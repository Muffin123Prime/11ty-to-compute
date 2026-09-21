/**
 * views/study.js -- "Lernen": eine Karte zur Zeit, mit der Tastatur.
 *
 * The decisions behind it
 * -----------------------
 * 1. **One card, large, and nothing else.** Studying is the one activity in
 *    this application that is done for twenty cards in a row, so everything
 *    that is not this card -- lists, counters, side panels -- is left out. The
 *    only permanent numbers on the screen are the honest progress ("3 von 12")
 *    and, when it applies, how many cards are coming back today.
 * 2. **The four buttons say when the card returns, and that has to be true.**
 *    The intervals are not computed here. They come from the server, which
 *    computes them with the very function that will later apply them
 *    (`schedule()` in src/study/cards.js). A second implementation in the
 *    browser would agree with the first until the day it did not, and the one
 *    piece of feedback that helps while grading would quietly become a lie.
 * 3. **The keyboard is the interface.** Space reveals the back, 1-4 grade.
 *    Whoever studies does not want to click, and a mouse-only deck is a deck
 *    nobody finishes. The buttons carry their key, so the shortcut is learned
 *    by using it rather than by reading a help page.
 * 4. **No streak, no points, no confetti.** docs/IDEEN.md rules gamification
 *    out explicitly, and a spaced-repetition schedule is the one place where a
 *    streak actively does damage: it rewards answering rather than knowing.
 *    The end of a session is a statement of fact -- what was answered, what is
 *    coming back, when the next card is due.
 * 5. **An empty deck is a result, not a blank page.** "Heute ist nichts
 *    fällig" plus the day the next card arrives is an answer. Next to it are
 *    the two ways to get cards: by hand, and from a note -- where the
 *    proposals are shown and ticked, never created behind the user's back.
 * 6. **"Nochmal" really means today.** A card graded 0 goes back to the end of
 *    this session's queue instead of disappearing until tomorrow, and the
 *    progress line says how many are waiting to come round again. Counting it
 *    as "done" would be the flattering version of the truth.
 */

import {
  h, text, clear, on, icon, formatDate, formatNumber,
} from '../lib/dom.js';

const STYLE_ID = 'nos-study-view-style';

const VIEW_ICON = '<path d="M3.2 5.1h5.3a2 2 0 0 1 1.5.7 2 2 0 0 1 1.5-.7h5.3v9.4h-5.3a2 2 0 0 0-1.5.7 2 2 0 0 0-1.5-.7H3.2z"/><path d="M10 5.8v9.4"/>';

const ICONS = {
  plus: '<path d="M10 4.4v11.2M4.4 10h11.2"/>',
  note: '<path d="M5.2 3.4h7l3 3v10.2h-10z"/><path d="M12.2 3.4v3.2h3M7.4 9.6h5.2M7.4 12.4h5.2"/>',
  back: '<path d="M16.2 10H4.8M9 5.8 4.8 10 9 14.2"/>',
  refresh: '<path d="M16.6 10a6.6 6.6 0 1 1-2.1-4.8"/><path d="M16.9 3v3.7h-3.7"/>',
  check: '<path d="m4.2 10.6 3.9 3.9 7.7-8.9"/>',
  alert: '<path d="M10 3.2 17.5 16.4h-15z"/><path d="M10 8.2v3.5M10 13.9h.01"/>',
};

/** Key 1..4 on the keyboard, grade 0..3 in the schedule. */
const GRADE_KEYS = ['1', '2', '3', '4'];

const SESSION_LIMIT = 20;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function errorMessage(err) {
  if (!err) return 'Unbekannter Fehler.';
  if (err.message) return err.message;
  return String(err);
}

/**
 * `due` is a calendar day (`2026-09-28`), not a timestamp. Parsing it with
 * `new Date(...)` would read it as UTC midnight and show the day before in
 * every timezone west of Greenwich, so the parts are assembled by hand.
 */
