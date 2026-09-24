'use strict';

/**
 * Tests für web/lib/qr.js -- gegen Werte, die NICHT aus diesem Kodierer stammen:
 *
 *  1. Reed-Solomon: das Rechenbeispiel aus ISO/IEC 18004, Anhang I
 *     ("01234567", Version 1-M): 16 Datencodewörter -> 10 Fehlerkorrekturwörter.
 *  2. Formatbits der Stufe M für die Masken 0-7 und Versionsbits 7-10:
 *     die Tabellen der Norm (Anhang C und D).
 *  3. Byte-Kapazität bei M für die Versionen 1-10: Tabelle 7 der Norm.
 *  4. Vollständige Symbole: erzeugt mit segno 1.6.6 (unabhängige
 *     Python-Implementierung), Versionen 1-10 x Masken 0-7, jeweils bis zur
 *     letzten Stelle gefüllter ASCII-Text. Verglichen wird Modul für Modul
 *     (hier als SHA-256 der Zeilen, Version 1 zusätzlich im Klartext).
 *     Warum "voll gefüllt": segno hängt hinter dem Abschlussmuster ein
 *     zusätzliches Null-Byte an, wenn es genau auf eine Bytegrenze fällt; die
 *     Norm verlangt dort direkt die Füllbytes 0xEC/0x11 (so macht es dieser
 *     Kodierer). Bei voller Kapazität gibt es keine Füllbytes, und beide
 *     Symbole müssen identisch sein. Sie sind es: 80 von 80.
 *  Zusätzlich (einmalig, nicht Teil dieses Laufs, weil es eine Bibliothek
 *  bräuchte): 81 Symbole dieses Kodierers, als Bild gerastert, wurden von
 *  zxing-cpp 3.1.1 fehlerfrei zurückgelesen, darunter Umlaute und der
 *  Verbinden-Link.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, tempHome } = require('./harness');

let modul = null;
async function laden() {
  if (modul) return modul;
  const { home, cleanup } = tempHome('nos-qr');
  try {
    const ziel = path.join(home, 'qr.mjs');
    fs.copyFileSync(path.join(__dirname, '..', 'web', 'lib', 'qr.js'), ziel);
    modul = await import(pathToFileURL(ziel).href);
    return modul;
  } finally {
    cleanup();
  }
}

const TEXT = 'Neural OS auf dem Stick, '.repeat(30);
const KAPAZITAET_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

/** segno 1.6.6: sha256(Zeilen aus 0/1, mit \n verbunden).slice(0, 16), Version -> [Maske 0..7]. */
const SEGNO = {
  1: ['868f788483921d8b', '628438309aa910c1', 'e09a505fa5a8ca31', 'e6f69b3334eab7dd', 'd62e0102616bb74f', 'ce367e82a930fdb0', '103bc57e144217ff', '8b266ca4a59fa692'],
  2: ['1bbb5b5ce5cd465d', 'cf3d7ee4fae43dd7', 'b5506a859c3ff276', '5d4c4afb93de12ef', 'ffbf2c15a6f0a16b', '58193b0d1e5cad23', '4410310459f190d4', '047fa0634a153402'],
  3: ['fae1eca460f36ccf', 'cbaf7b4631401afb', 'f159eb7b566d0bdd', '9a55938a39b9dbaf', 'a10759eb86f41a1f', 'ddff2974f216d73b', '2660de1494ac3925', '2e315b262232dc94'],
  4: ['2eda995ec1890e50', 'f759b812fe84f4ae', '3eb6780d7de56ee5', 'f5b05c24ea964731', '58e3a3a2356ff7ab', '15861c05c6164e32', '22f1e9726c57e3ba', 'c5e6a61313fd0d68'],
  5: ['18857aba69aaebc9', '2b67dc2c6bf99dcb', '56514c7a44ffd9bc', 'b7473a5a35fa43ac', 'f1889edb3a449a34', '8e9ad4f618f99798', '5a730cf2e55898c8', 'dd8fee16e4e5377e'],
  6: ['97dab1a01344c6d4', '4a25e3ab1976c130', '1e88db02e74c30c5', 'a05d5f9c0f0d8f38', '265688d3bd5616e0', '3a90142eb9257926', '733d3b1b07045b79', 'ad3ece8d3b844111'],
  7: ['2ccd64ddb1047cf8', '3bc5bb9a2f77deeb', 'd1d96711a8120391', '0d8d6d4a45dc5f37', 'a2239291928be053', '65ed386aeee6578c', '07532c1538d9c038', 'eafaabe28d299a9a'],
  8: ['ce2429ead67b7e3f', '0595ee39475e6f54', 'bcfb41ec63462730', '985672b27de6eb88', '6a2d3178bc60e424', '99461d67f063aab2', '30f0ac4648de41c2', 'c26f52faf4b04142'],
  9: ['ac2109d4f2fe4ac2', '5113f979930dbd66', 'bc9460f94b3a0ab7', '86504ed32c91d7a6', '5d3ae94b60f5bfb3', 'aa44789c0e4a2f79', 'b14cc31789da5670', 'f103215ff4e0fed1'],
  10: ['b586d3661e7a4f13', '2ec7453d8056f9e1', '515e8e9ff7eaa730', '74840c52b97302c7', '1d2626e410cbfe34', '314ab5d8ebd9a382', 'b2fa73c62e9075f9', '79ac9cc52cedd740'],
};

