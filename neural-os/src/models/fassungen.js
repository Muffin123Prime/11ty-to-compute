'use strict';

/**
 * Fassungen einer Antwort, Antwortstil und Umwandeln -- die reinen Teile
 * (docs/ANTWORT-BAUSTEINE.md, Abschnitte 3 und 4). Kein Speicher, kein Netz:
 * src/models/chat.js ruft sie auf, die Tests prüfen sie einzeln.
 *
 * Warum das Datenmodell so aussieht
 * ---------------------------------
 * Eine Antwort bleibt EIN Satz mit EINER id. Die Felder oben am Satz
 * (`content`, `denken`, `quellen`, `agenten`, `rueckfragen`, `status`,
 * `claude`, …) sind immer die AKTIVE Fassung -- so sehen Suche, Export,
 * Gehirn und jede Ansicht, die von Fassungen nichts weiß, genau das, was
 * der Nutzer gerade liest. `versionen[i]` hält die übrigen Fassungen als
 * Abbild; für die aktive stehen dort nur die Kopfdaten (inhalt, at, art …),
 * damit nichts doppelt gespeichert wird.
 *
 * Die rohen Anbieter-Blöcke (`claude.verlauf`, samt Denk-Signaturen) gehören
 * zur Fassung 0: nur sie ist damals so gesendet und empfangen worden. Eine
 * spätere Fassung geht als ihr Text in den Verlauf; ihr eigener Rohverlauf
 * wird beim Wegschalten nicht aufgehoben (er würde nie wieder gesendet).
 */

/** Felder, die zu genau einer Fassung gehören. */
const JE_FASSUNG = [
  'content', 'denken', 'quellen', 'agenten', 'rueckfragen', 'rueckfrageOffen', 'status',
  'error', 'abgeschnitten', 'stats', 'model', 'claude', 'usedNetwork', 'networkTargets',
];

/** Kopfdaten einer Fassung (das, was die Oberfläche von jeder Fassung sieht). */
const KOPF = ['inhalt', 'at', 'art', 'anweisung', 'sprache', 'auswahl', 'modell', 'status', 'nr'];

const ARTEN = new Set(['original', 'neu', 'umgewandelt', 'bearbeitet']);

/** Höchstens so viele Fassungen je Antwort -- danach fällt die älteste (außer 0) weg. */
const MAX_FASSUNGEN = 20;

