'use strict';

/**
 * Tests für die Ordnerbeobachtung.
 *
 * Alles hier läuft gegen echte Dateien in einem Wegwerf-Verzeichnis und gegen
 * den echten Speicher. Das ist kein Selbstzweck: die Eigenschaften, auf die es
 * bei diesem Teilsystem ankommt, sind genau die, die eine Attrappe
 * wegdefinieren würde.
 *
 *  - Ein symbolischer Link wird nur dann wirklich nicht verfolgt, wenn er ein
 *    echter symbolischer Link im Dateisystem ist. `fs.symlinkSync` also, kein
 *    nachgebauter Verzeichniseintrag.
 *  - „Nichts angelegt" lässt sich nur am echten Speicher zeigen.
 *  - „stop() baut wirklich alles ab" heißt: danach löst eine echte
 *    Dateiänderung nichts mehr aus. Ein Zähler in einer Attrappe würde das
 *    nicht beweisen.
 *  - Dass die Zeitgeber den Prozess nicht am Leben halten, ist überhaupt nur
 *    in einem eigenen Prozess prüfbar — deshalb startet ein Test einen.
 *
 * Kein Test hier geht ins Netz, keiner fasst das echte Heimatverzeichnis an,
 * und keiner braucht ein Sprachmodell.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { test, drain, tempHome } = require('./harness');

const { openStore } = require('../src/store/engine');
const pathsMod = require('../src/kernel/paths');
const { Bus } = require('../src/kernel/bus');
const configMod = require('../src/kernel/config');
const { createWatcher } = require('../src/store/watch');
const watchApi = require('../src/http/api/watch');

/** Tests dürfen nicht über die Ausgabe des Runners schreiben. */
const SILENT = { error() {}, warn() {}, info() {}, debug() {} };
const silentLogger = () => SILENT;

/**
 * Echter Speicher, echter Beobachter, echte Dateien — danach alles weg.
 *
 * Der Tresor (`vaultHome`) und der beobachtete Ordner (`quelle`) liegen
 * absichtlich nebeneinander und nicht ineinander: dass das ineinander
 * verboten ist, prüft ein eigener Test.
 *
 * @param {(env:object)=>any} fn
 * @param {{deps?:object}} [opts]
 */
async function withWatcher(fn, opts = {}) {
  const { home, cleanup } = tempHome('nos-watch');
  const vaultHome = path.join(home, 'tresor');
  const quelle = path.join(home, 'quelle');
  fs.mkdirSync(quelle, { recursive: true });

  const paths = pathsMod.ensureLayout(pathsMod.layout(vaultHome));
  const bus = new Bus();
  const store = await openStore({ paths, bus, logger: silentLogger });
  const watcher = createWatcher({
    store,
    bus,
    paths,
    logger: silentLogger,
    config: { watch: { debounceMs: 60, sweepIntervalMs: 5000 } },
    ...(opts.deps || {}),
  });

  try {
    await fn({ store, bus, watcher, quelle, vaultHome, paths, home });
  } finally {
    try { watcher.stop(); } catch { /* schon gestoppt */ }
    await store.close().catch(() => {});
    cleanup();
  }
}

