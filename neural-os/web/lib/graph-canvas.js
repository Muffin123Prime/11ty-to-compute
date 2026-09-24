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
 *    oeffnet. Auf dem iPad ueber WLAN ist das die ganze Bedienung.
 */

/* ------------------------------------------------------------------ */
/* Konstanten                                                          */
/* ------------------------------------------------------------------ */

const TAU = Math.PI * 2;

/** Arten, die als Knoten vorkommen koennen (wie schema.GRAPH_TYPES). */
export const GRAPH_TYPES = ['note', 'chat', 'project', 'task', 'event', 'agent', 'file', 'entity', 'run'];

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

const MIN_ZOOM = 0.04;
const MAX_ZOOM = 6;
const CLICK_SLOP = 5; // so weit darf sich ein Klick bewegen und bleibt ein Klick
const DOUBLE_TAP_MS = 320;
const MOVE_MS = 380;
const FADE_MS = 160; // Hervorheben und Zuruecktreten, wie in Obsidian: kurz, aber sichtbar

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
 *   onSelect?: (node:object|null) => void,
 *   onOpen?: (node:object) => void,
 *   onHover?: (node:object|null) => void,
 *   onSettle?: () => void,         // die Wolke ruht, die Bildschleife steht
 *   onWake?: () => void,           // sie bewegt sich wieder (Ziehen, Filter, neue Daten)
 *   onUserMove?: () => void,       // der Mensch hat die Kamera bewegt
 * }} [options]
 *
 * Rueckgabe: setData, setFilter, setOrphans, pin, setHighlight, setColors,
 * setSettings, setLabels, setSelection, refreshTheme, prewarm, reheat,
 * fitToView, focus, zoomBy, resize, screenPosition, neighbours, stats,
 * freeze, stopFollowing, destroy; Getter transform, settings, selectedId.
 */
