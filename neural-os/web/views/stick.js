/**
 * views/stick.js -- „Stick": die KI zum Mitnehmen, per Knopfdruck.
 *
 * Was der Nutzer will
 * -------------------
 * „Stick rein, starten antippen, läuft – mit allem, was sie über mich weiß."
 * Nichts einrichten, nichts erklären, kein Schnickschnack. Diese Ansicht hat
 * deshalb genau vier Handgriffe, und jeder ist EIN Knopf:
 *
 *   1. Stick vorbereiten   – Programm, Laufzeiten, Wissen; was der Stick braucht
 *   2. Jetzt sichern       – auf den Stick, sonst in den Sicherungsordner
 *   3. Wiederherstellen    – klein darunter, weil man es selten braucht
 *   4. Beenden & abziehen  – speichern, auswerfen wo es geht, schließen
 *
 * Die frühere Ansicht „Sicherung" (views/backup.js) ist hier aufgegangen.
 *
 * Entscheidungen, die man beim Lesen sonst für Zufall hielte
 * ----------------------------------------------------------
 * - **Der Ort des Sticks ist EIN Feld**, vorbelegt mit dem Stick, den der
 *   Server an diesem Rechner gefunden hat; weitere stehen als antippbare
 *   Knöpfe darunter. Der Server sucht, nicht der Browser: der kennt keine
 *   Dateipfade, und auf dem iPad, das nur der Bildschirm ist, steckt gar
 *   kein Stick. Findet er keinen, steht genau das da.
 * - **Die Frage nach dem Internet kommt als zwei Knöpfe**, nicht als Dialog
 *   mit „Abbrechen": „Erlauben" oder „Nur <dieses System>". Ein Dialog kann
 *   Escape und Nein nicht unterscheiden -- dann hätte ein Wegklicken still
 *   einen halben Stick bestellt.
 * - **Der Balken ist gemessen.** Jede Bewegung kommt aus einem Ereignis des
 *   Servers. Eine Animation, die bei 90 % stehenbleibt, wäre hier besonders
 *   schädlich: die natürliche Reaktion auf „hängt" ist, den Stick abzuziehen.
 * - **„Jetzt kannst du den Stick abziehen" steht erst da, wenn der Server
 *   wirklich weg ist** -- die Ansicht fragt so lange nach, bis keiner mehr
 *   antwortet. Vorher heißt es „Wird beendet …".
 * - **Beim Tippen wird nichts neu gebaut außer dem, was vom Feld abhängt.**
 *   Ein voller Neuaufbau würde das Feld unter den Fingern austauschen.
 */

import {
  h, text, clear, icon, formatBytes, formatNumber, formatDateTime, timeAgo,
} from '../lib/dom.js';

/* ------------------------------------------------------------------ */
/* Wortschatz                                                          */
/* ------------------------------------------------------------------ */

const EIGENE_ICONS = {
  /** Auswerfen: Dreieck über einem Strich. */
  eject: '<path d="M10 4.2 15.4 11H4.6z"/><path d="M4.6 14.8h10.8"/>',
  download: '<path d="M10 3.4v9.2M6.2 9l3.8 3.8L13.8 9M4 16.2h12"/>',
  upload: '<path d="M10 16.4V7.2M6.2 11 10 7.2 13.8 11M4 3.8h12"/>',
  stop: '<rect x="5.4" y="5.4" width="9.2" height="9.2" rx="1.6"/>',
};

/**
 * Wiederherstellen: die Modi aus `POST /api/backup/import`, von „nimmt nichts
 * weg" nach „nimmt alles weg". Voreingestellt ist der ungefährliche.
 */
const MODI = [
  { value: 'merge', label: 'Ergänzen', gefahr: false },
  { value: 'replace', label: 'Gleiche ersetzen', gefahr: true },
  { value: 'fresh', label: 'Nur in leeren Tresor', gefahr: false },
  { value: 'restore', label: 'Alles ersetzen', gefahr: true },
];

const STYLE_ID = 'neural-os-stickv-style';

/** Wie lange nach „Beenden" nachgefragt wird, ob der Server noch antwortet. */
const WARTEN_MS = 20000;

function fehlerText(err) {
  if (!err) return 'Unbekannter Fehler.';
  return err.message ? String(err.message) : String(err);
}

/** Der erste Satz eines langen Grundes -- der Rest steht im Protokoll. */
function ersterSatz(satz) {
  const s = String(satz || '').trim();
  const m = /^(.{12,220}?[.!?])(\s|$)/.exec(s);
  return m ? m[1] : s.slice(0, 220);
}

/**
 * Die Rechnerfamilie zu einer Plattform. Für die Frage „Darf es?" zählt, ob
 * der Stick an Windows und am Mac startet -- ob Intel oder Apple-Chip, weiß
 * der Nutzer oft nicht und muss es hier auch nicht wissen.
 */
function familien(ids) {
  const namen = [];
  for (const id of ids || []) {
    const n = String(id).startsWith('win') ? 'Windows' : String(id).startsWith('darwin') ? 'Mac' : String(id).startsWith('linux') ? 'Linux' : id;
    if (!namen.includes(n)) namen.push(n);
  }
  return namen;
}

function aufzaehlen(namen) {
  const n = (namen || []).filter(Boolean);
  if (n.length <= 1) return n.join('');
  return `${n.slice(0, -1).join(', ')} und ${n[n.length - 1]}`;
}

/* ------------------------------------------------------------------ */
/* Ansicht                                                             */
/* ------------------------------------------------------------------ */

let view = null;

