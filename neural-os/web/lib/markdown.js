/**
 * markdown.js -- Markdown to a *DOM tree*, never to an HTML string.
 *
 * Why this file exists at all
 * --------------------------
 * Everything this application displays as Markdown comes from a source that
 * must be treated as hostile: a model's output, an imported file, a note that
 * an agent wrote. A renderer that produces an HTML string and hands it to
 * `innerHTML` turns every one of those into a scripting vector inside an app
 * that holds the user's private notes and can reach a local network. So this
 * renderer never produces markup: it produces nodes, via `h()`/`text()` from
 * dom.js, and the browser's HTML parser is never invoked on user content.
 *
 * The consequences, stated plainly because they are deliberate:
 *
 * - **Raw HTML in the input is shown as text.** `<script>`, `<img onerror>`,
 *   `<div>` -- all of it appears literally, exactly as written. There is no
 *   allow-list of "harmless" tags, because an allow-list is a promise that has
 *   to be re-verified against every browser quirk forever.
 * - **`javascript:`, `data:` and every other unknown scheme is refused** in
 *   links. The refusal is visible (the text stays, the link does not), so a
 *   blocked link cannot be mistaken for a rendering bug.
 * - **Remote images are not loaded.** The server's CSP (`img-src 'self' data:
 *   blob:`) would block them anyway, but a broken image icon says nothing; a
 *   labelled placeholder naming the host says what happened and why. It also
 *   means a note cannot phone home through a tracking pixel.
 * - **HTML entities are not decoded.** `&lt;` stays `&lt;`. Decoding is one of
 *   the classic ways a sanitiser and a parser end up disagreeing about what a
 *   string means; here there is only one reading.
 *
 * Syntax highlighting is a real tokeniser per language family (a small state
 * machine over characters), not a pile of regular expressions run across the
 * whole block. The difference matters: a regex for "string" does not know it
 * is inside a comment, so the usual result is a file that looks correct until
 * it does not -- and on a 2 000-line block, backtracking regexes are also how
 * a renderer becomes a freeze.
 *
 * Deliberate omissions (a parser that claims more than it does is worse than a
 * small one): setext headings, indented code blocks (ambiguous against list
 * continuation lines), footnotes, inline HTML, and nested emphasis edge cases
 * that CommonMark resolves with a delimiter stack. What is here is what the
 * app writes and what models emit.
 */

import { h, text, frag } from './dom.js';

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/** Schemes a link may use. Everything else is refused, including `data:`. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** Above this size a code block is rendered plain: highlighting it is not
 *  worth blocking the main thread of a local-first app for. */
const HIGHLIGHT_MAX_CHARS = 40000;

/** Hard ceiling on one document, so a pathological paste cannot hang the tab. */
const MAX_INPUT_CHARS = 2000000;

/** Nesting limit for quotes/lists; protects against hand-crafted input. */
const MAX_DEPTH = 12;

const STYLE_ID = 'nos-markdown-styles';

/* ------------------------------------------------------------------ */
/* URL safety                                                          */
/* ------------------------------------------------------------------ */

function baseHref() {
  if (typeof document !== 'undefined' && document.baseURI) return document.baseURI;
  if (typeof location !== 'undefined' && location.href) return location.href;
  return 'http://localhost/';
}

function sameOrigin(url) {
  try {
    return url.origin === new URL(baseHref()).origin;
  } catch {
    return false;
  }
}

/**
 * Decide whether a link destination may be used, and how it must be presented.
 *
 * Control characters are stripped BEFORE parsing: `java\nscript:` is a real
 * bypass against naive prefix checks, and `new URL()` would happily normalise
 * it back into a scheme we must refuse.
 *
 * @param {string} raw
 * @returns {{href:string, external:boolean, host:string, scheme:string}|null}
 *          null means "refused" -- the caller must render the text, not a link.
 */
export function safeUrl(raw) {
  // U+FFFD is stripped along with the control characters: it is what a NUL in
  // the source became during normalisation, and leaving it in would let
  // `java<NUL>script:` survive as a "relative" URL instead of being refused.
  const value = String(raw === null || raw === undefined ? '' : raw)
    .replace(/[\u0000-\u001F\u007F�]/g, '')
    .trim();
  if (!value) return null;

  let url;
  try {
    url = new URL(value, baseHref());
  } catch {
    return null;
  }

  const scheme = url.protocol.toLowerCase();
  if (!SAFE_SCHEMES.has(scheme)) return null;

  if (scheme === 'mailto:') {
    return { href: url.href, external: true, host: '', scheme };
  }
  if (sameOrigin(url)) {
    // Keep the author's own spelling so `#/notes?id=…` stays a hash route
    // instead of becoming an absolute URL the router has to re-parse.
    return { href: value, external: false, host: url.host, scheme };
  }
  return { href: url.href, external: true, host: url.host, scheme };
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

function normalise(source) {
  let src = String(source === null || source === undefined ? '' : source);
  if (src.length > MAX_INPUT_CHARS) src = src.slice(0, MAX_INPUT_CHARS);
  return src
    .replace(/\u0000/g, '\uFFFD')
    .replace(/\r\n?/g, '\n')
    // Tabs are expanded so indentation arithmetic (lists, fences) has one
    // unit. Four columns is the Markdown convention.
    .replace(/\t/g, '    ');
}

/* ------------------------------------------------------------------ */
/* Link reference definitions                                          */
/* ------------------------------------------------------------------ */

const DEFINITION_RE = /^ {0,3}\[([^\]\n]+)\]:\s*(\S+)(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*$/;

/**
 * Pull `[label]: url "title"` lines out of the document.
 * Returns the remaining lines plus the reference map, so the inline scanner
 * can resolve `[text][label]` without re-scanning the whole document.
 */
function collectDefinitions(lines) {
  const refs = new Map();
  const kept = [];
  let inFence = null;
  for (const line of lines) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!inFence) inFence = fence[1][0];
      else if (fence[1][0] === inFence) inFence = null;
      kept.push(line);
      continue;
    }
    if (inFence) {
      kept.push(line);
      continue;
    }
    const match = DEFINITION_RE.exec(line);
    if (match) {
      const key = match[1].trim().toLowerCase();
      if (!refs.has(key)) {
        refs.set(key, { href: match[2], title: match[3] || match[4] || match[5] || '' });
      }
      continue; // definitions are metadata, not content
    }
    kept.push(line);
  }
  return { lines: kept, refs };
}

/* ------------------------------------------------------------------ */
/* Block parsing                                                       */
/* ------------------------------------------------------------------ */

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\n]*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;
const BULLET_RE = /^( *)([-*+])([ \t]+)(.*)$/;
const ORDERED_RE = /^( *)(\d{1,9})([.)])([ \t]+)(.*)$/;
const TASK_RE = /^\[([ xX])\][ \t]+(.*)$/;
const TABLE_DELIM_RE = /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;

function isBlank(line) {
  return !line || /^[ \t]*$/.test(line);
}

