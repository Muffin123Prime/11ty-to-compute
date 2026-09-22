/**
 * views/stick.js -- „Stick": das Hauptversprechen dieses Projekts, sichtbar.
 *
 * Worum es geht
 * -------------
 * Die KI mit allem Wissen auf einem Stick mitnehmen und an jedem Rechner
 * weiterarbeiten. Das konnte `src/portable/stick.js` seit langem -- aber nur
 * über die Kommandozeile. Diese Ansicht ist der Ort, an dem es stattfindet.
 *
 * Entscheidungen, die man beim Lesen sonst für Zufall hielte
 * ----------------------------------------------------------
 * 1. **Die Wahrheit über die laufende Instanz steht ganz oben, vor allem
 *    anderen.** „Du läufst gerade VOM STICK" ist eine andere Situation als
 *    „du läufst von der Platte", und wer das verwechselt, kopiert seinen
 *    Datenbestand im Kreis. Deshalb ist es keine Fußnote, sondern die erste
 *    Zeile.
 * 2. **Erst ansehen, dann schreiben.** Der Browser kennt keine Dateipfade; es
 *    gibt keinen Ordnerwähler, der einen absoluten Pfad liefert, also wird der
 *    Pfad getippt. Ein getippter Pfad neben einem Knopf, der sofort Gigabyte
 *    kopiert, ist eine Falle -- ein Tippfehler legt dann ein `app/` irgendwo
 *    auf der Platte an. „Erst ansehen" beantwortet vorher, was passieren
 *    WÜRDE, mit denselben Zahlen, die der Vorgang danach benutzt. Dasselbe tun
 *    die beobachteten Ordner in den Einstellungen, aus demselben Grund.
 * 3. **Der Fortschritt ist gemessen, nicht geschätzt.** Jede Zahl im Balken
 *    kommt aus einem echten Ereignis des Servers (`percent` aus kopierten
 *    Bytes). Eine erfundene Animation, die bei 90 % stehenbleibt, wäre hier
 *    besonders schädlich: die natürliche Reaktion auf „hängt" ist, den Stick
 *    abzuziehen.
 * 4. **Die unbequemen Wahrheiten stehen da, wo entschieden wird, nicht im
 *    Kleingedruckten.** Dass auf FAT32 keine Datei über 4 GB passt, dass es
 *    auf den meisten Sticks keine Zugriffsrechte gibt (und deshalb nur die
 *    Verschlüsselung schützt) und dass das SPRACHMODELL NICHT mitreist -- das
 *    sind die drei Sätze, wegen derer jemand hinterher enttäuscht wäre.
 * 5. **Die Laufzeiten sagen ehrlich, welcher Rechner geht und welcher nicht.**
 *    Mitkopiert wird immer nur die Laufzeit DIESES Rechners; sie braucht kein
 *    Netz. Jede weitere ist ein einmaliger Download durch die Netzschleuse,
 *    und wenn die Schleuse zu ist, ist das kein Fehler des Sticks.
 * 6. **Das Modell reist nur mit, wenn man es dazulegt -- und der Abschnitt
 *    dazu sagt die Wahrheit, BEVOR jemand klickt.** Was auf diesem Rechner
 *    gefunden wurde (mit Grösse), was auf dem Stick liegt und für welches
 *    Betriebssystem, ob das Dateisystem eine 4-GB-Datei überhaupt aufnimmt,
 *    ob der Platz reicht: alles kommt aus `GET /api/stick/models`, das nichts
 *    schreibt. Nichts gefunden? Dann steht da, was zu tun wäre, und kein
 *    leerer Kasten. Ein Laufzeitkern für ein anderes Betriebssystem lässt
 *    sich -- anders als die Node-Laufzeit -- NICHT herunterladen; dafür
 *    braucht es einen Rechner mit diesem System, und das steht genau dort,
 *    wo es auffällt.
 */

import {
  h, text, clear, icon, formatBytes, formatNumber, formatDateTime,
} from '../lib/dom.js';

/* ------------------------------------------------------------------ */
/* Wortschatz                                                          */
/* ------------------------------------------------------------------ */

/** Ein USB-Stick: Gehäuse mit Kontaktstück. */
const VIEW_ICON = '<rect x="6.6" y="6.2" width="6.8" height="11.2" rx="1.6"/>'
  + '<path d="M8.4 6.2V3.4a1.6 1.6 0 0 1 1.6-1.6h0a1.6 1.6 0 0 1 1.6 1.6v2.8"/>'
  + '<path d="M8.8 10.2h2.4M8.8 12.8h2.4"/>';

const ICONS = {
  eye: '<path d="M1.8 10S4.8 4.6 10 4.6 18.2 10 18.2 10 15.2 15.4 10 15.4 1.8 10 1.8 10Z"/><circle cx="10" cy="10" r="2.4"/>',
  check: '<path d="m4.2 10.6 3.9 3.9 7.7-8.9"/>',
  alert: '<path d="M10 3.2 17.5 16.4h-15z"/><path d="M10 8.2v3.5M10 13.9h.01"/>',
  refresh: '<path d="M16.6 10a6.6 6.6 0 1 1-2.1-4.8"/><path d="M16.9 3v3.7h-3.7"/>',
  download: '<path d="M10 3.4v9M6.2 9l3.8 3.8L13.8 9"/><path d="M3.6 15.8h12.8"/>',
  stop: '<rect x="5.4" y="5.4" width="9.2" height="9.2" rx="1.6"/>',
};

/** Menschliche Namen für die Node-Plattformkennungen. */
const PLATTFORM_NAMEN = {
  'win-x64': 'Windows (Intel/AMD, 64 Bit)',
  'win-arm64': 'Windows (ARM)',
  'darwin-x64': 'macOS (Intel)',
  'darwin-arm64': 'macOS (Apple Silicon)',
  'linux-x64': 'Linux (Intel/AMD, 64 Bit)',
  'linux-arm64': 'Linux (ARM, 64 Bit)',
  'linux-armv7l': 'Linux (ARM, 32 Bit – z. B. Raspberry Pi)',
};

const STYLE_ID = 'neural-os-stickv-style';

function plattformName(id) {
  return PLATTFORM_NAMEN[id] || id || 'unbekanntes System';
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
  id: 'stick',
  title: 'Stick',
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

      selbst: null,
      selbstFehler: null,
      laedt: true,

      pfad: '',
      mitDaten: false,

      vorschau: null,
      vorschauFehler: null,
      vorschauLaeuft: false,

      pruefung: null,
      pruefungFehler: null,
      pruefungLaeuft: false,

      /** Der laufende oder zuletzt gelaufene Vorgang. */
      lauf: null,
      abbruch: null,
      /** Nur dieser Teilbaum wird beim Fortschritt neu gebaut, siehe renderLauf(). */
      laufSlot: null,

      /** Antwort von GET /stick/models: rechner, stick, vorschau. */
      modelle: null,
      modelleFehler: null,
      modelleLaedt: false,
      /** Der Pfad, für den `modelle.stick` und `modelle.vorschau` gelten. */
      modellePfad: '',
      /** Für welches Gerät gefragt wird ('' = dieser Rechner, sonst Plattform oder 'ipados'). */
      fuer: '',
      /** Die gewählten Kennungen; null heisst: alles, was gefunden wurde. */
      auswahl: null,
      /** Erst wenn jemand ein Kästchen berührt hat, überlebt die Auswahl ein „Neu nachsehen". */
      auswahlVonHand: false,
      modellPlan: null,
      modellPlanFehler: null,
      modellPlanLaeuft: false,
    };
    view = self;

    await ladeSelbst(self);
    if (!self.alive) return;
    render(self);
    // Der Befund über diesen Rechner soll dastehen, ohne dass jemand klickt --
    // nach der Selbstauskunft, weil der Pfad des eigenen Sticks daraus kommt.
    await ladeModelle(self);
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
  // Ein Wechsel des Bereichs beendet einen laufenden Kopiervorgang NICHT
  // stillschweigend -- aber der Strom wird abgebaut, und der Server bricht
  // daraufhin ab (stream.onClose -> AbortController). Das ist die ehrliche
  // Variante: ein Tab, den niemand mehr ansieht, darf keine 8 GB zu Ende
  // kopieren, und der Stick bleibt durch die zweistufige Umbenennung auf dem
  // Stand von vorher.
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
/* Laden                                                               */
/* ------------------------------------------------------------------ */

async function ladeSelbst(self) {
  self.laedt = true;
  try {
    const r = await request(self, (signal) => self.api.get('/stick', { signal }));
    if (!self.alive) return;
    self.selbst = r;
    self.selbstFehler = null;
    // Läuft die Instanz schon vom Stick, ist der Pfad bekannt und muss nicht
    // getippt werden. Vorbereiten und Erneuern gehen auf diesem Pfad zwar
    // nicht (siehe istEigenerStick), aber Prüfen und Laufzeiten-Holen schon --
    // und beides ist genau das, was man auf einem fremden Rechner will.
    if (!self.pfad && r && r.von && r.von.root) self.pfad = r.von.root;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.selbst = null;
    self.selbstFehler = err;
  } finally {
    self.laedt = false;
  }
}

