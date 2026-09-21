'use strict';

/**
 * Text extraction from opaque file bytes -- every parser hand-written.
 *
 * Why not a library: document parsers are precisely the npm packages that ship
 * postinstall scripts and "anonymous" telemetry, and this project's promise is
 * that no third-party code ever sees the user's files. The genuinely hard part
 * (DEFLATE) is in node:zlib; everything above it is container format work.
 *
 * Three rules this module never breaks:
 *  1. It never invents text. A scanned PDF yields kind 'pdf-image', an empty
 *     string and a warning -- never a plausible-looking guess. A format we
 *     cannot read throws a typed error instead of returning something.
 *  2. It never trusts a declared size. Every inflate is capped, so a zip bomb
 *     costs bounded memory and ends in a ValidationError, not in a dead process.
 *  3. It never trusts the file name. sniffKind() reads the bytes, so a .docx
 *     renamed to .txt is still parsed as a docx.
 *
 * Public API:
 *   extractText(buffer, {name, mime, maxBytes}) -> {text, kind, pages?, truncated, warnings[]}
 *   sniffKind(buffer, name) -> format id from magic bytes
 */

const zlib = require('node:zlib');
const { ValidationError } = require('../kernel/errors');

/* ------------------------------------------------------------ limits */

/** Produced text, in UTF-8 bytes. Beyond this the result is marked truncated. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
/** A file larger than this is refused outright rather than paged into memory. */
const MAX_INPUT_BYTES = 256 * 1024 * 1024;
/** Total bytes any one archive may inflate to, across all entries it reads. */
const DEFAULT_MAX_UNPACKED = 64 * 1024 * 1024;
/** Central-directory entries we are willing to walk. */
const MAX_ZIP_ENTRIES = 8192;
/** Wall-clock ceiling: a pathological file degrades to "truncated", never to a hang. */
const DEFAULT_TIME_BUDGET_MS = 15000;
const MAX_PDF_PAGES = 5000;
const MAX_PDF_OBJECTS = 200000;
/** PDF form XObjects can reference each other; bound the recursion. */
const MAX_FORM_DEPTH = 6;
/** Nesting depth for PDF dictionaries/arrays and XML-ish structures. */
const MAX_PARSE_DEPTH = 64;

/** Kinds extractText can produce text for. Anything else is refused honestly. */
const KINDS = [
  'empty', 'text', 'html', 'xml', 'rtf', 'pdf', 'pdf-image',
  'docx', 'xlsx', 'pptx', 'epub', 'odt', 'ods', 'odp',
  'zip', 'image', 'gzip', 'legacy-office', 'binary',
];

/* ------------------------------------------------------------- basics */

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  return null;
}

/**
 * Collects output under a hard byte budget.
 *
 * The budget is counted in UTF-8 bytes rather than characters because that is
 * what the caller stores and indexes; a result that says `truncated:false`
 * really did fit.
 */
class Sink {
  constructor(maxBytes) {
    this.max = Math.max(0, maxBytes);
    this.parts = [];
    this.bytes = 0;
    this.truncated = false;
  }

  get full() {
    return this.bytes >= this.max;
  }

  push(str) {
    if (!str || this.full) {
      if (str) this.truncated = true;
      return;
    }
    const len = Buffer.byteLength(str, 'utf8');
    if (this.bytes + len <= this.max) {
      this.parts.push(str);
      this.bytes += len;
      return;
    }
    // Cut on a character boundary: a half-written surrogate would be a lie
    // about the content, and would poison the search index downstream.
    const room = this.max - this.bytes;
    const cut = Buffer.from(str, 'utf8').subarray(0, room).toString('utf8').replace(/�$/, '');
    if (cut) {
      this.parts.push(cut);
      this.bytes += Buffer.byteLength(cut, 'utf8');
    }
    this.bytes = this.max;
    this.truncated = true;
  }

  toString() {
    return this.parts.join('');
  }
}

/**
 * Whitespace-normalising writer shared by every markup-ish extractor.
 *
 * Breaks, tabs and spaces are *pending* until real text arrives. That single
 * decision removes the usual pile of trailing-whitespace cleanup: an empty
 * paragraph produces nothing, a trailing table cell produces no trailing tab,
 * and a document never starts with blank lines.
 */
function createWriter(sink) {
  let breaks = 0;
  let tab = false;
  let space = false;
  let started = false;

  function flushPending() {
    if (!started) { breaks = 0; space = false; return; } // never emit leading whitespace
    if (breaks > 0) {
      sink.push('\n'.repeat(Math.min(breaks, 2)));
      breaks = 0;
      space = false;
    }
    if (tab) { sink.push('\t'); tab = false; space = false; }
    if (space) { sink.push(' '); space = false; }
  }

  return {
    /** Append text, collapsing internal whitespace runs to a single space. */
    word(value) {
      if (value === null || value === undefined) return;
      const s = String(value);
      if (!s) return;
      const parts = s.split(/[\s ​]+/);
      for (let i = 0; i < parts.length; i++) {
        if (!parts[i]) {
          // Leading/trailing whitespace of this chunk: remember a separator.
          if (started) space = true;
          continue;
        }
        if (i > 0) space = true;
        flushPending();
        sink.push(parts[i]);
        started = true;
      }
    },
    /** Verbatim text (already-formatted rows); no whitespace collapsing. */
    raw(value) {
      if (!value) return;
      flushPending();
      sink.push(String(value));
      started = true;
    },
    space() {
      if (started) space = true;
    },
    tab() {
      if (started) { tab = true; space = false; }
    },
    br(n = 1) {
      if (!started) return;
      breaks = Math.max(breaks, Math.min(n, 2));
      tab = false;
      space = false;
    },
    get hasText() { return started; },
  };
}

/** Shared per-call state: output budget, warnings, wall-clock deadline. */
function createContext(opts) {
  const sink = new Sink(Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES);
  const deadline = Date.now() + (Number.isFinite(opts.timeBudgetMs) && opts.timeBudgetMs >= 0
    ? opts.timeBudgetMs
    : DEFAULT_TIME_BUDGET_MS);
  const warnings = [];
  return {
    sink,
    warnings,
    unpackBudget: Number.isFinite(opts.maxUnpackedBytes) && opts.maxUnpackedBytes > 0
      ? opts.maxUnpackedBytes
      : DEFAULT_MAX_UNPACKED,
    warn(message) {
      if (!warnings.includes(message)) warnings.push(message);
    },
    /** True once the time budget is spent; callers stop and mark truncated. */
    expired() {
      if (Date.now() < deadline) return false;
      if (!sink.truncated) {
        sink.truncated = true;
        this.warn('Die Datei ist zu aufwendig zu lesen; die Auswertung wurde nach dem Zeitlimit abgebrochen. Der Text ist unvollständig.');
      }
      return true;
    },
    /**
     * The single stop condition for every loop and every scanner: the output
     * budget is spent, or the time budget is. Checking the clock costs about
     * as much as the work between two checks, so it is checked often.
     */
    done() {
      return this.sink.full || this.expired();
    },
  };
}

/* ----------------------------------------------------------- encoding */

/**
 * Windows-1252 differs from Latin-1 only in 0x80-0x9F, but that block carries
 * the typographic quotes and dashes real documents are full of. The same table
 * serves the text fallback, RTF \'hh escapes and PDF WinAnsiEncoding.
 */
const CP1252_HIGH = [
  '€', '\u0081', '‚', 'ƒ', '„', '…', '†', '‡',
  'ˆ', '‰', 'Š', '‹', 'Œ', '\u008d', 'Ž', '\u008f',
  '\u0090', '‘', '’', '“', '”', '•', '–', '—',
  '˜', '™', 'š', '›', 'œ', '\u009d', 'ž', 'Ÿ',
];

function cp1252Char(byte) {
  if (byte >= 0x80 && byte <= 0x9f) return CP1252_HIGH[byte - 0x80];
  return String.fromCharCode(byte);
}

function decodeCp1252(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i++) out += cp1252Char(buf[i]);
  return out;
}

function decodeUtf32(buf, littleEndian) {
  let out = '';
  for (let i = 0; i + 3 < buf.length; i += 4) {
    const cp = littleEndian ? buf.readUInt32LE(i) : buf.readUInt32BE(i);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) { out += '�'; continue; }
    out += String.fromCodePoint(cp);
  }
  return out;
}

/** Heuristic UTF-16 detection for BOM-less files: NULs land on a fixed parity. */
function looksLikeUtf16(buf) {
  const n = Math.min(buf.length, 4096);
  if (n < 4) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i++) {
    if (buf[i] !== 0) continue;
    if (i % 2 === 0) evenZero++; else oddZero++;
  }
  const half = n / 2;
  if (oddZero > half * 0.3 && evenZero < half * 0.05) return 'utf16le';
  if (evenZero > half * 0.3 && oddZero < half * 0.05) return 'utf16be';
  return null;
}

function swap16(buf) {
  const out = Buffer.from(buf);
  if (out.length % 2 === 1) return out.subarray(0, out.length - 1).swap16();
  return out.swap16();
}

/**
 * Decode bytes to a string, honestly reporting what had to be guessed.
 * BOM wins; then a UTF-16 parity heuristic; then strict UTF-8; then CP1252.
 */
function decodeText(buf, ctx) {
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0x00 && buf[3] === 0x00) {
    ctx.warn('Die Datei ist UTF-32 (LE) kodiert; sie wurde zeichenweise umgewandelt.');
    return decodeUtf32(buf.subarray(4), true);
  }
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0xfe && buf[3] === 0xff) {
    ctx.warn('Die Datei ist UTF-32 (BE) kodiert; sie wurde zeichenweise umgewandelt.');
    return decodeUtf32(buf.subarray(4), false);
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return decodeUtf8(buf.subarray(3), ctx);
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return swap16(buf.subarray(2)).toString('utf16le');
  }
  const guessed = looksLikeUtf16(buf);
  if (guessed === 'utf16le') {
    ctx.warn('Die Datei hat keine Kodierungs-Kennung; sie wurde als UTF-16 (LE) gelesen.');
    return buf.toString('utf16le');
  }
  if (guessed === 'utf16be') {
    ctx.warn('Die Datei hat keine Kodierungs-Kennung; sie wurde als UTF-16 (BE) gelesen.');
    return swap16(buf).toString('utf16le');
  }
  return decodeUtf8(buf, ctx);
}

function decodeUtf8(buf, ctx) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // Not valid UTF-8. Windows-1252 is the overwhelmingly likely alternative
    // for European text and, unlike a lossy UTF-8 decode, it loses nothing.
    ctx.warn('Die Datei ist nicht UTF-8; sie wurde als Latin-1/Windows-1252 gelesen. Einzelne Sonderzeichen können falsch sein.');
    return decodeCp1252(buf);
  }
}

/* ----------------------------------------------------------- entities */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '­',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  aacute: 'á', agrave: 'à', acirc: 'â', aring: 'å', atilde: 'ã', aelig: 'æ',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', iacute: 'í', igrave: 'ì',
  icirc: 'î', iuml: 'ï', ntilde: 'ñ', oacute: 'ó', ograve: 'ò', ocirc: 'ô',
  otilde: 'õ', oslash: 'ø', uacute: 'ú', ugrave: 'ù', ucirc: 'û', yacute: 'ý',
  ccedilla: 'ç', ccedil: 'ç', Eacute: 'É', Egrave: 'È', Aacute: 'Á', Ccedil: 'Ç',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', micro: 'µ', para: '¶',
  sect: '§', middot: '·', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“',
  rdquo: '”', lsquo: '‘', rsquo: '’', sbquo: '‚', ndash: '–', mdash: '—',
  hellip: '…', bull: '•', dagger: '†', Dagger: '‡', permil: '‰', prime: '′',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤', times: '×',
  divide: '÷', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³',
  iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º', not: '¬', macr: '¯',
  acute: '´', cedil: '¸', uml: '¨', brvbar: '¦', ensp: ' ',
  emsp: ' ', thinsp: ' ', zwnj: '', zwj: '', lrm: '', rlm: '',
  larr: '←', rarr: '→', harr: '↔', darr: '↓', uarr: '↑', infin: '∞',
  ne: '≠', le: '≤', ge: '≥', minus: '−', alpha: 'α', beta: 'β', gamma: 'γ',
  pi: 'π', mu: 'µ', omega: 'ω', Omega: 'Ω', sum: '∑', radic: '√',
};

