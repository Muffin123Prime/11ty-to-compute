'use strict';

/**
 * Der Termin-Agent: Claude liest, legt an, verschiebt und loescht Termine
 * SELBST -- ueber die Werkzeuge aus src/models/werkzeuge.js.
 *
 * Jeder Test laeuft gegen die echte Anwendung (createApp, echter Tresor,
 * echter HTTP-Server, echter Aenderungsverlauf) und gegen den Statisten aus
 * test/claude-statist.js, der die Anthropic-Schnittstelle spricht und die
 * Werkzeugaufrufe so in Stuecken streamt, wie ein echtes Modell es taete.
 * Einen echten Schluessel gibt es hier nicht; kein Test verlaesst 127.0.0.1.
 *
 * Was der Statist NICHT beweist: dass Claude diese Aufrufe von selbst so
 * waehlt. Er beweist, dass Neural OS sie richtig ausfuehrt, prueft,
 * zurueckmeldet und rueckgaengig machen kann, wenn Claude sie so waehlt.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { test, tempHome } = require('./harness');
const { starten, B, antwort } = require('./claude-statist');
const { createApp, seedIfEmpty } = require('../src/app');

/* --------------------------------------------------------------- Helfer */

function anfrage(base, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
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
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Einen Ereignisstrom lesen, bis der Server ihn schliesst. */
async function strom(base, urlPath, body) {
  const r = await anfrage(base, 'POST', urlPath, body);
  const ereignisse = [];
  for (const block of r.text.split('\n\n')) {
    let name = null;
    const daten = [];
    for (const zeile of block.split('\n')) {
      if (zeile.startsWith('event: ')) name = zeile.slice(7);
      else if (zeile.startsWith('data: ')) daten.push(zeile.slice(6));
    }
    if (name && daten.length) ereignisse.push({ name, data: JSON.parse(daten.join('\n')) });
  }
  return { status: r.status, ereignisse };
}

async function mitClaude(fn) {
  const { home, cleanup } = tempHome('nos-termin-agent');
  const statist = await starten();
  let app = null;
  try {
    app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false, claudeBasis: statist.url });
    await seedIfEmpty(app);
    const server = await app.listen();
    const base = `http://127.0.0.1:${server.server.address().port}`;
    const r = await anfrage(base, 'POST', '/api/claude/schluessel', { schluessel: statist.schluessel });
    assert.equal(r.status, 200, r.text);
    const chat = await anfrage(base, 'POST', '/api/chats', { title: 'Neuer Chat' });
    await fn({ app, base, statist, chatId: chat.json.record.id });
  } finally {
    if (app) await app.close().catch(() => {});
    await statist.close();
    cleanup();
  }
}

/** Die Werkzeugergebnisse, die Neural OS mit der n-ten Anfrage an Claude zurueckschickte. */
function ergebnisseIn(statist, n) {
  const body = statist.stromAnfragen()[n].body;
  const letzte = body.messages[body.messages.length - 1];
  assert.equal(letzte.role, 'user');
  return letzte.content.filter((b) => b.type === 'tool_result');
}

const agenten = (r) => r.ereignisse.filter((e) => e.name === 'agent').map((e) => e.data);

/* ----------------------------------------------------------- Anfrage */

