/**
 * views/settings.js -- Einstellungen, wenige ruhige Gruppen.
 *
 * Was der Nutzer gesagt hat, und was daraus folgt:
 *  - "Alles per Knopfdruck, nichts einrichten, kein Schnickschnack." Jede
 *    Gruppe hat EINE Hauptaktion. Was nur Technik ist, liegt eingeklappt
 *    unter "Für Fortgeschrittene".
 *  - Die KI ist Gemini (kostenlos) oder Claude (kostet). Die Gruppe "KI"
 *    wählt, wer antwortet, und verbindet je Anbieter mit einem Feld und
 *    einem Knopf, wählt das Modell und nennt den bisherigen Verbrauch --
 *    bei Claude als Schätzung, weil die Rechnung Anthropic stellt; bei
 *    Gemini als Zahl der Anfragen, weil Google zählt statt zu berechnen.
 *  - Schutz = PIN. 4-6 Ziffern, zweimal. "Dieses Gerät merken" legt den
 *    Schlüssel im Benutzerprofil dieses Rechners ab, nicht auf dem Stick.
 *    Was eine PIN kann und was nicht, steht in einem ehrlichen Satz mit der
 *    gemessenen Zahl (0,45 s je Rateversuch, siehe src/store/vaultcrypto.js).
 *    Das PIN-Feld ist kein <form> und kein type=password: sonst bietet der
 *    Browser an, die PIN zu speichern, und dann läge sie neben dem Stick.
 *  - iPad verbinden: EIN Knopf. Er öffnet die Freigabe im WLAN ohne Neustart
 *    und zeigt einen QR-Code (web/lib/qr.js). "Verbunden" steht erst da, wenn
 *    das iPad den Code wirklich eingelöst hat -- nie schon beim Einschalten,
 *    denn Firewall und Schul-WLAN kann dieser Laptop nicht sehen.
 *  - Nichts wird behauptet, was nicht abgefragt wurde. Fehlt eine Antwort,
 *    steht da, dass sie fehlt.
 */

import { h, text, clear, icon, timeAgo, formatDate, formatBytes, formatNumber, debounce } from '../lib/dom.js';
import { kodiere, svgPfad } from '../lib/qr.js';

const STYLE_ID = 'nos-settings-view-style';

/** Gemessen (scrypt N=2^17, r=8, p=1, ein Kern, 2,8-GHz-Xeon): 0,44-0,47 s. */
const RATEVERSUCH_S = 0.45;
const PIN_RE = /^[0-9]{4,6}$/;

const SYMBOLE = {
  ipad: '<rect x="4" y="2.8" width="12" height="14.4" rx="2.2"/><path d="M8.6 14.4h2.8"/>',
  speicher: '<ellipse cx="10" cy="5.2" rx="6" ry="2.4"/><path d="M4 5.2v9.6c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V5.2"/><path d="M4 10c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4"/>',
  darstellung: '<circle cx="10" cy="10" r="6.6"/><path d="M10 3.4v13.2"/><path d="M10 3.4a6.6 6.6 0 0 1 0 13.2z" fill="currentColor" stroke="none"/>',
  kopieren: '<rect x="6.6" y="6.6" width="9" height="9" rx="2"/><path d="M13 4.4H6.2a1.8 1.8 0 0 0-1.8 1.8V13"/>',
  gedaechtnis: '<path d="M6.2 3.4h7.6a1.2 1.2 0 0 1 1.2 1.2v12l-5-3.1-5 3.1v-12a1.2 1.2 0 0 1 1.2-1.2z"/><path d="M10 6.2l.8 1.6 1.7.3-1.2 1.2.3 1.7-1.6-.8-1.6.8.3-1.7-1.2-1.2 1.7-.3z" fill="currentColor" stroke="none"/>',
};

let aktiv = null;

export default {
  id: 'settings',
  title: 'Einstellungen',

  async mount(container, ctx) {
    ensureStyle();
    abbauen();
    const self = {
      ctx,
      api: ctx.api,
      alive: true,
      container,
      cleanups: [],
      timers: new Set(),
      dom: {},
      daten: {},
      fehler: {},
      ui: {
        feldOffen: { gemini: false, claude: false },
        pin: null,          // null | {schritt:'eins'|'zwei', erste:string}
        pinAendern: false,
        merkenFragen: false,
        ipad: null,         // {link, bis, verbunden?:string, seit:number}
        busy: new Set(),
        pinMeldung: null,
        gedaechtnisAlle: false,
        allesVergessenFragen: false,
      },
    };
    aktiv = self;
    geruestBauen(self);
    abonnieren(self);
    await allesLaden(self);
    if (!self.alive) return;
    allesZeichnen(self);
    // #/settings?bereich=gedaechtnis&id=memory_… (etwa von "Gemerkt" im Chat)
    const params = (ctx.route && ctx.route.params) || {};
    if (params.bereich) zumBereich(self, String(params.bereich), params.id ? String(params.id) : null);
  },

  async unmount() {
    abbauen();
  },
};

function abbauen() {
  const self = aktiv;
  aktiv = null;
  if (!self) return;
  self.alive = false;
  for (const off of self.cleanups) {
    try { off(); } catch { /* schon weg */ }
  }
  for (const t of self.timers) clearInterval(t);
  self.timers.clear();
}

/* ------------------------------------------------------------------ */
/* Laden                                                               */
/* ------------------------------------------------------------------ */

const QUELLEN = {
  status: '/status',
  ki: '/ki',
  gedaechtnis: '/gedaechtnis',
  vault: '/vault',
  ipad: '/ipad',
  network: '/network',
  tokens: '/tokens',
  watch: '/watch',
};

async function laden(self, schluessel) {
  try {
    const wert = await self.api.get(QUELLEN[schluessel], { timeoutMs: 10000 });
    if (!self.alive) return;
    self.daten[schluessel] = wert;
    self.fehler[schluessel] = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.daten[schluessel] = null;
    self.fehler[schluessel] = err;
  }
}

async function allesLaden(self) {
  // Zuerst: wer fragt? Ein verbundenes iPad darf die Zugänge nicht sehen und
  // soll dafür auch keinen 403 ins Protokoll schreiben.
  await laden(self, 'ipad');
  const nurBesitzer = new Set(['tokens']);
  await Promise.all(Object.keys(QUELLEN)
    .filter((k) => k !== 'ipad' && (besitzer(self) || !nurBesitzer.has(k)))
    .map((k) => laden(self, k)));
}

function besitzer(self) {
  const i = self.daten.ipad;
  // Ohne Antwort lieber vorsichtig: dann zeigen Knöpfe beim Klick, was der Server sagt.
  return !i || i.besitzer !== false;
}

function abonnieren(self) {
  const bus = self.ctx.bus;
  if (!bus || typeof bus.on !== 'function') return;
  const neu = {
    ki: debounce(() => kiNeu(self), 300),
    schutz: debounce(async () => { await Promise.all([laden(self, 'vault'), laden(self, 'status')]); if (self.alive) { zeichneSchutz(self); zeichneSpeicher(self); } }, 300),
    ipad: debounce(async () => { await Promise.all([laden(self, 'ipad'), laden(self, 'tokens')]); if (self.alive) { zeichneIpad(self); zeichneNetz(self); zeichneFortgeschritten(self); } }, 200),
    netz: debounce(async () => { await Promise.all([laden(self, 'network'), laden(self, 'ki'), laden(self, 'status')]); if (self.alive) { zeichneNetz(self); zeichneKi(self); } }, 300),
    gedaechtnis: debounce(async () => { await laden(self, 'gedaechtnis'); if (self.alive) zeichneGedaechtnis(self); }, 250),
  };
  self.cleanups.push(bus.on('*', (payload, event) => {
    const typ = (event && event.type) || '';
    // Merkt sich die KI im Chat etwas (oder vergisst es anderswo), steht es sofort hier.
    const art = payload && (payload.type || (payload.record && payload.record.type));
    if (typ.startsWith('record.') && art === 'memory') neu.gedaechtnis();
    else if (typ.startsWith('claude') || typ.startsWith('gemini') || typ === 'ki.anbieter') neu.ki();
    else if (typ.startsWith('vault.')) neu.schutz();
    else if (typ === 'ipad.verbunden') {
      if (self.ui.ipad) self.ui.ipad.verbunden = (payload && payload.geraet) || 'iPad';
      neu.ipad();
    } else if (typ.startsWith('ipad.')) neu.ipad();
    else if (typ === 'network.mode' || typ === 'config.changed' || typ === 'network.grant') neu.netz();
  }));
}

/* ------------------------------------------------------------------ */
/* Gerüst                                                              */
/* ------------------------------------------------------------------ */

function gruppe(self, key, { titel, symbol, satz }) {
  const status = h('span.setv__status');
  const body = h('div.setv__body');
  self.dom[key] = { status, body };
  return h('section.setv__gruppe', { 'aria-label': titel, dataset: { gruppe: key } },
    h('header.setv__kopf', null,
      h('span.setv__symbol', { 'aria-hidden': 'true' }, icon(symbol)),
      h('div.setv__titel', null,
        h('h2', null, text(titel)),
        satz ? h('p', null, text(satz)) : null),
      status),
    body);
}