/** Decode XML/HTML entities. Unknown references are left verbatim, not dropped. */
function decodeEntities(text) {
  if (text.indexOf('&') < 0) return text;
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
    if (body[0] === '#') {
      const code = (body[1] === 'x' || body[1] === 'X')
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body];
    return match;
  });
}

/* ------------------------------------------------------------- markup */

/**
 * One tiny scanner drives every XML-ish format here (HTML, XHTML, OOXML, ODF,
 * OPF). It is deliberately not a validating parser: real documents are full of
 * unclosed tags and stray '<', and an extractor that throws on those is useless.
 * Anything it cannot make sense of is skipped, never emitted as text.
 *
 * @param {string} src
 * @param {{open?:Function, close?:Function, text?:Function}} handlers
 *        open(name, local, rawAttrs, selfClosing), close(name, local), text(decoded)
 */
function scanMarkup(src, handlers) {
  const onOpen = handlers.open || null;
  const onClose = handlers.close || null;
  const onText = handlers.text || null;
  const stop = handlers.stop || null;
  const n = src.length;
  let i = 0;
  let ticks = 0;

  while (i < n) {
    // Abort a pathological document instead of scanning it to the bitter end.
    if (stop && (++ticks & 0xff) === 0 && stop()) break;
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      if (onText && i < n) onText(decodeEntities(src.slice(i)));
      break;
    }
    if (onText && lt > i) onText(decodeEntities(src.slice(i, lt)));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      // CDATA is literal text, entities and all -- that is the whole point of it.
      if (onText) onText(src.slice(lt + 9, end < 0 ? n : end));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const close = src.startsWith('<?', lt) ? src.indexOf('?>', lt) : -1;
      if (close >= 0) { i = close + 2; continue; }
      const end = src.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }

    const isClose = src[lt + 1] === '/';
    const start = lt + (isClose ? 2 : 1);
    if (start >= n || !/[A-Za-z_]/.test(src[start])) {
      // A bare '<' in running text. Emit it rather than swallowing content.
      if (onText) onText('<');
      i = lt + 1;
      continue;
    }
    let j = start;
    let quote = '';
    while (j < n) {
      const c = src[j];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    if (j >= n) break; // truncated tag: whatever follows is unreadable
    const body = src.slice(start, j);
    const nameEnd = body.search(/[\s/>]/);
    const name = nameEnd < 0 ? body : body.slice(0, nameEnd);
    const local = localName(name);
    if (isClose) {
      if (onClose) onClose(name, local);
    } else if (onOpen) {
      const raw = nameEnd < 0 ? '' : body.slice(nameEnd);
      onOpen(name, local, raw, /\/\s*$/.test(body));
    }
    i = j + 1;
  }
}

/** `w:t` -> `t`. Namespace prefixes vary by producer; the local name does not. */
function localName(name) {
  const colon = name.indexOf(':');
  const bare = colon < 0 ? name : name.slice(colon + 1);
  return bare.toLowerCase();
}

/** Read one attribute out of a raw tag body. Case-insensitive fallback for HTML. */
function attrOf(raw, want) {
  if (!raw) return null;
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  let loose = null;
  while ((m = re.exec(raw))) {
    const value = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
    if (m[1] === want) return decodeEntities(value);
    if (loose === null && m[1].toLowerCase() === want.toLowerCase()) loose = decodeEntities(value);
  }
  return loose;
}

/** HTML elements whose *content* is code or graphics, never readable text. */
const HTML_SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'math']);
/** Closing these ends a paragraph. */
const HTML_PARA = new Set([
  'p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table', 'form',
  'ul', 'ol', 'dl', 'figure', 'figcaption', 'address', 'fieldset', 'details',
  'title', 'tbody', 'thead', 'tfoot',
]);
/** Closing these ends a line. */
const HTML_LINE = new Set(['li', 'tr', 'dt', 'dd', 'caption', 'option', 'legend', 'summary', 'label']);

/**
 * HTML/XHTML/XML to plain text.
 *
 * For HTML the block structure becomes line structure; for generic XML every
 * element boundary becomes one, which keeps records readable without inventing
 * a schema we do not know.
 */
function markupToText(src, ctx, { html }) {
  const w = createWriter(ctx.sink);
  const skipStack = [];

  scanMarkup(src, {
    open(name, local, raw, selfClosing) {
      if (html && HTML_SKIP.has(local) && !selfClosing) { skipStack.push(local); return; }
      if (skipStack.length) return;
      if (!html) return;
      if (local === 'br') w.br(1);
      else if (local === 'hr') w.br(2);
      else if (local === 'li') w.br(1);
      else if (local === 'img') {
        const alt = attrOf(raw, 'alt');
        if (alt) w.word(alt);
      }
    },
    close(name, local) {
      if (skipStack.length) {
        const top = skipStack[skipStack.length - 1];
        if (top === local) skipStack.pop();
        return;
      }
      if (!html) { w.br(1); return; }
      if (local === 'td' || local === 'th') w.tab();
      else if (HTML_LINE.has(local)) w.br(1);
      else if (HTML_PARA.has(local)) w.br(2);
    },
    stop: () => ctx.done(),
    text(value) {
      if (skipStack.length || ctx.done()) return;
      w.word(value);
    },
  });
  return w;
}

/* ---------------------------------------------------------------- rtf */

/** RTF destinations that hold machine data, not document text. */
const RTF_SKIP_DESTINATIONS = new Set([
  'fonttbl', 'filetbl', 'colortbl', 'stylesheet', 'listtable', 'listoverridetable',
  'revtbl', 'rsidtbl', 'generator', 'info', 'pict', 'object', 'objdata', 'result',
  'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'xmlnstbl',
  'mmathPr', 'nonesttables', 'header', 'headerl', 'headerr', 'headerf',
  'footer', 'footerl', 'footerr', 'footerf', 'panose', 'falt', 'wgrffmtfilter',
]);

const RTF_SYMBOLS = {
  emdash: '—', endash: '–', emspace: ' ', enspace: ' ', qmspace: ' ',
  bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”',
  chdate: '', chtime: '', chpgn: '',
};

/** Latin-1 decoded bytes carry raw 0x80-0x9F; RTF means Windows-1252 there. */
function fixCp1252(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    out += (code >= 0x80 && code <= 0x9f) ? CP1252_HIGH[code - 0x80] : str[i];
  }
  return out;
}

/**
 * RTF to plain text.
 *
 * RTF is a nest of groups with control words; the readable text is whatever is
 * left once the destinations holding fonts, colours, styles and embedded
 * objects are dropped. `\uN` wins over its ANSI fallback char, which is why the
 * `uc` skip count has to be tracked per group -- otherwise every non-ASCII
 * character shows up twice.
 */
function rtfToText(buf, ctx) {
  const src = buf.toString('latin1');
  const w = createWriter(ctx.sink);
  const stack = [];
  let state = { ignore: false, uc: 1 };
  let i = 0;
  const n = src.length;

  const skipFallback = (count) => {
    let left = count;
    while (left > 0 && i < n) {
      const c = src[i];
      if (c === '{' || c === '}') break;
      if (c === '\\') {
        const m = /^\\(?:[a-zA-Z]{1,32}-?\d{0,10} ?|'[0-9a-fA-F]{2}|.)/.exec(src.slice(i, i + 40));
        i += m ? m[0].length : 2;
      } else if (c === ' ' || c === '\r' || c === '\n') {
        i++;
        continue; // whitespace between fallback chars does not count
      } else {
        i++;
      }
      left--;
    }
  };

  while (i < n) {
    if ((i & 0x3fff) === 0 && ctx.done()) break;
    const c = src[i];

    if (c === '{') { stack.push(state); state = { ignore: state.ignore, uc: state.uc }; i++; continue; }
    if (c === '}') { state = stack.pop() || { ignore: false, uc: 1 }; i++; continue; }

    if (c === '\\') {
      const next = src[i + 1];
      if (next === '\\' || next === '{' || next === '}') { if (!state.ignore) w.word(next); i += 2; continue; }
      if (next === "'") {
        const byte = parseInt(src.substr(i + 2, 2), 16);
        if (!state.ignore && Number.isFinite(byte)) w.word(cp1252Char(byte));
        i += 4;
        continue;
      }
      if (next === '*') { state.ignore = true; i += 2; continue; }
      if (next === '~') { if (!state.ignore) w.word(' '); i += 2; continue; }
      if (next === '-') { i += 2; continue; } // optional hyphen: not text
      if (next === '_') { if (!state.ignore) w.word('-'); i += 2; continue; }
      if (next === '\n' || next === '\r') { w.br(1); i += 2; continue; }

      const m = /^\\([a-zA-Z]{1,32})(-?\d{1,10})?[ ]?/.exec(src.slice(i, i + 48));
      if (!m) { i += 2; continue; }
      const word = m[1];
      const param = m[2] === undefined ? null : parseInt(m[2], 10);
      i += m[0].length;

      if (word === 'bin' && Number.isFinite(param) && param > 0) { i += param; continue; }
      if (word === 'uc') { state.uc = Math.max(0, Math.min(param || 0, 32)); continue; }
      if (word === 'u') {
        let cp = param;
        if (Number.isFinite(cp)) {
          if (cp < 0) cp += 65536;
          if (cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) && !state.ignore) {
            w.word(String.fromCodePoint(cp));
          }
        }
        skipFallback(state.uc);
        continue;
      }
      if (RTF_SKIP_DESTINATIONS.has(word)) { state.ignore = true; continue; }
      if (state.ignore) continue;
      if (word === 'par' || word === 'line' || word === 'sect' || word === 'page'
        || word === 'row' || word === 'nestrow' || word === 'column') { w.br(1); continue; }
      if (word === 'tab' || word === 'cell' || word === 'nestcell') { w.tab(); continue; }
      if (Object.prototype.hasOwnProperty.call(RTF_SYMBOLS, word)) { w.word(RTF_SYMBOLS[word]); continue; }
      continue; // formatting control word: no text of its own
    }

    if (c === '\r' || c === '\n') { i++; continue; } // line breaks in the source are not content
    let j = i;
    while (j < n) {
      const ch = src[j];
      if (ch === '\\' || ch === '{' || ch === '}' || ch === '\r' || ch === '\n') break;
      j++;
    }
    if (!state.ignore) w.word(fixCp1252(src.slice(i, j)));
    i = j;
  }
  return w;
}

/* ---------------------------------------------------------------- zip */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function corrupt(detail) {
  return new ValidationError(`Die Datei ist beschädigt oder unvollständig und lässt sich nicht lesen (${detail}).`);
}

/**
 * The end-of-central-directory record is the only fixed point in a zip: it sits
 * at the end, behind a comment of unknown length, so it has to be searched for
 * backwards. A record whose comment length matches the remaining bytes exactly
 * is the real one; anything else is a coincidence inside file data.
 */
function findEocd(buf) {
  const lowest = Math.max(0, buf.length - 22 - 0xffff);
  let fallback = -1;
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    if (i + 22 + buf.readUInt16LE(i + 20) === buf.length) return i;
    if (fallback < 0) fallback = i;
  }
  return fallback;
}

function readZip64Tail(buf, eocd) {
  const locator = eocd - 20;
  if (locator < 0 || buf.readUInt32LE(locator) !== SIG_EOCD64_LOCATOR) return null;
  const at = Number(buf.readBigUInt64LE(locator + 8));
  if (!Number.isSafeInteger(at) || at < 0 || at + 56 > buf.length) return null;
  if (buf.readUInt32LE(at) !== SIG_EOCD64) return null;
  return {
    entries: Number(buf.readBigUInt64LE(at + 32)),
    offset: Number(buf.readBigUInt64LE(at + 48)),
  };
}

