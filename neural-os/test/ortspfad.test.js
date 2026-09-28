'use strict';

/**
 * Paket O (docs/STICK-BAUPLAN.md 2.7): Ordner je Rechner.
 *
 * Ein Ordner auf dem Stick gilt an jedem Rechner, ein Ordner auf der
 * Festplatte nur an dem Rechner (und Konto), an dem er gewählt wurde. Die
 * Stick-KI liest nie Dokumente eines fremden PCs, auch nicht über die Ordner,
 * die Agenten und Modulen freigegeben sind.
 *
 * "Ein anderer Rechner" wird gespielt, indem `rechner.profil` am Modulobjekt
 * ersetzt wird; ortspfad.js liest es bei jedem Aufruf dort.
 *
 * ortspfad.js wird erst in den Tests geladen, damit diese Datei auch ohne das
 * Modul lädt und jeder Test einzeln rot sein kann.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { test, drain, tempHome } = require('./harness');

const rechner = require('../src/kernel/rechner');
const { PORTABLE_MARKER, layout, ensureLayout } = require('../src/kernel/paths');
const configMod = require('../src/kernel/config');
const permissions = require('../src/agents/permissions');

const ortspfad = () => require('../src/kernel/ortspfad');

/** Einen anderen Rechner spielen, danach wieder diesen. */
async function alsRechner(profil, fn) {
  const echt = rechner.profil;
  rechner.profil = () => profil;
  try {
    return await fn();
  } finally {
    rechner.profil = echt;
  }
}

/** Ein Temp-Stick in alter Aufteilung: Markierung in der Wurzel. */
function stickAlt(wurzel) {
  fs.mkdirSync(path.join(wurzel, 'data'), { recursive: true });
  fs.mkdirSync(path.join(wurzel, 'app'), { recursive: true });
  fs.writeFileSync(path.join(wurzel, PORTABLE_MARKER), JSON.stringify({ neuralOsPortable: true, dataDir: 'data' }));
  return { root: wurzel, dataDir: path.join(wurzel, 'data') };
}

/** Ein Temp-Stick in neuer Aufteilung: Markierung in `Inhalt/` (Bauplan 2.10, Punkt 4). */
function stickNeu(wurzel) {
  const inhalt = path.join(wurzel, 'Inhalt');
  fs.mkdirSync(path.join(inhalt, 'data'), { recursive: true });
  fs.mkdirSync(path.join(inhalt, 'app'), { recursive: true });
  fs.writeFileSync(path.join(inhalt, PORTABLE_MARKER), JSON.stringify({ neuralOsPortable: true, dataDir: 'data' }));
  return { root: inhalt, dataDir: path.join(inhalt, 'data') };
}

/* ------------------------------------------------ erfassen / aufloesen */

test('erfassen: auf dem Stick relativ zur Stick-Wurzel, sonst an Rechner und Konto gebunden', () => {
  const { erfassen } = ortspfad();
  const portable = { root: '/x' };
  assert.deepEqual(erfassen('/x/Schule/Mathe', { portable }), { ort: 'stick', rel: 'Schule/Mathe' });
  assert.deepEqual(erfassen('/x', { portable }), { ort: 'stick', rel: '' });
  assert.deepEqual(
    erfassen('/home/max/Dokumente', { portable, profil: 'aaaaaaaaaaaaaaaa' }),
    { ort: 'rechner', rechner: 'aaaaaaaaaaaaaaaa', pfad: '/home/max/Dokumente' },
  );
  // Ohne Stick gibt es nur den Rechner; ein Name, der zufällig mit der
  // Wurzel beginnt, liegt nicht darin.
  assert.equal(erfassen('/x/Schule', { portable: null, profil: 'a' }).ort, 'rechner');
  assert.equal(erfassen('/xy/Schule', { portable, profil: 'a' }).ort, 'rechner');
  // Windows: der Rest wird POSIX gespeichert.
  assert.deepEqual(erfassen('E:\\Schule\\Mathe', { portable: { root: 'E:\\' }, pfad: path.win32 }), { ort: 'stick', rel: 'Schule/Mathe' });
});

