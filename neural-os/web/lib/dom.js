/**
 * dom.js -- the whole "framework" of this interface.
 *
 * Why hand-rolled instead of a library: this app ships no bundler and no CDN,
 * so every dependency would have to live in the repository forever. The three
 * things a UI actually needs -- creating elements, keeping a list in sync with
 * an array, and removing listeners again -- fit in one readable file.
 *
 * The hard rule here: `innerHTML` is never used with data. Not once. `h()`
 * builds nodes, `text()` builds text nodes, and the only path that parses
 * markup is `icon()`, which takes a string authored in this repository, parses
 * it as XML (not HTML) and strips scripting before it touches the document.
 * That is what makes "the interface cannot be turned into an injection
 * vector by a note title" a structural property rather than a promise.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Tags that must be created in the SVG namespace to render at all. */
const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline',
  'polygon', 'defs', 'use', 'title', 'linearGradient', 'stop', 'clipPath',
]);

/**
 * Keys that must be assigned as DOM properties, not attributes: an attribute
 * only sets the *initial* value, so `value`/`checked` would silently stop
 * working after the first user interaction.
 */
const PROPERTY_KEYS = new Set(['value', 'checked', 'selected', 'indeterminate', 'disabled', 'open']);

/** Attribute aliases so JSX-ish habits do not produce dead attributes. */
const ATTRIBUTE_ALIASES = { htmlFor: 'for', className: 'class', xlinkHref: 'href' };

const selectorCache = new Map();

