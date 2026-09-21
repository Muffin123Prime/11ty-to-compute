/**
 * views/backup.js -- „Sicherung": der Wissensstand speichern und zurückholen.
 *
 * Warum das ein eigener Bereich ist
 * ---------------------------------
 * Der Zweck ist ein Satz: *den Wissensstand speichern, falls alles verloren
 * geht, und auf einem neuen Gerät wiederherstellen.* Bis hierher war das der
 * vierte von neun Abschnitten auf einer 2455 Zeilen langen
 * Einstellungsseite -- unter „Darstellung" und über „Beobachtete Ordner", also
 * an der Stelle, an der man nach Schriftgrößen sucht. Von 93 Bildschirmfotos
 * der laufenden Anwendung zeigte keines diesen Abschnitt. Etwas, das man im
 * Notfall braucht, darf nicht erst gefunden werden müssen.
 *
 * Die Entscheidungen hinter diesem Bildschirm
 * -------------------------------------------
 * 1. **Zuerst die Frage, die man im Schadensfall stellt.** Ganz oben steht,
 *    WANN zuletzt gesichert wurde, WOHIN, WIE GROSS und WIE VIELE Sätze --
 *    und wenn nie, dann steht genau das da, in einem Kasten, der nicht wie
 *    eine Randnotiz aussieht. Alles andere ist Bedienung und kommt danach.
 * 2. **Nichts wird geraten.** Jede Zahl stammt aus `manifest.json` einer
 *    wirklich auf der Platte liegenden Sicherung (`GET /api/backup/list`).
 *    Wo nichts gemessen wurde, steht „unbekannt" und nicht eine Null, die wie
 *    eine Messung aussieht.
 * 3. **Das Ziel ist eine Entscheidung, keine Voreinstellung.** Ab Werk
 *    schreibt der Export nach `<home>/exports` -- also in genau den Ordner,
 *    der bei einem Plattendefekt mit verlorengeht. Die Zielauswahl sagt das
 *    in einem Satz und bietet, wenn diese Instanz von einem Stick läuft, den
 *    Stick als zweites Ziel an.
 * 4. **Vor dem Schreiben steht, was passieren wird.** „Wiederherstellen"
 *    ruft erst `POST /api/backup/preview` -- das schreibt nichts -- und zeigt
 *    die Zahlen: was kommt, was verschwindet, was NICHT mitreist. Erst danach
 *    gibt es den Knopf. Ein Import ist der einzige Vorgang dieses Programms,
 *    der fremde Daten über eigene legt; er darf nicht überraschen.
 * 5. **Klartext wird nicht kleingedruckt.** Eine Sicherung ohne eigene
 *    Passphrase ist der gesamte Tresor lesbar auf der Platte. Das steht in
 *    der Liste an jedem einzelnen Eintrag und im Ergebnis des Exports -- als
 *    Warnung, nicht als Fußnote.
 * 6. **Was nicht umgesetzt ist, wird nicht behauptet.** Der Netzmodus wird
 *    beim Wiederherstellen NICHT übernommen und Zugangstoken reisen nicht
 *    mit. Beides sind bewusste Entscheidungen des Servers; diese Ansicht
 *    zeigt sie an, statt den Eindruck von Vollständigkeit zu erzeugen.
 *
 * Was hier NICHT stattfindet
 * --------------------------
 * Das Ein- und Ausschalten der Tresorverschlüsselung. Das ist eine Eigenschaft
 * dieses Geräts und bleibt in den Einstellungen; eine Sicherung trägt niemals
 * Schlüsselmaterial mit sich. Die beiden zu vermischen wäre genau das
 * Missverständnis, das zu einem unlesbaren Tresor führt.
 */

import {
  h, text, clear, icon, formatBytes, formatNumber, formatDateTime, timeAgo,
} from '../lib/dom.js';

/* ------------------------------------------------------------------ */
/* Wortschatz                                                          */
/* ------------------------------------------------------------------ */

/** Ein Tresor mit Bügel: verschlossen aufbewahrt, nicht nur abgelegt. */
const VIEW_ICON = '<rect x="3" y="7.6" width="14" height="9.2" rx="2.2"/>'
  + '<path d="M6.4 7.6V5.4a3.6 3.6 0 0 1 7.2 0v2.2"/>'
  + '<circle cx="10" cy="12" r="1.5"/>';

const ICONS = {
  check: '<path d="m4.2 10.6 3.9 3.9 7.7-8.9"/>',
  alert: '<path d="M10 3.2 17.5 16.4h-15z"/><path d="M10 8.2v3.5M10 13.9h.01"/>',
  info: '<circle cx="10" cy="10" r="7.4"/><path d="M10 9.2v4.4M10 6.5h.01"/>',
  refresh: '<path d="M16.6 10a6.6 6.6 0 1 1-2.1-4.8"/><path d="M16.9 3v3.7h-3.7"/>',
  download: '<path d="M10 3.4v9.2M6.2 9l3.8 3.8L13.8 9M4 16.2h12"/>',
  upload: '<path d="M10 16.4V7.2M6.2 11 10 7.2 13.8 11M4 3.8h12"/>',
  copy: '<rect x="6.6" y="6.6" width="9" height="9" rx="2"/><path d="M13 4.4H6.2a1.8 1.8 0 0 0-1.8 1.8V13"/>',
  eye: '<path d="M1.8 10S4.8 4.8 10 4.8 18.2 10 18.2 10 15.2 15.2 10 15.2 1.8 10 1.8 10Z"/><circle cx="10" cy="10" r="2.1"/>',
  lock: '<rect x="4.4" y="8.6" width="11.2" height="8" rx="2.6"/><path d="M7 8.6V6.3a3 3 0 0 1 6 0v2.3"/>',
  unlock: '<rect x="4.4" y="8.6" width="11.2" height="8" rx="2.6"/><path d="M7 8.6V6.3a3 3 0 0 1 5.7-1.3"/>',
};

/**
 * Die Modi in der Reihenfolge, in der ein Mensch sie abwägt: von „nimmt
 * nichts weg" zu „nimmt alles weg". `restore` steht bewusst unten und ist
 * bewusst NICHT voreingestellt -- er löscht.
 */
