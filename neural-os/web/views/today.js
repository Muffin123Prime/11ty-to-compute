/**
 * views/today.js -- "Heute": der Bildschirm, den man morgens einmal ansieht.
 *
 * Die Entscheidungen dahinter
 * ---------------------------
 * 1. **Der erste Satz ist eine Tatsache, keine Begrüßung.** „Guten Morgen!"
 *    sagt nichts und wird nach drei Tagen nicht mehr gelesen. „Drei Aufgaben
 *    sind fällig, zwei davon überfällig." sagt alles, was man im Vorbeigehen
 *    wissen muss -- und wenn nichts ansteht, sagt der Satz genau das.
 * 2. **Die Reihenfolge ist Dringlichkeit, nicht Vollständigkeit.** Was fällig
 *    ist, steht oben; was ohne dich lief, direkt darunter, weil es die einzige
 *    Frage ist, die man sonst gar nicht stellt. Was sich nur geändert hat,
 *    kommt zuletzt.
 * 3. **Jeder Block führt dorthin, wo man etwas tun kann.** Ein Bildschirm zum
 *    Ansehen, der in einer Sackgasse endet, zwingt zum Suchen -- also ist jede
 *    Zeile anklickbar und jeder Block hat seinen Weg in den zuständigen
 *    Bereich.
 * 4. **Eine einzige Schreibaktion, und die gehört hierher.** Abhaken. Alles
 *    andere -- ändern, verschieben, löschen -- passiert dort, wo auch der
 *    Zusammenhang steht. Aber eine erledigte Aufgabe abzuhaken, wäre von hier
 *    aus drei Klicks weit weg, und das ist genau der Weg, den niemand geht.
 * 5. **„Nichts gefunden" und „konnte nicht nachsehen" sehen verschieden aus.**
 *    Die Route sagt in `fehlend`, welcher Teil des Systems nicht erreichbar
 *    war; dieser Block zeigt dann den Grund statt einer leeren Liste, die wie
 *    eine gute Nachricht aussähe.
 * 6. **Der leere Bildschirm ist ein Ergebnis.** Nichts fällig, nichts ohne
 *    dich gelaufen, kein Vorschlag offen: das ist der beste Morgen, den es
 *    gibt, und er wird auch so dargestellt -- nicht als leere Seite, die nach
 *    einem Ladefehler aussieht.
 * 7. **Zuschreibung wird nicht aufgerundet.** Die Route trennt Änderungen, die
 *    wirklich in einem Agentenlauf entstanden sind, von solchen, bei denen nur
 *    der Herkunftsstempel einen Agenten nennt. Die zweite Sorte wird gezählt
 *    und benannt, aber nicht als „ohne dich" ausgegeben.
 */

import {
  h, text, frag, clear, icon, timeAgo, formatDate, formatNumber, debounce,
} from '../lib/dom.js';

const STYLE_ID = 'nos-today-view-style';

/** Sonne über dem Horizont -- der Tagesbeginn. */
const VIEW_ICON = '<path d="M10 2.8v2.4M4.5 5.6 6.2 7.3M15.5 5.6 13.8 7.3M2.6 14.2h14.8M5.8 14.2a4.2 4.2 0 0 1 8.4 0"/>';

const ICONS = {
  check: '<path d="m4.2 10.6 3.9 3.9 7.7-8.9"/>',
  arrow: '<path d="M3.8 10h11.4M11 5.8l4.2 4.2-4.2 4.2"/>',
  alert: '<path d="M10 3.2 17.5 16.4h-15z"/><path d="M10 8.2v3.5M10 13.9h.01"/>',
  refresh: '<path d="M16.6 10a6.6 6.6 0 1 1-2.1-4.8"/><path d="M16.9 3v3.7h-3.7"/>',
  agent: '<rect x="3.4" y="6.2" width="13.2" height="9.4" rx="2.6"/><path d="M10 3v3.2M7 10.4h.01M13 10.4h.01M7.8 13.2h4.4"/>',
  clock: '<circle cx="10" cy="10" r="7.2"/><path d="M10 5.6V10l2.8 1.8"/>',
};

/** Substantive pro Art, wie in views/search.js. */
const SINGULAR = {
  note: 'Notiz', chat: 'Chat', message: 'Nachricht', project: 'Projekt',
  task: 'Aufgabe', entity: 'Begriff', file: 'Datei', agent: 'Agent',
  run: 'Lauf', memory: 'Erinnerung', edge: 'Verknüpfung', suggestion: 'Vorschlag',
};