test('{ort:"stick", rel:"Schule"} wird bei portable.root=/x und bei /y jeweils richtig aufgelöst', () => {
  const { aufloesen } = ortspfad();
  const eintrag = { ort: 'stick', rel: 'Schule' };
  assert.equal(aufloesen(eintrag, { portable: { root: '/x' } }), path.resolve('/x/Schule'));
  assert.equal(aufloesen(eintrag, { portable: { root: '/y' } }), path.resolve('/y/Schule'));
  // Derselbe Satz an Windows und am Mac.
  assert.equal(aufloesen(eintrag, { portable: { root: 'E:\\' }, pfad: path.win32 }), 'E:\\Schule');
  assert.equal(aufloesen({ ort: 'stick', rel: 'Schule/Mathe' }, { portable: { root: 'F:\\' }, pfad: path.win32 }), 'F:\\Schule\\Mathe');
  assert.equal(aufloesen(eintrag, { portable: { root: '/Volumes/NEURAL' }, pfad: path.posix }), '/Volumes/NEURAL/Schule');
  // Neue Aufteilung: die Markierung liegt in Inhalt/, die Wurzel eine Ebene höher.
  assert.equal(aufloesen(eintrag, { portable: { root: '/y/Inhalt' } }), path.resolve('/y/Schule'));
  assert.deepEqual(ortspfad().erfassen('/x/Schule', { portable: { root: '/x/Inhalt' } }), { ort: 'stick', rel: 'Schule' });
});

test('aufloesen: ein Ordner eines anderen Rechners oder außerhalb des Sticks ergibt null', () => {
  const { aufloesen } = ortspfad();
  const hier = { ort: 'rechner', rechner: 'aaaaaaaaaaaaaaaa', pfad: '/home/max/Dokumente' };
  assert.equal(aufloesen(hier, { profil: 'aaaaaaaaaaaaaaaa' }), '/home/max/Dokumente');
  assert.equal(aufloesen(hier, { profil: 'bbbbbbbbbbbbbbbb' }), null);
  // Ohne ausdrückliches Profil gilt das dieses Rechners.
  assert.equal(aufloesen({ ...hier, rechner: rechner.profil() }, {}), '/home/max/Dokumente');
  assert.equal(aufloesen(hier, {}), null);

  // Ein Stick-Satz ohne Stick, und Wege aus dem Stick hinaus.
  assert.equal(aufloesen({ ort: 'stick', rel: 'Schule' }, { portable: null }), null);
  assert.equal(aufloesen({ ort: 'stick', rel: '../etc' }, { portable: { root: '/x' } }), null);
  assert.equal(aufloesen({ ort: 'stick', rel: 'a\\..\\..\\Windows' }, { portable: { root: 'D:\\Sticks\\Neural' }, pfad: path.win32 }), null);
  assert.equal(aufloesen({ ort: 'woanders', pfad: '/x' }, {}), null);
  assert.equal(aufloesen(42, {}), null);
});

test('aufloesen: eine alte Zeichenkette gilt ohne Stick wie bisher, auf dem Stick nur, wenn sie auf dem Stick liegt', () => {
  const { aufloesen, aufloesenListe } = ortspfad();
  assert.equal(aufloesen('/home/max/Dokumente', { portable: null }), '/home/max/Dokumente');
  assert.equal(aufloesen('/x/Schule', { portable: { root: '/x' } }), '/x/Schule');
  assert.equal(aufloesen('/home/max/Dokumente', { portable: { root: '/x' } }), null);
  assert.equal(aufloesen('relativ/pfad', { portable: null }), null);
  assert.deepEqual(
    aufloesenListe(['/x/Schule', '/home/max', { ort: 'stick', rel: 'Schule' }, { ort: 'rechner', rechner: 'fremd', pfad: '/y' }], { portable: { root: '/x' } }),
    ['/x/Schule'],
    'was nicht hierher gehört, fällt weg, Doppeltes auch',
  );
});

test('Groß/Klein: Windows und Mac erkennen die Stick-Wurzel auch anders geschrieben', () => {
  const { erfassen } = ortspfad();
  assert.deepEqual(erfassen('e:\\schule', { portable: { root: 'E:\\' }, pfad: path.win32 }), { ort: 'stick', rel: 'schule' });
  assert.deepEqual(
    erfassen('/volumes/neural/Schule', { portable: { root: '/Volumes/NEURAL' }, pfad: path.posix, plattform: 'darwin' }),
    { ort: 'stick', rel: 'Schule' },
  );
  assert.equal(
    erfassen('/volumes/neural/Schule', { portable: { root: '/Volumes/NEURAL' }, pfad: path.posix, plattform: 'linux', profil: 'a' }).ort,
    'rechner',
  );
});

