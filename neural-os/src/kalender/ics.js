'use strict';

/**
 * Termine als Kalenderdatei (RFC 5545, "iCalendar", Endung .ics).
 *
 * Wozu: Auf dem iPad in Safari einen Termin antippen -> "Zum Kalender
 * hinzufuegen". Das funktioniert nur, wenn die Datei genau der Norm folgt;
 * die Kalender-App verzeiht wenig und sagt nicht, warum sie etwas ablehnt.
 * Deshalb steht hier jede Regel ausdruecklich:
 *
 * - Zeilen enden mit CRLF, auch die letzte.
 * - Eine Zeile ist hoechstens 75 OKTETTE lang, nicht 75 Zeichen: "Grüße"
 *   hat 5 Zeichen, aber 6 Oktette. Laengere Zeilen werden gefaltet (CRLF +
 *   ein Leerzeichen), und zwar nie mitten in einem UTF-8-Zeichen -- ein
 *   halbes "ü" am Zeilenende ist fuer den Leser kaputter Text.
 * - In Texten werden Backslash, Semikolon, Komma und Zeilenumbruch
 *   maskiert (\\ \; \, \n). Ein Komma im Ort ("Praxis, 2. Stock") waere
 *   sonst der Beginn eines zweiten Werts.
 * - Uhrzeiten sind "fliessende Ortszeit" ohne TZID: 18:00 bleibt 18:00, egal
 *   in welcher Zone das iPad gerade ist -- genau wie im Tresor (Wandzeit).
 *   Nur ein Termin, der schon mit Zone gespeichert wurde, geht als UTC-Zeit
 *   ("…Z") hinaus, denn er IST ein fester Zeitpunkt.
 * - Ganztaegig: DTSTART;VALUE=DATE und DTEND exklusiv (der Tag NACH dem
 *   letzten). Im Tresor ist `end` der letzte Tag einschliesslich; wer das
 *   eins zu eins uebernimmt, verliert auf dem iPad jeweils den letzten Tag.
 * - Serien: RRULE und EXDATE, im selben Werttyp wie DTSTART (so verlangt es
 *   die Norm fuer UNTIL und EXDATE).
 * - Erinnerung: VALARM mit TRIGGER vor dem Beginn.
 * - UID = <id>@neural-os: dieselbe Datei zweimal importiert ergibt keinen
 *   doppelten Termin, sondern aktualisiert den vorhandenen.
 */

const w = require('./wiederholung');

const CRLF = '\r\n';
const MAX_OKTETTE = 75;
const PRODID = '-//Neural OS//Kalender//DE';

const pad = (n) => String(n).padStart(2, '0');

/* ------------------------------------------------------------ Texte */

/**
 * Text fuer SUMMARY, LOCATION, DESCRIPTION maskieren (RFC 5545, 3.3.11).
 * TEXT darf keine Steuerzeichen ausser HTAB enthalten: \v und \f werden
 * Leerzeichen, der Rest faellt weg. Sonst lehnt die Kalender-App die Datei
 * ab oder schneidet am \u0000 ab -- auch bei Bestand, der vor der Pruefung
 * in checkEvent gespeichert wurde.
 */
function textMaskieren(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/[\u000B\u000C]/g, ' ')
    .replace(/[\u0000-\u0008\u000E-\u001F\u007F]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Eine logische Zeile falten: hoechstens 75 Oktette je physischer Zeile, die
 * Fortsetzung beginnt mit einem Leerzeichen (das zu ihren 75 zaehlt). Nie
 * mitten in einem UTF-8-Zeichen.
 */
function falten(zeile) {
  const bytes = Buffer.from(zeile, 'utf8');
  if (bytes.length <= MAX_OKTETTE) return zeile;
  const teile = [];
  let pos = 0;
  let platz = MAX_OKTETTE;
  while (pos < bytes.length) {
    let ende = Math.min(bytes.length, pos + platz);
    // Nicht in ein Mehrbyte-Zeichen hineinschneiden: Folgebytes sind 10xxxxxx.
    while (ende < bytes.length && ende > pos && (bytes[ende] & 0xc0) === 0x80) ende -= 1;
    teile.push(bytes.slice(pos, ende).toString('utf8'));
    pos = ende;
    platz = MAX_OKTETTE - 1; // das fuehrende Leerzeichen der Fortsetzung
  }
  return teile.join(`${CRLF} `);
}

/* ----------------------------------------------------------- Werte */

function datumWert(tag) {
  return tag.replace(/-/g, '');
}

/** 'YYYY-MM-DDTHH:MM[:SS]' -> 'YYYYMMDDTHHMMSS' (fliessend, ohne Zone). */
function ortszeitWert(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6] || '00'}`;
}

function utcWert(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/**
 * Eine Zeitangabe des Tresors als Eigenschaft: [Parameter, Wert].
 * @returns {{param:string, wert:string, art:'datum'|'ortszeit'|'utc'}|null}
 */
function zeitEigenschaft(text, ganztaegig) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const s = text.trim();
  if (ganztaegig || /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const tag = s.slice(0, 10);
    return w.gueltigerTag(tag) ? { param: ';VALUE=DATE', wert: datumWert(tag), art: 'datum' } : null;
  }
  if (w.hatZone(s)) {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? { param: '', wert: utcWert(ms), art: 'utc' } : null;
  }
  return w.wandzeitLesen(s) ? { param: '', wert: ortszeitWert(s), art: 'ortszeit' } : null;
}

/** Eine Minutenzahl als Dauer: 90 -> "PT1H30M", 1440 -> "P1D", 0 -> "PT0S". */
function dauer(minuten) {
  if (!minuten) return 'PT0S';
  if (minuten % 1440 === 0) return `P${minuten / 1440}D`;
  const h = Math.floor(minuten / 60);
  const m = minuten % 60;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}`;
}