function klon(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function modellId(model) {
  if (!model) return null;
  if (typeof model === 'string') return model;
  return typeof model.model === 'string' ? model.model : null;
}

/**
 * Die Fassungen einer Antwort -- auch für eine Nachricht von vor diesem Plan
 * (ohne `versionen`): dann ist sie genau eine Fassung, das Original. Nichts
 * wird dabei geschrieben (Migration beim Lesen); erst wer eine neue Fassung
 * anlegt, speichert die Liste.
 *
 * @returns {{versionen:object[], version:number}}
 */
function fassungenLesen(record) {
  const d = (record && record.data) || {};
  const liste = Array.isArray(d.versionen) ? d.versionen.filter((v) => v && typeof v === 'object') : [];
  if (!liste.length) {
    return {
      versionen: [{
        inhalt: String(d.content || ''),
        at: record && record.createdAt ? record.createdAt : new Date(0).toISOString(),
        art: 'original',
        modell: modellId(d.model),
      }],
      version: 0,
    };
  }
  let version = Number.isInteger(d.version) ? d.version : 0;
  if (version < 0 || version >= liste.length) version = liste.length - 1;
  return { versionen: klon(liste), version };
}

/** Nur die Kopfdaten einer Fassung (ohne Abbild). */
function kopf(v) {
  const out = {};
  for (const k of KOPF) if (v && v[k] !== undefined && v[k] !== null) out[k] = v[k];
  if (typeof out.inhalt !== 'string') out.inhalt = '';
  if (!ARTEN.has(out.art)) out.art = 'original';
  return out;
}

/**
 * Das Abbild der AKTIVEN Fassung aus den Feldern oben am Satz. Eine Fassung
 * nach der ersten verliert dabei ihren Rohverlauf (siehe Kopf).
 */
function abbild(d, index, alterKopf) {
  const v = { ...kopf(alterKopf || {}), inhalt: String(d.content || ''), status: d.status || 'complete' };
  const modell = modellId(d.model);
  if (modell) v.modell = modell;
  for (const k of JE_FASSUNG) {
    if (k === 'content' || d[k] === undefined) continue;
    v[`_${k}`] = klon(d[k]);
  }
  if (index > 0 && v._claude && typeof v._claude === 'object') {
    const { verlauf, offen, ...rest } = v._claude;
    void verlauf; void offen;
    v._claude = rest;
  }
  return v;
}

/** Die Felder oben am Satz für eine Fassung aus ihrem Abbild (oder leer, wenn keins da ist). */
function felderAus(v) {
  const out = { content: String((v && v.inhalt) || '') };
  const leer = {
    denken: '', quellen: [], agenten: [], rueckfragen: [], rueckfrageOffen: false,
    status: (v && v.status) || 'complete', error: null, abgeschnitten: false, stats: {},
    claude: null, usedNetwork: false, networkTargets: [],
  };
  for (const k of JE_FASSUNG) {
    if (k === 'content') continue;
    out[k] = v && v[`_${k}`] !== undefined ? klon(v[`_${k}`]) : leer[k];
  }
  if (v && v.modell && !out.model) out.model = { model: v.modell };
  if (out.model === undefined) delete out.model;
  return out;
}

/**
 * Eine neue Fassung anlegen: die aktive wird als Abbild gesichert, die neue
 * bekommt `felder` oben am Satz. Gibt den Patch für store.update zurück.
 *
 * @param {object} record  der Antwort-Satz
 * @param {object} neuKopf {art, anweisung?, sprache?, auswahl?, modell?}
 * @param {object} felder  die Felder der neuen Fassung (content, status, …)
 * @returns {{patch:object, vorige:number}}  vorige = Index der bisher aktiven danach
 */
function neueFassung(record, neuKopf, felder) {
  const d = record.data || {};
  const { versionen, version } = fassungenLesen(record);
  versionen[version] = abbild(d, version, versionen[version]);
  const kopfNeu = kopf({ ...neuKopf, inhalt: String(felder.content || ''), at: new Date().toISOString(), status: felder.status || 'complete' });
  versionen.push(kopfNeu);
  let vorige = version;
  // Zu viele: die älteste nach dem Original fällt weg (das Original trägt den
  // Rohverlauf) -- nie die, die gerade noch aktiv war.
  while (versionen.length > MAX_FASSUNGEN) {
    const weg = vorige === 1 ? 2 : 1;
    versionen.splice(weg, 1);
    if (weg < vorige) vorige--;
  }
  return { patch: { ...felder, versionen, version: versionen.length - 1 }, vorige };
}

/**
 * Auf eine andere Fassung umschalten. Gibt den Patch zurück oder null, wenn
 * sie schon aktiv ist.
 */
function fassungWaehlen(record, ziel) {
  const d = record.data || {};
  const { versionen, version } = fassungenLesen(record);
  if (!Number.isInteger(ziel) || ziel < 0 || ziel >= versionen.length) return undefined;
  if (ziel === version) return null;
  versionen[version] = abbild(d, version, versionen[version]);
  const felder = felderAus(versionen[ziel]);
  versionen[ziel] = kopf(versionen[ziel]);
  return { ...felder, versionen, version: ziel };
}

/**
 * Die zuletzt angelegte Fassung wieder entfernen und die vorige herstellen --
 * wenn ein Umwandeln scheitert oder abgebrochen wird. Eine halbe Umwandlung
 * als Fassung wäre eine, die niemand bestellt hat.
 */
function fassungZuruecknehmen(record, vorige) {
  const { versionen } = fassungenLesen(record);
  if (!Number.isInteger(vorige) || vorige < 0 || vorige >= versionen.length - 1) return null;
  versionen.pop();
  const felder = felderAus(versionen[vorige]);
  versionen[vorige] = kopf(versionen[vorige]);
  return { ...felder, versionen, version: vorige };
}

/** Die Kopfdaten der aktiven Fassung an `content`/`status` angleichen (nach einem Zug). */
function kopfAngleichen(record, patch) {
  const d = { ...(record.data || {}), ...patch };
  if (!Array.isArray(d.versionen) || !d.versionen.length) return patch;
  const { versionen, version } = fassungenLesen({ ...record, data: d });
  versionen[version] = kopf({
    ...versionen[version],
    inhalt: String(d.content || ''),
    status: d.status || versionen[version].status,
    modell: modellId(d.model) || versionen[version].modell,
  });
  return { ...patch, versionen };
}

/**
 * Was die Oberfläche von den Fassungen sieht: nur Kopfdaten, die aktive mit
 * dem Text, der gerade oben steht. Die Abbilder (mit Rohverlauf) bleiben im
 * Tresor.
 */
function fuerOberflaeche(record) {
  const d = (record && record.data) || {};
  if (d.role !== 'assistant') return null;
  // Ohne tiefe Kopie: die Abbilder (mit Rohverlauf) können groß sein, und
  // GET …/messages liest bis zu 5000 Nachrichten. `kopf` nimmt nur Einfaches.
  const roh = Array.isArray(d.versionen) ? d.versionen.filter((v) => v && typeof v === 'object') : [];
  const { versionen, version } = roh.length
    ? { versionen: roh, version: Number.isInteger(d.version) && d.version >= 0 && d.version < roh.length ? d.version : roh.length - 1 }
    : fassungenLesen(record);
  const liste = versionen.map((v, i) => {
    const k = kopf(v);
    // Jede andere Fassung bringt ihre Quellen mit (nur Titel und Adresse):
    // "[1]" in ihrem Text zeigt auf IHRE Quelle 1.
    if (i !== version && Array.isArray(v._quellen) && v._quellen.length) k.quellen = v._quellen.map(quelleKurz).filter(Boolean);
    return k;
  });
  liste[version] = { ...liste[version], inhalt: String(d.content || ''), status: d.status || liste[version].status };
  return { versionen: liste, version };
}

function quelleKurz(q) {
  if (!q || typeof q !== 'object' || typeof q.url !== 'string') return null;
  const out = { titel: String(q.titel || q.url), url: q.url };
  for (const k of ['art', 'id', 'typ']) if (typeof q[k] === 'string' && q[k]) out[k] = q[k];
  return out;
}

/** Was im Text als Verweis auf eine Quelle gilt: "[1]" bis "[99]" -- kein Link "[1](…)". */
const VERWEIS = /\[\d{1,2}\](?!\()/g;
/** Code im Fliesstext (`a[1]`) bleibt, wie er ist. */
const INLINE_CODE = /(`+)[^`]*?\1/g;

/**
 * Der Text ohne die Nummern der Quellen ("[1]"), ausserhalb von Code. Fuer
 * alles, was als Text an die KI geht: sie soll keine Nummern nachahmen, zu
 * denen es keine Quelle gibt. (Umwandeln behaelt sie -- dort bleiben auch
 * die Quellen.) `anzahl`: wie viele Quellen die Antwort hat -- nur "[1]" bis
 * "[anzahl]" sind Verweise; ein "Schritt [2]" in einer Antwort ohne Quellen
 * bleibt stehen.
 */
function ohneVerweise(text, anzahl) {
  const s = String(text || '');
  const n = Number(anzahl);
  if (!(n > 0) || !/\[\d{1,2}\]/.test(s)) return s;
  const weg = (t) => t.replace(VERWEIS, (m) => {
    const nr = Number(m.slice(1, -1));
    return nr >= 1 && nr <= n ? '' : m;
  });
  const draussen = (t) => {
    let out = '';
    let pos = 0;
    for (const m of t.matchAll(INLINE_CODE)) {
      out += weg(t.slice(pos, m.index));
      out += m[0];
      pos = m.index + m[0].length;
    }
    return out + weg(t.slice(pos));
  };
  let out = '';
  let pos = 0;
  for (const b of codebloecke(s)) {
    out += draussen(s.slice(pos, b.start));
    out += s.slice(b.start, b.ende);
    pos = b.ende;
  }
  return out + draussen(s.slice(pos));
}

/* ------------------------------------------------------------ Antwortstil */

const STIL_REGLER = [
  ['laenge', 'Länge', ['sehr kurz', 'eher kurz', 'mittel', 'eher ausführlich', 'sehr ausführlich']],
  ['fachlich', 'Fachbegriffe', ['ganz einfach', 'eher einfach', 'ausgewogen', 'eher fachlich', 'sehr fachlich']],
  ['kreativ', 'Kreativität', ['sehr sachlich', 'eher sachlich', 'ausgewogen', 'eher kreativ', 'sehr kreativ']],
];

/**
 * Den Antwortstil prüfen: {laenge, fachlich, kreativ} je 0-100 (gerundet),
 * fehlende Regler 50. `null` heißt: kein Stil (zurücksetzen).
 * @returns {object|null}
 * @throws {Error} mit `.satz` bei ungültiger Eingabe
 */
function stilPruefen(roh) {
  if (roh === null) return null;
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) {
    const e = new Error('Der Antwortstil muss ein Objekt {laenge, fachlich, kreativ} mit Werten von 0 bis 100 sein.');
    e.satz = e.message;
    throw e;
  }
  const out = {};
  let irgendeiner = false;
  for (const [k] of STIL_REGLER) {
    if (roh[k] === undefined || roh[k] === null) { out[k] = 50; continue; }
    const n = Number(roh[k]);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      const e = new Error(`„${k}“ im Antwortstil muss eine Zahl von 0 bis 100 sein.`);
      e.satz = e.message;
      throw e;
    }
    out[k] = Math.round(n);
    irgendeiner = true;
  }
  if (!irgendeiner) {
    const e = new Error('Im Antwortstil fehlt ein Wert (laenge, fachlich oder kreativ).');
    e.satz = e.message;
    throw e;
  }
  return out;
}

