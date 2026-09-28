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
 * ihren CSS-Variablen ableitet. 7 ist neutral: "Unverbunden" und der
 * Behaelter "Weitere Themen" -- beides sind keine Wissensgebiete und sollen
 * nicht wie eines aussehen.
 *
 * Ein Thema BEHAELT seine Farbe (Pruefer, Runde 1: nach Rang vergeben
 * sprangen Biologie und Geschichte, sobald Geschichte zwei Notizen mehr
 * hatte). Deshalb:
 *   - Die erste Wahl haengt am Schluessel des Themas (djb2 ueber die ID), nicht
 *     an seinem Platz; sie aendert sich nie.
 *   - Ist sie auf der Karte schon vergeben, nimmt das neue Thema die am
 *     wenigsten benutzte Farbe, von der ersten Wahl aus weitergezaehlt -- so
 *     tragen benachbarte Themen verschiedene Toene, solange es sieben gibt.
 *   - Einmal vergeben, merkt sich der Store die Farbe (FARB_GEDAECHTNIS):
 *     wachsen andere Themen, kommen neue dazu oder verschwinden welche,
 *     bleibt sie. Neu gebaut (anderer Store, gleiche Daten) entsteht in
 *     derselben Reihenfolge dieselbe Karte.
 * Kinder erben die Farbe ihres Elternteils; die Kinder von "Weitere Themen"
 * sind echte Themen und bekommen ihre eigene.
 */
const FARBE_NEUTRAL = FARBEN - 1;
const FARB_GEDAECHTNIS = new WeakMap();

function hashFarbe(id) {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h * 33) ^ id.charCodeAt(i)) >>> 0;
  return h % FARBE_NEUTRAL;
}

