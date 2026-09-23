/**
 * views/kalender.js -- der Kalender: Monat und Woche, heute markiert, Termine
 * als ruhige Bloecke mit dem blauen Balken aus der Vorlage.
 *
 * Wofuer er da ist, und was daraus folgt
 * --------------------------------------
 * Die Termine legt meistens die KI an ("das ist ein Termin"). Der Kalender
 * muss deshalb vor allem zeigen und erklaeren, nicht verwalten:
 *
 * - **Jeder Termin sagt, woher er kommt.** Ein automatisch angelegter nennt
 *   den Chat, aus dem er stammt, und fuehrt dorthin. Ein Eintrag, von dem
 *   niemand weiss, warum er im Kalender steht, ist schlimmer als keiner.
 * - **Anlegen von Hand geht, aber schlicht:** Titel, Tag, Uhrzeit, Ort. Wer
 *   mehr will, sagt es im Chat.
 * - **Monat mit Tagesliste daneben.** Der Monat zeigt, WANN etwas ist; die
 *   Liste rechts zeigt den gewaehlten Tag so, wie die Kachel "Kalender" den
 *   heutigen zeigt (Uhrzeit, blauer Balken, Titel, Ort) -- ein Bild, zwei Orte.
 * - **Live.** Legt die KI waehrend eines Gespraechs einen Termin an, erscheint
 *   er hier ohne Neuladen (record.* ueber /api/events, den Bus).
 *
 * Zeitangaben: "JJJJ-MM-TT" (ganztaegig), "JJJJ-MM-TTTHH:MM" (Uhrzeit vor
 * Ort) oder ein Zeitpunkt mit Zone -- dieselben Regeln wie im Server
 * (src/http/api/events.js). Angezeigt wird alles in der Ortszeit dieses
 * Browsers. Von Hand angelegte Termine bekommen die Uhrzeit vor Ort ohne Zone:
 * "um zehn" soll um zehn bleiben, egal an welchem Rechner der Stick steckt.
 *
 * Die reinen Datumsfunktionen stehen oben und werden exportiert, damit
 * test/kalender-ansicht.test.js sie ohne Browser pruefen kann.
 */

/* ------------------------------------------------------------------ */
/* Reine Datumsfunktionen (ohne DOM)                                   */
/* ------------------------------------------------------------------ */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/;
const ZONED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

const pad = (n) => String(n).padStart(2, '0');

/** Ein Datum als "JJJJ-MM-TT" in Ortszeit. */
export function toDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "JJJJ-MM-TT" als Mitternacht vor Ort. */
export function parseDay(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(day, n) {
  const d = parseDay(day);
  return toDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

/** Derselbe Tag im Monat daneben -- der 31. wird zum letzten, den es gibt. */
export function addMonths(day, n) {
  const d = parseDay(day);
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return toDay(new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), last)));
}

/** Der Montag der Woche, in der `day` liegt. */
export function startOfWeek(day) {
  const d = parseDay(day);
  return addDays(day, -((d.getDay() + 6) % 7));
}

/** Kalenderwoche nach ISO 8601 (die Woche mit dem ersten Donnerstag ist KW 1). */
export function isoWeek(day) {
  const d = parseDay(day);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

/**
 * Die Wochen, die ein Monatsblatt zeigt: von Montag vor dem Ersten bis
 * Sonntag nach dem Letzten -- vier bis sechs Zeilen, nie eine leere.
 * @returns {string[][]}
 */
export function monthGrid(cursor) {
  const d = parseDay(cursor);
  const first = toDay(new Date(d.getFullYear(), d.getMonth(), 1));
  const last = toDay(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  const start = startOfWeek(first);
  const end = addDays(startOfWeek(last), 6);
  const weeks = [];
  let week = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    week.push(day);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  return weeks;
}

/**
 * Eine Zeitangabe lesen, wie der Server sie liest.
 * @returns {{kind:'date'|'local'|'zoned', day:string, ms:number, hm:string|null, min:number}|null}
 */
export function whenOf(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  let m = DATE_RE.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (toDay(d) !== s) return null; // der 31. Februar
    return { kind: 'date', day: s, ms: d.getTime(), hm: null, min: 0 };
  }
  let d;
  let kind;
  m = LOCAL_RE.exec(s);
  if (m) {
    const [hh, mi] = [Number(m[4]), Number(m[5])];
    if (hh > 23 || mi > 59) return null;
    d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mi, Number(m[6] || 0));
    if (toDay(d) !== `${m[1]}-${m[2]}-${m[3]}`) return null;
    kind = 'local';
  } else if (ZONED_RE.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) return null;
    d = new Date(ms);
    kind = 'zoned';
  } else {
    return null;
  }
  return {
    kind,
    day: toDay(d),
    ms: d.getTime(),
    hm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    min: d.getHours() * 60 + d.getMinutes(),
  };
}

/**
 * Welche Tage ein Termin belegt (beide eingeschlossen), und ob er ganztaegig
 * ist. Ein Termin, der um Mitternacht endet, belegt den Folgetag nicht.
 */
export function spanOf(ev) {
  const start = whenOf(ev && ev.start);
  if (!start) return null;
  const allDay = (ev && ev.allDay === true) || start.kind === 'date';
  let end = whenOf(ev && ev.end);
  if (end && end.ms < start.ms) end = null;
  let lastDay = start.day;
  if (end) {
    lastDay = end.day;
    if (!allDay && end.kind !== 'date' && end.min === 0 && end.day > start.day) lastDay = addDays(end.day, -1);
  }
  return { allDay, firstDay: start.day, lastDay, start, end };
}

/** Beruehrt der Termin diesen Tag? */
export function onDay(span, day) {
  return !!span && span.firstDay <= day && span.lastDay >= day;
}

/**
 * Wie ein Termin an einem bestimmten Tag beschriftet wird: "09:00–10:00",
 * "ab 22:00", "bis 01:00", "ganztägig".
 */
export function timeLabel(span, day) {
  if (!span) return '';
  if (span.allDay) return 'ganztägig';
  const first = day === undefined || day === span.firstDay;
  const last = day === undefined || day === span.lastDay;
  if (first && last) return span.end && span.end.hm !== span.start.hm ? `${span.start.hm}–${span.end.hm}` : span.start.hm;
  if (first) return `ab ${span.start.hm}`;
  if (last && span.end) return `bis ${span.end.hm}`;
  return 'ganztägig';
}

/**
 * Nebeneinander, was sich ueberschneidet: jeder Block bekommt eine Spur und
 * erfaehrt, wie viele Spuren seine Gruppe braucht. Gierig und stabil --
 * derselbe Tag sieht bei jedem Zeichnen gleich aus.
 *
 * @param {{id:string, startMin:number, endMin:number}[]} items
 * @returns {{id:string, startMin:number, endMin:number, lane:number, lanes:number}[]}
 */