/** ZIP64 moves oversized sizes/offsets into extra field 0x0001, in a fixed order. */
function applyZip64Extra(entry, extra) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    if (p + 4 + size > extra.length) break;
    if (id === 0x0001) {
      let q = p + 4;
      if (entry.size === 0xffffffff && q + 8 <= p + 4 + size) { entry.size = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (entry.compressedSize === 0xffffffff && q + 8 <= p + 4 + size) { entry.compressedSize = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (entry.localOffset === 0xffffffff && q + 8 <= p + 4 + size) { entry.localOffset = Number(extra.readBigUInt64LE(q)); q += 8; }
      break;
    }
    p += 4 + size;
  }
}

/**
 * Minimal read-only zip reader over a buffer.
 *
 * It reads the central directory (never the local headers' sizes, which are
 * allowed to be zero in streamed archives) and inflates entries on demand, so
 * opening a 200 MB epub to answer "which format is this?" costs nothing.
 */
function openZip(buffer, ctx) {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw corrupt('das ZIP-Verzeichnis am Dateiende fehlt');

  let count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    const tail = readZip64Tail(buffer, eocd);
    if (!tail) throw corrupt('ZIP64-Verzeichnis nicht lesbar');
    count = tail.entries;
    offset = tail.offset;
  }
  if (offset < 0 || offset >= buffer.length) throw corrupt('ungültiger Verzeichnis-Zeiger');

  const entries = new Map();
  const names = [];
  let p = offset;
  const limit = Math.min(count, MAX_ZIP_ENTRIES);
  for (let k = 0; k < limit; k++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== SIG_CENTRAL) break;
    const flags = buffer.readUInt16LE(p + 8);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    if (p + 46 + nameLen + extraLen + commentLen > buffer.length) break;
    const rawName = buffer.subarray(p + 46, p + 46 + nameLen);
    const entry = {
      // Bit 11 promises UTF-8; without it the spec says CP437, and for the
      // ASCII paths inside office documents latin1 is indistinguishable.
      name: (flags & 0x800) ? rawName.toString('utf8') : rawName.toString('latin1'),
      flags,
      method: buffer.readUInt16LE(p + 10),
      compressedSize: buffer.readUInt32LE(p + 20),
      size: buffer.readUInt32LE(p + 24),
      localOffset: buffer.readUInt32LE(p + 42),
    };
    if (entry.size === 0xffffffff || entry.compressedSize === 0xffffffff || entry.localOffset === 0xffffffff) {
      applyZip64Extra(entry, buffer.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen));
    }
    if (!entry.name.endsWith('/') && !entries.has(entry.name)) {
      entries.set(entry.name, entry);
      names.push(entry.name);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.size) throw corrupt('das Archiv enthält keine lesbaren Einträge');
  if (count > MAX_ZIP_ENTRIES && ctx) {
    ctx.warn(`Das Archiv enthält ${count} Einträge; nur die ersten ${MAX_ZIP_ENTRIES} wurden berücksichtigt.`);
  }

  function bytes(name, opts = {}) {
    const entry = entries.get(name);
    if (!entry) {
      if (opts.optional) return null;
      throw new ValidationError(`Im Dokument fehlt der Bestandteil "${name}"; es lässt sich nicht auslesen.`);
    }
    if (entry.flags & 0x0001) {
      throw new ValidationError('Das Dokument ist passwortgeschützt. Ohne das Passwort lässt sich kein Text auslesen.');
    }
    const lh = entry.localOffset;
    if (lh < 0 || lh + 30 > buffer.length || buffer.readUInt32LE(lh) !== SIG_LOCAL) {
      throw corrupt(`Eintrag "${name}" hat keinen gültigen Kopfsatz`);
    }
    const start = lh + 30 + buffer.readUInt16LE(lh + 26) + buffer.readUInt16LE(lh + 28);
    const end = start + entry.compressedSize;
    if (start > buffer.length || end > buffer.length) throw corrupt(`Eintrag "${name}" ist abgeschnitten`);
    const raw = buffer.subarray(start, end);

    // The cap is the remaining budget for the WHOLE archive, so neither one
    // huge entry nor a thousand medium ones can exhaust memory.
    const cap = Math.max(0, ctx ? ctx.unpackBudget : DEFAULT_MAX_UNPACKED);
    if (cap === 0) {
      if (opts.optional) return null;
      throw new ValidationError('Das Dokument entpackt sich auf mehr Daten als erlaubt; die Auswertung wurde abgebrochen.');
    }
    if (entry.size > cap) throw bombError(name, entry.size);

    let out;
    if (entry.method === 0) {
      out = Buffer.from(raw);
    } else if (entry.method === 8) {
      try {
        out = zlib.inflateRawSync(raw, { maxOutputLength: cap });
      } catch (err) {
        if (err && err.code === 'ERR_BUFFER_TOO_LARGE') throw bombError(name, null);
        throw corrupt(`Eintrag "${name}" liess sich nicht entpacken`);
      }
    } else {
      throw new ValidationError(`Der Eintrag "${name}" verwendet ein nicht unterstütztes Kompressionsverfahren (${entry.method}).`);
    }
    if (ctx) ctx.unpackBudget -= out.length;
    return out;
  }

  function text(name, opts = {}) {
    const buf = bytes(name, opts);
    if (!buf) return null;
    // XML parts are UTF-8 by contract; a BOM would otherwise land in the first tag.
    return buf.toString('utf8').replace(/^﻿/, '');
  }

  return {
    names,
    entries,
    has: (name) => entries.has(name),
    bytes,
    text,
    /** Entry names matching a predicate, in central-directory order. */
    filter: (fn) => names.filter(fn),
  };
}

function bombError(name, size) {
  const detail = size ? ` (angekündigt: ${Math.round(size / 1048576)} MB)` : '';
  return new ValidationError(
    `Der Bestandteil "${name}" entpackt sich auf mehr Daten, als für eine Datei zulässig ist${detail}. `
    + 'Das ist typisch für eine "ZIP-Bombe"; die Datei wurde nicht weiter ausgewertet.',
  );
}

/** Resolve an href against a zip-internal directory, the way OPF/rels do. */
function zipResolve(base, href) {
  let clean = String(href || '').split('#')[0].split('?')[0];
  if (!clean) return '';
  // Hrefs are percent-encoded, but a malformed escape must not end the parse.
  try { clean = decodeURIComponent(clean); } catch { /* use it verbatim */ }
  if (clean.startsWith('/')) return clean.slice(1);
  const parts = (base ? base.split('/') : []).filter(Boolean);
  for (const part of clean.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/* -------------------------------------------------------------- ooxml */

/**
 * docx: the readable document is `word/document.xml`. Paragraphs (`w:p`) are
 * lines, table rows (`w:tr`) are lines and cells (`w:tc`) are tab-separated, so
 * a table survives extraction as something the search index can still match.
 * Only `w:t` carries text -- `w:delText` (tracked deletions) and `w:instrText`
 * (field codes) deliberately do not.
 */
function extractDocx(zip, ctx) {
  const xml = zip.text('word/document.xml');
  const w = createWriter(ctx.sink);
  let inText = 0;
  let inCell = 0;
  let skip = 0;

  scanMarkup(xml, {
    open(name, local, raw, selfClosing) {
      // mc:Fallback repeats mc:Choice for older readers; taking both would
      // duplicate the text of every drawing and text box in the document.
      if (local === 'fallback') { if (!selfClosing) skip++; return; }
      if (skip) return;
      if (local === 't') { if (!selfClosing) inText++; return; }
      if (local === 'tc') { if (!selfClosing) inCell++; return; }
      if (local === 'tab') w.tab();
      else if (local === 'br' || local === 'cr') w.br(1);
    },
    close(name, local) {
      if (local === 'fallback') { if (skip > 0) skip--; return; }
      if (skip) return;
      if (local === 't') { if (inText > 0) inText--; return; }
      // Inside a cell a paragraph is a soft separator: breaking the line here
      // would tear the row apart and lose the column alignment.
      if (local === 'p') { if (inCell > 0) w.space(); else w.br(1); }
      else if (local === 'tc') { if (inCell > 0) inCell--; w.tab(); }
      else if (local === 'tr') w.br(1);
      else if (local === 'tbl') w.br(2);
    },
    stop: () => ctx.done(),
    text(value) {
      if (!skip && inText > 0 && !ctx.done()) w.word(value);
    },
  });
  return { kind: 'docx' };
}

/** `<si>` entries of the shared string table, in index order. */
function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  let current = null;
  let inText = 0;
  let skip = 0;
  scanMarkup(xml, {
    open(name, local, raw, selfClosing) {
      // Phonetic hints (Japanese ruby) are duplicates of the same word.
      if (local === 'rph' || local === 'phoneticpr') { if (!selfClosing) skip++; return; }
      if (skip) return;
      if (local === 'si') current = [];
      else if (local === 't' && !selfClosing) inText++;
    },
    close(name, local) {
      if (local === 'rph' || local === 'phoneticpr') { if (skip > 0) skip--; return; }
      if (skip) return;
      if (local === 't') { if (inText > 0) inText--; }
      else if (local === 'si') { out.push(current ? current.join('') : ''); current = null; }
    },
    text(value) {
      if (!skip && inText > 0 && current) current.push(value);
    },
  });
  return out;
}

/** "B" -> 1. Returns -1 when the reference is missing or malformed. */
function columnIndex(ref) {
  if (!ref) return -1;
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i) & ~0x20; // fold case
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
    if (n > 16384) return -1; // beyond the format's own column limit
  }
  return n - 1;
}

/** Worksheet parts in workbook order, falling back to file-name order. */
function listWorksheets(zip, ctx) {
  const sheets = [];
  const rels = new Map();
  const relsXml = zip.text('xl/_rels/workbook.xml.rels', { optional: true });
  if (relsXml) {
    scanMarkup(relsXml, {
      open(name, local, raw) {
        if (local !== 'relationship') return;
        const id = attrOf(raw, 'Id');
        const target = attrOf(raw, 'Target');
        if (id && target) rels.set(id, zipResolve('xl', target));
      },
    });
  }
  const workbookXml = zip.text('xl/workbook.xml', { optional: true });
  if (workbookXml) {
    scanMarkup(workbookXml, {
      open(name, local, raw) {
        if (local !== 'sheet') return;
        const rid = attrOf(raw, 'r:id') || attrOf(raw, 'id');
        const path = rid ? rels.get(rid) : null;
        if (path && zip.has(path)) sheets.push({ name: attrOf(raw, 'name') || path, path });
      },
    });
  }
  if (sheets.length) return sheets;

  const found = zip.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  if (found.length && ctx) ctx.warn('Die Arbeitsmappe nennt ihre Blätter nicht; sie wurden in Dateireihenfolge gelesen.');
  return found.map((path, i) => ({ name: `Blatt ${i + 1}`, path }));
}

/**
 * xlsx: one TSV block per worksheet, preceded by the sheet name.
 *
 * Column gaps are preserved (an empty cell stays an empty column), because a
 * spreadsheet read as a stream of values loses the association between a label
 * and the number next to it -- which is the only thing anyone searches for.
 * Dates stay raw serial numbers: converting them needs the number format, and
 * guessing would be worse than leaving the source value visible.
 */