/** Parse `'div.card.is-open#main'` once and remember the result. */
function parseSelector(selector) {
  const cached = selectorCache.get(selector);
  if (cached) return cached;
  const match = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:[.#][A-Za-z0-9_-]+)*)$/.exec(selector);
  if (!match) throw new TypeError(`h(): unbrauchbarer Selektor "${selector}"`);
  const parsed = { tag: match[1] || 'div', classes: [], id: null };
  for (const token of (match[2] || '').split(/(?=[.#])/)) {
    if (!token) continue;
    if (token[0] === '.') parsed.classes.push(token.slice(1));
    else parsed.id = token.slice(1);
  }
  selectorCache.set(selector, parsed);
  return parsed;
}

function appendChild(parent, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (const entry of child) appendChild(parent, entry);
    return;
  }
  if (child instanceof Node) {
    parent.appendChild(child);
    return;
  }
  parent.appendChild(document.createTextNode(String(child)));
}

function applyProps(el, props) {
  for (const [rawKey, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    const key = ATTRIBUTE_ALIASES[rawKey] || rawKey;

    if (key === 'class') {
      for (const name of cx(value).split(/\s+/)) if (name) el.classList.add(name);
    } else if (key === 'style') {
      if (typeof value === 'string') el.setAttribute('style', value);
      else for (const [prop, v] of Object.entries(value)) {
        if (v === null || v === undefined) continue;
        if (prop.startsWith('--')) el.style.setProperty(prop, String(v));
        else el.style[prop] = String(v);
      }
    } else if (key === 'dataset') {
      for (const [prop, v] of Object.entries(value)) if (v !== null && v !== undefined) el.dataset[prop] = String(v);
    } else if (key === 'attrs') {
      for (const [prop, v] of Object.entries(value)) if (v !== null && v !== undefined) el.setAttribute(prop, String(v));
    } else if (key === 'ref') {
      if (typeof value === 'function') value(el);
    } else if (key === 'html' || key === 'innerHTML' || key === 'dangerouslySetInnerHTML') {
      // Refused on purpose, loudly, so nobody "just this once" ships an
      // injection point into a local-first app that holds private notes.
      throw new TypeError('h(): rohes HTML ist nicht erlaubt. Nutze h()/text() oder icon() für geprüftes SVG.');
    } else if (rawKey.length > 2 && rawKey.startsWith('on') && typeof value === 'function') {
      el.addEventListener(rawKey.slice(2).toLowerCase(), value);
    } else if (PROPERTY_KEYS.has(key)) {
      el[key] = value;
    } else if (value === true) {
      el.setAttribute(key, '');
    } else if (value === false) {
      el.removeAttribute(key);
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

/**
 * Create an element.
 *
 *   h('div.card', { role: 'group' }, h('h2', null, 'Titel'), text(note.title))
 *
 * @param {string} selector tag plus optional `.class` and `#id` parts
 * @param {object|null} [props]
 * @param {...any} children nodes, strings, numbers, arrays; null/false skipped
 * @returns {HTMLElement|SVGElement}
 */
export function h(selector, props, ...children) {
  const { tag, classes, id } = parseSelector(selector);
  const el = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  if (classes.length) el.setAttribute('class', classes.join(' '));
  if (id) el.id = id;
  if (props) applyProps(el, props);
  for (const child of children) appendChild(el, child);
  return el;
}

/** A text node. `null`/`undefined` become an empty string, never "null". */
export function text(value) {
  return document.createTextNode(value === null || value === undefined ? '' : String(value));
}

/** A document fragment holding the given children. */
export function frag(...children) {
  const f = document.createDocumentFragment();
  for (const child of children) appendChild(f, child);
  return f;
}

/** Append children to an existing node (same child rules as `h`). */
export function append(parent, ...children) {
  for (const child of children) appendChild(parent, child);
  return parent;
}

/** Empty a node and forget any keyed-list state attached to it. */
export function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  listState.delete(node);
  return node;
}

/**
 * Add a listener and get its removal back as a function. Views collect these
 * and call them in `unmount()`; a listener that outlives its view is the
 * classic way a single-page app starts leaking and double-firing.
 */
export function on(node, event, handler, opts) {
  node.addEventListener(event, handler, opts);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    node.removeEventListener(event, handler, opts);
  };
}

/** Join class names; accepts strings, arrays and `{name: condition}` objects. */
export function cx(...parts) {
  const out = [];
  for (const part of parts) {
    if (!part) continue;
    if (typeof part === 'string') out.push(part);
    else if (Array.isArray(part)) out.push(cx(...part));
    else if (typeof part === 'object') {
      for (const [name, cond] of Object.entries(part)) if (cond) out.push(name);
    }
  }
  return out.join(' ').trim();
}

const listState = new WeakMap();

/**
 * Keyed list reconciler.
 *
 * Keeps `container`'s children in step with `items` while preserving the DOM
 * node that belongs to a key. That matters for more than performance: a
 * re-created node loses focus, selection and scroll position, so a list that
 * re-renders while you type in it would eat your keystrokes.
 *
 * `renderFn(item, existingNode, index)` returns the node for the item. When it
 * is given an existing node it may update it in place and return it (or
 * return nothing, which means "kept as is").
 *
 * @returns {Node[]} the nodes in their final order
 */
export function list(container, items, keyFn, renderFn) {
  const previous = listState.get(container) || new Map();
  const next = new Map();
  const ordered = [];

  let index = 0;
  for (const item of items) {
    const key = String(keyFn(item, index));
    if (next.has(key)) throw new Error(`list(): doppelter Schlüssel "${key}" -- Schlüssel müssen eindeutig sein.`);
    const existing = previous.get(key);
    const node = (existing ? (renderFn(item, existing.node, index) || existing.node) : renderFn(item, null, index));
    if (!(node instanceof Node)) throw new TypeError('list(): renderFn muss einen DOM-Knoten liefern.');
    next.set(key, { node, item });
    ordered.push(node);
    index += 1;
  }

  for (const [key, entry] of previous) {
    if (!next.has(key) && entry.node.parentNode === container) container.removeChild(entry.node);
  }

  let cursor = container.firstChild;
  for (const node of ordered) {
    if (cursor === node) {
      cursor = cursor.nextSibling;
      continue;
    }
    container.insertBefore(node, cursor); // moves the node when it already exists
  }
  // Anything still trailing belonged to an older render pass.
  while (cursor) {
    const following = cursor.nextSibling;
    container.removeChild(cursor);
    cursor = following;
  }

  listState.set(container, next);
  return ordered;
}

/**
 * Turn an inline SVG string from this repository into a live node.
 *
 * Parsed as `image/svg+xml` rather than assigned to `innerHTML`: XML parsing
 * does not run scripts, does not execute event-handler attributes, and reports
 * malformed input instead of guessing. Scripting constructs are stripped
 * anyway, because "the string is ours" is an assumption that ages badly.
 *
 * @param {string} markup
 * @param {{class?:string, title?:string}} [opts]
 * @returns {SVGElement}
 */
export function icon(markup, opts = {}) {
  const source = String(markup || '').trim();
  const wrapped = source.startsWith('<svg')
    ? source
    : `<svg xmlns="${SVG_NS}" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${source}</svg>`;

  let node;
  try {
    const doc = new DOMParser().parseFromString(wrapped, 'image/svg+xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('parsererror');
    node = doc.documentElement;
  } catch {
    // A broken icon must never take a view down with it.
    node = document.createElementNS(SVG_NS, 'svg');
    node.setAttribute('viewBox', '0 0 20 20');
  }

  const imported = document.importNode(node, true);
  sanitiseSvg(imported);
  imported.setAttribute('aria-hidden', 'true');
  imported.setAttribute('focusable', 'false');
  if (!imported.getAttribute('width')) imported.setAttribute('width', '20');
  if (!imported.getAttribute('height')) imported.setAttribute('height', '20');
  if (opts.class) for (const name of opts.class.split(/\s+/)) if (name) imported.classList.add(name);
  if (opts.title) {
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = opts.title;
    imported.insertBefore(title, imported.firstChild);
    imported.removeAttribute('aria-hidden');
    imported.setAttribute('role', 'img');
  }
  return imported;
}

function sanitiseSvg(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const doomed = [];
  let node = root;
  while (node) {
    const name = node.nodeName.toLowerCase();
    if (name === 'script' || name === 'foreignobject' || name === 'iframe') doomed.push(node);
    else {
      for (const attr of [...node.attributes]) {
        const attrName = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (attrName.startsWith('on')) node.removeAttribute(attr.name);
        else if ((attrName === 'href' || attrName === 'xlink:href') && !value.startsWith('#')) node.removeAttribute(attr.name);
      }
    }
    node = walker.nextNode();
  }
  for (const el of doomed) el.remove();
}

/* ------------------------------------------------------------------ */
/* Shared presentation helpers.                                        */
/* They live here so that eight views do not grow eight slightly       */
/* different German date formats.                                      */
/* ------------------------------------------------------------------ */

/** "gerade eben" / "vor 4 Min." / "vor 3 Tagen" / a date for anything older. */
export function timeAgo(value, now = Date.now()) {
  const ts = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ts)) return '';
  const seconds = Math.round((now - ts) / 1000);
  if (seconds < 0) return formatDate(ts);
  if (seconds < 45) return 'gerade eben';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'gestern';
  if (days < 7) return `vor ${days} Tagen`;
  return formatDate(ts);
}

/** Short absolute date, e.g. "14. Mai 2026". */
export function formatDate(value, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  const ts = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ts)) return '';
  try {
    return new Intl.DateTimeFormat('de-DE', opts).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

/** Date plus time, for transcripts and audit rows. */
export function formatDateTime(value) {
  return formatDate(value, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Byte counts in the German convention (1,4 MB). */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '–';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString('de-DE', { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

/** Grouped number, e.g. 12.480. */
export function formatNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('de-DE') : '–';
}

/**
 * Render a search snippet. The search index marks hits with \u0001/\u0002
 * instead of HTML precisely so this layer can decide how to display them --
 * here: real `<mark>` elements built as nodes, never as a string.
 */
export function snippet(raw) {
  const fragment = document.createDocumentFragment();
  const source = String(raw || '');
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('\u0001', cursor);
    if (start === -1) break;
    const end = source.indexOf('\u0002', start + 1);
    if (end === -1) break;
    if (start > cursor) fragment.appendChild(text(source.slice(cursor, start)));
    const mark = document.createElement('mark');
    mark.appendChild(text(source.slice(start + 1, end)));
    fragment.appendChild(mark);
    cursor = end + 1;
  }
  if (cursor < source.length) fragment.appendChild(text(source.slice(cursor)));
  return fragment;
}

/** Trailing-edge debounce; returns the wrapped function with `.cancel()`. */
export function debounce(fn, ms = 180) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}
