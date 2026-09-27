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

/* ================================================================== */
/* Der Notiz-Editor                                                    */
/* ================================================================== */

/**
 * createNoteEditor -- Markdown schreiben, als Teil des Wissensnetzes.
 *
 * Auch hier ein `<textarea>`, aus denselben Gruenden wie oben (Undo,
 * Einfuegen, Bildschirmtastatur, Vorlesen -- alles wie in jedem anderen
 * Feld), nur ohne Zeilennummern und mit Zeilenumbruch: eine Notiz ist Prosa.
 * Was dazu kommt, ist genau das, was eine Notiz mit dem Netz verbindet:
 *
 * - **"[[" oeffnet eine kleine Liste** passender Titel (Notizen, Projekte,
 *   Begriffe, Personen), "#" eine Liste der Schlagworte. Pfeile und Enter
 *   waehlen, Escape schliesst. Woher die Liste kommt, entscheidet der
 *   Aufrufer (`complete(art, anfrage)`), der Editor kennt keinen Server.
 * - **Tastenkuerzel:** Strg/Cmd+B fett, Strg/Cmd+I kursiv, Strg/Cmd+Enter
 *   und Strg/Cmd+S speichern. Enter setzt eine Liste fort (auch `- [ ]`),
 *   ein leerer Punkt beendet sie. Tab rueckt in einer Liste ein.
 * - **Werkzeugleiste** fuer alles, was man nicht auswendig weiss:
 *   Ueberschrift, Liste, Aufgabe, Zitat, Callout, Tabelle, Code, Bild.
 *
 * Kein Ruckeln bei 50.000 Zeichen: je Tastendruck passiert nur, was am
 * Cursor zu sehen ist (die 160 Zeichen davor werden auf "[[" und "#"
 * geprueft); Woerter zaehlen und Hoehe anpassen laufen gebremst.
 *
 * Die reinen Funktionen darunter (completionContext, applyCompletion,
 * wrapSelection, toggleLinePrefix, continueList) sind ohne Browser
 * pruefbar -- test/notizen-editor.test.js.
 */

const NOTE_STYLE_ID = 'nos-note-editor-style';

/** Ein Listenpunkt am Zeilenanfang: Einzug, Zeichen, Leerraum, ggf. `[ ] `. */
const LIST_MARKER_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(\[[ xX]\][ \t]+)?/;
const TAG_TAIL_RE = /(^|[\s(])#([\p{L}\p{N}_\-/]*)$/u;
const TAG_CHARS_RE = /^[\p{L}\p{N}_\-/]*/u;
const WORD_RE = /[\p{L}\p{N}_]/u;

/**
 * Steht der Cursor gerade in einem "[[" oder "#"?
 *
 * @param {string} value
 * @param {number} caret
 * @returns {{kind:'link'|'tag', start:number, query:string}|null}
 *   `start` ist der Anfang der Anfrage (hinter "[[" bzw. "#").
 */
export function completionContext(value, caret) {
  const v = String(value === null || value === undefined ? '' : value);
  const pos = Math.max(0, Math.min(Number(caret) || 0, v.length));
  const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
  const back = v.slice(Math.max(lineStart, pos - 160), pos);

  const open = back.lastIndexOf('[[');
  if (open !== -1) {
    const query = back.slice(open + 2);
    if (!query.includes(']') && !query.includes('[')) {
      return { kind: 'link', start: pos - query.length, query };
    }
  }
  const tag = TAG_TAIL_RE.exec(back);
  if (tag) {
    const query = tag[2];
    const start = pos - query.length;
    // "# " am Zeilenanfang ist eine Ueberschrift im Werden, kein Schlagwort.
    if (start - 1 === lineStart && !query) return null;
    return { kind: 'tag', start, query };
  }
  return null;
}

/**
 * Die gewaehlte Vervollstaendigung einsetzen.
 *
 * Alle Aenderungsfunktionen hier geben neben dem ganzen neuen Text auch den
 * kleinsten Ausschnitt zurueck, der sich aendert (`from..to` -> `insert`):
 * der Editor ersetzt nur den, damit Undo bei 50.000 Zeichen nicht einen
 * Schritt ueber alles macht.
 *
 * @returns {{value:string, caret:number, from:number, to:number, insert:string}}
 */
export function applyCompletion(value, ctx, insert) {
  const v = String(value === null || value === undefined ? '' : value);
  const caret = ctx.start + ctx.query.length;
  let end = caret;
  if (ctx.kind === 'link') {
    // Der Rest eines halb getippten Links hinter dem Cursor ("to]]") geht mit.
    const rest = /^[^\]\n]{0,80}\]\]/.exec(v.slice(caret, caret + 90));
    if (rest) end = caret + rest[0].length;
    const start = ctx.start - 2;
    const piece = `[[${String(insert).trim()}]]`;
    return { value: v.slice(0, start) + piece + v.slice(end), caret: start + piece.length, from: start, to: end, insert: piece };
  }
  const rest = TAG_CHARS_RE.exec(v.slice(caret, caret + 80));
  if (rest) end = caret + rest[0].length;
  const start = ctx.start - 1;
  const tag = String(insert).trim().replace(/^#/, '');
  const trailing = end >= v.length || !/\s/.test(v[end]) ? ' ' : '';
  const piece = `#${tag}${trailing}`;
  return { value: v.slice(0, start) + piece + v.slice(end), caret: start + piece.length, from: start, to: end, insert: piece };
}