function extractXlsx(zip, ctx) {
  const shared = parseSharedStrings(zip.text('xl/sharedStrings.xml', { optional: true }));
  const sheets = listWorksheets(zip, ctx);
  if (!sheets.length) throw new ValidationError('Die Arbeitsmappe enthält keine lesbaren Tabellenblätter.');
  const w = createWriter(ctx.sink);

  for (const sheet of sheets) {
    if (ctx.done()) break;
    w.br(2);
    w.word(sheet.name);
    w.br(1);

    const xml = zip.text(sheet.path, { optional: true });
    if (!xml) { ctx.warn(`Das Tabellenblatt "${sheet.name}" fehlt im Dokument.`); continue; }

    let cells = [];
    let cursor = 0;
    let cell = null;
    let inValue = 0;
    let inInline = 0;
    let value = [];

    scanMarkup(xml, {
      open(name, local, raw, selfClosing) {
        if (local === 'row') { cells = []; cursor = 0; return; }
        if (local === 'c') {
          const at = columnIndex(attrOf(raw, 'r'));
          cell = { col: at >= 0 ? at : cursor, type: attrOf(raw, 't') || 'n' };
          value = [];
          if (selfClosing) { cursor = cell.col + 1; cell = null; }
          return;
        }
        if (!cell) return;
        if (local === 'v' && !selfClosing) inValue++;
        else if (local === 'is') inInline++;
        else if (local === 't' && inInline > 0 && !selfClosing) inValue++;
      },
      close(name, local) {
        if (local === 'v' || (local === 't' && inInline > 0)) { if (inValue > 0) inValue--; return; }
        if (local === 'is') { if (inInline > 0) inInline--; return; }
        if (local === 'c') {
          if (cell) {
            const text = formatCell(cell.type, value.join(''), shared);
            if (text) cells[cell.col] = text;
            cursor = cell.col + 1;
            cell = null;
          }
          return;
        }
        if (local === 'row') {
          if (ctx.done()) { cells = []; return; }
          const line = rowToTsv(cells);
          if (line) { w.raw(line); w.br(1); }
          cells = [];
        }
      },
      stop: () => ctx.done(),
      text(chunk) {
        if (inValue > 0) value.push(chunk);
      },
    });
  }
  return { kind: 'xlsx', pages: sheets.length };
}

function formatCell(type, raw, shared) {
  if (raw === '') return '';
  if (type === 's') {
    const idx = Number(raw);
    return Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx] : '';
  }
  if (type === 'b') return raw === '1' ? 'WAHR' : 'FALSCH';
  return raw;
}

function rowToTsv(cells) {
  let last = -1;
  for (let i = 0; i < cells.length; i++) if (cells[i]) last = i;
  if (last < 0) return '';
  const out = [];
  for (let i = 0; i <= last; i++) out.push((cells[i] || '').replace(/[\t\r\n]+/g, ' '));
  return out.join('\t');
}

/**
 * pptx: one block per slide, numbered, in slide order. The number matters --
 * "on which slide did we say that" is the question people actually ask.
 */
function extractPptx(zip, ctx) {
  const slides = zip.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .map((path) => ({ path, no: Number(path.match(/slide(\d+)\.xml$/)[1]) }))
    .sort((a, b) => a.no - b.no);
  if (!slides.length) throw new ValidationError('Die Präsentation enthält keine lesbaren Folien.');
  const w = createWriter(ctx.sink);

  for (const slide of slides) {
    if (ctx.done()) break;
    w.br(2);
    w.word(`Folie ${slide.no}`);
    w.br(1);
    const xml = zip.text(slide.path, { optional: true });
    if (!xml) continue;
    let inText = 0;
    let skip = 0;
    scanMarkup(xml, {
      open(name, local, raw, selfClosing) {
        if (local === 'fallback') { if (!selfClosing) skip++; return; }
        if (skip) return;
        if (local === 't' && !selfClosing) inText++;
        else if (local === 'br') w.br(1);
      },
      close(name, local) {
        if (local === 'fallback') { if (skip > 0) skip--; return; }
        if (skip) return;
        if (local === 't') { if (inText > 0) inText--; }
        else if (local === 'p') w.br(1);
        else if (local === 'txbody') w.br(1); // one line per shape
      },
      stop: () => ctx.done(),
      text(value) {
        if (!skip && inText > 0 && !ctx.done()) w.word(value);
      },
    });
  }
  return { kind: 'pptx', pages: slides.length };
}

/* ------------------------------------------------------------ odf/epub */

/** ODF containers that hold style or binary data rather than document text. */
const ODF_SKIP = new Set(['automatic-styles', 'font-face-decls', 'binary-data', 'scripts', 'forms', 'styles']);

/**
 * odt/ods/odp: `content.xml`. Paragraphs and headings are lines, table rows are
 * lines with tab-separated cells -- the same shape as the OOXML extractors, so
 * a spreadsheet reads the same whether it came from Excel or LibreOffice.
 */
function extractOdf(zip, ctx, kind) {
  assertNotDrm(zip);
  const xml = zip.text('content.xml');
  const w = createWriter(ctx.sink);
  let skip = 0;
  let inCell = 0;
  let tables = 0;

  scanMarkup(xml, {
    open(name, local, raw, selfClosing) {
      if (ODF_SKIP.has(local)) { if (!selfClosing) skip++; return; }
      if (skip) return;
      if (local === 'table') {
        tables++;
        // In a spreadsheet the table IS the sheet, and its name is the label
        // everything below it belongs to -- same shape as the xlsx output.
        if (kind === 'ods') {
          const label = attrOf(raw, 'table:name') || attrOf(raw, 'name');
          if (label) { w.br(2); w.word(label); w.br(1); }
        }
        return;
      }
      if (local === 'table-cell') { if (!selfClosing) inCell++; return; }
      if (local === 'tab') w.tab();
      else if (local === 'line-break') w.br(1);
      else if (local === 's') {
        const count = Number(attrOf(raw, 'text:c') || attrOf(raw, 'c') || 1);
        if (Number.isFinite(count) && count > 0) w.space();
      }
    },
    close(name, local) {
      if (ODF_SKIP.has(local)) { if (skip > 0) skip--; return; }
      if (skip) return;
      if (local === 'p' || local === 'h' || local === 'list-item') {
        if (inCell > 0) w.space(); else w.br(1);
      } else if (local === 'table-cell') { if (inCell > 0) inCell--; w.tab(); }
      else if (local === 'table-row') w.br(1);
      else if (local === 'table') w.br(2);
    },
    stop: () => ctx.done(),
    text(value) {
      if (!skip && !ctx.done()) w.word(value);
    },
  });
  return kind === 'ods' ? { kind, pages: tables } : { kind };
}

/**
 * A document whose parts are encrypted (epub DRM, ODF password protection)
 * decompresses into noise. Detecting that is the difference between an honest
 * error and a note full of garbage characters in the user's vault.
 */
function assertNotDrm(zip) {
  if (zip.has('META-INF/encryption.xml')) {
    throw new ValidationError('Dieses E-Book ist kopiergeschützt (DRM). Sein Text lässt sich nicht auslesen.');
  }
  const manifest = zip.has('META-INF/manifest.xml') ? zip.text('META-INF/manifest.xml', { optional: true }) : null;
  if (manifest && manifest.includes('encryption-data')) {
    throw new ValidationError('Dieses Dokument ist mit einem Passwort verschlüsselt. '
      + 'Ohne das Passwort lässt sich kein Text auslesen; entferne den Schutz im Ursprungsprogramm.');
  }
}

/**
 * epub: follow `META-INF/container.xml` to the OPF, then read the spine in
 * reading order. Falling back to alphabetical file order would scramble the
 * chapters of any book whose files are not conveniently named.
 */
function extractEpub(zip, ctx) {
  assertNotDrm(zip);
  const containerXml = zip.text('META-INF/container.xml', { optional: true });
  let opfPath = null;
  if (containerXml) {
    scanMarkup(containerXml, {
      open(name, local, raw) {
        if (local === 'rootfile' && !opfPath) opfPath = zipResolve('', attrOf(raw, 'full-path') || '');
      },
    });
  }

  let documents = [];
  if (opfPath && zip.has(opfPath)) {
    const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
    const manifest = new Map();
    const spine = [];
    scanMarkup(zip.text(opfPath), {
      open(name, local, raw) {
        if (local === 'item') {
          const id = attrOf(raw, 'id');
          const href = attrOf(raw, 'href');
          if (id && href) manifest.set(id, { path: zipResolve(base, href), media: attrOf(raw, 'media-type') || '' });
        } else if (local === 'itemref') {
          const idref = attrOf(raw, 'idref');
          if (idref) spine.push(idref);
        }
      },
    });
    documents = spine
      .map((id) => manifest.get(id))
      .filter((item) => item && zip.has(item.path) && /html|xml/i.test(item.media || 'html'))
      .map((item) => item.path);
  }

  if (!documents.length) {
    documents = zip.filter((n) => /\.x?html?$/i.test(n)).sort();
    if (documents.length) ctx.warn('Das E-Book nennt keine Lesereihenfolge; die Kapitel wurden in Dateireihenfolge gelesen.');
  }
  if (!documents.length) throw new ValidationError('Das E-Book enthält keine lesbaren Kapitel.');

  let read = 0;
  for (const path of documents) {
    if (ctx.done()) break;
    const xml = zip.text(path, { optional: true });
    if (!xml) continue;
    markupToText(xml, ctx, { html: true });
    ctx.sink.push('\n\n');
    read++;
  }
  return { kind: 'epub', pages: read };
}

/* ---------------------------------------------------------------- pdf */

/**
 * PDF object model.
 *
 * A PDF is a heap of numbered objects plus a cross-reference table pointing at
 * them. We deliberately ignore the xref: in damaged files it is the first thing
 * to go, while the `N G obj ... endobj` markers survive, and scanning for those
 * costs one linear pass. The whole file is held as a latin1 string so that
 * string offsets and byte offsets are the same number -- every stream is still
 * sliced out of the original Buffer, so binary data is never round-tripped.
 */
class PName {
  constructor(name) { this.name = name; }
}
class PRef {
  constructor(num, gen) { this.num = num; this.gen = gen; }
}
class PStr {
  constructor(bytes) { this.bytes = bytes; }
}

/** Raw stream bytes hang off the stream's own dictionary. */
const STREAM = Symbol('pdf.stream');

const IS_WS = new Uint8Array(256);
for (const code of [0, 9, 10, 12, 13, 32]) IS_WS[code] = 1;
const IS_DELIM = new Uint8Array(256);
for (const ch of '()<>[]{}/%') IS_DELIM[ch.charCodeAt(0)] = 1;

function skipWs(src, i) {
  while (i < src.length) {
    const code = src.charCodeAt(i);
    if (IS_WS[code]) { i++; continue; }
    if (code === 37) { // '%' comment runs to the end of the line
      while (i < src.length && src.charCodeAt(i) !== 10 && src.charCodeAt(i) !== 13) i++;
      continue;
    }
    return i;
  }
  return i;
}

function isRegular(code) {
  return !IS_WS[code] && !IS_DELIM[code];
}

function parseName(src, i) {
  let j = i;
  while (j < src.length && isRegular(src.charCodeAt(j))) j++;
  let name = src.slice(i, j);
  if (name.indexOf('#') >= 0) {
    name = name.replace(/#([0-9a-fA-F]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return { value: new PName(name), next: j };
}

function parseLiteralString(src, i) {
  const bytes = [];
  let depth = 1;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      const e = src[j + 1];
      j += 2;
      if (e === 'n') bytes.push(10);
      else if (e === 'r') bytes.push(13);
      else if (e === 't') bytes.push(9);
      else if (e === 'b') bytes.push(8);
      else if (e === 'f') bytes.push(12);
      else if (e === '\n') { /* line continuation */ }
      else if (e === '\r') { if (src[j] === '\n') j++; }
      else if (e >= '0' && e <= '7') {
        let oct = e;
        while (oct.length < 3 && src[j] >= '0' && src[j] <= '7') { oct += src[j]; j++; }
        bytes.push(parseInt(oct, 8) & 0xff);
      } else if (e !== undefined) bytes.push(e.charCodeAt(0) & 0xff);
      continue;
    }
    if (c === '(') { depth++; bytes.push(40); j++; continue; }
    if (c === ')') {
      depth--;
      j++;
      if (depth === 0) break;
      bytes.push(41);
      continue;
    }
    bytes.push(src.charCodeAt(j) & 0xff);
    j++;
  }
  return { value: new PStr(Buffer.from(bytes)), next: j };
}

