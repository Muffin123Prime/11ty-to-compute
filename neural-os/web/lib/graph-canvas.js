/**
 * graph-canvas.js -- the force-directed renderer behind the "Gehirn" view.
 *
 * Why this file exists in this shape
 * ----------------------------------
 * 1. **Framework-free and dependency-free.** It touches nothing but the
 *    canvas element it is handed, so it can be dropped into any view and
 *    cannot drag a bundler into a project that promises to have none.
 * 2. **Typed arrays, not objects.** A personal vault reaches a few thousand
 *    records quickly, and 2 000 nodes * 60 frames/s leaves no room for
 *    allocating a vector object per node per tick. Positions, velocities and
 *    charges live in parallel `Float32Array`s indexed by node slot; the
 *    per-node metadata objects are only read when something is drawn or
 *    inspected.
 * 3. **Barnes-Hut instead of the honest O(n^2).** Repulsion is summarised per
 *    quadtree cell whenever the cell is far enough away (theta = 0.9). That is
 *    the single decision that keeps 2 000 nodes interactive; the exact sum
 *    would be four million pair evaluations per tick.
 * 4. **The simulation stops.** `alpha` decays and, below `alphaMin`, the
 *    animation frame loop is cancelled outright. An idle graph view must cost
 *    zero CPU -- this application is meant to sit open all day on a laptop
 *    running a local model, and a renderer that spins forever would be a
 *    battery bug disguised as a feature.
 * 5. **Drawing happens in screen space.** World coordinates are converted by
 *    hand instead of being pushed into the canvas transform, so line widths,
 *    dash patterns and label sizes stay exact at every zoom level and at every
 *    `devicePixelRatio` -- a stroke scaled by the transform turns into a hair
 *    at k=0.1 and a slab at k=8.
 * 6. **Hit testing uses a uniform grid.** Linear search over every node would
 *    run on each `pointermove`; the grid is rebuilt only when positions have
 *    actually changed, and only when somebody asks for a hit.
 * 7. **Colours come from CSS custom properties.** The design system owns the
 *    palette, including both themes. Per-type colours are read from optional
 *    `--graph-<type>` tokens and fall back to a built-in set chosen by the
 *    measured lightness of `--bg`, so the renderer follows dark/light mode
 *    even if nobody ever defines a graph token.
 * 8. **Provenance is visible without a legend.** Manual edges are solid and
 *    use the foreground colour, derived edges are thin and dashed, agent
 *    suggestions are dash-dotted in the warning colour. What the user linked
 *    and what the machine guessed must be distinguishable at a glance.
 */

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const TAU = Math.PI * 2;

/** Record types that can appear as nodes (mirrors schema.GRAPH_TYPES). */
export const GRAPH_TYPES = ['note', 'chat', 'project', 'task', 'agent', 'file', 'entity', 'run'];

/** Shape per type. Shape carries the type even for colour-blind readers. */
const SHAPES = {
  note: 'circle',
  chat: 'bubble',
  project: 'hexagon',
  task: 'diamond',
  agent: 'triangle',
  file: 'page',
  entity: 'ring',
  run: 'pentagon',
  unknown: 'circle',
};

/** Fallback palettes, used when the stylesheet defines no --graph-* tokens. */
const TYPE_COLORS_LIGHT = {
  note: '#2f5bd0',
  chat: '#7a4cc0',
  project: '#1c7a4c',
  task: '#b8761a',
  agent: '#b22a21',
  file: '#4a5561',
  entity: '#0f7f8f',
  run: '#7a6a2a',
  unknown: '#6d737d',
};

const TYPE_COLORS_DARK = {
  note: '#7f9cff',
  chat: '#b596ff',
  project: '#4cbd86',
  task: '#e0a84e',
  agent: '#ff8a7d',
  file: '#9aa7b5',
  entity: '#4fc6d4',
  run: '#cbb96a',
  unknown: '#838a95',
};

/** Cluster tints, used only while the view asks for the cluster colouring. */
const CLUSTER_COLORS_LIGHT = ['#2f5bd0', '#1c7a4c', '#b8761a', '#7a4cc0', '#b22a21', '#0f7f8f', '#7a6a2a', '#4a5561'];
const CLUSTER_COLORS_DARK = ['#7f9cff', '#4cbd86', '#e0a84e', '#b596ff', '#ff8a7d', '#4fc6d4', '#cbb96a', '#9aa7b5'];

const DEFAULTS = {
  theta: 0.9,
  charge: -46, // base repulsion; grown with the node radius below
  linkDistance: 34,
  gravity: 0.05,
  velocityDecay: 0.62,
  alphaDecay: 0.0228, // 1 - 0.001^(1/300): ~300 ticks to settle
  alphaMin: 0.012,
  minZoom: 0.03,
  maxZoom: 8,
  labelZoom: 0.62, // below this zoom only the important labels are drawn
  maxLabels: 240,
  nodeBaseRadius: 4.6,
  nodeDegreeScale: 2.9,
  nodeMaxRadius: 26,
};

const MAX_TREE_DEPTH = 24;
const MIN_DISTANCE_SQ = 1;
const COINCIDENT_EPS = 1e-6;
const CLICK_SLOP = 4; // px of movement still counted as a click, not a drag
const HIT_SLOP = 6; // px of forgiveness around a node when hit testing

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * Deterministic tiny offset. Two nodes at the exact same position produce a
 * division by zero in the repulsion term; `Math.random()` would fix that but
 * would also make every frame slightly different, which makes bugs here
 * impossible to reproduce.
 */
function jitter(seed) {
  let x = (seed * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822507);
  x ^= x >>> 13;
  return ((x >>> 0) / 4294967295 - 0.5) * 2e-3;
}

function hashString(value) {
  let h = 2166136261;
  const s = String(value);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Normalise any CSS colour through the canvas itself: assigning to
 * `fillStyle` and reading it back yields `#rrggbb` or `rgba(r, g, b, a)`,
 * which is far less code than a CSS colour parser and is exactly what the
 * browser would have painted.
 */
function parseColor(ctx, value, fallback) {
  const raw = String(value || '').trim();
  if (raw) {
    const before = ctx.fillStyle;
    try {
      ctx.fillStyle = raw;
      const normalised = ctx.fillStyle;
      ctx.fillStyle = before;
      if (typeof normalised === 'string') {
        if (normalised.startsWith('#')) {
          const hex = normalised.length === 4
            ? normalised.slice(1).split('').map((c) => c + c).join('')
            : normalised.slice(1);
          const n = parseInt(hex, 16);
          if (Number.isFinite(n)) return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
        }
        const m = /rgba?\(([^)]+)\)/.exec(normalised);
        if (m) {
          const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
          if (parts.length >= 3 && parts.every((p) => Number.isFinite(p))) {
            return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
          }
        }
      }
    } catch {
      ctx.fillStyle = before;
    }
  }
  return fallback ? { ...fallback } : { r: 128, g: 128, b: 128, a: 1 };
}