function geruestBauen(self) {
  const { ctx } = self;
  clear(self.container);
  const I = ctx.icons || {};
  self.dom.hinweis = h('div.setv__hinweis');
  self.dom.fortgeschritten = h('div.setv__body');
  self.container.appendChild(h('div.page.setv', null,
    self.dom.hinweis,
    gruppe(self, 'ki', { titel: 'KI', symbol: I.brand || I.cloud, satz: 'Gemini (kostenlos) oder Claude. Antwortet, sucht im Internet, denkt mit.' }),
    gruppe(self, 'gedaechtnis', { titel: 'Gedächtnis', symbol: SYMBOLE.gedaechtnis, satz: 'Was sich die KI über dich gemerkt hat. Sie liest es bei jeder Antwort mit.' }),
    gruppe(self, 'schutz', { titel: 'Schutz', symbol: I.lock, satz: 'Eine PIN, damit niemand liest, wer den Stick findet.' }),
    gruppe(self, 'ipad', { titel: 'iPad verbinden', symbol: SYMBOLE.ipad, satz: 'Das iPad als zweiter Bildschirm, im selben WLAN.' }),
    gruppe(self, 'darstellung', { titel: 'Darstellung', symbol: SYMBOLE.darstellung }),
    gruppe(self, 'netz', { titel: 'Netzwerk', symbol: I.network }),
    gruppe(self, 'speicher', { titel: 'Speicher', symbol: SYMBOLE.speicher }),
    h('details.setv__mehr', null,
      h('summary', null,
        h('span.setv__mehr-titel', null, text('Für Fortgeschrittene')),
        h('span.setv__mehr-inhalt', null, text('Beobachtete Ordner · Zugänge · Diagnose'))),
      self.dom.fortgeschritten)));
}

function allesZeichnen(self) {
  zeichneHinweis(self);
  zeichneKi(self);
  zeichneGedaechtnis(self);
  zeichneSchutz(self);
  zeichneIpad(self);
  zeichneDarstellung(self);
  zeichneNetz(self);
  zeichneSpeicher(self);
  zeichneFortgeschritten(self);
}

/* ------------------------------------------------------------------ */
/* Kleine Bausteine                                                    */
/* ------------------------------------------------------------------ */

function status(self, key, punkt, wort) {
  const box = self.dom[key].status;
  clear(box);
  if (!wort) return;
  box.appendChild(h('span.setv__zustand', null,
    punkt ? h(`span.dot.dot--${punkt}`, { 'aria-hidden': 'true' }) : null,
    text(wort)));
}

function satz(inhalt, klasse = '') {
  return h(`p.setv__satz${klasse}`, null, text(inhalt));
}

function fehlerText(err) {
  if (!err) return '';
  return (err && err.message) || String(err);
}

/** Fehlt nur die PIN, sagt jede Gruppe dasselbe, leise -- der Schutz darüber erklärt es. */
function nichtAbrufbar(err, sonst) {
  if (err && err.code === 'PIN_NOETIG') return satz('Erst nach der PIN.', '.meta');
  return satz(err ? `${sonst}: ${fehlerText(err)}` : `${sonst}.`, '.is-warn');
}

function knopf(self, beschriftung, onClick, { art = '', schluessel = null, symbol = null, deaktiviert = false } = {}) {
  const busy = schluessel && self.ui.busy.has(schluessel);
  return h(`button.btn${art}`, {
    type: 'button',
    disabled: deaktiviert || busy,
    'aria-busy': busy ? 'true' : null,
    onClick: async (ev) => {
      const el = ev.currentTarget;
      if (schluessel) {
        if (self.ui.busy.has(schluessel)) return;
        self.ui.busy.add(schluessel);
        el.disabled = true;
      }
      try {
        await onClick(ev);
      } finally {
        if (schluessel) {
          self.ui.busy.delete(schluessel);
          // Bleibt der Knopf stehen (etwa nach einer falschen PIN), muss er
          // wieder gehen -- sonst wartet man vor einem toten Knopf.
          if (el.isConnected && !deaktiviert) el.disabled = false;
        }
      }
    },
  }, symbol ? icon(symbol) : null, busy ? h('span.spinner', { 'aria-hidden': 'true' }) : null, text(beschriftung));
}

/**
 * Ein PIN-Feld. Kein type=password, kein <form>, kein Autofill: der Browser
 * soll die PIN nicht speichern wollen (Stick-Bauplan, Paket V). Die Punkte
 * macht CSS (-webkit-text-security).
 */
function pinFeld({ label, onEnter, autofocus = false }) {
  const feld = h('input.input.setv__pin', {
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    maxlength: '6',
    spellcheck: 'false',
    'aria-label': label,
    attrs: { autocorrect: 'off', autocapitalize: 'off', 'data-1p-ignore': 'true', 'data-lpignore': 'true', enterkeyhint: 'done' },
    onInput: (ev) => {
      const el = ev.currentTarget;
      const sauber = el.value.replace(/[^0-9]/g, '').slice(0, 6);
      if (sauber !== el.value) el.value = sauber;
    },
    onKeydown: (ev) => {
      if (ev.key === 'Enter' && typeof onEnter === 'function') {
        ev.preventDefault();
        onEnter();
      }
    },
  });
  if (autofocus) setTimeout(() => { try { feld.focus(); } catch { /* weg */ } }, 30);
  return h('label.setv__feld', null, h('span.label', null, text(label)), feld);
}

function merkenSchalter(self, standard = false) {
  const box = h('input', { type: 'checkbox', checked: standard });
  const wrap = h('label.setv__check', null, box,
    h('span', null,
      h('strong', null, text('Dieses Gerät merken')),
      h('span.meta', null, text(' – an diesem Rechner nicht mehr nach der PIN fragen. Nur am eigenen Laptop.'))));
  return { el: wrap, wert: () => box.checked };
}

/* ------------------------------------------------------------------ */
/* Hinweis oben (nur, wenn etwas wichtig ist)                          */
/* ------------------------------------------------------------------ */

function zeichneHinweis(self) {
  const box = self.dom.hinweis;
  clear(box);
  if (!besitzer(self)) {
    box.appendChild(h('div.setv__banner', null,
      icon((self.ctx.icons || {}).info),
      text('Dieses Gerät ist als Bildschirm verbunden. Einstellungen ändern geht nur am Laptop, auf dem Neural OS läuft.')));
  }
}

/** Fuer Selektoren. `CSS` heisst in dieser Datei der Stiltext -- daher ueber globalThis. */
const escape = (x) => (globalThis.CSS && typeof globalThis.CSS.escape === 'function' ? globalThis.CSS.escape(x) : String(x).replace(/[^a-zA-Z0-9_-]/g, ''));

/** Zu einer Gruppe springen und sie kurz hervorheben; mit `id` auch zu einem Eintrag darin. */
function zumBereich(self, key, id = null) {
  const gruppeEl = self.container.querySelector(`[data-gruppe="${escape(key)}"]`);
  if (!gruppeEl) return;
  const eintrag = id ? gruppeEl.querySelector(`[data-id="${escape(id)}"]`) : null;
  const ziel = eintrag || gruppeEl;
  ziel.classList.add('is-ziel');
  setTimeout(() => {
    try { ziel.scrollIntoView({ block: eintrag ? 'center' : 'start', behavior: 'smooth' }); } catch { ziel.scrollIntoView(); }
  }, 60);
  setTimeout(() => ziel.classList.remove('is-ziel'), 2600);
}

/* ------------------------------------------------------------------ */
/* Gedächtnis: was sich die KI gemerkt hat                             */
/* ------------------------------------------------------------------ */

/** So viele stehen zuerst da; der Rest auf [Alle … zeigen]. */
const GEDAECHTNIS_ERST = 12;

function zeichneGedaechtnis(self) {
  const { body } = self.dom.gedaechtnis;
  clear(body);
  const g = self.daten.gedaechtnis;
  if (!g) {
    status(self, 'gedaechtnis', null, '');
    body.appendChild(nichtAbrufbar(self.fehler.gedaechtnis, 'Das Gedächtnis ließ sich nicht laden'));
    return;
  }
  const items = Array.isArray(g.items) ? g.items : [];
  status(self, 'gedaechtnis', null, items.length ? (items.length === 1 ? '1 Eintrag' : `${formatNumber(items.length)} Einträge`) : 'leer');
  if (!items.length) {
    body.appendChild(satz('Noch nichts gemerkt. Sag im Chat zum Beispiel: „Merk dir, dass ich vegetarisch esse.“', '.meta'));
    return;
  }
  const zeigen = self.ui.gedaechtnisAlle ? items : items.slice(0, GEDAECHTNIS_ERST);
  body.appendChild(h('ul.setv__fakten', { 'aria-label': 'Gemerkt' }, zeigen.map((f) => faktZeile(self, f))));
  const zeile = h('div.setv__zeile');
  if (items.length > GEDAECHTNIS_ERST) {
    zeile.appendChild(knopf(self, self.ui.gedaechtnisAlle ? 'Weniger zeigen' : `Alle ${formatNumber(items.length)} zeigen`, () => {
      self.ui.gedaechtnisAlle = !self.ui.gedaechtnisAlle;
      zeichneGedaechtnis(self);
    }, { art: '.btn--ghost.btn--small' }));
  }
  const nichtMit = items.filter((f) => f.fuerAlle && !f.liestMit).length;
  if (nichtMit) {
    body.appendChild(satz(`Bei so vielen liest die KI die neuesten ${formatNumber(g.mitgelesen)} mit; ${nichtMit === 1 ? 'ein älterer zählt' : `${formatNumber(nichtMit)} ältere zählen`} gerade nicht.`, '.meta'));
  }
  // Alles vergessen: mit Nachfrage hier in der Gruppe, nicht mit einem Fenster des Browsers.
  if (self.ui.allesVergessenFragen) {
    body.appendChild(h('div.setv__frage', { role: 'group', 'aria-label': 'Alles vergessen?' },
      satz(`Wirklich alles vergessen? ${items.length === 1 ? 'Das ist ein Eintrag' : `Das sind ${formatNumber(items.length)} Einträge`}. Die KI weiß danach nichts mehr davon.`),
      h('div.setv__zeile', null,
        knopf(self, 'Ja, alles vergessen', () => vergessen(self, null), { art: '.btn--danger', schluessel: 'alles-vergessen' }),
        knopf(self, 'Abbrechen', () => { self.ui.allesVergessenFragen = false; zeichneGedaechtnis(self); }, { art: '.btn--ghost' }))));
  } else if (items.length > 1) {
    zeile.appendChild(knopf(self, 'Alles vergessen …', () => { self.ui.allesVergessenFragen = true; zeichneGedaechtnis(self); }, { art: '.btn--ghost.btn--small' }));
  }
  if (zeile.childNodes.length) body.appendChild(zeile);
}