function parseHexString(src, i) {
  const bytes = [];
  let half = -1;
  let j = i;
  while (j < src.length && src[j] !== '>') {
    const code = src.charCodeAt(j);
    let digit = -1;
    if (code >= 48 && code <= 57) digit = code - 48;
    else if (code >= 97 && code <= 102) digit = code - 87;
    else if (code >= 65 && code <= 70) digit = code - 55;
    if (digit >= 0) {
      if (half < 0) half = digit;
      else { bytes.push((half << 4) | digit); half = -1; }
    }
    j++;
  }
  if (half >= 0) bytes.push(half << 4); // odd digit count: spec says pad with 0
  return { value: new PStr(Buffer.from(bytes)), next: j + 1 };
}

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

function parseObject(src, i, depth = 0) {
  i = skipWs(src, i);
  if (i >= src.length) return { value: null, next: i };
  if (depth > MAX_PARSE_DEPTH) {
    throw new ValidationError('Die PDF-Datei ist zu tief verschachtelt und wurde als fehlerhaft abgelehnt.');
  }
  const c = src[i];
  if (c === '/') return parseName(src, i + 1);
  if (c === '(') return parseLiteralString(src, i + 1);
  if (c === '<') {
    if (src[i + 1] === '<') return parseDict(src, i + 2, depth);
    return parseHexString(src, i + 1);
  }
  if (c === '[') {
    const arr = [];
    let j = i + 1;
    for (;;) {
      j = skipWs(src, j);
      if (j >= src.length) break;
      if (src[j] === ']') { j++; break; }
      const item = parseObject(src, j, depth + 1);
      if (item.next <= j) { j++; continue; }
      j = item.next;
      if (item.value !== undefined && arr.length < 65536) arr.push(item.value);
    }
    return { value: arr, next: j };
  }
  if (c === ']' || c === '>' || c === ')' || c === '}' || c === '{') return { value: undefined, next: i + 1 };

  let j = i;
  while (j < src.length && isRegular(src.charCodeAt(j))) j++;
  const token = src.slice(i, j);
  if (!token) return { value: undefined, next: i + 1 };
  if (token === 'true') return { value: true, next: j };
  if (token === 'false') return { value: false, next: j };
  if (token === 'null') return { value: null, next: j };
  if (NUMBER_RE.test(token)) {
    const num = Number(token);
    if (Number.isInteger(num) && num >= 0) {
      // "12 0 R" is a reference; "12 0" followed by anything else is two numbers.
      const afterNum = skipWs(src, j);
      let k = afterNum;
      while (k < src.length && src.charCodeAt(k) >= 48 && src.charCodeAt(k) <= 57) k++;
      if (k > afterNum) {
        const afterGen = skipWs(src, k);
        if (src[afterGen] === 'R' && (afterGen + 1 >= src.length || !isRegular(src.charCodeAt(afterGen + 1)))) {
          return { value: new PRef(num, Number(src.slice(afterNum, k))), next: afterGen + 1 };
        }
      }
    }
    return { value: num, next: j };
  }
  return { value: undefined, next: j, keyword: token };
}

function parseDict(src, i, depth) {
  const dict = Object.create(null);
  let j = i;
  for (;;) {
    j = skipWs(src, j);
    if (j >= src.length) break;
    if (src[j] === '>' && src[j + 1] === '>') { j += 2; break; }
    if (src[j] !== '/') {
      const junk = parseObject(src, j, depth + 1);
      j = junk.next > j ? junk.next : j + 1;
      continue;
    }
    const key = parseName(src, j + 1);
    j = key.next;
    const val = parseObject(src, j, depth + 1);
    if (val.next <= j) { j++; continue; }
    j = val.next;
    if (val.value !== undefined) dict[key.value.name] = val.value;
  }
  return { value: dict, next: j };
}

function isDict(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && !(value instanceof PName) && !(value instanceof PRef) && !(value instanceof PStr);
}

/** Follow indirect references; a reference cycle stops at the guard, not in a loop. */
function resolve(doc, value) {
  let v = value;
  let guard = 0;
  while (v instanceof PRef && guard++ < 32) v = doc.objects.has(v.num) ? doc.objects.get(v.num) : null;
  return v;
}

function dictGet(doc, dict, key) {
  if (!isDict(dict)) return null;
  const value = dict[key];
  return value === undefined ? null : resolve(doc, value);
}

function nameOf(value) {
  return value instanceof PName ? value.name : null;
}

/**
 * Read one object's body: its value, and the raw bytes if it is a stream.
 * `/Length` is preferred but verified, because a wrong length is common in
 * hand-built and incrementally-updated files; `endstream` is the fallback.
 */
function readObjectBody(src, buffer, start) {
  let parsed;
  try {
    parsed = parseObject(src, start);
  } catch {
    return { value: null, end: start };
  }
  let j = skipWs(src, parsed.next);
  if (!src.startsWith('stream', j)) return { value: parsed.value, end: parsed.next };
  j += 6;
  if (src[j] === '\r') j++;
  if (src[j] === '\n') j++;
  const dataStart = j;
  let dataEnd = -1;
  const declared = isDict(parsed.value) && typeof parsed.value.Length === 'number' ? parsed.value.Length : -1;
  if (declared >= 0 && dataStart + declared <= src.length) {
    const after = skipWs(src, dataStart + declared);
    if (src.startsWith('endstream', after)) dataEnd = dataStart + declared;
  }
  if (dataEnd < 0) {
    const found = src.indexOf('endstream', dataStart);
    dataEnd = found < 0 ? src.length : found;
    if (src[dataEnd - 1] === '\n') dataEnd--;
    if (src[dataEnd - 1] === '\r') dataEnd--;
  }
  if (isDict(parsed.value)) parsed.value[STREAM] = buffer.subarray(dataStart, Math.max(dataStart, dataEnd));
  return { value: parsed.value, end: dataEnd + 9 };
}

function scanObjects(doc) {
  const { src, buffer } = doc;
  const re = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
  let match;
  let count = 0;
  while ((match = re.exec(src))) {
    if (++count > MAX_PDF_OBJECTS) break;
    const prev = match.index > 0 ? src[match.index - 1] : ' ';
    if ((prev >= '0' && prev <= '9') || prev === '.' || prev === '-') continue;
    const body = readObjectBody(src, buffer, match.index + match[0].length);
    doc.objects.set(Number(match[1]), body.value);
    // Never scan inside stream data: compressed bytes produce phantom objects.
    if (body.end > re.lastIndex) re.lastIndex = body.end;
  }
}

/* ------------------------------------------------------- pdf filters */

function inflatePdf(data, cap) {
  // Z_SYNC_FLUSH keeps whatever inflated before a truncated stream ran out,
  // which is the difference between "half a page" and "nothing" on damaged files.
  const opts = { maxOutputLength: cap, finishFlush: zlib.constants.Z_SYNC_FLUSH };
  try { return zlib.inflateSync(data, opts); } catch { /* try raw */ }
  try { return zlib.inflateRawSync(data, opts); } catch { /* try skipping junk */ }
  let k = 0;
  while (k < data.length && IS_WS[data[k]]) k++;
  if (k > 0 && k < data.length) {
    try { return zlib.inflateSync(data.subarray(k), opts); } catch { /* give up */ }
  }
  return null;
}

function asciiHexDecode(data) {
  const out = [];
  let half = -1;
  for (let i = 0; i < data.length; i++) {
    const code = data[i];
    if (code === 0x3e) break; // '>'
    let digit = -1;
    if (code >= 48 && code <= 57) digit = code - 48;
    else if (code >= 97 && code <= 102) digit = code - 87;
    else if (code >= 65 && code <= 70) digit = code - 55;
    if (digit < 0) continue;
    if (half < 0) half = digit;
    else { out.push((half << 4) | digit); half = -1; }
  }
  if (half >= 0) out.push(half << 4);
  return Buffer.from(out);
}

function ascii85Decode(data) {
  const out = [];
  let tuple = 0;
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    const code = data[i];
    if (IS_WS[code]) continue;
    if (code === 0x7e) break; // '~>'
    if (code === 0x7a && count === 0) { out.push(0, 0, 0, 0); continue; } // 'z'
    if (code < 0x21 || code > 0x75) continue;
    tuple = tuple * 85 + (code - 0x21);
    if (++count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    for (let i = 0; i < count - 1; i++) out.push(bytes[i]);
  }
  return Buffer.from(out);
}

function runLengthDecode(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const len = data[i++];
    if (len === 128) break;
    if (len < 128) {
      for (let k = 0; k <= len && i < data.length; k++) out.push(data[i++]);
    } else {
      const byte = data[i++];
      for (let k = 0; k < 257 - len; k++) out.push(byte);
    }
  }
  return Buffer.from(out);
}

/** LZW as PDF uses it: 9..12 bit codes, `earlyChange` defaults to 1. */
function lzwDecode(data, earlyChange, cap) {
  const out = [];
  const dict = new Array(4096);
  for (let i = 0; i < 256; i++) dict[i] = [i];
  let dictLen = 258;
  let codeLen = 9;
  let prev = null;
  let bitBuf = 0;
  let bitLen = 0;
  let i = 0;
  for (;;) {
    while (bitLen < codeLen && i < data.length) { bitBuf = (bitBuf << 8) | data[i++]; bitLen += 8; }
    if (bitLen < codeLen) break;
    const code = (bitBuf >> (bitLen - codeLen)) & ((1 << codeLen) - 1);
    bitLen -= codeLen;
    if (code === 256) { dictLen = 258; codeLen = 9; prev = null; continue; }
    if (code === 257) break;
    let entry;
    if (code < dictLen && dict[code]) entry = dict[code];
    else if (prev) entry = prev.concat(prev[0]);
    else break;
    for (let k = 0; k < entry.length; k++) out.push(entry[k]);
    if (out.length > cap) throw new ValidationError('Ein Datenstrom in der PDF-Datei entpackt sich unverhältnismäßig stark; die Auswertung wurde abgebrochen.');
    if (prev && dictLen < 4096) dict[dictLen++] = prev.concat(entry[0]);
    prev = entry;
    if (dictLen + earlyChange >= (1 << codeLen) && codeLen < 12) codeLen++;
  }
  return Buffer.from(out);
}

/** Undo PNG/TIFF predictors (used by object and xref streams). */
function undoPredictor(data, predictor, colors, bpc, columns) {
  if (predictor < 2) return data;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    if (bpc !== 8) return data; // sub-byte TIFF prediction is not worth the code
    const out = Buffer.from(data);
    for (let r = 0; r + rowLen <= out.length; r += rowLen) {
      for (let k = bpp; k < rowLen; k++) out[r + k] = (out[r + k] + out[r + k - bpp]) & 0xff;
    }
    return out;
  }
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const row = Buffer.from(data.subarray(r * (rowLen + 1) + 1, r * (rowLen + 1) + 1 + rowLen));
    for (let k = 0; k < rowLen; k++) {
      const left = k >= bpp ? row[k - bpp] : 0;
      const up = prev[k];
      const upLeft = k >= bpp ? prev[k - bpp] : 0;
      switch (type) {
        case 1: row[k] = (row[k] + left) & 0xff; break;
        case 2: row[k] = (row[k] + up) & 0xff; break;
        case 3: row[k] = (row[k] + ((left + up) >> 1)) & 0xff; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          row[k] = (row[k] + (pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft))) & 0xff;
          break;
        }
        default: break;
      }
    }
    row.copy(out, r * rowLen);
    prev = row;
  }
  return out;
}

const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode']);

/**
 * Decode a stream through its filter chain.
 * Returns `{data}` for anything readable, `{image:true}` for pixel data (which
 * is what makes a scanned page detectable rather than silently empty).
 */
