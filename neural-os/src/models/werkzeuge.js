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
 *   sie schon gibt.
 */

const { withActor } = require('../kernel/actor');
const { ValidationError, asNeuralError } = require('../kernel/errors');

const AGENT_ID = 'claude';

/** Rolle je Werkzeug (Vertrag 7). */
const ROLLEN = Object.freeze({
  rueckfrage: 'planung',
  termin_anlegen: 'kalender',
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

/**
 * Die Definitionen, wie sie an Claude gehen. Reihenfolge und Wortlaut sind
 * Teil des gecachten Präfixes: nicht pro Anfrage verändern.
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
      + 'Sind Tag oder Uhrzeit unklar, frag vorher mit rueckfrage.',
    {
      titel: { type: 'string', description: 'Kurzer Titel, z. B. „Zahnarzt“.' },
      start: { type: 'string', description: 'Beginn: YYYY-MM-DD bei ganztägigen Terminen, sonst YYYY-MM-DDTHH:MM in Ortszeit.' },
      ende: { type: 'string', description: 'Ende im selben Format wie start. Weglassen, wenn unbekannt.' },
      ganztaegig: { type: 'boolean', description: 'true für Termine ohne Uhrzeit (Fristen, Geburtstage, Ferien).' },
      ort: { type: 'string', description: 'Ort, falls genannt.' },
      notiz: { type: 'string', description: 'Weitere Angaben, falls genannt.' },
    },
    ['titel', 'start', 'ganztaegig'],
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

function typPruefen(feld, def, wert, fehler) {
  if (def.type === 'string') {
    if (typeof wert !== 'string') fehler.push(`„${feld}“ muss Text sein.`);
    else if (def.enum && !def.enum.includes(wert)) fehler.push(`„${feld}“ muss eines von ${def.enum.join(', ')} sein.`);
    return;
  }
  if (def.type === 'boolean') {
    if (typeof wert !== 'boolean') fehler.push(`„${feld}“ muss true oder false sein.`);
    return;
  }
  if (def.type === 'array') {
    if (!Array.isArray(wert)) fehler.push(`„${feld}“ muss eine Liste sein.`);
    else if (def.items && def.items.type === 'string' && wert.some((x) => typeof x !== 'string')) {
      fehler.push(`„${feld}“ darf nur Text enthalten.`);
    }
  }
}

const DATUM = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZEITPUNKT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** 'YYYY-MM-DD' oder 'YYYY-MM-DDTHH:MM' -> {art, wert, ms} oder null, wenn es den Tag/die Uhrzeit nicht gibt. */
function zeitLesen(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  let m = DATUM.exec(s);
  if (m) {
    const [j, mo, t] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const d = new Date(j, mo - 1, t);
    if (j < 1900 || j > 2200 || d.getFullYear() !== j || d.getMonth() !== mo - 1 || d.getDate() !== t) return null;
    return { art: 'datum', wert: s, ms: d.getTime() };
  }
  m = ZEITPUNKT.exec(s);
  if (m) {
    const [j, mo, t, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
    const d = new Date(j, mo - 1, t, h, mi);
    if (j < 1900 || j > 2200 || h > 23 || mi > 59 || d.getFullYear() !== j || d.getMonth() !== mo - 1 || d.getDate() !== t) return null;
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
    return {
      titel: String(e.titel || '').trim(),
      start: start ? start.wert : null,
      ende: ende ? ende.wert : null,
      ganztaegig: e.ganztaegig,
      ort: typeof e.ort === 'string' ? e.ort.trim() : '',
      notiz: typeof e.notiz === 'string' ? e.notiz.trim() : '',
    };
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
  if (!eingabe || typeof eingabe !== 'object' || Array.isArray(eingabe)) {
    return { ok: false, fehler: 'Die Eingabe ist kein Objekt.', roh };
  }
  const schema = def.input_schema;
  const fehler = [];
  for (const key of Object.keys(eingabe)) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) fehler.push(`Unbekanntes Feld „${key}“.`);
  }
  for (const key of schema.required) {
    if (eingabe[key] === undefined || eingabe[key] === null) fehler.push(`Pflichtfeld „${key}“ fehlt.`);
  }
  for (const [key, feldDef] of Object.entries(schema.properties)) {
    if (eingabe[key] === undefined || eingabe[key] === null) continue;
    typPruefen(key, feldDef, eingabe[key], fehler);
  }
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

function zeitDeutsch(wert) {
  const z = zeitLesen(wert);
  if (!z) return String(wert || '');
  const d = new Date(z.ms);
  const datum = `${WOCHENTAG[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  if (z.art === 'datum') return datum;
  return `${datum}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} Uhr`;
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

  const AUSFUEHRUNG = {
    termin_anlegen(w, k, lauf) {
      const vorhanden = store.all('event').find((ev) => gleich(ev.data.title, w.titel) && ev.data.start === w.start);
      if (vorhanden) {
        return {
          inhalt: { ok: true, schonDa: true, id: vorhanden.id, hinweis: 'Dieser Termin stand schon im Kalender; nichts doppelt angelegt.' },
          ergebnis: `Stand schon im Kalender: ${w.titel}, ${zeitDeutsch(w.start)}`,
          produced: [],
        };
      }
      const ev = alsAgent(lauf, 'kalender', () => store.create('event', {
        title: w.titel,
        start: w.start,
        end: w.ende,
        allDay: w.ganztaegig,
        location: w.ort,
        body: w.notiz,
        chatId: k.chatId || null,
        source: 'auto',
        runId: lauf.runId || undefined,
        agentId: AGENT_ID,
      }));
      return {
        inhalt: { ok: true, id: ev.id, titel: w.titel, start: w.start, ende: w.ende, hinweis: 'Steht jetzt im Kalender.' },
        ergebnis: `${w.titel} · ${zeitDeutsch(w.start)}`,
        produced: [ev.id],
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

  const TITEL = {
    termin_anlegen: (w) => `Termin: ${kurz(w.titel, 60)}`,
    notiz_anlegen: (w) => `Notiz: ${kurz(w.titel, 60)}`,
    merken: (w) => `Merkt sich: ${kurz(w.fakt, 60)}`,
    projekt_anpassen: (w) => `Projekt: ${kurz(w.name, 60)}`,
    rueckfrage: (w) => `Rückfrage: ${kurz(w.frage, 60)}`,
  };

  const SCHRITT = {
    termin_anlegen: 'Trägt in den Kalender ein',
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