export function layoutDay(items) {
  const sorted = [...items].sort((a, b) => (a.startMin - b.startMin) || (b.endMin - a.endMin) || String(a.id).localeCompare(String(b.id)));
  const out = [];
  let group = [];
  let groupEnd = -1;
  const flush = () => {
    const laneEnds = [];
    const placed = group.map((item) => {
      let lane = laneEnds.findIndex((end) => end <= item.startMin);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(item.endMin);
      } else {
        laneEnds[lane] = item.endMin;
      }
      return { ...item, lane };
    });
    for (const item of placed) out.push({ ...item, lanes: laneEnds.length });
    group = [];
    groupEnd = -1;
  };
  for (const item of sorted) {
    if (group.length && item.startMin >= groupEnd) flush();
    group.push(item);
    groupEnd = Math.max(groupEnd, item.endMin);
  }
  if (group.length) flush();
  return out;
}

/* ------------------------------------------------------------------ */
/* Ansicht                                                             */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'nos-kalender-view';
const MODE_KEY = 'neural-os:kalender-ansicht';
const HOUR_PX = 48;
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

const GLYPH = {
  prev: '<path d="M12.2 5 7.2 10l5 5"/>',
  next: '<path d="m7.8 5 5 5-5 5"/>',
  pin: '<path d="M10 17.4s5.4-4.8 5.4-9.2a5.4 5.4 0 0 0-10.8 0c0 4.4 5.4 9.2 5.4 9.2z"/><circle cx="10" cy="8.2" r="1.9"/>',
  trash: '<path d="M4.6 5.8h10.8M8.2 5.8V4.2h3.6v1.6M6.2 5.8l.7 9.4a1.4 1.4 0 0 0 1.4 1.3h3.4a1.4 1.4 0 0 0 1.4-1.3l.7-9.4"/>',
};