async function ansehen(self) {
  const pfad = self.pfad.trim();
  if (!pfad) return;
  self.vorschauLaeuft = true;
  self.vorschauFehler = null;
  render(self);
  try {
    const r = await request(self, (signal) => self.api.get('/stick/preview', {
      signal,
      query: { path: pfad, action: 'prepare', vault: self.mitDaten ? '1' : '0' },
      // Den Quelltext und einen ganzen Datenbestand zu vermessen dauert auf
      // einem grossen Heimatordner länger als die üblichen 30 Sekunden.
      timeoutMs: 120000,
    }));
    if (!self.alive) return;
    self.vorschau = r;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.vorschau = null;
    self.vorschauFehler = err;
  } finally {
    self.vorschauLaeuft = false;
    render(self);
  }
}

async function pruefen(self) {
  const pfad = self.pfad.trim();
  if (!pfad) return;
  self.pruefungLaeuft = true;
  self.pruefungFehler = null;
  render(self);
  try {
    const r = await request(self, (signal) => self.api.get('/stick/verify', {
      signal, query: { path: pfad }, timeoutMs: 60000,
    }));
    if (!self.alive) return;
    self.pruefung = r;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.pruefung = null;
    self.pruefungFehler = err;
  } finally {
    self.pruefungLaeuft = false;
    render(self);
  }
  // Wer den Stick prüft, will auch wissen, was an Modellen darauf liegt --
  // derselbe Pfad, keine zweite Eingabe.
  if (self.alive && self.modellePfad !== pfad) {
    await ladeModelle(self);
    render(self);
  }
}

/**
 * Was liegt an Modellen hier und auf dem Stick -- ohne zu schreiben.
 *
 * Läuft beim Öffnen der Ansicht (dann ohne Pfad, oder mit dem des eigenen
 * Sticks) und noch einmal, sobald ein Pfad geprüft wird. Der Server sucht
 * dabei in Ollamas Speicher und im PATH; das dauert auf einem grossen
 * Modellordner länger als die üblichen 30 Sekunden.
 */
async function ladeModelle(self) {
  const pfad = self.pfad.trim();
  self.modelleLaedt = true;
  self.modelleFehler = null;
  try {
    const query = {};
    if (pfad) query.path = pfad;
    if (self.fuer) query.fuer = self.fuer;
    const r = await request(self, (signal) => self.api.get('/stick/models', { signal, query, timeoutMs: 90000 }));
    if (!self.alive) return;
    self.modelle = r;
    self.modellePfad = pfad;
    // Vorgabe: alles, was gefunden wurde -- Modell UND Kern. Eine von Hand
    // getroffene Auswahl bleibt, solange ihre Kennungen noch existieren; was
    // nie jemand angefasst hat, folgt dem neuen Befund.
    const ids = alleKennungen(r);
    self.auswahl = self.auswahlVonHand && self.auswahl
      ? new Set([...self.auswahl].filter((id) => ids.includes(id)))
      : new Set(ids);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.modelle = null;
    self.modellePfad = '';
    self.modelleFehler = err;
  } finally {
    self.modelleLaedt = false;
  }
}

function alleKennungen(antwort) {
  const r = antwort && antwort.rechner;
  if (!r) return [];
  return [...(r.kerne || []), ...(r.modelle || [])].map((f) => f.id);
}

function gewaehlteKennungen(self) {
  return self.auswahl ? [...self.auswahl] : alleKennungen(self.modelle);
}

async function modellAnsehen(self) {
  const pfad = self.pfad.trim();
  if (!pfad) return;
  self.modellPlanLaeuft = true;
  self.modellPlanFehler = null;
  render(self);
  try {
    const r = await request(self, (signal) => self.api.post('/stick/models/preview', {
      path: pfad, auswahl: gewaehlteKennungen(self), fuer: self.fuer || undefined,
    }, { signal, timeoutMs: 90000 }));
    if (!self.alive) return;
    self.modellPlan = r;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.modellPlan = null;
    self.modellPlanFehler = err;
  } finally {
    self.modellPlanLaeuft = false;
    render(self);
  }
}

async function modellKopieren(self) {
  const pfad = self.pfad.trim();
  if (!pfad) return;
  const auswahl = gewaehlteKennungen(self);
  if (!auswahl.length) return;
  const plan = self.modellPlan;
  const groesse = plan && Number.isFinite(plan.bytesMitKopfraum) ? ` (${formatBytes(plan.bytesMitKopfraum)})` : '';
  const ok = await self.ctx.confirm({
    title: 'Modell auf den Stick kopieren?',
    message: `${auswahl.length} Eintrag/Einträge werden nach ${pfad}/models kopiert${groesse}. Was dort schon liegt, `
      + 'bleibt unverändert; bricht der Vorgang ab, wird das halb Kopierte entfernt. Ein Laufzeitkern gilt nur für '
      + 'das Betriebssystem, für das er gebaut ist.',
    confirmLabel: 'Kopieren',
  });
  if (!ok || !self.alive) return;
  await starteVorgang(self, {
    was: 'Modell auf den Stick kopieren',
    pfad,
    route: '/stick/models/copy',
    koerper: { path: pfad, auswahl, fuer: self.fuer || undefined },
  });
}

/* ------------------------------------------------------------------ */
/* Die langen Vorgänge                                                 */
/* ------------------------------------------------------------------ */

/**
 * Einen langen Vorgang als Ereignisstrom fahren.
 *
 * Warum nicht `api.post`: `web/lib/api.js` bricht eine gewöhnliche Anfrage
 * nach 30 Sekunden ab (DEFAULT_TIMEOUT_MS), während der Server weiterkopiert.
 * Der Tab sähe einen Fehler, der Stick würde trotzdem fertig -- die
 * unangenehmste Art von Unwahrheit. Der Strom läuft, solange der Vorgang
 * läuft, und trägt den gemessenen Fortschritt.
 */
async function starteVorgang(self, { was, pfad, koerper, route }) {
  if (self.lauf && self.lauf.laeuft) return;
  const controller = new AbortController();
  self.abbruch = controller;
  self.lauf = {
    was,
    pfad,
    laeuft: true,
    percent: null,
    message: 'Wird vorbereitet …',
    zeilen: [],
    warnungen: [],
    fehler: null,
    ergebnis: null,
  };
  render(self);

  const notiere = (zeile) => {
    const lauf = self.lauf;
    if (!lauf) return;
    lauf.zeilen.push(zeile);
    if (lauf.zeilen.length > 40) lauf.zeilen.splice(0, lauf.zeilen.length - 40);
  };

  try {
    await self.api.stream(route, {
      body: koerper,
      signal: controller.signal,
      onEvent: (event) => {
        const lauf = self.lauf;
        if (!lauf || !self.alive) return;
        const nutz = event.payload || {};
        if (event.type === 'fortschritt') {
          if (Number.isFinite(nutz.percent)) lauf.percent = nutz.percent;
          if (nutz.message) {
            lauf.message = String(nutz.message);
            notiere(String(nutz.message));
          }
        } else if (event.type === 'fertig') {
          lauf.ergebnis = nutz;
          lauf.warnungen = Array.isArray(nutz.warnings) ? nutz.warnings : [];
          lauf.percent = 100;
          lauf.message = 'Fertig.';
        } else if (event.type === 'fehler') {
          lauf.fehler = fehlerSatz(nutz.error);
        }
        // Absichtlich NUR der Fortschrittsblock: ein vollständiger Neuaufbau
        // mehrmals pro Sekunde würde das Pfadfeld unter den Fingern
        // auswechseln und den Cursor verlieren.
        renderLauf(self);
      },
    });
  } catch (err) {
    if (self.lauf) {
      self.lauf.fehler = (err && err.isAborted)
        ? 'Abgebrochen. Auf dem Stick steht der Stand von vorher; halb Kopiertes wurde entfernt.'
        : fehlerSatz(err);
    }
  } finally {
    if (self.lauf) self.lauf.laeuft = false;
    self.abbruch = null;
    if (self.alive) {
      // Nach jedem Vorgang stimmt die Selbstauskunft nicht mehr (neue
      // Laufzeiten, neuer Zeitstempel), und die alte Vorschau schon gar nicht.
      // Der Modellplan ebenso: was eben kopiert wurde, liegt jetzt dort.
      self.vorschau = null;
      self.modellPlan = null;
      self.modellePfad = '';
      await ladeSelbst(self);
      if (self.pfad.trim()) await pruefen(self);
      else render(self);
    }
  }
}

/**
 * Der Satz zu einem gescheiterten Vorgang.
 *
 * Eine verweigerte Netzschleuse ist kein Fehler des Sticks, sondern die
 * eigene Einstellung -- und genau so muss es dastehen, sonst sucht jemand den
 * Defekt am falschen Ort. Der Server nennt den Code, die Ansicht den Ort.
 */
