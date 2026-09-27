'use strict';

/**
 * Das Wissensuniversum -- die zoombare Themenkarte hinter dem "Gehirn".
 *
 * Was hier entsteht (Vertrag A, 27.09.2026)
 * ---------------------------------------
 * Ebene 0 sind Themenbereiche: grosse Kreise, hoechstens ~40. Ebene 1 ist
 * EIN Thema mit seinen Knoten und Kanten, dazu die Nachbarn ausserhalb
 * (`ausserhalb: true`), damit der Rand nicht ins Leere zeigt. Ein Thema mit
 * mindestens zwei Untergruppen traegt `kinder`, und jedes Kind ist selbst ein
 * Thema -- so geht es von "Schule" ueber "Biologie" bis "Genetik" hinein und
 * wieder heraus.
 *
 * Woher die Themen kommen, in dieser Reihenfolge:
 *   1. Schlagworte (#biologie) und Begriffe der Art `topic` -- beide auf
 *      denselben Schluessel gefaltet, damit "#biologie" und der Begriff
 *      "Biologie" EIN Thema sind (die Ableitung zieht ohnehin eine
 *      `tagged`-Kante zwischen ihnen).
 *   2. Projekte: das Projekt, seine Aufgaben und Termine (belongs-to), alles
 *      mit `projectId`, und was darauf verweist.
 *   3. Was danach noch ohne Thema ist, aber an einem Thema haengt, lagert
 *      sich an (die Notiz, die auf drei Biologie-Notizen verweist, gehoert
 *      zu Biologie, auch ohne Schlagwort).
 *   4. Der Rest wird per Label-Propagation gruppiert; eine Gruppe heisst wie
 *      der Knoten mit den meisten Verbindungen. Was gar nichts beruehrt,
 *      steht ehrlich unter "Unverbunden".
 *
 * Entscheidungen, die man dem Code nicht ansieht
 * -----------------------------------------------
 * - **Deterministisch.** Gleiche Daten, gleiche Karte: Knoten werden nach
 *   ID sortiert verarbeitet, Gleichstaende nach ID oder Name entschieden,
 *   die Label-Propagation laeuft in fester Reihenfolge und hoechstens acht
 *   Runden. Eine Karte, die sich bei jedem Oeffnen anders sortiert, kann
 *   niemand im Kopf behalten -- und genau darum geht es beim "durch das
 *   eigene Gehirn navigieren".
 * - **Farben sind Indizes (0-7), keine Hex-Werte.** Der Server weiss nichts
 *   von Dunkel- und Hellmodus; die Oberflaeche leitet die Toene aus ihren
 *   CSS-Variablen ab. Der Index haengt am Namen, nicht an der Position: ein
 *   Thema behaelt seine Farbe, wenn andere dazukommen.
 * - **Der Cache verfaellt, er rechnet nicht nach.** `attach()` haengt sich
 *   an record.*-Ereignisse und wirft die Karte weg; der naechste Aufruf baut
 *   sie neu. Ohne Bus (Tests mit einem Fake-Store) wird schlicht jedes Mal
 *   gebaut -- langsamer, nie falsch. Ein Cache, der still veraltet, waere
 *   die schlimmste der drei Moeglichkeiten.
 * - **Vorschlaege werden nie geschrieben** (Vertrag E). Nach dem Speichern
 *   einer Notiz rechnet der Server sie aus und schickt `graph.vorschlaege`;
 *   ein Mensch drueckt [Alle verbinden]. Abgelehnte Paare stehen als
 *   `suggestion`-Saetze (kind `link`, status `dismissed`, source `graph`)
 *   im Tresor -- die Satzart gibt es schon, sie braucht keine neue Schema-
 *   Zeile, und die Assistenz laesst fremde Quellen in Ruhe.
 * - **Keine Einbettungen.** Aehnlichkeit ist Jaccard ueber Stammformen und
 *   Schlagworte (src/graph/view.js), vorgefiltert durch die Volltextsuche.
 *   Das findet "Pflanzen brauchen Licht" neben "Chlorophyll absorbiert
 *   Licht" -- und nicht "Photosynthese" neben "Solarzelle". Das steht so
 *   auch in der Oberflaeche: der Grund nennt die gemeinsamen Woerter.
 */

const { NotFoundError, ValidationError } = require('../kernel/errors');
const { GRAPH_TYPES, EDGE_KINDS } = require('../store/schema');
const { fold } = require('../store/search');
const view = require('./view');

/** Arten, aus denen das Universum besteht. Agenten und Laeufe sind Betrieb, kein Wissen. */
const TYPEN = ['note', 'entity', 'project', 'task', 'event', 'file', 'chat'];
/** Arten, fuer die nach dem Speichern Verbindungsvorschlaege berechnet werden. */
const VORSCHLAG_TYPEN = new Set(['note', 'entity', 'project', 'task']);

const MAX_THEMEN = 40;
const MAX_KNOTEN = 2000;
const MAX_AUSSERHALB = 150;
const MAX_VERBINDUNGEN = 200;
const WICHTIGSTE = 5;
const LPA_RUNDEN = 8;
const KIND_UEBERLAPPUNG = 2;
const KIND_ANTEIL = 0.6;
const FARBEN = 8;
const MAX_VORSCHLAEGE = 5;
const MIN_SCORE = 0.02;
const VERZOEGERUNG_NEU_MS = 40;
const VERZOEGERUNG_AENDERUNG_MS = 400;

const UNVERBUNDEN = 'unverbunden';
const WEITERE = 'weitere';

