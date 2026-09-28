'use strict';

/**
 * Paket K2 (docs/STICK-BAUPLAN.md, Abschnitt 2.9): Dateien im Postfach
 * gekoppelter Sticks.
 *
 * Wie test/kopplung.test.js: echte Apps auf Temp-Sticks, echte Tresore, echte
 * Postfächer; welche Sticks "stecken", sagt eine eingespielte Liste von
 * Einhängepunkten, und die Tests rufen `abgleichen()` selbst auf.
 *
 * Was hier gilt:
 *  - Ein Datei-Satz reist mit seinem Inhalt (Blob) und seinem ausgelesenen
 *    Text. Der Blob liegt einzeln versiegelt in `<postfach>/dateien/<hash>.enc`.
 *  - Abgelegt wird nur, was einem Empfänger laut seiner letzten Kopfzeile
 *    fehlt; was alle haben, verschwindet wieder aus dem Postfach.
 *  - Höchstens 50 MB je Datei.
 *  - Ein voller Stick bringt die vorhandene Meldung und keinen halben Stand:
 *    kein Satz ohne Inhalt, beim Schreiben bleibt das alte Postfach gültig.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { test, tempHome } = require('./harness');

const { createApp } = require('../src/app');
const pathsMod = require('../src/kernel/paths');
const merge = require('../src/sync/merge');
const { createVaultCrypto } = require('../src/store/vaultcrypto');

const VERSION = require('../package.json').version;
const KEIN_PLATZ = /Auf dem Datenträger ist kein Platz mehr frei\./;

/** Ein kleines, echtes PNG (1x1, rot) und ein kleines PDF: der Chat prüft die Art am Inhalt. */
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415478da63f8cfc0000003010100c9fe92ef0000000049454e44ae426082',
  'hex',
);
const PDF_KLEIN = Buffer.from([
  '%PDF-1.4',
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
  '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
  '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj',
  'trailer << /Root 1 0 R >>',
  '%%EOF',
].join('\n'), 'latin1');

/* ------------------------------------------------------------- Helfer */

function tempStick(label) {
  const t = tempHome(`kopplung-dateien-${label}`);
  const root = t.home;
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'package.json'), JSON.stringify({ name: 'neural-os', version: VERSION }));
  fs.writeFileSync(path.join(root, pathsMod.PORTABLE_MARKER), JSON.stringify({
    neuralOsPortable: true, dataDir: 'data', appDir: 'app', createdAt: '2026-09-01T10:00:00.000Z',
  }, null, 2));
  return { ...t, root, data: path.join(root, 'data'), appDir: path.join(root, 'app'), sync: path.join(root, 'sync') };
}

async function pinAnlegen(stick, pin) {
  const secrets = path.join(stick.data, 'secrets.json');
  if (fs.existsSync(secrets)) return;
  const vc = createVaultCrypto({ paths: { secrets }, config: {}, geraet: false });
  await vc.initialise(pin);
  vc.lock();
}

async function starte(stick, welt, { pin, name } = {}) {
  if (pin) await pinAnlegen(stick, pin);
  const app = await createApp({
    home: stick.data,
    appDir: stick.appDir,
    port: 0,
    host: '127.0.0.1',
    logLevel: 'error',
    harden: false,
    passphrase: pin,
    kopplung: { automatisch: false, einhaengepunkte: () => [...welt] },
  });
  if (name && app.identitaet.name !== name) app.identitaet.umbenennen(name);
  return app;
}

async function welt(fn) {
  const sticks = [];
  const apps = new Set();
  const w = new Set();
  const geraete = tempHome('kopplung-dateien-geraete');
  const vorher = process.env.NEURAL_OS_GERAETE;
  process.env.NEURAL_OS_GERAETE = geraete.home;
  const env = {
    welt: w,
    stick(label) {
      const s = tempStick(label);
      sticks.push(s);
      w.add(s.root);
      return s;
    },
    async start(stick, opts) {
      const app = await starte(stick, w, opts);
      apps.add(app);
      return app;
    },
    async stop(app) {
      apps.delete(app);
      await app.close();
    },
  };
  try {
    return await fn(env);
  } finally {
    for (const app of apps) await app.close().catch(() => {});
    for (const s of sticks) s.cleanup();
    if (vorher === undefined) delete process.env.NEURAL_OS_GERAETE;
    else process.env.NEURAL_OS_GERAETE = vorher;
    geraete.cleanup();
  }
}