test('Die Werkzeugliste steht in der vereinbarten Reihenfolge und ist zwischen zwei Anfragen byte-gleich (Caching)', async () => {
  await mitClaude(async ({ base, statist, chatId }) => {
    statist.weiter(
      antwort(B.start(), B.text(0, 'Hallo.'), B.ende('end_turn')),
      antwort(B.start(), B.text(0, 'Gern.'), B.ende('end_turn')),
    );
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Hallo' });
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Was steht morgen an?' });
    const [a, b] = statist.stromAnfragen().map((x) => x.body);
    assert.deepEqual(a.tools.map((t) => t.name), [
      'rueckfrage', 'termin_anlegen', 'termine_lesen', 'termin_aendern', 'termin_loeschen',
      'notiz_anlegen', 'merken', 'projekt_anpassen', 'web_search', 'web_fetch',
    ]);
    assert.equal(JSON.stringify(b.tools), JSON.stringify(a.tools), 'die Werkzeuge sind Teil des gecachten Präfixes');
    assert.equal(JSON.stringify(b.system[0]), JSON.stringify(a.system[0]), 'der feste Systemtext auch');
    for (const t of a.tools.slice(0, 8)) {
      assert.equal(t.strict, true, `${t.name}: strict`);
      assert.equal(t.eager_input_streaming, true, `${t.name}: eager_input_streaming`);
    }
    // Der strenge Modus kennt keine Zahlen- und Laengengrenzen im Schema; die
    // stehen in der Beschreibung und werden in eingabePruefen durchgesetzt.
    const schemaText = JSON.stringify(a.tools);
    assert.ok(!/"(minimum|maximum|minLength|maxLength|minItems|maxItems)"/.test(schemaText), 'nichts, was strict nicht kennt');
    // Jedes Objekt, auch das verschachtelte, verbietet fremde Felder.
    const anlegen = a.tools.find((t) => t.name === 'termin_anlegen').input_schema.properties.wiederholung;
    assert.equal(anlegen.additionalProperties, false);
    const aendern = a.tools.find((t) => t.name === 'termin_aendern').input_schema.properties.wiederholung;
    assert.equal(aendern.anyOf[0].additionalProperties, false);
    assert.deepEqual(aendern.anyOf[1], { type: 'null' });
    const lesen = a.tools.find((t) => t.name === 'termine_lesen');
    assert.match(lesen.description, /bevor du einen Termin änderst oder löschst/);
    assert.match(lesen.description, /was hab ich morgen/);
    // Der Kalender-Absatz im Systemtext -- ohne Datum.
    const sys = a.system[0].text;
    assert.match(sys, /termine_lesen/);
    assert.match(sys, /rueckfrage und 2–4 Antworten/);
    assert.match(sys, /Überschneidung/);
    assert.match(sys, /Wochentag, Datum und Uhrzeit/);
    assert.ok(!/20\d\d/.test(sys));
    // Heute: Wochentag, Datum, Uhrzeit, Zeitzone -- in der Nutzernachricht.
    const heute = b.messages[b.messages.length - 1].content[0].text;
    assert.match(heute, /^\[Neural OS: Heute ist (Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag), \d{1,2}\. \S+ \d{4} \(\d{4}-\d{2}-\d{2}\), \d{2}:\d{2} Uhr, Zeitzone \S+\.\]$/);
  });
});

/* -------------------------------------------------------------- Serie */

test('„Jeden Dienstag 18 Uhr Training bis Weihnachten“: Claude legt EINE Serie an, der Kalender zeigt jeden Dienstag', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    statist.weiter(
      antwort(B.start(), B.denken(0, 'Serie, woechentlich, bis 24.12.'), B.werkzeug(1, 'toolu_serie', 'termin_anlegen', {
        titel: 'Training', start: '2026-09-29T18:00', ende: '2026-09-29T19:30', ganztaegig: false, ort: 'Halle 3',
        wiederholung: { rhythmus: 'woechentlich', bis: '2026-12-24' }, erinnerung_minuten: 60,
      }), B.ende('tool_use')),
      antwort(B.start(), B.text(0, 'Eingetragen: jeden Dienstag, 18:00 Uhr, bis 24.12.'), B.ende('end_turn')),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'jeden Dienstag 18 Uhr Training bis Weihnachten' });
    const termine = app.store.all('event');
    assert.equal(termine.length, 1, 'eine Serie, nicht zwölf Termine');
    const t = termine[0].data;
    assert.deepEqual(t.recurrence, { freq: 'weekly', interval: 1, byDay: [], until: '2026-12-24', count: null });
    assert.equal(t.reminder, 60);
    assert.equal(t.source, 'auto');
    assert.equal(t.chatId, chatId);
    const [ergebnis] = ergebnisseIn(statist, 1);
    const inhalt = JSON.parse(ergebnis.content);
    assert.equal(inhalt.id, termine[0].id);
    assert.equal(inhalt.wann, 'Di. 29.09.2026, 18:00–19:30 Uhr', 'der Wochentag ausgerechnet, für die Bestätigung');
    assert.equal(inhalt.wiederholung, 'jeden Dienstag bis 24.12.2026');
    assert.deepEqual(inhalt.ueberschneidungen, []);

    const liste = await anfrage(base, 'GET', '/api/events/zeitraum?from=2026-10-01&to=2026-12-31');
    assert.deepEqual(liste.json.items.map((x) => x.occurrence), [
      '2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10',
      '2026-11-17', '2026-11-24', '2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22',
    ]);
    assert.equal(liste.json.items.find((x) => x.occurrence === '2026-10-27').data.start, '2026-10-27T18:00');
    const ag = agenten(r);
    assert.deepEqual(ag.map((a) => [a.rolle, a.zustand]), [['kalender', 'laeuft'], ['kalender', 'fertig']]);
    assert.match(ag[1].ergebnis, /Training · Di\. 29\.09\.2026, 18:00–19:30 Uhr · jeden Dienstag bis 24\.12\.2026/);
  });
});