/**
 * Parse a list of lines into block descriptors.
 * Recursion happens for quotes and list items; `depth` bounds it.
 */
function parseBlocks(lines, depth = 0) {
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[2];
      const indent = fence[1].length;
      const info = fence[3].trim();
      const body = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        const candidate = lines[i];
        const end = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(candidate);
        if (end && end[1][0] === marker[0] && end[1].length >= marker.length) {
          i += 1;
          closed = true;
          break;
        }
        // The opening fence's indentation is removed from every line, as far
        // as each line actually has it.
        body.push(candidate.slice(0, indent).trim() === '' ? candidate.slice(indent) : candidate);
        i += 1;
      }
      blocks.push({ type: 'code', lang: info.split(/\s+/)[0] || '', info, code: body.join('\n'), closed });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: (heading[2] || '').trim() });
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line) && depth < MAX_DEPTH) {
      const inner = [];
      while (i < lines.length) {
        const match = QUOTE_RE.exec(lines[i]);
        if (match) {
          inner.push(match[1]);
          i += 1;
          continue;
        }
        // Lazy continuation: a plain line right after a quote line belongs to
        // the quote's paragraph, which is how people actually write them.
        if (!isBlank(lines[i]) && inner.length && !isBlank(inner[inner.length - 1])) {
          inner.push(lines[i]);
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(inner, depth + 1) });
      continue;
    }

    const table = tryTable(lines, i);
    if (table) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }

    if ((BULLET_RE.test(line) || ORDERED_RE.test(line)) && depth < MAX_DEPTH) {
      const listResult = parseList(lines, i, depth);
      if (listResult) {
        blocks.push(listResult.block);
        i = listResult.next;
        continue;
      }
    }

    // Paragraph: everything up to a blank line or a line that starts another
    // block. Interrupting on a list marker is what makes an unspaced list
    // after a sentence still render as a list.
    const paragraph = [];
    while (i < lines.length && !isBlank(lines[i])) {
      const current = lines[i];
      if (paragraph.length && (
        FENCE_RE.test(current)
        || HEADING_RE.test(current)
        || HR_RE.test(current)
        || QUOTE_RE.test(current)
        || BULLET_RE.test(current)
        || ORDERED_RE.test(current)
      )) break;
      paragraph.push(current.replace(/^ {0,3}/, ''));
      i += 1;
    }
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
    else i += 1; // defensive: never spin on a line nothing consumed
  }

  return blocks;
}

/** GFM pipe table, recognised only when the delimiter row matches the header. */
function tryTable(lines, start) {
  const header = lines[start];
  const delim = lines[start + 1];
  if (!header || !delim) return null;
  if (header.indexOf('|') === -1) return null;
  if (!TABLE_DELIM_RE.test(delim)) return null;

  const head = splitRow(header);
  const spec = splitRow(delim);
  if (!head.length || head.length !== spec.length) return null;

  const align = spec.map((cell) => {
    const value = cell.trim();
    const left = value.startsWith(':');
    const right = value.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });

  const rows = [];
  let i = start + 2;
  while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf('|') !== -1) {
    const cells = splitRow(lines[i]);
    // Short rows are padded, long rows are cut: a ragged table is a typo, not
    // a reason to refuse to render the data.
    while (cells.length < head.length) cells.push('');
    rows.push(cells.slice(0, head.length));
    i += 1;
  }

  return { block: { type: 'table', head, align, rows }, next: i };
}

/** Split a table row on unescaped pipes, dropping the optional outer ones. */
function splitRow(line) {
  const cells = [];
  let buf = '';
  const trimmed = line.trim();
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      buf += '|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  cells.push(buf);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((cell) => cell.trim());
}

/**
 * Parse one list (a run of items sharing a marker family).
 *
 * An item's continuation lines are the ones indented to its content column;
 * they are dedented and parsed recursively, which is what makes nested lists,
 * code blocks and paragraphs inside items work without special cases.
 */
function parseList(lines, start, depth) {
  const first = BULLET_RE.exec(lines[start]) || ORDERED_RE.exec(lines[start]);
  if (!first) return null;
  const ordered = !BULLET_RE.test(lines[start]);
  const startNumber = ordered ? Number(first[2]) : 1;

  const items = [];
  let i = start;
  let loose = false;
  let pendingBlank = false;

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      pendingBlank = true;
      i += 1;
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    const numbered = ORDERED_RE.exec(line);
    const match = bullet || numbered;
    const isOrdered = !bullet && !!numbered;

    if (!match || isOrdered !== ordered) {
      if (pendingBlank || !items.length) break;
      // A non-blank, non-marker line directly after an item continues it.
      const last = items[items.length - 1];
      last.lines.push(line.replace(new RegExp(`^ {0,${last.indent}}`), ''));
      i += 1;
      continue;
    }

    const indent = match[1].length;
    if (items.length && indent >= items[items.length - 1].contentIndent) {
      // Deeper marker: content of the current item, handled by recursion.
      const last = items[items.length - 1];
      last.lines.push(line.slice(Math.min(indent, last.contentIndent)));
      i += 1;
      pendingBlank = false;
      continue;
    }
    if (items.length && indent > 0 && indent < items[0].indent) break;

    if (pendingBlank && items.length) loose = true;
    pendingBlank = false;

    const markerLength = bullet
      ? bullet[1].length + bullet[2].length + bullet[3].length
      : numbered[1].length + numbered[2].length + numbered[3].length + numbered[4].length;
    const rest = bullet ? bullet[4] : numbered[5];

    const task = TASK_RE.exec(rest);
    items.push({
      indent,
      contentIndent: markerLength,
      checked: task ? task[1].toLowerCase() === 'x' : null,
      lines: [task ? task[2] : rest],
    });
    i += 1;
  }

  if (!items.length) return null;

  const parsed = items.map((item) => {
    const blocks = parseBlocks(item.lines, depth + 1);
    // A nested list does not make its parent loose -- only a second block of
    // running content does, which is what the extra spacing is meant to show.
    if (blocks.filter((block) => block.type !== 'list').length > 1) loose = true;
    return { checked: item.checked, blocks };
  });

  return {
    block: { type: 'list', ordered, start: Number.isFinite(startNumber) ? startNumber : 1, loose, items: parsed },
    next: i,
  };
}

/* ------------------------------------------------------------------ */
/* Inline parsing                                                      */
/* ------------------------------------------------------------------ */