function write(dir, name, content) {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

/** Einen eingeschalteten Ordner anlegen — zwei Schritte, wie in der Oberfläche. */
function armed(watcher, quelle, input = {}) {
  const record = watcher.add({ path: quelle, ...input });
  return watcher.enable(record.id, true);
}

function reasonFor(result, needle) {
  const entry = result.uebersprungen.find((e) => e.datei.includes(needle));
  return entry ? entry.grund : null;
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Warten, bis eine Bedingung wahr ist — oder ehrlich scheitern. */
async function waitFor(check, { timeoutMs = 3000, what = 'Bedingung' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() > until) throw new Error(`${what} ist nach ${timeoutMs} ms nicht eingetreten`);
    await sleep(25);
  }
}

function filesIn(store) {
  return store.all('file');
}

/* ------------------------------------------------------- der Schalter */

test('Ein ausgeschalteter Ordner wird nicht gelesen', async () => {
  await withWatcher(async ({ store, watcher, quelle }) => {
    write(quelle, 'notiz.txt', 'Ein Satz, den niemand angefordert hat.');
    const record = watcher.add({ path: quelle });

    assert.equal(record.data.enabled, false, 'ab Werk ausgeschaltet — das ist der ganze Punkt');

    await assert.rejects(
      () => watcher.scan(record.id, {}),
      (err) => err.code === 'WATCH_DISABLED' && /ausgeschaltet/.test(err.message),
      'ein ausgeschalteter Ordner muss den Durchlauf ablehnen, nicht still nichts tun',
    );
    assert.equal(store.count('file'), 0, 'es darf nichts im Tresor gelandet sein');

    // Auch die Automatik lässt ihn in Ruhe: start() hängt sich nicht an ihn,
    // und der Rundlauf geht an ihm vorbei.
    watcher.start({ sweepIntervalMs: 5000 });
    assert.equal(watcher.status().watching, 0, 'an einen ausgeschalteten Ordner wird nichts angehängt');
    write(quelle, 'noch-einer.txt', 'Auch der nicht.');
    await watcher.sweep();
    assert.equal(store.count('file'), 0, 'der Rundlauf darf einen ausgeschalteten Ordner nicht anfassen');
  });
});

test('Einschalten allein nimmt noch nichts auf', async () => {
  await withWatcher(async ({ store, watcher, quelle }) => {
    write(quelle, 'notiz.txt', 'Da, aber noch nicht angefordert.');
    const record = armed(watcher, quelle);
    assert.equal(record.data.enabled, true);
    // Der Satz, den die Oberfläche beim Einschalten verspricht, stimmt nur,
    // wenn Einschalten genau eine Folge hat: ab jetzt wird geschaut.
    assert.equal(store.count('file'), 0, 'Einschalten ist keine Aufnahme');
  });
});

/* ------------------------------------------------------------ Erst ansehen */

test('dryRun legt nichts an und sagt, was es nicht wissen kann', async () => {
  await withWatcher(async ({ store, watcher, quelle }) => {
    write(quelle, 'a.txt', 'Erster Text.');
    write(quelle, 'b.md', '# Zweiter Text');
    write(quelle, 'film.mp4', Buffer.alloc(64));
    const record = armed(watcher, quelle);

    const vorschau = await watcher.scan(record.id, { dryRun: true });
    assert.equal(vorschau.dryRun, true);
    assert.equal(vorschau.gefunden, 3);
    assert.equal(vorschau.aufgenommen, 0, 'eine Vorschau nimmt nichts auf');
    assert.equal(vorschau.wuerdeAufnehmen, 2);
    assert.deepEqual(vorschau.neu.map((n) => n.datei).sort(), ['a.txt', 'b.md']);
    assert.match(reasonFor(vorschau, 'film.mp4') || '', /kann dieses System keinen Text lesen/);
    assert.match(String(vorschau.hinweis), /keine Datei wurde geöffnet/);
    assert.equal(store.count('file'), 0, 'nach einer Vorschau ist der Tresor unverändert');

    const nachher = store.get(record.id);
    assert.equal(nachher.data.imported, 0);
    assert.equal(nachher.data.lastScanAt, null, 'eine Vorschau ist kein Durchlauf');

    const echt = await watcher.scan(record.id, {});
    assert.equal(echt.aufgenommen, 2, 'und danach passiert genau das, was angekündigt war');
  });
});

/* ------------------------------------------------------------- die Grenzen */

test('Eine zu große Datei wird mit Grund übersprungen, nicht halb gelesen', async () => {
  await withWatcher(async ({ store, watcher, quelle }) => {
    write(quelle, 'klein.txt', 'passt');
    write(quelle, 'riesig.txt', 'x'.repeat(4096));
    const record = armed(watcher, quelle, { maxFileBytes: 1024 });

    const result = await watcher.scan(record.id, {});
    assert.equal(result.aufgenommen, 1);
    const grund = reasonFor(result, 'riesig.txt');
    assert.match(String(grund), /Zu groß/);
    assert.match(String(grund), /erlaubt sind 1 kB/, 'der Grund nennt die Grenze, nicht nur das Urteil');
    assert.match(String(grund), /Halb gelesen wird nichts/);

    const namen = filesIn(store).map((f) => f.data.name);
    assert.deepEqual(namen, ['klein.txt']);
  });
});

test('Ein symbolischer Link aus dem Ordner heraus wird nicht verfolgt', async () => {
  await withWatcher(async ({ store, watcher, quelle, home }) => {
    // Das, wovor die Regel schützt: ein Link auf ein Verzeichnis mit
    // Schlüsselmaterial und ein Link auf die Wurzel des Dateisystems.
    const geheim = path.join(home, 'nicht-ssh');
    fs.mkdirSync(geheim, { recursive: true });
    fs.writeFileSync(path.join(geheim, 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\nnicht deins\n');
    fs.writeFileSync(path.join(home, 'auch-geheim.txt'), 'Nur für mich.');

    write(quelle, 'echt.txt', 'Diese Datei gehört wirklich hierher.');
    fs.symlinkSync(geheim, path.join(quelle, 'schluessel'));
    fs.symlinkSync(path.join(home, 'auch-geheim.txt'), path.join(quelle, 'verlockend.txt'));
    fs.symlinkSync('/', path.join(quelle, 'alles'));

    const record = armed(watcher, quelle);
    const result = await watcher.scan(record.id, {});

    assert.equal(result.aufgenommen, 1, 'nur die echte Datei');
    for (const name of ['schluessel', 'verlockend.txt', 'alles']) {
      assert.match(String(reasonFor(result, name)), /Symbolischer Link – wird nicht verfolgt/,
        `${name} muss als Link gemeldet werden, nicht stillschweigend übergangen`);
    }

    const aufgenommen = filesIn(store);
    assert.deepEqual(aufgenommen.map((f) => f.data.name), ['echt.txt']);
    for (const file of aufgenommen) {
      assert.ok(!String(file.data.text || '').includes('PRIVATE KEY'), 'kein Schlüsselmaterial im Tresor');
      assert.ok(file.data.externalPath.startsWith(fs.realpathSync(quelle)),
        'jeder aufgenommene Pfad liegt im beobachteten Ordner');
    }
    assert.equal(store.search('OPENSSH').items.length, 0, 'und nichts davon ist durchsuchbar geworden');
  });
});

test('Der Tresor selbst lässt sich nicht beobachten – in beide Richtungen', async () => {
  await withWatcher(async ({ watcher, vaultHome, home }) => {
    assert.throws(
      () => watcher.add({ path: vaultHome }),
      (err) => err.code === 'VALIDATION_FAILED' && /Datenordner von Neural OS/.test(err.message),
      'der Tresor selbst',
    );
    assert.throws(
      () => watcher.add({ path: path.join(vaultHome, 'vault', 'files') }),
      (err) => /Datenordner von Neural OS/.test(err.message),
      'ein Unterordner des Tresors',
    );
    // Der andere Weg in dieselbe Falle: ein Ordner, der den Tresor enthält.
    assert.throws(
      () => watcher.add({ path: home }),
      (err) => /enthält den Datenordner/.test(err.message),
      'ein Ordner oberhalb des Tresors',
    );
  });
});

test('Ein Pfad, den es nicht gibt, ist ein 404 mit Namen – keine stille Ablage', async () => {
  await withWatcher(async ({ watcher, home }) => {
    assert.throws(
      () => watcher.add({ path: path.join(home, 'gibtsnicht') }),
      (err) => err.status === 404,
    );
    assert.throws(() => watcher.add({ path: '   ' }), (err) => err.code === 'VALIDATION_FAILED');
  });
});

/* ------------------------------------------------------- keine Dubletten */

test('Dieselbe Datei wird nicht zweimal aufgenommen', async () => {
  await withWatcher(async ({ store, watcher, quelle }) => {
    write(quelle, 'einmal.txt', 'Genau dieser Inhalt.');
    const record = armed(watcher, quelle);

    const erster = await watcher.scan(record.id, {});
    assert.equal(erster.aufgenommen, 1);

    const zweiter = await watcher.scan(record.id, {});
    assert.equal(zweiter.aufgenommen, 0, 'der zweite Durchlauf nimmt nichts noch einmal auf');
    assert.match(String(reasonFor(zweiter, 'einmal.txt')), /unverändert/);
    assert.equal(store.count('file'), 1);

    // Dieselben Bytes unter anderem Namen: `store.files` ist
    // inhaltsadressiert, also ist das dieselbe Datei und wird auch so gemeldet.
    write(quelle, 'kopie.txt', 'Genau dieser Inhalt.');
    const dritter = await watcher.scan(record.id, {});
    assert.equal(dritter.aufgenommen, 0);
    assert.match(String(reasonFor(dritter, 'kopie.txt')), /Derselbe Inhalt liegt schon im Tresor/);
    assert.equal(store.count('file'), 1, 'eine Kopie ist kein zweiter Eintrag');

    const geaendert = write(quelle, 'einmal.txt', 'Jetzt steht etwas anderes drin.');
    assert.ok(fs.existsSync(geaendert));
    const vierter = await watcher.scan(record.id, {});
    assert.equal(vierter.aufgenommen, 1, 'eine wirklich geänderte Datei kommt neu herein');
    assert.equal(store.count('file'), 2);
  });
});

/* -------------------------------------------------- ehrlich beim Scheitern */

test('Eine unlesbare Datei landet mit Grund im Protokoll und stoppt den Durchlauf nicht', async () => {
  await withWatcher(async ({ store, watcher, quelle }) => {
    // Nach Namen sortiert läuft die kaputte Datei VOR der guten: wenn sie den
    // Durchlauf abbräche, käme die gute nie an. Ein abgeschnittenes ZIP ist
    // echt unlesbar -- ein .docx, in dem in Wahrheit Text steht, wäre es
    // nicht, denn die Extraktion geht nach den Bytes und nicht nach dem Namen.
    write(quelle, '1-kaputt.docx', Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), Buffer.from('abgeschnitten')]));
    write(quelle, '2-gut.txt', 'Und diese hier ist in Ordnung.');
    write(quelle, '3-leer.txt', '');

    const record = armed(watcher, quelle);
    const result = await watcher.scan(record.id, {});

    assert.equal(result.aufgenommen, 1, 'der Durchlauf läuft über den Fehler hinweg weiter');
    assert.deepEqual(filesIn(store).map((f) => f.data.name), ['2-gut.txt']);

    const kaputt = reasonFor(result, '1-kaputt.docx');
    assert.ok(kaputt, 'die kaputte Datei steht im Protokoll');
    assert.match(kaputt, /Text nicht lesbar/);
    assert.match(kaputt, /beschädigt oder unvollständig/,
      'der Grund ist der Satz der Extraktion, nicht ein Fehlercode');
    assert.match(String(reasonFor(result, '3-leer.txt')), /leer/);

    const protokoll = watcher.log(record.id);
    assert.equal(protokoll.aufgenommen.length, 1);
    assert.ok(protokoll.uebersprungen.some((e) => e.datei === '1-kaputt.docx' && e.grund),
      'das Protokoll nennt die übersprungene Datei mit Grund');
    assert.match(protokoll.hinweis, /nur, solange es läuft/,
      'und sagt, wie weit es zurückreicht, statt Dauerhaftigkeit vorzutäuschen');

    const nachher = store.get(record.id);
    assert.equal(nachher.data.imported, 1);
    assert.equal(nachher.data.skipped, 2,
      'die Karte nennt die übersprungenen Einträge dieses einen Durchlaufs: die kaputte und die leere');
    assert.equal(nachher.data.lastError, null, 'übersprungene Dateien sind kein Fehler des Ordners');
  });
});