const MODI = [
  {
    value: 'merge',
    label: 'Zusammenführen',
    folge: 'Vorhandene Einträge bleiben, wie sie sind. Nur was hier fehlt, kommt hinzu. Nichts wird überschrieben.',
    gefahr: false,
  },
  {
    value: 'replace',
    label: 'Einträge ersetzen',
    folge: 'Einträge mit derselben Kennung werden durch die Fassung aus der Sicherung überschrieben. '
      + 'Was hier zusätzlich liegt, bleibt liegen.',
    gefahr: true,
  },
  {
    value: 'fresh',
    label: 'Nur in einen leeren Tresor',
    folge: 'Bricht ab, sobald hier irgendetwas liegt – auch Gelöschtes. Auf einer frischen Installation '
      + 'liegt bereits die Erstausstattung des ersten Starts, deshalb scheitert dieser Modus dort.',
    gefahr: false,
  },
  {
    value: 'restore',
    label: 'Diese Installation vollständig ersetzen',
    folge: 'Löscht zuerst ALLES, was hier liegt – Einträge, Verknüpfungen, Gelöschtes und die '
      + 'Erstausstattung des ersten Starts – und spielt danach die Sicherung ein. Danach ist dieser '
      + 'Tresor genau der gesicherte Tresor. Das lässt sich nicht rückgängig machen.',
    gefahr: true,
  },
];

/** Satzarten mit menschlichem Namen, für die Zahlen in der Vorschau. */
const ARTEN = {
  note: 'Notizen',
  chat: 'Chats',
  message: 'Nachrichten',
  project: 'Projekte',
  task: 'Aufgaben',
  agent: 'Agenten',
  run: 'Agentenläufe',
  file: 'Dateien',
  edge: 'Verknüpfungen',
  entity: 'Entitäten',
  memory: 'Erinnerungen',
  grant: 'Netzfreigaben',
  peer: 'Gekoppelte Geräte',
  schedule: 'Zeitpläne',
  trigger: 'Auslöser',
  watch: 'Beobachtete Ordner',
  conflict: 'Konflikte',
  module: 'Erweiterungen',
  suggestion: 'Vorschläge',
  approval: 'Bestätigungen',
  token: 'Zugangstoken',
};

const STYLE_ID = 'neural-os-backupv-style';

function artName(art) {
  return ARTEN[art] || art;
}

function fehlerText(err) {
  if (!err) return 'Unbekannter Fehler.';
  if (err.message) return err.message;
  return String(err);
}

/* ------------------------------------------------------------------ */
/* Ansicht                                                             */
/* ------------------------------------------------------------------ */

let view = null;

export default {
  id: 'backup',
  title: 'Sicherung',
  icon: VIEW_ICON,

  async mount(container, ctx) {
    ensureStyle();
    teardown();

    const self = {
      alive: true,
      ctx,
      api: ctx.api,
      container,
      requests: new Set(),

      /** Die vorhandenen Sicherungen, aus GET /api/backup/list. */
      liste: null,
      listeFehler: null,
      laedt: true,

      /* --- Sichern --- */
      ziel: '',
      zielEigen: false,
      format: 'both',
      mitDateien: true,
      passphrase: '',
      sichernLaeuft: false,
      sichernSeit: 0,
      uhr: null,
      sicherung: null,
      sicherungFehler: null,

      /* --- Prüfen --- */
      pruefungFuer: null,
      pruefung: null,
      pruefungFehler: null,
      pruefungLaeuft: false,

      /* --- Wiederherstellen --- */
      quelle: '',
      modus: 'merge',
      importPass: '',
      vorschau: null,
      /** Der Pfad, für den die Vorschau gilt. Siehe vorschauGilt(). */
      vorschauQuelle: null,
      vorschauFehler: null,
      vorschauLaeuft: false,
      ergebnis: null,
      ergebnisFehler: null,
      importLaeuft: false,
    };
    view = self;

    await ladeListe(self);
    if (!self.alive) return;
    render(self);
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
  if (self.uhr) clearInterval(self.uhr);
  self.uhr = null;
  for (const controller of self.requests) {
    try { controller.abort(); } catch { /* schon vorbei */ }
  }
  self.requests.clear();
}

function request(self, run) {
  const controller = new AbortController();
  self.requests.add(controller);
  return run(controller.signal).finally(() => self.requests.delete(controller));
}

/* ------------------------------------------------------------------ */
/* Laden und Handeln                                                   */
/* ------------------------------------------------------------------ */

async function ladeListe(self) {
  self.laedt = true;
  try {
    // Das gewählte Ziel wird mitgeschickt: sonst sähe die Liste nur im
    // Programmverzeichnis nach, und wer auf einen Stick sichert, fände seine
    // eigenen Sicherungen hier nie wieder.
    const ziel = String(self.ziel || '').trim();
    const r = await request(self, (signal) => self.api.get('/backup/list', {
      signal, query: ziel ? { dir: ziel } : undefined,
    }));
    if (!self.alive) return;
    self.liste = r;
    self.listeFehler = null;
    // Das Ziel wird EINMAL vorbelegt und danach nie wieder überschrieben:
    // sonst verlöre der Mensch beim Neuladen, was er gerade getippt hat.
    if (!self.ziel && !self.zielEigen) self.ziel = standardZiel(r);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.liste = null;
    self.listeFehler = err;
  } finally {
    self.laedt = false;
  }
}

/**
 * Das voreingestellte Ziel.
 *
 * Läuft diese Instanz von einem Stick, ist der Stick das richtige Ziel: eine
 * Sicherung, die auf derselben Platte liegt wie das Original, überlebt genau
 * die Art von Schaden nicht, gegen die sie helfen soll. Auf der Platte bleibt
 * es beim Programmordner -- und der Satz daneben sagt, warum das zu wenig ist.
 */
function standardZiel(liste) {
  if (!liste) return '';
  const stick = (liste.orte || []).find((o) => o.label === 'Auf dem Stick');
  if (liste.portable && stick) return stick.dir;
  return liste.exportsDir || '';
}

async function sichern(self) {
  const ziel = String(self.ziel || '').trim();
  self.sichernLaeuft = true;
  self.sicherungFehler = null;
  self.sicherung = null;
  self.sichernSeit = Date.now();
  render(self);

  // Der Server schickt für den Export keine Fortschrittsereignisse. Eine
  // laufende Uhr ist das Einzige, was hier ehrlich angezeigt werden kann --
  // ein Balken wäre erfunden.
  if (self.uhr) clearInterval(self.uhr);
  self.uhr = setInterval(() => {
    if (!self.alive || !self.sichernLaeuft) return;
    renderSichernStatus(self);
  }, 1000);

  try {
    const body = {
      format: self.format,
      includeFiles: self.mitDateien === true,
    };
    // `parent`, nicht `dir`: in diesem Ordner entsteht eine NEUE Sicherung mit
    // Zeitstempel. `dir` würde den Ordner selbst beschreiben und eine dort
    // liegende ältere Sicherung ersetzen -- man hätte dann immer genau eine,
    // und die letzte gute wäre beim nächsten Klick weg.
    if (ziel) body.parent = ziel;
    if (self.passphrase) body.passphrase = self.passphrase;
    const r = await request(self, (signal) => self.api.post('/backup/export', body, { signal, timeoutMs: 600000 }));
    if (!self.alive) return;
    self.sicherung = r;
    self.ctx.toast('Sicherung geschrieben.', 'success');
    await ladeListe(self);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.sicherungFehler = err;
  } finally {
    self.sichernLaeuft = false;
    if (self.uhr) clearInterval(self.uhr);
    self.uhr = null;
    if (self.alive) render(self);
  }
}

async function pruefen(self, dir) {
  self.pruefungLaeuft = true;
  self.pruefungFuer = dir;
  self.pruefung = null;
  self.pruefungFehler = null;
  render(self);
  try {
    const r = await request(self, (signal) => self.api.get('/backup/verify', {
      query: { dir }, signal, timeoutMs: 120000,
    }));
    if (!self.alive) return;
    self.pruefung = r;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.pruefungFehler = err;
  } finally {
    self.pruefungLaeuft = false;
    if (self.alive) render(self);
  }
}

/** Quelle als Anfrage-Körper: eine export.json ist eine Datei, alles andere ein Ordner. */
function quelleKoerper(self) {
  const quelle = String(self.quelle || '').trim();
  const body = quelle.toLowerCase().endsWith('.json') || quelle.toLowerCase().endsWith('.enc')
    ? { file: quelle }
    : { dir: quelle };
  if (self.importPass) body.passphrase = self.importPass;
  return body;
}

async function ansehen(self) {
  const quelle = String(self.quelle || '').trim();
  if (!quelle) {
    self.vorschauFehler = new Error('Trage den Ordner der Sicherung ein, die du einspielen möchtest.');
    render(self);
    return;
  }
  self.vorschauLaeuft = true;
  self.vorschauFehler = null;
  self.ergebnis = null;
  self.ergebnisFehler = null;
  render(self);
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
    if (self.alive) render(self);
  }
}