async function koppeln(appA, appB, stickB, pinB) {
  await appA.kopplung.koppeln({ root: stickB.root, pin: pinB });
  const r = await appB.kopplung.annehmen();
  assert.equal(r.angenommen.length, 1, 'B hat das Angebot nicht angenommen');
}

/** Eine Datei so ablegen, wie es Chat, Notizen und Ordnerbeobachtung tun: erst der Blob, dann der Satz. */
function dateiAnlegen(app, { name, inhalt, text = null, mime = 'text/plain' }) {
  const buf = Buffer.isBuffer(inhalt) ? inhalt : Buffer.from(inhalt, 'utf8');
  const abgelegt = app.store.files.put(buf, { name, mime });
  return app.store.create('file', { name, hash: abgelegt.hash, mime, size: buf.length, text });
}

function alleDateien(dir) {
  const out = [];
  let eintraege = [];
  try { eintraege = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of eintraege) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...alleDateien(p));
    else out.push(p);
  }
  return out;
}

/** Was im Postfach von `id` im Ordner `sync` unter dateien/ liegt (Dateinamen). */
function imPostfach(sync, id) {
  try {
    return fs.readdirSync(path.join(sync, id, 'dateien')).sort();
  } catch {
    return [];
  }
}

/** Jeder Datei-Satz auf diesem Stick hat seinen Inhalt: kein Satz, der ins Leere zeigt. */
function keinSatzOhneInhalt(app) {
  for (const f of app.store.list('file').items) {
    if (f.data.hash) assert.ok(app.store.files.has(f.data.hash), `Satz ${f.id} (${f.data.name}) ohne Inhalt`);
  }
}

/** Den Blob-Ordner von B voll machen: jede neue Datei darunter scheitert mit ENOSPC (ab dem `ab`-ten Versuch). */
function vollerOrdnerSync(ordner, { ab = 1 } = {}) {
  const echt = fs.openSync;
  let n = 0;
  fs.openSync = function voll(p, ...rest) {
    if (String(p).startsWith(ordner + path.sep) && ++n >= ab) {
      throw Object.assign(new Error('ENOSPC: no space left on device, open'), { code: 'ENOSPC' });
    }
    return echt.call(this, p, ...rest);
  };
  return () => { fs.openSync = echt; };
}

function vollerOrdnerAsync(ordner) {
  const echt = fs.promises.open;
  fs.promises.open = async function voll(p, ...rest) {
    if (String(p).startsWith(ordner + path.sep)) {
      throw Object.assign(new Error('ENOSPC: no space left on device, open'), { code: 'ENOSPC' });
    }
    return echt.call(this, p, ...rest);
  };
  return () => { fs.promises.open = echt; };
}

/** statfs meldet für diesen Ordner nur noch `frei` Bytes. */
function wenigPlatz(ordner, frei) {
  const echt = fs.statfsSync;
  fs.statfsSync = function wenig(p, ...rest) {
    const st = echt.call(this, p, ...rest);
    if (String(p) === ordner || String(p).startsWith(ordner + path.sep)) {
      return { ...st, bsize: 4096, bavail: Math.floor(frei / 4096), bfree: Math.floor(frei / 4096) };
    }
    return st;
  };
  return () => { fs.statfsSync = echt; };
}

/* ---------------------------------------------------------------- Tests */

test('2.9: ein Datei-Satz mit Blob kommt samt Inhalt und data.text an, in beide Richtungen', async () => {
  await welt(async (w) => {
    const A = w.stick('a');
    const B = w.stick('b');
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);

    const inhaltA = `Bericht von Max ${crypto.randomBytes(8).toString('hex')}\n`.repeat(50);
    const fA = dateiAnlegen(appA, { name: 'Bericht.txt', inhalt: inhaltA, text: 'Ausgelesener Text von Max' });
    const inhaltB = crypto.randomBytes(200 * 1024);
    const fB = dateiAnlegen(appB, { name: 'Foto.bin', inhalt: inhaltB, mime: 'application/octet-stream' });

    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    await appA.kopplung.abgleichen();

    const beiB = appB.store.get(fA.id);
    assert.ok(beiB, 'der Datei-Satz von A fehlt bei B');
    assert.deepEqual(beiB.data, fA.data);
    assert.equal(beiB.data.text, 'Ausgelesener Text von Max');
    assert.equal(appB.store.files.read(fA.data.hash).toString('utf8'), inhaltA, 'der Inhalt kam nicht an');
    assert.equal(merge.fingerprint(beiB), merge.fingerprint(fA));

    const beiA = appA.store.get(fB.id);
    assert.ok(beiA, 'der Datei-Satz von B fehlt bei A');
    assert.ok(appA.store.files.read(fB.data.hash).equals(inhaltB), 'der Inhalt von B kam nicht an');
    keinSatzOhneInhalt(appA);
    keinSatzOhneInhalt(appB);
  });
});

