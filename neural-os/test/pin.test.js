'use strict';

/**
 * PIN und "Dieses Gerät merken" in src/store/vaultcrypto.js.
 *
 * Jeder Test legt ein eigenes Temp-Home UND einen eigenen Ordner für gemerkte
 * Geräte an. Das echte Benutzerprofil wird nie berührt: ein Test, der dort
 * eine Datei hinterlässt, würde auf dem Rechner des Entwicklers einen Tresor
 * ohne PIN öffnen.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, tempHome } = require('./harness');

const vc = require('../src/store/vaultcrypto');
const { createVaultCrypto, istPin, geraeteOrdner } = vc;

const KI = 'dev_0123456789abcdef01234567';

function umgebung(label) {
  const heim = tempHome(`pin-${label}`);
  const profil = tempHome(`pin-profil-${label}`);
  const paths = { secrets: path.join(heim.home, 'secrets.json') };
  const config = { sync: { deviceId: KI }, security: {} };
  const neu = (opts = {}) => createVaultCrypto({ paths, config: opts.config || config, geraeteOrdner: profil.home, ...opts });
  return {
    heim, profil, paths, config, neu,
    aufraeumen() { heim.cleanup(); profil.cleanup(); },
  };
}

test('eine PIN aus 4 bis 6 Ziffern gilt, alles Kürzere oder Buchstaben nicht', () => {
  for (const gut of ['1234', '12345', '123456', '0000']) assert.equal(istPin(gut), true, gut);
  for (const schlecht of ['123', '1234567', '12a4', ' 1234', '١٢٣٤', '', null, 1234]) assert.equal(istPin(schlecht), false, String(schlecht));
});

test('PIN einrichten, falsche PIN abweisen, richtige öffnen', async () => {
  const u = umgebung('grund');
  try {
    const a = u.neu();
    await assert.rejects(() => a.initialise('hallo'), /PIN aus 4 bis 6 Ziffern/);
    await assert.rejects(() => a.initialise('123'), /PIN aus 4 bis 6 Ziffern/);
    await a.initialise('4711');
    assert.equal(a.state, 'unlocked');
    assert.equal(a.entsperrtDurch, 'pin');
    assert.equal(a.art(), 'pin');
    assert.equal(a.info().art, 'pin');
    assert.equal(a.info().gemerkteGeraete, 0);

    const b = u.neu();
    assert.equal(b.state, 'locked', 'ohne gemerktes Gerät bleibt der Tresor zu');
    await assert.rejects(() => b.unlock('4712'), (err) => err.code === 'VAULT_LOCKED');
    await b.unlock('4711');
    assert.equal(b.entsperrtDurch, 'pin');
    await assert.rejects(() => b.pruefen('0000'), (err) => err.code === 'VAULT_LOCKED');
    assert.equal(await b.pruefen('4711'), true);
  } finally {
    u.aufraeumen();
  }
});

test('Dieses Gerät merken: der nächste Start braucht keine PIN, der Stick allein schon', async () => {
  const u = umgebung('merken');
  try {
    const a = u.neu();
    await a.initialise('123456');
    const { id, datei } = a.merken({ kiId: KI, name: 'Laptop von Max' });
    assert.match(id, /^g_/);
    assert.ok(datei.startsWith(u.profil.home), 'der Schlüssel liegt im Profil, nicht auf dem Stick');
    assert.ok(!datei.startsWith(u.heim.home));
    assert.equal(a.geraetGemerkt(KI), true);

    // Auf dem Stick steht nur der verpackte Datenschlüssel, nie der Name im Klartext.
    const roh = fs.readFileSync(u.paths.secrets, 'utf8');
    assert.equal(roh.includes('Laptop von Max'), false, 'der Gerätename muss versiegelt sein');
    assert.equal(JSON.parse(roh).geraete.length, 1);

    const b = u.neu();
    assert.equal(b.state, 'unlocked', 'am gemerkten Rechner öffnet sich der Tresor selbst');
    assert.equal(b.entsperrtDurch, 'geraet');
    const liste = b.geraete({ kiId: KI });
    assert.equal(liste.length, 1);
    assert.equal(liste[0].name, 'Laptop von Max');
    assert.equal(liste[0].diesesGeraet, true);

    // Ein anderer Rechner = ein anderes Profil: dort fragt die PIN.
    const fremd = tempHome('pin-fremdes-profil');
    try {
      const c = createVaultCrypto({ paths: u.paths, config: u.config, geraeteOrdner: fremd.home });
      assert.equal(c.state, 'locked');
    } finally {
      fremd.cleanup();
    }

    // Abschaltbar für Werkzeuge, die bewusst die PIN verlangen.
    assert.equal(u.neu({ geraet: false }).state, 'locked');

    // Die PIN ändern lässt das gemerkte Gerät gelten (es verpackt den Datenschlüssel, nicht die PIN).
    await b.changePassphrase('123456', '654321');
    assert.equal(b.entsperrtDurch, 'geraet');
    assert.equal(u.neu().state, 'unlocked');
    await assert.rejects(() => u.neu({ geraet: false }).unlock('123456'), (err) => err.code === 'VAULT_LOCKED');
  } finally {
    u.aufraeumen();
  }
});

test('Vergessen: einzeln und alle; danach öffnet die Datei im Profil nichts mehr', async () => {
  const u = umgebung('vergessen');
  try {
    const a = u.neu();
    await a.initialise('2468');
    a.merken({ kiId: KI, name: 'eins' });
    // Ein zweiter Rechner (anderes Profil) wird ebenfalls gemerkt.
    const zweit = tempHome('pin-zweit');
    try {
      const b = createVaultCrypto({ paths: u.paths, config: u.config, geraeteOrdner: zweit.home });
      await b.unlock('2468');
      b.merken({ kiId: KI, name: 'zwei' });
      assert.equal(createVaultCrypto({ paths: u.paths, config: u.config, geraeteOrdner: zweit.home }).state, 'unlocked');

      // Diesen (ersten) vergessen: der zweite bleibt.
      assert.deepEqual(u.neu().vergessen({ kiId: KI }), { entfernt: true });
      assert.equal(u.neu().state, 'locked');
      assert.equal(createVaultCrypto({ paths: u.paths, config: u.config, geraeteOrdner: zweit.home }).state, 'unlocked');

      // Alle vergessen -- vom ersten Rechner aus, der zweite ist "nicht da".
      const c = u.neu();
      await c.unlock('2468');
      assert.equal(c.alleVergessen({ kiId: KI }).entfernt, 1);
      assert.equal(fs.existsSync(path.join(zweit.home, `${KI}.json`)), true, 'die Datei des abwesenden Rechners liegt noch da ...');
      assert.equal(createVaultCrypto({ paths: u.paths, config: u.config, geraeteOrdner: zweit.home }).state, 'locked', '... öffnet aber nichts mehr');
    } finally {
      zweit.cleanup();
    }
  } finally {
    u.aufraeumen();
  }
});

test('eine kaputte oder fremde Gerätedatei heißt nur: PIN fragen', async () => {
  const u = umgebung('kaputt');
  try {
    const a = u.neu();
    await a.initialise('13579');
    a.merken({ kiId: KI });
    const datei = path.join(u.profil.home, `${KI}.json`);
    const gut = JSON.parse(fs.readFileSync(datei, 'utf8'));

    fs.writeFileSync(datei, '{kaputt');
    assert.equal(u.neu().state, 'locked');

    fs.writeFileSync(datei, JSON.stringify({ ...gut, schluessel: Buffer.alloc(32, 7).toString('base64') }));
    assert.equal(u.neu().state, 'locked', 'ein falscher Geräteschlüssel darf nicht öffnen und nicht abstürzen');

    // Eine andere KI (anderer Stick) findet die Datei gar nicht erst.
    const andere = createVaultCrypto({ paths: u.paths, config: { sync: { deviceId: 'dev_ffffffffffffffffffffffff' } }, geraeteOrdner: u.profil.home });
    assert.equal(andere.state, 'locked');

    // Das Entsperren mit der PIN funktioniert trotz beschädigter Liste.
    const s = JSON.parse(fs.readFileSync(u.paths.secrets, 'utf8'));
    s.geraete = [{ id: 5 }, 'quatsch'];
    fs.writeFileSync(u.paths.secrets, JSON.stringify(s));
    const b = u.neu();
    await b.unlock('13579');
    assert.equal(b.state, 'unlocked');
    assert.deepEqual(b.geraete({ kiId: KI }), []);
  } finally {
    u.aufraeumen();
  }
});

test('das Sitzungssiegel ist in jedem Prozess desselben Tresors gleich und gesperrt nicht zu haben', async () => {
  const u = umgebung('siegel');
  try {
    const a = u.neu();
    await a.initialise('8642');
    const s1 = a.sitzungsSiegel('abc');
    const b = u.neu();
    await b.unlock('8642');
    assert.deepEqual(b.sitzungsSiegel('abc'), s1, 'ein Neustart (neuer Prozess) muss dasselbe Siegel ergeben');
    assert.notDeepEqual(b.sitzungsSiegel('abd'), s1);
    b.lock();
    assert.throws(() => b.sitzungsSiegel('abc'), (err) => err.code === 'VAULT_LOCKED');
    assert.equal(b.entsperrtDurch, null);
  } finally {
    u.aufraeumen();
  }
});

test('der Ort für gemerkte Geräte liegt im Benutzerprofil des jeweiligen Systems', () => {
  const win = geraeteOrdner({ LOCALAPPDATA: 'C:\\Users\\max\\AppData\\Local', APPDATA: 'C:\\Users\\max\\AppData\\Roaming' }, 'win32');
  assert.ok(win.includes('AppData') && win.includes('Local') && win.includes('NeuralOS'), win);
  assert.ok(!win.includes('Roaming'), 'nicht im Roaming-Profil: "dieses Gerät" heißt dieser Rechner');
  const mac = geraeteOrdner({}, 'darwin');
  assert.ok(mac.includes(path.join('Library', 'Application Support', 'NeuralOS')), mac);
  const linux = geraeteOrdner({}, 'linux');
  assert.ok(linux.includes(path.join('.config', 'neural-os')), linux);
  assert.equal(geraeteOrdner({ NEURAL_OS_GERAETE: '/tmp/x' }, 'linux'), path.resolve('/tmp/x'));
});

test('die Instanz ist über ihre Konfiguration auffindbar (auth.js braucht sie)', () => {
  const u = umgebung('instanz');
  try {
    const a = u.neu();
    assert.equal(vc.instanzFuer(u.config), a);
    assert.equal(vc.instanzFuer({}), null);
    assert.equal(vc.instanzFuer(null), null);
  } finally {
    u.aufraeumen();
  }
});
