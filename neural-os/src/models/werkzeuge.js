'use strict';

/**
 * Die eigenen Werkzeuge von Claude -- was die KI in Neural OS SELBST tun darf.
 *
 * Warum diese Datei so gebaut ist
 * -------------------------------
 * - **Die Beschreibung sagt WANN.** Claude entscheidet an ihr, ob ein Satz
 *   ein Termin ist. "Legt einen Termin an" allein führt dazu, dass nur auf
 *   ausdrücklichen Befehl eingetragen wird; der Nutzer will aber, dass
 *   "Dienstag um 10 Zahnarzt" von selbst im Kalender landet.
 * - **Jede Eingabe wird streng geprüft**, bevor irgendetwas geschrieben wird.
 *   Die Werkzeuge tragen `eager_input_streaming`; damit prüft der Server die
 *   Eingabe NICHT mehr. `strict: true` bleibt als Absicht in der Definition,
 *   aber die Garantie gibt hier nur `eingabePruefen()`: zusätzliche Felder,
 *   falsche Typen, fehlende Pflichtfelder, unmögliche Daten -- alles wird
 *   abgelehnt und NICHT ausgeführt.
 * - **Jeder Schreibvorgang trägt einen Urheber** (`withActor`, Art `agent`).
 *   Damit schreibt der Änderungsverlauf ihn als Agentenänderung auf, er ist
 *   rückgängig zu machen, und "hat das die KI gemacht?" hat eine Antwort.
 * - **Jeder Aufruf ist als Lauf sichtbar** (Satzart `run`, Bus-Ereignis
 *   `agent.aktivitaet`): wer arbeitet gerade, seit wann, was ist erledigt.
 *   Das gilt auch für abgelehnte Eingaben -- ein Agent, der still scheitert,
 *   ist schlimmer als einer, der sagt, dass er gescheitert ist.
 * - **Doppelt anlegen wird verhindert, nicht versteckt.** Derselbe Termin
 *   (Titel + Beginn), dieselbe Erinnerung, dieselbe Aufgabe im selben Projekt
 *   werden nicht ein zweites Mal geschrieben; Claude bekommt gesagt, dass es
 *   sie schon gibt. Nennt der zweite Aufruf beim Termin etwas Neues
 *   (Wiederholung, Ende, Ort, Erinnerung), wird das am vorhandenen ergaenzt
 *   und gesagt -- "ach, das ist jeden Dienstag" darf nicht verschluckt werden.
 * - **Serien werden nie still verkuerzt.** start/end beziehen sich bei einer
 *   Serie auf EIN Vorkommen (das Claude aus termine_lesen kennt); die Serie
 *   verschiebt sich um den Unterschied. "Ab jetzt …" teilt sie mit ab_am.
 */

const { withActor } = require('../kernel/actor');
const { NeuralError, ValidationError, asNeuralError } = require('../kernel/errors');
const kalender = require('../http/api/events');
const wdh = require('../kalender/wiederholung');

const AGENT_ID = 'claude';

/** Rolle je Werkzeug (Vertrag 7). */
const ROLLEN = Object.freeze({
  rueckfrage: 'planung',
  termin_anlegen: 'kalender',
  termine_lesen: 'kalender',
  termin_aendern: 'kalender',
  termin_loeschen: 'kalender',
  notiz_anlegen: 'notizen',
  merken: 'gedaechtnis',
  projekt_anpassen: 'projekte',
  web_search: 'recherche',
  web_fetch: 'recherche',
});

const ROLLEN_NAME = Object.freeze({
  planung: 'Planung',
  kalender: 'Kalender',
  notizen: 'Notizen',
  gedaechtnis: 'Gedächtnis',
  projekte: 'Projekte',
  recherche: 'Recherche',
});

/* ------------------------------------------------------ Definitionen */

function werkzeug(name, description, properties, required) {
  return Object.freeze({
    name,
    description,
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties,
      required,
    },
  });
}

/*
 * Kalender: gemeinsame Bausteine.
 *
 * Die Feldnamen sind deutsch, weil Claude sie aus deutschen Saetzen fuellt;
 * gespeichert wird in der Form aus Vertrag A (freq/interval/byDay/…). Die
 * Wochentage heissen deshalb MO DI MI DO FR SA SO und werden erst beim
 * Speichern auf die Norm (MO TU WE TH FR SA SU) umgeschrieben.
 *
 * Keine minimum/maximum/minLength im Schema: die kennt der strenge Modus
 * nicht. Die Grenzen stehen in der Beschreibung und werden in
 * `eingabePruefen()` durchgesetzt.
 */
const RHYTHMUS = Object.freeze({ taeglich: 'daily', woechentlich: 'weekly', monatlich: 'monthly', jaehrlich: 'yearly' });
const TAGE_DE = Object.freeze(['MO', 'DI', 'MI', 'DO', 'FR', 'SA', 'SO']);
const TAG_DE_ZU_NORM = Object.freeze({ MO: 'MO', DI: 'TU', MI: 'WE', DO: 'TH', FR: 'FR', SA: 'SA', SO: 'SU' });

const WIEDERHOLUNG = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    rhythmus: {
      type: 'string',
      enum: Object.keys(RHYTHMUS),
      description: 'Wie oft. monatlich/jaehrlich = am selben Tag wie start; gibt es den Tag in einem Monat nicht (31.), fällt der Termin dort aus.',
    },
    alle: { type: 'integer', description: 'Jede wievielte Einheit: 1 = jede Woche, 2 = jede zweite Woche. Weglassen = 1. Höchstens 99.' },
    wochentage: {
      type: 'array',
      items: { type: 'string', enum: TAGE_DE },
      description: 'Nur bei woechentlich und nur, wenn andere oder mehrere Tage gemeint sind als der Wochentag von start („Montag und Donnerstag“ = ["MO","DO"]).',
    },
    bis: { type: 'string', description: 'Letzter möglicher Tag YYYY-MM-DD, einschließlich („bis Weihnachten“). Weglassen, wenn kein Ende genannt ist.' },
    anzahl: { type: 'integer', description: 'Wie oft insgesamt („zehnmal“), höchstens 999. Nicht zusammen mit bis.' },
  },
  required: ['rhythmus'],
});

const ERINNERUNG_MINUTEN = Object.freeze([...wdh.ERINNERUNGEN]);

/**
 * Die Definitionen, wie sie an Claude gehen. Reihenfolge und Wortlaut sind
 * Teil des gecachten Präfixes: nicht pro Anfrage verändern. Die Reihenfolge
 * ist fest vereinbart (Vertrag F): rueckfrage, termin_anlegen, termine_lesen,
 * termin_aendern, termin_loeschen, notiz_anlegen, merken, projekt_anpassen --
 * danach hängt der Anbieter web_search und web_fetch an.
 */
