'use strict';

/**
 * Einmalige Umwandlungen beim Oeffnen eines Tresors, der aelter ist als der Code.
 *
 * WARUM es diese Datei gibt: der Bereich "Lernen" ist entfallen, und mit ihm
 * der Record-Typ 'card' aus `schema.TYPES`. Ein bereits vorhandener 'card'-Satz
 * verschwindet dadurch NICHT -- der Wiederaufbau aus dem Log prueft den Typ
 * nicht nach. Er wuerde aber zur Karteileiche, und zwar zu einer stillen:
 *
 *   - `backup.js` laeuft ueber `schema.TYPES`. Ein Typ, der dort fehlt, faellt
 *     aus jeder NEUEN Sicherung heraus, ohne dass irgendwo etwas gemeldet wird.
 *   - Eine ALTE Sicherung, die den Satz noch enthaelt, laesst sich nicht mehr
 *     einspielen: der Import weist ihn mit "Unbekannter Record-Typ card" ab.
 *
 * Damit waere das, was der Mensch fuer gesichert haelt, genau im Notfall weg.
 * Deshalb wird umgewandelt statt liegengelassen: Vorderseite -> Titel,
 * Rueckseite -> Text, das Schlagwort 'lernkarte' haelt die Herkunft fest, und
 * die Verknuepfung zur Quellnotiz bleibt als Kante erhalten.
 *
 * Der Lernstand (`ease`, `intervalDays`, `due`) wandert bewusst NICHT mit: ohne
 * das Verfahren, das ihn fortschreibt, ist er keine Information mehr, sondern
 * eine Zahl, die niemand mehr deuten kann.
 */

const HERKUNFT_TAG = 'lernkarte';

/** `note.title` ist bei 500 Zeichen begrenzt; `card.front` war es bei 2000. */
const MAX_TITEL = 500;

function istObjekt(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nullLogger() {
  return { error() {}, warn() {}, info() {}, debug() {} };
}

/**
 * Vorderseite und Rueckseite auf Titel und Text abbilden.
 *
 * Eine Vorderseite kann laenger oder mehrzeilig sein, als ein Titel sein darf.
 * Sie wird dann gekuerzt -- aber nie nur gekuerzt: der volle Wortlaut wandert
 * zusaetzlich in den Text, damit das Kuerzen nichts wegnimmt.
 */
function titelUndText(front, back) {
  const vorne = String(front == null ? '' : front).trim();
  const hinten = String(back == null ? '' : back).trim();

  const ersteZeile = vorne.split('\n')[0].trim();
  const mehrzeilig = ersteZeile !== vorne;

  let titel = ersteZeile;
  let gekuerzt = false;
  if (titel.length > MAX_TITEL) {
    titel = `${titel.slice(0, MAX_TITEL - 1)}…`;
    gekuerzt = true;
  }
  if (!titel) titel = 'Lernkarte ohne Vorderseite';

  const text = (mehrzeilig || gekuerzt)
    ? [vorne, hinten].filter(Boolean).join('\n\n')
    : hinten;

  return { titel, text };
}

/** Schlagwoerter der neuen Notiz: Herkunft, und der Stapelname, falls er einer war. */
function schlagwoerter(deck) {
  const tags = [HERKUNFT_TAG];
  const stapel = String(deck == null ? '' : deck).trim().toLowerCase();
  // 'Standard' war die Voreinstellung und sagt nichts; jeder andere Stapelname
  // ist eine Einteilung, die jemand von Hand getroffen hat.
  if (stapel && stapel !== 'standard' && stapel !== HERKUNFT_TAG) tags.push(stapel);
  return tags;
}

/**
 * Lernkarten in Notizen umwandeln.
 *
 * Laeuft bei jedem Start, tut aber nur beim ersten etwas: die umgewandelte
 * Karte wird danach endgueltig entfernt, also findet der naechste Start keine
 * mehr. Das ist absichtlich kein gesetztes Haekchen irgendwo -- ein Haekchen
 * kann verlorengehen, waehrend die Karte noch daliegt, und dann wuerde die
 * Umwandlung genau das ueberspringen, wofuer es sie gibt.
 *
 * @param {object} store  offener Store
 * @param {object} [opts]
 * @param {Function} [opts.logger]
 * @returns {{gefunden:number, umgewandelt:number, verworfen:number, fehler:Array}}
 */
function lernkartenZuNotizen(store, opts = {}) {
  const log = typeof opts.logger === 'function' ? opts.logger('migration') : nullLogger();
  const bericht = { gefunden: 0, umgewandelt: 0, verworfen: 0, fehler: [] };
  if (!store || typeof store.list !== 'function') return bericht;

  // `includeDeleted`, weil auch ein Grabstein ein 'card'-Satz im Log bleibt.
  let karten;
  try {
    karten = store.list('card', { includeDeleted: true, limit: undefined }).items;
  } catch (err) {
    bericht.fehler.push({ id: null, grund: String(err && err.message) });
    return bericht;
  }
  if (!karten || !karten.length) return bericht;
  bericht.gefunden = karten.length;

  for (const karte of karten) {
    const daten = istObjekt(karte.data) ? karte.data : {};
    try {
      // Eine Karte, die der Mensch bereits geloescht hatte, wird nicht als
      // Notiz wiederbelebt -- das waere ein Wiederauftauchen von etwas, das
      // jemand bewusst weggeworfen hat. Sie wird nur endgueltig entfernt,
      // damit sie nicht als unlesbarer Rest im Tresor stehen bleibt.
      if (karte.deletedAt) {
        store.remove(karte.id, { hard: true });
        bericht.verworfen += 1;
        continue;
      }

      const { titel, text } = titelUndText(daten.front, daten.back);
      const notiz = store.create('note', {
        title: titel,
        body: text,
        tags: schlagwoerter(daten.deck),
        source: 'import',
      });

      // Die Verknuepfung zur Quellnotiz, falls es eine gab und sie noch da ist.
      const quelle = typeof daten.noteId === 'string' && daten.noteId
        ? store.get(daten.noteId)
        : null;
      if (quelle && !quelle.deletedAt && quelle.id !== notiz.id) {
        try {
          store.edges.add({
            from: notiz.id,
            to: quelle.id,
            kind: 'derived-from',
            source: 'derived',
            reason: 'War eine Lernkarte zu dieser Notiz.',
          });
        } catch (err) {
          // Eine fehlende Kante ist ein Verlust an Zusammenhang, kein Verlust
          // an Inhalt: die Notiz steht schon. Also gemeldet, nicht abgebrochen.
          bericht.fehler.push({ id: karte.id, grund: `Verknuepfung: ${String(err && err.message)}` });
        }
      }

      store.remove(karte.id, { hard: true });
      bericht.umgewandelt += 1;
    } catch (err) {
      bericht.fehler.push({ id: karte.id, grund: String(err && err.message) });
    }
  }

  if (bericht.umgewandelt || bericht.verworfen || bericht.fehler.length) {
    log.info(`Lernkarten umgewandelt: ${bericht.umgewandelt} zu Notizen, `
      + `${bericht.verworfen} bereits geloeschte entfernt, ${bericht.fehler.length} Fehler`);
  }
  return bericht;
}

module.exports = {
  lernkartenZuNotizen,
  titelUndText,
  schlagwoerter,
  HERKUNFT_TAG,
};
