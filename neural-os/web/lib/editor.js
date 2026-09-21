/**
 * editor.js -- the window the user pastes code into.
 *
 * Deliberately a `<textarea>` with a number column beside it, not a
 * `contenteditable` with syntax colouring. The reason is the person this
 * whole feature exists for: someone pasting code that an assistant wrote for
 * them. What they need is that paste, undo, select-all, find-in-page, the
 * screen reader and the mobile keyboard all behave exactly as they do in every
 * other text field on their machine. A rich editor buys colour and loses all
 * of that, and it would become the largest single file in this interface.
 *
 * Three rules hold this file together:
 *
 * 1. **The geometry has exactly one source.** `LINE_HEIGHT` and `PAD_TOP`
 *    below generate both the stylesheet and the marker arithmetic. A literal
 *    px value anywhere else would silently drift the highlight away from the
 *    line it claims to mark -- and a marker pointing at the wrong line is
 *    worse than no marker at all.
 * 2. **Every programmatic edit goes through `applyEdit`,** which uses
 *    `document.execCommand('insertText')`. It is a deprecated API and it is
 *    still the only way to change a textarea without destroying the browser's
 *    own undo stack. Undo is not a nicety here: the user is pasting code they
 *    do not fully understand, and Strg+Z is the first thing they will reach
 *    for. There is a manual fallback for the day it finally disappears.
 * 3. **Tab types, Escape releases.** Swallowing Tab is what makes indentation
 *    work and is also the classic way to trap a keyboard user inside a
 *    control. Escape arms the next Tab to move focus out again, and the hint
 *    line under the editor says so, because an affordance nobody can see is
 *    not an affordance.
 */

import { h, text, clear, on } from './dom.js';

const STYLE_ID = 'nos-editor-style';

/* The single source of the geometry. Both the CSS and the marker maths below
   are generated from these two numbers. */
const LINE_HEIGHT = 20;
const PAD_TOP = 8;

const INDENT = '  ';

/** Opening character -> the character typed in after it. */
const PAIRS = {
  '(': ')',
  '[': ']',
  '{': '}',
  "'": "'",
  '"': '"',
  '`': '`',
};

const CLOSERS = new Set([')', ']', '}', "'", '"', '`']);
const QUOTES = new Set(["'", '"', '`']);

/** After these, a quote is much more likely to be an apostrophe than a pair. */
const WORD_BEFORE = /[\w$À-ɏ]/;

/**
 * Build a code editor inside `container`.
 *
 * @param {HTMLElement} container emptied and filled; `destroy()` empties it again
 * @param {object} [options]
 * @param {string} [options.value] initial text
 * @param {(value: string) => void} [options.onChange] after every user edit
 * @param {(value: string) => void} [options.onSave] Strg/Cmd + S
 * @param {string} [options.label] accessible name of the text field
 * @param {string} [options.placeholder]
 * @param {boolean} [options.readOnly]
 * @returns {{
 *   element: HTMLElement,
 *   getValue: () => string,
 *   setValue: (value: string) => void,
 *   focus: () => void,
 *   setMarker: (line: number, message: string, opts?: object) => boolean,
 *   clearMarkers: () => void,
 *   revealLine: (line: number) => void,
 *   setReadOnly: (value: boolean) => void,
 *   destroy: () => void,
 * }}
 */