export function createGraphCanvas(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new TypeError('createGraphCanvas(): ein <canvas>-Element wird benötigt.');
  }
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('createGraphCanvas(): 2D-Kontext nicht verfügbar.');

  const mini = !!options.mini;
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
  let labelWidthCache = [];
  let labelFontCache = 0;
  let edgeStrength = new Float64Array(0);
  let edgeBias = new Float64Array(0);
  let edgeVisible = new Uint8Array(0);
  let adjStart = new Int32Array(1);
  let adjList = new Int32Array(0);

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
  let dimAlpha = mini ? 0.42 : 0.1;

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
    };
    labelWidthCache = new Array(n);
  }

  /* ---------------------------- Daten setzen ----------------------- */

  function radiusOf(slot) {
    const d = degree[slot];
    const base = mini ? 2.8 : 2.8;
    return settings.nodeScale * Math.min(base + 1.2 * Math.sqrt(d), mini ? 7 : 15);
  }

  function tierOf(slot) {
    const d = degree[slot];
    return d >= 24 ? 3 : d >= 8 ? 2 : d >= 2 ? 1 : 0;
  }

  /**
   * @param {{nodes: object[], edges: object[]}} data
   * Knoten brauchen `id`; Kanten `from`/`to`. Positionen bleiben pro id
   * erhalten, damit ein Nachladen die Karte nicht unter der Hand umwirft.
   */
  function setData(data) {
    const inNodes = Array.isArray(data && data.nodes) ? data.nodes : [];
    const inEdges = Array.isArray(data && data.edges) ? data.edges : [];

    const old = { index, posX, posY, velX, velY, fixed, fixX, fixY };
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
    const seen = new Set();
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
      degree[ia]++;
      degree[ib]++;
    }
    m = a.length;
    edgeA = Int32Array.from(a);
    edgeB = Int32Array.from(b);
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
    // Ein Nachladen ohne neue Knoten oder Linien bewegt nichts: die Karte
    // bleibt, wie der Mensch sie gerade ansieht.
    const shape = `${n}:${m}`;
    if (fresh === n) reheat(1);
    else if (fresh > 0 && fresh <= Math.max(12, n * 0.1)) {
      mobile = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (!freshMask[i]) continue;
        mobile[i] = 1;
        for (let q = adjStart[i]; q < adjStart[i + 1]; q++) mobile[adjList[q]] = 1;
      }
      alpha = Math.max(alpha, 0.5);
      settledOnce = false;
    } else if (fresh > 0) reheat(0.4);
    else if (shape !== structure) reheat(0.12);
    structure = shape;
    if (pendingColors) setColors(pendingColors.colorOf, pendingColors.list);
    requestFrame();
    return api;
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
    recomputeSizes();
    brightKey = null;
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

  function tick() {
    const t0 = performance.now();
    alpha += (alphaTarget - alpha) * PHYS.alphaDecay;
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
    // Die Kachel braucht seitlich Platz fuer die Namen neben den Punkten.
    const padX = pad !== undefined ? pad : mini ? clamp(width * 0.2, 30, 90) : 48;
    const padY = pad !== undefined ? pad : mini ? 26 : 48;
    const bw = Math.max(box.maxX - box.minX, 1);
    const bh = Math.max(box.maxY - box.minY, 1);
    // Ein kleines Netz wird nicht auf Briefmarkengroesse aufgeblasen: ueber
    // 1.6 sehen zwanzig Punkte aus wie Knoepfe, nicht wie ein Gehirn.
    const k = clamp(Math.min((width - padX * 2) / bw, (height - padY * 2) / bh), MIN_ZOOM, mini ? 2.2 : 1.6);
    return {
      k,
      x: width / 2 - ((box.minX + box.maxX) / 2) * k,
      y: height / 2 - ((box.minY + box.maxY) / 2) * k,
    };
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
    const target = { k, x: width / 2 - posX[slot] * k, y: height / 2 - posY[slot] * k };
    if (config.animate === false) {
      transform = target;
      animation = null;
      requestFrame();
    } else {
      animateTo(target, MOVE_MS);
    }
    return api;
  }

  function zoomAround(factor, cx, cy) {
    const k = clamp(transform.k * factor, MIN_ZOOM, MAX_ZOOM);
    const f = k / transform.k;
    transform = { k, x: cx - (cx - transform.x) * f, y: cy - (cy - transform.y) * f };
  }

  function zoomBy(factor, cx = width / 2, cy = height / 2, animate = false) {
    autoFit = false;
    if (animate) {
      const k = clamp(transform.k * factor, MIN_ZOOM, MAX_ZOOM);
      const f = k / transform.k;
      animateTo({ k, x: cx - (cx - transform.x) * f, y: cy - (cy - transform.y) * f }, 220);
    } else {
      animation = null;
      zoomAround(factor, cx, cy);
      requestFrame();
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

    draw();
    if (busy) requestFrame();
    else lastFrame = 0;
  }

  function draw() {
    const t0 = performance.now();
    if (!palette) readPalette();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
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

    drawEdges(k);
    drawNodes(k);
    drawLabels(k);
    drawMs = performance.now() - t0;
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
    ctx.lineCap = 'round';
    const lineAlpha = palette.lineAlpha * (mini ? 0.9 : 1);
    const lit = fade > 0;
    // Ohne Licht: alle Linien in einem Pfad -- ein Strich fuer tausend Kanten.
    ctx.beginPath();
    let any = false;
    for (let e = 0; e < m; e++) {
      if (!edgeVisible[e]) continue;
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
        ctx.strokeStyle = rgba(palette.accent, 0.35 + 0.5 * fade);
        ctx.lineWidth = lw * (1 + 0.5 * fade);
      } else {
        ctx.strokeStyle = rgba(palette.line, Math.min(1, lineAlpha * (1 + 0.6 * fade)));
        ctx.lineWidth = lw;
      }
      ctx.stroke();
    }
  }

  /**
   * Beim Heranzoomen wachsen die Abstaende linear, die Punkte nur gedaempft
   * (k^0.6): so wird das Netz beim Hineingehen luftiger statt dass ein Hub
   * zur Scheibe aufquillt.
   */
  function screenRadius(i, k) {
    const grow = k <= 1 ? k : Math.pow(k, 0.6);
    return Math.max(radius[i] * grow, mini ? 1.6 : 1.15);
  }

  function drawNodes(k) {
    const lit = fade > 0;
    // Buendel nach Farbe: ein fill() pro Farbe statt eines pro Knoten. Was
    // zuruecktritt, wird mit Deckkraft gemalt statt mit einer zweiten Farbe
    // -- so blendet es weich ueber, statt umzuspringen.
    const normal = new Map();
    const dimmed = new Map();
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      const r = screenRadius(i, k);
      if (!onScreen(i, r + 2)) continue;
      if (i === selected || (lit && i === focusSlot)) continue; // kommt zuletzt, im Akzent
      const ck = colorKey[i];
      const style = ck >= 0 && colors[ck] ? colors[ck] : palette.tiers[tierOf(i)];
      const target = lit && !bright[i] ? dimmed : normal;
      let list = target.get(style);
      if (!list) target.set(style, (list = []));
      list.push(i);
    }
    const fillAll = (buckets) => {
      for (const [style, list] of buckets) {
        ctx.beginPath();
        for (const i of list) {
          const r = screenRadius(i, k);
          ctx.moveTo(sx[i] + r, sy[i]);
          ctx.arc(sx[i], sy[i], r, 0, TAU);
        }
        ctx.fillStyle = style;
        ctx.fill();
      }
    };
    if (dimmed.size) {
      ctx.globalAlpha = 1 - fade * (1 - dimAlpha);
      fillAll(dimmed);
      ctx.globalAlpha = 1;
    }
    fillAll(normal);

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
    return clip(node.label || node.title || node.id, mini ? 17 : 34);
  }

  /**
   * Beschriftungen. Gewoehnliche erscheinen ab `labelZoom`; grosse Knoten
   * frueher, weil ihr Name auch aus der Ferne etwas sagt. Im Licht stehen
   * der Knoten und seine Nachbarn immer da. Was sich ueberlappen wuerde,
   * faellt weg -- der wichtigere Knoten gewinnt, weil er zuerst kommt.
   */
  function drawLabels(k) {
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
        const importance = radius[i] / (2.8 * settings.nodeScale);
        let a = clamp((k * importance - lz) / (0.45 * lz), 0, 1);
        if (lit && !bright[i]) a *= 1 - fade * 0.85;
        else if (lit && highlightSet && bright[i]) a = Math.max(a, fade * 0.9);
        if (a < 0.04) continue;
        list.push([i, a, false]);
        if (list.length > 400) break;
      }
    }

    const hgt = px * 1.25;
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
        const pick = cands.find(([cx, cy]) => fits(cx, cy, w) && free(cx, cy, w, i))
          || cands.find(([cx, cy]) => fits(cx, cy, w))
          || cands[0];
        x = clamp(pick[0], 2, Math.max(2, width - w - 2));
        y = clamp(pick[1], 2, Math.max(2, height - hgt - 2));
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
    for (const [i, x, y, a] of placed) {
      ctx.globalAlpha = a;
      ctx.strokeText(labelText(i), x, y);
    }
    for (const [i, x, y, a, isForced] of placed) {
      ctx.globalAlpha = a;
      const strong = i === focusSlot || i === selected;
      ctx.fillStyle = strong ? palette.labelStrong : isForced && !mini ? palette.labelStrong : palette.label;
      ctx.fillText(labelText(i), x, y);
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------------------- Groesse ---------------------------- */

  function resize() {
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
      ? { kind: 'node', slot, start: p, dragging: false, pointerType: event.pointerType }
      : { kind: 'pan', start: p, last: p, moved: false, pointerType: event.pointerType };
    if (event.pointerType === 'touch' && slot >= 0) setHovered(slot);
  }

  function onPointerMove(event) {
    const p = local(event);
    if (!pointers.has(event.pointerId)) {
      // Maus ohne gedrueckte Taste: nur Ueberfahren.
      if (event.pointerType === 'mouse' || event.pointerType === 'pen') setHovered(nodeAt(p.x, p.y, 4));
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
      return;
    }
    if (gesture.kind === 'node') {
      const moved = Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y);
      if (!gesture.dragging && moved > CLICK_SLOP) {
        gesture.dragging = true;
        userMoved();
        fixed[gesture.slot] = 1;
        alphaTarget = 0.25;
        reheat(0.25);
        canvas.style.cursor = 'grabbing';
      }
      if (gesture.dragging) {
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
    canvas.style.cursor = hovered >= 0 ? 'pointer' : '';
    if (g.kind === 'node') {
      if (g.dragging) {
        releaseNode(g.slot);
        if (g.pointerType === 'touch') setHovered(-1);
        return;
      }
      if (g.pointerType === 'touch') setHovered(-1);
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
      if (again) {
        zoomBy(1.6, p.x, p.y, true);
        return;
      }
      setSelection(null);
      emit('onSelect', null);
    }
  }

  function onPointerCancel(event) {
    pointers.delete(event.pointerId);
    if (gesture && gesture.kind === 'node' && gesture.dragging) releaseNode(gesture.slot);
    if (!pointers.size) gesture = null;
  }

  function onPointerLeave(event) {
    if (event.pointerType === 'mouse' && !pointers.size) setHovered(-1);
  }

  function onWheel(event) {
    event.preventDefault();
    const p = local(event);
    let dy = event.deltaY;
    if (event.deltaMode === 1) dy *= 16;
    else if (event.deltaMode === 2) dy *= height || 600;
    // ctrlKey = Zwei-Finger-Zoom auf dem Trackpad: feinere, groessere Schritte.
    const factor = Math.exp(-dy * (event.ctrlKey ? 0.012 : 0.0016));
    userMoved();
    zoomAround(factor, p.x, p.y);
    requestFrame();
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
    colorKey.fill(-1);
    colors = [];
    if (colorOf && Array.isArray(list) && palette) {
      colors = list.map((css) => {
        const c = parseColor(ctx, css, palette.fg);
        return rgba(mix(mix(palette.ground, palette.fg, palette.dark ? 0.72 : 0.6), c, 0.62));
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
    alwaysLabel = always ? new Set(always) : null;
    ringIds = rings ? new Set(rings) : null;
    requestFrame();
    return api;
  }

  function refreshTheme() {
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
    refreshTheme,
    prewarm,
    reheat,
    fitToView,
    focus,
    zoomBy,
    resize,
    screenPosition,
    neighbours,
    stats,
    destroy,
    get transform() { return { ...transform }; },
    get settings() { return { ...settings }; },
    get selectedId() { return selected >= 0 ? nodes[selected].id : null; },
    stopFollowing() { autoFit = false; },
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