/* ------------------------------------------------ lesen, dann aendern */

test('„Verschieb den Zahnarzt auf Freitag“: termine_lesen, dann termin_aendern -- genau ein Termin geaendert, als Agent, rueckgaengig machbar', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    const neu = async (body) => (await anfrage(base, 'POST', '/api/events', body)).json.record;
    const zahnarzt = await neu({ title: 'Zahnarzt', start: '2026-09-29T10:00', end: '2026-09-29T10:45', location: 'Praxis Dr. Weiß' });
    const andere = [
      await neu({ title: 'Zahnarzt Kinder', start: '2026-11-20T15:00', end: '2026-11-20T15:30' }),
      await neu({ title: 'Training', start: '2026-09-29T18:00', end: '2026-09-29T19:30', recurrence: { freq: 'weekly' } }),
      await neu({ title: 'Elternabend', start: '2026-10-06T19:00' }),
    ];
    const revVorher = Object.fromEntries(andere.map((x) => [x.id, app.store.get(x.id).rev]));
    const aktivitaet = [];
    app.bus.on('agent.aktivitaet', (e) => aktivitaet.push(e.payload));

    statist.weiter(
      antwort(B.start(), B.text(0, 'Ich schaue nach.'), B.werkzeug(1, 'toolu_lesen', 'termine_lesen', {
        von: '2026-09-23', bis: '2026-10-31', suche: 'zahnarzt',
      }), B.ende('tool_use')),
      antwort(B.start(), B.werkzeug(0, 'toolu_aendern', 'termin_aendern', { id: zahnarzt.id, start: '2026-10-02T10:00' }), B.ende('tool_use')),
      antwort(B.start(), B.text(0, 'Verschoben: Fr., 02.10., 10:00 Uhr.'), B.ende('end_turn')),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'verschieb den Zahnarzt auf Freitag' });
    assert.equal(r.status, 200);

    // 1. Was termine_lesen an Claude zurueckgab: kompakt, mit id, nur der Treffer im Zeitraum.
    const [gelesen] = ergebnisseIn(statist, 1);
    assert.equal(gelesen.tool_use_id, 'toolu_lesen');
    assert.equal(gelesen.is_error, undefined);
    const liste = JSON.parse(gelesen.content);
    assert.equal(liste.anzahl, 1, '„Zahnarzt Kinder“ liegt nach dem 31.10.');
    assert.deepEqual(liste.termine[0], {
      id: zahnarzt.id, titel: 'Zahnarzt', start: '2026-09-29T10:00', end: '2026-09-29T10:45',
      ort: 'Praxis Dr. Weiß', wiederkehrend: false, vorkommen: null, wann: 'Di. 29.09.2026, 10:00–10:45 Uhr',
    });

    // 2. Genau EIN Termin geaendert; die Dauer blieb (ohne end im Aufruf).
    const nachher = app.store.get(zahnarzt.id).data;
    assert.equal(nachher.start, '2026-10-02T10:00');
    assert.equal(nachher.end, '2026-10-02T10:45', 'die Dauer von 45 Minuten bleibt');
    assert.equal(nachher.location, 'Praxis Dr. Weiß');
    for (const x of andere) assert.equal(app.store.get(x.id).rev, revVorher[x.id], `${x.data.title} blieb unberührt`);
    assert.equal(app.store.all('event').length, 4);
    const [geaendert] = ergebnisseIn(statist, 2);
    const antwortAendern = JSON.parse(geaendert.content);
    assert.equal(antwortAendern.wann, 'Fr. 02.10.2026, 10:00–10:45 Uhr');

    // 3. Sichtbar: je Werkzeug laeuft -> fertig, Rolle Kalender, dazu ein run-Satz.
    const ag = agenten(r);
    assert.deepEqual(ag.map((a) => a.zustand), ['laeuft', 'fertig', 'laeuft', 'fertig']);
    assert.ok(ag.every((a) => a.rolle === 'kalender'));
    assert.equal(ag[1].ergebnis, '1 Termin zu „zahnarzt“ gefunden');
    assert.equal(ag[3].ergebnis, 'Zahnarzt → Fr. 02.10.2026, 10:00–10:45 Uhr');
    assert.ok(aktivitaet.some((a) => a.rolle === 'kalender' && a.zustand === 'fertig' && a.chatId === chatId), 'auch auf dem Bus (Kachel)');
    const lauf = app.store.get(ag[3].id);
    assert.equal(lauf.type, 'run');
    assert.equal(lauf.data.status, 'done');
    assert.equal(lauf.data.rolle, 'kalender');
    assert.ok(lauf.data.producedIds.includes(zahnarzt.id));

    // 4. Der Verlauf kennt den Urheber: Claude, nicht der Nutzer -- und nimmt es zurueck.
    const eintrag = app.history.list({ type: 'event' }).items.find((e) => e.id === zahnarzt.id && e.op === 'update');
    assert.ok(eintrag, 'die Änderung steht im Verlauf');
    assert.equal(eintrag.actor.kind, 'agent');
    assert.equal(eintrag.actor.runId, lauf.id);
    assert.equal(eintrag.canUndo, true);
    await app.history.undo(eintrag.seq);
    assert.equal(app.store.get(zahnarzt.id).data.start, '2026-09-29T10:00');
    assert.equal(app.store.get(zahnarzt.id).data.end, '2026-09-29T10:45');
  });
});