function faktZeile(self, f) {
  const meta = [];
  if (f.herkunft && f.herkunft.url) {
    meta.push(h('a.setv__herkunft', { href: f.herkunft.url }, text(f.herkunft.art === 'chat' ? `aus dem Chat „${f.herkunft.titel}“` : 'von einem Agenten')));
    meta.push(text(' · '));
  }
  meta.push(text(timeAgo(f.createdAt)));
  if (!f.fuerAlle) meta.push(text(' · merkt sich nur ein Agent'));
  else if (!f.liestMit) meta.push(text(' · wird gerade nicht mitgelesen'));
  return h('li.setv__fakt', { dataset: { id: f.id } },
    h('div.setv__fakt-text', null,
      h('p', null, text(f.text)),
      h('p.meta', null, ...meta)),
    knopf(self, 'Vergessen', () => vergessen(self, [f.id]), { art: '.btn--ghost.btn--small', schluessel: `vergessen-${f.id}` }));
}

/** Vergessen -- einzeln oder alles (`ids` null) -- mit [Rückgängig] in der Meldung. */
async function vergessen(self, ids) {
  let r;
  try {
    r = await self.api.post('/gedaechtnis/vergessen', ids ? { ids } : { alle: true }, { timeoutMs: 20000 });
  } catch (err) {
    if (self.alive) self.ctx.toast(`Nicht vergessen: ${fehlerText(err)}`, 'error');
    return;
  }
  const weg = r && Array.isArray(r.ids) ? r.ids : [];
  self.ui.allesVergessenFragen = false;
  await laden(self, 'gedaechtnis');
  if (self.alive) zeichneGedaechtnis(self);
  if (!weg.length) return;
  const { api, ctx } = self;
  ctx.toast(weg.length === 1 ? 'Vergessen.' : `${formatNumber(weg.length)} Einträge vergessen.`, 'success', {
    timeout: 10000,
    action: {
      label: 'Rückgängig',
      run: async () => {
        try {
          await api.post('/gedaechtnis/zurueck', { ids: weg }, { timeoutMs: 20000 });
          ctx.toast(weg.length === 1 ? 'Wieder da.' : 'Alles wieder da.', 'info');
        } catch (err) {
          ctx.toast(`Rückgängig ist gescheitert: ${fehlerText(err)}`, 'error');
          return;
        }
        if (self.alive) {
          await laden(self, 'gedaechtnis');
          if (self.alive) zeichneGedaechtnis(self);
        }
      },
    },
  });
}

/* ------------------------------------------------------------------ */
/* KI: Gemini (kostenlos) oder Claude                                  */
/* ------------------------------------------------------------------ */

/** Was je Anbieter fest ist: Name, Preis in einem Wort, wo es den Schlüssel gibt. */
const ANBIETER = {
  gemini: {
    name: 'Gemini', wahl: 'Gemini (kostenlos)', platzhalter: 'AIza…', label: 'Google-Schlüssel', host: 'generativelanguage.googleapis.com',
    hinweis: 'Schlüssel: aistudio.google.com/apikey → Create API key. Kostenlos; Google darf Inhalte zur Verbesserung nutzen.',
  },
  claude: {
    name: 'Claude', wahl: 'Claude (kostet)', platzhalter: 'sk-ant-…', label: 'Claude-Schlüssel', host: 'api.anthropic.com',
    hinweis: 'Schlüssel: console.anthropic.com → API Keys. Kostet pro Nutzung; die Rechnung stellt Anthropic.',
  },
};

async function kiNeu(self) {
  await laden(self, 'ki');
  if (self.alive) zeichneKi(self);
}

function zeichneKi(self) {
  const { body } = self.dom.ki;
  clear(body);
  const k = self.daten.ki;
  if (!k || !k.anbieter) {
    status(self, 'ki', null, '');
    body.appendChild(nichtAbrufbar(self.fehler.ki, 'Der Zustand der KI ist gerade nicht abrufbar'));
    return;
  }
  const aktiv = k.aktiv === 'claude' ? 'claude' : 'gemini';
  const a = k.anbieter[aktiv] || {};
  const name = a.name || ANBIETER[aktiv].name;
  if (k.verbunden) status(self, 'ki', 'accent', `Verbunden · ${a.modellName || name}`);
  else if (k.irgendeinSchluessel) status(self, 'ki', 'warn', 'Nicht erreichbar');
  else status(self, 'ki', null, 'Nicht verbunden');

  // Ein verbundenes iPad sieht, wie es steht -- ändern geht am Laptop.
  if (!besitzer(self)) {
    body.appendChild(satz(k.verbunden
      ? `${name} antwortet. Schlüssel und Modell werden am Laptop eingestellt.`
      : `${k.grund || 'Keine KI verbunden.'} Das geht am Laptop.`));
    return;
  }

  // 1. Wer antwortet.
  body.appendChild(h('div.setv__feld', null,
    h('span.label', null, text('Es antwortet')),
    h('div.segmented.setv__segmente', { role: 'radiogroup', 'aria-label': 'KI' },
      ['gemini', 'claude'].map((id) => h('button.segmented__option', {
        type: 'button',
        role: 'radio',
        'aria-checked': id === aktiv ? 'true' : 'false',
        class: id === aktiv ? 'is-active' : null,
        onClick: async () => {
          if (id === aktiv) return;
          try {
            await self.api.patch('/ki', { anbieter: id });
            if (!self.alive) return;
            self.ctx.toast(`${ANBIETER[id].name} antwortet ab der nächsten Nachricht.`, 'success');
          } catch (err) {
            self.ctx.toast(`Nicht gewechselt: ${fehlerText(err)}`, 'error');
          }
          await kiNeu(self);
        },
      }, text(ANBIETER[id].wahl))))));

  // 2. Warum der Gewählte gerade nicht antwortet -- mit dem Knopf, der es behebt.
  if (!k.verbunden && a.schluesselVorhanden) {
    const zeile = h('div.setv__zeile.setv__warnung', null, icon((self.ctx.icons || {}).alert), h('span', null, text(a.grund || `${name} ist gerade nicht erreichbar.`)));
    if (a.grundCode === 'offline') {
      zeile.appendChild(knopf(self, 'Online gehen', () => netzModus(self, 'online'), { art: '.btn--accent.btn--small', schluessel: 'netz' }));
    } else if (a.grundCode === 'schleuse') {
      zeile.appendChild(knopf(self, `${name} freigeben`, () => hostFreigeben(self, ANBIETER[aktiv].host), { art: '.btn--accent.btn--small', schluessel: 'freigabe' }));
    } else if (a.grundCode === 'schluessel-falsch') {
      zeile.appendChild(knopf(self, 'Neu eingeben', () => { self.ui.feldOffen[aktiv] = true; zeichneKi(self); }, { art: '.btn--accent.btn--small' }));
    }
    body.appendChild(zeile);
  }

  // 3. Je Anbieter: Schlüssel, Modell, Verbrauch.
  for (const id of ['gemini', 'claude']) body.appendChild(anbieterBlock(self, id, k.anbieter[id] || {}, id === aktiv));
}

