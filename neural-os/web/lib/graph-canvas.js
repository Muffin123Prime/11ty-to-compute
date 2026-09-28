/**
 * graph-canvas.js -- der Zeichner hinter dem "Gehirn".
 *
 * Vorbild ist die Graph-Ansicht von Obsidian (docs/vorlage/gehirn-obsidian.png):
 * tiefschwarzer Grund, kleine runde grau-weisse Punkte, duenne halb
 * durchsichtige Linien, wenige grosse Knoten, unverbundene Knoten als lockerer
 * Ring aussen. Warum diese Datei so gebaut ist:
 *
 * 1. **Ein Knoten ist ein Punkt.** Frueher trug jede Art eine eigene Form
 *    (Raute, Sechseck, Dreieck ...). Auf achthundert Knoten wurde daraus
 *    Kies. Die Art steht jetzt im Filter und im schmalen Panel beim Antippen;
 *    auf der Flaeche zaehlt nur, wie viel an einem Knoten haengt -- und das
 *    liest man an der Groesse.
 * 2. **Ein Akzent.** Blau ist der gewaehlte oder ueberfahrene Knoten und
 *    seine Linien, wie der fokussierte Knoten in docs/vorlage/app.png. Alles
 *    andere ist Grau. Themenfarben gibt es nur, wenn die Ansicht sie
 *    ausdruecklich setzt (setColors) -- gedaempft und abschaltbar.
 * 3. **Physik wie d3-force, ohne d3.** Abstossung ueber einen Barnes-Hut-Baum
 *    (theta 0.9), Federn mit der Staerke 1/min(Grad) -- das ist der Kniff,
 *    der Sterne um einen Hub auffaechert statt sie zu einem Klumpen zu
 *    ziehen --, eine weiche Zentrierung und fuer Waisen eine Ringkraft. Keine
 *    Abhaengigkeit, kein Bauschritt.
 * 4. **Die Wolke kommt zur Ruhe.** `alpha` klingt ab; darunter endet die
 *    Bildschleife ganz. Ein Gehirn, das man offen liegen laesst, kostet dann
 *    keine Rechenzeit -- das hier laeuft auf einem Schullaptop vom Stick.
 * 5. **Gezeichnet wird in Bildschirmpunkten.** Welt-Koordinaten werden von
 *    Hand umgerechnet statt ueber die Canvas-Transformation, damit eine Linie
 *    bei jedem Zoom duenn bleibt und eine Schrift scharf.
 * 6. **Finger zuerst.** Pointer-Events statt Maus-Events: ein Finger zieht und
 *    verschiebt, zwei Finger zoomen, Antippen waehlt, zweimal Antippen
 *    oeffnet, langes Druecken meldet sich (onLongPress). Auf dem iPad ueber
 *    WLAN ist das die ganze Bedienung.
 *
 * Seit dem Wissensuniversum (web/views/graph.js) kann derselbe Zeichner
 * zweierlei zeigen:
 *
 * 7. **Themen-Ebene** (`themen: true`): wenige grosse, ruhige Kreise -- ein
 *    Kreis je Themenbereich, Groesse nach Anzahl, Name in der Mitte,
 *    darunter "42 Eintraege", ein Hauch Farbe je Thema (Saettigung niedrig,
 *    aus den Marken der Oberflaeche gemischt). Die Lage rechnet
 *    `layoutThemen()` deterministisch vor; Physik laeuft dort nicht.
 * 8. **Weicher Aufbau** (`enter()`): Knoten wachsen in Wellen aus dem Nichts,
 *    Linien blenden nach; 600-900 ms, ease-out. Nichts fliegt herum.
 * 9. **Art im Knoten**: ab einem Bildschirmradius von 7 px traegt ein Punkt
 *    ein winziges Symbol seiner Art (Notiz, Projekt, Person, Ort, Begriff,
 *    Datei, Termin ...) in der Farbe des Grundes -- dezent, und nur dann,
 *    wenn man nah genug ist, dass es lesbar waere.
 * 10. **Neue Verbindung**: eine Kante, die zu geladenen Daten dazukommt,
 *    zieht sich in 400 ms vom einen zum anderen Knoten; beide bewegen sich
 *    leicht (nudge), der Rest bleibt stehen.
 * 11. **Zoomschwellen**: wer auf der Themen-Ebene ueber die Schwelle
 *    hineinzoomt, bekommt `onDive(thema)`; wer auf der Netz-Ebene weit
 *    herauszoomt, `onSurface()`. Die Ansicht entscheidet, was das heisst.
 */

/* ------------------------------------------------------------------ */
/* Konstanten                                                          */
/* ------------------------------------------------------------------ */

const TAU = Math.PI * 2;

/** Arten, die als Knoten vorkommen koennen (wie schema.GRAPH_TYPES). */
export const GRAPH_TYPES = ['note', 'chat', 'project', 'task', 'event', 'agent', 'file', 'entity', 'run'];

/**
 * Acht Themen-Toene, keiner davon blau: Blau ist der eine Akzent und heisst
 * "gewaehlt". Der Zeichner mischt sie tief ins Grau der Oberflaeche -- ein
 * Hauch Farbe, kein Anstrich. Der Server nennt nur den Index (0-7).
 */
export const THEME_HUES = ['#5fb8a5', '#d4a857', '#a98bd6', '#8cbc6a', '#d9828f', '#b9b56a', '#cc86c0', '#8e9097'];

/**
 * Index 7 ist neutral (Vertrag G): "Unverbunden" und der Behaelter "Weitere
 * Themen" sind keine Wissensgebiete und tragen kein Themen-Grau mit Ton,
 * sondern das leise Grau der Oberflaeche (Pruefer, Runde 1: der Rest-Kreis
 * war orange-braun wie ein Thema).
 */
export const FARBE_NEUTRAL = 7;

/** Die CSS-Farbe eines Themen-Punkts (Suche, Karte, Detailkarte). */
export function themaFarbeCss(index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= FARBE_NEUTRAL) return i === FARBE_NEUTRAL ? 'var(--fg-subtle)' : `color-mix(in srgb, ${THEME_HUES[0]} 55%, var(--fg-muted))`;
  return `color-mix(in srgb, ${THEME_HUES[i]} 55%, var(--fg-muted))`;
}

/** Themenkreise: Radius in Welt-Einheiten, zwischen diesen beiden Werten. */
export const THEMA_R_MIN = 30;
export const THEMA_R_MAX = 92;

/**
 * Radius eines Themenkreises: Wurzel aus dem Anteil am groessten Thema, damit
 * die Flaeche mit der Anzahl waechst und ein Thema mit 400 Eintraegen nicht
 * das Zehnfache eines Themas mit 40 einnimmt.
 */
export function themaRadius(anzahl, maxAnzahl) {
  const a = Math.max(0, Number(anzahl) || 0);
  const mx = Math.max(1, Number(maxAnzahl) || 1);
  return THEMA_R_MIN + (THEMA_R_MAX - THEMA_R_MIN) * Math.sqrt(Math.min(1, a / mx));
}

/**
 * Die Lage der Themenkreise, deterministisch: gleiche Daten, gleiche Karte.
 * Das groesste Thema in die Mitte, die weiteren der Groesse nach auf eine
 * Spirale; dann 120 Runden Entspannung -- Kreise, die sich ueberlappen,
 * schieben sich auseinander, Themen mit gemeinsamen Eintraegen ruecken
 * leicht zusammen, alles strebt sanft zur Mitte. Kein Zufall im Spiel.
 *
 * @param {Array<{id:string, anzahl:number}>} themen
 * @param {Array<{from:string, to:string, anzahl?:number}>} [links]
 * @returns {Map<string, {x:number, y:number, r:number}>}
 */
export function layoutThemen(themen, links = []) {
  const list = (Array.isArray(themen) ? themen : []).filter((t) => t && typeof t.id === 'string');
  const n = list.length;
  const out = new Map();
  if (!n) return out;
  // `groesse` (falls gesetzt) bestimmt den Radius, `anzahl` sonst; `rand`
  // setzt einen Kreis an den Rand ("Weitere Themen", "Unverbunden"): er ist
  // ein Behaelter, kein Wissensgebiet, und gehoert nicht in die Mitte.
  const groesse = (t) => Number(t.groesse != null ? t.groesse : t.anzahl) || 0;
  const maxA = list.reduce((mx, t) => Math.max(mx, groesse(t)), 1);
  const order = list.map((_, i) => i).sort((p, q) => ((list[p].rand ? 1 : 0) - (list[q].rand ? 1 : 0))
    || (groesse(list[q]) - groesse(list[p])) || (list[p].id < list[q].id ? -1 : 1));
  const r = new Float64Array(n);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const GAP = 28;
  const golden = Math.PI * (3 - Math.sqrt(5));
  order.forEach((i, rank) => {
    r[i] = themaRadius(groesse(list[i]), maxA);
    if (rank === 0) return;
    const a = rank * golden;
    const d = THEMA_R_MAX + r[i] + 58 * Math.sqrt(rank);
    x[i] = Math.cos(a) * d;
    y[i] = Math.sin(a) * d;
  });
  const idx = new Map(list.map((t, i) => [t.id, i]));
  const L = [];
  for (const l of links || []) {
    const a = idx.get(l && l.from);
    const b = idx.get(l && l.to);
    if (a === undefined || b === undefined || a === b) continue;
    L.push([a, b, Math.max(1, Number(l.anzahl) || 1)]);
  }
  const trennen = (staerke) => {
    let ueberlappt = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = x[j] - x[i];
        let dy = y[j] - y[i];
        let d = Math.hypot(dx, dy);
        if (d < 1e-6) {
          dx = jitter(i * 31 + j) * 1000;
          dy = jitter(j * 31 + i) * 1000;
          d = Math.hypot(dx, dy) || 1;
        }
        const want = r[i] + r[j] + GAP;
        if (d >= want) continue;
        ueberlappt++;
        const f = ((want - d) / d) * staerke;
        x[i] -= dx * f;
        y[i] -= dy * f;
        x[j] += dx * f;
        y[j] += dy * f;
      }
    }
    return ueberlappt;
  };
  const ROUNDS = 120;
  for (let it = 0; it < ROUNDS; it++) {
    const t = 1 - it / ROUNDS;
    // Verbundene Themen ruecken zusammen -- deutlich, damit ihre Linie kurz
    // ist und nicht unter fremden Kreisen durchlaeuft (Pruefer, Runde 1).
    for (const [a, b, w] of L) {
      const dx = x[b] - x[a];
      const dy = y[b] - y[a];
      const d = Math.hypot(dx, dy) || 1;
      const want = r[a] + r[b] + GAP * 1.5;
      if (d <= want) continue;
      const f = ((d - want) / d) * 0.06 * Math.max(0.5, Math.min(1, Math.log2(1 + w) / 3));
      x[a] += dx * f;
      y[a] += dy * f;
      x[b] -= dx * f;
      y[b] -= dy * f;
    }
    for (let i = 0; i < n; i++) {
      const sog = list[i].rand ? 0.004 : 0.012;
      x[i] *= 1 - sog * t;
      y[i] *= 1 - sog * t;
    }
    trennen(0.5);
  }
  // Zum Schluss nur noch trennen, ohne Sog zur Mitte, bis kein Kreis mehr
  // einen anderen beruehrt: bei vierzig dicht verbundenen Themen blieben
  // sonst Paare uebereinander liegen, und ihre Namen verdeckten sich.
  for (let it = 0; it < 400; it++) if (!trennen(0.5)) break;
  for (let i = 0; i < n; i++) out.set(list[i].id, { x: x[i], y: y[i], r: r[i] });
  return out;
}

/**
 * Was die Ansicht im Panel verstellen kann. 1 heisst "wie gedacht"; die
 * Regler gehen links und rechts davon. Die Ansicht merkt sich die Werte.
 */
export const GRAPH_DEFAULTS = Object.freeze({
  nodeScale: 1, // Knotengroesse
  linkScale: 1, // Liniendicke
  labelZoom: 1.5, // ab diesem Zoom erscheinen gewoehnliche Beschriftungen
  repel: 1, // Abstossung
  linkDistance: 1, // Federlaenge
  center: 1, // Zentrierung
});

/**
 * Die Physik. Die Zahlen sind am kuenstlichen Tresor mit 800 Knoten in zehn
 * Themen abgestimmt, im Vergleich mit der Vorlage (Bildschirmfotos im
 * Bericht), nicht geraten. Entscheidend ist das Verhaeltnis: lange Federn
 * faechern die Sterne um einen Hub weit auf, eine kraeftige Zentrierung
 * schiebt die Themen zu EINER Wolke zusammen. Mit kurzen Federn und
 * schwacher Mitte (d3-Vorgabe) entstanden enge Knaeuel mit leeren Luecken
 * dazwischen -- "klumpig".
 */
const PHYS = {
  theta2: 0.81,
  charge: -31,
  hubCharge: 0.22, // Hubs stossen staerker ab, damit ihr Stern Platz bekommt
  linkDistance: 85,
  linkStrength: 0.85,
  center: 0.1,
  ring: 0.1,
  velocityDecay: 0.42,
  alphaMin: 0.004,
  maxSpeed: 60,
};
PHYS.alphaDecay = 1 - Math.pow(PHYS.alphaMin, 1 / 300);

/**
 * Uebersicht wie in Obsidian: herausgezoomt tragen nur die groessten
 * verbundenen Knoten einen Namen (und was man ueberfaehrt oder waehlt):
 * die drei groessten immer, der vierte und fuenfte nur, wenn sie mindestens
 * halb so viele Linien haben wie der groesste. Alle anderen blenden erst
 * beim Hineinzoomen ein.
 */
const UEBERSICHT_NAMEN = 5;
const UEBERSICHT_SICHER = 3;

const MIN_ZOOM = 0.04;
const MAX_ZOOM = 6;
const CLICK_SLOP = 5; // so weit darf sich ein Klick bewegen und bleibt ein Klick
const DOUBLE_TAP_MS = 320;
const MOVE_MS = 380;
const FADE_MS = 160; // Hervorheben und Zuruecktreten, wie in Obsidian: kurz, aber sichtbar
const ENTER_MS = 720; // weicher Aufbau eines Bildes (Vision: 600-900 ms, ease-out)
const ENTER_WAVE_MS = 70; // Abstand der vier Wellen: Hubs zuerst, Blaetter zuletzt
const EDGE_GROW_MS = 420; // eine neue Linie zieht sich vom einen zum anderen Knoten
const LONG_PRESS_MS = 480;
const GLYPH_MIN_R = 9; // ab diesem Bildschirmradius traegt ein Punkt sein Art-Symbol (darunter waere es Gekrakel)
const DICHT_AB = 160; // ab so vielen sichtbaren Knoten gelten die Zoomstufen fuer Namen (LOD)
const DIVE_FACTOR = 2.3; // Themen-Ebene: so weit ueber das Eingepasste hinein -> onDive
const SURFACE_FACTOR = 0.42; // Netz-Ebene: so weit unter das Eingepasste heraus -> onSurface
const PAN_CACHE_AB = 1200; // ab so vielen sichtbaren Linien wird beim Ziehen ein Zwischenbild verschoben
const PAN_MARGIN = 0.3; // Rand des Zwischenbilds je Seite, als Anteil der Flaeche

/** "1.234" -- fuer "1.234 Eintraege" unter einem Themennamen. */
function formatCount(value) {
  const nr = Number(value) || 0;
  try {
    return nr.toLocaleString('de-DE');
  } catch {
    return String(nr);
  }
}

function easeOut(t) {
  return t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.pow(1 - t, 3);
}

/* ------------------------------------------------------------------ */
/* Kleine Helfer                                                       */
/* ------------------------------------------------------------------ */

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * Deterministischer kleiner Versatz. Zwei Knoten auf demselben Punkt
 * erzeugen eine Division durch null; Math.random wuerde das beheben, aber
 * jedes Bild ein wenig anders machen -- Fehler hier waeren nicht
 * nachzustellen.
 */
function jitter(seed) {
  let x = (seed * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822507);
  x ^= x >>> 13;
  return ((x >>> 0) / 4294967295 - 0.5) * 2e-3;
}

/**
 * Eine CSS-Farbe ueber die Leinwand selbst normalisieren: fillStyle setzen
 * und zuruecklesen liefert #rrggbb oder rgba(...) -- weniger Code als ein
 * Farbparser, und genau das, was der Browser malen wuerde.
 */
function parseColor(ctx, value, fallback) {
  const raw = String(value || '').trim();
  if (raw) {
    const before = ctx.fillStyle;
    try {
      ctx.fillStyle = '#000000';
      ctx.fillStyle = raw;
      const norm = ctx.fillStyle;
      ctx.fillStyle = before;
      if (typeof norm === 'string') {
        if (norm.startsWith('#')) {
          const n = parseInt(norm.slice(1), 16);
          if (Number.isFinite(n)) return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
        }
        const m = /rgba?\(([^)]+)\)/.exec(norm);
        if (m) {
          const p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
          if (p.length >= 3 && p.every(Number.isFinite)) return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
        }
      }
    } catch {
      ctx.fillStyle = before;
    }
  }
  return { ...fallback };
}

function mix(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1 };
}