function fehlerSatz(fehler) {
  const code = fehler && fehler.code;
  const satz = (fehler && fehler.message) || 'Der Vorgang ist gescheitert.';
  if (code === 'NETWORK_BLOCKED') {
    return `${satz} Das ist kein Fehler des Sticks: die Netzschleuse hat den Zugriff verweigert, weil du es so `
      + 'eingestellt hast. Freigeben lässt er sich im Bereich „Netz" – oder du lässt es, dann läuft der Stick '
      + 'weiterhin auf deinem eigenen Betriebssystem.';
  }
  return satz;
}

async function vorbereiten(self) {
  const pfad = self.pfad.trim();
  if (!pfad) return;
  const ok = await self.ctx.confirm({
    title: 'Stick vorbereiten?',
    message: `In ${pfad} werden das Programm, die Laufzeit dieses Rechners und die Starter angelegt`
      + (self.mitDaten ? ' und dein Datenbestand hineinkopiert' : '')
      + '. Ein vorhandener Datenbestand auf dem Stick wird dabei NIE überschrieben.',
    confirmLabel: 'Vorbereiten',
  });
  if (!ok || !self.alive) return;
  await starteVorgang(self, {
    was: 'Stick vorbereiten',
    pfad,
    route: '/stick/prepare',
    koerper: { path: pfad, includeVault: self.mitDaten },
  });
}

async function aktualisieren(self) {
  const pfad = self.pfad.trim();
  if (!pfad) return;
  await starteVorgang(self, {
    was: 'Stick aktualisieren',
    pfad,
    route: '/stick/update',
    koerper: { path: pfad },
  });
}

async function laufzeitHolen(self, plattform) {
  const pfad = self.pfad.trim();
  if (!pfad) return;
  const lokal = self.selbst && self.selbst.dieserRechner === plattform;
  if (!lokal) {
    const ok = await self.ctx.confirm({
      title: `Laufzeit für ${plattformName(plattform)} holen?`,
      message: 'Dafür wird einmalig das offizielle Node-Paket von nodejs.org geladen – durch die '
        + 'Netzschleuse, die das erlauben muss. Die Prüfsummen werden verglichen, und es wird nur die '
        + 'Programmdatei entpackt. Ohne Freigabe passiert nichts; der Stick läuft trotzdem auf diesem Rechner.',
      confirmLabel: 'Holen',
    });
    if (!ok || !self.alive) return;
  }
  await starteVorgang(self, {
    was: `Laufzeit ${plattform} holen`,
    pfad,
    route: '/stick/runtime',
    koerper: { path: pfad, platform: plattform },
  });
}

/* ------------------------------------------------------------------ */
/* Aufbau                                                              */
/* ------------------------------------------------------------------ */

function render(self) {
  if (!self.alive || !self.container) return;
  const laufSlot = h('div.stickv__laufslot');
  self.laufSlot = laufSlot;
  const block = laufBlock(self);
  if (block) laufSlot.appendChild(block);

  const page = h('div.page.stickv', null,
    h('header.page__head', null,
      h('div', null,
        h('h1.page__title', null, text('Stick')),
        h('p.page__subtitle', null, text(
          'Dein Wissen auf einem USB-Stick – auf jedem Rechner, ohne Installation.'))),
      h('div.page__actions', null,
        h('button.btn.btn--small', {
          type: 'button',
          disabled: self.laedt,
          onClick: async () => { await ladeSelbst(self); render(self); },
        }, icon(ICONS.refresh), text('Neu laden')))),
    h('div.stack', null,
      selbstBlock(self),
      pruefBlock(self),
      laufSlot,
      vorbereitenBlock(self),
      laufzeitenBlock(self),
      modellBlock(self),
      wahrheitenBlock(self)));

  clear(self.container);
  self.container.appendChild(page);
}

/** Nur den Fortschrittsblock erneuern. Siehe den Kommentar an seiner Aufrufstelle. */
function renderLauf(self) {
  if (!self.alive || !self.laufSlot) return;
  clear(self.laufSlot);
  const block = laufBlock(self);
  if (block) self.laufSlot.appendChild(block);
}

/* ---------------------------------------------------- 1. diese Instanz */

function selbstBlock(self) {
  if (self.laedt && !self.selbst) {
    return karte('Wo läuft dieses Neural OS gerade?', h('p.meta', null, text('Wird ermittelt …')));
  }
  if (self.selbstFehler) {
    return karte('Wo läuft dieses Neural OS gerade?',
      h('p.stickv__bad', null, text(`Nicht zu beantworten: ${fehlerText(self.selbstFehler)}`)));
  }
  const s = self.selbst || {};
  const von = s.von;

  if (!von) {
    return h('section.card.stickv__self', { dataset: { portabel: '0' } },
      h('div.card__body.stack', null,
        h('div.row', null,
          h('span.stickv__dot', { 'aria-hidden': 'true' }),
          h('strong', null, text('Diese Instanz läuft von der Festplatte, nicht von einem Stick.'))),
        h('p.meta', null, text(
          `Dein Datenbestand liegt in ${s.datenOrdner || 'deinem Heimatordner'}. `
          + 'Beim Vorbereiten wird er nur dann mitkopiert, wenn du es unten ausdrücklich ankreuzt – '
          + 'das Original bleibt in jedem Fall unverändert.'))));
  }

  return h('section.card.stickv__self', { dataset: { portabel: '1' } },
    h('div.card__body.stack', null,
      h('div.row', null,
        h('span.stickv__dot', { 'aria-hidden': 'true' }),
        h('strong', null, text('Dieses Neural OS läuft gerade VOM STICK.'))),
      h('p.meta', null, text(`Stick: ${von.root}`)),
      h('p.meta', null, text(`Deine Daten liegen in ${von.dataDir} – und nur dort.`)),
      h('p.meta', null, text(
        (von.createdAt ? `Stick angelegt ${formatDateTime(von.createdAt)}` : 'Anlegedatum unbekannt')
        + (von.updatedAt ? ` · zuletzt aktualisiert ${formatDateTime(von.updatedAt)}` : '')
        + (von.preparedBy ? ` · vorbereitet auf ${plattformName(von.preparedBy)}` : ''))),
      Number.isFinite(s.freieBytes)
        ? h('p.meta', null, text(`Noch frei auf dem Stick: ${formatBytes(s.freieBytes)}`))
        : null,
      s.pruefung && Array.isArray(s.pruefung.problems) && s.pruefung.problems.length
        ? problemListe(s.pruefung.problems)
        : h('p.meta', null, text('Die Prüfung dieses Sticks findet nichts zu beanstanden.'))));
}

/* --------------------------------------------------- 2. prüfen/ansehen */

function pruefBlock(self) {
  const eingabe = h('input.input', {
    type: 'text',
    value: self.pfad,
    placeholder: '/media/usb   oder   E:\\',
    spellcheck: 'false',
    autocapitalize: 'off',
    'aria-label': 'Pfad zum Stick',
    // Kein vollstaendiger Neuaufbau beim Tippen -- der wuerde das Feld unter
    // den Fingern austauschen und den Cursor verlieren. Nur die Knoepfe, die
    // ohne Pfad nichts tun koennen, werden freigegeben oder gesperrt.
    onInput: (e) => { self.pfad = e.target.value; pfadKnoepfe(self); },
    onKeyDown: (e) => { if (e.key === 'Enter') pruefen(self); },
  });

  const leer = !self.pfad.trim();
  const eigener = istEigenerStick(self);

  return karte('Stick prüfen und ansehen',
    h('div.stack', null,
      h('div.field', null,
        h('label.label', null, text('Pfad zum Stick')),
        eingabe,
        h('p.hint', null, text(
          'Der Browser kennt keine Dateipfade – es gibt keinen Ordnerwähler, der einen absoluten Pfad '
          + 'liefern darf. Der Pfad muss also getippt werden. Unter Linux meist /media/… oder /run/media/…, '
          + 'unter macOS /Volumes/…, unter Windows z. B. E:\\'))),
      h('div.row.stickv__buttons', null,
        h('button.btn', {
          type: 'button',
          dataset: { brauchtFremdenPfad: '1' },
          disabled: leer || eigener || self.vorschauLaeuft,
          title: eigener ? 'Für den Stick, von dem diese Instanz läuft, gibt es nichts vorzubereiten.' : '',
          onClick: () => ansehen(self),
        }, icon(ICONS.eye), text(self.vorschauLaeuft ? 'Wird angesehen …' : 'Erst ansehen')),
        h('button.btn', {
          type: 'button',
          dataset: { brauchtPfad: '1' },
          disabled: leer || self.pruefungLaeuft,
          onClick: () => pruefen(self),
        }, icon(ICONS.check), text(self.pruefungLaeuft ? 'Wird geprüft …' : 'Stick prüfen'))),
      eigener
        ? h('p.hint', null, text(
          'Das ist der Stick, von dem diese Instanz gerade läuft. „Stick prüfen" sagt hier, wie es um ihn '
          + 'steht; „Erst ansehen" beantwortet dagegen die Frage „was würde ein Vorbereiten tun" – und die '
          + 'stellt sich für den eigenen Stick nicht.'))
        : null,
      self.vorschauFehler
        ? h('div.stickv__box', { dataset: { level: 'fail' } }, text(fehlerText(self.vorschauFehler)))
        : null,
      vorschauBox(self),
      self.pruefungFehler
        ? h('div.stickv__box', { dataset: { level: 'fail' } }, text(fehlerText(self.pruefungFehler)))
        : null,
      pruefungBox(self)));
}

