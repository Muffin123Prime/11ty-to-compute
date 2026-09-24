/**
 * qr.js -- ein QR-Code-Kodierer ohne Abhängigkeit.
 *
 * Wozu: "iPad verbinden" zeigt einen QR-Code mit Adresse und Einmal-Code.
 * Eine fremde Bibliothek oder ein Dienst im Netz kommt nicht in Frage (null
 * Abhängigkeiten, CSP 'self', und der Code ist ein Zugang), also steht hier
 * genau das, was dafür nötig ist -- nicht mehr:
 *
 *  - nur Byte-Modus (UTF-8), denn Links mischen Klein- und Großbuchstaben;
 *  - nur Fehlerkorrektur M (15 %): robust genug für ein Display, das die
 *    iPad-Kamera abfilmt, und kleiner als Q/H;
 *  - nur Versionen 1 bis 10 (höchstens 213 Byte). Ein Verbinden-Link hat
 *    rund 90 Byte und landet bei Version 5 oder 6.
 *
 * Die Rechnung folgt ISO/IEC 18004: Bitstrom, Reed-Solomon über GF(256) mit
 * dem Polynom 0x11D, Blöcke verschränken, Funktionsmuster, Zickzack-Platzierung,
 * die acht Masken mit den vier Strafpunkt-Regeln, Formatbits (BCH 0x537,
 * Maske 0x5412) und ab Version 7 Versionsbits (BCH 0x1F25). Geprüft wird das
 * in test/qr.test.js gegen das Rechenbeispiel der Norm (Reed-Solomon), gegen
 * die Tabellen der Norm (Format, Version, Kapazität) und gegen vollständige
 * Symbole einer unabhängigen Implementierung (segno), Modul für Modul.
 *
 * Läuft im Browser und in Node (TextEncoder gibt es in beiden).
 */

/** Fehlerkorrektur-Codewörter je Block und Anzahl Blöcke bei Stufe M, Index = Version. */
const ECC_JE_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKE_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** Formatbits der Stufe M sind 00 (L=01, M=00, Q=11, H=10). */
const STUFE_M = 0;
const MAX_VERSION = 10;

/* ------------------------------------------------------------ GF(256) */

function gfMal(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** Generatorpolynom vom Grad `grad` (höchster Koeffizient weggelassen). */
function rsDivisor(grad) {
  const out = new Array(grad).fill(0);
  out[grad - 1] = 1;
  let wurzel = 1;
  for (let i = 0; i < grad; i++) {
    for (let j = 0; j < out.length; j++) {
      out[j] = gfMal(out[j], wurzel);
      if (j + 1 < out.length) out[j] ^= out[j + 1];
    }
    wurzel = gfMal(wurzel, 0x02);
  }
  return out;
}

/** Die Fehlerkorrektur-Codewörter zu `daten`. */
function rsRest(daten, divisor) {
  const out = divisor.map(() => 0);
  for (const b of daten) {
    const faktor = b ^ out.shift();
    out.push(0);
    for (let i = 0; i < divisor.length; i++) out[i] ^= gfMal(divisor[i], faktor);
  }
  return out;
}

/* ------------------------------------------------------- Kapazitäten */

/** Module, die nach allen Funktionsmustern für Daten übrig sind. */
function rohModule(version) {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const ausrichtung = Math.floor(version / 7) + 2;
    n -= (25 * ausrichtung - 10) * ausrichtung - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

function datenCodewoerter(version) {
  return Math.floor(rohModule(version) / 8) - ECC_JE_BLOCK_M[version] * BLOCKE_M[version];
}

/** Wie viele Byte im Byte-Modus bei Stufe M in eine Version passen. */
function byteKapazitaet(version) {
  const bits = datenCodewoerter(version) * 8 - 4 - (version < 10 ? 8 : 16);
  return Math.floor(bits / 8);
}

/* ------------------------------------------------------- BCH-Codes */

function formatBits(maske) {
  const daten = (STUFE_M << 3) | maske;
  let rest = daten;
  for (let i = 0; i < 10; i++) rest = (rest << 1) ^ ((rest >>> 9) * 0x537);
  return ((daten << 10) | rest) ^ 0x5412;
}

function versionBits(version) {
  let rest = version;
  for (let i = 0; i < 12; i++) rest = (rest << 1) ^ ((rest >>> 11) * 0x1f25);
  return (version << 12) | rest;
}

function ausrichtungsPositionen(version) {
  if (version === 1) return [];
  const anzahl = Math.floor(version / 7) + 2;
  const groesse = version * 4 + 17;
  const schritt = Math.ceil((version * 4 + 4) / (anzahl * 2 - 2)) * 2;
  const out = [6];
  for (let pos = groesse - 7; out.length < anzahl; pos -= schritt) out.splice(1, 0, pos);
  return out;
}

/* ------------------------------------------------------- das Symbol */

const MASKEN = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function neuesRaster(groesse) {
  return {
    groesse,
    dunkel: Array.from({ length: groesse }, () => new Array(groesse).fill(false)),
    funktion: Array.from({ length: groesse }, () => new Array(groesse).fill(false)),
  };
}

/** x = Spalte, y = Zeile. */
function setze(r, x, y, dunkel, funktion = true) {
  r.dunkel[y][x] = dunkel;
  if (funktion) r.funktion[y][x] = true;
}

function zeichneFunktionsmuster(r, version) {
  const n = r.groesse;
  // Taktlinien
  for (let i = 0; i < n; i++) {
    setze(r, 6, i, i % 2 === 0);
    setze(r, i, 6, i % 2 === 0);
  }
  // Suchmuster mit Trennstreifen (der Abstand macht beides in einem)
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= n || y < 0 || y >= n) continue;
        const abstand = Math.max(Math.abs(dx), Math.abs(dy));
        setze(r, x, y, abstand !== 2 && abstand !== 4);
      }
    }
  }
  // Ausrichtungsmuster, außer dort, wo die Suchmuster sitzen
  const pos = ausrichtungsPositionen(version);
  const k = pos.length;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === k - 1) || (i === k - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setze(r, pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  // Platz für die Formatbits freihalten (Maske 0 als Platzhalter)
  zeichneFormat(r, 0);
  // Versionsbits ab Version 7
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const b = ((bits >>> i) & 1) === 1;
      const a = n - 11 + (i % 3);
      const c = Math.floor(i / 3);
      setze(r, a, c, b);
      setze(r, c, a, b);
    }
  }
}