/**
 * Der Satz für die Nutzernachricht, z. B.
 * `[Antwortstil: Länge 30/100 (eher kurz), Fachbegriffe 70/100 (eher fachlich), Kreativität 50/100 (ausgewogen)]`.
 * Ohne Stil: null (dann steht nichts in der Nachricht).
 */
function stilSatz(stil) {
  if (!stil || typeof stil !== 'object') return null;
  const teile = STIL_REGLER.map(([k, name, stufen]) => {
    const n = Number.isFinite(Number(stil[k])) ? Math.max(0, Math.min(100, Math.round(Number(stil[k])))) : 50;
    const stufe = stufen[Math.min(4, Math.floor(n / 20.0001))];
    return `${name} ${n}/100 (${stufe})`;
  });
  return `[Antwortstil: ${teile.join(', ')}]`;
}

const STIL_PRAEFIX = '[Antwortstil:';

/* -------------------------------------------------------- Neu erstellen */

/** Varianten von "Neu erstellen" (docs 4) und die Anweisung für diesen einen Aufruf. */
const VARIANTEN = {
  kuerzer: 'Antworte diesmal deutlich kürzer als in der bisherigen Antwort.',
  einfacher: 'Antworte diesmal einfacher: kurze Sätze, keine Fachbegriffe (oder erkläre sie kurz).',
  detaillierter: 'Antworte diesmal ausführlicher und genauer als in der bisherigen Antwort, mit Beispielen, wo sie helfen.',
  kreativer: 'Antworte diesmal kreativer und lebendiger als in der bisherigen Antwort.',
  anders: 'Formuliere die Antwort diesmal ganz anders als die bisherige – anderer Aufbau, andere Worte.',
  stil: null, // der Antwortstil steht ohnehin in der Nachricht
};