function anbieterBlock(self, id, c, istAktiv) {
  const A = ANBIETER[id];
  const block = h('section.setv__anbieter', { 'aria-label': A.name, dataset: { anbieter: id } });
  const zustandWort = c.verbunden ? 'verbunden' : (c.schluesselVorhanden ? 'Schlüssel hinterlegt' : 'kein Schlüssel');
  block.appendChild(h('div.setv__anbieter-kopf', null,
    h('strong', null, text(A.name)),
    h('span.setv__zustand', null,
      c.verbunden ? h('span.dot.dot--accent', { 'aria-hidden': 'true' }) : null,
      text(istAktiv ? `${zustandWort} · antwortet` : zustandWort))));

  const fehlt = !c.schluesselVorhanden;
  if (fehlt || self.ui.feldOffen[id]) {
    const feld = h('input.input.setv__schluessel', {
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: A.platzhalter,
      'aria-label': A.label,
      attrs: { autocorrect: 'off', autocapitalize: 'off', 'data-1p-ignore': 'true', 'data-lpignore': 'true' },
      onKeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); verbinden(); } },
    });
    const meldung = h('p.setv__meldung', { role: 'status' });
    const verbinden = async () => {
      const wert = feld.value.trim();
      if (!wert) {
        meldung.textContent = 'Bitte zuerst den Schlüssel einfügen.';
        feld.focus();
        return;
      }
      meldung.textContent = 'Wird mit einem kleinen Probeaufruf geprüft …';
      meldung.className = 'setv__meldung';
      try {
        await self.api.post(`/ki/${id}/schluessel`, { schluessel: wert }, { timeoutMs: 45000 });
        if (!self.alive) return;
        feld.value = '';
        self.ui.feldOffen[id] = false;
        self.ctx.toast(`${A.name} ist verbunden.`, 'success');
        await kiNeu(self);
      } catch (err) {
        if (!self.alive) return;
        meldung.textContent = fehlerText(err);
        meldung.className = 'setv__meldung is-danger';
      }
    };
    block.appendChild(h('div.setv__zeile', null,
      h('label.setv__feld.setv__feld--breit', null, h('span.label', null, text(fehlt ? 'Schlüssel einfügen' : 'Neuer Schlüssel')), feld),
      knopf(self, fehlt ? 'Verbinden' : 'Ersetzen', verbinden, { art: '.btn--primary', schluessel: `${id}-verbinden` })));
    block.appendChild(meldung);
    block.appendChild(satz(A.hinweis, '.meta'));
  } else {
    const geprueft = c.geprueftAm ? `, geprüft ${timeAgo(c.geprueftAm)}` : '';
    block.appendChild(h('div.setv__zeile', null,
      satz(`Der Schlüssel ist hinterlegt${geprueft}`.replace(/\.?$/, '.')),
      h('span.spacer'),
      knopf(self, 'Anderen Schlüssel', () => { self.ui.feldOffen[id] = true; zeichneKi(self); }, { art: '.btn--ghost.btn--small' }),
      knopf(self, 'Entfernen', async () => {
        const ok = await self.ctx.confirm({
          title: `${A.name}-Schlüssel entfernen?`,
          message: `Danach antwortet ${A.name} nicht mehr, bis ein Schlüssel eingefügt wird. Deine Notizen, Termine und Chats bleiben.`,
          confirmLabel: 'Entfernen',
          danger: true,
        });
        if (!ok || !self.alive) return;
        try {
          await self.api.del(`/ki/${id}/schluessel`);
          self.ctx.toast('Der Schlüssel ist entfernt.', 'success');
        } catch (err) {
          self.ctx.toast(`Nicht entfernt: ${fehlerText(err)}`, 'error');
        }
        await kiNeu(self);
      }, { art: '.btn--ghost.btn--small' })));
  }

  // Modell -- nur, wenn ein Schlüssel da ist; vorher gibt es nichts zu wählen.
  const modelle = Array.isArray(c.modelle) ? c.modelle : [];
  if (!fehlt && modelle.length) {
    const gewaehlt = modelle.find((m) => m.id === c.modell) || modelle[0];
    block.appendChild(h('div.setv__feld', null,
      h('span.label', null, text('Modell')),
      h('div.segmented.setv__segmente', { role: 'radiogroup', 'aria-label': `Modell ${A.name}` },
        modelle.map((m) => h('button.segmented__option', {
          type: 'button',
          role: 'radio',
          'aria-checked': m.id === c.modell ? 'true' : 'false',
          class: m.id === c.modell ? 'is-active' : null,
          onClick: async () => {
            if (m.id === c.modell) return;
            try {
              // Das Modell gehört zu diesem Anbieter; PATCH /api/ki setzt es beim Aktiven.
              await self.api.patch('/ki', { anbieter: id, modell: m.id });
              if (!self.alive) return;
              self.ctx.toast(`${m.name} antwortet ab der nächsten Nachricht.`, 'success');
            } catch (err) {
              self.ctx.toast(`Nicht gewechselt: ${fehlerText(err)}`, 'error');
            }
            await kiNeu(self);
          },
        }, text(m.name.replace(/^(Claude|Gemini) /, ''))))),
      gewaehlt && gewaehlt.hinweis ? h('span.hint', null, text(gewaehlt.hinweis)) : null));
  }

  // Verbrauch: Nullen sind keine Auskunft; er steht erst da, wenn es einen gibt.
  const v = c.verbrauch;
  if (v && Number.isFinite(v.anfragen) && v.anfragen > 0) {
    const kosten = v.kostenlos
      ? 'kostenlos'
      : (Number.isFinite(v.kostenUsd)
        ? `etwa ${v.kostenUsd.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`
        : 'unbekannt');
    block.appendChild(h('div.setv__verbrauch', null,
      h('div', null, h('span.label', null, text('Bisheriger Verbrauch')), h('strong', null, text(kosten))),
      h('div', null, h('span.label', null, text('Anfragen')), h('strong', null, text(formatNumber(v.anfragen)))),
      h('div', null, h('span.label', null, text('Websuchen')), h('strong', null, text(formatNumber(v.suchen || 0)))),
      h('p.meta', null, text(v.hinweis || ''))));
  }
  return block;
}

async function netzModus(self, mode) {
  try {
    await self.api.put('/network', { mode });
    if (!self.alive) return;
    self.ctx.toast(mode === 'online' ? 'Neural OS ist online.' : 'Neural OS ist offline.', 'success');
  } catch (err) {
    self.ctx.toast(`Nicht umgeschaltet: ${fehlerText(err)}`, 'error');
  }
  await Promise.all([laden(self, 'network'), laden(self, 'ki'), laden(self, 'status')]);
  if (self.alive) { zeichneNetz(self); zeichneKi(self); }
}

/** Den Host eines Anbieters auf die Freigabeliste setzen (strenge Liste, Modus online). */
async function hostFreigeben(self, host) {
  const netz = self.daten.network;
  const hosts = netz && Array.isArray(netz.allowHosts) ? netz.allowHosts.slice() : [];
  if (!hosts.includes(host)) hosts.push(host);
  try {
    await self.api.put('/network', { allowHosts: hosts });
    if (!self.alive) return;
    self.ctx.toast(`${host} ist freigegeben.`, 'success');
  } catch (err) {
    self.ctx.toast(`Nicht freigegeben: ${fehlerText(err)}`, 'error');
  }
  await Promise.all([laden(self, 'network'), laden(self, 'ki')]);
  if (self.alive) { zeichneNetz(self); zeichneKi(self); }
}

/* ------------------------------------------------------------------ */
/* Schutz (PIN)                                                        */
/* ------------------------------------------------------------------ */

function ehrlicherSatz() {
  const vier = Math.round((10000 * RATEVERSUCH_S) / 60);
  const sechs = Math.round((1000000 * RATEVERSUCH_S) / 86400);
  return `Ehrlich gesagt: Eine PIN mit 4 Ziffern schützt gegen Neugierige, nicht gegen einen Profi mit viel Zeit. `
    + `Ein Rateversuch kostet gemessen ${String(RATEVERSUCH_S).replace('.', ',')} Sekunden; alle 10.000 vierstelligen PINs `
    + `sind damit in etwa ${vier} Minuten durchprobiert. Mit 6 Ziffern sind es etwa ${sechs} Tage – deutlich besser.`;
}

function zeichneSchutz(self) {
  const { body } = self.dom.schutz;
  clear(body);
  const v = self.daten.vault;
  const s = v && v.schutz;
  if (!s || s.verfuegbar === false) {
    status(self, 'schutz', null, '');
    body.appendChild(self.fehler.vault
      ? nichtAbrufbar(self.fehler.vault, 'Der Zustand des Tresors ist gerade nicht abrufbar')
      : satz('Die Verschlüsselung ist in dieser Instanz nicht geladen. Eine PIN lässt sich so nicht einrichten.', '.is-warn'));
    return;
  }
  if (!besitzer(self)) {
    status(self, 'schutz', s.eingerichtet ? 'accent' : null, s.eingerichtet ? 'PIN aktiv' : 'Keine PIN');
    body.appendChild(satz('Die PIN wird am Laptop eingerichtet und eingegeben.', '.meta'));
    return;
  }

  const wort = s.art === 'passphrase' ? 'Passphrase' : 'PIN';
  const gesperrt = s.zustand !== 'unlocked';
  const ohneSitzung = s.sitzung && s.sitzung.noetig && !s.sitzung.vorhanden;

  // A. Keine PIN
  if (!s.eingerichtet) {
    status(self, 'schutz', 'warn', 'Keine PIN');
    if (!self.ui.pin) {
      body.appendChild(satz('Ohne PIN kann jeder, der den Stick findet, alles lesen: Notizen, Chats, die KI-Schlüssel.'));
      body.appendChild(h('div.setv__zeile', null,
        knopf(self, 'PIN einrichten', () => { self.ui.pin = { schritt: 'eins', erste: '' }; zeichneSchutz(self); }, { art: '.btn--accent', symbol: (self.ctx.icons || {}).lock })));
      body.appendChild(satz(ehrlicherSatz(), '.meta'));
      return;
    }
    zeichnePinEinrichten(self, body);
    return;
  }

  // B. PIN eingerichtet, aber dieser Browser darf noch nicht (gesperrt oder ohne Sitzung)
  if (gesperrt || ohneSitzung) {
    status(self, 'schutz', 'warn', gesperrt ? 'Gesperrt' : `${wort} nötig`);
    body.appendChild(satz(gesperrt
      ? `Der Tresor ist gesperrt. Mit der ${wort} geht er wieder auf.`
      : `Dieser Browser hat die KI noch nicht entsperrt. Bitte die ${wort} eingeben.`));
    zeichneEntsperren(self, body, s);
    return;
  }

  // C. PIN eingerichtet und offen
  const hier = s.diesesGeraetGemerkt;
  status(self, 'schutz', 'accent', `${wort} aktiv`);
  body.appendChild(h('ul.setv__fakten', null,
    h('li', null, h('span.dot.dot--accent', { 'aria-hidden': 'true' }), text(`Der Tresor ist mit deiner ${wort} verschlüsselt.`)),
    h('li', null, h(`span.dot${hier ? '.dot--accent' : ''}`, { 'aria-hidden': 'true' }),
      text(hier
        ? 'Dieser Rechner ist gemerkt: hier fragt Neural OS nicht nach der PIN.'
        : 'Dieser Rechner ist nicht gemerkt: beim Start fragt Neural OS nach der PIN.'))));

  if (self.ui.merkenFragen) {
    const meldung = h('p.setv__meldung', { role: 'status' });
    let feldEl;
    const los = async () => {
      const pin = feldEl.querySelector('input').value;
      await pinAufruf(self, meldung, () => self.api.post('/vault/geraet', { pin }), () => {
        self.ui.merkenFragen = false;
        self.ctx.toast('Dieser Rechner ist gemerkt.', 'success');
      });
    };
    feldEl = pinFeld({ label: `${wort} zur Bestätigung`, onEnter: los, autofocus: true });
    body.appendChild(h('div.setv__zeile', null, feldEl,
      knopf(self, 'Merken', los, { art: '.btn--primary', schluessel: 'merken' }),
      knopf(self, 'Abbrechen', () => { self.ui.merkenFragen = false; zeichneSchutz(self); }, { art: '.btn--ghost' })));
    body.appendChild(meldung);
  } else if (self.ui.pinAendern) {
    zeichnePinAendern(self, body, wort);
  } else {
    body.appendChild(h('div.setv__zeile', null,
      hier
        ? knopf(self, 'Diesen Rechner vergessen', async () => {
          try {
            await self.api.del('/vault/geraet');
            self.ctx.toast('Vergessen. Beim nächsten Start fragt Neural OS hier wieder nach der PIN.', 'success');
          } catch (err) {
            self.ctx.toast(`Nicht vergessen: ${fehlerText(err)}`, 'error');
          }
          await laden(self, 'vault');
          if (self.alive) zeichneSchutz(self);
        }, { art: '', schluessel: 'vergessen' })
        : knopf(self, 'Diesen Rechner merken', () => { self.ui.merkenFragen = true; zeichneSchutz(self); }, { art: '.btn--accent' }),
      knopf(self, `${wort} ändern`, () => { self.ui.pinAendern = true; zeichneSchutz(self); }),
      h('span.spacer'),
      knopf(self, 'Jetzt sperren', async () => {
        const ok = await self.ctx.confirm({
          title: 'Tresor sperren?',
          message: `Danach ist nichts mehr lesbar, bis die ${wort} eingegeben wird.`,
          confirmLabel: 'Sperren',
        });
        if (!ok || !self.alive) return;
        try {
          await self.api.post('/vault/lock', {});
        } catch (err) {
          self.ctx.toast(`Nicht gesperrt: ${fehlerText(err)}`, 'error');
        }
        await laden(self, 'vault');
        if (self.alive) zeichneSchutz(self);
      }, { art: '.btn--ghost' })));
  }

  const geraete = Array.isArray(s.geraete) ? s.geraete : [];
  if (geraete.length) {
    body.appendChild(h('div.setv__liste', null,
      h('span.label', null, text(`Gemerkte Rechner (${geraete.length})`)),
      geraete.map((g) => h('div.setv__eintrag', null,
        h('span', null, text(g.name || 'Rechner'), g.diesesGeraet ? h('span.badge.badge--accent', null, text('dieser')) : null),
        h('span.meta', null, text(g.angelegt ? `seit ${formatDate(g.angelegt)}` : '')))),
      h('div.setv__zeile', null, knopf(self, 'Alle vergessen', async () => {
        const ok = await self.ctx.confirm({
          title: 'Alle gemerkten Rechner vergessen?',
          message: 'Auch Rechner, die gerade nicht da sind, fragen danach wieder nach der PIN. Das ist der Weg, wenn ein Laptop weg ist.',
          confirmLabel: 'Alle vergessen',
          danger: true,
        });
        if (!ok || !self.alive) return;
        try {
          await self.api.del('/vault/geraete');
          self.ctx.toast('Alle gemerkten Rechner sind vergessen.', 'success');
        } catch (err) {
          self.ctx.toast(`Nicht vergessen: ${fehlerText(err)}`, 'error');
        }
        await laden(self, 'vault');
        if (self.alive) zeichneSchutz(self);
      }, { art: '.btn--ghost.btn--small', schluessel: 'alle-vergessen' }))));
  }
  body.appendChild(satz(`Eine ${wort} lässt sich ändern, aber nicht wieder abschalten: die Daten bleiben verschlüsselt.`, '.meta'));
}

