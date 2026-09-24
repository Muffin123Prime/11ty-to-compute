'use strict';

/**
 * Paket K1 (docs/STICK-BAUPLAN.md, Abschnitt 2.8): Koppeln, Kern.
 *
 * Zwei oder drei Temp-Sticks, jeder mit Marker, `data/`, `app/package.json`
 * und einem eigenen `sync/`. Jede KI läuft als echte App (`createApp` mit
 * `appDir` auf dem Stick), mit echtem Tresor und echten Postfächern. Welche
 * Sticks "stecken", sagt eine Liste von Einhängepunkten, die jede KI
 * eingespielt bekommt (`kopplung.einhaengepunkte`); Zeitgeber und
 * Bus-Auslöser sind aus (`automatisch: false`), die Tests rufen `annehmen()`
 * und `abgleichen()` selbst auf.
 *
 * Die Nummern im Testnamen sind die Nummern der Tests im Bauplan.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { test, tempHome } = require('./harness');

const { createApp, seedIfEmpty } = require('../src/app');
const pathsMod = require('../src/kernel/paths');
const merge = require('../src/sync/merge');
const { createVaultCrypto } = require('../src/store/vaultcrypto');

const VERSION = require('../package.json').version;

/** Erst beim Aufruf laden: fehlt das Modul, ist jeder Test einzeln rot. */
function kopplungMod() {
  return require('../src/sync/kopplung');
}

/* ------------------------------------------------------------- Helfer */

/** Ein Stick, wie "Stick vorbereiten" ihn anlegt: Marker, data/, app/. */
function tempStick(label, { version = VERSION } = {}) {
  const t = tempHome(`kopplung-${label}`);
  const root = t.home;
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'package.json'), JSON.stringify({ name: 'neural-os', version }));
  fs.writeFileSync(path.join(root, pathsMod.PORTABLE_MARKER), JSON.stringify({
    neuralOsPortable: true, dataDir: 'data', appDir: 'app', createdAt: '2026-09-01T10:00:00.000Z',
  }, null, 2));
  return {
    ...t,
    root,
    data: path.join(root, 'data'),
    appDir: path.join(root, 'app'),
    sync: path.join(root, 'sync'),
    marker: () => JSON.parse(fs.readFileSync(path.join(root, pathsMod.PORTABLE_MARKER), 'utf8')),
  };
}

/** Die PIN so anlegen, wie es die Einstellungen tun: vor dem Start liegt secrets.json da. */
async function pinAnlegen(stick, pin) {
  const secrets = path.join(stick.data, 'secrets.json');
  if (fs.existsSync(secrets)) return;
  const vc = createVaultCrypto({ paths: { secrets }, config: {}, geraet: false });
  await vc.initialise(pin);
  vc.lock();
}

/**
 * Eine KI auf dem Stick starten. `welt` ist die Menge der steckenden Sticks
 * (ihre Wurzeln); die KI sucht nur dort.
 */
async function starte(stick, welt, { pin, name, dateisystem } = {}) {
  if (pin) await pinAnlegen(stick, pin);
  const app = await createApp({
    home: stick.data,
    appDir: stick.appDir,
    port: 0,
    host: '127.0.0.1',
    logLevel: 'error',
    harden: false,
    passphrase: pin,
    kopplung: { automatisch: false, einhaengepunkte: () => [...welt], ...(dateisystem ? { dateisystem } : {}) },
  });
  if (name && app.identitaet.name !== name) app.identitaet.umbenennen(name);
  return app;
}

/** Eine KI einmal starten (Kennung, Name, PIN) und wieder beenden, ohne Einführung. */
async function kiAnlegen(stick, name, { pin } = {}) {
  const app = await starte(stick, new Set(), { pin, name });
  const id = app.identitaet.id;
  await app.close();
  return id;
}

/** Gerätedateien ("dieses Gerät merken") nie im echten Profil suchen. */
async function mitProfil(fn) {
  const ordner = tempHome('kopplung-geraete');
  const vorher = process.env.NEURAL_OS_GERAETE;
  process.env.NEURAL_OS_GERAETE = ordner.home;
  try {
    return await fn();
  } finally {
    if (vorher === undefined) delete process.env.NEURAL_OS_GERAETE;
    else process.env.NEURAL_OS_GERAETE = vorher;
    ordner.cleanup();
  }
}

/** Mehrere Sticks und Apps, am Ende alles zu und weg. */
async function welt(fn) {
  const sticks = [];
  const apps = new Set();
  const w = new Set();
  const env = {
    welt: w,
    stick(label, opts) {
      const s = tempStick(label, opts);
      sticks.push(s);
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
    return await mitProfil(() => fn(env));
  } finally {
    for (const app of apps) await app.close().catch(() => {});
    for (const s of sticks) s.cleanup();
  }
}

/** Zwei laufende KIs koppeln: A bietet an, B nimmt an (B läuft, Suchlauf). */
async function koppeln(appA, appB, stickB, pinB) {
  await appA.kopplung.koppeln({ root: stickB.root, pin: pinB });
  const r = await appB.kopplung.annehmen();
  assert.equal(r.angenommen.length, 1, 'B hat das Angebot nicht angenommen');
}

function notiz(app, id) {
  const r = app.store.get(id, { includeDeleted: true });
  if (!r) return null;
  return r.deletedAt ? `${r.data.body} (gelöscht)` : r.data.body;
}

function notizen(app) {
  return app.store.list('note').items.map((n) => `${n.data.title}=${n.data.body}`).sort();
}

/** Alle Sätze, die beim Koppeln reisen, als `id -> fingerprint`. */
function abgleichbar(app) {
  const out = new Map();
  for (const type of merge.SYNC_TYPES) {
    for (const r of app.store.list(type).items) out.set(r.id, merge.fingerprint(r));
  }
  return out;
}

function kopien(app) {
  const out = [];
  for (const type of merge.SYNC_TYPES) {
    for (const r of app.store.list(type).items) if (merge.istKopieId(r.id)) out.push(r);
  }
  return out;
}

function offeneKonflikte(app) {
  return app.store.list('conflict', { filter: (r) => r.data.status !== 'resolved' }).items.length;
}

/** Jede Datei unter einem Ordner, rekursiv. */
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

function partnerVon(app, id) {
  return app.kopplung.status().partner.find((p) => p.id === id) || null;
}

/** Kein Klartext: ein Siegel ist nie gültiges JSON (das erste Byte sagt nichts, es ist zufällig). */
function istKlartext(roh) {
  try { JSON.parse(roh.toString('utf8')); return true; } catch { return false; }
}

/** Ein Postfach von Hand älter machen: nur `at` im Klartext-Manifest. */
function zurueckdatieren(box, stunden) {
  const datei = path.join(box, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(datei, 'utf8'));
  m.at = new Date(Date.now() - stunden * 3600 * 1000).toISOString();
  fs.writeFileSync(datei, JSON.stringify(m, null, 2));
}

/* ------------------------------------------------------ Tests aus dem Bauplan */

test('1: B läuft nicht; A koppelt; B nimmt beim Start an, hat alles von A, keine eigene Einführung, keine Dubletten', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    const idB = await kiAnlegen(B, 'Lena');
    w.welt.add(A.root);
    w.welt.add(B.root);

    const appA = await w.start(A, { name: 'Max' });
    assert.equal(await seedIfEmpty(appA), true, 'A bekommt seine Einführung');
    appA.store.create('note', { title: 'Nur auf A', body: 'reist zu B' });

    const gefunden = await appA.kopplung.finden();
    const lena = gefunden.find((g) => g.id === idB);
    assert.ok(lena, 'A findet B nicht');
    assert.equal(lena.name, 'Lena');
    assert.equal(lena.zustand, 'fremd');
    assert.equal(lena.pin, false);

    await appA.kopplung.koppeln({ root: lena.pfad });
    const p = partnerVon(appA, idB);
    assert.equal(p.name, 'Lena');
    assert.equal(p.zustand, 'wartet', 'solange B nicht lief, wartet die Kopplung');
    assert.ok(fs.existsSync(path.join(B.sync, 'koppeln', `${appA.identitaet.id}.angebot`)), 'kein Angebot auf B');
    assert.ok(fs.existsSync(path.join(B.sync, appA.identitaet.id, 'manifest.json')), 'A hat sein Postfach nicht auf B gelegt');

    const vonA = abgleichbar(appA);
    const idA = appA.identitaet.id;
    await w.stop(appA);
    w.welt.delete(A.root);

    // B startet wie bin/neural-os.js: Einführung prüfen, dann die Kopplung.
    const appB = await w.start(B);
    assert.equal(await seedIfEmpty(appB), false, 'B darf keine eigene Einführung anlegen');
    await appB.kopplung.starten();

    const st = appB.kopplung.status();
    assert.equal(st.partner.length, 1);
    assert.equal(st.partner[0].id, idA);
    assert.equal(st.partner[0].name, 'Max');
    assert.equal(st.partner[0].zustand, 'aktiv');
    assert.equal(st.hinweis, 'Gekoppelt mit Max.');
    assert.equal(fs.existsSync(path.join(B.sync, 'koppeln', `${idA}.angebot`)), false, 'das Angebot muss weg sein');

    const beiB = abgleichbar(appB);
    for (const [id, h] of vonA) assert.equal(beiB.get(id), h, `Satz ${id} fehlt bei B oder ist anders`);
    assert.equal(beiB.size, vonA.size, 'B hat Sätze, die A nicht hat (Dubletten?)');
    const willkommen = appB.store.list('note').items.filter((n) => n.data.title === 'Willkommen in Neural OS');
    assert.equal(willkommen.length, 1, 'die Einführung liegt doppelt');
    assert.equal(kopien(appB).length, 0);
  });
});