/**
 * Minuten vor Beginn -> TRIGGER. Bei ganztaegigen Terminen zaehlt der Beginn
 * als 9 Uhr -- so erinnert auch die Oberflaeche (web/lib/erinnerung.js), und
 * so macht es die Kalender-App des iPads selbst ("1 Tag vorher um 9:00" ist
 * dort TRIGGER:-PT15H). Mitternacht zu nehmen hiesse, jemanden um 0 Uhr an
 * einen Geburtstag zu erinnern.
 */
/*
 * Zur Zeitumstellung, damit niemand es fuer ein Versehen haelt:
 * - Mit Uhrzeit: "1 Tag vorher" wird "-P1D" -- ein KALENDERtag (RFC 5545
 *   3.3.6), also am Vortag zur selben Wandzeit, auch ueber den 25.10.
 *   hinweg. Die Oberflaeche rechnet genauso (ausloeseMs in
 *   web/lib/erinnerung.js). Minuten und Stunden sind genaue Dauern, hier wie
 *   dort.
 * - Ganztaegig: "-PT15H" (1 Tag vorher) liegt ganz am Vorabend und kreuzt
 *   nie eine Umstellung. "PT9H" (am Tag selbst) kreuzt die Nacht; eine
 *   streng rechnende App kaeme am Umstellungstag auf 8 oder 10 Uhr. Die
 *   Kalender-App des iPads schreibt fuer "am Tag des Ereignisses (9:00)"
 *   selbst genau diese Form und liest sie als 9 Uhr Wandzeit -- genau wie
 *   die Oberflaeche. Eine absolute Zeit (VALUE=DATE-TIME) waere nur in UTC
 *   erlaubt und wiederholte sich bei Serien nicht.
 */
function ausloeser(minuten, ganztaegig = false) {
  const vorher = ganztaegig ? minuten - 9 * 60 : minuten;
  if (vorher === 0) return 'PT0S';
  return vorher > 0 ? `-${dauer(vorher)}` : dauer(-vorher);
}

/** Die Regel als RRULE-Wert. */
function rrule(regel, art) {
  const teile = [`FREQ=${regel.freq.toUpperCase()}`];
  if (regel.interval && regel.interval !== 1) teile.push(`INTERVAL=${regel.interval}`);
  if (regel.freq === 'weekly' && regel.byDay && regel.byDay.length) teile.push(`BYDAY=${regel.byDay.join(',')}`);
  if (regel.until) {
    // UNTIL im Werttyp von DTSTART (RFC 5545, 3.3.10). Bei Ortszeit ist das
    // Ende des genannten Tages gemeint: "bis 24.12." schliesst den 24. ein.
    teile.push(`UNTIL=${art === 'datum' ? datumWert(regel.until) : `${datumWert(regel.until)}T235959`}`);
  }
  if (regel.count) teile.push(`COUNT=${regel.count}`);
  return teile.join(';');
}

/* --------------------------------------------------------- Termine */

/**
 * Ein Termin als VEVENT (Liste logischer Zeilen, noch ungefaltet).
 * @param {{id:string, data:object, createdAt?:string, updatedAt?:string}} record
 */
