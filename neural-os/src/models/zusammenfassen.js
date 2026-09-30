'use strict';

/**
 * Die KI-Zusammenfassung eines Eintrags fuer die Detailkarte im Gehirn
 * (POST /api/graph/zusammenfassung, web/views/graph.js).
 *
 * Warum so
 * --------
 * - **Nur aus dem, was dasteht.** Die KI bekommt Art, Titel, Inhalt und die
 *   Titel des Verknuepften -- keine Werkzeuge, keine Websuche. Eine
 *   Zusammenfassung, die Wissen von aussen dazumischt, waere keine
 *   Zusammenfassung dieses Eintrags mehr.
 * - **Einmal fragen, dann merken.** Mit Gemini kostenlos sind die Anfragen je
 *   Minute begrenzt; wer eine Karte zweimal oeffnet, soll nicht zweimal
 *   warten. Gemerkt wird im Speicher des laufenden Programms, unter einem
 *   Schluessel aus Kennung, Aenderungszeit und Nachbarn: aendert sich der
 *   Eintrag oder das, was mit ihm verknuepft ist, gilt die alte
 *   Zusammenfassung nicht mehr. Nicht auf den Stick geschrieben -- dort
 *   laege sonst Text aus dem Tresor ausserhalb des Tresors.
 * - **Ehrlich ohne KI.** Ist keine verbunden, kommt `text: null`; die Karte
 *   sagt das in einem Satz und zeigt keinen Knopf, der nichts tun kann.
 */

const crypto = require('node:crypto');

/** So viel Inhalt geht hoechstens an die KI (der Rest wuerde die Anfrage nur teurer machen). */
const MAX_INHALT = 30000;
/** Hoechstens so viele Nachbarn je Richtung. */
const MAX_NACHBARN = 25;
/** So viele Zusammenfassungen merkt sich das Programm (die aeltesten gehen zuerst). */
const MAX_GEMERKT = 200;

const SYSTEM = 'Du bist die persönliche KI von Neural OS und fasst einen Eintrag aus dem Wissen des Nutzers knapp zusammen. Deutsch, sachlich, ohne Einleitung, nichts erfinden.';
const AUFTRAG = 'Fasse das in zwei bis vier Sätzen zusammen: worum es geht und wie es mit dem Verknüpften zusammenhängt. Nur aus dem, was hier steht.';

function titelVon(record) {
  const d = (record && record.data) || {};
  return String(d.title || d.name || d.text || (record && record.id) || '').slice(0, 300);
}

function inhaltVon(record) {
  const d = (record && record.data) || {};
  return String(d.body || d.content || d.description || d.text || d.goal || d.result || '').slice(0, MAX_INHALT);
}

/** Die Nachbarn als Zeilen "- Titel (Art, Beziehung)". */
function nachbarZeilen(verknuepft) {
  const out = [];
  for (const richtung of ['ausgehend', 'eingehend']) {
    for (const v of ((verknuepft && verknuepft[richtung]) || []).slice(0, MAX_NACHBARN)) {
      out.push(`- ${String(v.title || v.id).slice(0, 120)} (${v.type || 'Satz'}${v.kind ? `, ${v.kind}` : ''})`);
    }
  }
  return out;
}

/**
 * Was an die KI geht.
 * @returns {{titel:string, system:string, nachrichten:Array, purpose:string}}
 */
function anfrageFuer({ record, verknuepft }) {
  const titel = titelVon(record);
  const text = inhaltVon(record);
  const nachbarn = nachbarZeilen(verknuepft);
  const bloecke = [
    { type: 'text', text: `Art: ${record.type}\nTitel: ${titel}` },
    { type: 'text', text: text.trim() ? `Inhalt:\n<<<\n${text}\n>>>` : 'Inhalt: (leer)' },
  ];
  if (nachbarn.length) bloecke.push({ type: 'text', text: `Verknüpft mit:\n${nachbarn.join('\n')}` });
  bloecke.push({ type: 'text', text: AUFTRAG });
  return {
    titel,
    system: SYSTEM,
    nachrichten: [{ role: 'user', content: bloecke }],
    purpose: `Zusammenfassung von „${titel.slice(0, 60)}“ im Gehirn`,
  };
}

/**
 * Der Schluessel, unter dem eine Zusammenfassung gilt: derselbe Eintrag in
 * derselben Fassung mit denselben Nachbarn.
 */
function schluesselVon(record, verknuepft) {
  const h = crypto.createHash('sha256');
  h.update(String(record.id));
  h.update('\u0000');
  h.update(`${record.rev ?? ''}|${record.updatedAt || ''}`);
  for (const zeile of nachbarZeilen(verknuepft)) {
    h.update('\u0000');
    h.update(zeile);
  }
  return h.digest('hex').slice(0, 32);
}

/** Ein kleiner Speicher mit Obergrenze: die aeltesten Eintraege gehen zuerst. */
function createGedaechtnis({ max = MAX_GEMERKT } = {}) {
  const map = new Map();
  return {
    holen(schluessel) {
      const wert = map.get(schluessel);
      if (!wert) return null;
      // Zuletzt gebraucht: nach hinten, damit es zuletzt verdraengt wird.
      map.delete(schluessel);
      map.set(schluessel, wert);
      return wert;
    },
    ablegen(schluessel, wert) {
      map.delete(schluessel);
      map.set(schluessel, wert);
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get groesse() { return map.size; },
  };
}

module.exports = {
  MAX_INHALT,
  MAX_NACHBARN,
  MAX_GEMERKT,
  SYSTEM,
  AUFTRAG,
  anfrageFuer,
  schluesselVon,
  createGedaechtnis,
};