function farbenVergeben(oben, themen, gedaechtnis = new Map()) {
  const farben = new Map();
  const belegt = new Array(FARBE_NEUTRAL).fill(0);
  const neutral = (t) => t.id === UNVERBUNDEN || t.id === WEITERE;
  const waehle = (t) => {
    if (gedaechtnis.has(t.id)) return gedaechtnis.get(t.id);
    const erste = hashFarbe(t.id);
    let beste = erste;
    for (let k = 0; k < FARBE_NEUTRAL; k++) {
      const c = (erste + k) % FARBE_NEUTRAL;
      if (belegt[c] < belegt[beste]) beste = c;
    }
    gedaechtnis.set(t.id, beste);
    return beste;
  };
  // Erst, wer seine Farbe schon hat (damit sie als belegt zaehlt), dann die neuen.
  for (const t of oben) {
    if (neutral(t)) { farben.set(t.id, FARBE_NEUTRAL); continue; }
    if (!gedaechtnis.has(t.id)) continue;
    const c = gedaechtnis.get(t.id);
    farben.set(t.id, c);
    belegt[c]++;
  }
  for (const t of oben) {
    if (farben.has(t.id)) continue;
    const c = waehle(t);
    farben.set(t.id, c);
    belegt[c]++;
  }
  // Kinder erben -- in Runden, weil ein Kind selbst Kinder haben kann.
  for (let runde = 0; runde < 8; runde++) {
    let neu = 0;
    for (const t of themen.values()) {
      if (farben.has(t.id) || !t.eltern || !farben.has(t.eltern)) continue;
      farben.set(t.id, t.eltern === WEITERE ? waehle(t) : farben.get(t.eltern));
      neu++;
    }
    if (!neu) break;
  }
  for (const t of themen.values()) if (!farben.has(t.id)) farben.set(t.id, FARBE_NEUTRAL);
  // Vergessen, was es nicht mehr gibt -- aber erst, wenn es viel wird.
  if (gedaechtnis.size > 5000) for (const id of [...gedaechtnis.keys()]) if (!themen.has(id)) gedaechtnis.delete(id);
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

/** Das, was ein Satz zum Universum beitraegt -- ohne Textkoerper. */
function knotenAus(rec) {
  const d = rec.data || {};
  const type = rec.type;
  return {
    id: rec.id,
    type,
    label: view.label(rec),
    tags: view.tagsOf(rec),
    updatedAt: rec.updatedAt || '',
    pinned: !!d.pinned,
    grad: 0,
    art: type === 'entity' ? (d.kind || 'topic') : null,
    // Wohin "Oeffnen" eine Aufgabe fuehrt: in ihr Projekt.
    projekt: type === 'task' && typeof d.projectId === 'string' && d.projectId ? d.projectId : null,
    pid: typeof d.projectId === 'string' && d.projectId ? d.projectId : null,
  };
}

function kanteAus(e) {
  const d = e.data || {};
  return { id: e.id, from: d.from, to: d.to, kind: d.kind || 'related', source: d.source || 'manual' };
}

/**
 * Die Rohdaten je Store (Knoten ohne Text, Kanten ohne Grund), von `attach`
 * Satz fuer Satz nachgefuehrt. Ohne sie las jeder Neubau alle 10 000 Saetze
 * und 40 000 Kanten neu aus dem Speicher (jede eine Kopie) -- das war der
 * groesste Teil der ~320 ms, die nach jedem Speichern in einem dichten
 * Tresor faellig wurden (Pruefer, Runde 1, Vertrag F). Ohne Bus-Anbindung
 * wird wie bisher jedes Mal frisch gelesen.
 */
const ROH = new WeakMap();

function rohLesen(store, typen) {
  const knoten = new Map();
  for (const type of typen) {
    let items;
    try {
      items = store.list(type, {}).items;
    } catch {
      continue; // ein Store ohne diese Art hat einfach keine
    }
    for (const rec of items) knoten.set(rec.id, knotenAus(rec));
  }
  const kanten = new Map();
  let edgeItems = [];
  try {
    edgeItems = store.list('edge', {}).items;
  } catch { /* kein Kantenspeicher */ }
  for (const e of edgeItems) kanten.set(e.id, kanteAus(e));
  // kv: Stand der Knoten-MENGE (anlegen/loeschen, nicht aendern). Solange
  // sie und die Kanten gleich bleiben, bleibt auch das Netz (Nachbarn, Grad,
  // Reihenfolge) gleich -- das Speichern einer Notiz aendert es nicht.
  return { knoten, kanten, sortiert: null, kv: 0, netz: null, reihe: null };
}

/**
 * Alles einsammeln, was ein Knoten sein kann, und die Kanten dazwischen.
 * Nur das Noetige wird behalten (kein Textkoerper): bei 10 000 Notizen ist
 * das der Unterschied zwischen 50 und 500 Millisekunden.
 */
function sammeln(store, typen) {
  const standard = typenGleich(typen, TYPEN);
  let roh = standard && ANGEBUNDEN.has(store) ? ROH.get(store) : null;
  if (!roh) {
    roh = rohLesen(store, typen);
    if (standard && ANGEBUNDEN.has(store)) ROH.set(store, roh);
  }
  // Nach ID sortiert: gleiche Daten, gleiche Reihenfolge. Einmal sortiert,
  // danach fuehrt rohNachfuehren die Liste Kante fuer Kante nach.
  if (!roh.sortiert) { roh.sortiert = [...roh.kanten.values()].sort((a, b) => idSort(a.id, b.id)); roh.netz = null; }
  // Das Netz (Kanten zwischen Knoten, Nachbarn, Grad, Paare) haengt an der
  // Knoten-MENGE und den Kanten. Speichern einer Notiz aendert die Menge
  // nicht; eine Kante mehr oder weniger fuehrt rohNachfuehren einzeln nach.
  // Nur wenn Knoten dazukommen oder gehen, wird es neu gezaehlt (Vertrag F,
  // dichter Tresor: vorher je Speichern 40 000 Kanten neu sortiert und
  // verknuepft). bauen() liest die Strukturen nur.
  let netz = roh.netz && roh.netz.kv === roh.kv ? roh.netz : null;
  if (!netz) {
    netz = { kv: roh.kv, kanten: [], nachbarn: new Map(), grad: new Map(), paare: new Map() };
    for (const e of roh.sortiert) {
      if (!netzGilt(roh, e)) continue;
      netz.kanten.push(e);
      netzZaehlen(netz, e, 1);
    }
    roh.netz = netz;
  }
  const knoten = new Map();
  const projektMitglieder = new Map();
  for (const [id, k] of roh.knoten) {
    // Dasselbe Objekt, nur der Grad frisch: 10 000 Kopien je Neubau waren
    // ein Sechstel der Zeit. bauen() und die Ausgabe lesen Knoten nur.
    k.grad = netz.grad.get(id) || 0;
    knoten.set(id, k);
    if (k.pid) {
      let list = projektMitglieder.get(k.pid);
      if (!list) projektMitglieder.set(k.pid, (list = []));
      list.push(id);
    }
  }
  if (!roh.reihe || roh.reihe.kv !== roh.kv) roh.reihe = { kv: roh.kv, ids: [...roh.knoten.keys()].sort(idSort) };
  return { knoten, kanten: netz.kanten, nachbarn: netz.nachbarn, projektMitglieder, reiheIds: roh.reihe.ids, paare: netz.paare };
}

/** Zaehlt diese Kante im Netz mit (beide Enden bekannt, keine Schleife)? */
function netzGilt(roh, e) {
  return e.from !== e.to && roh.knoten.has(e.from) && roh.knoten.has(e.to);
}

/** Eine Kante im Netz zaehlen (+1) oder austragen (-1): Nachbarn, Grad, Paar. */
function netzZaehlen(netz, e, d) {
  const plus = (a, b) => {
    let m = netz.nachbarn.get(a);
    if (!m) netz.nachbarn.set(a, (m = new Map()));
    const n = (m.get(b) || 0) + d;
    if (n > 0) m.set(b, n);
    else { m.delete(b); if (!m.size) netz.nachbarn.delete(a); }
    const g = (netz.grad.get(a) || 0) + d;
    if (g > 0) netz.grad.set(a, g); else netz.grad.delete(a);
  };
  plus(e.from, e.to);
  plus(e.to, e.from);
  // Ein Paar ist EINE Linie, egal wie viele Kanten es traegt.
  const key = e.from < e.to ? `${e.from}\u0000${e.to}` : `${e.to}\u0000${e.from}`;
  const p = netz.paare.get(key);
  if (p) {
    p.n += d;
    if (p.n <= 0) netz.paare.delete(key);
  } else if (d > 0) {
    netz.paare.set(key, { von: e.from, zu: e.to, n: d });
  }
}

/** Erste Stelle in einer nach ID sortierten Liste mit id >= gesucht. */
function stelle(liste, id) {
  let lo = 0;
  let hi = liste.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (liste[mid].id < id) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function sortiertWeg(liste, e) {
  const i = stelle(liste, e.id);
  if (i < liste.length && liste[i].id === e.id) liste.splice(i, 1);
}

function sortiertDazu(liste, e) {
  liste.splice(stelle(liste, e.id), 0, e);
}

/** Einen geschriebenen Satz in die Rohdaten uebernehmen (von attach). */
function rohNachfuehren(store, evtName, p) {
  const roh = ROH.get(store);
  if (!roh || !p) return;
  const rec = p.record || p.edge || null;
  const id = p.id || (rec && rec.id);
  const type = p.type || (rec && rec.type);
  if (!id) return;
  const weg = evtName === 'record.deleted' || evtName === 'edge.deleted' || !rec || rec.deletedAt;
  if (type === 'edge') {
    const netz = roh.netz && roh.netz.kv === roh.kv ? roh.netz : null;
    const alt = roh.kanten.get(id);
    if (alt) {
      roh.kanten.delete(id);
      if (roh.sortiert) sortiertWeg(roh.sortiert, alt);
      if (netz && netzGilt(roh, alt)) { sortiertWeg(netz.kanten, alt); netzZaehlen(netz, alt, -1); }
    }
    if (!weg) {
      const e = kanteAus(rec);
      roh.kanten.set(id, e);
      if (roh.sortiert) sortiertDazu(roh.sortiert, e);
      if (netz && netzGilt(roh, e)) { sortiertDazu(netz.kanten, e); netzZaehlen(netz, e, 1); }
    }
    return;
  }
  if (!TYPEN.includes(type)) return;
  if (weg) {
    if (roh.knoten.delete(id)) roh.kv++;
  } else {
    if (!roh.knoten.has(id)) roh.kv++;
    roh.knoten.set(id, knotenAus(rec));
  }
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

  const { knoten, kanten, nachbarn, projektMitglieder, reiheIds, paare } = sammeln(store, typen);
  const reihe = reiheIds.map((id) => knoten.get(id));

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

  // 1. Schlagworte und Themenbegriffe -- ein Schluessel, ein Thema. Der
  //    Name ist die haeufigste Schreibweise (mit grossem Anfang; bei
  //    Gleichstand nicht die in Grossbuchstaben, dann alphabetisch) -- nicht
  //    die des Knotens mit der kleinsten ID: "Genetik", "genetik", "GENETIK"
  //    heisst "Genetik".
  const schreibweisen = new Map(); // Thema-ID -> Map<Schreibweise, Anzahl>
  // Dieselben Schlagworte stehen an Tausenden Knoten: Schluessel und Name je
  // Schreibweise einmal ausrechnen, nicht je Vorkommen.
  const tagInfo = new Map();
  for (const k of reihe) {
    for (const tag of k.tags) {
      let info = tagInfo.get(tag);
      if (!info) {
        const key = schluessel(tag);
        info = { id: key ? `thema:${key}` : null, name: schoen(tag) };
        tagInfo.set(tag, info);
      }
      if (!info.id) continue;
      const t = themen.get(info.id) || neuesThema(info.id, info.name, 'tag');
      t.mitglieder.add(k.id);
      let sw = schreibweisen.get(info.id);
      if (!sw) schreibweisen.set(info.id, (sw = new Map()));
      sw.set(info.name, (sw.get(info.name) || 0) + 1);
    }
  }
  for (const [id, sw] of schreibweisen) {
    // Gleichstand: lieber "Genetik" als "GENETIK", dann alphabetisch.
    const laut = (w) => (w.length > 1 && w === w.toUpperCase() && w !== w.toLowerCase() ? 1 : 0);
    const beste = [...sw.entries()].sort((a, b) => (b[1] - a[1]) || (laut(a[0]) - laut(b[0])) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0];
    themen.get(id).name = beste;
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
  let gedaechtnis = FARB_GEDAECHTNIS.get(store);
  if (!gedaechtnis) FARB_GEDAECHTNIS.set(store, (gedaechtnis = new Map()));
  const farben = farbenVergeben(oben, themen, gedaechtnis);

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
  //    Gezaehlt werden Paare, nicht Kanten: Wiki-Link und Schlagwort
  //    zwischen denselben zwei Notizen sind im Bild EINE Linie, und die Zahl
  //    im Kopf, in der Karte und hier soll dieselbe sein (Pruefer, Runde 1).
  //    Die Paare selbst kommen fertig aus sammeln() (sie aendern sich nur
  //    mit den Kanten), hier wird nur noch je Thema gezaehlt; die Summen
  //    haengen nicht an der Reihenfolge.
  const innere = new Map();
  const zwischen = new Map(); // kleinere Wurzel-ID -> Map<groessere, Anzahl>
  for (const { von, zu } of paare.values()) {
    const a = zugeordnet.get(von);
    const b = zugeordnet.get(zu);
    if (a && b) {
      for (const tid of a) if (b.has(tid)) innere.set(tid, (innere.get(tid) || 0) + 1);
    }
    const ra = haupt.get(von);
    const rb = haupt.get(zu);
    if (ra && rb && ra !== rb) {
      const [k1, k2] = idSort(ra, rb) < 0 ? [ra, rb] : [rb, ra];
      let m = zwischen.get(k1);
      if (!m) zwischen.set(k1, (m = new Map()));
      m.set(k2, (m.get(k2) || 0) + 1);
    }
  }
  const verbindungen = [];
  for (const [von, m] of zwischen) for (const [zu, anzahl] of m) verbindungen.push({ von, zu, anzahl });
  verbindungen.sort((a, b) => b.anzahl - a.anzahl || idSort(a.von, b.von) || idSort(a.zu, b.zu));
  verbindungen.length = Math.min(verbindungen.length, MAX_VERBINDUNGEN);

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
  const vor = (a, b) => {
    if (t.hub === a) return -1;
    if (t.hub === b) return 1;
    const ka = u.knoten.get(a);
    const kb = u.knoten.get(b);
    if (ka.pinned !== kb.pinned) return ka.pinned ? -1 : 1;
    if (ka.grad !== kb.grad) return kb.grad - ka.grad;
    return idSort(a, b);
  };
  // Nur die ersten WICHTIGSTE werden gebraucht: auslesen statt alles zu
  // sortieren ("Weitere Themen" hat im dichten Tresor Tausende Mitglieder).
  const beste = [];
  for (const id of t.mitglieder) {
    if (beste.length === WICHTIGSTE && vor(id, beste[beste.length - 1]) >= 0) continue;
    let i = beste.length;
    while (i > 0 && vor(id, beste[i - 1]) < 0) i--;
    beste.splice(i, 0, id);
    if (beste.length > WICHTIGSTE) beste.pop();
  }
  t.wichtigste = beste;
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
    // Die Art eines Begriffs (Person, Ort, Thema ...): ohne sie hiess im
    // Gehirn jede Person "Begriff" (Pruefer, Runde 1).
    kind: k.art || null,
    projectId: k.projekt || null,
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
 * Wie haeufig jede Stammform im Tresor vorkommt (in wie vielen Saetzen der
 * Universum-Arten) -- fuer die Gewichtung der Vorschlaege (view.suggestLinks
 * mit `df`): "Alles" steht in jedem zehnten Satz und verbindet nichts,
 * "Chloroplasten" in zweien und verbindet genau die.
 *
 * Einmal je Store gebaut und danach von `attach` Satz fuer Satz
 * nachgefuehrt (record.created/updated/deleted); ohne Bus-Anbindung wird bei
 * jedem Aufruf neu gezaehlt -- langsamer, nie falsch (wie der Cache oben).
 */
const DF = new WeakMap();

function dfNimm(tab, rec) {
  if (!rec || rec.deletedAt || !TYPEN.includes(rec.type)) return;
  const set = view.termSet(rec);
  const liste = [...set];
  tab.je.set(rec.id, liste);
  tab.n++;
  for (const t of liste) tab.df.set(t, (tab.df.get(t) || 0) + 1);
}

function dfWeg(tab, id) {
  const alt = tab.je.get(id);
  if (!alt) return;
  tab.je.delete(id);
  tab.n--;
  for (const t of alt) {
    const c = (tab.df.get(t) || 0) - 1;
    if (c > 0) tab.df.set(t, c);
    else tab.df.delete(t);
  }
}

function dfTabelle(store) {
  const da = DF.get(store);
  if (da && ANGEBUNDEN.has(store)) return da;
  const tab = { n: 0, df: new Map(), je: new Map() };
  for (const type of TYPEN) {
    let items = [];
    try { items = store.list(type, {}).items; } catch { continue; }
    for (const rec of items) dfNimm(tab, rec);
  }
  DF.set(store, tab);
  return tab;
}

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

  const tab = dfTabelle(store);
  const out = view.suggestLinks(store, record.id, {
    limit,
    minScore,
    types: TYPEN,
    exclude,
    df: tab.df,
    dfN: tab.n,
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
  // Verbunden wird Wissen mit Wissen -- keine Kante mit einer Kante, kein
  // Merkzettel mit einer Notiz (Pruefer, Runde 1: to:[edge_…] ging durch).
  if (!TYPEN.includes(rec.type)) {
    throw new ValidationError(`„${view.label(rec)}“ ist kein Eintrag, der sich verbinden lässt (Art ${rec.type}). Möglich: ${TYPEN.join(', ')}.`);
  }
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
  // Je Ziel ein eigener Grund (Runde 1): "Alle verbinden" mit drei
  // Vorschlaegen schrieb sonst dreimal denselben Allgemeinsatz an die Kanten.
  const gruende = opts.gruende && typeof opts.gruende === 'object' ? opts.gruende : {};
  const grundFuer = (id) => (typeof gruende[id] === 'string' && gruende[id].trim() ? gruende[id].trim().slice(0, 500) : reason);

  const vorhanden = new Set();
  try {
    for (const e of store.edges.for(quelle.id, { direction: 'out' })) vorhanden.add(`${e.data.to}\u0000${e.data.kind}`);
  } catch { /* keine Kanten */ }

  const edges = [];
  const neu = [];
  const bereits = [];
  for (const ziel of ziele) {
    const edge = store.edges.add({ from: quelle.id, to: ziel, kind, source: 'manual', reason: grundFuer(ziel), weight: 1 });
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

/** Was das Universum veraendert: seine Arten und die Kanten zwischen ihnen. */
const VERFALL_TYPEN = new Set(TYPEN);
/** Hoechstens so viele Saetze warten auf ihre Vorschlaege; aeltere fallen heraus. */
const MAX_WARTESCHLANGE = 50;
/** So viel Rechenzeit je Durchgang, dann kommt die Ereignisschleife wieder dran. */
const BUDGET_MS = 15;

/** Liegen beide Enden einer Kante im Universum? Sonst geht sie es nichts an. */
function kanteImUniversum(store, edge) {
  const d = edge && edge.data;
  if (!d) return false;
  const a = typeof d.from === 'string' ? store.get(d.from) : null;
  const b = typeof d.to === 'string' ? store.get(d.to) : null;
  return !!(a && b && TYPEN.includes(a.type) && TYPEN.includes(b.type));
}

/**
 * An den Bus haengen (Vertrag D, E, F):
 *   - record.*      -> Cache verfaellt (nur fuer Arten des Universums und
 *                      Kanten zwischen ihnen -- eine Chat-Nachricht nicht);
 *                      die Worthaeufigkeiten werden nachgefuehrt; Links, die
 *                      am Titel des Satzes haengen, werden nachgezogen
 *                      (derive.nachziehen); fuer Notizen u. ae. werden nach
 *                      einer kurzen Verzoegerung Vorschlaege gerechnet und
 *                      als 'graph.vorschlaege' {recordId, type, anzahl,
 *                      vorschlaege} geschickt -- nur, wenn es welche gibt.
 *   - edge.created  -> 'graph.kante' {edge, neu:true, von, zu}
 *   - edge.deleted  -> 'graph.kante' {edge, entfernt:true, von, zu}
 *   Gemeldet werden nur Kanten zwischen Wissen: eine Nachricht, die an ihrem
 *   Chat haengt, erschien sonst kurz als Knoten im Netz (Pruefer, Runde 1).
 *
 * Die Vorschlaege laufen ueber EINE Warteschlange mit EINEM Zeitgeber und
 * einem Zeitbudget je Durchgang. Frueher bekam jeder Satz seinen eigenen
 * Zeitgeber: 3 000 einzeln geschriebene Saetze (Abgleich, ein Agent)
 * blockierten den Server 23 s, 10 000 rund 97 s. Jetzt warten hoechstens
 * MAX_WARTESCHLANGE Saetze (die juengsten -- um die kuemmert sich gerade
 * jemand), und nach BUDGET_MS kommt die Ereignisschleife wieder dran.
 *
 * Einmal je Bus; ein zweiter Aufruf gibt dieselbe Anbindung zurueck.
 * `istAusgesetzt()` (aus app.js) haelt Vorschlaege und Nachziehen waehrend
 * eines Massenimports an -- danach leitet bulkWrite ohnehin alles neu ab.
 */
function attach({ store, bus, logger, istAusgesetzt, verzoegerungMs } = {}) {
  if (!store || !bus || typeof bus.on !== 'function' || typeof bus.publish !== 'function') {
    throw new ValidationError('attach benoetigt store und bus.');
  }
  if (store.__universum) return store.__universum;
  DF.delete(store); // eine Zaehlung von vor der Anbindung koennte schon veraltet sein
  ROH.delete(store);
  const log = logger && typeof logger.warn === 'function' ? logger : NOOP_LOGGER;
  const ausgesetzt = typeof istAusgesetzt === 'function' ? istAusgesetzt : () => false;
  const warten = {
    neu: Number.isInteger(verzoegerungMs && verzoegerungMs.neu) ? verzoegerungMs.neu : VERZOEGERUNG_NEU_MS,
    aenderung: Number.isInteger(verzoegerungMs && verzoegerungMs.aenderung) ? verzoegerungMs.aenderung : VERZOEGERUNG_AENDERUNG_MS,
  };
  /** id -> {type, faellig} in der Reihenfolge des Eintreffens (Map haelt sie). */
  const warteschlange = new Map();
  let zeitgeber = null;
  let verworfen = 0;
  let offen = true;
  const derive = require('./derive');

  const publish = (name, payload) => {
    try { bus.publish(name, payload); } catch (err) { log.warn(`bus.publish(${name}) fehlgeschlagen: ${err && err.message}`); }
  };
  const leicht = (id) => {
    const rec = typeof id === 'string' ? store.get(id) : null;
    return rec ? { id: rec.id, type: rec.type, label: view.label(rec) } : null;
  };

  const rechne = (id, type) => {
    let vorschlaege;
    try {
      if (!store.get(id)) return; // inzwischen geloescht
      vorschlaege = vorschlaegeFuer(store, id, { limit: MAX_VORSCHLAEGE });
    } catch (err) {
      log.warn(`Verbindungsvorschlaege fuer ${id} fehlgeschlagen: ${err && err.message}`);
      return;
    }
    if (!vorschlaege.length) return;
    publish('graph.vorschlaege', { recordId: id, type, anzahl: vorschlaege.length, vorschlaege });
  };

  const wecken = () => {
    if (zeitgeber || !offen || !warteschlange.size) return;
    let naechst = Infinity;
    for (const e of warteschlange.values()) if (e.faellig < naechst) naechst = e.faellig;
    zeitgeber = setTimeout(abarbeiten, Math.max(0, naechst - Date.now()));
    if (zeitgeber && typeof zeitgeber.unref === 'function') zeitgeber.unref();
  };

  function abarbeiten() {
    zeitgeber = null;
    if (!offen) return;
    if (ausgesetzt()) { warteschlange.clear(); return; }
    const start = Date.now();
    for (const [id, e] of warteschlange) {
      if (e.faellig > Date.now()) continue;
      warteschlange.delete(id);
      rechne(id, e.type);
      if (Date.now() - start >= BUDGET_MS) break;
    }
    wecken();
  }

  const planen = (record, ms) => {
    if (!offen || ausgesetzt()) return;
    // Nach hinten: wer zuletzt geschrieben wurde, kommt zuletzt dran und
    // wird zuletzt verdraengt. Schnelle Aenderungen ergeben EIN Ereignis.
    warteschlange.delete(record.id);
    while (warteschlange.size >= MAX_WARTESCHLANGE) {
      warteschlange.delete(warteschlange.keys().next().value);
      verworfen++;
    }
    warteschlange.set(record.id, { type: record.type, faellig: Date.now() + ms });
    wecken();
  };

  // Nachziehen laeuft gesammelt NACH dem laufenden Schreibvorgang (naechster
  // Durchgang der Ereignisschleife), nicht mitten darin: Wer mehrere Saetze
  // in einem Zug schreibt, legt die Kanten dazu oft selbst an -- die
  // Startinhalte (feste Kanten-IDs, src/app.js seedIfEmpty), der Abgleich
  // und POST /api/notizen/anlegen, das die neue Kante in seiner Antwort
  // nennt. Nachziehen mittendrin haette dieselbe Kante vorher mit zufaelliger
  // ID gezogen: eine Dublette, und zwei Sticks mit verschiedenen Kanten.
  // Danach findet deriveFor die Kante schon vor und aendert nichts.
  const nachziehListe = new Map(); // id -> umbenannt
  let nachziehGeplant = null;
  // Mit demselben Zeitbudget wie die Vorschlaege: 1 500 Saetze aus einem
  // Abgleich sind 1 500 Suchen -- in Portionen, damit die Ereignisschleife
  // dazwischen frei wird. Verworfen wird hier nichts (sonst blieben Links
  // unaufgeloest); die Portionen laufen einfach nacheinander.
  const nachziehenJetzt = () => {
    nachziehGeplant = null;
    if (!offen || ausgesetzt()) { nachziehListe.clear(); return; }
    const start = Date.now();
    for (const [id, umbenannt] of nachziehListe) {
      nachziehListe.delete(id);
      let rec = null;
      try { rec = store.get(id); } catch { rec = null; }
      if (rec && !rec.deletedAt) {
        try {
          derive.nachziehen(store, rec, { umbenannt });
        } catch (err) {
          log.warn(`Links nachziehen fuer ${id} fehlgeschlagen: ${err && err.message}`);
        }
      }
      if (Date.now() - start >= BUDGET_MS) break;
    }
    if (nachziehListe.size && !nachziehGeplant) {
      nachziehGeplant = setImmediate(nachziehenJetzt);
      if (typeof nachziehGeplant.unref === 'function') nachziehGeplant.unref();
    }
  };
  const nachziehen = (record, umbenannt) => {
    if (ausgesetzt()) return;
    nachziehListe.set(record.id, !!(nachziehListe.get(record.id) || umbenannt));
    if (nachziehGeplant) return;
    nachziehGeplant = setImmediate(nachziehenJetzt);
    if (nachziehGeplant && typeof nachziehGeplant.unref === 'function') nachziehGeplant.unref();
  };

  const onRecord = (evt) => {
    const p = evt && evt.payload;
    if (!p) return;
    const type = p.type || (p.record && p.record.type);
    const rec = p.record || null;
    rohNachfuehren(store, evt.name, p);
    if (type === 'edge') {
      if (rec && kanteImUniversum(store, rec)) verwerfen(store);
      return;
    }
    if (!VERFALL_TYPEN.has(type)) return;
    verwerfen(store);
    const tab = DF.get(store);
    if (tab) {
      dfWeg(tab, p.id || (rec && rec.id));
      if (evt.name !== 'record.deleted' && rec && !rec.deletedAt) dfNimm(tab, rec);
    }
    if (evt.name === 'record.deleted' || !rec || rec.deletedAt) return;
    // Links, die an diesem Titel haengen: neu angelegt, umbenannt, wiederhergestellt.
    const titelNeu = evt.name === 'record.created' || p.restored
      || (p.patch && ['title', 'name', 'aliases'].some((f) => Object.prototype.hasOwnProperty.call(p.patch, f)
        && JSON.stringify(p.patch[f]) !== JSON.stringify(p.before && p.before[f])));
    if (titelNeu) nachziehen(rec, evt.name === 'record.updated' && !p.restored);
    if (!VORSCHLAG_TYPEN.has(type)) return;
    planen(rec, evt.name === 'record.created' ? warten.neu : warten.aenderung);
  };
  const onEdgeCreated = (evt) => {
    const edge = evt && evt.payload && evt.payload.edge;
    if (!edge || !edge.data || !kanteImUniversum(store, edge)) return;
    publish('graph.kante', {
      edge, neu: true, wiederhergestellt: !!evt.payload.restored,
      von: leicht(edge.data.from), zu: leicht(edge.data.to),
    });
  };
  const onEdgeDeleted = (evt) => {
    const edge = evt && evt.payload && evt.payload.edge;
    // Beim endgueltigen Loeschen eines Knotens gehen seine Kanten ohne eigenes
    // record.deleted -- nur mit edge.deleted (cascaded).
    if (edge && evt.payload.cascaded) rohNachfuehren(store, 'edge.deleted', { id: edge.id, type: 'edge', edge });
    if (!edge || !edge.data || !kanteImUniversum(store, edge)) return;
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
  // Die Worthaeufigkeiten einmal im Hintergrund zaehlen (bei 10 000 Notizen
  // ~150 ms), damit nicht der erste Vorschlag nach dem Start darauf wartet.
  const vorzaehlen = setTimeout(() => {
    if (offen && !DF.has(store)) { try { dfTabelle(store); } catch { /* dann beim ersten Vorschlag */ } }
  }, 3000);
  if (typeof vorzaehlen.unref === 'function') vorzaehlen.unref();

  const anbindung = {
    detach() {
      if (!offen) return;
      offen = false;
      for (const [name, fn] of abos) { try { bus.off(name, fn); } catch { /* schon weg */ } }
      if (zeitgeber) clearTimeout(zeitgeber);
      clearTimeout(vorzaehlen);
      if (nachziehGeplant) clearImmediate(nachziehGeplant);
      nachziehGeplant = null;
      nachziehListe.clear();
      zeitgeber = null;
      warteschlange.clear();
      ANGEBUNDEN.delete(store);
      verwerfen(store);
      DF.delete(store);
      ROH.delete(store);
      if (store.__universum === anbindung) delete store.__universum;
    },
    /** Fuer Tests: wie viele Saetze warten noch auf ihre Vorschlaege? */
    get ausstehend() { return warteschlange.size; },
    /** Fuer Tests: wie viele wurden verdraengt, weil zu viele auf einmal kamen? */
    get verworfen() { return verworfen; },
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
  MAX_WARTESCHLANGE,
};