function vorschauBox(self) {
  const v = self.vorschau;
  if (!v) return null;
  const zeilen = [];

  zeilen.push(h('p', null, h('strong', null, text('Das würde passieren – geschrieben ist noch nichts.'))));
  zeilen.push(h('p.meta', null, text(
    v.exists
      ? (v.isStick ? `${v.root} ist bereits ein Neural-OS-Stick.` : `${v.root} gibt es, ein Neural-OS-Stick ist es noch nicht.`)
      : `${v.root} gibt es noch nicht – der Ordner würde angelegt.`)));

  if (v.source) {
    zeilen.push(h('p', null, text(
      `Programm: ${formatNumber(v.source.files)} Dateien (${formatBytes(v.source.bytes)}), Fassung ${v.source.version}.`)));
  }
  if (v.home) {
    zeilen.push(h('p', null, text(
      `Datenbestand: ${formatNumber(v.home.files)} Dateien (${formatBytes(v.home.bytes)}) aus ${v.home.root}. `
      + 'Das Original bleibt unverändert.')));
  } else if (v.action === 'prepare') {
    zeilen.push(h('p', null, text('Datenbestand: wird NICHT mitkopiert. Der Stick startet mit einem leeren Tresor.')));
  }
  if (v.runtimes) {
    const teile = [];
    if (v.runtimes.copyLocal && v.runtimes.local) teile.push(`${plattformName(v.runtimes.local)} (von diesem Rechner, ohne Netz)`);
    for (const p of v.runtimes.download || []) teile.push(`${plattformName(p)} (Download durch die Netzschleuse)`);
    zeilen.push(h('p', null, text(teile.length
      ? `Laufzeiten, die dazukämen: ${teile.join(', ')}.`
      : 'Laufzeiten: keine neue – die vorhandenen bleiben, wie sie sind.')));
  }
  if (v.space) {
    zeilen.push(h('p', null, text(
      `Platz: gebraucht ${formatBytes(v.space.withHeadroom)}, frei `
      + (Number.isFinite(v.space.free) ? formatBytes(v.space.free) : 'unbekannt')
      + (v.space.fits === true ? ' – das passt.' : v.space.fits === false ? ' – das passt NICHT.' : ' – nicht feststellbar.'))));
  }
  if (v.data && v.data.entries > 0) {
    zeilen.push(h('p', null, text(
      `Auf dem Stick liegen bereits ${formatNumber(v.data.entries)} Einträge in ${v.data.path}. `
      + 'Sie werden von keinem Vorgang angefasst.')));
  }

  for (const b of v.blockers || []) {
    zeilen.push(h('p.stickv__bad', null, icon(ICONS.alert), text(` ${b.message}`)));
  }
  for (const w of (v.warnings || []).slice(0, 8)) {
    zeilen.push(h('p.stickv__warn', null, text(w)));
  }
  if (!v.blockers.length) {
    zeilen.push(h('p.meta', null, text('Nichts spricht dagegen. Erst ein Klick unten schreibt etwas.')));
  }

  return h('div.stickv__box', { dataset: { level: v.blockers.length ? 'blocked' : 'ok' } }, zeilen);
}

function pruefungBox(self) {
  const p = self.pruefung;
  if (!p) return null;
  const zeilen = [
    h('p', null, h('strong', null, text(p.ok
      ? 'Der Stick ist startklar.'
      : 'So startet der Stick nicht.'))),
  ];
  if (Number.isFinite(p.freeBytes)) {
    zeilen.push(h('p.meta', null, text(`Frei: ${formatBytes(p.freeBytes)}`)));
  }
  const laufzeiten = (p.layout && p.layout.runtimes) || [];
  zeilen.push(h('p.meta', null, text(laufzeiten.length
    ? `Laufzeiten auf dem Stick: ${laufzeiten.map((r) => plattformName(r.platform)).join(', ')}`
    : 'Auf dem Stick liegt keine Laufzeit.')));
  if (p.problems && p.problems.length) zeilen.push(problemListe(p.problems));
  zeilen.push(h('p.hint', null, text(
    'Diese Prüfung schreibt nichts auf den Stick – auch keine Testdatei.')));
  return h('div.stickv__box', { dataset: { level: p.ok ? 'ok' : 'fail' } }, zeilen);
}

/**
 * Zeigt der getippte Pfad auf genau den Stick, von dem diese Instanz laeuft?
 *
 * Das ist keine Feinheit, sondern eine harte Grenze: der Quelltext, aus dem
 * kopiert wuerde, liegt dann IN dem Ordner, in den kopiert werden soll
 * (`<stick>/app` in `<stick>`). stick.js lehnt das zu Recht ab -- eine Kopie
 * eines Baums in sich selbst waechst endlos. Also sagt die Ansicht es vorher,
 * statt den Benutzer in eine Fehlermeldung laufen zu lassen.
 */
function istEigenerStick(self) {
  const von = self.selbst && self.selbst.von;
  if (!von || !von.root) return false;
  const pfad = self.pfad.trim().replace(/[\\/]+$/, '');
  return pfad !== '' && pfad === String(von.root).replace(/[\\/]+$/, '');
}

/**
 * Die Knoepfe, die einen Pfad brauchen, an den aktuellen Stand anpassen.
 *
 * Sie tragen `data-braucht-pfad` bzw. `data-braucht-fremden-pfad`, damit diese
 * Funktion sie findet, ohne dass jede Stelle eine Referenz durchreichen muss
 * -- und damit kein Knopf vergessen wird, der spaeter dazukommt.
 */
function pfadKnoepfe(self) {
  if (!self.container) return;
  const leer = !self.pfad.trim();
  const laeuft = !!(self.lauf && self.lauf.laeuft);
  const eigener = istEigenerStick(self);
  for (const knopf of self.container.querySelectorAll('[data-braucht-pfad]')) {
    knopf.disabled = leer || laeuft;
  }
  for (const knopf of self.container.querySelectorAll('[data-braucht-fremden-pfad]')) {
    knopf.disabled = leer || laeuft || eigener;
  }
}

function problemListe(problems) {
  return h('ul.stickv__probleme', { role: 'list' },
    problems.map((p) => h('li', { dataset: { level: p.level || 'info' } },
      h('span', null, text(p.message || '')),
      p.fix ? h('span.meta', null, text(` ${p.fix}`)) : null)));
}

/* ------------------------------------------------------- 3. Fortschritt */

function laufBlock(self) {
  const lauf = self.lauf;
  if (!lauf) return null;

  const percent = Number.isFinite(lauf.percent) ? Math.max(0, Math.min(100, lauf.percent)) : null;

  return h('section.card.stickv__lauf', { dataset: { laeuft: lauf.laeuft ? '1' : '0' } },
    h('div.card__head', null,
      h('strong', null, text(lauf.was)),
      h('span.spacer'),
      lauf.laeuft
        ? h('button.btn.btn--small.btn--danger', {
          type: 'button',
          onClick: () => { if (self.abbruch) self.abbruch.abort(); },
        }, icon(ICONS.stop), text('Abbrechen'))
        : null),
    h('div.card__body.stack', null,
      h('p.meta', null, text(`${lauf.pfad}`)),
      h('div.stickv__bar', { role: 'progressbar', 'aria-valuenow': percent === null ? undefined : String(percent) },
        h('div.stickv__bar-fill', {
          dataset: { unbekannt: percent === null ? '1' : '0' },
          style: percent === null ? '' : `width:${percent}%`,
        })),
      h('p', null, text(percent === null ? lauf.message : `${percent} % · ${lauf.message}`)),
      lauf.fehler ? h('p.stickv__bad', null, text(lauf.fehler)) : null,
      ...(lauf.warnungen || []).map((w) => h('p.stickv__warn', null, text(w))),
      lauf.ergebnis && !lauf.fehler
        ? h('p', null, text(
          `${formatNumber(lauf.ergebnis.files || 0)} Dateien · ${formatBytes(lauf.ergebnis.bytes || 0)} geschrieben.`))
        : null,
      lauf.zeilen.length
        ? h('details.stickv__log', null,
          h('summary', null, text('Was gemeldet wurde')),
          h('ul.stickv__logliste', { role: 'list' },
            lauf.zeilen.slice(-20).map((z) => h('li', null, text(z)))))
        : null));
}

/* ------------------------------------------------------ 4. vorbereiten */