const PUNCTUATION = new Set('\\`*_{}[]()#+-.!|~<>"\'');
const TAG_RE = /^#([\p{L}_][\p{L}\p{N}_/-]*)/u;
const BARE_URL_RE = /^https?:\/\/[^\s<>()[\]"']+[^\s<>()[\]"'.,;:!?]/i;
const AUTOLINK_RE = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i;
const EMAIL_AUTOLINK_RE = /^<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/;

/**
 * Turn inline Markdown into descriptor nodes.
 *
 * A hand-written scanner rather than a chain of `String.replace` calls: only a
 * scanner knows that the `*` it is looking at sits inside a code span, and
 * only a scanner can stop at the right closing delimiter instead of the first
 * one anywhere in the document.
 */
function parseInline(source, ctx, depth = 0) {
  const src = String(source || '');
  const out = [];
  let buf = '';

  const flush = () => {
    if (buf) {
      out.push({ type: 'text', value: buf });
      buf = '';
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // Backslash escape: the next punctuation character is literal.
    if (ch === '\\' && i + 1 < src.length && PUNCTUATION.has(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === '\n') {
      flush();
      out.push({ type: 'break' });
      i += 1;
      continue;
    }

    if (ch === '`') {
      const span = readCodeSpan(src, i);
      if (span) {
        flush();
        out.push({ type: 'code', value: span.value });
        i = span.next;
        continue;
      }
    }

    if (ch === '!' && src[i + 1] === '[') {
      const image = readLink(src, i + 1, ctx, depth);
      if (image) {
        flush();
        out.push({ type: 'image', alt: image.rawLabel, src: image.target.href, title: image.target.title });
        i = image.next;
        continue;
      }
    }

    if (ch === '[' && src[i + 1] === '[') {
      const wiki = readWiki(src, i);
      if (wiki) {
        flush();
        out.push(wiki.node);
        i = wiki.next;
        continue;
      }
    }

    if (ch === '[') {
      const link = readLink(src, i, ctx, depth);
      if (link) {
        flush();
        out.push({ type: 'link', children: link.children, ...link.target });
        i = link.next;
        continue;
      }
    }

    if (ch === '<') {
      const auto = AUTOLINK_RE.exec(src.slice(i));
      if (auto) {
        flush();
        out.push({ type: 'link', children: [{ type: 'text', value: auto[1] }], href: auto[1], title: '' });
        i += auto[0].length;
        continue;
      }
      const mail = EMAIL_AUTOLINK_RE.exec(src.slice(i));
      if (mail) {
        flush();
        out.push({ type: 'link', children: [{ type: 'text', value: mail[1] }], href: `mailto:${mail[1]}`, title: '' });
        i += mail[0].length;
        continue;
      }
    }

    if ((ch === 'h' || ch === 'H') && atWordStart(src, i)) {
      const bare = BARE_URL_RE.exec(src.slice(i));
      if (bare) {
        flush();
        out.push({ type: 'link', children: [{ type: 'text', value: bare[0] }], href: bare[0], title: '' });
        i += bare[0].length;
        continue;
      }
    }

    if (ch === '#' && atWordStart(src, i)) {
      const tag = TAG_RE.exec(src.slice(i));
      if (tag) {
        flush();
        out.push({ type: 'tag', name: tag[1] });
        i += tag[0].length;
        continue;
      }
    }

    if ((ch === '*' || ch === '_' || ch === '~') && depth < MAX_DEPTH) {
      const emphasis = readEmphasis(src, i, ctx, depth);
      if (emphasis) {
        flush();
        out.push(emphasis.node);
        i = emphasis.next;
        continue;
      }
    }

    buf += ch;
    i += 1;
  }

  flush();
  return out;
}

function atWordStart(src, index) {
  if (index === 0) return true;
  return /[\s([{<"'‚„»›–—]/.test(src[index - 1]);
}

/** `` `code` `` with any number of backticks; the longest run wins. */
function readCodeSpan(src, start) {
  const open = /^`+/.exec(src.slice(start));
  if (!open) return null;
  const fence = open[0];
  const end = src.indexOf(fence, start + fence.length);
  if (end === -1) return null;
  // A backtick run longer than the fence is content, not a terminator.
  if (src[end + fence.length] === '`') return null;
  let value = src.slice(start + fence.length, end);
  if (value.length > 1 && value.startsWith(' ') && value.endsWith(' ') && value.trim()) {
    value = value.slice(1, -1);
  }
  return { value, next: end + fence.length };
}

/** `[label](dest "title")`, `[label][ref]` and `[ref]` when a definition exists. */
function readLink(src, start, ctx, depth) {
  const label = readBalanced(src, start, '[', ']');
  if (!label) return null;
  let next = label.next;
  let href = null;
  let title = '';

  if (src[next] === '(') {
    const dest = readBalanced(src, next, '(', ')');
    if (!dest) return null;
    const parsed = parseDestination(dest.value);
    href = parsed.href;
    title = parsed.title;
    next = dest.next;
  } else if (src[next] === '[') {
    const ref = readBalanced(src, next, '[', ']');
    if (!ref) return null;
    const key = (ref.value.trim() || label.value.trim()).toLowerCase();
    const definition = ctx.refs.get(key);
    if (!definition) return null;
    href = definition.href;
    title = definition.title;
    next = ref.next;
  } else {
    const definition = ctx.refs.get(label.value.trim().toLowerCase());
    if (!definition) return null;
    href = definition.href;
    title = definition.title;
  }

  return {
    children: parseInline(label.value, ctx, depth + 1),
    rawLabel: label.value,
    target: { href, title },
    next,
  };
}

/** Read a bracketed run, honouring nesting and escapes. */
function readBalanced(src, start, open, close) {
  if (src[start] !== open) return null;
  let level = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '`') {
      const span = readCodeSpan(src, i);
      if (span) {
        i = span.next - 1;
        continue;
      }
    }
    if (ch === open) level += 1;
    else if (ch === close) {
      level -= 1;
      if (level === 0) return { value: src.slice(start + 1, i), next: i + 1 };
    }
  }
  return null;
}

/** `url "title"`, `<url> 'title'`, or just `url`. */
function parseDestination(raw) {
  let value = String(raw || '').trim();
  let title = '';
  const quoted = /\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))$/.exec(value);
  if (quoted) {
    title = quoted[1] || quoted[2] || quoted[3] || '';
    value = value.slice(0, quoted.index).trim();
  }
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
  return { href: value, title };
}

/** `[[Name]]`, `[[Name|Beschriftung]]`, `[[Name#Abschnitt]]`. */
function readWiki(src, start) {
  const end = src.indexOf(']]', start + 2);
  if (end === -1) return null;
  const inner = src.slice(start + 2, end);
  if (!inner.trim() || inner.indexOf('\n') !== -1) return null;
  const pipe = inner.indexOf('|');
  const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const label = (pipe === -1 ? inner : inner.slice(pipe + 1)).trim();
  if (!target) return null;
  return { node: { type: 'wiki', target, label: label || target }, next: end + 2 };
}

/**
 * Emphasis. `**`/`__` -> strong, `*`/`_` -> em, `~~` -> struck through.
 *
 * `_` only delimits at word boundaries, so `snake_case_names` and
 * `datei_2_final` survive a renderer that would otherwise italicise half of
 * every identifier in a technical note.
 */
function readEmphasis(src, start, ctx, depth) {
  const char = src[start];
  const run = /^(\*+|_+|~+)/.exec(src.slice(start))[0];
  const wanted = char === '~' ? 2 : Math.min(run.length, 2);
  if (char === '~' && run.length < 2) return null;

  const after = src[start + wanted];
  if (after === undefined || /\s/.test(after)) return null;
  if (char === '_' && !atWordStart(src, start)) return null;

  const marker = char.repeat(wanted);
  let i = start + wanted;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      const span = readCodeSpan(src, i);
      if (span) {
        i = span.next;
        continue;
      }
    }
    if (src.startsWith(marker, i) && !/\s/.test(src[i - 1] || ' ')) {
      if (char === '_') {
        const following = src[i + marker.length];
        if (following !== undefined && /[\p{L}\p{N}]/u.test(following)) {
          i += 1;
          continue;
        }
      }
      const inner = src.slice(start + wanted, i);
      if (!inner) return null;
      const type = char === '~' ? 'strike' : (wanted === 2 ? 'strong' : 'em');
      return { node: { type, children: parseInline(inner, ctx, depth + 1) }, next: i + marker.length };
    }
    i += 1;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function makeContext(options = {}) {
  return {
    refs: options.refs instanceof Map ? options.refs : new Map(),
    /** `#/…` route for a wiki target, or null when it cannot be resolved. */
    wikiHref: typeof options.wikiHref === 'function' ? options.wikiHref : null,
    tagHref: typeof options.tagHref === 'function'
      ? options.tagHref
      : (name) => `#/search?q=${encodeURIComponent(`#${name}`)}`,
    highlight: options.highlight !== false,
    copy: options.copy !== false,
    softBreak: options.softBreak === 'space' ? 'space' : 'br',
    /** Hook so a view can intercept a click (e.g. "Notiz anlegen"). */
    onWikiLink: typeof options.onWikiLink === 'function' ? options.onWikiLink : null,
  };
}

function renderBlocks(blocks, ctx) {
  const nodes = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, block.level));
        // h1 is the view's own page title; a document heading starts at h2 so
        // the heading outline of the page stays meaningful for screen readers.
        const tag = `h${Math.min(6, level + 1)}`;
        nodes.push(h(`${tag}.md-heading.md-heading--${level}`, null, renderInlineNodes(parseInline(block.text, ctx), ctx)));
        break;
      }
      case 'paragraph':
        nodes.push(h('p.md-p', null, renderInlineNodes(parseInline(block.text, ctx), ctx)));
        break;
      case 'code':
        nodes.push(renderCode(block, ctx));
        break;
      case 'quote':
        nodes.push(h('blockquote.md-quote', null, renderBlocks(block.blocks, ctx)));
        break;
      case 'hr':
        nodes.push(h('hr.md-hr'));
        break;
      case 'list':
        nodes.push(renderList(block, ctx));
        break;
      case 'table':
        nodes.push(renderTable(block, ctx));
        break;
      default:
        break;
    }
  }
  return nodes;
}