/* -------------------------------------------------------------- Umwandeln */

/** Anweisungen für Umwandeln (docs 4); `stelle` ist die Fassung für eine markierte Stelle. */
const ANWEISUNGEN = {
  verbessern: {
    ganz: 'Verbessere die Antwort: klarer, genauer, besser gegliedert. Aussagen und Inhalt bleiben.',
    stelle: 'Verbessere die markierte Stelle: klarer und genauer, gleicher Inhalt.',
  },
  kuerzen: {
    ganz: 'Kürze die Antwort auf das Wesentliche, etwa auf die Hälfte.',
    stelle: 'Kürze die markierte Stelle auf das Wesentliche.',
  },
  umschreiben: {
    ganz: 'Formuliere die Antwort neu, mit gleichem Inhalt.',
    stelle: 'Formuliere die markierte Stelle neu, mit gleichem Inhalt.',
  },
  einfach: {
    ganz: 'Erkläre dasselbe einfacher: kurze Sätze, keine Fachbegriffe (oder erkläre sie kurz).',
    stelle: 'Schreib die markierte Stelle einfacher: kurze Sätze, keine Fachbegriffe.',
  },
  zusammenfassen: {
    ganz: 'Fasse die Antwort in wenigen Sätzen zusammen.',
    stelle: 'Fasse die markierte Stelle in einem Satz zusammen.',
  },
  uebersetzen: {
    ganz: 'Übersetze die Antwort ins {sprache}. Code, Namen, Adressen und die JSON-Schlüssel in ```ui-Blöcken bleiben unverändert; übersetze nur die Texte.',
    stelle: 'Übersetze die markierte Stelle ins {sprache}.',
  },
  tabelle: { ganz: 'Stelle denselben Inhalt als Markdown-Tabelle dar; davor höchstens ein kurzer Satz.' },
  diagramm: { ganz: 'Stelle die Zahlen der Antwort als Baustein diagramm (```ui) dar. Gibt es keine Zahlen, sag das in einem Satz und lass den Rest wie er ist.' },
  checkliste: { ganz: 'Mach aus der Antwort einen Baustein checkliste (```ui) mit Punkten zum Abhaken.' },
  schritte: { ganz: 'Mach aus der Antwort eine Anleitung Schritt für Schritt als Baustein schritte (```ui).' },
  wichtigste: { ganz: 'Nur die wichtigsten Punkte, als kurze Liste.' },
  nurtext: { ganz: 'Nur Text: ohne Bausteine (```ui), ohne Tabellen und Überschriften, als gut lesbarer Fließtext mit demselben Inhalt.' },
  knoepfe: { ganz: 'Mach aus Fragen und Angeboten in der Antwort antippbare Knöpfe: Baustein aktionen (oder auswahl, wenn der Nutzer wählen soll). Der übrige Text bleibt.' },
  kuerzer: { ganz: 'Schreib die Antwort deutlich kürzer.' },
  einfacher: { ganz: 'Schreib die Antwort einfacher: kurze Sätze, keine Fachbegriffe.' },
  detaillierter: { ganz: 'Schreib die Antwort ausführlicher und genauer, mit Beispielen, wo sie helfen.' },
  kreativer: { ganz: 'Formuliere die Antwort kreativer und lebendiger, gleicher Inhalt.' },
  anders: { ganz: 'Formuliere die Antwort ganz anders – anderer Aufbau, andere Worte, gleicher Inhalt.' },
};