test('2: nur A ändert, bevor A das Echo liest -> kein Konflikt (p2c)', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);

    const x = appA.store.create('note', { title: 'X', body: 'v1' });
    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen(); // B übernimmt v1 und legt das Echo ab
    assert.equal(notiz(appB, x.id), 'v1');

    appA.store.update(x.id, { body: 'v2' });
    const r = await appA.kopplung.abgleichen(); // A liest das Echo zum ersten Mal
    assert.equal(r.konflikte, 0, 'falscher Konflikt');
    assert.equal(notiz(appA, x.id), 'v2');

    const rb = await appB.kopplung.abgleichen();
    assert.equal(rb.konflikte, 0);
    assert.equal(notiz(appB, x.id), 'v2');
    assert.equal(kopien(appA).length + kopien(appB).length, 0, 'es darf keine zweite Fassung geben');
  });
});

test('3: beide ändern -> auf beiden Sticks dieselben zwei Fassungen, ohne Rückfrage; drei weitere Runden ohne neue Kopien (v4)', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);
    const ereignisse = [];
    appA.bus.on('kopplung.zweiFassungen', (e) => ereignisse.push(e.payload));
    appB.bus.on('kopplung.zweiFassungen', (e) => ereignisse.push(e.payload));

    const x = appA.store.create('note', { title: 'Einkaufsliste', body: 'Ausgang' });
    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    await appA.kopplung.abgleichen();

    appA.store.update(x.id, { body: 'Fassung A' });
    appB.store.update(x.id, { body: 'Fassung B' });
    await appB.kopplung.abgleichen();
    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    await appA.kopplung.abgleichen();

    const a = notizen(appA);
    const b = notizen(appB);
    assert.deepEqual(a, b, 'die Sticks sind verschieden');
    const einkauf = a.filter((t) => t.startsWith('Einkaufsliste'));
    assert.equal(einkauf.length, 2, `erwartet zwei Fassungen: ${JSON.stringify(a)}`);
    assert.ok(einkauf.some((t) => /^Einkaufsliste \(Fassung von (Max|Lena)\)=Fassung [AB]$/.test(t)), JSON.stringify(einkauf));
    assert.ok(einkauf.some((t) => /^Einkaufsliste=Fassung [AB]$/.test(t)), JSON.stringify(einkauf));
    assert.equal(offeneKonflikte(appA) + offeneKonflikte(appB), 0, 'niemand wird gefragt');
    assert.ok(ereignisse.some((e) => e.titel === 'Einkaufsliste' && merge.istKopieId(e.kopieId)), JSON.stringify(ereignisse));

    const vorher = [kopien(appA).length, kopien(appB).length];
    for (let i = 0; i < 3; i++) {
      await appA.kopplung.abgleichen();
      await appB.kopplung.abgleichen();
    }
    assert.deepEqual([kopien(appA).length, kopien(appB).length], vorher);
    assert.deepEqual(notizen(appA), notizen(appB));
  });
});

test('4: gelöscht gegen geändert -> die geänderte Fassung bleibt', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);

    const x = appA.store.create('note', { title: 'X', body: 'Ausgang' });
    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    await appA.kopplung.abgleichen();

    appA.store.remove(x.id);
    appB.store.update(x.id, { body: 'B hat weitergeschrieben' });
    await appB.kopplung.abgleichen();
    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    await appA.kopplung.abgleichen();

    assert.equal(notiz(appA, x.id), 'B hat weitergeschrieben');
    assert.equal(notiz(appB, x.id), 'B hat weitergeschrieben');
    assert.equal(kopien(appA).length + kopien(appB).length, 0, 'gelöscht gegen geändert braucht keine Kopie');
  });
});

test('5: eine ältere vollständige Postfach-Kopie wird übergangen, kein Stick fällt zurück (p2d, v3b)', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);
    const idA = appA.identitaet.id;

    const x = appA.store.create('note', { title: 'X', body: 'v1' });
    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    appA.store.update(x.id, { body: 'v2' });
    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    assert.equal(notiz(appB, x.id), 'v2');

    // Explorer-Kopie beider Postfächer von A, als v2 der Stand war.
    const altB = path.join(w.stick('alt').root, 'auf-b');
    const altA = path.join(path.dirname(altB), 'auf-a');
    fs.cpSync(path.join(B.sync, idA), altB, { recursive: true });
    fs.cpSync(path.join(A.sync, idA), altA, { recursive: true });

    appA.store.update(x.id, { body: 'v3' });
    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    assert.equal(notiz(appB, x.id), 'v3');

    // p2d: nur die alte Kopie auf B, A steckt nicht.
    fs.rmSync(path.join(B.sync, idA), { recursive: true, force: true });
    fs.cpSync(altB, path.join(B.sync, idA), { recursive: true });
    w.welt.delete(A.root);
    const r = await appB.kopplung.abgleichen();
    assert.equal(r.uebernommen, 0);
    assert.equal(r.konflikte, 0);
    assert.equal(notiz(appB, x.id), 'v3', 'B ist zurückgefallen');

    // v3b: beide Postfächer von A sind alt, A steckt.
    fs.rmSync(path.join(A.sync, idA), { recursive: true, force: true });
    fs.cpSync(altA, path.join(A.sync, idA), { recursive: true });
    w.welt.add(A.root);
    const r2 = await appB.kopplung.abgleichen();
    assert.equal(r2.uebernommen, 0);
    assert.equal(notiz(appB, x.id), 'v3', 'B ist zurückgefallen (beide Kopien alt)');
    assert.equal(offeneKonflikte(appB), 0);
  });
});

test('6: ein Postfach von gestern mit einer Löschung -> die Löschung wird ausgeführt, keine Uhr-Warnung (p2b)', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);
    const idB = appB.identitaet.id;
    const warnungen = [];
    appA.bus.on('sync.warning', (e) => warnungen.push(e.payload));

    const x = appA.store.create('note', { title: 'X', body: 'bleibt nicht' });
    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    await appA.kopplung.abgleichen();

    appB.store.remove(x.id);
    await appB.kopplung.abgleichen();
    zurueckdatieren(path.join(B.sync, idB), 26);
    zurueckdatieren(path.join(A.sync, idB), 26);

    const r = await appA.kopplung.abgleichen();
    assert.equal(notiz(appA, x.id), 'bleibt nicht (gelöscht)', 'die Löschung von gestern muss ausgeführt sein');
    assert.equal(r.konflikte, 0);
    assert.equal(r.warnungen.filter((t) => /Uhr/.test(t)).length, 0, r.warnungen.join(' | '));
    assert.equal(warnungen.length, 0, JSON.stringify(warnungen));
  });
});

test('7: zwei Sticks mit verschiedenen PINs gleichen über K_AB ab; unter sync/ steht nirgends Klartext (p2f)', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max', pin: '1357' });
    const appB = await w.start(B, { name: 'Lena', pin: '2468' });
    assert.equal(appA.vaultCrypto.state, 'unlocked');
    await koppeln(appA, appB, B, '2468');

    appA.store.create('note', { title: 'GEHEIMTITEL-VON-MAX', body: 'nur fuer Lena' });
    appB.store.create('note', { title: 'GEHEIMTITEL-VON-LENA', body: 'nur fuer Max' });
    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    await appA.kopplung.abgleichen();

    assert.ok(notizen(appA).includes('GEHEIMTITEL-VON-LENA=nur fuer Max'), JSON.stringify(notizen(appA)));
    assert.ok(notizen(appB).includes('GEHEIMTITEL-VON-MAX=nur fuer Lena'), JSON.stringify(notizen(appB)));

    const dateien = [...alleDateien(A.sync), ...alleDateien(B.sync)];
    assert.ok(dateien.length >= 4, `zu wenige Dateien unter sync/: ${dateien.length}`);
    for (const datei of dateien) {
      const roh = fs.readFileSync(datei);
      for (const wort of ['GEHEIMTITEL', 'nur fuer']) {
        assert.equal(roh.includes(wort), false, `${wort} steht im Klartext in ${datei}`);
        assert.equal(roh.toString('latin1').includes(wort), false, `${wort} steht in ${datei}`);
      }
    }
  });
});

test('8: sync-folder.json bleibt mit dem Tresorschlüssel lesbar, auch bei zwei Kopplungen mit verschiedenen Schlüsseln (Befund 17)', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    const C = w.stick('c');
    for (const s of [A, B, C]) w.welt.add(s.root);
    const appA = await w.start(A, { name: 'Max', pin: '1111' });
    const appB = await w.start(B, { name: 'Lena', pin: '2222' });
    const appC = await w.start(C, { name: 'Tom', pin: '3333' });
    await koppeln(appA, appB, B, '2222');
    await koppeln(appA, appC, C, '3333');

    appA.store.create('note', { title: 'von A', body: 'a' });
    appB.store.create('note', { title: 'von B', body: 'b' });
    appC.store.create('note', { title: 'von C', body: 'c' });
    for (const app of [appA, appB, appC, appA]) await app.kopplung.abgleichen();
    assert.ok(notizen(appA).includes('von B=b') && notizen(appA).includes('von C=c'), JSON.stringify(notizen(appA)));

    const roh = fs.readFileSync(path.join(A.data, 'sync-folder.json'));
    assert.equal(istKlartext(roh), false, 'sync-folder.json liegt im Klartext neben einem Tresor mit PIN');
    const stand = JSON.parse(appA.vaultCrypto.decryptBuffer(roh).toString('utf8'));
    assert.ok(stand.devices[appB.identitaet.id], 'kein Stand für B');
    assert.ok(stand.devices[appC.identitaet.id], 'kein Stand für C');
    assert.ok(Object.keys(stand.devices[appB.identitaet.id].bases).length > 0);

    const kroh = fs.readFileSync(path.join(A.data, 'kopplungen.json'));
    assert.equal(istKlartext(kroh), false, 'kopplungen.json liegt im Klartext');
    const k = JSON.parse(appA.vaultCrypto.decryptBuffer(kroh).toString('utf8'));
    assert.equal(k.partner.length, 2);
    assert.notEqual(k.partner[0].schluessel, k.partner[1].schluessel, 'ein Schlüssel je Paar');

    // Und der Stand hält über einen Neustart.
    await w.stop(appA);
    const wieder = await w.start(A, { pin: '1111' });
    assert.equal(wieder.kopplung.status().partner.length, 2);
    const r = await wieder.kopplung.abgleichen();
    assert.equal(r.konflikte, 0);
  });
});

