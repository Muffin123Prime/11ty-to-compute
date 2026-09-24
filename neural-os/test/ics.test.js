'use strict';

/**
 * Kalenderdateien (src/kalender/ics.js und die Routen dafuer).
 *
 * Zweck der Datei: auf dem iPad in Safari antippen -> "Zum Kalender
 * hinzufuegen". Die Kalender-App sagt nicht, warum sie eine Datei ablehnt
 * oder einen Tag verschluckt; deshalb wird hier jede Normregel einzeln
 * geprueft UND die Datei mit einem kleinen, unabhaengig geschriebenen Leser
 * zurueckgelesen. Der Leser steht absichtlich hier und nicht in ics.js: ein
 * Fehler, den Schreiber und Leser teilen (etwa ein vergessenes Komma beim
 * Maskieren), faellt nur auf, wenn der Leser nicht vom Schreiber abstammt.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { test, tempHome } = require('./harness');
const ics = require('../src/kalender/ics');

/* -------------------------------------------------------- der Leser */

/**
 * RFC 5545 lesen, so weit diese Dateien es brauchen: entfalten (CRLF + ein
 * Leerzeichen/Tab), Komponenten verschachteln, Parameter abtrennen, Text
 * entmaskieren.
 */
function lesen(text) {
  assert.ok(!/(^|[^\r])\n/.test(text), 'jede Zeile endet mit CRLF, nie mit einem nackten LF');
  const logisch = text.replace(/\r\n[ \t]/g, '').split('\r\n').filter((z) => z !== '');
  const wurzel = { name: 'ROOT', props: [], kinder: [] };
  const stapel = [wurzel];
  for (const zeile of logisch) {
    const doppelpunkt = zeile.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const kopf = zeile.slice(0, doppelpunkt);
    const wert = zeile.slice(doppelpunkt + 1);
    const [name, ...paramTeile] = kopf.split(';');
    const params = Object.fromEntries(paramTeile.map((p) => p.split('=')));
    if (name === 'BEGIN') {
      const k = { name: wert, props: [], kinder: [] };
      stapel[stapel.length - 1].kinder.push(k);
      stapel.push(k);
    } else if (name === 'END') {
      assert.equal(stapel.pop().name, wert, `END:${wert} schliesst die richtige Komponente`);
    } else {
      stapel[stapel.length - 1].props.push({ name, params, wert });
    }
  }
  assert.equal(stapel.length, 1, 'alle Komponenten geschlossen');
  return wurzel.kinder;
}