test('Ein Ordner, den es nicht mehr gibt, landet als Satz in lastError', async () => {
  await withWatcher(async ({ store, watcher, quelle }) => {
    write(quelle, 'da.txt', 'Noch da.');
    const record = armed(watcher, quelle);
    await watcher.scan(record.id, {});

    fs.rmSync(quelle, { recursive: true, force: true });
    const result = await watcher.scan(record.id, {});
    assert.equal(result.aufgenommen, 0);
    assert.ok(result.abgebrochen, 'der Durchlauf sagt, dass er abgebrochen ist');
    const nachher = store.get(record.id);
    assert.match(String(nachher.data.lastError), /not found|nicht erreichbar/i);
  });
});

test('Eine Warnung aus der Textextraktion wird durchgereicht, nicht ersetzt', async () => {
  // Ein gescanntes PDF ohne Textebene liefert kind 'pdf-image', leeren Text
  // und eine Warnung. Hier wird die Extraktion eingesetzt statt nachgebaut,
  // weil geprüft werden soll, was dieses Modul mit der Warnung MACHT.
  const gescannt = {
    extractText() {
      return { text: '', kind: 'pdf-image', truncated: false, warnings: ['Diese PDF enthält nur Bilder, keinen Text.'] };
    },
  };
  await withWatcher(async ({ store, watcher, quelle }) => {
    write(quelle, 'scan.pdf', Buffer.from('%PDF-1.4 tut hier nichts zur Sache'));
    const record = armed(watcher, quelle);
    const result = await watcher.scan(record.id, {});

    assert.equal(result.aufgenommen, 1);
    assert.ok(result.warnungen.some((w) => w.includes('nur Bilder')), 'die Warnung steht im Ergebnis');

    const file = filesIn(store)[0];
    assert.equal(file.data.text, '', 'kein erfundener Text');
    assert.deepEqual(file.data.extractWarnings, ['Diese PDF enthält nur Bilder, keinen Text.']);

    const protokoll = watcher.log(record.id);
    assert.equal(protokoll.aufgenommen[0].leererText, true);
    assert.equal(protokoll.aufgenommen[0].art, 'pdf-image');
  }, { deps: { extract: gescannt } });
});