function zeichnePinEinrichten(self, body) {
  const p = self.ui.pin;
  const meldung = h('p.setv__meldung', { role: 'status' }, text(self.ui.pinMeldung || ''));
  self.ui.pinMeldung = null;
  if (p.schritt === 'eins') {
    let feldEl;
    const weiter = () => {
      const wert = feldEl.querySelector('input').value;
      if (!PIN_RE.test(wert)) {
        meldung.textContent = 'Die PIN besteht aus 4 bis 6 Ziffern.';
        meldung.className = 'setv__meldung is-danger';
        return;
      }
      self.ui.pin = { schritt: 'zwei', erste: wert };
      zeichneSchutz(self);
    };
    feldEl = pinFeld({ label: 'Neue PIN (4 bis 6 Ziffern)', onEnter: weiter, autofocus: true });
    body.appendChild(h('div.setv__schritte', null, h('span.badge.badge--accent', null, text('Schritt 1 von 2'))));
    body.appendChild(h('div.setv__zeile', null, feldEl,
      knopf(self, 'Weiter', weiter, { art: '.btn--primary' }),
      knopf(self, 'Abbrechen', () => { self.ui.pin = null; zeichneSchutz(self); }, { art: '.btn--ghost' })));
    body.appendChild(meldung);
    body.appendChild(satz(ehrlicherSatz(), '.meta'));
    return;
  }
  let feldEl;
  // Voreingestellt AN: wer eine PIN einrichtet, sitzt fast immer am eigenen
  // Laptop. Ein nicht gemerkter Rechner braucht beim Start den PIN-Bildschirm
  // (Stick-Bauplan, Paket V); den gibt es noch nicht.
  const merken = merkenSchalter(self, true);
  const fertig = async () => {
    const wert = feldEl.querySelector('input').value;
    if (wert !== p.erste) {
      self.ui.pin = { schritt: 'eins', erste: '' };
      self.ui.pinMeldung = 'Die beiden Eingaben waren verschieden. Bitte noch einmal.';
      zeichneSchutz(self);
      return;
    }
    meldung.textContent = 'Verschlüsselt … (das dauert einen Moment)';
    meldung.className = 'setv__meldung';
    try {
      const r = await self.api.post('/vault/pin', { pin: wert, merken: merken.wert() }, { timeoutMs: 120000 });
      if (!self.alive) return;
      self.ui.pin = null;
      self.ctx.toast(r && r.gemerkt
        ? 'Die PIN ist eingerichtet. Dieser Rechner ist gemerkt.'
        : 'Die PIN ist eingerichtet. Beim nächsten Start fragt Neural OS danach.', 'success');
    } catch (err) {
      if (!self.alive) return;
      meldung.textContent = fehlerText(err);
      meldung.className = 'setv__meldung is-danger';
      return;
    }
    await Promise.all([laden(self, 'vault'), laden(self, 'status')]);
    if (self.alive) { zeichneSchutz(self); zeichneSpeicher(self); }
  };
  feldEl = pinFeld({ label: 'PIN wiederholen', onEnter: fertig, autofocus: true });
  body.appendChild(h('div.setv__schritte', null, h('span.badge.badge--accent', null, text('Schritt 2 von 2'))));
  body.appendChild(h('div.setv__zeile', null, feldEl,
    knopf(self, 'PIN einrichten', fertig, { art: '.btn--primary', schluessel: 'pin-einrichten' }),
    knopf(self, 'Zurück', () => { self.ui.pin = { schritt: 'eins', erste: '' }; zeichneSchutz(self); }, { art: '.btn--ghost' })));
  body.appendChild(merken.el);
  body.appendChild(meldung);
  body.appendChild(satz('Wichtig: Ohne die PIN kommt niemand mehr an die Daten – auch du nicht. Schreib sie dir auf und leg den Zettel nicht zum Stick.', '.is-warn'));
  body.appendChild(satz('Noch nicht fertig: Beim Start im Browser nach der PIN fragen kann Neural OS noch nicht. Bis das kommt, startet ein Stick mit PIN nur an gemerkten Rechnern – deshalb ist „merken“ hier voreingestellt.', '.meta'));
}

function zeichnePinAendern(self, body, wort) {
  const meldung = h('p.setv__meldung', { role: 'status' });
  const alt = pinFeld({ label: `Bisherige ${wort}`, autofocus: true });
  const neu1 = pinFeld({ label: 'Neue PIN' });
  const neu2 = pinFeld({ label: 'Neue PIN wiederholen' });
  const los = async () => {
    const a = alt.querySelector('input').value;
    const n1 = neu1.querySelector('input').value;
    const n2 = neu2.querySelector('input').value;
    if (!PIN_RE.test(n1)) { meldung.textContent = 'Die neue PIN besteht aus 4 bis 6 Ziffern.'; meldung.className = 'setv__meldung is-danger'; return; }
    if (n1 !== n2) { meldung.textContent = 'Die beiden neuen Eingaben sind verschieden.'; meldung.className = 'setv__meldung is-danger'; return; }
    await pinAufruf(self, meldung, () => self.api.post('/vault/pin/aendern', { alt: a, neu: n1 }, { timeoutMs: 60000 }), () => {
      self.ui.pinAendern = false;
      self.ctx.toast('Die PIN ist geändert.', 'success');
    });
  };
  neu2.querySelector('input').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); los(); } });
  body.appendChild(h('div.setv__raster', null, alt, neu1, neu2));
  body.appendChild(h('div.setv__zeile', null,
    knopf(self, 'Ändern', los, { art: '.btn--primary', schluessel: 'pin-aendern' }),
    knopf(self, 'Abbrechen', () => { self.ui.pinAendern = false; zeichneSchutz(self); }, { art: '.btn--ghost' })));
  body.appendChild(meldung);
}

function zeichneEntsperren(self, body, s) {
  const wort = s.art === 'passphrase' ? 'Passphrase' : 'PIN';
  const meldung = h('p.setv__meldung', { role: 'status' });
  const merken = merkenSchalter(self, false);
  let feldEl;
  const los = async () => {
    const wert = feldEl.querySelector('input').value;
    if (!wert) { feldEl.querySelector('input').focus(); return; }
    await pinAufruf(self, meldung, () => self.api.post('/vault/unlock', { passphrase: wert, merken: merken.wert() }, { timeoutMs: 60000 }), () => {
      self.ctx.toast('Entsperrt.', 'success');
      // Die anderen Bereiche haben ohne PIN nichts laden dürfen; neu laden
      // ist der ehrliche Weg, sie alle wieder zu füllen.
      setTimeout(() => { try { window.location.reload(); } catch { /* egal */ } }, 500);
    });
  };
  if (wort === 'PIN') {
    feldEl = pinFeld({ label: 'PIN', onEnter: los, autofocus: true });
  } else {
    const input = h('input.input.setv__pin', {
      type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Passphrase',
      onKeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); los(); } },
    });
    feldEl = h('label.setv__feld', null, h('span.label', null, text('Passphrase')), input);
  }
  body.appendChild(h('div.setv__zeile', null, feldEl, knopf(self, 'Entsperren', los, { art: '.btn--primary', schluessel: 'entsperren' })));
  body.appendChild(merken.el);
  body.appendChild(meldung);
  if (s.pauseS > 0) countdown(self, meldung, s.pauseS);
}