function entmaskieren(wert) {
  return wert.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

const prop = (komp, name) => komp.props.find((p) => p.name === name);
const events = (kal) => kal.kinder.filter((k) => k.name === 'VEVENT');

function termin(data, extra = {}) {
  return {
    id: 'event_0123456789abcdefghij',
    type: 'event',
    createdAt: '2026-09-20T08:00:00.000Z',
    updatedAt: '2026-09-21T09:30:00.000Z',
    data: { title: 'Termin', start: '2026-10-20T18:00', end: null, allDay: false, location: '', body: '', recurrence: null, exdates: [], reminder: null, ...data },
    ...extra,
  };
}

/* ------------------------------------------------------------ Regeln */

test('Faltung zaehlt Oktette, nicht Zeichen -- und schneidet nie in ein Umlaut-Zeichen', () => {
  const titel = 'Größere Übung für Jürgen, Özlem und Ärzte: äöüß äöüß äöüß äöüß äöüß äöüß äöüß äöüß äöüß äöüß ÄÖÜ – Ende';
  const text = ics.kalenderDatei([termin({ title: titel })]);
  for (const zeile of text.split('\r\n')) {
    assert.ok(Buffer.byteLength(zeile, 'utf8') <= 75, `${Buffer.byteLength(zeile, 'utf8')} Oktette: ${zeile}`);
    // Ein halbes UTF-8-Zeichen ergaebe beim Dekodieren U+FFFD.
    assert.ok(!Buffer.from(zeile, 'utf8').toString('utf8').includes('�'));
  }
  const summary = text.split('\r\n').filter((z) => z.startsWith('SUMMARY') || z.startsWith(' '));
  assert.ok(summary.length >= 3, 'die lange Zeile ist wirklich gefaltet');
  // Gegenprobe: gezaehlt in Zeichen, waeren Zeilen ueber 75 Oktette entstanden.
  assert.ok(Buffer.byteLength(titel.slice(0, 75), 'utf8') > 75);
  const [kal] = lesen(text);
  assert.equal(entmaskieren(prop(events(kal)[0], 'SUMMARY').wert), titel);
});

test('Komma, Semikolon, Backslash und Zeilenumbruch werden maskiert', () => {
  const text = ics.kalenderDatei([termin({
    title: 'Treffen; Raum 2, Etage\\3',
    location: 'Praxis Dr. Weiß, 2. OG; Eingang B',
    body: 'Zeile eins\nZeile zwei\r\nZeile drei',
  })]);
  assert.match(text, /SUMMARY:Treffen\\; Raum 2\\, Etage\\\\3\r\n/);
  assert.match(text, /LOCATION:Praxis Dr\. Weiß\\, 2\. OG\\; Eingang B\r\n/);
  assert.match(text, /DESCRIPTION:Zeile eins\\nZeile zwei\\nZeile drei\r\n/);
  const ev = events(lesen(text)[0])[0];
  assert.equal(entmaskieren(prop(ev, 'SUMMARY').wert), 'Treffen; Raum 2, Etage\\3');
  assert.equal(entmaskieren(prop(ev, 'LOCATION').wert), 'Praxis Dr. Weiß, 2. OG; Eingang B');
  assert.equal(entmaskieren(prop(ev, 'DESCRIPTION').wert), 'Zeile eins\nZeile zwei\nZeile drei');
});

test('Ganztaegig: DTEND ist exklusiv (der Tag NACH dem letzten); Uhrzeit ist fliessende Ortszeit ohne TZID', () => {
  const [kal] = lesen(ics.kalenderDatei([
    termin({ title: 'Urlaub', start: '2026-10-03', end: '2026-10-05', allDay: true }, { id: 'event_urlaub00000000000000' }),
    termin({ title: 'Geburtstag', start: '2026-10-09', end: null, allDay: true }, { id: 'event_geburtstag000000000' }),
    termin({ title: 'Zahnarzt', start: '2026-10-20T10:00', end: '2026-10-20T10:45' }, { id: 'event_zahnarzt00000000000' }),
  ]));
  const [urlaub, geburtstag, zahnarzt] = events(kal);
  assert.deepEqual([prop(urlaub, 'DTSTART').params, prop(urlaub, 'DTSTART').wert], [{ VALUE: 'DATE' }, '20261003']);
  assert.equal(prop(urlaub, 'DTEND').wert, '20261006', '„vom 3. bis 5.“ endet exklusiv am 6.');
  assert.equal(prop(geburtstag, 'DTEND').wert, '20261010', 'ein Tag ohne Ende ist genau ein Tag');
  assert.equal(prop(zahnarzt, 'DTSTART').wert, '20261020T100000');
  assert.deepEqual(prop(zahnarzt, 'DTSTART').params, {}, 'kein TZID');
  assert.ok(!/Z$/.test(prop(zahnarzt, 'DTSTART').wert), 'kein Z: fliessend');
  assert.equal(prop(zahnarzt, 'DTEND').wert, '20261020T104500');
  assert.equal(prop(zahnarzt, 'UID').wert, 'event_zahnarzt00000000000@neural-os');
  assert.match(prop(zahnarzt, 'DTSTAMP').wert, /^\d{8}T\d{6}Z$/);
  // Ohne Ende keine erfundene Dauer.
  const [ohne] = events(lesen(ics.kalenderDatei([termin({ start: '2026-10-20T10:00', end: null })]))[0]);
  assert.equal(prop(ohne, 'DTEND'), undefined);
});

test('Serien: RRULE und EXDATE im Werttyp von DTSTART; Erinnerung als VALARM', () => {
  const [kal] = lesen(ics.kalenderDatei([
    termin({
      title: 'Training', start: '2026-09-29T18:00', end: '2026-09-29T19:30', reminder: 30,
      recurrence: { freq: 'weekly', interval: 1, byDay: [], until: '2026-12-24', count: null },
      exdates: ['2026-10-27', '2026-11-10'],
    }, { id: 'event_training0000000000' }),
    termin({
      title: 'Kurs', start: '2026-10-05', allDay: true, reminder: 1440,
      recurrence: { freq: 'weekly', interval: 2, byDay: ['MO', 'TH'], until: null, count: 6 },
      exdates: ['2026-10-19'],
    }, { id: 'event_kurs00000000000000' }),
    termin({ title: 'Sofort', start: '2026-10-01T09:00', reminder: 0 }, { id: 'event_sofort000000000000' }),
  ]));
  const [training, kurs, sofort] = events(kal);
  assert.equal(prop(training, 'RRULE').wert, 'FREQ=WEEKLY;UNTIL=20261224T235959', 'UNTIL als Ortszeit, der 24. eingeschlossen');
  assert.equal(prop(training, 'EXDATE').wert, '20261027T180000,20261110T180000', 'mit der Uhrzeit von DTSTART');
  assert.deepEqual(prop(training, 'EXDATE').params, {});
  const alarm = training.kinder.find((k) => k.name === 'VALARM');
  assert.equal(prop(alarm, 'TRIGGER').wert, '-PT30M');
  assert.equal(prop(alarm, 'ACTION').wert, 'DISPLAY');
  assert.equal(prop(kurs, 'RRULE').wert, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=6');
  assert.deepEqual([prop(kurs, 'EXDATE').params, prop(kurs, 'EXDATE').wert], [{ VALUE: 'DATE' }, '20261019']);
  assert.equal(prop(kurs.kinder[0], 'TRIGGER').wert, '-PT15H', 'ganztägig: am Vortag um 9 Uhr, nicht um Mitternacht');
  assert.equal(ics.ausloeser(0, true), 'PT9H', 'ganztägig „zum Beginn“ = 9 Uhr am Tag');
  assert.equal(ics.ausloeser(1440, false), '-P1D');
  assert.equal(ics.ausloeser(120, false), '-PT2H');
  assert.equal(ics.ausloeser(90, false), '-PT1H30M');
  assert.equal(prop(sofort.kinder[0], 'TRIGGER').wert, 'PT0S');
  assert.equal(prop(sofort, 'RRULE'), undefined, 'kein RRULE ohne Serie');
  // Die Kalender-Huelle.
  assert.equal(prop(kal, 'VERSION').wert, '2.0');
  assert.ok(prop(kal, 'PRODID').wert.length > 0);
  assert.equal(prop(kal, 'METHOD').wert, 'PUBLISH');
});

test('Ein sauberer Dateiname -- nichts, was den Kopf der Antwort zerbricht', () => {
  assert.equal(ics.dateiname('Zahnarzt Dr. Weiß'), 'zahnarzt-dr-weiss.ics');
  assert.equal(ics.dateiname('Über „Grüße“ / Ärger\r\n"x"'), 'ueber-gruesse-aerger-x.ics');
  assert.equal(ics.dateiname('!!!'), 'termin.ics');
  assert.equal(ics.dateiname('Café crème'), 'cafe-creme.ics');
  assert.ok(ics.dateiname('x'.repeat(200)).length <= 64);
});

/* ------------------------------------------------------------ Routen */

function anfrage(base, method, pfad, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pfad, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method, hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(method !== 'GET' ? { 'x-neural-os': '1' } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* kein JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), bytes: buf.length, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('GET /api/events/:id/ics und /api/events/export.ics liefern text/calendar zum Hinzufuegen', async () => {
  const { createApp, seedIfEmpty } = require('../src/app');
  const { home, cleanup } = tempHome('nos-ics');
  let app = null;
  try {
    app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false });
    await seedIfEmpty(app);
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    const t = await anfrage(base, 'POST', '/api/events', {
      title: 'Training, Halle 3', start: '2026-09-29T18:00', end: '2026-09-29T19:30',
      recurrence: { freq: 'weekly', until: '2026-12-24' }, reminder: 60,
    });
    assert.equal(t.status, 200, t.text);
    const id = t.json.record.id;
    await anfrage(base, 'POST', '/api/events', { title: 'Zahnarzt Dr. Weiß', start: '2026-10-02T10:00' });

    const eins = await anfrage(base, 'GET', `/api/events/${id}/ics`);
    assert.equal(eins.status, 200, eins.text);
    assert.equal(eins.headers['content-type'], 'text/calendar; charset=utf-8');
    assert.equal(eins.headers['content-disposition'], 'attachment; filename="training-halle-3.ics"');
    assert.equal(Number(eins.headers['content-length']), eins.bytes, 'Länge in Bytes, nicht in Zeichen');
    const [kal] = lesen(eins.text);
    const [ev] = events(kal);
    assert.equal(prop(ev, 'UID').wert, `${id}@neural-os`);
    assert.equal(entmaskieren(prop(ev, 'SUMMARY').wert), 'Training, Halle 3');
    assert.equal(prop(ev, 'RRULE').wert, 'FREQ=WEEKLY;UNTIL=20261224T235959');
    assert.equal(prop(ev.kinder[0], 'TRIGGER').wert, '-PT1H');

    const alle = await anfrage(base, 'GET', '/api/events/export.ics?from=2026-10-01&to=2026-10-31');
    assert.equal(alle.status, 200, alle.text);
    assert.match(alle.headers['content-disposition'], /^attachment; filename="neural-os-2026-10-01-bis-2026-10-31\.ics"$/);
    const titel = events(lesen(alle.text)[0]).map((e) => entmaskieren(prop(e, 'SUMMARY').wert)).sort();
    assert.deepEqual(titel, ['Training, Halle 3', 'Zahnarzt Dr. Weiß'], 'die Serie EINMAL (als Regel), nicht je Dienstag');

    assert.equal((await anfrage(base, 'GET', '/api/events/event_00000000000000000000/ics')).status, 404);
    assert.equal((await anfrage(base, 'GET', '/api/events/export.ics?from=2020-01-01&to=2026-01-01')).status, 400, 'höchstens 400 Tage');
  } finally {
    if (app) await app.close().catch(() => {});
    cleanup();
  }
});