function vorbereitenBlock(self) {
  const leer = !self.pfad.trim();
  const laeuft = !!(self.lauf && self.lauf.laeuft);
  const eigenerStick = istEigenerStick(self);

  return karte('Stick vorbereiten oder erneuern',
    h('div.stack', null,
      h('label.stickv__check', null,
        h('input', {
          type: 'checkbox',
          checked: self.mitDaten,
          disabled: laeuft,
          onChange: (e) => { self.mitDaten = e.target.checked; self.vorschau = null; render(self); },
        }),
        text('Meinen Datenbestand mitnehmen')),
      h('p.hint', null, text(
        'Kopiert Notizen, Chats, Projekte und Dateien auf den Stick. Das Original auf diesem Rechner '
        + 'bleibt unverändert. Liegt auf dem Stick schon ein Datenbestand, wird er NICHT überschrieben – '
        + 'der Vorgang lehnt dann ab.')),
      eigenerStick
        ? h('p.stickv__warn', null, text(
          'Dieser Stick kann sich nicht selbst erneuern. Der Quelltext, aus dem kopiert würde, liegt auf '
          + 'ihm selbst (in app/) – eine Kopie eines Ordners in sich hinein würde endlos wachsen, und das '
          + 'wird abgelehnt. Zum Erneuern steck den Stick in einen Rechner, auf dem Neural OS von der '
          + 'Festplatte läuft. Laufzeiten für weitere Betriebssysteme lassen sich hier trotzdem holen.'))
        : null,
      h('div.row.stickv__buttons', null,
        h('button.btn.btn--primary', {
          type: 'button',
          dataset: { brauchtFremdenPfad: '1' },
          disabled: leer || laeuft || eigenerStick,
          title: eigenerStick ? 'Nicht auf dem Stick, von dem diese Instanz gerade läuft.' : '',
          onClick: () => vorbereiten(self),
        }, icon(ICONS.download), text('Stick vorbereiten')),
        h('button.btn', {
          type: 'button',
          dataset: { brauchtFremdenPfad: '1' },
          disabled: leer || laeuft || eigenerStick,
          title: eigenerStick ? 'Nicht auf dem Stick, von dem diese Instanz gerade läuft.' : '',
          onClick: () => aktualisieren(self),
        }, icon(ICONS.refresh), text('Nur Programm erneuern'))),
      h('p.hint', null, text(
        '„Nur Programm erneuern" fasst den Ordner data/ nicht an – das ist die wichtigste Zusage dieses '
        + 'Vorgangs und durch einen Test abgesichert. Beide Vorgänge laufen so lange, wie sie brauchen; '
        + 'der Balken oben ist gemessen, nicht geschätzt.'))));
}

/* -------------------------------------------------------- 5. Laufzeiten */

function laufzeitenBlock(self) {
  const s = self.selbst || {};
  const bekannt = Array.isArray(s.bekanntePlattformen) ? s.bekanntePlattformen : [];
  const lokal = s.dieserRechner || null;
  const leer = !self.pfad.trim();
  const laeuft = !!(self.lauf && self.lauf.laeuft);

  // Was wirklich auf dem angesehenen Stick liegt -- aus der Prüfung oder der
  // Vorschau, nie geraten. Ohne eine der beiden steht hier ehrlich nichts.
  const aufStick = new Map();
  const ausPruefung = self.pruefung && self.pruefung.layout && self.pruefung.layout.runtimes;
  const ausVorschau = self.vorschau && self.vorschau.runtimes && self.vorschau.runtimes.onStick;
  for (const r of ausPruefung || ausVorschau || []) aufStick.set(r.platform, r);
  const gesehen = !!(ausPruefung || ausVorschau);

  const zeilen = bekannt.map((p) => {
    const da = aufStick.get(p);
    const istLokal = p === lokal;
    let zustand;
    let ton;
    if (da) {
      zustand = `liegt auf dem Stick${da.version ? ` (Node ${da.version})` : ''}`;
      ton = 'ok';
    } else if (!gesehen) {
      zustand = 'unbekannt – erst „Stick prüfen" sagt, was wirklich darauf liegt';
      ton = 'unklar';
    } else if (istLokal) {
      zustand = 'fehlt – kommt beim Vorbereiten dieses Rechners automatisch mit, ohne Netz';
      ton = 'unklar';
    } else {
      zustand = 'fehlt – dieser Rechnertyp startet den Stick nur, wenn Node.js dort installiert ist';
      ton = 'fehlt';
    }
    return h('li.stickv__rt', { dataset: { ton } },
      h('div', null,
        h('strong', null, text(plattformName(p))),
        istLokal ? h('span.badge', null, text('dieser Rechner')) : null,
        h('p.meta', null, text(zustand))),
      h('span.spacer'),
      da ? null : h('button.btn.btn--small', {
        type: 'button',
        dataset: { brauchtPfad: '1' },
        disabled: leer || laeuft,
        title: istLokal
          ? 'Kopiert die Node-Laufzeit dieses Rechners auf den Stick – ohne Netz.'
          : 'Lädt einmalig das offizielle Node-Paket von nodejs.org – Netzzugriff durch die Netzschleuse.',
        onClick: () => laufzeitHolen(self, p),
      }, icon(ICONS.download), text(istLokal ? 'Jetzt kopieren' : 'Holen')));
  });

  const daListe = [...aufStick.keys()];
  const fehltListe = bekannt.filter((p) => !aufStick.has(p));

  return karte('Welche Rechner der Stick starten kann',
    h('div.stack', null,
      h('p', null, text(
        'Mitkopiert wird immer nur die Laufzeit DIESES Rechners'
        + (lokal ? ` (${plattformName(lokal)})` : '')
        + '. Das geht ohne Internet und macht den Stick auf jedem gleichartigen Rechner startfähig. '
        + 'Jede weitere Laufzeit ist ein einmaliger Download des offiziellen Node-Pakets (rund 30 MB) von '
        + 'nodejs.org durch die Netzschleuse – mit Prüfsummenvergleich, und nur die Programmdatei wird '
        + 'entpackt. Verweigert die Schleuse ihn, ist das kein Fehler des Sticks, sondern deine eigene '
        + 'Einstellung: er läuft weiterhin auf deinem Betriebssystem.')),
      gesehen
        ? h('p.meta', null, text(
          (daListe.length
            ? `Auf dem Stick liegen Laufzeiten für: ${daListe.map(plattformName).join(', ')}. `
            : 'Auf dem Stick liegt noch keine Laufzeit. ')
          + (fehltListe.length
            ? `Es fehlen: ${fehltListe.map(plattformName).join(', ')}.`
            : 'Damit startet der Stick auf jedem bekannten Rechnertyp.')))
        : null,
      h('ul.stickv__rts', { role: 'list' }, zeilen),
      h('p.hint', null, text(
        'Für den Laufzeitkern des Sprachmodells (Ollama, llama.cpp) gilt das NICHT: den kann Neural OS nicht '
        + 'herunterladen. Ein Kern für ein anderes Betriebssystem kommt nur von einem Rechner mit genau diesem '
        + 'System, auf dem unter „Modell mitnehmen" derselbe Schritt einmal ausgeführt wird.'))));
}

/* ------------------------------------------------- 5b. Modell mitnehmen */

/** Menschliche Namen für die Arten aus src/portable/model.js. */
const ART_NAMEN = {
  ollama: 'Ollama',
  'llama.cpp': 'llama.cpp',
  gguf: 'GGUF-Datei (llama.cpp, LM Studio)',
};

/** Die Geräte, für die man fragen kann -- Plattformen plus das, was gar kein Programm startet. */
const GERAETE_OHNE_PROGRAMM = [['ipados', 'iPad (iPadOS)'], ['android', 'Android-Gerät']];

function artName(art) {
  return ART_NAMEN[art] || art || 'unbekannt';
}

function fundZeile(self, fund, laeuft) {
  const gewaehlt = !self.auswahl || self.auswahl.has(fund.id);
  const istKern = fund.rolle === 'kern';
  const beschreibung = istKern
    ? `Laufzeitkern (${artName(fund.art)}) für ${plattformName(fund.plattform)} · ${formatBytes(fund.bytes)}`
    : `Modell (${artName(fund.art)}) · ${formatBytes(fund.bytes)} · ${fund.dateien ? fund.dateien.length : 1} Datei(en)`;
  return h('li.stickv__fund', { dataset: { rolle: fund.rolle, gewaehlt: gewaehlt ? '1' : '0' } },
    h('label.stickv__check', null,
      h('input', {
        type: 'checkbox',
        checked: gewaehlt,
        disabled: laeuft,
        onChange: (e) => {
          if (!self.auswahl) self.auswahl = new Set(alleKennungen(self.modelle));
          self.auswahlVonHand = true;
          if (e.target.checked) self.auswahl.add(fund.id); else self.auswahl.delete(fund.id);
          // Der alte Plan galt für die alte Auswahl.
          self.modellPlan = null;
          render(self);
        },
      }),
      h('span', null,
        h('strong', null, text(fund.name)),
        h('span.meta', null, text(` ${beschreibung}`)))),
    istKern && fund.ausfuehrbar === false
      ? h('p.stickv__warn', null, text('Trägt kein Ausführbar-Bit – auf dem Zielrechner muss es von Hand gesetzt werden (chmod +x).'))
      : null,
    fund.vollstaendig === false && fund.hinweis
      ? h('p.stickv__warn', null, text(fund.hinweis))
      : null);
}

