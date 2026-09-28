'use strict';

/**
 * Anhänge im Chat: Bilder und PDF (docs/ANTWORT-BAUSTEINE.md 6) und die
 * Sprachaufnahme fürs Umschreiben in Text.
 *
 * Warum so
 * --------
 * - **Im Nachrichtensatz steht nur die Kennung**, nie Base64. Ein Satz im
 *   Speicher hat ein Segment von 8 MB, und der Verlauf wird an seiner
 *   JSON-Länge gekürzt -- ein 5-MB-Bild im Satz würde alte Züge verdrängen.
 *   Die Datei liegt als `file`-Satz mit Blob in der Ablage (verschlüsselt wie
 *   jede andere Datei, wenn der Tresor es ist) und wird erst beim Bauen der
 *   Anfrage gelesen.
 * - **Die Art wird am Inhalt erkannt**, nicht am Namen oder an dem, was der
 *   Browser behauptet: eine umbenannte .exe wird kein "Bild".
 * - **Nicht alles geht jedes Mal mit.** Höchstens die letzten 6 Anhänge und
 *   ein Größenbudget je Anbieter (Claude: 32 MB je Anfrage; Gemini: 20 MB
 *   für die ganze Anfrage mit Inline-Daten). Ältere stehen als Text
 *   "[Bild: name]" im Verlauf -- die KI weiß, dass es sie gab.
 * - **GIF kann Gemini nicht lesen** (unterstützt: PNG, JPEG, WEBP, HEIC,
 *   HEIF). Dann steht das in einem Satz, statt still zu fehlen.
 */

/** Bildarten, die der Chat annimmt (beide Anbieter lesen sie, Gemini ohne GIF). */
const BILD_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const PDF_MIME = 'application/pdf';
const MAX_BILD_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** Je Nachricht. */
const MAX_ANHAENGE_JE_NACHRICHT = 10;
/** Je Anfrage an die KI (die jüngsten zuerst). */
const MAX_ANHAENGE_JE_ANFRAGE = 6;
/**
 * Base64-Budget je Anfrage. Claude nimmt 32 MB je Anfrage, Gemini 20 MB für
 * alles (Text, Systemtext, Inline-Daten). Luft für den Rest des Verlaufs.
 */
const BUDGET = Object.freeze({ claude: 24 * 1024 * 1024, gemini: 18 * 1024 * 1024 });
/**
 * Was eine ganze Anfrage höchstens wiegen darf (Claude: 32 MB je Anfrage;
 * Gemini: 20 MB samt Text) -- mit etwas Abstand. Ein sehr langer Verlauf
 * lässt entsprechend weniger Platz für Bilder.
 */
const GRENZE = Object.freeze({ claude: 30 * 1024 * 1024, gemini: 19 * 1024 * 1024 });
const GEMINI_BILD = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Sprachaufnahme fürs Umschreiben. */
const MAX_AUDIO_SEKUNDEN = 60;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

const MIME_ALIAS = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'application/x-pdf': PDF_MIME };

function fehler(satz, code = 'VALIDATION_ERROR', status = 400) {
  const e = new Error(satz);
  e.code = code;
  e.satz = satz;
  e.status = status;
  return e;
}