function renderList(block, ctx) {
  const listNode = h(block.ordered ? 'ol.md-list' : 'ul.md-list', block.ordered && block.start !== 1
    ? { start: String(block.start) }
    : null);
  if (block.loose) listNode.classList.add('md-list--loose');

  for (const item of block.items) {
    const li = h('li.md-item');
    if (item.checked !== null) {
      li.classList.add('md-item--task');
      li.appendChild(h('input.md-check', {
        type: 'checkbox',
        checked: item.checked === true,
        disabled: true,
        'aria-label': item.checked ? 'Erledigt' : 'Offen',
      }));
    }
    const children = block.loose
      ? renderBlocks(item.blocks, ctx)
      : renderTightItem(item.blocks, ctx);
    for (const child of children) li.appendChild(child);
    listNode.appendChild(li);
  }
  return listNode;
}

/** In a tight list the first paragraph is unwrapped, everything else is not. */
function renderTightItem(blocks, ctx) {
  const out = [];
  blocks.forEach((block, index) => {
    if (index === 0 && block.type === 'paragraph') {
      out.push(...renderInlineNodes(parseInline(block.text, ctx), ctx));
      return;
    }
    out.push(...renderBlocks([block], ctx));
  });
  return out;
}

function renderTable(block, ctx) {
  const headRow = h('tr');
  block.head.forEach((cell, index) => {
    const th = h('th', block.align[index] ? { style: { textAlign: block.align[index] } } : null,
      renderInlineNodes(parseInline(cell, ctx), ctx));
    headRow.appendChild(th);
  });

  const body = h('tbody');
  for (const row of block.rows) {
    const tr = h('tr');
    row.forEach((cell, index) => {
      tr.appendChild(h('td', block.align[index] ? { style: { textAlign: block.align[index] } } : null,
        renderInlineNodes(parseInline(cell, ctx), ctx)));
    });
    body.appendChild(tr);
  }

  // The wrapper is what keeps a wide table from stretching the whole column;
  // it scrolls on its own instead.
  return h('div.md-table-wrap', null, h('table.md-table.table', null, h('thead', null, headRow), body));
}

function renderCode(block, ctx) {
  const language = resolveLanguage(block.lang);
  const label = block.lang ? languageLabel(block.lang) : 'Text';
  const pre = h('pre.md-code__body');
  const code = h('code.md-code__text');

  if (ctx.highlight && language && block.code.length <= HIGHLIGHT_MAX_CHARS) {
    for (const token of tokenize(block.code, language)) {
      if (token.t === 'txt') code.appendChild(text(token.v));
      else code.appendChild(h(`span.md-tok.md-tok--${token.t}`, null, text(token.v)));
    }
  } else {
    code.appendChild(text(block.code));
  }
  pre.appendChild(code);

  const head = h('div.md-code__head', null,
    h('span.md-code__lang', null, text(label)),
    block.closed === false
      ? h('span.md-code__warn', { title: 'Der Codeblock wurde nicht geschlossen (fehlende ```-Zeile).' }, text('unvollständig'))
      : null,
    ctx.copy ? copyButton(block.code) : null);

  return h('div.md-code', { dataset: { lang: language || 'text' } }, head, pre);
}

/**
 * Copy-to-clipboard with an honest failure mode: when the clipboard is not
 * available the button says so instead of pretending the copy happened.
 */
function copyButton(value) {
  const button = h('button.md-code__copy', {
    type: 'button',
    title: 'Den Codeblock in die Zwischenablage kopieren',
  }, text('Kopieren'));

  let resetTimer = null;
  const say = (message, ok) => {
    button.textContent = '';
    button.appendChild(text(message));
    button.classList.toggle('is-ok', ok === true);
    button.classList.toggle('is-error', ok === false);
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      button.textContent = '';
      button.appendChild(text('Kopieren'));
      button.classList.remove('is-ok', 'is-error');
    }, 1800);
  };

  button.addEventListener('click', async () => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value);
        say('Kopiert', true);
        return;
      }
      throw new Error('Zwischenablage nicht verfügbar');
    } catch (err) {
      // Fall back to a selection the user can copy by hand, then say what
      // happened -- silently doing nothing would look like a broken button.
      const pre = button.closest('.md-code');
      const target = pre && pre.querySelector('.md-code__text');
      if (target && typeof window.getSelection === 'function') {
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        say('Markiert – Strg+C', false);
        return;
      }
      button.title = `Kopieren nicht möglich: ${err && err.message ? err.message : err}`;
      say('Nicht möglich', false);
    }
  });

  return button;
}