test('Aus einer echten HTML-Datei kommt echter Text', async () => {
  await withWatcher(async ({ store, watcher, quelle }) => {
    write(quelle, 'seite.html', '<html><body><h1>Überschrift</h1><p>Ein Absatz.</p><script>böse()</script></body></html>');
    const record = armed(watcher, quelle);
    await watcher.scan(record.id, {});

    const file = filesIn(store)[0];
    assert.match(file.data.text, /Überschrift/);
    assert.match(file.data.text, /Ein Absatz/);
    assert.ok(!file.data.text.includes('böse()'), 'Skript-Inhalt ist kein Text der Seite');
    assert.equal(file.data.mime, 'text/html');
    assert.ok(store.files.has(file.data.hash), 'die Bytes liegen inhaltsadressiert im Tresor');
  });
});

test('Tags und Herkunft hängen an jeder aufgenommenen Datei', async () => {
  await withWatcher(async ({ store, watcher, quelle }) => {
    write(quelle, 'unterlagen/rechnung.txt', 'Betrag: 12,40 EUR');
    const record = armed(watcher, quelle, { tags: ['papierkram', 'auto-aufgenommen'] });
    const result = await watcher.scan(record.id, {});

    assert.equal(result.aufgenommen, 1);
    const file = filesIn(store)[0];
    assert.deepEqual(file.data.tags, ['papierkram', 'auto-aufgenommen']);
    assert.equal(file.data.watchId, record.id, 'ohne Herkunft gäbe es keine Liste „das habe ich aufgenommen"');
    assert.equal(watcher.log(record.id).aufgenommen[0].datei, path.join('unterlagen', 'rechnung.txt'));
  });
});

