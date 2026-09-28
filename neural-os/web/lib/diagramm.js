/**
 * diagramm.js -- Zahlen als Bild, mit den Zahlen dahinter. Ohne Bibliothek.
 *
 * Der Baustein `diagramm` (docs/ANTWORT-BAUSTEINE.md, Abschnitt 2): Die KI
 * schreibt nur Daten, die Form entsteht hier --
 *
 *     ```ui
 *     {"typ":"diagramm","art":"linie","titel":"Umsatz","einheit":"€",
 *      "x":["2026-01","2026-02","2026-03"],"reihen":[{"name":"2026","werte":[1200,1350,1610]}]}
 *     ```
 *
 * Arten: balken (waagrecht), saeulen, linie, flaeche, kreis, ring, vergleich
 * (gruppierte Saeulen) und fortschritt. Warum jede so aussieht, wie sie
 * aussieht, steht in der dataviz-Anleitung, nach der das gebaut ist:
 *
 * - **Farben** haben eine Aufgabe. Eine Reihe ist immer der Akzent der App.
 *   Mehrere Reihen bekommen Farben in fester Reihenfolge (nie nach Rang: eine
 *   ausgeblendete Reihe faerbt die anderen nicht um). Die Reihenfolge ist mit
 *   dem Farbpruefer der Anleitung gegen die Flaeche der Karte geprueft,
 *   dunkel (#101112) und hell (#ffffff): Abstand fuer Farbfehlsichtige und
 *   normal Sehende besteht; drei helle Farben liegen im hellen Modus unter
 *   3:1 -- dafuer gibt es immer [Als Tabelle], Beschriftungen und die Legende.
 * - **Striche** sind duenn: Balken hoechstens 24 px, am Datenende 4 px rund,
 *   an der Grundlinie gerade; Linien 2 px; Punkte 8 px mit 2 px Ring in der
 *   Flaechenfarbe; 2 px Luft zwischen Stuecken; Gitter als Haarlinie.
 * - **Beschriftung** sparsam: Balken tragen ihren Wert an der Spitze (dann
 *   braucht es keine Achse), Linien am Ende, Kreise in der Legende. Text hat
 *   nie die Reihenfarbe -- die Farbe steht als Marke daneben.
 * - **Bedienung**: Ueberfahren UND Antippen zeigen die Werte an dieser Stelle
 *   (bei Linien alle Reihen auf einmal), Pfeiltasten tun dasselbe. Die Legende
 *   blendet Reihen aus und ein. [Als Tabelle] zeigt die Zahlen selbst,
 *   sortierbar. Fuer Screenreader: role=img mit Zusammenfassung und eine
 *   versteckte Datentabelle. Ein Wert ist nie nur ueber Farbe oder Maus da.
 * - **Breite**: Das Diagramm misst sich (ResizeObserver) und legt sich neu an
 *   -- auf 390 px stehen Balkennamen ueber dem Balken statt daneben, der
 *   Kreis steht ueber seiner Legende, Achsen zeigen weniger Schritte.
 *
 * Zustand (ausgeblendete Reihen, Tabelle an, Breite) liegt in `b.ansicht`
 * (web/lib/bausteine/zustand.js), nicht im DOM: der Chat baut eine Nachricht
 * beim Streaming in jedem Bild neu, und ein Diagramm darf dabei weder seine
 * Legende vergessen noch jedes Mal neu einblenden.
 *
 * Nichts hier fasst beim Laden `document` an (test/diagramm.test.js laedt
 * das Modul in Node und prueft die reinen Funktionen).
 */

import { h, text, icon } from './dom.js';
import { CSS as BS_CSS, ensureStyle, fehler, BausteinFehler, str, objekt, knopf, inline, LAENGE } from './bausteine/gemeinsam.js';
import { zahlLesen, datumLesen, tabelleVerbessern } from './tabelle.js';

const STYLE_ID = 'nos-diagramm';
/* Dieselbe id wie in web/lib/bausteine/index.js: das gemeinsame Aussehen der
   Bausteine kommt so genau einmal ins Dokument, auch wenn das Diagramm allein
   gezeichnet wird. */
const BS_STYLE_ID = 'nos-bausteine';

export const ARTEN = ['balken', 'saeulen', 'linie', 'flaeche', 'kreis', 'ring', 'vergleich', 'fortschritt'];

/* Was Modelle statt der deutschen Namen gern schreiben. */
const ALIAS = {
  bar: 'balken', bars: 'balken', horizontal: 'balken', 'säulen': 'saeulen', saeule: 'saeulen', 'säule': 'saeulen',
  column: 'saeulen', columns: 'saeulen', line: 'linie', linien: 'linie', 'fläche': 'flaeche', area: 'flaeche',
  pie: 'kreis', donut: 'ring', doughnut: 'ring', grouped: 'vergleich', gruppiert: 'vergleich', progress: 'fortschritt',
};

export const ART_NAMEN = {
  balken: 'Balkendiagramm', saeulen: 'Säulendiagramm', linie: 'Liniendiagramm', flaeche: 'Flächendiagramm',
  kreis: 'Kreisdiagramm', ring: 'Ringdiagramm', vergleich: 'Säulenvergleich', fortschritt: 'Fortschritt',
};

/** Mehr Reihen sind als Farben nicht mehr zu unterscheiden (dataviz: 5–6 ist die weiche Grenze). */
export const MAX_REIHEN = 6;
/** So viele Stuecke zeigt ein Kreis; der Rest wird zu "Andere". */
export const MAX_STUECKE = 6;
const MAX_KATEGORIEN = 60;
const MAX_PUNKTE = 500;
const MAX_TEILE = 40;
const GRENZE = 1e15;

/** Wie lange das Einblenden dauert (ms). */
const EIN_MS = 620;
/** Schriftgroesse der Achsen (--fs-xs). */
const SCHRIFT = 11.5;

/* ------------------------------------------------------------------ */
/* Pruefen                                                              */
/* ------------------------------------------------------------------ */

function zahlOderNull(v) {
  if (v === null || v === undefined) return null;
  const n = zahlLesen(v);
  return n !== null && Math.abs(n) <= GRENZE ? n : null;
}

function teileLesen(roh, { negativErlaubt }) {
  if (!Array.isArray(roh)) throw fehler('„teile“ muss eine Liste sein.');
  const out = [];
  for (const t of roh.slice(0, MAX_TEILE)) {
    const o = objekt(t);
    if (!o) continue;
    const wert = zahlOderNull(o.wert);
    const name = str(o.name, 60);
    if (wert === null || !name) continue;
    if (wert < 0 && !negativErlaubt) throw fehler('Ein Kreis kann keine negativen Werte zeigen – dafür passen Säulen.');
    const teil = { name, wert };
    const ziel = zahlOderNull(o.ziel);
    if (ziel !== null && ziel > 0) teil.ziel = ziel;
    out.push(teil);
  }
  return out;
}

function reihenLesen(roh, art) {
  let x = Array.isArray(roh.x) ? roh.x.slice(0, MAX_PUNKTE).map((v) => str(v, 60)) : [];
  let reihen = [];
  if (Array.isArray(roh.reihen)) {
    if (roh.reihen.length > MAX_REIHEN) throw fehler(`Höchstens ${MAX_REIHEN} Reihen – mehr ist als Diagramm nicht lesbar.`);
    reihen = roh.reihen.map((r, i) => {
      const o = objekt(r);
      const werte = o ? o.werte : (Array.isArray(r) ? r : null);
      if (!Array.isArray(werte)) throw fehler(`reihen[${i}] braucht „werte“ (eine Liste von Zahlen).`);
      return { name: (o && str(o.name, 60)) || `Reihe ${i + 1}`, werte: werte.slice(0, MAX_PUNKTE).map(zahlOderNull) };
    });
  } else if (roh.reihen !== undefined && roh.reihen !== null) {
    throw fehler('„reihen“ muss eine Liste sein.');
  }
  // Nachsichtig bei einer Reihe: "werte" direkt oder "teile" wie beim Kreis.
  if (!reihen.length && Array.isArray(roh.werte)) {
    reihen = [{ name: str(roh.titel, 60) || 'Wert', werte: roh.werte.slice(0, MAX_PUNKTE).map(zahlOderNull) }];
  }
  if (!reihen.length && Array.isArray(roh.teile)) {
    const t = teileLesen(roh.teile, { negativErlaubt: true });
    x = t.map((p) => p.name);
    reihen = [{ name: str(roh.titel, 60) || 'Wert', werte: t.map((p) => p.wert) }];
  }
  if (!reihen.length) throw fehler('Das Diagramm braucht „reihen“ mit Werten.');
  const n = Math.max(x.length, ...reihen.map((r) => r.werte.length));
  if (!n) throw fehler('Die Reihen haben keine Werte.');
  const zeitlich = art === 'linie' || art === 'flaeche';
  if (!zeitlich && n > MAX_KATEGORIEN) {
    throw fehler(`Zu viele Balken (${n}, höchstens ${MAX_KATEGORIEN}) – eine Linie oder Tabelle passt besser.`);
  }
  x = Array.from({ length: n }, (_, i) => x[i] || String(i + 1));
  reihen = reihen.map((r) => ({ name: r.name, werte: Array.from({ length: n }, (_, i) => (r.werte[i] === undefined ? null : r.werte[i])) }));
  if (!reihen.some((r) => r.werte.some((v) => v !== null))) throw fehler('Die Reihen haben keine Zahlen.');
  return { x, reihen };
}

/**
 * Das JSON eines Diagramms pruefen und vereinheitlichen. Wirft einen
 * BausteinFehler mit einem deutschen Satz (steht dann ueber dem Codeblock).
 * @param {object} roh
 * @returns {object} spec
 */
export function pruefen(roh) {
  const o = objekt(roh);
  if (!o) throw fehler('Ein Diagramm ist ein JSON-Objekt.');
  const artRoh = typeof o.art === 'string' ? o.art.trim().toLowerCase() : '';
  const art = ARTEN.includes(artRoh) ? artRoh : (ALIAS[artRoh] || null);
  if (!art) throw fehler('„art“ muss balken, saeulen, linie, flaeche, kreis, ring, vergleich oder fortschritt sein.');
  const out = { art };
  const titel = str(o.titel, LAENGE.titel);
  if (titel) out.titel = titel;
  const einheit = str(o.einheit, 20);
  if (einheit) out.einheit = einheit;
  const quelle = str(o.quelle, 300);
  if (quelle) out.quelle = quelle;

  if (art === 'fortschritt') {
    let ziel = 100;
    if (o.ziel !== undefined && o.ziel !== null) {
      ziel = zahlOderNull(o.ziel);
      if (ziel === null) throw fehler('„ziel“ ist keine Zahl.');
    }
    if (!(ziel > 0)) throw fehler('„ziel“ muss größer als 0 sein.');
    if (Array.isArray(o.teile) && o.teile.length) {
      const teile = teileLesen(o.teile, { negativErlaubt: true });
      if (!teile.length) throw fehler('Die „teile“ haben keine Zahlen.');
      return { ...out, ziel, teile };
    }
    const wert = zahlOderNull(o.wert);
    if (wert === null) throw fehler('„wert“ fehlt oder ist keine Zahl.');
    return { ...out, wert, ziel };
  }

  if (art === 'kreis' || art === 'ring') {
    let teile = [];
    if (o.teile !== undefined && o.teile !== null) teile = teileLesen(o.teile, { negativErlaubt: false });
    else if (Array.isArray(o.reihen) && o.reihen.length) {
      const { x, reihen } = reihenLesen(o, 'saeulen');
      teile = x.map((name, i) => ({ name, wert: reihen[0].werte[i] })).filter((t) => t.wert !== null);
      if (teile.some((t) => t.wert < 0)) throw fehler('Ein Kreis kann keine negativen Werte zeigen – dafür passen Säulen.');
    }
    if (!teile.length) throw fehler('Ein Kreis braucht „teile“ (je Name und Wert).');
    if (!teile.some((t) => t.wert > 0)) throw fehler('Alle Teile sind 0 – da gibt es nichts zu zeigen.');
    return { ...out, teile: teile.map(({ name, wert }) => ({ name, wert })) };
  }

  return { ...out, ...reihenLesen(o, art) };
}