/** Die Arten von Vorschlägen, mit demselben Wortschatz wie views/assist.js. */
const KIND_LABEL = {
  duplicate: 'Doppelt', orphan: 'Verwaist', tag: 'Schlagwort',
  task: 'Aufgabe', revisit: 'Wiedervorlage', link: 'Fehlender Link',
};

/** Ausgeschriebene Zahlwörter -- ein Satz liest sich mit ihnen wie ein Satz. */
const WORDS = [
  'null', 'eine', 'zwei', 'drei', 'vier', 'fünf', 'sechs',
  'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf',
];

const DAY = 24 * 60 * 60 * 1000;
const RELOAD_DEBOUNCE_MS = 2000;

/* ------------------------------------------------------------------ */
/* Sprache                                                             */
/* ------------------------------------------------------------------ */

function zahlwort(n) {
  return WORDS[n] || formatNumber(n);
}

function gross(satz) {
  return satz.charAt(0).toUpperCase() + satz.slice(1);
}

function errorMessage(err) {
  if (!err) return 'Unbekannter Fehler.';
  return err.message || String(err);
}

/**
 * Wo ein Eintrag in dieser Anwendung liegt. Dieselbe Tabelle wie in
 * views/search.js -- zwei verschiedene Antworten auf „wo ist das?" wären eine
 * zu viel.
 */
function targetFor(type, id, data = {}) {
  const enc = encodeURIComponent(id);
  switch (type) {
    case 'note': return `#/notes?id=${enc}`;
    case 'chat': return `#/chat?id=${enc}`;
    case 'message': return data.chatId ? `#/chat?id=${encodeURIComponent(data.chatId)}` : `#/graph?focus=${enc}`;
    case 'project':
    case 'task': return `#/projects?id=${enc}`;
    case 'agent': return `#/agents?id=${enc}`;
    case 'run': return `#/agents?run=${enc}`;
    default: return `#/graph?focus=${enc}`;
  }
}

/**
 * Wann eine Aufgabe fällig ist, in Millisekunden.
 *
 * Ein blankes `2026-09-21` ist Mitternacht vor Ort, nicht UTC -- dieselbe
 * Lesart wie in src/http/api/today.js. Stünde hier `Date.parse`, wäre die
 * Beschriftung „heute" ein paar Stunden lang im Widerspruch zu der
 * Einsortierung, die der Server vorgenommen hat.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function dueAt(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (DATE_ONLY.test(raw)) {
    const [y, m, d] = raw.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** „überfällig seit 3 Tagen", „heute", „morgen", „in 4 Tagen". */
function dueLabel(due, now = Date.now()) {
  const ms = dueAt(due);
  if (ms === null) return 'ohne Datum';
  const tage = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  if (tage === 0) return 'heute';
  if (tage === 1) return 'morgen';
  if (tage === -1) return 'überfällig seit gestern';
  if (tage < -1) return `überfällig seit ${formatNumber(-tage)} Tagen`;
  if (tage <= 14) return `in ${formatNumber(tage)} Tagen`;
  return formatDate(ms);
}

/**
 * Der erste Satz. Er sagt, was fällig ist -- und wenn nichts fällig ist, sagt
 * er das, statt zu grüßen.
 *
 * Drei Fälle, weil ein einziger Satzbaukasten hier sofort schief klingt:
 * alles überfällig, nichts überfällig, und gemischt. „Eine Aufgabe ist fällig,
 * und überfällig" wäre grammatisch möglich und trotzdem kein Satz, den ein
 * Mensch schreibt.
 */
function leadSentence(data) {
  const a = (data.faellig && data.faellig.anzahl) || {};
  const ueber = a.ueberfaellig || 0;
  const heute = a.heute || 0;
  const offen = ueber + heute;
  if (!offen) return 'Nichts ist fällig.';
  if (!heute) {
    return ueber === 1
      ? 'Eine Aufgabe ist überfällig.'
      : `${gross(zahlwort(ueber))} Aufgaben sind überfällig.`;
  }
  if (!ueber) {
    return heute === 1
      ? 'Eine Aufgabe ist heute fällig.'
      : `${gross(zahlwort(heute))} Aufgaben sind heute fällig.`;
  }
  const kopf = offen === 1 ? 'Eine Aufgabe ist fällig' : `${gross(zahlwort(offen))} Aufgaben sind fällig`;
  const nach = ueber === 1 ? 'eine davon überfällig' : `${zahlwort(ueber)} davon überfällig`;
  return `${kopf}, ${nach}.`;
}