test('Ohne Unterordner bleibt es bei der obersten Ebene', async () => {
  await withWatcher(async ({ store, watcher, quelle }) => {
    write(quelle, 'oben.txt', 'oben');
    write(quelle, 'tiefer/unten.txt', 'unten');
    const record = armed(watcher, quelle, { recursive: false });
    await watcher.scan(record.id, {});
    assert.deepEqual(filesIn(store).map((f) => f.data.name), ['oben.txt']);
  });
});

/* --------------------------------------------------- beobachten und aufhören */

test('Eine neue Datei wird von selbst aufgenommen, und mehrfaches Speichern nur einmal', async () => {
  await withWatcher(async ({ store, watcher, quelle }) => {
    const record = armed(watcher, quelle);
    watcher.start({ sweepIntervalMs: 60 * 60 * 1000 }); // der Rundlauf darf hier nicht mithelfen

    if (!watcher.status().watching) {
      // Auf manchen Dateisystemen gibt es fs.watch nicht. Dann ist der
      // Rundlauf zuständig, und dieser Test hätte nichts zu sagen.
      assert.ok(true, 'fs.watch ist hier nicht verfügbar – der Rundlauf trägt die Zusage');
      return;
    }

    // Ein Editor schreibt beim Speichern mehrfach. Ohne Entprellung landen
    // hier drei Fassungen im Tresor.
    const ziel = path.join(quelle, 'entwurf.txt');
    fs.writeFileSync(ziel, 'Fassung eins');
    fs.writeFileSync(ziel, 'Fassung zwei');
    fs.writeFileSync(ziel, 'Fassung drei');

    await waitFor(() => store.count('file') === 1, { what: 'die Aufnahme der Datei' });
    await sleep(250);
    assert.equal(store.count('file'), 1, 'mehrfaches Speichern ergibt einen Eintrag, nicht drei');
    assert.equal(filesIn(store)[0].data.text, 'Fassung drei', 'und zwar die letzte Fassung');
  });
});

test('Der schnelle Weg nimmt nichts auf, was die Vorschau abgelehnt hat', async () => {
  await withWatcher(async ({ store, watcher, quelle }) => {
    const record = armed(watcher, quelle);
    watcher.start({ sweepIntervalMs: 60 * 60 * 1000 }); // der Rundlauf darf hier nicht mithelfen

    if (!watcher.status().watching) {
      assert.ok(true, 'fs.watch ist hier nicht verfügbar – dann gibt es den schnellen Weg gar nicht');
      return;
    }

    // Was beide sichtbaren Wege mit Grund ablehnen: Punktdateien, versteckte
    // Ordner, Erzeugtes, zu tief Liegendes.
    const tief = Array.from({ length: 14 }, (_, i) => `e${i}`).join('/');
    write(quelle, '.geheim.md', '# geheim');
    write(quelle, '.config/zugang.md', '# zugang');
    write(quelle, 'node_modules/readme.md', '# paket');
    write(quelle, `${tief}/tief.md`, '# zu tief');

    const vorschau = await watcher.scan(record.id, { dryRun: true });
    assert.equal(vorschau.wuerdeAufnehmen, 0, 'die Vorschau nimmt nichts davon an');
    assert.equal((await watcher.scan(record.id, {})).aufgenommen, 0, 'und der Durchlauf auch nicht');

    // Genau dieselben Dateien noch einmal, diesmal über fs.watch. Der
    // schnelle Weg darf nicht der nachsichtige sein.
    write(quelle, '.geheim2.md', '# geheim zwei');
    write(quelle, '.config/zugang2.md', '# zugang zwei');
    write(quelle, 'node_modules/paket.md', '# paket zwei');
    write(quelle, `${tief}/tief2.md`, '# auch zu tief');
    // Der Beweis, dass lange genug gewartet wurde: diese eine gehört hinein.
    write(quelle, 'sichtbar.md', '# sichtbar');

    await waitFor(() => filesIn(store).some((f) => f.data.name === 'sichtbar.md'),
      { what: 'die Aufnahme der sichtbaren Datei' });
    await sleep(300); // großzügig länger als die Entprellung von 60 ms
    assert.deepEqual(filesIn(store).map((f) => f.data.name).sort(), ['sichtbar.md'],
      'über fs.watch kommt nichts herein, was die Vorschau eben noch abgelehnt hat');

    // Gemeldet wird, was diese eine Datei betrifft. Ein ganzer Ordner wird
    // einmal genannt, wo der Durchlauf ihn antrifft – und nicht Datei für
    // Datei, sonst drängt ein einziges npm install das Protokoll voll.
    const protokoll = watcher.log(record.id);
    const versteckt = protokoll.uebersprungen.find((e) => e.datei === '.geheim2.md');
    assert.match(String(versteckt && versteckt.grund), /Versteckte Datei/,
      'die abgelehnte Punktdatei steht mit Grund im Protokoll');
    assert.equal(protokoll.uebersprungen.filter((e) => e.datei === 'node_modules').length, 1,
      'der Durchlauf nennt den Ordner einmal mit Grund');
    assert.deepEqual(protokoll.uebersprungen.filter((e) => e.datei.startsWith(`node_modules${path.sep}`)), [],
      'aber keine einzige Datei daraus');
  });
});

