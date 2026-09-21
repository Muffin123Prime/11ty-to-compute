'use strict';

/**
 * Tests für den Tagesbeginn: die eine zusammentragende Route hinter
 * `GET /api/today`.
 *
 * Alles läuft gegen den ECHTEN Speicher in einem Wegwerf-Verzeichnis und
 * gegen den ECHTEN Server auf einem freien Port. Keine Attrappen -- gerade
 * hier nicht, denn die vier Dinge, die wirklich schiefgehen können, würde
 * eine Attrappe alle verdecken:
 *
 * 1. Ob „überfällig" und „heute" am richtigen Tagesschnitt auseinandergehen.
 * 2. Ob ein fehlendes Teilsystem die ganze Route kippt, statt mit einem Grund
 *    in `fehlend` zu landen.
 * 3. Ob eine Änderung, die ein Agent gemacht hat, auch wirklich als solche
 *    erkannt wird -- und ob eine, die nur der Herkunftsstempel behauptet,
 *    ehrlich als unsicher gilt.
 * 4. Ob ein Bildschirm, den man nur ansieht, tatsächlich nichts verändert.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');

const { test, drain, tempHome } = require('./harness');

const { openStore } = require('../src/store/engine');
const { createHistory } = require('../src/store/history');
const { withActor } = require('../src/kernel/actor');
const { Bus } = require('../src/kernel/bus');
const configMod = require('../src/kernel/config');
const pathsMod = require('../src/kernel/paths');

const todayApi = require('../src/http/api/today');

/** Tests dürfen nicht über die Ausgabe des Läufers schreiben. */
const SILENT = { error() {}, warn() {}, info() {}, debug() {} };
const silentLogger = () => SILENT;

const GRAPH = { ...require('../src/graph/derive'), ...require('../src/graph/view') };

const DAY = 24 * 60 * 60 * 1000;

const RUN_ID = 'run_nachtschicht0000000001';
const AGENT_ID = 'agent_aufraeumer00000000';

/**
 * Den echten Server `/api/today` bedienen lassen, auch bevor der Integrator
 * die Datei in seine Ladeliste aufgenommen hat: das zuletzt geladene
 * Routen-Modul bekommt eine Hülle, die zusätzlich unsere Route registriert.
 * Der Server selbst bleibt unangetastet, und die Naht verschwindet von selbst,
 * sobald `src/http/server.js` die Datei einträgt.
 */
