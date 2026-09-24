'use strict';

/**
 * Kalender, Nachbesserung Runde 3 (Server und Werkzeuge): Maengel, die die
 * Pruefer im echten Ablauf gefunden haben. Jeder Test war vor der Aenderung
 * rot (gegen den Stand vor Runde 3 laufen gelassen).
 *
 *  1. "ab jetzt montags" schob das genannte "bis 30.10." auf den 2.11.
 *  2. "Alle 2 Wochen Sa+So" einen Tag spaeter landete jeden zweiten Montag
 *     in der falschen Woche -- jetzt ein Satz statt einer falschen Serie
 *     (Orakel ueber viele Regeln und Verschiebungen).
 *  3. POST/PATCH nahmen unbekannte Felder still an ("ende" -> ohne Ende).
 *  4. Ein Formular mit altem Stand ueberschrieb, was Claude inzwischen
 *     geaendert hatte (rev -> 409).
 *  5. termin_aendern mit nur einem Datum machte den Termin still ganztaegig.
 *  6. Nach dem Aendern einer Serie nannte "wann" den Beginn im Januar.
 *  7. Der Satz zu until+count nannte Feldnamen, die im Formular niemand sieht.
 *  8. Fruehjahrs-Zeitumstellung: Sortierung und Ueberschneidungen in ms.
 *  9. Steuerzeichen standen unmaskiert in der Kalenderdatei.
 * 10. Nach ab_am blieb ein verlegtes Vorkommen stehen, wenn die Fortsetzung
 *     geloescht wurde.
 * 11. Projekte: eine laufende Serie verschwand aus "naechster Termin",
 *     sobald das heutige Vorkommen vorbei war.
 */

const assert = require('node:assert/strict');
const http = require('node:http');

const { test, tempHome } = require('./harness');
const w = require('../src/kalender/wiederholung');
const ics = require('../src/kalender/ics');
const kalender = require('../src/http/api/events');
const { createWerkzeuge } = require('../src/models/werkzeuge');