/** Eine PIN-Anfrage mit den Antworten aus dem Bauplan: 401 falsch, 429 Pause. */
async function pinAufruf(self, meldung, anfrage, beiErfolg) {
  meldung.textContent = 'Wird geprüft …';
  meldung.className = 'setv__meldung';
  try {
    await anfrage();
    if (!self.alive) return;
    beiErfolg();
  } catch (err) {
    if (!self.alive) return;
    // Eine falsche PIN bleibt nicht stehen: man tippt sie ohnehin neu.
    for (const feld of (meldung.parentElement ? meldung.parentElement.querySelectorAll('.setv__pin') : [])) feld.value = '';
    if (err && err.status === 429) {
      countdown(self, meldung, (err.details && err.details.wartenS) || 30);
      return;
    }
    const uebrig = err && err.details && Number.isFinite(err.details.uebrig) ? err.details.uebrig : null;
    meldung.textContent = err && err.code === 'FALSCHE_PIN' && uebrig !== null
      ? `${err.message} Noch ${uebrig} ${uebrig === 1 ? 'Versuch' : 'Versuche'}, dann 30 Sekunden Pause.`
      : fehlerText(err);
    meldung.className = 'setv__meldung is-danger';
    return;
  }
  await Promise.all([laden(self, 'vault'), laden(self, 'status')]);
  if (self.alive) { zeichneSchutz(self); zeichneSpeicher(self); }
}

function countdown(self, meldung, sekunden) {
  let rest = Math.max(1, Math.round(sekunden));
  meldung.className = 'setv__meldung is-danger';
  meldung.textContent = `Zu oft falsch. Kurz warten. (${rest} s)`;
  const t = setInterval(() => {
    rest -= 1;
    if (!self.alive || !meldung.isConnected) { clearInterval(t); self.timers.delete(t); return; }
    if (rest <= 0) {
      clearInterval(t);
      self.timers.delete(t);
      meldung.className = 'setv__meldung';
      meldung.textContent = 'Du kannst es jetzt wieder versuchen.';
      return;
    }
    meldung.textContent = `Zu oft falsch. Kurz warten. (${rest} s)`;
  }, 1000);
  self.timers.add(t);
}

/* ------------------------------------------------------------------ */
/* iPad verbinden                                                      */
/* ------------------------------------------------------------------ */

function zeichneIpad(self) {
  const { body } = self.dom.ipad;
  clear(body);
  const i = self.daten.ipad;
  if (!i) {
    status(self, 'ipad', null, '');
    body.appendChild(nichtAbrufbar(self.fehler.ipad, 'Nicht abrufbar'));
    return;
  }
  if (!i.besitzer) {
    status(self, 'ipad', 'accent', 'Verbunden');
    body.appendChild(satz('Dieses Gerät ist verbunden. Trennen geht am Laptop unter Einstellungen → iPad verbinden.'));
    return;
  }
  const geraete = Array.isArray(i.geraete) ? i.geraete : [];
  if (i.an) status(self, 'ipad', 'accent', geraete.length ? `An · ${geraete.length} verbunden` : 'An');
  else status(self, 'ipad', null, geraete.length ? `Aus · ${geraete.length} bekannt` : 'Aus');

  const ui = self.ui.ipad;
  if (ui && ui.verbunden) {
    body.appendChild(h('div.setv__erfolg', null,
      icon((self.ctx.icons || {}).checkCircle || (self.ctx.icons || {}).check),
      h('div', null,
        h('strong', null, text(`${ui.verbunden} ist verbunden.`)),
        h('p.meta', null, text('Es bleibt angemeldet, bis du es hier trennst. Läuft Neural OS neu, genügt am Laptop wieder „iPad verbinden“ – das iPad lädt dann einfach neu.')))));
  } else if (ui && ui.link && i.an) {
    body.appendChild(qrBlock(self, ui));
  } else if (!i.an) {
    body.appendChild(satz(i.netzGefunden === false
      ? 'Dieser Rechner ist gerade in keinem WLAN. Verbinde ihn mit demselben WLAN wie das iPad.'
      : 'Ein Knopf: Neural OS öffnet sich im WLAN und zeigt einen QR-Code. Den scannst du mit der Kamera des iPads, fertig.'));
  }

  const zeile = h('div.setv__zeile');
  if (!ui || !ui.link || ui.verbunden || !i.an) {
    // Nie gesperrt: wer das WLAN erst nach dem Öffnen dieser Seite einschaltet,
    // soll nicht vor einem toten Knopf stehen. Fehlt das WLAN, sagt es der Server.
    zeile.appendChild(knopf(self, i.an && ui && ui.verbunden ? 'Noch ein Gerät verbinden' : 'iPad verbinden', () => ipadEinschalten(self), {
      art: '.btn--accent', schluessel: 'ipad', symbol: SYMBOLE.ipad,
    }));
  }
  if (i.an) {
    zeile.appendChild(h('span.spacer'));
    zeile.appendChild(knopf(self, 'Freigabe ausschalten', async () => {
      try {
        await self.api.del('/ipad');
        self.ui.ipad = null;
        self.ctx.toast('Die Freigabe ist aus. Aus dem WLAN kommt niemand mehr herein.', 'success');
      } catch (err) {
        self.ctx.toast(`Nicht ausgeschaltet: ${fehlerText(err)}`, 'error');
      }
      await laden(self, 'ipad');
      if (self.alive) zeichneIpad(self);
    }, { art: '.btn--ghost', schluessel: 'ipad-aus' }));
  }
  body.appendChild(zeile);

  if (i.an && Array.isArray(i.adressen) && i.adressen.length) {
    body.appendChild(satz(`Erreichbar im WLAN unter ${i.adressen.map((a) => `${a.adresse}:${a.port}`).join(', ')} – nur mit Anmeldung. Die Freigabe gilt, bis Neural OS beendet wird.`, '.meta'));
  }

  if (geraete.length) {
    body.appendChild(h('div.setv__liste', null,
      h('span.label', null, text('Verbundene Geräte')),
      geraete.map((g) => h('div.setv__eintrag', null,
        h('span', null, text(g.name)),
        h('span.meta', null, text(g.zuletzt ? `zuletzt ${timeAgo(g.zuletzt)}` : `seit ${formatDate(g.seit)}`)),
        knopf(self, 'Trennen', async () => {
          try {
            await self.api.del(`/ipad/geraete/${encodeURIComponent(g.id)}`);
            self.ctx.toast('Getrennt. Das Gerät muss neu scannen, um wieder hereinzukommen.', 'success');
          } catch (err) {
            self.ctx.toast(`Nicht getrennt: ${fehlerText(err)}`, 'error');
          }
          await laden(self, 'ipad');
          if (self.alive) zeichneIpad(self);
        }, { art: '.btn--ghost.btn--small', schluessel: `trennen:${g.id}` })))));
  }

  // Was dieser Laptop nicht sehen kann, steht immer da -- nicht erst nach dem Scheitern.
  body.appendChild(h('p.setv__satz.meta', null, text(i.windows
    ? 'Windows fragt beim ersten Mal, ob Node.js im Netzwerk erreichbar sein darf. Ohne Administratorrechte (Schullaptop) lässt sich das oft nicht erlauben – dann erreicht das iPad den Laptop nicht. Viele Schul-WLANs trennen die Geräte außerdem voneinander.'
    : 'Kommt das iPad nicht durch: Beide müssen im selben WLAN sein. Eine Firewall (unter Windows fragt sie beim ersten Mal) oder ein Schul- oder Gast-WLAN, das Geräte voneinander trennt, kann die Verbindung verhindern.')));
}

async function ipadEinschalten(self) {
  try {
    const r = await self.api.post('/ipad', {}, { timeoutMs: 20000 });
    if (!self.alive) return;
    self.ui.ipad = { link: r.link, bis: Date.parse(r.bis), seit: Date.now(), verbunden: null };
    self.daten.ipad = { ...(self.daten.ipad || {}), ...r };
  } catch (err) {
    if (!self.alive) return;
    self.ctx.toast(fehlerText(err), 'error');
    await laden(self, 'ipad');
  }
  if (self.alive) zeichneIpad(self);
}

function qrBlock(self, ui) {
  let qr = null;
  try {
    qr = kodiere(ui.link);
  } catch (err) {
    return satz(`Der QR-Code ließ sich nicht erzeugen: ${fehlerText(err)}`, '.is-danger');
  }
  const { d, breite } = svgPfad(qr, 4);
  const bild = h('svg.setv__qr-bild', {
    viewBox: `0 0 ${breite} ${breite}`,
    role: 'img',
    'aria-label': 'QR-Code zum Verbinden des iPads',
    'shape-rendering': 'crispEdges',
  }, h('path', { d, fill: 'currentColor' }));
  const uhr = h('span.meta');
  const warten = h('p.setv__warten', null, h('span.spinner', { 'aria-hidden': 'true' }), text('Warte auf das iPad …'));
  const tick = () => {
    const rest = Math.max(0, Math.round((ui.bis - Date.now()) / 1000));
    if (rest <= 0) {
      uhr.textContent = 'Abgelaufen.';
      warten.textContent = 'Der Code ist abgelaufen. „Neuen Code zeigen“ macht einen frischen.';
      return false;
    }
    uhr.textContent = `Gilt noch ${Math.floor(rest / 60)}:${String(rest % 60).padStart(2, '0')} und nur einmal.`;
    return true;
  };
  tick();
  const t = setInterval(() => {
    if (!self.alive || !uhr.isConnected || !tick()) { clearInterval(t); self.timers.delete(t); }
  }, 1000);
  self.timers.add(t);
  const kopieren = h('button.btn.btn--ghost.btn--small', {
    type: 'button',
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(ui.link);
        self.ctx.toast('Link kopiert.', 'success');
      } catch {
        self.ctx.toast('Kopieren ging nicht. Der Link steht zum Abschreiben darunter.', 'info');
      }
    },
  }, icon(SYMBOLE.kopieren), text('Link kopieren'));
  return h('div.setv__qr', null,
    h('div.setv__qr-rahmen', null, bild),
    h('div.setv__qr-text', null,
      h('ol.setv__anleitung', null,
        h('li', null, text('Am iPad die Kamera öffnen und auf den Code halten.')),
        h('li', null, text('Auf den gelben Link tippen – Safari öffnet Neural OS.')),
        h('li', null, text('Fertig. Das iPad bleibt angemeldet.'))),
      uhr,
      warten,
      h('div.setv__zeile', null,
        knopf(self, 'Neuen Code zeigen', () => ipadEinschalten(self), { art: '.btn--ghost.btn--small', schluessel: 'ipad-neu' }),
        kopieren),
      h('code.setv__link', null, text(ui.link))));
}