/**
 * Die Anweisung als Satz für die KI.
 * @returns {{schluessel:string|null, satz:string}}
 * @throws {Error} mit `.satz`
 */
function anweisungSatz(anweisung, { sprache, stelle = false } = {}) {
  const fehler = (satz) => { const e = new Error(satz); e.satz = satz; return e; };
  if (typeof anweisung !== 'string' || !anweisung.trim()) throw fehler('Was soll ich mit der Antwort tun? Es fehlt die Anweisung.');
  const a = anweisung.trim();
  const eintrag = ANWEISUNGEN[a];
  if (eintrag) {
    const vorlage = stelle ? eintrag.stelle : eintrag.ganz;
    if (!vorlage) throw fehler(`„${a}“ geht nur für die ganze Antwort, nicht für eine markierte Stelle.`);
    if (a === 'uebersetzen') {
      const s = typeof sprache === 'string' ? sprache.trim() : '';
      if (!s || s.length > 40 || !/^[\p{L} ()-]+$/u.test(s)) throw fehler('In welche Sprache soll ich übersetzen? Bitte eine Sprache nennen (z. B. „Englische“).');
      return { schluessel: a, satz: vorlage.replace('{sprache}', s) };
    }
    return { schluessel: a, satz: vorlage };
  }
  if (a.length < 2) throw fehler('Die Anweisung ist zu kurz.');
  if (a.length > 2000) throw fehler('Die Anweisung ist zu lang (höchstens 2000 Zeichen).');
  return { schluessel: null, satz: stelle ? `Ändere die markierte Stelle so: ${a}` : `Ändere die Antwort so: ${a}` };
}

/**
 * Was ein Modell um den eigentlichen Text herum schreibt, wenn man es
 * lässt: die Markierungen aus der Vorlage, ein ```markdown-Zaun um alles.
 */
