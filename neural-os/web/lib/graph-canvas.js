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
 *    inspected. The draw loop allocates nothing per frame either: buckets,
 *    label candidates and the dim mask are reused between frames.
 * 3. **Barnes-Hut instead of the honest O(n^2).** Repulsion is summarised per
 *    quadtree cell whenever the cell is far enough away (theta = 0.9). That is
 *    the single decision that keeps 2 000 nodes interactive; the exact sum
 *    would be four million pair evaluations per tick.
 * 4. **The simulation stops.** `alpha` decays and, below `alphaMin`, the
 *    animation frame loop is cancelled outright. An idle graph view must cost
 *    zero CPU -- this application is meant to sit open all day on a laptop
 *    running a local model, and a renderer that spins forever would be a
 *    battery bug disguised as a feature. The loop is also cancelled while the
 *    tab is hidden.
 * 5. **Drawing happens in screen space.** World coordinates are converted by
 *    hand instead of being pushed into the canvas transform, so line widths,
 *    dash patterns and label sizes stay exact at every zoom level and at every
 *    `devicePixelRatio` -- a stroke scaled by the transform turns into a hair
 *    at k=0.1 and a slab at k=8. Chrome that must look machined -- the minimap
 *    frame, its viewport rectangle -- is snapped to the device pixel grid, so
 *    a 1 px hairline is one crisp pixel and not a 1.5 px grey smear.
 * 6. **Hit testing uses a uniform grid.** Linear search over every node would
 *    run on each `pointermove`; the grid is rebuilt only when positions have
 *    actually changed, and only when somebody asks for a hit.
 * 7. **The picture is black, white and grey.** The design system (app.css)
 *    says the interface is neutral and spends its single accent on the one
 *    thing that matters right now. This renderer obeys that: record types are
 *    told apart by *shape*, importance by *size and ink weight*, provenance by
 *    *line style* -- and the accent is reserved for the selection and for
 *    search hits. Eight saturated hues would be prettier in a screenshot and
 *    useless on a real vault, because hue carries no order and a colour-blind
 *    reader loses the whole encoding. Every colour is read from the CSS
 *    custom properties, so both themes work and a theme switch while the view
 *    is open re-resolves them.
 * 8. **Provenance is visible without a legend.** Manual edges are solid and
 *    use the foreground colour, derived edges are thin and dashed, agent
 *    suggestions are dash-dotted in the warning colour. What the user linked
 *    and what the machine guessed must be distinguishable at a glance.
 * 9. **Nothing is drawn that is not in the data.** Hull outlines come from the
 *    groups the view computed out of the edges actually on screen; the minimap
 *    plots the real positions; every label is a record's own title.
 */

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const TAU = Math.PI * 2;

/** Record types that can appear as nodes (mirrors schema.GRAPH_TYPES). */
export const GRAPH_TYPES = ['note', 'chat', 'project', 'task', 'agent', 'file', 'entity', 'run'];

/**
 * Shape per type. Shape -- not hue -- is what carries the type here, so the
 * encoding survives a greyscale print, a colour-blind reader and a dimmed
 * screen. The eight outlines are chosen to stay apart at 10 px: the silhouette
 * differs in corner count and in aspect, not only in size.
 */
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

/** Fixed bucket order, so the draw loop can index instead of hashing. */
const SHAPE_ORDER = ['circle', 'bubble', 'hexagon', 'diamond', 'triangle', 'page', 'ring', 'pentagon'];
const SHAPE_INDEX = new Map(SHAPE_ORDER.map((name, i) => [name, i]));

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
  labelZoom: 0.55, // below this zoom only the important labels are drawn
  maxLabels: 220,
  nodeBaseRadius: 4.6,
  nodeDegreeScale: 2.9,
  nodeMaxRadius: 26,
};

const MAX_TREE_DEPTH = 24;
const MIN_DISTANCE_SQ = 1;
const COINCIDENT_EPS = 1e-6;
const CLICK_SLOP = 4; // px of movement still counted as a click, not a drag
const HIT_SLOP = 6; // px of forgiveness around a node when hit testing

/** Camera motion. Long enough to follow with the eye, short enough to work in. */
const MOVE_MS = 320;
const FIT_MS = 360;

/** Dim factor for everything outside the focus. Context is kept, not hidden. */
const DIM = 0.16;

/** Minimap geometry (CSS pixels). */
const MAP_MAX_W = 176;
const MAP_MAX_H = 120;
const MAP_PAD = 12;
const MAP_MIN_NODES = 40; // below this the overview is noise, not help
const MAP_MIN_STAGE = 560;

/** Columns/rows of slack around the label occupancy grid, in grid cells. */
const OFF_GRID = 32;

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

/**
 * Trace the outline of one record type into a 2D context, centred on (x, y)
 * with nominal radius `r`. Exported so that a legend can draw the *same*
 * silhouette the canvas draws: two hand-written copies of these paths would
 * drift apart on the first change, and a legend that lies is worse than none.
 * The caller owns `beginPath`, the fill and the stroke.
 */