function zeichneFormat(r, maske) {
  const n = r.groesse;
  const bits = formatBits(maske);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) setze(r, 8, i, bit(i));
  setze(r, 8, 7, bit(6));
  setze(r, 8, 8, bit(7));
  setze(r, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setze(r, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) setze(r, n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setze(r, 8, n - 15 + i, bit(i));
  setze(r, 8, n - 8, true); // das "dunkle Modul"
}

/** Die Codewörter im Zickzack von rechts unten einsetzen. */
function platziere(r, codewoerter) {
  const n = r.groesse;
  let i = 0;
  for (let rechts = n - 1; rechts >= 1; rechts -= 2) {
    if (rechts === 6) rechts = 5; // die senkrechte Taktlinie überspringen
    for (let v = 0; v < n; v++) {
      for (let j = 0; j < 2; j++) {
        const x = rechts - j;
        const aufwaerts = ((rechts + 1) & 2) === 0;
        const y = aufwaerts ? n - 1 - v : v;
        if (r.funktion[y][x]) continue;
        if (i < codewoerter.length * 8) {
          r.dunkel[y][x] = ((codewoerter[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i += 1;
        }
        // Übrige Restbits bleiben hell (0).
      }
    }
  }
}

function maskiere(r, maske) {
  const f = MASKEN[maske];
  for (let y = 0; y < r.groesse; y++) {
    for (let x = 0; x < r.groesse; x++) {
      if (!r.funktion[y][x] && f(x, y)) r.dunkel[y][x] = !r.dunkel[y][x];
    }
  }
}

/** Strafpunkte nach den vier Regeln der Norm (N1=3, N2=3, N3=40, N4=10). */
function strafpunkte(r) {
  const n = r.groesse;
  const d = r.dunkel;
  let punkte = 0;
  const linie = (get) => {
    // Regel 1: Läufe gleicher Farbe ab 5
    let lauf = 1;
    for (let i = 1; i < n; i++) {
      if (get(i) === get(i - 1)) {
        lauf += 1;
      } else {
        if (lauf >= 5) punkte += 3 + (lauf - 5);
        lauf = 1;
      }
    }
    if (lauf >= 5) punkte += 3 + (lauf - 5);
    // Regel 3: 1:1:3:1:1 mit vier hellen Modulen davor oder dahinter
    // (außerhalb des Symbols zählt als hell).
    const muster = [1, 0, 1, 1, 1, 0, 1];
    for (let i = -4; i < n; i++) {
      let passt = true;
      for (let k = 0; k < 7 && passt; k++) {
        const p = i + k;
        const v = p >= 0 && p < n && get(p) ? 1 : 0;
        if (v !== muster[k]) passt = false;
      }
      if (!passt) continue;
      const hell = (von, bis) => {
        for (let p = von; p < bis; p++) if (p >= 0 && p < n && get(p)) return false;
        return true;
      };
      if (hell(i - 4, i) || hell(i + 7, i + 11)) punkte += 40;
    }
  };
  for (let y = 0; y < n; y++) linie((x) => d[y][x]);
  for (let x = 0; x < n; x++) linie((y) => d[y][x]);
  // Regel 2: 2x2-Blöcke
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const c = d[y][x];
      if (c === d[y][x + 1] && c === d[y + 1][x] && c === d[y + 1][x + 1]) punkte += 3;
    }
  }
  // Regel 4: Anteil dunkler Module
  let dunkle = 0;
  for (const zeile of d) for (const c of zeile) if (c) dunkle += 1;
  const gesamt = n * n;
  const k = Math.ceil(Math.abs(dunkle * 20 - gesamt * 10) / gesamt) - 1;
  punkte += Math.max(0, k) * 10;
  return punkte;
}

function datenMitFehlerkorrektur(daten, version) {
  const bloecke = BLOCKE_M[version];
  const eccLaenge = ECC_JE_BLOCK_M[version];
  const roh = Math.floor(rohModule(version) / 8);
  const kurze = bloecke - (roh % bloecke);
  const kurzLaenge = Math.floor(roh / bloecke);
  const divisor = rsDivisor(eccLaenge);
  const liste = [];
  for (let i = 0, k = 0; i < bloecke; i++) {
    const dat = daten.slice(k, k + kurzLaenge - eccLaenge + (i < kurze ? 0 : 1));
    k += dat.length;
    const ecc = rsRest(dat, divisor);
    if (i < kurze) dat.push(0); // Platzhalter, wird beim Verschränken übersprungen
    liste.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < liste[0].length; i++) {
    for (let j = 0; j < liste.length; j++) {
      if (i !== kurzLaenge - eccLaenge || j >= kurze) out.push(liste[j][i]);
    }
  }
  return out;
}

/**
 * Einen Text als QR-Code kodieren.
 * @param {string} text
 * @param {{maske?:number, version?:number}} [opts] feste Maske/Version (Tests)
 * @returns {{version:number, groesse:number, maske:number, stufe:'M', module:boolean[][]}}
 */
export function kodiere(text, opts = {}) {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  let version = 0;
  const von = Number.isInteger(opts.version) ? opts.version : 1;
  for (let v = von; v <= MAX_VERSION; v++) {
    if (bytes.length <= byteKapazitaet(v)) {
      version = v;
      break;
    }
    if (Number.isInteger(opts.version)) break;
  }
  if (!version) {
    throw new RangeError(`Der Text ist für einen QR-Code bis Version ${MAX_VERSION} zu lang (${bytes.length} Byte, höchstens ${byteKapazitaet(MAX_VERSION)}).`);
  }

  // Bitstrom: Modus 0100 (Byte), Länge, Daten, Abschluss, Füllbytes.
  const bits = [];
  const haenge = (wert, laenge) => {
    for (let i = laenge - 1; i >= 0; i--) bits.push((wert >>> i) & 1);
  };
  haenge(0x4, 4);
  haenge(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) haenge(b, 8);
  const kapazitaet = datenCodewoerter(version) * 8;
  haenge(0, Math.min(4, kapazitaet - bits.length));
  haenge(0, (8 - (bits.length % 8)) % 8);
  for (let fuell = 0xec; bits.length < kapazitaet; fuell ^= 0xec ^ 0x11) haenge(fuell, 8);
  const daten = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    daten.push(b);
  }

  const codewoerter = datenMitFehlerkorrektur(daten, version);
  const groesse = version * 4 + 17;
  const basis = neuesRaster(groesse);
  zeichneFunktionsmuster(basis, version);
  platziere(basis, codewoerter);

  const kandidaten = Number.isInteger(opts.maske) ? [opts.maske] : [0, 1, 2, 3, 4, 5, 6, 7];
  let bestes = null;
  for (const maske of kandidaten) {
    const r = {
      groesse,
      dunkel: basis.dunkel.map((z) => z.slice()),
      funktion: basis.funktion,
    };
    maskiere(r, maske);
    zeichneFormat(r, maske);
    const p = kandidaten.length === 1 ? 0 : strafpunkte(r);
    if (!bestes || p < bestes.punkte) bestes = { punkte: p, maske, r };
  }
  return { version, groesse, maske: bestes.maske, stufe: 'M', module: bestes.r.dunkel };
}

/**
 * Ein SVG-Pfad (Attribut `d`) für die dunklen Module, mit Ruhezone `rand`.
 * Enthält nur Zahlen, nie den Text: die Ansicht setzt ihn per setAttribute.
 * @returns {{d:string, breite:number}}
 */
export function svgPfad(qr, rand = 4) {
  const teile = [];
  for (let y = 0; y < qr.groesse; y++) {
    for (let x = 0; x < qr.groesse; x++) {
      if (qr.module[y][x]) teile.push(`M${x + rand} ${y + rand}h1v1h-1z`);
    }
  }
  return { d: teile.join(''), breite: qr.groesse + rand * 2 };
}

/** Nur für die Tests. */
export const __intern = { rsDivisor, rsRest, formatBits, versionBits, byteKapazitaet, ausrichtungsPositionen, strafpunkte };