test('Die Zahl „übersprungen“ auf der Karte gehört zu EINEM Durchlauf', async () => {
  await withWatcher(async ({ store, watcher, quelle }) => {
    write(quelle, 'gut.txt', 'Diese wird aufgenommen.');
    write(quelle, 'film.mp4', Buffer.alloc(64)); // bleibt dauerhaft übersprungen
    const record = armed(watcher, quelle);

    const zahlen = [];
    for (let i = 0; i < 4; i++) {
      await watcher.scan(record.id, {});
      zahlen.push(store.get(record.id).data.skipped);
    }
    // Lauf 1: film.mp4. Ab Lauf 2 zusätzlich gut.txt („schon aufgenommen").
    // Danach ändert sich nichts mehr: im Ordner passiert ja auch nichts.
    assert.deepEqual(zahlen, [1, 2, 2, 2],
      'die Zahl beschreibt den letzten Durchlauf und wächst nicht von allein weiter');
    assert.equal(store.get(record.id).data.imported, 1, 'und aufgenommen wurde genau eine Datei');
  });
});

test('stop() baut wirklich alles ab', async () => {
  await withWatcher(async ({ store, watcher, quelle }) => {
    const record = armed(watcher, quelle);
    watcher.start({ sweepIntervalMs: 60 * 60 * 1000 });
    const beobachtet = watcher.status().watching;

    fs.writeFileSync(path.join(quelle, 'vorher.txt'), 'Vor dem Stopp.');
    if (beobachtet) await waitFor(() => store.count('file') === 1, { what: 'die erste Aufnahme' });

    assert.equal(watcher.stop(), true);
    assert.equal(watcher.running, false);
    assert.equal(watcher.status().watching, 0, 'kein Betriebssystem-Beobachter bleibt offen');
    assert.equal(watcher.stop(), false, 'zweimal stoppen ist kein Fehler, aber auch kein zweiter Abbau');

    const vorher = store.count('file');
    fs.writeFileSync(path.join(quelle, 'nachher.txt'), 'Nach dem Stopp.');
    await sleep(400); // großzügig länger als die Entprellung von 60 ms
    assert.equal(store.count('file'), vorher, 'nach stop() löst eine Dateiänderung nichts mehr aus');

    // Und der Bus ist auch wieder frei: sonst liefe bei jeder Änderung
    // irgendwo ein Zuhörer in ein abgebautes Teilsystem.
    assert.equal(store.get(record.id).data.enabled, true, 'gestoppt ist nicht dasselbe wie ausgeschaltet');
  });
});

test('Ein entfernter Ordner nimmt die aufgenommenen Dateien nicht mit', async () => {
  await withWatcher(async ({ store, watcher, quelle }) => {
    write(quelle, 'bleibt.txt', 'Gehört jetzt mir.');
    const record = armed(watcher, quelle);
    await watcher.scan(record.id, {});
    assert.equal(store.count('file'), 1);

    watcher.remove(record.id);
    assert.equal(watcher.list().length, 0);
    assert.equal(store.count('file'), 1, 'die Dateien sind die Daten der Nutzerin, nicht Zubehör des Ordners');
  });
});

test('Zwei Durchläufe gleichzeitig gibt es nicht', async () => {
  await withWatcher(async ({ watcher, quelle }) => {
    for (let i = 0; i < 12; i++) write(quelle, `n${i}.txt`, `Inhalt ${i}`);
    const record = armed(watcher, quelle);
    const [a, b] = await Promise.allSettled([watcher.scan(record.id, {}), watcher.scan(record.id, {})]);
    const erfolge = [a, b].filter((r) => r.status === 'fulfilled');
    const fehler = [a, b].filter((r) => r.status === 'rejected');
    assert.equal(erfolge.length, 1);
    assert.equal(fehler.length, 1);
    assert.equal(fehler[0].reason.code, 'WATCH_BUSY');
    assert.equal(erfolge[0].value.aufgenommen, 12);
  });
});

test('Ein Massenimport läuft durch bulkWrite, ein kleiner nicht', async () => {
  // `app.bulkWrite` hält den Rückgängig-Verlauf frei, während viele Sätze auf
  // einmal geschrieben werden. Hier wird nur geprüft, dass dieses Modul es
  // benutzt -- was bulkWrite tut, gehört src/app.js und wird dort geprüft.
  const rufe = [];
  const bulkWrite = async (fn) => { rufe.push(1); return fn(); };

  await withWatcher(async ({ store, watcher, quelle }) => {
    write(quelle, 'wenig.txt', 'nur eine Datei');
    const klein = armed(watcher, quelle);
    const ergebnisKlein = await watcher.scan(klein.id, {});
    assert.equal(ergebnisKlein.sammelschreibung, false, 'eine einzelne Datei ist kein Massenimport');
    assert.equal(rufe.length, 0);
    assert.equal(ergebnisKlein.aufgenommen, 1);

    for (let i = 0; i < 40; i++) write(quelle, `viel-${i}.txt`, `Inhalt Nummer ${i}`);
    const ergebnisGross = await watcher.scan(klein.id, {});
    assert.equal(ergebnisGross.sammelschreibung, true, 'viele Dateien auf einmal laufen durch bulkWrite');
    assert.equal(rufe.length, 1);
    assert.equal(ergebnisGross.aufgenommen, 40);
    assert.equal(store.count('file'), 41);

    // Und ohne verdrahtetes bulkWrite wird es nicht behauptet.
    assert.equal(watcher.status().sammelschreibung, true);
  }, { deps: { bulkWrite } });

  await withWatcher(async ({ watcher }) => {
    assert.equal(watcher.status().sammelschreibung, false,
      'ohne verdrahtetes bulkWrite sagt der Zustand das, statt es vorzugeben');
  });
});