/* ------------------------------------------------------------------ */
/* Darstellung                                                         */
/* ------------------------------------------------------------------ */

function zeichneDarstellung(self) {
  const { body } = self.dom.darstellung;
  clear(body);
  const state = self.ctx.state;
  const jetzt = state && typeof state.get === 'function' ? state.get('theme') : 'dark';
  status(self, 'darstellung', null, jetzt === 'light' ? 'Hell' : jetzt === 'system' ? 'Wie das System' : 'Dunkel');
  const optionen = [['dark', 'Dunkel'], ['light', 'Hell']];
  body.appendChild(h('div.setv__zeile', null,
    h('div.segmented', { role: 'radiogroup', 'aria-label': 'Darstellung' },
      optionen.map(([wert, wort]) => h('button.segmented__option', {
        type: 'button',
        role: 'radio',
        'aria-checked': jetzt === wert ? 'true' : 'false',
        class: jetzt === wert ? 'is-active' : null,
        onClick: () => {
          if (state && typeof state.set === 'function') state.set('theme', wert);
          zeichneDarstellung(self);
        },
      }, text(wort)))),
    h('span.meta', null, text('Gilt sofort, für diesen Browser.'))));
}

/* ------------------------------------------------------------------ */
/* Netzwerk (Verweis)                                                  */
/* ------------------------------------------------------------------ */

function netzSatz(mode) {
  if (mode === 'online') return ['accent', 'Online', 'Die KI und die Websuche dürfen ins Internet. Jede Verbindung steht im Netzwerk-Protokoll.'];
  if (mode === 'lan') return ['warn', 'Nur lokales Netz', 'Kein Internet – die KI ist so nicht erreichbar.'];
  if (mode === 'offline') return [null, 'Offline', 'Nichts verlässt diesen Rechner. Die KI antwortet erst, wenn Neural OS online ist.'];
  return [null, 'Unbekannt', 'Der Netzzustand ist gerade nicht abrufbar.'];
}

function zeichneNetz(self) {
  const { body } = self.dom.netz;
  clear(body);
  const mode = (self.daten.network && self.daten.network.mode)
    || (self.daten.status && self.daten.status.network && self.daten.status.network.mode) || null;
  const [punkt, wort, erklaerung] = netzSatz(mode);
  status(self, 'netz', punkt, wort);
  const ipadAn = !!(self.daten.ipad && self.daten.ipad.an);
  body.appendChild(h('div.setv__zeile', null,
    satz(ipadAn ? `${erklaerung} Ausnahme: das verbundene iPad im WLAN.` : erklaerung),
    h('span.spacer'),
    h('a.btn.btn--small', { href: '#/network' }, text('Zum Netzwerk'))));
}

/* ------------------------------------------------------------------ */
/* Speicher                                                            */
/* ------------------------------------------------------------------ */

function zeichneSpeicher(self) {
  const { body } = self.dom.speicher;
  clear(body);
  const s = self.daten.status;
  if (!s) {
    status(self, 'speicher', null, '');
    body.appendChild(nichtAbrufbar(self.fehler.status, 'Nicht abrufbar'));
    return;
  }
  const v = s.vault || {};
  const groesse = Number.isFinite(v.bytes) ? formatBytes(v.bytes) : null;
  status(self, 'speicher', null, groesse || '');
  const wo = s.portable
    ? `Auf dem Stick: ${s.portable.dataDir || s.portable.root}`
    : `Auf diesem Rechner: ${s.home || 'unbekannt'}`;
  body.appendChild(h('dl.setv__werte', null,
    h('dt', null, text('Ort')), h('dd', null, h('code', null, text(wo.replace(/^[^:]+: /, ''))), h('span.meta', null, text(s.portable ? ' (Stick)' : ' (dieser Rechner)'))),
    h('dt', null, text('Größe')), h('dd', null, text(groesse ? `${groesse} · ${formatNumber(v.records || 0)} Einträge` : 'unbekannt')),
    h('dt', null, text('Verschlüsselt')), h('dd', null, text(v.encrypted ? 'ja, mit PIN' : 'nein'))));
  body.appendChild(h('div.setv__zeile', null,
    h('a.btn.btn--small', { href: '#/stick' }, text('Stick')),
    h('a.btn.btn--small', { href: '#/backup' }, text('Sicherung'))));
}

/* ------------------------------------------------------------------ */
/* Für Fortgeschrittene                                                */
/* ------------------------------------------------------------------ */

function zeichneFortgeschritten(self) {
  const box = self.dom.fortgeschritten;
  clear(box);
  if (!besitzer(self)) {
    box.appendChild(satz('Nur am Laptop.', '.meta'));
    return;
  }
  box.appendChild(ordnerTeil(self));
  box.appendChild(zugangTeil(self));
  box.appendChild(diagnoseTeil(self));
}

function unterteil(titel, ...inhalt) {
  return h('section.setv__teil', { 'aria-label': titel }, h('h3', null, text(titel)), ...inhalt);
}

function ordnerTeil(self) {
  const w = self.daten.watch;
  if (!w) {
    return unterteil('Beobachtete Ordner', satz(self.fehler.watch ? `Nicht verfügbar: ${fehlerText(self.fehler.watch)}` : 'Nicht verfügbar.', '.meta'));
  }
  const items = Array.isArray(w.items) ? w.items : [];
  const pfad = h('input.input', { type: 'text', placeholder: 'Ordner, z. B. C:\\Users\\du\\Dokumente\\Schule', 'aria-label': 'Ordnerpfad', spellcheck: 'false' });
  const hinzufuegen = async () => {
    const wert = pfad.value.trim();
    if (!wert) return;
    try {
      await self.api.post('/watch', { path: wert });
      pfad.value = '';
      self.ctx.toast('Ordner hinzugefügt. Er ist noch aus, bis du ihn einschaltest.', 'success');
    } catch (err) {
      self.ctx.toast(fehlerText(err), 'error');
    }
    await laden(self, 'watch');
    if (self.alive) zeichneFortgeschritten(self);
  };
  return unterteil('Beobachtete Ordner',
    satz('Neural OS liest neue Dateien aus diesen Ordnern in den Tresor. Im Ordner selbst wird nichts geändert.', '.meta'),
    items.length ? h('div.setv__liste', null, items.map((item) => {
      const d = item.data || {};
      const schalter = h('input', {
        type: 'checkbox',
        checked: d.enabled === true,
        'aria-label': `${d.label || d.path} beobachten`,
        onChange: async (ev) => {
          const an = ev.currentTarget.checked;
          try {
            await self.api.patch(`/watch/${encodeURIComponent(item.id)}`, { enabled: an });
          } catch (err) {
            self.ctx.toast(fehlerText(err), 'error');
          }
          await laden(self, 'watch');
          if (self.alive) zeichneFortgeschritten(self);
        },
      });
      return h('div.setv__eintrag', null,
        h('label.setv__schalter', null, schalter, h('span', null, text(d.label || d.path))),
        h('span.meta', null, text(d.path || '')),
        knopf(self, 'Entfernen', async () => {
          try {
            await self.api.del(`/watch/${encodeURIComponent(item.id)}`);
          } catch (err) {
            self.ctx.toast(fehlerText(err), 'error');
          }
          await laden(self, 'watch');
          if (self.alive) zeichneFortgeschritten(self);
        }, { art: '.btn--ghost.btn--small' }));
    })) : satz('Noch kein Ordner.', '.meta'),
    h('div.setv__zeile', null, pfad, knopf(self, 'Hinzufügen', hinzufuegen, { schluessel: 'ordner' })));
}

function zugangTeil(self) {
  if (!self.daten.tokens) {
    return unterteil('Zugänge', satz(self.fehler.tokens ? `Nicht verfügbar: ${fehlerText(self.fehler.tokens)}` : 'Nicht verfügbar.', '.meta'));
  }
  const alle = Array.isArray(self.daten.tokens.items) ? self.daten.tokens.items : [];
  const aktive = alle.filter((t) => t.active);
  return unterteil('Zugänge',
    satz('Jedes verbundene Gerät hat einen eigenen Zugang. Ein widerrufener Zugang bleibt im Protokoll stehen.', '.meta'),
    aktive.length ? h('div.setv__liste', null, aktive.map((t) => h('div.setv__eintrag', null,
      h('span', null, text(t.label || t.id)),
      h('span.meta', null, text(t.lastUsedAt ? `zuletzt ${timeAgo(t.lastUsedAt)}` : 'noch nie benutzt')),
      knopf(self, 'Widerrufen', async () => {
        try {
          await self.api.del(`/tokens/${encodeURIComponent(t.id)}`);
        } catch (err) {
          self.ctx.toast(fehlerText(err), 'error');
        }
        await Promise.all([laden(self, 'tokens'), laden(self, 'ipad')]);
        if (self.alive) { zeichneFortgeschritten(self); zeichneIpad(self); }
      }, { art: '.btn--ghost.btn--small' })))) : satz('Keine aktiven Zugänge.', '.meta'));
}