test('Nur ein Vorkommen: termin_aendern mit nur_am loest es aus der Serie; rueckgaengig nimmt beide Haelften zurueck', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    const serie = (await anfrage(base, 'POST', '/api/events', {
      title: 'Training', start: '2026-09-29T18:00', end: '2026-09-29T19:30', recurrence: { freq: 'weekly', until: '2026-12-24' },
    })).json.record;
    statist.weiter(
      antwort(B.start(), B.werkzeug(0, 'toolu_nur', 'termin_aendern', { id: serie.id, nur_am: '2026-10-13', start: '2026-10-14T18:00' }), B.ende('tool_use')),
      antwort(B.start(), B.text(0, 'Nur diese Woche am Mittwoch.'), B.ende('end_turn')),
    );
    await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'nächste Woche ist das Training ausnahmsweise am Mittwoch' });
    const inhalt = JSON.parse(ergebnisseIn(statist, 1)[0].content);
    assert.notEqual(inhalt.id, serie.id);
    assert.equal(inhalt.nur_am, '2026-10-13');
    assert.equal(inhalt.wann, 'Mi. 14.10.2026, 18:00–19:30 Uhr');
    assert.deepEqual(app.store.get(serie.id).data.exdates, ['2026-10-13']);
    const einzel = app.store.get(inhalt.id);
    assert.equal(einzel.data.source, 'user', 'die Herkunft der Serie wird geerbt, nicht erfunden');
    const eintrag = app.history.list({ type: 'event' }).items.find((e) => e.id === inhalt.id);
    assert.equal(eintrag.actor.kind, 'agent');
    const r = await app.history.undo(eintrag.seq);
    assert.equal(r.mitgenommen.length, 1);
    assert.equal(app.store.get(inhalt.id), null);
    assert.deepEqual(app.store.get(serie.id).data.exdates, []);
  });
});

/* -------------------------------------------------- Ueberschneidungen */