/**
 * Auswahl mit `before`/`after` einfassen -- oder wieder loesen, wenn sie es
 * schon ist. Ohne Auswahl wird das Wort am Cursor genommen; steht er in
 * keinem, entsteht ein leeres Paar mit dem Cursor in der Mitte.
 * @returns {{value:string, start:number, end:number}}
 */
export function wrapSelection(value, start, end, before, after = before) {
  const v = String(value === null || value === undefined ? '' : value);
  let a = Math.max(0, Math.min(start, end, v.length));
  let b = Math.max(0, Math.min(Math.max(start, end), v.length));
  if (a === b) {
    while (a > 0 && WORD_RE.test(v[a - 1])) a -= 1;
    while (b < v.length && WORD_RE.test(v[b])) b += 1;
  }
  const sel = v.slice(a, b);
  if (sel.length >= before.length + after.length && sel.startsWith(before) && sel.endsWith(after)) {
    const inner = sel.slice(before.length, sel.length - after.length);
    return { value: v.slice(0, a) + inner + v.slice(b), start: a, end: a + inner.length, from: a, to: b, insert: inner };
  }
  if (a >= before.length && v.slice(a - before.length, a) === before && v.slice(b, b + after.length) === after) {
    const s = a - before.length;
    return { value: v.slice(0, s) + sel + v.slice(b + after.length), start: s, end: s + sel.length, from: s, to: b + after.length, insert: sel };
  }
  const piece = before + sel + after;
  return { value: v.slice(0, a) + piece + v.slice(b), start: a + before.length, end: a + before.length + sel.length, from: a, to: b, insert: piece };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Jeder Zeile der Auswahl ein Praefix geben ("- ", "## ", "> ") -- oder es
 * nehmen, wenn alle es schon haben. Leere Zeilen bleiben leer.
 *
 * @param {object} [opts]
 * @param {RegExp} [opts.pattern] erkennt das Praefix (Standard: genau `prefix`)
 * @param {RegExp} [opts.clear]   wird vor dem Setzen entfernt (etwa eine andere Ueberschriftsebene)
 * @param {boolean} [opts.ordered] nummerieren statt `prefix`
 * @returns {{value:string, start:number, end:number}}
 */
export function toggleLinePrefix(value, start, end, prefix, opts = {}) {
  const v = String(value === null || value === undefined ? '' : value);
  const a = Math.max(0, Math.min(start, end, v.length));
  let b = Math.max(0, Math.min(Math.max(start, end), v.length));
  if (b > a && v[b - 1] === '\n') b -= 1;
  const lineStart = v.lastIndexOf('\n', a - 1) + 1;
  const nl = v.indexOf('\n', b);
  const lineEnd = nl === -1 ? v.length : nl;
  const pattern = opts.pattern instanceof RegExp ? opts.pattern : new RegExp(`^${escapeRe(prefix)}`);
  const lines = v.slice(lineStart, lineEnd).split('\n');
  const voll = lines.filter((l) => l.trim());
  const alle = voll.length > 0 && voll.every((l) => pattern.test(l));
  let n = 1;
  const out = lines.map((line) => {
    // Leere Zeilen in einer Mehrzeilen-Auswahl bleiben leer; eine einzelne
    // leere Zeile ist der Anfang einer Liste.
    if (!line.trim() && lines.length > 1) return line;
    if (alle) return line.replace(pattern, '');
    const base = opts.clear instanceof RegExp ? line.replace(opts.clear, '') : line;
    const mark = opts.ordered ? `${n++}. ` : prefix;
    return mark + base;
  });
  const block = out.join('\n');
  const next = v.slice(0, lineStart) + block + v.slice(lineEnd);
  const base = { value: next, from: lineStart, to: lineEnd, insert: block };
  if (start === end) {
    const delta = out[0].length - lines[0].length;
    const caret = Math.max(lineStart, Math.min(a + delta, lineStart + block.length));
    return { ...base, start: caret, end: caret };
  }
  return { ...base, start: lineStart, end: lineStart + block.length };
}

/**
 * Enter in einer Liste: den naechsten Punkt beginnen (nummeriert weiter,
 * Aufgabe bleibt Aufgabe). Ein leerer Punkt beendet die Liste.
 * @returns {{start:number, end:number, insert:string, caret:number}|null}
 */
export function continueList(value, caret) {
  const v = String(value === null || value === undefined ? '' : value);
  const pos = Math.max(0, Math.min(Number(caret) || 0, v.length));
  const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
  const nl = v.indexOf('\n', pos);
  const lineEnd = nl === -1 ? v.length : nl;
  const line = v.slice(lineStart, pos);
  const m = LIST_MARKER_RE.exec(line);
  if (!m) return null;
  const content = line.slice(m[0].length);
  if (!content.trim() && !v.slice(pos, lineEnd).trim()) {
    return { start: lineStart, end: lineEnd, insert: '', caret: lineStart };
  }
  let marker = m[2];
  if (/^\d/.test(marker)) marker = `${parseInt(marker, 10) + 1}${marker.slice(-1)}`;
  const insert = `\n${m[1]}${marker} ${m[4] ? '[ ] ' : ''}`;
  return { start: pos, end: pos, insert, caret: pos + insert.length };
}

/** Woerter und Zeichen -- fuer die Fusszeile. */
export function countText(value) {
  const v = String(value === null || value === undefined ? '' : value);
  const words = v.match(/\S+/g);
  return { words: words ? words.length : 0, chars: v.length };
}

const NOTE_GLYPH = {
  heading: '<path d="M5 4v12M15 4v12M5 10h10"/>',
  bold: '<path d="M6.5 4h5a3 3 0 0 1 0 6h-5zM6.5 10h6a3 3 0 0 1 0 6h-6z"/>',
  italic: '<path d="M11.5 4h4M4.5 16h4M12.5 4l-5 12"/>',
  list: '<path d="M7.6 5.6h9M7.6 10h9M7.6 14.4h9"/><path d="M3.6 5.6h.01M3.6 10h.01M3.6 14.4h.01" stroke-width="2.2"/>',
  ordered: '<path d="M8 5.6h8.6M8 10h8.6M8 14.4h8.6"/><path d="M3.6 4.4h1.2v2.8M3.4 7.2h1.8M3.4 11.6h2l-2 2.4h2.2"/>',
  task: '<rect x="3.2" y="3.2" width="13.6" height="13.6" rx="3"/><path d="m6.6 10.2 2.4 2.4 4.6-5"/>',
  quote: '<path d="M5 6.5h4v4H5zM11 6.5h4v4h-4zM9 10.5c0 2-1 3-3 3.4M15 10.5c0 2-1 3-3 3.4"/>',
  callout: '<circle cx="10" cy="10" r="7.4"/><path d="M10 9.2v4.4M10 6.5h.01"/>',
  table: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 8.5h14M3 12h14M8.5 8.5V16M12.5 8.5V16"/>',
  code: '<path d="m7 6-4 4 4 4M13 6l4 4-4 4"/>',
  link: '<path d="M8.4 11.6a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-1 1M11.6 8.4a3 3 0 0 0-4.2 0l-2.3 2.3a3 3 0 0 0 4.2 4.2l1-1"/>',
  image: '<rect x="3" y="4" width="14" height="12" rx="2"/><circle cx="7.5" cy="8" r="1.4"/><path d="m3.5 14.5 4-4 3 3 2.5-2.5 3.5 3.5"/>',
  note: '<path d="M5.4 2.7h5.9l3.9 3.9v9.1a1.6 1.6 0 0 1-1.6 1.6H5.4a1.6 1.6 0 0 1-1.6-1.6V4.3a1.6 1.6 0 0 1 1.6-1.6z"/><path d="M11.1 2.9v3.9h3.9"/>',
  project: '<path d="M2.6 6a1.8 1.8 0 0 1 1.8-1.8h3.1l1.8 2h6.3a1.8 1.8 0 0 1 1.8 1.8v6.6a1.8 1.8 0 0 1-1.8 1.8H4.4a1.8 1.8 0 0 1-1.8-1.8z"/>',
  person: '<circle cx="10" cy="6.8" r="3"/><path d="M4.2 16.6a5.8 5.8 0 0 1 11.6 0"/>',
  term: '<circle cx="10" cy="10" r="3.2"/><path d="M10 2.6v2.4M10 15v2.4M2.6 10H5M15 10h2.4"/>',
  tag: '<path d="M3.4 9.2V4.6a1.2 1.2 0 0 1 1.2-1.2h4.6l7.4 7.4-5.8 5.8z"/><circle cx="7" cy="7" r="1" fill="currentColor" stroke="none"/>',
};

/** Das Symbol fuer einen Vorschlag in der Liste, nach Art des Eintrags. */
function glyphFor(item) {
  if (item.tag !== undefined) return NOTE_GLYPH.tag;
  if (item.type === 'project') return NOTE_GLYPH.project;
  if (item.kind === 'person') return NOTE_GLYPH.person;
  if (item.type === 'entity') return NOTE_GLYPH.term;
  if (item.type === 'task') return NOTE_GLYPH.task;
  return NOTE_GLYPH.note;
}

/**
 * Text im Feld ersetzen, mit Undo-Verlauf (siehe applyEdit oben).
 * @returns {boolean} true, wenn der Browser es selbst gemacht hat (dann kommt ein input-Ereignis)
 */
function replaceRange(area, start, end, insert, selStart, selEnd) {
  area.focus();
  area.setSelectionRange(start, end);
  let native = false;
  try {
    native = insert === '' && start !== end
      ? document.execCommand('delete')
      : document.execCommand('insertText', false, insert);
  } catch {
    native = false;
  }
  if (!native) {
    const value = area.value;
    area.value = value.slice(0, start) + insert + value.slice(end);
  }
  area.setSelectionRange(selStart, selEnd);
  return native;
}

/**
 * @param {HTMLElement} container
 * @param {object} [options]
 * @param {string} [options.value]
 * @param {string} [options.placeholder]
 * @param {string} [options.label]
 * @param {(value:string)=>void} [options.onChange]
 * @param {(value:string)=>void} [options.onSave]   Strg/Cmd+Enter, Strg/Cmd+S
 * @param {(kind:'link'|'tag', query:string)=>Promise<Array<object>>} [options.complete]
 *        Vorschlaege: {title, hint?, type?, kind?} fuer Links, {tag, anzahl?} fuer Schlagworte
 * @param {(file:File)=>Promise<string>} [options.onImage] gibt das Markdown fuer ein Bild zurueck
 * @param {boolean} [options.toolbar]  Standard true
 * @param {number} [options.minRows]   Standard 10
 */
export function createNoteEditor(container, options = {}) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new TypeError('createNoteEditor(): Es wurde kein Element übergeben, in das der Editor gebaut werden könnte.');
  }
  ensureNoteStyle();
  const opts = options || {};
  const cleanups = [];
  let destroyed = false;
  let statusTimer = 0;
  let growFrame = 0;
  let popup = null; // { ctx, items, active, token }
  let completeToken = 0;
  let completeTimer = 0;

  /* ------------------------------------------------------------ DOM */

  const area = h('textarea.nos-ne__area', {
    'aria-label': opts.label || 'Text der Notiz',
    placeholder: opts.placeholder || 'Schreib los. [[ verknüpft mit einem Eintrag, # setzt ein Schlagwort.',
    spellcheck: 'true',
    autocapitalize: 'sentences',
    rows: String(opts.minRows || 10),
  });
  const mirror = h('div.nos-ne__mirror', { 'aria-hidden': 'true' });
  const list = h('ul.nos-ne__list', { role: 'listbox', 'aria-label': 'Vorschläge', hidden: true });
  const body = h('div.nos-ne__body', null, area, mirror, list);

  const counter = h('span.nos-ne__count');
  const hint = h('span.nos-ne__hint', null, text('Strg+B fett · Strg+I kursiv · [[ verknüpft · # Schlagwort · Strg+Enter speichert'));
  const foot = h('div.nos-ne__foot', null, counter, h('span.nos-ne__gap'), hint);

  const tools = opts.toolbar === false ? null : h('div.nos-ne__tools', { role: 'toolbar', 'aria-label': 'Formatierung' });
  const root = h('div.nos-ne', null, tools, body, foot);
  clear(container);
  container.appendChild(root);

  area.value = typeof opts.value === 'string' ? opts.value : '';

  /* ------------------------------------------------- Werkzeugleiste */

  const fileInput = h('input.nos-ne__file', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/avif', tabindex: '-1', 'aria-hidden': 'true' });

  function tool(name, label, run, extra = {}) {
    const b = h('button.nos-ne__tool', {
      type: 'button',
      title: extra.title || label,
      'aria-label': label,
      dataset: { tool: name },
      onMousedown: (e) => e.preventDefault(), // der Cursor bleibt im Text
      onClick: run,
    }, icon(NOTE_GLYPH[name]));
    return b;
  }

  const actions = {
    heading: () => lines('## ', { pattern: /^##\s/, clear: /^#{1,6}\s+/ }),
    bold: () => wrap('**'),
    italic: () => wrap('*'),
    list: () => lines('- ', { pattern: /^[-*+]\s(?!\[)/, clear: /^(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/ }),
    ordered: () => lines('1. ', { ordered: true, pattern: /^\d{1,9}[.)]\s/, clear: /^(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/ }),
    task: () => lines('- [ ] ', { pattern: /^[-*+]\s\[[ xX]\]\s/, clear: /^(?:[-*+]|\d{1,9}[.)])\s+/ }),
    quote: () => lines('> ', { pattern: /^>\s?/ }),
    callout: () => block('> [!info] Titel\n> Text des Hinweises', 9, 14),
    table: () => block('| Spalte | Spalte |\n| --- | --- |\n| Wert | Wert |', 2, 8),
    code: () => block('```\nCode\n```', 4, 8),
    link: () => insertLink(),
    image: () => fileInput.click(),
  };

  if (tools) {
    const groups = [
      [['heading', 'Überschrift'], ['bold', 'Fett (Strg+B)'], ['italic', 'Kursiv (Strg+I)']],
      [['list', 'Liste'], ['ordered', 'Nummerierte Liste'], ['task', 'Aufgabe']],
      [['quote', 'Zitat'], ['callout', 'Hinweis (Callout)'], ['table', 'Tabelle'], ['code', 'Code']],
      [['link', 'Verknüpfung [[ ]]'], ['image', 'Bild einfügen']],
    ];
    groups.forEach((group, i) => {
      if (i) tools.appendChild(h('span.nos-ne__sep', { 'aria-hidden': 'true' }));
      for (const [name, label] of group) {
        if (name === 'image' && typeof opts.onImage !== 'function') continue;
        tools.appendChild(tool(name, label, actions[name]));
      }
    });
    if (typeof opts.onImage === 'function') tools.appendChild(fileInput);
  }

  /* ---------------------------------------------------- Bearbeiten */

  function edit(start, end, insert, selStart, selEnd) {
    const native = replaceRange(area, start, end, insert, selStart, selEnd);
    if (!native) afterInput();
  }

  /** Nur den Ausschnitt ersetzen, den die reine Funktion nennt (siehe applyCompletion). */
  function apply(r) {
    if (area.value.slice(r.from, r.to) === r.insert) { area.setSelectionRange(r.start, r.end); return; }
    edit(r.from, r.to, r.insert, r.start, r.end);
  }

  function wrap(mark) {
    apply(wrapSelection(area.value, area.selectionStart, area.selectionEnd, mark));
  }

  function lines(prefix, o) {
    apply(toggleLinePrefix(area.value, area.selectionStart, area.selectionEnd, prefix, o));
  }

  /** Einen Block auf eigener Zeile einfuegen; `selA..selB` markiert den Platzhalter. */
  function block(template, selA, selB) {
    const v = area.value;
    const pos = area.selectionStart;
    const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
    const before = pos > lineStart ? '\n\n' : (pos >= 2 && v.slice(pos - 2, pos) !== '\n\n' && pos > 0 ? '\n' : '');
    const after = pos < v.length && v[pos] !== '\n' ? '\n\n' : (v[pos] === '\n' && v[pos + 1] !== '\n' ? '\n' : '');
    const insert = before + template + after;
    const base = pos + before.length;
    edit(pos, area.selectionEnd, insert, base + selA, base + selB);
  }

  function insertLink() {
    const s = area.selectionStart;
    const e = area.selectionEnd;
    const sel = area.value.slice(s, e);
    if (sel && !sel.includes('\n')) {
      edit(s, e, `[[${sel}]]`, s + 2, s + 2 + sel.length);
      return;
    }
    edit(s, e, '[[', s + 2, s + 2);
    scheduleComplete();
  }

  function insertText(piece, { newline = false } = {}) {
    const pos = area.selectionStart;
    const v = area.value;
    let insert = String(piece);
    if (newline) {
      const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
      if (pos > lineStart) insert = `\n${insert}`;
      if (v[pos] !== undefined && v[pos] !== '\n') insert = `${insert}\n`;
    }
    edit(pos, area.selectionEnd, insert, pos + insert.length, pos + insert.length);
  }

  async function takeImages(files) {
    if (typeof opts.onImage !== 'function') return false;
    const bilder = Array.from(files || []).filter((f) => f && /^image\//.test(f.type));
    if (!bilder.length) return false;
    for (const file of bilder) {
      try {
        const md = await opts.onImage(file);
        if (destroyed) return true;
        if (typeof md === 'string' && md) insertText(md, { newline: true });
      } catch {
        /* der Aufrufer meldet den Fehler selbst (Toast) */
      }
    }
    return true;
  }

  /* --------------------------------------------- Vervollstaendigung */

  function closePopup() {
    popup = null;
    completeToken += 1;
    list.hidden = true;
    clear(list);
    area.removeAttribute('aria-activedescendant');
    area.setAttribute('aria-expanded', 'false');
  }

  function scheduleComplete() {
    clearTimeout(completeTimer);
    completeTimer = setTimeout(runComplete, 60);
  }

  async function runComplete() {
    if (destroyed || typeof opts.complete !== 'function') return;
    const ctx = completionContext(area.value, area.selectionStart);
    if (!ctx || area.selectionStart !== area.selectionEnd) { if (popup) closePopup(); return; }
    const token = ++completeToken;
    let items = [];
    try {
      items = await opts.complete(ctx.kind, ctx.query);
    } catch {
      items = [];
    }
    if (destroyed || token !== completeToken) return;
    // Waehrenddessen weitergetippt? Dann gilt der neue Lauf.
    const now = completionContext(area.value, area.selectionStart);
    if (!now || now.kind !== ctx.kind || now.start !== ctx.start) return;
    items = Array.isArray(items) ? items.slice(0, 8) : [];
    if (!items.length && !ctx.query) { if (popup) closePopup(); return; }
    popup = { ctx: now, items, active: 0 };
    renderPopup();
  }

  function renderPopup() {
    if (!popup) return;
    clear(list);
    const { ctx, items, active } = popup;
    if (!items.length) {
      list.appendChild(h('li.nos-ne__item.is-empty', { role: 'presentation' },
        text(ctx.kind === 'link' ? `Kein Eintrag „${ctx.query}“ – so steht der Link, bis du ihn anlegst.` : 'Neues Schlagwort')));
    }
    items.forEach((item, i) => {
      const label = item.tag !== undefined ? `#${item.tag}` : String(item.title || '');
      const hintText = item.tag !== undefined
        ? (Number.isFinite(item.anzahl) ? `${item.anzahl}×` : '')
        : String(item.art || item.hint || '');
      list.appendChild(h('li.nos-ne__item', {
        id: `nos-ne-opt-${i}`,
        role: 'option',
        'aria-selected': i === active ? 'true' : 'false',
        class: i === active ? 'is-active' : '',
        onMousedown: (e) => e.preventDefault(),
        onClick: () => choose(i),
        onMousemove: () => { if (popup && popup.active !== i) { popup.active = i; renderPopup(); } },
      },
      h('span.nos-ne__item-icon', { 'aria-hidden': 'true' }, icon(glyphFor(item))),
      h('span.nos-ne__item-label', null, text(label)),
      hintText ? h('span.nos-ne__item-hint', null, text(hintText)) : null));
    });
    list.hidden = false;
    area.setAttribute('aria-expanded', 'true');
    if (items.length) area.setAttribute('aria-activedescendant', `nos-ne-opt-${active}`);
    placePopup(ctx.start - (ctx.kind === 'link' ? 2 : 1));
  }

  /** Die Liste unter den Anfang von "[[" bzw. "#" setzen -- gemessen am Spiegel. */
  function placePopup(index) {
    const style = getComputedStyle(area);
    for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'padding', 'borderWidth', 'boxSizing', 'whiteSpace', 'wordBreak', 'overflowWrap', 'tabSize']) {
      mirror.style[prop] = style[prop];
    }
    mirror.style.width = `${area.clientWidth}px`;
    clear(mirror);
    mirror.appendChild(text(area.value.slice(0, index)));
    const marker = h('span', null, text('​'));
    mirror.appendChild(marker);
    mirror.appendChild(text(area.value.slice(index, index + 1) || '.'));
    const top = marker.offsetTop + marker.offsetHeight - area.scrollTop;
    const left = marker.offsetLeft;
    const maxLeft = Math.max(0, body.clientWidth - Math.min(360, body.clientWidth) - 4);
    list.style.top = `${Math.max(0, top + 4)}px`;
    list.style.left = `${Math.min(left, maxLeft)}px`;
  }

  function choose(i) {
    if (!popup) return;
    const item = popup.items[i];
    const ctx = popup.ctx;
    let insert;
    if (!item) {
      // Kein Vorschlag: was getippt wurde, wird der Link / das Schlagwort.
      if (!ctx.query.trim()) return;
      insert = ctx.query.trim();
    } else {
      insert = item.tag !== undefined ? item.tag : item.title;
    }
    const r = applyCompletion(area.value, ctx, insert);
    closePopup();
    edit(r.from, r.to, r.insert, r.caret, r.caret);
  }

  /* ------------------------------------------------------- Tasten */

  function handleKeyDown(event) {
    if (event.defaultPrevented || event.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;

    if (popup) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const n = popup.items.length;
        if (n) {
          popup.active = (popup.active + (event.key === 'ArrowDown' ? 1 : n - 1)) % n;
          renderPopup();
        }
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (popup.items.length || popup.ctx.query.trim()) {
          event.preventDefault();
          event.stopPropagation();
          choose(popup.active);
          return;
        }
        closePopup();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePopup();
        return;
      }
    }

    if (mod && !event.altKey) {
      const k = event.key.toLowerCase();
      if (k === 'enter' || k === 's') {
        event.preventDefault();
        if (typeof opts.onSave === 'function') opts.onSave(area.value);
        return;
      }
      if (k === 'b' && !event.shiftKey) { event.preventDefault(); actions.bold(); return; }
      if (k === 'i' && !event.shiftKey) { event.preventDefault(); actions.italic(); return; }
      return;
    }
    if (event.altKey) return;

    if (event.key === 'Enter' && !event.shiftKey) {
      const r = continueList(area.value, area.selectionStart);
      if (r && area.selectionStart === area.selectionEnd) {
        event.preventDefault();
        edit(r.start, r.end, r.insert, r.caret, r.caret);
      }
      return;
    }
    if (event.key === 'Tab') {
      const v = area.value;
      const pos = area.selectionStart;
      const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
      const nl = v.indexOf('\n', pos);
      const lineEnd = nl === -1 ? v.length : nl;
      const line = v.slice(lineStart, lineEnd);
      if (!LIST_MARKER_RE.test(line)) return; // Tab verlaesst das Feld, wie in jedem Textfeld
      event.preventDefault();
      if (event.shiftKey) {
        const cut = /^ {1,2}|^\t/.exec(line);
        if (!cut) return;
        edit(lineStart, lineStart + cut[0].length, '', Math.max(lineStart, pos - cut[0].length), Math.max(lineStart, area.selectionEnd - cut[0].length));
      } else {
        edit(lineStart, lineStart, INDENT, pos + INDENT.length, area.selectionEnd + INDENT.length);
      }
    }
  }

  /* --------------------------------------------------------- Status */

  function afterInput() {
    scheduleGrow();
    scheduleStatus();
    if (typeof opts.onChange === 'function') opts.onChange(area.value);
    scheduleComplete();
  }

  function scheduleGrow() {
    if (growFrame) return;
    growFrame = requestAnimationFrame(() => {
      growFrame = 0;
      if (destroyed) return;
      grow();
    });
  }

  function grow() {
    area.style.height = 'auto';
    area.style.height = `${Math.max(area.scrollHeight, 0)}px`;
  }

  function scheduleStatus() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      if (destroyed) return;
      const { words, chars } = countText(area.value);
      clear(counter);
      counter.appendChild(text(`${words.toLocaleString('de-DE')} ${words === 1 ? 'Wort' : 'Wörter'} · ${chars.toLocaleString('de-DE')} Zeichen`));
    }, 150);
  }

  function setValue(value) {
    area.value = typeof value === 'string' ? value : '';
    closePopup();
    grow();
    scheduleStatus();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(statusTimer);
    clearTimeout(completeTimer);
    if (growFrame) cancelAnimationFrame(growFrame);
    for (const off of cleanups) {
      try { off(); } catch { /* schon weg */ }
    }
    cleanups.length = 0;
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  cleanups.push(on(area, 'input', afterInput));
  cleanups.push(on(area, 'keydown', handleKeyDown));
  cleanups.push(on(area, 'blur', () => { setTimeout(() => { if (!destroyed && document.activeElement !== area) closePopup(); }, 120); }));
  cleanups.push(on(area, 'click', () => { if (popup) scheduleComplete(); }));
  cleanups.push(on(area, 'paste', (event) => {
    const files = event.clipboardData && event.clipboardData.files;
    if (files && files.length && Array.from(files).some((f) => /^image\//.test(f.type))) {
      event.preventDefault();
      takeImages(files);
    }
  }));
  cleanups.push(on(area, 'drop', (event) => {
    const files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length && Array.from(files).some((f) => /^image\//.test(f.type))) {
      event.preventDefault();
      takeImages(files);
    }
  }));
  cleanups.push(on(fileInput, 'change', () => {
    takeImages(fileInput.files);
    fileInput.value = '';
  }));

  area.setAttribute('aria-autocomplete', 'list');
  area.setAttribute('aria-expanded', 'false');
  grow();
  scheduleStatus();
  // Erst sichtbar, dann messen: im Blatt haengt die Hoehe an der Breite.
  requestAnimationFrame(() => { if (!destroyed) grow(); });

  return {
    element: root,
    textarea: area,
    getValue: () => area.value,
    setValue,
    focus: () => area.focus(),
    insertText,
    closePopup,
    /** Fuer Pruefungen: die offene Vorschlagsliste. */
    get popup() { return popup ? { kind: popup.ctx.kind, query: popup.ctx.query, items: popup.items.slice(), active: popup.active } : null; },
    actions,
    destroy,
  };
}

function ensureNoteStyle() {
  if (typeof document === 'undefined' || document.getElementById(NOTE_STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = NOTE_STYLE_ID;
  node.textContent = NOTE_CSS;
  document.head.appendChild(node);
}

const NOTE_CSS = `
.nos-ne { display: flex; flex-direction: column; min-width: 0; }
.nos-ne__tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 4px 0 8px;
  border-bottom: 1px solid var(--border);
}
.nos-ne__tool {
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 30px;
  padding: 0;
  color: var(--fg-muted);
  background: none;
  border: 0;
  border-radius: var(--r-1);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
}
.nos-ne__tool:hover { color: var(--fg); background: var(--surface-3); }
.nos-ne__tool:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.nos-ne__tool svg { width: 17px; height: 17px; }
.nos-ne__sep { width: 1px; height: 18px; margin: 0 6px; background: var(--border); }
.nos-ne__file { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.nos-ne__body { position: relative; min-width: 0; }
.nos-ne__area {
  display: block;
  width: 100%;
  min-height: 260px;
  margin: 0;
  padding: 14px 0 20px;
  font-family: var(--font-sans);
  font-size: var(--fs-md);
  line-height: 1.7;
  color: var(--fg);
  background: transparent;
  border: 0;
  border-radius: 0;
  outline: none;
  resize: none;
  overflow: hidden;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}
.nos-ne__area::placeholder { color: var(--fg-subtle); }
.nos-ne__mirror {
  position: absolute;
  top: 0;
  left: 0;
  visibility: hidden;
  pointer-events: none;
  overflow: hidden;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  height: 0;
}
.nos-ne__list {
  position: absolute;
  z-index: 8;
  width: min(360px, 100%);
  max-height: 264px;
  margin: 0;
  padding: 4px;
  overflow-y: auto;
  list-style: none;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-2);
  box-shadow: var(--shadow-2);
  animation: nos-ne-rise var(--dur-1) var(--ease);
}
@keyframes nos-ne-rise { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
.nos-ne__item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 32px;
  padding: 4px 8px;
  font-size: var(--fs-sm);
  color: var(--fg);
  border-radius: 7px;
  cursor: pointer;
}
.nos-ne__item.is-active { background: var(--accent-soft); color: var(--accent-text); }
.nos-ne__item.is-empty { color: var(--fg-subtle); cursor: default; }
.nos-ne__item-icon { display: inline-flex; flex: none; color: var(--fg-subtle); }
.nos-ne__item.is-active .nos-ne__item-icon { color: inherit; }
.nos-ne__item-icon svg { width: 15px; height: 15px; }
.nos-ne__item-label { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.nos-ne__item-hint { flex: none; font-size: var(--fs-xs); color: var(--fg-subtle); }
.nos-ne__item.is-active .nos-ne__item-hint { color: inherit; opacity: 0.8; }
.nos-ne__foot {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 8px 0 0;
  font-size: var(--fs-xs);
  color: var(--fg-subtle);
  border-top: 1px solid var(--border);
}
.nos-ne__gap { flex: 1 1 auto; }
.nos-ne__count { font-variant-numeric: tabular-nums; white-space: nowrap; }
.nos-ne__hint { text-align: right; }
@media (max-width: 720px) {
  .nos-ne__hint { display: none; }
  .nos-ne__tool { width: var(--tap-min); height: 36px; }
}
`;