const DEFINITIONEN = Object.freeze([
  werkzeug(
    'rueckfrage',
    'Stellt dem Nutzer eine Rückfrage mit Antworten zum Antippen und wartet auf seine Wahl. '
      + 'Benutze es, wenn dir für einen Plan, einen Termin oder eine Entscheidung eine Angabe fehlt, die du nicht sicher ableiten kannst '
      + '– vor allem am Anfang einer Planung (Reise, Lernplan, Fest, Projekt). Gib 2 bis 6 kurze Antworten vor. '
      + 'Nicht benutzen, wenn die Antwort schon im Gespräch steht, und höchstens eine Rückfrage auf einmal.',
    {
      frage: { type: 'string', description: 'Die Frage, kurz und direkt, auf Deutsch.' },
      optionen: { type: 'array', items: { type: 'string' }, description: '2 bis 6 kurze Antworten zum Antippen, je höchstens ein paar Wörter.' },
      mehrfach: { type: 'boolean', description: 'true, wenn mehrere Antworten zugleich gewählt werden dürfen.' },
    },
    ['frage', 'optionen', 'mehrfach'],
  ),
  werkzeug(
    'termin_anlegen',
    'Trägt einen Termin in den Kalender des Nutzers ein. Benutze es, wenn der Nutzer einen Termin, eine Verabredung '
      + 'oder eine Frist mit Datum nennt – auch nebenbei („am Dienstag um 10 Zahnarzt“, „Abgabe ist am 3.11.“). '
      + 'Rechne relative Angaben („morgen“, „nächsten Freitag“) mit dem heutigen Datum aus der Nachricht in ein festes Datum um. '
      + 'Sind Tag oder Uhrzeit unklar, frag vorher mit rueckfrage. '
      + 'Wiederkehrendes („jeden Dienstag um 18 Uhr Training“) ist EIN Aufruf mit wiederholung, nicht viele Einzeltermine. '
      + 'Die Antwort nennt Termine, mit denen sich der neue überschneidet.',
    {
      titel: { type: 'string', description: 'Kurzer Titel, z. B. „Zahnarzt“.' },
      start: { type: 'string', description: 'Beginn: YYYY-MM-DD bei ganztägigen Terminen, sonst YYYY-MM-DDTHH:MM in Ortszeit. Bei Serien das erste Vorkommen.' },
      ende: {
        type: 'string',
        description: 'Ende im selben Format wie start. Weglassen, wenn unbekannt. '
          + 'Bei ganztägigen Terminen der LETZTE Tag, einschließlich („Urlaub vom 5. bis 9.10.“ = ende 9.10., nicht 10.10.).',
      },
      ganztaegig: { type: 'boolean', description: 'true für Termine ohne Uhrzeit (Fristen, Geburtstage, Ferien).' },
      ort: { type: 'string', description: 'Ort, falls genannt.' },
      notiz: { type: 'string', description: 'Weitere Angaben, falls genannt.' },
      wiederholung: { ...WIEDERHOLUNG, description: 'Nur für wiederkehrende Termine. Sonst weglassen.' },
      erinnerung_minuten: {
        type: 'integer',
        enum: ERINNERUNG_MINUTEN,
        description: 'Nur wenn der Nutzer eine Erinnerung will: so viele Minuten vorher („eine Stunde vorher“ = 60, „am Vortag“ = 1440).',
      },
    },
    ['titel', 'start', 'ganztaegig'],
  ),
  werkzeug(
    'termine_lesen',
    'Liest die Termine des Nutzers in einem Zeitraum, als kurze Liste mit id. '
      + 'Benutze es, bevor du einen Termin änderst oder löschst, und wenn der Nutzer fragt, was ansteht '
      + '(„was hab ich morgen“, „wann war nochmal …“). '
      + 'Wiederkehrende Termine stehen je Vorkommen einmal da: gleiche id, der Tag in vorkommen; '
      + 'serie_start und serie_end nennen Beginn und Ende des ERSTEN Vorkommens der ganzen Serie.',
    {
      von: { type: 'string', description: 'Erster Tag, YYYY-MM-DD.' },
      bis: { type: 'string', description: 'Letzter Tag, YYYY-MM-DD, einschließlich. Höchstens 400 Tage nach von.' },
      suche: { type: 'string', description: 'Nur Termine, deren Titel, Ort oder Notiz dieses Wort enthält („Zahnarzt“). Weglassen für alle.' },
    },
    ['von', 'bis'],
  ),
  werkzeug(
    'termin_aendern',
    'Ändert einen Termin, der schon im Kalender steht: verschieben, umbenennen, Ort, Notiz, Erinnerung, Wiederholung. '
      + 'Hol dir vorher mit termine_lesen die id. Gib nur an, was sich ändert; ohne end behält der Termin seine Dauer. '
      + 'Bei Serien: mit nur_am ändert sich nur dieses eine Vorkommen („nur diesen Dienstag“), mit ab_am dieses und alle '
      + 'späteren („ab jetzt um 19 Uhr“, frühere bleiben, wie sie waren), ohne beides die ganze Serie. '
      + 'start und end beziehen sich bei Serien immer auf EIN Vorkommen aus termine_lesen (das aus nur_am/ab_am, sonst '
      + 'eines, dessen Tag du in start nennst): die Serie verschiebt sich um den Unterschied, Beginn und Anzahl bleiben.',
    {
      id: { type: 'string', description: 'Die id aus termine_lesen.' },
      nur_am: { type: 'string', description: 'Nur bei Serien: der Tag (YYYY-MM-DD, wie in vorkommen) des einen Vorkommens, das sich ändern soll.' },
      ab_am: {
        type: 'string',
        description: 'Nur bei Serien: ab diesem Vorkommen (YYYY-MM-DD, wie in vorkommen) gilt die Änderung; frühere bleiben unverändert. '
          + 'Für „ab jetzt“, „ab nächster Woche“. Nicht zusammen mit nur_am.',
      },
      titel: { type: 'string', description: 'Neuer Titel.' },
      start: {
        type: 'string',
        description: 'Neuer Beginn: YYYY-MM-DD (ganztägig) oder YYYY-MM-DDTHH:MM. Bei Serien der neue Beginn des Vorkommens, '
          + 'von dem du ausgehst (siehe oben), nicht der ganzen Serie.',
      },
      end: {
        type: 'string',
        description: 'Neues Ende im selben Format wie start. Bei ganztägigen Terminen der letzte Tag, einschließlich.',
      },
      ganztaegig: { type: 'boolean', description: 'true = ganztägig, false = mit Uhrzeit (dann start mit Uhrzeit angeben).' },
      ort: { type: 'string', description: 'Neuer Ort; leerer Text entfernt ihn.' },
      notiz: { type: 'string', description: 'Neue Notiz; leerer Text entfernt sie.' },
      wiederholung: {
        anyOf: [WIEDERHOLUNG, { type: 'null' }],
        description: 'Neue Wiederholung der ganzen Serie. null beendet die Wiederholung (aus der Serie wird ein einzelner Termin).',
      },
      erinnerung_minuten: {
        anyOf: [{ type: 'integer', enum: ERINNERUNG_MINUTEN }, { type: 'null' }],
        description: 'Erinnerung so viele Minuten vorher; null = keine Erinnerung.',
      },
    },
    ['id'],
  ),
  werkzeug(
    'termin_loeschen',
    'Löscht einen Termin (lässt sich rückgängig machen). Hol dir vorher mit termine_lesen die id. '
      + 'Bei Serien: mit nur_am fällt nur dieses eine Vorkommen aus, ohne nur_am verschwindet die ganze Serie – '
      + 'ist unklar, was gemeint ist, frag vorher mit rueckfrage.',
    {
      id: { type: 'string', description: 'Die id aus termine_lesen.' },
      nur_am: { type: 'string', description: 'Nur bei Serien: der Tag (YYYY-MM-DD, wie in vorkommen), der ausfallen soll.' },
    },
    ['id'],
  ),
  werkzeug(
    'notiz_anlegen',
    'Legt eine Notiz (ein Post-it) an. Benutze es, wenn der Nutzer etwas festhalten will („schreib auf“, „das ist eine Notiz“, '
      + '„merk dir für später …“) oder wenn im Gespräch ein Ergebnis entsteht, das er sichtlich behalten will (Liste, Plan, Zusammenfassung). '
      + 'Nicht für Fakten über den Nutzer selbst – dafür ist merken – und nicht für Termine – dafür ist termin_anlegen.',
    {
      titel: { type: 'string', description: 'Kurzer Titel der Notiz.' },
      text: { type: 'string', description: 'Der Inhalt, gern in Markdown.' },
      schlagworte: { type: 'array', items: { type: 'string' }, description: 'Bis zu 5 Schlagworte ohne #.' },
    },
    ['titel', 'text'],
  ),
  werkzeug(
    'merken',
    'Merkt sich einen dauerhaften Fakt über den Nutzer: Name, Schule und Klasse, Vorlieben, Abneigungen, feste Gewohnheiten, Ziele, wichtige Menschen. '
      + 'Benutze es, wenn der Nutzer so etwas über sich erzählt und es in späteren Gesprächen nützlich ist. '
      + 'Nicht für einmalige Aufgaben oder Termine. Ein Fakt pro Aufruf, kurz, in der dritten Person („Geht in die 10b.“).',
    {
      fakt: { type: 'string', description: 'Der Fakt in einem kurzen Satz.' },
    },
    ['fakt'],
  ),
  werkzeug(
    'projekt_anpassen',
    'Legt ein Projekt an oder ändert eines. Benutze es, wenn der Nutzer an einem Vorhaben über mehrere Schritte arbeitet '
      + '(Referat, Bewerbung, Umzug, Fest) oder über ein bestehendes Projekt spricht. Mit aufgaben hängst du nächste Schritte als Aufgaben an. '
      + 'Ein Projekt mit demselben Namen wird aktualisiert, nicht doppelt angelegt.',
    {
      name: { type: 'string', description: 'Name des Projekts.' },
      beschreibung: { type: 'string', description: 'Worum es geht, ein bis drei Sätze.' },
      status: { type: 'string', enum: ['active', 'paused', 'done'], description: 'active = läuft, paused = ruht, done = erledigt.' },
      aufgaben: { type: 'array', items: { type: 'string' }, description: 'Nächste Schritte als kurze Aufgaben.' },
    },
    ['name'],
  ),
]);

const NACH_NAME = new Map(DEFINITIONEN.map((d) => [d.name, d]));

function istEigenesWerkzeug(name) {
  return NACH_NAME.has(name);
}

/* ------------------------------------------------------ Prüfung */