async function wiederherstellen(self) {
  const quelle = String(self.quelle || '').trim();
  if (!quelle) return;
  const modus = MODI.find((m) => m.value === self.modus) || MODI[0];
  const v = self.vorschau;

  // Die Rückfrage benennt den konkreten Verlust, nicht „bist du sicher?".
  // Die Zahlen stammen aus der Vorschau, die dieselbe Datei gelesen hat.
  const zeilen = [modus.folge];
  if (v && Array.isArray(v.verschwindet) && v.verschwindet.length) {
    zeilen.push(`Es verschwindet: ${v.verschwindet.join('; ')}.`);
  }
  if (v && v.sicherung) {
    zeilen.push(`Aus der Sicherung kommen ${formatNumber(v.sicherung.records || 0)} Einträge.`);
  }
  zeilen.push(`Quelle: ${quelle}`);

  const ok = await self.ctx.confirm({
    title: modus.value === 'restore'
      ? 'Diese Installation vollständig durch die Sicherung ersetzen?'
      : `Wiederherstellen im Modus „${modus.label}“?`,
    message: zeilen.join(' '),
    confirmLabel: modus.value === 'restore' ? 'Ja, alles ersetzen' : 'Wiederherstellen',
    danger: modus.gefahr,
  });
  if (!ok || !self.alive) return;

  self.importLaeuft = true;
  self.ergebnis = null;
  self.ergebnisFehler = null;
  render(self);
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
    if (self.alive) render(self);
  }
}

/* ------------------------------------------------------------------ */
/* Aufbau                                                              */
/* ------------------------------------------------------------------ */

function render(self) {
  if (!self.alive || !self.container) return;

  const statusSlot = h('div.bkpv__statusslot');
  self.statusSlot = statusSlot;
  const s = sichernStatus(self);
  if (s) statusSlot.appendChild(s);

  const page = h('div.page.bkpv', null,
    h('header.page__head', null,
      h('div', null,
        h('h1.page__title', null, text('Sicherung')),
        h('p.page__subtitle', null, text(
          'Deinen Wissensstand speichern – und ihn auf einem anderen Gerät zurückholen.'))),
      h('div.page__actions', null,
        h('button.btn.btn--small', {
          type: 'button',
          disabled: self.laedt,
          onClick: async () => { await ladeListe(self); render(self); },
        }, icon(ICONS.refresh), text('Neu laden')))),
    h('div.stack', null,
      standBlock(self),
      sichernBlock(self, statusSlot),
      listeBlock(self),
      wiederherstellenBlock(self)));

  clear(self.container);
  self.container.appendChild(page);
}

/**
 * Gilt die vorliegende Vorschau noch für das, was gerade eingestellt ist?
 *
 * Eine Vorschau ist eine Aussage über GENAU EINE Sicherung in GENAU EINEM
 * Modus. Sobald der Pfad oder der Modus daneben ein anderer ist, beschreibt
 * sie etwas, das so nicht passieren würde – und dann darf weder sie dastehen
 * noch der Knopf freigegeben sein, der sie zur Bedingung hat.
 */
function vorschauGilt(self) {
  const v = self.vorschau;
  if (!v || v.mode !== self.modus) return false;
  // Verglichen wird mit dem, was GESENDET wurde, nicht mit dem Pfad, den der
  // Server zurückmeldet: der ist aufgelöst (absolut, Symlinks gefolgt) und
  // stimmt mit dem getippten Text berechtigterweise oft nicht überein.
  return String(self.quelle || '').trim() === self.vorschauQuelle;
}

/**
 * Was vom getippten Pfad abhängt, beim Tippen nachziehen.
 *
 * Getrennt von render(), weil ein volles render() das Eingabefeld ersetzt und
 * damit den Cursor verliert. Wer hier einen weiteren Knopf ergänzt, der einen
 * Pfad braucht, muss ihn auch hier eintragen – sonst bleibt er beim Tippen grau.
 */
function knoepfeNachziehen(self) {
  const hatQuelle = !!String(self.quelle || '').trim();
  if (self.ansehenKnopf) self.ansehenKnopf.disabled = self.vorschauLaeuft === true || !hatQuelle;
  const gueltig = vorschauGilt(self);
  if (self.zurueckKnopf) self.zurueckKnopf.disabled = !gueltig || self.importLaeuft === true;
  // Die Vorschau selbst verschwindet mit, statt Zahlen über einen anderen
  // Ordner stehenzulassen.
  if (self.vorschauSlot) self.vorschauSlot.hidden = !gueltig && !self.vorschauFehler;
}

/** Nur die laufende Uhr erneuern – ein volles render() würde das Zielfeld austauschen. */
function renderSichernStatus(self) {
  if (!self.alive || !self.statusSlot) return;
  clear(self.statusSlot);
  const s = sichernStatus(self);
  if (s) self.statusSlot.appendChild(s);
}

/* ------------------------------------------- 1. Wann zuletzt gesichert */