function renderInlineNodes(nodes, ctx) {
  const out = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push(text(node.value));
        break;
      case 'break':
        out.push(ctx.softBreak === 'space' ? text(' ') : h('br'));
        break;
      case 'code':
        out.push(h('code.md-inline-code', null, text(node.value)));
        break;
      case 'strong':
        out.push(h('strong', null, renderInlineNodes(node.children, ctx)));
        break;
      case 'em':
        out.push(h('em', null, renderInlineNodes(node.children, ctx)));
        break;
      case 'strike':
        out.push(h('s', null, renderInlineNodes(node.children, ctx)));
        break;
      case 'link':
        out.push(renderLink(node, ctx));
        break;
      case 'image':
        out.push(renderImage(node, ctx));
        break;
      case 'wiki':
        out.push(renderWiki(node, ctx));
        break;
      case 'tag':
        out.push(h('a.md-tag.tag', { href: ctx.tagHref(node.name), dataset: { tag: node.name } }, text(`#${node.name}`)));
        break;
      default:
        break;
    }
  }
  return out;
}

function renderLink(node, ctx) {
  const target = safeUrl(node.href);
  const children = renderInlineNodes(node.children, ctx);

  if (!target) {
    // Refused. The text survives, the destination is named in the tooltip, and
    // nothing in the document can be clicked into a scheme we do not trust.
    return h('span.md-link--blocked', {
      title: `Blockierte Adresse: ${String(node.href || '').slice(0, 200)}`,
    }, children, text(' '), h('span.md-link__mark', { 'aria-hidden': 'true' }, text('⦸')));
  }

  const props = { href: target.href, class: 'md-link' };
  if (node.title) props.title = node.title;
  const anchor = h('a', props, children);

  if (target.external) {
    anchor.classList.add('md-link--external');
    anchor.setAttribute('target', '_blank');
    // noopener/noreferrer: the opened page must not get a handle on this one.
    anchor.setAttribute('rel', 'noopener noreferrer nofollow');
    const warning = target.scheme === 'mailto:'
      ? `E-Mail-Adresse: ${target.href.replace(/^mailto:/, '')}`
      : `Externe Adresse (${target.host}) – öffnet im Browser und verlässt damit dieses Gerät.`;
    // The author's own title still belongs to the user; the warning is added
    // to it rather than replacing information they wrote.
    anchor.title = node.title ? `${node.title} — ${warning}` : warning;
    anchor.appendChild(h('span.md-link__mark', { 'aria-hidden': 'true' }, text('↗')));
  }
  return anchor;
}

/**
 * Images are never loaded from a remote host.
 *
 * The CSP already blocks them, so an `<img>` would show a broken icon and
 * nothing else. A placeholder that names the host is both honest and useful,
 * and it closes the "note contains a tracking pixel" hole by construction.
 */
function renderImage(node, ctx) {
  const target = safeUrl(node.src);
  const alt = String(node.alt || '').trim();

  if (target && !target.external) {
    return h('img.md-image', {
      src: target.href,
      alt,
      loading: 'lazy',
      decoding: 'async',
    });
  }

  const label = alt || (target ? target.host : 'Bild');
  const placeholder = h('span.md-image-blocked', {
    title: target
      ? `Bild von ${target.host}. Es wird nicht geladen: externe Inhalte verlassen dieses Gerät.`
      : `Bildadresse abgelehnt: ${String(node.src || '').slice(0, 200)}`,
  },
  h('span.md-image-blocked__mark', { 'aria-hidden': 'true' }, text('▤')),
  text(` ${label}`));

  if (target) {
    placeholder.appendChild(text(' '));
    placeholder.appendChild(h('a.md-link.md-link--external', {
      href: target.href,
      target: '_blank',
      rel: 'noopener noreferrer nofollow',
      title: `Im Browser öffnen (${target.host}) – verlässt dieses Gerät.`,
    }, text('öffnen ↗')));
  }
  return placeholder;
}

function renderWiki(node, ctx) {
  // Without a resolver the caller cannot know whether the target exists, so
  // the link stays neutral. Marking it "missing" on a hunch would be the
  // renderer inventing a fact about the vault.
  const href = ctx.wikiHref ? ctx.wikiHref(node.target) : null;
  const resolved = typeof href === 'string' && href.length > 0;
  const unknown = !ctx.wikiHref;
  const anchor = h('a.md-wiki', {
    href: resolved ? href : `#/search?q=${encodeURIComponent(node.target)}`,
    dataset: { wiki: node.target, resolved: resolved ? '1' : (unknown ? '?' : '0') },
    title: resolved
      ? `Verknüpfter Eintrag: ${node.target}`
      : (unknown
        ? `Verknüpfung „${node.target}“ – im Wissensgraphen suchen.`
        : `Kein Eintrag mit dem Titel „${node.target}“ – klicken, um ihn anzulegen.`),
  }, text(node.label));
  if (!resolved && !unknown) anchor.classList.add('md-wiki--missing');
  if (ctx.onWikiLink) {
    anchor.addEventListener('click', (event) => {
      const handled = ctx.onWikiLink(node.target, { resolved, href, event });
      if (handled === true) event.preventDefault();
    });
  }
  return anchor;
}

/* ------------------------------------------------------------------ */
/* Syntax highlighting                                                 */
/* ------------------------------------------------------------------ */

const LANGUAGE_ALIASES = new Map(Object.entries({
  js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', node: 'js', jsx: 'js',
  ts: 'js', typescript: 'js', tsx: 'js',
  py: 'python', python: 'python', python3: 'python',
  json: 'json', jsonc: 'json', json5: 'json',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell', terminal: 'shell',
  html: 'html', xml: 'html', svg: 'html', xhtml: 'html', vue: 'html',
}));

const LANGUAGE_LABELS = new Map(Object.entries({
  js: 'JavaScript', python: 'Python', json: 'JSON', shell: 'Shell', html: 'HTML',
}));

/** Internal id for a fenced-code info string, or null when unknown. */
function resolveLanguage(info) {
  const key = String(info || '').trim().toLowerCase();
  if (!key) return null;
  return LANGUAGE_ALIASES.get(key) || null;
}

/** What the badge above a code block says. Unknown languages keep their name. */
export function languageLabel(info) {
  const key = String(info || '').trim();
  const id = resolveLanguage(key);
  if (id) return LANGUAGE_LABELS.get(id) || key;
  return key || 'Text';
}

const JS_KEYWORDS = new Set(('await break case catch class const continue debugger default delete do else export extends '
  + 'finally for function if import in instanceof let new of return static super switch this throw try typeof var void '
  + 'while with yield as from get set async').split(' '));
const JS_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
const JS_BUILTINS = new Set(('console window document Math JSON Object Array String Number Boolean Promise Map Set '
  + 'WeakMap WeakSet Symbol Error TypeError RangeError Date RegExp globalThis require module exports process Buffer '
  + 'setTimeout clearTimeout setInterval clearInterval fetch').split(' '));