export default {
  id: 'stick',
  title: 'Stick',

  async mount(container, ctx) {
    ensureStyle();
    teardown();

    const self = {
      alive: true,
      ctx,
      api: ctx.api,
      icons: ctx.icons || {},
      container,
      requests: new Set(),
      timers: new Set(),

      selbst: null,
      selbstFehler: null,

      laufwerke: null,
      laufwerkeFehler: null,
      sucht: false,

      pfad: '',
      pfadVonHand: false,

      /* Stick vorbereiten */
      frage: null, // { plan } solange um Erlaubnis gefragt wird
      lauf: null,
      abbruch: null,
      laufSlot: null,

      /* Sichern */
      sicherung: null,
      sichernLaeuft: false,
      sichernFehler: null,
      gesichert: null,
      sichernSlot: null,

      /* Wiederherstellen */
      offen: false,
      liste: null,
      quelle: '',
      modus: 'merge',
      pass: '',
      vorschau: null,
      vorschauQuelle: null,
      vorschauFehler: null,
      vorschauLaeuft: false,
      ergebnis: null,
      ergebnisFehler: null,
      importLaeuft: false,

      /* Beenden */
      ende: null, // null | 'speichert' | 'wartet' | 'fertig' | 'haengt' | 'fehler'
      endeAntwort: null,
      endeFehler: null,
    };
    view = self;

    self.sucht = true;
    render(self);
    await Promise.all([ladeSelbst(self), ladeLaufwerke(self)]);
    if (!self.alive) return;
    if (!self.pfad) self.pfad = vorschlag(self);
    render(self);
    await ladeSicherung(self);
    if (self.alive) renderSichern(self);
  },

  async unmount() {
    teardown();
  },
};

function teardown() {
  const self = view;
  view = null;
  if (!self) return;
  self.alive = false;
  // Ein Wechsel des Bereichs baut den Strom ab, und der Server bricht dann ab
  // (stream.onClose). Ein Tab, den niemand mehr ansieht, darf keinen Stick zu
  // Ende beschreiben, von dem keiner weiß, dass er beschrieben wird.
  for (const controller of self.requests) {
    try { controller.abort(); } catch { /* schon vorbei */ }
  }
  self.requests.clear();
  for (const t of self.timers) clearTimeout(t);
  self.timers.clear();
  if (self.tippTimer) clearTimeout(self.tippTimer);
}

function request(self, run) {
  const controller = new AbortController();
  self.requests.add(controller);
  return run(controller.signal).finally(() => self.requests.delete(controller));
}

/* ------------------------------------------------------------------ */
/* Laden                                                               */
/* ------------------------------------------------------------------ */

async function ladeSelbst(self) {
  try {
    self.selbst = await request(self, (signal) => self.api.get('/stick', { signal }));
    self.selbstFehler = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.selbstFehler = err;
  }
}

async function ladeLaufwerke(self) {
  self.sucht = true;
  try {
    self.laufwerke = await request(self, (signal) => self.api.get('/stick/laufwerke', { signal, timeoutMs: 20000 }));
    self.laufwerkeFehler = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.laufwerke = null;
    self.laufwerkeFehler = err;
  } finally {
    self.sucht = false;
  }
}

/** Der beste Vorschlag für das Feld: ein fremder Stick vor dem eigenen. */
function vorschlag(self) {
  const liste = (self.laufwerke && self.laufwerke.laufwerke) || [];
  const fremd = liste.find((l) => !l.eigener);
  if (fremd) return fremd.pfad;
  const eigen = self.selbst && self.selbst.von && self.selbst.von.root;
  return eigen || '';
}

async function ladeSicherung(self) {
  const pfad = self.pfad.trim();
  try {
    self.sicherung = await request(self, (signal) => self.api.get('/stick/sicherung', {
      signal, query: pfad ? { path: pfad } : undefined,
    }));
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.sicherung = { fehler: fehlerText(err) };
  }
}

async function ladeListe(self) {
  const ziel = self.sicherung && self.sicherung.ziel;
  try {
    self.liste = await request(self, (signal) => self.api.get('/backup/list', {
      signal, query: ziel && ziel.pfad ? { dir: ziel.pfad } : undefined,
    }));
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.liste = { items: [], fehler: fehlerText(err) };
  }
}

/* ------------------------------------------------------------------ */
/* 1. Stick vorbereiten                                                */
/* ------------------------------------------------------------------ */

async function vorbereitenGeklickt(self) {
  const pfad = self.pfad.trim();
  if (!pfad || laeuft(self)) return;
  self.frage = null;
  let plan;
  try {
    plan = await request(self, (signal) => self.api.get('/stick/plan', { signal, query: { path: pfad } }));
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.lauf = { laeuft: false, fehler: fehlerText(err), percent: null, message: '' };
    renderLauf(self);
    return;
  }
  if (!self.alive) return;
  // Muss für die anderen Betriebssysteme einmal ins Internet, und erlaubt
  // die Schleuse das nicht schon von sich aus: fragen. Sonst sofort los.
  if (plan.download && plan.download.noetig && !plan.download.erlaubt) {
    self.frage = { plan };
    self.lauf = null;
    renderLauf(self);
    return;
  }
  await einrichten(self, { andereSysteme: true, erlaubnis: false });
}