test('2.9: mit PIN: der Blob kommt an; einzeln versiegelt in dateien/<hash>.enc, unter sync/ nirgends Klartext', async () => {
  await welt(async (w) => {
    const A = w.stick('a');
    const B = w.stick('b');
    const appA = await w.start(A, { name: 'Max', pin: '1357' });
    const appB = await w.start(B, { name: 'Lena', pin: '2468' });
    await koppeln(appA, appB, B, '2468');

    const inhalt = 'GEHEIMER-DATEIINHALT '.repeat(400);
    const f = dateiAnlegen(appA, { name: 'Tagebuch.txt', inhalt, text: 'GEHEIMER-AUSZUG' });
    await appA.kopplung.abgleichen();

    const idA = appA.identitaet.id;
    assert.deepEqual(imPostfach(B.sync, idA), [`${f.data.hash}.enc`], 'der Blob liegt nicht im Postfach von A auf B');
    const siegel = fs.readFileSync(path.join(B.sync, idA, 'dateien', `${f.data.hash}.enc`));
    assert.ok(siegel.length > Buffer.byteLength(inhalt) && siegel.length < Buffer.byteLength(inhalt) + 64, `Größe ${siegel.length}`);

    await appB.kopplung.abgleichen();
    assert.equal(appB.store.files.read(f.data.hash).toString('utf8'), inhalt);
    assert.equal(appB.store.get(f.id).data.text, 'GEHEIMER-AUSZUG');
    // Auch im Tresor von B liegt der Blob versiegelt.
    assert.equal(fs.readFileSync(appB.store.files.path(f.data.hash)).includes('GEHEIMER'), false, 'Blob im Tresor von B im Klartext');

    const dateien = [...alleDateien(A.sync), ...alleDateien(B.sync)];
    assert.ok(dateien.some((d) => d.endsWith('.enc') && d.includes(`${path.sep}dateien${path.sep}`)), 'kein Blob unter sync/');
    for (const datei of dateien) {
      const roh = fs.readFileSync(datei);
      assert.equal(roh.includes('GEHEIMER'), false, `Klartext in ${datei}`);
      assert.equal(roh.includes('Tagebuch'), false, `Dateiname im Klartext in ${datei}`);
    }
  });
});

test('2.9: Chat-Anhang (Bild, PDF) aus dem Chat von A öffnet sich im selben Chat auf B', async () => {
  await welt(async (w) => {
    const A = w.stick('a');
    const B = w.stick('b');
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);
    assert.ok(appA.chat && typeof appA.chat.anhangAblegen === 'function', 'Vorbedingung: Chat mit Anhängen');

    const chat = appA.store.create('chat', { title: 'Urlaub' });
    const bild = appA.chat.anhangAblegen({ chatId: chat.id, name: 'rot.png', mime: 'image/png', daten: PNG_1X1.toString('base64') }).anhang;
    const pdf = appA.chat.anhangAblegen({ chatId: chat.id, name: 'Plan.pdf', mime: 'application/pdf', daten: PDF_KLEIN.toString('base64') }).anhang;
    appA.store.create('message', {
      chatId: chat.id, role: 'user', content: 'Schau mal', ordinal: 1,
      anhaenge: [bild, pdf].map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size })),
    });

    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();

    assert.ok(appB.chat.anhangDatei(chat.id, bild.id).buf.equals(PNG_1X1), 'das Bild öffnet sich auf B nicht');
    assert.ok(appB.chat.anhangDatei(chat.id, pdf.id).buf.equals(PDF_KLEIN), 'das PDF öffnet sich auf B nicht');
    const nachricht = appB.store.list('message').items.find((m) => m.data.chatId === chat.id);
    assert.deepEqual(nachricht.data.anhaenge.map((a) => a.id), [bild.id, pdf.id]);
  });
});