function istObjekt(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function erlaubtNull(def) {
  return Array.isArray(def.anyOf) && def.anyOf.some((d) => d && d.type === 'null');
}

/**
 * Ein Wert gegen seinen Schemateil -- rekursiv, weil `wiederholung` ein
 * Objekt im Objekt ist. Kennt genau die Formen, die in DEFINITIONEN
 * vorkommen: string/boolean/integer (mit enum), array, object mit
 * additionalProperties:false, anyOf mit null.
 */
function typPruefen(feld, def, wert, fehler) {
  if (Array.isArray(def.anyOf)) {
    if (wert === null && erlaubtNull(def)) return;
    let erste = null;
    for (const alt of def.anyOf) {
      if (!alt || alt.type === 'null') continue;
      const f = [];
      typPruefen(feld, alt, wert, f);
      if (!f.length) return;
      if (!erste) erste = f;
    }
    fehler.push(...(erste || [`„${feld}“ hat einen ungültigen Wert.`]));
    return;
  }
  if (def.type === 'string') {
    if (typeof wert !== 'string') fehler.push(`„${feld}“ muss Text sein.`);
    else if (def.enum && !def.enum.includes(wert)) fehler.push(`„${feld}“ muss eines von ${def.enum.join(', ')} sein.`);
    return;
  }
  if (def.type === 'boolean') {
    if (typeof wert !== 'boolean') fehler.push(`„${feld}“ muss true oder false sein.`);
    return;
  }
  if (def.type === 'integer') {
    if (typeof wert !== 'number' || !Number.isInteger(wert)) fehler.push(`„${feld}“ muss eine ganze Zahl sein.`);
    else if (def.enum && !def.enum.includes(wert)) fehler.push(`„${feld}“ muss eines von ${def.enum.join(', ')} sein.`);
    return;
  }
  if (def.type === 'array') {
    if (!Array.isArray(wert)) {
      fehler.push(`„${feld}“ muss eine Liste sein.`);
      return;
    }
    if (def.items && def.items.type === 'string' && wert.some((x) => typeof x !== 'string')) {
      fehler.push(`„${feld}“ darf nur Text enthalten.`);
      return;
    }
    if (def.items && def.items.enum) {
      const falsch = wert.filter((x) => !def.items.enum.includes(x));
      if (falsch.length) fehler.push(`„${feld}“ darf nur ${def.items.enum.join(', ')} enthalten (nicht ${falsch.map(String).join(', ')}).`);
    }
    return;
  }
  if (def.type === 'object') {
    if (!istObjekt(wert)) {
      fehler.push(`„${feld}“ muss ein Objekt sein.`);
      return;
    }
    objektPruefen(feld, def, wert, fehler);
  }
}

/**
 * Felder eines Objekts pruefen: unbekannte Felder, Pflichtfelder, Typen.
 * `null` bei einem Feld, das null nicht kennt, zaehlt wie "weggelassen" --
 * so war es immer, und Claude schickt fuer "unbekannt" gern null.
 */
function objektPruefen(pfad, schema, obj, fehler) {
  const name = (key) => (pfad ? `${pfad}.${key}` : key);
  for (const key of Object.keys(obj)) {
    if (Object.prototype.hasOwnProperty.call(schema.properties, key)) continue;
    // Ein haeufiger Verwechsler zwischen termin_anlegen (ende) und
    // termin_aendern (end): gleich sagen, wie es hier heisst.
    const statt = key === 'ende' && schema.properties.end ? 'end' : key === 'end' && schema.properties.ende ? 'ende' : null;
    fehler.push(statt ? `Unbekanntes Feld „${name(key)}“ – hier heißt es „${name(statt)}“.` : `Unbekanntes Feld „${name(key)}“.`);
  }
  for (const key of schema.required || []) {
    if (obj[key] === undefined || obj[key] === null) fehler.push(`Pflichtfeld „${name(key)}“ fehlt.`);
  }
  for (const [key, feldDef] of Object.entries(schema.properties)) {
    const wert = obj[key];
    if (wert === undefined) continue;
    if (wert === null && !erlaubtNull(feldDef)) continue;
    typPruefen(name(key), feldDef, wert, fehler);
  }
}

const DATUM = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZEITPUNKT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * 'YYYY-MM-DD' oder 'YYYY-MM-DDTHH:MM' -> {art, wert, ms} oder null, wenn es
 * den Tag/die Uhrzeit nicht gibt.
 *
 * `ms` ist WANDZEIT (ueber Date.UTC gebildet, ohne Ortszone): Termine stehen
 * in Wandzeit, und nur so bleibt 02:45 am 29.03. vor 03:00. Mit `new Date`
 * in Ortszeit wird 02:45 an diesem Tag zu 03:45 (die Stunde gibt es in
 * Berlin nicht), und "Ende vor Beginn" hielte einen gueltigen Termin auf.
 */
function zeitLesen(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  let m = DATUM.exec(s);
  if (m) {
    const [j, mo, t] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const d = new Date(Date.UTC(j, mo - 1, t));
    if (j < 1900 || j > 2200 || d.getUTCFullYear() !== j || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== t) return null;
    return { art: 'datum', wert: s, ms: d.getTime() };
  }
  m = ZEITPUNKT.exec(s);
  if (m) {
    const [j, mo, t, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
    const d = new Date(Date.UTC(j, mo - 1, t, h, mi));
    if (j < 1900 || j > 2200 || h > 23 || mi > 59 || d.getUTCFullYear() !== j || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== t) return null;
    return { art: 'zeit', wert: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`, ms: d.getTime() };
  }
  return null;
}

function laenge(feld, wert, min, max, fehler) {
  if (typeof wert !== 'string') return;
  const n = wert.trim().length;
  if (n < min) fehler.push(min <= 1 ? `„${feld}“ ist leer.` : `„${feld}“ ist zu kurz.`);
  if (n > max) fehler.push(`„${feld}“ ist zu lang (höchstens ${max} Zeichen).`);
}

/**
 * `wiederholung` (deutsche Felder) in die gespeicherte Form (Vertrag A).
 * Prueft, was sich ohne den Termin pruefen laesst; den Rest (bis vor dem
 * Beginn der Serie …) prueft dieselbe Regel wie die Route
 * (wiederholung.regelPruefen), damit KI und Oberflaeche nie verschieden
 * streng sind.
 *
 * @returns {undefined|null|object}  undefined = nicht angegeben, null = keine Wiederholung
 */
function wiederholungLesen(roh, fehler, startTag) {
  if (roh === undefined) return undefined;
  if (roh === null) return null;
  const freq = RHYTHMUS[roh.rhythmus];
  const interval = roh.alle === undefined || roh.alle === null ? 1 : roh.alle;
  if (interval < 1 || interval > wdh.MAX_INTERVALL) fehler.push(`„wiederholung.alle“ muss zwischen 1 und ${wdh.MAX_INTERVALL} liegen.`);
  const tage = Array.isArray(roh.wochentage) ? roh.wochentage : [];
  if (new Set(tage).size !== tage.length) fehler.push('„wiederholung.wochentage“ nennt einen Tag doppelt.');
  if (tage.length && freq !== 'weekly') fehler.push('„wiederholung.wochentage“ gibt es nur beim rhythmus „woechentlich“.');
  const until = roh.bis === undefined || roh.bis === null || roh.bis === '' ? null : String(roh.bis).trim();
  if (until !== null && !wdh.gueltigerTag(until)) fehler.push(`„wiederholung.bis“ ist kein gültiger Tag (YYYY-MM-DD): ${until}.`);
  const count = roh.anzahl === undefined || roh.anzahl === null ? null : roh.anzahl;
  if (count !== null && (count < 1 || count > wdh.MAX_ANZAHL)) fehler.push(`„wiederholung.anzahl“ muss zwischen 1 und ${wdh.MAX_ANZAHL} liegen.`);
  if (until && count) fehler.push('Entweder „wiederholung.bis“ oder „wiederholung.anzahl“, nicht beides.');
  const regel = { freq, interval, byDay: tage.map((t) => TAG_DE_ZU_NORM[t]), until, count };
  if (!fehler.length && startTag) {
    try {
      wdh.regelPruefen(regel, startTag);
    } catch (err) {
      fehler.push(until && until < startTag ? '„wiederholung.bis“ liegt vor dem Beginn.' : err.message);
    }
  }
  return regel;
}

function tagPruefen(feld, wert, fehler) {
  if (wert === undefined || wert === null) return null;
  const s = String(wert).trim();
  if (!wdh.gueltigerTag(s)) {
    fehler.push(`„${feld}“ ist kein gültiger Tag (YYYY-MM-DD).`);
    return null;
  }
  return s;
}

/** Inhaltliche Regeln je Werkzeug, NACH der Typprüfung. Gibt den bereinigten Wert zurück. */
const REGELN = {
  rueckfrage(e, fehler) {
    laenge('frage', e.frage, 3, 300, fehler);
    const optionen = (e.optionen || []).map((o) => o.trim()).filter(Boolean);
    if (optionen.length < 2 || optionen.length > 6) fehler.push('„optionen“ braucht 2 bis 6 Antworten.');
    if (optionen.some((o) => o.length > 80)) fehler.push('Eine Antwortoption ist zu lang (höchstens 80 Zeichen).');
    if (new Set(optionen.map((o) => o.toLowerCase())).size !== optionen.length) fehler.push('Zwei Antwortoptionen sind gleich.');
    return { frage: e.frage.trim(), optionen, mehrfach: e.mehrfach };
  },
  termin_anlegen(e, fehler) {
    laenge('titel', e.titel, 1, 200, fehler);
    const start = zeitLesen(e.start);
    if (!start) fehler.push('„start“ ist kein gültiges Datum (YYYY-MM-DD oder YYYY-MM-DDTHH:MM).');
    let ende = null;
    if (e.ende !== undefined && e.ende !== null && String(e.ende).trim() !== '') {
      ende = zeitLesen(e.ende);
      if (!ende) fehler.push('„ende“ ist kein gültiges Datum (YYYY-MM-DD oder YYYY-MM-DDTHH:MM).');
    }
    if (start && e.ganztaegig === true && start.art !== 'datum') fehler.push('Bei ganztägigen Terminen steht in „start“ nur das Datum (YYYY-MM-DD).');
    if (start && e.ganztaegig === false && start.art !== 'zeit') fehler.push('Ein Termin mit Uhrzeit braucht „start“ als YYYY-MM-DDTHH:MM – oder ganztaegig: true.');
    if (start && ende) {
      if (ende.art !== start.art) fehler.push('„ende“ muss im selben Format stehen wie „start“.');
      else if (ende.ms < start.ms) fehler.push('„ende“ liegt vor „start“.');
    }
    if (e.ort !== undefined) laenge('ort', e.ort, 0, 200, fehler);
    if (e.notiz !== undefined) laenge('notiz', e.notiz, 0, 4000, fehler);
    const wiederholung = wiederholungLesen(e.wiederholung, fehler, start ? start.wert.slice(0, 10) : null);
    return {
      titel: String(e.titel || '').trim(),
      start: start ? start.wert : null,
      ende: ende ? ende.wert : null,
      ganztaegig: e.ganztaegig,
      ort: typeof e.ort === 'string' ? e.ort.trim() : '',
      notiz: typeof e.notiz === 'string' ? e.notiz.trim() : '',
      wiederholung: wiederholung || null,
      erinnerung: e.erinnerung_minuten === undefined || e.erinnerung_minuten === null ? null : e.erinnerung_minuten,
    };
  },
  termine_lesen(e, fehler) {
    const von = tagPruefen('von', e.von, fehler);
    const bis = tagPruefen('bis', e.bis, fehler);
    if (von && bis) {
      if (bis < von) fehler.push('„bis“ liegt vor „von“.');
      else if (wdh.tageZwischen(von, bis) > 400) fehler.push('Höchstens 400 Tage auf einmal – bitte den Zeitraum teilen.');
    }
    if (e.suche !== undefined) laenge('suche', e.suche, 0, 100, fehler);
    const suche = typeof e.suche === 'string' ? e.suche.trim() : '';
    return { von, bis, suche };
  },
  termin_aendern(e, fehler) {
    laenge('id', e.id, 1, 80, fehler);
    const nurAm = tagPruefen('nur_am', e.nur_am, fehler);
    const abAm = tagPruefen('ab_am', e.ab_am, fehler);
    if (nurAm && abAm) fehler.push('Entweder „nur_am“ (ein Vorkommen) oder „ab_am“ (ab einem Vorkommen), nicht beides.');
    if (e.titel !== undefined) laenge('titel', e.titel, 1, 200, fehler);
    let start = null;
    if (e.start !== undefined && e.start !== null) {
      start = zeitLesen(e.start);
      if (!start) fehler.push('„start“ ist kein gültiges Datum (YYYY-MM-DD oder YYYY-MM-DDTHH:MM).');
    }
    let ende = null;
    if (e.end !== undefined && e.end !== null && String(e.end).trim() !== '') {
      ende = zeitLesen(e.end);
      if (!ende) fehler.push('„end“ ist kein gültiges Datum (YYYY-MM-DD oder YYYY-MM-DDTHH:MM).');
    }
    if (start && e.ganztaegig === true && start.art !== 'datum') fehler.push('Bei ganztägigen Terminen steht in „start“ nur das Datum (YYYY-MM-DD).');
    if (start && e.ganztaegig === false && start.art !== 'zeit') fehler.push('Ein Termin mit Uhrzeit braucht „start“ als YYYY-MM-DDTHH:MM.');
    if (!start && e.ganztaegig === false) fehler.push('Beim Wechsel auf „mit Uhrzeit“ bitte „start“ mit Uhrzeit angeben.');
    if (start && ende) {
      if (ende.art !== start.art) fehler.push('„end“ muss im selben Format stehen wie „start“.');
      else if (ende.ms < start.ms) fehler.push('„end“ liegt vor „start“.');
    }
    if (e.ort !== undefined) laenge('ort', e.ort, 0, 200, fehler);
    if (e.notiz !== undefined) laenge('notiz', e.notiz, 0, 4000, fehler);
    const wiederholung = wiederholungLesen(e.wiederholung, fehler, null);
    if (abAm && wiederholung === null) fehler.push('Mit „ab_am“ bleibt es eine Serie – wiederholung: null passt nicht dazu.');
    if (nurAm && wiederholung) fehler.push('Ein einzelnes Vorkommen (nur_am) hat keine eigene Wiederholung – ohne nur_am ändert sich die ganze Serie.');
    const aenderungen = ['titel', 'start', 'end', 'ganztaegig', 'ort', 'notiz', 'wiederholung', 'erinnerung_minuten']
      .filter((k) => e[k] !== undefined && (e[k] !== null || k === 'wiederholung' || k === 'erinnerung_minuten'));
    if (!aenderungen.length) fehler.push('Nichts zu ändern: gib mindestens ein Feld an, das sich ändern soll.');
    return {
      id: String(e.id || '').trim(),
      nurAm,
      abAm,
      titel: typeof e.titel === 'string' ? e.titel.trim() : undefined,
      start: start ? start.wert : undefined,
      end: ende ? ende.wert : undefined,
      ganztaegig: typeof e.ganztaegig === 'boolean' ? e.ganztaegig : undefined,
      ort: typeof e.ort === 'string' ? e.ort.trim() : undefined,
      notiz: typeof e.notiz === 'string' ? e.notiz.trim() : undefined,
      wiederholung,
      erinnerung: e.erinnerung_minuten,
    };
  },
  termin_loeschen(e, fehler) {
    laenge('id', e.id, 1, 80, fehler);
    return { id: String(e.id || '').trim(), nurAm: tagPruefen('nur_am', e.nur_am, fehler) };
  },
  notiz_anlegen(e, fehler) {
    laenge('titel', e.titel, 1, 200, fehler);
    laenge('text', e.text, 1, 20000, fehler);
    const schlagworte = Array.isArray(e.schlagworte)
      ? e.schlagworte.map((s) => s.trim().replace(/^#+/, '')).filter(Boolean)
      : [];
    if (schlagworte.length > 5) fehler.push('Höchstens 5 Schlagworte.');
    if (schlagworte.some((s) => s.length > 40 || /\s/.test(s))) fehler.push('Ein Schlagwort ist zu lang oder enthält Leerzeichen.');
    return { titel: String(e.titel || '').trim(), text: String(e.text || '').trim(), schlagworte };
  },
  merken(e, fehler) {
    laenge('fakt', e.fakt, 3, 500, fehler);
    return { fakt: String(e.fakt || '').trim() };
  },
  projekt_anpassen(e, fehler) {
    laenge('name', e.name, 1, 200, fehler);
    if (e.beschreibung !== undefined) laenge('beschreibung', e.beschreibung, 0, 4000, fehler);
    const aufgaben = Array.isArray(e.aufgaben) ? e.aufgaben.map((a) => a.trim()).filter(Boolean) : [];
    if (aufgaben.length > 20) fehler.push('Höchstens 20 Aufgaben auf einmal.');
    if (aufgaben.some((a) => a.length > 200)) fehler.push('Eine Aufgabe ist zu lang (höchstens 200 Zeichen).');
    return {
      name: String(e.name || '').trim(),
      beschreibung: typeof e.beschreibung === 'string' ? e.beschreibung.trim() : undefined,
      status: e.status,
      aufgaben,
    };
  },
};

/**
 * Eine Werkzeugeingabe streng prüfen.
 *
 * @param {string} name
 * @param {*} eingabe             das geparste `input` des tool_use-Blocks
 * @param {{roh:string, fehler:string}} [parseFehler]  wenn das JSON schon nicht las
 * @returns {{ok:true, wert:object} | {ok:false, fehler:string, roh:string}}
 */
function eingabePruefen(name, eingabe, parseFehler) {
  const def = NACH_NAME.get(name);
  const roh = parseFehler ? parseFehler.roh : safeJson(eingabe);
  if (!def) return { ok: false, fehler: `Unbekanntes Werkzeug „${name}“.`, roh };
  if (parseFehler) return { ok: false, fehler: parseFehler.fehler, roh };
  if (!istObjekt(eingabe)) {
    return { ok: false, fehler: 'Die Eingabe ist kein Objekt.', roh };
  }
  const fehler = [];
  objektPruefen('', def.input_schema, eingabe, fehler);
  if (fehler.length) return { ok: false, fehler: fehler.join(' '), roh };
  const wert = REGELN[name](eingabe, fehler);
  if (fehler.length) return { ok: false, fehler: fehler.join(' '), roh };
  return { ok: true, wert };
}

function safeJson(v) {
  try {
    return JSON.stringify(v === undefined ? null : v);
  } catch {
    return String(v);
  }
}

/**
 * Das Werkzeugergebnis für eine abgelehnte Eingabe, wie die Vorlage es
 * verlangt: `is_error` und `{"INVALID_JSON": "<Rohtext>"}` -- mit
 * JSON.stringify gebaut, nicht zusammengeklebt, damit Anführungszeichen im
 * Rohtext das Ergebnis nicht zerbrechen. `grund` sagt Claude, was zu ändern ist.
 */
function ungueltigErgebnis(toolUseId, pruefung) {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    is_error: true,
    content: JSON.stringify({ INVALID_JSON: pruefung.roh, grund: pruefung.fehler }),
  };
}

/* --------------------------------------------------------- Anzeige */

const WOCHENTAG = ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'];

/** Aus dem Text, nicht aus der Ortszeit: sonst hiesse 02:30 am 29.03. "03:30 Uhr". */
function zeitDeutsch(wert) {
  const z = zeitLesen(wert);
  if (!z) return String(wert || '');
  const d = new Date(z.ms);
  const datum = `${WOCHENTAG[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
  if (z.art === 'datum') return datum;
  return `${datum}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} Uhr`;
}

/** "Di. 29.09.2026, 10:00–10:45 Uhr" -- der Wochentag ausgerechnet, nicht geraten. */
function spanneDeutsch(start, ende) {
  const a = zeitLesen(start);
  const b = zeitLesen(ende);
  if (!a) return String(start || '');
  if (!b) return zeitDeutsch(start);
  if (a.art === 'datum') return b.wert === a.wert ? zeitDeutsch(start) : `${zeitDeutsch(start)} bis ${zeitDeutsch(ende)}`;
  if (b.wert.slice(0, 10) === a.wert.slice(0, 10)) return `${zeitDeutsch(start).replace(/ Uhr$/, '')}–${b.wert.slice(11, 16)} Uhr`;
  return `${zeitDeutsch(start)} bis ${zeitDeutsch(ende)}`;
}

/** Wandzeit als Minutenzahl -- ohne Zeitzone, damit eine Dauer die Zeitumstellung nicht spuert. */
function wandMinuten(wert) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wert);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) / 60000 : null;
}

function ausWandMinuten(min) {
  const d = new Date(min * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * "Verschieb den Zahnarzt auf Freitag": nur der Beginn ist genannt, die Dauer
 * soll bleiben. Ohne das laege das alte Ende vor dem neuen Beginn, und der
 * Termin liesse sich gar nicht verschieben.
 * @returns {string|null|undefined}  undefined = kein Ende zu setzen
 */
function dauerBehalten(altStart, altEnde, neuStart) {
  if (!altEnde) return undefined;
  const a = zeitLesen(altStart);
  const b = zeitLesen(altEnde);
  const n = zeitLesen(neuStart);
  if (!a || !b || !n || a.art !== n.art || b.art !== a.art) return null;
  if (a.art === 'datum') return wdh.plusTage(n.wert, wdh.tageZwischen(a.wert, b.wert));
  return ausWandMinuten(wandMinuten(n.wert) + (wandMinuten(b.wert) - wandMinuten(a.wert)));
}

function kurz(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/* ---------------------------------------------------------- Fabrik */

function nullLogger() {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop };
}

/**
 * @param {{store:object, bus?:object, logger?:Function}} deps
 */
function createWerkzeuge({ store, bus, logger } = {}) {
  if (!store || typeof store.create !== 'function') throw new ValidationError('Die Werkzeuge brauchen den Speicher.');
  const log = typeof logger === 'function' ? logger('werkzeuge') : (logger || nullLogger());

  function publish(name, payload) {
    if (!bus || typeof bus.publish !== 'function') return;
    try { bus.publish(name, payload); } catch (err) { log.warn(`bus.publish(${name}): ${err && err.message}`); }
  }

  /**
   * Eine sichtbare Tätigkeit beginnen: ein `run`-Satz plus Bus-Ereignis.
   *
   * @param {{chatId?:string|null, messageId?:string|null, rolle:string, titel:string, schritt?:string}} p
   * @returns {{runId:string|null, ereignis:()=>object, schritt:(t:string)=>object,
   *            fertig:(ergebnis:string, produced?:string[])=>object, fehler:(t:string)=>object}}
   */
  function aktivitaet({ chatId = null, messageId = null, rolle, titel, schritt = '' }) {
    const beginn = Date.now();
    const zustand = { zustand: 'laeuft', schritt, ergebnis: null, schritte: [] };
    let runId = null;
    if (schritt) zustand.schritte.push({ at: new Date(beginn).toISOString(), text: schritt });
    try {
      const run = store.create('run', {
        agentId: AGENT_ID,
        goal: titel,
        status: 'running',
        steps: zustand.schritte.slice(),
        startedAt: new Date(beginn).toISOString(),
        chatId,
        messageId,
        rolle,
        titel,
        quelle: 'claude',
        dauerMs: 0,
      });
      runId = run.id;
    } catch (err) {
      // Ohne Lauf-Satz bleibt die Tätigkeit trotzdem sichtbar (Bus, Chat).
      log.warn(`Lauf-Satz für „${titel}“ nicht angelegt: ${err && err.message}`);
    }
    const lokaleId = runId || `lauf_${beginn.toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    const ereignis = () => ({
      id: lokaleId,
      runId,
      rolle,
      rolleName: ROLLEN_NAME[rolle] || rolle,
      titel,
      zustand: zustand.zustand,
      schritt: zustand.schritt,
      dauerMs: Date.now() - beginn,
      ergebnis: zustand.ergebnis,
      chatId,
    });

    const speichern = (patch) => {
      if (!runId) return;
      try {
        store.update(runId, { ...patch, steps: zustand.schritte.slice(), dauerMs: Date.now() - beginn });
      } catch (err) {
        log.warn(`Lauf ${runId} nicht fortgeschrieben: ${err && err.message}`);
      }
    };

    const melden = () => {
      const e = ereignis();
      publish('agent.aktivitaet', e);
      return e;
    };

    melden();

    return {
      runId,
      id: lokaleId,
      ereignis,
      schritt(text) {
        zustand.schritt = text;
        zustand.schritte.push({ at: new Date().toISOString(), text });
        speichern({});
        return melden();
      },
      fertig(ergebnis, produced = []) {
        zustand.zustand = 'fertig';
        zustand.schritt = '';
        zustand.ergebnis = ergebnis;
        zustand.schritte.push({ at: new Date().toISOString(), text: ergebnis });
        speichern({ status: 'done', result: ergebnis, finishedAt: new Date().toISOString(), producedIds: produced });
        return melden();
      },
      fehler(text) {
        zustand.zustand = 'fehler';
        zustand.schritt = '';
        zustand.ergebnis = text;
        zustand.schritte.push({ at: new Date().toISOString(), text });
        speichern({ status: 'failed', result: text, error: { message: text }, finishedAt: new Date().toISOString() });
        return melden();
      },
    };
  }

  /**
   * Einen Lauf abschließen, dessen Griff nicht mehr im Speicher ist -- die
   * Rückfrage wartet unter Umständen über einen Neustart hinweg auf ihre
   * Antwort. Liest den Satz, schreibt ihn fort und meldet es wie immer.
   */
  function laufAbschliessen(runId, { zustand, ergebnis }) {
    const run = runId ? store.get(runId) : null;
    if (!run || run.type !== 'run') return null;
    const d = run.data || {};
    const start = Date.parse(d.startedAt || run.createdAt) || Date.now();
    const jetzt = new Date().toISOString();
    const schritte = Array.isArray(d.steps) ? d.steps.slice() : [];
    schritte.push({ at: jetzt, text: ergebnis });
    try {
      store.update(runId, {
        status: zustand === 'fehler' ? 'failed' : 'done',
        result: ergebnis,
        steps: schritte,
        finishedAt: jetzt,
        dauerMs: Date.now() - start,
      });
    } catch (err) {
      log.warn(`Lauf ${runId} nicht abgeschlossen: ${err && err.message}`);
    }
    const e = {
      id: runId,
      runId,
      rolle: d.rolle || 'planung',
      rolleName: ROLLEN_NAME[d.rolle] || d.rolle || 'Planung',
      titel: d.titel || d.goal || '',
      zustand,
      schritt: '',
      dauerMs: Date.now() - start,
      ergebnis,
      chatId: d.chatId || null,
    };
    publish('agent.aktivitaet', e);
    return e;
  }

  function alsAgent(lauf, rolle, fn) {
    const actor = { kind: 'agent', agentId: AGENT_ID, label: `Claude · ${ROLLEN_NAME[rolle] || rolle}` };
    if (lauf && lauf.runId) actor.runId = lauf.runId;
    return withActor(actor, fn);
  }

  const gleich = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

  /* ------------------------------------------------ die Ausführungen */

  /* ------------------------------------------------ Kalender-Helfer */

  /** Ein Termin (Satz der Satzart event) oder ein klarer Satz, warum nicht. */
  function terminHolen(id) {
    const rec = typeof id === 'string' && id ? store.get(id) : null;
    if (!rec || rec.type !== 'event') {
      // NeuralError statt NotFoundError: dessen Satz endet auf Englisch ("… not found").
      throw new NeuralError('NOT_FOUND', `Einen Termin mit der id „${kurz(id, 60)}“ gibt es nicht. Hol dir die id mit termine_lesen.`, { status: 404 });
    }
    return rec;
  }

  function heuteTag() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * Womit sich ein Termin ueberschneidet -- fuer die Antwort an Claude, das
   * es dem Nutzer in einem Satz sagen soll. Bei Serien die Vorkommen der
   * naechsten 90 Tage (ab heute bzw. ab Beginn), hoechstens fuenf Treffer:
   * die Antwort soll einen Hinweis geben, keine Liste.
   */
  function ueberschneidungenFuer(rec) {
    const d = rec.data || {};
    let lagen;
    if (wdh.istSerie(d)) {
      const beginn = d.start.slice(0, 10);
      const ab = beginn > heuteTag() ? beginn : heuteTag();
      lagen = wdh.vorkommenImZeitraum(d, ab, wdh.plusTage(ab, 90), { max: 40 }).slice(0, 40).map((tag) => wdh.aufTagLegen(d, tag));
    } else {
      lagen = [{ start: d.start, end: d.end || null }];
    }
    const treffer = new Map();
    for (const lage of lagen) {
      let liste = [];
      try {
        liste = kalender.ueberschneidungen(store, {
          start: d.allDay ? lage.start.slice(0, 10) : lage.start,
          end: lage.end ? (d.allDay ? lage.end.slice(0, 10) : lage.end) : null,
          ohne: rec.id,
        });
      } catch (err) {
        log.debug(`Überschneidungen für ${rec.id}: ${err && err.message}`);
      }
      for (const x of liste) {
        const key = `${x.id}|${x.occurrence || ''}`;
        if (!treffer.has(key)) treffer.set(key, { id: x.id, titel: x.data.title, wann: spanneDeutsch(x.data.start, x.data.end) });
      }
      if (treffer.size >= 5) break;
    }
    return [...treffer.values()].slice(0, 5);
  }

  /**
   * Welches Vorkommen einer Serie gemeint ist: der gewuenschte Tag, wenn die
   * Serie dort stattfindet, sonst das naechste ab heute, sonst das erste.
   */
  function vorkommenFuer(rec, wunschTag) {
    const d = rec.data;
    if (wunschTag && wdh.istVorkommen(d, wunschTag)) return wunschTag;
    return wdh.naechstesVorkommen(d, heuteTag()) || wdh.naechstesVorkommen(d, String(d.start).slice(0, 10));
  }

  function ueberschneidungSatz(liste) {
    if (!liste.length) return '';
    return ` · überschneidet sich mit ${liste.slice(0, 2).map((u) => `„${kurz(u.titel, 40)}“`).join(', ')}${liste.length > 2 ? ' …' : ''}`;
  }

  function terminKurz(rec) {
    const d = rec.data || {};
    const serie = wdh.istSerie(d);
    return {
      id: rec.id,
      titel: d.title,
      start: d.start,
      end: d.end || null,
      ganztaegig: !!d.allDay,
      wann: spanneDeutsch(d.start, d.end),
      wiederholung: serie ? wdh.inWorten(d.recurrence, d.start.slice(0, 10)) : null,
      erinnerung_minuten: Number.isInteger(d.reminder) ? d.reminder : null,
    };
  }

  /** Zwei Regeln gleich? Woechentlich ohne Tage heisst: der Wochentag des Beginns. */
  function regelSchluessel(regel, startTag) {
    if (!regel || !regel.freq) return 'keine';
    let tage = Array.isArray(regel.byDay) ? regel.byDay : [];
    if (regel.freq === 'weekly' && !tage.length && startTag) tage = [wdh.wochentag(startTag)];
    return JSON.stringify([regel.freq, regel.interval || 1, wdh.WOCHENTAGE.filter((t) => tage.includes(t)), regel.until || null, regel.count || null]);
  }

  /**
   * Steht dieser Termin (gleicher Titel, gleicher Beginn) schon da -- als
   * Einzeltermin, als Beginn einer Serie oder als eines ihrer Vorkommen?
   * Ueber den Zeitraum gesucht, damit auch "Training am Dienstag 18 Uhr" zu
   * einer bestehenden Serie gefunden wird.
   */
  function gleicherTermin(w) {
    const tag = w.start.slice(0, 10);
    let liste = [];
    try {
      liste = kalender.eventsInRange(store, tag, tag);
    } catch (err) {
      log.debug(`Doppelte suchen: ${err && err.message}`);
    }
    const x = liste.find((e) => gleich(e.data.title, w.titel) && e.data.start === w.start);
    if (!x) return null;
    const rec = store.get(x.id);
    if (!rec) return null;
    return { rec, erstes: !x.recurring || String(x.serie && x.serie.start) === w.start };
  }

  /**
   * Derselbe Termin ein zweites Mal: nicht doppelt anlegen -- aber auch
   * nicht still verschlucken, was neu ist. "Ach, das ist jeden Dienstag"
   * nach dem Einzeltermin heisst: die Wiederholung gehoert dazu. Genannte
   * Felder, die abweichen, werden am vorhandenen Termin ergaenzt (als
   * Agentenaenderung, also rueckgaengig zu machen), und Claude erfaehrt,
   * was ergaenzt wurde. Eine vorhandene Notiz wird nie ueberschrieben.
   *
   * Trifft der Aufruf ein SPAETERES Vorkommen einer Serie ("am 3.11.
   * Training 19 bis 21 Uhr in Halle 5"), gelten die Abweichungen nur fuer
   * diesen Tag: das Vorkommen wird geloest (wie termin_aendern mit nur_am),
   * die Serie bleibt. Frueher wurden Ende, Ort und Erinnerung hier still
   * verworfen, und Claude bestaetigte dem Nutzer, was nicht im Kalender stand.
   */
  function schonDa(treffer, w, lauf) {
    const { rec, erstes } = treffer;
    const d = rec.data || {};
    const startTag = String(d.start || '').slice(0, 10);
    // Das Vorkommen, das gemeint ist: bei einem spaeteren Vorkommen dessen
    // Lage, sonst der Termin selbst. "wann" und der Vergleich beziehen sich
    // darauf -- nicht auf den Beginn der Serie Wochen vorher.
    const tag = erstes ? null : w.start.slice(0, 10);
    const lage = tag ? wdh.aufTagLegen(d, tag) : { start: d.start, end: d.end || null };
    const patch = {};
    const ergaenzt = [];
    if (!erstes && w.wiederholung && regelSchluessel(w.wiederholung, startTag) !== regelSchluessel(d.recurrence, startTag)) {
      // Ein Vorkommen einer ANDEREN Serie: eine neue Serie ab hier ist gemeint.
      return null;
    }
    const endeNeu = w.ende && !(w.ganztaegig && w.ende === w.start) ? w.ende : null;
    if (endeNeu && endeNeu !== (lage.end || null)) { patch.end = endeNeu; ergaenzt.push('Ende'); }
    if (w.ort && w.ort !== (d.location || '')) { patch.location = w.ort; ergaenzt.push('Ort'); }
    if (w.notiz && !String(d.body || '').trim()) { patch.body = w.notiz; ergaenzt.push('Notiz'); }
    if (erstes && w.wiederholung && regelSchluessel(w.wiederholung, startTag) !== regelSchluessel(d.recurrence, startTag)) {
      patch.recurrence = w.wiederholung;
      ergaenzt.push('Wiederholung');
    }
    if (w.erinnerung !== null && w.erinnerung !== d.reminder) { patch.reminder = w.erinnerung; ergaenzt.push('Erinnerung'); }
    const stempel = { runId: lauf.runId || undefined, agentId: AGENT_ID };
    let nachher = rec;
    if (ergaenzt.length) {
      nachher = alsAgent(lauf, 'kalender', () => kalender.updateEvent(store, rec.id, patch, tag ? { nur: tag, stempel } : {}));
    }
    const kurzform = terminKurz(nachher);
    const wann = tag && !ergaenzt.length ? spanneDeutsch(lage.start, lage.end) : kurzform.wann;
    const ueber = ergaenzt.length ? ueberschneidungenFuer(nachher) : [];
    const liste = ergaenzt.join(', ');
    const serieWorte = tag ? wdh.inWorten(d.recurrence, startTag) : '';
    let hinweis;
    if (tag && ergaenzt.length) {
      hinweis = `Das ist ein Vorkommen der Serie „${kurz(d.title, 60)}“ (${serieWorte}). Nur für diesen Tag übernommen: ${liste}. `
        + 'Es ist jetzt ein eigener Termin mit neuer id; die Serie bleibt, wie sie war.';
    } else if (ergaenzt.length) {
      hinweis = `Stand schon im Kalender (gleicher Titel und Beginn). Nicht doppelt angelegt, sondern ergänzt: ${liste}.`;
    } else {
      hinweis = erstes ? 'Stand schon genau so im Kalender; nichts doppelt angelegt.'
        : `Das ist schon ein Vorkommen der Serie „${kurz(d.title, 60)}“ (${serieWorte}); nichts doppelt angelegt.`;
    }
    return {
      inhalt: {
        ok: true,
        schonDa: true,
        id: nachher.id,
        ...(tag ? { vorkommen: tag, serie: rec.id } : {}),
        wann,
        ...(kurzform.wiederholung ? { wiederholung: kurzform.wiederholung } : {}),
        ergaenzt,
        ...(ergaenzt.length ? { ueberschneidungen: ueber } : {}),
        hinweis,
      },
      ergebnis: ergaenzt.length
        ? `${kurz(w.titel, 50)} ergänzt (${liste}${tag ? ', nur dieses Mal' : ''}) · ${kurzform.wann}${kurzform.wiederholung ? ` · ${kurzform.wiederholung}` : ''}`
        : `Stand schon im Kalender: ${w.titel}, ${zeitDeutsch(w.start)}`,
      produced: ergaenzt.length ? [nachher.id] : [],
    };
  }

  /* ------------------------------------------------ die Ausführungen */

  const AUSFUEHRUNG = {
    termin_anlegen(w, k, lauf) {
      const treffer = gleicherTermin(w);
      const doppelt = treffer ? schonDa(treffer, w, lauf) : null;
      if (doppelt) return doppelt;
      // Ueber dieselbe Pruefung wie die Oberflaeche (src/http/api/events.js):
      // ein Termin, den die KI anlegt, ist nicht weniger streng geprueft als
      // einer, den der Nutzer eintippt.
      const ev = alsAgent(lauf, 'kalender', () => kalender.createEvent(store, {
        title: w.titel,
        start: w.start,
        end: w.ende,
        allDay: w.ganztaegig,
        location: w.ort,
        body: w.notiz,
        chatId: k.chatId || null,
        source: 'auto',
        recurrence: w.wiederholung,
        reminder: w.erinnerung,
      }, { stempel: { runId: lauf.runId || undefined, agentId: AGENT_ID } }));
      const kurzform = terminKurz(ev);
      const ueber = ueberschneidungenFuer(ev);
      const inhalt = {
        ok: true,
        id: ev.id,
        titel: w.titel,
        start: ev.data.start,
        ende: ev.data.end,
        wann: kurzform.wann,
        // Der Beginn lag auf keinem der Wochentage und wurde auf das erste
        // echte Vorkommen gelegt (src/kalender/wiederholung.js). Claude soll
        // den Tag bestaetigen, der wirklich im Kalender steht.
        ...(ev.data.start !== w.start
          ? { hinweis_beginn: `Der genannte Beginn liegt auf keinem der Wochentage; die Serie beginnt am ${zeitDeutsch(ev.data.start)}.` }
          : {}),
        ...(kurzform.wiederholung ? { wiederholung: kurzform.wiederholung } : {}),
        ...(kurzform.erinnerung_minuten !== null ? { erinnerung_minuten: kurzform.erinnerung_minuten } : {}),
        ueberschneidungen: ueber,
        hinweis: ueber.length
          ? 'Steht jetzt im Kalender. Er überschneidet sich mit den genannten Terminen – sag das dem Nutzer in einem Satz.'
          : 'Steht jetzt im Kalender.',
      };
      return {
        inhalt,
        ergebnis: `${w.titel} · ${kurzform.wann}${kurzform.wiederholung ? ` · ${kurzform.wiederholung}` : ''}${ueberschneidungSatz(ueber)}`,
        produced: [ev.id],
      };
    },

    termine_lesen(w) {
      const suche = w.suche.toLowerCase();
      const alle = kalender.eventsInRange(store, w.von, w.bis);
      const passend = suche
        ? alle.filter((x) => [x.data.title, x.data.location, x.data.body].some((t) => String(t || '').toLowerCase().includes(suche)))
        : alle;
      const GRENZE = 150;
      const termine = passend.slice(0, GRENZE).map((x) => ({
        id: x.id,
        titel: x.data.title,
        start: x.data.start,
        end: x.data.end || null,
        ort: x.data.location || null,
        wiederkehrend: !!x.recurring,
        vorkommen: x.occurrence || null,
        wann: spanneDeutsch(x.data.start, x.data.end),
        // Der Beginn der GANZEN Serie: ohne ihn haelt Claude das erste
        // Vorkommen im Zeitraum fuer den Anfang der Serie.
        ...(x.recurring ? {
          serie_start: x.serie ? x.serie.start : x.data.start,
          serie_end: x.serie ? x.serie.end : null,
          wiederholung: wdh.inWorten(x.data.recurrence, String(x.serie && x.serie.start || x.data.start).slice(0, 10)),
        } : {}),
      }));
      const inhalt = { ok: true, von: w.von, bis: w.bis, anzahl: passend.length, termine };
      if (passend.length > GRENZE) {
        inhalt.weitere = passend.length - GRENZE;
        inhalt.hinweis = 'Nicht alle gezeigt – für den Rest den Zeitraum verkleinern oder suche benutzen.';
      }
      const was = suche ? ` zu „${kurz(w.suche, 30)}“` : '';
      return {
        inhalt,
        ergebnis: passend.length ? `${passend.length} Termin${passend.length === 1 ? '' : 'e'}${was} gefunden` : `Keine Termine${was}`,
        produced: [],
      };
    },

    termin_aendern(w, k, lauf) {
      const vorher = terminHolen(w.id);
      const titelAlt = kurz(vorher.data.title, 60);
      const serie = wdh.istSerie(vorher.data);
      if (w.abAm && !serie) {
        throw new ValidationError(`„${titelAlt}“ wiederholt sich nicht – ab_am gibt es nur bei Serien.`);
      }
      const s0 = serie ? wdh.wandzeitLesen(vorher.data.start).tag : null;
      // Das Vorkommen, auf das sich start/end beziehen. Bei einer ganzen
      // Serie ist es das, dessen Tag in start (oder end) steht -- so, wie
      // Claude es aus termine_lesen kennt.
      let bezug = w.nurAm || w.abAm || null;
      if (serie && !bezug && (w.start !== undefined || w.end !== undefined)) {
        const kandidaten = [];
        if (w.start !== undefined) kandidaten.push(w.start.slice(0, 10));
        else {
          const endTag = w.end.slice(0, 10);
          kandidaten.push(endTag, wdh.plusTage(endTag, -wdh.spanneTage(vorher.data)));
        }
        bezug = kandidaten.find((t) => t === s0 || wdh.istVorkommen(vorher.data, t)) || null;
        if (!bezug) {
          throw new ValidationError(`Am ${zeitDeutsch(kandidaten[0])} findet „${titelAlt}“ nicht statt. `
            + 'Bei einer Serie beziehen sich start und end auf ein Vorkommen aus termine_lesen; die ganze Serie verschiebt sich dann um den Unterschied. '
            + 'Für einen anderen Wochentag: ab_am (oder nur_am) mit dem Tag des Vorkommens, und in start der neue Tag.');
        }
      }
      const basis = bezug ? { ...vorher.data, ...wdh.aufTagLegen(vorher.data, bezug) } : vorher.data;
      // "Verschieb den Zahnarzt auf Freitag": Claude schickt oft nur den Tag.
      // Hat der Termin eine Uhrzeit und sagt niemand "ganztaegig", bleibt die
      // Uhrzeit -- frueher wurde der Termin still ganztaegig, und 10:00-10:45
      // war verloren, obwohl niemand das wollte.
      let neuStart = w.start;
      let neuEnde = w.end;
      let uhrzeitBehalten = null;
      const basisMitZeit = !basis.allDay && !!wdh.wandzeitLesen(basis.start) && wdh.wandzeitLesen(basis.start).zeit !== '';
      const nurTag = (t) => typeof t === 'string' && t.length === 10;
      if (w.ganztaegig === undefined && (nurTag(neuStart) || nurTag(neuEnde)) && !basis.allDay) {
        if (!basisMitZeit) {
          throw new ValidationError(`„${titelAlt}“ hat eine Uhrzeit. Bitte start als YYYY-MM-DDTHH:MM angeben – oder ganztaegig: true, wenn er ganztägig werden soll.`);
        }
        const zeitStart = wdh.wandzeitLesen(basis.start).zeit;
        const endeAlt = basis.end ? wdh.wandzeitLesen(basis.end) : null;
        if (nurTag(neuStart)) neuStart = `${neuStart}${zeitStart}`;
        if (nurTag(neuEnde)) {
          if (endeAlt && endeAlt.zeit) neuEnde = `${neuEnde}${endeAlt.zeit}`;
          else neuEnde = undefined; // kein altes Ende mit Uhrzeit: die Dauer ergibt sich unten
        }
        uhrzeitBehalten = `Nur ein Tag genannt – die Uhrzeit ${zeitStart.slice(1, 6)}${endeAlt && endeAlt.zeit ? `–${endeAlt.zeit.slice(1, 6)}` : ''} ist geblieben. `
          + 'Soll er ganztägig werden: ganztaegig: true.';
      }
      const patch = {};
      if (w.titel !== undefined) patch.title = w.titel;
      if (neuStart !== undefined) patch.start = neuStart;
      if (neuEnde !== undefined) patch.end = neuEnde;
      else if (neuStart !== undefined) {
        const ende = dauerBehalten(basis.start, basis.end, neuStart);
        if (ende !== undefined) patch.end = ende;
      }
      if (w.ganztaegig !== undefined) patch.allDay = w.ganztaegig;
      if (w.ort !== undefined) patch.location = w.ort;
      if (w.notiz !== undefined) patch.body = w.notiz;
      if (w.wiederholung !== undefined) patch.recurrence = w.wiederholung;
      if (w.erinnerung !== undefined) patch.reminder = w.erinnerung;
      const stempel = { runId: lauf.runId || undefined, agentId: AGENT_ID };
      let rec;
      let geteilt = false;
      if (serie && !w.nurAm) {
        // Ab einem spaeteren Vorkommen: die neue Serie beginnt dort.
        const teil = w.abAm && w.abAm !== s0 ? wdh.abTagTeilen(vorher.data, w.abAm) : null;
        const serienDaten = teil ? { ...vorher.data, ...teil.neu } : vorher.data;
        if (bezug && (patch.start !== undefined || patch.end !== undefined)) {
          // Die neue Lage des Vorkommens auf die Serie umrechnen: sie
          // verschiebt sich um den Unterschied, ihr Beginn und ihre Anzahl
          // bleiben (siehe wiederholung.serieVerschieben).
          const v = wdh.serieVerschieben(serienDaten, bezug, {
            start: patch.start !== undefined ? patch.start : basis.start,
            end: Object.prototype.hasOwnProperty.call(patch, 'end') ? patch.end : undefined,
          }, { eigeneRegel: patch.recurrence !== undefined });
          patch.start = v.start;
          if (v.end !== undefined) patch.end = v.end;
          if (v.recurrence && patch.recurrence === undefined) patch.recurrence = v.recurrence;
          if (v.exdates) patch.exdates = v.exdates;
        }
        if (teil) {
          rec = alsAgent(lauf, 'kalender', () => kalender.aendernAb(store, vorher, w.abAm, patch, { stempel })).record;
          geteilt = true;
        } else {
          rec = alsAgent(lauf, 'kalender', () => kalender.updateEvent(store, vorher.id, patch, { stempel }));
        }
      } else {
        rec = alsAgent(lauf, 'kalender', () => kalender.updateEvent(store, vorher.id, patch, { nur: w.nurAm || null, stempel }));
      }
      const unveraendert = !geteilt && rec.id === vorher.id && rec.rev === vorher.rev;
      const kurzform = terminKurz(rec);
      // Bei einer Serie nennt "wann" das Vorkommen, um das es ging (dessen
      // neue Lage), sonst das naechste -- nicht den Beginn der Serie im
      // Januar. Claude bestaetigt dem Nutzer genau diesen Satz.
      const vorkommen = wdh.istSerie(rec.data)
        ? vorkommenFuer(rec, neuStart !== undefined ? neuStart.slice(0, 10) : bezug)
        : null;
      if (vorkommen) {
        const lage = wdh.aufTagLegen(rec.data, vorkommen);
        kurzform.wann = spanneDeutsch(lage.start, lage.end);
      }
      const ueber = ueberschneidungenFuer(rec);
      const inhalt = {
        ok: true,
        id: rec.id,
        ...(w.nurAm ? { nur_am: w.nurAm, serie: vorher.id, hinweis_serie: 'Nur dieses Vorkommen geändert; es ist jetzt ein eigener Termin mit neuer id. Die Serie bleibt.' } : {}),
        ...(geteilt ? {
          ab_am: w.abAm,
          serie_bisher: vorher.id,
          hinweis_serie: `Ab ${zeitDeutsch(w.abAm)} gilt die Änderung; das ist eine neue Serie mit neuer id. `
            + 'Die früheren Vorkommen bleiben unter der alten id, wie sie waren.',
        } : {}),
        titel: rec.data.title,
        start: rec.data.start,
        end: rec.data.end || null,
        ...(vorkommen ? { vorkommen } : {}),
        wann: kurzform.wann,
        ...(kurzform.wiederholung ? { wiederholung: kurzform.wiederholung } : {}),
        erinnerung_minuten: kurzform.erinnerung_minuten,
        ...(uhrzeitBehalten ? { hinweis_uhrzeit: uhrzeitBehalten } : {}),
        ueberschneidungen: ueber,
        hinweis: unveraendert
          ? 'Nichts geändert – der Termin stand schon so im Kalender.'
          : (ueber.length ? 'Geändert. Er überschneidet sich mit den genannten Terminen – sag das in einem Satz.' : 'Geändert.'),
      };
      const wieOft = w.nurAm ? ' (nur dieses Mal)' : geteilt ? ` (ab ${zeitDeutsch(w.abAm)})` : '';
      return {
        inhalt,
        ergebnis: unveraendert
          ? `${kurz(rec.data.title, 50)}: nichts zu ändern`
          : `${kurz(rec.data.title, 50)} → ${kurzform.wann}${wieOft}${vorkommen && kurzform.wiederholung && !w.nurAm ? ` · ${kurzform.wiederholung}` : ''}${ueberschneidungSatz(ueber)}`,
        produced: unveraendert ? [] : [rec.id],
      };
    },

    termin_loeschen(w, k, lauf) {
      const vorher = terminHolen(w.id);
      const { ausgelassen, mitgeloescht } = alsAgent(lauf, 'kalender', () => kalender.deleteEvent(store, vorher.id, { nur: w.nurAm || null }));
      const titel = kurz(vorher.data.title, 60);
      if (ausgelassen) {
        return {
          inhalt: { ok: true, id: vorher.id, ausgelassen, hinweis: `Nur am ${zeitDeutsch(ausgelassen)} fällt „${titel}“ aus; die Serie bleibt.` },
          ergebnis: `„${titel}“ fällt am ${zeitDeutsch(ausgelassen)} aus`,
          produced: [],
        };
      }
      const n = mitgeloescht.length;
      const samt = n ? `, samt ${n === 1 ? 'einem verschobenen Vorkommen' : `${n} verschobenen Vorkommen`}` : '';
      return {
        inhalt: {
          ok: true,
          id: vorher.id,
          geloescht: true,
          ...(n ? { mitgeloescht: mitgeloescht.map((r) => ({ id: r.id, titel: r.data.title, wann: spanneDeutsch(r.data.start, r.data.end) })) } : {}),
          hinweis: `Gelöscht${samt}. Lässt sich im Verlauf rückgängig machen.`,
        },
        ergebnis: `„${titel}“ gelöscht${samt}`,
        produced: [],
      };
    },

    notiz_anlegen(w, k, lauf) {
      const note = alsAgent(lauf, 'notizen', () => store.create('note', {
        title: w.titel,
        body: w.text,
        tags: w.schlagworte,
        source: 'auto',
        chatId: k.chatId || null,
        runId: lauf.runId || undefined,
        agentId: AGENT_ID,
      }));
      return {
        inhalt: { ok: true, id: note.id, titel: w.titel, hinweis: 'Notiz angelegt.' },
        ergebnis: `Notiz „${kurz(w.titel, 60)}“`,
        produced: [note.id],
      };
    },

    merken(w, k, lauf) {
      const vorhanden = store.all('memory').find((m) => gleich(m.data.text, w.fakt));
      if (vorhanden) {
        return {
          inhalt: { ok: true, schonBekannt: true, hinweis: 'Das war schon bekannt.' },
          ergebnis: `War schon bekannt: ${kurz(w.fakt, 60)}`,
          produced: [],
        };
      }
      const mem = alsAgent(lauf, 'gedaechtnis', () => store.create('memory', {
        text: w.fakt,
        scope: 'global',
        importance: 1,
        sourceId: k.chatId || null,
        source: 'auto',
        runId: lauf.runId || undefined,
        agentId: AGENT_ID,
      }));
      return {
        inhalt: { ok: true, id: mem.id, hinweis: 'Gemerkt.' },
        ergebnis: `Gemerkt: ${kurz(w.fakt, 60)}`,
        produced: [mem.id],
      };
    },

    projekt_anpassen(w, k, lauf) {
      const produced = [];
      let projekt = store.all('project').find((p) => gleich(p.data.name, w.name));
      let neu = false;
      alsAgent(lauf, 'projekte', () => {
        if (projekt) {
          const patch = {};
          if (w.beschreibung !== undefined && w.beschreibung !== projekt.data.description) patch.description = w.beschreibung;
          if (w.status && w.status !== projekt.data.status) patch.status = w.status;
          if (Object.keys(patch).length) projekt = store.update(projekt.id, patch);
        } else {
          neu = true;
          projekt = store.create('project', {
            name: w.name,
            description: w.beschreibung || '',
            status: w.status || 'active',
            source: 'auto',
            chatId: k.chatId || null,
            runId: lauf.runId || undefined,
            agentId: AGENT_ID,
          });
        }
        produced.push(projekt.id);
        const schonDa = store.list('task', { filter: { projectId: projekt.id } }).items;
        for (const titel of w.aufgaben) {
          if (schonDa.some((t) => gleich(t.data.title, titel))) continue;
          const task = store.create('task', {
            title: titel,
            projectId: projekt.id,
            source: 'auto',
            chatId: k.chatId || null,
            runId: lauf.runId || undefined,
            agentId: AGENT_ID,
          });
          produced.push(task.id);
        }
      });
      const neueAufgaben = produced.length - 1;
      const teile = [neu ? `Projekt „${kurz(w.name, 50)}“ angelegt` : `Projekt „${kurz(w.name, 50)}“ aktualisiert`];
      if (neueAufgaben > 0) teile.push(`${neueAufgaben} Aufgabe${neueAufgaben === 1 ? '' : 'n'}`);
      return {
        inhalt: { ok: true, id: projekt.id, neu, neueAufgaben, hinweis: neu ? 'Projekt angelegt.' : 'Projekt aktualisiert.' },
        ergebnis: teile.join(' · '),
        produced,
      };
    },
  };

  const terminTitel = (id) => {
    const rec = typeof id === 'string' && id ? store.get(id) : null;
    return rec && rec.type === 'event' ? kurz(rec.data.title, 50) : 'Termin';
  };

  const TITEL = {
    termin_anlegen: (w) => `Termin: ${kurz(w.titel, 60)}`,
    termine_lesen: (w) => (w.suche ? `Kalender: sucht „${kurz(w.suche, 40)}“` : `Kalender: ${zeitDeutsch(w.von)} bis ${zeitDeutsch(w.bis)}`),
    termin_aendern: (w) => `Termin ändern: ${terminTitel(w.id)}`,
    termin_loeschen: (w) => `Termin löschen: ${terminTitel(w.id)}`,
    notiz_anlegen: (w) => `Notiz: ${kurz(w.titel, 60)}`,
    merken: (w) => `Merkt sich: ${kurz(w.fakt, 60)}`,
    projekt_anpassen: (w) => `Projekt: ${kurz(w.name, 60)}`,
    rueckfrage: (w) => `Rückfrage: ${kurz(w.frage, 60)}`,
  };

  const SCHRITT = {
    termin_anlegen: 'Trägt in den Kalender ein',
    termine_lesen: 'Liest den Kalender',
    termin_aendern: 'Ändert den Termin',
    termin_loeschen: 'Löscht den Termin',
    notiz_anlegen: 'Schreibt die Notiz',
    merken: 'Merkt es sich',
    projekt_anpassen: 'Pflegt das Projekt',
  };

  /**
   * Einen tool_use-Block ausführen (nicht `rueckfrage` -- die wartet auf den
   * Nutzer und wird vom Chat-Dienst behandelt).
   *
   * Gibt das tool_result für Claude zurück und die Agenten-Ereignisse, die
   * der Chat an den Browser weiterreicht. Wirft nie: ein Fehler beim
   * Ausführen wird zu einem tool_result mit is_error.
   *
   * @param {{id:string, name:string, input:object}} block
   * @param {{roh:string, fehler:string}|undefined} parseFehler
   * @param {{chatId?:string, messageId?:string}} kontext
   * @returns {{toolResult:object, ereignisse:object[], produced:string[]}}
   */
  function ausfuehren(block, parseFehler, kontext = {}) {
    const name = block.name;
    const rolle = ROLLEN[name] || 'planung';
    const pruefung = eingabePruefen(name, block.input, parseFehler);
    if (!pruefung.ok) {
      const lauf = aktivitaet({
        chatId: kontext.chatId, messageId: kontext.messageId, rolle,
        titel: `${ROLLEN_NAME[rolle] || rolle}: Eingabe ungültig`, schritt: 'Prüft die Eingabe',
      });
      const e = lauf.fehler(`Nicht ausgeführt – die Eingabe war ungültig: ${kurz(pruefung.fehler, 160)}`);
      return { toolResult: ungueltigErgebnis(block.id, pruefung), ereignisse: [e], produced: [], ungueltig: true };
    }
    const w = pruefung.wert;
    const lauf = aktivitaet({
      chatId: kontext.chatId, messageId: kontext.messageId, rolle,
      titel: TITEL[name] ? TITEL[name](w) : name, schritt: SCHRITT[name] || '',
    });
    const ereignisse = [lauf.ereignis()];
    try {
      const r = AUSFUEHRUNG[name](w, kontext, lauf);
      ereignisse.push(lauf.fertig(r.ergebnis, r.produced));
      return {
        toolResult: { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(r.inhalt) },
        ereignisse,
        produced: r.produced,
      };
    } catch (err) {
      const e = asNeuralError(err);
      log.warn(`Werkzeug ${name} gescheitert: ${e.message}`);
      ereignisse.push(lauf.fehler(`Gescheitert: ${kurz(e.message, 160)}`));
      return {
        toolResult: { type: 'tool_result', tool_use_id: block.id, is_error: true, content: JSON.stringify({ fehler: e.message }) },
        ereignisse,
        produced: [],
      };
    }
  }

  return {
    definitionen: DEFINITIONEN,
    ausfuehren,
    aktivitaet,
    laufAbschliessen,
    pruefen: eingabePruefen,
    titel: (name, w) => (TITEL[name] ? TITEL[name](w) : name),
  };
}

module.exports = {
  createWerkzeuge,
  DEFINITIONEN,
  ROLLEN,
  ROLLEN_NAME,
  AGENT_ID,
  eingabePruefen,
  ungueltigErgebnis,
  istEigenesWerkzeug,
  zeitLesen,
  zeitDeutsch,
};