/** Ist wirklich gar nichts zu tun? Drei Fragen, nicht eine. */
function nothingToDo(data) {
  const a = (data.faellig && data.faellig.anzahl) || {};
  const ohne = data.ohneDich || {};
  const vor = data.vorschlaege || {};
  return !(a.ueberfaellig || 0) && !(a.heute || 0) && !(a.demnaechst || 0)
    && !(ohne.gesamt || 0) && !(ohne.laeufeGesamt || 0) && !(ohne.unsicher || 0)
    && !(vor.offen || 0);
}

/** Der Grund, warum ein Block nichts sagen kann -- oder null. */
function missingReason(data, teil) {
  const list = Array.isArray(data.fehlend) ? data.fehlend : [];
  const hits = list.filter((entry) => entry && entry.teil === teil).map((entry) => entry.grund);
  return hits.length ? hits.join(' ') : null;
}

/* ------------------------------------------------------------------ */
/* Ansicht                                                             */
/* ------------------------------------------------------------------ */

let view = null;

export default {
  id: 'today',
  title: 'Heute',
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

      data: null,
      error: null,
      loading: true,
      busy: new Set(), // Aufgaben, deren Abhaken gerade unterwegs ist
    };
    view = self;

    buildLayout(self);
    subscribe(self);
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
  if (self.reloadSoon) self.reloadSoon.cancel();
  for (const controller of self.requests) {
    try { controller.abort(); } catch { /* schon erledigt */ }
  }
  self.requests.clear();
  for (const off of self.cleanups) {
    try { off(); } catch { /* Zuhörer schon abgemeldet */ }
  }
  self.cleanups.length = 0;
}

function request(self, run) {
  const controller = new AbortController();
  self.requests.add(controller);
  return run(controller.signal).finally(() => self.requests.delete(controller));
}

function buildLayout(self) {
  const { container, dom } = self;
  clear(container);

  dom.lead = h('p.todayv__lead', { role: 'status' });
  dom.stand = h('span.todayv__stand.meta');
  dom.reload = h('button.btn.btn--small.btn--ghost', {
    type: 'button',
    title: 'Neu nachsehen',
    onClick: () => load(self),
  }, icon(ICONS.refresh), text('Neu ansehen'));

  dom.blocks = h('div.todayv__blocks');

  dom.root = h('div.todayv', null,
    h('div.todayv__inner', null,
      h('header.todayv__head', null,
        dom.lead,
        h('div.todayv__headmeta', null, dom.stand, dom.reload)),
      dom.blocks));

  container.appendChild(dom.root);
}

/**
 * Auf Änderungen im Tresor hören.
 *
 * Gedrosselt und still: dieser Bildschirm wird angesehen, nicht bearbeitet,
 * und ein Neuaufbau unter der Hand des Nutzers wäre schlimmer als eine Zahl,
 * die zwei Sekunden alt ist.
 */
function subscribe(self) {
  const { ctx } = self;
  self.reloadSoon = debounce(() => {
    if (!self.alive || self.loading) return;
    load(self, { quiet: true });
  }, RELOAD_DEBOUNCE_MS);
  if (!ctx.bus || typeof ctx.bus.on !== 'function') return;
  for (const name of ['record.created', 'record.updated', 'record.deleted']) {
    self.cleanups.push(ctx.bus.on(name, () => self.reloadSoon()));
  }
}