test('2.9: nur was fehlt: was der Partner laut seiner Kopfzeile hat, legt A nicht ab; nach der Übernahme verschwindet der Blob', async () => {
  await welt(async (w) => {
    const A = w.stick('a');
    const B = w.stick('b');
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);
    const idA = appA.identitaet.id;

    // B hat denselben Inhalt schon (eigener Satz) und sagt es in seiner Kopfzeile.
    const gemeinsam = 'Stundenplan 7b\n'.repeat(100);
    const fB = dateiAnlegen(appB, { name: 'plan-lena.txt', inhalt: gemeinsam });
    await appB.kopplung.abgleichen();

    const fA = dateiAnlegen(appA, { name: 'plan-max.txt', inhalt: gemeinsam });
    const neu = dateiAnlegen(appA, { name: 'neu.txt', inhalt: `nur bei Max ${crypto.randomBytes(8).toString('hex')}` });
    assert.equal(fA.data.hash, fB.data.hash);
    await appA.kopplung.abgleichen();

    const erwartet = [`${neu.data.hash}.enc`];
    assert.deepEqual(imPostfach(B.sync, idA), erwartet, 'auf B liegt mehr oder weniger als der fehlende Blob');
    assert.deepEqual(imPostfach(A.sync, idA), erwartet, 'im eigenen Postfach liegt mehr oder weniger als der fehlende Blob');

    await appB.kopplung.abgleichen();
    assert.ok(appB.store.get(fA.id), 'der Satz, dessen Inhalt B schon hatte, fehlt');
    assert.ok(appB.store.get(neu.id), 'der Satz mit dem fehlenden Blob fehlt');
    assert.ok(appB.store.files.has(neu.data.hash));
    keinSatzOhneInhalt(appB);

    // B hat jetzt alles: A räumt den Blob beim nächsten Schreiben weg.
    await appA.kopplung.abgleichen();
    assert.deepEqual(imPostfach(B.sync, idA), [], 'der übernommene Blob liegt weiter auf B');
    assert.deepEqual(imPostfach(A.sync, idA), [], 'der übernommene Blob liegt weiter im eigenen Postfach');
    // Und danach ist Ruhe: kein neues Postfach ohne Änderung.
    const r = await appA.kopplung.abgleichen();
    const r2 = await appB.kopplung.abgleichen();
    assert.deepEqual([r.geschrieben.length, r2.geschrieben.length], [0, 0], 'ohne Änderung wird weiter geschrieben');
  });
});

test('2.9: voller Stick beim Übernehmen (Tresor von B): kein halb angelegter Satz, die vorhandene Meldung; danach kommt alles an', async () => {
  for (const art of ['statfs', 'enospc']) {
    await welt(async (w) => {
      const A = w.stick('a');
      const B = w.stick('b');
      const appA = await w.start(A, { name: 'Max' });
      const appB = await w.start(B, { name: 'Lena' });
      await koppeln(appA, appB, B);

      const n = appA.store.create('note', { title: 'Mit Anhang', body: 'siehe Dateien' });
      const f1 = dateiAnlegen(appA, { name: 'eins.bin', inhalt: crypto.randomBytes(64 * 1024) });
      const f2 = dateiAnlegen(appA, { name: 'zwei.bin', inhalt: crypto.randomBytes(64 * 1024) });
      await appA.kopplung.abgleichen();

      const tresor = appB.paths.files;
      const vorher = alleDateien(tresor).length;
      const zurueck = art === 'statfs' ? wenigPlatz(tresor, 1024 * 1024) : vollerOrdnerSync(tresor, { ab: 2 });
      let r;
      try {
        r = await appB.kopplung.abgleichen();
      } finally {
        zurueck();
      }
      assert.ok(r.warnungen.some((t) => KEIN_PLATZ.test(t)), `${art}: keine Meldung: ${JSON.stringify(r.warnungen)}`);
      assert.equal(appB.store.get(f1.id), null, `${art}: Satz eins ohne vollständiges Postfach angelegt`);
      assert.equal(appB.store.get(f2.id), null, `${art}: Satz zwei ohne Inhalt angelegt`);
      assert.equal(appB.store.get(n.id), null, `${art}: das Postfach wurde halb übernommen`);
      keinSatzOhneInhalt(appB);
      if (art === 'statfs') assert.equal(alleDateien(tresor).length, vorher, 'trotz zu wenig Platz wurde geschrieben');
      assert.equal(alleDateien(tresor).some((d) => path.basename(d).includes('.tmp-')), false, 'Reste eines halben Blobs');

      // Platz ist wieder da: beim nächsten Abgleich kommt alles an.
      await appB.kopplung.abgleichen();
      assert.ok(appB.store.get(n.id), `${art}: die Notiz fehlt`);
      assert.ok(appB.store.files.read(f1.data.hash).equals(appA.store.files.read(f1.data.hash)), `${art}: eins`);
      assert.ok(appB.store.files.read(f2.data.hash).equals(appA.store.files.read(f2.data.hash)), `${art}: zwei`);
    });
  }
});