/** Was auf DIESEM Rechner gefunden wurde -- oder was zu tun wäre. */
function rechnerTeil(self, laeuft) {
  const m = self.modelle;
  if (self.modelleLaedt && !m) {
    return h('p.meta', null, text('Auf diesem Rechner wird nach Modellen und Laufzeitkernen gesucht …'));
  }
  if (self.modelleFehler) {
    return h('p.stickv__bad', null, text(`Nicht zu beantworten: ${fehlerText(self.modelleFehler)}`));
  }
  if (!m || !m.rechner) return h('p.meta', null, text('Noch nicht nachgesehen.'));
  const r = m.rechner;

  if (!r.gefunden) {
    return h('div.stickv__box', { dataset: { level: 'blocked' } },
      h('p', null, h('strong', null, text(
        `Auf diesem Rechner (${plattformName(r.rechner && r.rechner.plattform)}) ist kein lokales Modell und kein Laufzeitkern zu finden.`))),
      h('p', null, text('Zum Mitnehmen braucht es beides. So kommt es auf diesen Rechner:')),
      h('ol.stickv__anleitung', null,
        h('li', null, text('Ollama von ollama.com installieren (einmalig, mit Internet).')),
        h('li', null, text('Im Terminal ein Modell holen: '), h('code', null, text('ollama pull llama3.2')),
          text(' – rund 2 GB, läuft auf fast jeder Hardware.')),
        h('li', null, text('Hier „Neu nachsehen" drücken. Dann stehen Modell und Kern in dieser Liste.'))),
      // Der Satz "kein lokales Modell" steht oben schon; alles andere (ein
      // Kern ohne Bit, ein unvollständiges Modell) ist neu und bleibt.
      ...(r.hinweise || []).filter((s) => !/kein lokales Modell/.test(s)).slice(0, 4).map((s) => h('p.meta', null, text(s))));
  }

  const funde = [...(r.kerne || []), ...(r.modelle || [])];
  const gewaehlt = funde.filter((f) => !self.auswahl || self.auswahl.has(f.id));
  const bytes = gewaehlt.reduce((s, f) => s + (f.bytes || 0), 0);
  const kernDa = gewaehlt.some((f) => f.rolle === 'kern');
  const modellDa = gewaehlt.some((f) => f.rolle === 'modell');

  return h('div.stack', null,
    h('ul.stickv__funde', { role: 'list' }, funde.map((f) => fundZeile(self, f, laeuft))),
    h('p.meta', null, text(
      `${gewaehlt.length} von ${funde.length} ausgewählt · ${formatBytes(bytes)}`
      + (!kernDa && modellDa ? ' · ohne Laufzeitkern öffnet die Dateien auf einem fremden Rechner nur, wer dort selbst Ollama oder llama.cpp hat' : '')
      + (kernDa && !modellDa ? ' · ein Kern ohne Modell beantwortet keine Frage' : ''))),
    ...(r.hinweise || []).filter((s) => !/kein lokales Modell/.test(s)).slice(0, 4)
      .map((s) => h('p.stickv__warn', null, text(s))));
}

/** Was auf dem Stick liegt, für welches Betriebssystem, und der eine Satz dazu. */
function stickTeil(self, laeuft) {
  const pfad = self.pfad.trim();
  const m = self.modelle;
  const zeilen = [];

  const geraete = [['', `dieser Rechner (${plattformName(self.selbst && self.selbst.dieserRechner)})`]];
  for (const p of (self.selbst && self.selbst.bekanntePlattformen) || []) geraete.push([p, plattformName(p)]);
  geraete.push(...GERAETE_OHNE_PROGRAMM);
  zeilen.push(h('div.field', null,
    h('label.label', null, text('Für welchen Rechner soll das gelten?')),
    h('select.select', {
      'aria-label': 'Für welchen Rechner',
      disabled: laeuft || self.modelleLaedt,
      onChange: async (e) => {
        self.fuer = e.target.value;
        self.modellPlan = null;
        await ladeModelle(self);
        render(self);
      },
    }, geraete.map(([wert, name]) => h('option', { value: wert, selected: self.fuer === wert }, text(name)))),
    h('p.hint', null, text(
      'Ein Laufzeitkern startet nur auf dem Betriebssystem, für das er gebaut ist. Die Modelldateien selbst passen '
      + 'auf jeden Rechner. Ein iPad startet gar kein Programm von einem Stick – dort gibt es Antworten nur über '
      + 'einen Rechner im selben Netz.'))));

  if (!pfad) {
    zeilen.push(h('p.meta', null, text('Trag oben den Pfad zum Stick ein – dann steht hier, was darauf liegt.')));
    return h('div.stack', null, zeilen);
  }
  if (self.modelleLaedt) {
    zeilen.push(h('p.meta', null, text(`Auf ${pfad} wird nachgesehen …`)));
    return h('div.stack', null, zeilen);
  }
  const stand = m && self.modellePfad === pfad ? m.stick : null;
  if (!stand) {
    zeilen.push(h('p.meta', null, text(`Für ${pfad} wurde noch nicht nachgesehen.`)),
      h('div.row.stickv__buttons', null,
        h('button.btn.btn--small', {
          type: 'button',
          dataset: { brauchtPfad: '1' },
          disabled: laeuft,
          onClick: async () => { await ladeModelle(self); render(self); },
        }, icon(ICONS.eye), text('Auf dem Stick nachsehen'))));
    return h('div.stack', null, zeilen);
  }

  zeilen.push(h('p', { dataset: { passt: stand.passt ? '1' : '0' } }, h('strong', null, text(stand.satz))));
  if (stand.vorhanden) {
    zeilen.push(h('p.meta', null, text(`Belegt: ${formatBytes(stand.bytes)} in ${stand.ordner}`)));
    for (const k of stand.kerne || []) {
      const passt = stand.fuer && stand.fuer.kannProgrammeStarten && k.plattform === stand.fuer.plattform;
      zeilen.push(h('p.stickv__aufstick', { dataset: { ton: passt ? 'ok' : 'fehlt' } }, text(
        `Laufzeitkern ${k.name} (${artName(k.art)}) für ${plattformName(k.plattform)} · ${formatBytes(k.bytes)}`
        + (passt ? ' – passt zum gewählten Rechner' : ' – startet auf dem gewählten Rechner nicht'))));
    }
    for (const mo of stand.modelle || []) {
      zeilen.push(h('p.stickv__aufstick', { dataset: { ton: 'ok' } }, text(
        `Modell ${mo.name} (${artName(mo.art)}) · ${formatBytes(mo.bytes)} · ${mo.dateien} Datei(en)`)));
    }
  }
  const fehlendeKerne = ((self.selbst && self.selbst.bekanntePlattformen) || [])
    .filter((p) => !(stand.plattformen || []).includes(p));
  if (stand.vorhanden && fehlendeKerne.length) {
    zeilen.push(h('p.hint', null, text(
      `Kein Laufzeitkern für: ${fehlendeKerne.map(plattformName).join(', ')}. Neural OS kann ihn nicht herunterladen. `
      + 'Steck den Stick in einen Rechner mit diesem System, auf dem Ollama oder llama.cpp installiert ist, und führe '
      + 'dort „Auf den Stick kopieren" einmal aus – die Modelldateien liegen dann schon da und werden nicht noch einmal kopiert.')));
  }
  for (const w of stand.warnungen || []) zeilen.push(h('p.stickv__warn', null, text(w)));
  for (const s of stand.hinweise || []) zeilen.push(h('p.meta', null, text(s)));
  return h('div.stack', null, zeilen);
}