function diagnoseTeil(self) {
  const s = self.daten.status;
  const v = self.daten.vault;
  const zeilen = [];
  if (s) {
    zeilen.push(['Version', `${s.version || '?'} · Node ${s.node || '?'}`]);
    zeilen.push(['Läuft seit', Number.isFinite(s.uptime) ? `${Math.round(s.uptime / 60)} Minuten` : 'unbekannt']);
    const aus = Object.entries(s.subsystems || {}).filter(([, an]) => !an).map(([name]) => name);
    zeilen.push(['Teilsysteme', aus.length ? `fehlt: ${aus.join(', ')}` : 'alle geladen']);
    const fehler = Array.isArray(s.failures) ? s.failures : [];
    zeilen.push(['Beim Start', fehler.length ? fehler.map((f) => `${f.subsystem}: ${f.reason}`).join(' · ') : 'keine Fehler']);
  } else {
    zeilen.push(['Status', self.fehler.status ? fehlerText(self.fehler.status) : 'nicht abrufbar']);
  }
  if (v && v.enabled) {
    zeilen.push(['Verschlüsselung', `${v.algorithm || 'aes-256-gcm'} · scrypt N=${v.N}, r=${v.r}, p=${v.p}`]);
  }
  if (v && v.schutz && v.schutz.geraeteOrdner) {
    zeilen.push(['Gemerkte Schlüssel', v.schutz.geraeteOrdner]);
  }
  return unterteil('Diagnose',
    h('dl.setv__werte', null, zeilen.flatMap(([k, w]) => [h('dt', null, text(k)), h('dd', null, text(w))])));
}

/* ------------------------------------------------------------------ */
/* Stil                                                                */
/* ------------------------------------------------------------------ */

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS; // hier geschrieben, niemals Nutzerdaten
  document.head.appendChild(node);
}

const CSS = `
.setv {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding-top: var(--sp-3);
}
.setv p { margin: 0; }
.setv__gruppe,
.setv__mehr {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-4);
  box-shadow: var(--shadow-1);
}
.setv__kopf {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-3) 0;
}
.setv__symbol {
  display: grid;
  place-items: center;
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: var(--r-full);
  background: var(--surface-3);
  color: var(--fg-muted);
}
.setv__titel { flex: 1 1 auto; min-width: 0; }
.setv__titel h2 {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 600;
  line-height: var(--lh-tight);
}
.setv__titel p {
  margin-top: 2px;
  color: var(--fg-muted);
  font-size: var(--fs-sm);
}
.setv__status { flex: none; padding-top: 2px; }
.setv__zustand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-sm);
  color: var(--fg-muted);
}
.setv__body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: var(--sp-2) var(--sp-3) var(--sp-3) calc(var(--sp-3) + 36px + var(--sp-2));
}
.setv__satz { color: var(--fg); line-height: var(--lh); }
.setv__satz.meta { color: var(--fg-subtle); font-size: var(--fs-sm); }
.setv__satz.is-warn { color: var(--warn); }
.setv__satz.is-danger { color: var(--danger); }
.setv__zeile {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--sp-1);
}
.setv__zeile > .setv__satz { flex: 1 1 260px; }
.setv__feld {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.setv__feld--breit { flex: 1 1 280px; }
.setv__schluessel {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  -webkit-text-security: disc;
}
.setv__pin {
  width: 11.5em;
  font-family: var(--font-mono);
  font-size: var(--fs-lg);
  letter-spacing: 0.35em;
  -webkit-text-security: disc;
}
.setv__meldung {
  min-height: 1.2em;
  font-size: var(--fs-sm);
  color: var(--fg-muted);
}
.setv__meldung:empty { display: none; }
.setv__meldung.is-danger { color: var(--danger); }
.setv__warnung {
  align-items: center;
  padding: 10px 12px;
  border-radius: var(--r-2);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  color: var(--fg);
  font-size: var(--fs-sm);
}
.setv__warnung > svg { color: var(--warn); flex: none; }
.setv__warnung > span { flex: 1 1 220px; }
.setv__segmente { align-self: flex-start; }
.setv__anbieter {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.setv__anbieter-kopf { display: flex; align-items: baseline; gap: 10px; }
.setv__anbieter-kopf strong { font-size: var(--fs-md); font-weight: 600; }
.setv__verbrauch {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sp-1) var(--sp-2);
  padding: 12px 14px;
  border-radius: var(--r-3);
  background: var(--surface-3);
}
.setv__verbrauch > div { display: flex; flex-direction: column; gap: 2px; }
.setv__verbrauch strong { font-size: var(--fs-md); font-weight: 600; }
.setv__verbrauch .meta { grid-column: 1 / -1; }
.setv__fakten {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.setv__fakten li { display: flex; align-items: center; gap: 10px; }
.setv__fakten .dot:not(.dot--accent) { background: var(--fg-subtle); }
.setv__schritte { display: flex; }
.setv__check {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
  font-size: var(--fs-sm);
}
.setv__check input { margin-top: 3px; accent-color: var(--accent); width: 16px; height: 16px; }
.setv__raster {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(11.5em, 1fr));
  gap: var(--sp-1) var(--sp-2);
}
.setv__liste {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.setv__liste > .label { margin-bottom: 4px; }
.setv__eintrag {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-1);
  padding: 8px 12px;
  border-radius: var(--r-2);
  background: var(--surface-3);
}
.setv__eintrag > span:first-child { display: inline-flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; }
.setv__eintrag > .btn { margin-left: auto; }
.setv__fakten {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.setv__fakt {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 10px 12px;
  border-radius: var(--r-2);
  background: var(--surface-3);
  transition: box-shadow 0.3s;
}
.setv__fakt-text { flex: 1 1 auto; min-width: 0; }
.setv__fakt-text > p:first-child { overflow-wrap: anywhere; line-height: var(--lh); }
.setv__fakt-text > .meta { margin-top: 2px; color: var(--fg-subtle); font-size: var(--fs-sm); }
.setv__fakt > .btn { flex: none; }
.setv__herkunft { color: var(--accent-text); text-decoration: none; }
.setv__herkunft:hover { text-decoration: underline; }
.setv__frage {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
  border-radius: var(--r-3);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
}
.setv__gruppe.is-ziel,
.setv__fakt.is-ziel { box-shadow: 0 0 0 2px var(--accent-ring), var(--shadow-1); }
.setv__gruppe { transition: box-shadow 0.3s; }
.setv__banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: var(--r-3);
  background: var(--accent-soft);
  color: var(--fg);
  font-size: var(--fs-sm);
}
.setv__banner svg { color: var(--accent-text); flex: none; }
.setv__hinweis:empty { display: none; }
.setv__erfolg {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--r-3);
  background: var(--accent-soft);
}
.setv__erfolg > svg { color: var(--accent-text); width: 22px; height: 22px; flex: none; }
.setv__erfolg .meta { margin-top: 4px; }
.setv__qr {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  align-items: flex-start;
}
/* Weiss auf Schwarz, in beiden Darstellungen: Die iPad-Kamera liest einen
   dunklen QR-Code auf hellem Grund zuverlässig, den umgekehrten nicht. Das ist
   keine Farbe des Aussehens, sondern eine Bedingung des Lesegeräts. */
.setv__qr-rahmen {
  flex: none;
  padding: 10px;
  border-radius: var(--r-3);
  background: #ffffff;
  color: #000000;
  line-height: 0;
}
.setv__qr-bild { width: 212px; height: 212px; }
.setv__qr-text {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1 1 240px;
  min-width: 0;
}
.setv__anleitung {
  margin: 0;
  padding-left: 1.2em;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.setv__warten {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--accent-text);
  font-size: var(--fs-sm);
}
.setv__link {
  display: block;
  padding: 8px 10px;
  border-radius: var(--r-2);
  background: var(--surface-3);
  color: var(--fg-subtle);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  word-break: break-all;
}
.setv__werte {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 6px var(--sp-2);
  margin: 0;
  font-size: var(--fs-sm);
}
.setv__werte dt { color: var(--fg-subtle); }
.setv__werte dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.setv__werte code { font-family: var(--font-mono); font-size: var(--fs-xs); }
.setv__mehr > summary {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  cursor: pointer;
  list-style: none;
  min-height: var(--tap-min);
}
.setv__mehr > summary::-webkit-details-marker { display: none; }
.setv__mehr > summary::before {
  content: '';
  width: 7px;
  height: 7px;
  border-right: 1.5px solid var(--fg-muted);
  border-bottom: 1.5px solid var(--fg-muted);
  transform: rotate(-45deg) translateY(-2px);
  transition: transform var(--dur-2) var(--ease);
}
.setv__mehr[open] > summary::before { transform: rotate(45deg) translateY(-2px); }
.setv__mehr-titel { font-weight: 600; font-size: var(--fs-md); }
.setv__mehr-inhalt { color: var(--fg-subtle); font-size: var(--fs-sm); }
.setv__mehr > .setv__body { padding-left: var(--sp-3); gap: var(--sp-3); }
.setv__teil { display: flex; flex-direction: column; gap: 10px; }
.setv__teil h3 { margin: 0; font-size: var(--fs-base); font-weight: 600; }
.setv__teil .setv__zeile .input { flex: 1 1 260px; width: auto; }
.setv__schalter { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; }
.setv__schalter input { accent-color: var(--accent); width: 16px; height: 16px; }
@media (max-width: 640px) {
  .setv__body { padding-left: var(--sp-3); }
  .setv__verbrauch { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .setv__qr-bild { width: 180px; height: 180px; }
}
`;