test('2.9: voller Partner-Stick beim Ablegen: das alte Postfach bleibt gültig, kein halber Blob, die vorhandene Meldung; danach kommt die Datei an', async () => {
  for (const art of ['enospc', 'statfs']) {
    await welt(async (w) => {
      const A = w.stick('a');
      const B = w.stick('b');
      const appA = await w.start(A, { name: 'Max' });
      const appB = await w.start(B, { name: 'Lena' });
      await koppeln(appA, appB, B);
      const idA = appA.identitaet.id;
      await appA.kopplung.abgleichen();
      const manifest = path.join(B.sync, idA, 'manifest.json');
      const manifestVorher = fs.readFileSync(manifest, 'utf8');

      const f = dateiAnlegen(appA, { name: 'gross.bin', inhalt: crypto.randomBytes(300 * 1024) });
      const zurueck = art === 'statfs'
        ? wenigPlatz(B.sync, 2 * 1024 * 1024)
        : vollerOrdnerAsync(path.join(B.sync, idA, 'dateien'));
      let r;
      try {
        r = await appA.kopplung.abgleichen();
      } finally {
        zurueck();
      }
      assert.ok(r.warnungen.some((t) => KEIN_PLATZ.test(t)), `${art}: keine Meldung: ${JSON.stringify(r.warnungen)}`);
      assert.equal(fs.readFileSync(manifest, 'utf8'), manifestVorher, `${art}: das alte Postfach auf B wurde ersetzt`);
      assert.deepEqual(imPostfach(B.sync, idA), [], `${art}: halber Blob auf B`);
      assert.equal(r.zwilling, false);
      // Das eigene Postfach (anderer Stick) ist davon nicht betroffen.
      assert.deepEqual(imPostfach(A.sync, idA), [`${f.data.hash}.enc`]);

      // B liest, solange auf seinem Stick das alte Postfach liegt: kein Satz ohne Inhalt.
      w.welt.delete(A.root);
      await appB.kopplung.abgleichen();
      assert.equal(appB.store.get(f.id), null);
      keinSatzOhneInhalt(appB);

      w.welt.add(A.root);
      const r2 = await appA.kopplung.abgleichen();
      assert.ok(r2.geschrieben.some((g) => g.ordner === B.sync), `${art}: A schreibt nicht wieder auf B: ${JSON.stringify(r2)}`);
      w.welt.delete(A.root);
      await appB.kopplung.abgleichen();
      assert.ok(appB.store.files.read(f.data.hash).equals(appA.store.files.read(f.data.hash)), `${art}: die Datei kam nicht an`);
    });
  }
});