/** Dateisystem und Platz -- aus dem Plan für alles Gefundene, bevor irgendetwas beginnt. */
function platzTeil(self) {
  const pfad = self.pfad.trim();
  const m = self.modelle;
  const v = m && self.modellePfad === pfad ? m.vorschau : null;
  const zeilen = [];
  if (!pfad || !v) {
    zeilen.push(wahrheit('Dateisystem und Platz auf dem Stick',
      pfad ? 'Noch nicht nachgesehen.' : 'Ohne Pfad lässt sich das nicht beantworten.', 'unklar'));
    return h('div.stack', null, zeilen);
  }
  const fsInfo = v.dateisystem;
  const zuGross = (v.hindernisse || []).find((x) => x.code === 'DATEI_ZU_GROSS' || x.code === 'DATEI_ZU_GROSS_VIELLEICHT');
  if (!fsInfo) {
    zeilen.push(wahrheit('Dateisystem: unbekannt', 'Der Ordner liess sich nicht untersuchen – gibt es ihn?', 'unklar'));
  } else if (zuGross) {
    zeilen.push(wahrheit(`Dateisystem: ${fsInfo.typeName || 'unbekannt'} – hier passt das Modell NICHT`, zuGross.satz, 'fehlt'));
  } else {
    const grenze = Number.isFinite(fsInfo.maxFileBytes) ? fsInfo.maxFileBytes : null;
    zeilen.push(wahrheit(`Dateisystem: ${fsInfo.typeName || 'unbekannt'}`,
      grenze
        ? `Einzelne Dateien bis ${formatBytes(grenze)}. Die grösste ausgewählte Datei ist `
          + `${v.groessteDatei ? formatBytes(v.groessteDatei.bytes) : 'unbekannt'} – das passt.`
        : (fsInfo.typeName
          ? 'Keine Grenze für einzelne Dateien bekannt. (Auf FAT32 wäre bei 4 GB Schluss; ein Modell ist meist grösser.)'
          : 'Der Typ liess sich nicht bestimmen. Ist es FAT32, passt keine Datei über 4 GB – ein Modell ist meist grösser; '
            + 'exFAT und NTFS haben diese Grenze nicht. Neuformatieren löscht ALLE Daten auf dem Stick.'),
      grenze || fsInfo.typeName ? 'ok' : 'unklar'));
  }
  const frei = Number.isFinite(v.frei) ? v.frei : null;
  zeilen.push(wahrheit('Platz',
    `Gebraucht: ${formatBytes(v.bytesMitKopfraum || 0)} für ${v.anzahl || 0} Datei(en)`
    + (v.bytesUebersprungen ? ` (${formatBytes(v.bytesUebersprungen)} liegen schon dort)` : '')
    + ` · frei: ${frei === null ? 'unbekannt' : formatBytes(frei)}`
    + (v.passt === true ? ' – das passt.' : v.passt === false ? ' – das passt NICHT.' : ' – nicht feststellbar.'),
    v.passt === true ? 'ok' : v.passt === false ? 'fehlt' : 'unklar'));
  return h('div.stack', null, zeilen);
}

function planBox(self) {
  const p = self.modellPlan;
  if (!p) return null;
  const zeilen = [
    h('p', null, h('strong', null, text('Das würde passieren – geschrieben ist noch nichts.'))),
    h('p', null, text(p.zusammenfassung || '')),
  ];
  if (p.stickVorbereitet === false) {
    zeilen.push(h('p.stickv__warn', null, text(
      'In diesem Ordner liegt noch kein vorbereiteter Stick. Das Modell landet trotzdem dort – aber ohne „Stick vorbereiten" startet dort kein Programm, das es benutzt.')));
  }
  for (const x of p.hindernisse || []) {
    zeilen.push(h('p', { className: x.schwere === 'stopp' ? 'stickv__bad' : 'stickv__warn' },
      x.schwere === 'stopp' ? icon(ICONS.alert) : null, text(` ${x.satz}`)));
  }
  for (const s of (p.hinweise || []).slice(0, 8)) zeilen.push(h('p.meta', null, text(s)));
  if (p.kannLosgehen) zeilen.push(h('p.meta', null, text('Nichts spricht dagegen. Erst „Auf den Stick kopieren" schreibt etwas.')));
  return h('div.stickv__box', { dataset: { level: p.kannLosgehen ? 'ok' : 'blocked' } }, zeilen);
}

function modellBlock(self) {
  const leer = !self.pfad.trim();
  const laeuft = !!(self.lauf && self.lauf.laeuft);
  const gefunden = !!(self.modelle && self.modelle.rechner && self.modelle.rechner.gefunden);
  const nichtsGewaehlt = !gewaehlteKennungen(self).length;
  const planSagtNein = !!(self.modellPlan && self.modellPlan.kannLosgehen === false);
  const vorschauSagtNein = !!(self.modelle && self.modellePfad === self.pfad.trim() && self.modelle.vorschau
    && self.modelle.vorschau.hindernisse.some((x) => x.schwere === 'stopp' && x.code !== 'NICHTS_AUSGEWAEHLT'));

  return h('section.card.stickv__modell', null,
    h('div.card__head', null,
      h('strong', null, text('Modell mitnehmen')),
      h('span.spacer'),
      h('button.btn.btn--small', {
        type: 'button',
        disabled: self.modelleLaedt || laeuft,
        onClick: async () => { self.modellPlan = null; await ladeModelle(self); render(self); },
      }, icon(ICONS.refresh), text(self.modelleLaedt ? 'Wird nachgesehen …' : 'Neu nachsehen'))),
    h('div.card__body.stack', null,
      h('p', null, text(
        'Das Wissen reist immer mit; das Sprachmodell nur, wenn du es hier dazulegst. Dafür braucht es zwei '
        + 'Dinge: die Modelldateien (mehrere Gigabyte, passen auf jeden Rechner) und den Laufzeitkern, der sie '
        + 'öffnet (ein Programm, gebunden an ein Betriebssystem). Kopiert wird, was auf DIESEM Rechner schon '
        + 'liegt – Neural OS lädt kein Modell herunter.')),
      h('h3.stickv__h3', null, text('Auf diesem Rechner')),
      rechnerTeil(self, laeuft),
      h('h3.stickv__h3', null, text('Auf dem Stick')),
      stickTeil(self, laeuft),
      h('h3.stickv__h3', null, text('Dateisystem und Platz')),
      platzTeil(self),
      self.modellPlanFehler
        ? h('div.stickv__box', { dataset: { level: 'fail' } }, text(fehlerText(self.modellPlanFehler)))
        : null,
      planBox(self),
      h('div.row.stickv__buttons', null,
        h('button.btn', {
          type: 'button',
          dataset: { brauchtPfad: '1' },
          disabled: leer || laeuft || !gefunden || nichtsGewaehlt || self.modellPlanLaeuft,
          onClick: () => modellAnsehen(self),
        }, icon(ICONS.eye), text(self.modellPlanLaeuft ? 'Wird angesehen …' : 'Erst ansehen')),
        h('button.btn.btn--primary', {
          type: 'button',
          dataset: { brauchtPfad: '1' },
          disabled: leer || laeuft || !gefunden || nichtsGewaehlt || planSagtNein || vorschauSagtNein,
          title: !gefunden ? 'Auf diesem Rechner gibt es nichts zu kopieren.'
            : planSagtNein || vorschauSagtNein ? 'Ein Hindernis steht oben – so kann es nicht losgehen.' : '',
          onClick: () => modellKopieren(self),
        }, icon(ICONS.download), text('Auf den Stick kopieren'))),
      h('p.hint', null, text(
        'Was schon auf dem Stick liegt, bleibt unverändert; ein zweites Modell kommt daneben, und geteilte Schichten '
        + 'werden nur einmal kopiert. Bricht der Vorgang ab, wird das halb Kopierte entfernt. Über die Kommandozeile: '
        + 'neural-os stick model copy <pfad>.'))));
}

/* --------------------------------------------------- 6. was man wissen muss */