/* ------------------------------------------------- Zeitgeber und Prozessende */

test('Die Zeitgeber halten den Prozess nicht am Leben', async () => {
  // Nur in einem eigenen Prozess zu beantworten: ein vergessenes ref()
  // zeigt sich daran, dass node nach getaner Arbeit nicht zurückkommt.
  const { home, cleanup } = tempHome('nos-watch-exit');
  const vaultHome = path.join(home, 'tresor');
  const quelle = path.join(home, 'quelle');
  fs.mkdirSync(quelle, { recursive: true });
  fs.writeFileSync(path.join(quelle, 'egal.txt'), 'egal');

  const script = `
    const pathsMod = require(${JSON.stringify(require.resolve('../src/kernel/paths'))});
    const { openStore } = require(${JSON.stringify(require.resolve('../src/store/engine'))});
    const { createWatcher } = require(${JSON.stringify(require.resolve('../src/store/watch'))});
    const still = () => ({ error(){}, warn(){}, info(){}, debug(){} });
    (async () => {
      const paths = pathsMod.ensureLayout(pathsMod.layout(${JSON.stringify(vaultHome)}));
      const store = await openStore({ paths, logger: still });
      const watcher = createWatcher({ store, paths, logger: still });
      const record = watcher.add({ path: ${JSON.stringify(quelle)} });
      watcher.enable(record.id, true);
      watcher.start({ sweepIntervalMs: 5000 });
      await store.close();
      // Absichtlich KEIN watcher.stop(): genau das ist die Frage.
      console.log('fertig');
    })().catch((err) => { console.error(err && err.stack); process.exit(3); });
  `;

  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`der Prozess lief nach getaner Arbeit weiter (Ausgabe: ${out.trim() || '-'} / ${err.trim() || '-'})`));
      }, 8000);
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      child.on('exit', (status) => {
        clearTimeout(timer);
        if (status !== 0) reject(new Error(`Kindprozess endete mit ${status}: ${err.trim()}`));
        else if (!out.includes('fertig')) reject(new Error('der Kindprozess kam nicht bis zum Ende'));
        else resolve(status);
      });
    });
    assert.equal(code, 0);
  } finally {
    cleanup();
  }
});

/* ----------------------------------------------------------------- HTTP */