async function load(self, opts = {}) {
  if (!self.alive) return;
  self.loading = true;
  if (!opts.quiet) render(self);
  try {
    const data = await request(self, (signal) => self.api.get('/today', { signal }));
    if (!self.alive) return;
    self.data = data;
    self.error = null;
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    self.error = err;
    if (!opts.quiet) self.data = null;
  } finally {
    if (self.alive) {
      self.loading = false;
      render(self);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Zeichnen                                                            */
/* ------------------------------------------------------------------ */

function render(self) {
  const { dom, data } = self;
  clear(dom.lead);
  clear(dom.stand);
  clear(dom.blocks);

  if (self.error) {
    dom.lead.appendChild(text('Der Tagesbeginn konnte nicht gelesen werden.'));
    dom.blocks.appendChild(h('div.todayv__state.is-danger', { role: 'alert' },
      h('p', null, text(errorMessage(self.error))),
      h('button.btn.btn--small', { type: 'button', onClick: () => load(self) }, text('Erneut versuchen'))));
    return;
  }

  if (!data) {
    dom.lead.appendChild(text('Wird nachgesehen …'));
    dom.blocks.appendChild(h('div.todayv__state', { role: 'status' },
      h('span.spinner', { 'aria-hidden': 'true' }),
      h('p', null, text('Aufgaben, Läufe und Vorschläge werden zusammengetragen.'))));
    return;
  }

  dom.lead.appendChild(text(leadSentence(data)));
  dom.stand.appendChild(text(`Stand ${timeAgo(data.at)}${self.loading ? ' · sieht nach …' : ''}`));

  if (nothingToDo(data) && !(data.fehlend || []).length) {
    dom.blocks.appendChild(h('div.todayv__clear', null,
      h('span.todayv__clear-icon', { 'aria-hidden': 'true' }, icon(ICONS.check)),
      h('p.todayv__clear-text', null,
        text('Nichts ist fällig, nichts lief ohne dich, keine offenen Vorschläge.'))));
  } else {
    dom.blocks.appendChild(renderFaellig(self, data));
    dom.blocks.appendChild(renderOhneDich(self, data));
    dom.blocks.appendChild(renderVorschlaege(self, data));
  }

  dom.blocks.appendChild(renderSeitGestern(self, data));
  dom.blocks.appendChild(renderWiedervorlage(self, data));
  dom.blocks.appendChild(renderAutomatik(self, data));
}

/**
 * Ein Block: Überschrift, Zahl, Inhalt -- und der Weg dorthin, wo man etwas
 * tun kann.
 */
function blockNode(self, { name, titel, zahl, ziel, zielLabel, kinder, grund }) {
  const head = h('div.todayv__block-head', null,
    h('h2.todayv__block-title', null, text(titel)),
    zahl ? h('span.todayv__count.badge', null, text(zahl)) : null,
    ziel
      ? h('button.btn.btn--small.btn--ghost.todayv__more', {
        type: 'button',
        onClick: () => self.ctx.navigate(ziel),
      }, text(zielLabel || 'Ansehen'), icon(ICONS.arrow))
      : null);

  const body = grund
    ? h('p.todayv__missing', null,
      h('span.todayv__missing-icon', { 'aria-hidden': 'true' }, icon(ICONS.alert)),
      text(`Konnte nicht nachsehen: ${grund}`))
    : kinder;

  return h(`section.todayv__block.todayv__block--${name}`, { 'aria-label': titel }, head, body);
}

/** Eine Zeile, die irgendwohin führt. */
function rowNode(self, { ziel, titel, unten, rechts, klasse }) {
  return h(`div.todayv__row${klasse ? `.${klasse}` : ''}`, null,
    h('button.todayv__row-main', {
      type: 'button',
      onClick: () => self.ctx.navigate(ziel),
    },
    h('span.todayv__row-title', null, text(titel)),
    unten ? h('span.todayv__row-sub.meta', null, unten) : null),
    rechts || null);
}

function emptyLine(satz) {
  return h('p.todayv__empty', null, text(satz));
}

/* ------------------------------------------------------- 1 · was fällig ist */

function renderFaellig(self, data) {
  const f = data.faellig || {};
  const a = f.anzahl || {};
  const grund = missingReason(data, 'faellig');
  const offen = (a.ueberfaellig || 0) + (a.heute || 0);

  const rows = [];
  for (const task of [...(f.ueberfaellig || []), ...(f.heute || [])]) rows.push(taskRow(self, task));
  if ((f.demnaechst || []).length) {
    // Eine eigene Überschrift, weil die Zahl oben nur zählt, was WIRKLICH
    // fällig ist. Ohne sie stünde unter „Fällig · 3" eine vierte Zeile, und
    // der Leser müsste raten, welche der beiden Angaben stimmt.
    if (rows.length) rows.push(h('p.todayv__group.meta', null, text('Demnächst')));
    for (const task of f.demnaechst) rows.push(taskRow(self, task));
  }

  const kinder = h('div.todayv__rows', null,
    rows.length ? rows : emptyLine('Nichts ist fällig.'),
    a.ohneDatum
      ? h('button.todayv__note', {
        type: 'button',
        onClick: () => self.ctx.navigate('#/projects'),
      }, text(a.ohneDatum === 1
        ? 'Eine weitere offene Aufgabe hat kein Datum.'
        : `${formatNumber(a.ohneDatum)} weitere offene Aufgaben haben kein Datum.`))
      : null,
    a.spaeter
      ? h('p.todayv__note-quiet.meta', null, text(a.spaeter === 1
        ? 'Eine Aufgabe ist später fällig.'
        : `${formatNumber(a.spaeter)} Aufgaben sind später fällig.`))
      : null);

  return blockNode(self, {
    name: 'faellig',
    titel: 'Fällig',
    zahl: offen ? formatNumber(offen) : '',
    ziel: '#/projects',
    zielLabel: 'Projekte',
    grund,
    kinder,
  });
}

/**
 * Eine Aufgabe, abhakbar.
 *
 * Das ist die einzige Stelle, an der dieser Bildschirm schreibt. Er tut es
 * über dieselbe Route wie jede andere Ansicht und meldet, was wirklich
 * passiert ist: gelingt der Schreibvorgang nicht, bleibt die Zeile stehen und
 * der Fehler wird genannt. Eine Zeile, die verschwindet, obwohl im Tresor
 * nichts passiert ist, wäre die schlimmste Art von Fortschritt.
 */
function taskRow(self, task) {
  const busy = self.busy.has(task.id);
  const label = dueLabel(task.due);
  const ueberfaellig = label.startsWith('überfällig');

  const abhaken = h('button.todayv__tick', {
    type: 'button',
    disabled: busy,
    title: 'Als erledigt abhaken',
    'aria-label': `„${task.title}" als erledigt abhaken`,
    onClick: () => completeTask(self, task),
  }, busy ? h('span.spinner', { 'aria-hidden': 'true' }) : icon(ICONS.check));

  return rowNode(self, {
    ziel: targetFor('task', task.id),
    titel: task.title,
    klasse: ueberfaellig ? 'is-overdue' : '',
    // Ein Fragment, kein Hüll-<span>: so sind beide Angaben echte Kinder von
    // `.todayv__row-sub` und bekommen dessen Abstand.
    unten: frag(
      h('span', { class: ueberfaellig ? 'todayv__due is-overdue' : 'todayv__due' }, text(label)),
      task.priority === 1 ? h('span.badge.badge--accent', null, text('wichtig')) : null),
    rechts: h('div.todayv__row-actions', null, abhaken),
  });
}

async function completeTask(self, task) {
  if (self.busy.has(task.id)) return;
  self.busy.add(task.id);
  render(self);
  try {
    await request(self, (signal) => self.api.patch(`/records/${encodeURIComponent(task.id)}`, { status: 'done' }, { signal }));
    if (!self.alive) return;
    self.ctx.toast(`„${task.title}" ist abgehakt.`, 'success');
    await load(self, { quiet: true });
  } catch (err) {
    if (!self.alive || (err && err.isAborted)) return;
    // Keine Schönfärberei: die Zeile bleibt, wo sie war, und sagt warum.
    self.ctx.toast(`Abhaken fehlgeschlagen: ${errorMessage(err)}`, 'error');
  } finally {
    self.busy.delete(task.id);
    if (self.alive) render(self);
  }
}

/* --------------------------------------------------- 2 · was ohne dich lief */

function renderOhneDich(self, data) {
  const o = data.ohneDich || {};
  const grund = missingReason(data, 'ohneDich');
  const summe = (o.gesamt || 0) + (o.laeufeGesamt || 0);

  const rows = [];
  for (const lauf of o.laeufe || []) {
    const name = lauf.agent || (lauf.agentId ? `Agent ${lauf.agentId}` : 'Ein Agent');
    const teile = [statusWort(lauf.status)];
    if (lauf.produziert) teile.push(lauf.produziert === 1 ? '1 Eintrag entstanden' : `${formatNumber(lauf.produziert)} Einträge entstanden`);
    if (lauf.netz) teile.push('hat das Netz benutzt');
    if (lauf.startedAt) teile.push(timeAgo(lauf.startedAt));
    rows.push(rowNode(self, {
      ziel: `#/agents?run=${encodeURIComponent(lauf.id)}`,
      titel: lauf.goal ? `${name}: ${lauf.goal}` : `${name} ist gelaufen`,
      unten: text(teile.filter(Boolean).join(' · ')),
      rechts: h('span.todayv__row-icon', { 'aria-hidden': 'true' }, icon(ICONS.agent)),
    }));
  }
  for (const aenderung of o.aenderungen || []) {
    rows.push(rowNode(self, {
      ziel: targetFor(aenderung.type, aenderung.id),
      titel: aenderung.label || `${SINGULAR[aenderung.type] || aenderung.type} ${aenderung.id}`,
      unten: text([timeAgo(aenderung.at), aenderung.runId ? 'in einem Agentenlauf' : null]
        .filter(Boolean).join(' · ')),
    }));
  }

  const kinder = h('div.todayv__rows', null,
    rows.length ? rows : emptyLine('Nichts lief ohne dich.'),
    o.unsicher
      ? h('p.todayv__note-quiet.meta', null, text(o.unsicher === 1
        ? 'Eine weitere Änderung trägt nur den Herkunftsstempel eines Agenten. '
          + 'Der sagt, wer den Eintrag angelegt hat – nicht, wer ihn zuletzt geändert hat.'
        : `${formatNumber(o.unsicher)} weitere Änderungen tragen nur den Herkunftsstempel eines Agenten. `
          + 'Der sagt, wer den Eintrag angelegt hat – nicht, wer ihn zuletzt geändert hat.'))
      : null,
    o.gekuerzt
      ? h('p.todayv__note-quiet.meta', null,
        text('Es sind mehr Einträge im Verlauf, als hier gelesen wurden. Die Zeitachse zeigt alle.'))
      : null);

  return blockNode(self, {
    name: 'ohnedich',
    titel: 'Ohne dich gelaufen',
    zahl: summe ? formatNumber(summe) : '',
    ziel: '#/timeline',
    zielLabel: 'Zeitachse',
    grund,
    kinder,
  });
}

function statusWort(status) {
  switch (status) {
    case 'done': return 'fertig';
    case 'failed': return 'fehlgeschlagen';
    case 'aborted': return 'abgebrochen';
    case 'running': return 'läuft noch';
    case 'queued': return 'wartet';
    case 'waiting-approval': return 'wartet auf deine Freigabe';
    default: return status ? String(status) : '';
  }
}

/* -------------------------------------------------- 3 · was vorgeschlagen ist */

function renderVorschlaege(self, data) {
  const v = data.vorschlaege || {};
  const grund = missingReason(data, 'vorschlaege');

  const rows = (v.oben || []).map((vorschlag) => rowNode(self, {
    ziel: `#/assist?kind=${encodeURIComponent(vorschlag.kind || '')}`,
    titel: vorschlag.title || 'Ohne Titel',
    unten: text([KIND_LABEL[vorschlag.kind] || vorschlag.kind, vorschlag.reason]
      .filter(Boolean).join(' · ')),
  }));

  const rest = (v.offen || 0) - rows.length;
  const kinder = h('div.todayv__rows', null,
    rows.length ? rows : emptyLine('Kein Vorschlag ist offen.'),
    rest > 0
      ? h('button.todayv__note', {
        type: 'button',
        onClick: () => self.ctx.navigate('#/assist'),
      }, text(rest === 1 ? 'Ein weiterer Vorschlag wartet.' : `${formatNumber(rest)} weitere Vorschläge warten.`))
      : null);

  return blockNode(self, {
    name: 'vorschlaege',
    titel: 'Vorgeschlagen',
    zahl: v.offen ? formatNumber(v.offen) : '',
    ziel: '#/assist',
    zielLabel: 'Vorschläge',
    grund,
    kinder,
  });
}

/* ------------------------------------------------ 4 · was sich geändert hat */

function renderSeitGestern(self, data) {
  const s = data.seitGestern || {};
  const grund = missingReason(data, 'seitGestern');

  const rows = (s.eintraege || []).slice(0, 6).map((eintrag) => rowNode(self, {
    ziel: targetFor(eintrag.type, eintrag.id),
    titel: eintrag.label || `${SINGULAR[eintrag.type] || eintrag.type} ${eintrag.id}`,
    unten: text([SINGULAR[eintrag.type] || eintrag.type, eintrag.neu ? 'neu' : 'geändert', timeAgo(eintrag.updatedAt)]
      .filter(Boolean).join(' · ')),
  }));

  const rest = (s.gesamt || 0) - rows.length;
  const kinder = h('div.todayv__rows', null,
    rows.length ? rows : emptyLine('Seit gestern hat sich nichts geändert.'),
    rest > 0
      ? h('button.todayv__note', {
        type: 'button',
        onClick: () => self.ctx.navigate('#/timeline'),
      }, text(rest === 1 ? 'Ein weiterer Eintrag hat sich geändert.' : `${formatNumber(rest)} weitere Einträge haben sich geändert.`))
      : null);

  return blockNode(self, {
    name: 'seitgestern',
    titel: 'Seit gestern',
    zahl: s.gesamt ? formatNumber(s.gesamt) : '',
    ziel: '#/timeline',
    zielLabel: 'Zeitachse',
    grund,
    kinder,
  });
}

/* --------------------------------------------------- 5 · die Wiedervorlage */

function renderWiedervorlage(self, data) {
  const items = Array.isArray(data.wiedervorlage) ? data.wiedervorlage : [];
  const grund = missingReason(data, 'wiedervorlage');

  const rows = items.map((notiz) => rowNode(self, {
    ziel: targetFor('note', notiz.id),
    titel: notiz.label || 'Ohne Titel',
    unten: text([notiz.grund, notiz.angeheftet ? null : `zuletzt ${formatDate(notiz.updatedAt)}`]
      .filter(Boolean).join(' · ')),
  }));

  const kinder = h('div.todayv__rows', null,
    rows.length ? rows : emptyLine('Es liegt nichts lange genug, um daran zu erinnern.'));

  return blockNode(self, {
    name: 'wiedervorlage',
    titel: 'Wiedervorlage',
    zahl: '',
    ziel: '#/notes',
    zielLabel: 'Notizen',
    grund,
    kinder,
  });
}

/* -------------------------------------------------------- Fuß: die Automatik */

function renderAutomatik(self, data) {
  const a = data.automatik || {};
  const grund = missingReason(data, 'automatik');

  let satz;
  if (a.eingeschaltet === null || a.eingeschaltet === undefined) {
    satz = grund
      ? `Ob die Automatik läuft, war nicht zu erfahren. ${grund}`
      : 'Ob die Automatik läuft, war nicht zu erfahren.';
  } else if (a.eingeschaltet) {
    const teile = [];
    if (a.zeitplaene && a.zeitplaene.eingeschaltet) {
      teile.push(a.zeitplaene.eingeschaltet === 1
        ? 'ein Zeitplan ist eingeschaltet'
        : `${zahlwort(a.zeitplaene.eingeschaltet)} Zeitpläne sind eingeschaltet`);
    }
    if (a.ausloeser && a.ausloeser.eingeschaltet) {
      teile.push(a.ausloeser.eingeschaltet === 1
        ? 'ein Auslöser ist scharf'
        : `${zahlwort(a.ausloeser.eingeschaltet)} Auslöser sind scharf`);
    }
    const naechster = a.naechster
      ? ` Der nächste Lauf ist am ${formatDate(a.naechster)} um ${uhrzeit(a.naechster)}.`
      : ' Ein nächster Lauf steht nicht fest.';
    satz = `Die Automatik läuft: ${teile.join(', ') || 'ohne eingeschaltete Einträge'}.${naechster}`;
  } else {
    satz = 'Die Automatik ist aus. Nichts läuft von allein.';
  }

  return h('section.todayv__automatik', { 'aria-label': 'Automatik' },
    h('span.todayv__automatik-icon', { 'aria-hidden': 'true' }, icon(ICONS.clock)),
    h('p.todayv__automatik-text', null, text(satz)),
    h('button.btn.btn--small.btn--ghost', {
      type: 'button',
      onClick: () => self.ctx.navigate('#/automation'),
    }, text('Automatik'), icon(ICONS.arrow)));
}

function uhrzeit(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  try {
    return new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

/* ------------------------------------------------------------------ */
/* Stil                                                                */
/* ------------------------------------------------------------------ */

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS;
  document.head.appendChild(node);
}

const CSS = `
.todayv { height: 100%; min-height: 0; overflow-y: auto; }
.todayv__inner {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  max-width: var(--content-max);
  margin: 0 auto;
  padding: var(--sp-3) var(--sp-3) var(--sp-8);
}

.todayv__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-1);
}
.todayv__lead {
  flex: 1 1 26ch;
  margin: 0;
  font-size: var(--fs-xl);
  line-height: var(--lh-tight);
  color: var(--fg);
}
.todayv__headmeta { display: flex; align-items: center; gap: var(--sp-1); }
.todayv__stand { white-space: nowrap; }

.todayv__blocks { display: flex; flex-direction: column; gap: var(--sp-2); }

.todayv__block {
  padding: var(--sp-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
  box-shadow: var(--shadow-1);
}
.todayv__block-head {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  margin-bottom: var(--sp-1);
}
.todayv__block-title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--fg);
}
.todayv__count { font-variant-numeric: tabular-nums; }
.todayv__more { margin-left: auto; }

.todayv__rows { display: flex; flex-direction: column; }
.todayv__row {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  border-radius: var(--r-2);
}
.todayv__row + .todayv__row { border-top: 1px solid var(--border); }
.todayv__row:hover { background: var(--surface-2); }
.todayv__row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
  padding: var(--sp-1);
  text-align: left;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.todayv__row-main:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: var(--r-2); }
.todayv__row-title {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.todayv__row-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.todayv__row-actions { display: flex; align-items: center; gap: 4px; padding-right: var(--sp-05); }
.todayv__row-icon { display: inline-flex; padding-right: var(--sp-1); color: var(--fg-subtle); }

.todayv__due { color: var(--fg-muted); }
.todayv__due.is-overdue { color: var(--danger); font-weight: 500; }
.todayv__row.is-overdue { border-left: 2px solid var(--danger); }

.todayv__tick {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  color: var(--fg-subtle);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-full);
  cursor: pointer;
  transition: color var(--dur-1) var(--ease), background var(--dur-1) var(--ease);
}
.todayv__tick:hover:not(:disabled) { color: var(--ok); background: var(--surface-3); border-color: var(--ok); }
.todayv__tick:disabled { cursor: progress; opacity: 0.6; }
.todayv__tick:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* Der gemeinsame .spinner misst 22px und sprengte den Knopf sonst. */
.todayv__tick .spinner { width: 14px; height: 14px; border-width: 2px; }

.todayv__empty { margin: 0; padding: var(--sp-1) 0; color: var(--fg-muted); }
.todayv__group {
  margin: var(--sp-1) 0 0;
  padding: 0 var(--sp-1);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: var(--fs-xs);
}
.todayv__note {
  margin-top: var(--sp-1);
  padding: var(--sp-1);
  text-align: left;
  font: inherit;
  color: var(--accent);
  background: none;
  border: 0;
  border-radius: var(--r-2);
  cursor: pointer;
}
.todayv__note:hover { background: var(--accent-soft); }
.todayv__note:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.todayv__note-quiet { margin: var(--sp-1) 0 0; padding: 0 var(--sp-1); }

.todayv__missing {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-1);
  margin: 0;
  padding: var(--sp-1);
  color: var(--warn);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
  font-size: var(--fs-sm);
}
.todayv__missing-icon { display: inline-flex; flex: none; }

.todayv__clear {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
  box-shadow: var(--shadow-1);
}
.todayv__clear-icon { display: inline-flex; flex: none; color: var(--ok); }
.todayv__clear-text { margin: 0; font-size: var(--fs-md); color: var(--fg); }

.todayv__automatik {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
  background: var(--surface-2);
}
.todayv__automatik-icon { display: inline-flex; flex: none; color: var(--fg-subtle); }
.todayv__automatik-text {
  flex: 1 1 24ch;
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--fg-muted);
}

.todayv__state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-1);
  max-width: 60ch;
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
  background: var(--surface);
}
.todayv__state.is-danger { border-color: var(--danger); background: var(--danger-soft); }
.todayv__state p { margin: 0; color: var(--fg-muted); }

@media (max-width: 820px) {
  .todayv__inner { padding: var(--sp-2) var(--sp-2) var(--sp-6); }
  .todayv__lead { font-size: var(--fs-lg); }
  .todayv__row-title { white-space: normal; }
}
`;