function wahrheitenBlock(self) {
  const fsInfo = (self.vorschau && self.vorschau.filesystem)
    || (self.pruefung && self.pruefung.filesystem)
    || (self.selbst && self.selbst.dateisystem)
    || null;
  const modell = (self.selbst && self.selbst.modell) || null;

  const zeilen = [];

  /* --- Dateisystem ------------------------------------------------- */
  if (!fsInfo) {
    zeilen.push(wahrheit('Was das Dateisystem des Sticks kann',
      'Noch nicht nachgesehen. „Erst ansehen" oder „Stick prüfen" beantwortet es – ohne etwas zu schreiben.',
      'unklar'));
  } else {
    const grenze = Number.isFinite(fsInfo.maxFileBytes) && fsInfo.maxFileBytes < 4 * 1024 * 1024 * 1024;
    zeilen.push(wahrheit(`Dateisystem: ${fsInfo.typeName || 'unbekannt'}`,
      grenze
        ? 'Hier passt keine einzelne Datei über 4 GB. Ein KI-Modell ist meist grösser – dafür müsste der '
          + 'Stick als exFAT formatiert werden (dabei gehen alle Daten auf ihm verloren).'
        : 'Keine 4-GB-Grenze für einzelne Dateien erkennbar.',
      grenze ? 'fehlt' : 'ok'));

    if (fsInfo.enforcesModes === false) {
      zeilen.push(wahrheit('Dieses Dateisystem kennt keine Zugriffsrechte',
        'Typisch für exFAT und FAT32. Die Dateirechte 0600/0700 laufen dort ins Leere – wer den Stick '
        + 'findet, liest alles. Auf einem Stick schützt dann NUR die Tresorverschlüsselung. '
        + 'Sie steht in den Einstellungen unter „Verschlüsselung".',
        'fehlt'));
    } else if (fsInfo.enforcesModes === true) {
      zeilen.push(wahrheit('Zugriffsrechte werden durchgesetzt',
        'Das Dateisystem behält die gesetzten Rechte. Ein verlorener Stick ist trotzdem ein verlorener '
        + 'Datenbestand – an einem fremden Rechner hilft gegen physischen Zugriff nur Verschlüsselung.',
        'ok'));
    } else {
      zeilen.push(wahrheit('Ob Zugriffsrechte durchgesetzt werden, ist offen',
        'Diese Frage lässt sich nicht beantworten, ohne eine Datei zu schreiben – und Prüfen und Ansehen '
        + 'schreiben nichts. Beim Vorbereiten wird sie beantwortet und gemeldet. Bis dahin gilt: auf einem '
        + 'Stick schützt nur die Verschlüsselung.',
        'unklar'));
    }
  }

  /* --- das Modell -------------------------------------------------- */
  const aufStick = (self.modelle && self.modellePfad === self.pfad.trim() && self.modelle.stick)
    || (modell && modell.aufDemStick && !modell.aufDemStick.fehler ? modell.aufDemStick : null);
  if (aufStick && aufStick.vorhanden) {
    zeilen.push(wahrheit('Auf diesem Stick liegt ein Modell – aber nur für sein Betriebssystem',
      aufStick.satz, aufStick.passt ? 'ok' : 'fehlt'));
  } else {
    zeilen.push(wahrheit('Das Sprachmodell kommt nicht von selbst mit auf den Stick',
      (modell && modell.grund)
        || 'Ein Sprachmodell gehört einem Anbieter auf diesem Rechner, nicht Neural OS. Dazulegen lässt es sich unter „Modell mitnehmen".',
      'fehlt'));
  }
  zeilen.push(h('p.meta.stickv__folge', null, text(
    'Konkret: auf einem fremden Rechner ohne eigenes Modell und ohne Modell auf dem Stick hast du alle Notizen, '
    + 'Chats, Projekte und Verknüpfungen – aber keine neuen Antworten. Das Wissen reist immer mit, das Denken nur, '
    + 'wenn Modell und passender Laufzeitkern auf dem Stick liegen. '
    + (modell && modell.geprueft
      ? (modell.hierErreichbar
        ? 'Auf diesem Rechner ist zurzeit ein Modell erreichbar.'
        : 'Auf diesem Rechner ist zurzeit kein Modell erreichbar.')
      : 'Ob auf diesem Rechner ein Modell erreichbar ist, wurde noch nicht geprüft.'))));
  if (modell && modell.laufzeitkern) {
    const lk = modell.laufzeitkern;
    const satz = lk.zustand === 'laeuft' ? `Der Laufzeitkern vom Stick läuft (${lk.name || lk.art || 'Kern'}${lk.modellName ? `, ${lk.modellName}` : ''}).`
      : lk.zustand === 'startet' ? 'Der Laufzeitkern vom Stick startet noch – beim ersten Mal dauert das, bis das Modell im Arbeitsspeicher ist.'
        : lk.zustand === 'gescheitert' ? `Der Laufzeitkern vom Stick ist gescheitert: ${lk.grund || 'ohne Angabe eines Grundes'}`
          : 'Auf diesem Stick liegt kein startbarer Laufzeitkern.';
    zeilen.push(wahrheit('Das Modell vom Stick, gerade jetzt', satz,
      lk.zustand === 'laeuft' ? 'ok' : lk.zustand === 'gescheitert' ? 'fehlt' : 'unklar'));
  }

  /* --- der verlorene Stick ---------------------------------------- */
  zeilen.push(wahrheit('Ein verlorener Stick ist ein verlorener Datenbestand',
    'Deshalb: Verschlüsselung einschalten, und eine Sicherung woanders aufbewahren. Ein Stick geht '
    + 'verloren, geht kaputt, wird vergessen.',
    'fehlt'));

  return karte('Was du vorher wissen solltest', h('div.stack', null, zeilen));
}

function wahrheit(titel, satz, ton) {
  return h('div.stickv__wahrheit', { dataset: { ton } },
    h('strong', null, text(titel)),
    h('p.meta', null, text(satz)));
}

/* ------------------------------------------------------------------ */
/* Bausteine                                                           */
/* ------------------------------------------------------------------ */

function karte(titel, inhalt) {
  return h('section.card', null,
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
.stickv { max-width: 1000px; }
.stickv p { margin: 0; }

.stickv__self { border-left: 4px solid var(--fg-subtle); }
.stickv__self[data-portabel="1"] { border-left-color: var(--ok); }
.stickv__dot { width: 10px; height: 10px; flex: none; border-radius: var(--r-full); background: var(--fg-subtle); }
.stickv__self[data-portabel="1"] .stickv__dot { background: var(--ok); }

.stickv__buttons { flex-wrap: wrap; }

.stickv__box {
  padding: var(--sp-2);
  border: 1px solid var(--border);
  border-left: 4px solid var(--border-strong);
  border-radius: var(--r-2);
  background: var(--surface-2);
  font-size: var(--fs-sm);
  display: flex; flex-direction: column; gap: var(--sp-05);
  word-break: break-word;
}
.stickv__box[data-level="ok"] { border-left-color: var(--ok); }
.stickv__box[data-level="blocked"] { border-left-color: var(--warn); }
.stickv__box[data-level="fail"] { border-left-color: var(--danger); }

.stickv__bad { color: var(--danger); }
.stickv__warn { color: var(--warn); }

.stickv__probleme { margin: var(--sp-05) 0 0; padding-left: var(--sp-3); display: flex; flex-direction: column; gap: 3px; }
.stickv__probleme li { border-left: 3px solid var(--border-strong); padding-left: var(--sp-1); list-style: none; }
.stickv__probleme li[data-level="error"] { border-left-color: var(--danger); }
.stickv__probleme li[data-level="warn"] { border-left-color: var(--warn); }
.stickv__probleme li[data-level="info"] { border-left-color: var(--accent); }

.stickv__lauf[data-laeuft="1"] { border-color: var(--accent); }
.stickv__bar { position: relative; height: 6px; overflow: hidden; background: var(--surface-3); border-radius: var(--r-full); }
.stickv__bar-fill { height: 100%; width: 0; background: var(--accent); border-radius: var(--r-full); transition: width var(--dur-2) var(--ease); }
.stickv__bar-fill[data-unbekannt="1"] { width: 34%; animation: stickv-slide 1.1s var(--ease) infinite; position: absolute; top: 0; bottom: 0; }
@keyframes stickv-slide { from { left: -34%; } to { left: 100%; } }

.stickv__log > summary { cursor: pointer; font-size: var(--fs-sm); color: var(--fg-muted); }
.stickv__logliste { margin: var(--sp-05) 0 0; padding-left: var(--sp-3); font-size: var(--fs-xs); color: var(--fg-muted); list-style: none; }

.stickv__check { display: flex; align-items: center; gap: var(--sp-1); font-weight: 500; }

.stickv__rts { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--sp-1); }
.stickv__rt {
  display: flex; align-items: center; gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  border: 1px solid var(--border);
  border-left: 4px solid var(--fg-subtle);
  border-radius: var(--r-2);
}
.stickv__rt[data-ton="ok"] { border-left-color: var(--ok); }
.stickv__rt[data-ton="fehlt"] { border-left-color: var(--warn); }
.stickv__rt[data-ton="unklar"] { border-left-color: var(--border-strong); }
.stickv__rt p { margin: 2px 0 0; }
.stickv__rt .badge { margin-left: var(--sp-1); }

.stickv__wahrheit {
  padding: var(--sp-1) var(--sp-2);
  border-left: 4px solid var(--border-strong);
  border-radius: 0 var(--r-2) var(--r-2) 0;
  background: var(--surface-2);
}
.stickv__wahrheit[data-ton="ok"] { border-left-color: var(--ok); }
.stickv__wahrheit[data-ton="fehlt"] { border-left-color: var(--warn); }
.stickv__wahrheit[data-ton="unklar"] { border-left-color: var(--border-strong); }
.stickv__wahrheit p { margin: 2px 0 0; }
.stickv__folge { max-width: 78ch; }

.stickv__h3 { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; }

.stickv__funde { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--sp-1); }
.stickv__fund {
  padding: var(--sp-1) var(--sp-2);
  border: 1px solid var(--border);
  border-left: 4px solid var(--border-strong);
  border-radius: var(--r-2);
}
.stickv__fund[data-gewaehlt="1"] { border-left-color: var(--accent); }
.stickv__fund[data-rolle="kern"][data-gewaehlt="1"] { border-left-color: var(--ok); }
.stickv__fund .stickv__check { align-items: flex-start; }
.stickv__fund .stickv__check input { margin-top: 3px; }
.stickv__fund p { margin: var(--sp-05) 0 0; }

.stickv__anleitung { margin: 0; padding-left: var(--sp-3); display: flex; flex-direction: column; gap: 3px; }
.stickv__anleitung code { font-family: var(--font-mono); font-size: var(--fs-sm); background: var(--surface-3); padding: 0 4px; border-radius: var(--r-1); }

.stickv__aufstick { padding-left: var(--sp-2); border-left: 3px solid var(--border-strong); font-size: var(--fs-sm); }
.stickv__aufstick[data-ton="ok"] { border-left-color: var(--ok); }
.stickv__aufstick[data-ton="fehlt"] { border-left-color: var(--warn); }

@media (max-width: 680px) {
  .stickv__rt { flex-wrap: wrap; }
}
`;