test('9: ein fremdes Postfach (Protokoll 1 im Klartext, Protokoll 2 ohne Eintrag für mich) wird nie gelesen und nicht gemeldet (p2e)', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    const F = w.stick('f');
    for (const s of [A, B, F]) w.welt.add(s.root);
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    const appF = await w.start(F, { name: 'Fremd' });
    await koppeln(appA, appB, B);
    await koppeln(appF, appB, B); // F ist mit B gekoppelt, nicht mit A
    const warnungen = [];
    appA.bus.on('sync.warning', (e) => warnungen.push(e.payload));

    // Protokoll 1, Klartext, von einem unbekannten Gerät.
    const fremd1 = `dev_${crypto.randomBytes(12).toString('hex')}`;
    const box1 = path.join(A.sync, fremd1);
    fs.mkdirSync(box1, { recursive: true });
    const zeile = JSON.stringify({ id: 'note_ffffffffffffffffffffffff', type: 'note', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', deletedAt: null, rev: 1, data: { title: 'Werbung vom Fremden', body: '!', tags: [], pinned: false, source: 'user' } });
    const gz = require('node:zlib').gzipSync(Buffer.from(`${zeile}\n`));
    fs.writeFileSync(path.join(box1, 'records.jsonl.gz'), gz);
    fs.writeFileSync(path.join(box1, 'manifest.json'), JSON.stringify({
      protocol: 1, format: 'neural-os-folder-sync', deviceId: fremd1, deviceName: 'Fremd', at: new Date().toISOString(),
      count: 1, appVersion: '0.1.0', encrypted: false, bytes: gz.length, sha256: crypto.createHash('sha256').update(gz).digest('hex'),
    }));

    // Protokoll 2 von F: F schreibt nur für B. Liegt auf A, und A lernt F danach sogar kennen.
    appF.store.create('note', { title: 'F-Notiz', body: 'nur fuer Lena' });
    await appF.kopplung.abgleichen();
    const idF = appF.identitaet.id;
    fs.cpSync(path.join(B.sync, idF), path.join(A.sync, idF), { recursive: true });
    await appA.kopplung.koppeln({ root: F.root }); // F hat noch nicht angenommen

    const r = await appA.kopplung.abgleichen();
    const titel = notizen(appA).join(' | ');
    assert.equal(titel.includes('Werbung vom Fremden'), false, titel);
    assert.equal(titel.includes('F-Notiz'), false, titel);
    assert.deepEqual(r.warnungen, []);
    assert.equal(warnungen.length, 0, JSON.stringify(warnungen));
    assert.equal(offeneKonflikte(appA), 0);
  });
});

test('10: ungleiche Schutzstufe -> koppeln lehnt mit dem Satz ab; falsche PIN; ein unversiegeltes Angebot an einen PIN-Stick wird nicht angenommen', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    const C = w.stick('c');
    for (const s of [A, B, C]) w.welt.add(s.root);
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena', pin: '4711' });
    const appC = await w.start(C, { name: 'Tom', pin: '1234' });

    await assert.rejects(() => appA.kopplung.koppeln({ root: B.root }), (err) => err.message === 'Lena hat eine PIN, dieser Stick nicht.');
    await assert.rejects(() => appB.kopplung.koppeln({ root: A.root }), (err) => err.message === 'Dieser Stick hat eine PIN, Max nicht.');
    await assert.rejects(() => appC.kopplung.koppeln({ root: B.root, pin: '0000' }), (err) => err.message === 'Falsche PIN.');
    assert.equal(appA.kopplung.status().partner.length, 0);
    assert.equal(appC.kopplung.status().partner.length, 0);
    const angebote = fs.existsSync(path.join(B.sync, 'koppeln')) ? fs.readdirSync(path.join(B.sync, 'koppeln')) : [];
    assert.deepEqual(angebote, [], 'ein abgelehntes Koppeln hat ein Angebot hinterlassen');

    // Unversiegelt an einen Stick mit PIN: nie annehmen.
    fs.mkdirSync(path.join(B.sync, 'koppeln'), { recursive: true });
    const angebot = path.join(B.sync, 'koppeln', `${appA.identitaet.id}.angebot`);
    fs.writeFileSync(angebot, JSON.stringify({
      v: 1, von: appA.identitaet.id, name: 'Max', an: appB.identitaet.id, schluessel: crypto.randomBytes(32).toString('base64'), at: new Date().toISOString(),
    }));
    const r = await appB.kopplung.annehmen();
    assert.equal(r.angenommen.length, 0);
    assert.equal(appB.kopplung.status().partner.length, 0);

    // Richtig: C (PIN) mit B (PIN) und der PIN von B.
    await appC.kopplung.koppeln({ root: B.root, pin: '4711' });
    const r2 = await appB.kopplung.annehmen();
    assert.deepEqual(r2.angenommen.map((p) => p.name), ['Tom']);
  });
});

test('11: Zwilling: data/ samt Marker kopiert -> Zustand zwilling, keine Schreibvorgänge; ein Dritter wird nie zurückgedreht (v2-dritter)', async () => {
  await welt(async (w) => {
    kopplungMod();
    const L = w.stick('l');
    const C = w.stick('c');
    const S = w.stick('s');
    w.welt.add(L.root);
    w.welt.add(C.root);
    const appL = await w.start(L, { name: 'Max' });
    const appC = await w.start(C, { name: 'Tom' });
    await koppeln(appL, appC, C);
    const idX = appL.identitaet.id;

    const x = appL.store.create('note', { title: 'Hausaufgaben', body: 'v0' });
    await appL.kopplung.abgleichen();
    await appC.kopplung.abgleichen();
    await appL.kopplung.abgleichen();
    assert.equal(notiz(appC, x.id), 'v0');

    // Die Kopie: data/ und Marker auf Stick S, ohne Sperren.
    await appL.store.flush();
    fs.rmSync(S.data, { recursive: true, force: true });
    fs.cpSync(L.data, S.data, { recursive: true, filter: (p) => path.basename(p) !== '.lock' });
    fs.copyFileSync(path.join(L.root, pathsMod.PORTABLE_MARKER), path.join(S.root, pathsMod.PORTABLE_MARKER));

    appL.store.update(x.id, { body: 'v1 (am Laptop verbessert)' });
    await appL.kopplung.abgleichen();
    await appC.kopplung.abgleichen();
    assert.equal(notiz(appC, x.id), 'v1 (am Laptop verbessert)');

    // S läuft allein und schreibt zweimal in sein eigenes sync/ (noch unentdeckt).
    w.welt.delete(L.root);
    w.welt.delete(C.root);
    w.welt.add(S.root);
    const appS = await w.start(S);
    assert.equal(appS.identitaet.id, idX, 'der Zwilling trägt dieselbe Kennung');
    appS.store.create('note', { title: 'S-Notiz 1', body: 's' });
    await appS.kopplung.abgleichen();
    appS.store.create('note', { title: 'S-Notiz 2', body: 's' });
    await appS.kopplung.abgleichen();

    // C läuft, S steckt: C darf nicht zurückgedreht werden.
    w.welt.add(C.root);
    await appC.kopplung.abgleichen();
    assert.equal(notiz(appC, x.id), 'v1 (am Laptop verbessert)', 'C wurde vom Zwilling zurückgedreht');
    assert.equal(notizen(appC).some((t) => t.startsWith('S-Notiz')), false, 'vom Zwilling darf nichts ankommen');
    assert.equal(partnerVon(appC, idX).zustand, 'zwilling');

    // S läuft, C steckt: S erkennt sich als Zwilling und schreibt nirgends mehr hin.
    const aufC = path.join(C.sync, idX, 'manifest.json');
    const vorherC = fs.existsSync(aufC) ? fs.readFileSync(aufC, 'utf8') : null;
    const eigenesS = path.join(S.sync, idX, 'manifest.json');
    const vorherS = fs.readFileSync(eigenesS, 'utf8');
    appS.store.create('note', { title: 'S-Notiz 3', body: 's' });
    await appS.kopplung.abgleichen();
    assert.equal(appS.kopplung.status().selbst.zwilling, true, 'S erkennt nicht, dass es ein Zwilling ist');
    assert.equal(fs.existsSync(aufC) ? fs.readFileSync(aufC, 'utf8') : null, vorherC, 'der Zwilling hat auf C geschrieben');
    assert.equal(fs.readFileSync(eigenesS, 'utf8'), vorherS, 'der Zwilling schreibt weiter');
    await appC.kopplung.abgleichen();
    assert.equal(notiz(appC, x.id), 'v1 (am Laptop verbessert)');

    // Auch die Suche erkennt ihn, sobald beide stecken – auf beiden Seiten.
    w.welt.add(L.root);
    const gef = await appS.kopplung.finden();
    assert.equal(gef.find((g) => g.pfad === L.root).zustand, 'zwilling');
    await appL.kopplung.finden();
    assert.equal(appL.kopplung.status().selbst.zwilling, true, 'L sieht den Zwilling nicht');
    const aufCvonL = fs.readFileSync(aufC, 'utf8');

    // Diesen Stick eigenständig machen: neue Kennung, ohne Partner. Seine
    // alten Postfächer verschwinden, die von L bleiben.
    await appS.kopplung.eigenstaendig();
    assert.notEqual(appS.identitaet.id, idX);
    assert.equal(appS.kopplung.status().selbst.zwilling, false);
    assert.equal(appS.kopplung.status().partner.length, 0);
    assert.equal(fs.existsSync(path.join(S.sync, idX)), false, 'das alte Postfach des Zwillings liegt noch da');
    assert.equal(fs.readFileSync(aufC, 'utf8'), aufCvonL, 'das Postfach von L auf C wurde angefasst');

    // L sieht beim nächsten Suchlauf, dass der andere Stick eigenständig ist.
    await appL.kopplung.finden();
    assert.equal(appL.kopplung.status().selbst.zwilling, false, 'L bleibt für immer ein Zwilling');

    // L und C gleichen weiter ab.
    w.welt.delete(S.root);
    appL.store.update(x.id, { body: 'v2' });
    await appL.kopplung.abgleichen();
    await appC.kopplung.abgleichen();
    assert.equal(notiz(appC, x.id), 'v2');
    assert.equal(partnerVon(appC, idX).zustand, 'aktiv');
  });
});