async function einrichten(self, { andereSysteme, erlaubnis }) {
  const pfad = self.pfad.trim();
  if (!pfad || laeuft(self)) return;
  self.frage = null;
  const controller = new AbortController();
  self.abbruch = controller;
  self.requests.add(controller);
  self.lauf = { laeuft: true, percent: 0, message: 'Wird vorbereitet …', fehler: null, ergebnis: null, pfad };
  renderLauf(self);

  try {
    await self.api.stream('/stick/einrichten', {
      body: { path: pfad, andereSysteme, erlaubnis },
      signal: controller.signal,
      onEvent: (event) => {
        const lauf = self.lauf;
        if (!lauf || !self.alive) return;
        const nutz = event.payload || {};
        if (event.type === 'fortschritt') {
          if (Number.isFinite(nutz.percent)) lauf.percent = Math.max(lauf.percent || 0, nutz.percent);
          if (nutz.message) lauf.message = String(nutz.message);
        } else if (event.type === 'fertig') {
          lauf.ergebnis = nutz;
          lauf.percent = 100;
        } else if (event.type === 'fehler') {
          lauf.fehler = fehlerText(nutz.error);
        }
        // Nur der Fortschrittsblock: ein voller Neuaufbau mehrmals pro
        // Sekunde würde das Feld unter den Fingern austauschen.
        renderLauf(self);
      },
    });
  } catch (err) {
    if (self.lauf) {
      self.lauf.fehler = err && err.isAborted
        ? 'Abgebrochen. Auf dem Stick steht der Stand von vorher.'
        : fehlerText(err);
    }
  } finally {
    self.requests.delete(controller);
    self.abbruch = null;
    if (self.lauf) self.lauf.laeuft = false;
    if (self.alive) {
      // Danach gibt es auf dem Stick etwas Neues (Marke, Laufzeiten).
      await ladeLaufwerke(self);
      await ladeSicherung(self);
      if (self.alive) render(self);
    }
  }
}

function laeuft(self) {
  return !!(self.lauf && self.lauf.laeuft);
}

/* ------------------------------------------------------------------ */
/* 2. Sichern                                                          */
/* ------------------------------------------------------------------ */