function request(base, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(method !== 'GET' && method !== 'HEAD' ? { 'x-neural-os': '1' } : {}),
      },
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* nicht jede Antwort ist JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${urlPath}: keine Antwort nach 5 s`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Echte Anwendung, Werkzeuge ohne Claude davor, Zeitzone Berlin. */
async function mitApp(fn, { tz = 'Europe/Berlin' } = {}) {
  const vorherTz = process.env.TZ;
  process.env.TZ = tz;
  const { createApp } = require('../src/app');
  const { home, cleanup } = tempHome('nos-kal-r3');
  let app = null;
  try {
    app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    const store = app.store;
    const chat = store.create('chat', { title: 'Termine' });
    const werkzeuge = createWerkzeuge({ store, bus: app.bus });
    let n = 0;
    const rufe = (name, input) => {
      n += 1;
      const r = werkzeuge.ausfuehren({ id: `toolu_${n}`, name, input }, undefined, { chatId: chat.id });
      return { fehler: r.toolResult.is_error === true, inhalt: JSON.parse(r.toolResult.content) };
    };
    const r = (method, pfad, body) => request(base, method, pfad, body);
    const tage = (id, von = '2026-09-01', bis = '2027-03-31') => kalender.eventsInRange(store, von, bis)
      .filter((x) => x.id === id).map((x) => x.data.start);
    return await fn({ app, store, base, rufe, r, tage, history: app.history });
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
    if (vorherTz === undefined) delete process.env.TZ;
    else process.env.TZ = vorherTz;
  }
}

/* ------------------------------------------ 1. "bis" bleibt stehen */

test('„Ab jetzt montags“: das genannte „bis 30.10.“ bleibt, kein Termin am 2.11.', async () => {
  await mitApp(async ({ rufe, tage }) => {
    const a = rufe('termin_anlegen', {
      titel: 'Nachhilfe', start: '2026-10-02T16:00', ende: '2026-10-02T17:00', ganztaegig: false,
      wiederholung: { rhythmus: 'woechentlich', bis: '2026-10-30' },
    });
    assert.equal(a.fehler, false, JSON.stringify(a.inhalt));
    assert.equal(tage(a.inhalt.id).length, 5, 'fuenf Freitage bis zum 30.10.');
    const b = rufe('termin_aendern', { id: a.inhalt.id, ab_am: '2026-10-02', start: '2026-10-05T16:00' });
    assert.equal(b.fehler, false, JSON.stringify(b.inhalt));
    const liste = tage(a.inhalt.id);
    assert.ok(liste.every((s) => s.slice(0, 10) <= '2026-10-30'), `nichts nach dem 30.10.: ${liste.join(', ')}`);
    assert.deepEqual(liste, ['2026-10-05T16:00', '2026-10-12T16:00', '2026-10-19T16:00', '2026-10-26T16:00']);
    assert.match(b.inhalt.wiederholung, /bis 30\.10\.2026/);
  });
});

/* -------------------------- 2. Wochengrenze bei "alle N Wochen" */

/** Kleiner, fester Zufall: derselbe Lauf, dieselben Faelle. */
function zufall(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

test('Orakel: eine verschobene Serie hat genau die verschobenen Vorkommen -- oder es gibt einen Satz, nie eine still falsche Serie', () => {
  const rnd = zufall(20260924);
  let geprueft = 0;
  let abgelehnt = 0;
  for (let fall = 0; fall < 400; fall += 1) {
    const interval = 1 + Math.floor(rnd() * 3);
    const byDay = w.WOCHENTAGE.filter(() => rnd() < 0.4);
    if (!byDay.length) byDay.push(w.WOCHENTAGE[Math.floor(rnd() * 7)]);
    const d = Math.floor(rnd() * 7) - 3;
    if (!d) continue;
    // Beginn auf das erste echte Vorkommen legen, wie checkEvent es tut.
    const roh = { start: '2026-10-05T18:00', end: '2026-10-05T19:00', recurrence: { freq: 'weekly', interval, byDay, until: null, count: null }, exdates: [] };
    const daten = { ...roh, ...(w.beginnAufVorkommen(roh) || {}) };
    const s0 = daten.start.slice(0, 10);
    const bezug = w.vorkommenImZeitraum(daten, s0, w.plusTage(s0, 60))[0];
    const neuTag = w.plusTage(bezug, d);
    let v;
    try {
      v = w.serieVerschieben(daten, bezug, { start: `${neuTag}T18:00`, end: `${neuTag}T19:00` });
    } catch (err) {
      assert.equal(err.code, 'VALIDATION_FAILED', String(err));
      assert.match(err.message, /Woche/);
      abgelehnt += 1;
      continue;
    }
    const nachher = { ...daten, ...v };
    const von = w.plusTage(s0, 14);
    const bis = w.plusTage(s0, 200);
    const erwartet = w.vorkommenImZeitraum(daten, w.plusTage(von, -10), w.plusTage(bis, 10))
      .map((t) => w.plusTage(t, d)).filter((t) => t >= von && t <= bis);
    const ist = w.vorkommenImZeitraum(nachher, von, bis);
    assert.deepEqual(ist, erwartet, `interval ${interval}, ${byDay.join('+')}, ${d > 0 ? '+' : ''}${d} Tage`);
    geprueft += 1;
  }
  assert.ok(geprueft > 150, `genug Faelle gerechnet (${geprueft})`);
  assert.ok(abgelehnt > 10, `und genug Faelle ueber die Wochengrenze gesehen (${abgelehnt})`);
});

test('„Alle 2 Wochen Sa+So“ einen Tag später: Claude bekommt einen Satz, die Serie bleibt, wie sie war', async () => {
  await mitApp(async ({ rufe, tage }) => {
    const a = rufe('termin_anlegen', {
      titel: 'Wochenenddienst', start: '2026-10-03T08:00', ende: '2026-10-03T16:00', ganztaegig: false,
      wiederholung: { rhythmus: 'woechentlich', alle: 2, wochentage: ['SA', 'SO'] },
    });
    const vorher = tage(a.inhalt.id, '2026-10-01', '2026-11-15');
    const b = rufe('termin_aendern', { id: a.inhalt.id, ab_am: '2026-10-03', start: '2026-10-04T08:00' });
    assert.equal(b.fehler, true, 'nicht still speichern');
    assert.match(b.inhalt.fehler || JSON.stringify(b.inhalt), /nächste Woche/);
    assert.deepEqual(tage(a.inhalt.id, '2026-10-01', '2026-11-15'), vorher);
    // Eine Verschiebung, bei der alle Tage in ihrer Woche bleiben, geht weiter.
    const c = rufe('termin_aendern', { id: a.inhalt.id, start: '2026-10-03T09:00' });
    assert.equal(c.fehler, false, JSON.stringify(c.inhalt));
  });
});

/* ----------------------------------- 3. unbekannte Felder -> 400 */

test('POST/PATCH /api/events: ein unbekanntes Feld ist ein 400 mit Satz, nicht still ein Termin ohne Ende', async () => {
  await mitApp(async ({ r, store }) => {
    const ende = await r('POST', '/api/events', { title: 'Zahnarzt', start: '2026-10-08T10:00', ende: '2026-10-08T11:30', ort: 'Praxis' });
    assert.equal(ende.status, 400, ende.text);
    assert.match(ende.json.error.message, /Unbekanntes Feld „ende“ – hier heißt es „end“/);
    const farbe = await r('POST', '/api/events', { title: 'Yoga', start: '2026-10-04T09:00', farbe: 'blau' });
    assert.equal(farbe.status, 400);
    const huelle = await r('POST', '/api/events', { data: { title: 'Yoga', start: '2026-10-04T09:00', farbe: 'blau' } });
    assert.equal(huelle.status, 400);
    assert.equal(store.all('event').length, 0, 'nichts angelegt');

    const ok = await r('POST', '/api/events', { title: 'Zahnarzt', start: '2026-10-08T10:00', end: '2026-10-08T11:30' });
    assert.equal(ok.status, 200, ok.text);
    const id = ok.json.record.id;
    const patch = await r('PATCH', `/api/events/${id}`, { title: 'Friseur Anna', farbe: 'rot' });
    assert.equal(patch.status, 400);
    assert.equal(store.get(id).data.title, 'Zahnarzt', 'nichts geaendert');
    const tipp = await r('PATCH', `/api/events/${id}`, { endTime: '2026-10-08T12:00' });
    assert.equal(tipp.status, 400);
    assert.match(tipp.json.error.message, /„end“/);
  });
});

/* ------------------------------------ 4. Stand (rev) -> 409 */

test('Formular mit altem Stand: 409 statt still überschreiben, was Claude inzwischen geändert hat', async () => {
  await mitApp(async ({ r, rufe, store }) => {
    const a = await r('POST', '/api/events', { title: 'Zahnarzt', start: '2026-10-08T10:00', end: '2026-10-08T10:45', location: 'Praxis Weber' });
    const id = a.json.record.id;
    const geladen = a.json.record.rev;
    const claude = rufe('termin_aendern', { id, start: '2026-10-08T14:00' });
    assert.equal(claude.fehler, false);
    const alt = await r('PATCH', `/api/events/${id}`, {
      title: 'Zahnarzt', start: '2026-10-08T10:00', end: '2026-10-08T10:45', location: 'Praxis Weber, 2. OG', rev: geladen,
    });
    assert.equal(alt.status, 409, alt.text);
    assert.match(alt.json.error.message, /inzwischen geändert/);
    assert.equal(store.get(id).data.start, '2026-10-08T14:00', 'Claudes Verschiebung bleibt');
    // Mit dem aktuellen Stand geht es; nur der Ort aendert sich.
    const neu = await r('PATCH', `/api/events/${id}`, { location: 'Praxis Weber, 2. OG', rev: store.get(id).rev });
    assert.equal(neu.status, 200, neu.text);
    assert.equal(store.get(id).data.start, '2026-10-08T14:00');
    assert.equal(store.get(id).data.location, 'Praxis Weber, 2. OG');
    const falsch = await r('PATCH', `/api/events/${id}`, { location: 'x', rev: 'drei' });
    assert.equal(falsch.status, 400);
  });
});

/* ------------------------------ 5. nur ein Datum -> Uhrzeit bleibt */

test('termin_aendern mit nur einem Datum: die Uhrzeit bleibt (Einzeltermin und nur_am), nie still ganztägig', async () => {
  await mitApp(async ({ rufe, store }) => {
    const a = rufe('termin_anlegen', { titel: 'Zahnarzt', start: '2026-09-29T10:00', ende: '2026-09-29T10:45', ganztaegig: false });
    const b = rufe('termin_aendern', { id: a.inhalt.id, start: '2026-10-02' });
    assert.equal(b.fehler, false, JSON.stringify(b.inhalt));
    const d = store.get(a.inhalt.id).data;
    assert.equal(d.allDay, false);
    assert.equal(d.start, '2026-10-02T10:00');
    assert.equal(d.end, '2026-10-02T10:45');
    assert.match(b.inhalt.wann, /Fr\. 02\.10\.2026, 10:00–10:45 Uhr/);
    assert.match(b.inhalt.hinweis_uhrzeit, /10:00–10:45/);

    const s = rufe('termin_anlegen', {
      titel: 'Training', start: '2026-10-06T18:00', ende: '2026-10-06T19:30', ganztaegig: false,
      wiederholung: { rhythmus: 'woechentlich' },
    });
    const c = rufe('termin_aendern', { id: s.inhalt.id, nur_am: '2026-10-06', start: '2026-10-08' });
    assert.equal(c.fehler, false, JSON.stringify(c.inhalt));
    const einzel = store.get(c.inhalt.id).data;
    assert.equal(einzel.allDay, false);
    assert.equal(einzel.start, '2026-10-08T18:00');
    assert.equal(einzel.end, '2026-10-08T19:30');
    // Wer ganztaegig will, sagt es.
    const g = rufe('termin_aendern', { id: a.inhalt.id, start: '2026-10-03', ganztaegig: true });
    assert.equal(g.fehler, false);
    assert.equal(store.get(a.inhalt.id).data.allDay, true);
  });
});

/* ------------------------- 6. "wann" nennt das geaenderte Vorkommen */

test('Nach dem Ändern einer ganzen Serie nennt „wann“ das Vorkommen (29.09.), nicht den Beginn im Januar', async () => {
  await mitApp(async ({ rufe, app }) => {
    const a = rufe('termin_anlegen', {
      titel: 'Training', start: '2026-01-06T18:00', ende: '2026-01-06T19:30', ganztaegig: false,
      wiederholung: { rhythmus: 'woechentlich' },
    });
    const b = rufe('termin_aendern', { id: a.inhalt.id, start: '2026-09-29T19:00' });
    assert.equal(b.fehler, false, JSON.stringify(b.inhalt));
    assert.equal(b.inhalt.vorkommen, '2026-09-29');
    assert.match(b.inhalt.wann, /^Di\. 29\.09\.2026, 19:00–20:30 Uhr$/);
    // Die Schrittliste, die der Nutzer sieht (run.result):
    const lauf = app.store.all('run').find((x) => /Training →/.test(String(x.data.result || '')));
    assert.ok(lauf, 'Lauf mit Ergebnis gefunden');
    assert.doesNotMatch(lauf.data.result, /06\.01\.2026/);
    assert.match(lauf.data.result, /29\.09\.2026.*jeden Dienstag/);
  });
});

/* ------------------------------------ 7. Satz ohne Feldnamen */

test('until und count zugleich: der Satz nennt keine Feldnamen', () => {
  assert.throws(() => w.regelPruefen({ freq: 'weekly', until: '2026-11-17', count: 10 }, '2026-09-29'), (err) => {
    assert.match(err.message, /nicht beides/);
    assert.doesNotMatch(err.message, /until|count/);
    return true;
  });
});

/* ------------------------------ 8. Fruehjahrs-Zeitumstellung */

test('29.03. (Berlin): 02:30 steht vor 03:15, und 02:30–02:50 überschneidet 03:35 nicht', async () => {
  await mitApp(async ({ r, store }) => {
    await r('POST', '/api/events', { title: 'Nachtdienst Uebergabe', start: '2026-03-29T02:30', end: '2026-03-29T02:50' });
    await r('POST', '/api/events', { title: 'Kaffee', start: '2026-03-29T03:15', end: '2026-03-29T03:25' });
    const liste = await r('GET', '/api/events/zeitraum?from=2026-03-29&to=2026-03-29');
    assert.deepEqual(liste.json.items.map((x) => x.data.title), ['Nachtdienst Uebergabe', 'Kaffee']);
    const u = await r('GET', '/api/events/ueberschneidungen?start=2026-03-29T03:35&end=2026-03-29T03:40');
    assert.equal(u.status, 200, u.text);
    assert.deepEqual(u.json.items.map((x) => x.data.title), []);
    const u2 = kalender.ueberschneidungen(store, { start: '2026-03-29T02:40', end: '2026-03-29T02:45' });
    assert.deepEqual(u2.map((x) => x.data.title), ['Nachtdienst Uebergabe']);
  });
});

/* ----------------------------------------- 9. Steuerzeichen */

test('Steuerzeichen: beim Speichern entfernt, und auch alter Bestand steht nicht in der Kalenderdatei', async () => {
  await mitApp(async ({ r, store }) => {
    const a = await r('POST', '/api/events', { title: 'Steuer\u000b\u0000', start: '2026-10-09', location: 'Amt\u000cZimmer 3', body: 'x\u0007y\nzweite Zeile' });
    assert.equal(a.status, 200, a.text);
    const d = store.get(a.json.record.id).data;
    assert.equal(d.title, 'Steuer');
    assert.equal(d.location, 'Amt Zimmer 3');
    assert.equal(d.body, 'xy\nzweite Zeile');
    // Alter Bestand, an der Pruefung vorbei geschrieben:
    const alt = store.create('event', { title: 'Alt\u0000\u0007', start: '2026-10-10', allDay: true, location: 'A\u000cB', body: 'p\u001bq', source: 'user' });
    const text = ics.kalenderDatei([alt], { name: 'Neural OS' });
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(text.replace(/\r\n/g, ''), /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
    assert.match(text, /SUMMARY:Alt\r\n/);
    assert.match(text, /LOCATION:A B\r\n/);
  });
});

/* --------------- 10. ab_am haengt verlegte Vorkommen um */

test('Nach ab_am gehört ein verlegtes Vorkommen zur Fortsetzung: Löschen nimmt es mit, Rückgängig stellt alles her', async () => {
  await mitApp(async ({ rufe, store, history }) => {
    const a = rufe('termin_anlegen', {
      titel: 'Training', start: '2026-10-06T18:00', ende: '2026-10-06T19:30', ganztaegig: false,
      wiederholung: { rhythmus: 'woechentlich', bis: '2026-12-22' },
    });
    const verlegt = rufe('termin_aendern', { id: a.inhalt.id, nur_am: '2026-10-20', start: '2026-10-21T18:00' });
    assert.equal(verlegt.fehler, false, JSON.stringify(verlegt.inhalt));
    const neu = rufe('termin_aendern', { id: a.inhalt.id, ab_am: '2026-10-13', start: '2026-10-13T19:00' });
    assert.equal(neu.fehler, false, JSON.stringify(neu.inhalt));
    assert.equal(store.get(verlegt.inhalt.id).data.ausSerie.id, neu.inhalt.id, 'haengt an der Fortsetzung');
    const weg = rufe('termin_loeschen', { id: neu.inhalt.id });
    assert.equal(weg.fehler, false);
    assert.match(weg.inhalt.hinweis, /samt einem verschobenen Vorkommen/);
    assert.equal(store.get(verlegt.inhalt.id), null, 'das verlegte Training ist mit weg');

    // Rueckgaengig (Loeschen, dann Teilen): alles wie vorher.
    const eintraege = history.list({ type: 'event', limit: 20 }).items;
    await history.undo(eintraege.find((e) => e.id === neu.inhalt.id && e.canUndo).seq);
    assert.ok(store.get(verlegt.inhalt.id), 'verlegtes Vorkommen wieder da');
    const zweite = history.list({ type: 'event', limit: 20 }).items.find((e) => e.id === neu.inhalt.id && e.canUndo);
    await history.undo(zweite.seq);
    assert.equal(store.get(verlegt.inhalt.id).data.ausSerie.id, a.inhalt.id, 'nach dem Zuruecknehmen wieder an der alten Serie');
  });
});

/* ------------------------ 11. Projekt: naechstes Vorkommen nach Uhrzeit */

test('Projekt um 21:03: das heutige Training 19–20 Uhr ist vorbei, „nächster Termin“ ist nächste Woche', async () => {
  await mitApp(async ({ store }) => {
    const rec = store.create('event', {
      title: 'Training', start: '2026-09-17T19:00', end: '2026-09-17T20:00', allDay: false,
      recurrence: { freq: 'weekly', interval: 1, byDay: [], until: null, count: null }, exdates: [], source: 'user',
    });
    const jetzt = new Date(2026, 8, 24, 21, 3).getTime();
    const e = kalender.lightEvent(rec, '2026-09-24', jetzt);
    assert.equal(e.occurrence, '2026-10-01');
    assert.equal(e.start, '2026-10-01T19:00');
    const frueh = kalender.lightEvent(rec, '2026-09-24', new Date(2026, 8, 24, 18, 0).getTime());
    assert.equal(frueh.occurrence, '2026-09-24', 'vor 19 Uhr ist es noch heute');
  });
});