function antwortSaeubern(text) {
  let t = String(text || '').trim();
  t = t.replace(/^<<<\s*\n?/, '').replace(/\n?\s*>>>$/, '').trim();
  const zaun = /^```(?:markdown|md)?[ \t]*\n([\s\S]*)\n```$/i.exec(t);
  if (zaun && !/^```/m.test(zaun[1])) t = zaun[1].trim();
  return t;
}

/* ------------------------------------------------------ Codeblöcke finden */

const ZAUN_AUF = /^([ \t>]*?(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?)( {0,3})(`{3,}|~{3,})[ \t]*([^`\n]*)$/;

/**
 * Die Codeblöcke (```/~~~) einer Antwort in der Reihenfolge, in der sie im
 * Text stehen -- auch ```ui, auch eingerückt in Listen oder Zitaten. Die
 * Nummer ist die, die `PATCH …/block {nr}` meint.
 *
 * @returns {Array<{nr, lang, info, start, ende, inhaltStart, inhaltEnde, code, closed, praefix}>}
 *   start/ende: die Zaunzeilen samt Inhalt (Zeichenpositionen), inhaltStart/
 *   inhaltEnde: nur der Inhalt.
 */
function codebloecke(text) {
  const s = String(text || '');
  const zeilen = [];
  let pos = 0;
  for (const z of s.split('\n')) {
    zeilen.push({ z, start: pos, ende: pos + z.length });
    pos += z.length + 1;
  }
  const out = [];
  for (let i = 0; i < zeilen.length; i++) {
    const m = ZAUN_AUF.exec(zeilen[i].z);
    if (!m) continue;
    // Einrückung und Zitatzeichen vor dem Zaun gelten für jede Zeile des
    // Blocks (so zieht der Renderer sie auch ab: web/lib/markdown.js).
    const praefix = m[1] + m[2];
    const zaun = m[3];
    const info = m[4].trim();
    const ohnePraefix = (zeile) => {
      // Die Präfix-Zeichen (Einrückung, "> ") der Öffnung abziehen, soweit die Zeile sie hat.
      const blank = praefix.replace(/[-*+]|\d{1,9}[.)]/g, (x) => ' '.repeat(x.length));
      if (zeile.startsWith(praefix)) return zeile.slice(praefix.length);
      if (zeile.startsWith(blank)) return zeile.slice(blank.length);
      return zeile.replace(/^[ \t>]*/, '');
    };
    let j = i + 1;
    let closed = false;
    for (; j < zeilen.length; j++) {
      const rest = ohnePraefix(zeilen[j].z);
      const e = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(rest);
      if (e && e[1][0] === zaun[0] && e[1].length >= zaun.length) { closed = true; break; }
    }
    const inhaltZeilen = zeilen.slice(i + 1, j);
    const inhaltStart = inhaltZeilen.length ? inhaltZeilen[0].start : zeilen[i].ende + 1;
    const inhaltEnde = inhaltZeilen.length ? inhaltZeilen[inhaltZeilen.length - 1].ende : inhaltStart;
    out.push({
      nr: out.length,
      lang: (info.split(/\s+/)[0] || '').toLowerCase(),
      info,
      praefix,
      start: zeilen[i].start,
      ende: closed ? zeilen[j].ende : s.length,
      inhaltStart: Math.min(inhaltStart, s.length),
      inhaltEnde: Math.min(inhaltEnde, s.length),
      code: inhaltZeilen.map((x) => ohnePraefix(x.z)).join('\n'),
      closed,
    });
    i = closed ? j : zeilen.length;
  }
  return out;
}

/**
 * Einen Codeblock ersetzen. Für ```ui-Bausteine `datei` und `vorschau`
 * wird nur das Feld `inhalt` im JSON ersetzt; andere Bausteine sind keine
 * Texte zum Bearbeiten.
 *
 * @returns {{text:string, block:object}}
 * @throws {Error} mit `.code` und `.satz`
 */
function blockErsetzen(text, nr, inhalt, alt) {
  const fehler = (code, satz) => { const e = new Error(satz); e.code = code; e.satz = satz; return e; };
  const bloecke = codebloecke(text);
  let block = bloecke[nr];
  if (typeof alt === 'string') {
    const gleich = (b) => b && (b.code === alt || b.code.trim() === alt.trim());
    if (!gleich(block)) {
      const treffer = bloecke.filter(gleich);
      if (treffer.length !== 1) throw fehler('BLOCK_NICHT_GEFUNDEN', 'Diesen Block gibt es in der aktiven Fassung so nicht mehr.');
      block = treffer[0];
    }
  }
  if (!block) throw fehler('BLOCK_NICHT_GEFUNDEN', `Block ${nr} gibt es in der aktiven Fassung nicht (sie hat ${bloecke.length}).`);
  if (!block.closed) throw fehler('BLOCK_UNVOLLSTAENDIG', 'Dieser Block ist noch nicht fertig geschrieben.');
  let neu = String(inhalt);
  if (block.lang === 'ui') {
    let obj;
    try { obj = JSON.parse(block.code); } catch { obj = null; }
    if (!obj || typeof obj !== 'object' || !['datei', 'vorschau'].includes(obj.typ)) {
      throw fehler('BLOCK_NICHT_BEARBEITBAR', 'Nur Code, Texte, Dateien und Vorschauen lassen sich bearbeiten.');
    }
    obj.inhalt = neu;
    neu = block.code.includes('\n') ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);
  }
  // Der Inhalt bekommt das Präfix der Öffnung zurück (Einrückung in Listen, "> " in Zitaten).
  const einzug = block.praefix.replace(/[-*+]|\d{1,9}[.)]/g, (x) => ' '.repeat(x.length));
  const zeilen = neu.replace(/\r\n?/g, '\n').split('\n').map((z) => (einzug && z ? `${einzug}${z}` : z));
  const inhaltNeu = zeilen.join('\n');
  const vorher = text.slice(0, block.inhaltStart);
  const nachher = text.slice(block.inhaltEnde);
  const leer = block.inhaltStart === block.inhaltEnde && vorher.endsWith('\n') && !text.slice(block.inhaltStart).startsWith('\n');
  const ergebnis = leer ? `${vorher}${inhaltNeu}\n${nachher}` : `${vorher}${inhaltNeu}${nachher}`;
  return { text: ergebnis, block };
}