test('Zwilling über ein fremdes Postfach auf dem Partner: erkannt; nach „eigenständig“ auf dem anderen Stick schreibt L wieder', async () => {
  await welt(async (w) => {
    kopplungMod();
    const L = w.stick('l');
    const C = w.stick('c');
    const S = w.stick('s');
    w.welt.add(L.root);
    w.welt.add(C.root);
    const appL = await w.start(L, { name: 'Max' });
    await kiAnlegen(C, 'Tom');
    await appL.kopplung.koppeln({ root: C.root }); // C läuft nicht
    const idX = appL.identitaet.id;

    // Sofort kopiert, bevor C je lief.
    await appL.store.flush();
    fs.rmSync(S.data, { recursive: true, force: true });
    fs.cpSync(L.data, S.data, { recursive: true, filter: (p) => path.basename(p) !== '.lock' });
    fs.copyFileSync(path.join(L.root, pathsMod.PORTABLE_MARKER), path.join(S.root, pathsMod.PORTABLE_MARKER));

    // S läuft mit C, L steckt nicht: S schreibt auf C (nichts verrät ihn).
    w.welt.delete(L.root);
    w.welt.add(S.root);
    const appS = await w.start(S);
    appS.store.create('note', { title: 'von S', body: 's' });
    await appS.kopplung.abgleichen();
    const aufC = path.join(C.sync, idX, 'manifest.json');
    const vonS = fs.readFileSync(aufC, 'utf8');

    // L läuft mit C: das Postfach dort ist nicht von L.
    w.welt.delete(S.root);
    w.welt.add(L.root);
    appL.store.create('note', { title: 'von L', body: 'l' });
    const r = await appL.kopplung.abgleichen();
    assert.equal(r.zwilling, true);
    assert.equal(appL.kopplung.status().selbst.zwilling, true);
    assert.equal(fs.readFileSync(aufC, 'utf8'), vonS, 'L hat das Postfach des Zwillings überschrieben');

    // S wird eigenständig und räumt sein Postfach auf C weg.
    w.welt.add(S.root);
    await appS.kopplung.eigenstaendig();
    assert.equal(fs.existsSync(aufC), false, 'das Postfach von S liegt noch auf C');

    // L schreibt wieder.
    w.welt.delete(S.root);
    const r2 = await appL.kopplung.abgleichen();
    assert.equal(r2.zwilling, false);
    assert.equal(appL.kopplung.status().selbst.zwilling, false);
    assert.ok(fs.existsSync(aufC), 'L schreibt nicht wieder auf C');
  });
});

test('12: Entkoppeln -> beide behalten ihr Wissen, danach fließt nichts mehr, und die Entkoppel-Nachricht kommt an', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);
    const idA = appA.identitaet.id;
    const idB = appB.identitaet.id;

    appA.store.create('note', { title: 'gemeinsam', body: 'x' });
    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    assert.ok(notizen(appB).includes('gemeinsam=x'));

    await appA.kopplung.entkoppeln(idB);
    assert.equal(appA.kopplung.status().partner.length, 0);
    assert.equal(fs.existsSync(path.join(A.sync, idB)), false, 'das Postfach von B liegt noch auf A');
    assert.equal(fs.existsSync(path.join(B.sync, idA)), false, 'das Postfach von A liegt noch auf B');
    const nachricht = path.join(B.sync, 'koppeln', `${idA}.entkoppelt`);
    assert.ok(fs.existsSync(nachricht), 'keine Entkoppel-Nachricht auf B');
    const n = JSON.parse(fs.readFileSync(nachricht, 'utf8'));
    assert.equal(n.von, idA);
    assert.equal(n.an, idB);
    assert.match(n.mac, /^[0-9a-f]{64}$/);

    const r = await appB.kopplung.annehmen();
    assert.deepEqual(r.entkoppelt, [idA]);
    assert.equal(appB.kopplung.status().partner.length, 0);
    assert.equal(fs.existsSync(nachricht), false);

    // Beide behalten ihr Wissen.
    assert.ok(notizen(appA).includes('gemeinsam=x'));
    assert.ok(notizen(appB).includes('gemeinsam=x'));

    // Danach fließt nichts mehr.
    appA.store.create('note', { title: 'nach dem Entkoppeln A', body: 'a' });
    appB.store.create('note', { title: 'nach dem Entkoppeln B', body: 'b' });
    for (const app of [appA, appB, appA, appB]) await app.kopplung.abgleichen();
    assert.equal(notizen(appB).some((t) => t.startsWith('nach dem Entkoppeln A')), false);
    assert.equal(notizen(appA).some((t) => t.startsWith('nach dem Entkoppeln B')), false);
  });
});

test('Entkoppeln, während B nicht steckt: die Nachricht wird zugestellt, sobald B wieder steckt', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);
    await appA.kopplung.abgleichen();
    const idA = appA.identitaet.id;
    const idB = appB.identitaet.id;

    w.welt.delete(B.root);
    await appA.kopplung.entkoppeln(idB);
    assert.equal(appA.kopplung.status().partner.length, 0);
    assert.equal(fs.existsSync(path.join(B.sync, 'koppeln', `${idA}.entkoppelt`)), false);

    w.welt.add(B.root);
    await appA.kopplung.abgleichen();
    assert.ok(fs.existsSync(path.join(B.sync, 'koppeln', `${idA}.entkoppelt`)), 'nicht zugestellt');
    assert.equal(fs.existsSync(path.join(B.sync, idA)), false);
    const r = await appB.kopplung.annehmen();
    assert.deepEqual(r.entkoppelt, [idA]);
    assert.equal(appB.kopplung.status().partner.length, 0);

    // Eine gefälschte Nachricht (falscher MAC) entkoppelt nichts.
    const C = w.stick('c');
    w.welt.add(C.root);
    const appC = await w.start(C, { name: 'Tom' });
    await koppeln(appB, appC, C);
    fs.writeFileSync(path.join(C.sync, 'koppeln', `${idB}.entkoppelt`), JSON.stringify({ v: 1, von: idB, an: appC.identitaet.id, at: new Date().toISOString(), mac: 'ab'.repeat(32) }));
    const r2 = await appC.kopplung.annehmen();
    assert.deepEqual(r2.entkoppelt, []);
    assert.equal(appC.kopplung.status().partner.length, 1);
  });
});

test('13: A–B und B–C: die Notiz von A erreicht C über B; status() von A zeigt bei B ueber:[C]', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    const C = w.stick('c');
    for (const s of [A, B, C]) w.welt.add(s.root);
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    const appC = await w.start(C, { name: 'Tom' });
    await koppeln(appA, appB, B);
    await koppeln(appB, appC, C);

    appA.store.create('note', { title: 'Von Max', body: 'geht an Tom' });
    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    await appC.kopplung.abgleichen();
    assert.ok(notizen(appC).includes('Von Max=geht an Tom'), JSON.stringify(notizen(appC)));

    await appA.kopplung.abgleichen();
    const lena = partnerVon(appA, appB.identitaet.id);
    assert.deepEqual(lena.ueber, ['Tom']);
    assert.equal(partnerVon(appA, appC.identitaet.id), null, 'C ist kein direkter Partner von A');
  });
});

test('14: ein Abgleich schreibt unter dem Urheber {kind:"sync", label:<Partnername>} (Grundlage für den Verlauf aus Paket H)', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);
    const urheber = [];
    appB.bus.on('record.created', (e) => { if (e.payload.type === 'note') urheber.push(e.payload.actor); });

    appA.store.create('note', { title: 'über den Stick', body: 'x' });
    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    assert.ok(notizen(appB).includes('über den Stick=x'));
    assert.ok(urheber.length >= 1);
    for (const a of urheber) assert.deepEqual({ ...a }, { kind: 'sync', label: 'Max' });
  });
});

test('15: zwei gleichzeitige Auslöser laufen nacheinander, ohne Fehler', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);
    for (let i = 0; i < 30; i++) appB.store.create('note', { title: `Notiz ${i}`, body: 'x'.repeat(200) });
    await appB.kopplung.abgleichen();

    const [r1, r2, r3] = await Promise.all([
      appA.kopplung.abgleichen(),
      appA.kopplung.abgleichen(),
      appA.kopplung.abgleichen(),
    ]);
    for (const r of [r1, r2, r3]) assert.ok(r && typeof r.lauf === 'number', 'kein Bericht');
    const laeufe = [r1, r2, r3].sort((a, b) => a.begonnen - b.begonnen);
    for (let i = 1; i < laeufe.length; i++) {
      assert.ok(laeufe[i].begonnen >= laeufe[i - 1].beendet, 'zwei Abgleiche liefen gleichzeitig');
    }
    assert.equal(appA.store.list('note').items.filter((n) => n.data.title.startsWith('Notiz ')).length, 30);
  });
});