function veventZeilen(record, { jetzt = Date.now() } = {}) {
  const roh = record.data || {};
  // Aeltere Serien, deren Beginn auf keinem ihrer Wochentage liegt: DTSTART
  // zaehlt nach RFC 5545 immer als Vorkommen, also auf das erste echte legen
  // (neue Termine speichert die Route schon so, siehe checkEvent).
  const lage = w.istSerie(roh) ? w.beginnAufVorkommen(roh) : null;
  const d = lage ? { ...roh, ...lage } : roh;
  const ganz = d.allDay === true;
  const start = zeitEigenschaft(d.start, ganz);
  if (!start) return [];
  const zeilen = ['BEGIN:VEVENT'];
  zeilen.push(`UID:${record.id}@neural-os`);
  const stempel = Date.parse(record.updatedAt || record.createdAt || '') || jetzt;
  zeilen.push(`DTSTAMP:${utcWert(stempel)}`);
  if (record.createdAt && Number.isFinite(Date.parse(record.createdAt))) zeilen.push(`CREATED:${utcWert(Date.parse(record.createdAt))}`);
  if (record.updatedAt && Number.isFinite(Date.parse(record.updatedAt))) zeilen.push(`LAST-MODIFIED:${utcWert(Date.parse(record.updatedAt))}`);
  zeilen.push(`DTSTART${start.param}:${start.wert}`);

  if (start.art === 'datum') {
    // Exklusiv: der Tag nach dem letzten. Ohne Ende ist es ein Tag.
    const letzter = d.end && w.gueltigerTag(String(d.end).slice(0, 10)) ? String(d.end).slice(0, 10) : String(d.start).slice(0, 10);
    zeilen.push(`DTEND;VALUE=DATE:${datumWert(w.plusTage(letzter, 1))}`);
  } else if (d.end) {
    const ende = zeitEigenschaft(d.end, false);
    // Ohne Ende bleibt DTEND weg: die Norm liest das als Zeitpunkt. Eine
    // erfundene Stunde waere eine Angabe, die niemand gemacht hat.
    if (ende) zeilen.push(`DTEND${ende.param}:${ende.wert}`);
  }

  zeilen.push(`SUMMARY:${textMaskieren(d.title)}`);
  if (d.location) zeilen.push(`LOCATION:${textMaskieren(d.location)}`);
  if (d.body) zeilen.push(`DESCRIPTION:${textMaskieren(d.body)}`);

  if (w.istSerie(d) && start.art !== 'utc') {
    zeilen.push(`RRULE:${rrule(d.recurrence, start.art)}`);
    const aus = Array.isArray(d.exdates) ? d.exdates.filter(w.gueltigerTag) : [];
    if (aus.length) {
      if (start.art === 'datum') {
        zeilen.push(`EXDATE;VALUE=DATE:${aus.map(datumWert).join(',')}`);
      } else {
        const zeit = start.wert.slice(8); // 'THHMMSS' -- dieselbe Uhrzeit wie DTSTART
        zeilen.push(`EXDATE:${aus.map((t) => `${datumWert(t)}${zeit}`).join(',')}`);
      }
    }
  }

  if (Number.isInteger(d.reminder) && w.ERINNERUNGEN.includes(d.reminder)) {
    zeilen.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${textMaskieren(d.title || 'Termin')}`, `TRIGGER:${ausloeser(d.reminder, start.art === 'datum')}`, 'END:VALARM');
  }
  zeilen.push('END:VEVENT');
  return zeilen;
}

/**
 * Eine vollstaendige Kalenderdatei aus Terminen (Sätzen).
 * @param {object[]} records
 * @param {{name?:string}} [opts]
 * @returns {string}  mit CRLF, gefaltet, UTF-8-tauglich
 */
function kalenderDatei(records, { name = 'Neural OS', jetzt = Date.now() } = {}) {
  const zeilen = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    // PUBLISH: "hier sind Termine zum Uebernehmen" -- keine Einladung, auf
    // die jemand antworten muesste.
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${textMaskieren(name)}`,
  ];
  for (const record of records) zeilen.push(...veventZeilen(record, { jetzt }));
  zeilen.push('END:VCALENDAR');
  return zeilen.map(falten).join(CRLF) + CRLF;
}

/**
 * Ein Dateiname, der ueberall heil ankommt: nur a-z, 0-9 und Bindestrich.
 * "Zahnarzt Dr. Weiß" -> "zahnarzt-dr-weiss.ics". Der echte Titel steht in
 * der Datei; der Name muss nur erkennbar und ungefaehrlich sein (kein
 * Anfuehrungszeichen, kein Schraegstrich, kein Zeilenumbruch im Kopf).
 */
function dateiname(titel, fallback = 'termin') {
  const basis = String(titel || '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return `${basis || fallback}.ics`;
}

module.exports = {
  CRLF,
  MAX_OKTETTE,
  textMaskieren,
  falten,
  veventZeilen,
  kalenderDatei,
  dateiname,
  ausloeser,
};