function decodeStream(doc, dict) {
  const raw = isDict(dict) ? dict[STREAM] : null;
  if (!raw) return { data: null };
  let data = raw;
  const filterValue = dictGet(doc, dict, 'Filter');
  const filters = filterValue === null ? [] : (Array.isArray(filterValue) ? filterValue : [filterValue]);
  const parmsValue = dictGet(doc, dict, 'DecodeParms') || dictGet(doc, dict, 'DP');
  const parms = Array.isArray(parmsValue) ? parmsValue : [parmsValue];
  const cap = Math.max(1, doc.ctx.unpackBudget);

  for (let i = 0; i < filters.length; i++) {
    const name = nameOf(resolve(doc, filters[i]));
    if (!name) continue;
    if (IMAGE_FILTERS.has(name)) return { image: true };
    if (name === 'FlateDecode' || name === 'Fl') {
      data = inflatePdf(data, cap);
      if (!data) return { data: null, failed: true };
    } else if (name === 'LZWDecode' || name === 'LZW') {
      const parm = resolve(doc, parms[i]);
      const early = isDict(parm) && typeof parm.EarlyChange === 'number' ? parm.EarlyChange : 1;
      data = lzwDecode(data, early, cap);
    } else if (name === 'ASCIIHexDecode' || name === 'AHx') {
      data = asciiHexDecode(data);
    } else if (name === 'ASCII85Decode' || name === 'A85') {
      data = ascii85Decode(data);
    } else if (name === 'RunLengthDecode' || name === 'RL') {
      data = runLengthDecode(data);
    } else if (name === 'Crypt') {
      continue;
    } else {
      return { data: null, failed: true, filter: name };
    }
    const parm = resolve(doc, parms[i]);
    if (isDict(parm) && typeof parm.Predictor === 'number' && parm.Predictor > 1 && data) {
      data = undoPredictor(
        data,
        parm.Predictor,
        typeof parm.Colors === 'number' ? parm.Colors : 1,
        typeof parm.BitsPerComponent === 'number' ? parm.BitsPerComponent : 8,
        typeof parm.Columns === 'number' ? parm.Columns : 1,
      );
    }
    if (data && data.length > cap) {
      throw new ValidationError('Ein Datenstrom in der PDF-Datei ist größer als zulässig; die Auswertung wurde abgebrochen.');
    }
  }
  if (data && data !== raw) doc.ctx.unpackBudget -= data.length;
  return { data };
}

/**
 * Modern PDFs hide the catalogue and page dictionaries inside compressed
 * object streams, so without this step a perfectly healthy file looks empty.
 */
function expandObjectStreams(doc) {
  const streams = [];
  for (const [num, value] of doc.objects) {
    if (isDict(value) && value[STREAM] && nameOf(value.Type) === 'ObjStm') streams.push([num, value]);
  }
  for (const [, dict] of streams) {
    if (doc.ctx.done()) return;
    let decoded;
    try { decoded = decodeStream(doc, dict); } catch { continue; }
    if (!decoded.data) continue;
    const inner = decoded.data.toString('latin1');
    const n = typeof dictGet(doc, dict, 'N') === 'number' ? dictGet(doc, dict, 'N') : 0;
    const first = typeof dictGet(doc, dict, 'First') === 'number' ? dictGet(doc, dict, 'First') : 0;
    const header = inner.slice(0, first).trim().split(/\s+/);
    for (let k = 0; k < n && k * 2 + 1 < header.length; k++) {
      const num = Number(header[k * 2]);
      const at = Number(header[k * 2 + 1]);
      if (!Number.isInteger(num) || !Number.isInteger(at)) continue;
      if (doc.objects.has(num) && doc.objects.get(num) !== null) continue; // a direct object wins
      try {
        const parsed = parseObject(inner, first + at);
        if (parsed.value !== undefined) doc.objects.set(num, parsed.value);
      } catch { /* one unreadable member does not sink the stream */ }
    }
  }
}

/* --------------------------------------------------------- pdf glyphs */

/**
 * WinAnsiEncoding as a list of glyph names, indexed by character code.
 *
 * It earns its keep twice: it is the default encoding for simple fonts, and it
 * is the source of the glyph-name table that `/Differences` entries resolve
 * against -- so one list replaces the usual two hard-coded tables.
 */
const WINANSI_NAMES = (
  '32 space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright '
  + 'asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon '
  + 'semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z '
  + 'bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p '
  + 'q r s t u v w x y z braceleft bar braceright asciitilde '
  + '128 Euro .notdef quotesinglbase florin quotedblbase ellipsis dagger daggerdbl circumflex '
  + 'perthousand Scaron guilsinglleft OE .notdef Zcaron .notdef .notdef quoteleft quoteright '
  + 'quotedblleft quotedblright bullet endash emdash tilde trademark scaron guilsinglright oe '
  + '.notdef zcaron Ydieresis '
  + '160 .notdef exclamdown cent sterling currency yen brokenbar section dieresis copyright '
  + 'ordfeminine guillemotleft logicalnot sfthyphen registered macron degree plusminus twosuperior '
  + 'threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright '
  + 'onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring '
  + 'AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde '
  + 'Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis '
  + 'Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave '
  + 'eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute '
  + 'ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn '
  + 'ydieresis'
).split(/\s+/).reduce((acc, token) => {
  if (/^\d+$/.test(token)) { acc.at = Number(token); return acc; }
  acc.names[acc.at++] = token;
  return acc;
}, { names: new Array(256).fill('.notdef'), at: 0 }).names;

const MACROMAN_HIGH = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø'
  + '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

/** Glyph name -> character. Built from WinAnsi, plus the names it lacks. */
const GLYPH_TO_CHAR = (() => {
  const map = Object.create(null);
  for (let code = 32; code < 256; code++) {
    const name = WINANSI_NAMES[code];
    if (name && name !== '.notdef' && !(name in map)) map[name] = cp1252Char(code);
  }
  Object.assign(map, {
    fi: 'ﬁ', fl: 'ﬂ', ff: 'ﬀ', ffi: 'ﬃ', ffl: 'ﬄ', dotlessi: 'ı', dotlessj: 'ȷ',
    Delta: '∆', Omega: 'Ω', pi: 'π', minus: '−', fraction: '⁄', nbspace: ' ',
    Lslash: 'Ł', lslash: 'ł', Scedilla: 'Ş', scedilla: 'ş', Amacron: 'Ā', amacron: 'ā',
    Zdotaccent: 'Ż', zdotaccent: 'ż', Idotaccent: 'İ', napostrophe: 'ŉ',
    quotedblbase: '„', quotesinglbase: '‚', sfthyphen: '-', softhyphen: '-',
    middot: '·', bulletoperator: '∙', trademarkserif: '™',
  });
  return map;
})();

/**
 * Resolve a PostScript glyph name to text.
 * Returns '' for names we genuinely cannot map -- a subset font with names like
 * `g17` carries no information at all, and guessing would fabricate content.
 */
function glyphToChar(name) {
  if (!name) return '';
  if (Object.prototype.hasOwnProperty.call(GLYPH_TO_CHAR, name)) return GLYPH_TO_CHAR[name];
  let m = /^uni([0-9A-Fa-f]{4,})$/.exec(name);
  if (m) {
    let out = '';
    for (let i = 0; i + 4 <= m[1].length; i += 4) out += String.fromCharCode(parseInt(m[1].slice(i, i + 4), 16));
    return out;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) {
    const cp = parseInt(m[1], 16);
    if (cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) return String.fromCodePoint(cp);
  }
  if (name.length === 1) return name;
  const dot = name.indexOf('.');
  if (dot > 0) return glyphToChar(name.slice(0, dot));
  return '';
}

function utf16beHexToString(hex) {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  if (hex.length % 4 === 2) out += String.fromCharCode(parseInt(hex.slice(hex.length - 2), 16));
  return out;
}

/**
 * Parse a /ToUnicode CMap. This is the only encoding information that is
 * always authoritative, because the producer wrote it for exactly this purpose.
 */
function parseToUnicode(text) {
  const map = new Map();
  let twoByte = false;
  const space = /begincodespacerange([\s\S]*?)endcodespacerange/g;
  let m;
  while ((m = space.exec(text))) {
    const first = /<([0-9a-fA-F]+)>/.exec(m[1]);
    if (first && first[1].length >= 4) twoByte = true;
  }
  const chars = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = chars.exec(text))) {
    const pair = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g;
    let p;
    while ((p = pair.exec(m[1]))) {
      if (p[1].length >= 4) twoByte = true;
      map.set(parseInt(p[1], 16), utf16beHexToString(p[2]));
    }
  }
  const ranges = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = ranges.exec(text))) {
    const entry = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([\s\S]*?)\])/g;
    let e;
    while ((e = entry.exec(m[1]))) {
      const lo = parseInt(e[1], 16);
      const hi = parseInt(e[2], 16);
      if (e[1].length >= 4) twoByte = true;
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 65535) continue;
      if (e[3] !== undefined) {
        const base = utf16beHexToString(e[3]);
        for (let code = lo; code <= hi; code++) {
          if (!base) break;
          // Only the last code unit advances: that is what the spec defines.
          const head = base.slice(0, -1);
          const tail = base.charCodeAt(base.length - 1) + (code - lo);
          map.set(code, head + String.fromCharCode(tail & 0xffff));
        }
      } else if (e[4] !== undefined) {
        const items = e[4].match(/<([0-9a-fA-F]*)>/g) || [];
        for (let k = 0; k < items.length && lo + k <= hi; k++) {
          map.set(lo + k, utf16beHexToString(items[k].slice(1, -1)));
        }
      }
    }
  }
  return { map, twoByte };
}

/** Build the decoding table for one font resource. */
function buildFont(doc, dict) {
  const subtype = nameOf(dictGet(doc, dict, 'Subtype'));
  const font = {
    twoByte: subtype === 'Type0',
    toUnicode: null,
    differences: null,
    base: 'WinAnsiEncoding',
    unknown: 0,
    total: 0,
  };
  const toUni = dictGet(doc, dict, 'ToUnicode');
  if (isDict(toUni) && toUni[STREAM]) {
    try {
      const decoded = decodeStream(doc, toUni);
      if (decoded.data) {
        const parsed = parseToUnicode(decoded.data.toString('latin1'));
        font.toUnicode = parsed.map;
        if (parsed.twoByte) font.twoByte = true;
      }
    } catch { /* an unreadable CMap just means we fall back to the encoding */ }
  }
  const encoding = dictGet(doc, dict, 'Encoding');
  if (encoding instanceof PName) {
    font.base = encoding.name;
  } else if (isDict(encoding)) {
    const baseName = nameOf(dictGet(doc, encoding, 'BaseEncoding'));
    if (baseName) font.base = baseName;
    const diffs = dictGet(doc, encoding, 'Differences');
    if (Array.isArray(diffs)) {
      font.differences = new Map();
      let code = 0;
      for (const item of diffs) {
        const value = resolve(doc, item);
        if (typeof value === 'number') code = Math.trunc(value);
        else if (value instanceof PName && code >= 0 && code < 65536) font.differences.set(code++, value.name);
      }
    }
  }
  return font;
}

function encodedChar(font, code) {
  if (font.base === 'MacRomanEncoding') {
    if (code >= 0x80 && code <= 0xff) return MACROMAN_HIGH[code - 0x80] || '';
    return String.fromCharCode(code);
  }
  return cp1252Char(code);
}

/** Decode one PDF string with the current font's tables. */
function decodeShown(font, bytes) {
  let out = '';
  if (!font) {
    for (let i = 0; i < bytes.length; i++) out += cp1252Char(bytes[i]);
    return out;
  }
  if (font.twoByte) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      font.total++;
      const mapped = font.toUnicode ? font.toUnicode.get(code) : undefined;
      if (mapped !== undefined) out += mapped;
      else font.unknown++; // no table, no guess
    }
    return out;
  }
  for (let i = 0; i < bytes.length; i++) {
    const code = bytes[i];
    font.total++;
    const mapped = font.toUnicode ? font.toUnicode.get(code) : undefined;
    if (mapped !== undefined) { out += mapped; continue; }
    if (font.differences && font.differences.has(code)) {
      const glyph = glyphToChar(font.differences.get(code));
      if (glyph) out += glyph; else font.unknown++;
      continue;
    }
    out += encodedChar(font, code);
  }
  return out;
}

/* -------------------------------------------------------- pdf content */

const IDENTITY = [1, 0, 0, 1, 0, 0];