function rgba(c, alpha = 1) {
  const a = clamp((c.a === undefined ? 1 : c.a) * alpha, 0, 1);
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a.toFixed(3)})`;
}

function luminance(c) {
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}

function ease(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function clip(label, max) {
  const s = String(label == null ? '' : label).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/* ------------------------------------------------------------------ */
/* Barnes-Hut-Quadtree                                                 */
/* ------------------------------------------------------------------ */

/**
 * Zellen liegen in parallelen typisierten Feldern statt in Objekten, damit
 * das Neubauen sechzigmal pro Sekunde keinen Muell erzeugt. Koerper auf
 * demselben Punkt (oder an der Tiefengrenze) haengen als Kette ueber das
 * `next`-Feld des Aufrufers -- sonst liefe der Aufbau endlos, sobald jemand
 * einen Knoten genau auf einen anderen zieht.
 */
function createQuadtree() {
  const MAX_DEPTH = 24;
  let capacity = 0;
  let count = 0;
  let child = new Int32Array(0);
  let head = new Int32Array(0);
  let charge = new Float64Array(0);
  let accX = new Float64Array(0);
  let accY = new Float64Array(0);
  let centreX = new Float64Array(0);
  let centreY = new Float64Array(0);
  let halfSize = new Float64Array(0);
  let stack = new Int32Array(512);

  function ensure(n) {
    if (n <= capacity) return;
    const next = Math.max(64, n * 2);
    const grow = (arr, Type, factor) => {
      const out = new Type(next * factor);
      out.set(arr);
      return out;
    };
    child = grow(child, Int32Array, 4);
    head = grow(head, Int32Array, 1);
    charge = grow(charge, Float64Array, 1);
    accX = grow(accX, Float64Array, 1);
    accY = grow(accY, Float64Array, 1);
    centreX = grow(centreX, Float64Array, 1);
    centreY = grow(centreY, Float64Array, 1);
    halfSize = grow(halfSize, Float64Array, 1);
    capacity = next;
  }

  function newCell(cx, cy, half) {
    ensure(count + 1);
    const cell = count++;
    const base = cell * 4;
    child[base] = -1;
    child[base + 1] = -1;
    child[base + 2] = -1;
    child[base + 3] = -1;
    head[cell] = -1;
    charge[cell] = 0;
    accX[cell] = 0;
    accY[cell] = 0;
    centreX[cell] = cx;
    centreY[cell] = cy;
    halfSize[cell] = half;
    return cell;
  }

  function reset(cx, cy, half) {
    count = 0;
    newCell(cx, cy, Math.max(half, 1));
  }

  function subdivide(cell) {
    const half = halfSize[cell] / 2;
    const cx = centreX[cell];
    const cy = centreY[cell];
    // newCell kann die Felder neu anlegen: erst alle Kinder, dann eintragen.
    const c0 = newCell(cx - half, cy - half, half);
    const c1 = newCell(cx + half, cy - half, half);
    const c2 = newCell(cx - half, cy + half, half);
    const c3 = newCell(cx + half, cy + half, half);
    const base = cell * 4;
    child[base] = c0;
    child[base + 1] = c1;
    child[base + 2] = c2;
    child[base + 3] = c3;
  }

  function quadrant(cell, x, y) {
    return (x >= centreX[cell] ? 1 : 0) + (y >= centreY[cell] ? 2 : 0);
  }

  function place(startCell, startDepth, index, px, py, q, next, counted) {
    const x = px[index];
    const y = py[index];
    const w = q[index];
    let cell = startCell;
    let depth = startDepth;
    for (;;) {
      if (!counted || cell !== startCell) {
        charge[cell] += w;
        accX[cell] += x * w;
        accY[cell] += y * w;
      }
      if (child[cell * 4] === -1) {
        const other = head[cell];
        if (other === -1) {
          head[cell] = index;
          next[index] = -1;
          return;
        }
        if (depth >= MAX_DEPTH || (Math.abs(px[other] - x) < 1e-6 && Math.abs(py[other] - y) < 1e-6)) {
          next[index] = other;
          head[cell] = index;
          return;
        }
        head[cell] = -1;
        subdivide(cell);
        let moving = other;
        while (moving !== -1) {
          const following = next[moving];
          place(child[cell * 4 + quadrant(cell, px[moving], py[moving])], depth + 1, moving, px, py, q, next, false);
          moving = following;
        }
      }
      cell = child[cell * 4 + quadrant(cell, x, y)];
      depth += 1;
    }
  }

  function insert(index, px, py, q, next) {
    place(0, 0, index, px, py, q, next, false);
  }

  /** Abstossung auf Koerper `index` nach out[0], out[1] (d3: Betrag q/d). */
  function accumulate(index, px, py, q, next, theta2, out) {
    const x = px[index];
    const y = py[index];
    let ax = 0;
    let ay = 0;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const cell = stack[--sp];
      const w = charge[cell];
      if (w === 0) continue;
      const base = cell * 4;
      if (child[base] === -1) {
        let body = head[cell];
        while (body !== -1) {
          if (body !== index) {
            let dx = px[body] - x;
            let dy = py[body] - y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 1) {
              dx += jitter(index * 31 + body);
              dy += jitter(body * 31 + index);
              d2 = Math.max(1, dx * dx + dy * dy);
            }
            const f = q[body] / d2;
            ax += dx * f;
            ay += dy * f;
          }
          body = next[body];
        }
        continue;
      }
      const dx = accX[cell] / w - x;
      const dy = accY[cell] / w - y;
      const d2 = dx * dx + dy * dy;
      const size = halfSize[cell] * 2;
      if (size * size < theta2 * d2) {
        const f = w / (d2 < 1 ? 1 : d2);
        ax += dx * f;
        ay += dy * f;
        continue;
      }
      if (sp + 4 > stack.length) {
        const bigger = new Int32Array(stack.length * 2);
        bigger.set(stack);
        stack = bigger;
      }
      for (let k = 0; k < 4; k++) {
        const c = child[base + k];
        if (c !== -1 && charge[c] !== 0) stack[sp++] = c;
      }
    }
    out[0] = ax;
    out[1] = ay;
  }

  return { reset, insert, accumulate };
}

/* ------------------------------------------------------------------ */
/* Der Zeichner                                                        */
/* ------------------------------------------------------------------ */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{
 *   mini?: boolean,               // Kachel: keine Bedienung, feste Beschriftungen, nach aussen
 *   themen?: boolean,             // Themen-Ebene: grosse Kreise mit Namen, keine Physik
 *   onSelect?: (node:object|null) => void,
 *   onOpen?: (node:object) => void,
 *   onHover?: (node:object|null) => void,
 *   onLongPress?: (node:object) => void, // Finger bleibt auf einem Knoten liegen
 *   onDive?: (node:object) => void,      // Themen-Ebene: ueber die Schwelle hineingezoomt
 *   onSurface?: () => void,              // Netz-Ebene: unter die Schwelle herausgezoomt
 *   onSettle?: () => void,         // die Wolke ruht, die Bildschleife steht
 *   onWake?: () => void,           // sie bewegt sich wieder (Ziehen, Filter, neue Daten)
 *   onUserMove?: () => void,       // der Mensch hat die Kamera bewegt
 * }} [options]
 *
 * Rueckgabe: setData, setFilter, setOrphans, pin, setHighlight, setColors,
 * setSettings, setLabels, setSelection, setPadding, refreshTheme, prewarm,
 * reheat, enter, nudge, addEdge, fitToView, focus, zoomBy, resize,
 * screenPosition, neighbours, neighbourhood, nodeAtScreen, stats, freeze,
 * stopFollowing, destroy; Getter transform, settings, selectedId, fitZoom.
 */
export function createGraphCanvas(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new TypeError('createGraphCanvas(): ein <canvas>-Element wird benötigt.');
  }
  // `let`, nicht `const`: beim Ziehen zeichnet drawFromPanCache dieselbe Szene
  // einmal in eine zweite Leinwand und tauscht dafuer kurz den Kontext.
  let ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('createGraphCanvas(): 2D-Kontext nicht verfügbar.');

  const mini = !!options.mini;
  const themen = !!options.themen;
  const interactive = !mini;
  const emit = (name, ...args) => {
    const fn = options[name];
    if (typeof fn !== 'function') return;
    try {
      fn(...args);
    } catch (err) {
      console.error(`[gehirn] ${name} ist gescheitert:`, err);
    }
  };

  /* ---------------------------- Daten ------------------------------ */

  let nodes = [];
  let index = new Map();
  let n = 0;
  let edgeA = new Int32Array(0);
  let edgeB = new Int32Array(0);
  let m = 0;

  let posX = new Float64Array(0);
  let posY = new Float64Array(0);
  let velX = new Float64Array(0);
  let velY = new Float64Array(0);
  let fixed = new Uint8Array(0);
  let fixX = new Float64Array(0);
  let fixY = new Float64Array(0);
  let degree = new Int32Array(0); // alle Verbindungen im geladenen Netz
  let visDegree = new Int32Array(0); // nur die sichtbaren
  let visible = new Uint8Array(0);
  let orphan = new Uint8Array(0);
  let radius = new Float64Array(0);
  let charge = new Float64Array(0);
  let chain = new Int32Array(0);
  let sx = new Float64Array(0); // Bildschirmposition des letzten Bildes
  let sy = new Float64Array(0);
  let bright = new Uint8Array(0); // 1 = im Licht, 0 = tritt zurueck
  let colorKey = new Int16Array(0); // Themenfarbe je Knoten, -1 = keine
  let labelOrder = new Int32Array(0); // wichtigste zuerst
  let topSlots = new Set(); // die groessten verbundenen, sichtbaren Knoten (UEBERSICHT_NAMEN)
  let labelWidthCache = [];
  let labelFontCache = 0;
  let edgeStrength = new Float64Array(0);
  let edgeBias = new Float64Array(0);
  let edgeVisible = new Uint8Array(0);
  let edgeWeight = new Float64Array(0); // Themen-Ebene: wie viele Eintraege zwei Themen teilen
  let edgeBorn = new Float64Array(0); // Zeitpunkt, zu dem eine Linie dazukam (0 = schon immer da)
  let growingUntil = 0; // solange zieht sich noch eine neue Linie
  let adjStart = new Int32Array(1);
  let adjList = new Int32Array(0);
  let outside = new Uint8Array(0); // Ebene 1: Nachbar ausserhalb des Themas (ausserhalb: true)
  let labelRank = new Int32Array(0); // Platz in labelOrder: 0 = groesster Knoten
  let maxAnzahl = 1; // Themen-Ebene: das groesste Thema
  let visibleCount = 0; // sichtbare Knoten -- ein kleines Netz traegt alle Namen
  let enterStart = 0; // weicher Aufbau: Beginn in performance.now(), 0 = keiner
  let frameNow = 0;
  let padding = { top: 48, right: 48, bottom: 48, left: 48 }; // Rand beim Einpassen
  let levelArmed = true; // Zoomschwelle: einmal melden, dann erst wieder nach dem Zurueck
  // Nach einem Ebenenwechsel gehoert der Rest der Radbewegung noch zur alten
  // Geste: sie wird verschluckt, bis das Rad ~260 ms ruht (Pruefer, Runde 1:
  // derselbe Zug zoomte das neue Netz sonst bis x5,6 weiter).
  let schluckenSeit = 0;
  // Bereiche (Unterthemen) auf Ebene 1: [{id, name, anzahl, ids, slots}]
  let regionSpec = [];
  let regions = [];
  let regionOf = new Int32Array(0); // erster Bereich je Knoten, -1 = keiner
  let hoveredRegion = -1;
  let regionArmed = true;
  let regionGeoCache = null;

  let structure = '';
  /**
   * Beim Nachladen mit wenigen neuen Knoten duerfen sich nur diese und ihre
   * direkten Nachbarn bewegen. Die Karte, die der Mensch gerade ansieht,
   * bleibt stehen -- eine neue Notiz soll dazukommen, nicht alles umwerfen.
   */
  let mobile = null;
  let pendingColors = null; // zuletzt gesetzte Themenfarben, fuer Theme-Wechsel und Nachladen
  let filterFn = null;
  let showOrphans = true;
  let settings = { ...GRAPH_DEFAULTS };
  let colors = []; // gedaempfte Themenfarben als rgba-Strings
  let alwaysLabel = null; // Set<id> -- Kachel: diese immer beschriften
  let ringIds = null; // Set<id> -- Kachel: diese mit Ring
  // Der Rest tritt auf ein Viertel zurueck (Vision: "Rest auf 25 % Deckkraft").
  let dimAlpha = mini ? 0.42 : themen ? 0.3 : 0.25;

  // Zwei Baeume: die verbundene Wolke und der Ring der Waisen. Getrennt,
  // weil die gesammelte Abstossung von achthundert Knoten die Waisen sonst
  // weit hinaus draengt -- der Ring laege dann verloren am Rand.
  const tree = createQuadtree();
  const orphanTree = createQuadtree();
  const forceOut = new Float64Array(2);

  /* ---------------------------- Ansicht ---------------------------- */

  let transform = { x: 0, y: 0, k: 1 };
  let width = 0;
  let height = 0;
  let dpr = 1;

  let alpha = 0;
  let alphaTarget = 0;
  let settledOnce = false;
  let ringRadius = 0;
  let ringCentreX = 0;
  let ringCentreY = 0;
  let tickCount = 0;

  let rafId = 0;
  let lastFrame = 0;
  let destroyed = false;

  let selected = -1;
  let hovered = -1;
  let highlightSet = null; // Set<slot> aus der Suche
  let focusSlot = -1; // der Knoten, um den gerade das Licht faellt
  let fade = 0; // 0..1: wie weit der Rest zurueckgetreten ist
  let fadeTarget = 0;
  // null heisst "neu berechnen"; '' heisst "kein Licht". Beides mit ''
  // auszudruecken hat das Ausschalten des Suchlichts verschluckt.
  let brightKey = null;

  let animation = null; // {from, to, start, duration}
  let autoFit = false; // die Kamera folgt der Wolke, bis jemand selbst eingreift

  let palette = null;
  let fontFamily = 'system-ui, sans-serif';

  let tickMs = 0;
  let drawMs = 0;

  let api = null;

  /* ---------------------------- Pan-Zwischenbild ------------------- */
  // Beim Ziehen aendert sich nur der Ausschnitt. Steht die Wolke still und
  // ist das Netz dicht, wird das Bild EINMAL mit Rand in eine zweite
  // Leinwand gezeichnet und danach je Bild nur verschoben. Gemessen ohne
  // GPU (Software-Raster, 2.000 Knoten, 4.000 Linien, hineingezoomt):
  // 200 ms je Bild gezeichnet, 2 ms verschoben -- 6 statt 60 Bilder/s.
  // Das Zwischenbild ist die UNBELEUCHTETE Szene. Licht (ueberfahren,
  // gewaehlt, Suchtreffer) liegt darueber: das Bild mit der Deckkraft des
  // Zuruecktretens, darauf nur die hellen Knoten, ihre Linien und Namen.
  // So kostet auch das Ueberfahren in einem dichten Netz nur den kleinen
  // Teil, der sich aendert.
  let panCache = null; // {canvas, k, x, y, mx, my, key}
  let panCanvas = null;
  let sceneVersion = 0; // steigt, wenn sich etwas anderes als Ausschnitt oder Licht aendert
  let overlayOnly = false; // die Zeichenfunktionen malen nur, was im Licht steht
  let lastDrawK = 0; // Zoom des letzten Bildes: das Zwischenbild entsteht erst, wenn er steht

  /* ---------------------------- Farben ----------------------------- */

  /** Die Farbe, auf der die Leinwand liegt: der erste Vorfahr, der malt. */
  function resolveGround(fallback) {
    let el = canvas;
    for (let step = 0; step < 12 && el && el.nodeType === 1; step++) {
      let value = '';
      try {
        value = getComputedStyle(el).backgroundColor;
      } catch {
        value = '';
      }
      const c = parseColor(ctx, value, { r: 0, g: 0, b: 0, a: 0 });
      if (c.a > 0.9) return { r: c.r, g: c.g, b: c.b, a: 1 };
      el = el.parentElement;
    }
    return fallback;
  }

  function readPalette() {
    const cs = getComputedStyle(canvas);
    const prop = (name) => cs.getPropertyValue(name).trim();
    const fg = parseColor(ctx, prop('--fg'), { r: 238, g: 238, b: 240, a: 1 });
    const token = parseColor(ctx, prop('--bg'), { r: 9, g: 10, b: 10, a: 1 });
    const ground = resolveGround(token);
    const dark = luminance(ground) < 0.5;
    const muted = parseColor(ctx, prop('--fg-muted'), { r: 164, g: 166, b: 172, a: 1 });
    const accent = parseColor(ctx, prop('--accent'), { r: 47, g: 124, b: 246, a: 1 });
    const accentText = parseColor(ctx, prop('--accent-text'), accent);
    fontFamily = cs.fontFamily || fontFamily;

    // Alles Grau ist eine Mischung aus Grund und Schrift. Dadurch stimmt der
    // Abstand zum Grund in beiden Darstellungen, ohne zweite Farbtabelle.
    const nodeLo = mix(ground, fg, dark ? 0.66 : 0.52);
    const nodeHi = mix(ground, fg, dark ? 0.86 : 0.82);
    const tiers = [0, 1, 2, 3].map((t) => mix(nodeLo, nodeHi, t / 3));
    palette = {
      dark,
      ground,
      fg,
      muted,
      accent,
      accentText,
      tiers: tiers.map((c) => rgba(c)),
      line: mix(ground, fg, dark ? 0.42 : 0.4),
      lineAlpha: dark ? 0.7 : 0.6,
      label: rgba(mix(ground, fg, mini ? 0.8 : dark ? 0.66 : 0.7)),
      ringFill: rgba(mix(ground, fg, 0.9)),
      labelStrong: rgba(fg),
      halo: rgba(ground, 0.82),
      ring: rgba(mix(ground, fg, dark ? 0.34 : 0.3)),
      accentFill: rgba(accent),
      accentGlow: rgba(accent, dark ? 0.22 : 0.16),
      accentLine: rgba(accent, 0.85),
      // Linien im Licht: der Akzent, aber ins Liniengrau gemischt -- betont,
      // nicht neon (Vision: EIN dezentes Akzentblau).
      accentSoft: mix(mix(ground, fg, dark ? 0.42 : 0.4), accent, 0.72),
      themeGlow: rgba(accent, dark ? 0.1 : 0.08),
      // Das Art-Symbol im Punkt: die Farbe des Grundes, damit es sich
      // eindrueckt statt aufzutragen.
      glyph: rgba(ground, 0.9),
      themeText: rgba(fg, dark ? 0.92 : 0.9),
      // "42 Eintraege" im Kreis: das Grau von --fg-muted, nicht leiser --
      // darunter reichte der Kontrast nicht (hell 3,3:1, Pruefer, Runde 1).
      themeSub: rgba(muted),
      // Bereiche (Unterthemen) auf Ebene 1: eine leise Flaeche hinter den Knoten.
      regionFill: rgba(mix(ground, fg, dark ? 0.075 : 0.055)),
      regionHover: rgba(mix(mix(ground, fg, dark ? 0.08 : 0.06), accent, dark ? 0.16 : 0.12)),
      regionText: rgba(mix(ground, fg, dark ? 0.78 : 0.72)),
    };
    // Themenkreise: ein Grau aus Grund und Schrift, mit einem Hauch des
    // Themen-Tons -- Saettigung niedrig, in beiden Darstellungen.
    const themeBase = mix(ground, fg, dark ? 0.13 : 0.06);
    palette.themeFill = THEME_HUES.map((css) => rgba(mix(themeBase, parseColor(ctx, css, fg), dark ? 0.1 : 0.075)));
    palette.themeRing = THEME_HUES.map((css) => rgba(mix(mix(ground, fg, dark ? 0.32 : 0.28), parseColor(ctx, css, fg), 0.3)));
    palette.themeFillPlain = rgba(themeBase);
    palette.themeRingPlain = rgba(mix(ground, fg, dark ? 0.3 : 0.26));
    // Neutral heisst neutral: kein Hauch Farbe fuer Index 7.
    palette.themeFill[FARBE_NEUTRAL] = palette.themeFillPlain;
    palette.themeRing[FARBE_NEUTRAL] = palette.themeRingPlain;
    palette.themeLine = mix(ground, fg, dark ? 0.36 : 0.36);
    labelWidthCache = new Array(n);
  }

  /* ---------------------------- Daten setzen ----------------------- */

  function radiusOf(slot) {
    // Themen-Ebene: die Groesse ist die Anzahl, nicht der Grad.
    if (themen) return themaRadius(nodes[slot].anzahl, maxAnzahl);
    // Die sichtbaren Linien: ein Agent, dessen Laeufe ausgeblendet sind,
    // liegt als Waise im Ring und soll dort kein dicker Punkt sein.
    // Groesse nach Verbindungen, sichtbar: ein Hub mit neun Linien ist gut
    // doppelt so gross wie ein Blatt mit einer -- wie in der Vorlage, wo die
    // Hubs als helle Scheiben aus dem Netz treten.
    const d = visDegree[slot];
    const base = mini ? 2.8 : 3.3;
    return settings.nodeScale * Math.min(base + (mini ? 1.2 : 1.75) * Math.sqrt(d), mini ? 7 : 17);
  }

  function tierOf(slot) {
    const d = degree[slot];
    return d >= 24 ? 3 : d >= 8 ? 2 : d >= 2 ? 1 : 0;
  }

  /**
   * @param {{nodes: object[], edges: object[]}} data
   * @param {{beweglich?: string[]}} [opts] nur diese Knoten (und ihre
   *   Nachbarn) duerfen sich bewegen -- fuer eine neue Verbindung, die zu
   *   einer ruhenden Karte dazukommt.
   * Knoten brauchen `id`; Kanten `from`/`to`. Positionen bleiben pro id
   * erhalten, damit ein Nachladen die Karte nicht unter der Hand umwirft.
   */
  function setData(data, opts = {}) {
    sceneVersion++;
    const inNodes = Array.isArray(data && data.nodes) ? data.nodes : [];
    const inEdges = Array.isArray(data && data.edges) ? data.edges : [];

    const old = { index, posX, posY, velX, velY, fixed, fixX, fixY };
    const oldNodes = nodes;
    const oldM = m;
    // Welche Linien es schon gab: eine neue zieht sich gleich sichtbar.
    const oldKeys = new Set();
    if (oldM > 0 && oldM < 60000) {
      for (let e = 0; e < oldM; e++) {
        const p = oldNodes[edgeA[e]].id;
        const q = oldNodes[edgeB[e]].id;
        oldKeys.add(p < q ? `${p}\u0001${q}` : `${q}\u0001${p}`);
      }
    }
    const selectedId = selected >= 0 ? nodes[selected].id : null;
    const hoveredId = hovered >= 0 ? nodes[hovered].id : null;

    nodes = [];
    index = new Map();
    for (const node of inNodes) {
      if (!node || typeof node.id !== 'string' || index.has(node.id)) continue;
      index.set(node.id, nodes.length);
      nodes.push(node);
    }
    n = nodes.length;
    maxAnzahl = 1;
    outside = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (nodes[i].ausserhalb) outside[i] = 1;
      const a = Number(nodes[i].anzahl) || 0;
      if (a > maxAnzahl) maxAnzahl = a;
    }

    posX = new Float64Array(n);
    posY = new Float64Array(n);
    velX = new Float64Array(n);
    velY = new Float64Array(n);
    fixed = new Uint8Array(n);
    fixX = new Float64Array(n);
    fixY = new Float64Array(n);
    degree = new Int32Array(n);
    visDegree = new Int32Array(n);
    visible = new Uint8Array(n);
    orphan = new Uint8Array(n);
    radius = new Float64Array(n);
    charge = new Float64Array(n);
    chain = new Int32Array(n);
    sx = new Float64Array(n);
    sy = new Float64Array(n);
    bright = new Uint8Array(n).fill(1);
    colorKey = new Int16Array(n).fill(-1);
    labelWidthCache = new Array(n);

    const a = [];
    const b = [];
    const w = [];
    const born = [];
    const seen = new Set();
    const now = performance.now();
    let births = 0;
    for (const edge of inEdges) {
      if (!edge) continue;
      const ia = index.get(edge.from);
      const ib = index.get(edge.to);
      if (ia === undefined || ib === undefined || ia === ib) continue;
      // Zwei Kanten zwischen denselben Knoten (links-to und tagged) sind im
      // Bild eine Linie; doppelt gezogen wuerde die Feder doppelt ziehen.
      const key = ia < ib ? `${ia}:${ib}` : `${ib}:${ia}`;
      if (seen.has(key)) continue;
      seen.add(key);
      a.push(ia);
      b.push(ib);
      w.push(Math.max(1, Number(edge.anzahl) || Number(edge.weight) || 1));
      degree[ia]++;
      degree[ib]++;
      let fresh = 0;
      if (oldKeys.size) {
        const p = nodes[ia].id;
        const q = nodes[ib].id;
        if (!oldKeys.has(p < q ? `${p}\u0001${q}` : `${q}\u0001${p}`)) {
          fresh = now;
          births++;
        }
      }
      born.push(fresh);
    }
    m = a.length;
    edgeA = Int32Array.from(a);
    edgeB = Int32Array.from(b);
    edgeWeight = Float64Array.from(w);
    // Wenige neue Linien ziehen sich sichtbar; ein ganz neues Bild nicht --
    // das baut sich als Ganzes auf (enter), nicht Linie fuer Linie.
    edgeBorn = births > 0 && births <= 24 ? Float64Array.from(born) : new Float64Array(m);
    if (births > 0 && births <= 24) growingUntil = now + EDGE_GROW_MS;
    edgeStrength = new Float64Array(m);
    edgeBias = new Float64Array(m);
    edgeVisible = new Uint8Array(m);

    // CSR-Nachbarschaft fuer Hervorheben und die Suche nach Nachbarn.
    adjStart = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) {
      adjStart[edgeA[e] + 1]++;
      adjStart[edgeB[e] + 1]++;
    }
    for (let i = 0; i < n; i++) adjStart[i + 1] += adjStart[i];
    adjList = new Int32Array(adjStart[n]);
    const fill = adjStart.slice(0, n);
    for (let e = 0; e < m; e++) {
      adjList[fill[edgeA[e]]++] = edgeB[e];
      adjList[fill[edgeB[e]]++] = edgeA[e];
    }

    // Beschriftungen: die wichtigsten zuerst, damit sie bei Platzmangel gewinnen.
    labelOrder = Int32Array.from({ length: n }, (_, i) => i);
    labelOrder.sort((p, q) => (degree[q] - degree[p]) || (p - q));
    labelRank = new Int32Array(n);
    for (let o = 0; o < n; o++) labelRank[labelOrder[o]] = o;

    // Positionen: bekannte behalten, neue neben einen bekannten Nachbarn.
    let fresh = 0;
    const freshMask = new Uint8Array(n);
    mobile = null;
    for (let i = 0; i < n; i++) {
      const was = old.index.get(nodes[i].id);
      if (was !== undefined && was < old.posX.length) {
        posX[i] = old.posX[was];
        posY[i] = old.posY[was];
        velX[i] = old.velX[was];
        velY[i] = old.velY[was];
        fixed[i] = old.fixed[was];
        fixX[i] = old.fixX[was];
        fixY[i] = old.fixY[was];
      } else if (Number.isFinite(nodes[i].x) && Number.isFinite(nodes[i].y)) {
        // Eine Lage, die der Aufrufer vorgibt (die Kachel legt ihr Bild selbst).
        posX[i] = nodes[i].x;
        posY[i] = nodes[i].y;
        velX[i] = 0;
        velY[i] = 0;
      } else {
        posX[i] = NaN;
        freshMask[i] = 1;
        fresh++;
      }
    }
    if (fresh === n) seedLayout();
    else if (fresh > 0) seedNear();

    selected = selectedId !== null && index.has(selectedId) ? index.get(selectedId) : -1;
    hovered = hoveredId !== null && index.has(hoveredId) ? index.get(hoveredId) : -1;
    highlightSet = null;
    brightKey = null;
    applyFilter();
    const beweglich = Array.isArray(opts.beweglich) ? opts.beweglich.map((id) => index.get(id)).filter((s) => s !== undefined) : null;
    // Ein Nachladen ohne neue Knoten oder Linien bewegt nichts: die Karte
    // bleibt, wie der Mensch sie gerade ansieht.
    const shape = `${n}:${m}`;
    if (themen) {
      // Die Themen-Ebene liegt fest (layoutThemen); nur Kreise ohne Lage
      // bekommen eine, damit nichts uebereinander liegt.
      alpha = 0;
      alphaTarget = 0;
      mobile = null;
    } else if (fresh === n) reheat(1);
    else if ((fresh > 0 && fresh <= Math.max(12, n * 0.1)) || (beweglich && beweglich.length && fresh === 0)) {
      // Wenige neue Knoten oder eine neue Verbindung: nur die Betroffenen
      // und ihre Nachbarn bewegen sich leicht; die Karte bleibt stehen.
      mobile = new Uint8Array(n);
      const anfassen = (i) => {
        mobile[i] = 1;
        for (let q = adjStart[i]; q < adjStart[i + 1]; q++) mobile[adjList[q]] = 1;
      };
      for (let i = 0; i < n; i++) if (freshMask[i]) anfassen(i);
      if (beweglich) for (const s of beweglich) anfassen(s);
      alpha = Math.max(alpha, fresh > 0 ? 0.5 : 0.22);
      if (settledOnce) emit('onWake');
      settledOnce = false;
    } else if (fresh > 0) reheat(0.4);
    else if (shape !== structure) reheat(0.12);
    structure = shape;
    resolveRegions();
    if (pendingColors) setColors(pendingColors.colorOf, pendingColors.list);
    requestFrame();
    return api;
  }

  /** Die Bereiche auf die Plaetze der aktuellen Knoten abbilden. */
  function resolveRegions() {
    regionOf = new Int32Array(n).fill(-1);
    regions = [];
    hoveredRegion = -1;
    regionGeoCache = null;
    if (themen || mini) return;
    for (const spec of regionSpec) {
      const slots = [];
      for (const id of spec.ids || []) {
        const sl = index.get(id);
        if (sl === undefined) continue;
        slots.push(sl);
      }
      if (!slots.length) continue;
      const ri = regions.length;
      regions.push({ id: spec.id, name: String(spec.name || 'Thema'), anzahl: Number(spec.anzahl) || slots.length, slots: Int32Array.from(slots) });
      for (const sl of slots) if (regionOf[sl] < 0) regionOf[sl] = ri;
    }
  }

  /**
   * Startlage: Knoten in Breitensuche-Reihenfolge auf eine Phyllotaxis-
   * Spirale (wie d3), damit Nachbarn schon nah beieinander anfangen und die
   * Physik nicht erst ein Knaeuel entwirren muss. Waisen starten gleich auf
   * dem Ring, auf dem sie ohnehin landen.
   */
  function seedLayout() {
    const order = [];
    const done = new Uint8Array(n);
    const byDegree = Array.from({ length: n }, (_, i) => i).sort((p, q) => degree[q] - degree[p]);
    for (const start of byDegree) {
      if (done[start] || degree[start] === 0) continue;
      const queue = [start];
      done[start] = 1;
      for (let qi = 0; qi < queue.length; qi++) {
        const cur = queue[qi];
        order.push(cur);
        for (let k = adjStart[cur]; k < adjStart[cur + 1]; k++) {
          const nb = adjList[k];
          if (!done[nb]) {
            done[nb] = 1;
            queue.push(nb);
          }
        }
      }
    }
    const golden = Math.PI * (3 - Math.sqrt(5));
    const step = 9 * Math.sqrt(settings.linkDistance);
    for (let i = 0; i < order.length; i++) {
      const r = step * Math.sqrt(0.5 + i);
      const a = i * golden;
      posX[order[i]] = r * Math.cos(a);
      posY[order[i]] = r * Math.sin(a);
      velX[order[i]] = 0;
      velY[order[i]] = 0;
    }
    const lonely = [];
    for (let i = 0; i < n; i++) if (!done[i]) lonely.push(i);
    const R = Math.max(step * Math.sqrt(order.length + 1) * 1.15 + 40, (lonely.length * 20) / TAU);
    for (let j = 0; j < lonely.length; j++) {
      const a = (j / Math.max(1, lonely.length)) * TAU + 0.3;
      posX[lonely[j]] = R * Math.cos(a) + jitter(j) * 4000;
      posY[lonely[j]] = R * Math.sin(a) + jitter(j + 7) * 4000;
    }
  }

  function seedNear() {
    for (let i = 0; i < n; i++) {
      if (!Number.isNaN(posX[i])) continue;
      let px = NaN;
      let py = NaN;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const nb = adjList[k];
        if (!Number.isNaN(posX[nb])) {
          px = posX[nb];
          py = posY[nb];
          break;
        }
      }
      if (Number.isNaN(px)) {
        const a = i * 2.39996;
        const r = ringRadius > 0 ? ringRadius : 200;
        px = ringCentreX + r * Math.cos(a);
        py = ringCentreY + r * Math.sin(a);
      }
      posX[i] = px + jitter(i) * 12000;
      posY[i] = py + jitter(i + 3) * 12000;
      velX[i] = 0;
      velY[i] = 0;
    }
  }

  /** Sichtbarkeit, sichtbarer Grad, Waisen, Federstaerken. */
  function applyFilter() {
    for (let i = 0; i < n; i++) {
      let keep = true;
      if (filterFn) {
        try {
          keep = !!filterFn(nodes[i]);
        } catch {
          keep = true;
        }
      }
      visible[i] = keep ? 1 : 0;
      visDegree[i] = 0;
    }
    for (let e = 0; e < m; e++) {
      const on = visible[edgeA[e]] && visible[edgeB[e]] ? 1 : 0;
      edgeVisible[e] = on;
      if (on) {
        visDegree[edgeA[e]]++;
        visDegree[edgeB[e]]++;
      }
    }
    for (let i = 0; i < n; i++) {
      orphan[i] = visible[i] && visDegree[i] === 0 ? 1 : 0;
      // Ausgeblendete Waisen machen keine neuen: sie haben keine sichtbare Linie.
      if (orphan[i] && !showOrphans) {
        visible[i] = 0;
        orphan[i] = 0;
      }
    }
    // Wer unsichtbar wird, darf nicht gewaehlt bleiben.
    if (selected >= 0 && !visible[selected]) selected = -1;
    if (hovered >= 0 && !visible[hovered]) hovered = -1;
    visibleCount = 0;
    for (let i = 0; i < n; i++) if (visible[i]) visibleCount++;
    computeTop();
    recomputeSizes();
    brightKey = null;
  }

  /** Die groessten sichtbaren Knoten mit mindestens zwei Linien; Waisen nie. */
  function computeTop() {
    const best = [];
    const before = (p, q) => visDegree[p] > visDegree[q]
      || (visDegree[p] === visDegree[q] && (degree[p] > degree[q] || (degree[p] === degree[q] && p < q)));
    for (let i = 0; i < n; i++) {
      if (!visible[i] || orphan[i] || visDegree[i] < 2) continue;
      if (best.length === UEBERSICHT_NAMEN && !before(i, best[best.length - 1])) continue;
      let at = best.length;
      while (at > 0 && before(i, best[at - 1])) at--;
      best.splice(at, 0, i);
      if (best.length > UEBERSICHT_NAMEN) best.pop();
    }
    const groesster = best.length ? visDegree[best[0]] : 0;
    topSlots = new Set(best.filter((i, pos) => pos < UEBERSICHT_SICHER || visDegree[i] * 2 >= groesster));
  }

  function recomputeSizes() {
    for (let i = 0; i < n; i++) {
      radius[i] = radiusOf(i);
      charge[i] = PHYS.charge * settings.repel * (1 + PHYS.hubCharge * Math.sqrt(visDegree[i]));
    }
    for (let e = 0; e < m; e++) {
      const da = Math.max(1, visDegree[edgeA[e]]);
      const db = Math.max(1, visDegree[edgeB[e]]);
      edgeStrength[e] = PHYS.linkStrength / Math.min(da, db);
      edgeBias[e] = da / (da + db);
    }
  }

  /* ---------------------------- Physik ----------------------------- */

  function reheat(value = 0.6) {
    if (themen) {
      // Die Themen-Ebene liegt fest: neu zeichnen, nicht neu rechnen.
      requestFrame();
      return api;
    }
    mobile = null; // wer bewusst anstoesst, bewegt das Ganze
    alpha = Math.max(alpha, value);
    if (settledOnce) emit('onWake');
    settledOnce = false;
    requestFrame();
    return api;
  }

  function running() {
    return alpha >= PHYS.alphaMin || alphaTarget > 0;
  }

  /** Der Ring der Waisen: knapp ausserhalb der verbundenen Wolke. */
  function updateRing() {
    let cx = 0;
    let cy = 0;
    let count = 0;
    let orphans = 0;
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      if (orphan[i]) {
        orphans++;
        continue;
      }
      cx += posX[i];
      cy += posY[i];
      count++;
    }
    if (count) {
      cx /= count;
      cy /= count;
    }
    const dist = [];
    for (let i = 0; i < n; i++) {
      if (!visible[i] || orphan[i]) continue;
      dist.push(Math.hypot(posX[i] - cx, posY[i] - cy));
    }
    dist.sort((p, q) => p - q);
    const far = dist.length ? dist[Math.min(dist.length - 1, Math.floor(dist.length * 0.97))] : 0;
    const need = (orphans * 22) / TAU;
    ringCentreX = cx;
    ringCentreY = cy;
    // Ein sichtbarer Abstand zwischen Wolke und Ring, wie in der Vorlage:
    // die Waisen sollen als eigener Kranz lesbar sein, nicht als Saum.
    ringRadius = Math.max(far * 1.14 + 36 * settings.linkDistance, need, 80);
  }

  /**
   * Wie schnell die Wolke zur Ruhe kommt: ein grosses Thema (2.000 Knoten)
   * in rund 170 Schritten, ein kleines in 300 -- bei vielen Knoten ist jede
   * Sekunde Nachschwingen eine Sekunde Unruhe auf dem ganzen Bild.
   */
  function alphaDecayFor(count) {
    const ticks = count > 1500 ? 170 : count > 400 ? 240 : 300;
    return 1 - Math.pow(PHYS.alphaMin, 1 / ticks);
  }

  function tick() {
    sceneVersion++;
    const t0 = performance.now();
    alpha += (alphaTarget - alpha) * alphaDecayFor(n);
    if (tickCount++ % 6 === 0) updateRing();

    // Federn (d3.forceLink): Staerke 1/min(Grad), Anteil nach Grad verteilt.
    const restBase = PHYS.linkDistance * settings.linkDistance;
    for (let e = 0; e < m; e++) {
      if (!edgeVisible[e]) continue;
      const s = edgeA[e];
      const t = edgeB[e];
      let dx = posX[t] + velX[t] - posX[s] - velX[s];
      let dy = posY[t] + velY[t] - posY[s] - velY[s];
      if (dx === 0 && dy === 0) {
        dx = jitter(e);
        dy = jitter(e + 1);
      }
      const l = Math.sqrt(dx * dx + dy * dy);
      const rest = restBase + radius[s] + radius[t];
      const f = ((l - rest) / l) * alpha * edgeStrength[e];
      dx *= f;
      dy *= f;
      const bias = edgeBias[e];
      velX[t] -= dx * bias;
      velY[t] -= dy * bias;
      velX[s] += dx * (1 - bias);
      velY[s] += dy * (1 - bias);
    }

    // Abstossung (Barnes-Hut): die Wolke unter sich, die Waisen unter sich.
    repel(tree, 0);
    repel(orphanTree, 1);

    // Zentrierung fuer Verbundene, Ringkraft fuer Waisen.
    const cs = PHYS.center * settings.center * alpha;
    const rs = PHYS.ring * alpha;
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      if (orphan[i]) {
        const dx = posX[i] - ringCentreX;
        const dy = posY[i] - ringCentreY;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        // Ein lockerer Ring, kein Zirkel: jeder Waise hat seinen eigenen,
        // leicht anderen Abstand -- wie in der Vorlage.
        const target = ringRadius * (1 + jitter(i * 7 + 1) * 45);
        const k = ((target - d) / d) * rs;
        velX[i] += dx * k;
        velY[i] += dy * k;
      } else {
        velX[i] -= posX[i] * cs;
        velY[i] -= posY[i] * cs;
      }
    }

    // Bereiche halten zusammen: jeder Knoten zieht leicht zur Mitte seines
    // (ersten) Unterthemas -- so wird aus "Biologie" eine Flaeche, in die man
    // hineinzoomen kann, statt verstreuter Punkte.
    if (regions.length) {
      const zx = new Float64Array(regions.length);
      const zy = new Float64Array(regions.length);
      const zn = new Float64Array(regions.length);
      for (let i = 0; i < n; i++) {
        const ri = regionOf[i];
        if (ri < 0 || !visible[i]) continue;
        zx[ri] += posX[i];
        zy[ri] += posY[i];
        zn[ri]++;
      }
      const ks = 0.12 * alpha;
      for (let i = 0; i < n; i++) {
        const ri = regionOf[i];
        if (ri < 0 || !visible[i] || zn[ri] < 2) continue;
        velX[i] += (zx[ri] / zn[ri] - posX[i]) * ks;
        velY[i] += (zy[ri] / zn[ri] - posY[i]) * ks;
      }
      // ... und halten Abstand voneinander: zwei Unterthemen sind zwei
      // Flaechen, kein gemeinsamer Fleck.
      if (regions.length > 1) {
        const dx = new Float64Array(regions.length);
        const dy = new Float64Array(regions.length);
        for (let a = 0; a < regions.length; a++) {
          if (!zn[a]) continue;
          for (let b2 = a + 1; b2 < regions.length; b2++) {
            if (!zn[b2]) continue;
            let vx = zx[b2] / zn[b2] - zx[a] / zn[a];
            let vy = zy[b2] / zn[b2] - zy[a] / zn[a];
            let d = Math.hypot(vx, vy);
            if (d < 1e-6) { vx = jitter(a * 13 + b2); vy = jitter(b2 * 13 + a); d = Math.hypot(vx, vy) || 1; }
            const want = 26 * (Math.sqrt(zn[a]) + Math.sqrt(zn[b2])) + 60;
            if (d >= want) continue;
            const f = ((want - d) / d) * 0.06 * alpha;
            dx[a] -= vx * f;
            dy[a] -= vy * f;
            dx[b2] += vx * f;
            dy[b2] += vy * f;
          }
        }
        for (let i = 0; i < n; i++) {
          const ri = regionOf[i];
          if (ri < 0 || !visible[i]) continue;
          velX[i] += dx[ri];
          velY[i] += dy[ri];
        }
      }
    }

    // Integrieren. Eine Hoechstgeschwindigkeit verhindert, dass ein
    // losgelassener Knoten quer ueber die Karte schiesst.
    const decay = 1 - PHYS.velocityDecay;
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      if (fixed[i] || (mobile && !mobile[i])) {
        if (fixed[i]) {
          posX[i] = fixX[i];
          posY[i] = fixY[i];
        }
        velX[i] = 0;
        velY[i] = 0;
        continue;
      }
      let vx = velX[i] * decay;
      let vy = velY[i] * decay;
      const sp = vx * vx + vy * vy;
      if (sp > PHYS.maxSpeed * PHYS.maxSpeed) {
        const f = PHYS.maxSpeed / Math.sqrt(sp);
        vx *= f;
        vy *= f;
      }
      velX[i] = vx;
      velY[i] = vy;
      posX[i] += vx;
      posY[i] += vy;
    }
    tickMs = performance.now() - t0;
  }

  /** Abstossung innerhalb einer Gruppe (0 = verbunden, 1 = Waisen). */
  function repel(quad, wantOrphan) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (!visible[i] || orphan[i] !== wantOrphan) continue;
      count++;
      if (posX[i] < minX) minX = posX[i];
      if (posX[i] > maxX) maxX = posX[i];
      if (posY[i] < minY) minY = posY[i];
      if (posY[i] > maxY) maxY = posY[i];
    }
    if (count < 2) return;
    const half = Math.max(maxX - minX, maxY - minY) / 2 + 1;
    quad.reset((minX + maxX) / 2, (minY + maxY) / 2, half);
    for (let i = 0; i < n; i++) if (visible[i] && orphan[i] === wantOrphan) quad.insert(i, posX, posY, charge, chain);
    for (let i = 0; i < n; i++) {
      if (!visible[i] || orphan[i] !== wantOrphan) continue;
      quad.accumulate(i, posX, posY, charge, chain, PHYS.theta2, forceOut);
      velX[i] += forceOut[0] * alpha;
      velY[i] += forceOut[1] * alpha;
    }
  }

  /**
   * Vorab rechnen, ohne zu zeichnen: die ersten, wildesten Schritte sieht
   * niemand. Begrenzt durch Schritte UND Zeit, damit ein langsamer Laptop
   * nicht einfriert.
   */
  function prewarm(ticks = 160, budgetMs = 220) {
    const start = performance.now();
    for (let t = 0; t < ticks && running(); t++) {
      tick();
      if (performance.now() - start > budgetMs) break;
    }
    requestFrame();
    return api;
  }

  /* ---------------------------- Kamera ----------------------------- */

  function bounds(slots) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const take = (i) => {
      const r = radius[i];
      if (posX[i] - r < minX) minX = posX[i] - r;
      if (posX[i] + r > maxX) maxX = posX[i] + r;
      if (posY[i] - r < minY) minY = posY[i] - r;
      if (posY[i] + r > maxY) maxY = posY[i] + r;
    };
    if (slots) for (const i of slots) take(i);
    else for (let i = 0; i < n; i++) if (visible[i]) take(i);
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }

  function fitTransform(pad) {
    const box = bounds(null);
    if (!box || !width || !height) return null;
    // Die Kachel braucht seitlich Platz fuer die Namen neben den Punkten;
    // die grosse Ansicht oben Platz fuer Brotkrumen und Suche (setPadding).
    let top;
    let right;
    let bottom;
    let left;
    if (typeof pad === 'number') top = right = bottom = left = pad;
    else if (mini) {
      left = right = clamp(width * 0.2, 30, 90);
      top = bottom = 26;
    } else {
      const p = pad && typeof pad === 'object' ? pad : padding;
      top = Number.isFinite(p.top) ? p.top : padding.top;
      right = Number.isFinite(p.right) ? p.right : padding.right;
      bottom = Number.isFinite(p.bottom) ? p.bottom : padding.bottom;
      left = Number.isFinite(p.left) ? p.left : padding.left;
    }
    const bw = Math.max(box.maxX - box.minX, 1);
    const bh = Math.max(box.maxY - box.minY, 1);
    const innerW = Math.max(40, width - left - right);
    const innerH = Math.max(40, height - top - bottom);
    // Ein kleines Netz wird nicht auf Briefmarkengroesse aufgeblasen: ueber
    // 1.6 sehen zwanzig Punkte aus wie Knoepfe, nicht wie ein Gehirn. Die
    // Themenkreise duerfen etwas groesser, sie tragen ihren Namen innen.
    const k = clamp(Math.min(innerW / bw, innerH / bh), MIN_ZOOM, mini ? 2.2 : themen ? 1.35 : 2);
    return {
      k,
      x: left + innerW / 2 - ((box.minX + box.maxX) / 2) * k,
      y: top + innerH / 2 - ((box.minY + box.maxY) / 2) * k,
    };
  }

  function setPadding(next) {
    if (next && typeof next === 'object') {
      padding = { ...padding };
      for (const key of ['top', 'right', 'bottom', 'left']) if (Number.isFinite(next[key])) padding[key] = next[key];
    }
    return api;
  }

  function reduceMotion() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  function animateTo(target, duration = MOVE_MS) {
    if (!target) return;
    if (reduceMotion() || duration <= 0 || !width) {
      transform = { ...target };
      animation = null;
      requestFrame();
      return;
    }
    animation = { from: { ...transform }, to: { ...target }, start: performance.now(), duration };
    requestFrame();
  }

  function stepAnimation(now) {
    if (!animation) return false;
    const t = clamp((now - animation.start) / animation.duration, 0, 1);
    const e = ease(t);
    const { from, to } = animation;
    // Zoom logarithmisch einblenden: linear fuehlt sich beim Heranfahren
    // an, als wuerde die Kamera am Ende ploetzlich stehen bleiben.
    const k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e);
    // Den Weltpunkt in der Bildmitte gleichmaessig bewegen, nicht x/y roh.
    const cxFrom = (width / 2 - from.x) / from.k;
    const cyFrom = (height / 2 - from.y) / from.k;
    const cxTo = (width / 2 - to.x) / to.k;
    const cyTo = (height / 2 - to.y) / to.k;
    const cx = cxFrom + (cxTo - cxFrom) * e;
    const cy = cyFrom + (cyTo - cyFrom) * e;
    transform = { k, x: width / 2 - cx * k, y: height / 2 - cy * k };
    if (t >= 1) {
      transform = { ...to };
      animation = null;
    }
    return true;
  }

  function fitToView(config = {}) {
    const target = fitTransform(config.padding);
    if (!target) return api;
    if (config.follow) autoFit = true;
    if (config.animate === false) {
      transform = target;
      animation = null;
      requestFrame();
    } else {
      animateTo(target, config.duration || MOVE_MS);
    }
    return api;
  }

  function focus(id, config = {}) {
    const slot = index.get(id);
    if (slot === undefined || !visible[slot]) return api;
    autoFit = false;
    const k = config.zoom ? clamp(config.zoom, MIN_ZOOM, MAX_ZOOM) : Math.max(transform.k, 1.2);
    // In die Mitte der freien Flaeche (setPadding): neben einer offenen
    // Karte, nicht darunter.
    const cx = mini ? width / 2 : padding.left + Math.max(40, width - padding.left - padding.right) / 2;
    const cy = mini ? height / 2 : padding.top + Math.max(40, height - padding.top - padding.bottom) / 2;
    const target = { k, x: cx - posX[slot] * k, y: cy - posY[slot] * k };
    if (config.animate === false) {
      transform = target;
      animation = null;
      requestFrame();
    } else {
      animateTo(target, MOVE_MS);
    }
    return api;
  }

  /**
   * Einen Knoten und seine direkten Nachbarn in die freie Flaeche holen
   * (innerhalb von setPadding), wenn etwas davon ausserhalb liegt -- etwa
   * unter der Karte rechts. Liegt alles frei, bewegt sich nichts.
   */
  function zeigeFrei(id) {
    const slot = index.get(id);
    if (slot === undefined || !visible[slot] || !width || !height) return api;
    const slots = [slot];
    for (let q = adjStart[slot]; q < adjStart[slot + 1]; q++) if (visible[adjList[q]]) slots.push(adjList[q]);
    const box = bounds(slots);
    if (!box) return api;
    const k0 = transform.k;
    const rand = 28;
    const fx0 = padding.left + rand;
    const fx1 = width - padding.right - rand;
    const fy0 = padding.top + rand;
    const fy1 = height - padding.bottom - rand;
    const sx0 = box.minX * k0 + transform.x;
    const sx1 = box.maxX * k0 + transform.x;
    const sy0 = box.minY * k0 + transform.y;
    const sy1 = box.maxY * k0 + transform.y;
    if (sx0 >= fx0 && sx1 <= fx1 && sy0 >= fy0 && sy1 <= fy1) return api;
    const bw = Math.max(1, box.maxX - box.minX);
    const bh = Math.max(1, box.maxY - box.minY);
    const k = clamp(Math.min(k0, (fx1 - fx0) / bw, (fy1 - fy0) / bh), MIN_ZOOM, MAX_ZOOM);
    const cx = (fx0 + fx1) / 2;
    const cy = (fy0 + fy1) / 2;
    autoFit = false;
    animateTo({ k, x: cx - ((box.minX + box.maxX) / 2) * k, y: cy - ((box.minY + box.maxY) / 2) * k }, MOVE_MS);
    return api;
  }

  function zoomAround(factor, cx, cy) {
    const [lo, hi] = zoomGrenzen();
    const k = clamp(transform.k * factor, lo, Math.max(lo, hi));
    const f = k / transform.k;
    transform = { k, x: cx - (cx - transform.x) * f, y: cy - (cy - transform.y) * f };
  }

  function zoomBy(factor, cx = width / 2, cy = height / 2, animate = false) {
    autoFit = false;
    if (animate) {
      const k = clamp(transform.k * factor, MIN_ZOOM, MAX_ZOOM);
      const f = k / transform.k;
      animateTo({ k, x: cx - (cx - transform.x) * f, y: cy - (cy - transform.y) * f }, 220);
      checkLevel(cx, cy, k);
    } else {
      animation = null;
      zoomAround(factor, cx, cy);
      requestFrame();
      checkLevel(cx, cy);
    }
    return api;
  }

  /* ---------------------------- Licht ------------------------------ */

  /**
   * Wer im Licht steht. Vorrang: ueberfahren, dann gewaehlt, dann die
   * Suchtreffer. Das Ergebnis wird nur neu gerechnet, wenn sich der Anlass
   * aendert -- nicht in jedem Bild.
   */
  function updateBright() {
    const f = hovered >= 0 ? hovered : selected;
    let key;
    if (f >= 0) key = `f${f}`;
    else if (highlightSet) key = `h${highlightSet.size}:${[...highlightSet].slice(0, 6).join(',')}`;
    else key = '';
    if (key === brightKey) return;
    brightKey = key;
    if (f >= 0) {
      focusSlot = f;
      bright.fill(0);
      bright[f] = 1;
      for (let k = adjStart[f]; k < adjStart[f + 1]; k++) bright[adjList[k]] = 1;
      fadeTarget = 1;
      if (mini) fade = 1; // die Kachel zeigt ein ruhiges Bild, keine Ueberblendung
    } else if (highlightSet) {
      focusSlot = -1;
      bright.fill(0);
      for (const s of highlightSet) bright[s] = 1;
      fadeTarget = 1;
    } else {
      // Licht aus: die alte Maske bleibt stehen, bis das Zuruecktreten
      // zurueckgeblendet ist -- sonst springt das Bild.
      fadeTarget = 0;
    }
  }

  /* ---------------------------- Zeichnen --------------------------- */

  function requestFrame() {
    if (destroyed || rafId) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    rafId = requestAnimationFrame(frame);
  }

  function frame(now) {
    rafId = 0;
    if (destroyed) return;
    const dt = lastFrame ? Math.min(64, now - lastFrame) : 16;
    lastFrame = now;
    let busy = false;

    if (running()) {
      tick();
      if (alpha < PHYS.alphaMin && alphaTarget === 0) {
        alpha = 0;
        mobile = null;
        if (!settledOnce) {
          settledOnce = true;
          if (autoFit) {
            autoFit = false;
            animateTo(fitTransform(), 500);
          }
          emit('onSettle');
        }
      } else {
        busy = true;
      }
      // Solange die Wolke noch waechst, folgt ihr die Kamera weich.
      if (autoFit && !animation) {
        const target = fitTransform();
        if (target) {
          const t = 0.12;
          transform = {
            k: transform.k + (target.k - transform.k) * t,
            x: transform.x + (target.x - transform.x) * t,
            y: transform.y + (target.y - transform.y) * t,
          };
        }
      }
    }
    if (stepAnimation(now)) busy = true;

    updateBright();
    if (fade !== fadeTarget) {
      const step = dt / FADE_MS;
      fade = fadeTarget > fade ? Math.min(fadeTarget, fade + step) : Math.max(fadeTarget, fade - step);
      busy = true;
      if (fade === 0 && fadeTarget === 0) {
        bright.fill(1);
        focusSlot = -1;
      }
    }
    // Weicher Aufbau und wachsende Linien halten die Schleife am Laufen,
    // bis sie fertig sind -- dann steht das Bild wieder still.
    if (enterStart) {
      if (now < enterStart + ENTER_MS + ENTER_WAVE_MS * 4) busy = true;
      else enterStart = 0;
    }
    if (growingUntil) {
      if (now < growingUntil) busy = true;
      else growingUntil = 0;
    }

    frameNow = now;
    // Bewegt sich die Wolke selbst (Physik, Aufbau, wachsende Linie), wird
    // gezeichnet; Ausschnitt, Licht und Auswahl gehen ueber das Zwischenbild.
    const wolkeBewegt = running() || !!enterStart || !!growingUntil;
    if (wolkeBewegt || !drawFromPanCache()) draw();
    lastDrawK = transform.k;
    if (busy) requestFrame();
    else lastFrame = 0;
  }

  function dropPanCache() {
    panCache = null;
    if (panCanvas) {
      panCanvas.width = 1; // gibt den Speicher frei (bei dpr 2 auf dem iPad sind es Dutzende MB)
      panCanvas.height = 1;
    }
  }

  /**
   * Das Zwischenbild (siehe oben). Liefert false, wenn keines genutzt werden
   * kann -- dann zeichnet der Aufrufer ganz normal. Genutzt wird es nur bei
   * einem dichten Netz (PAN_CACHE_AB sichtbare Linien), stillstehender Wolke
   * (prueft der Aufrufer) und einem Zoom, der seit dem letzten Bild steht:
   * waehrend Rad oder Pinch zoomen, wuerde jedes Bild ein neues Zwischenbild
   * kosten, das ist teurer als Zeichnen.
   */
  function drawFromPanCache() {
    if (m < PAN_CACHE_AB && panCanvas && panCanvas.width > 1) dropPanCache(); // ein kleines Netz braucht den Speicher nicht
    if (mini || themen || !n || !width || !height || m < PAN_CACHE_AB) return false;
    const k = transform.k;
    const key = `${sceneVersion}|${k}|${dpr}|${width}|${height}`;
    if (panCache && (panCache.key !== key
      || Math.abs(transform.x - panCache.x) > panCache.mx || Math.abs(transform.y - panCache.y) > panCache.my)) {
      panCache = null;
    }
    if (!panCache) {
      if (k !== lastDrawK) return false;
      let ve = 0;
      for (let e = 0; e < m; e++) if (edgeVisible[e]) ve++;
      if (ve < PAN_CACHE_AB) return false;
      const mx = Math.round(width * PAN_MARGIN);
      const my = Math.round(height * PAN_MARGIN);
      const off = panCanvas || (panCanvas = document.createElement('canvas'));
      off.width = Math.max(1, Math.round((width + 2 * mx) * dpr));
      off.height = Math.max(1, Math.round((height + 2 * my) * dpr));
      const octx = off.getContext('2d', { alpha: true });
      if (!octx) return false;
      // Dieselbe Szene, dieselben Zeichenfunktionen -- nur auf die zweite
      // Leinwand, mit Rand, verschobenem Ursprung und ohne Licht und Auswahl.
      const saved = { ctx, width, height, transform, fade, selected };
      ctx = octx;
      width += 2 * mx;
      height += 2 * my;
      transform = { k, x: saved.transform.x + mx, y: saved.transform.y + my };
      fade = 0;
      selected = -1;
      try {
        draw();
      } finally {
        ctx = saved.ctx;
        width = saved.width;
        height = saved.height;
        transform = saved.transform;
        fade = saved.fade;
        selected = saved.selected;
      }
      panCache = { canvas: off, k, x: transform.x, y: transform.y, mx, my, key };
    }
    const t0 = performance.now();
    frameNow = t0;
    const dx = transform.x - panCache.x;
    const dy = transform.y - panCache.y;
    const lit = fade > 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    // Im Licht tritt das ganze Zwischenbild zurueck; die hellen Teile kommen darauf.
    ctx.globalAlpha = lit ? 1 - fade * (1 - dimAlpha) : 1;
    ctx.drawImage(panCache.canvas, Math.round((dx - panCache.mx) * dpr), Math.round((dy - panCache.my) * dpr));
    ctx.globalAlpha = 1;
    for (let i = 0; i < n; i++) {
      sx[i] = posX[i] * k + transform.x;
      sy[i] = posY[i] * k + transform.y;
    }
    if (lit || selected >= 0) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      overlayOnly = true;
      try {
        drawEdges(k);
        drawNodes(k);
        drawLabels(k);
      } finally {
        overlayOnly = false;
      }
    }
    drawMs = performance.now() - t0;
    return true;
  }

  /** 0..1: wie weit ein Knoten im weichen Aufbau ist (Welle 0-3, Hubs zuerst). */
  function enterProgress(i) {
    if (!enterStart) return 1;
    const wave = themen ? Math.min(3, Math.floor((i * 4) / Math.max(1, n))) : Math.min(3, Math.floor((labelRank[i] * 4) / Math.max(1, n)));
    return easeOut((frameNow - enterStart - wave * ENTER_WAVE_MS) / ENTER_MS);
  }

  function draw() {
    const t0 = performance.now();
    frameNow = t0;
    if (!palette) readPalette();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (!width || !height || !n) {
      drawMs = performance.now() - t0;
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = transform.k;

    for (let i = 0; i < n; i++) {
      sx[i] = posX[i] * k + transform.x;
      sy[i] = posY[i] * k + transform.y;
    }

    drawRegions(k);
    drawEdges(k);
    drawNodes(k);
    drawLabels(k);
    drawRegionLabels();
    drawMs = performance.now() - t0;
  }

  /* ---------------------------- Bereiche --------------------------- */

  /** Konvexe Huelle (Andrew), Punkte als [x, y]. */
  function huelle(pts) {
    if (pts.length < 3) return pts.slice();
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const pt of p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
      lower.push(pt);
    }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) {
      const pt = p[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
      upper.push(pt);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
  }

  function regionPad(k) {
    return clamp(16 * Math.sqrt(k), 12, 30);
  }

  /**
   * Lage der Bereiche auf dem Bildschirm: Huelle, Mitte, Name. Aus den
   * Bildschirmpunkten des letzten Bildes; je Ausschnitt einmal gerechnet.
   */
  function regionGeo() {
    if (!regions.length) return [];
    const k = transform.k;
    const key = `${sceneVersion}|${k}|${transform.x}|${transform.y}|${width}|${height}`;
    if (regionGeoCache && regionGeoCache.key === key) return regionGeoCache.geo;
    const pad = regionPad(k);
    const geo = regions.map((reg) => {
      const pts = [];
      for (const sl of reg.slots) {
        if (!visible[sl]) continue;
        pts.push([posX[sl] * k + transform.x, posY[sl] * k + transform.y]);
      }
      if (!pts.length) return null;
      const h = huelle(pts);
      let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
      for (const [x, y] of h) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      const text = `${reg.name} · ${formatCount(reg.anzahl)}`;
      ctx.font = `500 12px ${fontFamily}`;
      const w = ctx.measureText(text).width + 16;
      const label = { x: (minX + maxX) / 2 - w / 2, y: minY - pad - 24, w, h: 22 };
      return { hull: h, pad, text, label, box: { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad } };
    });
    regionGeoCache = { key, geo };
    return geo;
  }

  /** Je Bereich ein eigener, sehr leiser Ton -- zwei Unterthemen sind zwei Flaechen. */
  function regionFarbe(ri) {
    if (!palette.regionTints) {
      const basis = parseColor(ctx, palette.regionFill, palette.fg);
      palette.regionTints = [0, 2, 3, 1, 5, 4, 6].map((h) => rgba(mix(basis, parseColor(ctx, THEME_HUES[h], palette.fg), palette.dark ? 0.1 : 0.12)));
    }
    return palette.regionTints[ri % palette.regionTints.length];
  }

  function drawRegions(k) {
    if (!regions.length || overlayOnly) return;
    const geo = regionGeo();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    geo.forEach((g, ri) => {
      if (!g) return;
      const color = ri === hoveredRegion ? palette.regionHover : regionFarbe(ri);
      ctx.beginPath();
      const h = g.hull;
      ctx.moveTo(h[0][0], h[0][1]);
      for (let q = 1; q < h.length; q++) ctx.lineTo(h[q][0], h[q][1]);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineWidth = g.pad * 2;
      ctx.stroke();
      if (h.length >= 3) ctx.fill();
    });
    void k;
  }

  function drawRegionLabels() {
    if (!regions.length || overlayOnly) return;
    const geo = regionGeo();
    ctx.font = `500 12px ${fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    geo.forEach((g, ri) => {
      if (!g) return;
      const l = g.label;
      const hov = ri === hoveredRegion;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(l.x, l.y, l.w, l.h, 11);
      else ctx.rect(l.x, l.y, l.w, l.h);
      ctx.fillStyle = hov ? palette.regionHover : palette.halo;
      ctx.fill();
      if (hov) {
        ctx.strokeStyle = rgba(palette.accent, 0.55);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.fillStyle = hov ? palette.labelStrong : palette.regionText;
      ctx.fillText(g.text, l.x + l.w / 2, l.y + l.h / 2 + 0.5);
    });
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  /** Der Bereich, dessen Name unter dem Punkt liegt (-1: keiner). */
  function regionLabelAt(x, y) {
    const geo = regionGeo();
    for (let ri = 0; ri < geo.length; ri++) {
      const g = geo[ri];
      if (g && x >= g.label.x && x <= g.label.x + g.label.w && y >= g.label.y && y <= g.label.y + g.label.h) return ri;
    }
    return -1;
  }

  /** Der kleinste Bereich, in dessen Flaeche der Punkt liegt (-1: keiner). */
  function regionAreaAt(x, y) {
    const geo = regionGeo();
    let best = -1;
    let bestA = Infinity;
    for (let ri = 0; ri < geo.length; ri++) {
      const g = geo[ri];
      if (!g || x < g.box.minX || x > g.box.maxX || y < g.box.minY || y > g.box.maxY) continue;
      if (!inHuelle(g.hull, x, y, g.pad)) continue;
      const a = (g.box.maxX - g.box.minX) * (g.box.maxY - g.box.minY);
      if (a < bestA) { bestA = a; best = ri; }
    }
    return best;
  }

  function inHuelle(h, x, y, pad) {
    if (h.length >= 3) {
      let drin = false;
      for (let i = 0, j = h.length - 1; i < h.length; j = i++) {
        const [xi, yi] = h[i];
        const [xj, yj] = h[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) drin = !drin;
      }
      if (drin) return true;
    }
    for (let i = 0; i < h.length; i++) {
      const [ax, ay] = h[i];
      const [bx, by] = h[(i + 1) % h.length];
      const vx = bx - ax;
      const vy = by - ay;
      const t = clamp(((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1), 0, 1);
      if (Math.hypot(ax + vx * t - x, ay + vy * t - y) <= pad) return true;
    }
    return false;
  }

  function regionInfo(ri) {
    const r = regions[ri];
    return r ? { id: r.id, name: r.name, anzahl: r.anzahl } : null;
  }

  function setHoveredRegion(ri) {
    if (ri === hoveredRegion) return;
    hoveredRegion = ri;
    sceneVersion++;
    canvas.style.cursor = ri >= 0 ? 'pointer' : '';
    requestFrame();
  }

  function onScreen(i, margin) {
    return sx[i] > -margin && sx[i] < width + margin && sy[i] > -margin && sy[i] < height + margin;
  }

  function edgeOnScreen(p, q) {
    const minX = Math.min(sx[p], sx[q]);
    const maxX = Math.max(sx[p], sx[q]);
    const minY = Math.min(sy[p], sy[q]);
    const maxY = Math.max(sy[p], sy[q]);
    return maxX > -4 && minX < width + 4 && maxY > -4 && minY < height + 4;
  }

  function drawEdges(k) {
    if (!m) return;
    // Linien bleiben duenn: sie wachsen nur sanft mit dem Zoom mit.
    const lw = settings.linkScale * clamp(0.55 + 0.45 * Math.sqrt(k), 0.5, 1.8) * (mini ? 1.1 : 1);
    // Stumpfe Enden fuer die Masse: bei tausenden Linien kostet jedes runde
    // Ende im Software-Raster ein Drittel der Zeit, und bei 1 px sieht man es
    // nicht. Neue und beleuchtete Linien bekommen ihre runden Enden unten.
    ctx.lineCap = m > 600 ? 'butt' : 'round';
    // Beim Aufbau blenden die Linien nach den Knoten ein.
    const enterA = enterStart ? easeOut((frameNow - enterStart - ENTER_WAVE_MS * 2) / ENTER_MS) : 1;
    if (enterA <= 0) return;
    const lineAlpha = palette.lineAlpha * (mini ? 0.9 : 1) * enterA;
    const lit = fade > 0;
    if (themen) {
      drawThemeLines(k, lineAlpha, lit);
      return;
    }
    const growing = [];
    // Ohne Licht: alle Linien in einem Pfad -- ein Strich fuer tausend Kanten.
    ctx.beginPath();
    let any = false;
    for (let e = 0; e < m && !overlayOnly; e++) {
      if (!edgeVisible[e]) continue;
      if (edgeBorn[e] && frameNow - edgeBorn[e] < EDGE_GROW_MS) {
        growing.push(e);
        continue;
      }
      const p = edgeA[e];
      const q = edgeB[e];
      if (lit && (bright[p] && bright[q]) && (focusSlot < 0 || p === focusSlot || q === focusSlot)) continue;
      if (!edgeOnScreen(p, q)) continue;
      ctx.moveTo(sx[p], sy[p]);
      ctx.lineTo(sx[q], sy[q]);
      any = true;
    }
    if (any) {
      ctx.strokeStyle = rgba(palette.line, lineAlpha * (1 - fade * (1 - dimAlpha * 0.9)));
      ctx.lineWidth = lw;
      ctx.stroke();
    }
    ctx.lineCap = 'round';
    // Eine neue Verbindung zieht sich vom einen zum anderen Knoten, im Akzent.
    for (const e of growing) {
      const p = edgeA[e];
      const q = edgeB[e];
      const f = easeOut((frameNow - edgeBorn[e]) / EDGE_GROW_MS);
      ctx.beginPath();
      ctx.moveTo(sx[p], sy[p]);
      ctx.lineTo(sx[p] + (sx[q] - sx[p]) * f, sy[p] + (sy[q] - sy[p]) * f);
      ctx.strokeStyle = rgba(palette.accent, 0.9 - 0.4 * f);
      ctx.lineWidth = lw * 1.6;
      ctx.stroke();
    }
    if (!lit) return;
    // Die Linien im Licht: am gewaehlten Knoten blau, sonst (Suche) hell.
    ctx.beginPath();
    any = false;
    for (let e = 0; e < m; e++) {
      if (!edgeVisible[e]) continue;
      const p = edgeA[e];
      const q = edgeB[e];
      if (!(bright[p] && bright[q])) continue;
      if (focusSlot >= 0 && p !== focusSlot && q !== focusSlot) continue;
      if (!edgeOnScreen(p, q)) continue;
      ctx.moveTo(sx[p], sy[p]);
      ctx.lineTo(sx[q], sy[q]);
      any = true;
    }
    if (any) {
      if (focusSlot >= 0 && mini) {
        // Die Kachel bleibt ruhig wie die Vorlage: nur der Punkt ist blau.
        ctx.strokeStyle = rgba(palette.fg, 0.5);
        ctx.lineWidth = lw;
      } else if (focusSlot >= 0) {
        ctx.strokeStyle = rgba(palette.accentSoft, 0.4 + 0.4 * fade);
        ctx.lineWidth = lw * (1 + 0.3 * fade);
      } else {
        ctx.strokeStyle = rgba(palette.line, Math.min(1, lineAlpha * (1 + 0.6 * fade)));
        ctx.lineWidth = lw;
      }
      ctx.stroke();
    }
  }

  /**
   * Themen-Ebene: feine Linien zwischen Themen, die Eintraege teilen -- je
   * mehr gemeinsame, desto etwas kraeftiger (drei Stufen, drei Pfade). Sie
   * enden am Rand der Kreise, nicht in der Mitte, damit sie nicht unter
   * dem Namen durchlaufen.
   */
  function drawThemeLines(k, lineAlpha, lit) {
    const stufen = [[], [], []];
    for (let e = 0; e < m; e++) {
      if (!edgeVisible[e]) continue;
      const w = edgeWeight[e];
      stufen[w >= 6 ? 2 : w >= 2 ? 1 : 0].push(e);
    }
    stufen.forEach((liste, stufe) => {
      if (!liste.length) return;
      const zeichne = (hell) => {
        ctx.beginPath();
        let any = false;
        for (const e of liste) {
          const p = edgeA[e];
          const q = edgeB[e];
          const imLicht = lit && bright[p] && bright[q] && (focusSlot < 0 || p === focusSlot || q === focusSlot);
          if (imLicht !== hell) continue;
          if (!edgeOnScreen(p, q)) continue;
          const dx = sx[q] - sx[p];
          const dy = sy[q] - sy[p];
          const d = Math.hypot(dx, dy) || 1;
          const rp = screenRadius(p, k) * enterProgress(p) + 3;
          const rq = screenRadius(q, k) * enterProgress(q) + 3;
          if (d <= rp + rq) continue;
          const ax = sx[p] + (dx / d) * rp;
          const ay = sy[p] + (dy / d) * rp;
          const bx = sx[q] - (dx / d) * rq;
          const by = sy[q] - (dy / d) * rq;
          // Eine Linie, die unter einem fremden Kreis durchliefe, taeuschte
          // eine Verbindung vor, die es nicht gibt ("Schule-Technik"). In Ruhe
          // bleibt sie weg; im Licht (Thema ueberfahren) liegt sie obenauf.
          if (!hell && durchKreis(ax, ay, bx, by, p, q, k)) continue;
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          any = true;
        }
        if (!any) return;
        const a = hell ? Math.min(1, lineAlpha * 1.3) : lineAlpha * (1 - fade * (1 - dimAlpha * 0.9));
        ctx.strokeStyle = hell ? rgba(palette.accentSoft, 0.4 + 0.4 * fade) : rgba(palette.themeLine, a * (0.55 + stufe * 0.15));
        ctx.lineWidth = (0.8 + stufe * 0.6) * (hell ? 1.4 : 1);
        ctx.stroke();
      };
      zeichne(false);
      if (lit) zeichne(true);
    });
  }

  /** Laeuft die Strecke a-b durch einen Kreis ausser p und q? */
  function durchKreis(ax, ay, bx, by, p, q, k) {
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy || 1;
    for (let i = 0; i < n; i++) {
      if (i === p || i === q || !visible[i]) continue;
      const t = clamp(((sx[i] - ax) * vx + (sy[i] - ay) * vy) / len2, 0, 1);
      const cx = ax + vx * t - sx[i];
      const cy = ay + vy * t - sy[i];
      const r = screenRadius(i, k) + 2;
      if (cx * cx + cy * cy < r * r) return true;
    }
    return false;
  }

  /**
   * Beim Heranzoomen wachsen die Abstaende linear, die Punkte nur gedaempft
   * (k^0.6): so wird das Netz beim Hineingehen luftiger statt dass ein Hub
   * zur Scheibe aufquillt. Themenkreise wachsen linear: sie sind Flaechen.
   */
  function screenRadius(i, k) {
    if (themen) return radius[i] * k;
    const grow = k <= 1 ? k : Math.pow(k, 0.6);
    return Math.max(radius[i] * grow, mini ? 1.6 : 1.15);
  }

  /**
   * Das Art-Symbol im Punkt, in der Farbe des Grundes: zwei Zeilen fuer eine
   * Notiz, ein Ordner fuer ein Projekt, ein Haken fuer eine Aufgabe, ein
   * Kalenderblatt fuer einen Termin, eine Sprechblase fuer einen Chat, ein
   * Blatt mit Eselsohr fuer eine Datei, Kopf und Schultern fuer eine Person,
   * eine Nadel fuer einen Ort, ein Haus fuer eine Organisation, ein kleiner
   * Kreis fuer einen Begriff.
   */
  function glyphPath(type, x, y, s) {
    switch (type) {
      case 'note':
        ctx.moveTo(x - s * 0.8, y - s * 0.35); ctx.lineTo(x + s * 0.8, y - s * 0.35);
        ctx.moveTo(x - s * 0.8, y + s * 0.35); ctx.lineTo(x + s * 0.25, y + s * 0.35);
        break;
      case 'project':
        ctx.moveTo(x - s, y - s * 0.55); ctx.lineTo(x - s * 0.3, y - s * 0.55); ctx.lineTo(x, y - s * 0.2);
        ctx.lineTo(x + s, y - s * 0.2); ctx.lineTo(x + s, y + s * 0.7); ctx.lineTo(x - s, y + s * 0.7); ctx.closePath();
        break;
      case 'task':
        ctx.moveTo(x - s * 0.8, y); ctx.lineTo(x - s * 0.2, y + s * 0.6); ctx.lineTo(x + s * 0.9, y - s * 0.6);
        break;
      case 'event':
        ctx.rect(x - s * 0.85, y - s * 0.7, s * 1.7, s * 1.5);
        ctx.moveTo(x - s * 0.85, y - s * 0.2); ctx.lineTo(x + s * 0.85, y - s * 0.2);
        break;
      case 'chat':
        ctx.moveTo(x - s * 0.9, y - s * 0.6); ctx.lineTo(x + s * 0.9, y - s * 0.6); ctx.lineTo(x + s * 0.9, y + s * 0.4);
        ctx.lineTo(x - s * 0.1, y + s * 0.4); ctx.lineTo(x - s * 0.6, y + s * 0.9); ctx.lineTo(x - s * 0.6, y + s * 0.4);
        ctx.lineTo(x - s * 0.9, y + s * 0.4); ctx.closePath();
        break;
      case 'file':
        ctx.moveTo(x - s * 0.7, y - s * 0.9); ctx.lineTo(x + s * 0.2, y - s * 0.9); ctx.lineTo(x + s * 0.7, y - s * 0.4);
        ctx.lineTo(x + s * 0.7, y + s * 0.9); ctx.lineTo(x - s * 0.7, y + s * 0.9); ctx.closePath();
        break;
      case 'person':
        ctx.moveTo(x + s * 0.35, y - s * 0.45); ctx.arc(x, y - s * 0.45, s * 0.35, 0, TAU);
        ctx.moveTo(x - s * 0.9, y + s * 0.95); ctx.arc(x, y + s * 0.95, s * 0.9, Math.PI, TAU);
        break;
      case 'place':
        ctx.moveTo(x, y + s * 0.95); ctx.lineTo(x - s * 0.55, y - s * 0.05);
        ctx.arc(x, y - s * 0.3, s * 0.6, Math.PI * 0.85, Math.PI * 2.15); ctx.lineTo(x, y + s * 0.95);
        break;
      case 'org':
        ctx.rect(x - s * 0.8, y - s * 0.9, s * 1.6, s * 1.8);
        ctx.moveTo(x - s * 0.3, y - s * 0.4); ctx.lineTo(x + s * 0.3, y - s * 0.4);
        ctx.moveTo(x - s * 0.3, y + s * 0.1); ctx.lineTo(x + s * 0.3, y + s * 0.1);
        break;
      case 'agent': case 'run':
        ctx.moveTo(x, y - s); ctx.lineTo(x, y + s); ctx.moveTo(x - s, y); ctx.lineTo(x + s, y);
        break;
      default:
        ctx.moveTo(x + s * 0.5, y); ctx.arc(x, y, s * 0.5, 0, TAU);
    }
  }

  function glyphType(node) {
    if (node.type === 'entity') return node.kind === 'topic' ? 'term' : (node.kind || 'term');
    return node.type || 'note';
  }

  /**
   * Themen-Ebene: grosse, ruhige Kreise. Fuellung mit einem Hauch des
   * Themen-Tons, feiner Ring; ueberfahren oder gewaehlt bekommt der Kreis
   * den Akzent als Ring und einen weichen Schein. Beim Aufbau wachsen die
   * Kreise aus ihrer Mitte.
   */
  function drawThemes(k) {
    const lit = fade > 0;
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      const p = enterProgress(i);
      if (p <= 0) continue;
      const r = screenRadius(i, k) * (0.6 + 0.4 * p);
      if (!onScreen(i, r + 4)) continue;
      const ck = colorKey[i];
      const hell = lit && (i === focusSlot || i === selected);
      let a = p;
      if (lit && !bright[i]) a *= 1 - fade * (1 - dimAlpha);
      ctx.globalAlpha = a;
      if (hell || i === selected) {
        // Ein leiser Schein, kein zweiter Ring: der Kreis bleibt eine Flaeche.
        ctx.beginPath();
        ctx.arc(sx[i], sy[i], r + 5, 0, TAU);
        ctx.fillStyle = palette.themeGlow;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(sx[i], sy[i], r, 0, TAU);
      ctx.fillStyle = ck >= 0 && palette.themeFill[ck] ? palette.themeFill[ck] : palette.themeFillPlain;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx[i], sy[i], r - 0.5, 0, TAU);
      ctx.strokeStyle = hell || i === selected ? rgba(palette.accent, 0.45 + 0.4 * (i === selected ? 1 : fade)) : ck >= 0 && palette.themeRing[ck] ? palette.themeRing[ck] : palette.themeRingPlain;
      ctx.lineWidth = hell || i === selected ? 1.25 : 1;
      // Ein Behaelter ("Weitere Themen") hat einen gestrichelten Rand.
      if (nodes[i].gestrichelt && !hell) ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }

  function drawNodes(k) {
    if (themen) {
      drawThemes(k);
      return;
    }
    const lit = fade > 0;
    const entering = !!enterStart;
    // Buendel nach Farbe: ein fill() pro Farbe statt eines pro Knoten. Was
    // zuruecktritt, wird mit Deckkraft gemalt statt mit einer zweiten Farbe
    // -- so blendet es weich ueber, statt umzuspringen. Beim Aufbau kommt
    // eine vierte Dimension dazu: die Welle (Hubs zuerst).
    const normal = new Map();
    const dimmed = new Map();
    const outer = new Map(); // Nachbarn ausserhalb des Themas: leiser
    const glyphs = [];
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      const r = screenRadius(i, k);
      if (!onScreen(i, r + 2)) continue;
      if (i === selected || (lit && i === focusSlot)) continue; // kommt zuletzt, im Akzent
      if (overlayOnly && !(lit && bright[i])) continue; // das Zwischenbild hat den Rest
      const ck = colorKey[i];
      let style = ck >= 0 && colors[ck] ? colors[ck] : palette.tiers[tierOf(i)];
      if (entering) style = `${style}\u0001${Math.min(3, Math.floor((labelRank[i] * 4) / Math.max(1, n)))}`;
      const target = lit && !bright[i] ? dimmed : outside[i] ? outer : normal;
      let list = target.get(style);
      if (!list) target.set(style, (list = []));
      list.push(i);
      if (r >= GLYPH_MIN_R && (!lit || bright[i]) && glyphs.length < 400) glyphs.push(i);
    }
    const fillAll = (buckets, baseAlpha) => {
      for (const [key, list] of buckets) {
        const cut = key.indexOf('\u0001');
        const style = cut >= 0 ? key.slice(0, cut) : key;
        let scale = 1;
        if (cut >= 0) {
          scale = easeOut((frameNow - enterStart - Number(key.slice(cut + 1)) * ENTER_WAVE_MS) / ENTER_MS);
          if (scale <= 0) continue;
        }
        ctx.globalAlpha = baseAlpha * scale;
        ctx.beginPath();
        for (const i of list) {
          const r = screenRadius(i, k) * scale;
          ctx.moveTo(sx[i] + r, sy[i]);
          ctx.arc(sx[i], sy[i], r, 0, TAU);
        }
        ctx.fillStyle = style;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    if (dimmed.size) fillAll(dimmed, 1 - fade * (1 - dimAlpha));
    if (outer.size) fillAll(outer, 0.55);
    fillAll(normal, 1);

    // Die Art im Punkt -- nur nah genug, nur im Licht, nie beim Aufbau.
    if (glyphs.length && !entering) {
      ctx.strokeStyle = palette.glyph;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const i of glyphs) {
        const r = screenRadius(i, k);
        ctx.lineWidth = clamp(r * 0.11, 1, 1.5);
        ctx.globalAlpha = outside[i] ? 0.55 : 0.9;
        ctx.beginPath();
        glyphPath(glyphType(nodes[i]), sx[i], sy[i], r * 0.46);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Kachel: die direkten Nachbarn sind helle Punkte mit feinem Ring (Vorlage).
    if (ringIds && ringIds.size) {
      ctx.beginPath();
      for (const id of ringIds) {
        const i = index.get(id);
        if (i === undefined || !visible[i] || i === selected) continue;
        const r = screenRadius(i, k);
        ctx.moveTo(sx[i] + r, sy[i]);
        ctx.arc(sx[i], sy[i], r, 0, TAU);
      }
      ctx.fillStyle = palette.ringFill;
      ctx.fill();
      ctx.beginPath();
      for (const id of ringIds) {
        const i = index.get(id);
        if (i === undefined || !visible[i] || i === selected) continue;
        const r = screenRadius(i, k) + 2.6;
        ctx.moveTo(sx[i] + r, sy[i]);
        ctx.arc(sx[i], sy[i], r, 0, TAU);
      }
      ctx.strokeStyle = palette.ring;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Der gewaehlte oder ueberfahrene Knoten: Akzent mit weichem Schein.
    const accentSlots = [];
    if (selected >= 0 && visible[selected]) accentSlots.push(selected);
    if (lit && focusSlot >= 0 && focusSlot !== selected && visible[focusSlot]) accentSlots.push(focusSlot);
    for (const i of accentSlots) {
      const r = screenRadius(i, k) * (mini ? 1.25 : 1.15) + (mini ? 1.5 : 0.8);
      const strength = i === selected ? 1 : fade;
      ctx.globalAlpha = strength;
      ctx.beginPath();
      ctx.arc(sx[i], sy[i], r + (mini ? 7 : 5), 0, TAU);
      ctx.fillStyle = palette.accentGlow;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (strength < 1) {
        // Beim Ueberblenden liegt der graue Punkt unter dem blauen.
        ctx.beginPath();
        ctx.arc(sx[i], sy[i], screenRadius(i, k), 0, TAU);
        ctx.fillStyle = palette.tiers[tierOf(i)];
        ctx.fill();
        ctx.globalAlpha = strength;
      }
      ctx.beginPath();
      ctx.arc(sx[i], sy[i], r, 0, TAU);
      ctx.fillStyle = palette.accentFill;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (mini) {
        ctx.beginPath();
        ctx.arc(sx[i], sy[i], r, 0, TAU);
        ctx.strokeStyle = rgba(palette.fg, 0.55);
        ctx.lineWidth = 1.2;
        ctx.stroke();
      } else if (r >= GLYPH_MIN_R) {
        // Auf dem Akzentblau ist das Symbol weiss (--accent-fg), hell wie dunkel.
        ctx.strokeStyle = rgba({ r: 255, g: 255, b: 255 }, 0.95 * strength);
        ctx.lineWidth = clamp(r * 0.11, 1, 1.6);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        glyphPath(glyphType(nodes[i]), sx[i], sy[i], r * 0.42);
        ctx.stroke();
      }
    }
  }

  function labelWidth(i, font, px) {
    if (labelFontCache !== px) {
      labelFontCache = px;
      labelWidthCache = new Array(n);
    }
    let w = labelWidthCache[i];
    if (w === undefined) {
      ctx.font = font;
      w = ctx.measureText(labelText(i)).width;
      labelWidthCache[i] = w;
    }
    return w;
  }

  function labelText(i) {
    const node = nodes[i];
    // Die Kachel kuerzt nach Platz (unten beim Setzen), nicht nach Zeichen.
    return clip(node.label || node.title || node.id, mini ? 40 : 34);
  }

  /** Einen Namen auf eine Breite kuerzen (mit der gerade gesetzten Schrift). */
  function kuerzeAuf(textIn, maxW) {
    let t = textIn;
    if (ctx.measureText(t).width <= maxW) return t;
    while (t.length > 4 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
    return `${t.trimEnd()}…`;
  }

  /**
   * Beschriftungen. Gewoehnliche erscheinen ab `labelZoom`; darunter (die
   * Uebersicht) tragen nur die groessten Knoten ihren Namen, wie in
   * Obsidian -- Waisen im Ring nie. Im Licht stehen der Knoten und seine
   * Nachbarn immer da. Was sich ueberlappen wuerde, faellt weg -- der
   * wichtigere Knoten gewinnt, weil er zuerst kommt.
   */
  /**
   * Themen-Ebene: der Name in der Mitte des Kreises, darunter leise
   * "42 Eintraege". Ist der Kreis auf dem Bildschirm zu klein dafuer, steht
   * der Name unter dem Kreis. Ein zu langer Name wird auf die Breite des
   * Kreises gekuerzt -- nicht umgebrochen, ein Kreis ist keine Spalte.
   */
  /**
   * Einen Namen auf hoechstens `maxLines` Zeilen der Breite `maxW` legen
   * (mit der gerade gesetzten Schrift): Woerter greedy, die letzte Zeile
   * bekommt bei Bedarf Auslassungspunkte. Ein Kreis ist keine Spalte --
   * mehr als zwei Zeilen gibt es nicht.
   */
  function wrapName(name, maxW, maxLines) {
    // Ein Wort, das allein breiter ist als der Kreis ("Steuererklaerung"),
    // wird getrennt statt abgeschnitten: "Steuer-" / "erklaerung".
    const words = [];
    let getrennt = false;
    for (const w of String(name).split(/\s+/).filter(Boolean)) {
      if (ctx.measureText(w).width <= maxW || w.length < 8) { words.push(w); continue; }
      getrennt = true;
      let rest = w;
      while (rest.length >= 8 && ctx.measureText(rest).width > maxW) {
        let cut = rest.length - 3;
        while (cut > 4 && ctx.measureText(`${rest.slice(0, cut)}-`).width > maxW) cut--;
        if (cut <= 4) break;
        words.push(`${rest.slice(0, cut)}-`);
        rest = rest.slice(cut);
      }
      words.push(rest);
    }
    const lines = [];
    let cur = '';
    for (const w of words) {
      const probe = cur ? (cur.endsWith('-') ? `${cur}${w}` : `${cur} ${w}`) : w;
      if (ctx.measureText(probe).width <= maxW || !cur) cur = probe;
      else {
        lines.push(cur);
        cur = w;
        if (lines.length === maxLines) break;
      }
    }
    if (lines.length < maxLines && cur) lines.push(cur);
    else if (cur && lines.length === maxLines) lines[maxLines - 1] = `${lines[maxLines - 1]} ${cur}`;
    if (!lines.length) lines.push(String(name));
    const last = lines.length - 1;
    let s = lines[last];
    while (ctx.measureText(s).width > maxW && s.length > 3) { s = `${s.slice(0, s.length - 2).trimEnd()}…`; getrennt = true; }
    lines[last] = s;
    lines.getrennt = getrennt;
    return lines;
  }

  function drawThemeLabels(k) {
    const lit = fade > 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Groesste Kreise zuerst: wo sich Namen ueberlagern wuerden (herausgezoomt),
    // behaelt der groessere seinen und der kleinere schweigt -- wie auf Ebene 1.
    const reihe = [];
    for (let i = 0; i < n; i++) if (visible[i]) reihe.push(i);
    reihe.sort((p, q) => radius[q] - radius[p] || p - q);
    const belegt = [];
    const frei = (b) => !belegt.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
    for (const i of reihe) {
      const p = enterProgress(i);
      if (p <= 0.2) continue;
      const r = screenRadius(i, k);
      if (!onScreen(i, r + 40)) continue;
      const node = nodes[i];
      let a = easeOut((p - 0.2) / 0.8);
      if (lit && !bright[i]) a *= 1 - fade * (1 - dimAlpha);
      const strong = i === selected || (lit && i === focusSlot);
      const px = clamp(Math.round(r * 0.3), 11, 16);
      const innen = r >= 30;
      const font = `500 ${px}px ${fontFamily}`;
      ctx.font = font;
      const maxW = innen ? r * 1.72 : 180;
      const voll = clip(node.label || node.name || node.id, 48);
      let zeilen = wrapName(voll, maxW, innen ? 2 : 1);
      // Ein kleiner Kreis, in den der Name nur getrennt oder gekuerzt passte
      // ("Steuererkl-aerung"): der Name steht ganz darunter, die Zahl innen.
      const unten = innen && r < 48 && zeilen.getrennt;
      if (unten) zeilen = [voll];
      const count = `${formatCount(node.anzahl)} ${Number(node.anzahl) === 1 ? 'Eintrag' : 'Einträge'}`;
      const subPx = clamp(Math.round(r * 0.19), 11, 12);
      // Unterthemen andeuten, wenn der Kreis gross genug ist: "Biologie · Geschichte".
      const kinder = Array.isArray(node.kinder) ? node.kinder : [];
      let kinderZeile = '';
      if (innen && r >= 56 && kinder.length) {
        ctx.font = `${subPx}px ${fontFamily}`;
        kinderZeile = kinder.slice(0, 2).map((c) => c.name).join(' · ') + (kinder.length > 2 ? ` +${kinder.length - 2}` : '');
        while (kinderZeile.length > 6 && ctx.measureText(kinderZeile).width > r * 1.6) kinderZeile = `${kinderZeile.slice(0, -2).trimEnd()}…`;
        ctx.font = font;
      }
      const zeilenH = px * 1.15;
      const block = innen && !unten ? zeilen.length * zeilenH + subPx * 1.3 + (kinderZeile ? subPx * 1.3 : 0) : zeilenH;
      let breit = 0;
      for (const z of zeilen) breit = Math.max(breit, ctx.measureText(z).width);
      const box = innen && !unten
        ? { x: sx[i] - breit / 2 - 4, y: sy[i] - block / 2 - 2, w: breit + 8, h: block + 4 }
        : { x: sx[i] - breit / 2 - 4, y: sy[i] + r + 10 - zeilenH / 2, w: breit + 8, h: zeilenH + 2 };
      // Ein Name unter dem Kreis darf keinen fremden Kreis ueberdecken.
      const ueberKreis = (innen && !unten) ? false : reihe.some((j) => {
        if (j === i) return false;
        const rj = screenRadius(j, k);
        const cx = clamp(sx[j], box.x, box.x + box.w);
        const cy = clamp(sy[j], box.y, box.y + box.h);
        return (sx[j] - cx) ** 2 + (sy[j] - cy) ** 2 < rj * rj;
      });
      if (!strong && (!frei(box) || ueberKreis)) {
        // Kein Platz fuer den Namen: die Zahl im Kreis bleibt trotzdem.
        if (unten) {
          ctx.globalAlpha = a;
          ctx.font = `${subPx}px ${fontFamily}`;
          ctx.fillStyle = palette.themeSub;
          ctx.fillText(count, sx[i], sy[i]);
        }
        continue;
      }
      belegt.push(box);
      ctx.globalAlpha = a;
      if (unten) {
        ctx.font = `${subPx}px ${fontFamily}`;
        ctx.fillStyle = palette.themeSub;
        ctx.fillText(count, sx[i], sy[i]);
        ctx.font = font;
        ctx.lineWidth = 3;
        ctx.strokeStyle = palette.halo;
        ctx.strokeText(zeilen[0], sx[i], sy[i] + r + 10);
        ctx.fillStyle = strong ? palette.labelStrong : palette.themeText;
        ctx.fillText(zeilen[0], sx[i], sy[i] + r + 10);
      } else if (innen) {
        // Name (eine oder zwei Zeilen) und darunter die Zahl, als Block mittig.
        let y = sy[i] - block / 2 + zeilenH / 2;
        ctx.fillStyle = strong ? palette.labelStrong : palette.themeText;
        for (const z of zeilen) {
          ctx.fillText(z, sx[i], y);
          y += zeilenH;
        }
        ctx.font = `${subPx}px ${fontFamily}`;
        ctx.fillStyle = palette.themeSub;
        ctx.fillText(count, sx[i], y - zeilenH / 2 + subPx * 0.85);
        if (kinderZeile) ctx.fillText(kinderZeile, sx[i], y - zeilenH / 2 + subPx * 0.85 + subPx * 1.3);
      } else {
        ctx.lineWidth = 3;
        ctx.strokeStyle = palette.halo;
        ctx.strokeText(zeilen[0], sx[i], sy[i] + r + 10);
        ctx.fillStyle = strong ? palette.labelStrong : palette.themeText;
        ctx.fillText(zeilen[0], sx[i], sy[i] + r + 10);
      }
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  function drawLabels(k) {
    if (themen) {
      drawThemeLabels(k);
      return;
    }
    // Beim Aufbau kommen die Namen zuletzt.
    const enterA = enterStart ? easeOut((frameNow - enterStart - ENTER_WAVE_MS * 3) / ENTER_MS) : 1;
    if (enterA <= 0) return;
    // Halbe Pixel als Stufen: sonst aendert jeder Zoomschritt die Schrift
    // und jede Breite muesste neu gemessen werden.
    const px = mini ? 12.5 : Math.round(clamp(10.5 + 1.6 * Math.log2(Math.max(k, 0.25) + 1), 10.5, 15) * 2) / 2;
    const font = `${px}px ${fontFamily}`;
    ctx.font = font;
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    const placed = [];
    const cell = 80;
    const grid = new Map();
    const collides = (x, y, w, hgt) => {
      const c0 = Math.floor(x / cell);
      const c1 = Math.floor((x + w) / cell);
      const r0 = Math.floor(y / cell);
      const r1 = Math.floor((y + hgt) / cell);
      for (let cx = c0; cx <= c1; cx++) {
        for (let cy = r0; cy <= r1; cy++) {
          const list = grid.get(cx * 100003 + cy);
          if (!list) continue;
          for (const b of list) {
            if (x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + hgt > b.y) return true;
          }
        }
      }
      return false;
    };
    const occupy = (box) => {
      const c0 = Math.floor(box.x / cell);
      const c1 = Math.floor((box.x + box.w) / cell);
      const r0 = Math.floor(box.y / cell);
      const r1 = Math.floor((box.y + box.h) / cell);
      for (let cx = c0; cx <= c1; cx++) {
        for (let cy = r0; cy <= r1; cy++) {
          const key = cx * 100003 + cy;
          let list = grid.get(key);
          if (!list) grid.set(key, (list = []));
          list.push(box);
        }
      }
    };

    const lit = fade > 0;
    const lz = settings.labelZoom;
    // Die Uebersicht ist, was "Einpassen" zeigt. Bei einem kleinen Netz
    // liegt sie schon ueber labelZoom (Einpassen geht bis 1,6) -- gewoehnliche
    // Namen kommen deshalb erst deutlich hinter dem eingepassten Bild, der
    // Regler verschiebt das anteilig. 0 in der Uebersicht, 1 ab der
    // Schwelle; die groessten stehen immer (topSlots).
    const fit = mini ? null : fitTransform();
    const schwelle = Math.max(lz, fit ? fit.k * 1.6 * (lz / GRAPH_DEFAULTS.labelZoom) : lz);
    // Ein Thema mit wenigen Eintraegen (Ebene 1) traegt alle Namen, die
    // Platz finden -- man will lesen, was man geoeffnet hat. Erst ein
    // dichtes Netz blendet gewoehnliche Namen nach Zoom ein (LOD).
    const dicht = visibleCount > DICHT_AB;
    const gate = dicht ? clamp((k - 0.8 * schwelle) / (0.2 * schwelle), 0, 1) : 1;
    const list = [];
    // Zuerst die, die immer stehen muessen: Fokus und Nachbarn.
    const forced = new Set();
    if (lit && focusSlot >= 0) {
      forced.add(focusSlot);
      for (let q = adjStart[focusSlot]; q < adjStart[focusSlot + 1]; q++) if (visible[adjList[q]]) forced.add(adjList[q]);
    }
    if (selected >= 0 && visible[selected]) forced.add(selected);
    if (alwaysLabel) {
      for (const id of alwaysLabel) {
        const i = index.get(id);
        if (i !== undefined && visible[i]) forced.add(i);
      }
    }
    const focusFirst = [...forced].sort((p, q) => (p === focusSlot || p === selected ? -1 : 0) - (q === focusSlot || q === selected ? -1 : 0) || degree[q] - degree[p]);
    // Nachbarn blenden mit dem Licht ein und aus, statt am Ende wegzuspringen.
    for (const i of focusFirst) list.push([i, i === selected || mini ? 1 : Math.max(fade, 0.04), true]);
    if (!mini) {
      for (let o = 0; o < labelOrder.length; o++) {
        const i = labelOrder[o];
        if (!visible[i] || forced.has(i)) continue;
        if (overlayOnly && !(lit && highlightSet && bright[i])) continue; // die anderen stehen im Zwischenbild
        const importance = radius[i] / (2.8 * settings.nodeScale);
        let a = dicht ? clamp((k * importance - lz) / (0.45 * lz), 0, 1) : 1;
        a = topSlots.has(i) ? 1 : a * gate;
        if (lit && !bright[i]) a *= 1 - fade * 0.85;
        else if (lit && highlightSet && bright[i]) a = Math.max(a, fade * 0.9);
        if (a < 0.04) continue;
        list.push([i, a, false]);
        if (list.length > 400) break;
      }
    }

    const hgt = px * 1.25;
    // Die Namen der Bereiche (Unterthemen) haben Vorrang: kein Knotenname
    // liegt darauf.
    if (regions.length && !overlayOnly) {
      for (const g of regionGeo()) if (g) occupy({ x: g.label.x - 2, y: g.label.y - 2, w: g.label.w + 4, h: g.label.h + 4 });
    }
    if (mini) {
      // In der Kachel sind die Punkte selbst belegt: ein Name, der auf dem
      // eigenen oder einem fremden Punkt liegt, liest sich nicht.
      for (let i = 0; i < n; i++) {
        if (!visible[i]) continue;
        const r = screenRadius(i, k) + 3;
        occupy({ x: sx[i] - r, y: sy[i] - r, w: r * 2, h: r * 2, own: i });
      }
    }
    const fits = (x, y, w) => x >= 2 && y >= 2 && x + w <= width - 2 && y + hgt <= height - 2;
    const free = (x, y, w, self) => {
      const c0 = Math.floor((x - 2) / cell);
      const c1 = Math.floor((x + w + 2) / cell);
      const r0 = Math.floor((y - 1) / cell);
      const r1 = Math.floor((y + hgt + 1) / cell);
      for (let cx = c0; cx <= c1; cx++) {
        for (let cy = r0; cy <= r1; cy++) {
          const cellList = grid.get(cx * 100003 + cy);
          if (!cellList) continue;
          for (const b of cellList) {
            if (b.own === self) continue;
            if (x - 2 < b.x + b.w && x + w + 2 > b.x && y - 1 < b.y + b.h && y + hgt + 1 > b.y) return false;
          }
        }
      }
      return true;
    };
    for (const [i, a, isForced] of list) {
      const r = screenRadius(i, k);
      if (!onScreen(i, 200)) continue;
      const w = labelWidth(i, font, px);
      let x;
      let y;
      if (mini) {
        // Nach aussen: vom Mittelpunkt der Kachel weg, wie in der Vorlage.
        // Passt es dort nicht (Rand, fremder Punkt), dann darunter, darueber
        // oder zur anderen Seite -- nie auf den eigenen Punkt geschoben.
        const dx = sx[i] - width / 2;
        const dy = sy[i] - height / 2;
        const right = [sx[i] + r + 8, sy[i] - hgt / 2];
        const left = [sx[i] - r - 8 - w, sy[i] - hgt / 2];
        const below = [sx[i] - w / 2, sy[i] + r + 6];
        const above = [sx[i] - w / 2, sy[i] - r - 6 - hgt];
        let cands;
        if (i === selected) cands = [right, below, above, left];
        else if (Math.abs(dx) > Math.abs(dy) * 1.2) cands = dx > 0 ? [right, below, above, left] : [left, below, above, right];
        else cands = dy > 0 ? [below, dx > 0 ? right : left, above] : [above, dx > 0 ? right : left, below];
        let pick = cands.find(([cx, cy]) => fits(cx, cy, w) && free(cx, cy, w, i))
          || cands.find(([cx, cy]) => fits(cx, cy, w));
        let kurz = null;
        if (!pick) {
          // Passt der ganze Name nirgends: dort, wo am meisten Platz ist, und
          // nach der Breite gekuerzt -- nicht nach Zeichenzahl (Pruefer, Runde 1).
          const platz = (c) => (c === right ? width - 4 - right[0] : c === left ? left[0] + w - 4 : width - 8);
          pick = cands.slice().sort((a2, b2) => platz(b2) - platz(a2))[0];
          ctx.font = font;
          kurz = kuerzeAuf(labelText(i), Math.max(40, platz(pick)));
          const kw = ctx.measureText(kurz).width;
          if (pick === left) pick = [left[0] + w - kw, left[1]];
          else if (pick !== right) pick = [sx[i] - kw / 2, pick[1]];
        }
        const breite = kurz ? ctx.measureText(kurz).width : w;
        x = clamp(pick[0], 2, Math.max(2, width - breite - 2));
        y = clamp(pick[1], 2, Math.max(2, height - hgt - 2));
        const box = { x: x - 2, y: y - 1, w: breite + 4, h: hgt + 2 };
        if (collides(box.x, box.y, box.w, box.h) && !(isForced && (i === focusSlot || i === selected))) continue;
        occupy(box);
        placed.push([i, x, y, a, isForced, kurz]);
        continue;
      } else {
        x = sx[i] - w / 2;
        y = sy[i] + r + 3;
      }
      const box = { x: x - 2, y: y - 1, w: w + 4, h: hgt + 2 };
      if (collides(box.x, box.y, box.w, box.h) && !(isForced && (i === focusSlot || i === selected))) continue;
      occupy(box);
      placed.push([i, x, y, a, isForced]);
    }

    // Erst alle Schatten, dann alle Schriften: ein Text liegt nie unter dem
    // Schatten eines Nachbarn.
    ctx.lineWidth = 3;
    ctx.strokeStyle = palette.halo;
    const alphaOf = (i, a, isForced) => a * enterA * (outside[i] && !isForced ? 0.6 : 1);
    for (const [i, x, y, a, isForced, kurz] of placed) {
      ctx.globalAlpha = alphaOf(i, a, isForced);
      ctx.strokeText(kurz || labelText(i), x, y);
    }
    for (const [i, x, y, a, isForced, kurz] of placed) {
      ctx.globalAlpha = alphaOf(i, a, isForced);
      const strong = i === focusSlot || i === selected;
      ctx.fillStyle = strong ? palette.labelStrong : isForced && !mini ? palette.labelStrong : palette.label;
      ctx.fillText(kurz || labelText(i), x, y);
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------------------- Groesse ---------------------------- */

  function resize() {
    sceneVersion++;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(0, Math.round(rect.width));
    const hgt = Math.max(0, Math.round(rect.height));
    const nextDpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (w === width && hgt === height && nextDpr === dpr) return api;
    // Die Weltmitte bleibt in der Bildmitte, wenn sich die Flaeche aendert
    // (Seite ein- oder ausgeklappt).
    if (width && height) {
      transform = { ...transform, x: transform.x + (w - width) / 2, y: transform.y + (hgt - height) / 2 };
    }
    width = w;
    height = hgt;
    dpr = nextDpr;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(hgt * dpr));
    labelFontCache = 0;
    requestFrame();
    return api;
  }

  let resizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => {
      resize();
      // Die Kachel passt sich immer neu ein; im grossen Bild bleibt die
      // Kamera, wo der Mensch sie hingestellt hat.
      if (mini) fitToView({ animate: false });
      draw();
    });
    resizeObserver.observe(canvas);
  }

  /* ---------------------------- Bedienung -------------------------- */

  const pointers = new Map(); // pointerId -> {x, y}
  let gesture = null; // {kind:'node'|'pan'|'pinch', ...}
  let lastTap = { time: 0, slot: -1, x: 0, y: 0 };

  function local(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function nodeAt(x, y, slop) {
    let best = -1;
    let bestD = Infinity;
    const k = transform.k;
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      const r = screenRadius(i, k) + slop;
      const dx = sx[i] - x;
      const dy = sy[i] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r && d2 < bestD) {
        bestD = d2;
        best = i;
      }
    }
    return best;
  }

  function setHovered(slot) {
    if (slot === hovered) return;
    hovered = slot;
    canvas.style.cursor = slot >= 0 ? 'pointer' : gesture && gesture.kind === 'pan' ? 'grabbing' : '';
    emit('onHover', slot >= 0 ? nodes[slot] : null);
    requestFrame();
  }

  function userMoved() {
    autoFit = false;
    animation = null;
    emit('onUserMove');
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button > 0) return;
    const p = local(event);
    pointers.set(event.pointerId, p);
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch { /* ein Stift ohne Capture geht auch */ }
    if (pointers.size === 2) {
      // Zwei Finger: zoomen und schieben, ein angefangener Zug endet -- und
      // das Licht, das der erste Finger auf einem Knoten angemacht hat, geht
      // aus. Sonst bliebe der Knoten nach dem Zoomen blau haengen.
      clearPress(gesture);
      if (gesture && gesture.kind === 'node' && gesture.dragging) releaseNode(gesture.slot);
      if (event.pointerType === 'touch') setHovered(-1);
      const [a, b] = [...pointers.values()];
      gesture = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      userMoved();
      return;
    }
    if (pointers.size > 2) return;
    const slop = event.pointerType === 'touch' ? 14 : 5;
    const slot = nodeAt(p.x, p.y, slop);
    gesture = slot >= 0
      ? { kind: 'node', slot, start: p, dragging: false, pointerType: event.pointerType, timer: 0, longPressed: false }
      : { kind: 'pan', start: p, last: p, moved: false, pointerType: event.pointerType };
    if (event.pointerType === 'touch' && slot >= 0) {
      setHovered(slot);
      // Langes Druecken: der Finger bleibt liegen, ohne zu ziehen.
      const g = gesture;
      g.timer = setTimeout(() => {
        if (gesture !== g || g.dragging || destroyed) return;
        g.longPressed = true;
        setSelection(nodes[g.slot].id);
        emit('onSelect', nodes[g.slot]);
        emit('onLongPress', nodes[g.slot]);
      }, LONG_PRESS_MS);
    }
  }

  function clearPress(g) {
    if (g && g.timer) {
      clearTimeout(g.timer);
      g.timer = 0;
    }
  }

  function onPointerMove(event) {
    const p = local(event);
    if (!pointers.has(event.pointerId)) {
      // Maus ohne gedrueckte Taste: nur Ueberfahren.
      if (event.pointerType === 'mouse' || event.pointerType === 'pen') {
        const slot = nodeAt(p.x, p.y, 4);
        setHovered(slot);
        if (regions.length) setHoveredRegion(slot >= 0 ? -1 : regionLabelAt(p.x, p.y));
        if (hoveredRegion >= 0) canvas.style.cursor = 'pointer';
      }
      return;
    }
    pointers.set(event.pointerId, p);
    if (!gesture) return;
    if (gesture.kind === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      zoomAround(dist / gesture.dist, gesture.mid.x, gesture.mid.y);
      transform = { ...transform, x: transform.x + mid.x - gesture.mid.x, y: transform.y + mid.y - gesture.mid.y };
      gesture.dist = dist;
      gesture.mid = mid;
      requestFrame();
      checkLevel(mid.x, mid.y);
      return;
    }
    if (gesture.kind === 'node') {
      const moved = Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y);
      if (gesture.longPressed) return; // nach langem Druecken zieht der Finger nicht mehr
      if (!gesture.dragging && moved > CLICK_SLOP) {
        clearPress(gesture);
        gesture.dragging = true;
        userMoved();
        fixed[gesture.slot] = 1;
        alphaTarget = 0.25;
        reheat(0.25);
        canvas.style.cursor = 'grabbing';
      }
      if (gesture.dragging) {
        sceneVersion++;
        fixX[gesture.slot] = (p.x - transform.x) / transform.k;
        fixY[gesture.slot] = (p.y - transform.y) / transform.k;
        posX[gesture.slot] = fixX[gesture.slot];
        posY[gesture.slot] = fixY[gesture.slot];
        requestFrame();
      }
      return;
    }
    if (gesture.kind === 'pan') {
      const moved = Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y);
      if (!gesture.moved && moved > CLICK_SLOP) {
        gesture.moved = true;
        userMoved();
        canvas.style.cursor = 'grabbing';
      }
      if (gesture.moved) {
        transform = { ...transform, x: transform.x + p.x - gesture.last.x, y: transform.y + p.y - gesture.last.y };
        requestFrame();
      }
      gesture.last = p;
    }
  }

  function releaseNode(slot) {
    // Losgelassen schwingt der Knoten zurueck in die Wolke, wie in Obsidian:
    // wer eine Karte aufraeumen will, soll nicht jeden Knoten festnageln.
    fixed[slot] = 0;
    alphaTarget = 0;
    reheat(0.18);
  }

  function onPointerUp(event) {
    const p = pointers.get(event.pointerId) || local(event);
    pointers.delete(event.pointerId);
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch { /* schon frei */ }
    if (!gesture) return;
    if (gesture.kind === 'pinch') {
      if (pointers.size === 0) gesture = null;
      else {
        // Ein Finger bleibt liegen: er schiebt weiter, ohne Sprung.
        const rest = [...pointers.values()][0];
        gesture = { kind: 'pan', start: rest, last: rest, moved: true, pointerType: 'touch' };
      }
      return;
    }
    const g = gesture;
    gesture = null;
    clearPress(g);
    canvas.style.cursor = hovered >= 0 ? 'pointer' : '';
    if (g.kind === 'node') {
      if (g.dragging) {
        releaseNode(g.slot);
        if (g.pointerType === 'touch') setHovered(-1);
        return;
      }
      if (g.pointerType === 'touch') setHovered(-1);
      if (g.longPressed) return; // das lange Druecken hat schon gewaehlt
      tap(g.slot, p);
      return;
    }
    if (g.kind === 'pan' && !g.moved) {
      tap(-1, p);
    }
  }

  function tap(slot, p) {
    const now = performance.now();
    const again = now - lastTap.time < DOUBLE_TAP_MS && lastTap.slot === slot
      && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 24;
    lastTap = { time: again ? 0 : now, slot, x: p.x, y: p.y };
    if (slot >= 0) {
      setSelection(nodes[slot].id);
      emit('onSelect', nodes[slot]);
      if (again) emit('onOpen', nodes[slot]);
    } else {
      // Ein Bereich (Unterthema): sein Name antippen, oder zweimal in seine
      // Flaeche tippen, taucht hinein.
      const ri = regions.length ? regionLabelAt(p.x, p.y) : -1;
      if (ri >= 0) {
        lastTap = { time: 0, slot: -1, x: p.x, y: p.y };
        emit('onRegion', regionInfo(ri), 'tippen');
        return;
      }
      if (again) {
        const ra = regions.length ? regionAreaAt(p.x, p.y) : -1;
        if (ra >= 0) {
          emit('onRegion', regionInfo(ra), 'tippen');
          return;
        }
        zoomBy(1.6, p.x, p.y, true);
        return;
      }
      setSelection(null);
      emit('onSelect', null);
    }
  }

  function onPointerCancel(event) {
    pointers.delete(event.pointerId);
    clearPress(gesture);
    if (gesture && gesture.kind === 'node' && gesture.dragging) releaseNode(gesture.slot);
    if (!pointers.size) gesture = null;
  }

  /**
   * Zoomschwellen. Themen-Ebene: wer deutlich ueber das Eingepasste hinein
   * zoomt, meint das Thema unter dem Zeiger -- onDive. Netz-Ebene: wer weit
   * unter das Eingepasste hinaus zoomt, will die Uebersicht -- onSurface.
   * Jede Schwelle meldet einmal und erst wieder, wenn der Zoom zurueck war.
   */
  function checkLevel(px, py, kOverride) {
    if (!interactive || !n) return;
    const fit = fitTransform();
    if (!fit) return;
    const k = Number.isFinite(kOverride) ? kOverride : transform.k;
    if (themen) {
      if (k > fit.k * DIVE_FACTOR) {
        if (!levelArmed) return;
        const slot = nearestNode(px, py, 260);
        if (slot < 0) return;
        levelArmed = false;
        schluckenSeit = performance.now();
        emit('onDive', nodes[slot]);
      } else if (k < fit.k * 1.5) levelArmed = true;
      return;
    }
    if (k < fit.k * SURFACE_FACTOR) {
      if (!levelArmed) return;
      levelArmed = false;
      schluckenSeit = performance.now();
      emit('onSurface');
      return;
    }
    if (k > fit.k * 0.7) levelArmed = true;
    // Tief in einen Bereich hineingezoomt: in das Unterthema tauchen -- so geht
    // es von "Schule" ueber "Biologie" bis "Genetik" hinein (Vision).
    if (regions.length) {
      if (k > fit.k * DIVE_FACTOR) {
        if (!regionArmed) return;
        const ri = regionAreaAt(px, py);
        if (ri < 0) return;
        regionArmed = false;
        schluckenSeit = performance.now();
        emit('onRegion', regionInfo(ri), 'zoom');
      } else if (k < fit.k * 1.6) regionArmed = true;
    }
  }

  /**
   * Wie weit gezoomt werden darf. Themen-Ebene: kaum kleiner als eingepasst
   * (sonst schrumpft das Universum zum Klumpen) und nur bis knapp ueber die
   * Tauchschwelle. Netz mit Rueckweg (onSurface): nicht unter die Schwelle,
   * an der es ohnehin ins Universum zurueckgeht.
   */
  function zoomGrenzen() {
    if (!interactive) return [MIN_ZOOM, MAX_ZOOM];
    const fit = fitTransform();
    if (!fit) return [MIN_ZOOM, MAX_ZOOM];
    if (themen) return [Math.max(MIN_ZOOM, fit.k * 0.8), Math.min(MAX_ZOOM, fit.k * DIVE_FACTOR * 1.08)];
    if (typeof options.onSurface === 'function') return [Math.max(MIN_ZOOM, fit.k * SURFACE_FACTOR * 0.96), MAX_ZOOM];
    return [MIN_ZOOM, MAX_ZOOM];
  }

  /** Der Knoten, dessen Mitte dem Bildschirmpunkt am naechsten liegt (bis maxDist). */
  function nearestNode(x, y, maxDist) {
    let best = -1;
    let bestD = maxDist * maxDist;
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      const dx = sx[i] - x;
      const dy = sy[i] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) {
        bestD = d2;
        best = i;
      }
    }
    return best;
  }

  function onPointerLeave(event) {
    if (event.pointerType === 'mouse' && !pointers.size) setHovered(-1);
  }

  function onWheel(event) {
    event.preventDefault();
    if (schluckenSeit) {
      const jetzt = performance.now();
      if (jetzt - schluckenSeit < 260) {
        schluckenSeit = jetzt;
        return;
      }
      schluckenSeit = 0;
    }
    const p = local(event);
    let dy = event.deltaY;
    if (event.deltaMode === 1) dy *= 16;
    else if (event.deltaMode === 2) dy *= height || 600;
    // ctrlKey = Zwei-Finger-Zoom auf dem Trackpad: feinere, groessere Schritte.
    const factor = Math.exp(-dy * (event.ctrlKey ? 0.012 : 0.0016));
    userMoved();
    zoomAround(factor, p.x, p.y);
    requestFrame();
    checkLevel(p.x, p.y);
  }

  function onKeyDown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const stepPx = event.shiftKey ? 160 : 60;
    let handled = true;
    switch (event.key) {
      case 'ArrowLeft': transform = { ...transform, x: transform.x + stepPx }; userMoved(); break;
      case 'ArrowRight': transform = { ...transform, x: transform.x - stepPx }; userMoved(); break;
      case 'ArrowUp': transform = { ...transform, y: transform.y + stepPx }; userMoved(); break;
      case 'ArrowDown': transform = { ...transform, y: transform.y - stepPx }; userMoved(); break;
      case '+': case '=': zoomBy(1.25, width / 2, height / 2, true); break;
      case '-': case '_': zoomBy(0.8, width / 2, height / 2, true); break;
      case '0': case 'f': fitToView(); break;
      case 'Escape':
        if (selected >= 0) {
          setSelection(null);
          emit('onSelect', null);
        } else handled = false;
        break;
      default: handled = false;
    }
    if (handled) {
      event.preventDefault();
      requestFrame();
    }
  }

  function onVisibility() {
    if (!document.hidden) {
      lastFrame = 0;
      requestFrame();
    } else if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  const listeners = [];
  function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    listeners.push(() => target.removeEventListener(type, fn, opts));
  }
  if (interactive) {
    canvas.style.touchAction = 'none';
    listen(canvas, 'pointerdown', onPointerDown);
    listen(canvas, 'pointermove', onPointerMove);
    listen(canvas, 'pointerup', onPointerUp);
    listen(canvas, 'pointercancel', onPointerCancel);
    listen(canvas, 'pointerleave', onPointerLeave);
    listen(canvas, 'wheel', onWheel, { passive: false });
    listen(canvas, 'keydown', onKeyDown);
  }
  listen(document, 'visibilitychange', onVisibility);

  /* ---------------------------- Oeffentlich ------------------------ */

  function setSelection(id) {
    const slot = id == null ? -1 : index.get(id);
    selected = slot === undefined ? -1 : slot;
    if (selected >= 0 && !visible[selected]) selected = -1;
    brightKey = null;
    requestFrame();
    return api;
  }

  function setFilter(fn) {
    sceneVersion++;
    filterFn = typeof fn === 'function' ? fn : null;
    const before = visible.slice();
    applyFilter();
    // Nur wenn sich wirklich etwas zeigt oder verschwindet, kommt Bewegung
    // in die Wolke. Ein Nachladen mit demselben Filter laesst sie in Ruhe.
    let changed = before.length !== visible.length;
    for (let i = 0; !changed && i < visible.length; i++) changed = before[i] !== visible[i];
    if (changed) reheat(0.35);
    else requestFrame();
    return api;
  }

  /** Einen Knoten an eine Weltposition heften (Kachel: die Mitte). */
  function pin(id, x = 0, y = 0) {
    sceneVersion++;
    const s = index.get(id);
    if (s === undefined) return api;
    fixed[s] = 1;
    fixX[s] = x;
    fixY[s] = y;
    posX[s] = x;
    posY[s] = y;
    return api;
  }

  function setOrphans(show) {
    sceneVersion++;
    const next = show !== false;
    if (next === showOrphans) return api;
    showOrphans = next;
    applyFilter();
    reheat(0.3);
    return api;
  }

  function setHighlight(ids) {
    if (!ids) highlightSet = null;
    else {
      highlightSet = new Set();
      for (const id of ids) {
        const s = index.get(id);
        if (s !== undefined && visible[s]) highlightSet.add(s);
      }
    }
    brightKey = null;
    requestFrame();
    return api;
  }

  /**
   * Themenfarben. `colorOf`: Map id -> Index in `list`; `list`: CSS-Farben.
   * null schaltet sie ab. Gedaempft wird hier, nicht in der Ansicht: ein
   * Thema faerbt den Punkt, es schreit nicht.
   */
  function setColors(colorOf, list) {
    sceneVersion++;
    colorKey.fill(-1);
    colors = [];
    if (colorOf && Array.isArray(list) && palette) {
      // Ein Hauch, kein Anstrich: gut ein Drittel Ton in ein helles Grau.
      colors = list.map((css) => {
        const c = parseColor(ctx, css, palette.fg);
        return rgba(mix(mix(palette.ground, palette.fg, palette.dark ? 0.74 : 0.58), c, palette.dark ? 0.36 : 0.4));
      });
      for (const [id, k] of colorOf) {
        const s = index.get(id);
        if (s !== undefined && k >= 0 && k < colors.length) colorKey[s] = k;
      }
    }
    pendingColors = colorOf ? { colorOf, list } : null;
    requestFrame();
    return api;
  }

  function setSettings(next) {
    sceneVersion++;
    const before = settings;
    settings = { ...settings, ...next };
    for (const key of Object.keys(GRAPH_DEFAULTS)) {
      if (!Number.isFinite(settings[key])) settings[key] = GRAPH_DEFAULTS[key];
    }
    const forces = before.repel !== settings.repel || before.linkDistance !== settings.linkDistance
      || before.center !== settings.center || before.nodeScale !== settings.nodeScale;
    recomputeSizes();
    if (forces) reheat(0.5);
    requestFrame();
    return api;
  }

  function setLabels({ always = null, rings = null } = {}) {
    sceneVersion++;
    alwaysLabel = always ? new Set(always) : null;
    ringIds = rings ? new Set(rings) : null;
    requestFrame();
    return api;
  }

  function refreshTheme() {
    sceneVersion++;
    palette = null;
    readPalette();
    if (pendingColors) setColors(pendingColors.colorOf, pendingColors.list);
    requestFrame();
    return api;
  }

  /** Bildschirmposition eines Knotens (CSS-Pixel relativ zur Leinwand). */
  function screenPosition(id) {
    const s = index.get(id);
    if (s === undefined) return null;
    return { x: posX[s] * transform.k + transform.x, y: posY[s] * transform.k + transform.y, r: screenRadius(s, transform.k) };
  }

  function neighbours(id) {
    const s = index.get(id);
    if (s === undefined) return [];
    const out = [];
    for (let q = adjStart[s]; q < adjStart[s + 1]; q++) if (visible[adjList[q]]) out.push(nodes[adjList[q]]);
    return out;
  }

  /** Alle ids bis zur Tiefe `depth` um einen Knoten (ihn selbst eingeschlossen), ueber alle geladenen Linien. */
  function neighbourhood(id, depth = 2) {
    const start = index.get(id);
    const out = new Set();
    if (start === undefined) return out;
    let frontier = [start];
    out.add(id);
    const seen = new Uint8Array(n);
    seen[start] = 1;
    for (let d = 0; d < depth && frontier.length; d++) {
      const next = [];
      for (const s of frontier) {
        for (let q = adjStart[s]; q < adjStart[s + 1]; q++) {
          const t = adjList[q];
          if (seen[t]) continue;
          seen[t] = 1;
          out.add(nodes[t].id);
          next.push(t);
        }
      }
      frontier = next;
    }
    return out;
  }

  /** Der Knoten unter einem Bildschirmpunkt (CSS-Pixel), oder null. */
  function nodeAtScreen(x, y, slop = 4) {
    const s = nodeAt(x, y, slop);
    return s >= 0 ? nodes[s] : null;
  }

  /** Weicher Aufbau: Knoten wachsen in Wellen, Linien und Namen blenden nach. */
  function enter(delayMs = 0) {
    sceneVersion++;
    if (reduceMotion()) {
      enterStart = 0;
      requestFrame();
      return api;
    }
    enterStart = performance.now() + Math.max(0, delayMs);
    requestFrame();
    return api;
  }

  /**
   * Ein leichter Stoss fuer einzelne Knoten (neue Verbindung): sie und ihre
   * Nachbarn duerfen sich kurz bewegen, der Rest bleibt stehen. Laeuft die
   * Wolke ohnehin noch, kommt nur der Stoss dazu.
   */
  function nudge(ids, strength = 1) {
    if (themen) return api;
    const slots = [];
    for (const id of ids || []) {
      const s = index.get(id);
      if (s !== undefined && visible[s]) slots.push(s);
    }
    if (!slots.length) return api;
    if (alpha < PHYS.alphaMin) {
      mobile = new Uint8Array(n);
      for (const s of slots) {
        mobile[s] = 1;
        for (let q = adjStart[s]; q < adjStart[s + 1]; q++) mobile[adjList[q]] = 1;
      }
    }
    for (const s of slots) {
      // Richtung deterministisch aus dem Platz, Betrag klein: ein Ruck, kein Sprung.
      const angle = jitter(s * 17 + 3) * 3000;
      velX[s] += Math.cos(angle) * 4 * strength;
      velY[s] += Math.sin(angle) * 4 * strength;
    }
    alpha = Math.max(alpha, 0.16);
    if (settledOnce) emit('onWake');
    settledOnce = false;
    requestFrame();
    return api;
  }

  /**
   * Eine Verbindung zu den geladenen Daten dazunehmen, ohne Neuladen: die
   * Linie zieht sich sichtbar, beide Knoten bewegen sich leicht. Liefert
   * false, wenn ein Ende nicht geladen ist oder die Linie schon da war.
   */
  function addEdge(edge) {
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string' || edge.from === edge.to) return false;
    const a = index.get(edge.from);
    const b = index.get(edge.to);
    if (a === undefined || b === undefined) return false;
    for (let q = adjStart[a]; q < adjStart[a + 1]; q++) if (adjList[q] === b) return false;
    const edges = new Array(m + 1);
    for (let e = 0; e < m; e++) edges[e] = { from: nodes[edgeA[e]].id, to: nodes[edgeB[e]].id, weight: edgeWeight[e] };
    edges[m] = { from: edge.from, to: edge.to, weight: Number(edge.weight) || 1 };
    setData({ nodes, edges }, { beweglich: [edge.from, edge.to] });
    nudge([edge.from, edge.to]);
    return true;
  }

  function stats() {
    let vn = 0;
    let ve = 0;
    let orphans = 0;
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      vn++;
      if (orphan[i]) orphans++;
    }
    for (let e = 0; e < m; e++) if (edgeVisible[e]) ve++;
    return {
      nodes: n,
      edges: m,
      visibleNodes: vn,
      visibleEdges: ve,
      orphans,
      running: running(),
      alpha,
      zoom: transform.k,
      tickMs,
      drawMs,
    };
  }

  function destroy() {
    destroyed = true;
    dropPanCache();
    panCanvas = null;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    for (const off of listeners.splice(0)) off();
    if (resizeObserver) resizeObserver.disconnect();
    nodes = [];
    n = 0;
    m = 0;
  }

  api = {
    setData,
    setFilter,
    setOrphans,
    pin,
    setHighlight,
    setColors,
    setSettings,
    setLabels,
    setSelection,
    setPadding,
    refreshTheme,
    prewarm,
    reheat,
    enter,
    nudge,
    addEdge,
    fitToView,
    focus,
    zeigeFrei,
    zoomBy,
    resize,
    screenPosition,
    neighbours,
    neighbourhood,
    nodeAtScreen,
    stats,
    destroy,
    get transform() { return { ...transform }; },
    get settings() { return { ...settings }; },
    get selectedId() { return selected >= 0 ? nodes[selected].id : null; },
    /** Der Zoom, bei dem alles eingepasst ist -- Bezug fuer die Schwellen. */
    get fitZoom() { const f = fitTransform(); return f ? f.k : 1; },
    get hoveredId() { return hovered >= 0 ? nodes[hovered].id : null; },
    stopFollowing() { autoFit = false; },
    /**
     * Die laufende Radbewegung gehoert noch zur vorigen Ebene: schlucken, bis
     * das Rad ruht (die Ansicht ruft das nach jedem Ebenenwechsel).
     */
    gesteBeenden() { schluckenSeit = performance.now(); levelArmed = false; regionArmed = false; return api; },
    /**
     * Bereiche (Unterthemen) auf der Netz-Ebene: [{id, name, anzahl, ids}].
     * Sie liegen als leise Flaeche hinter ihren Knoten, der Name steht
     * darueber; antippen oder hineinzoomen meldet onRegion(bereich, woher).
     */
    setRegions(list) {
      regionSpec = Array.isArray(list) ? list.filter((r) => r && typeof r.id === 'string') : [];
      sceneVersion++;
      resolveRegions();
      if (regions.length && !themen) reheat(0.3);
      requestFrame();
      return api;
    },
    /** Fuer Pruefwerkzeuge: wo die Namen der Bereiche stehen. */
    regionLabels() {
      return regionGeo().map((g, ri) => (g ? {
        ...regionInfo(ri),
        x: g.label.x + g.label.w / 2,
        y: g.label.y + g.label.h / 2,
        mitteX: g.hull.reduce((acc, q) => acc + q[0], 0) / g.hull.length,
        mitteY: g.hull.reduce((acc, q) => acc + q[1], 0) / g.hull.length,
      } : null)).filter(Boolean);
    },
    /** Die Kachel will ein ruhiges Bild ohne Nachschwingen. */
    freeze() {
      alpha = 0;
      alphaTarget = 0;
      requestFrame();
      return api;
    },
  };

  resize();
  readPalette();
  return api;
}

export default createGraphCanvas;