function standBlock(self) {
  if (self.listeFehler) {
    return h('section.card.bkpv__stand', { dataset: { ton: 'unbekannt' } },
      h('div.card__body.stack', null,
        h('p.bkpv__standtitel', null, icon(ICONS.alert), text(' Nicht feststellbar')),
        h('p', null, text(`Die vorhandenen Sicherungen konnten nicht gelesen werden: ${fehlerText(self.listeFehler)}`)),
        h('p.meta', null, text('Solange das so ist, kann hier niemand sagen, ob je eine Sicherung geschrieben wurde.'))));
  }
  if (self.laedt && !self.liste) {
    return h('section.card.bkpv__stand', { dataset: { ton: 'unbekannt' } },
      h('div.card__body', null, h('p.meta', null, text('Wird ermittelt …'))));
  }

  const items = (self.liste && self.liste.items) || [];
  if (!items.length) {
    return h('section.card.bkpv__stand', { dataset: { ton: 'keine' } },
      h('div.card__body.stack', null,
        h('p.bkpv__standtitel', null, icon(ICONS.alert), text(' Es gibt noch keine Sicherung.')),
        h('p', null, text(
          'Auf diesem Gerät liegt kein einziger Export. Geht die Platte kaputt, ist alles weg, '
          + 'was in diesem Tresor steht.')),
        h('p.meta', null, text('Der Knopf „Jetzt sichern“ weiter unten schreibt die erste.'))));
  }

  const letzte = items[0];
  const arten = Object.entries(letzte.byType || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  return h('section.card.bkpv__stand', { dataset: { ton: letzte.sealed ? 'gut' : 'klartext' } },
    h('div.card__body.stack', null,
      h('p.bkpv__standtitel', null,
        icon(ICONS.check),
        text(` Zuletzt gesichert: ${letzte.at ? formatDateTime(letzte.at) : 'Zeitpunkt unbekannt'}`)),
      letzte.at ? h('p.meta', null, text(`Das war ${timeAgo(letzte.at)}.`)) : null,
      h('dl.bkpv__fakten', null,
        faktum('Wohin', letzte.dir, { code: true }),
        faktum('Ort', letzte.ort || 'unbekannt'),
        faktum('Größe', letzte.bytes ? formatBytes(letzte.bytes) : 'unbekannt'),
        faktum('Sätze', letzte.records === null || letzte.records === undefined
          ? 'unbekannt'
          : `${formatNumber(letzte.records)}${arten.length ? ` (${arten.slice(0, 4).map(([t, n]) => `${formatNumber(n)} ${artName(t)}`).join(', ')}${arten.length > 4 ? ' …' : ''})` : ''}`),
        faktum('Anhänge', letzte.includeFiles === false
          ? 'keine – dieser Export wurde ohne Dateiinhalte geschrieben'
          : (letzte.files === null || letzte.files === undefined ? 'unbekannt' : formatNumber(letzte.files)))),
      letzte.sealed
        ? h('p.bkpv__gut', null, icon(ICONS.lock), text(
          ' Diese Sicherung ist mit einer eigenen Passphrase verschlüsselt. Ohne sie lässt sie sich nicht öffnen – auch von dir nicht.'))
        : h('p.bkpv__warnung', null, icon(ICONS.unlock), text(
          ' Diese Sicherung liegt im Klartext. Wer den Ordner lesen kann, liest deinen gesamten Tresor. '
          + 'Beim nächsten Sichern kannst du unten eine Passphrase vergeben.')),
      items.length > 1
        ? h('p.meta', null, text(`Insgesamt liegen ${formatNumber(items.length)} Sicherungen auf diesem Gerät.`))
        : null));
}

function faktum(name, wert, opts = {}) {
  return h('div.bkpv__faktum', null,
    h('dt', null, text(name)),
    h('dd', null, opts.code ? h('code.code.bkpv__pfad', null, text(String(wert))) : text(String(wert))));
}

/* ------------------------------------------------------- 2. Jetzt sichern */

function sichernBlock(self, statusSlot) {
  const zielFeld = h('input.input', {
    type: 'text',
    value: self.ziel,
    spellcheck: 'false',
    'aria-label': 'Zielordner der Sicherung',
    onInput: (event) => {
      self.ziel = event.target.value;
      self.zielEigen = true;
    },
  });

  const orte = (self.liste && self.liste.orte) || [];
  const vorschlaege = orte.filter((o) => o.dir);

  const formatFeld = h('select.select', {
    'aria-label': 'Format',
    onChange: (event) => { self.format = event.target.value; },
  },
  h('option', { value: 'both' }, text('JSON und Markdown – zum Zurückspielen und zum Lesen')),
  h('option', { value: 'json' }, text('Nur JSON – zum Zurückspielen')),
  h('option', { value: 'markdown' }, text('Nur Markdown – nur zum Lesen, NICHT zurückspielbar')));
  formatFeld.value = self.format;

  const dateienFeld = h('input', {
    type: 'checkbox',
    checked: self.mitDateien === true,
    onChange: (event) => { self.mitDateien = event.target.checked === true; },
  });

  const passFeld = h('input.input', {
    type: 'password',
    value: self.passphrase,
    autocomplete: 'new-password',
    placeholder: 'leer lassen = Klartext',
    'aria-label': 'Passphrase für diese Sicherung',
    onInput: (event) => { self.passphrase = event.target.value; },
  });

  return karte('Jetzt sichern', h('div.stack', null,
    h('label.field', null,
      h('span.label', null, text('Wohin')),
      zielFeld,
      h('span.hint', null, text(zielHinweis(self)))),
    vorschlaege.length
      ? h('div.row.bkpv__ziele', null,
        h('span.meta', null, text('Bekannte Orte:')),
        ...vorschlaege.map((o) => h('button.btn.btn--small.btn--ghost', {
          type: 'button',
          onClick: () => { self.ziel = o.dir; self.zielEigen = true; render(self); },
        }, text(o.label))))
      : null,
    h('label.field', null, h('span.label', null, text('Format')), formatFeld),
    h('label.bkpv__switch', null,
      h('span.bkpv__switch-box', null, dateienFeld),
      h('span.bkpv__switch-body', null,
        h('span.bkpv__switch-label', null, text('Angehängte Dateien mitnehmen')),
        h('span.bkpv__switch-hint', null, text(
          'Ohne diese Option enthält die Sicherung nur Texte und Verweise. Die Dateien selbst '
          + 'wären dann nicht wiederherstellbar.')))),
    h('label.field', null,
      h('span.label', null, text('Passphrase (freiwillig)')),
      passFeld,
      h('span.hint', null, text(
        'Mit Passphrase wird die Sicherung verschlüsselt. Sie ist bewusst nicht voreingestellt: '
        + 'eine vergessene Passphrase macht die Sicherung endgültig unlesbar, und das ist der '
        + 'größere Schaden als ein Ordner auf einer Platte, die dir gehört.'))),
    h('div.row', null,
      h('button.btn.btn--primary', {
        type: 'button',
        disabled: self.sichernLaeuft === true,
        onClick: () => sichern(self),
      }, icon(ICONS.download), text(self.sichernLaeuft ? 'Wird geschrieben …' : 'Jetzt sichern'))),
    statusSlot));
}

function zielHinweis(self) {
  const liste = self.liste;
  const exportsDir = (liste && liste.exportsDir) || '';
  const ziel = String(self.ziel || '').trim();
  const gemeinsam = 'In diesem Ordner entsteht bei jedem Sichern ein neuer Unterordner mit '
    + 'Zeitstempel – ältere Sicherungen bleiben also stehen. ';
  if (liste && liste.portable) {
    return gemeinsam + 'Diese Instanz läuft von einem Stick. Eine Sicherung auf dem Stick reist mit '
      + 'dir – sie überlebt aber nicht, wenn du den Stick verlierst. Am besten liegt eine Sicherung '
      + 'auf einem anderen Datenträger als das Original.';
  }
  if (ziel && exportsDir && ziel === exportsDir) {
    return gemeinsam + 'Achtung: Das ist der Ordner im Programmverzeichnis. Er liegt auf derselben '
      + 'Platte wie dein Tresor und geht bei einem Plattendefekt mit verloren. Für den Ernstfall '
      + 'gehört eine Sicherung auf einen USB-Stick oder ein anderes Laufwerk – trag den Pfad hier ein.';
  }
  return gemeinsam + 'Ein absoluter Pfad. Leer bedeutet: der Ordner „exports“ im '
    + 'Programmverzeichnis – also dieselbe Platte, auf der auch der Tresor liegt.';
}

function sichernStatus(self) {
  if (self.sichernLaeuft) {
    const sekunden = Math.max(0, Math.round((Date.now() - self.sichernSeit) / 1000));
    return h('div.bkpv__box', { role: 'status' },
      h('div.row', null,
        h('span.spinner', { 'aria-hidden': 'true' }),
        h('span', null, text(`Der Server schreibt die Sicherung … ${formatNumber(sekunden)} s`))),
      h('p.meta', null, text(
        'Dafür gibt es keine Fortschrittsmeldungen; hier läuft nur die Zeit. Fertig ist es, wenn der Pfad erscheint.')));
  }
  if (self.sicherungFehler) {
    return h('div.bkpv__box', { role: 'alert', dataset: { ton: 'schlecht' } },
      h('p.is-danger', null, text(`Die Sicherung konnte nicht geschrieben werden: ${fehlerText(self.sicherungFehler)}`)));
  }
  const r = self.sicherung;
  if (!r) return null;

  return h('div.bkpv__box', { role: 'status', dataset: { ton: r.sealed ? 'gut' : 'warnung' } },
    h('p', null, icon(ICONS.check), text(' Sicherung geschrieben.')),
    h('div.row.bkpv__pfadrow', null,
      h('code.code.bkpv__pfad', null, text(String(r.dir || ''))),
      h('button.btn.btn--small', {
        type: 'button',
        onClick: () => kopieren(self, String(r.dir || '')),
      }, icon(ICONS.copy), text('Pfad kopieren'))),
    // „Dateien" heißt hier: Dateien IM ORDNER (auch die Markdown-Fassung), in
    // der Liste darunter dagegen: Anhänge. Zwei verschiedene Zahlen unter
    // demselben Wort nebeneinander wäre genau die Art Unschärfe, wegen der man
    // einer Anzeige nicht mehr glaubt.
    h('p.meta', null, text(
      `${formatNumber(r.records || 0)} Sätze · ${formatNumber(r.files || 0)} Dateien geschrieben · `
      + `${formatBytes(r.bytes || 0)}`
      + (r.orphanFiles ? ` · davon ${formatNumber(r.orphanFiles)} Anhänge ohne Eintrag` : '')
      + (r.historyEntries ? ` · ${formatNumber(r.historyEntries)} Zeilen Änderungsverlauf` : ''))),
    r.withheld && r.withheld.token
      ? h('p.meta', null, text(`${formatNumber(r.withheld.token)} Zugangstoken wurden bewusst NICHT mitgenommen – `
        + 'sie gehören zu diesem Gerät und müssten anderswo neu angelegt werden.'))
      : null,
    r.sealed
      ? h('p.bkpv__gut', null, icon(ICONS.lock), text(
        ' Verschlüsselt. Ohne die Passphrase ist diese Sicherung nicht mehr zu öffnen – bewahre sie getrennt auf.'))
      : h('p.bkpv__warnung', null, icon(ICONS.unlock), text(
        ' Dieser Ordner liegt im Klartext: er enthält deinen gesamten Tresor lesbar. '
        + 'Leg ihn an einen Ort, an den sonst niemand kommt – oder sichere das nächste Mal mit Passphrase.')));
}

async function kopieren(self, wert) {
  try {
    await navigator.clipboard.writeText(wert);
    self.ctx.toast('Pfad kopiert.', 'success');
  } catch {
    // Ohne Erlaubnis für die Zwischenablage ist der Pfad trotzdem sichtbar.
    self.ctx.toast('Kopieren nicht erlaubt – der Pfad steht oben und lässt sich markieren.', 'info');
  }
}

/* ------------------------------------------------- 3. Vorhandene Sicherungen */

function listeBlock(self) {
  const items = (self.liste && self.liste.items) || [];
  const orte = (self.liste && self.liste.orte) || [];
  const unlesbar = orte.filter((o) => !o.lesbar);

  const inhalt = h('div.stack');
  if (!items.length) {
    inhalt.appendChild(h('p.meta', null, text('Keine Sicherung gefunden.')));
  } else {
    inhalt.appendChild(h('ul.bkpv__liste', null, ...items.map((item) => eintrag(self, item))));
  }
  for (const o of unlesbar) {
    inhalt.appendChild(h('p.meta', null, text(
      `${o.label}: ${o.dir} ist nicht lesbar – dort wurde nicht nachgesehen.`)));
  }
  // WO gesucht wurde, steht immer da -- nicht nur, wenn ein Ort unlesbar ist.
  // Sonst liest sich eine leere Liste wie „es gibt keine Sicherung", während
  // in Wahrheit nur an zwei Stellen nachgesehen wurde. Wer woanders hin
  // gesichert hat, findet seine Sicherung hier nicht und muss wissen, warum.
  const durchsucht = orte.filter((o) => o.lesbar).map((o) => o.dir);
  inhalt.appendChild(h('p.meta', null, text(
    durchsucht.length
      ? `Nachgesehen wurde in: ${durchsucht.join(', ')}. Eine Sicherung, die woanders liegt, `
        + 'steht hier nicht – das macht sie nicht schlechter, im Gegenteil. Zum Prüfen oder '
        + 'Zurückspielen trägst du ihren Pfad unten einfach ein.'
      : 'Es wurde nirgends nachgesehen: kein Ordner war lesbar.')));
  inhalt.appendChild(h('p.meta', null, text(
    'Gelesen wird dafür nur die Inhaltsangabe jedes Ordners (manifest.json). Ob eine Sicherung '
    + 'wirklich vollständig ist, sagt erst „Prüfen“ – das liest jede Datei und vergleicht ihre Prüfsumme.')));

  return karte('Vorhandene Sicherungen', inhalt);
}

function eintrag(self, item) {
  const geprueft = self.pruefungFuer === item.dir;
  const laeuft = geprueft && self.pruefungLaeuft;

  const zeilen = [
    item.records === null || item.records === undefined ? 'Sätze unbekannt' : `${formatNumber(item.records)} Sätze`,
    item.includeFiles === false
      ? 'ohne Anhänge geschrieben'
      : (item.files === null || item.files === undefined ? null : `${formatNumber(item.files)} Anhänge`),
    item.bytes ? formatBytes(item.bytes) : null,
    item.ort,
    item.format ? `Format: ${item.format}` : null,
  ].filter(Boolean);

  return h('li.bkpv__eintrag', { dataset: { verschluesselt: item.sealed ? '1' : '0' } },
    h('div.bkpv__eintrag-kopf', null,
      h('strong', null, text(item.at ? formatDateTime(item.at) : item.name)),
      h('span.spacer'),
      item.sealed
        ? h('span.badge', null, text('verschlüsselt'))
        : h('span.badge.badge--danger', null, text('Klartext'))),
    h('code.code.bkpv__pfad', null, text(item.dir)),
    h('p.meta', null, text(zeilen.join(' · '))),
    h('div.row.bkpv__eintrag-knoepfe', null,
      h('button.btn.btn--small', {
        type: 'button',
        disabled: self.pruefungLaeuft === true,
        onClick: () => pruefen(self, item.dir),
      }, icon(ICONS.check), text(laeuft ? 'Wird geprüft …' : 'Prüfen')),
      h('button.btn.btn--small', {
        type: 'button',
        onClick: () => {
          self.quelle = item.dir;
          self.vorschau = null;
          self.vorschauFehler = null;
          self.ergebnis = null;
          render(self);
          ansehen(self);
        },
      }, icon(ICONS.upload), text('Zum Wiederherstellen wählen')),
      h('button.btn.btn--small.btn--ghost', {
        type: 'button',
        onClick: () => kopieren(self, item.dir),
      }, icon(ICONS.copy), text('Pfad kopieren'))),
    geprueft ? pruefErgebnis(self) : null);
}

function pruefErgebnis(self) {
  if (self.pruefungLaeuft) {
    return h('div.bkpv__box', { role: 'status' }, h('p.meta', null, text('Jede Datei wird gelesen und ihre Prüfsumme verglichen …')));
  }
  if (self.pruefungFehler) {
    return h('div.bkpv__box', { dataset: { ton: 'schlecht' } },
      h('p.is-danger', null, text(`Nicht prüfbar: ${fehlerText(self.pruefungFehler)}`)));
  }
  const p = self.pruefung;
  if (!p) return null;
  const probleme = Array.isArray(p.problems) ? p.problems : [];
  // „extra" ist kein Mangel: daneben abgelegte eigene Dateien machen eine
  // Sicherung nicht ungültig. Das sagt der Server, und hier wird es nicht
  // zu einem Fehler umgedeutet.
  const echte = probleme.filter((x) => x.kind !== 'extra');

  return h('div.bkpv__box', { dataset: { ton: p.ok ? 'gut' : 'schlecht' } },
    h('p', null,
      icon(p.ok ? ICONS.check : ICONS.alert),
      text(p.ok
        ? ' Vollständig: jede Datei ist da und stimmt mit ihrer Prüfsumme überein.'
        : ` ${formatNumber(echte.length)} Beanstandung(en) – diese Sicherung ist nicht vollständig.`)),
    probleme.length
      ? h('ul.bkpv__probleme', null, ...probleme.slice(0, 12).map((x) => h('li', null,
        text(`${x.path || x.kind || 'Eintrag'}: ${x.message || 'ohne Angabe'}`))))
      : null,
    probleme.length > 12
      ? h('p.meta', null, text(`… und ${formatNumber(probleme.length - 12)} weitere.`))
      : null);
}

/* --------------------------------------------- 4. Wiederherstellen */

function wiederherstellenBlock(self) {
  const quelleFeld = h('input.input', {
    type: 'text',
    value: self.quelle,
    spellcheck: 'false',
    placeholder: '/pfad/zur/sicherung',
    'aria-label': 'Ordner oder Datei der Sicherung',
    // Beim Tippen NUR die Knöpfe nachziehen, kein volles render(): das würde
    // dieses Feld bei jedem Zeichen austauschen und den Cursor verlieren.
    // Ohne das Nachziehen bliebe „Erst ansehen" grau, obwohl ein Pfad dasteht
    // -- ein Knopf, der aus unerfindlichem Grund nicht geht.
    onInput: (event) => {
      self.quelle = event.target.value;
      knoepfeNachziehen(self);
    },
  });

  const passFeld = h('input.input', {
    type: 'password',
    value: self.importPass,
    autocomplete: 'off',
    placeholder: 'nur bei verschlüsselten Sicherungen',
    'aria-label': 'Passphrase der Sicherung',
    onInput: (event) => { self.importPass = event.target.value; },
  });

  const modusBox = h('div.stack');
  for (const m of MODI) {
    const eingabe = h('input', {
      type: 'radio',
      name: 'bkpv-modus',
      value: m.value,
      checked: m.value === self.modus,
      onChange: () => {
        self.modus = m.value;
        // Eine Vorschau gilt immer nur für EINEN Modus. Sie stehenzulassen,
        // während daneben ein anderer ausgewählt ist, wäre eine Aussage über
        // etwas, das so nicht passieren würde.
        self.vorschau = null;
        self.ergebnis = null;
        render(self);
      },
    });
    modusBox.appendChild(h('label.bkpv__switch', { dataset: { gefahr: m.gefahr ? '1' : '0' } },
      h('span.bkpv__switch-box', null, eingabe),
      h('span.bkpv__switch-body', null,
        h('span.bkpv__switch-label', null, text(m.label)),
        h('span.bkpv__switch-hint', null, text(m.folge)))));
  }

  const hatVorschau = vorschauGilt(self);

  self.vorschauSlot = h('div.bkpv__vorschauslot');
  const vb = vorschauBlock(self);
  if (vb) self.vorschauSlot.appendChild(vb);
  self.vorschauSlot.hidden = !vb;

  self.ansehenKnopf = h('button.btn', {
    type: 'button',
    disabled: self.vorschauLaeuft === true || !String(self.quelle || '').trim(),
    onClick: () => ansehen(self),
  }, icon(ICONS.eye), text(self.vorschauLaeuft ? 'Wird gelesen …' : 'Erst ansehen'));

  self.zurueckKnopf = h('button.btn.btn--primary', {
    type: 'button',
    // Ohne gesehene Vorschau gibt es den Knopf nicht. Das ist der Punkt
    // dieses Bildschirms: nichts wird geschrieben, bevor dasteht, was
    // geschrieben wird.
    disabled: !hatVorschau || self.importLaeuft === true,
    onClick: () => wiederherstellen(self),
  }, icon(ICONS.upload), text(self.importLaeuft ? 'Läuft …' : 'Wiederherstellen'));

  return karte('Wiederherstellen', h('div.stack', null,
    h('label.field', null,
      h('span.label', null, text('Ordner der Sicherung (oder eine export.json)')),
      quelleFeld,
      h('span.hint', null, text('Ein absoluter Pfad. Aus der Liste oben lässt er sich mit einem Klick übernehmen.'))),
    h('label.field', null,
      h('span.label', null, text('Passphrase der Sicherung')),
      passFeld,
      h('span.hint', null, text('Nur nötig, wenn die Sicherung mit einer eigenen Passphrase geschrieben wurde.'))),
    modusBox,
    h('div.row', null,
      self.ansehenKnopf,
      self.zurueckKnopf,
      hatVorschau
        ? null
        : h('span.hint', null, text('„Erst ansehen“ sagt, was passieren wird. Danach wird der zweite Knopf frei.'))),
    self.vorschauSlot,
    ergebnisBlock(self)));
}

function vorschauBlock(self) {
  if (self.vorschauFehler) {
    return h('div.bkpv__box', { role: 'alert', dataset: { ton: 'schlecht' } },
      h('p.is-danger', null, text(fehlerText(self.vorschauFehler))));
  }
  if (!vorschauGilt(self)) return null;
  const v = self.vorschau;

  const kommt = Object.entries(v.sicherung.byType || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const hier = Object.entries(v.hier.byType || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);

  return h('div.bkpv__box.bkpv__vorschau', { role: 'status', dataset: { ton: v.verschwindet.length ? 'warnung' : 'neutral' } },
    h('p.bkpv__vorschau-titel', null, icon(ICONS.info), text(' Das wird passieren – geschrieben ist noch nichts.')),

    h('div.bkpv__spalten', null,
      h('div', null,
        h('h4.bkpv__spalte-titel', null, text('Was kommt')),
        h('p', null, text(`${formatNumber(v.sicherung.records)} Sätze aus der Sicherung`
          + (v.at ? ` vom ${formatDateTime(v.at)}` : '') + '.')),
        kommt.length
          ? h('ul.bkpv__zahlen', null, ...kommt.map(([t, n]) => h('li', null,
            text(`${formatNumber(n)} ${artName(t)}`))))
          : null,
        h('p.meta', null, text(v.sicherung.includeFiles
          ? `${formatNumber(v.sicherung.files)} Anhänge sind enthalten.`
          : 'Diese Sicherung enthält keine Anhänge.'))),
      h('div', null,
        h('h4.bkpv__spalte-titel', null, text('Was jetzt hier liegt')),
        h('p', null, text(`${formatNumber(v.hier.records)} Sätze, ${formatNumber(v.hier.files)} Anhänge.`)),
        hier.length
          ? h('ul.bkpv__zahlen', null, ...hier.map(([t, n]) => h('li', null,
            text(`${formatNumber(n)} ${artName(t)}`))))
          : h('p.meta', null, text('Dieser Tresor ist leer.')))),

    v.verschwindet.length
      ? h('div.bkpv__verschwindet', null,
        h('h4.bkpv__spalte-titel', null, icon(ICONS.alert), text(' Was dabei verschwindet')),
        h('ul.bkpv__zahlen', null, ...v.verschwindet.map((s) => h('li', null, text(s)))))
      : null,

    v.hinweise.length
      ? h('ul.bkpv__zahlen.bkpv__hinweise', null, ...v.hinweise.map((s) => h('li', null, text(s))))
      : null,

    // Die beiden Sätze, wegen derer jemand sonst hinterher ratlos vor einem
    // Gerät steht, das ihn nicht mehr hereinlässt, stehen SICHTBAR da. Nur die
    // vollständige Aufzählung liegt hinter der Klappe -- was man aufklappen
    // muss, hat man nicht gelesen.
    h('p.bkpv__nichtmit', null, icon(ICONS.info), text(
      ' Nicht mit dabei: Zugangstoken für das lokale Netz, der Zugangsschlüssel gekoppelter Geräte '
      + 'und der Netzmodus — der bleibt auf dem Stand dieses Geräts, bis du ihn selbst änderst.')),
    h('details.bkpv__details', null,
      h('summary', null, text('Was NICHT mitreist — vollständig')),
      h('ul.bkpv__zahlen', null, ...v.reistNichtMit.map((s) => h('li', null, text(s))))),

    v.sealed
      ? h('p.meta', null, text('Diese Sicherung ist verschlüsselt und wurde mit der eingegebenen Passphrase geöffnet.'))
      : h('p.bkpv__warnung', null, icon(ICONS.unlock), text(
        ' Diese Sicherung liegt im Klartext auf der Platte.')));
}

function ergebnisBlock(self) {
  if (self.ergebnisFehler) {
    return h('div.bkpv__box', { role: 'alert', dataset: { ton: 'schlecht' } },
      h('p.is-danger', null, text(`Die Wiederherstellung ist fehlgeschlagen: ${fehlerText(self.ergebnisFehler)}`)),
      h('p.meta', null, text('Es wurde entweder alles oder nichts geschrieben – der Server führt den Import in einem Zug aus.')));
  }
  const r = self.ergebnis;
  if (!r) return null;

  const konflikte = Array.isArray(r.conflicts) ? r.conflicts : [];
  const fehler = Array.isArray(r.errors) ? r.errors : [];
  const warnungen = Array.isArray(r.warnings) ? r.warnings : [];

  return h('div.bkpv__box', { role: 'status', dataset: { ton: fehler.length ? 'schlecht' : 'gut' } },
    h('p', null, icon(fehler.length ? ICONS.alert : ICONS.check),
      text(` ${formatNumber(r.imported || 0)} Sätze übernommen, ${formatNumber(r.skipped || 0)} übersprungen, `
        + `${formatNumber(konflikte.length)} Konflikt(e).`)),
    r.purged && r.purged.records
      ? h('p', null, text(`${formatNumber(r.purged.records)} vorher vorhandene Sätze wurden dabei gelöscht`
        + (r.purged.files ? `, ${formatNumber(r.purged.files)} Dateiinhalte entfernt` : '') + '.'))
      : null,
    r.files !== undefined
      ? h('p.meta', null, text(`${formatNumber(r.files || 0)} Anhänge eingelesen`
        + (r.filesSkipped ? `, ${formatNumber(r.filesSkipped)} waren schon da` : '') + '.'))
      : null,
    r.history && r.history.message ? h('p.meta', null, text(r.history.message)) : null,
    // Die Ableitung der Verknüpfungen läuft nach dem Import EINMAL neu. Ohne
    // sie stimmt der Graph nicht mit den Daten überein, und das darf nicht
    // stillschweigend fehlen. Dass sie dabei Verknüpfungen ergänzt, ist der
    // Normalfall und keine Dublette: sie holt die Verweise nach, die beim
    // Schreiben noch ins Leere zeigten. Gesagt wird es trotzdem – eine Zahl,
    // die sich unerklärt ändert, macht misstrauisch.
    r.graph && r.graph.ok === false
      ? h('p.bkpv__warnung', null, icon(ICONS.alert), text(` ${r.graph.grund}`))
      : null,
    r.graph && r.graph.ok && (r.graph.angelegt || r.graph.entfernt)
      ? h('p.meta', null, text(
        `Die Verknüpfungen wurden danach einmal vollständig neu abgeleitet: `
        + `${formatNumber(r.graph.angelegt || 0)} ergänzt, ${formatNumber(r.graph.entfernt || 0)} entfernt `
        + `(${formatNumber(r.graph.geprueft || 0)} Einträge angesehen).`))
      : null,
    warnungen.length
      ? h('ul.bkpv__zahlen.bkpv__warnliste', null, ...warnungen.map((w) => h('li', null, text(w))))
      : null,
    fehler.length
      ? h('p.is-danger', null, text(`${formatNumber(fehler.length)} Eintrag/Einträge konnten nicht gelesen werden: `
        + fehler.slice(0, 3).map((e) => e.reason || 'ohne Angabe').join(' · ')))
      : null,
    h('p.meta', null, text('Änderungsverlauf und Suchindex werden nach einem Neustart des Programms vollständig sichtbar.')));
}

/* ------------------------------------------------------------------ */
/* Bausteine                                                           */
/* ------------------------------------------------------------------ */

function karte(titel, inhalt) {
  return h('section.card', { 'aria-label': titel },
    h('div.card__head', null, h('strong', null, text(titel))),
    h('div.card__body', null, inhalt));
}

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS; // hier geschrieben, niemals Nutzerdaten
  document.head.appendChild(node);
}

const CSS = `
.bkpv { max-width: 1000px; }
.bkpv p { margin: 0; }

.bkpv__stand { border-left: 4px solid var(--fg-subtle); }
.bkpv__stand[data-ton="gut"] { border-left-color: var(--ok); }
.bkpv__stand[data-ton="klartext"] { border-left-color: var(--warn); }
.bkpv__stand[data-ton="keine"] { border-left-color: var(--danger); }
.bkpv__standtitel { font-size: var(--fs-lg); display: flex; align-items: center; gap: var(--sp-1); }

.bkpv__fakten {
  margin: 0;
  display: grid;
  grid-template-columns: minmax(6rem, max-content) 1fr;
  gap: var(--sp-05) var(--sp-2);
  font-size: var(--fs-sm);
}
.bkpv__faktum { display: contents; }
.bkpv__faktum dt { color: var(--fg-muted); }
.bkpv__faktum dd { margin: 0; word-break: break-word; }

.bkpv__pfad { display: inline-block; word-break: break-all; font-size: var(--fs-xs); }
.bkpv__pfadrow { flex-wrap: wrap; gap: var(--sp-1); }
.bkpv__ziele { flex-wrap: wrap; gap: var(--sp-1); }

.bkpv__gut { color: var(--ok); display: flex; align-items: flex-start; gap: var(--sp-05); font-size: var(--fs-sm); }
.bkpv__warnung { color: var(--warn); display: flex; align-items: flex-start; gap: var(--sp-05); font-size: var(--fs-sm); }
.bkpv__gut svg, .bkpv__warnung svg { flex: none; }

.bkpv__box {
  padding: var(--sp-2);
  border: 1px solid var(--border);
  border-left: 4px solid var(--border-strong);
  border-radius: var(--r-2);
  background: var(--surface-2);
  font-size: var(--fs-sm);
  display: flex; flex-direction: column; gap: var(--sp-1);
  word-break: break-word;
}
.bkpv__box[data-ton="gut"] { border-left-color: var(--ok); }
.bkpv__box[data-ton="warnung"] { border-left-color: var(--warn); }
.bkpv__box[data-ton="schlecht"] { border-left-color: var(--danger); }

.bkpv__switch {
  display: flex; align-items: flex-start; gap: var(--sp-2);
  padding: var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
  cursor: pointer;
}
.bkpv__switch[data-gefahr="1"] { border-color: var(--danger); }
.bkpv__switch-box { flex: none; padding-top: 2px; }
.bkpv__switch-body { display: flex; flex-direction: column; gap: var(--sp-05); }
.bkpv__switch-label { font-weight: 600; }
.bkpv__switch-hint { color: var(--fg-muted); font-size: var(--fs-sm); }

.bkpv__liste { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.bkpv__eintrag {
  padding: var(--sp-2);
  border: 1px solid var(--border);
  border-left: 4px solid var(--warn);
  border-radius: var(--r-2);
  display: flex; flex-direction: column; gap: var(--sp-1);
}
.bkpv__eintrag[data-verschluesselt="1"] { border-left-color: var(--ok); }
.bkpv__eintrag-kopf { display: flex; align-items: center; gap: var(--sp-1); }
.bkpv__eintrag-knoepfe { flex-wrap: wrap; gap: var(--sp-1); }

.bkpv__spalten { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); }
.bkpv__spalte-titel { margin: 0 0 var(--sp-05); font-size: var(--fs-sm); display: flex; align-items: center; gap: var(--sp-05); }
.bkpv__zahlen { margin: 0; padding-left: var(--sp-3); display: flex; flex-direction: column; gap: 2px; }
.bkpv__hinweise { color: var(--fg-muted); }
.bkpv__warnliste { color: var(--warn); }
.bkpv__verschwindet { color: var(--danger); }
.bkpv__vorschau-titel { font-weight: 600; display: flex; align-items: center; gap: var(--sp-05); }
.bkpv__nichtmit { display: flex; align-items: flex-start; gap: var(--sp-05); color: var(--fg-muted); }
.bkpv__nichtmit svg { flex: none; }
.bkpv__details summary { cursor: pointer; color: var(--fg-muted); }
.bkpv__details ul { margin-top: var(--sp-1); }
.bkpv__probleme { margin: 0; padding-left: var(--sp-3); }

@media (max-width: 720px) {
  .bkpv__spalten { grid-template-columns: 1fr; }
  .bkpv__fakten { grid-template-columns: 1fr; gap: 0 0; }
  .bkpv__faktum dt { margin-top: var(--sp-1); }
}
`;