test('termin_anlegen mit Ueberschneidung: die Antwort an Claude nennt den ueberschnittenen Termin -- auch ein Vorkommen einer Serie', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    await anfrage(base, 'POST', '/api/events', { title: 'Elternabend', start: '2026-10-06T19:00', end: '2026-10-06T21:00' });
    await anfrage(base, 'POST', '/api/events', { title: 'Chor', start: '2026-09-30T19:30', end: '2026-09-30T21:00', recurrence: { freq: 'weekly' } });
    statist.weiter(
      antwort(B.start(),
        B.werkzeug(0, 'toolu_a', 'termin_anlegen', { titel: 'Training', start: '2026-10-06T20:00', ende: '2026-10-06T21:30', ganztaegig: false }),
        B.werkzeug(1, 'toolu_b', 'termin_anlegen', { titel: 'Kino', start: '2026-10-14T20:00', ganztaegig: false }),
        B.werkzeug(2, 'toolu_c', 'termin_anlegen', { titel: 'Frühstück', start: '2026-10-07T08:00', ende: '2026-10-07T09:00', ganztaegig: false }),
        B.ende('tool_use')),
      antwort(B.start(), B.text(0, 'Eingetragen. Achtung: Training überschneidet sich mit dem Elternabend.'), B.ende('end_turn')),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Di 20 Uhr Training, Mi 14.10. 20 Uhr Kino, Mi 8 Uhr Frühstück' });
    const [a, b, c] = ergebnisseIn(statist, 1).map((e) => JSON.parse(e.content));
    assert.equal(app.store.all('event').length, 5, 'alle drei angelegt -- eine Überschneidung verhindert nichts');
    assert.ok(a.id);
    assert.deepEqual(a.ueberschneidungen.map(({ titel, wann }) => ({ titel, wann })), [{ titel: 'Elternabend', wann: 'Di. 06.10.2026, 19:00–21:00 Uhr' }]);
    assert.match(a.hinweis, /überschneidet sich/);
    assert.deepEqual(b.ueberschneidungen.map((u) => [u.titel, u.wann]), [['Chor', 'Mi. 14.10.2026, 19:30–21:00 Uhr']], 'das Vorkommen der Serie am 14.10.');
    assert.deepEqual(c.ueberschneidungen, []);
    const fertig = agenten(r).filter((x) => x.zustand === 'fertig');
    assert.match(fertig[0].ergebnis, /überschneidet sich mit „Elternabend“/);
  });
});

/* ------------------------------------------------------------ Loeschen */

test('termin_loeschen mit falscher id oder fremdem Satztyp: is_error, nichts geloescht; mit nur_am faellt nur ein Tag aus', async () => {
  await mitClaude(async ({ app, base, statist, chatId }) => {
    const notiz = app.store.create('note', { title: 'Keine Verabredung' });
    const serie = (await anfrage(base, 'POST', '/api/events', {
      title: 'Training', start: '2026-09-29T18:00', recurrence: { freq: 'weekly', until: '2026-12-24' },
    })).json.record;
    const zaehler = () => ({ events: app.store.count('event'), notes: app.store.count('note') });
    const vorher = zaehler();
    statist.weiter(
      antwort(B.start(),
        B.werkzeug(0, 'toolu_falsch', 'termin_loeschen', { id: 'event_gibtesnicht000000000000' }),
        B.werkzeug(1, 'toolu_fremd', 'termin_loeschen', { id: notiz.id }),
        B.werkzeug(2, 'toolu_leer', 'termin_loeschen', { id: '' }),
        B.werkzeug(3, 'toolu_tag', 'termin_loeschen', { id: serie.id, nur_am: '2026-10-28' }),
        B.ende('tool_use')),
      antwort(B.start(), B.werkzeug(0, 'toolu_ok', 'termin_loeschen', { id: serie.id, nur_am: '2026-10-27' }), B.ende('tool_use')),
      antwort(B.start(), B.text(0, 'Am 27.10. fällt das Training aus.'), B.ende('end_turn')),
    );
    const r = await strom(base, `/api/chats/${chatId}/messages`, { inhalt: 'Lösch das Training am 27.10.' });
    const [falsch, fremd, leer, tag] = ergebnisseIn(statist, 1);
    for (const e of [falsch, fremd, leer, tag]) assert.equal(e.is_error, true, e.content);
    assert.match(JSON.parse(falsch.content).fehler, /gibt es nicht\. Hol dir die id mit termine_lesen\.$/, "ein deutscher Satz, ohne englischen Anhang");
    assert.match(JSON.parse(fremd.content).fehler, /gibt es nicht/);
    assert.ok('INVALID_JSON' in JSON.parse(leer.content), 'eine leere id ist schon eine ungültige Eingabe');
    assert.match(JSON.parse(tag.content).fehler, /28\.10\.2026 findet „Training“ nicht statt/);
    assert.deepEqual(zaehler(), vorher, 'nichts gelöscht');
    assert.ok(app.store.get(notiz.id), 'die Notiz steht noch');
    assert.deepEqual(app.store.get(serie.id).data.exdates, ['2026-10-27'], 'dann nur der eine Dienstag');
    const [ok] = ergebnisseIn(statist, 2);
    assert.equal(JSON.parse(ok.content).ausgelassen, '2026-10-27');
    const zustaende = agenten(r).filter((a) => a.zustand !== 'laeuft').map((a) => a.zustand);
    assert.deepEqual(zustaende, ['fehler', 'fehler', 'fehler', 'fehler', 'fertig'], 'gescheitert heißt sichtbar gescheitert');
  });
});

