'use strict';

/**
 * Paket S (docs/STICK-BAUPLAN.md, 2.4 Nr. 5, Teil 1.4): [Beenden] sagt
 * "Gespeichert. Stick kann raus." Danach darf Neural OS nichts mehr auf den
 * eigenen oder den Partner-Stick schreiben -- sonst zieht, wer auf den Satz
 * hin zieht, mitten in rename und fsync (Prüfung Runde 2: der letzte
 * Abgleich lief erst NACH der 202).
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { test, tempHome } = require('./harness');
const { createApp } = require('../src/app');
const pathsMod = require('../src/kernel/paths');

const VERSION = require('../package.json').version;

function tempStick(label) {
  const t = tempHome(`beenden-${label}`);
  fs.mkdirSync(path.join(t.home, 'data'), { recursive: true });
  fs.mkdirSync(path.join(t.home, 'app'), { recursive: true });
  fs.writeFileSync(path.join(t.home, 'app', 'package.json'), JSON.stringify({ name: 'neural-os', version: VERSION }));
  fs.writeFileSync(path.join(t.home, pathsMod.PORTABLE_MARKER), JSON.stringify({ neuralOsPortable: true, dataDir: 'data', appDir: 'app' }));
  return { ...t, root: t.home, data: path.join(t.home, 'data'), appDir: path.join(t.home, 'app') };
}

function starte(stick, welt, automatisch) {
  return createApp({
    home: stick.data, appDir: stick.appDir, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false,
    kopplung: { automatisch, einhaengepunkte: () => [...welt], zeiten: { startMs: 1, suchlaufMs: 1e7, ruheMs: 60000 } },
  });
}

/** Inhalt jeder Datei unter den Ordnern, als Pfad -> sha256. */
function abbild(ordner) {
  const out = new Map();
  const gehe = (d) => {
    let e = [];
    try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const x of e) {
      const p = path.join(d, x.name);
      if (x.isDirectory()) gehe(p);
      else out.set(p, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  for (const o of ordner) gehe(o);
  return out;
}

function unterschiede(vorher, nachher) {
  const out = [];
  for (const [p, h] of nachher) if (vorher.get(p) !== h) out.push(p);
  return out;
}

test('[Beenden] mit gekoppeltem Partner: der letzte Abgleich steht VOR der 202, danach wird nichts mehr auf die Sticks geschrieben', async () => {
  const geraete = tempHome('beenden-geraete');
  const vorherGeraete = process.env.NEURAL_OS_GERAETE;
  process.env.NEURAL_OS_GERAETE = geraete.home;
  const A = tempStick('a');
  const B = tempStick('b');
  const welt = new Set([A.root, B.root]);
  let a = null;
  try {
    let b = await starte(B, welt, false);
    await b.close();
    a = await starte(A, welt, false);
    await a.kopplung.koppeln({ root: B.root });
    await a.close();
    b = await starte(B, welt, false);
    await b.kopplung.annehmen();
    await b.close();

    // A läuft wie im Dienst: automatisch, der erste Abgleich ist durch.
    a = await starte(A, welt, true);
    await new Promise((r) => { setTimeout(r, 300); });
    a.store.create('note', { title: 'kurz vor Beenden', body: 'x' });
    let fertig = null;
    const zu = new Promise((r) => { fertig = r; });
    a.beenden = async () => { await a.close(); fertig(); };
    await a.listen({ port: 0 });
    const port = a.server.server.address().port;

    const beobachtet = [path.join(A.root, 'sync'), path.join(B.root, 'sync'), path.join(A.data, 'kopplungen.json'), path.join(A.data, 'sync-folder.json')];
    const beiAntwort = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/api/system/beenden', method: 'POST',
        headers: { 'x-neural-os': '1', 'content-type': 'application/json', host: `127.0.0.1:${port}` },
      }, (res) => {
        // Der Stand in dem Augenblick, in dem die Seite "Stick kann raus." zeigt.
        const stand = abbild([path.join(A.root, 'sync'), path.join(B.root, 'sync'), A.data]);
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, stand }));
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(beiAntwort.status, 202);
    await zu;
    a = null;

    const danach = abbild([path.join(A.root, 'sync'), path.join(B.root, 'sync'), A.data]);
    const spaet = unterschiede(beiAntwort.stand, danach)
      .filter((p) => beobachtet.some((o) => p === o || p.startsWith(`${o}${path.sep}`)));
    assert.deepEqual(spaet.map((p) => path.relative(path.dirname(A.root), p)), [], 'nach "Stick kann raus." geschrieben');
    const postfaecher = [...danach.keys()].filter((p) => p.startsWith(path.join(B.root, 'sync')) && p.endsWith('manifest.json'));
    assert.ok(postfaecher.length >= 1, 'das Postfach von A liegt auf B');
  } finally {
    if (a) await a.close().catch(() => {});
    if (vorherGeraete === undefined) delete process.env.NEURAL_OS_GERAETE;
    else process.env.NEURAL_OS_GERAETE = vorherGeraete;
    A.cleanup();
    B.cleanup();
    geraete.cleanup();
  }
});