/**
 * Wie `pruefen`, aber ohne zu werfen -- fuer Tests und die Pruefseite.
 * @returns {{ok:true, spec:object}|{ok:false, fehler:string}}
 */
export function pruefeSpec(roh) {
  try {
    return { ok: true, spec: pruefen(roh) };
  } catch (err) {
    if (err instanceof BausteinFehler) return { ok: false, fehler: err.message };
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Skalen, Zahlen, Daten (rein)                                         */
/* ------------------------------------------------------------------ */

function genau12(x) {
  return Number(Number(x).toPrecision(12));
}

/** Ein "schoener" Schritt: 1, 2, 2,5 oder 5 mal einer Zehnerpotenz, mindestens `roh`. */
export function schoenerSchritt(roh) {
  if (!(roh > 0) || !Number.isFinite(roh)) return 1;
  const e = Math.floor(Math.log10(roh));
  const p = 10 ** e;
  const f = roh / p;
  const nf = f <= 1 + 1e-9 ? 1 : f <= 2 + 1e-9 ? 2 : f <= 2.5 + 1e-9 ? 2.5 : f <= 5 + 1e-9 ? 5 : 10;
  return genau12(nf * p);
}

/**
 * Eine Achse mit runden Schritten. Die Null ist bei Balken Pflicht (Balken
 * wachsen von der Grundlinie, sonst luegt ihre Laenge); bei Linien darf die
 * Achse die Daten umschliessen.
 * @param {number} min
 * @param {number} max
 * @param {{anzahl?:number, mitNull?:boolean}} [opts] etwa so viele Schritte
 * @returns {{min:number, max:number, schritt:number, ticks:number[]}}
 */
export function schoeneSkala(min, max, { anzahl = 5, mitNull = true } = {}) {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : 1;
  if (lo > hi) [lo, hi] = [hi, lo];
  if (mitNull) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  if (lo === hi) {
    // Eine flache Reihe: etwas Raum um den Wert, damit er nicht am Rand klebt.
    const d = lo === 0 ? 1 : Math.abs(lo) * 0.5;
    if (mitNull && lo >= 0) hi = lo + d;
    else if (mitNull && hi <= 0) lo = hi - d;
    else {
      lo -= d;
      hi += d;
    }
  }
  const schritt = schoenerSchritt((hi - lo) / Math.max(1, anzahl));
  const a = Math.floor(genau12(lo / schritt));
  const b = Math.ceil(genau12(hi / schritt));
  const ticks = [];
  for (let i = a; i <= b; i += 1) ticks.push(genau12(i * schritt));
  return { min: ticks[0], max: ticks[ticks.length - 1], schritt, ticks };
}

/** Wie viele Nachkommastellen braucht ein Vielfaches von `schritt`? */
export function dezimalen(schritt) {
  for (let d = 0; d <= 6; d += 1) {
    const x = schritt * 10 ** d;
    if (Math.abs(Math.round(x) - x) < 1e-6) return d;
  }
  return 6;
}

let zahlFormate = new Map();
function format(stellenMax, stellenMin = 0) {
  const k = `${stellenMax}|${stellenMin}`;
  let f = zahlFormate.get(k);
  if (!f) {
    f = new Intl.NumberFormat('de-DE', { maximumFractionDigits: stellenMax, minimumFractionDigits: Math.min(stellenMin, stellenMax) });
    if (zahlFormate.size > 40) zahlFormate = new Map();
    zahlFormate.set(k, f);
  }
  return f;
}

/**
 * Eine Zahl deutsch: 1.234,5 · −4,2 (echtes Minus) · mit `kompakt`
 * 3,5 Mio. / 1,2 Mrd. · mit Einheit "12 %", "1.234,5 €", "3,5 Mio. €".
 * @param {number} n
 * @param {{einheit?:string, kompakt?:boolean, stellen?:number, festeStellen?:boolean}} [opts]
 */
export function zahlText(n, { einheit = '', kompakt = false, stellen = null, festeStellen = false } = {}) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  let wert = n;
  let wort = '';
  const betrag = Math.abs(n);
  if (kompakt && betrag >= 1e9) {
    wert = n / 1e9;
    wort = ' Mrd.';
  } else if (kompakt && betrag >= 1e6) {
    wert = n / 1e6;
    wort = ' Mio.';
  }
  const max = stellen ?? (wort ? (Math.abs(wert) >= 100 ? 0 : Math.abs(wert) >= 10 ? 1 : 2) : 2);
  let s = format(max, festeStellen ? max : 0).format(wert);
  if (/^-0(,0+)?$/.test(s)) s = s.slice(1);
  s = s.replace(/^-/, '−');
  return `${s}${wort}${einheit ? ` ${einheit}` : ''}`;
}

/** Anteil 0..1 als "45 %" (unter 10 % mit einer Stelle: "4,5 %"). */
export function prozentText(anteil) {
  if (!Number.isFinite(anteil)) return '–';
  const p = anteil * 100;
  return `${zahlText(p, { stellen: Math.abs(p) < 10 && p !== 0 ? 1 : 0 })} %`;
}

/**
 * Beschriftungen einer Werte-Achse: gleiche Groessenordnung fuer alle
 * Schritte ("0", "0,5 Mio.", "1 Mio." statt "500.000" neben "1 Mio.").
 */
export function achsenFormat(skala, einheit = '') {
  const maxAbs = Math.max(Math.abs(skala.min), Math.abs(skala.max));
  const teiler = maxAbs >= 1e9 ? 1e9 : maxAbs >= 1e6 ? 1e6 : 1;
  const wort = teiler === 1e9 ? ' Mrd.' : teiler === 1e6 ? ' Mio.' : '';
  const stellen = dezimalen(skala.schritt / teiler);
  const prozent = einheit === '%';
  return (v) => {
    if (v === 0) return prozent ? '0 %' : '0';
    return `${zahlText(v / teiler, { stellen })}${wort}${prozent ? ' %' : ''}`;
  };
}

const MONAT_KURZ = ['Jan', 'Feb', 'März', 'Apr', 'Mai', 'Juni', 'Juli', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const MONAT_LANG = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const TAG_KURZ = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const zwei = (n) => String(n).padStart(2, '0');

/**
 * Ein Zeitpunkt ausfuehrlich (Tooltip, Tabelle): "Mo, 28. Sep 2026",
 * "September 2026", "Q3 2026", "2026", "28. Sep 2026, 14:30".
 * datumLesen() liest jede dieser Formen zurueck (die Tabelle sortiert danach).
 */
export function datumText(t, genau) {
  const d = new Date(t);
  const j = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const tag = d.getUTCDate();
  switch (genau) {
    case 'jahr': return String(j);
    case 'quartal': return `Q${Math.floor(m / 3) + 1} ${j}`;
    case 'monat': return `${MONAT_LANG[m]} ${j}`;
    case 'minute': return `${tag}. ${MONAT_KURZ[m]} ${j}, ${zwei(d.getUTCHours())}:${zwei(d.getUTCMinutes())}`;
    default: return `${TAG_KURZ[d.getUTCDay()]}, ${tag}. ${MONAT_KURZ[m]} ${j}`;
  }
}

/** Ein Zeitpunkt kurz (Achse): "28. Sep", "Sep", "Q3", "2026", "14:30"; mit Jahr, wenn gewuenscht. */
export function datumKurz(t, genau, { mitJahr = false } = {}) {
  const d = new Date(t);
  const j = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const jz = mitJahr ? ` ${j}` : '';
  switch (genau) {
    case 'jahr': return String(j);
    case 'quartal': return `Q${Math.floor(m / 3) + 1}${jz}`;
    case 'monat': return `${MONAT_KURZ[m]}${jz}`;
    case 'minute': return `${zwei(d.getUTCHours())}:${zwei(d.getUTCMinutes())}`;
    default: return `${d.getUTCDate()}. ${MONAT_KURZ[m]}${jz}`;
  }
}

const RANG = { minute: 0, tag: 1, monat: 2, quartal: 3, jahr: 4 };

/**
 * Sind die Beschriftungen einer Achse Zeitpunkte? Nur wenn ALLE es sind
 * (mindestens zwei verschiedene) -- sonst bleibt es eine Liste von Namen.
 * Reine Jahreszahlen zaehlen nur, wenn alle Beschriftungen Jahre sind.
 * @param {string[]} labels
 * @param {{jahr?:number}} [opts] Jahr fuer "28.09." ohne Jahr
 * @returns {{t:number[], genau:string, ordnung:number[]}|null}
 */
export function zeitachse(labels, { jahr = null } = {}) {
  if (!Array.isArray(labels) || labels.length < 2) return null;
  const alleJahre = labels.every((l) => /^\s*(1[5-9]\d{2}|2[0-2]\d{2})\s*$/.test(String(l)));
  const werte = labels.map((l) => datumLesen(String(l), { jahr, jahrAllein: alleJahre }));
  if (werte.some((w) => !w)) return null;
  // Ohne Jahr ("28.12.", "03.01."): ein Sprung zurueck um mehr als ein
  // halbes Jahr ist ein Jahreswechsel, keine Zeitreise.
  let plus = 0;
  const t = werte.map((w, i) => {
    if (w.ohneJahr && i > 0) {
      const vorher = werte[i - 1];
      let neu = addiereJahre(w.t, plus);
      if (neu < addiereJahre(vorher.t, vorher.ohneJahr ? plus : 0) - 182 * 864e5) {
        plus += 1;
        neu = addiereJahre(w.t, plus);
      }
      return neu;
    }
    return w.t;
  });
  if (new Set(t).size < 2) return null;
  const genau = werte.map((w) => w.genau).reduce((a, g) => (RANG[g] < RANG[a] ? g : a), 'jahr');
  const ordnung = t.map((_, i) => i).sort((i, k) => t[i] - t[k] || i - k);
  return { t, genau, ordnung };
}

function addiereJahre(t, n) {
  if (!n) return t;
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
}

const STUFEN = [
  ['minute', 1], ['minute', 5], ['minute', 15], ['minute', 30],
  ['stunde', 1], ['stunde', 3], ['stunde', 6], ['stunde', 12],
  ['tag', 1], ['tag', 2], ['woche', 1], ['woche', 2],
  ['monat', 1], ['monat', 2], ['monat', 3], ['monat', 6],
  ['jahr', 1], ['jahr', 2], ['jahr', 5], ['jahr', 10], ['jahr', 20], ['jahr', 50], ['jahr', 100],
];
/* Die feinste sinnvolle Stufe je Genauigkeit der Daten: Monatswerte bekommen
   keine Tagesstriche. */
const ERSTE_STUFE = { minute: 0, tag: 8, monat: 12, quartal: 14, jahr: 16 };

function stufenTicks([einheit, n], t0, t1) {
  const out = [];
  const grenze = 400;
  if (einheit === 'minute' || einheit === 'stunde' || einheit === 'tag') {
    const schritt = n * (einheit === 'minute' ? 6e4 : einheit === 'stunde' ? 36e5 : 864e5);
    for (let t = Math.ceil(t0 / schritt) * schritt; t <= t1 && out.length < grenze; t += schritt) out.push(t);
    return out;
  }
  if (einheit === 'woche') {
    const d = new Date(t0);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    if (t < t0) t += 864e5;
    while (new Date(t).getUTCDay() !== 1) t += 864e5; // Montag
    for (; t <= t1 && out.length < grenze; t += n * 7 * 864e5) out.push(t);
    return out;
  }
  const d0 = new Date(t0);
  if (einheit === 'monat') {
    let j = d0.getUTCFullYear();
    let m = d0.getUTCMonth();
    if (Date.UTC(j, m, 1) < t0) m += 1;
    while (m % n) m += 1;
    for (let t = Date.UTC(j, m, 1); t <= t1 && out.length < grenze; m += n, t = Date.UTC(j, m, 1)) out.push(t);
    return out;
  }
  let j = d0.getUTCFullYear();
  if (Date.UTC(j, 0, 1) < t0) j += 1;
  while (j % n) j += 1;
  for (; Date.UTC(j, 0, 1) <= t1 && out.length < grenze; j += n) out.push(Date.UTC(j, 0, 1));
  return out;
}

function tickText(t, [einheit, n], vorher, erster, genau) {
  const d = new Date(t);
  const j = d.getUTCFullYear();
  const wechsel = vorher !== null && new Date(vorher).getUTCFullYear() !== j;
  if (einheit === 'minute' || einheit === 'stunde') {
    if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return `${d.getUTCDate()}. ${MONAT_KURZ[d.getUTCMonth()]}`;
    return `${zwei(d.getUTCHours())}:${zwei(d.getUTCMinutes())}`;
  }
  if (einheit === 'tag' || einheit === 'woche') return datumKurz(t, 'tag', { mitJahr: wechsel });
  if (einheit === 'monat') {
    if (genau === 'quartal' && n % 3 === 0) return `Q${Math.floor(d.getUTCMonth() / 3) + 1}${erster || wechsel ? ` ${j}` : ''}`;
    return datumKurz(t, 'monat', { mitJahr: erster || wechsel || d.getUTCMonth() === 0 });
  }
  return String(j);
}

/** Geschaetzte Textbreite (Node, Tests): mittlere Zeichenbreite der Systemschrift. */
export function schaetzeBreite(s, px = SCHRIFT) {
  return String(s ?? '').length * px * 0.58;
}

/**
 * Striche fuer eine Zeitachse: die feinste Stufe, deren Beschriftungen
 * nebeneinander passen. An Kalendergrenzen ausgerichtet (Monatserster,
 * Montag, volle Stunde), Jahreszahl nur beim ersten Strich und bei einem
 * Jahreswechsel.
 * @param {number} t0
 * @param {number} t1
 * @param {{maxAnzahl?:number, platz?:number|null, messen?:(s:string)=>number, genau?:string}} [opts]
 * @returns {{t:number, text:string}[]}
 */
export function zeitTicks(t0, t1, { maxAnzahl = Infinity, platz = null, messen = schaetzeBreite, genau = 'tag' } = {}) {
  if (!(t1 > t0)) return [{ t: t0, text: datumKurz(t0, genau) }];
  let letzte = null;
  for (let s = ERSTE_STUFE[genau] ?? 0; s < STUFEN.length; s += 1) {
    const ticks = stufenTicks(STUFEN[s], t0, t1);
    if (!ticks.length || ticks.length > 60) continue;
    const texte = ticks.map((t, i) => ({ t, text: tickText(t, STUFEN[s], i ? ticks[i - 1] : null, i === 0, genau) }));
    letzte = texte;
    if (texte.length > maxAnzahl) continue;
    if (platz !== null) {
      // Nachbarn duerfen sich nicht beruehren: halbe Breiten plus Luft
      // zwischen je zwei Strichen, an ihrer echten Stelle gemessen.
      const breiten = texte.map((x) => messen(x.text));
      const xs = texte.map((x) => ((x.t - t0) / (t1 - t0)) * platz);
      if (texte.some((_, i) => i > 0 && xs[i] - xs[i - 1] < (breiten[i] + breiten[i - 1]) / 2 + 12)) continue;
    }
    return texte;
  }
  return letzte || [{ t: t0, text: datumKurz(t0, genau) }];
}

/**
 * Hoechstens `max` Stuecke im Kreis: die groessten bleiben (in ihrer
 * Reihenfolge), der Rest wird zu "Andere (n)". Die Tabelle zeigt weiter alle.
 * @returns {{name:string, wert:number, farbe:number|'x', andere?:string[]}[]}
 */
export function teileFalten(teile, max = MAX_STUECKE) {
  const liste = (teile || []).filter((t) => t && Number.isFinite(t.wert) && t.wert >= 0);
  if (liste.length <= max) return liste.map((t, i) => ({ name: t.name, wert: t.wert, farbe: i }));
  const behalten = new Set(liste.map((t, i) => [t.wert, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, max - 1).map((x) => x[1]));
  const out = [];
  const rest = [];
  liste.forEach((t, i) => {
    if (behalten.has(i)) out.push({ name: t.name, wert: t.wert, farbe: out.length });
    else rest.push(t);
  });
  out.push({ name: `Andere (${rest.length})`, wert: rest.reduce((s, t) => s + t.wert, 0), farbe: 'x', andere: rest.map((t) => t.name) });
  return out;
}

function xKopf(zeit) {
  if (!zeit) return 'Kategorie';
  return { minute: 'Zeit', tag: 'Datum', monat: 'Monat', quartal: 'Quartal', jahr: 'Jahr' }[zeit.genau] || 'Datum';
}

function fortschrittText(wert, ziel, einheit) {
  if (einheit === '%' && ziel === 100) return zahlText(wert, { einheit: '%' });
  return `${zahlText(wert, { einheit })} von ${zahlText(ziel, { einheit })} · ${prozentText(wert / ziel)}`;
}

/**
 * Die Zahlen eines Diagramms als Tabelle (Kopf und Zeilen, alles Text):
 * fuer [Als Tabelle], die versteckte Datentabelle und das Kopieren.
 * @returns {{kopf:string[], zeilen:string[][], fuss?:string[]}}
 */
export function datenZeilen(spec, { jahr = null } = {}) {
  const e = spec.einheit || '';
  if (spec.art === 'kreis' || spec.art === 'ring') {
    const summe = spec.teile.reduce((s, t) => s + t.wert, 0);
    return {
      kopf: ['Teil', 'Wert', 'Anteil'],
      zeilen: spec.teile.map((t) => [t.name, zahlText(t.wert, { einheit: e }), prozentText(summe ? t.wert / summe : 0)]),
      fuss: ['Summe', zahlText(summe, { einheit: e }), '100 %'],
    };
  }
  if (spec.art === 'fortschritt') {
    const teile = spec.teile || [{ name: spec.titel || 'Stand', wert: spec.wert }];
    return {
      kopf: ['Bereich', 'Stand', 'Ziel', 'Erreicht'],
      zeilen: teile.map((t) => {
        const ziel = t.ziel || spec.ziel;
        return [t.name, zahlText(t.wert, { einheit: e }), zahlText(ziel, { einheit: e }), prozentText(t.wert / ziel)];
      }),
    };
  }
  const zeit = zeitachse(spec.x, { jahr });
  return {
    kopf: [xKopf(zeit), ...spec.reihen.map((r) => r.name)],
    zeilen: spec.x.map((lab, c) => [zeit ? datumText(zeit.t[c], zeit.genau) : lab, ...spec.reihen.map((r) => zahlText(r.werte[c], { einheit: e }))]),
  };
}

const zelle = (s) => String(s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');

/**
 * Das Diagramm als Text (Kopieren, Vorlesen): Titel, eine Markdown-Tabelle
 * der Zahlen, die Quelle. So kommt beim Einfuegen in eine Notiz wieder eine
 * Tabelle heraus, kein JSON.
 */
export function textFassung(spec) {
  if (!spec) return '';
  const teile = [];
  if (spec.titel) teile.push(`**${spec.titel}**`);
  if (spec.art === 'fortschritt' && !spec.teile) {
    teile.push(fortschrittText(spec.wert, spec.ziel, spec.einheit));
  } else {
    const { kopf, zeilen, fuss } = datenZeilen(spec);
    const t = [`| ${kopf.map(zelle).join(' | ')} |`, `|${kopf.map(() => '---').join('|')}|`, ...zeilen.map((z) => `| ${z.map(zelle).join(' | ')} |`)];
    if (fuss) t.push(`| ${fuss.map(zelle).join(' | ')} |`);
    teile.push(t.join('\n'));
  }
  if (spec.quelle) teile.push(`Quelle: ${spec.quelle}`);
  return teile.join('\n\n');
}

/** Ein Satz fuer Screenreader (aria-label des Bildes). */
export function beschreibung(spec, { jahr = null } = {}) {
  const name = ART_NAMEN[spec.art] || 'Diagramm';
  const titel = spec.titel ? `: ${spec.titel}` : '';
  const e = spec.einheit || '';
  if (spec.art === 'fortschritt') {
    if (spec.teile) return `${name}${titel}. ${spec.teile.map((t) => `${t.name} ${prozentText(t.wert / (t.ziel || spec.ziel))}`).join(', ')}.`;
    return `${name}${titel}: ${fortschrittText(spec.wert, spec.ziel, spec.einheit)}.`;
  }
  if (spec.art === 'kreis' || spec.art === 'ring') {
    const summe = spec.teile.reduce((s, t) => s + t.wert, 0);
    return `${name}${titel}. ${spec.teile.map((t) => `${t.name} ${prozentText(t.wert / summe)}`).join(', ')}.`;
  }
  const werte = spec.reihen.flatMap((r) => r.werte.filter((v) => v !== null));
  const zeit = zeitachse(spec.x, { jahr });
  const k = spec.reihen.length;
  const n = spec.x.length;
  let s = `${name}${titel}, ${k === 1 ? 'eine Reihe' : `${k} Reihen`}, ${n} ${n === 1 ? 'Wert' : 'Werte'}`;
  if (zeit) s += ` von ${datumText(zeit.t[zeit.ordnung[0]], zeit.genau)} bis ${datumText(zeit.t[zeit.ordnung[n - 1]], zeit.genau)}`;
  s += `, zwischen ${zahlText(Math.min(...werte), { einheit: e, kompakt: true })} und ${zahlText(Math.max(...werte), { einheit: e, kompakt: true })}.`;
  return s;
}

/* ------------------------------------------------------------------ */
/* Zeichnen: Hilfen                                                     */
/* ------------------------------------------------------------------ */

let messKontext = null;
let messFamilie = null;
/** Textbreite in px (im Browser gemessen, sonst geschaetzt). */
function messen(s, px = SCHRIFT, gewicht = 400) {
  const t = String(s ?? '');
  if (typeof document !== 'undefined') {
    try {
      if (!messKontext) messKontext = document.createElement('canvas').getContext('2d');
      if (!messFamilie) messFamilie = getComputedStyle(document.body || document.documentElement).fontFamily || 'system-ui, sans-serif';
      messKontext.font = `${gewicht} ${px}px ${messFamilie}`;
      return messKontext.measureText(t).width;
    } catch {
      messKontext = null;
    }
  }
  return schaetzeBreite(t, px);
}

/** Text kuerzen, bis er in `maxPx` passt ("Nordrhein-Westf…"). */
function kuerzen(s, maxPx, px = SCHRIFT, gewicht = 400) {
  const t = String(s ?? '');
  if (maxPx <= 0) return '';
  if (messen(t, px, gewicht) <= maxPx) return t;
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mitte = (lo + hi + 1) >> 1;
    if (messen(`${t.slice(0, mitte).trimEnd()}…`, px, gewicht) <= maxPx) lo = mitte;
    else hi = mitte - 1;
  }
  return lo ? `${t.slice(0, lo).trimEnd()}…` : '';
}

const r2 = (x) => Math.round(x * 100) / 100;
/* replaceChildren macht aus null den Text "null" und aus einer Liste
   "[object …]" -- hier werden beide vorher aussortiert bzw. ausgebreitet. */
function fuellen(el, ...kinder) {
  el.replaceChildren(...kinder.flat(2).filter((k) => k !== null && k !== undefined && k !== false));
  return el;
}
const farbKlasse = (slot) => (slot === 'x' ? 'dg-rx' : `dg-r${slot}`);

/** Saeule von der Grundlinie `basis` bis `oben`: am Datenende 4 px rund, an der Grundlinie gerade. */
function saeulePfad(x, basis, breite, oben) {
  const hoehe = basis - oben;
  const r = Math.min(4, breite / 2, Math.abs(hoehe));
  const [X, W, B, O] = [r2(x), r2(breite), r2(basis), r2(oben)];
  if (hoehe >= 0) return `M${X},${B}V${r2(O + r)}A${r},${r} 0 0 1 ${r2(X + r)},${O}H${r2(X + W - r)}A${r},${r} 0 0 1 ${r2(X + W)},${r2(O + r)}V${B}Z`;
  return `M${X},${B}V${r2(O - r)}A${r},${r} 0 0 0 ${r2(X + r)},${O}H${r2(X + W - r)}A${r},${r} 0 0 0 ${r2(X + W)},${r2(O - r)}V${B}Z`;
}

/** Waagrechter Balken von `basis` bis `ende` (x), oben bei `y`, `dicke` hoch. */
function balkenPfad(basis, y, dicke, ende) {
  const laenge = ende - basis;
  const r = Math.min(4, dicke / 2, Math.abs(laenge));
  const [B, Y, D, E] = [r2(basis), r2(y), r2(dicke), r2(ende)];
  if (laenge >= 0) return `M${B},${Y}H${r2(E - r)}A${r},${r} 0 0 1 ${E},${r2(Y + r)}V${r2(Y + D - r)}A${r},${r} 0 0 1 ${r2(E - r)},${r2(Y + D)}H${B}Z`;
  return `M${B},${Y}H${r2(E + r)}A${r},${r} 0 0 0 ${E},${r2(Y + r)}V${r2(Y + D - r)}A${r},${r} 0 0 0 ${r2(E + r)},${r2(Y + D)}H${B}Z`;
}

/** Ein Kreis- oder Ringstueck von Winkel a0 bis a1 (Bogenmass, 0 = rechts, im Uhrzeigersinn). */
function stueckPfad(cx, cy, innen, aussen, a0, a1) {
  const p = (r, a) => `${r2(cx + r * Math.cos(a))},${r2(cy + r * Math.sin(a))}`;
  if (a1 - a0 >= Math.PI * 2 - 1e-6) {
    const voll = `M${r2(cx + aussen)},${cy}A${aussen},${aussen} 0 1 1 ${r2(cx - aussen)},${cy}A${aussen},${aussen} 0 1 1 ${r2(cx + aussen)},${cy}Z`;
    if (innen <= 0) return voll;
    return `${voll}M${r2(cx + innen)},${cy}A${innen},${innen} 0 1 0 ${r2(cx - innen)},${cy}A${innen},${innen} 0 1 0 ${r2(cx + innen)},${cy}Z`;
  }
  const gross = a1 - a0 > Math.PI ? 1 : 0;
  if (innen <= 0) return `M${cx},${cy}L${p(aussen, a0)}A${aussen},${aussen} 0 ${gross} 1 ${p(aussen, a1)}Z`;
  return `M${p(aussen, a0)}A${aussen},${aussen} 0 ${gross} 1 ${p(aussen, a1)}L${p(innen, a1)}A${innen},${innen} 0 ${gross} 0 ${p(innen, a0)}Z`;
}

/** Die Plot-Hoehe waechst mit der Breite, bleibt aber ruhig. */
const plotHoehe = (breite) => Math.round(Math.max(150, Math.min(250, breite * 0.4)));

function svgText(x, y, inhalt, { anker = 'middle', klasse = 'dg-text', gewicht = null } = {}) {
  return h('text', { x: r2(x), y: r2(y), 'text-anchor': anker, class: klasse, 'font-weight': gewicht }, inhalt);
}

/* ------------------------------------------------------------------ */
/* Zeichnen: Modell                                                     */
/* ------------------------------------------------------------------ */

function modellAus(spec) {
  const m = { art: spec.art, einheit: spec.einheit || '', spec };
  if (spec.art === 'kreis' || spec.art === 'ring') {
    m.stuecke = teileFalten(spec.teile);
    return m;
  }
  if (spec.art === 'fortschritt') return m;
  m.x = spec.x;
  m.serien = spec.reihen.map((r, i) => ({ name: r.name, werte: r.werte, i }));
  m.zeit = zeitachse(spec.x);
  const zeit = m.zeit;
  if (zeit) {
    const jahre = new Set(zeit.t.map((t) => new Date(t).getUTCFullYear()));
    const ord = zeit.ordnung;
    const mitJahrAn = new Set();
    if (jahre.size > 1) {
      ord.forEach((c, k) => {
        if (k === 0 || new Date(zeit.t[c]).getUTCFullYear() !== new Date(zeit.t[ord[k - 1]]).getUTCFullYear()) mitJahrAn.add(c);
      });
    }
    m.xKurz = spec.x.map((_, c) => datumKurz(zeit.t[c], zeit.genau, { mitJahr: mitJahrAn.has(c) }));
    m.xLang = spec.x.map((_, c) => datumText(zeit.t[c], zeit.genau));
  } else {
    m.xKurz = spec.x.slice();
    m.xLang = spec.x.slice();
  }
  return m;
}

/* Werte mit Einheit fuer den Tooltip; grosse Zahlen kompakt. */
const wertText = (v, e) => zahlText(v, { einheit: e, kompakt: v !== null && Math.abs(v) >= 1e6 });
/* Direkte Beschriftung: ohne Einheit (die steht im Kopf), ausser Prozent. */
const etikett = (v, e) => zahlText(v, { kompakt: true, einheit: e === '%' ? '%' : '' });

/* ------------------------------------------------------------------ */
/* Zeichnen: Saeulen und Vergleich                                      */
/* ------------------------------------------------------------------ */

function zeichneSaeulen(m, ser, B) {
  const n = m.x.length;
  const k = Math.max(1, ser.length);
  const H = plotHoehe(B);
  const werte = ser.flatMap((s) => s.werte.filter((v) => v !== null));
  const lo = werte.length ? Math.min(...werte) : 0;
  const hi = werte.length ? Math.max(...werte) : 1;
  const unten = 26;
  // Eine Reihe mit wenigen Saeulen traegt ihre Werte selbst -- dann braucht
  // es keine Achse (dataviz: "Y-Achse nur fuer das, was nicht beschriftet ist").
  const etiketten = werte.map((v) => etikett(v, m.einheit));
  const etikettBreite = Math.max(0, ...etiketten.map((t) => messen(t, SCHRIFT, 500)));
  const bandVorab = (B - 4) / n;
  const beschriften = k === 1 && n <= 16 && etikettBreite + 6 <= bandVorab;
  const oben = beschriften ? 20 : 10;
  // Ohne Achse braucht es keine runden Schritte: die hoechste Saeule darf
  // bis oben reichen, statt unter einem unsichtbaren "20.000" zu enden.
  const negUnten = beschriften && lo < 0 ? 16 : 0;
  const skala = beschriften
    ? { min: Math.min(0, lo), max: Math.max(0, hi) > Math.min(0, lo) ? Math.max(0, hi) : 1, schritt: 1, ticks: [0] }
    : schoeneSkala(lo, hi, { anzahl: Math.max(2, Math.min(6, Math.floor(H / 44))), mitNull: true });
  const tick = achsenFormat(skala, m.einheit);
  const links = beschriften ? 2 : Math.ceil(Math.max(...skala.ticks.map((t) => messen(tick(t))))) + 10;
  const plotW = Math.max(40, B - links - 2);
  const bw = plotW / n;
  const dicke = Math.max(2, Math.min(24, (bw * 0.72 - (k - 1) * 2) / k));
  const gruppe = k * dicke + (k - 1) * 2;
  const y = (v) => oben + ((skala.max - v) / (skala.max - skala.min)) * H;
  const y0 = y(Math.min(skala.max, Math.max(skala.min, 0)));
  const hoehe = oben + H + unten + negUnten;

  const svg = h('svg', { width: B, height: hoehe, viewBox: `0 0 ${B} ${hoehe}`, class: 'dg-svg' });
  const gitter = h('g.dg-gitterschicht');
  if (!beschriften) {
    for (const t of skala.ticks) {
      if (t === 0) continue;
      gitter.appendChild(h('line', { x1: links, x2: B, y1: r2(y(t)), y2: r2(y(t)), class: 'dg-gitter' }));
    }
    for (const t of skala.ticks) gitter.appendChild(svgText(links - 8, y(t) + 4, tick(t), { anker: 'end' }));
  }
  const band = h('rect.dg-band', { x: 0, y: oben - 6, width: 0, height: H + 6, rx: 6, visibility: 'hidden' });
  const marken = h('g.dg-marken');
  const beschriftungen = h('g');
  const nachBand = new Map();
  for (let c = 0; c < n; c += 1) {
    const liste = [];
    ser.forEach((s, j) => {
      const v = s.werte[c];
      if (v === null) return;
      const x = links + c * bw + (bw - gruppe) / 2 + j * (dicke + 2);
      const pfad = h('path', {
        d: saeulePfad(x, y0, dicke, y(v)),
        class: `dg-mark dg-balken dg-ein-balken ${farbKlasse(s.i)}${v < 0 ? ' is-neg' : ''}`,
      });
      marken.appendChild(pfad);
      liste.push(pfad);
      if (beschriften) {
        beschriftungen.appendChild(svgText(x + dicke / 2, v < 0 ? y(v) + 14 : y(v) - 6, etikett(v, m.einheit), { klasse: 'dg-text dg-wert' }));
      }
    });
    nachBand.set(c, liste);
  }
  const basis = h('line', { x1: links, x2: B, y1: r2(y0), y2: r2(y0), class: 'dg-basis' });
  const achse = xBeschriftungen(m, (c) => links + c * bw + bw / 2, bw, oben + H + 17 + negUnten, B);
  svg.append(gitter, band, marken, basis, beschriftungen, achse);

  return {
    svg,
    hoehe,
    ordnung: Array.from({ length: n }, (_, c) => c),
    treffer: (px, py) => (px < links - 4 || py > hoehe ? null : Math.max(0, Math.min(n - 1, Math.floor((px - links) / bw)))),
    markieren(c) {
      band.setAttribute('visibility', c === null ? 'hidden' : 'visible');
      if (c !== null) {
        band.setAttribute('x', r2(links + c * bw + 1));
        band.setAttribute('width', r2(Math.max(2, bw - 2)));
      }
      for (const [bc, liste] of nachBand) for (const p of liste) p.classList.toggle('is-gedimmt', c !== null && bc !== c);
    },
    hervorheben(i) {
      for (const liste of nachBand.values()) for (const p of liste) p.classList.toggle('is-gedimmt', i !== null && !p.classList.contains(farbKlasse(i)));
    },
    info(c) {
      const vs = ser.map((s) => s.werte[c]).filter((v) => v !== null);
      return {
        kopf: m.xLang[c],
        zeilen: ser.map((s) => ({ slot: s.i, name: s.name, wert: wertText(s.werte[c], m.einheit) })),
        x: links + c * bw + bw / 2,
        y: vs.length ? Math.min(...vs.map((v) => y(Math.max(v, 0)))) : y0,
      };
    },
  };
}

/** Kategorie-Beschriftungen unter einer Achse: ausgeduennt, wenn sie nicht nebeneinander passen. */
function xBeschriftungen(m, xVon, platzJe, yText, B) {
  const g = h('g.dg-xachse');
  const n = m.xKurz.length;
  const breiten = m.xKurz.map((t) => messen(t));
  const maxB = Math.max(0, ...breiten);
  const schritt = Math.max(1, Math.ceil((maxB + 10) / Math.max(1, platzJe)));
  const erlaubt = Math.max(24, platzJe * schritt - 8);
  for (let c = 0; c < n; c += schritt) {
    const t = kuerzen(m.xKurz[c], erlaubt);
    const w = messen(t);
    const x = Math.max(w / 2, Math.min(B - w / 2, xVon(c)));
    g.appendChild(svgText(x, yText, t));
  }
  return g;
}

/* ------------------------------------------------------------------ */
/* Zeichnen: Balken (waagrecht)                                         */
/* ------------------------------------------------------------------ */

function zeichneBalken(m, ser, B) {
  const n = m.x.length;
  const k = Math.max(1, ser.length);
  // Auf schmalen Schirmen steht der Name ueber dem Balken, sonst frisst die
  // Namensspalte den Platz, den der Balken braucht.
  const schmal = B < 440;
  const dicke = k === 1 ? 20 : Math.max(8, Math.min(16, Math.floor(40 / k)));
  const gruppe = k * dicke + (k - 1) * 2;
  const nameZeile = schmal ? 19 : 0;
  const abstand = schmal ? 16 : 12;
  const zeile = nameZeile + gruppe + abstand;
  const werte = ser.flatMap((s) => s.werte.filter((v) => v !== null));
  const etikettBreite = Math.ceil(Math.max(0, ...werte.map((v) => messen(etikett(v, m.einheit), SCHRIFT, 500)))) + 8;
  const namenBreite = schmal ? 0 : Math.ceil(Math.min(B * 0.36, Math.max(...m.xKurz.map((t) => messen(t, 13))) + 14));
  const negativ = werte.some((v) => v < 0);
  const lo = Math.min(0, ...werte);
  const hi = Math.max(0, ...werte, lo === 0 ? 1 : 0);
  const x0 = namenBreite + (negativ ? etikettBreite : 0);
  const x1 = Math.max(x0 + 40, B - etikettBreite);
  const sx = (v) => x0 + ((v - lo) / ((hi - lo) || 1)) * (x1 - x0);
  const basisX = sx(0);
  const oben = 4;
  const hoehe = oben + n * zeile - abstand + 6;

  const svg = h('svg', { width: B, height: hoehe, viewBox: `0 0 ${B} ${hoehe}`, class: 'dg-svg' });
  const band = h('rect.dg-band', { x: 0, y: 0, width: B, height: 0, rx: 6, visibility: 'hidden' });
  const marken = h('g.dg-marken');
  const texte = h('g');
  const nachZeile = new Map();
  for (let c = 0; c < n; c += 1) {
    const top = oben + c * zeile;
    const name = m.xKurz[c];
    if (schmal) texte.appendChild(svgText(0, top + 13, kuerzen(name, B - 4, 13), { anker: 'start', klasse: 'dg-text dg-name' }));
    else texte.appendChild(svgText(namenBreite - 12, top + gruppe / 2 + 4.5, kuerzen(name, namenBreite - 14, 13), { anker: 'end', klasse: 'dg-text dg-name' }));
    const liste = [];
    ser.forEach((s, j) => {
      const v = s.werte[c];
      if (v === null) return;
      const yb = top + nameZeile + j * (dicke + 2);
      const pfad = h('path', { d: balkenPfad(basisX, yb, dicke, sx(v)), class: `dg-mark dg-balken dg-ein-balken is-waag ${farbKlasse(s.i)}${v < 0 ? ' is-neg' : ''}` });
      marken.appendChild(pfad);
      liste.push(pfad);
      texte.appendChild(svgText(v < 0 ? sx(v) - 6 : sx(v) + 6, yb + dicke / 2 + 4, etikett(v, m.einheit), { anker: v < 0 ? 'end' : 'start', klasse: 'dg-text dg-wert' }));
    });
    nachZeile.set(c, liste);
  }
  // Schmal stehen die Namen ueber den Balken: die Grundlinie laeuft dann nur
  // durch die Balkenzeilen, nicht durch die Namen.
  const basis = schmal
    ? h('g', null, Array.from({ length: n }, (_, c) => {
      const y1 = oben + c * zeile + nameZeile - 3;
      return h('line', { x1: r2(basisX), x2: r2(basisX), y1: r2(y1), y2: r2(y1 + gruppe + 6), class: 'dg-basis' });
    }))
    : h('line', { x1: r2(basisX), x2: r2(basisX), y1: oben - 2, y2: hoehe - 2, class: 'dg-basis' });
  svg.append(band, marken, basis, texte);

  return {
    svg,
    hoehe,
    ordnung: Array.from({ length: n }, (_, c) => c),
    treffer: (px, py) => Math.max(0, Math.min(n - 1, Math.floor((py - oben + abstand / 2) / zeile))),
    markieren(c) {
      band.setAttribute('visibility', c === null ? 'hidden' : 'visible');
      if (c !== null) {
        band.setAttribute('y', r2(oben + c * zeile - abstand / 2 + 1));
        band.setAttribute('height', r2(zeile - 2));
      }
      for (const [zc, liste] of nachZeile) for (const p of liste) p.classList.toggle('is-gedimmt', c !== null && zc !== c);
    },
    hervorheben(i) {
      for (const liste of nachZeile.values()) for (const p of liste) p.classList.toggle('is-gedimmt', i !== null && !p.classList.contains(farbKlasse(i)));
    },
    info(c) {
      const vs = ser.map((s) => s.werte[c]).filter((v) => v !== null);
      return {
        kopf: m.xLang[c],
        zeilen: ser.map((s) => ({ slot: s.i, name: s.name, wert: wertText(s.werte[c], m.einheit) })),
        x: vs.length ? sx(Math.max(...vs, 0)) : basisX,
        y: oben + c * zeile + nameZeile,
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Zeichnen: Linie und Flaeche                                          */
/* ------------------------------------------------------------------ */

function zeichneLinien(m, ser, B) {
  const n = m.x.length;
  const zeit = m.zeit;
  const ord = zeit ? zeit.ordnung : Array.from({ length: n }, (_, c) => c);
  const flaeche = m.art === 'flaeche';
  const H = plotHoehe(B);
  const oben = 12;
  const unten = 26;
  const hoehe = oben + H + unten;
  const werte = ser.flatMap((s) => s.werte.filter((v) => v !== null));
  const lo = werte.length ? Math.min(...werte) : 0;
  const hi = werte.length ? Math.max(...werte) : 1;
  // Eine Flaeche steht immer auf der Null; eine Linie nur, wenn die Null
  // nahe ist -- sonst waere die ganze Bewegung ein flacher Strich oben.
  const mitNull = flaeche || (lo >= 0 && lo <= hi * 0.35) || (hi <= 0 && hi >= lo * 0.35);
  const skala = schoeneSkala(lo, hi, { anzahl: Math.max(2, Math.min(6, Math.floor(H / 44))), mitNull });
  const tick = achsenFormat(skala, m.einheit);
  const links = Math.ceil(Math.max(...skala.ticks.map((t) => messen(tick(t))))) + 10;
  const y = (v) => oben + ((skala.max - v) / (skala.max - skala.min)) * H;

  // Werte am Linienende -- aber nur, wenn sie sich nicht ueberlagern (dann
  // tragen Legende und Tooltip die Werte; gestapelte Etiketten waeren Laerm).
  const enden = ser.map((s) => {
    for (let k = ord.length - 1; k >= 0; k -= 1) {
      const c = ord[k];
      if (s.werte[c] !== null) return { s, c, v: s.werte[c], y: y(s.werte[c]), text: etikett(s.werte[c], m.einheit) };
    }
    return null;
  }).filter(Boolean);
  const sortiert = enden.slice().sort((a, b) => a.y - b.y);
  const endeZeigen = enden.length > 0 && enden.length <= 4 && sortiert.every((e, i) => i === 0 || e.y - sortiert[i - 1].y >= 15);
  const rechts = endeZeigen ? Math.ceil(Math.max(...enden.map((e) => messen(e.text, SCHRIFT, 500)))) + 14 : 8;
  const plotW = Math.max(40, B - links - rechts);

  let xVon;
  let t0 = 0;
  let t1 = 1;
  if (zeit) {
    t0 = zeit.t[ord[0]];
    t1 = zeit.t[ord[ord.length - 1]];
    xVon = (c) => links + ((zeit.t[c] - t0) / ((t1 - t0) || 1)) * plotW;
  } else {
    const pos = new Map(ord.map((c, k) => [c, k]));
    xVon = (c) => (n === 1 ? links + plotW / 2 : links + (pos.get(c) / (n - 1)) * plotW);
  }

  const svg = h('svg', { width: B, height: hoehe, viewBox: `0 0 ${B} ${hoehe}`, class: 'dg-svg' });
  const gitter = h('g.dg-gitterschicht');
  for (const t of skala.ticks) {
    gitter.appendChild(h('line', { x1: links, x2: links + plotW, y1: r2(y(t)), y2: r2(y(t)), class: t === 0 ? 'dg-basis' : 'dg-gitter' }));
    gitter.appendChild(svgText(links - 8, y(t) + 4, tick(t), { anker: 'end' }));
  }

  // x-Achse: Kalenderstriche bei Zeitverlaeufen, sonst ausgeduennte Namen.
  let achse;
  if (zeit) {
    achse = h('g.dg-xachse');
    const ticks = zeitTicks(t0, t1, { platz: plotW, messen: (s) => messen(s), genau: zeit.genau });
    for (const tk of ticks) {
      const x = links + ((tk.t - t0) / ((t1 - t0) || 1)) * plotW;
      const w = messen(tk.text);
      achse.appendChild(svgText(Math.max(w / 2, Math.min(B - w / 2, x)), oben + H + 17, tk.text));
    }
  } else {
    achse = xBeschriftungen(m, xVon, n > 1 ? plotW / (n - 1) : plotW, oben + H + 17, B);
  }

  const basisY = y(skala.min < 0 && skala.max > 0 ? 0 : skala.min);
  const flaechen = h('g.dg-ein-blende');
  const linien = h('g.dg-ein-blende');
  const punkte = h('g');
  const nachSerie = new Map();
  for (const s of ser) {
    const segmente = [];
    let seg = [];
    for (const c of ord) {
      const v = s.werte[c];
      if (v === null) {
        if (seg.length) segmente.push(seg);
        seg = [];
      } else seg.push([xVon(c), y(v)]);
    }
    if (seg.length) segmente.push(seg);
    const kl = farbKlasse(s.i);
    const teile = [];
    if (flaeche) {
      const d = segmente.filter((sg) => sg.length > 1).map((sg) => `M${r2(sg[0][0])},${r2(basisY)}${sg.map(([px, py]) => `L${r2(px)},${r2(py)}`).join('')}L${r2(sg[sg.length - 1][0])},${r2(basisY)}Z`).join('');
      if (d) {
        const f = h('path', { d, class: `dg-mark dg-flaechen ${kl}` });
        flaechen.appendChild(f);
        teile.push(f);
      }
    }
    const d = segmente.filter((sg) => sg.length > 1).map((sg) => sg.map(([px, py], i) => `${i ? 'L' : 'M'}${r2(px)},${r2(py)}`).join('')).join('');
    if (d) {
      const l = h('path', { d, class: `dg-mark dg-linie ${kl}` });
      linien.appendChild(l);
      teile.push(l);
    }
    // Einzelne Punkte zwischen Luecken haetten sonst keinen Strich.
    for (const sg of segmente) {
      if (sg.length === 1) {
        const p = h('circle', { cx: r2(sg[0][0]), cy: r2(sg[0][1]), r: 3, class: `dg-mark dg-einzel ${kl}` });
        linien.appendChild(p);
        teile.push(p);
      }
    }
    nachSerie.set(s.i, teile);
  }
  const endpunkte = h('g.dg-ein-blende');
  for (const e of enden) {
    const p = h('circle', { cx: r2(xVon(e.c)), cy: r2(e.y), r: 5, class: `dg-mark dg-punkt ${farbKlasse(e.s.i)}` });
    endpunkte.appendChild(p);
    nachSerie.get(e.s.i).push(p);
    if (endeZeigen) {
      const t = svgText(xVon(e.c) + 10, e.y + 4, e.text, { anker: 'start', klasse: 'dg-text dg-wert' });
      endpunkte.appendChild(t);
    }
  }
  const kreuz = h('line', { x1: 0, x2: 0, y1: oben, y2: oben + H, class: 'dg-kreuz', visibility: 'hidden' });
  const schwebe = ser.map((s) => h('circle', { cx: 0, cy: 0, r: 5, class: `dg-punkt dg-schwebe ${farbKlasse(s.i)}`, visibility: 'hidden' }));
  punkte.append(...schwebe);
  svg.append(gitter, flaechen, achse, kreuz, linien, endpunkte, punkte);

  // Naechster Punkt zur Zeigerposition: nach x, nicht nach dem Strich --
  // niemand trifft eine 2-px-Linie.
  const xs = ord.map((c) => xVon(c));
  const treffer = (px) => {
    if (!n) return null;
    let a = 0;
    let b = xs.length - 1;
    while (b - a > 1) {
      const mitte = (a + b) >> 1;
      if (xs[mitte] < px) a = mitte;
      else b = mitte;
    }
    return ord[Math.abs(xs[a] - px) <= Math.abs(xs[b] - px) ? a : b];
  };

  return {
    svg,
    hoehe,
    ordnung: ord.slice(),
    treffer,
    markieren(c) {
      const an = c !== null;
      kreuz.setAttribute('visibility', an ? 'visible' : 'hidden');
      if (an) {
        const x = r2(xVon(c));
        kreuz.setAttribute('x1', x);
        kreuz.setAttribute('x2', x);
      }
      ser.forEach((s, j) => {
        const v = an ? s.werte[c] : null;
        schwebe[j].setAttribute('visibility', v === null ? 'hidden' : 'visible');
        if (v !== null) {
          schwebe[j].setAttribute('cx', r2(xVon(c)));
          schwebe[j].setAttribute('cy', r2(y(v)));
        }
      });
    },
    hervorheben(i) {
      for (const [si, teile] of nachSerie) for (const p of teile) p.classList.toggle('is-gedimmt', i !== null && si !== i);
    },
    info(c) {
      const vs = ser.map((s) => s.werte[c]).filter((v) => v !== null);
      return {
        kopf: m.xLang[c],
        zeilen: ser.map((s) => ({ slot: s.i, name: s.name, wert: wertText(s.werte[c], m.einheit) })),
        x: xVon(c),
        y: vs.length ? Math.min(...vs.map(y)) : oben,
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Zeichnen: Kreis und Ring                                             */
/* ------------------------------------------------------------------ */

function zeichneKreis(m, sichtbar, D) {
  const ring = m.art === 'ring';
  const cx = D / 2;
  const cy = D / 2;
  const aussen = D / 2 - 2;
  const innen = ring ? aussen * 0.64 : 0;
  const summe = sichtbar.reduce((s, t) => s + t.wert, 0) || 1;
  const svg = h('svg', { width: D, height: D, viewBox: `0 0 ${D} ${D}`, class: 'dg-svg' });
  const g = h('g.dg-ein-kreis');
  const stuecke = new Map();
  const winkel = new Map();
  let a = -Math.PI / 2;
  const mehrere = sichtbar.filter((t) => t.wert > 0).length > 1;
  for (const t of sichtbar) {
    const a1 = a + (t.wert / summe) * Math.PI * 2;
    if (t.wert > 0) {
      const p = h('path', {
        d: stueckPfad(cx, cy, innen, aussen, a, a1),
        class: `dg-mark dg-stueck ${farbKlasse(t.farbe)}${mehrere ? '' : ' is-allein'}`,
        'fill-rule': 'evenodd',
      });
      g.appendChild(p);
      stuecke.set(t.d, p);
    }
    winkel.set(t.d, [a, a1]);
    a = a1;
  }
  svg.appendChild(g);

  // Der Ring hat in der Mitte Platz fuer die Summe -- und beim Zeigen fuer
  // das gezeigte Stueck. Dort braucht es dann keinen Tooltip.
  let mitte = null;
  const mitteSetzen = (t) => {
    if (!mitte) return;
    const gross = t ? prozentText(t.wert / summe) : zahlText(summe, { kompakt: true, einheit: m.einheit === '%' ? '%' : '' });
    const klein = t ? t.name : (m.einheit && m.einheit !== '%' ? `Gesamt · ${m.einheit}` : 'Gesamt');
    const platz = innen * 1.6;
    const px = messen(gross, 22, 600) <= platz ? 22 : 17;
    mitte.replaceChildren(
      h('text', { x: cx, y: cy + 3, 'text-anchor': 'middle', class: 'dg-mitte', 'font-size': px }, kuerzen(gross, platz, px, 600)),
      h('text', { x: cx, y: cy + 21, 'text-anchor': 'middle', class: 'dg-text' }, kuerzen(klein, platz)),
    );
  };
  if (ring) {
    mitte = h('g');
    svg.appendChild(mitte);
    mitteSetzen(null);
  }

  const reihe = sichtbar.filter((t) => t.wert > 0).map((t) => t.d);
  return {
    svg,
    hoehe: D,
    ordnung: reihe,
    ring,
    treffer(px, py) {
      const dx = px - cx;
      const dy = py - cy;
      const r = Math.hypot(dx, dy);
      if (r > aussen + 6 || r < innen - 6) return null;
      let w = Math.atan2(dy, dx);
      if (w < -Math.PI / 2) w += Math.PI * 2;
      for (const [d, [a0, a1]] of winkel) if (w >= a0 && w < a1 && stuecke.has(d)) return d;
      return null;
    },
    markieren(d) {
      for (const [sd, p] of stuecke) p.classList.toggle('is-gedimmt', d !== null && sd !== d);
      mitteSetzen(d === null ? null : sichtbar.find((t) => t.d === d) || null);
    },
    hervorheben(d) {
      for (const [sd, p] of stuecke) p.classList.toggle('is-gedimmt', d !== null && sd !== d);
    },
    info(d) {
      const t = sichtbar.find((x) => x.d === d);
      if (!t) return null;
      const [a0, a1] = winkel.get(d);
      const am = (a0 + a1) / 2;
      const r = (aussen + innen) / 2 || aussen * 0.6;
      return {
        kopf: t.name,
        zeilen: [{ slot: t.farbe, name: m.einheit === '%' ? '' : prozentText(t.wert / summe), wert: wertText(t.wert, m.einheit) }],
        x: cx + r * Math.cos(am),
        y: cy + r * Math.sin(am),
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Zeichnen: Fortschritt                                                */
/* ------------------------------------------------------------------ */

function spur(anteil, label, valueText) {
  const p = Math.max(0, Math.min(1, anteil));
  return h('div.dg-fs__spur', {
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': String(Math.round(p * 100)),
    'aria-valuetext': valueText,
    'aria-label': label,
  }, h('div.dg-fs__fuell', { style: { width: `${(p * 100).toFixed(2)}%` } }));
}

function zeichneFortschritt(spec) {
  const e = spec.einheit || '';
  if (!spec.teile) {
    const anteil = spec.wert / spec.ziel;
    const prozentArt = e === '%' && spec.ziel === 100;
    const erreicht = anteil >= 1;
    return h('div.dg-fs', null,
      h('div.dg-fs__kopf', null,
        h('div.dg-fs__zahlen', null,
          h('span.dg-fs__wert', null, text(zahlText(spec.wert, { einheit: e }))),
          prozentArt ? null : h('span.dg-fs__von', null, text(`von ${zahlText(spec.ziel, { einheit: e })}`))),
        prozentArt ? null : h('span.dg-fs__prozent', null, text(prozentText(anteil)))),
      spur(anteil, spec.titel || 'Fortschritt', fortschrittText(spec.wert, spec.ziel, e)),
      erreicht ? h('p.dg-fs__erreicht', null, icon('<path d="m4.2 10.6 3.9 3.9 7.7-8.9"/>'), text('Ziel erreicht')) : null);
  }
  return h('ul.dg-fs.dg-fs--liste', null, spec.teile.map((t) => {
    const ziel = t.ziel || spec.ziel;
    const anteil = t.wert / ziel;
    return h('li.dg-fs__zeile', null,
      h('div.dg-fs__kopf', null,
        h('span.dg-fs__name', null, text(t.name)),
        h('span.dg-fs__stand', null,
          h('span.dg-fs__von', null, text(`${zahlText(t.wert, { einheit: '' })} / ${zahlText(ziel, { einheit: e })}`)),
          h('span.dg-fs__prozent', null, text(prozentText(anteil))),
          anteil >= 1 ? h('span.dg-fs__haken', { title: 'Ziel erreicht', 'aria-label': 'Ziel erreicht', role: 'img' }, icon('<path d="m4.2 10.6 3.9 3.9 7.7-8.9"/>')) : null)),
      spur(anteil, t.name, fortschrittText(t.wert, ziel, e)));
  }));
}

/* ------------------------------------------------------------------ */
/* Tabelle                                                              */
/* ------------------------------------------------------------------ */

function tabelleAus(spec, { versteckt = false, beschriftung = 'Daten' } = {}) {
  const { kopf, zeilen, fuss } = datenZeilen(spec);
  const tabelle = h(versteckt ? 'table' : 'table.md-table.table', null,
    versteckt ? h('caption', null, text(beschriftung)) : null,
    h('thead', null, h('tr', null, kopf.map((k) => h('th', { scope: 'col' }, text(k))))),
    h('tbody', null, zeilen.map((z) => h('tr', null, z.map((c, i) => (i === 0 ? h('th', { scope: 'row' }, text(c)) : h('td', null, text(c))))))),
    fuss ? h('tfoot', null, h('tr', null, fuss.map((c, i) => (i === 0 ? h('th', { scope: 'row' }, text(c)) : h('td', null, text(c)))))) : null);
  return versteckt ? h('div.dg-nur-leser', null, tabelle) : h('div.md-table-wrap', null, tabelle);
}

/* ------------------------------------------------------------------ */
/* Der Baustein                                                         */
/* ------------------------------------------------------------------ */

let zaehler = 0;
const jetzt = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * Ein Diagramm zeichnen.
 *
 * @param {object} spec Ergebnis von `pruefen()` (ueber bausteine/index.js: `typ` ist dann dabei)
 * @param {object} [b] das Baustein-Objekt aus web/lib/bausteine/index.js (`ansicht`, `key`,
 *   `beiNeubau`); allein aufgerufen genuegt nichts -- dann lebt der Zustand im Element.
 * @returns {HTMLElement} `figure.dg`
 */
export function render(spec, b = {}) {
  ensureStyle(BS_STYLE_ID, BS_CSS);
  ensureStyle(STYLE_ID, CSS);
  const a = b && b.ansicht && typeof b.ansicht === 'object' ? b.ansicht : {};
  const key = b && typeof b.key === 'function' ? b.key : () => null;
  const m = modellAus(spec);
  const kreisArt = m.art === 'kreis' || m.art === 'ring';
  zaehler += 1;
  const nr = zaehler;

  if (!Array.isArray(a.aus)) a.aus = [];
  if (a.einStart === undefined) a.einStart = jetzt();

  const root = h('figure.dg', { dataset: { art: m.art } });
  if (spec.titel || (m.einheit && m.einheit !== '%' && !kreisArt && m.art !== 'fortschritt')) {
    root.appendChild(h('figcaption.bs-kopf.dg-kopf', null,
      spec.titel ? h('p.bs-titel', null, inline(spec.titel)) : h('span'),
      m.einheit && m.einheit !== '%' && !kreisArt && m.art !== 'fortschritt' ? h('span.bs-meta', null, text(`in ${m.einheit}`)) : null));
  }
  const legendenPlatz = h('div.dg-legendenplatz');
  const buehnenPlatz = h('div.dg-buehnenplatz');
  const live = h('p.dg-nur-leser', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  root.append(legendenPlatz, buehnenPlatz, live);

  const mitTabelle = !(m.art === 'fortschritt' && !spec.teile);
  const umschalter = mitTabelle ? knopf(a.tabelle ? 'Als Diagramm' : 'Als Tabelle', {
    art: 'leise',
    klasse: 'dg-umschalter',
    key: key('tabelle'),
    attrs: { 'aria-pressed': a.tabelle ? 'true' : 'false' },
    onClick: () => {
      a.tabelle = !a.tabelle;
      zeichnen();
    },
  }) : null;
  if (spec.quelle || umschalter) {
    root.appendChild(h('div.dg-fuss', null,
      spec.quelle ? h('p.dg-quelle', null, text('Quelle: '), inline(spec.quelle)) : h('span'),
      umschalter));
  }

  let aktiv = null;
  let plot = null;
  let tip = null;
  let aufraeumen = [];

  function sichtbareSerien() {
    const ser = m.serien.filter((s) => !a.aus.includes(s.i));
    if (!ser.length) {
      a.aus = [];
      return m.serien.slice();
    }
    return ser;
  }
  function sichtbareStuecke() {
    const alle = m.stuecke.map((t, d) => ({ ...t, d }));
    const ser = alle.filter((t) => !a.aus.includes(t.d));
    if (!ser.some((t) => t.wert > 0)) {
      a.aus = [];
      return alle;
    }
    return ser;
  }

  /* -- Legende: ein Knopf je Reihe, blendet aus und ein -- */
  function legendeBauen() {
    // In der Tabelle stehen alle Reihen als Spalten; eine Legende, die dort
    // nichts ausblendet, waere eine Attrappe.
    if (kreisArt || m.art === 'fortschritt' || m.serien.length < 2 || (a.tabelle && mitTabelle)) {
      legendenPlatz.replaceChildren();
      return;
    }
    const sichtbar = m.serien.filter((s) => !a.aus.includes(s.i)).length;
    const linie = m.art === 'linie';
    legendenPlatz.replaceChildren(h('div.dg-legende', { role: 'group', 'aria-label': 'Reihen ein- und ausblenden' },
      m.serien.map((s) => {
        const an = !a.aus.includes(s.i);
        const letzte = an && sichtbar === 1;
        return h('button.dg-leg', {
          type: 'button',
          'aria-pressed': an ? 'true' : 'false',
          'aria-disabled': letzte ? 'true' : null,
          title: letzte ? 'Mindestens eine Reihe bleibt sichtbar' : (an ? 'Ausblenden' : 'Einblenden'),
          'data-key': key(`leg:${s.i}`),
          class: farbKlasse(s.i),
          onClick: (e) => {
            e.stopPropagation();
            if (letzte) return;
            a.aus = an ? [...a.aus, s.i] : a.aus.filter((x) => x !== s.i);
            zeichnen();
          },
          onPointerenter: () => { if (plot && an && aktiv === null) plot.hervorheben(s.i); },
          onPointerleave: () => { if (plot) plot.hervorheben(null); },
          onFocus: () => { if (plot && an) plot.hervorheben(s.i); },
          onBlur: () => { if (plot) plot.hervorheben(null); },
        }, h('span.dg-leg__farbe', { class: linie ? 'is-linie' : null, 'aria-hidden': 'true' }), h('span.dg-leg__name', null, text(s.name)));
      })));
  }

  /* -- Tooltip und Zeigen -- */
  function tipZeigen(info, touch) {
    if (!tip || !info) return;
    fuellen(tip,
      info.kopf ? h('p.dg-tip__kopf', null, text(info.kopf)) : null,
      info.zeilen.map((z) => h('p.dg-tip__zeile', { class: farbKlasse(z.slot) },
        h('span.dg-tip__schluessel', { 'aria-hidden': 'true' }),
        h('strong.dg-tip__wert', null, text(z.wert)),
        z.name ? h('span.dg-tip__name', null, text(z.name)) : null)));
    tip.hidden = false;
    const buehne = tip.parentElement;
    const B = buehne ? buehne.clientWidth : 0;
    const w = tip.offsetWidth;
    const hh = tip.offsetHeight;
    let links = info.x + 14;
    if (links + w > B) links = info.x - 14 - w;
    if (links < 0) links = Math.max(0, Math.min(B - w, info.x - w / 2));
    let oben = info.y - hh - (touch ? 30 : 12);
    if (oben < -8) oben = info.y + (touch ? 30 : 16);
    tip.style.transform = `translate(${Math.round(links)}px, ${Math.round(oben)}px)`;
  }

  function setze(ziel, { touch = false, ansagen = false } = {}) {
    aktiv = ziel;
    if (!plot) return;
    plot.markieren(ziel);
    if (ziel === null) {
      if (tip) tip.hidden = true;
      return;
    }
    const info = plot.info(ziel);
    if (!info) return;
    if (!plot.ring) tipZeigen(info, touch);
    if (ansagen) live.textContent = `${info.kopf}: ${info.zeilen.map((z) => `${z.name ? `${z.name} ` : ''}${z.wert}`).join(', ')}`;
  }

  function verdrahten(buehne) {
    const pos = (e) => {
      const r = plot.svg.getBoundingClientRect();
      const sx = r.width ? (plot.svg.viewBox.baseVal.width || r.width) / r.width : 1;
      return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sx];
    };
    let beruehrt = false;
    const draussen = (e) => {
      if (!buehne.isConnected || !buehne.contains(e.target)) {
        setze(null);
        document.removeEventListener('pointerdown', draussen, true);
      }
    };
    buehne.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' && !beruehrt) return;
      const z = plot.treffer(...pos(e));
      if (z !== aktiv) setze(z, { touch: e.pointerType !== 'mouse' });
    });
    buehne.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') setze(null);
    });
    buehne.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      beruehrt = true;
      const z = plot.treffer(...pos(e));
      // Noch einmal auf dieselbe Stelle tippen schliesst den Wert wieder.
      setze(z === aktiv ? null : z, { touch: true });
      if (aktiv !== null) document.addEventListener('pointerdown', draussen, true);
    });
    const loslassen = () => { beruehrt = false; };
    buehne.addEventListener('pointerup', loslassen);
    buehne.addEventListener('pointercancel', loslassen);
    // Ein Tippen ins Diagramm ist Bedienung, kein Antippen der Nachricht
    // (das schaltet im Chat die Aktionsleiste um).
    buehne.addEventListener('click', (e) => e.stopPropagation());
    buehne.addEventListener('focus', () => {
      if (!buehne.matches(':focus-visible')) return;
      const reihe = plot.ordnung;
      if (reihe.length) setze(aktiv !== null && reihe.includes(aktiv) ? aktiv : reihe[0], { ansagen: true });
    });
    buehne.addEventListener('blur', () => setze(null));
    buehne.addEventListener('keydown', (e) => {
      const reihe = plot.ordnung;
      if (!reihe.length) return;
      const i = aktiv === null ? -1 : reihe.indexOf(aktiv);
      let neu = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') neu = reihe[Math.min(reihe.length - 1, i + 1)];
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') neu = reihe[Math.max(0, i - 1)];
      else if (e.key === 'Home') neu = reihe[0];
      else if (e.key === 'End') neu = reihe[reihe.length - 1];
      else if (e.key === 'Escape' && aktiv !== null) {
        e.preventDefault();
        e.stopPropagation();
        setze(null);
        return;
      } else return;
      e.preventDefault();
      setze(neu, { ansagen: true });
    });
    aufraeumen.push(() => document.removeEventListener('pointerdown', draussen, true));
  }

  /* -- Alles zeichnen (bei Breite, Legende, Tabelle) -- */
  function zeichnen() {
    for (const fn of aufraeumen.splice(0)) {
      try { fn(); } catch { /* weiter */ }
    }
    const verstrichen = jetzt() - a.einStart;
    root.classList.toggle('is-ein', verstrichen < EIN_MS);
    root.style.setProperty('--dg-verzug', `${-Math.round(Math.max(0, verstrichen))}ms`);
    const B = Math.max(160, Math.floor(a.breite || 568));
    plot = null;
    tip = null;
    const vorher = aktiv;
    aktiv = null;
    try {
      legendeBauen();
      if (umschalter) {
        umschalter.querySelector('span').textContent = a.tabelle ? 'Als Diagramm' : 'Als Tabelle';
        umschalter.setAttribute('aria-pressed', a.tabelle ? 'true' : 'false');
      }
      if (a.tabelle && mitTabelle) {
        const wrap = tabelleAus(spec);
        buehnenPlatz.replaceChildren(wrap);
        tabelleVerbessern(wrap, { schluessel: `dg:${key('t') || nr}`, beschriftung: spec.titel || 'Daten' });
        return;
      }
      const versteckt = mitTabelle ? tabelleAus(spec, { versteckt: true, beschriftung: spec.titel || ART_NAMEN[m.art] }) : null;
      if (m.art === 'fortschritt') {
        fuellen(buehnenPlatz, zeichneFortschritt(spec), versteckt);
        return;
      }
      tip = h('div.dg-tip', { hidden: true, 'aria-hidden': 'true' });
      const buehne = h('div.dg-flaeche', {
        tabindex: '0',
        'aria-label': 'Werte ansehen: Pfeiltasten wechseln',
        'data-key': key('flaeche'),
      });
      if (kreisArt) {
        const schmal = B < 440;
        const D = Math.round(schmal ? Math.min(200, B - 24) : Math.min(200, B * 0.4));
        plot = zeichneKreis(m, sichtbareStuecke(), D);
        plot.svg.setAttribute('role', 'img');
        plot.svg.setAttribute('aria-label', beschreibung(spec));
        buehne.append(plot.svg, tip);
        fuellen(buehnenPlatz, h('div.dg-kreis', { class: schmal ? 'is-schmal' : null }, buehne, teileListe()), versteckt);
      } else {
        const ser = sichtbareSerien();
        plot = m.art === 'balken' ? zeichneBalken(m, ser, B) : (m.art === 'linie' || m.art === 'flaeche') ? zeichneLinien(m, ser, B) : zeichneSaeulen(m, ser, B);
        plot.svg.setAttribute('role', 'img');
        plot.svg.setAttribute('aria-label', beschreibung(spec));
        buehne.append(plot.svg, tip);
        fuellen(buehnenPlatz, buehne, versteckt);
      }
      verdrahten(buehne);
      if (vorher !== null && plot.ordnung.includes(vorher)) setze(vorher);
    } catch (err) {
      if (typeof console !== 'undefined') console.error('[diagramm]', err);
      buehnenPlatz.replaceChildren(h('p.bs-fehler', { role: 'alert' }, text('Das Diagramm ließ sich nicht zeichnen.')));
    }
  }

  /* -- Die Legende eines Kreises: Name, Wert, Anteil; Tippen blendet aus -- */
  function teileListe() {
    const summe = m.stuecke.filter((t, d) => !a.aus.includes(d)).reduce((s, t) => s + t.wert, 0) || 1;
    const sichtbar = m.stuecke.filter((t, d) => !a.aus.includes(d) && t.wert > 0).length;
    return h('ul.dg-teile', { role: 'list', 'aria-label': 'Teile ein- und ausblenden' }, m.stuecke.map((t, d) => {
      const an = !a.aus.includes(d);
      const letzte = an && sichtbar === 1 && t.wert > 0;
      return h('li', null, h('button.dg-teil', {
        type: 'button',
        class: farbKlasse(t.farbe),
        'aria-pressed': an ? 'true' : 'false',
        'aria-disabled': letzte ? 'true' : null,
        title: t.andere ? t.andere.join(', ') : (letzte ? 'Mindestens ein Teil bleibt sichtbar' : (an ? 'Ausblenden' : 'Einblenden')),
        'data-key': key(`teil:${d}`),
        onClick: (e) => {
          e.stopPropagation();
          if (letzte) return;
          a.aus = an ? [...a.aus, d] : a.aus.filter((x) => x !== d);
          zeichnen();
        },
        onPointerenter: () => { if (plot && an) plot.markieren(d); },
        onPointerleave: () => { if (plot) plot.markieren(aktiv); },
        onFocus: () => { if (plot && an) plot.markieren(d); },
        onBlur: () => { if (plot) plot.markieren(aktiv); },
      },
      h('span.dg-leg__farbe', { 'aria-hidden': 'true' }),
      h('span.dg-teil__name', null, text(t.name)),
      h('span.dg-teil__wert', null, text(zahlText(t.wert, { einheit: m.einheit, kompakt: t.wert >= 1e6 }))),
      h('span.dg-teil__anteil', null, text(an ? (m.einheit === '%' ? '' : prozentText(t.wert / summe)) : 'aus'))));
    }));
  }

  zeichnen();

  // Breite messen und bei Aenderung neu anlegen. Der erste Aufruf kommt,
  // sobald das Element im Dokument steht -- vor dem ersten Bild, also ohne
  // sichtbaren Sprung.
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      if (!root.isConnected) {
        ro.disconnect();
        return;
      }
      const w = Math.floor(root.clientWidth);
      if (w > 0 && Math.abs(w - (a.breite || 0)) >= 1) {
        a.breite = w;
        zeichnen();
      }
    });
    ro.observe(root);
    if (b && typeof b.beiNeubau === 'function') b.beiNeubau(() => ro.disconnect());
  }
  if (b && typeof b.beiNeubau === 'function') b.beiNeubau(() => { for (const fn of aufraeumen.splice(0)) fn(); });
  return root;
}

/**
 * Die Anmeldung fuer web/lib/bausteine/index.js:
 *   import { typen as diagrammTypen } from '../diagramm.js';
 */
export const typen = {
  diagramm: {
    pruefen,
    render,
    text: textFassung,
    name: 'Diagramm',
  },
};

/* ------------------------------------------------------------------ */
/* Aussehen                                                             */
/* ------------------------------------------------------------------ */

/*
 * Die Reihenfarben. Reihe 1 ist der Akzent der App (var(--accent)); die
 * weiteren sind die gepruefte Reihenfolge der dataviz-Anleitung (Orange,
 * Aqua, Gelb, Magenta, Gruen), je Modus eigene Stufen. Geprueft mit
 * scripts/validate_palette.js der Anleitung:
 *   hell  gegen #ffffff: Band, Buntheit, Farbfehlsicht (min. 9,1) und
 *         Normalsicht (min. 19,6) bestanden; Kontrast < 3:1 bei Aqua, Gelb,
 *         Magenta -> Tabelle und Beschriftungen sind der Ausgleich.
 *   dunkel gegen #101112: alles bestanden (Farbfehlsicht min. 8,4).
 * Die Statusfarben (--ok, --warn, --danger) sind fuer Zustaende reserviert und
 * nie eine Reihe. "Andere" ist grau.
 */
const HELL = '--dg-2: #eb6834; --dg-3: #1baf7a; --dg-4: #eda100; --dg-5: #e87ba4; --dg-6: #008300;';
const CSS = `
.dg { --dg-1: var(--accent); --dg-2: #d95926; --dg-3: #199e70; --dg-4: #c98500; --dg-5: #d55181; --dg-6: #008300; --dg-andere: var(--fg-subtle); --dg-grund: var(--surface); --dg-verzug: 0ms; display: block; min-width: 0; margin: 0; }
:root[data-theme="light"] .dg { ${HELL} }
@media (prefers-color-scheme: light) { :root[data-theme="system"] .dg { ${HELL} } }
.dg-r0 { --dg-f: var(--dg-1); } .dg-r1 { --dg-f: var(--dg-2); } .dg-r2 { --dg-f: var(--dg-3); }
.dg-r3 { --dg-f: var(--dg-4); } .dg-r4 { --dg-f: var(--dg-5); } .dg-r5 { --dg-f: var(--dg-6); } .dg-rx { --dg-f: var(--dg-andere); }
.dg-kopf { margin-bottom: 10px; }
.dg-legendenplatz:empty { display: none; }
.dg-legende { display: flex; flex-wrap: wrap; gap: 2px 4px; margin: -4px 0 8px -8px; }
.dg-leg { display: inline-flex; align-items: center; gap: 7px; min-height: 28px; padding: 0 8px; font: inherit; font-size: var(--fs-sm); color: var(--fg); background: none; border: 0; border-radius: var(--r-1); cursor: pointer; transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease); -webkit-tap-highlight-color: transparent; }
.dg-leg:hover { background: var(--surface-3); }
.dg-leg:focus-visible, .dg-teil:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.dg-leg[aria-pressed="false"], .dg-teil[aria-pressed="false"] { color: var(--fg-subtle); }
.dg-leg[aria-disabled="true"], .dg-teil[aria-disabled="true"] { cursor: default; }
.dg-leg__farbe { flex: none; width: 10px; height: 10px; border-radius: 3px; background: var(--dg-f); }
.dg-leg__farbe.is-linie { width: 14px; height: 3px; border-radius: 2px; }
[aria-pressed="false"] > .dg-leg__farbe { background: none; box-shadow: inset 0 0 0 1.5px var(--dg-f); opacity: 0.6; }
[aria-pressed="false"] > .dg-leg__farbe.is-linie { box-shadow: none; background: var(--dg-f); opacity: 0.35; }
.dg-flaeche { position: relative; min-width: 0; border-radius: var(--r-1); touch-action: pan-y; -webkit-tap-highlight-color: transparent; -webkit-user-select: none; user-select: none; }
.dg-flaeche:focus { outline: none; }
.dg-flaeche:focus-visible { box-shadow: 0 0 0 3px var(--accent-ring); }
.dg-svg { display: block; max-width: 100%; height: auto; overflow: visible; font-family: inherit; }
.dg-text { font-size: ${SCHRIFT}px; fill: var(--fg-muted); font-variant-numeric: tabular-nums; }
.dg-wert { font-weight: 500; }
.dg-name { font-size: 13px; fill: var(--fg); font-variant-numeric: normal; }
.dg-mitte { font-weight: 600; fill: var(--fg); letter-spacing: -0.01em; }
.dg-gitter { stroke: var(--border); stroke-width: 1; shape-rendering: crispEdges; }
.dg-basis { stroke: var(--border-strong); stroke-width: 1; shape-rendering: crispEdges; }
.dg-band { fill: var(--fg); fill-opacity: 0.045; }
.dg-mark { transition: opacity var(--dur-2) var(--ease); }
.dg-mark.is-gedimmt { opacity: 0.32; }
.dg-balken { fill: var(--dg-f); }
.dg-linie { fill: none; stroke: var(--dg-f); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.dg-flaechen { fill: var(--dg-f); fill-opacity: 0.12; stroke: none; }
.dg-einzel { fill: var(--dg-f); }
.dg-punkt { fill: var(--dg-f); stroke: var(--dg-grund); stroke-width: 2; }
.dg-stueck { fill: var(--dg-f); stroke: var(--dg-grund); stroke-width: 2; stroke-linejoin: round; }
.dg-stueck.is-allein { stroke: none; }
.dg-kreuz { stroke: var(--fg-subtle); stroke-width: 1; shape-rendering: crispEdges; }
.dg-schwebe { pointer-events: none; }
.dg-tip { position: absolute; left: 0; top: 0; z-index: 5; min-width: 112px; max-width: 250px; padding: 8px 11px 7px; font-size: var(--fs-sm); line-height: 1.45; color: var(--fg); background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--r-2); box-shadow: var(--shadow-2); pointer-events: none; }
.dg-tip[hidden] { display: none; }
.dg-tip__kopf { margin: 0 0 3px; font-size: var(--fs-xs); color: var(--fg-muted); white-space: nowrap; }
.dg-tip__zeile { display: flex; align-items: center; gap: 8px; margin: 0; white-space: nowrap; }
.dg-tip__schluessel { flex: none; width: 12px; height: 3px; border-radius: 2px; background: var(--dg-f); }
.dg-tip__wert { font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; }
.dg-tip__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--fg-muted); }
.dg-kreis { display: flex; align-items: center; gap: 28px; }
.dg-kreis > .dg-flaeche { flex: none; }
.dg-kreis.is-schmal { flex-direction: column; align-items: stretch; gap: 14px; }
.dg-kreis.is-schmal > .dg-flaeche { align-self: center; }
.dg-teile { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; margin: 0; padding: 0; list-style: none; }
.dg-teil { display: grid; grid-template-columns: auto minmax(0, 1fr) auto 3.4em; align-items: center; gap: 10px; width: 100%; min-height: 32px; padding: 3px 8px; font: inherit; font-size: var(--fs-sm); text-align: left; color: var(--fg); background: none; border: 0; border-radius: var(--r-1); cursor: pointer; transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease); -webkit-tap-highlight-color: transparent; }
.dg-teil:hover { background: var(--surface-3); }
.dg-teil__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dg-teil__wert { color: var(--fg-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dg-teil__anteil { font-weight: 500; text-align: right; font-variant-numeric: tabular-nums; }
[aria-pressed="false"] > .dg-teil__anteil { font-weight: 400; }
.dg-fuss { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
.dg-quelle { min-width: 0; margin: 0; font-size: var(--fs-xs); color: var(--fg-subtle); overflow-wrap: anywhere; }
.dg-quelle a { color: var(--fg-muted); }
.dg .dg-umschalter { flex: none; min-height: 28px; margin-right: -8px; padding: 0 10px; font-size: var(--fs-sm); }
.dg-buehnenplatz .md-table-wrap { margin: 0; }
.dg-nur-leser { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.dg-fs { margin: 0; padding: 0; list-style: none; }
.dg-fs--liste { display: flex; flex-direction: column; gap: 14px; }
.dg-fs__kopf { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.dg-fs__zahlen { min-width: 0; }
.dg-fs__wert { font-size: var(--fs-2xl); font-weight: 600; line-height: 1.1; letter-spacing: -0.02em; color: var(--fg); }
.dg-fs__von { margin-left: 8px; font-size: var(--fs-sm); color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.dg-fs__name { min-width: 0; font-size: var(--fs-base); color: var(--fg); overflow-wrap: anywhere; }
.dg-fs__stand { display: inline-flex; align-items: baseline; gap: 10px; flex: none; }
.dg-fs__stand .dg-fs__von { margin: 0; }
.dg-fs__prozent { font-size: var(--fs-base); font-weight: 500; color: var(--fg); font-variant-numeric: tabular-nums; }
.dg-fs__kopf > .dg-fs__prozent { font-size: var(--fs-md); }
.dg-fs__haken { display: inline-grid; align-self: center; color: var(--ok); }
.dg-fs__haken svg { width: 15px; height: 15px; }
.dg-fs__spur { position: relative; height: 8px; overflow: hidden; background: var(--accent-soft); border-radius: var(--r-full); }
.dg-fs--liste .dg-fs__spur { height: 6px; }
.dg-fs__fuell { position: absolute; inset: 0 auto 0 0; background: var(--accent); border-radius: inherit; }
.dg-fs__erreicht { display: inline-flex; align-items: center; gap: 6px; margin: 10px 0 0; font-size: var(--fs-sm); color: var(--ok); }
.dg-fs__erreicht svg { width: 15px; height: 15px; }

/* Einblenden: einmal, ruhig. --dg-verzug ist negativ, wenn das Diagramm
   waehrend des Einblendens neu gebaut wird (Streaming) -- dann laeuft die
   Bewegung weiter, statt jedes Bild von vorn zu beginnen. */
.dg.is-ein .dg-ein-balken { animation: dg-wachsen-y ${EIN_MS - 80}ms var(--ease) both; animation-delay: var(--dg-verzug); transform-box: fill-box; transform-origin: 50% 100%; }
.dg.is-ein .dg-ein-balken.is-neg { transform-origin: 50% 0%; }
.dg.is-ein .dg-ein-balken.is-waag { animation-name: dg-wachsen-x; transform-origin: 0% 50%; }
.dg.is-ein .dg-ein-balken.is-waag.is-neg { transform-origin: 100% 50%; }
.dg.is-ein .dg-ein-blende { animation: dg-blende ${EIN_MS}ms var(--ease) both; animation-delay: var(--dg-verzug); }
.dg.is-ein .dg-ein-kreis { animation: dg-kreis ${EIN_MS}ms var(--ease) both; animation-delay: var(--dg-verzug); transform-box: fill-box; transform-origin: 50% 50%; }
.dg.is-ein .dg-fs__fuell { animation: dg-wachsen-x ${EIN_MS + 80}ms var(--ease) both; animation-delay: var(--dg-verzug); transform-origin: 0% 50%; }
@keyframes dg-wachsen-y { from { transform: scaleY(0); } to { transform: none; } }
@keyframes dg-wachsen-x { from { transform: scaleX(0); } to { transform: none; } }
@keyframes dg-blende { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes dg-kreis { from { opacity: 0; transform: scale(0.94) rotate(-10deg); } to { opacity: 1; transform: none; } }

@media (pointer: coarse) {
  .dg-leg { min-height: 40px; padding: 0 10px; }
  .dg-teil { min-height: var(--tap-min); }
  .dg .dg-umschalter { min-height: 40px; }
}
@media (prefers-reduced-motion: reduce) {
  .dg.is-ein .dg-ein-balken, .dg.is-ein .dg-ein-blende, .dg.is-ein .dg-ein-kreis, .dg.is-ein .dg-fs__fuell { animation: none; }
  .dg-mark { transition: none; }
}
@media (forced-colors: active) {
  .dg-balken, .dg-stueck, .dg-einzel, .dg-punkt, .dg-leg__farbe, .dg-tip__schluessel { fill: CanvasText; background: CanvasText; }
  .dg-linie { stroke: CanvasText; }
}
`;