/* ---------------------------------------------------- markierte Stelle */

const AUSZEICHNUNG = new Set(['*', '_', '`', '~', '#', '>', '|', '<', '[', ']', '\\']);
const RAND = new Set(['*', '_', '`', '~']);

/**
 * Text so vergleichbar machen, wie ihn der Browser beim Markieren liefert:
 * Markdown-Zeichen raus, Listen- und Überschriftszeichen am Zeilenanfang
 * raus, Linkziele raus, Leerraum zusammengefasst. `karte[i]` ist die Stelle
 * im Original, von der das i-te Zeichen stammt.
 */
function vergleichbar(text, { zeilenanfang = true } = {}) {
  const s = String(text || '').normalize('NFC');
  const zeichen = [];
  const karte = [];
  let leer = true;
  const zaeune = zeilenanfang ? codebloecke(s) : [];
  const inZaunzeile = (i) => zaeune.some((b) => (i >= b.start && i < b.inhaltStart) || (b.closed && i > b.inhaltEnde && i < b.ende));
  const inCode = (i) => zaeune.some((b) => i >= b.inhaltStart && i < b.inhaltEnde);
  let i = 0;
  let zeilenStart = true;
  while (i < s.length) {
    if (zeilenanfang && zeilenStart) {
      zeilenStart = false;
      if (inZaunzeile(i)) {
        const nl = s.indexOf('\n', i);
        i = nl < 0 ? s.length : nl;
        continue;
      }
      if (!inCode(i)) {
        const rest = s.slice(i);
        const tabelle = /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*(?=\n|$)/.exec(rest);
        if (tabelle && /-/.test(tabelle[0]) && /\|/.test(tabelle[0])) { i += tabelle[0].length; continue; }
        const m = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:\[![A-Za-z][\w-]{0,30}\][+-]?[ \t]*|#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/.exec(rest);
        if (m && m[0].length) { i += m[0].length; continue; }
      }
    }
    const c = s[i];
    if (c === '\n') { zeilenStart = true; }
    if (c === ']' && s[i + 1] === '(') {
      const zu = s.indexOf(')', i + 2);
      if (zu > 0 && !s.slice(i + 2, zu).includes('\n')) { i = zu + 1; continue; }
    }
    if (/\s/.test(c)) {
      if (!leer) { zeichen.push(' '); karte.push(i); leer = true; }
      i++;
      continue;
    }
    if (AUSZEICHNUNG.has(c)) { i++; continue; }
    zeichen.push(c);
    karte.push(i);
    leer = false;
    i++;
  }
  while (zeichen.length && zeichen[zeichen.length - 1] === ' ') { zeichen.pop(); karte.pop(); }
  return { text: zeichen.join(''), karte };
}