const PY_KEYWORDS = new Set(('and as assert async await break class continue def del elif else except finally for from '
  + 'global if import in is lambda nonlocal not or pass raise return try while with yield match case').split(' '));
const PY_LITERALS = new Set(['True', 'False', 'None', 'self', 'cls']);
const PY_BUILTINS = new Set(('print len range str int float list dict set tuple bool open enumerate zip map filter sum '
  + 'min max abs sorted type isinstance super repr input format any all').split(' '));

const SH_KEYWORDS = new Set(('if then else elif fi for while until do done case esac function in select time '
  + 'return break continue local export readonly declare source alias unset').split(' '));
const SH_BUILTINS = new Set(('echo cd ls cat grep sed awk curl wget git npm node python python3 pip make sudo chmod '
  + 'chown mkdir rm cp mv find xargs kill ps tar ssh scp docker systemctl ollama').split(' '));

const LANGUAGE_SPECS = {
  js: {
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [
      { open: '`', close: '`', escape: true, multiline: true },
      { open: '"', close: '"', escape: true },
      { open: "'", close: "'", escape: true },
    ],
    keywords: JS_KEYWORDS,
    literals: JS_LITERALS,
    builtins: JS_BUILTINS,
    callNames: true,
  },
  python: {
    lineComments: ['#'],
    blockComments: [],
    strings: [
      { open: '"""', close: '"""', escape: true, multiline: true },
      { open: "'''", close: "'''", escape: true, multiline: true },
      { open: '"', close: '"', escape: true },
      { open: "'", close: "'", escape: true },
    ],
    keywords: PY_KEYWORDS,
    literals: PY_LITERALS,
    builtins: PY_BUILTINS,
    decorators: true,
    callNames: true,
  },
  json: {
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: [{ open: '"', close: '"', escape: true }],
    keywords: new Set(),
    literals: new Set(['true', 'false', 'null']),
    builtins: new Set(),
    propertyNames: true,
  },
  shell: {
    lineComments: ['#'],
    blockComments: [],
    strings: [
      { open: '"', close: '"', escape: true },
      { open: "'", close: "'", escape: false },
    ],
    keywords: SH_KEYWORDS,
    literals: new Set(),
    builtins: SH_BUILTINS,
    variables: true,
    // In a shell, `llama3.2` and `some-file.txt` are one word. Splitting them
    // on `.` would paint half of every command line as numbers.
    wordPattern: /^[A-Za-z_][\w./-]*/,
  },
};

const DEFAULT_WORD_PATTERN = /^[A-Za-z_$À-ɏ][\w$À-ɏ]*/;

/**
 * Tokenise source code.
 *
 * One left-to-right pass with explicit state. Every branch consumes at least
 * one character, so the loop always terminates -- which is the property a
 * regex-based highlighter cannot give you on adversarial input.
 *
 * @param {string} code
 * @param {string} language internal id from `resolveLanguage`
 * @returns {Array<{t:string, v:string}>}
 */