test('16: finden() mit eingespielten Einhängepunkten: Partner, fremde Sticks, Zwillinge, Versionen, leere Datenträger – nie sich selbst, nie config.json', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    const F = w.stick('f');
    const T = w.stick('t');
    const O = w.stick('o', { version: '0.0.1' });
    const N = w.stick('n', { version: '99.0.0' });
    const leer = w.stick('leer');
    fs.rmSync(path.join(leer.root, pathsMod.PORTABLE_MARKER));
    fs.rmSync(leer.appDir, { recursive: true, force: true });
    fs.rmSync(leer.data, { recursive: true, force: true });
    // Ein Stick mit dem Ordner "Inhalt" (Bauplan 1.1).
    const I = w.stick('inhalt');
    fs.mkdirSync(path.join(I.root, 'Inhalt'));
    for (const name of [pathsMod.PORTABLE_MARKER, 'app', 'data']) fs.renameSync(path.join(I.root, name), path.join(I.root, 'Inhalt', name));

    await kiAnlegen(F, 'Fremd');
    await kiAnlegen(O, 'Alt');
    await kiAnlegen(N, 'Neu');
    const idI = await kiAnlegen({ ...I, data: path.join(I.root, 'Inhalt', 'data'), appDir: path.join(I.root, 'Inhalt', 'app') }, 'Innen', { pin: '9876' });
    for (const s of [A, B, F, T, O, N, leer, I]) w.welt.add(s.root);

    const gelesen = [];
    const spion = {};
    for (const name of ['readFile', 'stat', 'lstat', 'access', 'readdir', 'realpath', 'statfs', 'open']) {
      spion[name] = (p, ...rest) => { gelesen.push(String(p)); return fs.promises[name](p, ...rest); };
    }
    const appA = await w.start(A, { name: 'Max', dateisystem: spion });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);
    // Der Zwilling: dieselbe Kennung wie A im Marker.
    const tm = T.marker();
    fs.writeFileSync(path.join(T.root, pathsMod.PORTABLE_MARKER), JSON.stringify({ ...tm, kiId: appA.identitaet.id, name: 'Max' }));

    gelesen.length = 0;
    const gef = await appA.kopplung.finden({ leer: true });
    const nach = (root) => gef.find((g) => g.pfad === root || g.pfad === path.join(root, 'Inhalt'));
    assert.equal(nach(A.root), undefined, 'A findet sich selbst');
    assert.equal(nach(B.root).zustand, 'partner');
    assert.equal(nach(B.root).name, 'Lena');
    assert.equal(nach(F.root).zustand, 'fremd');
    assert.equal(nach(F.root).version, VERSION);
    assert.equal(nach(T.root).zustand, 'zwilling');
    assert.equal(nach(O.root).zustand, 'aelter');
    assert.equal(nach(N.root).zustand, 'neuer');
    assert.equal(nach(leer.root).zustand, 'leer');
    assert.equal(nach(leer.root).id, null);
    const innen = nach(I.root);
    assert.equal(innen.pfad, path.join(I.root, 'Inhalt'));
    assert.equal(innen.id, idI);
    assert.equal(innen.pin, true);
    assert.equal(typeof nach(F.root).frei, 'number');
    assert.ok(gelesen.length > 0, 'der Spion hat nichts gesehen');
    assert.deepEqual(gelesen.filter((p) => /config\.json$/.test(p)), [], 'config.json eines anderen Sticks wurde gelesen');
    assert.equal(appA.kopplung.status().selbst.zwilling, true, 'ein Stick mit derselben Kennung macht A zum Zwilling');

    const partner = appA.kopplung.status().partner.find((p) => p.id === appB.identitaet.id);
    assert.equal(partner.steckt, true);
  });
});

test('17: ein Postfach mit Protokoll 3 wird nicht halb gelesen; der Status sagt neuer', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);
    await appB.kopplung.abgleichen();
    await appA.kopplung.abgleichen();
    const idB = appB.identitaet.id;

    appB.store.create('note', { title: 'aus der Zukunft', body: 'x' });
    await appB.kopplung.abgleichen();
    for (const box of [path.join(A.sync, idB), path.join(B.sync, idB)]) {
      const datei = path.join(box, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(datei, 'utf8'));
      m.protocol = 3;
      fs.writeFileSync(datei, JSON.stringify(m));
    }
    const r = await appA.kopplung.abgleichen();
    assert.equal(r.uebernommen, 0);
    assert.equal(notizen(appA).some((t) => t.startsWith('aus der Zukunft')), false, 'halb gelesen');
    assert.equal(partnerVon(appA, idB).zustand, 'neuer');
  });
});

/* ------------------------------------------------------ Kanten */

/** Warten, bis `bedingung()` wahr ist (Zeitgeber laufen im Hintergrund). */
async function bis(bedingung, ms = 5000, was = 'Bedingung') {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (await bedingung()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`${was} trat nicht ein`);
}

function generationAuf(syncOrdner, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(syncOrdner, id, 'manifest.json'), 'utf8')).generation;
  } catch {
    return 0;
  }
}

test('Auslöser: Start nimmt an, eine Änderung gleicht nach der Ruhezeit ab, ein eingesteckter Partner wird gefunden, Beenden gleicht ein letztes Mal ab', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    const idB = await kiAnlegen(B, 'Lena');
    const zeiten = { startMs: 10, suchlaufMs: 60, ruheMs: 80 };
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    await appA.kopplung.koppeln({ root: B.root });
    const idA = appA.identitaet.id;
    await w.stop(appA);

    // B startet automatisch: Start nimmt das Angebot an.
    const appB = await createApp({
      home: B.data, appDir: B.appDir, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false,
      kopplung: { einhaengepunkte: () => [...w.welt], zeiten },
    });
    let vorEnde = 0;
    try {
      assert.equal(appB.kopplung.automatisch, true);
      await bis(() => appB.kopplung.status().partner.some((p) => p.id === idA && p.zustand === 'aktiv'), 5000, 'Annahme beim Start');

      // Eine Änderung: nach der Ruhezeit liegt ein neues Postfach auf A.
      const vorher = generationAuf(A.sync, idB);
      appB.store.create('note', { title: 'nach der Ruhe', body: 'x' });
      await bis(() => generationAuf(A.sync, idB) > vorher, 5000, 'Abgleich nach der Änderung');

      // A steckt nicht mehr; eine Änderung landet nur auf B. Dann steckt A
      // wieder: der Suchlauf findet ihn und gleicht ab.
      w.welt.delete(A.root);
      await new Promise((r) => setTimeout(r, 150)); // ein Suchlauf ohne A
      const ohneA = generationAuf(A.sync, idB);
      appB.store.create('note', { title: 'während A fehlt', body: 'y' });
      await bis(() => generationAuf(B.sync, idB) > ohneA, 5000, 'Abgleich ins eigene sync/');
      assert.equal(generationAuf(A.sync, idB), ohneA, 'auf einen Stick, der nicht steckt, wird nicht geschrieben');
      w.welt.add(A.root);
      await bis(() => generationAuf(A.sync, idB) > ohneA, 5000, 'Abgleich, sobald A wieder steckt');

      // Beenden: die letzte Änderung reist noch mit.
      vorEnde = generationAuf(A.sync, idB);
      appB.store.create('note', { title: 'kurz vor Schluss', body: 'z' });
    } finally {
      await appB.close();
    }
    assert.ok(generationAuf(A.sync, idB) > vorEnde, 'beim Beenden wurde nicht mehr geschrieben');
    const letzte = JSON.parse(fs.readFileSync(path.join(A.sync, idB, 'manifest.json'), 'utf8'));
    assert.ok(Date.parse(letzte.at) > Date.now() - 5000);
    const appA2 = await w.start(A);
    await appA2.kopplung.abgleichen();
    assert.ok(notizen(appA2).includes('kurz vor Schluss=z'), 'die letzte Änderung kam beim Beenden nicht mehr an');
  });
});