const CSS = `
.kal {
  --kal-hour: ${HOUR_PX}px;
  container-type: inline-size;
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.kal__bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px var(--sp-2);
  padding: var(--sp-3) var(--sp-4) var(--sp-2);
}
.kal__period { display: flex; align-items: baseline; gap: 12px; min-width: 0; margin-right: auto; }
.kal__title { margin: 0; font-size: var(--fs-xl); font-weight: 500; letter-spacing: -0.01em; white-space: nowrap; }
.kal__sub { font-size: var(--fs-sm); color: var(--fg-subtle); white-space: nowrap; font-variant-numeric: tabular-nums; }
.kal__nav { display: flex; align-items: center; gap: 2px; }
.kal__body {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(260px, 30%, 320px);
  gap: var(--sp-3);
  padding: 0 var(--sp-4) var(--sp-4);
}
.kal__body.is-week { grid-template-columns: minmax(0, 1fr); }
.kal__notice { grid-column: 1 / -1; display: flex; align-items: center; gap: 12px; padding: 12px var(--sp-2); color: var(--danger); background: var(--danger-soft); border-radius: var(--r-3); font-size: var(--fs-sm); }

/* ---- Monat ---- */
.kal__month {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
  overflow: hidden;
}
.kal__dow { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); border-bottom: 1px solid var(--border); }
.kal__dow span { padding: 10px 12px 9px; font-size: var(--fs-xs); font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-subtle); }
.kal__weeks { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); grid-auto-rows: minmax(88px, 1fr); min-height: 0; }
.kal__day {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 3px;
  min-width: 0;
  min-height: 0;
  padding: 7px 7px 6px;
  overflow: hidden;
  font: inherit;
  text-align: left;
  color: var(--fg);
  background: none;
  border: 0;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease);
}
.kal__day:nth-child(7n) { border-right: 0; }
.kal__day.is-lastrow { border-bottom: 0; }
.kal__day.is-weekend { background: color-mix(in srgb, var(--surface-2) 55%, transparent); }
.kal__day:hover { background: var(--surface-2); }
.kal__day.is-selected { background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--border-strong); }
.kal__day:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent-ring); }
.kal__day.is-other { color: var(--fg-subtle); }
.kal__day.is-other .kal__pill { opacity: 0.55; }
.kal__num {
  display: inline-grid;
  place-items: center;
  align-self: flex-start;
  min-width: 26px;
  height: 26px;
  padding: 0 6px;
  margin-bottom: 2px;
  font-size: var(--fs-sm);
  font-variant-numeric: tabular-nums;
  border-radius: var(--r-full);
}
.kal__day.is-today .kal__num { color: var(--accent-fg); background: var(--accent); font-weight: 600; }
.kal__pill {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  min-height: 19px;
  padding: 1px 6px 1px 0;
  font-size: var(--fs-xs);
  line-height: 1.35;
  border-radius: 5px;
}
.kal__pill::before { content: ''; flex: none; align-self: stretch; width: 3px; border-radius: var(--r-full); background: var(--accent); }
.kal__pill.is-allday { padding-left: 7px; background: var(--accent-soft); }
.kal__pill.is-allday::before { display: none; }
.kal__pill-time { flex: none; color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.kal__pill-title { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--fg); }
.kal__day.is-other .kal__pill-title { color: var(--fg-muted); }
.kal__pill:hover .kal__pill-title { text-decoration: underline; text-decoration-color: var(--border-strong); text-underline-offset: 2px; }
.kal__more { padding-left: 9px; font-size: var(--fs-xs); color: var(--fg-subtle); }

/* ---- Tagesliste rechts ---- */
.kal__agenda { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.kal__agenda-head { display: flex; align-items: baseline; gap: 10px; padding: 4px 0 0; }
.kal__agenda-day { margin: 0; font-size: var(--fs-lg); font-weight: 500; }
.kal__agenda-date { font-size: var(--fs-sm); color: var(--fg-subtle); }
.kal__agenda-list { display: flex; flex-direction: column; gap: 10px; margin: var(--sp-2) 0 0; padding: 0; list-style: none; overflow-y: auto; min-height: 0; }
.kal__entry {
  display: grid;
  grid-template-columns: 46px 3px minmax(0, 1fr);
  gap: 12px;
  width: 100%;
  padding: 0;
  font: inherit;
  text-align: left;
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
}
.kal__entry-time { display: flex; flex-direction: column; gap: 6px; padding-top: 11px; font-size: var(--fs-sm); color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.kal__entry-bar { border-radius: var(--r-full); background: var(--accent); }
.kal__entry-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding: 10px 14px 11px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
  transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
}
.kal__entry:hover .kal__entry-card, .kal__entry.is-open .kal__entry-card { background: var(--surface-3); border-color: var(--border-strong); }
.kal__entry:focus-visible { outline: none; }
.kal__entry:focus-visible .kal__entry-card { box-shadow: 0 0 0 3px var(--accent-ring); }
.kal__entry-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--fg); }
.kal__entry-sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--fs-sm); color: var(--fg-subtle); }
.kal__entry.is-past { opacity: 0.55; }
.kal__auto { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--fg-subtle); }
.kal__auto .dot { width: 6px; height: 6px; }
.kal__agenda-empty { margin: var(--sp-2) 0 0; font-size: var(--fs-sm); color: var(--fg-subtle); line-height: var(--lh); }
.kal__agenda-add { align-self: flex-start; margin-top: var(--sp-2); }

/* ---- Woche ---- */
.kal__week { display: flex; flex-direction: column; min-height: 0; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-3); overflow: hidden; }
.kal__wgrid { display: grid; grid-template-columns: 58px repeat(7, minmax(0, 1fr)); }
.kal__whead { border-bottom: 1px solid var(--border); }
.kal__wday {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 10px 10px;
  font: inherit;
  font-size: var(--fs-sm);
  text-align: left;
  color: var(--fg-subtle);
  background: none;
  border: 0;
  border-left: 1px solid var(--border);
  cursor: pointer;
}
.kal__wday:hover { background: var(--surface-2); }
.kal__wday-num { display: inline-grid; place-items: center; min-width: 30px; height: 30px; padding: 0 6px; font-size: var(--fs-md); color: var(--fg); border-radius: var(--r-full); font-variant-numeric: tabular-nums; }
.kal__wday.is-today .kal__wday-num { color: var(--accent-fg); background: var(--accent); font-weight: 600; }
.kal__wallday { border-bottom: 1px solid var(--border); }
.kal__wallday-label { display: flex; align-items: center; justify-content: flex-end; padding: 0 8px; font-size: var(--fs-xs); color: var(--fg-subtle); }
.kal__wallday-cell { display: flex; flex-direction: column; gap: 3px; min-width: 0; min-height: 34px; padding: 5px; border-left: 1px solid var(--border); }
.kal__wscroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.kal__whours { position: relative; height: calc(24 * var(--kal-hour)); }
.kal__whours > .kal__wgrid { height: 100%; }
.kal__wlabels { position: relative; }
.kal__wlabel { position: absolute; right: 8px; transform: translateY(-50%); font-size: var(--fs-xs); color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.kal__wcol {
  position: relative;
  min-width: 0;
  border-left: 1px solid var(--border);
  background-image: repeating-linear-gradient(to bottom, var(--border) 0, var(--border) 1px, transparent 1px, transparent var(--kal-hour));
}
.kal__wcol.is-today { background-color: color-mix(in srgb, var(--accent) 4%, transparent); }
.kal__block {
  position: absolute;
  left: calc(var(--lane) * 100% / var(--lanes) + 3px);
  width: calc(100% / var(--lanes) - 6px);
  display: flex;
  gap: 7px;
  min-height: 22px;
  padding: 4px 8px 4px 0;
  overflow: hidden;
  font: inherit;
  font-size: var(--fs-xs);
  line-height: 1.35;
  text-align: left;
  color: var(--fg);
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
}
.kal__block::before { content: ''; flex: none; width: 3px; border-radius: var(--r-full); background: var(--accent); }
.kal__block:hover, .kal__block.is-open { background: var(--surface-4); border-color: var(--border-strong); }
.kal__block:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.kal__block-text { display: flex; flex-direction: column; min-width: 0; }
.kal__block-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 500; }
.kal__block-time { color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.kal__block.is-past { opacity: 0.6; }
.kal__now { position: absolute; left: 0; right: 0; height: 0; border-top: 2px solid var(--accent); pointer-events: none; z-index: 2; }
.kal__now::before { content: ''; position: absolute; left: -5px; top: -6px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
.kal__wallday .kal__pill { cursor: pointer; }

/* ---- Seitenblatt: Termin ansehen, anlegen, bearbeiten ---- */
.kal__sheet {
  position: absolute;
  top: var(--sp-2);
  right: var(--sp-2);
  z-index: 6;
  display: flex;
  flex-direction: column;
  width: min(390px, calc(100% - 2 * var(--sp-2)));
  max-height: calc(100% - 2 * var(--sp-2));
  overflow-y: auto;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-4);
  box-shadow: var(--shadow-3);
  animation: kal-in var(--dur-3) var(--ease);
}
@keyframes kal-in { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: none; } }
.kal__sheet-top { display: flex; align-items: center; gap: 8px; padding: 14px 14px 0 var(--sp-3); }
.kal__sheet-kicker { margin-right: auto; font-size: var(--fs-xs); font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-subtle); }
.kal__sheet-body { display: flex; flex-direction: column; gap: var(--sp-2); padding: 6px var(--sp-3) var(--sp-3); }
.kal__sheet-title { margin: 0; font-size: var(--fs-xl); font-weight: 500; line-height: var(--lh-tight); letter-spacing: -0.01em; overflow-wrap: anywhere; }
.kal__when { display: grid; grid-template-columns: 3px minmax(0, 1fr); gap: 12px; }
.kal__when-bar { border-radius: var(--r-full); background: var(--accent); }
.kal__when-day { display: block; color: var(--fg); }
.kal__when-time { display: block; font-size: var(--fs-sm); color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.kal__facts { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.kal__fact { display: flex; align-items: flex-start; gap: 10px; font-size: var(--fs-base); color: var(--fg-muted); line-height: var(--lh); }
.kal__fact svg { flex: none; width: 17px; height: 17px; margin-top: 3px; color: var(--fg-subtle); }
.kal__fact a { color: var(--accent-text); text-decoration: none; }
.kal__fact a:hover { text-decoration: underline; }
.kal__note { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: var(--lh); color: var(--fg); }
.kal__origin { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-3); }
.kal__origin-text { margin: 0; font-size: var(--fs-sm); line-height: var(--lh); color: var(--fg-muted); }
.kal__origin-text strong { font-weight: 500; color: var(--fg); }
.kal__origin .btn { align-self: flex-start; }
.kal__actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.kal__actions .spacer { flex: 1 1 auto; }
.kal__danger { color: var(--danger); }
.kal__form { display: flex; flex-direction: column; gap: 14px; }
.kal__form-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
.kal__form-error { margin: 0; padding: 10px 12px; font-size: var(--fs-sm); color: var(--danger); background: var(--danger-soft); border-radius: var(--r-2); }

/* Unter ~980 px ist neben dem Monat kein Platz fuer die Tagesliste, ohne dass
   die Titel in den Tagen zu zwei Buchstaben schrumpfen (gemessen am iPad quer:
   73 px je Spalte). Dann steht die Liste unter dem Monat. */
@container (max-width: 980px) {
  .kal__body { grid-template-columns: minmax(0, 1fr); overflow-y: auto; }
  .kal__month { min-height: 480px; }
  .kal__agenda-list { overflow: visible; }
  .kal__bar { padding: var(--sp-2) var(--sp-3); }
  .kal__body { padding: 0 var(--sp-3) var(--sp-3); }
}
@container (max-width: 560px) {
  .kal__weeks { grid-auto-rows: minmax(64px, 1fr); }
  .kal__pill-time, .kal__pill-title { display: none; }
  .kal__pill { min-height: 6px; height: 6px; padding: 0; }
  .kal__pill::before { width: 100%; }
  .kal__sheet { top: 0; right: 0; bottom: 0; width: 100%; border-radius: var(--r-4); }
  .kal__form-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .kal__wgrid { grid-template-columns: 40px repeat(7, minmax(0, 1fr)); }
  .kal__wday { flex-direction: column; gap: 2px; padding: 6px 2px; }
}
@media (pointer: coarse) {
  .kal__block { min-height: var(--tap-min); }
  .kal__wday { min-height: var(--tap-min); }
}
@media (prefers-reduced-motion: reduce) {
  .kal__sheet { animation: none; }
}
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS;
  document.head.appendChild(node);
}

function readMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'woche' ? 'woche' : 'monat';
  } catch {
    return 'monat';
  }
}

function writeMode(mode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch { /* privat surfen: dann eben nicht gemerkt */ }
}

function fmt(day, opts) {
  try {
    return new Intl.DateTimeFormat('de-DE', opts).format(parseDay(day));
  } catch {
    return day;
  }
}

function errorText(err) {
  return (err && err.message) || 'Unbekannter Fehler.';
}

/** Die naechste volle Stunde, fuer das Formular "Neuer Termin" von heute. */
function nextFullHour(now = new Date()) {
  const h = Math.min(23, now.getHours() + 1);
  return `${pad(h)}:00`;
}

export default {
  id: 'kalender',
  title: 'Kalender',

  async mount(container, ctx) {
    ensureStyle();
    const { h, text, clear, icon, api, icons, bus, toast, confirm } = ctx;
    const I = { ...icons, ...GLYPH };

    const today = () => toDay(new Date());
    const st = {
      mode: readMode(),
      cursor: today(),
      selected: today(),
      events: [],
      spans: new Map(),
      chats: {},
      projekte: {},
      range: null,
      loaded: false,
      error: null,
      token: 0,
      sheet: null, // { kind: 'detail'|'neu'|'bearbeiten', id?, data? }
      alive: true,
    };
    const cleanups = [];

    /* ---------------- Grundgeruest ---------------- */

    const root = h('div.kal');
    const bar = h('header.kal__bar');
    const body = h('div.kal__body', { 'aria-live': 'polite' });
    root.append(bar, body);
    container.appendChild(root);

    const dom = {
      title: h('h2.kal__title'),
      sub: h('span.kal__sub'),
      prev: h('button.icon-button', { type: 'button', onClick: () => move(-1) }, icon(I.prev)),
      next: h('button.icon-button', { type: 'button', onClick: () => move(1) }, icon(I.next)),
      heute: h('button.btn.btn--ghost.btn--small', { type: 'button', onClick: () => goToday() }, text('Heute')),
      modes: {},
      sheet: null,
    };
    const segmented = h('div.segmented', { role: 'group', 'aria-label': 'Ansicht' });
    for (const [mode, label] of [['monat', 'Monat'], ['woche', 'Woche']]) {
      const b = h('button.segmented__option', { type: 'button', onClick: () => setMode(mode) }, text(label));
      dom.modes[mode] = b;
      segmented.appendChild(b);
    }
    const addButton = h('button.btn.btn--accent', { type: 'button', onClick: () => openForm(null) },
      icon(I.plus), text('Termin'));
    bar.append(
      h('div.kal__period', null, dom.title, dom.sub),
      h('div.kal__nav', null, dom.prev, dom.heute, dom.next),
      segmented,
      addButton);

    /* ---------------- Daten ---------------- */

    function rangeFor(mode, cursor) {
      if (mode === 'woche') {
        const from = startOfWeek(cursor);
        return { from, to: addDays(from, 6) };
      }
      const weeks = monthGrid(cursor);
      return { from: weeks[0][0], to: weeks[weeks.length - 1][6] };
    }

    async function load() {
      const token = ++st.token;
      const range = rangeFor(st.mode, st.cursor);
      try {
        const res = await api.get('/events/zeitraum', { query: range });
        if (!st.alive || token !== st.token) return;
        st.events = Array.isArray(res && res.items) ? res.items : [];
        st.spans = new Map(st.events.map((r) => [r.id, spanOf(r.data)]));
        st.chats = (res && res.chats) || {};
        st.projekte = (res && res.projekte) || {};
        st.range = range;
        st.error = null;
      } catch (err) {
        if (!st.alive || token !== st.token) return;
        st.error = errorText(err);
        st.range = range;
      }
      st.loaded = true;
      render();
    }

    let reloadTimer = null;
    function reloadSoon() {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => load(), 250);
    }

    /** Termine eines Tages: ganztaegige zuerst, dann nach Beginn. */
    function eventsOn(day) {
      const out = [];
      for (const r of st.events) {
        const span = st.spans.get(r.id);
        if (onDay(span, day)) out.push(r);
      }
      out.sort((a, b) => {
        const sa = st.spans.get(a.id);
        const sb = st.spans.get(b.id);
        const aa = sa.allDay || sa.firstDay < day;
        const ab = sb.allDay || sb.firstDay < day;
        if (aa !== ab) return aa ? -1 : 1;
        return sa.start.ms - sb.start.ms;
      });
      return out;
    }

    function isPast(span) {
      const now = Date.now();
      if (span.allDay) return span.lastDay < today();
      const end = span.end ? span.end.ms : span.start.ms + 60 * 60000;
      return end < now;
    }

    /* ---------------- Steuerung ---------------- */

    function setMode(mode) {
      if (st.mode === mode) return;
      st.mode = mode;
      writeMode(mode);
      st.cursor = st.selected;
      load();
      render();
    }

    function move(step) {
      if (st.mode === 'woche') {
        st.cursor = addDays(st.cursor, 7 * step);
        st.selected = addDays(st.selected, 7 * step);
      } else {
        st.cursor = addMonths(st.cursor, step);
        const d = parseDay(st.cursor);
        // Im neuen Monat ist heute gewaehlt, wenn heute darin liegt, sonst der Erste.
        const t = parseDay(today());
        st.selected = t.getFullYear() === d.getFullYear() && t.getMonth() === d.getMonth()
          ? today()
          : toDay(new Date(d.getFullYear(), d.getMonth(), 1));
      }
      load();
      render();
    }

    function goToday() {
      st.cursor = today();
      st.selected = today();
      load();
      render();
    }

    function select(day, { focus = false } = {}) {
      const range = rangeFor(st.mode, st.cursor);
      st.selected = day;
      if (day < range.from || day > range.to) {
        st.cursor = day;
        load();
      }
      render();
      if (focus) {
        const el = body.querySelector(`[data-day="${day}"]`);
        if (el) el.focus();
      }
    }

    /* ---------------- Zeichnen ---------------- */

    function renderBar() {
      if (st.mode === 'woche') {
        const from = startOfWeek(st.cursor);
        const to = addDays(from, 6);
        const sameMonth = from.slice(0, 7) === to.slice(0, 7);
        const title = sameMonth
          ? fmt(from, { month: 'long', year: 'numeric' })
          : `${fmt(from, { month: 'short' })} – ${fmt(to, { month: 'short', year: 'numeric' })}`;
        setText(dom.title, title);
        setText(dom.sub, `KW ${isoWeek(from)} · ${fmt(from, { day: 'numeric', month: 'numeric' })}–${fmt(to, { day: 'numeric', month: 'numeric' })}`);
        dom.prev.setAttribute('aria-label', 'Vorherige Woche');
        dom.next.setAttribute('aria-label', 'Nächste Woche');
      } else {
        setText(dom.title, fmt(st.cursor, { month: 'long', year: 'numeric' }));
        const n = st.loaded && !st.error ? countInMonth() : null;
        setText(dom.sub, n === null ? '' : n === 0 ? 'keine Termine' : n === 1 ? '1 Termin' : `${n} Termine`);
        dom.prev.setAttribute('aria-label', 'Vorheriger Monat');
        dom.next.setAttribute('aria-label', 'Nächster Monat');
      }
      dom.prev.title = dom.prev.getAttribute('aria-label');
      dom.next.title = dom.next.getAttribute('aria-label');
      for (const [mode, b] of Object.entries(dom.modes)) {
        b.classList.toggle('is-active', mode === st.mode);
        b.setAttribute('aria-pressed', mode === st.mode ? 'true' : 'false');
      }
    }

    function countInMonth() {
      const month = st.cursor.slice(0, 7);
      let n = 0;
      for (const span of st.spans.values()) {
        if (span && span.firstDay.slice(0, 7) <= month && span.lastDay.slice(0, 7) >= month) n += 1;
      }
      return n;
    }

    function setText(el, value) {
      if (el.textContent !== value) {
        clear(el);
        el.appendChild(text(value));
      }
    }

    function render() {
      if (!st.alive) return;
      renderBar();
      const scroller = body.querySelector('.kal__wscroll');
      const keepScroll = scroller ? scroller.scrollTop : null;
      clear(body);
      body.classList.toggle('is-week', st.mode === 'woche');
      if (st.error) {
        body.appendChild(h('div.kal__notice', { role: 'alert' },
          text(`Die Termine konnten nicht geladen werden: ${st.error}`),
          h('button.btn.btn--small', { type: 'button', onClick: () => load() }, text('Erneut versuchen'))));
      }
      if (st.mode === 'woche') {
        body.appendChild(renderWeek());
        const next = body.querySelector('.kal__wscroll');
        if (next) {
          if (keepScroll !== null) next.scrollTop = keepScroll;
          else scrollWeekToMorning(next);
        }
      } else {
        body.append(renderMonth(), renderAgenda());
      }
      markOpen();
    }

    function renderMonth() {
      const weeks = monthGrid(st.cursor);
      const month = st.cursor.slice(0, 7);
      const t = today();
      const grid = h('div.kal__weeks', { role: 'grid', 'aria-label': fmt(st.cursor, { month: 'long', year: 'numeric' }) });
      weeks.forEach((week, wi) => {
        week.forEach((day, di) => {
          const list = eventsOn(day);
          const shown = list.slice(0, 3);
          const more = list.length - shown.length;
          const label = `${fmt(day, { weekday: 'long', day: 'numeric', month: 'long' })}${list.length ? `, ${list.length === 1 ? '1 Termin' : `${list.length} Termine`}` : ''}${day === t ? ', heute' : ''}`;
          const cell = h('button.kal__day', {
            type: 'button',
            'data-day': day,
            'aria-label': label,
            'aria-pressed': day === st.selected ? 'true' : 'false',
            tabindex: day === st.selected ? '0' : '-1',
            class: {
              'is-other': day.slice(0, 7) !== month,
              'is-today': day === t,
              'is-selected': day === st.selected,
              'is-weekend': di >= 5,
              'is-lastrow': wi === weeks.length - 1,
            },
            onClick: (event) => {
              const pill = event.target.closest('[data-event]');
              select(day);
              if (pill) openDetail(pill.dataset.event);
            },
          },
          h('span.kal__num', { 'aria-hidden': 'true' }, text(String(parseDay(day).getDate()))),
          ...shown.map((r) => {
            const span = st.spans.get(r.id);
            const allDayLike = span.allDay || (span.firstDay < day && span.lastDay > day);
            const time = allDayLike ? '' : timeLabel(span, day).replace(/–.*$/, '');
            return h('span.kal__pill', { 'data-event': r.id, class: allDayLike ? 'is-allday' : '', title: `${timeLabel(span, day)} · ${r.data.title}` },
              time ? h('span.kal__pill-time', null, text(time)) : null,
              h('span.kal__pill-title', null, text(r.data.title)));
          }),
          more > 0 ? h('span.kal__more', null, text(`+${more} weitere`)) : null);
          grid.appendChild(cell);
        });
      });
      grid.addEventListener('keydown', onGridKey);
      return h('section.kal__month', { 'aria-label': 'Monat' },
        h('div.kal__dow', { 'aria-hidden': 'true' }, ...WEEKDAYS.map((d) => h('span', null, text(d)))),
        grid);
    }

    function onGridKey(event) {
      const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (event.key in steps) {
        event.preventDefault();
        select(addDays(st.selected, steps[event.key]), { focus: true });
      } else if (event.key === 'Home') {
        event.preventDefault();
        select(startOfWeek(st.selected), { focus: true });
      } else if (event.key === 'End') {
        event.preventDefault();
        select(addDays(startOfWeek(st.selected), 6), { focus: true });
      }
    }

    function renderAgenda() {
      const day = st.selected;
      const list = eventsOn(day);
      const t = today();
      const relative = day === t ? 'Heute' : day === addDays(t, 1) ? 'Morgen' : day === addDays(t, -1) ? 'Gestern' : fmt(day, { weekday: 'long' });
      const section = h('section.kal__agenda', { 'aria-label': `Termine am ${fmt(day, { day: 'numeric', month: 'long' })}` },
        h('div.kal__agenda-head', null,
          h('h3.kal__agenda-day', null, text(relative)),
          h('span.kal__agenda-date', null, text(fmt(day, relative === fmt(day, { weekday: 'long' })
            ? { day: 'numeric', month: 'long' }
            : { weekday: 'long', day: 'numeric', month: 'long' })))));
      if (!st.loaded) return section;
      if (!list.length) {
        section.append(
          h('p.kal__agenda-empty', null, text(day === t ? 'Heute nichts eingetragen.' : 'Nichts eingetragen.')),
          h('p.kal__agenda-empty', null, text('Sag im Chat „das ist ein Termin“ – er landet dann hier.')),
          h('button.btn.btn--small.kal__agenda-add', { type: 'button', onClick: () => openForm(null, day) },
            icon(I.plus), text('Termin an diesem Tag')));
        return section;
      }
      const ul = h('ul.kal__agenda-list');
      for (const r of list) {
        const span = st.spans.get(r.id);
        const label = timeLabel(span, day);
        const [von, bis] = label.includes('–') ? label.split('–') : [label, ''];
        const sub = [r.data.location, r.data.source === 'auto' && st.chats[r.data.chatId] ? `aus „${st.chats[r.data.chatId].title}“` : null]
          .filter(Boolean).join(' · ');
        ul.appendChild(h('li', null,
          h('button.kal__entry', {
            type: 'button',
            'data-event': r.id,
            class: isPast(span) ? 'is-past' : '',
            onClick: () => openDetail(r.id),
          },
          h('span.kal__entry-time', null,
            h('span', null, text(von === 'ganztägig' ? 'ganzt.' : von)),
            bis ? h('span', null, text(bis)) : null),
          h('span.kal__entry-bar', { 'aria-hidden': 'true' }),
          h('span.kal__entry-card', null,
            h('span.kal__entry-title', null, text(r.data.title)),
            sub ? h('span.kal__entry-sub', null, text(sub)) : null))));
      }
      section.appendChild(ul);
      return section;
    }

    function renderWeek() {
      const from = startOfWeek(st.cursor);
      const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
      const t = today();

      const head = h('div.kal__wgrid.kal__whead', null, h('span', { 'aria-hidden': 'true' }),
        ...days.map((day) => h('button.kal__wday', {
          type: 'button',
          class: day === t ? 'is-today' : '',
          'aria-label': fmt(day, { weekday: 'long', day: 'numeric', month: 'long' }),
          onClick: () => {
            st.mode = 'monat';
            writeMode('monat');
            select(day);
            load();
          },
        },
        h('span', null, text(WEEKDAYS[(parseDay(day).getDay() + 6) % 7])),
        h('span.kal__wday-num', null, text(String(parseDay(day).getDate()))))));

      const allday = h('div.kal__wgrid.kal__wallday', null, h('span.kal__wallday-label', null, text('ganzt.')));
      const columns = h('div.kal__wgrid');
      columns.appendChild(h('div.kal__wlabels', { 'aria-hidden': 'true' },
        ...Array.from({ length: 23 }, (_, i) => h('span.kal__wlabel', { style: { top: `${(i + 1) * HOUR_PX}px` } }, text(`${pad(i + 1)}:00`)))));

      for (const day of days) {
        const cell = h('div.kal__wallday-cell');
        const col = h('div.kal__wcol', { class: day === t ? 'is-today' : '', 'data-day': day });
        const timed = [];
        for (const r of eventsOn(day)) {
          const span = st.spans.get(r.id);
          const whole = span.allDay || (span.firstDay < day && span.lastDay > day);
          if (whole) {
            cell.appendChild(h('span.kal__pill.is-allday', {
              'data-event': r.id,
              role: 'button',
              tabindex: '0',
              title: r.data.title,
              onClick: () => openDetail(r.id),
              onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.id); } },
            }, h('span.kal__pill-title', null, text(r.data.title))));
            continue;
          }
          const startMin = span.firstDay === day ? span.start.min : 0;
          let endMin;
          if (span.lastDay === day && span.end) endMin = span.end.day === day ? span.end.min : 24 * 60;
          else if (span.lastDay > day) endMin = 24 * 60;
          else endMin = startMin + 60; // ohne Ende: eine Stunde, damit man ihn sieht
          timed.push({ id: r.id, startMin, endMin: Math.max(endMin, startMin + 30), record: r, span });
        }
        for (const item of layoutDay(timed)) {
          const { record: r, span } = timed.find((x) => x.id === item.id);
          const top = (item.startMin / 60) * HOUR_PX;
          const height = Math.max(22, ((item.endMin - item.startMin) / 60) * HOUR_PX - 2);
          col.appendChild(h('button.kal__block', {
            type: 'button',
            'data-event': r.id,
            class: isPast(span) ? 'is-past' : '',
            style: { top: `${top}px`, height: `${height}px`, '--lane': item.lane, '--lanes': item.lanes },
            'aria-label': `${timeLabel(span, day)}, ${r.data.title}`,
            onClick: () => openDetail(r.id),
          },
          h('span.kal__block-text', null,
            h('span.kal__block-title', null, text(r.data.title)),
            height >= 38 ? h('span.kal__block-time', null, text(timeLabel(span, day))) : null)));
        }
        if (day === t) {
          const now = new Date();
          col.appendChild(h('span.kal__now', { style: { top: `${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX}px` }, 'aria-hidden': 'true' }));
        }
        allday.appendChild(cell);
        columns.appendChild(col);
      }

      return h('section.kal__week', { 'aria-label': 'Woche' },
        head,
        allday,
        h('div.kal__wscroll', null, h('div.kal__whours', null, columns)));
    }

    function scrollWeekToMorning(scroller) {
      const now = new Date();
      const inWeek = startOfWeek(today()) === startOfWeek(st.cursor);
      const hour = inWeek ? Math.max(0, Math.min(now.getHours() - 1, 16)) : 7;
      scroller.scrollTop = Math.max(0, hour * HOUR_PX - 8);
    }

    function markOpen() {
      const openId = st.sheet && st.sheet.kind === 'detail' ? st.sheet.id : null;
      for (const el of body.querySelectorAll('.kal__entry, .kal__block')) {
        el.classList.toggle('is-open', !!openId && el.dataset.event === openId);
      }
    }

    /* ---------------- Seitenblatt ---------------- */

    function closeSheet({ keepRoute = false } = {}) {
      if (dom.sheet) dom.sheet.remove();
      dom.sheet = null;
      const hadId = st.sheet && st.sheet.kind !== 'neu';
      st.sheet = null;
      markOpen();
      if (!keepRoute && hadId && typeof ctx.replaceRoute === 'function') ctx.replaceRoute('#/kalender');
    }

    function showSheet(kicker, ...content) {
      if (dom.sheet) dom.sheet.remove();
      const close = h('button.icon-button', { type: 'button', 'aria-label': 'Schließen', title: 'Schließen (Esc)', onClick: () => closeSheet() }, icon(I.close));
      dom.sheet = h('aside.kal__sheet', { role: 'region', 'aria-label': kicker },
        h('div.kal__sheet-top', null, h('span.kal__sheet-kicker', null, text(kicker)), close),
        h('div.kal__sheet-body', null, ...content));
      root.appendChild(dom.sheet);
      markOpen();
      return dom.sheet;
    }

    async function openDetail(id, { fromRoute = false } = {}) {
      let res;
      try {
        res = await api.get(`/events/${encodeURIComponent(id)}`);
      } catch (err) {
        if (!st.alive) return;
        toast(err && err.status === 404 ? 'Diesen Termin gibt es nicht mehr.' : `Der Termin konnte nicht geöffnet werden: ${errorText(err)}`, 'error');
        if (fromRoute && typeof ctx.replaceRoute === 'function') ctx.replaceRoute('#/kalender');
        return;
      }
      if (!st.alive) return;
      const record = res.record;
      const span = spanOf(record.data);
      if (span) {
        const range = rangeFor(st.mode, st.cursor);
        st.selected = span.firstDay;
        if (span.firstDay < range.from || span.firstDay > range.to) {
          st.cursor = span.firstDay;
          await load();
        } else {
          render();
        }
      }
      st.sheet = { kind: 'detail', id: record.id, data: res };
      renderDetail(res);
      if (!fromRoute && typeof ctx.replaceRoute === 'function') ctx.replaceRoute(`#/kalender?id=${record.id}`);
    }

    function renderDetail(res) {
      const record = res.record;
      const data = record.data;
      const span = spanOf(data);
      const dayLine = span
        ? (span.firstDay === span.lastDay
          ? fmt(span.firstDay, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
          : `${fmt(span.firstDay, { weekday: 'short', day: 'numeric', month: 'short' })} – ${fmt(span.lastDay, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`)
        : 'Zeitpunkt unlesbar';
      const timeLine = span ? (span.allDay ? 'ganztägig' : (span.firstDay === span.lastDay ? timeLabel(span) : `${span.start.hm} – ${span.end ? span.end.hm : ''}`)) : String(data.start || '');

      const facts = h('ul.kal__facts');
      if (data.location) facts.appendChild(h('li.kal__fact', null, icon(I.pin), h('span', null, text(data.location))));
      if (res.projekt) {
        facts.appendChild(h('li.kal__fact', null, icon(I.projects),
          h('span', null, text('Projekt '), h('a', { href: `#/projects?id=${encodeURIComponent(res.projekt.id)}` }, text(res.projekt.name)))));
      }

      let origin;
      if (data.source === 'auto') {
        const chat = res.chat;
        origin = h('div.kal__origin', null,
          h('span.kal__auto', null, h('span.dot.dot--accent'), text('Automatisch erkannt')),
          h('p.kal__origin-text', null,
            chat
              ? [text(chat.deleted ? 'Angelegt aus dem inzwischen gelöschten Chat ' : 'Angelegt aus dem Chat '), h('strong', null, text(`„${chat.title}“`)),
                text(`, ${fmtStamp(record.createdAt)}.`)]
              : text('Die KI hat ihn angelegt; der Chat dazu ist nicht mehr auffindbar.')),
          chat && !chat.deleted
            ? h('button.btn.btn--accent.btn--small', { type: 'button', onClick: () => ctx.navigate(`#/chat?id=${encodeURIComponent(chat.id)}`) },
              icon(I.chat), text('Zum Chat'))
            : null);
      } else {
        origin = h('div.kal__origin', null,
          h('p.kal__origin-text', null, text(`Von dir eingetragen, ${fmtStamp(record.createdAt)}.`)));
      }

      const del = h('button.btn.btn--ghost.kal__danger', { type: 'button', onClick: () => remove(record) }, icon(I.trash), text('Löschen'));
      showSheet('Termin',
        h('h2.kal__sheet-title', { tabindex: '-1' }, text(data.title)),
        h('div.kal__when', null, h('span.kal__when-bar', { 'aria-hidden': 'true' }),
          h('div', null, h('span.kal__when-day', null, text(dayLine)), h('span.kal__when-time', null, text(timeLine)))),
        facts.childNodes.length ? facts : null,
        data.body ? h('p.kal__note', null, text(data.body)) : null,
        origin,
        h('div.kal__actions', null,
          h('button.btn', { type: 'button', onClick: () => openForm(res) }, icon(I.pen), text('Bearbeiten')),
          h('span.spacer'),
          del));
      const title = dom.sheet.querySelector('.kal__sheet-title');
      if (title) title.focus({ preventScroll: true });
    }

    function fmtStamp(iso) {
      const d = new Date(iso);
      if (!Number.isFinite(d.getTime())) return '';
      const day = toDay(d);
      const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      if (day === today()) return `heute ${hm}`;
      if (day === addDays(today(), -1)) return `gestern ${hm}`;
      return `${fmt(day, { day: 'numeric', month: 'short', year: 'numeric' })}, ${hm}`;
    }

    async function remove(record) {
      const ok = await confirm({
        title: 'Termin löschen?',
        message: `„${record.data.title}“ verschwindet aus dem Kalender. Du kannst es gleich danach rückgängig machen.`,
        confirmLabel: 'Löschen',
        danger: true,
      });
      if (!ok || !st.alive) return;
      try {
        await api.del(`/events/${encodeURIComponent(record.id)}`);
      } catch (err) {
        toast(`Löschen hat nicht geklappt: ${errorText(err)}`, 'error');
        return;
      }
      closeSheet();
      await load();
      toast(`„${record.data.title}“ gelöscht.`, 'success', {
        action: {
          label: 'Rückgängig',
          run: async () => {
            try {
              await api.post(`/records/${encodeURIComponent(record.id)}/restore`);
              await load();
            } catch (err) {
              toast(`Wiederherstellen hat nicht geklappt: ${errorText(err)}`, 'error');
            }
          },
        },
        timeout: 9000,
      });
    }

    /**
     * Anlegen und Bearbeiten: Titel, Tag, von, bis, Ort. Mehr nicht -- wer
     * mehr will, sagt es im Chat. Ohne Uhrzeit ist der Termin ganztaegig.
     */
    function openForm(res, day) {
      const record = res ? res.record : null;
      const data = record ? record.data : null;
      const span = data ? spanOf(data) : null;
      const startDay = span ? span.firstDay : (day || st.selected || today());
      const von = span && !span.allDay ? span.start.hm : (record ? '' : (startDay === today() ? nextFullHour() : '09:00'));
      const bis = span && !span.allDay && span.end ? span.end.hm : '';

      const f = {
        title: h('input.input', { type: 'text', name: 'titel', required: true, maxlength: '500', autocomplete: 'off', value: data ? data.title : '', placeholder: 'z. B. Zahnarzt' }),
        day: h('input.input', { type: 'date', name: 'tag', required: true, value: startDay }),
        von: h('input.input', { type: 'time', name: 'von', value: von, step: '300' }),
        bis: h('input.input', { type: 'time', name: 'bis', value: bis, step: '300' }),
        ort: h('input.input', { type: 'text', name: 'ort', maxlength: '500', autocomplete: 'off', value: data ? data.location || '' : '', placeholder: 'optional' }),
      };
      const error = h('p.kal__form-error', { role: 'alert', hidden: true });
      const submit = h('button.btn.btn--primary', { type: 'submit' }, text(record ? 'Speichern' : 'Eintragen'));
      const form = h('form.kal__form', {
        novalidate: true,
        onSubmit: async (event) => {
          event.preventDefault();
          const input = collect();
          if (typeof input === 'string') {
            showError(input);
            return;
          }
          submit.disabled = true;
          try {
            const saved = record
              ? await api.patch(`/events/${encodeURIComponent(record.id)}`, input)
              : await api.post('/events', input);
            if (!st.alive) return;
            const id = saved.record.id;
            toast(record ? 'Termin gespeichert.' : `„${saved.record.data.title}“ eingetragen.`, 'success');
            await openDetail(id);
          } catch (err) {
            showError(errorText(err));
          } finally {
            submit.disabled = false;
          }
        },
      },
      h('label.field', null, h('span.label', null, text('Titel')), f.title),
      h('div.kal__form-row', null,
        h('label.field', null, h('span.label', null, text('Tag')), f.day),
        h('label.field', null, h('span.label', null, text('von')), f.von),
        h('label.field', null, h('span.label', null, text('bis')), f.bis)),
      h('p.hint', { style: { margin: '-4px 0 0' } }, text('Ohne Uhrzeit ist der Termin ganztägig.')),
      h('label.field', null, h('span.label', null, text('Ort')), f.ort),
      error,
      h('div.kal__actions', null, submit,
        h('button.btn.btn--ghost', { type: 'button', onClick: () => (record ? openDetail(record.id) : closeSheet()) }, text('Abbrechen'))));

      function showError(message) {
        clear(error);
        error.appendChild(text(message));
        error.hidden = false;
      }

      /** Aus dem Formular die Felder, die der Server erwartet -- oder ein Satz, was fehlt. */
      function collect() {
        const title = f.title.value.trim();
        const tag = f.day.value;
        const vonV = f.von.value;
        const bisV = f.bis.value;
        if (!title) {
          f.title.focus();
          return 'Bitte einen Titel eingeben.';
        }
        if (!DATE_RE.test(tag)) {
          f.day.focus();
          return 'Bitte einen Tag wählen.';
        }
        if (!vonV && bisV) {
          f.von.focus();
          return 'Ein Ende ohne Beginn geht nicht – bitte auch „von“ ausfüllen.';
        }
        // Mehrtaegiges bleibt mehrtaegig: das Ende wandert mit, wenn der Tag sich aendert.
        const shift = span ? Math.round((parseDay(tag) - parseDay(span.firstDay)) / 86400000) : 0;
        const out = { title, location: f.ort.value.trim() };
        if (!vonV) {
          out.allDay = true;
          out.start = tag;
          out.end = span && span.allDay && span.lastDay > span.firstDay ? addDays(span.lastDay, shift) : null;
        } else {
          out.allDay = false;
          out.start = `${tag}T${vonV}`;
          if (bisV) {
            const endDay = span && !span.allDay && span.end && span.end.day > span.firstDay ? addDays(span.end.day, shift) : tag;
            if (endDay === tag && bisV < vonV) {
              f.bis.focus();
              return 'Das Ende liegt vor dem Beginn.';
            }
            out.end = `${endDay}T${bisV}`;
          } else {
            out.end = null;
          }
        }
        return out;
      }

      st.sheet = { kind: record ? 'bearbeiten' : 'neu', id: record ? record.id : null };
      showSheet(record ? 'Termin bearbeiten' : 'Neuer Termin', form);
      f.title.focus();
    }

    /* ---------------- Live und Aufraeumen ---------------- */

    const isEvent = (payload) => payload && (payload.type === 'event' || (payload.record && payload.record.type === 'event'));
    for (const name of ['record.created', 'record.updated', 'record.deleted']) {
      cleanups.push(bus.on(name, (payload) => {
        if (!isEvent(payload)) return;
        reloadSoon();
        if (st.sheet && st.sheet.kind === 'detail' && st.sheet.id === payload.id) {
          if (name === 'record.deleted') closeSheet();
          else openDetail(payload.id, { fromRoute: true });
        }
      }));
    }

    const onKey = (event) => {
      if (event.key === 'Escape' && dom.sheet && !event.defaultPrevented && !document.querySelector('.dialog')) {
        event.preventDefault();
        closeSheet();
      }
    };
    document.addEventListener('keydown', onKey);
    cleanups.push(() => document.removeEventListener('keydown', onKey));

    // Die Jetzt-Linie wandert, und um Mitternacht wird aus "heute" "gestern".
    let lastDay = today();
    const tick = setInterval(() => {
      if (lastDay !== today()) {
        lastDay = today();
        render();
        return;
      }
      const line = body.querySelector('.kal__now');
      if (line) {
        const now = new Date();
        line.style.top = `${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX}px`;
      }
    }, 60000);
    cleanups.push(() => clearInterval(tick));
    cleanups.push(() => clearTimeout(reloadTimer));

    this._cleanup = () => {
      st.alive = false;
      for (const fn of cleanups.splice(0)) {
        try { fn(); } catch { /* weiter aufraeumen */ }
      }
    };

    render();
    await load();
    const wanted = ctx.route && ctx.route.params ? ctx.route.params.id : null;
    if (wanted) await openDetail(wanted, { fromRoute: true });
  },

  async unmount() {
    if (typeof this._cleanup === 'function') this._cleanup();
    this._cleanup = null;
  },
};