export function createEditor(container, options = {}) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new TypeError(
      'createEditor(): Es wurde kein Element übergeben, in das der Editor gebaut werden könnte.',
    );
  }
  ensureStyle();

  const opts = options || {};
  const cleanups = [];
  let markers = [];
  let lineCount = 0;
  /** Set by Escape: the next Tab leaves the field instead of indenting. */
  let tabReleased = false;
  let statusFrame = 0;
  let destroyed = false;

  /* ----------------------------------------------------------- the DOM */

  const numbers = h('div.nos-ed__nums', { 'aria-hidden': 'true' });
  const gutter = h('div.nos-ed__gutter', { 'aria-hidden': 'true' }, numbers);

  const area = h('textarea.nos-ed__area', {
    spellcheck: 'false',
    autocapitalize: 'off',
    autocorrect: 'off',
    autocomplete: 'off',
    wrap: 'off',
    'aria-label': opts.label || 'Quelltext des Moduls',
    placeholder: opts.placeholder || '',
  });
  if (opts.readOnly) area.readOnly = true;

  const marksInner = h('div.nos-ed__marks-inner');
  const marks = h('div.nos-ed__marks', { 'aria-hidden': 'true' }, marksInner);

  const body = h('div.nos-ed__body', null, gutter, area, marks);

  const position = h('span.nos-ed__pos');
  /**
   * Markers are drawn, so a screen reader would never learn about them; this
   * is the same information as text.
   */
  const live = h('span.nos-ed__live', { role: 'status', 'aria-live': 'polite' });
  const hint = h('span.nos-ed__hint', null, text(
    'Tabulator setzt zwei Leerzeichen · Esc, dann Tabulator verlässt das Feld · Strg/Cmd + S speichert',
  ));
  const foot = h('div.nos-ed__foot', null, position, h('span.nos-ed__gap'), hint, live);

  const root = h('div.nos-ed', null, body, foot);

  clear(container);
  container.appendChild(root);

  area.value = typeof opts.value === 'string' ? opts.value : '';
  renderNumbers();
  scheduleStatus();

  /* ------------------------------------------------------- text editing */

  /**
   * Replace `[start, end)` with `insert` and leave the selection where the
   * caller wants it. Goes through `execCommand` so the browser's undo history
   * stays intact -- see rule 2 in the header.
   */
  function applyEdit(start, end, insert, selStart, selEnd) {
    area.focus();
    area.setSelectionRange(start, end);

    let native = false;
    try {
      // `insertText` with an empty string is not a deletion in every browser,
      // so an empty insert (closing an auto-inserted pair with Backspace) goes
      // through `delete`, which is.
      native = insert === ''
        ? document.execCommand('delete')
        : document.execCommand('insertText', false, insert);
    } catch {
      native = false;
    }
    if (!native) {
      const value = area.value;
      area.value = value.slice(0, start) + insert + value.slice(end);
      // The manual path fires no `input` event, so the bookkeeping the input
      // handler normally does has to happen here instead.
      area.setSelectionRange(selStart, selEnd);
      afterEdit();
      return;
    }
    area.setSelectionRange(selStart, selEnd);
    scheduleStatus();
  }

  function afterEdit() {
    renderNumbers();
    if (markers.length) clearMarkers(); // a marker on text that moved is a lie
    scheduleStatus();
    if (typeof opts.onChange === 'function') opts.onChange(area.value);
  }

  function handleInput() {
    afterEdit();
  }

  /** Start index of the line containing `pos`. */
  function lineStartAt(value, pos) {
    return value.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
  }

  /** End index (exclusive, before the newline) of the line containing `pos`. */
  function lineEndAt(value, pos) {
    const next = value.indexOf('\n', pos);
    return next === -1 ? value.length : next;
  }

  function leadingWhitespace(line) {
    const match = /^[ \t]*/.exec(line);
    return match ? match[0] : '';
  }

  function handleTab(shift) {
    const value = area.value;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const multiline = value.slice(start, end).includes('\n');

    if (!shift && !multiline) {
      applyEdit(start, end, INDENT, start + INDENT.length, start + INDENT.length);
      return;
    }

    const blockStart = lineStartAt(value, start);
    const blockEnd = lineEndAt(value, end);
    const lines = value.slice(blockStart, blockEnd).split('\n');

    let firstDelta = 0;
    let totalDelta = 0;
    const changed = lines.map((line, index) => {
      if (shift) {
        const removed = /^ {1,2}|^\t/.exec(line);
        const cut = removed ? removed[0].length : 0;
        if (index === 0) firstDelta = -cut;
        totalDelta -= cut;
        return line.slice(cut);
      }
      if (index === 0) firstDelta = INDENT.length;
      totalDelta += INDENT.length;
      return INDENT + line;
    });

    if (totalDelta === 0) return; // nothing to outdent: leave the caret alone
    applyEdit(
      blockStart,
      blockEnd,
      changed.join('\n'),
      Math.max(blockStart, start + firstDelta),
      Math.max(blockStart, end + totalDelta),
    );
  }

  function handleEnter() {
    const value = area.value;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const current = value.slice(lineStartAt(value, start), start);
    const indent = leadingWhitespace(current);
    const before = start > 0 ? value[start - 1] : '';
    const after = value[end] || '';

    const opensBlock = before === '{' || before === '[' || before === '(';
    if (opensBlock && PAIRS[before] === after) {
      // Caret sits between a pair: put the closer on its own line, the way
      // every editor does, so the block is readable straight away.
      const insert = `\n${indent}${INDENT}\n${indent}`;
      const caret = start + 1 + indent.length + INDENT.length;
      applyEdit(start, end, insert, caret, caret);
      return;
    }
    const insert = opensBlock ? `\n${indent}${INDENT}` : `\n${indent}`;
    const caret = start + insert.length;
    applyEdit(start, end, insert, caret, caret);
  }

  /** @returns {boolean} true when the key was handled here. */
  function handlePair(key) {
    const value = area.value;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const closer = PAIRS[key];

    if (start !== end) {
      if (!closer) return false;
      // Wrap the selection and keep it selected, so wrapping twice works.
      const inner = value.slice(start, end);
      applyEdit(start, end, key + inner + closer, start + 1, end + 1);
      return true;
    }

    // Typing the closer that is already there: step over it rather than
    // producing `))`.
    if (CLOSERS.has(key) && value[start] === key) {
      area.setSelectionRange(start + 1, start + 1);
      scheduleStatus();
      return true;
    }
    if (!closer) return false;

    if (QUOTES.has(key)) {
      const before = start > 0 ? value[start - 1] : '';
      // `don't` must stay `don't`, and a quote right after a quote is almost
      // always the user closing one by hand.
      if (WORD_BEFORE.test(before) || before === key) return false;
    }
    const after = value[start] || '';
    // Only auto-close where a closer would not be in the way of real text.
    if (after && !/[\s)\]},;:]/.test(after)) return false;

    applyEdit(start, end, key + closer, start + 1, start + 1);
    return true;
  }

  function handleBackspace() {
    const value = area.value;
    const start = area.selectionStart;
    if (start !== area.selectionEnd || start === 0) return false;
    const before = value[start - 1];
    const after = value[start];
    if (!PAIRS[before] || PAIRS[before] !== after) return false;
    applyEdit(start - 1, start + 1, '', start - 1, start - 1);
    return true;
  }

  function handleKeyDown(event) {
    // While an input method is composing (dead keys, CJK), the keystrokes are
    // not characters yet and intercepting them mangles the composition.
    if (event.defaultPrevented || event.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;

    if (mod && !event.altKey && (event.key === 's' || event.key === 'S')) {
      // Without this the browser offers to save the whole page, which is both
      // useless and alarming.
      event.preventDefault();
      if (typeof opts.onSave === 'function') opts.onSave(area.value);
      return;
    }

    if (event.key === 'Escape') {
      // Not prevented: the application still closes its dialogs on Escape.
      if (!tabReleased) {
        tabReleased = true;
        announce('Der nächste Tabulator verlässt den Editor.');
      }
      return;
    }

    if (event.key === 'Tab') {
      if (tabReleased) {
        tabReleased = false;
        announce('');
        return; // let the browser move the focus
      }
      if (area.readOnly) return;
      event.preventDefault();
      handleTab(event.shiftKey);
      return;
    }

    tabReleased = false;
    if (area.readOnly || mod || event.altKey) return;

    if (event.key === 'Enter') {
      event.preventDefault();
      handleEnter();
      return;
    }
    if (event.key === 'Backspace') {
      if (handleBackspace()) event.preventDefault();
      return;
    }
    if (event.key.length === 1 && (PAIRS[event.key] || CLOSERS.has(event.key))) {
      if (handlePair(event.key)) event.preventDefault();
    }
  }

  function announce(message) {
    clear(live);
    if (message) live.appendChild(text(message));
  }

  /* ------------------------------------------------------- presentation */

  function renderNumbers() {
    const value = area.value;
    let count = 1;
    for (let i = value.indexOf('\n'); i !== -1; i = value.indexOf('\n', i + 1)) count += 1;
    if (count === lineCount) return;
    lineCount = count;

    const rows = new Array(count);
    for (let i = 0; i < count; i += 1) rows[i] = String(i + 1);
    clear(numbers);
    numbers.appendChild(text(rows.join('\n')));
    // The column has to be wide enough for the largest number, or the code
    // shifts sideways the moment the file crosses 100 lines.
    gutter.style.width = `${Math.max(2, rows[count - 1].length) + 1.6}ch`;
    renderMarks();
  }

  function syncScroll() {
    const offset = `translateY(${-area.scrollTop}px)`;
    numbers.style.transform = offset;
    marksInner.style.transform = offset;
  }

  function renderMarks() {
    clear(marksInner);
    for (const marker of markers) {
      const line = Math.min(Math.max(1, marker.line), lineCount);
      const band = h('div.nos-ed__mark', {
        'data-kind': marker.kind || 'error',
        style: { top: `${PAD_TOP + (line - 1) * LINE_HEIGHT}px` },
      });
      if (marker.message) {
        band.appendChild(h('span.nos-ed__mark-msg', { title: marker.message }, text(marker.message)));
      }
      marksInner.appendChild(band);
    }
  }

  function scheduleStatus() {
    if (statusFrame) return;
    statusFrame = requestAnimationFrame(() => {
      statusFrame = 0;
      if (destroyed) return;
      renderStatus();
      syncScroll();
    });
  }

  function renderStatus() {
    const value = area.value;
    const pos = area.selectionStart || 0;
    let line = 1;
    for (let i = value.indexOf('\n'); i !== -1 && i < pos; i = value.indexOf('\n', i + 1)) line += 1;
    const column = pos - lineStartAt(value, pos) + 1;
    clear(position);
    position.appendChild(text(`Zeile ${line}, Spalte ${column} · ${lineCount} Zeilen`));
  }

  /* ------------------------------------------------------------- public */

  function revealLine(line) {
    const target = Math.min(Math.max(1, Math.floor(line)), Math.max(1, lineCount));
    const top = (target - 1) * LINE_HEIGHT;
    const height = area.clientHeight || LINE_HEIGHT * 10;
    if (top < area.scrollTop || top + LINE_HEIGHT > area.scrollTop + height) {
      area.scrollTop = Math.max(0, top - Math.round(height / 2) + LINE_HEIGHT);
    }
    syncScroll();
  }

  function caretToLine(line) {
    const value = area.value;
    let index = 0;
    for (let i = 1; i < line; i += 1) {
      const next = value.indexOf('\n', index);
      if (next === -1) break;
      index = next + 1;
    }
    area.setSelectionRange(index, lineEndAt(value, index));
    scheduleStatus();
  }

  function setMarker(line, message, markerOptions = {}) {
    const target = Number(line);
    // A report without a line number is normal (a missing manifest has none).
    // Saying so by returning false is more use than marking line 1 at random.
    if (!Number.isFinite(target) || target < 1) return false;
    markers.push({
      line: Math.floor(target),
      message: message ? String(message) : '',
      kind: markerOptions.kind || 'error',
    });
    renderMarks();
    revealLine(target);
    if (markerOptions.focus) {
      area.focus();
      caretToLine(Math.floor(target));
    }
    return true;
  }

  function clearMarkers() {
    if (!markers.length) return;
    markers = [];
    renderMarks();
  }

  function setValue(value) {
    // No `onChange`: this is the program talking, not the user, and a view
    // that treats it as an edit will mark itself dirty the moment it loads.
    area.value = typeof value === 'string' ? value : '';
    markers = [];
    area.scrollTop = 0;
    area.scrollLeft = 0;
    lineCount = -1; // force a rebuild even when the count happens to match
    renderNumbers();
    scheduleStatus();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (statusFrame) cancelAnimationFrame(statusFrame);
    statusFrame = 0;
    for (const off of cleanups) {
      try { off(); } catch { /* listener already gone */ }
    }
    cleanups.length = 0;
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  cleanups.push(on(area, 'input', handleInput));
  cleanups.push(on(area, 'keydown', handleKeyDown));
  cleanups.push(on(area, 'scroll', syncScroll, { passive: true }));
  cleanups.push(on(area, 'keyup', scheduleStatus));
  cleanups.push(on(area, 'click', scheduleStatus));
  cleanups.push(on(area, 'blur', () => { tabReleased = false; announce(''); }));

  return {
    element: root,
    textarea: area,
    getValue: () => area.value,
    setValue,
    focus: () => area.focus(),
    setMarker,
    clearMarkers,
    revealLine,
    setReadOnly: (value) => { area.readOnly = !!value; },
    destroy,
  };
}

export default createEditor;

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS;
  document.head.appendChild(node);
}