test('HTTP /api/kopplung: nur für den Besitzer, Suche, Koppeln, Abgleichen, Entkoppeln', async () => {
  await welt(async (w) => {
    kopplungMod();
    const http = require('node:http');
    const A = w.stick('a');
    const B = w.stick('b');
    const idB = await kiAnlegen(B, 'Lena');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    const server = await appA.listen();
    const port = server.server.address().port;
    const rufe = (method, pfad, body, kopf = { 'x-neural-os': '1' }) => new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({
        method, host: '127.0.0.1', port, path: pfad,
        headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...kopf },
      }, (res) => {
        const teile = [];
        res.on('data', (c) => teile.push(c));
        res.on('end', () => {
          const text = Buffer.concat(teile).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* kein JSON */ }
          resolve({ status: res.statusCode, json, text });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });

    const leer = await rufe('GET', '/api/kopplung');
    assert.equal(leer.status, 200, leer.text);
    assert.deepEqual(leer.json.selbst, { id: appA.identitaet.id, name: 'Max', pin: false, zwilling: false });
    assert.deepEqual(leer.json.partner, []);

    const such = await rufe('GET', '/api/kopplung?suchen=1&leer=1');
    assert.equal(such.status, 200, such.text);
    const lena = such.json.gefunden.find((g) => g.id === idB);
    assert.deepEqual(Object.keys(lena).sort(), ['frei', 'id', 'name', 'pfad', 'pin', 'version', 'zustand']);

    const ohneKopf = await rufe('POST', '/api/kopplung/koppeln', { pfad: lena.pfad }, {});
    assert.equal(ohneKopf.status, 403, 'ohne X-Neural-OS darf niemand koppeln');

    const gekoppelt = await rufe('POST', '/api/kopplung/koppeln', { pfad: lena.pfad });
    assert.equal(gekoppelt.status, 200, gekoppelt.text);
    const st = await rufe('GET', '/api/kopplung');
    assert.equal(st.json.partner.length, 1);
    assert.equal(st.json.partner[0].zustand, 'wartet');
    assert.equal(JSON.stringify(st.json).includes('schluessel'), false, 'ein Schlüssel geht über HTTP');

    const ab = await rufe('POST', '/api/kopplung/abgleichen', {});
    assert.equal(ab.status, 200, ab.text);
    const ent = await rufe('POST', '/api/kopplung/entkoppeln', { id: idB });
    assert.equal(ent.status, 200, ent.text);
    assert.equal(ent.json.partner.length, 0);
    const falsch = await rufe('POST', '/api/kopplung/entkoppeln', { id: idB });
    assert.equal(falsch.status, 404);

    const alt = appA.identitaet.id;
    const eigen = await rufe('POST', '/api/kopplung/eigenstaendig', {});
    assert.equal(eigen.status, 200, eigen.text);
    assert.notEqual(eigen.json.selbst.id, alt);
    assert.equal(eigen.json.selbst.id, appA.identitaet.id);
  });
});

/* ------------------------------------------------ Tresor gesperrt, PIN später, Name */

/** Eine Anfrage an eine laufende App, als Besitzer (X-Neural-OS). */
function rufeAn(port, method, pfad, body) {
  const http = require('node:http');
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method, host: '127.0.0.1', port, path: pfad,
      headers: { 'x-neural-os': '1', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
    }, (res) => {
      const teile = [];
      res.on('data', (c) => teile.push(c));
      res.on('end', () => {
        const text = Buffer.concat(teile).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* kein JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('Tresor gesperrt: Angebot und Entkoppel-Nachricht bleiben liegen, nichts wird geschrieben; nach dem Entsperren wird angenommen', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    const C = w.stick('c');
    for (const s of [A, B, C]) w.welt.add(s.root);
    const appA = await w.start(A, { name: 'Max', pin: '1111' });
    let appB = await w.start(B, { name: 'Lena', pin: '2222' });
    const appC = await w.start(C, { name: 'Tom', pin: '3333' });
    await koppeln(appC, appB, B, '2222');
    await appB.kopplung.abgleichen();
    const idB = appB.identitaet.id;
    await w.stop(appB);

    // B läuft nicht: C entkoppelt, A bietet an.
    await appC.kopplung.entkoppeln(idB);
    await appA.kopplung.koppeln({ root: B.root, pin: '2222' });
    const angebot = path.join(B.sync, 'koppeln', `${appA.identitaet.id}.angebot`);
    const entkoppelt = path.join(B.sync, 'koppeln', `${appC.identitaet.id}.entkoppelt`);
    assert.ok(fs.existsSync(angebot) && fs.existsSync(entkoppelt));

    // B startet und wird gesperrt, bevor die Kopplung ihren Stand gelesen hat.
    appB = await w.start(B, { pin: '2222' });
    appB.vaultCrypto.lock();
    const kopplungenVorher = fs.readFileSync(path.join(B.data, 'kopplungen.json'));
    const r = await appB.kopplung.annehmen();
    assert.deepEqual(r, { angenommen: [], entkoppelt: [], abgelehnt: 0 });
    const ab = await appB.kopplung.abgleichen();
    assert.equal(ab.uebernommen, 0);
    assert.ok(fs.existsSync(angebot), 'ein versiegeltes Angebot wurde weggeworfen, weil der Tresor gesperrt war');
    assert.ok(fs.existsSync(entkoppelt), 'die Entkoppel-Nachricht wurde weggeworfen, weil der Tresor gesperrt war');
    assert.ok(fs.readFileSync(path.join(B.data, 'kopplungen.json')).equals(kopplungenVorher), 'kopplungen.json wurde im gesperrten Zustand angefasst');
    await assert.rejects(() => appB.kopplung.koppeln({ root: A.root, pin: '1111' }), (err) => err.code === 'VAULT_LOCKED');

    // Entsperrt: beides wird erledigt.
    await appB.vaultCrypto.unlock('2222');
    const r2 = await appB.kopplung.annehmen();
    assert.deepEqual(r2.angenommen.map((p) => p.name), ['Max']);
    assert.deepEqual(r2.entkoppelt, [appC.identitaet.id]);
    assert.deepEqual(appB.kopplung.status().partner.map((p) => p.name), ['Max']);
    assert.equal(fs.existsSync(angebot), false);
    assert.equal(fs.existsSync(entkoppelt), false);
  });
});

test('PIN nach dem Koppeln: kopplungen.json und sync-folder.json werden sofort versiegelt, der Abgleich läuft weiter', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);
    appA.store.create('note', { title: 'vor der PIN', body: 'a' });
    for (const app of [appA, appB, appA]) await app.kopplung.abgleichen();
    const kDatei = path.join(A.data, 'kopplungen.json');
    const sDatei = path.join(A.data, 'sync-folder.json');
    const schluessel = JSON.parse(fs.readFileSync(kDatei, 'utf8')).partner[0].schluessel;
    assert.equal(fs.readFileSync(sDatei)[0], 0x7b, 'Vorbedingung: ohne PIN liegt der Stand im Klartext');

    // "PIN festlegen" in den Einstellungen, über die echte Route.
    const server = await appA.listen();
    const pin = await rufeAn(server.server.address().port, 'POST', '/api/vault/pin', { pin: '8642' });
    assert.equal(pin.status, 200, pin.text);

    const kRoh = fs.readFileSync(kDatei);
    assert.equal(istKlartext(kRoh), false, 'kopplungen.json liegt nach dem Festlegen der PIN weiter im Klartext');
    assert.equal(kRoh.includes(schluessel), false, 'der Paarschlüssel steht im Klartext auf dem Stick');
    assert.equal(JSON.parse(appA.vaultCrypto.decryptBuffer(kRoh).toString('utf8')).partner[0].schluessel, schluessel);
    const sRoh = fs.readFileSync(sDatei);
    assert.equal(istKlartext(sRoh), false, 'sync-folder.json liegt nach dem Festlegen der PIN weiter im Klartext');
    assert.ok(JSON.parse(appA.vaultCrypto.decryptBuffer(sRoh).toString('utf8')).devices[appB.identitaet.id]);

    const n = appB.store.create('note', { title: 'nach der PIN', body: 'b' });
    await appB.kopplung.abgleichen();
    const r = await appA.kopplung.abgleichen();
    assert.equal(r.konflikte, 0);
    assert.equal(notiz(appA, n.id), 'b');
  });
});

test('Name dieser KI reist mit: nach dem Umbenennen schreibt A von selbst neu, B zeigt den neuen Namen', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appB = await w.start(B, { name: 'Lena' });
    const appA = await createApp({
      home: A.data, appDir: A.appDir, port: 0, host: '127.0.0.1', logLevel: 'error', harden: false,
      kopplung: { einhaengepunkte: () => [...w.welt], zeiten: { startMs: 10, suchlaufMs: 60000, ruheMs: 50 } },
    });
    try {
      appA.identitaet.umbenennen('Max');
      await appA.kopplung.koppeln({ root: B.root });
      await appB.kopplung.annehmen();
      await appB.kopplung.abgleichen();
      assert.equal(partnerVon(appB, appA.identitaet.id).name, 'Max');
      const vorher = generationAuf(B.sync, appA.identitaet.id);

      // So benennt POST /api/ki/name um: Identität, dann das Ereignis.
      appA.identitaet.umbenennen('Moritz');
      appA.bus.publish('ki.umbenannt', { id: appA.identitaet.id, name: 'Moritz' });
      await bis(() => generationAuf(B.sync, appA.identitaet.id) > vorher, 5000, 'neues Postfach nach dem Umbenennen');
      await appB.kopplung.abgleichen();
      assert.equal(partnerVon(appB, appA.identitaet.id).name, 'Moritz');
    } finally {
      await appA.close();
    }
  });
});

test('Entkoppeln, bevor B angenommen hat: B ist danach nicht gekoppelt und zeigt keinen Hinweis', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const B = w.stick('b');
    await kiAnlegen(B, 'Lena');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    const angenommen = [];
    await appA.kopplung.koppeln({ root: B.root });
    const angebot = path.join(B.sync, 'koppeln', `${appA.identitaet.id}.angebot`);
    const kopie = fs.readFileSync(angebot);
    await appA.kopplung.entkoppeln(appA.kopplung.status().partner[0].id);
    assert.equal(fs.existsSync(angebot), false, 'das Angebot bleibt liegen, obwohl A entkoppelt hat');
    // Auch wenn das Wegräumen nicht gelang: Angebot und Rückzug liegen beide da.
    fs.writeFileSync(angebot, kopie);

    const appB = await w.start(B);
    appB.bus.on('kopplung.angenommen', (e) => angenommen.push(e.payload));
    const r = await appB.kopplung.annehmen();
    assert.deepEqual(r.angenommen, []);
    const st = appB.kopplung.status();
    assert.equal(st.partner.length, 0);
    assert.equal(st.hinweis, null, 'B meldet eine Kopplung, die es nicht mehr gibt');
    assert.deepEqual(angenommen, []);
    const rest = fs.existsSync(path.join(B.sync, 'koppeln')) ? fs.readdirSync(path.join(B.sync, 'koppeln')) : [];
    assert.deepEqual(rest, []);
  });
});