test('kiBereich: Stick-Wurzel, Programm, Daten und Datenordner ja, eigene Ordner auf dem Stick nein', () => {
  const { kiBereich } = ortspfad();
  const { home, cleanup } = tempHome('nos-ortspfad-ki');
  try {
    const alt = path.join(home, 'alt');
    stickAlt(alt);
    fs.mkdirSync(path.join(alt, 'Schule'));
    assert.equal(kiBereich(alt), true, 'Wurzel eines alten Sticks');
    assert.equal(kiBereich(path.join(alt, 'data')), true, 'Daten');
    assert.equal(kiBereich(path.join(alt, 'app')), true, 'Programm');
    assert.equal(kiBereich(path.join(alt, 'Schule')), false, 'ein eigener Ordner auf dem Stick');

    const neu = path.join(home, 'neu');
    stickNeu(neu);
    fs.mkdirSync(path.join(neu, 'Schule'));
    assert.equal(kiBereich(neu), true, 'Wurzel eines neuen Sticks');
    assert.equal(kiBereich(path.join(neu, 'Inhalt')), true);
    assert.equal(kiBereich(path.join(neu, 'Inhalt', 'app')), true);
    assert.equal(kiBereich(path.join(neu, 'Schule')), false);

    const heim = ensureLayout(layout(path.join(home, 'heim'))).home;
    assert.equal(kiBereich(heim), true, 'ein Datenordner');
    assert.equal(kiBereich(path.join(heim, 'exports')), true, 'in einem Datenordner');

    const frei = path.join(home, 'frei');
    fs.mkdirSync(frei);
    assert.equal(kiBereich(frei), false);
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------ Agenten und Module */

test('Agenten: fileRoots gehen durch dieselbe Auflösung, was null ergibt, fällt weg', async () => {
  const config = configMod.defaults();
  const portable = { root: '/x' };
  const agent = {
    id: 'agent_oooooooooooooooooooooo',
    type: 'agent',
    data: {
      name: 'O',
      permissions: {
        readFiles: true,
        fileRoots: [
          '/x/Schule',
          '/home/max/Dokumente',
          { ort: 'stick', rel: 'Schule' },
          { ort: 'stick', rel: 'Musik' },
          { ort: 'rechner', rechner: 'aaaaaaaaaaaaaaaa', pfad: '/home/max/Bilder' },
          { ort: 'rechner', rechner: 'bbbbbbbbbbbbbbbb', pfad: '/home/lena/Bilder' },
        ],
      },
    },
  };
  await alsRechner('aaaaaaaaaaaaaaaa', () => {
    const eff = permissions.effective(agent, config, { portable });
    assert.deepEqual(eff.fileRoots, [path.resolve('/x/Schule'), path.resolve('/x/Musik'), '/home/max/Bilder']);
    const text = permissions.describe(agent, config, { portable });
    assert.ok(!text.includes('/home/lena'), text);
    assert.ok(!text.includes('/home/max/Dokumente'), text);

    // Ohne Stick (Heim-Installation) bleibt die alte Zeichenkette gültig.
    const heim = permissions.effective(agent, config, { portable: null });
    assert.deepEqual(heim.fileRoots, [path.resolve('/x/Schule'), '/home/max/Dokumente', '/home/max/Bilder']);
  });
});

test('Agenten: files.read erreicht auf dem Stick keinen Ordner eines fremden Rechners', async () => {
  const { home, cleanup } = tempHome('nos-ortspfad-agent');
  const { openStore } = require('../src/store/engine');
  const { Bus } = require('../src/kernel/bus');
  const { createToolbox } = require('../src/agents/tools');
  const stick = stickAlt(path.join(home, 'stick'));
  const aufDemStick = path.join(stick.root, 'Schule');
  const platte = path.join(home, 'platte');
  fs.mkdirSync(aufDemStick);
  fs.mkdirSync(platte);
  fs.writeFileSync(path.join(aufDemStick, 'plan.txt'), 'Stundenplan');
  fs.writeFileSync(path.join(platte, 'brief.txt'), 'Privat');

  const paths = ensureLayout(layout(path.join(home, 'tresor')));
  const store = await openStore({ paths, bus: new Bus() });
  const config = configMod.defaults();
  const toolbox = createToolbox({ store, paths, config, portable: stick });
  const agentMit = (fileRoots) => store.create('agent', {
    name: 'Leser',
    systemPrompt: 'Du liest.',
    permissions: permissions.basePermissions({ readFiles: true, requireApproval: false, fileRoots }),
  });
  try {
    await alsRechner('aaaaaaaaaaaaaaaa', async () => {
      const alt = agentMit([platte]);
      await assert.rejects(
        toolbox.call('files.read', { path: path.join(platte, 'brief.txt') }, { agent: alt }),
        (err) => err.code === 'PERMISSION_DENIED',
        'eine alte Zeichenkette außerhalb des Sticks',
      );

      const hier = agentMit([{ ort: 'rechner', rechner: 'aaaaaaaaaaaaaaaa', pfad: platte }]);
      const gelesen = await toolbox.call('files.read', { path: path.join(platte, 'brief.txt') }, { agent: hier });
      assert.equal(gelesen.result.text, 'Privat', 'an diesem Rechner gewählt: erreichbar');

      const stickAgent = agentMit([{ ort: 'stick', rel: 'Schule' }]);
      const plan = await toolbox.call('files.read', { path: 'plan.txt' }, { agent: stickAgent });
      assert.equal(plan.result.text, 'Stundenplan');
    });

    await alsRechner('bbbbbbbbbbbbbbbb', async () => {
      const hier = store.list('agent', { limit: 10 }).items.find((a) => a.data.permissions.fileRoots.some((r) => r && r.ort === 'rechner'));
      await assert.rejects(
        toolbox.call('files.read', { path: path.join(platte, 'brief.txt') }, { agent: hier }),
        (err) => err.code === 'PERMISSION_DENIED',
        'an einem anderen Rechner nicht mehr',
      );
    });
  } finally {
    await store.close();
    cleanup();
  }
});

test('Module: api.files erreicht auf dem Stick keinen Ordner eines fremden Rechners', async () => {
  const { home, cleanup } = tempHome('nos-ortspfad-modul');
  const { openStore } = require('../src/store/engine');
  const { Bus } = require('../src/kernel/bus');
  const { createSandbox } = require('../src/modules/sandbox');
  const stick = stickAlt(path.join(home, 'stick'));
  const aufDemStick = path.join(stick.root, 'Schule');
  const platte = path.join(home, 'platte');
  fs.mkdirSync(aufDemStick);
  fs.mkdirSync(platte);
  fs.writeFileSync(path.join(aufDemStick, 'plan.txt'), 'Stundenplan');
  fs.writeFileSync(path.join(platte, 'brief.txt'), 'Privat');

  const paths = ensureLayout(layout(path.join(home, 'tresor')));
  const bus = new Bus();
  const store = await openStore({ paths, bus });
  const sandbox = createSandbox({ store, bus, config: configMod.defaults(), paths, portable: stick });
  const modul = (name, fileRoots) => store.create('module', {
    name,
    kind: 'server',
    source: 'module.exports = { manifest: { name: "D", kind: "server", capabilities: ["files.read"] }, setup(api) {} };',
    version: 1,
    capabilities: ['files.read'],
    enabled: false,
    fileRoots,
  });
  try {
    const fremd = await sandbox.instantiate(modul('Platte', [platte]));
    assert.throws(() => fremd.api.files.read('brief.txt'), (err) => err.code === 'PERMISSION_DENIED' && /kein Ordner freigegeben/.test(err.message));

    const aufStick = await sandbox.instantiate(modul('Stick', [aufDemStick]));
    assert.equal(aufStick.api.files.read('plan.txt'), 'Stundenplan');
  } finally {
    try { sandbox.disposeAll(); } catch { /* schon weg */ }
    await store.close();
    cleanup();
  }
});

module.exports = { name: 'ortspfad', tests: drain() };