const NOOP_LOGGER = { error() {}, warn() {}, info() {}, debug() {} };

/* ------------------------------------------------------------ Hilfen */

function idSort(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function nameSort(a, b) {
  const fa = fold(a);
  const fb = fold(b);
  return fa < fb ? -1 : fa > fb ? 1 : 0;
}

/** Erster Buchstabe gross: aus "#biologie" wird "Biologie". */
function schoen(tag) {
  const s = String(tag || '').trim().replace(/^#/, '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/** Der Schluessel, unter dem Schlagwort und Begriff zusammenfallen. */
function schluessel(name) {
  return fold(String(name || '').trim().replace(/^#/, '')).replace(/\s+/g, '-');
}

/**
 * Farben sind Indizes 0-7 einer dezenten Palette, die die Oberflaeche aus
 * ihren CSS-Variablen ableitet. Vergeben nach Rang auf Ebene 0 (die groessten
 * Themen bekommen 0, 1, 2 ... modulo 7), Kinder erben die Farbe ihres
 * Elternteils, und 7 ist neutral: "Unverbunden" und alles, was zu keinem
 * Kreis gehoert. Nach Rang statt nach Namen gehasht, weil sieben Farben
 * fuer vierzig Themen ohnehin nicht reichen und benachbarte Geschwister in
 * derselben Farbe das Bild unlesbar machten; mit gleichen Daten ist der
 * Rang gleich, also auch die Farbe.
 */
const FARBE_NEUTRAL = FARBEN - 1;

function farbenVergeben(oben, themen) {
  const farben = new Map();
  let rang = 0;
  for (const t of oben) {
    farben.set(t.id, t.id === UNVERBUNDEN ? FARBE_NEUTRAL : rang++ % FARBE_NEUTRAL);
  }
  // Kinder erben -- in Runden, weil ein Kind selbst Kinder haben kann.
  for (let runde = 0; runde < 8; runde++) {
    let neu = 0;
    for (const t of themen.values()) {
      if (farben.has(t.id) || !t.eltern || !farben.has(t.eltern)) continue;
      farben.set(t.id, farben.get(t.eltern));
      neu++;
    }
    if (!neu) break;
  }
  for (const t of themen.values()) if (!farben.has(t.id)) farben.set(t.id, FARBE_NEUTRAL);
  return farben;
}

/** Die Farbe eines Themas im gebauten Universum. */
function farbeFuer(u, themaId) {
  const f = u && u.farben ? u.farben.get(themaId) : undefined;
  return Number.isInteger(f) ? f : FARBE_NEUTRAL;
}

function intOpt(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function eindeutig(list) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(list) ? list : []) {
    if (typeof v !== 'string' || !v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/* -------------------------------------------------------------- Bauen */

function verbinde(nachbarn, a, b) {
  let m = nachbarn.get(a);
  if (!m) nachbarn.set(a, (m = new Map()));
  m.set(b, (m.get(b) || 0) + 1);
}

/**
 * Alles einsammeln, was ein Knoten sein kann, und die Kanten dazwischen.
 * Nur das Noetige wird behalten (kein Textkoerper): bei 10 000 Notizen ist
 * das der Unterschied zwischen 50 und 500 Millisekunden.
 */
function sammeln(store, typen) {
  const knoten = new Map();
  const projektMitglieder = new Map();
  for (const type of typen) {
    let items;
    try {
      items = store.list(type, {}).items;
    } catch {
      continue; // ein Store ohne diese Art hat einfach keine
    }
    for (const rec of items) {
      const d = rec.data || {};
      knoten.set(rec.id, {
        id: rec.id,
        type,
        label: view.label(rec),
        tags: view.tagsOf(rec),
        updatedAt: rec.updatedAt || '',
        pinned: !!d.pinned,
        grad: 0,
        art: type === 'entity' ? (d.kind || 'topic') : null,
      });
      if (typeof d.projectId === 'string' && d.projectId) {
        let list = projektMitglieder.get(d.projectId);
        if (!list) projektMitglieder.set(d.projectId, (list = []));
        list.push(rec.id);
      }
    }
  }

  const kanten = [];
  const nachbarn = new Map();
  let edgeItems = [];
  try {
    edgeItems = store.list('edge', {}).items;
  } catch { /* kein Kantenspeicher */ }
  edgeItems.sort((a, b) => idSort(a.id, b.id));
  for (const e of edgeItems) {
    const d = e.data || {};
    if (!knoten.has(d.from) || !knoten.has(d.to) || d.from === d.to) continue;
    kanten.push({ id: e.id, from: d.from, to: d.to, kind: d.kind || 'related', source: d.source || 'manual' });
    verbinde(nachbarn, d.from, d.to);
    verbinde(nachbarn, d.to, d.from);
    knoten.get(d.from).grad++;
    knoten.get(d.to).grad++;
  }
  return { knoten, kanten, nachbarn, projektMitglieder };
}

/**
 * Die Karte bauen. Rein: liest den Store, schreibt nichts.
 * @returns {object} das Universum (intern; die Routen sehen `ebene0`/`ebene1`)
 */
function bauen(store, opts = {}) {
  if (!store || typeof store.list !== 'function') throw new ValidationError('Das Universum benoetigt einen Store.');
  const t0 = Date.now();
  const typen = Array.isArray(opts.typen) && opts.typen.length
    ? opts.typen.filter((t) => GRAPH_TYPES.includes(t))
    : TYPEN.slice();

  const { knoten, kanten, nachbarn, projektMitglieder } = sammeln(store, typen);
  const reihe = [...knoten.values()].sort((a, b) => idSort(a.id, b.id));

  const themen = new Map();
  const zugeordnet = new Map(); // Knoten-ID -> Set<Thema-ID>
  const merke = (id, themaId) => {
    let set = zugeordnet.get(id);
    if (!set) zugeordnet.set(id, (set = new Set()));
    set.add(themaId);
  };
  const neuesThema = (id, name, quelle) => {
    const t = { id, name, quelle, mitglieder: new Set(), hub: null, kinder: [], eltern: null };
    themen.set(id, t);
    return t;
  };

  // 1. Schlagworte und Themenbegriffe -- ein Schluessel, ein Thema.
  for (const k of reihe) {
    for (const tag of k.tags) {
      const key = schluessel(tag);
      if (!key) continue;
      const id = `thema:${key}`;
      const t = themen.get(id) || neuesThema(id, schoen(tag), 'tag');
      t.mitglieder.add(k.id);
    }
  }
  for (const k of reihe) {
    if (k.type !== 'entity' || k.art !== 'topic') continue;
    const key = schluessel(k.label);
    if (!key) continue;
    const id = `thema:${key}`;
    let t = themen.get(id);
    if (!t) t = neuesThema(id, k.label, 'begriff');
    else { t.name = k.label; t.quelle = 'tag+begriff'; }
    t.hub = k.id;
    t.mitglieder.add(k.id);
    const nb = nachbarn.get(k.id);
    if (nb) for (const other of nb.keys()) t.mitglieder.add(other);
  }

  // 2. Projekte.
  for (const k of reihe) {
    if (k.type !== 'project') continue;
    const t = neuesThema(`projekt:${k.id}`, k.label, 'projekt');
    t.hub = k.id;
    t.mitglieder.add(k.id);
    const nb = nachbarn.get(k.id);
    if (nb) for (const other of nb.keys()) t.mitglieder.add(other);
    for (const id of projektMitglieder.get(k.id) || []) if (knoten.has(id)) t.mitglieder.add(id);
  }
  for (const t of themen.values()) for (const id of t.mitglieder) merke(id, t.id);

  // 3. Anlagern: ohne Thema, aber an einem Thema haengend.
  for (const k of reihe) {
    if (zugeordnet.has(k.id)) continue;
    const nb = nachbarn.get(k.id);
    if (!nb) continue;
    const zaehler = new Map();
    for (const [other, n] of nb) {
      const ts = zugeordnet.get(other);
      if (!ts) continue;
      for (const tid of ts) zaehler.set(tid, (zaehler.get(tid) || 0) + n);
    }
    if (!zaehler.size) continue;
    let best = null;
    let bestN = -1;
    for (const [tid, n] of zaehler) {
      const t = themen.get(tid);
      const b = best ? themen.get(best) : null;
      if (n > bestN || (n === bestN && (t.mitglieder.size > b.mitglieder.size
        || (t.mitglieder.size === b.mitglieder.size && idSort(tid, best) < 0)))) {
        best = tid;
        bestN = n;
      }
    }
    themen.get(best).mitglieder.add(k.id);
    merke(k.id, best);
  }

  // 4. Der Rest: Label-Propagation in fester Reihenfolge.
  const rest = reihe.filter((k) => !zugeordnet.has(k.id));
  const restSet = new Set(rest.map((k) => k.id));
  const label = new Map(rest.map((k) => [k.id, k.id]));
  for (let runde = 0; runde < LPA_RUNDEN; runde++) {
    let geaendert = 0;
    for (const k of rest) {
      const nb = nachbarn.get(k.id);
      if (!nb) continue;
      const zaehler = new Map();
      for (const [other, n] of nb) {
        if (!restSet.has(other)) continue;
        const l = label.get(other);
        zaehler.set(l, (zaehler.get(l) || 0) + n);
      }
      if (!zaehler.size) continue;
      let best = null;
      let bestN = -1;
      for (const [l, n] of zaehler) {
        if (n > bestN || (n === bestN && idSort(l, best) < 0)) { best = l; bestN = n; }
      }
      if (best !== label.get(k.id)) { label.set(k.id, best); geaendert++; }
    }
    if (!geaendert) break;
  }
  const gruppen = new Map();
  for (const k of rest) {
    const l = label.get(k.id);
    let list = gruppen.get(l);
    if (!list) gruppen.set(l, (list = []));
    list.push(k.id);
  }
  const unverbunden = [];
  for (const l of [...gruppen.keys()].sort(idSort)) {
    const ids = gruppen.get(l);
    if (ids.length < 2) { unverbunden.push(...ids); continue; }
    let hub = null;
    for (const id of ids) {
      const k = knoten.get(id);
      if (!hub || k.grad > knoten.get(hub).grad || (k.grad === knoten.get(hub).grad && idSort(id, hub) < 0)) hub = id;
    }
    const t = neuesThema(`gruppe:${hub}`, knoten.get(hub).label, 'gruppe');
    t.hub = hub;
    for (const id of ids) { t.mitglieder.add(id); merke(id, t.id); }
  }
  if (unverbunden.length) {
    const t = neuesThema(UNVERBUNDEN, 'Unverbunden', 'rest');
    for (const id of unverbunden) { t.mitglieder.add(id); merke(id, t.id); }
  }

  // 5. Kinder: ein Schlagwort-Thema, das ueberwiegend (>= 60 %, mindestens
  //    zwei Knoten) in einem groesseren liegt, ist dessen Untergruppe. Bei
  //    gleicher Ueberlappung gewinnt das KLEINERE Elternteil -- das
  //    speziellere: Genetik liegt ganz in Biologie und ganz in Schule, und
  //    "Schule > Biologie > Genetik" ist die Karte, die man im Kopf hat.
  //    Eltern mit >= 2 Kindern behalten sie; ein einzelnes Kind bleibt nur,
  //    wenn es GANZ im Elternteil liegt (ein Unterthema, kein Nachbar) --
  //    sonst stuende es als eigener Kreis daneben, obwohl es dazugehoert.
  const zuordnung = new Map(); // Kind -> {eltern, ganz}
  for (const kind of themen.values()) {
    if (!/^thema:/.test(kind.id) || kind.mitglieder.size < KIND_UEBERLAPPUNG) continue;
    const zaehler = new Map();
    for (const id of kind.mitglieder) {
      for (const tid of zugeordnet.get(id) || []) {
        if (tid === kind.id || tid === UNVERBUNDEN) continue;
        zaehler.set(tid, (zaehler.get(tid) || 0) + 1);
      }
    }
    let best = null;
    let bestN = 0;
    for (const [tid, n] of zaehler) {
      const p = themen.get(tid);
      if (p.mitglieder.size <= kind.mitglieder.size) continue;
      if (n < KIND_UEBERLAPPUNG || n / kind.mitglieder.size < KIND_ANTEIL) continue;
      const b = best ? themen.get(best) : null;
      if (n > bestN || (n === bestN && (p.mitglieder.size < b.mitglieder.size
        || (p.mitglieder.size === b.mitglieder.size && idSort(tid, best) < 0)))) {
        best = tid;
        bestN = n;
      }
    }
    if (best) zuordnung.set(kind.id, { eltern: best, ganz: bestN === kind.mitglieder.size });
  }
  const kinderVon = new Map();
  for (const [kindId, { eltern, ganz }] of zuordnung) {
    let list = kinderVon.get(eltern);
    if (!list) kinderVon.set(eltern, (list = []));
    list.push({ kindId, ganz });
  }
  for (const [elternId, kinder] of kinderVon) {
    if (kinder.length < 2 && !kinder.every((k) => k.ganz)) continue;
    const eltern = themen.get(elternId);
    for (const { kindId } of kinder) {
      const kind = themen.get(kindId);
      kind.eltern = elternId;
      eltern.kinder.push(kind);
    }
  }
  // Was ein Kind weiss, weiss das Elternteil: hineinzoomen zeigt alles.
  for (let tiefe = 0; tiefe < 6; tiefe++) {
    let gewachsen = false;
    for (const t of themen.values()) {
      for (const kind of t.kinder) {
        for (const id of kind.mitglieder) {
          if (!t.mitglieder.has(id)) { t.mitglieder.add(id); gewachsen = true; }
        }
      }
    }
    if (!gewachsen) break;
  }
  for (const t of themen.values()) {
    t.kinder.sort((a, b) => b.mitglieder.size - a.mitglieder.size || nameSort(a.name, b.name) || idSort(a.id, b.id));
  }

  // 6. Ebene 0: die Grossen; der Schwanz wird zu "Weitere Themen".
  let oben = [...themen.values()].filter((t) => !t.eltern && t.id !== UNVERBUNDEN);
  oben.sort((a, b) => b.mitglieder.size - a.mitglieder.size || nameSort(a.name, b.name) || idSort(a.id, b.id));
  const platz = MAX_THEMEN - (themen.has(UNVERBUNDEN) ? 1 : 0);
  if (oben.length > platz) {
    const bleiben = oben.slice(0, platz - 1);
    const schwanz = oben.slice(platz - 1);
    const w = neuesThema(WEITERE, 'Weitere Themen', 'sammlung');
    for (const t of schwanz) {
      t.eltern = WEITERE;
      w.kinder.push(t);
      for (const id of t.mitglieder) w.mitglieder.add(id);
    }
    oben = [...bleiben, w];
  }
  if (themen.has(UNVERBUNDEN)) oben.push(themen.get(UNVERBUNDEN));
  const farben = farbenVergeben(oben, themen);

  // 7. Wurzel je Thema und Hauptthema je Knoten (fuer Farbe und Verbindungen).
  const wurzel = new Map();
  for (const t of themen.values()) {
    let cur = t;
    let schritte = 0;
    while (cur.eltern && themen.has(cur.eltern) && schritte++ < 10) cur = themen.get(cur.eltern);
    wurzel.set(t.id, cur.id);
  }
  const haupt = new Map();
  for (const [id, ts] of zugeordnet) {
    let best = null;
    for (const tid of ts) {
      const r = wurzel.get(tid);
      const rt = themen.get(r);
      const bt = best ? themen.get(best) : null;
      if (!best || rt.mitglieder.size > bt.mitglieder.size
        || (rt.mitglieder.size === bt.mitglieder.size && idSort(r, best) < 0)) best = r;
    }
    haupt.set(id, best);
  }

  // 8. Kanten je Thema und Verbindungen zwischen den Kreisen -- ein Durchlauf.
  const innere = new Map();
  const zwischen = new Map();
  for (const e of kanten) {
    const a = zugeordnet.get(e.from);
    const b = zugeordnet.get(e.to);
    if (a && b) {
      for (const tid of a) if (b.has(tid)) innere.set(tid, (innere.get(tid) || 0) + 1);
    }
    const ra = haupt.get(e.from);
    const rb = haupt.get(e.to);
    if (ra && rb && ra !== rb) {
      const key = idSort(ra, rb) < 0 ? `${ra}\u0000${rb}` : `${rb}\u0000${ra}`;
      zwischen.set(key, (zwischen.get(key) || 0) + 1);
    }
  }
  const verbindungen = [...zwischen.entries()]
    .map(([key, anzahl]) => { const [von, zu] = key.split('\u0000'); return { von, zu, anzahl }; })
    .sort((a, b) => b.anzahl - a.anzahl || idSort(a.von, b.von) || idSort(a.zu, b.zu))
    .slice(0, MAX_VERBINDUNGEN);

  return {
    at: new Date().toISOString(),
    aufgebautMs: Date.now() - t0,
    typen,
    knoten,
    kanten,
    nachbarn,
    themen,
    zugeordnet,
    haupt,
    wurzel,
    innere,
    oben,
    farben,
    verbindungen,
    stand: 0,
  };
}

/* -------------------------------------------------------------- Cache */

const CACHE = new WeakMap();
const ANGEBUNDEN = new WeakSet();
let STAND = 0;

function typenGleich(a, b) {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * Das Universum fuer einen Store -- aus dem Cache, wenn ein Bus ihn
 * verfallen laesst (`attach`), sonst frisch gebaut.
 * @returns {{u:object, ausCache:boolean}}
 */
function universum(store, opts = {}) {
  const typen = Array.isArray(opts.typen) && opts.typen.length ? opts.typen.slice() : TYPEN.slice();
  const c = CACHE.get(store);
  if (c && c.gueltig && ANGEBUNDEN.has(store) && !opts.frisch && typenGleich(c.typen, typen)) {
    return { u: c.u, ausCache: true };
  }
  const u = bauen(store, { typen });
  u.stand = ++STAND;
  CACHE.set(store, { u, gueltig: true, typen });
  return { u, ausCache: false };
}

/** Den Cache dieses Stores verfallen lassen. */
function verwerfen(store) {
  const c = store && CACHE.get(store);
  if (c) c.gueltig = false;
}

/* ----------------------------------------------------------- Ausgabe */

/**
 * Die wichtigsten Knoten eines Themas: der Hub, dann Angeheftetes, dann nach
 * Grad. Bewusst OHNE Zeitstempel als letztes Kriterium -- der haengt an der
 * Reihenfolge des Anlegens, und gleiche Daten sollen dieselbe Karte geben.
 * Einmal je Bau berechnet (`t.wichtigste`), weil das groesste Thema bei
 * 10 000 Knoten Tausende Mitglieder sortieren muesste -- bei jeder Anfrage.
 */
function wichtigste(u, t) {
  if (t.wichtigste) return t.wichtigste;
  const ids = [...t.mitglieder];
  ids.sort((a, b) => {
    if (t.hub === a) return -1;
    if (t.hub === b) return 1;
    const ka = u.knoten.get(a);
    const kb = u.knoten.get(b);
    if (ka.pinned !== kb.pinned) return ka.pinned ? -1 : 1;
    if (ka.grad !== kb.grad) return kb.grad - ka.grad;
    return idSort(a, b);
  });
  t.wichtigste = ids.slice(0, WICHTIGSTE);
  return t.wichtigste;
}

function kindKarte(u, t) {
  return { id: t.id, name: t.name, anzahl: t.mitglieder.size, farbe: farbeFuer(u, t.id), quelle: t.quelle };
}

function themaKarte(u, t) {
  return {
    id: t.id,
    name: t.name,
    anzahl: t.mitglieder.size,
    farbe: farbeFuer(u, t.id),
    quelle: t.quelle,
    hub: t.hub,
    kanten: u.innere.get(t.id) || 0,
    knoten: wichtigste(u, t),
    kinder: t.kinder.map((k) => kindKarte(u, k)),
  };
}

function knotenKarte(u, k, ausserhalb) {
  return {
    id: k.id,
    type: k.type,
    label: k.label,
    tags: k.tags,
    grad: k.grad,
    updatedAt: k.updatedAt,
    pinned: k.pinned,
    ausserhalb,
    thema: u.haupt.get(k.id) || null,
    farbe: farbeFuer(u, u.haupt.get(k.id)),
    themen: [...(u.zugeordnet.get(k.id) || [])],
  };
}

/** Ebene 0: die Themenbereiche. Einmal je Bau zusammengestellt, dann kopiert. */
function ebene0(u) {
  if (!u.ebene0Karte) {
    u.ebene0Karte = {
      ebene: 0,
      themen: u.oben.map((t) => themaKarte(u, t)),
      verbindungen: u.verbindungen,
      // "Weitere Themen" ist ein Behaelter, kein Thema: er zaehlt nicht mit.
      gesamt: { knoten: u.knoten.size, kanten: u.kanten.length, themen: u.themen.size - (u.themen.has(WEITERE) ? 1 : 0) },
      stand: u.stand,
      aufgebautMs: u.aufgebautMs,
      at: u.at,
    };
  }
  return { ...u.ebene0Karte };
}

/** Ebene 1: ein Thema, seine Knoten und Kanten, dazu die Nachbarn ausserhalb. */
function ebene1(u, themaId) {
  const t = u.themen.get(themaId);
  if (!t) throw new NotFoundError(`Thema ${themaId}`);

  let mitglieder = [...t.mitglieder];
  mitglieder.sort((a, b) => {
    const ka = u.knoten.get(a);
    const kb = u.knoten.get(b);
    if (ka.grad !== kb.grad) return kb.grad - ka.grad;
    return idSort(a, b);
  });
  const gekuerzt = mitglieder.length > MAX_KNOTEN;
  if (gekuerzt) mitglieder = mitglieder.slice(0, MAX_KNOTEN);
  const drin = new Set(mitglieder);

  // Nachbarn ausserhalb, nach Zahl der Kanten ins Thema.
  const draussen = new Map();
  for (const id of mitglieder) {
    const nb = u.nachbarn.get(id);
    if (!nb) continue;
    for (const [other, n] of nb) {
      if (drin.has(other)) continue;
      draussen.set(other, (draussen.get(other) || 0) + n);
    }
  }
  const ausserhalb = [...draussen.entries()]
    .sort((a, b) => b[1] - a[1] || idSort(a[0], b[0]))
    .slice(0, MAX_AUSSERHALB)
    .map(([id]) => id);
  const sichtbar = new Set([...drin, ...ausserhalb]);

  const kanten = [];
  for (const e of u.kanten) {
    if (!sichtbar.has(e.from) || !sichtbar.has(e.to)) continue;
    if (!drin.has(e.from) && !drin.has(e.to)) continue;
    kanten.push(e);
  }

  const pfad = [];
  let cur = t;
  let schritte = 0;
  while (cur.eltern && u.themen.has(cur.eltern) && schritte++ < 10) {
    cur = u.themen.get(cur.eltern);
    pfad.unshift({ id: cur.id, name: cur.name });
  }

  return {
    ebene: 1,
    thema: { ...themaKarte(u, t), eltern: t.eltern, pfad },
    knoten: [
      ...mitglieder.map((id) => knotenKarte(u, u.knoten.get(id), false)),
      ...ausserhalb.map((id) => knotenKarte(u, u.knoten.get(id), true)),
    ],
    kanten,
    gekuerzt,
    stand: u.stand,
    at: u.at,
  };
}

/** Die Themen, zu denen ein Knoten gehoert (fuer die Informationskarte). */
function themenVon(store, recordId, opts = {}) {
  const { u } = universum(store, opts);
  const ts = u.zugeordnet.get(recordId);
  if (!ts) return [];
  return [...ts].map((tid) => kindKarte(u, u.themen.get(tid)))
    .sort((a, b) => b.anzahl - a.anzahl || nameSort(a.name, b.name));
}

/* ------------------------------------------------------- Vorschlaege */

/**
 * Abgelehnte Vorschlaege fuer einen Satz: die Gegenseite jedes Paares.
 * @returns {Set<string>}
 */
function abgelehnteFuer(store, recordId) {
  const out = new Set();
  let items = [];
  try {
    items = store.list('suggestion', {}).items;
  } catch { /* keine Vorschlaege gespeichert */ }
  for (const s of items) {
    const d = s.data || {};
    if (d.source !== 'graph' || d.kind !== 'link' || d.status !== 'dismissed') continue;
    const ids = Array.isArray(d.recordIds) ? d.recordIds : [];
    if (ids[0] === recordId && typeof ids[1] === 'string') out.add(ids[1]);
    else if (ids[1] === recordId && typeof ids[0] === 'string') out.add(ids[0]);
  }
  return out;
}

/**
 * Verbindungsvorschlaege fuer einen Satz (Vertrag B und E).
 *
 * Vorgefiltert ueber die Volltextsuche, wo es eine gibt: die Stammformen des
 * Satzes als ODER-Anfrage (Praefixe finden "Pflanze" wie "Pflanzen"), dazu
 * je Schlagwort eine `tag:`-Anfrage. Gewertet wird dann wie immer
 * (view.suggestLinks); abgelehnte Paare fallen heraus.
 *
 * @returns {Array<{id,type,title,score,grund,gemeinsam,sharedTags,sharedTerms}>}
 */
function vorschlaegeFuer(store, recordId, opts = {}) {
  if (!store || typeof store.get !== 'function') throw new ValidationError('vorschlaegeFuer benoetigt einen Store.');
  const record = typeof recordId === 'string' ? store.get(recordId) : null;
  if (!record) throw new NotFoundError(`Record ${String(recordId)}`);
  const limit = intOpt(opts.limit, MAX_VORSCHLAEGE, 1, 50);
  const minScore = typeof opts.minScore === 'number' ? opts.minScore : MIN_SCORE;
  const exclude = abgelehnteFuer(store, record.id);

  let candidates = null;
  if (typeof store.search === 'function' && store.searchIndex) {
    candidates = [];
    const seen = new Set();
    const sammle = (res) => {
      for (const hit of (res && res.items) || []) {
        if (!hit || !hit.record || seen.has(hit.record.id)) continue;
        seen.add(hit.record.id);
        candidates.push(hit.record);
      }
    };
    const staemme = [...view.termMap(record).keys()]
      .sort((a, b) => b.length - a.length || idSort(a, b))
      .slice(0, 16);
    if (staemme.length) {
      try { sammle(store.search(staemme.join(' '), { types: TYPEN, limit: 80 })); } catch { /* Suche gestoert: dann ohne */ }
    }
    for (const tag of view.tagsOf(record).slice(0, 5)) {
      try { sammle(store.search(`tag:${tag}`, { types: TYPEN, limit: 40 })); } catch { /* s. o. */ }
    }
  }

  const out = view.suggestLinks(store, record.id, {
    limit,
    minScore,
    types: TYPEN,
    exclude,
    ...(candidates ? { candidates } : { pool: 500 }),
  });
  return out.map((v) => ({
    id: v.id,
    type: v.type,
    title: v.label,
    score: v.score,
    grund: v.grund,
    gemeinsam: v.gemeinsam,
    sharedTags: v.sharedTags,
    sharedTerms: v.sharedTerms,
  }));
}

/* ------------------------------------------------- Verbinden, Ablehnen */

function mussLeben(store, id, was) {
  const rec = typeof id === 'string' && id ? store.get(id) : null;
  if (!rec) throw new NotFoundError(`${was} ${String(id)}`);
  return rec;
}

/**
 * Manuelle Kanten von `from` zu jedem `to` (Vertrag C). Alles wird zuerst
 * geprueft, dann geschrieben: halb verbunden ist schlimmer als gar nicht.
 * @returns {{edges:object[], neu:string[], bereits:string[], rueckgaengig:object|null}}
 */
function verbinden(store, from, to, opts = {}) {
  if (!store || !store.edges || typeof store.edges.add !== 'function') throw new ValidationError('verbinden benoetigt einen Store mit edges-API.');
  const quelle = mussLeben(store, from, 'Eintrag');
  const kind = typeof opts.kind === 'string' && opts.kind ? opts.kind : 'related';
  if (!EDGE_KINDS.includes(kind)) {
    throw new ValidationError(`"${kind}" ist keine bekannte Verknüpfungsart. Möglich: ${EDGE_KINDS.join(', ')}.`);
  }
  const ziele = eindeutig(to).filter((id) => id !== quelle.id);
  if (!ziele.length) throw new ValidationError('"to" muss mindestens einen anderen Eintrag nennen.');
  for (const id of ziele) mussLeben(store, id, 'Eintrag');
  const reason = typeof opts.reason === 'string' && opts.reason.trim() ? opts.reason.trim() : 'Im Gehirn verbunden';

  const vorhanden = new Set();
  try {
    for (const e of store.edges.for(quelle.id, { direction: 'out' })) vorhanden.add(`${e.data.to}\u0000${e.data.kind}`);
  } catch { /* keine Kanten */ }

  const edges = [];
  const neu = [];
  const bereits = [];
  for (const ziel of ziele) {
    const edge = store.edges.add({ from: quelle.id, to: ziel, kind, source: 'manual', reason, weight: 1 });
    edges.push(edge);
    if (vorhanden.has(`${ziel}\u0000${kind}`)) bereits.push(edge.id);
    else neu.push(edge.id);
  }
  return {
    edges,
    neu,
    bereits,
    rueckgaengig: neu.length ? { pfad: '/api/graph/rueckgaengig', methode: 'POST', body: { edges: neu }, edges: neu } : null,
  };
}

/**
 * Die Umkehrung von `verbinden`: genau diese manuellen Kanten wieder weg
 * (weich geloescht, wie jede Kante). Abgeleitete Kanten werden verweigert --
 * die Ableitung zoege sie beim naechsten Speichern ohnehin neu.
 */
function rueckgaengig(store, edgeIds) {
  if (!store || !store.edges) throw new ValidationError('rueckgaengig benoetigt einen Store mit edges-API.');
  const ids = eindeutig(edgeIds);
  if (!ids.length) throw new ValidationError('"edges" muss mindestens eine Kante nennen.');
  const kanten = [];
  for (const id of ids) {
    const edge = store.get(id);
    if (!edge || edge.type !== 'edge') throw new NotFoundError(`Verknüpfung ${id}`);
    if (edge.data.source !== 'manual') {
      throw new ValidationError(`Die Verknüpfung ${id} wurde abgeleitet (${edge.data.reason || edge.data.kind}) und lässt sich nur über den Text ändern.`);
    }
    kanten.push(edge);
  }
  const entfernt = kanten.map((edge) => store.edges.remove(edge.id));
  return { entfernt, anzahl: entfernt.length };
}

/**
 * Ablehnen merkt sich das Paar, damit derselbe Vorschlag nicht wiederkommt.
 * Gespeichert als `suggestion` (kind link, status dismissed, source graph).
 */
function ablehnen(store, from, to) {
  if (!store || typeof store.create !== 'function') throw new ValidationError('ablehnen benoetigt einen Store.');
  const quelle = mussLeben(store, from, 'Eintrag');
  const ziele = eindeutig(to).filter((id) => id !== quelle.id);
  if (!ziele.length) throw new ValidationError('"to" muss mindestens einen anderen Eintrag nennen.');
  const records = new Map();
  for (const id of ziele) records.set(id, mussLeben(store, id, 'Eintrag'));
  const schon = abgelehnteFuer(store, quelle.id);

  const abgelehnt = [];
  const bereits = [];
  for (const ziel of ziele) {
    if (schon.has(ziel)) { bereits.push(ziel); continue; }
    const satz = store.create('suggestion', {
      kind: 'link',
      title: `Verbindung abgelehnt: ${view.label(quelle)} – ${view.label(records.get(ziel))}`,
      detail: '',
      reason: 'Im Gehirn abgelehnt; dieser Vorschlag kommt nicht wieder.',
      recordIds: [quelle.id, ziel],
      action: { op: 'link', from: quelle.id, to: ziel, kind: 'related' },
      confidence: 0,
      status: 'dismissed',
      source: 'graph',
      decidedAt: new Date().toISOString(),
    });
    abgelehnt.push({ id: ziel, satz: satz.id });
  }
  return { from: quelle.id, abgelehnt, bereits };
}

/* ----------------------------------------------------------- Anbinden */

/** Was das Universum veraendert: seine Arten und die Kanten. */
const VERFALL_TYPEN = new Set([...TYPEN, 'edge']);

/**
 * An den Bus haengen (Vertrag D, E, F):
 *   - record.*      -> Cache verfaellt; fuer Notizen u. ae. werden nach einer
 *                      kurzen Verzoegerung Vorschlaege gerechnet und als
 *                      'graph.vorschlaege' {recordId, type, anzahl, vorschlaege}
 *                      geschickt -- nur, wenn es welche gibt.
 *   - edge.created  -> 'graph.kante' {edge, neu:true, von, zu}
 *   - edge.deleted  -> 'graph.kante' {edge, entfernt:true, von, zu}
 *
 * Einmal je Bus; ein zweiter Aufruf gibt dieselbe Anbindung zurueck.
 * `istAusgesetzt()` (aus app.js) haelt die Vorschlaege waehrend eines
 * Massenimports an -- dort waere jede Notiz ein Ereignis.
 */
function attach({ store, bus, logger, istAusgesetzt, verzoegerungMs } = {}) {
  if (!store || !bus || typeof bus.on !== 'function' || typeof bus.publish !== 'function') {
    throw new ValidationError('attach benoetigt store und bus.');
  }
  if (store.__universum) return store.__universum;
  const log = logger && typeof logger.warn === 'function' ? logger : NOOP_LOGGER;
  const ausgesetzt = typeof istAusgesetzt === 'function' ? istAusgesetzt : () => false;
  const warten = {
    neu: Number.isInteger(verzoegerungMs && verzoegerungMs.neu) ? verzoegerungMs.neu : VERZOEGERUNG_NEU_MS,
    aenderung: Number.isInteger(verzoegerungMs && verzoegerungMs.aenderung) ? verzoegerungMs.aenderung : VERZOEGERUNG_AENDERUNG_MS,
  };
  const timer = new Map();
  let offen = true;

  const publish = (name, payload) => {
    try { bus.publish(name, payload); } catch (err) { log.warn(`bus.publish(${name}) fehlgeschlagen: ${err && err.message}`); }
  };
  const leicht = (id) => {
    const rec = typeof id === 'string' ? store.get(id) : null;
    return rec ? { id: rec.id, type: rec.type, label: view.label(rec) } : null;
  };

  const planen = (record, ms) => {
    if (!offen || ausgesetzt()) return;
    const alt = timer.get(record.id);
    if (alt) clearTimeout(alt);
    const t = setTimeout(() => {
      timer.delete(record.id);
      if (!offen || ausgesetzt()) return;
      let vorschlaege;
      try {
        if (!store.get(record.id)) return; // inzwischen geloescht
        vorschlaege = vorschlaegeFuer(store, record.id, { limit: MAX_VORSCHLAEGE });
      } catch (err) {
        log.warn(`Verbindungsvorschlaege fuer ${record.id} fehlgeschlagen: ${err && err.message}`);
        return;
      }
      if (!vorschlaege.length) return;
      publish('graph.vorschlaege', { recordId: record.id, type: record.type, anzahl: vorschlaege.length, vorschlaege });
    }, ms);
    timer.set(record.id, t);
  };

  const onRecord = (evt) => {
    const p = evt && evt.payload;
    if (!p) return;
    const type = p.type || (p.record && p.record.type);
    if (VERFALL_TYPEN.has(type)) verwerfen(store);
    if (evt.name === 'record.deleted' || !p.record || p.record.deletedAt) return;
    if (!VORSCHLAG_TYPEN.has(type)) return;
    planen(p.record, evt.name === 'record.created' ? warten.neu : warten.aenderung);
  };
  const onEdgeCreated = (evt) => {
    const edge = evt && evt.payload && evt.payload.edge;
    if (!edge || !edge.data) return;
    publish('graph.kante', {
      edge, neu: true, wiederhergestellt: !!evt.payload.restored,
      von: leicht(edge.data.from), zu: leicht(edge.data.to),
    });
  };
  const onEdgeDeleted = (evt) => {
    const edge = evt && evt.payload && evt.payload.edge;
    if (!edge || !edge.data) return;
    publish('graph.kante', { edge, entfernt: true, von: leicht(edge.data.from), zu: leicht(edge.data.to) });
  };

  const abos = [
    ['record.created', onRecord],
    ['record.updated', onRecord],
    ['record.deleted', onRecord],
    ['edge.created', onEdgeCreated],
    ['edge.deleted', onEdgeDeleted],
  ];
  for (const [name, fn] of abos) bus.on(name, fn);
  ANGEBUNDEN.add(store);

  const anbindung = {
    detach() {
      if (!offen) return;
      offen = false;
      for (const [name, fn] of abos) { try { bus.off(name, fn); } catch { /* schon weg */ } }
      for (const t of timer.values()) clearTimeout(t);
      timer.clear();
      ANGEBUNDEN.delete(store);
      verwerfen(store);
      if (store.__universum === anbindung) delete store.__universum;
    },
    /** Fuer Tests: wartet nichts mehr auf einen Zeitgeber? */
    get ausstehend() { return timer.size; },
  };
  try {
    Object.defineProperty(store, '__universum', { value: anbindung, configurable: true, enumerable: false, writable: true });
  } catch { /* eingefrorener Store: dann ohne Merkzettel */ }
  return anbindung;
}

module.exports = {
  bauen,
  universum,
  verwerfen,
  ebene0,
  ebene1,
  themenVon,
  vorschlaegeFuer,
  abgelehnteFuer,
  verbinden,
  rueckgaengig,
  ablehnen,
  attach,
  farbeFuer,
  FARBEN,
  FARBE_NEUTRAL,
  TYPEN,
  VORSCHLAG_TYPEN,
  MAX_THEMEN,
  MAX_KNOTEN,
  MAX_VORSCHLAEGE,
  UNVERBUNDEN,
  WEITERE,
};