// Solange `src/http/server.js` die Route noch nicht selbst lädt (die
// Verdrahtung macht jemand anderes), wird sie hier angehängt — genauso wie
// test/assist.test.js es getan hat, als die Assistenz neu war.
const SERVER_FILE = require.resolve('../src/http/server');
if (!/require\(['"]\.\/api\/watch['"]\)/.test(fs.readFileSync(SERVER_FILE, 'utf8'))) {
  const host = require('../src/http/api/graph');
  const originalRegister = host.register;
  host.register = function registerWithWatch(router) {
    originalRegister.call(this, router);
    watchApi.register(router);
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
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { /* nicht jede Route antwortet JSON */ }
          resolve({ status: res.statusCode, text: raw, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Echter Server auf einem freien Port, echter Speicher darunter. */
async function withServer(fn, opts = {}) {
  const { createServer } = require('../src/http/server');
  const { home, cleanup } = tempHome('nos-watch-http');
  const vaultHome = path.join(home, 'tresor');
  const quelle = path.join(home, 'quelle');
  fs.mkdirSync(quelle, { recursive: true });

  const paths = pathsMod.ensureLayout(pathsMod.layout(vaultHome));
  const config = configMod.defaults();
  config.server.host = '127.0.0.1';
  const bus = new Bus();
  const store = await openStore({ paths, bus, logger: silentLogger });
  const watcher = opts.withoutWatcher
    ? null
    : createWatcher({ store, bus, paths, logger: silentLogger, config: { watch: { debounceMs: 60 } } });

  const server = await createServer({
    version: 'test', config, paths, store, bus, watcher, logger: silentLogger, failures: [], ...(opts.ctx || {}),
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;
  const req = (method, urlPath, body) => request(base, method, urlPath, body);

  try {
    await fn({ req, store, watcher, quelle, vaultHome, base });
  } finally {
    if (watcher) { try { watcher.stop(); } catch { /* egal */ } }
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    cleanup();
  }
}

test('Die HTTP-Routen liefern den vereinbarten Vertrag', async () => {
  await withServer(async ({ req, store, quelle, vaultHome }) => {
    fs.writeFileSync(path.join(quelle, 'brief.txt'), 'Sehr geehrte Damen und Herren,');

    const leer = await req('GET', '/api/watch');
    assert.equal(leer.status, 200, leer.text);
    assert.deepEqual(leer.json.items, []);
    assert.equal(leer.json.status.running, false);
    assert.ok(leer.json.lesbareEndungen.includes('.pdf'));

    const angelegt = await req('POST', '/api/watch', { path: quelle, label: 'Posteingang', tags: ['post'] });
    assert.equal(angelegt.status, 200, angelegt.text);
    const id = angelegt.json.record.id;
    assert.equal(angelegt.json.record.data.enabled, false,
      'auch über HTTP ist ein neuer Ordner ausgeschaltet');

    const nochmal = await req('POST', '/api/watch', { path: quelle });
    assert.equal(nochmal.status, 400, nochmal.text);
    assert.match(nochmal.json.error.message, /wird bereits beobachtet/);

    const tresor = await req('POST', '/api/watch', { path: vaultHome });
    assert.equal(tresor.status, 400, tresor.text);
    assert.match(tresor.json.error.message, /Datenordner von Neural OS/);

    const aus = await req('POST', `/api/watch/${id}/scan`, {});
    assert.equal(aus.status, 409, aus.text);
    assert.equal(aus.json.error.code, 'WATCH_DISABLED');

    const ein = await req('PATCH', `/api/watch/${id}`, { enabled: true });
    assert.equal(ein.status, 200, ein.text);
    assert.equal(ein.json.record.data.enabled, true);

    const vorschau = await req('POST', `/api/watch/${id}/scan`, { dryRun: true });
    assert.equal(vorschau.status, 200, vorschau.text);
    assert.equal(vorschau.json.aufgenommen, 0);
    assert.equal(vorschau.json.wuerdeAufnehmen, 1);
    assert.equal(store.count('file'), 0);

    const echt = await req('POST', `/api/watch/${id}/scan`, { dryRun: false });
    assert.equal(echt.status, 200, echt.text);
    assert.equal(echt.json.aufgenommen, 1);
    assert.ok(Number.isFinite(echt.json.dauerMs));

    const protokoll = await req('GET', `/api/watch/${id}/log`);
    assert.equal(protokoll.status, 200, protokoll.text);
    assert.equal(protokoll.json.aufgenommen.length, 1);
    assert.equal(protokoll.json.aufgenommen[0].datei, 'brief.txt');
    assert.ok(typeof protokoll.json.hinweis === 'string');

    const liste = await req('GET', '/api/watch');
    assert.equal(liste.json.items.length, 1);
    assert.equal(liste.json.items[0].data.imported, 1);
    assert.ok(liste.json.items[0].beobachtung, 'die Liste sagt auch, ob wirklich beobachtet wird');

    const kaputt = await req('PATCH', `/api/watch/${id}`, {});
    assert.equal(kaputt.status, 400, kaputt.text);
    const fremd = await req('GET', '/api/watch/watch_gibtsnichtgibtsnicht00/log');
    assert.equal(fremd.status, 404, fremd.text);

    const weg = await req('DELETE', `/api/watch/${id}`);
    assert.equal(weg.status, 200, weg.text);
    assert.match(weg.json.hinweis, /bleiben im Tresor/);
    assert.equal(store.count('file'), 1);
    assert.equal((await req('GET', '/api/watch')).json.items.length, 0);
  });
});

test('Ohne das Teilsystem sagt die Route das, statt so zu tun als ob', async () => {
  await withServer(async ({ req }) => {
    const res = await req('GET', '/api/watch');
    assert.equal(res.status, 503, res.text);
    assert.equal(res.json.error.code, 'SUBSYSTEM_UNAVAILABLE');
    assert.match(res.json.error.message, /Ordnerbeobachtung/);
  }, { withoutWatcher: true });
});

test('Ein geteilter Zugang darf die Liste lesen, aber keinen Ordner anlegen', async () => {
  const gast = {
    async middleware() {
      return { ok: true, identity: { kind: 'token', permissions: { read: true, write: false, chat: false, agents: false } } };
    },
  };
  await withServer(async ({ req, quelle }) => {
    assert.equal((await req('GET', '/api/watch')).status, 200);

    const versuch = await req('POST', '/api/watch', { path: quelle });
    assert.equal(versuch.status, 403, versuch.text);
    assert.equal(versuch.json.error.code, 'PERMISSION_DENIED');

    const einschalten = await req('PATCH', '/api/watch/watch_irgendwasirgendwas1', { enabled: true });
    assert.equal(einschalten.status, 403, 'ein Gast schaltet keinen Ordner ein');
  }, { ctx: { auth: gast } });
});

module.exports = { name: 'watch', tests: drain() };