function rgba(color, alpha) {
  const a = clamp((color.a === undefined ? 1 : color.a) * (alpha === undefined ? 1 : alpha), 0, 1);
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${a.toFixed(3)})`;
}

function luminance(color) {
  return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
}

function mix(a, b, t) {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: 1,
  };
}

/* ------------------------------------------------------------------ */
/* Barnes-Hut quadtree                                                 */
/* ------------------------------------------------------------------ */

/**
 * Array-backed quadtree. Cells live in parallel arrays instead of objects so
 * that rebuilding it 60 times a second does not hand the garbage collector
 * thousands of short-lived objects.
 *
 * Bodies that fall on the same point (or reach the depth cap) are kept in a
 * linked list through the caller's `next` array, so coincident nodes -- which
 * happen the moment somebody drags one node onto another -- cannot make the
 * build loop forever.
 */
function createQuadtree() {
  let capacity = 0;
  let count = 0;
  let child = new Int32Array(0);
  let head = new Int32Array(0);
  let charge = new Float32Array(0);
  let accX = new Float32Array(0);
  let accY = new Float32Array(0);
  let centreX = new Float32Array(0);
  let centreY = new Float32Array(0);
  let halfSize = new Float32Array(0);
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
    charge = grow(charge, Float32Array, 1);
    accX = grow(accX, Float32Array, 1);
    accY = grow(accY, Float32Array, 1);
    centreX = grow(centreX, Float32Array, 1);
    centreY = grow(centreY, Float32Array, 1);
    halfSize = grow(halfSize, Float32Array, 1);
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
    const base = cell * 4;
    // `newCell` may reallocate the arrays, so every child is created before
    // the parent's slot is written back.
    const c0 = newCell(cx - half, cy - half, half);
    const c1 = newCell(cx + half, cy - half, half);
    const c2 = newCell(cx - half, cy + half, half);
    const c3 = newCell(cx + half, cy + half, half);
    child[base] = c0;
    child[base + 1] = c1;
    child[base + 2] = c2;
    child[base + 3] = c3;
  }

  function quadrant(cell, x, y) {
    return (x >= centreX[cell] ? 1 : 0) + (y >= centreY[cell] ? 2 : 0);
  }

  /**
   * @param {number} index body slot
   * @param {Float32Array} px world x per body
   * @param {Float32Array} py world y per body
   * @param {Float32Array} q charge per body (negative = repulsive)
   * @param {Int32Array} next chain array owned by the caller
   */
  function insert(index, px, py, q, next) {
    const x = px[index];
    const y = py[index];
    const w = q[index];
    let cell = 0;
    let depth = 0;
    for (;;) {
      charge[cell] += w;
      accX[cell] += x * w;
      accY[cell] += y * w;

      if (child[cell * 4] === -1) {
        const other = head[cell];
        if (other === -1) {
          head[cell] = index;
          next[index] = -1;
          return;
        }
        if (depth >= MAX_TREE_DEPTH
          || (Math.abs(px[other] - x) < COINCIDENT_EPS && Math.abs(py[other] - y) < COINCIDENT_EPS)) {
          next[index] = other;
          head[cell] = index;
          return;
        }
        // Push the sitting tenant (and any coincident chain) one level down.
        head[cell] = -1;
        subdivide(cell);
        let moving = other;
        while (moving !== -1) {
          const following = next[moving];
          placeInChild(cell, moving, px, py, q, next, depth + 1);
          moving = following;
        }
      }

      const target = child[cell * 4 + quadrant(cell, x, y)];
      cell = target;
      depth += 1;
    }
  }

  /** Insert an already-counted body into the subtree below `cell`. */
  function placeInChild(parent, index, px, py, q, next, depth) {
    const x = px[index];
    const y = py[index];
    const w = q[index];
    let cell = child[parent * 4 + quadrant(parent, x, y)];
    let level = depth;
    for (;;) {
      charge[cell] += w;
      accX[cell] += x * w;
      accY[cell] += y * w;
      if (child[cell * 4] === -1) {
        const other = head[cell];
        if (other === -1) {
          head[cell] = index;
          next[index] = -1;
          return;
        }
        if (level >= MAX_TREE_DEPTH
          || (Math.abs(px[other] - x) < COINCIDENT_EPS && Math.abs(py[other] - y) < COINCIDENT_EPS)) {
          next[index] = other;
          head[cell] = index;
          return;
        }
        head[cell] = -1;
        subdivide(cell);
        let moving = other;
        while (moving !== -1) {
          const following = next[moving];
          placeInChild(cell, moving, px, py, q, next, level + 1);
          moving = following;
        }
      }
      cell = child[cell * 4 + quadrant(cell, x, y)];
      level += 1;
    }
  }

  /**
   * Accumulate the repulsion acting on body `index` into `out` ([ax, ay]).
   * `theta2` is the squared opening angle: a cell is summarised when
   * `size^2 < theta2 * distance^2`.
   */
  function accumulate(index, px, py, q, next, theta2, factor, out) {
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
            if (d2 < MIN_DISTANCE_SQ) {
              dx += jitter(index * 31 + body);
              dy += jitter(body * 31 + index);
              d2 = dx * dx + dy * dy;
              if (d2 < MIN_DISTANCE_SQ) d2 = MIN_DISTANCE_SQ;
            }
            const f = (q[body] * factor) / d2;
            ax += dx * f;
            ay += dy * f;
          }
          body = next[body];
        }
        continue;
      }
      const invW = 1 / w;
      const dx = accX[cell] * invW - x;
      const dy = accY[cell] * invW - y;
      const d2 = dx * dx + dy * dy;
      const size = halfSize[cell] * 2;
      if (size * size < theta2 * d2) {
        const f = (w * factor) / (d2 < MIN_DISTANCE_SQ ? MIN_DISTANCE_SQ : d2);
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

  return { reset, insert, accumulate, get cells() { return count; } };
}

/* ------------------------------------------------------------------ */
/* The renderer                                                        */
/* ------------------------------------------------------------------ */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{
 *   onSelect?:(node:object|null, event:Event)=>void,
 *   onDoubleClick?:(node:object|null)=>void,
 *   onContext?:(node:object|null, position:{clientX:number, clientY:number})=>void,
 *   onHover?:(node:object|null)=>void,
 *   onLink?:(link:{from:string, to:string})=>void,
 *   onTransform?:(transform:{x:number,y:number,k:number})=>void,
 *   onSettle?:()=>void,
 * }} [options]
 */
export function createGraphCanvas(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new TypeError('createGraphCanvas(): ein <canvas>-Element wird benötigt.');
  }
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('createGraphCanvas(): 2D-Kontext nicht verfügbar.');

  const opts = { ...DEFAULTS, ...options };
  const emit = (name, ...args) => {
    const fn = options[name];
    if (typeof fn !== 'function') return;
    try {
      fn(...args);
    } catch (err) {
      console.error(`[graph-canvas] ${name} ist gescheitert:`, err);
    }
  };

  /* --------------------------- data state --------------------------- */

  /** @type {object[]} node metadata, index-aligned with the typed arrays */
  let nodes = [];
  /** @type {object[]} edge metadata */
  let edges = [];
  let index = new Map(); // id -> slot
  let n = 0;
  let m = 0;

  let posX = new Float32Array(0);
  let posY = new Float32Array(0);
  let velX = new Float32Array(0);
  let velY = new Float32Array(0);
  let fixX = new Float32Array(0);
  let fixY = new Float32Array(0);
  let fixed = new Uint8Array(0);
  let radius = new Float32Array(0);
  let charge = new Float32Array(0);
  let visible = new Uint8Array(0);
  let chain = new Int32Array(0);
  let screenX = new Float32Array(0);
  let screenY = new Float32Array(0);

  let edgeA = new Int32Array(0);
  let edgeB = new Int32Array(0);
  let edgeWeight = new Float32Array(0);
  let edgeBias = new Float32Array(0);
  let edgeStrength = new Float32Array(0);
  let edgeRest = new Float32Array(0);
  let edgeVisible = new Uint8Array(0);

  // CSR adjacency, for the hover highlight of direct neighbours.
  let adjStart = new Int32Array(1);
  let adjList = new Int32Array(0);

  const tree = createQuadtree();
  const forceOut = new Float64Array(2);

  /**
   * Declared up front rather than with `const` at the end: observers and DOM
   * listeners are registered before the object literal is evaluated, and
   * several methods return `api` for chaining. A callback that fired early
   * would otherwise hit the temporal dead zone.
   */
  let api = null;

  /* -------------------------- view state ---------------------------- */

  let transform = { x: 0, y: 0, k: 1 };
  let width = 0;
  let height = 0;
  let dpr = 1;

  let alpha = 0;
  let alphaTarget = 0;
  let rafId = 0;
  let destroyed = false;
  let hiddenPause = false;

  let selectedId = null;
  let hoveredId = null;
  let highlighted = null; // Set<string> | null
  let filterFn = null;
  let clusterOf = null; // Map<string, number> | null
  let labelMode = 'auto';

  let animation = null; // {from, to, start, duration}
  let gridDirty = true;

  /* ----------------------------- palette ---------------------------- */

  let palette = null;

  function readPalette() {
    const cs = getComputedStyle(canvas);
    const prop = (name) => cs.getPropertyValue(name).trim();
    const fg = parseColor(ctx, prop('--fg'), { r: 22, g: 24, b: 28, a: 1 });
    const bg = parseColor(ctx, prop('--surface') || prop('--bg'), { r: 255, g: 255, b: 255, a: 1 });
    const dark = luminance(bg) < 0.45;
    const muted = parseColor(ctx, prop('--fg-muted'), dark ? { r: 154, g: 161, b: 172, a: 1 } : { r: 88, g: 94, b: 104, a: 1 });
    const subtle = parseColor(ctx, prop('--fg-subtle'), dark ? { r: 106, g: 113, b: 124, a: 1 } : { r: 133, g: 139, b: 149, a: 1 });
    const accent = parseColor(ctx, prop('--accent'), dark ? { r: 127, g: 156, b: 255, a: 1 } : { r: 47, g: 91, b: 208, a: 1 });
    const warn = parseColor(ctx, prop('--warn'), dark ? { r: 221, g: 164, b: 70, a: 1 } : { r: 138, g: 90, b: 0, a: 1 });
    const danger = parseColor(ctx, prop('--danger'), dark ? { r: 255, g: 111, b: 99, a: 1 } : { r: 178, g: 42, b: 33, a: 1 });

    const base = dark ? TYPE_COLORS_DARK : TYPE_COLORS_LIGHT;
    const types = {};
    for (const type of [...GRAPH_TYPES, 'unknown']) {
      const token = prop(`--graph-${type}`);
      types[type] = token ? parseColor(ctx, token, parseColor(ctx, base[type])) : parseColor(ctx, base[type]);
    }
    const clusterBase = dark ? CLUSTER_COLORS_DARK : CLUSTER_COLORS_LIGHT;
    const clusters = clusterBase.map((hex) => parseColor(ctx, hex));

    palette = {
      dark,
      fg,
      bg,
      muted,
      subtle,
      accent,
      warn,
      danger,
      types,
      clusters,
      // Node fills are tinted towards the surface so that the label on top of
      // them stays readable in both themes.
      fillOf(color) {
        return mix(color, bg, dark ? 0.55 : 0.82);
      },
    };
    return palette;
  }

  /* ---------------------------- geometry ---------------------------- */

  function toWorldX(sx) {
    return (sx - transform.x) / transform.k;
  }

  function toWorldY(sy) {
    return (sy - transform.y) / transform.k;
  }

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width ? canvas.clientWidth / rect.width : 1;
    const scaleY = rect.height ? canvas.clientHeight / rect.height : 1;
    return {
      x: (event.clientX - rect.left) * (Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1),
      y: (event.clientY - rect.top) * (Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1),
    };
  }

  /* -------------------------- spatial grid -------------------------- */

  let gridCols = 0;
  let gridRows = 0;
  let gridCell = 64;
  let gridMinX = 0;
  let gridMinY = 0;
  let gridStart = new Int32Array(1);
  let gridItems = new Int32Array(0);
  let gridCounts = new Int32Array(0);

  /**
   * Rebuild the uniform grid (CSR layout: counts -> offsets -> items). Called
   * lazily, so a graph nobody is pointing at never pays for it.
   */
  function rebuildGrid() {
    gridDirty = false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let live = 0;
    let maxR = 8;
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      live += 1;
      if (posX[i] < minX) minX = posX[i];
      if (posY[i] < minY) minY = posY[i];
      if (posX[i] > maxX) maxX = posX[i];
      if (posY[i] > maxY) maxY = posY[i];
      if (radius[i] > maxR) maxR = radius[i];
    }
    if (!live) {
      gridCols = 0;
      gridRows = 0;
      return;
    }
    // A cell wide enough to hold the biggest node keeps the search at 3x3.
    const span = Math.max(maxX - minX, maxY - minY, 1);
    gridCell = Math.max(maxR * 2, span / Math.max(4, Math.sqrt(live)), 8);
    gridMinX = minX;
    gridMinY = minY;
    gridCols = Math.max(1, Math.min(512, Math.ceil((maxX - minX) / gridCell) + 1));
    gridRows = Math.max(1, Math.min(512, Math.ceil((maxY - minY) / gridCell) + 1));
    const cells = gridCols * gridRows;
    if (gridCounts.length < cells + 1) {
      gridCounts = new Int32Array(cells + 1);
      gridStart = new Int32Array(cells + 1);
    } else {
      gridCounts.fill(0, 0, cells + 1);
    }
    if (gridItems.length < live) gridItems = new Int32Array(Math.max(live, 64));

    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      gridCounts[cellIndex(posX[i], posY[i])] += 1;
    }
    let running = 0;
    for (let c = 0; c < cells; c++) {
      gridStart[c] = running;
      running += gridCounts[c];
      gridCounts[c] = gridStart[c];
    }
    gridStart[cells] = running;
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      const c = cellIndex(posX[i], posY[i]);
      gridItems[gridCounts[c]++] = i;
    }
  }

  function cellIndex(x, y) {
    const col = clamp(Math.floor((x - gridMinX) / gridCell), 0, gridCols - 1);
    const row = clamp(Math.floor((y - gridMinY) / gridCell), 0, gridRows - 1);
    return row * gridCols + col;
  }

  /**
   * Nearest visible node under a screen point, or -1.
   * The tolerance is in screen pixels, so hitting a node is equally easy at
   * every zoom level.
   */
  function hitTest(sx, sy) {
    if (!n) return -1;
    if (gridDirty) rebuildGrid();
    if (!gridCols) return -1;
    const wx = toWorldX(sx);
    const wy = toWorldY(sy);
    const slopWorld = HIT_SLOP / Math.max(transform.k, 1e-6);
    const col = clamp(Math.floor((wx - gridMinX) / gridCell), 0, gridCols - 1);
    const row = clamp(Math.floor((wy - gridMinY) / gridCell), 0, gridRows - 1);
    const reach = Math.max(1, Math.ceil(slopWorld / gridCell));
    let best = -1;
    let bestScore = Infinity;
    for (let r = row - reach; r <= row + reach; r++) {
      if (r < 0 || r >= gridRows) continue;
      for (let c = col - reach; c <= col + reach; c++) {
        if (c < 0 || c >= gridCols) continue;
        const cell = r * gridCols + c;
        const end = gridStart[cell + 1];
        for (let p = gridStart[cell]; p < end; p++) {
          const i = gridItems[p];
          const dx = posX[i] - wx;
          const dy = posY[i] - wy;
          const d = Math.sqrt(dx * dx + dy * dy);
          const reachR = radius[i] + slopWorld;
          if (d <= reachR && d - radius[i] < bestScore) {
            bestScore = d - radius[i];
            best = i;
          }
        }
      }
    }
    return best;
  }

  /* ----------------------------- data ------------------------------- */

  function radiusFor(node) {
    const degree = Number.isFinite(node.degree) ? node.degree : 0;
    const r = opts.nodeBaseRadius + opts.nodeDegreeScale * Math.sqrt(Math.max(0, degree));
    return clamp(node.pinned ? r * 1.15 : r, opts.nodeBaseRadius, opts.nodeMaxRadius);
  }

  /**
   * Replace the graph. Positions of nodes that were already on screen are
   * kept: a live vault publishes record events constantly, and a map that
   * reshuffles itself on every new note is unusable.
   */
  function setData(data) {
    const rawNodes = Array.isArray(data && data.nodes) ? data.nodes : [];
    const rawEdges = Array.isArray(data && data.edges) ? data.edges : [];

    const previous = new Map();
    for (let i = 0; i < n; i++) {
      previous.set(nodes[i].id, {
        x: posX[i], y: posY[i], vx: velX[i], vy: velY[i], fixed: fixed[i], fx: fixX[i], fy: fixY[i],
      });
    }

    nodes = [];
    index = new Map();
    for (const raw of rawNodes) {
      if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
      if (index.has(raw.id)) continue;
      const node = {
        id: raw.id,
        type: GRAPH_TYPES.includes(raw.type) ? raw.type : 'unknown',
        rawType: typeof raw.type === 'string' ? raw.type : 'unknown',
        label: typeof raw.label === 'string' && raw.label ? raw.label : raw.id,
        tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : [],
        degree: Number.isFinite(raw.degree) ? raw.degree : 0,
        totalDegree: Number.isFinite(raw.totalDegree) ? raw.totalDegree : (Number.isFinite(raw.degree) ? raw.degree : 0),
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
        pinned: !!raw.pinned,
        snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
      };
      index.set(node.id, nodes.length);
      nodes.push(node);
    }
    n = nodes.length;

    posX = new Float32Array(n);
    posY = new Float32Array(n);
    velX = new Float32Array(n);
    velY = new Float32Array(n);
    fixX = new Float32Array(n);
    fixY = new Float32Array(n);
    fixed = new Uint8Array(n);
    radius = new Float32Array(n);
    charge = new Float32Array(n);
    visible = new Uint8Array(n);
    chain = new Int32Array(n);
    screenX = new Float32Array(n);
    screenY = new Float32Array(n);

    edges = [];
    for (const raw of rawEdges) {
      if (!raw) continue;
      const a = index.get(raw.from);
      const b = index.get(raw.to);
      if (a === undefined || b === undefined || a === b) continue;
      edges.push({
        id: typeof raw.id === 'string' ? raw.id : `${raw.from}->${raw.to}`,
        from: raw.from,
        to: raw.to,
        kind: typeof raw.kind === 'string' ? raw.kind : 'related',
        source: raw.source === 'manual' || raw.source === 'agent' ? raw.source : 'derived',
        weight: Number.isFinite(raw.weight) ? raw.weight : 1,
        reason: typeof raw.reason === 'string' ? raw.reason : '',
        a,
        b,
      });
    }
    m = edges.length;

    edgeA = new Int32Array(m);
    edgeB = new Int32Array(m);
    edgeWeight = new Float32Array(m);
    edgeBias = new Float32Array(m);
    edgeStrength = new Float32Array(m);
    edgeRest = new Float32Array(m);
    edgeVisible = new Uint8Array(m);

    const linkCount = new Int32Array(n);
    for (let e = 0; e < m; e++) {
      edgeA[e] = edges[e].a;
      edgeB[e] = edges[e].b;
      edgeWeight[e] = edges[e].weight;
      linkCount[edges[e].a] += 1;
      linkCount[edges[e].b] += 1;
    }

    // CSR adjacency (both directions) for neighbour highlighting.
    adjStart = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) {
      adjStart[edgeA[e] + 1] += 1;
      adjStart[edgeB[e] + 1] += 1;
    }
    for (let i = 0; i < n; i++) adjStart[i + 1] += adjStart[i];
    adjList = new Int32Array(adjStart[n]);
    const cursor = adjStart.slice(0, n);
    for (let e = 0; e < m; e++) {
      adjList[cursor[edgeA[e]]++] = edgeB[e];
      adjList[cursor[edgeB[e]]++] = edgeA[e];
    }

    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      radius[i] = radiusFor(node);
      charge[i] = opts.charge - radius[i] * 3.4;
      const kept = previous.get(node.id);
      if (kept) {
        posX[i] = kept.x;
        posY[i] = kept.y;
        velX[i] = kept.vx;
        velY[i] = kept.vy;
        fixed[i] = kept.fixed;
        fixX[i] = kept.fx;
        fixY[i] = kept.fy;
      } else {
        // Phyllotaxis: an even, non-repeating spread that never starts two
        // nodes on the same point.
        const angle = i * 2.399963229728653;
        const spread = 14 * Math.sqrt(i + 1);
        posX[i] = Math.cos(angle) * spread;
        posY[i] = Math.sin(angle) * spread;
      }
    }

    // New nodes that already have a placed neighbour start next to it, so an
    // incoming record does not fly in from the far edge of the map.
    for (let i = 0; i < n; i++) {
      if (previous.has(nodes[i].id)) continue;
      for (let p = adjStart[i]; p < adjStart[i + 1]; p++) {
        const j = adjList[p];
        if (!previous.has(nodes[j].id)) continue;
        posX[i] = posX[j] + jitter(i * 7 + 1) * 8000;
        posY[i] = posY[j] + jitter(i * 13 + 3) * 8000;
        break;
      }
    }

    for (let e = 0; e < m; e++) {
      const a = edgeA[e];
      const b = edgeB[e];
      const ca = linkCount[a];
      const cb = linkCount[b];
      edgeBias[e] = ca / (ca + cb || 1);
      edgeStrength[e] = 1 / Math.max(1, Math.min(ca, cb));
      edgeRest[e] = opts.linkDistance + (radius[a] + radius[b]) * 1.7;
    }

    if (selectedId && !index.has(selectedId)) selectedId = null;
    if (hoveredId && !index.has(hoveredId)) hoveredId = null;

    applyFilter();
    gridDirty = true;
    reheat(nodes.length ? 0.9 : 0);
    requestRender();
    return api;
  }

  function applyFilter() {
    for (let i = 0; i < n; i++) {
      let show = true;
      if (filterFn) {
        try {
          show = !!filterFn(nodes[i]);
        } catch (err) {
          console.error('[graph-canvas] Filter ist gescheitert:', err);
          show = true;
        }
      }
      visible[i] = show ? 1 : 0;
    }
    for (let e = 0; e < m; e++) {
      let show = visible[edgeA[e]] === 1 && visible[edgeB[e]] === 1;
      if (show && filterFn && typeof filterFn.edge === 'function') {
        try {
          show = !!filterFn.edge(edges[e]);
        } catch {
          show = true;
        }
      }
      edgeVisible[e] = show ? 1 : 0;
    }
    gridDirty = true;
  }

  /* --------------------------- simulation --------------------------- */

  function reheat(value) {
    const next = Number.isFinite(value) ? value : 0.6;
    if (next > alpha) alpha = next;
    if (alpha > opts.alphaMin) schedule();
    return api;
  }

  function running() {
    return alpha > opts.alphaMin || alphaTarget > 0;
  }

  function tick() {
    alpha += (alphaTarget - alpha) * opts.alphaDecay;
    if (alpha <= opts.alphaMin && alphaTarget <= 0) alpha = 0;

    // 1. Repulsion, summarised through the quadtree.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let live = 0;
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      live += 1;
      if (posX[i] < minX) minX = posX[i];
      if (posY[i] < minY) minY = posY[i];
      if (posX[i] > maxX) maxX = posX[i];
      if (posY[i] > maxY) maxY = posY[i];
    }
    if (!live) {
      alpha = 0;
      return;
    }
    const half = Math.max((maxX - minX) / 2, (maxY - minY) / 2, 1) * 1.05;
    tree.reset((minX + maxX) / 2, (minY + maxY) / 2, half);
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      tree.insert(i, posX, posY, charge, chain);
    }
    const theta2 = opts.theta * opts.theta;
    for (let i = 0; i < n; i++) {
      if (!visible[i] || fixed[i]) continue;
      tree.accumulate(i, posX, posY, charge, chain, theta2, alpha, forceOut);
      velX[i] += forceOut[0];
      velY[i] += forceOut[1];
    }

    // 2. Springs. Velocity is included in the distance (as in d3) so that a
    //    link does not overshoot when both ends are already moving apart.
    for (let e = 0; e < m; e++) {
      if (!edgeVisible[e]) continue;
      const a = edgeA[e];
      const b = edgeB[e];
      let dx = posX[b] + velX[b] - posX[a] - velX[a];
      let dy = posY[b] + velY[b] - posY[a] - velY[a];
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-6) {
        dx = jitter(e * 3 + 1);
        dy = jitter(e * 5 + 2);
        d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      }
      const weight = edgeWeight[e] > 0 ? Math.min(edgeWeight[e], 3) : 1;
      const l = ((d - edgeRest[e]) / d) * alpha * edgeStrength[e] * weight;
      const fx = dx * l;
      const fy = dy * l;
      const bias = edgeBias[e];
      if (!fixed[b]) {
        velX[b] -= fx * bias;
        velY[b] -= fy * bias;
      }
      if (!fixed[a]) {
        velX[a] += fx * (1 - bias);
        velY[a] += fy * (1 - bias);
      }
    }

    // 3. Gravity towards the origin. Without it, disconnected records -- and a
    //    personal vault is full of them -- drift outwards forever.
    for (let i = 0; i < n; i++) {
      if (!visible[i] || fixed[i]) continue;
      const pull = (adjStart[i + 1] === adjStart[i] ? opts.gravity * 2.2 : opts.gravity) * alpha;
      velX[i] -= posX[i] * pull;
      velY[i] -= posY[i] * pull;
    }

    // 4. Integrate.
    const decay = opts.velocityDecay;
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      if (fixed[i]) {
        posX[i] = fixX[i];
        posY[i] = fixY[i];
        velX[i] = 0;
        velY[i] = 0;
        continue;
      }
      velX[i] *= decay;
      velY[i] *= decay;
      posX[i] += velX[i];
      posY[i] += velY[i];
      if (!Number.isFinite(posX[i]) || !Number.isFinite(posY[i])) {
        // A NaN would silently remove the node from every later frame.
        posX[i] = jitter(i) * 5000;
        posY[i] = jitter(i + 1) * 5000;
        velX[i] = 0;
        velY[i] = 0;
      }
    }
    gridDirty = true;
  }

  /* ----------------------------- drawing ---------------------------- */

  const labelWidths = new Map();
  const LABEL_FONT = 'ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  /**
   * Text width per font pixel, measured once per label. `measureText` is the
   * single most expensive call in the label pass, and width scales linearly
   * with the font size, so one measurement serves every zoom level.
   */
  function labelWidth(label, fontSize) {
    let unit = labelWidths.get(label);
    if (unit === undefined) {
      const previous = ctx.font;
      ctx.font = `10px ${LABEL_FONT}`;
      unit = ctx.measureText(label).width / 10;
      ctx.font = previous;
      if (labelWidths.size > 4000) labelWidths.clear();
      labelWidths.set(label, unit);
    }
    return unit * fontSize;
  }

  function neighbourSet(slot) {
    const set = new Set();
    if (slot < 0) return set;
    set.add(slot);
    for (let p = adjStart[slot]; p < adjStart[slot + 1]; p++) set.add(adjList[p]);
    return set;
  }

  function nodeColor(i) {
    if (clusterOf) {
      const cluster = clusterOf.get(nodes[i].id);
      if (cluster !== undefined && palette.clusters.length) {
        return palette.clusters[Math.abs(cluster) % palette.clusters.length];
      }
      return palette.subtle;
    }
    return palette.types[nodes[i].type] || palette.types.unknown;
  }

  function drawShape(shape, x, y, r) {
    switch (shape) {
      case 'diamond':
        ctx.moveTo(x, y - r * 1.18);
        ctx.lineTo(x + r * 1.18, y);
        ctx.lineTo(x, y + r * 1.18);
        ctx.lineTo(x - r * 1.18, y);
        ctx.closePath();
        break;
      case 'triangle':
        ctx.moveTo(x, y - r * 1.25);
        ctx.lineTo(x + r * 1.12, y + r * 0.82);
        ctx.lineTo(x - r * 1.12, y + r * 0.82);
        ctx.closePath();
        break;
      case 'hexagon': {
        for (let s = 0; s < 6; s++) {
          const a = (s / 6) * TAU - Math.PI / 2;
          const px = x + Math.cos(a) * r * 1.12;
          const py = y + Math.sin(a) * r * 1.12;
          if (s === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        break;
      }
      case 'pentagon': {
        for (let s = 0; s < 5; s++) {
          const a = (s / 5) * TAU - Math.PI / 2;
          const px = x + Math.cos(a) * r * 1.15;
          const py = y + Math.sin(a) * r * 1.15;
          if (s === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        break;
      }
      case 'page': {
        const w = r * 0.92;
        const hgt = r * 1.2;
        const fold = Math.min(w, hgt) * 0.5;
        ctx.moveTo(x - w, y - hgt);
        ctx.lineTo(x + w - fold, y - hgt);
        ctx.lineTo(x + w, y - hgt + fold);
        ctx.lineTo(x + w, y + hgt);
        ctx.lineTo(x - w, y + hgt);
        ctx.closePath();
        break;
      }
      case 'bubble': {
        const w = r * 1.12;
        const hgt = r * 0.94;
        const rad = Math.min(w, hgt) * 0.55;
        ctx.moveTo(x - w + rad, y - hgt);
        ctx.arcTo(x + w, y - hgt, x + w, y + hgt, rad);
        ctx.arcTo(x + w, y + hgt, x - w, y + hgt, rad);
        ctx.lineTo(x - w * 0.34, y + hgt);
        ctx.lineTo(x - w * 0.62, y + hgt + rad * 0.9);
        ctx.lineTo(x - w * 0.62, y + hgt);
        ctx.arcTo(x - w, y + hgt, x - w, y - hgt, rad);
        ctx.arcTo(x - w, y - hgt, x + w, y - hgt, rad);
        ctx.closePath();
        break;
      }
      case 'ring':
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, TAU);
        ctx.moveTo(x + r * 0.45, y);
        ctx.arc(x, y, r * 0.45, 0, TAU, true);
        break;
      default:
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, TAU);
        break;
    }
  }

  function draw() {
    if (!width || !height) return;
    if (!palette) readPalette();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (!n) return;

    const k = transform.k;
    const focusSlot = hoveredId !== null ? (index.get(hoveredId) ?? -1) : -1;
    const near = focusSlot >= 0 ? neighbourSet(focusSlot) : null;
    const selectedSlot = selectedId !== null ? (index.get(selectedId) ?? -1) : -1;
    const dimming = !!near || (highlighted && highlighted.size > 0);

    // Screen coordinates once per frame; every later pass reads them.
    const margin = 80;
    for (let i = 0; i < n; i++) {
      screenX[i] = posX[i] * k + transform.x;
      screenY[i] = posY[i] * k + transform.y;
    }

    const isBright = (i) => {
      if (!dimming) return true;
      if (near && near.has(i)) return true;
      if (highlighted && highlighted.has(nodes[i].id)) return true;
      return false;
    };

    /* ---- edges, bucketed by style in ONE pass ----
       Six separate passes over the edge list would re-read every edge six
       times; at 3 000 edges * 60 fps that is 1 M pointless iterations per
       second. One pass sorts the indices, then each bucket is stroked as a
       single path. */
    const lineScale = clamp(Math.sqrt(k), 0.45, 2.2);
    for (const bucket of edgeBuckets) bucket.length = 0;
    for (let e = 0; e < m; e++) {
      if (!edgeVisible[e]) continue;
      const a = edgeA[e];
      const b = edgeB[e];
      const ax = screenX[a];
      const ay = screenY[a];
      const bx = screenX[b];
      const by = screenY[b];
      if ((ax < -margin && bx < -margin) || (ax > width + margin && bx > width + margin)) continue;
      if ((ay < -margin && by < -margin) || (ay > height + margin && by > height + margin)) continue;
      const source = edges[e].source;
      const slot = (source === 'manual' ? 2 : source === 'agent' ? 1 : 0) + (isBright(a) && isBright(b) ? 3 : 0);
      edgeBuckets[slot].push(e);
    }
    for (let slot = 0; slot < edgeBuckets.length; slot++) {
      const bucket = edgeBuckets[slot];
      if (!bucket.length) continue;
      const bright = slot >= 3;
      const kind = slot % 3;
      ctx.beginPath();
      for (let p = 0; p < bucket.length; p++) {
        const e = bucket[p];
        ctx.moveTo(screenX[edgeA[e]], screenY[edgeA[e]]);
        ctx.lineTo(screenX[edgeB[e]], screenY[edgeB[e]]);
      }
      if (kind === 2) {
        // Manual: solid and in the foreground colour. What the user drew is
        // the only kind of link the system did not guess.
        ctx.setLineDash([]);
        ctx.strokeStyle = rgba(palette.fg, bright ? 0.5 : 0.1);
        ctx.lineWidth = 1.35 * lineScale;
      } else if (kind === 1) {
        // Agent proposal: dash-dot in the warning colour -- a hypothesis.
        ctx.setLineDash([7 * lineScale, 3 * lineScale, 1.5 * lineScale, 3 * lineScale]);
        ctx.strokeStyle = rgba(palette.warn, bright ? 0.85 : 0.16);
        ctx.lineWidth = 1.2 * lineScale;
      } else {
        // Derived: thin and dashed, present but never loud.
        ctx.setLineDash([3 * lineScale, 3.5 * lineScale]);
        ctx.strokeStyle = rgba(palette.subtle, bright ? 0.6 : 0.12);
        ctx.lineWidth = 0.85 * lineScale;
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    /* ---- the link being drawn by hand (alt-drag) ---- */
    if (linkDrag) {
      const from = index.get(linkDrag.from);
      if (from !== undefined) {
        ctx.beginPath();
        ctx.moveTo(screenX[from], screenY[from]);
        ctx.lineTo(linkDrag.x, linkDrag.y);
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = rgba(palette.accent, 0.9);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    /* ---- nodes, batched per (colour, shape, dim) ---- */
    // The buckets are reused between frames: at 60 fps a fresh Map of arrays
    // per frame is pure garbage-collector pressure.
    for (const group of nodeBuckets.values()) group.items.length = 0;
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      const sx = screenX[i];
      const sy = screenY[i];
      const r = clamp(radius[i] * k, 1.4, 64);
      if (sx < -r - margin || sx > width + r + margin || sy < -r - margin || sy > height + r + margin) continue;
      const bright = isBright(i);
      const color = nodeColor(i);
      const shape = k < 0.34 ? 'circle' : (SHAPES[nodes[i].type] || 'circle');
      const key = `${color.r},${color.g},${color.b}|${shape}|${bright ? 1 : 0}`;
      let group = nodeBuckets.get(key);
      if (!group) nodeBuckets.set(key, (group = { color, shape, bright, items: [] }));
      group.items.push(i);
    }

    for (const group of nodeBuckets.values()) {
      if (!group.items.length) continue;
      const fill = palette.fillOf(group.color);
      ctx.beginPath();
      for (const i of group.items) drawShape(group.shape, screenX[i], screenY[i], clamp(radius[i] * k, 1.4, 64));
      ctx.fillStyle = rgba(fill, group.bright ? 1 : 0.28);
      ctx.fill();
      ctx.lineWidth = clamp(1.2 * lineScale, 0.6, 2.4);
      ctx.strokeStyle = rgba(group.color, group.bright ? 0.95 : 0.22);
      ctx.stroke();
    }

    /* ---- fixed markers, hover and selection rings ---- */
    ctx.lineWidth = 1;
    for (let i = 0; i < n; i++) {
      if (!visible[i] || !fixed[i]) continue;
      const r = clamp(radius[i] * k, 1.4, 64);
      const sx = screenX[i];
      const sy = screenY[i];
      if (sx < -r || sx > width + r || sy < -r || sy > height + r) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, r + 3.5, -0.7, 0.7);
      ctx.strokeStyle = rgba(palette.muted, isBright(i) ? 0.75 : 0.2);
      ctx.stroke();
    }

    const ring = (slot, color, extra, lineWidth) => {
      if (slot < 0 || slot >= n || !visible[slot]) return;
      const r = clamp(radius[slot] * k, 1.4, 64) + extra;
      ctx.beginPath();
      ctx.arc(screenX[slot], screenY[slot], r, 0, TAU);
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = color;
      ctx.stroke();
    };

    if (highlighted && highlighted.size) {
      for (const id of highlighted) {
        const slot = index.get(id);
        if (slot !== undefined && slot !== selectedSlot) ring(slot, rgba(palette.accent, 0.55), 4, 1.6);
      }
    }
    if (focusSlot >= 0) ring(focusSlot, rgba(palette.fg, 0.55), 3, 1.4);
    if (selectedSlot >= 0) {
      ring(selectedSlot, rgba(palette.accent, 0.95), 5, 2.2);
      if (linkArmed) ring(selectedSlot, rgba(palette.accent, 0.45), 9, 1.2);
    }

    /* ---- labels last, with collision-avoiding placement ---- */
    drawLabels(focusSlot, near, selectedSlot);
  }

  const occupancy = new Set();
  const nodeBuckets = new Map();
  const edgeBuckets = [[], [], [], [], [], []];

  function drawLabels(focusSlot, near, selectedSlot) {
    if (labelMode === 'off') return;
    const k = transform.k;
    const always = labelMode === 'always';
    const pointedAt = !!near || selectedSlot >= 0 || !!(highlighted && highlighted.size);
    const lowZoom = !always && k < opts.labelZoom;
    // Fully zoomed out with nothing to point at: every label would land on top
    // of another one, so the honest answer is to draw none.
    if (lowZoom && !pointedAt && k < opts.labelZoom * 0.55) return;

    const fontSize = clamp(11 * Math.sqrt(clamp(k, 0.5, 2)), 10, 15);
    ctx.font = `${fontSize.toFixed(1)}px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    const candidates = [];
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      const sx = screenX[i];
      const sy = screenY[i];
      if (sx < -40 || sx > width + 40 || sy < -20 || sy > height + 20) continue;
      let priority = nodes[i].degree;
      if (highlighted && highlighted.has(nodes[i].id)) priority += 100000;
      if (near && near.has(i)) priority += 50000;
      if (i === selectedSlot) priority += 200000;
      if (i === focusSlot) priority += 150000;
      if (fixed[i]) priority += 400;
      if (nodes[i].pinned) priority += 300;
      // Below the threshold only hubs and nodes the user is pointing at keep
      // their label; everything else would be unreadable anyway.
      if (lowZoom && priority < 400 && nodes[i].degree < 4) continue;
      candidates.push({ i, priority });
    }
    if (!candidates.length) return;
    candidates.sort((a, b) => b.priority - a.priority);

    occupancy.clear();
    const cell = 14;
    // +4 columns and a +1 offset below: a label may start just off-screen, and
    // a negative column index would otherwise fold onto the previous row.
    const cols = Math.ceil(width / cell) + 4;
    const limit = Math.min(candidates.length, lowZoom ? Math.min(64, opts.maxLabels) : opts.maxLabels);
    let drawn = 0;

    for (let c = 0; c < candidates.length && drawn < limit; c++) {
      const i = candidates[c].i;
      const node = nodes[i];
      const label = node.label.length > 44 ? `${node.label.slice(0, 43)}…` : node.label;
      const w = labelWidth(label, fontSize) + 6;
      const hgt = fontSize + 4;
      const r = clamp(radius[i] * k, 1.4, 64);
      const sx = screenX[i];
      const sy = screenY[i];
      const positions = [
        [sx - w / 2, sy + r + hgt * 0.7],
        [sx - w / 2, sy - r - hgt * 0.7],
        [sx + r + 5, sy],
        [sx - r - 5 - w, sy],
      ];
      let placed = null;
      for (const [lx, ly] of positions) {
        if (lx < -w || lx > width || ly < 0 || ly > height) continue;
        if (!free(lx, ly - hgt / 2, w, hgt, cell, cols)) continue;
        occupy(lx, ly - hgt / 2, w, hgt, cell, cols);
        placed = [lx, ly];
        break;
      }
      if (!placed) continue;
      drawn += 1;
      const bright = !near && !(highlighted && highlighted.size)
        ? true
        : (near && near.has(i)) || (highlighted && highlighted.has(node.id)) || i === selectedSlot;
      // A halo in the background colour keeps text legible over edges without
      // painting an opaque box over the graph.
      ctx.lineWidth = 3;
      ctx.strokeStyle = rgba(palette.bg, bright ? 0.85 : 0.45);
      ctx.strokeText(label, placed[0] + 3, placed[1]);
      ctx.fillStyle = rgba(i === selectedSlot ? palette.accent : palette.fg, bright ? 0.95 : 0.3);
      ctx.fillText(label, placed[0] + 3, placed[1]);
    }
  }

  /** +1 offset: a label may start just off-screen, and a negative column
   *  index would otherwise fold onto the previous row of the occupancy grid. */
  function cellKey(cx, cy, cols) {
    return (cy + 1) * cols + (cx + 1);
  }

  function free(x, y, w, hgt, cell, cols) {
    const x0 = Math.floor(x / cell);
    const x1 = Math.floor((x + w) / cell);
    const y0 = Math.floor(y / cell);
    const y1 = Math.floor((y + hgt) / cell);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (occupancy.has(cellKey(cx, cy, cols))) return false;
      }
    }
    return true;
  }

  function occupy(x, y, w, hgt, cell, cols) {
    const x0 = Math.floor(x / cell);
    const x1 = Math.floor((x + w) / cell);
    const y0 = Math.floor(y / cell);
    const y1 = Math.floor((y + hgt) / cell);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) occupancy.add(cellKey(cx, cy, cols));
    }
  }

  /* ------------------------- the frame loop -------------------------- */

  function schedule() {
    if (rafId || destroyed || hiddenPause) return;
    rafId = requestAnimationFrame(frame);
  }

  function requestRender() {
    schedule();
  }

  function frame(now) {
    rafId = 0;
    if (destroyed) return;
    let again = false;
    if (animation) {
      stepAnimation(now);
      again = animation !== null;
    }
    if (running()) {
      tick();
      if (running()) again = true;
      else emit('onSettle');
    }
    draw();
    if (again) schedule();
  }

  function stepAnimation(now) {
    const t = animation.duration <= 0 ? 1 : clamp((now - animation.start) / animation.duration, 0, 1);
    // ease-out cubic: fast enough to feel instant, slow enough to follow
    const e = 1 - (1 - t) ** 3;
    transform = {
      x: animation.from.x + (animation.to.x - animation.from.x) * e,
      y: animation.from.y + (animation.to.y - animation.from.y) * e,
      k: animation.from.k + (animation.to.k - animation.from.k) * e,
    };
    emit('onTransform', { ...transform });
    if (t >= 1) animation = null;
  }

  function reduceMotion() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  function animateTo(target, duration = 160) {
    const ms = reduceMotion() ? 0 : duration;
    if (ms <= 0) {
      transform = { ...target };
      animation = null;
      emit('onTransform', { ...transform });
      requestRender();
      return;
    }
    animation = { from: { ...transform }, to: { ...target }, start: performance.now(), duration: ms };
    schedule();
  }

  /* ---------------------------- viewport ---------------------------- */

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(0, Math.round(rect.width || canvas.clientWidth || 0));
    const cssHeight = Math.max(0, Math.round(rect.height || canvas.clientHeight || 0));
    const ratio = clamp(window.devicePixelRatio || 1, 1, 3);
    if (cssWidth === width && cssHeight === height && ratio === dpr) return api;
    const hadSize = width > 0 && height > 0;
    const oldWidth = width;
    const oldHeight = height;
    width = cssWidth;
    height = cssHeight;
    dpr = ratio;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    if (hadSize && width && height) {
      // Keep whatever was in the middle of the view in the middle of the view.
      transform.x += (width - oldWidth) / 2;
      transform.y += (height - oldHeight) / 2;
    } else if (width && height) {
      transform.x = width / 2;
      transform.y = height / 2;
    }
    requestRender();
    return api;
  }

  /** @param {Set<string>|string[]} [ids] restrict the box to these nodes */
  function bounds(ids) {
    const only = ids ? (ids instanceof Set ? ids : new Set(ids)) : null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      if (only && !only.has(nodes[i].id)) continue;
      count += 1;
      const r = radius[i];
      if (posX[i] - r < minX) minX = posX[i] - r;
      if (posY[i] - r < minY) minY = posY[i] - r;
      if (posX[i] + r > maxX) maxX = posX[i] + r;
      if (posY[i] + r > maxY) maxY = posY[i] + r;
    }
    if (!count) return null;
    return { minX, minY, maxX, maxY, count };
  }

  /**
   * Frame the visible graph -- or, with `config.ids`, just those nodes, which
   * is how the cluster panel zooms to one component.
   */
  function fitToView(config = {}) {
    const box = bounds(config.ids) || bounds();
    if (!box || !width || !height) return api;
    const padding = Number.isFinite(config.padding) ? config.padding : 48;
    const w = Math.max(box.maxX - box.minX, 1);
    const hgt = Math.max(box.maxY - box.minY, 1);
    const k = clamp(Math.min((width - padding * 2) / w, (height - padding * 2) / hgt), opts.minZoom, 2);
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    const target = { k, x: width / 2 - cx * k, y: height / 2 - cy * k };
    if (config.animate === false) {
      transform = target;
      animation = null;
      emit('onTransform', { ...transform });
      requestRender();
    } else {
      animateTo(target, 200);
    }
    return api;
  }

  function focus(id, config = {}) {
    const slot = index.get(id);
    if (slot === undefined || !width || !height) return api;
    if (!visible[slot]) {
      // Focusing something a filter hid would otherwise centre on emptiness.
      visible[slot] = 1;
      gridDirty = true;
    }
    const k = Number.isFinite(config.zoom) ? clamp(config.zoom, opts.minZoom, opts.maxZoom) : clamp(Math.max(transform.k, 0.9), 0.9, 2.2);
    const target = { k, x: width / 2 - posX[slot] * k, y: height / 2 - posY[slot] * k };
    if (config.animate === false) {
      transform = target;
      animation = null;
      emit('onTransform', { ...transform });
      requestRender();
    } else {
      animateTo(target, 220);
    }
    return api;
  }

  function zoomBy(factor, centreX, centreY) {
    const k = clamp(transform.k * factor, opts.minZoom, opts.maxZoom);
    if (k === transform.k) return;
    const cx = centreX === undefined ? width / 2 : centreX;
    const cy = centreY === undefined ? height / 2 : centreY;
    // Keep the world point under the cursor exactly under the cursor.
    transform = {
      k,
      x: cx - (cx - transform.x) * (k / transform.k),
      y: cy - (cy - transform.y) * (k / transform.k),
    };
    animation = null;
    emit('onTransform', { ...transform });
    requestRender();
  }

  /* --------------------------- interaction --------------------------- */

  const pointers = new Map();
  let mode = 'idle';
  let dragSlot = -1;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let dragMoved = false;
  let dragWasFixed = 0;
  let panStart = null;
  let pressStart = null;
  let linkDrag = null;
  let linkArmed = false;
  let pinchStart = null;
  let hoverPending = false;

  function nodeAtScreen(sx, sy) {
    const slot = hitTest(sx, sy);
    return slot >= 0 ? nodes[slot] : null;
  }

  function setHovered(id) {
    if (hoveredId === id) return;
    hoveredId = id;
    emit('onHover', id === null ? null : nodes[index.get(id)] || null);
    requestRender();
  }

  function onPointerDown(event) {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const p = pointerPosition(event);
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* a pointer that vanished mid-gesture is not worth an exception */
    }
    pointers.set(event.pointerId, p);

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = {
        distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        k: transform.k,
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        x: transform.x,
        y: transform.y,
      };
      mode = 'pinch';
      dragSlot = -1;
      linkDrag = null;
      return;
    }
    if (pointers.size > 2) return;

    const slot = hitTest(p.x, p.y);
    pressStart = { x: p.x, y: p.y, at: performance.now(), slot };

    const wantsLink = event.altKey && (slot >= 0 || selectedId !== null);
    if (wantsLink) {
      const fromId = slot >= 0 ? nodes[slot].id : selectedId;
      if (fromId) {
        linkDrag = { from: fromId, x: p.x, y: p.y, target: null };
        mode = 'link';
        requestRender();
        event.preventDefault();
        return;
      }
    }

    if (slot >= 0) {
      mode = 'drag';
      dragSlot = slot;
      dragMoved = false;
      dragWasFixed = fixed[slot];
      dragOffsetX = posX[slot] - toWorldX(p.x);
      dragOffsetY = posY[slot] - toWorldY(p.y);
      // Fixing happens on the first real movement, not here: a plain click is
      // a selection, and selecting something must not silently nail it down.
      fixX[slot] = posX[slot];
      fixY[slot] = posY[slot];
    } else {
      mode = 'pan';
      panStart = { x: p.x, y: p.y, tx: transform.x, ty: transform.y };
      animation = null;
    }
    event.preventDefault();
  }

  function onPointerMove(event) {
    const p = pointerPosition(event);
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, p);

    if (mode === 'pinch' && pointers.size >= 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const k = clamp(pinchStart.k * (distance / pinchStart.distance), opts.minZoom, opts.maxZoom);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const scale = k / pinchStart.k;
      transform = {
        k,
        x: midX - (pinchStart.midX - pinchStart.x) * scale,
        y: midY - (pinchStart.midY - pinchStart.y) * scale,
      };
      emit('onTransform', { ...transform });
      requestRender();
      return;
    }

    if (mode === 'pan' && panStart) {
      transform = { ...transform, x: panStart.tx + (p.x - panStart.x), y: panStart.ty + (p.y - panStart.y) };
      emit('onTransform', { ...transform });
      requestRender();
      return;
    }

    if (mode === 'drag' && dragSlot >= 0) {
      if (!dragMoved) {
        if (!pressStart || Math.hypot(p.x - pressStart.x, p.y - pressStart.y) <= CLICK_SLOP) return;
        dragMoved = true;
        fixed[dragSlot] = 1;
        alphaTarget = 0.28;
        reheat(0.4);
      }
      fixX[dragSlot] = toWorldX(p.x) + dragOffsetX;
      fixY[dragSlot] = toWorldY(p.y) + dragOffsetY;
      posX[dragSlot] = fixX[dragSlot];
      posY[dragSlot] = fixY[dragSlot];
      gridDirty = true;
      reheat(0.32);
      requestRender();
      return;
    }

    if (mode === 'link' && linkDrag) {
      linkDrag.x = p.x;
      linkDrag.y = p.y;
      const slot = hitTest(p.x, p.y);
      const targetId = slot >= 0 && nodes[slot].id !== linkDrag.from ? nodes[slot].id : null;
      linkDrag.target = targetId;
      setHovered(targetId);
      requestRender();
      return;
    }

    if (mode !== 'idle') return;
    // Hover work is throttled to one frame: pointermove fires far more often
    // than the screen refreshes, and every hover costs a hit test.
    if (hoverPending) return;
    hoverPending = true;
    requestAnimationFrame(() => {
      hoverPending = false;
      if (destroyed || mode !== 'idle') return;
      const slot = hitTest(p.x, p.y);
      setHovered(slot >= 0 ? nodes[slot].id : null);
      canvas.style.cursor = linkArmed ? 'crosshair' : (slot >= 0 ? 'pointer' : 'grab');
    });
  }

  function onPointerUp(event) {
    const p = pointerPosition(event);
    pointers.delete(event.pointerId);
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }

    if (mode === 'pinch') {
      if (pointers.size < 2) {
        pinchStart = null;
        mode = pointers.size === 1 ? 'pan' : 'idle';
        if (mode === 'pan') {
          const [only] = [...pointers.values()];
          panStart = { x: only.x, y: only.y, tx: transform.x, ty: transform.y };
        }
      }
      return;
    }

    const moved = pressStart ? Math.hypot(p.x - pressStart.x, p.y - pressStart.y) : Infinity;

    if (mode === 'link' && linkDrag) {
      const slot = hitTest(p.x, p.y);
      const target = slot >= 0 ? nodes[slot] : null;
      const from = linkDrag.from;
      linkDrag = null;
      mode = 'idle';
      requestRender();
      if (target && target.id !== from) emit('onLink', { from, to: target.id });
      pressStart = null;
      return;
    }

    if (mode === 'drag') {
      alphaTarget = 0;
      if (!dragMoved && dragSlot >= 0) {
        fixed[dragSlot] = dragWasFixed; // it was a click, not a drag
        if (moved <= CLICK_SLOP) select(nodes[dragSlot].id, event);
      }
      // A dragged node stays fixed on purpose: putting something in a place is
      // a statement about where it belongs, and the simulation must not undo it.
      dragSlot = -1;
      dragMoved = false;
      mode = 'idle';
      requestRender();
      pressStart = null;
      return;
    }

    if (mode === 'pan') {
      mode = 'idle';
      panStart = null;
      if (moved <= CLICK_SLOP) select(null, event);
      pressStart = null;
      return;
    }

    mode = 'idle';
    pressStart = null;
  }

  function onPointerCancel(event) {
    pointers.delete(event.pointerId);
    if (mode === 'drag') {
      alphaTarget = 0;
      if (!dragMoved && dragSlot >= 0) fixed[dragSlot] = dragWasFixed;
      dragMoved = false;
    }
    if (mode === 'link') {
      linkDrag = null;
      requestRender();
    }
    mode = pointers.size >= 2 ? 'pinch' : 'idle';
    pressStart = null;
    panStart = null;
    dragSlot = -1;
  }

  function onWheel(event) {
    event.preventDefault();
    const p = pointerPosition(event);
    // deltaMode 1 counts lines, not pixels; a trackpad pinch arrives as a
    // wheel event with ctrlKey and deserves a stronger response.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
    const delta = event.deltaY * unit * (event.ctrlKey ? 0.006 : 0.0016);
    zoomBy(Math.exp(-clamp(delta, -1.2, 1.2)), p.x, p.y);
  }

  function onDoubleClick(event) {
    const p = pointerPosition(event);
    const slot = hitTest(p.x, p.y);
    if (slot >= 0) {
      focus(nodes[slot].id);
      emit('onDoubleClick', nodes[slot]);
    } else {
      fitToView();
      emit('onDoubleClick', null);
    }
  }

  function onContextMenu(event) {
    event.preventDefault();
    const p = pointerPosition(event);
    const slot = hitTest(p.x, p.y);
    emit('onContext', slot >= 0 ? nodes[slot] : null, { clientX: event.clientX, clientY: event.clientY });
  }

  function onKeyDown(event) {
    const step = event.shiftKey ? 120 : 48;
    switch (event.key) {
      case 'ArrowLeft':
        transform = { ...transform, x: transform.x + step };
        break;
      case 'ArrowRight':
        transform = { ...transform, x: transform.x - step };
        break;
      case 'ArrowUp':
        transform = { ...transform, y: transform.y + step };
        break;
      case 'ArrowDown':
        transform = { ...transform, y: transform.y - step };
        break;
      case '+':
      case '=':
        zoomBy(1.25);
        return;
      case '-':
      case '_':
        zoomBy(0.8);
        return;
      case '0':
        fitToView();
        return;
      case 'Escape':
        if (selectedId) select(null, event);
        return;
      default:
        return;
    }
    event.preventDefault();
    animation = null;
    emit('onTransform', { ...transform });
    requestRender();
  }

  function onKeyState(event) {
    // The selection ring gains a halo while Alt is held, so the alt-drag
    // gesture for drawing a link is discoverable instead of folklore.
    const armed = !!event.altKey && selectedId !== null;
    if (armed !== linkArmed) {
      linkArmed = armed;
      canvas.style.cursor = armed ? 'crosshair' : (mode === 'idle' ? 'grab' : canvas.style.cursor);
      requestRender();
    }
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden') {
      hiddenPause = true;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    } else {
      hiddenPause = false;
      requestRender();
      if (running()) schedule();
    }
  }

  function select(id, event) {
    const next = id === null ? null : (index.has(id) ? id : null);
    if (next === selectedId) {
      if (next === null) emit('onSelect', null, event);
      else emit('onSelect', nodes[index.get(next)], event);
      return;
    }
    selectedId = next;
    linkArmed = false;
    requestRender();
    emit('onSelect', next === null ? null : nodes[index.get(next)], event);
  }

  /* --------------------------- observers ---------------------------- */

  let resizeObserver = null;
  try {
    resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(canvas);
  } catch {
    // Older engines: fall back to window resize, which is coarser but works.
    resizeObserver = null;
  }

  const onWindowResize = () => resize();
  let themeMedia = null;
  const onThemeChange = () => {
    palette = null;
    requestRender();
  };
  try {
    themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
    if (typeof themeMedia.addEventListener === 'function') themeMedia.addEventListener('change', onThemeChange);
    else if (typeof themeMedia.addListener === 'function') themeMedia.addListener(onThemeChange);
  } catch {
    themeMedia = null;
  }

  // The in-app theme toggle writes data-theme on <html>; the palette has to
  // follow it without the view having to remember to tell us.
  let themeObserver = null;
  try {
    themeObserver = new MutationObserver(onThemeChange);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  } catch {
    themeObserver = null;
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  const onPointerLeave = () => {
    if (mode === 'idle') setHovered(null);
  };
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('keydown', onKeyState);
  window.addEventListener('keyup', onKeyState);
  document.addEventListener('visibilitychange', onVisibility);

  if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');
  canvas.style.touchAction = 'none';
  canvas.style.cursor = 'grab';

  /* ------------------------------ API ------------------------------- */

  api = {
    setData,

    /** Centre the view on one node (and reveal it when a filter hid it). */
    focus,

    /** Ring and label a set of ids, dimming everything else. */
    highlight(ids) {
      if (!ids) highlighted = null;
      else {
        const set = ids instanceof Set ? new Set(ids) : new Set(Array.isArray(ids) ? ids : [ids]);
        highlighted = set.size ? set : null;
      }
      requestRender();
      return api;
    },

    /**
     * `fn(node) -> boolean` decides node visibility. An optional `fn.edge`
     * property decides edge visibility on top of it, which is what the
     * "only my own links" switch uses.
     */
    setFilter(fn) {
      filterFn = typeof fn === 'function' ? fn : null;
      applyFilter();
      reheat(0.35);
      requestRender();
      return api;
    },

    setSelection(id) {
      const next = id === null || id === undefined ? null : (index.has(id) ? id : null);
      if (next === selectedId) return api;
      selectedId = next;
      requestRender();
      return api;
    },

    /** Colour nodes by cluster; pass null to return to colouring by type. */
    setClusters(map) {
      clusterOf = map instanceof Map ? map : null;
      requestRender();
      return api;
    },

    setLabelMode(nextMode) {
      labelMode = nextMode === 'always' || nextMode === 'off' ? nextMode : 'auto';
      requestRender();
      return api;
    },

    /** Release a node dragged into place (or all of them). */
    unpin(id) {
      if (id === undefined || id === null) {
        for (let i = 0; i < n; i++) fixed[i] = 0;
      } else {
        const slot = index.get(id);
        if (slot === undefined) return api;
        fixed[slot] = 0;
      }
      reheat(0.4);
      requestRender();
      return api;
    },

    isPinned(id) {
      const slot = index.get(id);
      return slot === undefined ? false : fixed[slot] === 1;
    },

    resize,
    fitToView,
    reheat,

    getTransform() {
      return { ...transform };
    },

    setTransform(next) {
      if (!next) return api;
      transform = {
        x: Number.isFinite(next.x) ? next.x : transform.x,
        y: Number.isFinite(next.y) ? next.y : transform.y,
        k: Number.isFinite(next.k) ? clamp(next.k, opts.minZoom, opts.maxZoom) : transform.k,
      };
      animation = null;
      emit('onTransform', { ...transform });
      requestRender();
      return api;
    },

    zoomBy,

    getNode(id) {
      const slot = index.get(id);
      return slot === undefined ? null : nodes[slot];
    },

    /** All node metadata, for the view's search and cluster panels. */
    getNodes() {
      return nodes.slice();
    },

    getEdges() {
      return edges.slice();
    },

    /** Direct neighbours of a node, as metadata objects. */
    neighbours(id) {
      const slot = index.get(id);
      if (slot === undefined) return [];
      const out = [];
      for (let p = adjStart[slot]; p < adjStart[slot + 1]; p++) out.push(nodes[adjList[p]]);
      return out;
    },

    nodeAt(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      return nodeAtScreen(clientX - rect.left, clientY - rect.top);
    },

    getPalette() {
      return palette || readPalette();
    },

    refreshTheme() {
      palette = null;
      requestRender();
      return api;
    },

    stats() {
      let visibleNodes = 0;
      let visibleEdges = 0;
      for (let i = 0; i < n; i++) if (visible[i]) visibleNodes += 1;
      for (let e = 0; e < m; e++) if (edgeVisible[e]) visibleEdges += 1;
      return {
        nodes: n,
        edges: m,
        visibleNodes,
        visibleEdges,
        alpha,
        running: running(),
        zoom: transform.k,
        selected: selectedId,
      };
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('keydown', onKeyState);
      window.removeEventListener('keyup', onKeyState);
      document.removeEventListener('visibilitychange', onVisibility);
      if (resizeObserver) resizeObserver.disconnect();
      if (themeObserver) themeObserver.disconnect();
      if (themeMedia) {
        if (typeof themeMedia.removeEventListener === 'function') themeMedia.removeEventListener('change', onThemeChange);
        else if (typeof themeMedia.removeListener === 'function') themeMedia.removeListener(onThemeChange);
      }
      pointers.clear();
      labelWidths.clear();
      nodes = [];
      edges = [];
      index = new Map();
      n = 0;
      m = 0;
      try {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      } catch {
        /* the canvas may already be detached */
      }
    },
  };

  // Measured last: `resize()` returns `api`, so it may only run once the
  // object it returns actually exists.
  resize();
  readPalette();

  return api;
}

export default createGraphCanvas;