/** Dasselbe Symbol (Version 1, Maske 0) im Klartext, von segno. */
const SEGNO_V1_M0 = [
  '#######.......#######',
  '#.....#.#.###.#.....#',
  '#.###.#..#....#.###.#',
  '#.###.#..#.#..#.###.#',
  '#.###.#.###.#.#.###.#',
  '#.....#...##..#.....#',
  '#######.#.#.#.#######',
  '.........###.........',
  '#.#.#.#..##.#...#..#.',
  '#.#....#...##.##...##',
  '##.#..#..##.##.######',
  '#.##...#.#.##..#...##',
  '.#.#..####.####.##.#.',
  '........######.##..#.',
  '#######..#.###..#####',
  '#.....#...#..#.#...##',
  '#.###.#.##.##..#.#.#.',
  '#.###.#..##.##.###.#.',
  '#.###.#.##.##.###...#',
  '#.....#............#.',
  '#######.#.#.#...#..##',
];

function zeilen(qr) {
  return qr.module.map((z) => z.map((c) => (c ? '1' : '0')).join('')).join('\n');
}

test('Reed-Solomon: das Rechenbeispiel der Norm (Anhang I, 1-M)', async () => {
  const { __intern } = await laden();
  const daten = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
  const ecc = __intern.rsRest(daten, __intern.rsDivisor(10));
  assert.deepEqual(ecc, [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
});

test('Format- und Versionsbits wie in den Tabellen der Norm', async () => {
  const { __intern } = await laden();
  const format = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
  for (let m = 0; m < 8; m++) assert.equal(__intern.formatBits(m), format[m], `Maske ${m}`);
  assert.deepEqual([7, 8, 9, 10].map(__intern.versionBits), [0x07c94, 0x085bc, 0x09a99, 0x0a4d3]);
  assert.deepEqual([2, 6, 7, 10].map(__intern.ausrichtungsPositionen), [[6, 18], [6, 34], [6, 22, 38], [6, 28, 50]]);
});

test('Byte-Kapazität bei Stufe M wie Tabelle 7 der Norm', async () => {
  const { __intern } = await laden();
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(__intern.byteKapazitaet), KAPAZITAET_M);
});

test('vollständige Symbole: Versionen 1-10 x Masken 0-7 Modul für Modul wie segno', async () => {
  const { kodiere } = await laden();
  const abweichend = [];
  for (let v = 1; v <= 10; v++) {
    const text = TEXT.slice(0, KAPAZITAET_M[v - 1]);
    for (let m = 0; m < 8; m++) {
      const qr = kodiere(text, { maske: m });
      assert.equal(qr.version, v, `"${text.length} Byte" muss genau in Version ${v} passen`);
      assert.equal(qr.groesse, 17 + 4 * v);
      const h = crypto.createHash('sha256').update(zeilen(qr)).digest('hex').slice(0, 16);
      if (h !== SEGNO[v][m]) abweichend.push(`${v}-M Maske ${m}`);
    }
  }
  assert.deepEqual(abweichend, []);
  const v1 = kodiere(TEXT.slice(0, 14), { maske: 0 });
  assert.deepEqual(v1.module.map((z) => z.map((c) => (c ? '#' : '.')).join('')), SEGNO_V1_M0);
});

test('der Verbinden-Link passt, die Maske wird gewählt, zu lang wird ehrlich abgewiesen', async () => {
  const { kodiere, svgPfad } = await laden();
  const link = `http://192.168.178.23:24567/api/verbinden?c=${'A'.repeat(43)}`;
  const qr = kodiere(link);
  assert.ok(qr.version >= 5 && qr.version <= 6, `Version ${qr.version}`);
  assert.equal(qr.stufe, 'M');
  assert.ok(qr.maske >= 0 && qr.maske <= 7);
  // Umlaute gehen als UTF-8 hinein und verlängern entsprechend.
  assert.equal(kodiere('ä'.repeat(7)).version, 1);
  assert.equal(kodiere('ä'.repeat(8)).version, 2);
  assert.throws(() => kodiere('x'.repeat(214)), /zu lang/);

  const { d, breite } = svgPfad(qr, 4);
  assert.equal(breite, qr.groesse + 8);
  assert.match(d, /^(M\d+ \d+h1v1h-1z)+$/, 'der Pfad enthält nur Zahlen, nie den Text');
  const dunkle = qr.module.flat().filter(Boolean).length;
  assert.equal(d.split('M').length - 1, dunkle);
});