const SERVER_FILE = require.resolve('../src/http/server');
if (!/require\(['"]\.\/api\/today['"]\)/.test(fs.readFileSync(SERVER_FILE, 'utf8'))) {
  const lastLoadedApi = require('../src/http/api/history');
  const originalRegister = lastLoadedApi.register;
  lastLoadedApi.register = function registerWithToday(router) {
    originalRegister.call(this, router);
    todayApi.register(router);
  };
}

function request(base, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...(method !== 'GET' && method !== 'HEAD' ? { 'x-neural-os': '1' } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* nicht jede Antwort ist JSON */ }
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Echter Speicher, echter Server, hinterher weggeworfen.
 *
 * @param {(env:{store:object, base:string, bus:object, history:object|null}) => any} fn
 * @param {{history?:boolean, assist?:object|null, scheduler?:object|null, triggers?:object|null}} [opts]
 */
async function withServer(fn, opts = {}) {
  const { createServer } = require('../src/http/server');
  const { home, cleanup } = tempHome('nos-today');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  config.server.host = '127.0.0.1';

  const bus = new Bus();
  const store = await openStore({ paths, bus, logger: silentLogger });

  let history = null;
  if (opts.history !== false) {
    history = createHistory({ store, bus, paths, logger: silentLogger });
    history.start();
  }

  const server = await createServer({
    version: 'test',
    config,
    paths,
    store,
    bus,
    graph: GRAPH,
    history,
    assist: opts.assist === undefined ? null : opts.assist,
    scheduler: opts.scheduler === undefined ? null : opts.scheduler,
    triggers: opts.triggers === undefined ? null : opts.triggers,
    logger: silentLogger,
    failures: [],
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;

  try {
    return await fn({ store, base, bus, history, paths });
  } finally {
    if (history) { try { history.stop(); } catch { /* schon gestoppt */ } }
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    cleanup();
  }
}

/** Ein ISO-Datum ohne Uhrzeit, `tage` von heute entfernt. */
function isoDate(tage) {
  const d = new Date(Date.now() + tage * DAY);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Was im Tresor steht, als vergleichbarer Abzug. */
function snapshot(store) {
  const stats = store.stats();
  const records = store.list(require('../src/store/schema').TYPES, { limit: undefined }).items
    .map((r) => `${r.id}:${r.rev}:${r.updatedAt}:${r.deletedAt || ''}`)
    .sort();
  return { records, gesamt: stats.records, counts: stats.counts, seq: stats.seq };
}

/* ------------------------------------------------------------- Fälligkeit */

test('dueAt liest ein blankes Datum in Ortszeit, eine volle Zeitangabe wie angegeben', () => {
  const bare = todayApi.dueAt('2026-09-21');
  assert.equal(bare, new Date(2026, 8, 21).getTime(),
    'ein blankes Datum ist Mitternacht vor Ort – sonst wäre „heute fällig" westlich von Greenwich überfällig');
  assert.equal(todayApi.dueAt('2026-09-21T10:00:00Z'), Date.parse('2026-09-21T10:00:00Z'));
  assert.equal(todayApi.dueAt(''), null);
  assert.equal(todayApi.dueAt(null), null);
  assert.equal(todayApi.dueAt('übermorgen'), null, 'Unlesbares ist kein Datum, sondern keines');
});

test('überfällige, heutige und demnächst fällige Aufgaben werden getrennt', async () => {
  await withServer(async ({ store, base }) => {
    const gestern = store.create('task', { title: 'Rechnung zahlen', due: isoDate(-1), priority: 1 });
    const vorgestern = store.create('task', { title: 'Müll rausbringen', due: isoDate(-2) });
    const heute = store.create('task', { title: 'Zahnarzt anrufen', due: isoDate(0) });
    const bald = store.create('task', { title: 'Reifen wechseln', due: isoDate(3) });
    store.create('task', { title: 'Steuererklärung', due: isoDate(60) });
    store.create('task', { title: 'Irgendwann mal aufräumen' });
    // Erledigtes ist nicht fällig, auch wenn das Datum längst durch ist.
    store.create('task', { title: 'Schon erledigt', due: isoDate(-5), status: 'done' });

    const res = await request(base, 'GET', '/api/today');
    assert.equal(res.status, 200, res.text);
    const { faellig } = res.json;

    assert.deepEqual(faellig.ueberfaellig.map((t) => t.id), [vorgestern.id, gestern.id],
      'das Älteste zuerst – die Reihenfolge, die tasks.list auch liefert');
    assert.deepEqual(faellig.heute.map((t) => t.id), [heute.id]);
    assert.deepEqual(faellig.demnaechst.map((t) => t.id), [bald.id]);

    assert.equal(faellig.anzahl.ueberfaellig, 2);
    assert.equal(faellig.anzahl.heute, 1);
    assert.equal(faellig.anzahl.demnaechst, 1);
    assert.equal(faellig.anzahl.spaeter, 1, 'in 60 Tagen ist weder heute noch demnächst');
    assert.equal(faellig.anzahl.ohneDatum, 1,
      'eine Aufgabe ohne Datum ist nicht fällig, verschwindet aber auch nicht');

    // Der vereinbarte Umfang eines Eintrags – dieselben Felder wie tasks.list.
    assert.deepEqual(Object.keys(faellig.heute[0]).sort(),
      ['due', 'id', 'priority', 'projectId', 'status', 'title']);
  });
});

test('bei gleichem Datum entscheidet die Priorität, wie in tasks.list', async () => {
  await withServer(async ({ store, base }) => {
    const niedrig = store.create('task', { title: 'Beiläufig', due: isoDate(-1), priority: 3 });
    const hoch = store.create('task', { title: 'Dringend', due: isoDate(-1), priority: 1 });

    const res = await request(base, 'GET', '/api/today');
    assert.deepEqual(res.json.faellig.ueberfaellig.map((t) => t.id), [hoch.id, niedrig.id]);
  });
});

/* ------------------------------------------------------------ seit gestern */

test('seit gestern zählt, was sich geändert hat, und sagt was davon neu ist', async () => {
  await withServer(async ({ store, base }) => {
    const note = store.create('note', { title: 'Frühjahrsputz', body: 'Keller' });
    store.create('task', { title: 'Regal bauen' });

    const res = await request(base, 'GET', '/api/today');
    assert.equal(res.status, 200, res.text);
    const seit = res.json.seitGestern;

    assert.equal(seit.gesamt, 2);
    assert.deepEqual(seit.nachArt, { note: 1, task: 1 });
    const eintrag = seit.eintraege.find((e) => e.id === note.id);
    assert.ok(eintrag, 'die Notiz fehlt in der Liste');
    assert.equal(eintrag.label, 'Frühjahrsputz', 'der Eintrag trägt seinen lesbaren Namen');
    assert.equal(eintrag.neu, true, 'gerade angelegt heißt neu, nicht nur geändert');

    // Das Fenster ist benannt, nicht geraten: der Schnitt steht in der Antwort.
    assert.equal(res.json.stunden, 24);
    assert.ok(Date.parse(res.json.seit) < Date.parse(res.json.at));
    assert.equal(Math.round((Date.parse(res.json.at) - Date.parse(res.json.seit)) / 3600000), 24);
  });
});

test('ein kürzeres Fenster lässt Älteres draußen', async () => {
  await withServer(async ({ store, base }) => {
    store.create('note', { title: 'Eben erst' });
    const res = await request(base, 'GET', '/api/today?stunden=1');
    assert.equal(res.json.stunden, 1);
    assert.equal(res.json.seitGestern.gesamt, 1, 'gerade angelegt liegt auch in einer Stunde');
  });
});

/* ---------------------------------------------------------------- ohneDich */

test('eine Änderung durch einen Agenten erscheint unter ohneDich', async () => {
  await withServer(async ({ store, base }) => {
    const note = store.create('note', { title: 'Von Hand geschrieben', body: 'Alt' });

    // Genau das, was ein Agentenlauf tut: einmal den Urheber setzen, und
    // alles darin trägt ihn.
    withActor({ kind: 'agent', runId: RUN_ID, agentId: AGENT_ID }, () => {
      store.update(note.id, { body: 'Vom Agenten überarbeitet' });
      store.create('task', { title: 'Vom Agenten angelegt' });
    });

    const res = await request(base, 'GET', '/api/today');
    assert.equal(res.status, 200, res.text);
    const { ohneDich } = res.json;

    assert.equal(ohneDich.gesamt, 2, 'beide Schreibvorgänge im Lauf gehören dem Agenten');
    assert.equal(ohneDich.unsicher, 0);
    assert.deepEqual(ohneDich.aenderungen.map((a) => a.op).sort(), ['create', 'update']);

    const geaendert = ohneDich.aenderungen.find((a) => a.id === note.id);
    assert.ok(geaendert, 'die Änderung an der Notiz fehlt');
    assert.equal(geaendert.runId, RUN_ID, 'der Lauf ist benannt, damit man ihn nachschlagen kann');
    assert.equal(geaendert.agentId, AGENT_ID);
    assert.equal(geaendert.label, 'Notiz „Von Hand geschrieben" geändert');

    // Die eigene Änderung davor gehört nicht hierher.
    assert.ok(!ohneDich.aenderungen.some((a) => a.op === 'create' && a.id === note.id),
      'was der Mensch selbst angelegt hat, lief nicht ohne ihn');
  });
});

test('ein Herkunftsstempel auf einer späteren Änderung gilt als unsicher, nicht als Tatsache', async () => {
  // Die Regel für sich, ohne Speicher: `via: "stempel"` sagt bei einer
  // Änderung nur, wer den Satz ANGELEGT hat (src/store/history.js, actorOf).
  const ausKontext = { op: 'update', actor: { kind: 'agent', via: 'kontext', runId: RUN_ID } };
  const stempelAufAnlage = { op: 'create', actor: { kind: 'agent', via: 'stempel', runId: RUN_ID } };
  const stempelAufAenderung = { op: 'update', actor: { kind: 'agent', via: 'stempel', runId: RUN_ID } };
  const vomMenschen = { op: 'update', actor: { kind: 'user' } };

  assert.equal(todayApi.reallyAgent(ausKontext), true);
  assert.equal(todayApi.reallyAgent(stempelAufAnlage), true, 'beim Anlegen stimmt der Stempel');
  assert.equal(todayApi.reallyAgent(stempelAufAenderung), false,
    'sonst sähe die eigene Nachbearbeitung wie die Arbeit des Agenten aus');
  assert.equal(todayApi.reallyAgent(vomMenschen), false);

  // Und derselbe Fall durch den echten Server: der Agent legt an, der Mensch
  // ändert danach.
  await withServer(async ({ store, base }) => {
    let angelegt = null;
    withActor({ kind: 'agent', runId: RUN_ID, agentId: AGENT_ID }, () => {
      // `runId`/`agentId` im Satz: genau das, was `stamped()` in
      // src/agents/tools.js schreibt, wenn ein Agent etwas anlegt.
      angelegt = store.create('note', {
        title: 'Vom Agenten', body: 'Erste Fassung', runId: RUN_ID, agentId: AGENT_ID,
      });
    });
    store.update(angelegt.id, { body: 'Vom Menschen nachbearbeitet' });

    const res = await request(base, 'GET', '/api/today');
    const { ohneDich } = res.json;
    assert.equal(ohneDich.gesamt, 1, 'nur das Anlegen war wirklich der Agent');
    assert.equal(ohneDich.aenderungen[0].op, 'create');
    assert.equal(ohneDich.unsicher, 1,
      'die spätere Änderung wird gezählt, aber nicht als Agentenarbeit ausgegeben');
  });
});

test('Agentenläufe werden gemeldet, mit Namen des Agenten wenn er bekannt ist', async () => {
  await withServer(async ({ store, base }) => {
    const agent = store.create('agent', { name: 'Aufräumer', description: 'Sortiert nachts' });
    const run = store.create('run', {
      agentId: agent.id,
      goal: 'Verwaiste Notizen verknüpfen',
      status: 'done',
      startedAt: new Date(Date.now() - 3600000).toISOString(),
      finishedAt: new Date(Date.now() - 3500000).toISOString(),
      producedIds: ['note_aaaaaaaaaaaaaaaaaaaaaa'],
    });

    const res = await request(base, 'GET', '/api/today');
    assert.equal(res.json.ohneDich.laeufeGesamt, 1);
    const gemeldet = res.json.ohneDich.laeufe[0];
    assert.equal(gemeldet.id, run.id);
    assert.equal(gemeldet.agent, 'Aufräumer');
    assert.equal(gemeldet.status, 'done');
    assert.equal(gemeldet.produziert, 1);
    assert.equal(gemeldet.netz, false);
  });
});

/* -------------------------------------------------------- fehlende Teile */

test('fehlende Teilsysteme landen in fehlend, statt die Route zu kippen', async () => {
  await withServer(async ({ store, base }) => {
    store.create('task', { title: 'Trotzdem fällig', due: isoDate(-1) });

    const res = await request(base, 'GET', '/api/today');
    assert.equal(res.status, 200, 'ein fehlendes Teilsystem ist kein Fehler der ganzen Route');

    const teile = res.json.fehlend.map((f) => f.teil);
    assert.ok(teile.includes('vorschlaege'), 'die Assistenz fehlt und sagt es');
    assert.ok(teile.includes('ohneDich'), 'der Änderungsverlauf fehlt und sagt es');
    assert.ok(teile.includes('automatik'), 'Zeitplanung und Auslöser fehlen und sagen es');

    for (const eintrag of res.json.fehlend) {
      assert.match(eintrag.grund, /nicht verfügbar/,
        'der Grund ist ein deutscher Satz, kein Stapelabzug');
    }

    // Was da ist, kommt trotzdem an.
    assert.equal(res.json.faellig.anzahl.ueberfaellig, 1);
    assert.deepEqual(res.json.vorschlaege, { offen: 0, nachArt: {}, oben: [] });
    assert.equal(res.json.ohneDich.gesamt, 0);
    assert.equal(res.json.automatik.eingeschaltet, null,
      '„konnte nicht nachsehen" ist nicht dasselbe wie „ist aus"');
  }, { history: false });
});

test('ein Teilsystem, das beim Nachsehen scheitert, kippt die Route ebenso wenig', async () => {
  const kaputt = {
    list() { throw new Error('Der Vorschlagsspeicher ist beschädigt.'); },
    stats() { throw new Error('Der Vorschlagsspeicher ist beschädigt.'); },
  };
  await withServer(async ({ base }) => {
    const res = await request(base, 'GET', '/api/today');
    assert.equal(res.status, 200, res.text);
    const eintrag = res.json.fehlend.find((f) => f.teil === 'vorschlaege');
    assert.ok(eintrag, 'der Fehler muss benannt werden, nicht verschluckt');
    assert.match(eintrag.grund, /beschädigt/, 'und zwar mit dem, was wirklich passiert ist');
    assert.deepEqual(res.json.vorschlaege.oben, []);
  }, { assist: kaputt });
});

/* -------------------------------------------------------------- Vorschläge */

test('offene Vorschläge werden mit Zahl und Art gemeldet', async () => {
  const assist = {
    stats: () => ({ open: 3, accepted: 1, dismissed: 0, stale: 0, byKind: { duplicate: 2, orphan: 1 } }),
    list: () => ({
      total: 3,
      items: [{
        id: 'suggestion_aaaaaaaaaaaaaaaa',
        data: {
          kind: 'duplicate',
          title: 'Zwei fast gleiche Notizen',
          reason: 'Beide tragen denselben Titel.',
          confidence: 0.82,
          recordIds: ['note_aaaaaaaaaaaaaaaaaaaaaa', 'note_bbbbbbbbbbbbbbbbbbbbbb'],
        },
      }],
    }),
  };
  await withServer(async ({ base }) => {
    const res = await request(base, 'GET', '/api/today');
    assert.equal(res.json.vorschlaege.offen, 3);
    assert.deepEqual(res.json.vorschlaege.nachArt, { duplicate: 2, orphan: 1 });
    assert.equal(res.json.vorschlaege.oben[0].kind, 'duplicate');
    assert.equal(res.json.vorschlaege.oben[0].confidence, 0.82);
    assert.ok(!res.json.fehlend.some((f) => f.teil === 'vorschlaege'));
  }, { assist });
});

/* ---------------------------------------------------------------- Automatik */

test('die Automatik meldet, ob sie läuft und wann sie das nächste Mal dran ist', async () => {
  const naechster = new Date(Date.now() + 3600000).toISOString();
  const scheduler = { status: () => ({ running: true, intervalMs: 60000, enabled: 2, total: 3, nextDue: naechster }) };
  const triggers = { status: () => ({ running: true, enabled: 1, total: 1, firedLastHour: 4 }) };

  await withServer(async ({ base }) => {
    const res = await request(base, 'GET', '/api/today');
    assert.equal(res.json.automatik.eingeschaltet, true);
    assert.equal(res.json.automatik.naechster, naechster);
    assert.deepEqual(res.json.automatik.zeitplaene, { laeuft: true, eingeschaltet: 2, gesamt: 3 });
    assert.deepEqual(res.json.automatik.ausloeser, { laeuft: true, eingeschaltet: 1, gesamt: 1, letzteStunde: 4 });
    assert.ok(!res.json.fehlend.some((f) => f.teil === 'automatik'));
  }, { scheduler, triggers });
});

test('eine gestoppte Uhr meldet aus – und das ist etwas anderes als unbekannt', async () => {
  const scheduler = { status: () => ({ running: false, intervalMs: 60000, enabled: 0, total: 0, nextDue: null }) };
  const triggers = { status: () => ({ running: false, enabled: 0, total: 0, firedLastHour: 0 }) };

  await withServer(async ({ base }) => {
    const res = await request(base, 'GET', '/api/today');
    assert.equal(res.json.automatik.eingeschaltet, false, 'aus ist false, nicht null');
    assert.equal(res.json.automatik.naechster, null);
  }, { scheduler, triggers });
});

/* ------------------------------------------------------------ Wiedervorlage */

test('eine frische Notiz ist keine Wiedervorlage', async () => {
  await withServer(async ({ store, base }) => {
    store.create('note', { title: 'Heute geschrieben', body: 'Noch warm' });
    const res = await request(base, 'GET', '/api/today');
    assert.deepEqual(res.json.wiedervorlage, [],
      `was gerade entstanden ist, liegt nicht seit ${todayApi.REVISIT_MIN_AGE_DAYS} Tagen`);
  });
});

/**
 * Der Speicher stempelt `updatedAt` immer mit der aktuellen Zeit und bietet
 * keinen Weg, das zu datieren. Eine 90 Tage alte Notiz lässt sich also nicht
 * anlegen -- deshalb wird die Auswahl hier direkt mit einem `now` weit voraus
 * geprüft, dieselbe Naht, die `assist.scan({ now })` aus demselben Grund hat.
 */
test('was lange liegt, kommt auf die Wiedervorlage – Angeheftetes zuerst', async () => {
  await withServer(async ({ store }) => {
    // Zwischen den Anlagen ein paar Millisekunden, sonst tragen sie denselben
    // Zeitstempel und „das Älteste zuerst" wäre gar nicht prüfbar.
    const alt = store.create('note', { title: 'Dachsanierung', body: 'Angebote einholen' });
    await new Promise((r) => setTimeout(r, 5));
    const aelter = store.create('note', { title: 'Sprachkurs', body: 'Italienisch' });
    await new Promise((r) => setTimeout(r, 5));
    const angeheftet = store.create('note', { title: 'Passwörter', body: 'Wo liegt der Zettel?', pinned: true });
    assert.ok(Date.parse(alt.updatedAt) < Date.parse(aelter.updatedAt), 'die Zeitstempel müssen sich unterscheiden');

    const spaeter = Date.parse(angeheftet.updatedAt) + (todayApi.REVISIT_MIN_AGE_DAYS + 30) * DAY;
    const items = todayApi.wiedervorlageBlock(store, spaeter, todayApi.labelerFor({ graph: GRAPH }));

    assert.equal(items.length, 3);
    assert.equal(items[0].id, angeheftet.id, 'Angeheftetes zuerst – das stärkste Signal, das es gibt');
    assert.equal(items[0].angeheftet, true);
    assert.match(items[0].grund, /^Angeheftet und seit \d+ Tagen nicht mehr geändert\.$/);

    const uebrige = items.slice(1).map((i) => i.id);
    assert.deepEqual(uebrige, [alt.id, aelter.id], 'danach das Älteste zuerst');
    assert.equal(items[1].label, 'Dachsanierung');
    assert.ok(items[1].tage >= todayApi.REVISIT_MIN_AGE_DAYS);
    assert.match(items[1].grund, /^Seit \d+ Tagen nicht mehr geändert\.$/);

    // Ein Schnitt kurz nach dem Anlegen findet nichts.
    assert.deepEqual(
      todayApi.wiedervorlageBlock(store, Date.parse(alt.updatedAt) + DAY, todayApi.labelerFor({})),
      [],
    );
  });
});

/* -------------------------------------------------- der leere Bildschirm */

test('ein leerer Tresor ergibt einen leeren Tagesbeginn, keinen Fehler', async () => {
  await withServer(async ({ base }) => {
    const res = await request(base, 'GET', '/api/today');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.faellig.anzahl,
      { ueberfaellig: 0, heute: 0, demnaechst: 0, ohneDatum: 0, spaeter: 0 });
    assert.equal(res.json.seitGestern.gesamt, 0);
    assert.deepEqual(res.json.seitGestern.eintraege, []);
    assert.equal(res.json.ohneDich.gesamt, 0);
    assert.deepEqual(res.json.ohneDich.laeufe, []);
    assert.deepEqual(res.json.wiedervorlage, []);
    assert.ok(Array.isArray(res.json.fehlend));
  });
});

/* ------------------------------------------------- der Bildschirm schreibt nicht */

test('die Route legt nichts an und ändert nichts', async () => {
  await withServer(async ({ store, base }) => {
    const note = store.create('note', { title: 'Unangetastet', body: 'Bleibt so' });
    store.create('task', { title: 'Überfällig', due: isoDate(-2) });
    withActor({ kind: 'agent', runId: RUN_ID, agentId: AGENT_ID }, () => {
      store.create('task', { title: 'Vom Agenten', due: isoDate(0) });
    });

    const vorher = snapshot(store);

    // Dreimal ansehen – ein Morgen, den man zweimal aufruft, muss zweimal
    // derselbe sein.
    for (let i = 0; i < 3; i++) {
      const res = await request(base, 'GET', '/api/today');
      assert.equal(res.status, 200, res.text);
    }

    const nachher = snapshot(store);
    assert.deepEqual(nachher.counts, vorher.counts, 'keine neue Art, kein neuer Satz');
    assert.equal(nachher.gesamt, vorher.gesamt);
    assert.equal(nachher.seq, vorher.seq, 'kein einziger Schreibvorgang im Log');
    assert.deepEqual(nachher.records, vorher.records, 'keine Fassung und kein Zeitstempel hat sich bewegt');
    assert.equal(store.get(note.id).rev, 1);
  });
});

test('auch die Wiedervorlage schreibt nichts, obwohl sie den ganzen Tresor liest', async () => {
  await withServer(async ({ store }) => {
    for (let i = 0; i < 20; i++) store.create('note', { title: `Notiz ${i}`, body: 'Text' });
    const vorher = snapshot(store);
    const spaeter = Date.now() + (todayApi.REVISIT_MIN_AGE_DAYS + 10) * DAY;
    const items = todayApi.wiedervorlageBlock(store, spaeter, todayApi.labelerFor({}));
    assert.equal(items.length, 3, 'höchstens drei – mehr als drei ist keine Wiedervorlage mehr');
    assert.deepEqual(snapshot(store), vorher);
  });
});

/* ------------------------------------------------------------- Eingaben */

test('unsinnige Parameter werden geklemmt, nicht geglaubt', async () => {
  await withServer(async ({ base }) => {
    const gross = await request(base, 'GET', '/api/today?stunden=999999&limit=100000');
    assert.equal(gross.status, 200, gross.text);
    assert.equal(gross.json.stunden, 24 * 7, 'eine Woche ist die Grenze');

    const text = await request(base, 'GET', '/api/today?stunden=viele');
    assert.equal(text.status, 400, text.text);
    assert.match(text.json.error.message, /muss eine Zahl sein/);
  });
});

module.exports = { name: 'today', tests: drain() };