export function tokenize(code, language) {
  const source = String(code || '');
  if (language === 'html') return tokenizeMarkup(source);
  const spec = LANGUAGE_SPECS[language];
  if (!spec) return [{ t: 'txt', v: source }];

  const tokens = [];
  let plain = '';
  const push = (t, v) => {
    if (!v) return;
    if (t === 'txt') {
      plain += v;
      return;
    }
    if (plain) {
      tokens.push({ t: 'txt', v: plain });
      plain = '';
    }
    tokens.push({ t, v });
  };

  let i = 0;
  const length = source.length;

  while (i < length) {
    const ch = source[i];

    // Comments ------------------------------------------------------
    let matchedComment = false;
    for (const [open, close] of spec.blockComments) {
      if (source.startsWith(open, i)) {
        const end = source.indexOf(close, i + open.length);
        const stop = end === -1 ? length : end + close.length;
        push('com', source.slice(i, stop));
        i = stop;
        matchedComment = true;
        break;
      }
    }
    if (matchedComment) continue;

    for (const open of spec.lineComments) {
      // `#` only starts a shell comment at the beginning of a word; `$#` and
      // `${x#y}` are not comments.
      if (source.startsWith(open, i) && (open !== '#' || i === 0 || /[\s;|&(]/.test(source[i - 1]))) {
        const end = source.indexOf('\n', i);
        const stop = end === -1 ? length : end;
        push('com', source.slice(i, stop));
        i = stop;
        matchedComment = true;
        break;
      }
    }
    if (matchedComment) continue;

    // Strings -------------------------------------------------------
    let matchedString = false;
    for (const rule of spec.strings) {
      if (!source.startsWith(rule.open, i)) continue;
      let j = i + rule.open.length;
      while (j < length) {
        if (rule.escape && source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source.startsWith(rule.close, j)) {
          j += rule.close.length;
          break;
        }
        if (!rule.multiline && source[j] === '\n') break; // unterminated: stop at EOL
        j += 1;
      }
      const value = source.slice(i, Math.min(j, length));
      const kind = spec.propertyNames && isPropertyName(source, Math.min(j, length)) ? 'prop' : 'str';
      push(kind, value);
      i = Math.min(j, length) || i + 1;
      matchedString = true;
      break;
    }
    if (matchedString) continue;

    // Shell variables ----------------------------------------------
    if (spec.variables && ch === '$') {
      const match = /^\$(\{[^}\n]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9?@*#!$-])/.exec(source.slice(i));
      if (match) {
        push('var', match[0]);
        i += match[0].length;
        continue;
      }
    }

    // Python decorators --------------------------------------------
    if (spec.decorators && ch === '@' && (i === 0 || source[i - 1] === '\n' || /\s/.test(source[i - 1]))) {
      const match = /^@[A-Za-z_][\w.]*/.exec(source.slice(i));
      if (match) {
        push('meta', match[0]);
        i += match[0].length;
        continue;
      }
    }

    // Numbers -------------------------------------------------------
    if (/[0-9]/.test(ch) && !/[A-Za-z_$]/.test(source[i - 1] || ' ')) {
      const match = /^(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)n?/.exec(source.slice(i));
      if (match) {
        push('num', match[0]);
        i += match[0].length;
        continue;
      }
    }

    // Identifiers ---------------------------------------------------
    if (/[A-Za-z_$\u00C0-\u024F]/.test(ch)) {
      const match = (spec.wordPattern || DEFAULT_WORD_PATTERN).exec(source.slice(i));
      const word = match[0];
      let kind = 'txt';
      if (spec.keywords.has(word)) kind = 'kw';
      else if (spec.literals.has(word)) kind = 'lit';
      else if (spec.builtins.has(word)) kind = 'bui';
      else if (spec.callNames && /^\s*\(/.test(source.slice(i + word.length))) kind = 'fn';
      push(kind, word);
      i += word.length;
      continue;
    }

    // Punctuation and operators -------------------------------------
    if (/[{}[\]()<>=+\-*/%!&|^~?:;,.]/.test(ch)) {
      push('punct', ch);
      i += 1;
      continue;
    }

    push('txt', ch);
    i += 1;
  }

  if (plain) tokens.push({ t: 'txt', v: plain });
  return tokens;
}

/** In JSON a string is a property name when the next thing is a colon. */
function isPropertyName(source, index) {
  const rest = source.slice(index);
  return /^\s*:/.test(rest);
}

/**
 * HTML/XML needs its own machine: its "words" are tags, attribute names and
 * attribute values, none of which the generic identifier rule would find.
 */
function tokenizeMarkup(source) {
  const tokens = [];
  let i = 0;
  const length = source.length;
  const push = (t, v) => {
    if (v) tokens.push({ t, v });
  };

  while (i < length) {
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      const stop = end === -1 ? length : end + 3;
      push('com', source.slice(i, stop));
      i = stop;
      continue;
    }
    if (source[i] === '<') {
      const close = source.indexOf('>', i);
      const stop = close === -1 ? length : close + 1;
      const tag = source.slice(i, stop);
      tokenizeTag(tag, push);
      i = stop;
      continue;
    }
    const next = source.indexOf('<', i);
    const stop = next === -1 ? length : next;
    push('txt', source.slice(i, stop));
    i = stop;
  }
  return tokens;
}

function tokenizeTag(tag, push) {
  const nameMatch = /^<\/?\s*([A-Za-z_!?][\w:.-]*)/.exec(tag);
  if (!nameMatch) {
    push('txt', tag);
    return;
  }
  const headLength = nameMatch[0].length;
  push('punct', tag.slice(0, headLength - nameMatch[1].length));
  push('tag', nameMatch[1]);

  let i = headLength;
  while (i < tag.length) {
    const ch = tag[i];
    if (ch === '>' || (ch === '/' && tag[i + 1] === '>')) {
      push('punct', tag.slice(i));
      return;
    }
    if (/\s/.test(ch)) {
      push('txt', ch);
      i += 1;
      continue;
    }
    const attr = /^[^\s=/>]+/.exec(tag.slice(i));
    if (attr) {
      push('attr', attr[0]);
      i += attr[0].length;
      continue;
    }
    if (ch === '=') {
      push('punct', '=');
      i += 1;
      const value = /^\s*("[^"]*"?|'[^']*'?|[^\s>]+)/.exec(tag.slice(i));
      if (value) {
        push('txt', value[0].slice(0, value[0].length - value[0].trimStart().length));
        push('str', value[0].trimStart());
        i += value[0].length;
      }
      continue;
    }
    push('txt', ch);
    i += 1;
  }
}

/**
 * Highlight a code string on its own (for views that show code outside a
 * Markdown document).
 * @returns {DocumentFragment}
 */
export function highlight(code, language) {
  const id = resolveLanguage(language);
  const fragment = frag();
  if (!id || String(code || '').length > HIGHLIGHT_MAX_CHARS) {
    fragment.appendChild(text(String(code || '')));
    return fragment;
  }
  for (const token of tokenize(String(code || ''), id)) {
    if (token.t === 'txt') fragment.appendChild(text(token.v));
    else fragment.appendChild(h(`span.md-tok.md-tok--${token.t}`, null, text(token.v)));
  }
  return fragment;
}

/* ------------------------------------------------------------------ */
/* Plain text extraction                                               */
/* ------------------------------------------------------------------ */

/**
 * The readable text of a Markdown document, for previews, titles and search
 * result lines. Structure markers are dropped, content is kept: a link keeps
 * its label, a wiki link its name, an image its alt text, a code block its
 * code (that is content too).
 *
 * @param {string} source
 * @param {{maxLength?:number}} [opts]
 * @returns {string}
 */
export function extractPlain(source, opts = {}) {
  const lines = normalise(source).split('\n');
  const { lines: content, refs } = collectDefinitions(lines);
  const ctx = makeContext({ refs });
  const parts = [];
  plainBlocks(parseBlocks(content), ctx, parts);
  let out = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const max = Number(opts.maxLength);
  if (Number.isFinite(max) && max > 0 && out.length > max) {
    out = `${out.slice(0, max - 1).trimEnd()}…`;
  }
  return out;
}

function plainBlocks(blocks, ctx, out) {
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        out.push(plainInline(parseInline(block.text, ctx)));
        break;
      case 'paragraph':
        out.push(plainInline(parseInline(block.text, ctx)));
        break;
      case 'code':
        out.push(block.code);
        break;
      case 'quote':
        plainBlocks(block.blocks, ctx, out);
        break;
      case 'list':
        for (const item of block.items) {
          const buffer = [];
          plainBlocks(item.blocks, ctx, buffer);
          const marker = item.checked === null ? '•' : (item.checked ? '[x]' : '[ ]');
          out.push(`${marker} ${buffer.join(' ').trim()}`);
        }
        break;
      case 'table':
        out.push(block.head.map((cell) => plainInline(parseInline(cell, ctx))).join(' | '));
        for (const row of block.rows) {
          out.push(row.map((cell) => plainInline(parseInline(cell, ctx))).join(' | '));
        }
        break;
      case 'hr':
        break;
      default:
        break;
    }
  }
}