test('finden(): der eigene Stick unter einem zweiten Pfad ist kein Zwilling', async () => {
  await welt(async (w) => {
    kopplungMod();
    const A = w.stick('a');
    const zweiter = `${A.root}-zweiter-pfad`;
    fs.symlinkSync(A.root, zweiter, 'dir');
    try {
      // Wie ein zweiter Einhängepunkt desselben Datenträgers: realpath löst ihn nicht auf.
      const dateisystem = { ...fs.promises, realpath: (p) => (String(p).startsWith(zweiter) ? Promise.resolve(p) : fs.promises.realpath(p)) };
      w.welt.add(A.root);
      w.welt.add(zweiter);
      const appA = await w.start(A, { name: 'Max', dateisystem });
      const gef = await appA.kopplung.finden({ leer: true });
      assert.deepEqual(gef.map((g) => g.pfad), [], 'A findet sich selbst');
      assert.equal(appA.kopplung.status().selbst.zwilling, false, 'A hält sich selbst für einen Zwilling');
    } finally {
      fs.unlinkSync(zweiter);
    }
  });
});

test('beideBehalten: dieselbe Entscheidung auf beiden Seiten, Kopie mit 32 Zeichen, keine Kopie einer Kopie', () => {
  const basis = { type: 'note', createdAt: 'x', updatedAt: 'x', deletedAt: null, rev: 1 };
  const a = { ...basis, id: 'note_aaaaaaaaaaaaaaaaaaaaaaaa', data: { title: 'Einkaufsliste', body: 'A' } };
  const b = { ...basis, id: a.id, data: { title: 'Einkaufsliste', body: 'B' } };
  const beiA = merge.beideBehalten({ recordId: a.id, recordType: 'note', local: a, remote: b }, { nameLokal: 'Max', nameFern: 'Lena' });
  const beiB = merge.beideBehalten({ recordId: a.id, recordType: 'note', local: b, remote: a }, { nameLokal: 'Lena', nameFern: 'Max' });
  assert.notEqual(beiA.sieger, beiB.sieger, 'beide Seiten müssen denselben Sieger wählen');
  assert.deepEqual(beiA.kopie, beiB.kopie);
  assert.ok(merge.istKopieId(beiA.kopie.id));
  assert.match(beiA.kopie.id, /^note_[0-9a-z]{32}$/);
  assert.match(beiA.kopie.data.title, /^Einkaufsliste \(Fassung von (Max|Lena)\)$/);

  const kopie = { ...basis, id: beiA.kopie.id, data: { title: 'k', body: '1' } };
  const kopie2 = { ...kopie, data: { title: 'k', body: '2' } };
  assert.equal(merge.beideBehalten({ recordId: kopie.id, recordType: 'note', local: kopie, remote: kopie2 }).kopie, null);
  const weg = { ...a, deletedAt: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(merge.beideBehalten({ recordId: a.id, recordType: 'note', local: weg, remote: b }), { sieger: 'fern', kopie: null });
  assert.deepEqual(merge.beideBehalten({ recordId: a.id, recordType: 'note', local: b, remote: weg }), { sieger: 'lokal', kopie: null });
  const lang = { ...a, data: { title: 'x'.repeat(500), body: 'A' } };
  const r = merge.beideBehalten({ recordId: a.id, recordType: 'note', local: lang, remote: b }, { nameLokal: 'Max', nameFern: 'Lena' });
  if (r.kopie) assert.ok([...r.kopie.data.title].length <= 500);
  const kante = { ...basis, id: 'edge_aaaaaaaaaaaaaaaaaaaaaaaa', type: 'edge', data: { from: 'a', to: 'b', kind: 'related', weight: 1 } };
  const kante2 = { ...kante, data: { ...kante.data, weight: 2 } };
  assert.equal(merge.beideBehalten({ recordId: kante.id, recordType: 'edge', local: kante, remote: kante2 }).kopie, null);
});

/* ------------------------------------------------ Prüfung Runde 1 (K1) */

test('2b: nur A ändert zweimal (B hat v2 schon, A liest das Echo nicht) -> kein Konflikt, keine Kopie; eine Löschung bleibt', async () => {
  for (const art of ['aendern', 'loeschen']) {
    for (const beideStecken of [true, false]) {
      await welt(async (w) => {
        const A = w.stick('a');
        const B = w.stick('b');
        w.welt.add(A.root);
        w.welt.add(B.root);
        const appA = await w.start(A, { name: 'Max' });
        const appB = await w.start(B, { name: 'Lena' });
        await koppeln(appA, appB, B);
        const x = appA.store.create('note', { title: 'Tagebuch', body: 'v1' });
        for (const a of [appA, appB, appA]) await a.kopplung.abgleichen();

        appA.store.update(x.id, { body: 'v2' });
        await appA.kopplung.abgleichen();
        if (!beideStecken) { w.welt.clear(); w.welt.add(B.root); }
        await appB.kopplung.abgleichen();
        assert.equal(notiz(appB, x.id), 'v2');
        w.welt.add(A.root);
        w.welt.add(B.root);
        if (art === 'aendern') appA.store.update(x.id, { body: 'v3' });
        else appA.store.remove(x.id);
        const soll = art === 'aendern' ? 'v3' : 'v2 (gelöscht)';
        const r = await appA.kopplung.abgleichen();
        assert.equal(r.konflikte, 0, `${art}/${beideStecken}: falscher Konflikt bei A`);
        assert.equal(notiz(appA, x.id), soll);
        if (!beideStecken) { w.welt.clear(); w.welt.add(B.root); }
        const rb = await appB.kopplung.abgleichen();
        assert.equal(rb.konflikte, 0, `${art}/${beideStecken}: falscher Konflikt bei B`);
        assert.equal(notiz(appB, x.id), soll, `${art}/${beideStecken}: B`);
        w.welt.add(A.root);
        for (const a of [appA, appB, appA]) await a.kopplung.abgleichen();
        assert.equal(notiz(appA, x.id), soll, `${art}/${beideStecken}: A danach`);
        assert.equal(notiz(appB, x.id), soll, `${art}/${beideStecken}: B danach`);
        assert.equal(kopien(appA).length + kopien(appB).length, 0, `${art}/${beideStecken}: zweite Fassung`);
      });
    }
  }
});

/** Beide ändern X; B läuft allein, dann A mit B (Konflikt, Kopie), dann B allein. */
async function zweiFassungen(w, tag) {
  const A = w.stick(`a${tag}`);
  const B = w.stick(`b${tag}`);
  w.welt.add(A.root);
  w.welt.add(B.root);
  const appA = await w.start(A, { name: 'Max' });
  const appB = await w.start(B, { name: 'Lena' });
  await koppeln(appA, appB, B);
  const x = appA.store.create('note', { title: 'Einkaufsliste', body: 'Milch' });
  for (const a of [appA, appB, appA, appB]) await a.kopplung.abgleichen();
  appA.store.update(x.id, { body: `Milch, Brot (Max ${tag})` });
  appB.store.update(x.id, { body: `Milch, Eier (Lena ${tag})` });
  w.welt.clear(); w.welt.add(B.root);
  await appB.kopplung.abgleichen();
  w.welt.add(A.root);
  await appA.kopplung.abgleichen();
  const nurB = async () => { w.welt.clear(); w.welt.add(B.root); await appB.kopplung.abgleichen(); };
  const aMitB = async () => { w.welt.add(A.root); w.welt.add(B.root); return appA.kopplung.abgleichen(); };
  return { A, B, appA, appB, x, nurB, aMitB };
}

test('1.7 Punkt 8: „Wer sie nicht will, löscht sie“ – auf dem Stick, der die Kopie bekam, und auf dem, der sie anlegte', async () => {
  for (let i = 0; i < 4; i++) {
    await welt(async (w) => {
      // B löscht die Kopie, die von A kam.
      const v = await zweiFassungen(w, `d${i}`);
      await v.nurB();
      const kA = kopien(v.appA);
      const kB = kopien(v.appB);
      assert.equal(kA.length, 1);
      assert.deepEqual(kB.map((k) => k.id), kA.map((k) => k.id), 'beide haben dieselbe Kopie');
      const kid = kB[0].id;
      v.appB.store.remove(kid);
      await v.appB.kopplung.abgleichen();
      const ra = await v.aMitB();
      assert.equal(ra.konflikte, 0, `Lauf ${i}: eine Löschung, die nur eine Seite gemacht hat, ist kein Konflikt`);
      await v.nurB();
      await v.aMitB(); // A ändert danach etwas anderes: die Kopie darf nicht zurückkommen
      v.appA.store.create('note', { title: 'ganz anderes', body: 'x' });
      await v.aMitB();
      await v.nurB();
      assert.equal(v.appA.store.get(kid), null, `Lauf ${i}: Kopie auf A wieder da`);
      assert.equal(v.appB.store.get(kid), null, `Lauf ${i}: Kopie auf B wieder da`);
    });
    await welt(async (w) => {
      // A löscht die eben angelegte Kopie sofort, bevor B abgeglichen hat.
      const v = await zweiFassungen(w, `s${i}`);
      const k = kopien(v.appA)[0];
      assert.ok(k, `Lauf ${i}: A hat keine Kopie angelegt`);
      v.appA.store.remove(k.id);
      await v.aMitB();
      await v.nurB();
      await v.aMitB();
      await v.nurB();
      assert.equal(v.appA.store.get(k.id), null, `Lauf ${i}: „${k.data.title}“ ist auf A wieder da`);
      assert.equal(v.appB.store.get(k.id), null, `Lauf ${i}: „${k.data.title}“ ist auf B wieder da`);
    });
  }
});

test('1.7 Punkt 8: eine Bearbeitung der Kopie geht nicht verloren', async () => {
  for (let i = 0; i < 4; i++) {
    await welt(async (w) => {
      const v = await zweiFassungen(w, `e${i}`);
      await v.nurB();
      const kid = kopien(v.appB)[0].id;
      const neu = `zusammengeführt ${i}: Milch, Brot, Eier`;
      v.appB.store.update(kid, { body: neu });
      await v.appB.kopplung.abgleichen();
      await v.aMitB();
      await v.nurB();
      await v.aMitB();
      assert.equal(notiz(v.appA, kid), neu, `Lauf ${i}: A`);
      assert.equal(notiz(v.appB, kid), neu, `Lauf ${i}: B`);
    });
  }
});

test('Partner-Stick voll (ENOSPC): kein Zwilling; nach dem Aufräumen bekommt B die Notiz', async () => {
  await welt(async (w) => {
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);
    await appA.kopplung.abgleichen();
    await w.stop(appB);
    const boxAufB = path.join(B.sync, appA.identitaet.id);
    const manifestVorher = fs.readFileSync(path.join(boxAufB, 'manifest.json'), 'utf8');

    // Der Stick von B ist voll: jede neue Datei in A's Postfach auf B scheitert.
    const echtesOpen = fs.promises.open;
    fs.promises.open = async function voll(datei, ...rest) {
      if (String(datei).startsWith(boxAufB + path.sep)) {
        const err = new Error('ENOSPC: no space left on device');
        err.code = 'ENOSPC';
        throw err;
      }
      return echtesOpen.call(this, datei, ...rest);
    };
    let n;
    try {
      n = appA.store.create('note', { title: 'eine einzige neue Notiz', body: 'x' });
      for (let i = 0; i < 3; i++) {
        const r = await appA.kopplung.abgleichen();
        assert.equal(r.zwilling, false, `Lauf ${i + 1}: A hält sich für einen Zwilling`);
      }
    } finally {
      fs.promises.open = echtesOpen;
    }
    assert.equal(fs.readFileSync(path.join(boxAufB, 'manifest.json'), 'utf8'), manifestVorher, 'auf B liegt weiter das alte Postfach');
    assert.equal(appA.kopplung.status().selbst.zwilling, false);

    const r = await appA.kopplung.abgleichen();
    assert.ok(r.geschrieben.some((g) => g.ordner === B.sync), `nach dem Aufräumen schreibt A wieder auf B: ${JSON.stringify(r)}`);
    const appB2 = await w.start(B);
    await appB2.kopplung.abgleichen();
    assert.ok(appB2.store.get(n.id), 'B bekommt die Notiz');
  });
});