const CSS = `
.nos-ed {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-2);
  overflow: hidden;
}
.nos-ed:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }

.nos-ed__body { position: relative; display: flex; flex: 1; min-height: 0; }

/* The mono font sits on the gutter itself, not only on the numbers: the
   width below is measured in \`ch\`, and \`ch\` resolves against THIS element's
   font. With the inherited sans font the column would be too narrow. */
.nos-ed__gutter {
  flex: 0 0 auto;
  overflow: hidden;
  padding: ${PAD_TOP}px 6px ${PAD_TOP}px 0;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  background: var(--surface-2);
  border-right: 1px solid var(--border);
  user-select: none;
}
.nos-ed__nums {
  font: inherit;
  line-height: ${LINE_HEIGHT}px;
  text-align: right;
  white-space: pre;
  color: var(--fg-subtle);
  will-change: transform;
}

.nos-ed__area {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: ${PAD_TOP}px var(--sp-2) ${PAD_TOP}px var(--sp-1);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  line-height: ${LINE_HEIGHT}px;
  tab-size: 2;
  color: var(--fg);
  background: transparent;
  border: 0;
  border-radius: 0;
  outline: none;
  resize: none;
  overflow: auto;
  white-space: pre;
  overflow-wrap: normal;
  z-index: 1;
}
.nos-ed__area::placeholder { color: var(--fg-subtle); }
.nos-ed__area:read-only { color: var(--fg-muted); background: var(--surface-2); }

/* The marker layer sits UNDER the text (z-index 0 against the textarea's 1),
   so a highlighted line keeps its normal, fully legible glyphs. */
.nos-ed__marks {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
}
.nos-ed__marks-inner { position: absolute; inset: 0; will-change: transform; }
.nos-ed__mark {
  position: absolute;
  left: 0;
  right: 0;
  height: ${LINE_HEIGHT}px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  background: var(--danger-soft);
  border-left: 3px solid var(--danger);
}
.nos-ed__mark[data-kind="warn"] { background: var(--surface-3); border-left-color: var(--warn); }
.nos-ed__mark[data-kind="info"] { background: var(--accent-soft); border-left-color: var(--accent); }
.nos-ed__mark-msg {
  max-width: 55%;
  padding: 0 var(--sp-1);
  font-family: var(--font-sans);
  font-size: var(--fs-xs);
  line-height: ${LINE_HEIGHT - 4}px;
  color: var(--danger);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nos-ed__mark[data-kind="warn"] .nos-ed__mark-msg { color: var(--warn); }
.nos-ed__mark[data-kind="info"] .nos-ed__mark-msg { color: var(--accent); }

.nos-ed__foot {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 3px var(--sp-1);
  font-size: var(--fs-xs);
  color: var(--fg-subtle);
  background: var(--surface-2);
  border-top: 1px solid var(--border);
}
.nos-ed__gap { flex: 1 1 auto; }
.nos-ed__pos { font-variant-numeric: tabular-nums; white-space: nowrap; }
.nos-ed__hint { text-align: right; }
.nos-ed__live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (max-width: 720px) {
  .nos-ed__hint { display: none; }
}
`;