function plainInline(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += node.value;
        break;
      case 'code':
        out += node.value;
        break;
      case 'break':
        out += ' ';
        break;
      case 'strong':
      case 'em':
      case 'strike':
      case 'link':
        out += plainInline(node.children);
        break;
      case 'image':
        out += node.alt || '';
        break;
      case 'wiki':
        out += node.label || node.target;
        break;
      case 'tag':
        out += `#${node.name}`;
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Every `[[wiki link]]` and `#tag` a document contains, in order of first
 * appearance. The views use this to resolve links before rendering and to
 * offer "Notiz anlegen" for the ones that do not exist yet.
 *
 * @returns {{wikiLinks:string[], tags:string[]}}
 */
export function extractLinks(source) {
  const lines = normalise(source).split('\n');
  const { lines: content, refs } = collectDefinitions(lines);
  const ctx = makeContext({ refs });
  const wikiLinks = [];
  const tags = [];

  const walkInline = (nodes) => {
    for (const node of nodes) {
      if (node.type === 'wiki' && !wikiLinks.includes(node.target)) wikiLinks.push(node.target);
      else if (node.type === 'tag' && !tags.includes(node.name)) tags.push(node.name);
      if (Array.isArray(node.children)) walkInline(node.children);
    }
  };
  const walkBlocks = (blocks) => {
    for (const block of blocks) {
      if (block.type === 'paragraph' || block.type === 'heading') walkInline(parseInline(block.text, ctx));
      else if (block.type === 'quote') walkBlocks(block.blocks);
      else if (block.type === 'list') block.items.forEach((item) => walkBlocks(item.blocks));
      else if (block.type === 'table') {
        block.head.forEach((cell) => walkInline(parseInline(cell, ctx)));
        block.rows.forEach((row) => row.forEach((cell) => walkInline(parseInline(cell, ctx))));
      }
    }
  };
  walkBlocks(parseBlocks(content));
  return { wikiLinks, tags };
}

/* ------------------------------------------------------------------ */
/* Public rendering entry points                                       */
/* ------------------------------------------------------------------ */

/**
 * Render a Markdown document into a DocumentFragment.
 *
 * @param {string} source
 * @param {{
 *   wikiHref?:(name:string)=>string|null,
 *   onWikiLink?:(name:string, info:object)=>boolean,
 *   tagHref?:(tag:string)=>string,
 *   highlight?:boolean, copy?:boolean, softBreak?:'br'|'space'
 * }} [options]
 * @returns {DocumentFragment}
 */
export function renderMarkdown(source, options = {}) {
  ensureStyles();
  const lines = normalise(source).split('\n');
  const { lines: content, refs } = collectDefinitions(lines);
  const ctx = makeContext({ ...options, refs });
  const fragment = frag();
  for (const node of renderBlocks(parseBlocks(content), ctx)) fragment.appendChild(node);
  return fragment;
}

/**
 * Render a single line of Markdown without block structure -- for titles,
 * list rows and anywhere a `<p>` would be wrong.
 * @returns {DocumentFragment}
 */
export function renderInline(source, options = {}) {
  ensureStyles();
  const ctx = makeContext({ ...options, softBreak: options.softBreak || 'space' });
  const fragment = frag();
  for (const node of renderInlineNodes(parseInline(normalise(source).replace(/\n+/g, ' '), ctx), ctx)) {
    fragment.appendChild(node);
  }
  return fragment;
}

/** Replace a container's content with rendered Markdown. */
export function renderInto(container, source, options = {}) {
  if (!container) return container;
  while (container.firstChild) container.removeChild(container.firstChild);
  container.appendChild(renderMarkdown(source, options));
  return container;
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

/**
 * The renderer ships its own styles.
 *
 * Markdown output has parts (code head, token colours, blocked-link marks)
 * that only exist here, and a view that forgot to style them would silently
 * render an unreadable code block. Every value is a design token from
 * app.css, so light/dark and the accent stay consistent; the syntax palette
 * reuses the status colours rather than inventing six new hues.
 *
 * Injected as a <style> element with textContent -- allowed by the server's
 * `style-src 'self' 'unsafe-inline'`, and not an HTML parse of user content.
 */
function ensureStyles() {
  if (typeof document === 'undefined' || !document.head) return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = MARKDOWN_CSS;
  document.head.appendChild(style);
}

const MARKDOWN_CSS = `
.md-p { margin: 0 0 var(--sp-2); overflow-wrap: anywhere; }
.md-p:last-child { margin-bottom: 0; }
.md-heading { margin: var(--sp-3) 0 var(--sp-1); line-height: var(--lh-tight); }
.md-heading:first-child { margin-top: 0; }
.md-heading--1 { font-size: var(--fs-lg); }
.md-heading--2 { font-size: var(--fs-md); }
.md-heading--3, .md-heading--4, .md-heading--5, .md-heading--6 { font-size: var(--fs-base); }
.md-heading--4, .md-heading--5, .md-heading--6 { color: var(--fg-muted); }
.md-list { margin: 0 0 var(--sp-2); padding-left: var(--sp-3); }
.md-list--loose > .md-item { margin-bottom: var(--sp-1); }
.md-item { margin: 2px 0; }
.md-item--task { list-style: none; margin-left: calc(var(--sp-3) * -1); padding-left: var(--sp-3); position: relative; }
.md-check { position: absolute; left: 0; top: 3px; margin: 0; accent-color: var(--accent); }
.md-quote {
  margin: 0 0 var(--sp-2);
  padding: var(--sp-05) 0 var(--sp-05) var(--sp-2);
  border-left: 3px solid var(--border-strong);
  color: var(--fg-muted);
}
.md-quote > :last-child { margin-bottom: 0; }
.md-hr { height: 1px; margin: var(--sp-3) 0; background: var(--border); border: 0; }
.md-inline-code {
  padding: 1px 5px;
  font-family: var(--font-mono);
  font-size: 0.92em;
  background: var(--surface-3);
  border-radius: var(--r-1);
  overflow-wrap: anywhere;
}
.md-link { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.md-link:hover { text-decoration-thickness: 2px; }
.md-link__mark { font-size: 0.85em; opacity: 0.75; padding-left: 2px; }
.md-link--blocked { color: var(--fg-muted); text-decoration: line-through; cursor: help; }
.md-wiki {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px solid var(--accent-ring);
  padding-bottom: 1px;
}
.md-wiki--missing { color: var(--warn); border-bottom-style: dashed; border-bottom-color: var(--warn); }
.md-tag { text-decoration: none; }
.md-tag:hover { background: var(--accent-soft); color: var(--accent); }
.md-image { display: block; margin: var(--sp-1) 0; border-radius: var(--r-2); }
.md-image-blocked {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  font-size: var(--fs-sm);
  color: var(--fg-muted);
  background: var(--surface-3);
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-2);
}
.md-table-wrap { margin: 0 0 var(--sp-2); overflow-x: auto; }
.md-table { width: 100%; }
.md-code {
  margin: 0 0 var(--sp-2);
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
  overflow: hidden;
}
.md-code__head {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 2px var(--sp-1) 2px var(--sp-2);
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}
.md-code__lang { font-size: var(--fs-xs); font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.md-code__warn { font-size: var(--fs-xs); color: var(--warn); }
.md-code__copy {
  margin-left: auto;
  padding: 2px 8px;
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  background: none;
  border: 1px solid transparent;
  border-radius: var(--r-1);
  cursor: pointer;
}
.md-code__copy:hover { color: var(--fg); border-color: var(--border-strong); }
.md-code__copy.is-ok { color: var(--ok); }
.md-code__copy.is-error { color: var(--danger); }
.md-code__body { margin: 0; padding: var(--sp-1) var(--sp-2); overflow-x: auto; }
.md-code__text { font-family: var(--font-mono); font-size: var(--fs-sm); line-height: 1.5; white-space: pre; }
.md-tok--kw { color: var(--accent); font-weight: 600; }
.md-tok--str { color: var(--ok); }
.md-tok--prop { color: var(--accent); }
.md-tok--num { color: var(--warn); }
.md-tok--lit { color: var(--warn); }
.md-tok--com { color: var(--fg-subtle); font-style: italic; }
.md-tok--bui { color: var(--fg); font-weight: 600; }
.md-tok--fn { color: var(--fg); }
.md-tok--var { color: var(--danger); }
.md-tok--meta { color: var(--danger); }
.md-tok--tag { color: var(--accent); font-weight: 600; }
.md-tok--attr { color: var(--warn); }
.md-tok--punct { color: var(--fg-muted); }
`;

export default {
  render: renderMarkdown,
  renderMarkdown,
  renderInline,
  renderInto,
  extractPlain,
  extractLinks,
  highlight,
  tokenize,
  languageLabel,
  safeUrl,
};