test('Zwilling: wird die Kopie formatiert oder gelöscht, gleicht A wieder mit B ab', async () => {
  for (const art of ['formatiert', 'geloescht']) {
    await welt(async (w) => {
      const A = w.stick('a');
      const B = w.stick('b');
      w.welt.add(A.root);
      w.welt.add(B.root);
      const appA = await w.start(A, { name: 'Max' });
      const appB = await w.start(B, { name: 'Lena' });
      await koppeln(appA, appB, B);
      const x = appA.store.create('note', { title: 'X', body: 'v1' });
      for (const a of [appA, appB, appA]) await a.kopplung.abgleichen();
      await appA.store.flush();
      const S = w.stick('s');
      fs.rmSync(S.data, { recursive: true, force: true });
      fs.cpSync(A.data, S.data, { recursive: true, filter: (p) => path.basename(p) !== '.lock' });
      fs.copyFileSync(path.join(A.root, pathsMod.PORTABLE_MARKER), path.join(S.root, pathsMod.PORTABLE_MARKER));
      w.welt.add(S.root);
      await appA.kopplung.finden();
      assert.equal(appA.kopplung.status().selbst.zwilling, true, 'Vorbedingung: Zwilling erkannt');
      if (art === 'formatiert') {
        for (const e of fs.readdirSync(S.root)) fs.rmSync(path.join(S.root, e), { recursive: true, force: true });
        await appA.kopplung.finden();
        assert.equal(appA.kopplung.status().selbst.zwilling, false, 'formatiert: sofort vorbei');
      } else {
        w.welt.delete(S.root);
        fs.rmSync(S.root, { recursive: true, force: true });
        for (let i = 0; i < 3; i++) await appA.kopplung.finden();
      }
      appA.store.update(x.id, { body: 'v2' });
      const r = await appA.kopplung.abgleichen();
      assert.equal(r.zwilling, false, `${art}: A schreibt nicht`);
      await appB.kopplung.abgleichen();
      assert.equal(notiz(appB, x.id), 'v2', `${art}: B bekommt die Änderung nicht`);
      assert.equal(appA.kopplung.status().partner.length, 1, 'die Kopplung mit B bleibt');
    });
  }
});

test('Entkoppeln ohne gesteckten B, dann doch wieder koppeln: B nimmt das neue Angebot an', async () => {
  await welt(async (w) => {
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    const idB = await kiAnlegen(B, 'Lena');
    await appA.kopplung.koppeln({ root: B.root });
    let appB = await w.start(B);
    await appB.kopplung.starten();
    await w.stop(appB);
    await appA.kopplung.abgleichen();
    w.welt.delete(B.root);
    await appA.kopplung.entkoppeln(idB);
    w.welt.add(B.root);
    await appA.kopplung.finden();
    await appA.kopplung.koppeln({ root: B.root });
    assert.ok(fs.readdirSync(path.join(B.sync, 'koppeln')).includes(`${appA.identitaet.id}.angebot`), 'das neue Angebot liegt auf B');
    appB = await w.start(B);
    await appB.kopplung.annehmen();
    assert.equal(appB.kopplung.status().partner.length, 1, 'B ist wieder gekoppelt');
    const n = appA.store.create('note', { title: 'nach dem Wiederkoppeln', body: 'x' });
    await appA.kopplung.abgleichen();
    await appB.kopplung.abgleichen();
    assert.ok(appB.store.get(n.id), 'die Notiz von A kommt bei B an');
  });
});

test('Lena entkoppelt an ihrem Laptop: A erfährt es über Lenas Stick, auch wenn Lena nie mit A läuft', async () => {
  await welt(async (w) => {
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    await koppeln(appA, appB, B);
    for (const a of [appA, appB, appA]) await a.kopplung.abgleichen();
    const idA = appA.identitaet.id;
    await w.stop(appA);
    w.welt.delete(A.root);
    await appB.kopplung.entkoppeln(idA);
    await w.stop(appB);
    w.welt.add(A.root);
    const appA2 = await w.start(A);
    appA2.store.create('note', { title: 'Tag 1', body: 'Max schreibt' });
    await appA2.kopplung.abgleichen();
    assert.deepEqual(appA2.kopplung.status().partner.map((p) => p.zustand), [], 'A zeigt weiter „Gekoppelt mit Lena · abgeglichen …“');
    assert.equal(fs.existsSync(path.join(B.sync, idA)), false, 'A schreibt weiter sein Postfach auf Lenas Stick');
  });
});

test('Zwei schon benutzte Sticks koppeln: eine Startinhalt-Änderung auf nur einer Seite gibt keine zweite Fassung', async () => {
  await welt(async (w) => {
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max' });
    const appB = await w.start(B, { name: 'Lena' });
    assert.equal(await seedIfEmpty(appA), true);
    assert.equal(await seedIfEmpty(appB), true);
    const aufgabe = appA.store.list('task').items.find((t) => t.data.title === 'Claude verbinden');
    appA.store.update(aufgabe.id, { status: 'done' });
    const will = appA.store.list('note').items.find((n) => n.data.title === 'Willkommen in Neural OS');
    appA.store.update(will.id, { pinned: false });
    await koppeln(appA, appB, B);
    const konflikte = [];
    for (const a of [appA, appB, appA, appB]) konflikte.push((await a.kopplung.abgleichen()).konflikte);
    assert.deepEqual(konflikte, [0, 0, 0, 0]);
    assert.equal(kopien(appA).length + kopien(appB).length, 0, 'zweite Fassungen der Startinhalte');
    const tB = appB.store.list('task').items.map((t) => `${t.data.title}:${t.data.status}`).sort();
    assert.ok(tB.includes('Claude verbinden:done') && !tB.includes('Claude verbinden:todo'), JSON.stringify(tB));
    assert.equal(appB.store.get(will.id).data.pinned, false);
  });
});

test('kopplungen.json, deren Siegel zufällig mit „{“ beginnt, wird gelesen (etwa jeder 256. Fall)', async () => {
  await welt(async (w) => {
    const A = w.stick('a');
    const B = w.stick('b');
    w.welt.add(A.root);
    w.welt.add(B.root);
    const appA = await w.start(A, { name: 'Max', pin: '4711' });
    const appB = await w.start(B, { name: 'Lena', pin: '0815' });
    await koppeln(appA, appB, B, '0815');
    const datei = path.join(A.data, 'kopplungen.json');
    const klar = appA.vaultCrypto.decryptBuffer(fs.readFileSync(datei));
    let roh;
    for (let i = 0; i < 5000; i++) {
      roh = appA.vaultCrypto.encryptBuffer(klar);
      if (roh[0] === 0x7b) break;
    }
    assert.equal(roh[0], 0x7b, 'Vorbedingung: ein Siegel mit „{“ vorne');
    await w.stop(appA);
    fs.writeFileSync(datei, roh);
    const appA2 = await w.start(A, { pin: '4711' });
    assert.deepEqual(appA2.kopplung.status().partner.map((p) => p.name), ['Lena']);
  });
});