/**
 * Die markierte Stelle in der aktiven Fassung finden (docs 4: Leerraum und
 * Markdown-Zeichen großzügig). Eindeutig oder gar nicht: kommt sie mehrmals
 * vor, entscheidet `vorkommen` (0 = das erste), sonst wird abgelehnt.
 *
 * @returns {{start:number, ende:number, stelle:string}}
 * @throws {Error} mit `.code = 'AUSWAHL_NICHT_GEFUNDEN'` und `.satz`
 */
function stelleFinden(text, auswahl, vorkommen) {
  const fehler = (satz, details) => { const e = new Error(satz); e.code = 'AUSWAHL_NICHT_GEFUNDEN'; e.satz = satz; e.details = details; return e; };
  const s = String(text || '');
  const gesucht = vergleichbar(auswahl, { zeilenanfang: false }).text.trim();
  if (gesucht.replace(/\s/g, '').length < 2) throw fehler('Die Markierung ist zu kurz.');
  const { text: flach, karte } = vergleichbar(s);
  const treffer = [];
  for (let p = flach.indexOf(gesucht); p >= 0; p = flach.indexOf(gesucht, p + 1)) treffer.push(p);
  if (!treffer.length) throw fehler('Die markierte Stelle habe ich in der Antwort nicht wiedergefunden.', { treffer: 0 });
  let p;
  if (treffer.length === 1) p = treffer[0];
  else if (Number.isInteger(vorkommen) && vorkommen >= 0 && vorkommen < treffer.length) p = treffer[vorkommen];
  else throw fehler(`Die markierte Stelle kommt ${treffer.length}-mal vor; ich weiß nicht, welche gemeint ist.`, { treffer: treffer.length });
  let start = karte[p];
  let ende = karte[p + gesucht.length - 1] + 1;
  // Auszeichnung am Rand gehört dazu (**fett** bleibt ganz), ebenso ein Linkziel.
  while (start > 0 && RAND.has(s[start - 1])) start--;
  if (start > 0 && s[start - 1] === '[') start--;
  while (ende < s.length && RAND.has(s[ende])) ende++;
  if (s[ende] === ']' && s[ende + 1] === '(') {
    const zu = s.indexOf(')', ende + 2);
    if (zu > 0) ende = zu + 1;
  } else if (s[ende] === ']' && /\[\d{1,2}$/.test(s.slice(Math.max(0, ende - 3), ende))) {
    // Endet die Markierung an einer Quellen-Nummer ("…Freitag.[1"), gehoert
    // ihre Klammer dazu -- sonst bliebe nach dem Umschreiben ein "]" stehen.
    ende++;
  }
  // Nie halb in einen Codeblock hinein: sonst zerbricht der Zaun.
  for (const b of codebloecke(s)) {
    const drin = start >= b.inhaltStart && ende <= b.inhaltEnde;
    const draussen = ende <= b.start || start >= b.ende;
    if (!drin && !draussen) {
      throw fehler('Die Markierung reicht in einen Codeblock oder Baustein hinein. Markiere nur Text – oder nur Code.', { block: b.nr });
    }
  }
  return { start, ende, stelle: s.slice(start, ende) };
}

module.exports = {
  JE_FASSUNG,
  MAX_FASSUNGEN,
  VARIANTEN,
  ANWEISUNGEN,
  STIL_PRAEFIX,
  fassungenLesen,
  neueFassung,
  fassungWaehlen,
  fassungZuruecknehmen,
  kopfAngleichen,
  fuerOberflaeche,
  stilPruefen,
  stilSatz,
  anweisungSatz,
  antwortSaeubern,
  codebloecke,
  blockErsetzen,
  vergleichbar,
  stelleFinden,
  ohneVerweise,
};