/** Die Art am Inhalt erkennen (die ersten Bytes). */
function artErkennen(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  if (buf[0] === 0x89 && buf.slice(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const kopf6 = buf.slice(0, 6).toString('latin1');
  if (kopf6 === 'GIF87a' || kopf6 === 'GIF89a') return 'image/gif';
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return PDF_MIME;
  return null;
}

/** Base64 (auch als data:-Adresse) in Bytes -- streng: was kein Base64 ist, wird abgelehnt. */
function base64Lesen(roh, feld = 'daten') {
  if (typeof roh !== 'string' || !roh.length) throw fehler(`"${feld}" fehlt.`);
  const b64 = roh.replace(/^data:[^,]{0,200},/, '').replace(/\s+/g, '');
  if (!b64.length || b64.length % 4 === 1 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) {
    throw fehler(`"${feld}" ist kein gültiges Base64.`);
  }
  return Buffer.from(b64, 'base64');
}

/** Der Dateiname für Anzeige und Kopfzeilen: ohne Pfad, ohne Steuerzeichen. */
function nameSaeubern(roh) {
  const n = String(roh || '').replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 200);
  return n || 'anhang';
}

/**
 * Einen hochgeladenen Anhang prüfen.
 * @returns {{buf:Buffer, mime:string, name:string, art:'bild'|'pdf'}}
 */
function anhangPruefen({ name, mime, daten }) {
  const angegeben = String(mime || '').toLowerCase().trim();
  const gewuenscht = MIME_ALIAS[angegeben] || angegeben;
  if (!BILD_MIME.has(gewuenscht) && gewuenscht !== PDF_MIME) {
    throw fehler(`„${angegeben || 'unbekannt'}“ nimmt der Chat nicht an. Möglich: PNG, JPG, WEBP, GIF und PDF.`, 'ANHANG_ART');
  }
  const buf = base64Lesen(daten);
  if (!buf.length) throw fehler('Die Datei ist leer.');
  const erkannt = artErkennen(buf);
  if (!erkannt) throw fehler('Der Inhalt ist weder ein Bild (PNG, JPG, WEBP, GIF) noch ein PDF.', 'ANHANG_ART');
  if (erkannt !== gewuenscht) {
    throw fehler(`Die Datei heißt ${gewuenscht}, ist aber ${erkannt}.`, 'ANHANG_ART');
  }
  const art = erkannt === PDF_MIME ? 'pdf' : 'bild';
  const grenze = art === 'pdf' ? MAX_PDF_BYTES : MAX_BILD_BYTES;
  if (buf.length > grenze) {
    const mb = (n) => (n / (1024 * 1024)).toLocaleString('de-DE', { maximumFractionDigits: 1 });
    throw fehler(`${art === 'pdf' ? 'Das PDF' : 'Das Bild'} ist zu groß (${mb(buf.length)} MB, erlaubt sind ${mb(grenze)} MB).`, 'ANHANG_ZU_GROSS', 413);
  }
  return { buf, mime: erkannt, name: nameSaeubern(name), art };
}

/** Wie ein Anhang im Verlauf als Text heißt, wenn er nicht (mehr) mitgeht. */
function etikett(a, grund) {
  const was = a.mime === PDF_MIME ? 'PDF' : 'Bild';
  return `[${was}: ${a.name || 'anhang'}${grund ? ` – ${grund}` : ''}]`;
}

/**
 * Die Platzhalter `{type:'anhang', id, name, mime}` in den Nachrichten
 * auflösen -- für GENAU diese Anfrage (Kopie). Die jüngsten gehen als echte
 * Blöcke mit (Claude-Form: image/document mit base64; der Gemini-Anbieter
 * übersetzt sie in inlineData), ältere und zu große als Text.
 *
 * @param {Array} nachrichten   Verlauf in Claudes Blockform
 * @param {object} opts
 * @param {string} opts.anbieter  'claude' | 'gemini'
 * @param {(id:string)=>({buf:Buffer,mime:string,name:string}|null)} opts.lesen
 * @param {Map} [opts.cache]      id -> base64 (für die Runden eines Zuges)
 * @param {number} [opts.reserve]  was der Rest der Anfrage schon wiegt (Zeichen)
 * @returns {{nachrichten:Array, mit:number, ohne:number}}
 */
function aufloesen(nachrichten, { anbieter, lesen, cache, reserve = 0 }) {
  const liste = Array.isArray(nachrichten) ? nachrichten : [];
  const stellen = [];
  liste.forEach((n, i) => {
    if (!n || n.role !== 'user' || !Array.isArray(n.content)) return;
    n.content.forEach((b, j) => { if (b && b.type === 'anhang') stellen.push([i, j]); });
  });
  if (!stellen.length) return { nachrichten: liste, mit: 0, ohne: 0 };
  const art = BUDGET[anbieter] ? anbieter : 'claude';
  const budget = Math.max(0, Math.min(BUDGET[art], GRENZE[art] - (Number(reserve) || 0)));
  const merk = cache instanceof Map ? cache : new Map();
  const ersatz = new Map(); // "i:j" -> Blöcke
  let genutzt = 0;
  let anzahl = 0;
  let mit = 0;
  let ohne = 0;
  // Von der jüngsten zur ältesten: die neuesten Bilder zählen.
  for (let k = stellen.length - 1; k >= 0; k--) {
    const [i, j] = stellen[k];
    const a = liste[i].content[j];
    const schluessel = `${i}:${j}`;
    const alsText = (grund) => { ersatz.set(schluessel, [{ type: 'text', text: etikett(a, grund) }]); ohne++; };
    if (anzahl >= MAX_ANHAENGE_JE_ANFRAGE) { alsText(''); continue; }
    if (anbieter === 'gemini' && a.mime !== PDF_MIME && !GEMINI_BILD.has(a.mime)) {
      alsText('dieses Format kann Gemini nicht lesen');
      continue;
    }
    let b64 = merk.get(a.id);
    if (b64 === undefined) {
      let datei = null;
      try { datei = lesen(a.id); } catch { datei = null; }
      b64 = datei && Buffer.isBuffer(datei.buf) ? datei.buf.toString('base64') : null;
      merk.set(a.id, b64);
    }
    if (!b64) { alsText('nicht mehr vorhanden'); continue; }
    if (genutzt + b64.length > budget) { alsText('zu groß, um es noch einmal mitzuschicken'); continue; }
    genutzt += b64.length;
    anzahl++;
    mit++;
    const quelle = { type: 'base64', media_type: a.mime, data: b64 };
    const block = a.mime === PDF_MIME
      ? { type: 'document', source: quelle, title: String(a.name || 'Dokument').slice(0, 200) }
      : { type: 'image', source: quelle };
    ersatz.set(schluessel, [{ type: 'text', text: etikett(a, '') }, block]);
  }
  const out = liste.map((n, i) => {
    if (!n || n.role !== 'user' || !Array.isArray(n.content) || !n.content.some((b) => b && b.type === 'anhang')) return n;
    const content = [];
    n.content.forEach((b, j) => {
      if (b && b.type === 'anhang') content.push(...(ersatz.get(`${i}:${j}`) || [{ type: 'text', text: etikett(b, '') }]));
      else content.push(b);
    });
    return { ...n, content };
  });
  return { nachrichten: out, mit, ohne };
}

/* ------------------------------------------------------------- Audio */

/**
 * Eine WAV-Aufnahme prüfen und ihre Dauer ausrechnen (aus dem fmt- und dem
 * data-Abschnitt, nicht aus der Dateigröße: ein Kopf mit Zusatzabschnitten
 * würde sonst falsch rechnen).
 * @returns {{buf:Buffer, sekunden:number}}
 */
function wavPruefen(roh) {
  const buf = base64Lesen(roh, 'audio');
  if (buf.length > MAX_AUDIO_BYTES) throw fehler('Die Aufnahme ist zu groß.', 'AUDIO_ZU_LANG', 413);
  if (buf.length < 44 || buf.slice(0, 4).toString('latin1') !== 'RIFF' || buf.slice(8, 12).toString('latin1') !== 'WAVE') {
    throw fehler('Die Aufnahme ist kein WAV.', 'AUDIO_UNGUELTIG');
  }
  let pos = 12;
  let byteRate = 0;
  let datenBytes = null;
  while (pos + 8 <= buf.length) {
    const id = buf.slice(pos, pos + 4).toString('latin1');
    const groesse = buf.readUInt32LE(pos + 4);
    const inhalt = pos + 8;
    if (id === 'fmt ' && inhalt + 16 <= buf.length) {
      byteRate = buf.readUInt32LE(inhalt + 8);
    } else if (id === 'data') {
      // Manche Aufnahmen tragen im Kopf 0 oder 0xFFFFFFFF (Länge unbekannt): dann zählt, was da ist.
      datenBytes = groesse === 0 || groesse === 0xffffffff ? buf.length - inhalt : Math.min(groesse, buf.length - inhalt);
      break;
    }
    pos = inhalt + groesse + (groesse % 2);
  }
  if (!byteRate || datenBytes === null) throw fehler('Die Aufnahme ist kein lesbares WAV (fmt oder data fehlt).', 'AUDIO_UNGUELTIG');
  const sekunden = datenBytes / byteRate;
  if (sekunden > MAX_AUDIO_SEKUNDEN + 0.5) {
    throw fehler(`Die Aufnahme ist ${Math.round(sekunden)} Sekunden lang; umgeschrieben werden höchstens ${MAX_AUDIO_SEKUNDEN}.`, 'AUDIO_ZU_LANG', 413);
  }
  if (sekunden < 0.1) throw fehler('Die Aufnahme ist leer.', 'AUDIO_UNGUELTIG');
  return { buf, sekunden };
}

module.exports = {
  BILD_MIME,
  PDF_MIME,
  GEMINI_BILD,
  MAX_BILD_BYTES,
  MAX_PDF_BYTES,
  MAX_ANHAENGE_JE_NACHRICHT,
  MAX_ANHAENGE_JE_ANFRAGE,
  MAX_AUDIO_SEKUNDEN,
  BUDGET,
  GRENZE,
  artErkennen,
  base64Lesen,
  anhangPruefen,
  nameSaeubern,
  etikett,
  aufloesen,
  wavPruefen,
};