test('2.9: über 50 MB reist nicht (kein Satz ohne Inhalt bei B), die kleine Datei daneben schon; A sagt es in einem Satz', async () => {
  await welt(async (w) => {
    const A = w.stick('a');
    const B = w.stick('b');
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);
    const idA = appA.identitaet.id;

    const gross = dateiAnlegen(appA, { name: 'Film.mp4', inhalt: Buffer.alloc(50 * 1024 * 1024 + 1, 7), mime: 'video/mp4' });
    const klein = dateiAnlegen(appA, { name: 'Notiz.txt', inhalt: 'klein' });
    const saetze = [];
    const ab = appA.bus.subscribe((evt) => { if (evt && evt.name === 'sync.warning') saetze.push(evt.payload || evt.data || evt); });
    try {
      await appA.kopplung.abgleichen();
    } finally {
      ab();
    }
    assert.ok(JSON.stringify(saetze).includes('„Film.mp4“ ist größer als 50 MB und bleibt auf diesem Stick.'), JSON.stringify(saetze));
    assert.deepEqual(imPostfach(B.sync, idA), [`${klein.data.hash}.enc`]);

    await appB.kopplung.abgleichen();
    assert.ok(appB.store.get(klein.id), 'die kleine Datei fehlt');
    assert.equal(appB.store.get(gross.id), null, 'Satz ohne Inhalt bei B');
    assert.equal(appB.store.files.has(gross.data.hash), false);
    keinSatzOhneInhalt(appB);
  });
});

test('2.9: ein Datei-Satz, dessen Inhalt erst später kommt, wird nachgeholt, auch nach einem alten Stand mit „blob-missing“', async () => {
  await welt(async (w) => {
    const A = w.stick('a');
    const B = w.stick('b');
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);
    const idA = appA.identitaet.id;

    const inhalt = Buffer.from('kommt später');
    const f = dateiAnlegen(appA, { name: 'spaeter.txt', inhalt });
    // A hat den Inhalt selbst gerade nicht (etwa aus einer Sicherung ohne Anhänge).
    fs.unlinkSync(appA.store.files.path(f.data.hash));
    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    assert.equal(appB.store.get(f.id), null, 'Satz ohne Inhalt bei B');

    // So stand es vor Paket K2 in sync-folder.json von B: eine Basis mit dem Vermerk "blob-missing".
    const folderB = appB.kopplung.__internals.folder;
    const s = folderB.__internals.loadState();
    s.devices[idA].bases[f.id] = { h: merge.fingerprint(f), at: new Date().toISOString(), note: 'blob-missing' };
    assert.equal(folderB.__internals.saveState(), true);

    appA.store.files.put(inhalt);
    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    assert.ok(appB.store.get(f.id), 'der Satz kam nicht nach, als der Inhalt da war');
    assert.ok(appB.store.files.read(f.data.hash).equals(inhalt));
  });
});

test('2.9: A–B und B–C: die Datei von A erreicht C über B, samt Inhalt', async () => {
  await welt(async (w) => {
    const A = w.stick('a');
    const B = w.stick('b');
    const C = w.stick('c');
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    const appC = await w.start(C, { name: 'Tom' });
    await koppeln(appA, appB, B);
    await koppeln(appB, appC, C);

    const inhalt = crypto.randomBytes(48 * 1024);
    const f = dateiAnlegen(appA, { name: 'Arbeitsblatt.pdf', inhalt, text: 'Aufgabe 1', mime: 'application/pdf' });
    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    await appC.kopplung.abgleichen();

    assert.ok(appC.store.get(f.id), 'die Datei von A kam bei C nicht an');
    assert.equal(appC.store.get(f.id).data.text, 'Aufgabe 1');
    assert.ok(appC.store.files.read(f.data.hash).equals(inhalt));
    keinSatzOhneInhalt(appC);
  });
});

test('2.9: ein beschädigter Blob im Postfach: B legt keinen halben Satz an und sagt es in seiner Kopfzeile; A legt ihn neu ab, dann kommt er an', async () => {
  await welt(async (w) => {
    const A = w.stick('a');
    const B = w.stick('b');
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);
    const idA = appA.identitaet.id;

    const inhalt = crypto.randomBytes(32 * 1024);
    const f = dateiAnlegen(appA, { name: 'kaputt.bin', inhalt });
    await appA.kopplung.abgleichen();
    for (const sync of [A.sync, B.sync]) {
      const datei = path.join(sync, idA, 'dateien', `${f.data.hash}.enc`);
      const roh = fs.readFileSync(datei);
      roh[roh.length - 10] ^= 0xff;
      fs.writeFileSync(datei, roh);
    }

    await appB.kopplung.abgleichen();
    assert.equal(appB.store.get(f.id), null, 'Satz mit beschädigtem Inhalt angelegt');
    keinSatzOhneInhalt(appB);

    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    assert.ok(appB.store.get(f.id), 'der neu abgelegte Blob kam nicht an');
    assert.ok(appB.store.files.read(f.data.hash).equals(inhalt));
  });
});