function dayToDate(key) {
  if (typeof key !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function todayKey() {
  const now = new Date();
  const pad = (n) => (n < 10 ? `0${n}` : String(n));
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function daysBetween(key) {
  const target = dayToDate(key);
  const today = dayToDate(todayKey());
  if (!target || !today) return null;
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/** "heute" / "morgen" / "am Montag, 28. September". */
function dayLabel(key) {
  const delta = daysBetween(key);
  if (delta === null) return '';
  if (delta <= 0) return 'heute';
  if (delta === 1) return 'morgen';
  const date = dayToDate(key);
  return `am ${formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}`;
}

function plural(count, one, many) {
  return count === 1 ? one : many;
}

function isTyping(node) {
  if (!node || !node.tagName) return false;
  const tag = node.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable;
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

let view = null;

export default {
  id: 'study',
  title: 'Lernen',
  icon: VIEW_ICON,

  async mount(container, ctx) {
    ensureStyle();
    teardown();

    const self = {
      alive: true,
      ctx,
      api: ctx.api,
      container,
      cleanups: [],
      requests: new Set(),
      dom: {},

      mode: 'laden',        // laden | fehler | lernen | fertig | leer | anlegen | notiz
      renderedMode: null,
      error: null,
      stats: null,

      queue: [],            // [{record, vorschau}]
      cursor: 0,
      revealed: false,
      answered: new Set(),  // card ids answered at least once
      again: 0,             // how many were sent back into this session
      sessionSize: 0,
      naechste: null,
      busy: false,

      panel: null,          // the node of the current form, kept so typing survives
    };
    view = self;

    buildLayout(self);
    self.cleanups.push(on(document, 'keydown', (event) => onKey(self, event)));

    await load(self);
  },

  async unmount() {
    teardown();
  },
};

function teardown() {
  const self = view;
  view = null;
  if (!self) return;
  self.alive = false;
  for (const controller of self.requests) {
    try { controller.abort(); } catch { /* already done */ }
  }
  self.requests.clear();
  for (const off of self.cleanups) {
    try { off(); } catch { /* listener already gone */ }
  }
  self.cleanups.length = 0;
}

function request(self, run) {
  const controller = new AbortController();
  self.requests.add(controller);
  return run(controller.signal).finally(() => self.requests.delete(controller));
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

async function load(self) {
  self.mode = 'laden';
  self.error = null;
  render(self);
  try {
    const [queue, stats] = await Promise.all([
      request(self, (signal) => self.api.get('/study/due', { query: { limit: SESSION_LIMIT }, signal })),
      request(self, (signal) => self.api.get('/study/stats', { signal })),
    ]);
    if (!self.alive) return;
    self.stats = stats;
    self.queue = Array.isArray(queue && queue.items) ? queue.items.slice() : [];
    self.naechste = (queue && queue.naechste) || null;
    self.cursor = 0;
    self.revealed = false;
    self.answered = new Set();
    self.again = 0;
    self.sessionSize = self.queue.length;
    self.mode = self.queue.length ? 'lernen' : 'leer';
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.error = err;
    self.mode = 'fehler';
  }
  render(self);
}

/** Only the numbers, after something was created. */
async function refreshStats(self) {
  try {
    const [stats, queue] = await Promise.all([
      request(self, (signal) => self.api.get('/study/stats', { signal })),
      request(self, (signal) => self.api.get('/study/due', { query: { limit: 1 }, signal })),
    ]);
    if (!self.alive) return;
    self.stats = stats;
    self.naechste = (queue && queue.naechste) || null;
    renderHead(self);
  } catch {
    /* die Zahlen sind eine Zugabe; ihr Ausbleiben ist kein Fehlerbildschirm */
  }
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function buildLayout(self) {
  const { container, dom } = self;
  clear(container);

  dom.progress = h('p.studyv__progress', { role: 'status', 'aria-live': 'polite' });
  dom.counts = h('p.studyv__counts.meta');
  dom.actions = h('div.studyv__actions');
  dom.body = h('div.studyv__body');

  dom.root = h('div.studyv', null,
    h('header.studyv__head', null,
      h('div.studyv__headText', null, dom.progress, dom.counts),
      dom.actions),
    dom.body);

  container.appendChild(dom.root);
}

function renderHead(self) {
  const { dom } = self;
  clear(dom.progress);
  clear(dom.counts);
  clear(dom.actions);

  if (self.mode === 'lernen' || self.mode === 'fertig') {
    dom.progress.appendChild(text(`${formatNumber(self.answered.size)} von ${formatNumber(self.sessionSize)}`));
    if (self.again > 0) {
      dom.counts.appendChild(text(`${formatNumber(self.again)} ${plural(self.again, 'Karte kommt', 'Karten kommen')} heute noch einmal.`));
    }
  } else if (self.stats) {
    const offen = (self.stats.faellig || 0) + (self.stats.neu || 0);
    dom.progress.appendChild(text(offen
      ? `${formatNumber(offen)} ${plural(offen, 'Karte wartet', 'Karten warten')}`
      : 'Nichts fällig'));
    dom.counts.appendChild(text(
      `${formatNumber(self.stats.gesamt || 0)} ${plural(self.stats.gesamt || 0, 'Karte', 'Karten')} im Stapel`
      + (self.stats.ausgesetzt ? ` · ${formatNumber(self.stats.ausgesetzt)} ausgesetzt` : ''),
    ));
  }

  const inForm = self.mode === 'anlegen' || self.mode === 'notiz';
  if (inForm) {
    dom.actions.appendChild(h('button.btn.btn--small', {
      type: 'button',
      onClick: () => leaveForm(self),
    }, icon(ICONS.back), text('Zurück')));
    return;
  }

  if (self.mode !== 'laden') {
    dom.actions.appendChild(h('button.btn.btn--small', {
      type: 'button',
      title: 'Eine Karte von Hand anlegen',
      onClick: () => openAnlegen(self),
    }, icon(ICONS.plus), text('Neue Karte')));
    dom.actions.appendChild(h('button.btn.btn--small', {
      type: 'button',
      title: 'Aus einer Notiz Karten vorschlagen lassen',
      onClick: () => openAusNotiz(self),
    }, icon(ICONS.note), text('Aus einer Notiz')));
  }
  if (self.mode === 'leer' || self.mode === 'fertig' || self.mode === 'fehler') {
    dom.actions.appendChild(h('button.btn.btn--small', {
      type: 'button',
      onClick: () => load(self),
    }, icon(ICONS.refresh), text('Neu laden')));
  }
}

function render(self) {
  if (!self.alive) return;
  renderHead(self);
  const { dom } = self;
  clear(dom.body);
  self.renderedMode = self.mode;

  switch (self.mode) {
    case 'laden':
      dom.body.appendChild(h('div.studyv__state', { role: 'status' },
        h('span.spinner', { 'aria-hidden': 'true' }),
        h('p', null, text('Der Stapel wird geholt …'))));
      break;
    case 'fehler':
      dom.body.appendChild(renderError(self));
      break;
    case 'lernen':
      dom.body.appendChild(renderCard(self));
      break;
    case 'fertig':
      dom.body.appendChild(renderDone(self));
      break;
    case 'leer':
      dom.body.appendChild(renderEmpty(self));
      break;
    case 'anlegen':
    case 'notiz':
      if (self.panel) dom.body.appendChild(self.panel);
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* States                                                              */
/* ------------------------------------------------------------------ */

function renderError(self) {
  const err = self.error;
  const missing = err && (err.status === 503 || err.code === 'SUBSYSTEM_UNAVAILABLE');
  return h('div.studyv__state.is-danger', { role: 'alert' },
    h('h2', null, icon(ICONS.alert), text(missing ? 'Der Kartenstapel fehlt' : 'Der Stapel ließ sich nicht laden')),
    h('p', null, text(errorMessage(err))),
    missing
      ? h('p.hint', null, text('Dieser Teil des Systems ist in dieser Installation nicht eingerichtet. Karten anzulegen ist deshalb gerade nicht möglich — das ist kein vorübergehender Fehler.'))
      : h('button.btn.btn--small', { type: 'button', onClick: () => load(self) }, text('Erneut versuchen')));
}

function renderEmpty(self) {
  const stats = self.stats || {};
  const leer = !stats.gesamt;
  const box = h('div.studyv__state', null);

  if (leer) {
    box.appendChild(h('h2', null, text('Noch keine Karten')));
    box.appendChild(h('p', null, text('Ein Kartenstapel entsteht aus dem, was du behalten willst. Leg eine Karte von Hand an, oder lass dir aus einer Notiz vorschlagen, was sich als Frage stellen lässt.')));
  } else {
    box.appendChild(h('h2', null, text('Heute ist nichts fällig')));
    box.appendChild(h('p', null, text(self.naechste
      ? `Die nächste Karte kommt ${dayLabel(self.naechste)}.`
      : 'Es steht keine weitere Wiederholung an — alle Karten im Stapel sind ausgesetzt.')));
    if (stats.ausgesetzt) {
      box.appendChild(h('p.hint', null, text(`${formatNumber(stats.ausgesetzt)} ${plural(stats.ausgesetzt, 'Karte ist', 'Karten sind')} ausgesetzt und ${plural(stats.ausgesetzt, 'wird', 'werden')} nicht abgefragt.`)));
    }
  }

  box.appendChild(h('div.studyv__stateActions', null,
    h('button.btn.btn--primary.btn--small', { type: 'button', onClick: () => openAnlegen(self) },
      icon(ICONS.plus), text('Karte anlegen')),
    h('button.btn.btn--small', { type: 'button', onClick: () => openAusNotiz(self) },
      icon(ICONS.note), text('Aus einer Notiz'))));

  if (stats.nachStapel && stats.nachStapel.length > 1) {
    box.appendChild(renderDecks(stats.nachStapel));
  }
  box.appendChild(h('p.hint', null, text('Der Stapel liegt auf diesem Gerät. Zwischen Geräten wird er nicht abgeglichen: zwei Lernstände für dieselbe Karte ließen sich nicht zusammenführen, ohne zu raten, wie gut du etwas weißt.')));
  return box;
}

function renderDecks(decks) {
  const listNode = h('ul.studyv__decks', { role: 'list' });
  for (const deck of decks) {
    listNode.appendChild(h('li', null,
      h('span.studyv__deckName', null, text(deck.name)),
      h('span.meta', null, text(`${formatNumber(deck.gesamt)} ${plural(deck.gesamt, 'Karte', 'Karten')}`
        + (deck.faellig ? ` · ${formatNumber(deck.faellig)} fällig` : '')
        + (deck.neu ? ` · ${formatNumber(deck.neu)} neu` : '')))));
  }
  return h('div.studyv__deckBox', null,
    h('h3', null, text('Stapel')),
    listNode);
}

function renderDone(self) {
  const stats = self.stats || {};
  const box = h('div.studyv__state', null,
    h('h2', null, icon(ICONS.check), text('Für heute durch')),
    h('p', null, text(`${formatNumber(self.answered.size)} ${plural(self.answered.size, 'Karte', 'Karten')} beantwortet.`)));

  if (self.again > 0) {
    box.appendChild(h('p', null, text(`${formatNumber(self.again)} davon ${plural(self.again, 'kam', 'kamen')} noch einmal — „Nochmal" heißt heute.`)));
  }
  box.appendChild(h('p', null, text(self.naechste
    ? `Die nächste Karte ist ${dayLabel(self.naechste)} fällig.`
    : 'Es steht keine weitere Wiederholung an.')));
  if (stats.gesamt) {
    box.appendChild(h('p.meta', null, text(`${formatNumber(stats.gesamt)} ${plural(stats.gesamt, 'Karte', 'Karten')} im Stapel, davon ${formatNumber(stats.gelernt || 0)} mindestens einmal beantwortet.`)));
  }
  box.appendChild(h('div.studyv__stateActions', null,
    h('button.btn.btn--small', { type: 'button', onClick: () => load(self) }, icon(ICONS.refresh), text('Noch einmal nachsehen')),
    h('button.btn.btn--small', { type: 'button', onClick: () => openAnlegen(self) }, icon(ICONS.plus), text('Karte anlegen'))));
  return box;
}

/* ------------------------------------------------------------------ */
/* The card                                                            */
/* ------------------------------------------------------------------ */

function currentItem(self) {
  return self.queue[self.cursor] || null;
}

function renderCard(self) {
  const item = currentItem(self);
  if (!item) return h('div.studyv__state', null, h('p', null, text('Keine Karte.')));
  const data = item.record.data || {};

  const frame = h('div.studyv__cardFrame', null);
  const card = h('article.studyv__card', { 'aria-label': 'Lernkarte' },
    h('p.studyv__front', null, text(data.front || '')));

  if (self.revealed) {
    card.appendChild(h('hr.studyv__rule'));
    card.appendChild(h('p.studyv__back', null, text(data.back || 'Diese Karte hat keine Rückseite.')));
  }

  const meta = h('p.studyv__cardMeta.meta', null,
    text(data.deck || 'Standard'),
    data.lapses ? text(` · ${formatNumber(data.lapses)} ${plural(data.lapses, 'Rückfall', 'Rückfälle')}`) : null,
    data.noteId ? h('button.studyv__link', {
      type: 'button',
      title: 'Die Notiz öffnen, aus der diese Karte stammt',
      onClick: () => self.ctx.navigate(`#/notes?id=${encodeURIComponent(data.noteId)}`),
    }, text('Quellnotiz')) : null);

  frame.appendChild(card);
  frame.appendChild(meta);

  if (!self.revealed) {
    frame.appendChild(h('div.studyv__reveal', null,
      h('button.btn.btn--primary', {
        type: 'button',
        onClick: () => reveal(self),
      }, text('Rückseite zeigen')),
      h('p.hint', null, h('kbd.kbd', null, text('Leertaste')), text(' zeigt die Rückseite.'))));
    return frame;
  }

  const buttons = h('div.studyv__grades', { role: 'group', 'aria-label': 'Wie gut saß die Karte?' });
  for (const entry of item.vorschau || []) {
    buttons.appendChild(h(`button.studyv__grade.studyv__grade--${entry.grade}`, {
      type: 'button',
      disabled: self.busy,
      title: entry.hinweis || '',
      onClick: () => grade(self, entry.grade),
    },
    h('span.studyv__gradeKey', { 'aria-hidden': 'true' }, text(GRADE_KEYS[entry.grade])),
    h('span.studyv__gradeLabel', null, text(entry.label)),
    h('span.studyv__gradeWhen', null, text(entry.wann))));
  }
  frame.appendChild(buttons);
  frame.appendChild(h('p.hint.studyv__keys', null,
    text('Tasten '), h('kbd.kbd', null, text('1')), text(' bis '), h('kbd.kbd', null, text('4')),
    text(' — jede sagt, wann die Karte wiederkommt.')));
  return frame;
}

function reveal(self) {
  if (self.mode !== 'lernen' || self.revealed) return;
  self.revealed = true;
  render(self);
}

async function grade(self, value) {
  if (self.mode !== 'lernen' || !self.revealed || self.busy) return;
  const item = currentItem(self);
  if (!item) return;
  self.busy = true;
  render(self);
  try {
    const result = await request(self, (signal) => self.api.post(
      `/study/cards/${encodeURIComponent(item.record.id)}/review`, { grade: value }, { signal },
    ));
    if (!self.alive) return;
    self.answered.add(item.record.id);
    // "Nochmal" heisst heute: die Karte geht ans Ende dieser Runde zurueck,
    // statt bis morgen zu verschwinden.
    if (value === 0 && result && result.record) {
      self.again += 1;
      self.queue.push({ record: result.record, vorschau: result.vorschau || item.vorschau });
    }
    self.cursor += 1;
    self.revealed = false;
    self.busy = false;
    if (self.cursor >= self.queue.length) {
      self.mode = 'fertig';
      render(self);
      await refreshNext(self);
      return;
    }
    render(self);
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.busy = false;
    self.ctx.toast(`Die Bewertung wurde nicht gespeichert: ${errorMessage(err)}`, 'error');
    render(self);
  }
}

/** After the session: what the server now says is next. */
async function refreshNext(self) {
  try {
    const [queue, stats] = await Promise.all([
      request(self, (signal) => self.api.get('/study/due', { query: { limit: 1 }, signal })),
      request(self, (signal) => self.api.get('/study/stats', { signal })),
    ]);
    if (!self.alive) return;
    self.naechste = (queue && queue.naechste) || null;
    self.stats = stats;
    if (self.mode === 'fertig') render(self);
  } catch {
    /* die Schlusszahlen sind eine Zugabe, kein Grund fuer einen Fehlerbildschirm */
  }
}

/* ------------------------------------------------------------------ */
/* Creating cards                                                      */
/* ------------------------------------------------------------------ */

/**
 * Back to where the user was. A half-finished round is resumed rather than
 * thrown away -- cards that were already answered stay answered.
 */
function leaveForm(self) {
  self.panel = null;
  if (self.cursor < self.queue.length) self.mode = 'lernen';
  else if (self.sessionSize) self.mode = 'fertig';
  else self.mode = 'leer';
  render(self);
}

function deckOptions(self) {
  const names = new Set(['Standard']);
  for (const deck of (self.stats && self.stats.nachStapel) || []) names.add(deck.name);
  return [...names];
}

function openAnlegen(self) {
  const front = h('textarea.input.studyv__area', {
    rows: '3', placeholder: 'Vorderseite — die Frage', 'aria-label': 'Vorderseite',
  });
  const back = h('textarea.input.studyv__area', {
    rows: '4', placeholder: 'Rückseite — die Antwort', 'aria-label': 'Rückseite',
  });
  const deckList = h('datalist', { id: 'studyv-decks' },
    ...deckOptions(self).map((name) => h('option', { value: name })));
  const deck = h('input.input', {
    type: 'text', value: 'Standard', list: 'studyv-decks', 'aria-label': 'Stapel',
  });
  const status = h('p.studyv__formStatus.meta', { role: 'status' });

  const submit = async () => {
    const frontValue = front.value.trim();
    if (!frontValue) {
      clear(status);
      status.appendChild(text('Ohne Vorderseite gibt es keine Frage.'));
      front.focus();
      return;
    }
    try {
      await request(self, (signal) => self.api.post('/study/cards', {
        front: frontValue, back: back.value.trim(), deck: deck.value.trim() || 'Standard',
      }, { signal }));
      if (!self.alive) return;
      front.value = '';
      back.value = '';
      clear(status);
      status.appendChild(text('Angelegt. Die nächste kann gleich folgen.'));
      front.focus();
      refreshStats(self);
    } catch (err) {
      if (!self.alive || (err && err.isAborted)) return;
      clear(status);
      status.appendChild(text(`Nicht angelegt: ${errorMessage(err)}`));
    }
  };

  self.panel = h('div.studyv__panel', null,
    h('h2', null, text('Karte anlegen')),
    h('p.hint', null, text('Eine gute Karte stellt eine Frage, auf die es eine Antwort gibt — nicht einen Abschnitt, den man wiedererkennt.')),
    h('label.label', null, text('Vorderseite')), front,
    h('label.label', null, text('Rückseite')), back,
    h('label.label', null, text('Stapel')), deck, deckList,
    h('div.studyv__formActions', null,
      h('button.btn.btn--primary.btn--small', { type: 'button', onClick: submit }, text('Anlegen')),
      h('button.btn.btn--small', { type: 'button', onClick: () => leaveForm(self) }, text('Fertig'))),
    status);

  self.mode = 'anlegen';
  render(self);
  front.focus();
}

/* ------------------------------------------------------------------ */
/* Cards from a note                                                   */
/* ------------------------------------------------------------------ */

function openAusNotiz(self) {
  const filter = h('input.input', {
    type: 'search', placeholder: 'Notiz suchen …', 'aria-label': 'Notiz suchen',
    autocomplete: 'off', spellcheck: 'false',
  });
  const notes = h('div.studyv__notes', { role: 'list' });
  const result = h('div.studyv__proposals');

  self.panel = h('div.studyv__panel', null,
    h('h2', null, text('Karten aus einer Notiz')),
    h('p.hint', null, text('Vorgeschlagen wird nur, was ausdrücklich als Frage und Antwort geschrieben ist. Aus Fließtext wird nichts geraten — angelegt wird erst, was du anhakst.')),
    filter,
    notes,
    result);

  self.mode = 'notiz';
  render(self);
  filter.focus();

  let all = [];
  const paint = () => {
    const needle = filter.value.trim().toLowerCase();
    clear(notes);
    const shown = all.filter((note) => !needle || String(note.data.title || '').toLowerCase().includes(needle));
    if (!shown.length) {
      notes.appendChild(h('p.meta', null, text(all.length ? 'Keine Notiz mit diesem Titel.' : 'Es gibt noch keine Notizen.')));
      return;
    }
    for (const note of shown.slice(0, 40)) {
      notes.appendChild(h('button.studyv__note', {
        type: 'button',
        role: 'listitem',
        onClick: () => loadProposals(self, note, result),
      }, h('span.studyv__noteTitle', null, text(note.data.title || 'Ohne Titel')),
      h('span.meta', null, text(formatDate(note.updatedAt)))));
    }
    if (shown.length > 40) {
      notes.appendChild(h('p.meta', null, text(`… und ${formatNumber(shown.length - 40)} weitere. Tipp den Titel ein.`)));
    }
  };

  on(filter, 'input', paint);
  notes.appendChild(h('p.meta', { role: 'status' }, text('Notizen werden geholt …')));

  request(self, (signal) => self.api.get('/records', {
    query: { type: 'note', limit: 200, sort: 'updatedAt', order: 'desc' }, signal,
  })).then((listed) => {
    if (!self.alive || self.mode !== 'notiz') return;
    all = Array.isArray(listed && listed.items) ? listed.items : [];
    paint();
  }).catch((err) => {
    if (!self.alive || (err && err.isAborted)) return;
    clear(notes);
    notes.appendChild(h('p.meta', null, text(`Die Notizen ließen sich nicht laden: ${errorMessage(err)}`)));
  });
}

async function loadProposals(self, note, into) {
  clear(into);
  into.appendChild(h('p.meta', { role: 'status' }, text(`„${note.data.title || 'Ohne Titel'}“ wird gelesen …`)));
  let proposal;
  try {
    proposal = await request(self, (signal) => self.api.get(
      `/study/from-note/${encodeURIComponent(note.id)}`, { signal },
    ));
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    clear(into);
    into.appendChild(h('p.meta', null, text(`Nicht lesbar: ${errorMessage(err)}`)));
    return;
  }
  if (!self.alive) return;
  clear(into);

  const items = Array.isArray(proposal.items) ? proposal.items : [];
  into.appendChild(h('h3', null, text(`Vorschläge aus „${proposal.note.title || 'Ohne Titel'}“`)));

  if (!items.length) {
    into.appendChild(h('p', null, text(proposal.hinweis || 'Hier ist nichts, was sich als Karte stellen ließe.')));
    into.appendChild(renderForms(proposal.formen));
    if (proposal.uebersprungen && proposal.uebersprungen.length) {
      into.appendChild(renderSkipped(proposal.uebersprungen));
    }
    return;
  }

  const checks = new Map();
  const listNode = h('ul.studyv__proposalList', { role: 'list' });
  for (const item of items) {
    const box = h('input', {
      type: 'checkbox',
      checked: !item.schonVorhanden,
      disabled: !!item.schonVorhanden,
      'aria-label': `Karte für ${item.front}`,
    });
    checks.set(item.key, box);
    listNode.appendChild(h('li.studyv__proposal', null,
      h('label.studyv__proposalMain', null,
        box,
        h('span.studyv__proposalText', null,
          h('span.studyv__proposalFront', null, text(item.front)),
          h('span.studyv__proposalBack', null, text(item.back)))),
      h('span.studyv__proposalMeta.meta', null,
        h('span.badge', null, text(formLabel(item.form))),
        item.schonVorhanden ? h('span', null, text('gibt es schon')) : null)));
  }
  into.appendChild(listNode);

  if (proposal.uebersprungen && proposal.uebersprungen.length) {
    into.appendChild(renderSkipped(proposal.uebersprungen));
  }

  const deckList = h('datalist', { id: 'studyv-decks-note' },
    ...deckOptions(self).map((name) => h('option', { value: name })));
  const deck = h('input.input', {
    type: 'text', value: note.data.title ? String(note.data.title).slice(0, 120) : 'Standard',
    list: 'studyv-decks-note', 'aria-label': 'Stapel',
  });
  const status = h('p.studyv__formStatus.meta', { role: 'status' });

  const submit = async () => {
    const auswahl = [...checks.entries()].filter(([, box]) => box.checked && !box.disabled).map(([key]) => key);
    if (!auswahl.length) {
      clear(status);
      status.appendChild(text('Nichts angehakt — es wurde nichts angelegt.'));
      return;
    }
    try {
      const created = await request(self, (signal) => self.api.post(
        `/study/from-note/${encodeURIComponent(note.id)}`,
        { auswahl, deck: deck.value.trim() || undefined },
        { signal },
      ));
      if (!self.alive) return;
      const count = (created.created || []).length;
      self.ctx.toast(`${formatNumber(count)} ${plural(count, 'Karte', 'Karten')} angelegt.`, 'success');
      clear(status);
      status.appendChild(text(`${formatNumber(count)} ${plural(count, 'Karte', 'Karten')} angelegt`
        + ((created.uebersprungen || []).length ? `, ${formatNumber(created.uebersprungen.length)} übersprungen (gab es schon).` : '.')));
      for (const [key, box] of checks) {
        if (auswahl.includes(key)) {
          box.checked = false;
          box.disabled = true;
        }
      }
      refreshStats(self);
    } catch (err) {
      if (!self.alive || (err && err.isAborted)) return;
      clear(status);
      status.appendChild(text(`Nicht angelegt: ${errorMessage(err)}`));
    }
  };

  into.appendChild(h('div.studyv__formActions', null,
    h('label.label', null, text('Stapel')), deck, deckList,
    h('button.btn.btn--primary.btn--small', { type: 'button', onClick: submit }, text('Ausgewählte anlegen'))));
  into.appendChild(status);
}

function formLabel(form) {
  if (form === 'ueberschrift') return 'Überschrift';
  if (form === 'trenner') return 'Trenner ::';
  if (form === 'definition') return 'Definition';
  return form || 'Form';
}

function renderForms(formen) {
  const box = h('div.studyv__forms', null, h('h4', null, text('Erkannt werden diese Formen')));
  for (const form of formen || []) {
    box.appendChild(h('div.studyv__form', null,
      h('p', null, text(form.text)),
      h('pre.code.studyv__example', null, text(form.beispiel))));
  }
  return box;
}

function renderSkipped(entries) {
  const listNode = h('ul.studyv__skipped', { role: 'list' });
  for (const entry of entries.slice(0, 8)) {
    listNode.appendChild(h('li.meta', null, text(entry.grund)));
  }
  return h('div.studyv__skippedBox', null,
    h('h4', null, text('Nicht übernommen')),
    listNode);
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

function onKey(self, event) {
  if (!self.alive || event.defaultPrevented) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (isTyping(event.target)) return;
  // Ein offener Dialog gehoert der Schale, nicht dieser Ansicht.
  if (document.documentElement.classList.contains('is-overlaid')) return;
  if (self.mode !== 'lernen') return;

  if (event.key === ' ' || event.key === 'Spacebar' || event.key === 'Enter') {
    event.preventDefault();
    reveal(self);
    return;
  }
  const index = GRADE_KEYS.indexOf(event.key);
  if (index === -1) return;
  event.preventDefault();
  if (!self.revealed) {
    // Ohne Rueckseite ist eine Note geraten. Erst zeigen, dann bewerten.
    reveal(self);
    return;
  }
  grade(self, index);
}

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
.studyv { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.studyv__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.studyv__headText { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2); }
.studyv__progress { margin: 0; font-size: var(--fs-md); font-variant-numeric: tabular-nums; }
.studyv__counts { margin: 0; }
.studyv__actions { display: flex; flex-wrap: wrap; gap: 6px; }

.studyv__body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--sp-3); }

/* --- die Karte selbst --- */
.studyv__cardFrame {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  max-width: 60ch;
  margin: var(--sp-4) auto var(--sp-8);
}
.studyv__card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 9rem;
  padding: var(--sp-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-4);
  box-shadow: var(--shadow-1);
}
.studyv__front {
  margin: 0;
  font-size: var(--fs-xl);
  line-height: var(--lh-tight);
  white-space: pre-wrap;
}
.studyv__rule { width: 100%; height: 1px; margin: 0; border: 0; background: var(--border); }
.studyv__back {
  margin: 0;
  font-size: var(--fs-lg);
  color: var(--fg-muted);
  white-space: pre-wrap;
}
.studyv__cardMeta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); margin: 0; }
.studyv__link {
  padding: 0;
  color: var(--accent);
  background: none;
  border: 0;
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
}
.studyv__reveal { display: flex; flex-direction: column; align-items: center; gap: var(--sp-1); }
.studyv__reveal .hint { margin: 0; }

/* --- die vier Knoepfe --- */
.studyv__grades { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.studyv__grade {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: var(--sp-1) var(--sp-05);
  color: inherit;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-3);
  font: inherit;
  cursor: pointer;
}
.studyv__grade:hover:not(:disabled) { background: var(--surface-2); border-color: var(--accent); }
.studyv__grade:disabled { opacity: 0.6; cursor: default; }
.studyv__grade:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.studyv__gradeKey {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.4rem;
  padding: 0 4px;
  color: var(--fg-subtle);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-1);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
}
.studyv__gradeLabel { font-size: var(--fs-base); }
.studyv__gradeWhen { color: var(--fg-muted); font-size: var(--fs-xs); text-align: center; }
.studyv__grade--0 { border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
.studyv__grade--0:hover:not(:disabled) { border-color: var(--danger); }
.studyv__grade--3 { border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
.studyv__grade--3:hover:not(:disabled) { border-color: var(--ok); }
.studyv__keys { margin: 0; text-align: center; }

/* --- Zustaende --- */
.studyv__state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-1);
  max-width: 60ch;
  margin: var(--sp-4) auto;
  padding: var(--sp-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
}
.studyv__state h2 { display: flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-lg); }
.studyv__state p { margin: 0; color: var(--fg-muted); }
.studyv__state.is-danger { border-color: color-mix(in srgb, var(--danger) 45%, transparent); background: var(--danger-soft); }
.studyv__stateActions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: var(--sp-1); }

.studyv__deckBox { width: 100%; margin-top: var(--sp-2); }
.studyv__deckBox h3 { font-size: var(--fs-base); margin: 0 0 var(--sp-05); }
.studyv__decks { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.studyv__decks li { display: flex; justify-content: space-between; gap: var(--sp-2); }
.studyv__deckName { font-weight: 500; }

/* --- Formulare --- */
.studyv__panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  max-width: 70ch;
  margin: 0 auto var(--sp-8);
}
.studyv__panel h2 { font-size: var(--fs-lg); margin: 0; }
.studyv__panel h3 { font-size: var(--fs-md); margin: var(--sp-2) 0 0; }
.studyv__panel h4 { font-size: var(--fs-base); margin: var(--sp-2) 0 var(--sp-05); }
.studyv__panel .hint { margin: 0 0 var(--sp-1); }
.studyv__area { width: 100%; resize: vertical; font: inherit; }
.studyv__formActions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: var(--sp-2); }
.studyv__formStatus { margin: var(--sp-1) 0 0; }

.studyv__notes {
  display: flex;
  flex-direction: column;
  max-height: 14rem;
  overflow-y: auto;
  margin-top: var(--sp-1);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
}
.studyv__note {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  text-align: left;
  color: inherit;
  background: none;
  border: 0;
  border-bottom: 1px solid var(--border);
  font: inherit;
  cursor: pointer;
}
.studyv__note:last-child { border-bottom: 0; }
.studyv__note:hover { background: var(--surface-2); }
.studyv__note:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.studyv__noteTitle { font-weight: 500; }

.studyv__proposals { display: flex; flex-direction: column; gap: var(--sp-1); }
.studyv__proposalList { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.studyv__proposal {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-1);
  padding: var(--sp-1);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
}
.studyv__proposalMain { display: flex; align-items: flex-start; gap: var(--sp-1); flex: 1; min-width: 0; cursor: pointer; }
.studyv__proposalText { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.studyv__proposalFront { font-weight: 500; }
.studyv__proposalBack { color: var(--fg-muted); font-size: var(--fs-sm); }
.studyv__proposalMeta { display: flex; align-items: center; gap: 6px; }

.studyv__forms { display: flex; flex-direction: column; gap: var(--sp-1); }
.studyv__form p { margin: 0 0 4px; color: var(--fg-muted); font-size: var(--fs-sm); }
.studyv__example { margin: 0; padding: var(--sp-1); white-space: pre-wrap; }
.studyv__skippedBox { margin-top: var(--sp-1); }
.studyv__skipped { display: flex; flex-direction: column; gap: 2px; margin: 0; padding-left: var(--sp-3); }

@media (max-width: 720px) {
  .studyv__body { padding: var(--sp-2); }
  .studyv__cardFrame { margin-top: var(--sp-2); }
  .studyv__card { padding: var(--sp-3); }
  .studyv__front { font-size: var(--fs-lg); }
  .studyv__back { font-size: var(--fs-base); }
  .studyv__grades { grid-template-columns: repeat(2, 1fr); }
}
`;