function matmul(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function numArg(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A TJ displacement this large (in 1/1000 em) is word spacing, not kerning.
 * Too low and justified text sprouts spaces inside words; too high and whole
 * sentences run together. 150 is the value that survives real-world documents.
 */
const TJ_SPACE_UNITS = 150;
/** Baseline shift that counts as a new line rather than a sub/superscript. */
const LINE_EPSILON = 0.6;

function fontFor(doc, resources, name) {
  if (!isDict(resources)) return null;
  let perResource = doc.resourceFonts.get(resources);
  if (!perResource) {
    perResource = new Map();
    doc.resourceFonts.set(resources, perResource);
  }
  if (perResource.has(name)) return perResource.get(name);
  const dict = dictGet(doc, dictGet(doc, resources, 'Font'), name);
  const font = isDict(dict) ? buildFont(doc, dict) : null;
  if (font) doc.fonts.add(font);
  perResource.set(name, font);
  return font;
}

/**
 * Interpret a content stream far enough to recover reading order.
 *
 * We do not lay out glyphs: without font metrics that is guesswork. What we do
 * track is the text matrix, because a change in baseline is the one reliable
 * signal for "new line", and TJ displacements, which are the only signal for
 * "word gap" in documents that draw spaces by moving the pen.
 */
function runContentStream(doc, data, resources, w, state, depth) {
  const src = data.toString('latin1');
  const ctx = doc.ctx;
  const stack = [];
  const n = src.length;
  let i = 0;

  const moved = () => {
    const x = state.tlm[4];
    const y = state.tlm[5];
    if (state.lastY !== null) {
      if (Math.abs(y - state.lastY) > LINE_EPSILON) w.br(1);
      else if (x > state.lastX + 0.1) w.space();
    }
    state.lastX = x;
    state.lastY = y;
  };
  const translate = (tx, ty) => {
    state.tlm = matmul([1, 0, 0, 1, tx, ty], state.tlm);
    state.tm = state.tlm.slice();
    moved();
  };
  const show = (value) => {
    if (!(value instanceof PStr)) return;
    const text = decodeShown(state.font, value.bytes);
    if (text) w.word(text);
  };

  while (i < n) {
    if (ctx.sink.full) break;
    if ((i & 0x1fff) === 0 && ctx.expired()) break;
    i = skipWs(src, i);
    if (i >= n) break;
    const code = src.charCodeAt(i);
    const c = src[i];
    if (c === '(' || c === '<' || c === '[' || c === '/' || c === '+' || c === '-' || c === '.'
      || (code >= 48 && code <= 57)) {
      let parsed;
      try { parsed = parseObject(src, i); } catch { break; }
      if (parsed.next <= i) { i++; continue; }
      i = parsed.next;
      if (parsed.value !== undefined) {
        stack.push(parsed.value);
        if (stack.length > 64) stack.shift();
      }
      continue;
    }
    if (IS_DELIM[code]) { i++; continue; }
    let j = i;
    while (j < n && isRegular(src.charCodeAt(j))) j++;
    if (j === i) { i++; continue; }
    const op = src.slice(i, j);
    i = j;
    const top = stack[stack.length - 1];

    switch (op) {
      case 'BT':
        state.tm = IDENTITY.slice();
        state.tlm = IDENTITY.slice();
        state.lastX = null;
        state.lastY = null;
        break;
      case 'ET':
        w.br(1);
        break;
      case 'Tf': {
        const name = stack[stack.length - 2];
        if (name instanceof PName) state.font = fontFor(doc, resources, name.name);
        state.fontSize = numArg(top) || state.fontSize;
        break;
      }
      case 'TL':
        state.leading = numArg(top);
        break;
      case 'Td':
        translate(numArg(stack[stack.length - 2]), numArg(top));
        break;
      case 'TD':
        state.leading = -numArg(top);
        translate(numArg(stack[stack.length - 2]), numArg(top));
        break;
      case 'Tm': {
        const m = stack.slice(-6).map(numArg);
        if (m.length === 6) {
          state.tlm = m;
          state.tm = m.slice();
          moved();
        }
        break;
      }
      case 'T*':
        translate(0, -state.leading);
        break;
      case 'Tj':
        show(top);
        break;
      case "'":
        translate(0, -state.leading);
        show(top);
        break;
      case '"':
        translate(0, -state.leading);
        show(top);
        break;
      case 'TJ': {
        if (Array.isArray(top)) {
          for (const item of top) {
            if (item instanceof PStr) show(item);
            else if (typeof item === 'number' && item <= -TJ_SPACE_UNITS) w.space();
          }
        }
        break;
      }
      case 'Do': {
        if (top instanceof PName) {
          const xobject = dictGet(doc, dictGet(doc, resources, 'XObject'), top.name);
          if (isDict(xobject)) {
            const subtype = nameOf(dictGet(doc, xobject, 'Subtype'));
            if (subtype === 'Image') state.hasImage = true;
            else if (depth < MAX_FORM_DEPTH && !state.forms.has(xobject)) {
              state.forms.add(xobject);
              let decoded = { data: null };
              try { decoded = decodeStream(doc, xobject); } catch { /* skip this form */ }
              if (decoded.image) state.hasImage = true;
              if (decoded.data) {
                const own = dictGet(doc, xobject, 'Resources');
                runContentStream(doc, decoded.data, isDict(own) ? own : resources, w, state, depth + 1);
              }
              state.forms.delete(xobject);
            }
          }
        }
        break;
      }
      case 'BI': {
        state.hasImage = true;
        const idAt = src.indexOf('ID', i);
        const from = idAt < 0 ? n : idAt + 2;
        const end = /\sEI(?=[\s\]/<(%]|$)/.exec(src.slice(from));
        i = end ? from + end.index + 3 : n;
        break;
      }
      default:
        break;
    }
    stack.length = 0;
  }
}

/* ---------------------------------------------------------- pdf pages */

function collectPages(doc) {
  let catalog = null;
  for (const value of doc.objects.values()) {
    if (isDict(value) && nameOf(value.Type) === 'Catalog') { catalog = value; break; }
  }
  const pages = [];
  const seen = new Set();

  const walk = (node, inherited, depth) => {
    if (!isDict(node) || depth > 32 || pages.length >= MAX_PDF_PAGES) return;
    const resources = node.Resources !== undefined ? resolve(doc, node.Resources) : inherited;
    const type = nameOf(node.Type);
    const kids = dictGet(doc, node, 'Kids');
    if (type === 'Page' || (type !== 'Pages' && !Array.isArray(kids) && node.Contents !== undefined)) {
      pages.push({ dict: node, resources });
      return;
    }
    if (!Array.isArray(kids)) return;
    for (const kid of kids) {
      if (kid instanceof PRef) {
        if (seen.has(kid.num)) continue;
        seen.add(kid.num);
      }
      walk(resolve(doc, kid), resources, depth + 1);
    }
  };

  if (catalog) walk(dictGet(doc, catalog, 'Pages'), null, 0);
  if (pages.length) return pages;

  // No usable page tree (damaged file or an unusual producer): fall back to
  // object order, which is the order pages are written in practice.
  for (const [, value] of [...doc.objects.entries()].sort((a, b) => a[0] - b[0])) {
    if (isDict(value) && nameOf(value.Type) === 'Page') {
      pages.push({ dict: value, resources: resolve(doc, value.Resources) });
      if (pages.length >= MAX_PDF_PAGES) break;
    }
  }
  return pages;
}

function pageContent(doc, page) {
  const contents = dictGet(doc, page.dict, 'Contents');
  const list = Array.isArray(contents) ? contents : [contents];
  const parts = [];
  for (const item of list.slice(0, 256)) {
    const dict = resolve(doc, item);
    if (!isDict(dict) || !dict[STREAM]) continue;
    let decoded;
    try { decoded = decodeStream(doc, dict); } catch { continue; }
    if (decoded.image) continue;
    if (decoded.data) parts.push(decoded.data);
    else if (decoded.failed) doc.failedStreams++;
  }
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : Buffer.concat(parts.flatMap((p) => [p, Buffer.from('\n')]));
}

/** An encrypted PDF is reported, never guessed at. */
function assertNotEncrypted(doc) {
  const ref = /\/Encrypt\s+(\d+)\s+(\d+)\s+R/.exec(doc.src);
  let encryptionDict = null;
  if (ref) {
    const candidate = doc.objects.get(Number(ref[1]));
    if (isDict(candidate) && (candidate.Filter !== undefined || candidate.V !== undefined || candidate.R !== undefined)) {
      encryptionDict = candidate;
    }
  }
  if (!encryptionDict) {
    const inline = /\/Encrypt\s*<<([\s\S]{0,600}?)>>/.exec(doc.src);
    if (inline && /\/Filter\b/.test(inline[1])) encryptionDict = true;
  }
  if (!encryptionDict) return;
  throw new ValidationError(
    'Diese PDF-Datei ist verschlüsselt (passwortgeschützt). Ihr Text lässt sich ohne das Passwort nicht auslesen. '
    + 'Entferne den Schutz im Ursprungsprogramm und lege die Datei erneut ab.',
  );
}

/**
 * PDF to text.
 *
 * Returns kind 'pdf-image' with an empty string when the pages hold only
 * pixels: that is the honest answer for a scan, and the warning says what would
 * be needed instead. It never returns approximated or reconstructed text.
 */
function extractPdf(buffer, ctx) {
  const doc = {
    buffer,
    src: buffer.toString('latin1'),
    ctx,
    objects: new Map(),
    resourceFonts: new Map(),
    fonts: new Set(),
    failedStreams: 0,
  };
  scanObjects(doc);
  if (!doc.objects.size) throw corrupt('die PDF-Datei enthält keine lesbaren Objekte');
  assertNotEncrypted(doc);
  expandObjectStreams(doc);

  const pages = collectPages(doc);
  const w = createWriter(ctx.sink);
  const state = {
    font: null,
    fontSize: 0,
    leading: 0,
    tm: IDENTITY.slice(),
    tlm: IDENTITY.slice(),
    lastX: null,
    lastY: null,
    hasImage: false,
    forms: new Set(),
  };

  for (const page of pages) {
    if (ctx.done()) break;
    const data = pageContent(doc, page);
    if (!data) continue;
    state.font = null;
    state.tm = IDENTITY.slice();
    state.tlm = IDENTITY.slice();
    state.lastX = null;
    state.lastY = null;
    runContentStream(doc, data, page.resources, w, state, 0);
    w.br(2);
  }

  // No page at all means the structure is gone -- saying "no text found" would
  // blame the document for what is really a damaged file.
  if (!pages.length) throw corrupt('die PDF-Datei enthält keine lesbaren Seiten');
  if (doc.failedStreams) {
    ctx.warn(`${doc.failedStreams} Datenströme der PDF-Datei liessen sich nicht entpacken; der Text kann unvollständig sein.`);
  }

  // A PDF always ends in %%EOF. Missing it means the file was cut short; when
  // nothing could be read that is the real diagnosis, not "contains no text".
  const lastEof = doc.src.lastIndexOf('%%EOF');
  if (lastEof < 0 || doc.src.length - lastEof > 4096) {
    if (!w.hasText) throw corrupt('die PDF-Datei endet unvollständig, das Dateiende (%%EOF) fehlt');
    ctx.warn('Die PDF-Datei ist unvollständig (das Dateiende fehlt); der Text kann unvollständig sein.');
  }

  let unknown = 0;
  let total = 0;
  for (const font of doc.fonts) { unknown += font.unknown; total += font.total; }
  if (total > 0 && unknown / total > 0.2) {
    ctx.warn('Ein Teil der Schriften in dieser PDF-Datei bringt keine Zeichentabelle mit; entsprechende Zeichen fehlen im Text.');
  }

  if (!w.hasText) {
    if (state.hasImage) {
      ctx.warn('Diese PDF-Datei enthält nur Bilder (vermutlich ein Scan). Sie enthält keinen auslesbaren Text — dafür wäre eine Texterkennung (OCR) nötig, die Neural OS nicht mitbringt.');
      return { kind: 'pdf-image', pages: pages.length };
    }
    // No glyphs and no pixels either: an empty or vector-only document. Saying
    // 'pdf-image' here would send the user to an OCR that has nothing to read.
    ctx.warn('In dieser PDF-Datei wurde kein auslesbarer Text gefunden.');
    return { kind: 'pdf', pages: pages.length };
  }
  return { kind: 'pdf', pages: pages.length };
}

/* ------------------------------------------------------------- sniffing */

const IMAGE_MAGIC = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF8
  [0x42, 0x4d], // BM
  [0x49, 0x49, 0x2a, 0x00], // TIFF LE
  [0x4d, 0x4d, 0x00, 0x2a], // TIFF BE
  [0x00, 0x00, 0x01, 0x00], // ICO
];

const BINARY_MAGIC = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x37, 0x7a, 0xbc, 0xaf], // 7z
  [0x52, 0x61, 0x72, 0x21], // Rar!
  [0x42, 0x5a, 0x68], // BZh
  [0xfd, 0x37, 0x7a, 0x58], // xz
  [0x4f, 0x67, 0x67, 0x53], // OggS
  [0x49, 0x44, 0x33], // ID3
  [0x66, 0x4c, 0x61, 0x43], // fLaC
  [0xca, 0xfe, 0xba, 0xbe], // java class / mach-o fat
  [0x1a, 0x45, 0xdf, 0xa3], // matroska
  [0x53, 0x51, 0x4c, 0x69], // SQLite
];