test('Die Werkzeugeingaben werden streng geprueft -- auch das Objekt in wiederholung', async () => {
  const { eingabePruefen } = require('../src/models/werkzeuge');
  const ok = (n, e) => assert.equal(eingabePruefen(n, e).ok, true, `${n} ${JSON.stringify(e)}: ${eingabePruefen(n, e).fehler}`);
  const nein = (n, e, muster) => {
    const p = eingabePruefen(n, e);
    assert.equal(p.ok, false, `${n} ${JSON.stringify(e)} hätte abgelehnt werden müssen`);
    assert.match(p.fehler, muster);
  };
  const basis = { titel: 'Training', start: '2026-09-29T18:00', ganztaegig: false };
  ok('termin_anlegen', { ...basis, wiederholung: { rhythmus: 'woechentlich', wochentage: ['DI', 'DO'], bis: '2026-12-24' } });
  nein('termin_anlegen', { ...basis, wiederholung: { rhythmus: 'woechentlich', wochentage: ['TU'] } }, /wochentage.*MO, DI/);
  nein('termin_anlegen', { ...basis, wiederholung: { rhythmus: 'weekly' } }, /rhythmus/);
  nein('termin_anlegen', { ...basis, wiederholung: { rhythmus: 'woechentlich', jeden: 'Dienstag' } }, /Unbekanntes Feld „wiederholung\.jeden“/);
  nein('termin_anlegen', { ...basis, wiederholung: { alle: 2 } }, /Pflichtfeld „wiederholung\.rhythmus“/);
  nein('termin_anlegen', { ...basis, wiederholung: { rhythmus: 'woechentlich', alle: 0 } }, /zwischen 1 und 99/);
  nein('termin_anlegen', { ...basis, wiederholung: { rhythmus: 'woechentlich', alle: 1.5 } }, /ganze Zahl/);
  nein('termin_anlegen', { ...basis, wiederholung: { rhythmus: 'monatlich', wochentage: ['MO'] } }, /nur beim rhythmus „woechentlich“/);
  nein('termin_anlegen', { ...basis, wiederholung: { rhythmus: 'woechentlich', bis: '2026-09-01' } }, /liegt vor dem Beginn/);
  nein('termin_anlegen', { ...basis, wiederholung: { rhythmus: 'woechentlich', bis: '2026-12-24', anzahl: 5 } }, /nicht beides/);
  nein('termin_anlegen', { ...basis, erinnerung_minuten: 7 }, /erinnerung_minuten/);
  nein('termin_anlegen', { ...basis, wiederholung: null, erinnerung_minuten: '60' }, /ganze Zahl/);
  ok('termine_lesen', { von: '2026-10-01', bis: '2026-10-31' });
  nein('termine_lesen', { von: '2026-10-31', bis: '2026-10-01' }, /vor „von“/);
  nein('termine_lesen', { von: '2026-01-01', bis: '2027-06-01' }, /400 Tage/);
  nein('termine_lesen', { von: 'morgen', bis: '2026-10-01' }, /kein gültiger Tag/);
  ok('termin_aendern', { id: 'event_x', wiederholung: null });
  ok('termin_aendern', { id: 'event_x', erinnerung_minuten: null });
  ok('termin_aendern', { id: 'event_x', nur_am: '2026-10-13', start: '2026-10-14T18:00' });
  nein('termin_aendern', { id: 'event_x' }, /Nichts zu ändern/);
  nein('termin_aendern', { id: 'event_x', ende: '2026-10-14T19:00' }, /Unbekanntes Feld „ende“ – hier heißt es „end“/);
  nein('termin_aendern', { id: 'event_x', nur_am: '2026-10-13', wiederholung: { rhythmus: 'taeglich' } }, /keine eigene Wiederholung/);
  nein('termin_aendern', { id: 'event_x', start: '2026-10-14', ganztaegig: false }, /Uhrzeit/);
  nein('termin_loeschen', { id: 'event_x', nur_am: '27.10.' }, /nur_am/);
});