async function sichern(self) {
  if (self.sichernLaeuft) return;
  self.sichernLaeuft = true;
  self.sichernFehler = null;
  self.gesichert = null;
  renderSichern(self);
  try {
    const pfad = self.pfad.trim();
    self.gesichert = await request(self, (signal) => self.api.post('/stick/sichern',
      pfad ? { path: pfad } : {}, { signal, timeoutMs: 600000 }));
    self.ctx.toast('Gesichert.', 'success');
    await ladeSicherung(self);
    if (self.offen) await ladeListe(self);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.sichernFehler = err;
  } finally {
    self.sichernLaeuft = false;
    if (self.alive) {
      renderSichern(self);
      if (self.offen) renderWieder(self);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. Wiederherstellen (die Funktion der früheren „Sicherung")         */
/* ------------------------------------------------------------------ */

function quelleKoerper(self) {
  const quelle = String(self.quelle || '').trim();
  const klein = quelle.toLowerCase();
  const body = klein.endsWith('.json') || klein.endsWith('.enc') ? { file: quelle } : { dir: quelle };
  if (self.pass) body.passphrase = self.pass;
  return body;
}

/**
 * Gilt die Vorschau noch für das, was eingestellt ist? Eine Vorschau ist eine
 * Aussage über GENAU EINE Sicherung in GENAU EINEM Modus; daneben ein anderer
 * Pfad oder Modus, und sie beschreibt etwas, das so nicht passieren würde.
 */
function vorschauGilt(self) {
  const v = self.vorschau;
  if (!v || v.mode !== self.modus) return false;
  return String(self.quelle || '').trim() === self.vorschauQuelle;
}

async function ansehen(self) {
  const quelle = String(self.quelle || '').trim();
  if (!quelle) return;
  self.vorschauLaeuft = true;
  self.vorschauFehler = null;
  self.ergebnis = null;
  self.ergebnisFehler = null;
  renderWieder(self);
  try {
    const r = await request(self, (signal) => self.api.post('/backup/preview',
      { ...quelleKoerper(self), mode: self.modus }, { signal, timeoutMs: 120000 }));
    if (!self.alive) return;
    self.vorschau = r;
    self.vorschauQuelle = quelle;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.vorschau = null;
    self.vorschauFehler = err;
  } finally {
    self.vorschauLaeuft = false;
    if (self.alive) renderWieder(self);
  }
}

async function wiederherstellen(self) {
  const quelle = String(self.quelle || '').trim();
  if (!quelle || !vorschauGilt(self)) return;
  const modus = MODI.find((m) => m.value === self.modus) || MODI[0];
  const v = self.vorschau;
  const zeilen = [];
  if (v && v.sicherung) zeilen.push(`${formatNumber(v.sicherung.records || 0)} Einträge kommen aus der Sicherung.`);
  if (v && Array.isArray(v.verschwindet) && v.verschwindet.length) zeilen.push(`Es verschwindet: ${v.verschwindet.join('; ')}.`);
  const ok = await self.ctx.confirm({
    title: modus.value === 'restore' ? 'Alles durch die Sicherung ersetzen?' : 'Wiederherstellen?',
    message: zeilen.join(' ') || quelle,
    confirmLabel: modus.value === 'restore' ? 'Ja, alles ersetzen' : 'Wiederherstellen',
    danger: modus.gefahr,
  });
  if (!ok || !self.alive) return;

  self.importLaeuft = true;
  self.ergebnis = null;
  self.ergebnisFehler = null;
  renderWieder(self);
  try {
    const r = await request(self, (signal) => self.api.post('/backup/import',
      { ...quelleKoerper(self), mode: self.modus }, { signal, timeoutMs: 600000 }));
    if (!self.alive) return;
    self.ergebnis = r;
    self.ctx.toast(`Wiederhergestellt: ${formatNumber((r && r.imported) || 0)} Einträge.`, 'success');
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.ergebnisFehler = err;
  } finally {
    self.importLaeuft = false;
    if (self.alive) renderWieder(self);
  }
}

/* ------------------------------------------------------------------ */
/* 4. Beenden & abziehen                                               */
/* ------------------------------------------------------------------ */

async function beenden(self) {
  if (laeuft(self) || self.sichernLaeuft || self.importLaeuft) {
    self.ctx.toast('Erst fertig werden lassen – sonst ist der Stick nur halb beschrieben.', 'info');
    return;
  }
  const ok = await self.ctx.confirm({
    title: 'Neural OS beenden?',
    message: 'Alles wird gespeichert, danach schließt Neural OS.',
    confirmLabel: 'Beenden',
  });
  if (!ok || !self.alive) return;

  self.ende = 'speichert';
  self.endeFehler = null;
  render(self);
  try {
    const pfad = self.pfad.trim();
    self.endeAntwort = await self.api.post('/stick/beenden', pfad ? { path: pfad } : {}, { timeoutMs: 30000 });
  } catch (err) {
    if (!self.alive) return;
    self.ende = 'fehler';
    self.endeFehler = err;
    render(self);
    return;
  }
  self.ende = 'wartet';
  render(self);
  const weg = await wartenBisWeg();
  if (!self.alive) return;
  self.ende = weg ? 'fertig' : 'haengt';
  render(self);
}

/**
 * Antwortet der Server noch? Erst wenn nicht, ist „abziehen" wahr.
 *
 * Absichtlich `fetch` und nicht `api.get`: gefragt wird nach dem Ausbleiben
 * einer Antwort, und das ist für die Hülle um `fetch` ein Fehlerfall, den sie
 * weitermelden würde. „Keine Antwort" hat zwei Gestalten: die Verbindung wird
 * abgelehnt, oder der Service Worker (web/sw.js) springt ein und meldet selbst
 * SERVER_UNREACHABLE -- gemessen: ohne diese zweite Lesart hielt die Ansicht
 * einen längst beendeten Server 20 Sekunden lang für lebendig.
 */
async function wartenBisWeg() {
  const bis = Date.now() + WARTEN_MS;
  while (Date.now() < bis) {
    await new Promise((r) => { setTimeout(r, 500); });
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);
    try {
      const res = await fetch('/api/status', { cache: 'no-store', signal: c.signal, credentials: 'same-origin' });
      if (res.status === 503) {
        const body = await res.json().catch(() => null);
        if (body && body.error && body.error.code === 'SERVER_UNREACHABLE') return true;
      }
    } catch {
      return true;
    } finally {
      clearTimeout(t);
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Aufbau                                                              */
/* ------------------------------------------------------------------ */

function render(self) {
  if (!self.alive || !self.container) return;
  clear(self.container);
  if (self.ende) {
    self.container.appendChild(endeBlock(self));
    return;
  }
  self.laufSlot = h('div.stickv__slot', { 'aria-live': 'polite' });
  self.sichernSlot = h('div.stickv__sichern');
  self.wiederSlot = h('div.stickv__wieder-inhalt');

  const page = h('div.page.stickv', null,
    vorbereitenKarte(self),
    sichernKarte(self),
    beendenKarte(self));
  self.container.appendChild(page);
  renderLauf(self);
  renderSichern(self);
  renderWieder(self);
}

/* ---------------------------------------------- 1. Stick vorbereiten */

function vorbereitenKarte(self) {
  const feld = h('input.input.stickv__feld', {
    type: 'text',
    value: self.pfad,
    placeholder: 'z. B. E:\\  oder  /Volumes/STICK',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
    'aria-label': 'Ort des Sticks',
    onInput: (e) => {
      self.pfad = e.target.value;
      self.pfadVonHand = true;
      pfadGeaendert(self);
    },
    onKeyDown: (e) => { if (e.key === 'Enter') vorbereitenGeklickt(self); },
  });
  self.feld = feld;

  const suchen = h('button.btn.btn--ghost.stickv__suchen', {
    type: 'button',
    disabled: self.sucht,
    onClick: async () => {
      await ladeLaufwerke(self);
      if (!self.alive) return;
      if (!self.pfadVonHand || !self.pfad.trim()) self.pfad = vorschlag(self);
      await ladeSicherung(self);
      render(self);
    },
  }, icon(self.icons.refresh || ''), text('Neu suchen'));

  const knopf = h('button.btn.btn--primary.stickv__los', {
    type: 'button',
    disabled: !self.pfad.trim() || laeuft(self),
    onClick: () => vorbereitenGeklickt(self),
  }, icon(self.icons.stick || ''), text('Stick vorbereiten'));
  self.losKnopf = knopf;

  return h('section.card.stickv__karte', { 'aria-label': 'Stick vorbereiten' },
    h('label.stickv__label', null, text('Wo steckt der Stick?')),
    h('div.stickv__feldzeile', null, feld, suchen),
    laufwerkeZeile(self),
    knopf,
    self.laufSlot);
}

function laufwerkeZeile(self) {
  if (self.sucht && !self.laufwerke) return h('p.stickv__still', null, text('Suche Sticks …'));
  if (self.laufwerkeFehler) {
    return h('p.stickv__still', null, text(`Die Suche ging nicht: ${fehlerText(self.laufwerkeFehler)}`));
  }
  const liste = (self.laufwerke && self.laufwerke.laufwerke) || [];
  if (!liste.length) {
    return h('p.stickv__still', { dataset: { leer: '1' } },
      text('Kein Stick gefunden. Steck ihn ein und tippe auf „Neu suchen“ – oder trag den Ort oben ein.'));
  }
  const gewaehlt = self.pfad.trim();
  return h('div.stickv__laufwerke', { role: 'list', 'aria-label': 'Gefundene Sticks' },
    liste.map((l) => {
      const aktiv = gleich(gewaehlt, l.pfad);
      const teile = [];
      if (l.name) teile.push(l.name);
      if (Number.isFinite(l.frei)) teile.push(`${formatBytes(l.frei)} frei`);
      if (l.eigener) teile.push('läuft von hier');
      else if (l.istStick) teile.push('Neural OS drauf');
      return h('button.stickv__laufwerk', {
        type: 'button',
        role: 'listitem',
        class: aktiv ? 'is-active' : '',
        'aria-pressed': aktiv ? 'true' : 'false',
        onClick: async () => {
          self.pfad = l.pfad;
          self.pfadVonHand = false;
          if (self.feld) self.feld.value = l.pfad;
          markiereLaufwerke(self);
          if (!laeuft(self)) self.lauf = null;
          self.frage = null;
          renderLauf(self);
          await ladeSicherung(self);
          renderSichern(self);
        },
      },
      h('span.stickv__laufwerk-pfad', null, text(l.pfad)),
      teile.length ? h('span.stickv__laufwerk-info', null, text(teile.join(' · '))) : null);
    }));
}

function gleich(a, b) {
  const n = (p) => String(p || '').trim().replace(/[\\/]+$/, '').toLowerCase();
  return n(a) !== '' && n(a) === n(b);
}

function markiereLaufwerke(self) {
  if (!self.container) return;
  const gewaehlt = self.pfad.trim();
  for (const b of self.container.querySelectorAll('.stickv__laufwerk')) {
    const pfad = b.querySelector('.stickv__laufwerk-pfad');
    const aktiv = !!pfad && gleich(gewaehlt, pfad.textContent);
    b.classList.toggle('is-active', aktiv);
    b.setAttribute('aria-pressed', aktiv ? 'true' : 'false');
  }
}

/** Beim Tippen: nur was vom Feld abhängt -- Knopf, Markierung, Sicherungsziel. */
function pfadGeaendert(self) {
  if (self.losKnopf) self.losKnopf.disabled = !self.pfad.trim() || laeuft(self);
  markiereLaufwerke(self);
  if (self.frage) { self.frage = null; renderLauf(self); }
  if (self.tippTimer) clearTimeout(self.tippTimer);
  self.tippTimer = setTimeout(async () => {
    self.tippTimer = null;
    if (!self.alive) return;
    await ladeSicherung(self);
    renderSichern(self);
  }, 450);
}

function renderLauf(self) {
  if (!self.alive || !self.laufSlot) return;
  clear(self.laufSlot);
  if (self.losKnopf) self.losKnopf.disabled = !self.pfad.trim() || laeuft(self);
  if (self.frage) {
    self.laufSlot.appendChild(frageBlock(self));
    return;
  }
  const lauf = self.lauf;
  if (!lauf) return;
  if (lauf.laeuft) {
    const p = Number.isFinite(lauf.percent) ? Math.max(0, Math.min(100, lauf.percent)) : 0;
    self.laufSlot.appendChild(h('div.stickv__lauf', null,
      h('div.stickv__bar', {
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': String(p),
        'aria-label': 'Fortschritt',
      }, h('div.stickv__bar-fill', { style: `width:${p}%` })),
      h('div.stickv__lauf-zeile', null,
        h('span.stickv__lauf-text', null, text(`${p} % · ${lauf.message || ''}`)),
        h('button.btn.btn--ghost.btn--small', {
          type: 'button',
          onClick: () => { if (self.abbruch) self.abbruch.abort(); },
        }, icon(EIGENE_ICONS.stop), text('Abbrechen')))));
    return;
  }
  if (lauf.fehler) {
    self.laufSlot.appendChild(h('div.stickv__meldung', { role: 'alert' },
      icon(self.icons.alert || ''), h('span', null, text(lauf.fehler))));
    return;
  }
  if (lauf.ergebnis) self.laufSlot.appendChild(fertigBlock(self, lauf.ergebnis));
}

/** Die eine Rückfrage: zwei Knöpfe, keine Erklärung. */
function frageBlock(self) {
  const plan = self.frage.plan;
  const hier = familien([plan.dieserRechner])[0] || plan.dieserRechnerName || 'dieses System';
  return h('div.stickv__frage', { role: 'group', 'aria-label': 'Einmal ins Internet?' },
    h('p.stickv__frage-text', null, text(
      `Damit der Stick auch an ${aufzaehlen(familien(plan.andere).filter((f) => f !== hier))} startet, lädt Neural OS einmal die Laufzeit `
      + 'dafür von nodejs.org. Darf es?')),
    h('div.stickv__antworten', null,
      h('button.btn.btn--accent', {
        type: 'button',
        onClick: () => einrichten(self, { andereSysteme: true, erlaubnis: true }),
      }, icon(self.icons.globe || ''), text('Erlauben')),
      h('button.btn.btn--accent', {
        type: 'button',
        onClick: () => einrichten(self, { andereSysteme: false, erlaubnis: false }),
      }, text(`Nur ${hier}`))));
}

function fertigBlock(self, r) {
  const namen = familien(Array.isArray(r.laufzeiten) ? r.laufzeiten : []);
  const fehlend = Array.isArray(r.fehlend) ? r.fehlend : [];
  return h('div.stickv__fertig', { role: 'status' },
    h('p.stickv__fertig-titel', null,
      h('span.stickv__haken', null, icon(self.icons.checkCircle || self.icons.check || '')),
      text('Der Stick ist fertig.')),
    h('p.stickv__still', null, text(namen.length
      ? `Startet an: ${aufzaehlen(namen)}.${r.wissen === 'blieb' ? ' Dein Wissen darauf blieb, wie es war.' : ''}`
      : 'Auf dem Stick liegt noch keine Laufzeit.')),
    ...fehlend.map((f) => h('p.stickv__hinweis', null,
      text(`${f.name || f.platform} fehlt: ${ersterSatz(f.grund)}`))),
    h('ol.stickv__schritte', null,
      h('li', null, text('Steck den Stick in den anderen Rechner und öffne ihn im Explorer oder Finder.')),
      h('li', null, text('Doppelklick auf „Neural OS starten“ – am Mac beim ersten Mal Rechtsklick und „Öffnen“.')),
      h('li', null, text('Zum Schluss hier „Beenden & abziehen“ tippen.'))));
}

/* ------------------------------------------------------- 2. Sichern */

function sichernKarte(self) {
  const details = h('details.stickv__wieder', {
    onToggle: async (e) => {
      self.offen = e.target.open;
      if (self.offen && !self.liste) {
        renderWieder(self);
        await ladeListe(self);
      }
      renderWieder(self);
    },
  },
  h('summary.stickv__wieder-titel', null, text('Von einer Sicherung wiederherstellen')),
  self.wiederSlot);
  if (self.offen) details.open = true;

  return h('section.card.stickv__karte', { 'aria-label': 'Sicherung' },
    self.sichernSlot,
    details);
}

function renderSichern(self) {
  if (!self.alive || !self.sichernSlot) return;
  clear(self.sichernSlot);
  const s = self.sicherung;
  let still = '';
  if (s && s.fehler) still = s.fehler;
  else if (s && s.letzte && s.letzte.at) {
    still = `Zuletzt gesichert ${timeAgo(s.letzte.at)} · ${s.letzte.art === 'stick' ? 'auf dem Stick' : 'im Sicherungsordner'}`;
  } else if (s) still = 'Noch keine Sicherung.';

  self.sichernSlot.appendChild(h('div.stickv__zeile', null,
    h('button.btn.btn--accent.stickv__sichern-knopf', {
      type: 'button',
      disabled: self.sichernLaeuft,
      onClick: () => sichern(self),
    }, self.sichernLaeuft ? h('span.spinner', { 'aria-hidden': 'true' }) : icon(EIGENE_ICONS.download),
    text(self.sichernLaeuft ? 'Wird gesichert …' : 'Jetzt sichern')),
    h('span.stickv__still', { title: s && s.letzte ? `${formatDateTime(s.letzte.at)} · ${s.letzte.dir}` : '' }, text(still))));

  if (self.sichernFehler) {
    self.sichernSlot.appendChild(h('div.stickv__meldung', { role: 'alert' },
      icon(self.icons.alert || ''), h('span', null, text(fehlerText(self.sichernFehler)))));
  } else if (self.gesichert) {
    const g = self.gesichert;
    self.sichernSlot.appendChild(h('p.stickv__still.stickv__pfad', { role: 'status' },
      text(`${formatNumber(g.records || 0)} Einträge · ${formatBytes(g.bytes || 0)} · ${g.dir}`)));
  }
}

function renderWieder(self) {
  if (!self.alive || !self.wiederSlot) return;
  clear(self.wiederSlot);
  if (!self.offen) return;

  const items = (self.liste && self.liste.items) || [];
  const quelleFeld = h('input.input', {
    type: 'text',
    value: self.quelle,
    spellcheck: 'false',
    placeholder: 'Ordner der Sicherung',
    'aria-label': 'Ordner oder Datei der Sicherung',
    onInput: (e) => {
      self.quelle = e.target.value;
      knoepfeNachziehen(self);
    },
  });

  const modusFeld = h('select.select', {
    'aria-label': 'Wie wiederherstellen',
    onChange: (e) => {
      self.modus = e.target.value;
      self.vorschau = null;
      self.ergebnis = null;
      renderWieder(self);
    },
  }, MODI.map((m) => h('option', { value: m.value }, text(m.label))));
  modusFeld.value = self.modus;

  const passFeld = h('input.input', {
    type: 'password',
    value: self.pass,
    autocomplete: 'off',
    placeholder: 'Passphrase, falls verschlüsselt',
    'aria-label': 'Passphrase der Sicherung',
    onInput: (e) => { self.pass = e.target.value; },
  });

  self.ansehenKnopf = h('button.btn', {
    type: 'button',
    disabled: self.vorschauLaeuft || !String(self.quelle || '').trim(),
    onClick: () => ansehen(self),
  }, text(self.vorschauLaeuft ? 'Wird gelesen …' : 'Erst ansehen'));

  self.zurueckKnopf = h('button.btn.btn--primary', {
    type: 'button',
    // Ohne gesehene Vorschau gibt es den Knopf nicht: nichts wird
    // geschrieben, bevor dasteht, was geschrieben wird.
    disabled: !vorschauGilt(self) || self.importLaeuft,
    onClick: () => wiederherstellen(self),
  }, icon(EIGENE_ICONS.upload), text(self.importLaeuft ? 'Läuft …' : 'Wiederherstellen'));

  self.wiederSlot.append(
    items.length
      ? h('div.stickv__liste', { role: 'list' }, items.slice(0, 6).map((item) => h('button.stickv__eintrag', {
        type: 'button',
        role: 'listitem',
        class: String(self.quelle || '').trim() === item.dir ? 'is-active' : '',
        onClick: () => {
          self.quelle = item.dir;
          self.vorschau = null;
          self.vorschauFehler = null;
          self.ergebnis = null;
          renderWieder(self);
          ansehen(self);
        },
      },
      h('span', null, text(item.at ? formatDateTime(item.at) : item.name)),
      h('span.stickv__still', null, text([
        item.records === null || item.records === undefined ? null : `${formatNumber(item.records)} Einträge`,
        ortName(self, item),
        item.sealed ? 'verschlüsselt' : null,
      ].filter(Boolean).join(' · '))))))
      : h('p.stickv__still', null, text(self.liste ? 'Hier liegt keine Sicherung.' : 'Suche Sicherungen …')),
    h('div.stickv__formular', null, quelleFeld, modusFeld, passFeld),
    h('div.stickv__zeile', null, self.ansehenKnopf, self.zurueckKnopf),
    vorschauBlock(self) || '',
    ergebnisBlock(self) || '');
}

/** Wo eine Sicherung liegt, in den Worten dieser Ansicht statt in denen der Liste. */
function ortName(self, item) {
  const ziel = self.sicherung && self.sicherung.ziel;
  if (item.ort === 'Auf dem Stick') return 'auf dem Stick';
  if (item.ort === 'Gewähltes Ziel') return ziel && ziel.art === 'stick' ? 'auf dem Stick' : 'im Sicherungsordner';
  if (item.ort === 'Im Programmverzeichnis') return 'im Sicherungsordner';
  return item.ort || null;
}

/**
 * Beim Tippen NUR die Knöpfe nachziehen, kein volles Neuzeichnen: das würde
 * das Feld bei jedem Zeichen austauschen und den Cursor verlieren.
 */
function knoepfeNachziehen(self) {
  if (self.ansehenKnopf) self.ansehenKnopf.disabled = self.vorschauLaeuft || !String(self.quelle || '').trim();
  if (self.zurueckKnopf) self.zurueckKnopf.disabled = !vorschauGilt(self) || self.importLaeuft;
  const slot = self.wiederSlot && self.wiederSlot.querySelector('.stickv__vorschau');
  if (slot) slot.hidden = !vorschauGilt(self);
}

function vorschauBlock(self) {
  if (self.vorschauFehler) {
    return h('div.stickv__meldung', { role: 'alert' },
      icon(self.icons.alert || ''), h('span', null, text(fehlerText(self.vorschauFehler))));
  }
  if (!vorschauGilt(self)) return null;
  const v = self.vorschau;
  const verschwindet = Array.isArray(v.verschwindet) ? v.verschwindet : [];
  return h('div.stickv__vorschau', { role: 'status' },
    h('p', null, h('strong', null, text('Das würde passieren – geschrieben ist noch nichts.'))),
    h('p', null, text(`${formatNumber(v.sicherung.records)} Einträge kommen`
      + (v.at ? ` (Stand ${formatDateTime(v.at)})` : '')
      + `, hier liegen jetzt ${formatNumber(v.hier.records)}.`)),
    verschwindet.length
      ? h('p.stickv__hinweis', null, text(`Es verschwindet: ${verschwindet.join('; ')}.`))
      : null,
    h('p.stickv__still', null, text('Zugangstoken und Netzmodus kommen nicht mit.')));
}

function ergebnisBlock(self) {
  if (self.ergebnisFehler) {
    return h('div.stickv__meldung', { role: 'alert' },
      icon(self.icons.alert || ''), h('span', null, text(`Nicht wiederhergestellt: ${fehlerText(self.ergebnisFehler)}`)));
  }
  const r = self.ergebnis;
  if (!r) return null;
  const warnungen = Array.isArray(r.warnings) ? r.warnings : [];
  return h('div.stickv__fertig', { role: 'status' },
    h('p.stickv__fertig-titel', null,
      h('span.stickv__haken', null, icon(self.icons.checkCircle || self.icons.check || '')),
      text(`${formatNumber(r.imported || 0)} Einträge wiederhergestellt.`)),
    ...warnungen.slice(0, 3).map((w) => h('p.stickv__hinweis', null, text(w))));
}

/* ------------------------------------------------- 4. Beenden & abziehen */

function beendenKarte(self) {
  const s = self.selbst;
  let wo = '';
  if (s && s.portabel && s.von) wo = `Läuft vom Stick ${s.von.root}`;
  else if (s) wo = 'Läuft von diesem Rechner';
  return h('section.card.stickv__karte', { 'aria-label': 'Beenden' },
    h('div.stickv__zeile', null,
      h('button.btn.stickv__ende-knopf', {
        type: 'button',
        onClick: () => beenden(self),
      }, icon(EIGENE_ICONS.eject), text('Beenden & abziehen')),
      wo ? h('span.stickv__still', null, text(wo)) : null));
}

function endeBlock(self) {
  const a = self.endeAntwort || {};
  const auswurf = a.auswurf || null;
  let titel;
  let zeile = null;
  let ton = 'ruhig';
  if (self.ende === 'speichert') {
    titel = 'Wird gespeichert …';
  } else if (self.ende === 'wartet') {
    titel = 'Wird beendet …';
    zeile = 'Alles ist gespeichert.';
  } else if (self.ende === 'fertig') {
    titel = 'Jetzt kannst du den Stick abziehen.';
    ton = 'gut';
    if (auswurf && auswurf.ausgeworfen === true) {
      zeile = 'Alles ist gespeichert, der Stick ist ausgeworfen.';
    } else if (auswurf && auswurf.ausgeworfen === false && auswurf.wie === 'diskutil') {
      zeile = 'Alles ist gespeichert. Der Mac hat den Stick nicht ausgeworfen – wirf ihn im Finder aus.';
    } else if (auswurf && auswurf.ausgeworfen === false) {
      zeile = `Alles ist gespeichert. Ausgeworfen hat ihn Windows nicht${auswurf.grund ? ` (${auswurf.grund})` : ''} – abziehen geht trotzdem.`;
    } else {
      zeile = 'Alles ist gespeichert.';
    }
  } else if (self.ende === 'haengt') {
    titel = 'Neural OS antwortet noch.';
    ton = 'warn';
    zeile = 'Alles ist gespeichert. Schließ das schwarze Fenster von Neural OS, dann kannst du den Stick abziehen.';
  } else {
    titel = 'Beenden ging nicht.';
    ton = 'warn';
    zeile = fehlerText(self.endeFehler);
  }
  let zeichen;
  if (ton === 'gut') zeichen = icon(self.icons.checkCircle || self.icons.check || '');
  else if (ton === 'warn') zeichen = icon(self.icons.alert || '');
  else zeichen = h('span.spinner', { 'aria-hidden': 'true' });
  return h('div.stickv__ende', { role: 'status', 'aria-live': 'polite', dataset: { ton, zustand: self.ende } },
    h('div.stickv__ende-zeichen', null, zeichen),
    h('h2.stickv__ende-titel', null, text(titel)),
    zeile ? h('p.stickv__ende-zeile', null, text(zeile)) : null,
    self.ende === 'fehler'
      ? h('button.btn', { type: 'button', onClick: () => { self.ende = null; render(self); } }, text('Zurück'))
      : null);
}

/* ------------------------------------------------------------------ */
/* Gestalt                                                             */
/* ------------------------------------------------------------------ */

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS; // hier geschrieben, niemals Nutzerdaten
  document.head.appendChild(node);
}

const CSS = `
.stickv {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.stickv p { margin: 0; }

.stickv__karte {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border-radius: var(--r-4);
  box-shadow: none;
}

.stickv__label {
  font-size: var(--fs-md);
  color: var(--fg);
}

.stickv__feldzeile {
  display: flex;
  gap: var(--sp-1);
  align-items: stretch;
}
.stickv__feld {
  flex: 1 1 auto;
  min-width: 0;
  min-height: var(--tap-min);
  font-size: var(--fs-md);
  font-family: var(--font-mono);
  border-radius: var(--r-3);
}
.stickv__suchen { min-height: var(--tap-min); }

.stickv__laufwerke {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
}
.stickv__laufwerk {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 2px;
  min-height: var(--tap-min);
  padding: var(--sp-1) 14px;
  background: var(--surface-3);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition: border-color var(--dur-1) var(--ease), background var(--dur-1) var(--ease);
}
.stickv__laufwerk:hover { border-color: var(--border-strong); }
.stickv__laufwerk.is-active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.stickv__laufwerk-pfad { font-family: var(--font-mono); font-size: var(--fs-base); }
.stickv__laufwerk-info { font-size: var(--fs-xs); color: var(--fg-muted); }

.stickv__los {
  min-height: 52px;
  font-size: var(--fs-md);
  border-radius: var(--r-3);
}
.stickv__los svg { width: 20px; height: 20px; }

.stickv__still {
  color: var(--fg-muted);
  font-size: var(--fs-sm);
  line-height: var(--lh);
}
.stickv__hinweis {
  color: var(--warn);
  font-size: var(--fs-sm);
  line-height: var(--lh);
}

.stickv__slot:empty { display: none; }

.stickv__lauf { display: flex; flex-direction: column; gap: var(--sp-1); }
.stickv__bar {
  height: 8px;
  background: var(--surface-3);
  border-radius: var(--r-full);
  overflow: hidden;
}
.stickv__bar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: var(--r-full);
  transition: width var(--dur-3) var(--ease);
}
.stickv__lauf-zeile { display: flex; align-items: center; gap: var(--sp-1); }
.stickv__lauf-text {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--fg-muted);
  font-size: var(--fs-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stickv__frage {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-2);
  background: var(--surface-3);
  border-radius: var(--r-3);
}
.stickv__frage-text { line-height: var(--lh); }
.stickv__antworten { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.stickv__antworten .btn { min-height: var(--tap-min); }

.stickv__fertig { display: flex; flex-direction: column; gap: var(--sp-1); }
.stickv__fertig-titel {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-md);
  font-weight: 500;
}
.stickv__haken { display: inline-flex; color: var(--accent-text); }
.stickv__schritte {
  margin: var(--sp-1) 0 0;
  padding-left: var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-05);
  line-height: var(--lh);
}
.stickv__schritte li::marker { color: var(--accent-text); }

.stickv__meldung {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-1);
  padding: 12px var(--sp-2);
  border-radius: var(--r-3);
  background: var(--danger-soft);
  color: var(--fg);
  font-size: var(--fs-sm);
  line-height: var(--lh);
  word-break: break-word;
}
.stickv__meldung svg { flex: none; color: var(--danger); margin-top: 1px; }

.stickv__zeile {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-1) var(--sp-2);
}
.stickv__sichern { display: flex; flex-direction: column; gap: var(--sp-1); }
.stickv__sichern-knopf, .stickv__ende-knopf { min-height: var(--tap-min); }
.stickv__pfad { word-break: break-all; }

.stickv__wieder { border-top: 1px solid var(--border); padding-top: var(--sp-2); }
.stickv__wieder-titel {
  cursor: pointer;
  color: var(--fg-muted);
  font-size: var(--fs-sm);
  min-height: 28px;
  display: flex;
  align-items: center;
}
.stickv__wieder-titel:hover { color: var(--fg); }
.stickv__wieder-inhalt {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding-top: var(--sp-2);
}
.stickv__wieder-inhalt:empty { display: none; }
.stickv__liste { display: flex; flex-direction: column; gap: var(--sp-05); }
.stickv__eintrag {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-1);
  min-height: 40px;
  padding: var(--sp-1) 12px;
  background: none;
  color: var(--fg);
  font: inherit;
  border: 1px solid var(--border);
  border-radius: var(--r-2);
  cursor: pointer;
  text-align: left;
}
.stickv__eintrag:hover { background: var(--surface-3); }
.stickv__eintrag.is-active { border-color: var(--accent); }
.stickv__formular {
  display: grid;
  grid-template-columns: 2fr 1.4fr 1.2fr;
  gap: var(--sp-1);
}
.stickv__vorschau {
  display: flex;
  flex-direction: column;
  gap: var(--sp-05);
  padding: 12px var(--sp-2);
  background: var(--surface-3);
  border-radius: var(--r-3);
  font-size: var(--fs-sm);
  line-height: var(--lh);
}

.stickv__ende {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-6) var(--sp-4);
  text-align: center;
}
.stickv__ende-zeichen { color: var(--fg-muted); }
.stickv__ende-zeichen svg { width: 44px; height: 44px; }
.stickv__ende[data-ton="gut"] .stickv__ende-zeichen { color: var(--accent-text); }
.stickv__ende[data-ton="warn"] .stickv__ende-zeichen { color: var(--warn); }
.stickv__ende-titel {
  margin: 0;
  font-size: var(--fs-display);
  font-weight: 500;
  line-height: var(--lh-tight);
  max-width: 22ch;
}
.stickv__ende-zeile { color: var(--fg-muted); max-width: 52ch; line-height: var(--lh); }

/* Mit dem Finger (iPad) ist auch die kleine Zeile ein ganzes Tippziel. */
@media (pointer: coarse) {
  .stickv__wieder-titel { min-height: var(--tap-min); }
}

@media (max-width: 720px) {
  .stickv__formular { grid-template-columns: 1fr; }
  .stickv__karte { padding: var(--sp-2); }
}
`;