function startsWith(buf, magic, offset = 0) {
  if (buf.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (buf[offset + i] !== magic[i]) return false;
  return true;
}

/** Bytes that no text encoding produces: NULs (outside UTF-16) and C0 controls. */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return control / n > 0.05;
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml',
  'toml', 'ini', 'conf', 'cfg', 'log', 'sql', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py',
  'rb', 'go', 'rs', 'java', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh',
  'css', 'scss', 'less', 'lua', 'pl', 'r', 'swift', 'kt', 'dart', 'tex', 'bib', 'srt', 'vtt',
  'env', 'gitignore', 'diff', 'patch',
]);

const EXTENSION_KINDS = {
  pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx', epub: 'epub',
  odt: 'odt', ods: 'ods', odp: 'odp', rtf: 'rtf', zip: 'zip', gz: 'gzip', tgz: 'gzip',
  html: 'html', htm: 'html', xhtml: 'html', xml: 'xml', svg: 'xml',
  doc: 'legacy-office', xls: 'legacy-office', ppt: 'legacy-office',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', bmp: 'image',
  tif: 'image', tiff: 'image', webp: 'image', ico: 'image', heic: 'image',
};

function extensionOf(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Decode enough of the head to look for markup, whatever the encoding is. */
function textProbe(buf) {
  const slice = buf.subarray(0, 4096);
  const quiet = { warn() {} };
  try { return decodeText(slice, quiet); } catch { return slice.toString('latin1'); }
}

function zipKind(buf) {
  let zip;
  try { zip = openZip(buf, null); } catch { return 'zip'; }
  if (zip.has('word/document.xml')) return 'docx';
  if (zip.has('xl/workbook.xml') || zip.names.some((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) return 'xlsx';
  if (zip.has('ppt/presentation.xml') || zip.names.some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) return 'pptx';
  let mimetype = '';
  if (zip.has('mimetype')) {
    try { mimetype = (zip.text('mimetype') || '').trim(); } catch { mimetype = ''; }
  }
  if (mimetype === 'application/epub+zip' || zip.has('META-INF/container.xml')) return 'epub';
  if (mimetype.startsWith('application/vnd.oasis.opendocument.')) {
    const flavour = mimetype.slice('application/vnd.oasis.opendocument.'.length);
    if (flavour.startsWith('spreadsheet')) return 'ods';
    if (flavour.startsWith('presentation')) return 'odp';
    return 'odt';
  }
  if (zip.has('content.xml') && zip.has('styles.xml')) return 'odt';
  return 'zip';
}

/**
 * Identify a file by its content.
 *
 * The name is advisory only: it can tip the balance between "text with a few
 * odd control bytes" and "binary", and nothing else. Everything that has magic
 * bytes is decided by those bytes, so a .docx renamed to .txt still parses as a
 * docx, and an executable renamed to .txt is still refused.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {string} [name] file name, advisory
 * @returns {string} one of KINDS
 */
function sniffKind(buffer, name) {
  const buf = toBuffer(buffer);
  if (!buf || buf.length === 0) return 'empty';

  // Some producers prepend junk before the header; the spec tolerates a shift.
  if (buf.subarray(0, 1024).indexOf('%PDF-') >= 0) return 'pdf';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06])
    || startsWith(buf, [0x50, 0x4b, 0x07, 0x08])) return zipKind(buf);
  if (startsWith(buf, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return 'rtf'; // {\rtf
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'legacy-office';
  if (startsWith(buf, [0x1f, 0x8b])) return 'gzip';
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return 'image';
  for (const magic of IMAGE_MAGIC) if (startsWith(buf, magic)) return 'image';
  for (const magic of BINARY_MAGIC) if (startsWith(buf, magic)) return 'binary';

  const hasBom = startsWith(buf, [0xef, 0xbb, 0xbf]) || startsWith(buf, [0xff, 0xfe]) || startsWith(buf, [0xfe, 0xff]);
  if (!hasBom && !looksLikeUtf16(buf) && looksBinary(buf)) {
    // The name is the tie-breaker here and only here: a .csv with a stray 0x01
    // is still a csv, but an unnamed blob of control bytes is not text.
    if (!TEXT_EXTENSIONS.has(extensionOf(name))) return 'binary';
  }

  const probe = textProbe(buf).replace(/^\s+/, '');
  if (/^<\?xml[\s?]/i.test(probe) || /^<(?:!doctype|[a-z_][\w:.-]*)[\s/>]/i.test(probe)) {
    if (/^<!doctype\s+html/i.test(probe) || /<(?:html|body|head|div|span|p|br|table|h[1-6]|ul|ol|li|a|script|style|meta)[\s/>]/i.test(probe)) {
      return 'html';
    }
    return 'xml';
  }
  return 'text';
}

/* ------------------------------------------------------------- extract */

function unsupported(kind, name) {
  const what = name ? `"${name}"` : 'Diese Datei';
  const messages = {
    'legacy-office': `${what} ist ein Office-Dokument im alten Binärformat (.doc/.xls/.ppt von vor 2007). `
      + 'Neural OS kann daraus keinen Text lesen. Öffne es einmal in Word oder LibreOffice und speichere es als .docx, .xlsx oder .pptx.',
    image: `${what} ist eine Bilddatei. Sie enthält keinen maschinenlesbaren Text — dafür wäre eine `
      + 'Texterkennung (OCR) nötig, die Neural OS bewusst nicht mitbringt.',
    zip: `${what} ist ein gewöhnliches ZIP-Archiv und kein Dokument. Entpacke es und lege die einzelnen Dateien ab.`,
    gzip: `${what} ist ein gzip-Archiv. Entpacke es und lege die enthaltene Datei ab.`,
    binary: `${what} enthält keinen Text (erkannt an den ersten Bytes, nicht an der Dateiendung). `
      + 'Es wurde nichts ausgelesen, statt unbrauchbare Zeichen zu liefern.',
  };
  return new ValidationError(messages[kind] || `Das Format von ${what} wird nicht unterstützt.`);
}

/** Last pass over the assembled text: no control characters, no ragged edges. */
function finalise(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MIME_KINDS = {
  'application/pdf': 'pdf',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/xml': 'xml',
  'application/xml': 'xml',
  'image/svg+xml': 'xml',
  'application/epub+zip': 'epub',
  'application/zip': 'zip',
  'application/gzip': 'gzip',
  'application/msword': 'legacy-office',
  'application/vnd.ms-excel': 'legacy-office',
  'application/vnd.ms-powerpoint': 'legacy-office',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
};

function declaredKind(name, mime) {
  const byName = EXTENSION_KINDS[extensionOf(name)];
  if (byName) return byName;
  const type = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!type) return null;
  if (MIME_KINDS[type]) return MIME_KINDS[type];
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('text/')) return 'text';
  return null;
}

/** Warn when the file name or the declared type contradicts the real content. */
function noteMismatch(ctx, kind, name, mime) {
  const declared = declaredKind(name, mime);
  if (!declared || declared === kind) return;
  const textish = new Set(['text', 'html', 'xml']);
  if (textish.has(declared) && textish.has(kind)) return;
  if (declared === 'pdf' && kind === 'pdf-image') return;
  ctx.warn(`Die Datei ist als ${declared.toUpperCase()} gekennzeichnet, ihr Inhalt ist aber ${kind.toUpperCase()}. `
    + 'Gelesen wurde der tatsächliche Inhalt.');
}

/**
 * Extract readable text from a file's bytes.
 *
 * @param {Buffer|Uint8Array} buffer   the file content
 * @param {object} [options]
 * @param {string} [options.name]      file name, used for messages only
 * @param {string} [options.mime]      declared type, advisory only
 * @param {number} [options.maxBytes]  ceiling for the produced text (UTF-8 bytes)
 * @param {number} [options.maxUnpackedBytes] ceiling for everything decompressed
 * @param {number} [options.timeBudgetMs]     wall-clock ceiling for one file
 * @returns {{text:string, kind:string, pages?:number, truncated:boolean, warnings:string[]}}
 * @throws {ValidationError} for damaged, encrypted or unreadable formats
 */
function extractText(buffer, options = {}) {
  const buf = toBuffer(buffer);
  if (!buf) {
    throw new ValidationError('Zum Auslesen wird der Dateiinhalt als Buffer benötigt; es wurde nichts übergeben.');
  }
  if (buf.length > MAX_INPUT_BYTES) {
    throw new ValidationError(`Die Datei ist mit ${Math.round(buf.length / 1048576)} MB zu groß, um sie am Stück auszulesen `
      + `(Grenze: ${Math.round(MAX_INPUT_BYTES / 1048576)} MB).`);
  }
  const opts = options && typeof options === 'object' ? options : {};
  const name = typeof opts.name === 'string' ? opts.name : '';
  const ctx = createContext(opts);
  const kind = sniffKind(buf, name);

  if (kind === 'empty') {
    return { text: '', kind: 'empty', truncated: false, warnings: ['Die Datei ist leer.'] };
  }
  noteMismatch(ctx, kind, name, opts.mime);

  let result;
  switch (kind) {
    case 'text':
      ctx.sink.push(decodeText(buf, ctx));
      result = { kind: 'text' };
      break;
    case 'html':
    case 'xml':
      markupToText(decodeText(buf, ctx), ctx, { html: kind === 'html' });
      result = { kind };
      break;
    case 'rtf':
      rtfToText(buf, ctx);
      result = { kind: 'rtf' };
      break;
    case 'pdf':
      result = extractPdf(buf, ctx);
      break;
    case 'docx':
      result = extractDocx(openZip(buf, ctx), ctx);
      break;
    case 'xlsx':
      result = extractXlsx(openZip(buf, ctx), ctx);
      break;
    case 'pptx':
      result = extractPptx(openZip(buf, ctx), ctx);
      break;
    case 'epub':
      result = extractEpub(openZip(buf, ctx), ctx);
      break;
    case 'odt':
    case 'ods':
    case 'odp':
      result = extractOdf(openZip(buf, ctx), ctx, kind);
      break;
    case 'zip':
      // Distinguish a genuine archive from a damaged document: if the central
      // directory does not parse, openZip throws the honest "beschädigt" error.
      openZip(buf, ctx);
      throw unsupported(kind, name);
    default:
      throw unsupported(kind, name);
  }

  const text = finalise(ctx.sink.toString());
  if (ctx.sink.full) {
    ctx.warn('Die Datei ist länger als das eingestellte Limit; der Text wurde abgeschnitten.');
  }
  const out = {
    text,
    kind: result.kind,
    truncated: ctx.sink.truncated,
    warnings: ctx.warnings,
  };
  if (typeof result.pages === 'number') out.pages = result.pages;
  return out;
}

module.exports = {
  extractText,
  sniffKind,
  KINDS,
  DEFAULT_MAX_BYTES,
};