export function drawNodeShape(ctx, type, x, y, r) {
  const shape = typeof type === 'string' && SHAPE_INDEX.has(type) ? type : (SHAPES[type] || 'circle');
  switch (shape) {
    case 'diamond':
      ctx.moveTo(x, y - r * 1.2);
      ctx.lineTo(x + r * 1.2, y);
      ctx.lineTo(x, y + r * 1.2);
      ctx.lineTo(x - r * 1.2, y);
      ctx.closePath();
      break;
    case 'triangle':
      ctx.moveTo(x, y - r * 1.26);
      ctx.lineTo(x + r * 1.14, y + r * 0.8);
      ctx.lineTo(x - r * 1.14, y + r * 0.8);
      ctx.closePath();
      break;
    case 'hexagon': {
      for (let s = 0; s < 6; s++) {
        const a = (s / 6) * TAU - Math.PI / 2;
        const px = x + Math.cos(a) * r * 1.14;
        const py = y + Math.sin(a) * r * 1.14;
        if (s === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'pentagon': {
      for (let s = 0; s < 5; s++) {
        const a = (s / 5) * TAU - Math.PI / 2;
        const px = x + Math.cos(a) * r * 1.18;
        const py = y + Math.sin(a) * r * 1.18;
        if (s === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'page': {
      const w = r * 0.9;
      const hgt = r * 1.16;
      const fold = Math.min(w, hgt) * 0.52;
      ctx.moveTo(x - w, y - hgt);
      ctx.lineTo(x + w - fold, y - hgt);
      ctx.lineTo(x + w, y - hgt + fold);
      ctx.lineTo(x + w, y + hgt);
      ctx.lineTo(x - w, y + hgt);
      ctx.closePath();
      break;
    }
    case 'bubble': {
      const w = r * 1.16;
      const hgt = r * 0.94;
      const rad = Math.min(w, hgt) * 0.5;
      ctx.moveTo(x - w + rad, y - hgt);
      ctx.arcTo(x + w, y - hgt, x + w, y + hgt, rad);
      ctx.arcTo(x + w, y + hgt, x - w, y + hgt, rad);
      ctx.lineTo(x - w * 0.3, y + hgt);
      ctx.lineTo(x - w * 0.58, y + hgt + rad * 0.95);
      ctx.lineTo(x - w * 0.58, y + hgt);
      ctx.arcTo(x - w, y + hgt, x - w, y - hgt, rad);
      ctx.arcTo(x - w, y - hgt, x + w, y - hgt, rad);
      ctx.closePath();
      break;
    }
    case 'ring':
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, TAU);
      ctx.moveTo(x + r * 0.44, y);
      ctx.arc(x, y, r * 0.44, 0, TAU, true);
      break;
    default:
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, TAU);
      break;
  }
}

/**
 * Convex hull (Andrew's monotone chain) over `count` node slots held in
 * `slots`, reading world positions from `px`/`py`. Writes the hull back into
 * `out` as slot indices and returns how many it wrote. No allocation: the
 * caller owns both arrays, because this runs once per cluster per frame while
 * the simulation is still moving.
 */
function convexHull(slots, count, px, py, out) {
  if (count <= 2) {
    for (let i = 0; i < count; i++) out[i] = slots[i];
    return count;
  }
  // Sort by x, then y. `slots` is scratch owned by the caller.
  const view = slots.subarray(0, count);
  view.sort((a, b) => (px[a] - px[b]) || (py[a] - py[b]));
  const cross = (o, a, b) => (px[a] - px[o]) * (py[b] - py[o]) - (py[a] - py[o]) * (px[b] - px[o]);

  let k = 0;
  for (let i = 0; i < count; i++) {
    const p = view[i];
    while (k >= 2 && cross(out[k - 2], out[k - 1], p) <= 0) k--;
    out[k++] = p;
  }
  const lower = k + 1;
  for (let i = count - 2; i >= 0; i--) {
    const p = view[i];
    while (k >= lower && cross(out[k - 2], out[k - 1], p) <= 0) k--;
    out[k++] = p;
  }
  return Math.max(1, k - 1); // the last point repeats the first
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
  /** 1 = in focus, 0 = dimmed. Rebuilt only when the focus actually changes. */
  let bright = new Uint8Array(0);
  /** Ink tier per node (0 leaf, 1 normal, 2 hub); drives batching and weight. */
  let tier = new Uint8Array(0);

  let edgeA = new Int32Array(0);
  let edgeB = new Int32Array(0);
  let edgeWeight = new Float32Array(0);
  let edgeBias = new Float32Array(0);
  let edgeStrength = new Float32Array(0);
  let edgeRest = new Float32Array(0);
  let edgeVisible = new Uint8Array(0);
  /** Signed bow per edge. Parallel links fan out instead of stacking. */
  let edgeCurve = new Float32Array(0);
  /** 0 = derived, 1 = agent, 2 = manual. Read in the hot loop. */
  let edgeSource = new Uint8Array(0);

  // CSR adjacency, for neighbour highlighting and the focus walk.
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
  /** Focus mode: dim everything more than this many hops from the selection. */
  let focusDepth = 0;
  let maskDirty = true;

  let animation = null; // {from, to, start, duration}
  let gridDirty = true;

  /* --------------------------- measurements ------------------------- */

  let tickMs = 0;
  let drawMs = 0;
  let frameMs = 0;

  /* ----------------------------- palette ---------------------------- */

  let palette = null;

  /**
   * The colour the canvas actually sits on. The element itself is transparent,
   * so the halo behind a label has to come from the first ancestor that paints
   * something -- `--bg` in the graph view, `--surface` inside a card. Guessing
   * one of them would put a white halo on a dark panel.
   */
  function resolveGround(fallback) {
    let el = canvas;
    for (let step = 0; step < 10 && el && el.nodeType === 1; step++) {
      let value = '';
      try {
        value = getComputedStyle(el).backgroundColor;
      } catch {
        value = '';
      }
      const parsed = parseColor(ctx, value, null);
      if (parsed && parsed.a > 0.92) return { r: parsed.r, g: parsed.g, b: parsed.b, a: 1 };
      el = el.parentElement;
    }
    return fallback;
  }

  function readPalette() {
    const cs = getComputedStyle(canvas);
    const prop = (name) => cs.getPropertyValue(name).trim();
    const fg = parseColor(ctx, prop('--fg'), { r: 22, g: 24, b: 28, a: 1 });
    const token = parseColor(ctx, prop('--bg'), { r: 244, g: 244, b: 246, a: 1 });
    const bg = resolveGround(token);
    const dark = luminance(bg) < 0.45;
    const muted = parseColor(ctx, prop('--fg-muted'), dark ? { r: 154, g: 161, b: 172, a: 1 } : { r: 88, g: 94, b: 104, a: 1 });
    const subtle = parseColor(ctx, prop('--fg-subtle'), dark ? { r: 106, g: 113, b: 124, a: 1 } : { r: 133, g: 139, b: 149, a: 1 });
    const accent = parseColor(ctx, prop('--accent'), dark ? { r: 127, g: 156, b: 255, a: 1 } : { r: 47, g: 91, b: 208, a: 1 });
    const warn = parseColor(ctx, prop('--warn'), dark ? { r: 221, g: 164, b: 70, a: 1 } : { r: 138, g: 90, b: 0, a: 1 });
    const danger = parseColor(ctx, prop('--danger'), dark ? { r: 255, g: 111, b: 99, a: 1 } : { r: 178, g: 42, b: 33, a: 1 });
    const surface = parseColor(ctx, prop('--surface'), dark ? { r: 18, g: 20, b: 25, a: 1 } : { r: 255, g: 255, b: 255, a: 1 });

    // The whole node vocabulary is one neutral ramp from the ground towards
    // the foreground. Three ink weights read as "leaf / normal / hub" without
    // anybody having to be told, because more links means more ink.
    const plate = mix(bg, fg, dark ? 0.15 : 0.05);
    const inks = [
      mix(bg, fg, dark ? 0.3 : 0.34),
      mix(bg, fg, dark ? 0.46 : 0.52),
      mix(bg, fg, dark ? 0.68 : 0.78),
    ];
    // Dimming mixes towards the ground instead of lowering the alpha. An
    // alpha that looks right on black is invisible on white; a mix keeps the
    // same perceived distance from the background in both themes.
    const fade = (color, amount) => mix(bg, color, amount);
    const inksDim = inks.map((c) => fade(c, 0.3));
    const plateDim = fade(plate, 0.45);

    // Group swatches: the same ramp at different weights, so a list of
    // groups is scannable without turning the panel into a paint box.
    const clusters = [];
    for (let i = 0; i < 8; i++) clusters.push(mix(bg, fg, (dark ? 0.34 : 0.3) + (i % 4) * (dark ? 0.16 : 0.15)));

    palette = {
      dark,
      fg,
      bg,
      surface,
      muted,
      subtle,
      accent,
      warn,
      danger,
      plate,
      plateDim,
      inks,
      inksDim,
      fade,
      clusters,
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

  /**
   * Snap a coordinate so that a stroke of `lineWidth` CSS pixels covers whole
   * device pixels. Without this a 1 px frame at dpr 1 straddles two rows and
   * is painted as two half-covered grey lines -- the single cheapest-looking
   * artefact a canvas can produce. Only used for chrome that must look
   * machined; node positions stay continuous so motion does not stutter.
   */
  function crisp(value, lineWidth) {
    const device = lineWidth * dpr;
    const offset = Math.round(device) % 2 ? 0.5 / dpr : 0;
    return Math.round(value * dpr) / dpr + offset;
  }

  /** Round to the device pixel grid -- used for text baselines. */
  function snap(value) {
    return Math.round(value * dpr) / dpr;
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
    let offset = 0;
    for (let c = 0; c < cells; c++) {
      gridStart[c] = offset;
      offset += gridCounts[c];
      gridCounts[c] = gridStart[c];
    }
    gridStart[cells] = offset;
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
    bright = new Uint8Array(n);
    tier = new Uint8Array(n);

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
    edgeCurve = new Float32Array(m);
    edgeSource = new Uint8Array(m);

    const linkCount = new Int32Array(n);
    // How many links this pair already has. Two records that are linked three
    // times -- "erwähnt", "verweist auf" and one drawn by hand -- must not
    // collapse into a single stroke that hides two of them.
    const pairSeen = new Map();
    for (let e = 0; e < m; e++) {
      edgeA[e] = edges[e].a;
      edgeB[e] = edges[e].b;
      edgeWeight[e] = edges[e].weight;
      edgeSource[e] = edges[e].source === 'manual' ? 2 : edges[e].source === 'agent' ? 1 : 0;
      linkCount[edges[e].a] += 1;
      linkCount[edges[e].b] += 1;

      const lo = Math.min(edges[e].a, edges[e].b);
      const hi = Math.max(edges[e].a, edges[e].b);
      const key = lo * n + hi;
      const seen = pairSeen.get(key) || 0;
      pairSeen.set(key, seen + 1);
      // 0, then +1, -1, +2, -2 ... and the direction of the bow follows the
      // direction of the edge, so A->B and B->A separate instead of overlapping.
      const rank = Math.ceil(seen / 2) * (seen % 2 ? 1 : -1);
      edgeCurve[e] = rank * 0.19 * (edges[e].a === lo ? 1 : -1);
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
      tier[i] = radius[i] > 13 ? 2 : radius[i] > 8 ? 1 : 0;
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

    resolveHullSlots();
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
    maskDirty = true;
    hullDirty = true;
  }

  /* --------------------------- focus mask --------------------------- */

  /**
   * Who is in focus right now. Hovering lights up the direct neighbourhood;
   * a selection with focus mode on lights up everything within `focusDepth`
   * hops; a search lights up its hits. Everything else is *dimmed*, never
   * removed -- the shape of the surrounding graph is the context that makes a
   * neighbourhood mean anything.
   *
   * The result is a byte per node, rebuilt only when one of those inputs
   * changes. Recomputing a `Set` of neighbours inside the draw loop, as this
   * file used to, allocated on every single frame of a hover.
   */
  let queue = new Int32Array(0);
  let depthOf = new Int32Array(0);

  function rebuildMask() {
    maskDirty = false;
    if (!n) return;
    const hoverSlot = hoveredId !== null ? (index.get(hoveredId) ?? -1) : -1;
    const selectSlot = selectedId !== null ? (index.get(selectedId) ?? -1) : -1;
    const hasHighlight = !!(highlighted && highlighted.size);
    const hasFocus = focusDepth > 0 && selectSlot >= 0;
    if (hoverSlot < 0 && !hasHighlight && !hasFocus) {
      bright.fill(1);
      return;
    }
    bright.fill(0);

    if (hoverSlot >= 0) {
      bright[hoverSlot] = 1;
      for (let p = adjStart[hoverSlot]; p < adjStart[hoverSlot + 1]; p++) bright[adjList[p]] = 1;
    }
    if (hasHighlight) {
      for (const id of highlighted) {
        const slot = index.get(id);
        if (slot !== undefined) bright[slot] = 1;
      }
    }
    if (hasFocus) {
      if (queue.length < n) {
        queue = new Int32Array(n);
        depthOf = new Int32Array(n);
      }
      depthOf.fill(-1, 0, n);
      let head = 0;
      let tail = 0;
      queue[tail++] = selectSlot;
      depthOf[selectSlot] = 0;
      bright[selectSlot] = 1;
      while (head < tail) {
        const slot = queue[head++];
        const d = depthOf[slot];
        if (d >= focusDepth) continue;
        for (let p = adjStart[slot]; p < adjStart[slot + 1]; p++) {
          const next = adjList[p];
          if (depthOf[next] !== -1) continue;
          depthOf[next] = d + 1;
          bright[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    if (selectSlot >= 0) bright[selectSlot] = 1;
  }

  function markMaskDirty() {
    maskDirty = true;
  }

  /* ----------------------------- hulls ------------------------------ */

  /**
   * Soft outlines behind the groups the view found. They are drawn under
   * everything else and stay very faint: the point is to make "these belong
   * together" readable at a glance, not to add a second picture on top of the
   * first one.
   */
  let hullInput = []; // [{id, label, ids:string[]}]
  let hullGroups = []; // [{id, label, slots:Int32Array, count, hullCount, hull:Int32Array}]
  let hullDirty = true;
  let activeHullId = null;

  function resolveHullSlots() {
    hullGroups = [];
    for (const group of hullInput) {
      const ids = Array.isArray(group.ids) ? group.ids : [];
      const slots = new Int32Array(ids.length);
      let count = 0;
      for (const id of ids) {
        const slot = index.get(id);
        if (slot !== undefined) slots[count++] = slot;
      }
      if (count < 3) continue; // two nodes are a line, not a group outline
      hullGroups.push({
        id: group.id,
        label: typeof group.label === 'string' ? group.label : '',
        slots,
        count,
        hull: new Int32Array(count * 2 + 2),
        hullCount: 0,
        scratch: new Int32Array(count),
      });
    }
    hullDirty = true;
  }

  function rebuildHulls() {
    hullDirty = false;
    for (const group of hullGroups) {
      let live = 0;
      for (let i = 0; i < group.count; i++) {
        const slot = group.slots[i];
        if (visible[slot]) group.scratch[live++] = slot;
      }
      group.hullCount = live >= 3 ? convexHull(group.scratch, live, posX, posY, group.hull) : 0;
    }
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
    hullDirty = true;
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

  /* Reused scratch. None of this is allocated inside the frame loop. */
  const edgeBuckets = [];
  for (let i = 0; i < 6; i++) edgeBuckets.push([]);
  const nodeBuckets = [];
  for (let i = 0; i < SHAPE_ORDER.length * 6; i++) nodeBuckets.push([]);
  const occupancy = new Set();
  /** Boxes the group captions took, so a node label cannot land on one. */
  const captionBoxes = [];
  let labelOrder = new Int32Array(0);
  let labelScore = new Float64Array(0);

  function draw() {
    if (!width || !height) return;
    if (!palette) readPalette();
    if (maskDirty) rebuildMask();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (!n) return;

    const k = transform.k;
    const selectedSlot = selectedId !== null ? (index.get(selectedId) ?? -1) : -1;
    const hoverSlot = hoveredId !== null ? (index.get(hoveredId) ?? -1) : -1;

    // Screen coordinates once per frame; every later pass reads them.
    for (let i = 0; i < n; i++) {
      screenX[i] = posX[i] * k + transform.x;
      screenY[i] = posY[i] * k + transform.y;
    }

    drawHulls();
    drawEdges(k, hoverSlot, selectedSlot);
    drawNodes(k);
    drawRings(k, hoverSlot, selectedSlot);
    drawLabels(k, hoverSlot, selectedSlot);
    drawMinimap();
  }

  /* ---- group outlines, under everything ---- */

  function drawHulls() {
    captionBoxes.length = 0;
    if (!hullGroups.length) return;
    if (hullDirty) rebuildHulls();
    const k = transform.k;
    const pad = 16 + 10 * clamp(k, 0.2, 1.4);

    for (const group of hullGroups) {
      if (group.hullCount < 3) continue;
      const active = activeHullId !== null && group.id === activeHullId;

      // Centre of the hull in screen space, used to push each vertex outwards.
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < group.hullCount; i++) {
        cx += screenX[group.hull[i]];
        cy += screenY[group.hull[i]];
      }
      cx /= group.hullCount;
      cy /= group.hullCount;

      // Cheap viewport rejection: skip a group that cannot be on screen.
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < group.hullCount; i++) {
        const sx = screenX[group.hull[i]];
        const sy = screenY[group.hull[i]];
        if (sx < minX) minX = sx;
        if (sy < minY) minY = sy;
        if (sx > maxX) maxX = sx;
        if (sy > maxY) maxY = sy;
      }
      if (maxX + pad < 0 || minX - pad > width || maxY + pad < 0 || minY - pad > height) continue;

      // Rounded outline: walk the expanded hull and curve through the
      // midpoints. A polygon with hard corners would read as a diagram of
      // something; a soft blob reads as "a region", which is what it is.
      ctx.beginPath();
      let prevX = 0;
      let prevY = 0;
      for (let i = 0; i <= group.hullCount; i++) {
        const slot = group.hull[i % group.hullCount];
        let vx = screenX[slot] - cx;
        let vy = screenY[slot] - cy;
        const len = Math.hypot(vx, vy) || 1;
        const r = clamp(radius[slot] * k, 2, 64);
        vx = screenX[slot] + (vx / len) * (pad + r);
        vy = screenY[slot] + (vy / len) * (pad + r);
        if (i === 0) {
          prevX = vx;
          prevY = vy;
          continue;
        }
        const midX = (prevX + vx) / 2;
        const midY = (prevY + vy) / 2;
        if (i === 1) ctx.moveTo(midX, midY);
        else ctx.quadraticCurveTo(prevX, prevY, midX, midY);
        prevX = vx;
        prevY = vy;
      }
      ctx.closePath();

      const tintFill = active ? palette.accent : palette.fg;
      ctx.fillStyle = rgba(tintFill, active ? (palette.dark ? 0.07 : 0.055) : (palette.dark ? 0.045 : 0.035));
      ctx.fill();
      ctx.lineWidth = active ? 1.3 : 1;
      ctx.strokeStyle = rgba(active ? palette.accent : palette.fg, active ? 0.32 : (palette.dark ? 0.14 : 0.1));
      ctx.stroke();

      if (k < 0.24) continue;
      // The group's own name and its real size, set above the outline.
      const size = Math.round(10.5);
      ctx.font = `${size}px ${LABEL_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const live = countVisible(group);
      const caption = group.label ? `${group.label} · ${live}` : String(live);
      const ty = snap(minY - pad - 8);
      const tx = snap((minX + maxX) / 2);
      if (ty > 12 && ty < height - 4) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = rgba(palette.bg, 0.8);
        ctx.strokeText(caption, tx, ty);
        ctx.fillStyle = rgba(active ? palette.accent : palette.muted, active ? 0.95 : 0.7);
        ctx.fillText(caption, tx, ty);
        const cw = labelWidth(caption, size) + 8;
        captionBoxes.push(tx - cw / 2, ty - size, cw, size * 1.6);
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
    }
  }

  function countVisible(group) {
    let live = 0;
    for (let i = 0; i < group.count; i++) if (visible[group.slots[i]]) live += 1;
    return live;
  }

  /* ---- edges ---- */

  /**
   * Six buckets: {derived, agent, manual} x {dimmed, in focus}. Six separate
   * passes over the edge list would re-read every edge six times; at 3 000
   * edges * 60 fps that is a million pointless iterations per second. One pass
   * sorts the indices, then each bucket is stroked as a single path.
   */
  function drawEdges(k, hoverSlot, selectedSlot) {
    const margin = 90;
    const lineScale = clamp(Math.sqrt(k), 0.5, 2.1);
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
      edgeBuckets[edgeSource[e] + (bright[a] && bright[b] ? 3 : 0)].push(e);
    }

    // Direction is shown where it is being asked for: on the links of the node
    // under the pointer or in the selection, and everywhere once the view is
    // close enough that only a handful of links are on screen. An arrowhead on
    // every one of 3 000 edges is not direction, it is noise -- which is
    // exactly how the overview read before this rule existed.
    const near = hoverSlot >= 0 ? hoverSlot : selectedSlot;
    const everywhere = k >= 1.5;
    const showDirection = k >= 0.45 && (everywhere || near >= 0);

    for (let slot = 0; slot < edgeBuckets.length; slot++) {
      const bucket = edgeBuckets[slot];
      if (!bucket.length) continue;
      const lit = slot >= 3;
      const kind = slot % 3;

      ctx.beginPath();
      for (let p = 0; p < bucket.length; p++) {
        const e = bucket[p];
        const ax = screenX[edgeA[e]];
        const ay = screenY[edgeA[e]];
        const bx = screenX[edgeB[e]];
        const by = screenY[edgeB[e]];
        ctx.moveTo(ax, ay);
        const bow = edgeCurve[e];
        if (bow === 0) {
          ctx.lineTo(bx, by);
        } else {
          const dx = bx - ax;
          const dy = by - ay;
          const len = Math.hypot(dx, dy) || 1;
          const off = clamp(len * bow, -120, 120);
          ctx.quadraticCurveTo((ax + bx) / 2 - (dy / len) * off, (ay + by) / 2 + (dx / len) * off, bx, by);
        }
      }
      applyEdgeStyle(kind, lit, lineScale);
      ctx.stroke();

      if (!showDirection || !lit) continue;
      ctx.beginPath();
      let drawn = 0;
      for (let p = 0; p < bucket.length && drawn < 900; p++) {
        const e = bucket[p];
        if (!everywhere && edgeA[e] !== near && edgeB[e] !== near) continue;
        if (chevron(e, lineScale)) drawn += 1;
      }
      if (drawn) {
        ctx.setLineDash([]);
        ctx.lineWidth = (kind === 2 ? 1.3 : 1.05) * lineScale;
        ctx.strokeStyle = rgba(kind === 1 ? palette.warn : palette.fg, kind === 2 ? 0.5 : 0.34);
        ctx.stroke();
      }
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
  }

  function applyEdgeStyle(kind, lit, lineScale) {
    if (kind === 2) {
      // Manual: solid, in the foreground ink. What the user drew is the only
      // kind of link the system did not guess, so it is the only solid line.
      ctx.setLineDash([]);
      ctx.strokeStyle = lit ? rgba(palette.fg, 0.46) : rgba(palette.fade(palette.fg, DIM), 1);
      ctx.lineWidth = 1.3 * lineScale;
    } else if (kind === 1) {
      // Agent proposal: dash-dot in the warning colour -- a hypothesis.
      ctx.setLineDash([7 * lineScale, 3 * lineScale, 1.5 * lineScale, 3 * lineScale]);
      ctx.strokeStyle = lit ? rgba(palette.warn, 0.8) : rgba(palette.fade(palette.warn, DIM + 0.06), 1);
      ctx.lineWidth = 1.15 * lineScale;
    } else {
      // Derived: thin and dashed, present but never loud.
      ctx.setLineDash([3.2 * lineScale, 3.6 * lineScale]);
      ctx.strokeStyle = lit ? rgba(palette.muted, 0.46) : rgba(palette.fade(palette.muted, DIM), 1);
      ctx.lineWidth = 0.9 * lineScale;
    }
  }

  /**
   * A small chevron on the curve, pointing from `from` towards `to`. Placed at
   * 62 % so it never hides under either node and never collides with the
   * chevron of the opposite edge of the same pair.
   */
  function chevron(e, lineScale) {
    const ax = screenX[edgeA[e]];
    const ay = screenY[edgeA[e]];
    const bx = screenX[edgeB[e]];
    const by = screenY[edgeB[e]];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 34) return false;
    const t = 0.62;
    const bow = edgeCurve[e];
    const off = bow === 0 ? 0 : clamp(len * bow, -120, 120);
    const cx = (ax + bx) / 2 - (dy / len) * off;
    const cy = (ay + by) / 2 + (dx / len) * off;
    const mt = 1 - t;
    const px = mt * mt * ax + 2 * mt * t * cx + t * t * bx;
    const py = mt * mt * ay + 2 * mt * t * cy + t * t * by;
    let tx = 2 * mt * (cx - ax) + 2 * t * (bx - cx);
    let ty = 2 * mt * (cy - ay) + 2 * t * (by - cy);
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const size = clamp(4.4 * lineScale, 3, 7);
    const nx = -ty;
    const ny = tx;
    ctx.moveTo(px - tx * size + nx * size * 0.62, py - ty * size + ny * size * 0.62);
    ctx.lineTo(px, py);
    ctx.lineTo(px - tx * size - nx * size * 0.62, py - ty * size - ny * size * 0.62);
    return true;
  }

  /* ---- nodes ---- */

  function drawNodes(k) {
    const margin = 60;
    for (const bucket of nodeBuckets) bucket.length = 0;
    const flatten = k < 0.3; // below this a silhouette is two pixels wide

    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      const r = clamp(radius[i] * k, 1.5, 64);
      const sx = screenX[i];
      const sy = screenY[i];
      if (sx < -r - margin || sx > width + r + margin || sy < -r - margin || sy > height + r + margin) continue;
      const shape = flatten ? 0 : (SHAPE_INDEX.get(SHAPES[nodes[i].type]) ?? 0);
      nodeBuckets[shape * 6 + tier[i] * 2 + (bright[i] ? 1 : 0)].push(i);
    }

    const stroke = clamp(1.05 * Math.sqrt(clamp(k, 0.25, 3)), 0.7, 2);
    for (let b = 0; b < nodeBuckets.length; b++) {
      const bucket = nodeBuckets[b];
      if (!bucket.length) continue;
      const shape = SHAPE_ORDER[Math.floor(b / 6)];
      const lit = b % 2 === 1;
      const weight = Math.floor(b / 2) % 3;

      ctx.beginPath();
      for (let p = 0; p < bucket.length; p++) {
        const i = bucket[p];
        drawNodeShape(ctx, shape, screenX[i], screenY[i], clamp(radius[i] * k, 1.5, 64));
      }
      // An opaque plate, so the edges running underneath stop at the node
      // instead of showing through it as a grey haze.
      ctx.fillStyle = rgba(lit ? palette.plate : palette.plateDim, 1);
      ctx.fill();
      ctx.lineWidth = stroke * (weight === 2 ? 1.35 : weight === 1 ? 1.08 : 0.92);
      ctx.strokeStyle = rgba(lit ? palette.inks[weight] : palette.inksDim[weight], 1);
      ctx.stroke();
    }

    /* Nodes the user put somewhere by hand carry a short tick on the right,
       so "I placed this" is visible without hovering. */
    ctx.lineWidth = clamp(1.1 * Math.sqrt(clamp(k, 0.3, 3)), 0.8, 1.8);
    ctx.beginPath();
    let ticks = 0;
    for (let i = 0; i < n; i++) {
      if (!visible[i] || !fixed[i]) continue;
      const r = clamp(radius[i] * k, 1.5, 64);
      const sx = screenX[i];
      const sy = screenY[i];
      if (sx < -r || sx > width + r || sy < -r || sy > height + r) continue;
      ctx.moveTo(sx + r + 2.5, sy - r * 0.42);
      ctx.lineTo(sx + r + 2.5, sy + r * 0.42);
      ticks += 1;
    }
    if (ticks) {
      ctx.strokeStyle = rgba(palette.fg, 0.55);
      ctx.stroke();
    }
  }

  /* ---- hover and selection rings ---- */

  function drawRings(k, hoverSlot, selectedSlot) {
    const radiusAt = (slot, extra) => clamp(radius[slot] * k, 1.5, 64) + extra;

    // Past a few dozen, a ring around every hit is a second graph drawn over
    // the first one. The dimming already says which nodes are meant.
    if (highlighted && highlighted.size && highlighted.size <= 40) {
      ctx.beginPath();
      let any = false;
      for (const id of highlighted) {
        const slot = index.get(id);
        if (slot === undefined || slot === selectedSlot || !visible[slot]) continue;
        const r = radiusAt(slot, 3.5);
        ctx.moveTo(screenX[slot] + r, screenY[slot]);
        ctx.arc(screenX[slot], screenY[slot], r, 0, TAU);
        any = true;
      }
      if (any) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = rgba(palette.accent, 0.55);
        ctx.stroke();
      }
    }

    // Hover: one ring in plain ink. Selection: a gap in the ground colour and
    // then a heavy accent ring -- two rings and a thicker stroke, so the state
    // is unmistakable in a screenshot printed in black and white.
    if (hoverSlot >= 0 && visible[hoverSlot] && hoverSlot !== selectedSlot) {
      ctx.beginPath();
      const r = radiusAt(hoverSlot, 4);
      ctx.arc(screenX[hoverSlot], screenY[hoverSlot], r, 0, TAU);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = rgba(palette.fg, 0.6);
      ctx.stroke();
    }

    if (selectedSlot >= 0 && visible[selectedSlot]) {
      const sx = screenX[selectedSlot];
      const sy = screenY[selectedSlot];
      ctx.beginPath();
      ctx.arc(sx, sy, radiusAt(selectedSlot, 3), 0, TAU);
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = rgba(palette.bg, 0.95);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx, sy, radiusAt(selectedSlot, 4.6), 0, TAU);
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = rgba(palette.accent, 1);
      ctx.stroke();
      if (linkArmed) {
        ctx.beginPath();
        ctx.arc(sx, sy, radiusAt(selectedSlot, 9), 0, TAU);
        ctx.lineWidth = 1.1;
        ctx.strokeStyle = rgba(palette.accent, 0.42);
        ctx.stroke();
      }
    }
  }

  /* ---- labels ---- */

  /**
   * Labels are the whole point of the picture: a node without one is a dot.
   * Three rules keep them readable instead of merely present.
   *
   *   1. Every node already on screen reserves its own box first, so a label
   *      can never be dropped on top of a node.
   *   2. Labels are placed greedily in order of importance and skipped when
   *      their box is taken, so two labels never overlap.
   *   3. A halo in the ground colour is stroked behind the text, so a label
   *      that sits over an edge stays legible.
   */
  function drawLabels(k, hoverSlot, selectedSlot) {
    if (labelMode === 'off') return;
    const always = labelMode === 'always';
    const pointedAt = hoverSlot >= 0 || selectedSlot >= 0 || !!(highlighted && highlighted.size);
    const lowZoom = !always && k < opts.labelZoom;
    // Fully zoomed out with nothing to point at: every label would land on top
    // of another one, so the honest answer is to draw none.
    if (lowZoom && !pointedAt && k < opts.labelZoom * 0.5) return;

    const fontSize = clamp(11 * Math.sqrt(clamp(k, 0.5, 2)), 10.5, 15);
    ctx.font = `${fontSize.toFixed(1)}px ${LABEL_FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    if (labelOrder.length < n) {
      labelOrder = new Int32Array(n);
      labelScore = new Float64Array(n);
    }

    const cell = 13;
    // The grid has to hold columns left of the screen as well: a centred label
    // on a node near the left edge starts at a negative x. OFF_GRID is the
    // slack in both directions, and `cols` is wide enough that a negative
    // column can never wrap onto the previous row and block the wrong pixels.
    const cols = Math.ceil(width / cell) + OFF_GRID * 2;
    occupancy.clear();

    // Rule 1: the nodes -- and the group captions drawn under them -- own
    // their pixels before any label asks for a place.
    for (let b = 0; b < captionBoxes.length; b += 4) {
      occupy(captionBoxes[b], captionBoxes[b + 1], captionBoxes[b + 2], captionBoxes[b + 3], cell, cols);
    }
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      const sx = screenX[i];
      const sy = screenY[i];
      const r = clamp(radius[i] * k, 1.5, 64) + 2;
      if (sx + r < 0 || sx - r > width || sy + r < 0 || sy - r > height) continue;
      occupy(sx - r, sy - r, r * 2, r * 2, cell, cols);
    }

    let count = 0;
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      const sx = screenX[i];
      const sy = screenY[i];
      if (sx < -40 || sx > width + 40 || sy < -20 || sy > height + 20) continue;
      let priority = nodes[i].degree;
      if (highlighted && highlighted.has(nodes[i].id)) priority += 100000;
      if (bright[i]) priority += 20000;
      if (i === hoverSlot) priority += 150000;
      if (i === selectedSlot) priority += 200000;
      if (fixed[i]) priority += 400;
      if (nodes[i].pinned) priority += 300;
      // Below the threshold only hubs and nodes the user is pointing at keep
      // their label; everything else would be unreadable anyway.
      if (lowZoom && priority < 400 && nodes[i].degree < 4) continue;
      labelOrder[count] = i;
      labelScore[i] = priority;
      count += 1;
    }
    if (!count) return;
    labelOrder.subarray(0, count).sort((a, b) => labelScore[b] - labelScore[a]);

    const limit = Math.min(count, lowZoom ? Math.min(72, opts.maxLabels) : opts.maxLabels);
    let drawn = 0;

    for (let c = 0; c < count && drawn < limit; c++) {
      const i = labelOrder[c];
      const node = nodes[i];
      const label = node.label.length > 42 ? `${node.label.slice(0, 41)}…` : node.label;
      const w = labelWidth(label, fontSize) + 6;
      const hgt = fontSize + 4;
      const r = clamp(radius[i] * k, 1.5, 64);
      const sx = screenX[i];
      const sy = screenY[i];
      const current = i === selectedSlot || i === hoverSlot;
      let placed = false;
      let lx = 0;
      let ly = 0;
      for (let slot = 0; slot < 4; slot++) {
        // below, above, right, left -- in that order, because a caption under
        // the thing it names is where the eye looks first.
        if (slot === 0) {
          lx = sx - w / 2;
          ly = sy + r + hgt * 0.72;
        } else if (slot === 1) {
          lx = sx - w / 2;
          ly = sy - r - hgt * 0.72;
        } else if (slot === 2) {
          lx = sx + r + 6;
          ly = sy;
        } else {
          lx = sx - r - 6 - w;
          ly = sy;
        }
        if (lx < -w || lx > width || ly < 4 || ly > height - 4) continue;
        if (!free(lx, ly - hgt / 2, w, hgt, cell, cols)) continue;
        occupy(lx, ly - hgt / 2, w, hgt, cell, cols);
        placed = true;
        break;
      }
      if (!placed) {
        // The one node the user is pointing at always gets its name, even in
        // a crowd: it goes below the node and takes a plate, which is opaque
        // enough to win against whatever it lands on. Dropping the label of
        // the thing that was just clicked is never the right answer.
        if (!current) continue;
        lx = clamp(sx - w / 2, 2, Math.max(2, width - w - 2));
        ly = clamp(sy + r + hgt * 0.72, hgt, height - hgt);
        occupy(lx, ly - hgt / 2, w, hgt, cell, cols);
      }
      drawn += 1;

      const lit = bright[i] === 1;
      const x = snap(lx + 3);
      const y = snap(ly);

      if (current) {
        // The one label the user is working with gets a real plate instead of
        // a halo: it has to win against whatever is behind it.
        roundRect(x - 5, y - hgt / 2, w + 4, hgt, 4);
        ctx.fillStyle = rgba(palette.bg, 0.94);
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = rgba(i === selectedSlot ? palette.accent : palette.fg, i === selectedSlot ? 0.5 : 0.22);
        ctx.stroke();
      } else {
        ctx.lineWidth = 3;
        ctx.strokeStyle = rgba(palette.bg, lit ? 0.9 : 0.5);
        ctx.strokeText(label, x, y);
      }
      ctx.fillStyle = lit
        ? rgba(i === selectedSlot ? palette.accent : palette.fg, 0.95)
        : rgba(palette.fade(palette.fg, 0.42), 1);
      ctx.fillText(label, x, y);
    }
  }

  /** A rounded rectangle path. `ctx.roundRect` is not everywhere yet. */
  function roundRect(x, y, w, hgt, r) {
    const rad = Math.min(r, w / 2, hgt / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + hgt, rad);
    ctx.arcTo(x + w, y + hgt, x, y + hgt, rad);
    ctx.arcTo(x, y + hgt, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  /**
   * Key into the label occupancy grid. The offset exists because a label may
   * start off-screen in either direction; without it a negative column index
   * would fold onto the previous row and reserve pixels somewhere else
   * entirely -- a collision test that quietly lies.
   */
  function cellKey(cx, cy, cols) {
    return (cy + OFF_GRID) * cols + (cx + OFF_GRID);
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

  /* ---- minimap ---- */

  /**
   * A thumbnail of the whole graph with the current viewport marked on it.
   * It answers the one question a zoomed-in graph cannot: "where am I?".
   * It is hidden on a small graph, where the answer is "you can see all of
   * it", and on a narrow stage, where it would eat the picture.
   */
  let mapRect = null;
  let mapEnabled = 'auto';

  function minimapVisible() {
    if (mapEnabled === false) return false;
    if (mapEnabled === true) return n > 0;
    return n >= MAP_MIN_NODES && width >= MAP_MIN_STAGE && height >= 320;
  }

  /**
   * An overview of something you can already see in full is decoration. When
   * the viewport contains the whole graph -- right after "Einpassen", which is
   * how the view opens -- the map has nothing to add and stays away.
   */
  function worthShowing(box) {
    if (mapEnabled === true) return true;
    const viewW = width / transform.k;
    const viewH = height / transform.k;
    return (box.maxX - box.minX) > viewW * 0.94 || (box.maxY - box.minY) > viewH * 0.94;
  }

  function drawMinimap() {
    mapRect = null;
    if (!minimapVisible()) return;
    const box = bounds();
    if (!box || !worthShowing(box)) return;

    const worldW = Math.max(box.maxX - box.minX, 1);
    const worldH = Math.max(box.maxY - box.minY, 1);
    const scale = Math.min(MAP_MAX_W / worldW, MAP_MAX_H / worldH);
    const w = Math.max(56, Math.min(MAP_MAX_W, worldW * scale));
    const hgt = Math.max(46, Math.min(MAP_MAX_H, worldH * scale));
    const x = width - w - MAP_PAD;
    const y = MAP_PAD;
    mapRect = { x, y, w, h: hgt, scale, minX: box.minX, minY: box.minY, worldW, worldH };

    ctx.save();
    roundRect(crisp(x, 1), crisp(y, 1), Math.round(w), Math.round(hgt), 6);
    ctx.fillStyle = rgba(palette.surface, palette.dark ? 0.72 : 0.82);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(palette.fg, palette.dark ? 0.18 : 0.14);
    ctx.stroke();
    ctx.clip();

    const ox = x + (w - worldW * scale) / 2;
    const oy = y + (hgt - worldH * scale) / 2;
    const dot = clamp(scale * 8, 0.7, 2);

    ctx.beginPath();
    let dim = 0;
    for (let i = 0; i < n; i++) {
      if (!visible[i] || bright[i]) continue;
      const px = ox + (posX[i] - box.minX) * scale;
      const py = oy + (posY[i] - box.minY) * scale;
      ctx.moveTo(px + dot, py);
      ctx.arc(px, py, dot, 0, TAU);
      dim += 1;
    }
    if (dim) {
      ctx.fillStyle = rgba(palette.fg, 0.16);
      ctx.fill();
    }
    ctx.beginPath();
    let lit = 0;
    for (let i = 0; i < n; i++) {
      if (!visible[i] || !bright[i]) continue;
      const px = ox + (posX[i] - box.minX) * scale;
      const py = oy + (posY[i] - box.minY) * scale;
      ctx.moveTo(px + dot, py);
      ctx.arc(px, py, dot, 0, TAU);
      lit += 1;
    }
    if (lit) {
      ctx.fillStyle = rgba(palette.fg, 0.42);
      ctx.fill();
    }

    // The viewport, snapped to the device pixel grid so the frame is one
    // crisp line rather than a two-pixel smear.
    const k = transform.k;
    const vx = ox + (toWorldX(0) - box.minX) * scale;
    const vy = oy + (toWorldY(0) - box.minY) * scale;
    const vw = (width / k) * scale;
    const vh = (height / k) * scale;
    ctx.beginPath();
    ctx.rect(crisp(vx, 1.2), crisp(vy, 1.2), Math.max(4, Math.round(vw)), Math.max(4, Math.round(vh)));
    ctx.fillStyle = rgba(palette.accent, 0.08);
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = rgba(palette.accent, 0.75);
    ctx.stroke();

    ctx.restore();
  }

  function pointInMinimap(sx, sy) {
    if (!mapRect) return false;
    return sx >= mapRect.x && sx <= mapRect.x + mapRect.w && sy >= mapRect.y && sy <= mapRect.y + mapRect.h;
  }

  /** Centre the camera on the world point a minimap position stands for. */
  function cameraFromMinimap(sx, sy) {
    if (!mapRect) return;
    const ox = mapRect.x + (mapRect.w - mapRect.worldW * mapRect.scale) / 2;
    const oy = mapRect.y + (mapRect.h - mapRect.worldH * mapRect.scale) / 2;
    const wx = mapRect.minX + (sx - ox) / mapRect.scale;
    const wy = mapRect.minY + (sy - oy) / mapRect.scale;
    transform = { k: transform.k, x: width / 2 - wx * transform.k, y: height / 2 - wy * transform.k };
    animation = null;
    emit('onTransform', { ...transform });
    requestRender();
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
    const t0 = performance.now();
    let again = false;
    if (animation) {
      stepAnimation(now);
      again = animation !== null;
    }
    let settled = false;
    if (running()) {
      tick();
      if (running()) again = true;
      else settled = true;
    }
    const t1 = performance.now();
    draw();
    const t2 = performance.now();
    tickMs = tickMs * 0.85 + (t1 - t0) * 0.15;
    drawMs = drawMs * 0.85 + (t2 - t1) * 0.15;
    frameMs = frameMs * 0.85 + (t2 - t0) * 0.15;
    if (settled) emit('onSettle');
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

  function animateTo(target, duration = MOVE_MS) {
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
    watchPixelRatio();
    requestRender();
    return api;
  }

  /**
   * `devicePixelRatio` changes when the window is dragged to a screen with a
   * different density or the page is zoomed. That fires no resize event on
   * every engine, and a canvas backing store left at the old ratio is exactly
   * the half-pixel blur this renderer is trying to avoid -- so the ratio is
   * watched directly.
   */
  let ratioMedia = null;
  const onRatioChange = () => {
    if (destroyed) return;
    resize();
    // `resize()` re-arms the watch for the new ratio.
  };

  function watchPixelRatio() {
    try {
      if (ratioMedia && typeof ratioMedia.removeEventListener === 'function') {
        ratioMedia.removeEventListener('change', onRatioChange);
      }
      const value = window.devicePixelRatio || 1;
      ratioMedia = window.matchMedia(`(resolution: ${value}dppx)`);
      if (typeof ratioMedia.addEventListener === 'function') ratioMedia.addEventListener('change', onRatioChange);
    } catch {
      ratioMedia = null;
    }
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
    const padding = Number.isFinite(config.padding) ? config.padding : 56;
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
      animateTo(target, FIT_MS);
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
      maskDirty = true;
      hullDirty = true;
    }
    const k = Number.isFinite(config.zoom) ? clamp(config.zoom, opts.minZoom, opts.maxZoom) : clamp(Math.max(transform.k, 0.9), 0.9, 2.2);
    const target = { k, x: width / 2 - posX[slot] * k, y: height / 2 - posY[slot] * k };
    if (config.animate === false) {
      transform = target;
      animation = null;
      emit('onTransform', { ...transform });
      requestRender();
    } else {
      animateTo(target, MOVE_MS);
    }
    return api;
  }

  function zoomBy(factor, centreX, centreY, animate) {
    const k = clamp(transform.k * factor, opts.minZoom, opts.maxZoom);
    if (k === transform.k) return;
    const cx = centreX === undefined ? width / 2 : centreX;
    const cy = centreY === undefined ? height / 2 : centreY;
    // Keep the world point under the cursor exactly under the cursor.
    const next = {
      k,
      x: cx - (cx - transform.x) * (k / transform.k),
      y: cy - (cy - transform.y) * (k / transform.k),
    };
    if (animate) {
      animateTo(next, 200);
      return;
    }
    transform = next;
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
    markMaskDirty();
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

    if (pointInMinimap(p.x, p.y)) {
      mode = 'minimap';
      pressStart = null;
      cameraFromMinimap(p.x, p.y);
      event.preventDefault();
      return;
    }

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

    if (mode === 'minimap') {
      cameraFromMinimap(p.x, p.y);
      return;
    }

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
      hullDirty = true;
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
      if (pointInMinimap(p.x, p.y)) {
        setHovered(null);
        canvas.style.cursor = 'pointer';
        return;
      }
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

    if (mode === 'minimap') {
      mode = 'idle';
      pressStart = null;
      return;
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
    if (pointInMinimap(p.x, p.y)) return;
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

  /** The visible node nearest the middle of the view -- the keyboard's "here". */
  function centreSlot() {
    let best = -1;
    let bestD = Infinity;
    const cx = width / 2;
    const cy = height / 2;
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue;
      const dx = posX[i] * transform.k + transform.x - cx;
      const dy = posY[i] * transform.k + transform.y - cy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * Walk the graph with the keyboard. `n`/`p` step around the *anchor* -- the
   * node that was selected when the walk began -- so pressing `n` repeatedly
   * looks at one node's neighbours one after another instead of wandering off
   * into the graph. `Enter` re-anchors on whatever is selected, which is how
   * you descend. Tab is deliberately left alone: a canvas that swallows Tab
   * traps every keyboard user inside it.
   */
  let walkAnchor = -1;
  let walkCursor = -1;
  let walking = false;

  function stepNeighbour(direction) {
    if (walkAnchor < 0 || walkAnchor >= n || !visible[walkAnchor]) {
      walkAnchor = selectedId !== null ? (index.get(selectedId) ?? -1) : -1;
      walkCursor = -1;
    }
    if (walkAnchor < 0) return false;
    const start = adjStart[walkAnchor];
    const count = adjStart[walkAnchor + 1] - start;
    if (!count) return false;
    for (let step = 0; step < count; step++) {
      walkCursor = (walkCursor + direction + count) % count;
      const next = adjList[start + walkCursor];
      if (!visible[next]) continue;
      walking = true;
      try {
        select(nodes[next].id, null);
      } finally {
        walking = false;
      }
      focus(nodes[next].id);
      return true;
    }
    return false;
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
        zoomBy(1.3, undefined, undefined, true);
        return;
      case '-':
      case '_':
        zoomBy(0.77, undefined, undefined, true);
        return;
      case '0':
        fitToView();
        return;
      case 'Enter':
      case ' ': {
        // Nothing selected: pick up the node in the middle of the view, so a
        // keyboard user has a way into the graph that does not go through the
        // search box. Something selected: anchor the walk here.
        event.preventDefault();
        if (selectedId !== null) {
          walkAnchor = index.get(selectedId) ?? -1;
          walkCursor = -1;
          focus(selectedId);
          return;
        }
        const slot = centreSlot();
        if (slot >= 0) {
          walkAnchor = slot;
          walkCursor = -1;
          select(nodes[slot].id, event);
          focus(nodes[slot].id);
        }
        return;
      }
      case 'n':
      case 'N':
        if (stepNeighbour(1)) event.preventDefault();
        return;
      case 'p':
      case 'P':
        if (stepNeighbour(-1)) event.preventDefault();
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
    if (!walking) {
      walkAnchor = -1;
      walkCursor = -1;
    }
    markMaskDirty();
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
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
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
      markMaskDirty();
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
      markMaskDirty();
      requestRender();
      return api;
    },

    /**
     * Group nodes by a `Map<id, clusterIndex>`; pass null to clear. This is
     * the label-less form of `setHulls` and writes to the same slot, so a
     * caller uses one or the other.
     */
    setClusters(map) {
      clusterOf = map instanceof Map ? map : null;
      if (!clusterOf) {
        hullInput = [];
      } else {
        const byCluster = new Map();
        for (const [id, cluster] of clusterOf) {
          const key = String(cluster);
          let list = byCluster.get(key);
          if (!list) byCluster.set(key, (list = []));
          list.push(id);
        }
        hullInput = [...byCluster.entries()].map(([id, ids]) => ({ id, label: '', ids }));
      }
      resolveHullSlots();
      requestRender();
      return api;
    },

    /**
     * Draw a soft outline behind each group. `groups` is
     * `[{id, label, ids:string[]}]` -- the view owns the grouping, because it
     * is the one that knows which nodes are actually on screen.
     */
    setHulls(groups) {
      clusterOf = null;
      hullInput = Array.isArray(groups) ? groups.filter((g) => g && Array.isArray(g.ids)) : [];
      resolveHullSlots();
      requestRender();
      return api;
    },

    /** Mark one group as the one being looked at, or null for none. */
    setActiveHull(id) {
      activeHullId = id === undefined ? null : id;
      requestRender();
      return api;
    },

    /**
     * Focus mode: with a node selected, dim everything more than `depth` hops
     * away. 0 or null turns it off. Nothing is hidden -- the surrounding graph
     * stays visible, just quiet.
     */
    setFocusDepth(depth) {
      const next = Number.isFinite(depth) ? clamp(Math.round(depth), 0, 8) : 0;
      if (next === focusDepth) return api;
      focusDepth = next;
      markMaskDirty();
      requestRender();
      return api;
    },

    /** `true`, `false` or `'auto'` (shown only when the graph is big enough). */
    setMinimap(value) {
      mapEnabled = value === true || value === false ? value : 'auto';
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

    /**
     * Run the simulation forward without drawing, so the first frame the user
     * sees is already laid out. Without this the view frames the seed spiral,
     * the graph then expands out of the viewport over the next three seconds,
     * and the very first impression of the map is of something running away.
     *
     * Bounded by a time budget as well as by a tick count: on a big graph a
     * fixed number of ticks would block the main thread for a visible moment,
     * and a hitch on load is worse than a slightly looser layout.
     */
    prewarm(ticks, budgetMs) {
      const steps = clamp(Math.round(Number(ticks) || 0), 0, 600);
      if (!n || !steps) return api;
      const budget = clamp(Number(budgetMs) || 120, 10, 400);
      const until = performance.now() + budget;
      if (alpha <= opts.alphaMin) alpha = 0.9;
      for (let i = 0; i < steps; i++) {
        if (alpha <= opts.alphaMin) break;
        tick();
        if (performance.now() >= until) break;
      }
      gridDirty = true;
      hullDirty = true;
      requestRender();
      return api;
    },

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
        // Rolling averages of the last frames, in milliseconds. Real numbers
        // from the real loop -- the only honest way to answer "is it fast?".
        frameMs,
        tickMs,
        drawMs,
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
      if (ratioMedia && typeof ratioMedia.removeEventListener === 'function') {
        ratioMedia.removeEventListener('change', onRatioChange);
      }
      ratioMedia = null;
      pointers.clear();
      labelWidths.clear();
      hullInput = [];
      hullGroups = [];
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
  // A canvas that starts at zero size makes `resize()` return early, so the
  // pixel-ratio watch is armed here too rather than only on the first real
  // measurement.
  watchPixelRatio();
  readPalette();
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') hiddenPause = true;

  return api;
}

export default createGraphCanvas;
