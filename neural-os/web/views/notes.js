/**
 * views/notes.js -- die Notizen als Teil des Wissensnetzes.
 *
 * Was hier anders ist als bei einem Notizblock
 * --------------------------------------------
 * Eine Notiz steht nie allein. Was sie mit dem Rest verbindet, ist hier
 * sichtbar und antippbar -- ohne dass man in das Gehirn wechseln muss:
 *
 * - **[[Name]] verbindet.** Beim Schreiben oeffnet "[[" eine Liste passender
 *   Titel (Notizen, Projekte, Begriffe, Personen; web/lib/editor.js). Beim
 *   Lesen ist ein Link, dessen Ziel es nicht gibt, gestrichelt -- und ein
 *   Tipp darauf fragt "Notiz „Name“ anlegen?". Nach [Anlegen] existiert sie,
 *   und die Kante entsteht in derselben Anfrage (POST /api/notizen/anlegen
 *   mit `vonId`), also ohne Neuladen im Gehirn.
 * - **"Verknuepft mit"** unter jeder Notiz: eingehend und ausgehend, mit Art
 *   und Grund jeder Kante (GET /api/records/:id/verknuepft, Vertrag B).
 * - **Verbindungsvorschlaege** nach dem Speichern: der Server rechnet sie
 *   (suggestLinks) und schickt 'graph.vorschlaege'; die Karte "Ich habe N
 *   moegliche Verbindungen gefunden" bietet [Alle verbinden] [Bearbeiten]
 *   [Ablehnen]. Verbinden legt manuelle Kanten an (Vertrag C) und laesst sich
 *   rueckgaengig machen; Ablehnen merkt sich das Paar, damit der Vorschlag
 *   nicht wiederkommt.
 * - **Live** ueber den Bus: eine neue Kante ('graph.kante') erscheint in
 *   "Verknuepft mit" mit einer leichten Bewegung, eine neue Notiz auf der
 *   Wand, ohne Neuladen.
 *
 * Die Wand aus Post-its bleibt als Uebersicht (Angeheftetes oben, Neuestes
 * zuerst -- die Reihenfolge kommt vom Server, GET /api/notizen). Dazu kommt
 * ein Umschalter "Wand | Liste", ein Filter nach Schlagwort und eine schnelle
 * Suche ueber das Geladene. Oben rechts ein "+": Neue Notiz, Neue Aufgabe,
 * Link speichern, Text speichern -- alles in wenigen Sekunden.
 *
 * Reine Funktionen (tagsVon, sichtbareNotizen, zaehleTags, titelAusText,
 * artInfo, kantenText, vorschlagsSatz, zielFuer) sind ohne Browser pruefbar:
 * test/notizen-editor.test.js.
 */

import { renderMarkdown, extractPlain, extractLinks, setzeHaken } from '../lib/markdown.js';
import { createNoteEditor } from '../lib/editor.js';

const STYLE_ID = 'nos-notes-wall';
const MODUS_KEY = 'neural-os:notizen:modus';
const LADE_LIMIT = 600;
const MAX_TAG_CHIPS = 14;

const GLYPH = {
  pin: '<path d="M12.6 2.9 17.1 7.4l-2.3.8-3.1 3.1.2 3.4-1.6 1.6-3.1-3.1-3.9 3.9M7.2 9.9l3.1 3.1M10.1 7l-.4-3.3"/>',
  trash: '<path d="M4.6 5.8h10.8M8.2 5.8V4.2h3.6v1.6M6.2 5.8l.7 9.4a1.4 1.4 0 0 0 1.4 1.3h3.4a1.4 1.4 0 0 0 1.4-1.3l.7-9.4"/>',
  user: '<circle cx="10" cy="6.8" r="3"/><path d="M4.2 16.6a5.8 5.8 0 0 1 11.6 0"/>',
  grid: '<rect x="3.2" y="3.2" width="5.6" height="5.6" rx="1.4"/><rect x="11.2" y="3.2" width="5.6" height="5.6" rx="1.4"/><rect x="3.2" y="11.2" width="5.6" height="5.6" rx="1.4"/><rect x="11.2" y="11.2" width="5.6" height="5.6" rx="1.4"/>',
  rows: '<path d="M3.4 5.4h13.2M3.4 10h13.2M3.4 14.6h13.2"/>',
  tag: '<path d="M3.4 9.2V4.6a1.2 1.2 0 0 1 1.2-1.2h4.6l7.4 7.4-5.8 5.8z"/><circle cx="7" cy="7" r="1" fill="currentColor" stroke="none"/>',
  link: '<path d="M8.4 11.6a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-1 1M11.6 8.4a3 3 0 0 0-4.2 0l-2.3 2.3a3 3 0 0 0 4.2 4.2l1-1"/>',
  task: '<rect x="3.2" y="3.2" width="13.6" height="13.6" rx="3"/><path d="m6.6 10.2 2.4 2.4 4.6-5"/>',
  text: '<path d="M4 5h12M4 9h12M4 13h7"/>',
  out: '<path d="M4.5 10h10M10.5 6l4 4-4 4"/>',
  in: '<path d="M15.5 10h-10M9.5 6l-4 4 4 4"/>',
  project: '<path d="M2.6 6a1.8 1.8 0 0 1 1.8-1.8h3.1l1.8 2h6.3a1.8 1.8 0 0 1 1.8 1.8v6.6a1.8 1.8 0 0 1-1.8 1.8H4.4a1.8 1.8 0 0 1-1.8-1.8z"/>',
  term: '<circle cx="10" cy="10" r="3.2"/><path d="M10 2.6v2.4M10 15v2.4M2.6 10H5M15 10h2.4"/>',
  place: '<path d="M10 17.2s-5.2-4.9-5.2-9a5.2 5.2 0 0 1 10.4 0c0 4.1-5.2 9-5.2 9z"/><circle cx="10" cy="8.2" r="1.8"/>',
  org: '<path d="M4 16.5V5.2l6-2.4 6 2.4v11.3M4 16.5h12M7.5 8h1.2M11.3 8h1.2M7.5 11h1.2M11.3 11h1.2M8.8 16.5v-3h2.4v3"/>',
  topic: '<path d="M7 3.5 5.5 16.5M14.5 3.5 13 16.5M3.8 7.8h13M3.2 12.2h13"/>',
  event: '<rect x="3" y="4.2" width="14" height="12.4" rx="2"/><path d="M3 8.4h14M7 2.8v2.8M13 2.8v2.8"/>',
  file: '<path d="M5.4 2.7h5.9l3.9 3.9v9.1a1.6 1.6 0 0 1-1.6 1.6H5.4a1.6 1.6 0 0 1-1.6-1.6V4.3a1.6 1.6 0 0 1 1.6-1.6z"/><path d="M11.1 2.9v3.9h3.9"/>',
  undo: '<path d="M7.2 5.6 3.8 9l3.4 3.4M4.2 9h7.4a4 4 0 0 1 0 8H8"/>',
  sparkle: '<path d="M10 3.2v3.2M10 13.6v3.2M3.2 10h3.2M13.6 10h3.2M5.4 5.4l2 2M12.6 12.6l2 2M5.4 14.6l2-2M12.6 7.4l2-2"/>',
  globe: '<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c2.4 2.4 2.4 11.6 0 14M10 3c-2.4 2.4-2.4 11.6 0 14"/>',
};

const FILTERS = [
  ['alle', 'Alle'],
  ['auto', 'Automatisch'],
  ['angeheftet', 'Angeheftet'],
];
const MODI = [
  ['wand', 'Wand', 'grid'],
  ['liste', 'Liste', 'rows'],
];

/** Art eines Satzes -> Beschriftung und Symbol. Begriffe je nach `kind`. */
const ART = {
  note: ['Notiz', 'note'],
  project: ['Projekt', 'project'],
  task: ['Aufgabe', 'task'],
  event: ['Termin', 'event'],
  file: ['Datei', 'file'],
  chat: ['Chat', 'chat'],
  agent: ['Agent', 'agent'],
  entity: ['Begriff', 'term'],
};
const ENTITY_ART = {
  person: ['Person', 'user'],
  place: ['Ort', 'place'],
  org: ['Organisation', 'org'],
  topic: ['Thema', 'topic'],
  term: ['Begriff', 'term'],
};

/** Verknuepfungsart -> deutsches Wort (src/store/schema.js EDGE_KINDS). */
const KIND_LABEL = {
  'links-to': 'Link',
  mentions: 'Erwähnung',
  tagged: 'Schlagwort',
  'belongs-to': 'Gehört zu',
  'derived-from': 'Abgeleitet aus',
  produced: 'Erzeugt',
  uses: 'Benutzt',
  related: 'Verwandt',
};

const CSS = `
.nw { position: relative; min-height: 100%; container-type: inline-size; }
.nw__inner { max-width: 1240px; margin: 0 auto; padding: var(--sp-3) var(--sp-4) var(--sp-8); }
.nw__bar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px var(--sp-2); margin-bottom: 14px; }
.nw__lead { margin: 0 auto 0 0; font-size: var(--fs-sm); color: var(--fg-subtle); }
.nw__lead strong { font-weight: 500; color: var(--fg-muted); }
.nw__count { margin-left: 6px; color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.segmented__option.is-active .nw__count { color: var(--fg-muted); }
.nw__search { position: relative; display: flex; align-items: center; }
.nw__search svg { position: absolute; left: 10px; width: 15px; height: 15px; color: var(--fg-subtle); pointer-events: none; }
.nw__search .input { width: 220px; padding-left: 32px; }
.nw__modus .segmented__option svg { width: 15px; height: 15px; }
.nw__tags { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 0 0 var(--sp-3); }
.nw__tags-label { display: inline-flex; align-items: center; gap: 6px; margin-right: 4px; font-size: var(--fs-xs); color: var(--fg-subtle); }
.nw__tags-label svg { width: 14px; height: 14px; }
.nw__tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  font: inherit;
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-full);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
}
.nw__tag:hover { color: var(--fg); background: var(--surface-3); border-color: var(--border-strong); }
.nw__tag:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.nw__tag.is-active { color: var(--accent-text); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
.nw__tag-count { color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.nw__tag.is-active .nw__tag-count { color: inherit; opacity: 0.8; }
.nw__hint { margin: -8px 0 var(--sp-2); font-size: var(--fs-xs); color: var(--fg-subtle); }

/* ---- Wand ---- */
.nw__wall { display: grid; grid-template-columns: repeat(auto-fill, minmax(212px, 1fr)); gap: var(--sp-2); margin: 0; padding: 0; list-style: none; }
.nw__wall > li { display: flex; min-width: 0; }
.nw__note {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  min-width: 0;
  min-height: 200px;
  padding: 18px 18px 16px;
  overflow: hidden;
  font: inherit;
  text-align: left;
  color: var(--fg);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-3) var(--r-3) 6px var(--r-3);
  box-shadow: var(--shadow-1);
  cursor: pointer;
  transition: transform var(--dur-2) var(--ease), border-color var(--dur-2) var(--ease), background var(--dur-2) var(--ease);
}
.nw__note::after {
  content: '';
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 22px;
  height: 22px;
  background: linear-gradient(135deg, var(--surface-4) 0 50%, var(--surface) 50% 100%);
  border-top-left-radius: 5px;
  box-shadow: -1px -1px 2px rgba(0, 0, 0, 0.18);
}
.nw__note:hover { transform: translateY(-2px); background: var(--surface-3); border-color: var(--border-strong); }
.nw__note:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.nw__note.is-pinned { border-color: color-mix(in srgb, var(--accent) 38%, var(--border)); }
.nw__note.is-neu { animation: nw-neu var(--dur-3) var(--ease); }
@keyframes nw-neu { from { opacity: 0; transform: translateY(6px) scale(0.98); } to { opacity: 1; transform: none; } }
.nw__note-top { display: flex; align-items: center; gap: 8px; min-height: 16px; font-size: var(--fs-xs); color: var(--fg-subtle); }
.nw__note-top svg { width: 15px; height: 15px; }
.nw__pinmark { display: inline-flex; margin-left: auto; color: var(--accent-text); }
.nw__note-title {
  flex: none;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: var(--fs-md);
  font-weight: 500;
  line-height: var(--lh-tight);
  letter-spacing: -0.005em;
  overflow-wrap: anywhere;
}
.nw__note-body {
  flex: none;
  display: -webkit-box;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: var(--fs-sm);
  line-height: 1.55;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}
.nw__note-tags { display: flex; flex-wrap: wrap; gap: 4px 8px; font-size: var(--fs-xs); color: var(--accent-text); }
.nw__note-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-top: auto;
  padding-right: 18px;
  font-size: var(--fs-xs);
  color: var(--fg-subtle);
}
.nw__note-foot svg { flex: none; width: 14px; height: 14px; }
.nw__note-foot span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

/* ---- Liste ---- */
.nw__list { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--border); }
.nw__row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 52px;
  padding: 10px 6px;
  font: inherit;
  text-align: left;
  color: var(--fg);
  background: none;
  border: 0;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease);
}
.nw__row:hover { background: var(--surface-2); }
.nw__row:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent-ring); }
.nw__row-icon { display: inline-flex; color: var(--fg-subtle); }
.nw__row-icon svg { width: 16px; height: 16px; }
.nw__row.is-pinned .nw__row-icon { color: var(--accent-text); }
.nw__row-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.nw__row-title { font-size: var(--fs-md); font-weight: 500; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.nw__row-sub { display: flex; gap: 10px; min-width: 0; font-size: var(--fs-sm); color: var(--fg-muted); }
.nw__row-sub .nw__snippet { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.nw__row-sub .nw__row-tags { flex: none; color: var(--accent-text); }
.nw__row-side { font-size: var(--fs-xs); color: var(--fg-subtle); white-space: nowrap; text-align: right; }

.nw__empty { display: flex; flex-direction: column; align-items: center; gap: 10px; max-width: 460px; margin: var(--sp-8) auto; text-align: center; color: var(--fg-subtle); }
.nw__empty-icon { display: grid; place-items: center; width: 56px; height: 56px; color: var(--fg-muted); background: var(--surface-2); border: 1px solid var(--border); border-radius: 50%; }
.nw__empty-icon svg { width: 24px; height: 24px; }
.nw__empty h2 { margin: 6px 0 0; font-size: var(--fs-lg); font-weight: 500; color: var(--fg); }
.nw__empty p { margin: 0; line-height: var(--lh); }
.nw__empty-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 8px; }
.nw__notice { display: flex; align-items: center; gap: 12px; padding: 12px var(--sp-2); margin-bottom: var(--sp-2); color: var(--danger); background: var(--danger-soft); border-radius: var(--r-3); font-size: var(--fs-sm); }

/* ---- Das Plus oben rechts ---- */
.nw__plus { position: relative; display: inline-flex; }
.nw__menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 30;
  min-width: 220px;
  margin: 0;
  padding: 5px;
  list-style: none;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-2);
  box-shadow: var(--shadow-2);
  animation: nw-drop var(--dur-2) var(--ease);
}
@keyframes nw-drop { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.nw__menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 36px;
  padding: 6px 10px;
  font: inherit;
  font-size: var(--fs-sm);
  text-align: left;
  color: var(--fg);
  background: none;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
}
.nw__menu-item:hover, .nw__menu-item:focus-visible { outline: none; background: var(--surface-3); }
.nw__menu-item svg { width: 16px; height: 16px; color: var(--fg-subtle); }
.nw__menu-item kbd { margin-left: auto; font-family: inherit; font-size: var(--fs-xs); color: var(--fg-subtle); }

/* ---- Das geoeffnete Blatt ---- */
.nw__scrim {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: var(--sp-3);
  background: var(--overlay-bg);
  animation: nw-fade var(--dur-2) var(--ease);
}
@keyframes nw-fade { from { opacity: 0; } to { opacity: 1; } }
.nw__read {
  display: flex;
  flex-direction: column;
  width: min(760px, 100%);
  max-height: calc(100% - 2 * var(--sp-3));
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-4);
  box-shadow: var(--shadow-3);
  overflow: hidden;
  animation: nw-rise var(--dur-3) var(--ease);
}
.nw__read--klein { width: min(520px, 100%); }
@keyframes nw-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.nw__read-top { display: flex; align-items: center; gap: 8px; padding: 14px 14px 0 var(--sp-4); }
.nw__kicker { margin-right: auto; font-size: var(--fs-xs); font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-subtle); }
.nw__read-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px var(--sp-4) var(--sp-3); }
.nw__read-title { margin: 0 0 10px; font-size: var(--fs-2xl); font-weight: 500; line-height: var(--lh-tight); letter-spacing: -0.015em; overflow-wrap: anywhere; }
.nw__read-title:focus { outline: none; }
.nw__origin { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin: 0 0 12px; font-size: var(--fs-sm); color: var(--fg-subtle); }
.nw__origin svg { width: 15px; height: 15px; }
.nw__origin a { color: var(--accent-text); text-decoration: none; }
.nw__origin a:hover { text-decoration: underline; }
.nw__origin-part { display: inline-flex; align-items: center; gap: 6px; }
.nw__read-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 var(--sp-3); }
.nw__prose { color: var(--fg); font-size: var(--fs-md); line-height: 1.7; overflow-wrap: anywhere; }
.nw__prose > :first-child { margin-top: 0; }
.nw__prose .md-p { margin: 0 0 14px; }
.nw__blank { color: var(--fg-subtle); font-style: italic; }
.nw__read-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 14px var(--sp-4); border-top: 1px solid var(--border); }
.nw__read-foot .spacer { flex: 1 1 auto; }
.nw__danger { color: var(--danger); }

/* ---- Verknuepft mit ---- */
.nw__links { margin-top: var(--sp-4); padding-top: var(--sp-3); border-top: 1px solid var(--border); }
.nw__links-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.nw__links-head h3 { margin: 0; font-size: var(--fs-base); font-weight: 500; }
.nw__links-head .nw__count { margin-left: 0; }
.nw__links-head .btn { margin-left: auto; }
.nw__links-group { margin: 12px 0 0; }
.nw__links-group h4 { display: flex; align-items: center; gap: 6px; margin: 0 0 4px; font-size: var(--fs-xs); font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg-subtle); }
.nw__links-group h4 svg { width: 13px; height: 13px; }
.nw__links-list { margin: 0; padding: 0; list-style: none; }
.nw__link {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  width: calc(100% + 16px); /* die 8px Rand links und rechts, damit die Hover-Flaeche buendig ist */
  min-height: 40px;
  padding: 6px 8px;
  margin: 0 -8px;
  font: inherit;
  text-align: left;
  color: var(--fg);
  background: none;
  border: 0;
  border-radius: var(--r-2);
  cursor: pointer;
  transition: background var(--dur-1) var(--ease);
}
.nw__link:hover { background: var(--surface-3); }
.nw__link:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.nw__link.is-neu { animation: nw-link-neu 900ms var(--ease); }
@keyframes nw-link-neu { 0% { background: var(--accent-soft); transform: translateX(-4px); } 100% { background: transparent; transform: none; } }
.nw__link-icon { display: inline-flex; color: var(--fg-subtle); }
.nw__link-icon svg { width: 16px; height: 16px; }
.nw__link-main { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; min-width: 0; }
.nw__link-title { font-size: var(--fs-base); }
.nw__link-meta { font-size: var(--fs-xs); color: var(--fg-subtle); }
.nw__links-empty, .nw__links-wait { margin: 4px 0 0; font-size: var(--fs-sm); color: var(--fg-subtle); }
.nw__links-error { margin: 4px 0 0; font-size: var(--fs-sm); color: var(--danger); }

/* ---- Die Vorschlagskarte ---- */
.nw__card {
  margin: 0 0 var(--sp-2);
  padding: 14px 16px 12px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--r-3);
  animation: nw-rise var(--dur-3) var(--ease);
}
.nw__card-head { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: var(--fs-base); font-weight: 500; }
.nw__card-head svg { width: 16px; height: 16px; color: var(--accent-text); }
.nw__card-list { margin: 0 0 10px; padding: 0; list-style: none; }
.nw__card-item { display: flex; align-items: center; gap: 10px; min-height: 30px; padding: 2px 0; }
.nw__card-item input { margin: 0; accent-color: var(--accent); }
.nw__card-item svg { flex: none; width: 15px; height: 15px; color: var(--fg-subtle); }
.nw__card-item .nw__card-title { font-size: var(--fs-sm); }
.nw__card-item .nw__card-grund { font-size: var(--fs-xs); color: var(--fg-subtle); }
.nw__card-item.is-aus .nw__card-title { color: var(--fg-subtle); text-decoration: line-through; }
.nw__card-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.nw__card-actions .spacer { flex: 1 1 auto; }
.nw__card-status { display: flex; align-items: center; gap: 8px; font-size: var(--fs-sm); color: var(--fg-muted); }
.nw__card-status svg { width: 15px; height: 15px; color: var(--ok); }
.nw__card.is-fertig { animation: nw-fade var(--dur-2) var(--ease); }

/* ---- Bearbeiten und Formulare ---- */
.nw__edit { display: flex; flex-direction: column; gap: 10px; }
.nw__edit-title {
  width: 100%;
  margin: 0;
  padding: 4px 0;
  font: inherit;
  font-size: var(--fs-2xl);
  font-weight: 500;
  line-height: var(--lh-tight);
  letter-spacing: -0.015em;
  color: var(--fg);
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--border);
  outline: none;
}
.nw__edit-title::placeholder { color: var(--fg-subtle); }
.nw__edit-title:focus { border-bottom-color: var(--accent); }
.nw__edit-error { margin: 0; padding: 10px 12px; font-size: var(--fs-sm); color: var(--danger); background: var(--danger-soft); border-radius: var(--r-2); }
.nw__form { display: flex; flex-direction: column; gap: 12px; }
.nw__form .textarea { min-height: 160px; }
.nw__form-hint { margin: 0; font-size: var(--fs-sm); color: var(--fg-subtle); line-height: var(--lh); }
.nw__form-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.nw__form-actions .spacer { flex: 1 1 auto; }

@container (max-width: 600px) {
  .nw__inner { padding: var(--sp-2) var(--sp-2) var(--sp-6); }
  .nw__wall { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
  .nw__note { min-height: 160px; padding: 14px; }
  .nw__note-body { -webkit-line-clamp: 4; }
  .nw__search .input { width: 160px; }
  .nw__scrim { padding: 0; }
  .nw__read { top: 0; max-height: 100%; border-radius: 0; }
  .nw__read-body { padding: 4px var(--sp-2) var(--sp-2); }
  .nw__read-top { padding-left: var(--sp-2); }
  .nw__read-foot { padding: 12px var(--sp-2); }
  .nw__row-sub .nw__row-tags { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .nw__note, .nw__scrim, .nw__read, .nw__menu, .nw__card, .nw__link { animation: none; transition: none; }
}
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS;
  document.head.appendChild(node);
}

const pad = (n) => String(n).padStart(2, '0');

function dayOf(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "heute 10:24", "gestern 18:02", "12. Sept. 10:24", "3. Jan. 2025". */
export function stamp(iso, now = new Date()) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = dayOf(d);
  if (day === dayOf(now)) return `heute ${hm}`;
  const gestern = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (day === dayOf(gestern)) return `gestern ${hm}`;
  const opts = d.getFullYear() === now.getFullYear()
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' };
  try {
    const datum = new Intl.DateTimeFormat('de-DE', opts).format(d);
    return d.getFullYear() === now.getFullYear() ? `${datum} ${hm}` : datum;
  } catch {
    return day;
  }
}

/**
 * Die Herkunft in einem Satz, fuer Post-it und Blatt gleich.
 * @param {{art:string, chatTitel?:string|null, chatGeloescht?:boolean}} herkunft
 */
export function originLabel(herkunft) {
  const h = herkunft || {};
  switch (h.art) {
    case 'chat':
      return h.chatGeloescht ? `aus einem gelöschten Chat „${h.chatTitel}“` : `aus dem Chat „${h.chatTitel}“`;
    case 'automatisch':
      return 'automatisch erkannt';
    case 'agent':
      return 'von einem Agenten';
    case 'import':
      return 'importiert';
    default:
      return 'von dir';
  }
}

/* ------------------------------------------------------------------ */
/* Reine Funktionen                                                    */
/* ------------------------------------------------------------------ */

/** Umlaute und Gross/Klein spielen keine Rolle -- wie beim Suchen auf dem Server. */
function falten(s) {
  return String(s || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .trim();
}

/**
 * Alle Schlagworte einer Notiz: das Feld `tags` und die #worte im Text, ohne
 * Doppelte (Gross/Klein zaehlt nicht), in der Reihenfolge des Auftretens.
 * @returns {string[]} ohne fuehrendes #
 */
export function tagsVon(note) {
  const d = (note && note.data) || {};
  const out = [];
  const seen = new Set();
  const nimm = (raw) => {
    const t = String(raw || '').trim().replace(/^#/, '');
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  if (Array.isArray(d.tags)) d.tags.forEach(nimm);
  const body = typeof d.body === 'string' ? d.body : '';
  if (body.includes('#')) {
    try { extractLinks(body).tags.forEach(nimm); } catch { /* ein kaputter Text hat eben keine Schlagworte */ }
  }
  return out;
}

/**
 * Schlagworte ueber alle Notizen, haeufigste zuerst (dann alphabetisch).
 * @param {object[]} items
 * @param {(note:object)=>string[]} [tagsFn]
 * @returns {Array<{tag:string, anzahl:number}>}
 */
export function zaehleTags(items, tagsFn = tagsVon) {
  const map = new Map();
  for (const note of items || []) {
    for (const tag of tagsFn(note)) {
      const key = tag.toLowerCase();
      const e = map.get(key) || { tag, anzahl: 0 };
      e.anzahl += 1;
      map.set(key, e);
    }
  }
  return [...map.values()].sort((a, b) => (b.anzahl - a.anzahl) || a.tag.localeCompare(b.tag, 'de'));
}

/**
 * Welche Notizen die Wand zeigt: Quelle (alle/auto/angeheftet), ein
 * Schlagwort und eine Suche, deren Woerter alle in Titel oder Text stehen
 * muessen (Umlaute und Gross/Klein egal). Die Reihenfolge bleibt die des
 * Servers.
 */
export function sichtbareNotizen(items, { filter = 'alle', tag = null, q = '' } = {}, tagsFn = tagsVon) {
  let list = Array.isArray(items) ? items : [];
  if (filter === 'auto') list = list.filter((n) => n.data && n.data.source === 'auto');
  else if (filter === 'angeheftet') list = list.filter((n) => n.data && n.data.pinned);
  if (tag) {
    const key = String(tag).toLowerCase().replace(/^#/, '');
    list = list.filter((n) => tagsFn(n).some((t) => t.toLowerCase() === key));
  }
  const woerter = falten(q).split(/\s+/).filter(Boolean);
  if (woerter.length) {
    list = list.filter((n) => {
      const d = n.data || {};
      const heu = falten(`${d.title || ''}\n${d.body || ''}`);
      return woerter.every((w) => heu.includes(w));
    });
  }
  return list;
}

/**
 * "Text speichern": die erste nichtleere Zeile wird der Titel (ohne
 * Markdown-Zeichen, hoechstens 120 Zeichen), der Rest der Text. Ist der
 * Text nur eine Zeile, bleibt sie als Text erhalten, damit nichts verloren
 * geht, was laenger als ein Titel ist.
 * @returns {{title:string, body:string}|null} null bei leerer Eingabe
 */
export function titelAusText(raw) {
  const value = String(raw || '').replace(/\r\n?/g, '\n');
  if (!value.trim()) return null;
  const lines = value.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  const erste = lines[i].trim().replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '').replace(/[*_`~]+/g, '').trim();
  const rest = lines.slice(i + 1).join('\n').trim();
  if (erste.length <= 120) return { title: erste || 'Notiz', body: rest };
  // Ein langer erster Satz: der Anfang wird Titel, die ganze Zeile bleibt Text.
  const kurz = erste.slice(0, 117).replace(/\s+\S*$/, '');
  return { title: `${kurz}…`, body: value.trim() };
}

/** Art eines Satzes -> {label, glyph}: "Notiz", "Person", "Projekt" ... */
export function artInfo(type, kind) {
  if (type === 'entity') {
    const e = ENTITY_ART[kind] || ENTITY_ART.term;
    return { label: e[0], glyph: e[1] };
  }
  const a = ART[type] || [type ? String(type) : 'Eintrag', 'note'];
  return { label: a[0], glyph: a[1] };
}

/**
 * Eine Zeile aus "Verknuepft mit" in Worten: erst der Grund, den die Kante
 * traegt ("Schlagwort #biologie", "Im Gehirn verbunden"), sonst die Art.
 * Eine von Hand gezogene Kante sagt das dazu.
 */
export function kantenText(zeile) {
  const z = zeile || {};
  const grund = String(z.reason || '').trim();
  const art = KIND_LABEL[z.kind] || (z.kind ? String(z.kind) : 'Verknüpft');
  // "Wiki-Link [[X]] im Text" sagt schon, dass es ein Link ist: kein "Link · " davor.
  if (grund) return grund.toLowerCase().includes(art.toLowerCase()) ? grund : `${art} · ${grund}`;
  return z.source === 'manual' ? `${art} · von Hand` : art;
}

/** "Ich habe 4 mögliche Verbindungen gefunden". */
export function vorschlagsSatz(n) {
  const k = Number(n) || 0;
  if (k === 1) return 'Ich habe 1 mögliche Verbindung gefunden';
  return `Ich habe ${k} mögliche Verbindungen gefunden`;
}

/**
 * Wohin ein Tipp auf einen verknuepften Eintrag fuehrt. Notizen oeffnen sich
 * hier im Blatt (null: die Ansicht kuemmert sich selbst), alles andere hat
 * seinen Bereich -- und was keinen hat, zeigt das Gehirn mit Fokus.
 */
export function zielFuer(eintrag) {
  const e = eintrag || {};
  const id = encodeURIComponent(String(e.id || ''));
  switch (e.type) {
    case 'note': return null;
    case 'project': return `#/projects?id=${id}`;
    case 'chat': return `#/chat?id=${id}`;
    case 'event': return `#/kalender?id=${id}`;
    case 'task': return '#/projects';
    default: return `#/graph?focus=${id}`;
  }
}

function errorText(err) {
  return (err && err.message) || 'Unbekannter Fehler.';
}

/** Eine Datei als Base64 lesen (ohne "data:"-Vorspann). */
function dateiAlsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Die Datei ließ sich nicht lesen.'));
    reader.onload = () => {
      const s = String(reader.result || '');
      resolve(s.replace(/^data:[^,]*,/, ''));
    };
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------------ */
/* Die Ansicht                                                         */
/* ------------------------------------------------------------------ */

export default {
  id: 'notes',
  title: 'Notizen',

  async mount(container, ctx) {
    ensureStyle();
    const { h, text, clear, icon, api, icons, bus, toast, confirm, navigate } = ctx;
    const I = { ...GLYPH, note: icons.notes, chat: icons.chat, agent: icons.agents, plus: icons.plus, search: icons.search, check: icons.check, pen: icons.pen, close: icons.close, graph: icons.graph, info: icons.info };

    let modus = 'wand';
    try { modus = localStorage.getItem(MODUS_KEY) === 'liste' ? 'liste' : 'wand'; } catch { /* privat: dann die Wand */ }
    const params = (ctx.route && ctx.route.params) || {};
    if (params.modus === 'liste' || params.modus === 'wand') modus = params.modus;

    const st = {
      items: [],
      total: 0,
      zaehler: { alle: 0, automatisch: 0, angeheftet: 0 },
      filter: 'alle',
      tag: typeof params.tag === 'string' && params.tag ? params.tag.replace(/^#/, '') : null,
      q: typeof params.q === 'string' ? params.q : '',
      modus,
      loaded: false,
      error: null,
      token: 0,
      /** { id, mode: 'read'|'edit'|'neu'|'form', note, ... } */
      open: null,
      alive: true,
      /** [[Name]] -> {id,type,title} | null, vom Server (POST /notizen/aufloesen). */
      aufgeloest: new Map(),
      /** Schlagworte je Notiz, damit die Wand sie nicht bei jedem Rendern neu liest. */
      tagCache: new Map(),
      /** Ids, die wir gerade selbst geschrieben haben: ihr record.updated baut das Blatt nicht um. */
      eigene: new Map(),
      neuAufWand: new Set(),
    };
    const cleanups = [];

    const root = h('div.nw');
    const inner = h('div.nw__inner');
    const bar = h('div.nw__bar');
    const lead = h('p.nw__lead');
    const segmented = h('div.segmented', { role: 'group', 'aria-label': 'Welche Notizen' });
    const searchInput = h('input.input', {
      type: 'search',
      value: st.q,
      placeholder: 'Notizen durchsuchen',
      'aria-label': 'Notizen durchsuchen',
      autocomplete: 'off',
      onInput: () => {
        st.q = searchInput.value;
        render();
        syncRoute();
      },
      onKeydown: (event) => {
        if (event.key === 'Escape' && searchInput.value) {
          event.stopPropagation();
          searchInput.value = '';
          st.q = '';
          render();
          syncRoute();
        }
      },
    });
    const search = h('div.nw__search', null, icon(I.search), searchInput);
    const modusSwitch = h('div.segmented.nw__modus', { role: 'group', 'aria-label': 'Darstellung' });
    const tagsRow = h('div.nw__tags');
    const wallHost = h('div');
    bar.append(lead, segmented, search, modusSwitch);
    inner.append(bar, tagsRow, wallHost);
    root.appendChild(inner);
    container.appendChild(root);
    let sheet = null;
    let sheetCleanups = [];
    let menu = null;

    /* ---------------- Daten ---------------- */

    async function load() {
      const token = ++st.token;
      try {
        const res = await api.get('/notizen', { query: { limit: LADE_LIMIT } });
        if (!st.alive || token !== st.token) return;
        st.items = Array.isArray(res && res.items) ? res.items : [];
        st.total = Number.isFinite(res && res.total) ? res.total : st.items.length;
        st.zaehler = (res && res.zaehler) || st.zaehler;
        st.error = null;
        // Vergessen, was es nicht mehr gibt.
        const ids = new Set(st.items.map((n) => n.id));
        for (const key of st.tagCache.keys()) if (!ids.has(key.split('\u0000')[0])) st.tagCache.delete(key);
      } catch (err) {
        if (!st.alive || token !== st.token) return;
        st.error = errorText(err);
      }
      st.loaded = true;
      render();
    }

    let reloadTimer = null;
    const reloadSoon = () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => load(), 250);
    };

    /** Die Adresse der Wand mit Filter (#/notes?tag=…&q=…), damit Neuladen und Links sie behalten. */
    function wandRoute() {
      const q = new URLSearchParams();
      if (st.tag) q.set('tag', st.tag);
      if (st.q.trim()) q.set('q', st.q.trim());
      const s = q.toString();
      return s ? `#/notes?${s}` : '#/notes';
    }

    function syncRoute() {
      if (typeof ctx.replaceRoute === 'function' && !st.open) ctx.replaceRoute(wandRoute());
    }

    function tagsOf(note) {
      const key = `${note.id}\u0000${note.updatedAt}`;
      let tags = st.tagCache.get(key);
      if (!tags) {
        tags = tagsVon(note);
        st.tagCache.set(key, tags);
      }
      return tags;
    }

    function findNote(id) {
      return st.items.find((n) => n.id === id) || null;
    }

    /* ---------------- Wand und Liste ---------------- */

    function render() {
      if (!st.alive) return;
      clear(lead);
      if (st.loaded && !st.error) {
        const { alle, automatisch } = st.zaehler;
        lead.append(
          h('strong', null, text(alle === 1 ? '1 Notiz' : `${alle} Notizen`)),
          text(automatisch ? ` · ${automatisch} davon hat die KI aus deinen Chats gemacht` : ''));
      }
      clear(segmented);
      const counts = { alle: st.zaehler.alle, auto: st.zaehler.automatisch, angeheftet: st.zaehler.angeheftet };
      for (const [key, label] of FILTERS) {
        segmented.appendChild(h('button.segmented__option', {
          type: 'button',
          class: st.filter === key ? 'is-active' : '',
          'aria-pressed': st.filter === key ? 'true' : 'false',
          onClick: () => {
            st.filter = key;
            render();
          },
        }, text(label), st.loaded ? h('span.nw__count', null, text(String(counts[key] || 0))) : null));
      }
      clear(modusSwitch);
      for (const [key, label, glyph] of MODI) {
        modusSwitch.appendChild(h('button.segmented__option', {
          type: 'button',
          class: st.modus === key ? 'is-active' : '',
          'aria-pressed': st.modus === key ? 'true' : 'false',
          title: label,
          onClick: () => {
            st.modus = key;
            try { localStorage.setItem(MODUS_KEY, key); } catch { /* dann eben nur fuer jetzt */ }
            render();
          },
        }, icon(I[glyph]), text(label)));
      }

      renderTags();

      clear(wallHost);
      if (st.error) {
        wallHost.appendChild(h('div.nw__notice', { role: 'alert' },
          text(`Die Notizen konnten nicht geladen werden: ${st.error}`),
          h('button.btn.btn--small', { type: 'button', onClick: () => load() }, text('Erneut versuchen'))));
        return;
      }
      if (!st.loaded) return;
      const list = sichtbareNotizen(st.items, { filter: st.filter, tag: st.tag, q: st.q }, tagsOf);
      if (st.q.trim() && st.total > st.items.length) {
        wallHost.appendChild(h('p.nw__hint', null,
          text(`Durchsucht sind die ${st.items.length} neuesten Notizen. Alle ${st.total} findet Strg+K.`)));
      }
      if (!list.length) {
        wallHost.appendChild(renderEmpty());
        return;
      }
      if (st.modus === 'liste') {
        const ul = h('ul.nw__list', { 'aria-label': 'Notizen' });
        for (const note of list) ul.appendChild(h('li', null, renderRow(note)));
        wallHost.appendChild(ul);
      } else {
        const wall = h('ul.nw__wall', { 'aria-label': 'Notizen' });
        for (const note of list) wall.appendChild(h('li', null, renderNote(note)));
        wallHost.appendChild(wall);
      }
      st.neuAufWand.clear();
    }

    function renderTags() {
      clear(tagsRow);
      if (!st.loaded || st.error) return;
      const alle = zaehleTags(st.items, tagsOf);
      if (!alle.length && !st.tag) return;
      let chips = alle.slice(0, MAX_TAG_CHIPS);
      if (st.tag && !chips.some((c) => c.tag.toLowerCase() === st.tag.toLowerCase())) {
        const rest = alle.find((c) => c.tag.toLowerCase() === st.tag.toLowerCase());
        chips = [...chips, rest || { tag: st.tag, anzahl: 0 }];
      }
      tagsRow.appendChild(h('span.nw__tags-label', null, icon(I.tag), text('Schlagwort')));
      tagsRow.appendChild(h('button.nw__tag', {
        type: 'button',
        class: st.tag ? '' : 'is-active',
        'aria-pressed': st.tag ? 'false' : 'true',
        onClick: () => { st.tag = null; render(); syncRoute(); },
      }, text('Alle')));
      for (const { tag, anzahl } of chips) {
        const active = !!st.tag && st.tag.toLowerCase() === tag.toLowerCase();
        tagsRow.appendChild(h('button.nw__tag', {
          type: 'button',
          class: active ? 'is-active' : '',
          'aria-pressed': active ? 'true' : 'false',
          dataset: { tag },
          onClick: () => { st.tag = active ? null : tag; render(); syncRoute(); },
        }, text(`#${tag}`), h('span.nw__tag-count', null, text(String(anzahl)))));
      }
      if (alle.length > MAX_TAG_CHIPS) {
        tagsRow.appendChild(h('span.nw__tags-label', null, text(`+${alle.length - MAX_TAG_CHIPS} weitere in den Notizen`)));
      }
    }

    function renderEmpty() {
      const gefiltert = st.q.trim() || st.tag || st.filter !== 'alle';
      let title;
      let line;
      if (st.q.trim()) {
        title = 'Nichts gefunden';
        line = `Keine der geladenen Notizen enthält „${st.q.trim()}“.`;
      } else if (st.tag) {
        title = `Keine Notiz mit #${st.tag}`;
        line = 'Schreib #schlagwort in eine Notiz – dann steht sie hier.';
      } else if (st.filter === 'auto') {
        title = 'Noch keine automatische Notiz';
        line = 'Sag im Chat „das ist eine Notiz“ – die KI legt sie hier ab und schreibt dazu, aus welchem Gespräch sie stammt.';
      } else if (st.filter === 'angeheftet') {
        title = 'Nichts angeheftet';
        line = 'Öffne eine Notiz und tippe auf „Anheften“ – dann steht sie hier ganz oben.';
      } else {
        title = 'Dein Wissensuniversum wartet.';
        line = 'Erstelle deine erste Notiz oder halte einen Link fest. Was du schreibst, verbindet sich über [[Links]] und #Schlagworte von selbst.';
      }
      return h('div.nw__empty', null,
        h('span.nw__empty-icon', { 'aria-hidden': 'true' }, icon(I.note)),
        h('h2', null, text(title)),
        h('p', null, text(line)),
        gefiltert
          ? h('div.nw__empty-actions', null,
            h('button.btn.btn--small', { type: 'button', onClick: () => { st.q = ''; searchInput.value = ''; st.tag = null; st.filter = 'alle'; render(); syncRoute(); } }, text('Filter zurücksetzen')))
          : h('div.nw__empty-actions', null,
            h('button.btn.btn--primary', { type: 'button', onClick: () => openNew() }, text('Erste Notiz')),
            // Vorhandenes Wissen kommt als Sicherung zurueck: der Bereich Stick spielt sie ein.
            h('button.btn', { type: 'button', title: 'Eine Sicherung wiederherstellen (Bereich Stick)', onClick: () => navigate('#/stick') }, text('Importieren')),
            h('button.btn.btn--ghost', { type: 'button', onClick: () => navigate('#/chat') }, text('KI kennenlernen'))));
    }

    function originIcon(herkunft) {
      return herkunft.art === 'chat' ? I.chat : herkunft.art === 'hand' ? I.user : I.info;
    }

    function renderNote(note) {
      const data = note.data || {};
      const plain = extractPlain(String(data.body || ''), { maxLength: 420 });
      const herkunft = note.herkunft || { art: 'hand' };
      const auto = herkunft.art === 'chat' || herkunft.art === 'automatisch';
      const tags = tagsOf(note).slice(0, 3);
      return h('button.nw__note', {
        type: 'button',
        'data-id': note.id,
        class: `${data.pinned ? 'is-pinned' : ''} ${st.neuAufWand.has(note.id) ? 'is-neu' : ''}`,
        'aria-label': `${data.title || 'Notiz'}, ${originLabel(herkunft)}, ${stamp(note.updatedAt)}${data.pinned ? ', angeheftet' : ''}`,
        onClick: () => openNote(note.id),
      },
      h('span.nw__note-top', null,
        auto ? h('span.dot.dot--accent', { style: { width: '6px', height: '6px' } }) : null,
        auto ? text('Automatisch') : null,
        data.pinned ? h('span.nw__pinmark', { title: 'Angeheftet' }, icon(I.pin)) : null),
      h('span.nw__note-title', null, text(data.title || 'Ohne Titel')),
      plain ? h('span.nw__note-body', null, text(plain)) : null,
      tags.length ? h('span.nw__note-tags', null, tags.map((t) => h('span', null, text(`#${t}`)))) : null,
      h('span.nw__note-foot', null,
        icon(originIcon(herkunft)),
        h('span', null, text(`${originLabel(herkunft)} · ${stamp(note.updatedAt)}`))));
    }

    function renderRow(note) {
      const data = note.data || {};
      const plain = extractPlain(String(data.body || ''), { maxLength: 160 });
      const herkunft = note.herkunft || { art: 'hand' };
      const tags = tagsOf(note).slice(0, 3);
      return h('button.nw__row', {
        type: 'button',
        'data-id': note.id,
        class: data.pinned ? 'is-pinned' : '',
        onClick: () => openNote(note.id),
      },
      h('span.nw__row-icon', null, icon(data.pinned ? I.pin : originIcon(herkunft))),
      h('span.nw__row-main', null,
        h('span.nw__row-title', null, text(data.title || 'Ohne Titel')),
        (plain || tags.length) ? h('span.nw__row-sub', null,
          plain ? h('span.nw__snippet', null, text(plain)) : null,
          tags.length ? h('span.nw__row-tags', null, text(tags.map((t) => `#${t}`).join(' '))) : null) : null),
      h('span.nw__row-side', null, text(stamp(note.updatedAt)), h('br'), text(originLabel(herkunft))));
    }

    /* ---------------- Das Plus oben rechts ---------------- */

    function closeMenu() {
      if (!menu) return;
      menu.remove();
      menu = null;
      plusButton.setAttribute('aria-expanded', 'false');
    }

    const MENU = [
      ['notiz', 'Neue Notiz', 'note', () => openNew()],
      ['aufgabe', 'Neue Aufgabe', 'task', () => openForm('aufgabe')],
      ['link', 'Link speichern', 'globe', () => openForm('link')],
      ['text', 'Text speichern', 'text', () => openForm('text')],
    ];

    function openMenu() {
      if (menu) { closeMenu(); return; }
      menu = h('ul.nw__menu', { role: 'menu', 'aria-label': 'Neu' });
      for (const [key, label, glyph, run] of MENU) {
        menu.appendChild(h('li', { role: 'none' }, h('button.nw__menu-item', {
          type: 'button',
          role: 'menuitem',
          dataset: { neu: key },
          onClick: () => { closeMenu(); run(); },
        }, icon(I[glyph]), text(label))));
      }
      plusWrap.appendChild(menu);
      plusButton.setAttribute('aria-expanded', 'true');
      const first = menu.querySelector('button');
      if (first) first.focus();
    }

    const plusButton = h('button.btn.btn--primary.btn--small', {
      type: 'button',
      'aria-label': 'Neu: Notiz, Aufgabe, Link oder Text',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      title: 'Neu',
      dataset: { nwPlus: '1' },
      onClick: () => openMenu(),
    }, icon(I.plus), text('Neu'));
    const plusWrap = h('span.nw__plus', {
      onKeydown: (event) => {
        if (!menu) return;
        const items = [...menu.querySelectorAll('button')];
        const idx = items.indexOf(document.activeElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const next = items[(idx + (event.key === 'ArrowDown' ? 1 : items.length - 1) + items.length) % items.length];
          if (next) next.focus();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closeMenu();
          plusButton.focus();
        }
      },
    }, plusButton);
    if (typeof ctx.setHeadActions === 'function') ctx.setHeadActions(plusWrap);

    const onDocClick = (event) => {
      if (menu && !plusWrap.contains(event.target)) closeMenu();
    };
    document.addEventListener('mousedown', onDocClick);
    cleanups.push(() => document.removeEventListener('mousedown', onDocClick));

    /* ---------------- Blatt: oeffnen, schliessen ---------------- */

    function closeSheet({ keepRoute = false, force = false } = {}) {
      if (!sheet) return true;
      if (!force && st.open && st.open.dirty) {
        // Ein Text, den man gerade tippt, verschwindet nicht durch einen Klick
        // daneben: erst die Rueckfrage, dann (und nur dann) das Schliessen.
        const offen = st.open;
        confirm({
          title: 'Änderungen verwerfen?',
          message: 'Was du hier geschrieben hast, ist noch nicht gespeichert.',
          confirmLabel: 'Verwerfen',
          cancelLabel: 'Weiterschreiben',
          danger: true,
        }).then((ok) => {
          if (ok && st.alive && st.open === offen) closeSheet({ keepRoute, force: true });
        });
        return false;
      }
      teardownSheet();
      container.style.overflowY = '';
      const was = st.open;
      st.open = null;
      if (!keepRoute && typeof ctx.replaceRoute === 'function') ctx.replaceRoute(wandRoute());
      if (was && was.id) {
        const tile = root.querySelector(`.nw__note[data-id="${was.id}"], .nw__row[data-id="${was.id}"]`);
        if (tile) tile.focus({ preventScroll: true });
      }
      return true;
    }

    async function fetchNote(id) {
      const res = await api.get(`/records/${encodeURIComponent(id)}`);
      if (!res || !res.record || res.record.type !== 'note') throw Object.assign(new Error('Das ist keine Notiz.'), { status: 404 });
      const note = { ...res.record, herkunft: { art: res.record.data.source === 'auto' ? 'automatisch' : 'hand' } };
      if (res.record.data.chatId) {
        try {
          const chat = await api.get(`/chats/${encodeURIComponent(res.record.data.chatId)}`);
          if (chat && chat.record) note.herkunft = { art: 'chat', chatId: chat.record.id, chatTitel: chat.record.data.title, chatGeloescht: false };
        } catch { /* Chat weg: dann bleibt "automatisch erkannt" */ }
      }
      return note;
    }

    /**
     * Welche [[Namen]] im Text es wirklich gibt -- vom Server, mit derselben
     * Faltung wie die Ableitung. Was schon bekannt ist, wird nicht noch
     * einmal gefragt.
     */
    async function resolveWiki(body) {
      let namen = [];
      try { namen = extractLinks(String(body || '')).wikiLinks; } catch { namen = []; }
      const offen = namen.filter((n) => !st.aufgeloest.has(n)).slice(0, 200);
      if (!offen.length) return;
      try {
        const res = await api.post('/notizen/aufloesen', { namen: offen }, { timeoutMs: 8000 });
        const map = (res && res.aufgeloest) || {};
        for (const name of offen) st.aufgeloest.set(name, map[name] || null);
      } catch {
        /* dann entscheidet die Wand (Titel der geladenen Notizen) */
      }
    }

    function wikiTarget(name) {
      if (st.aufgeloest.has(name)) return st.aufgeloest.get(name);
      const wanted = falten(name);
      const hit = st.items.find((n) => falten(n.data.title) === wanted);
      return hit ? { id: hit.id, type: 'note', title: hit.data.title } : null;
    }

    function wikiHref(name) {
      const ziel = wikiTarget(name);
      if (!ziel) return null;
      return ziel.type === 'note' ? `#/notes?id=${ziel.id}` : (zielFuer(ziel) || `#/graph?focus=${encodeURIComponent(ziel.id)}`);
    }

    async function openNote(id, { fromRoute = false, mode = 'read' } = {}) {
      if (st.open && st.open.dirty && st.open.id !== id) {
        if (!closeSheet({ keepRoute: true })) return;
      }
      let note = findNote(id);
      if (!note) {
        try {
          note = await fetchNote(id);
        } catch (err) {
          if (!st.alive) return;
          toast(err && err.status === 404 ? 'Diese Notiz gibt es nicht mehr.' : `Die Notiz konnte nicht geöffnet werden: ${errorText(err)}`, 'error');
          if (fromRoute && typeof ctx.replaceRoute === 'function') ctx.replaceRoute('#/notes');
          return;
        }
      }
      if (mode === 'read') await resolveWiki(note.data && note.data.body);
      if (!st.alive) return;
      st.open = { id: note.id, mode, note, dirty: false, verknuepft: null, karte: null };
      renderSheet();
      if (!fromRoute && typeof ctx.replaceRoute === 'function') ctx.replaceRoute(`#/notes?id=${note.id}`);
      if (mode === 'read') loadVerknuepft(note.id);
    }

    function openNew({ title = '', body = '' } = {}) {
      if (st.open && st.open.dirty && !closeSheet({ keepRoute: true })) return;
      st.open = { id: null, mode: 'neu', note: { id: null, data: { title, body, tags: [] }, herkunft: { art: 'hand' } }, dirty: false };
      renderSheet();
      if (typeof ctx.replaceRoute === 'function') ctx.replaceRoute('#/notes?neu=notiz');
    }

    function openForm(art) {
      if (st.open && st.open.dirty && !closeSheet({ keepRoute: true })) return;
      st.open = { id: null, mode: 'form', art, dirty: false };
      renderSheet();
      if (typeof ctx.replaceRoute === 'function') ctx.replaceRoute(`#/notes?neu=${art}`);
    }

    /** Das alte Blatt abbauen -- VOR dem Bau des neuen, damit dessen Editor nicht mit abgeraeumt wird. */
    function teardownSheet() {
      for (const fn of sheetCleanups.splice(0)) { try { fn(); } catch { /* weiter */ } }
      if (sheet) sheet.remove();
      sheet = null;
    }

    function mountSheet(card, { focus } = {}) {
      sheet = h('div.nw__scrim', {
        onMousedown: (event) => {
          if (event.target === sheet) {
            event.preventDefault();
            closeSheet();
          }
        },
      }, card);
      root.appendChild(sheet);
      // Das Blatt steht dort, wo man gerade hinsieht, nicht oben auf der Wand,
      // und die Wand darunter rollt nicht mit, solange es offen ist.
      sheet.style.top = `${container.scrollTop || 0}px`;
      sheet.style.bottom = `${-(container.scrollTop || 0)}px`;
      container.style.overflowY = 'hidden';
      if (focus) {
        const target = typeof focus === 'string' ? card.querySelector(focus) : focus;
        if (target) setTimeout(() => target.focus({ preventScroll: true }), 0);
      }
    }

    function renderSheet() {
      if (!st.open) return;
      teardownSheet();
      if (st.open.mode === 'form') { renderForm(); return; }
      if (st.open.mode === 'edit' || st.open.mode === 'neu') { renderEditor(); return; }
      renderReader();
    }

    /* ---------------- Blatt: lesen ---------------- */

    function renderReader() {
      const o = st.open;
      const note = o.note;
      const data = note.data || {};
      const herkunft = note.herkunft || { art: 'hand' };
      const titleId = `nw-title-${note.id}`;
      const close = h('button.icon-button', { type: 'button', 'aria-label': 'Schließen', title: 'Schließen (Esc)', onClick: () => closeSheet() }, icon(I.close));

      const origin = h('p.nw__origin', null,
        h('span.nw__origin-part', null,
          icon(originIcon(herkunft)),
          herkunft.art === 'chat' && !herkunft.chatGeloescht
            ? [text('aus dem Chat '), h('a', { href: `#/chat?id=${encodeURIComponent(herkunft.chatId)}` }, text(`„${herkunft.chatTitel}“`))]
            : text(originLabel(herkunft).replace(/^./, (c) => c.toUpperCase()))),
        h('span', null, text(`· ${stamp(note.createdAt)}`)),
        note.updatedAt !== note.createdAt ? h('span', null, text(`· geändert ${stamp(note.updatedAt)}`)) : null,
        note.projekt ? h('span.nw__origin-part', null, text('· Projekt '),
          h('a', { href: `#/projects?id=${encodeURIComponent(note.projekt.id)}` }, text(note.projekt.name))) : null);

      const tags = tagsOf(note);
      const tagRow = tags.length ? h('div.nw__read-tags', null, tags.map((t) => h('button.nw__tag', {
        type: 'button',
        title: `Alle Notizen mit #${t}`,
        onClick: () => { st.tag = t; closeSheet(); render(); syncRoute(); },
      }, text(`#${t}`)))) : null;

      const prose = h('div.nw__prose');
      renderProse(prose, note);
      o.dom = { prose };

      const links = h('section.nw__links', { 'aria-label': 'Verknüpft mit' });
      o.dom.links = links;
      renderLinks();

      const foot = h('footer.nw__read-foot', null,
        h('button.btn', { type: 'button', onClick: () => togglePin(note) },
          icon(I.pin), text(data.pinned ? 'Lösen' : 'Anheften')),
        h('button.btn.btn--ghost', { type: 'button', onClick: () => openNote(note.id, { fromRoute: true, mode: 'edit' }) },
          icon(I.pen), text('Bearbeiten')),
        h('span.spacer'),
        h('button.btn.btn--ghost.nw__danger', { type: 'button', onClick: () => removeNote(note) }, icon(I.trash), text('Löschen')));

      const card = h('article.nw__read', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
        h('div.nw__read-top', null, h('span.nw__kicker', null, text('Notiz')), close),
        h('div.nw__read-body', null,
          h('h2.nw__read-title', { id: titleId, tabindex: '-1' }, text(data.title || 'Ohne Titel')),
          origin,
          tagRow,
          prose,
          links),
        foot);
      mountSheet(card, { focus: '.nw__read-title' });
    }

    function renderProse(prose, note) {
      clear(prose);
      const body = String((note.data && note.data.body) || '');
      if (!body.trim()) {
        prose.appendChild(h('p.nw__blank', null, text('Diese Notiz hat nur einen Titel.')));
        return;
      }
      prose.appendChild(renderMarkdown(body, {
        wikiHref,
        onWikiLink: (name, info) => {
          if (info.resolved) {
            const ziel = wikiTarget(name);
            if (ziel && ziel.type === 'note') openNote(ziel.id);
            else navigate(info.href);
            return true;
          }
          offerCreate(name, note);
          return true;
        },
        onTask: (index, checked) => toggleTask(note, index, checked),
      }));
    }

    /** "Notiz „Name“ anlegen?" -- danach existiert sie, und die Kante steht. */
    async function offerCreate(name, note) {
      const ok = await confirm({
        title: `Notiz „${name}“ anlegen?`,
        message: 'Es gibt noch keinen Eintrag mit diesem Titel. Die neue Notiz wird sofort mit dieser hier verknüpft und erscheint im Gehirn.',
        confirmLabel: 'Anlegen',
        cancelLabel: 'Nicht jetzt',
      });
      if (!ok || !st.alive) return;
      let res;
      try {
        res = await api.post('/notizen/anlegen', { title: name, vonId: note.id });
      } catch (err) {
        toast(`Anlegen hat nicht geklappt: ${errorText(err)}`, 'error');
        return;
      }
      if (!st.alive) return;
      const rec = res && res.record;
      if (rec) st.aufgeloest.set(name, { id: rec.id, type: rec.type, title: (rec.data && rec.data.title) || name });
      const kanten = (res && res.kanten) || null;
      const neu = kanten && Array.isArray(kanten.neu) ? kanten.neu.length : 0;
      toast(res && res.bereits
        ? `„${name}“ gab es schon – jetzt ist die Notiz damit verknüpft.`
        : `„${name}“ angelegt${neu ? ' und verknüpft' : ''}.`, 'success', {
        action: rec ? { label: 'Öffnen', run: () => openNote(rec.id) } : undefined,
        timeout: 7000,
      });
      if (st.open && st.open.mode === 'read' && st.open.id === note.id && st.open.dom) {
        renderProse(st.open.dom.prose, st.open.note);
        loadVerknuepft(note.id);
      }
    }

    /** Ein Haken im Anzeigen-Modus schreibt die Zeile im Quelltext um. */
    function toggleTask(note, index, checked) {
      const body = String((note.data && note.data.body) || '');
      const neu = setzeHaken(body, index, checked);
      if (neu === body) return false;
      st.eigene.set(note.id, Date.now() + 2000);
      api.patch(`/records/${encodeURIComponent(note.id)}`, { data: { body: neu } }).then((res) => {
        if (!st.alive) return;
        const rec = res && res.record ? res.record : null;
        note.data.body = neu;
        if (rec) { note.updatedAt = rec.updatedAt; note.rev = rec.rev; }
        const auf = findNote(note.id);
        if (auf && auf !== note) { auf.data.body = neu; if (rec) auf.updatedAt = rec.updatedAt; }
      }).catch((err) => {
        if (!st.alive) return;
        toast(`Der Haken ließ sich nicht speichern: ${errorText(err)}`, 'error');
        if (st.open && st.open.mode === 'read' && st.open.id === note.id && st.open.dom) renderProse(st.open.dom.prose, note);
      });
      return true;
    }

    /* ---------------- Verknuepft mit ---------------- */

    let verknuepftTimer = null;
    async function loadVerknuepft(id, { markiere = null } = {}) {
      const o = st.open;
      if (!o || o.id !== id || o.mode !== 'read') return;
      const token = (o.linkToken = (o.linkToken || 0) + 1);
      try {
        const res = await api.get(`/records/${encodeURIComponent(id)}/verknuepft`, { timeoutMs: 12000 });
        if (!st.alive || st.open !== o || token !== o.linkToken) return;
        const vorher = o.verknuepft;
        o.verknuepft = { eingehend: res.eingehend || [], ausgehend: res.ausgehend || [], fehler: null };
        // Welche Zeilen neu sind: die bekommen die leichte Bewegung.
        const alt = new Set();
        if (vorher) for (const z of [...vorher.eingehend, ...vorher.ausgehend]) alt.add(z.edgeId || `${z.id}:${z.kind}`);
        o.neuKanten = vorher ? new Set([...o.verknuepft.eingehend, ...o.verknuepft.ausgehend].map((z) => z.edgeId || `${z.id}:${z.kind}`).filter((k) => !alt.has(k))) : new Set();
        if (markiere) for (const k of markiere) o.neuKanten.add(k);
        const vorschlaege = Array.isArray(res.vorschlaege) ? res.vorschlaege : [];
        // Eine Karte, die gerade bearbeitet oder eben verbunden wurde, bleibt.
        if (!o.karte || (o.karte.status === 'offen' && !o.karte.bearbeiten && !o.karte.busy)) {
          o.karte = vorschlaege.length ? { vorschlaege, status: 'offen', bearbeiten: false, gewaehlt: new Set(vorschlaege.map((v) => v.id)), busy: false, edges: [] } : null;
        }
      } catch (err) {
        if (!st.alive || st.open !== o || token !== o.linkToken) return;
        o.verknuepft = { eingehend: [], ausgehend: [], fehler: errorText(err) };
      }
      renderLinks();
    }

    function renderLinks() {
      const o = st.open;
      if (!o || o.mode !== 'read' || !o.dom || !o.dom.links) return;
      const box = o.dom.links;
      clear(box);
      const v = o.verknuepft;
      const anzahl = v ? v.eingehend.length + v.ausgehend.length : 0;
      box.appendChild(h('div.nw__links-head', null,
        h('h3', null, text('Verknüpft mit')),
        v ? h('span.nw__count', null, text(String(anzahl))) : null,
        h('button.btn.btn--ghost.btn--small', { type: 'button', onClick: () => navigate(`#/graph?focus=${encodeURIComponent(o.id)}`) },
          icon(I.graph), text('Im Gehirn zeigen'))));
      if (o.karte) box.appendChild(renderCard());
      if (!v) {
        box.appendChild(h('p.nw__links-wait', null, text('Verknüpfungen werden gelesen …')));
        return;
      }
      if (v.fehler) {
        box.appendChild(h('p.nw__links-error', null, text(`Verknüpfungen nicht lesbar: ${v.fehler}`)));
        return;
      }
      if (!anzahl) {
        box.appendChild(h('p.nw__links-empty', null, text('Noch keine Verknüpfungen. Schreib [[Name]] in den Text, setz ein #Schlagwort oder nimm einen Vorschlag.')));
        return;
      }
      const gruppe = (titel, glyph, zeilen) => {
        if (!zeilen.length) return null;
        return h('div.nw__links-group', null,
          h('h4', null, icon(I[glyph]), text(titel)),
          h('ul.nw__links-list', null, zeilen.map((z) => h('li', null, renderLinkRow(z)))));
      };
      for (const g of [gruppe('Verweist auf', 'out', v.ausgehend), gruppe('Hierher verweist', 'in', v.eingehend)]) {
        if (g) box.appendChild(g); // Node.append(null) schriebe "null" in die Seite
      }
      o.neuKanten = new Set();
    }

    function renderLinkRow(z) {
      const info = artInfo(z.type, z.entityKind);
      const key = z.edgeId || `${z.id}:${z.kind}`;
      const neu = st.open && st.open.neuKanten && st.open.neuKanten.has(key);
      return h('button.nw__link', {
        type: 'button',
        class: neu ? 'is-neu' : '',
        dataset: { ziel: z.id, kante: z.edgeId || '' },
        title: `${info.label}: ${z.title}`,
        onClick: () => {
          if (z.type === 'note') { openNote(z.id); return; }
          const ziel = zielFuer(z);
          if (ziel) navigate(ziel);
        },
      },
      h('span.nw__link-icon', null, icon(I[info.glyph] || I.note)),
      h('span.nw__link-main', null,
        h('span.nw__link-title', null, text(z.title || 'Ohne Titel')),
        h('span.nw__link-meta', null, text(`${info.label} · ${kantenText(z)}`))));
    }

    /* ---------------- Die Vorschlagskarte ---------------- */

    function renderCard() {
      const o = st.open;
      const k = o.karte;
      const box = h('aside.nw__card', { role: 'region', 'aria-label': 'Verbindungsvorschläge', dataset: { status: k.status } });
      if (k.status === 'verbunden') {
        box.classList.add('is-fertig');
        const n = k.verbunden.length;
        box.append(
          h('div.nw__card-status', null, icon(I.check),
            text(n === 1 ? `Verbunden mit „${k.verbunden[0].title}“.` : `Verbunden mit ${n} Einträgen: ${k.verbunden.map((v) => v.title).join(', ')}.`)),
          h('div.nw__card-actions', null,
            h('button.btn.btn--small', { type: 'button', disabled: k.busy || !k.edges.length, onClick: () => undoVerbinden() }, icon(I.undo), text('Rückgängig')),
            h('span.spacer'),
            h('button.btn.btn--ghost.btn--small', { type: 'button', onClick: () => { o.karte = null; renderLinks(); } }, text('Ausblenden'))));
        return box;
      }
      if (k.status === 'abgelehnt') {
        box.classList.add('is-fertig');
        box.append(
          h('div.nw__card-status', null, icon(I.check), text('Abgelehnt – diese Vorschläge kommen nicht wieder.')),
          h('div.nw__card-actions', null, h('span.spacer'),
            h('button.btn.btn--ghost.btn--small', { type: 'button', onClick: () => { o.karte = null; renderLinks(); } }, text('Ausblenden'))));
        return box;
      }
      box.appendChild(h('p.nw__card-head', null, icon(I.sparkle), text(vorschlagsSatz(k.vorschlaege.length))));
      const ul = h('ul.nw__card-list');
      for (const v of k.vorschlaege) {
        const info = artInfo(v.type, v.kind);
        const gewaehlt = k.gewaehlt.has(v.id);
        const zeile = h('li.nw__card-item', { class: k.bearbeiten && !gewaehlt ? 'is-aus' : '', dataset: { ziel: v.id } });
        if (k.bearbeiten) {
          zeile.appendChild(h('input', {
            type: 'checkbox',
            checked: gewaehlt,
            'aria-label': `„${v.title}“ verbinden`,
            onChange: (event) => {
              if (event.target.checked) k.gewaehlt.add(v.id); else k.gewaehlt.delete(v.id);
              renderLinks();
            },
          }));
        }
        zeile.append(
          icon(I[info.glyph] || I.note),
          h('span', null,
            h('span.nw__card-title', null, text(v.title || 'Ohne Titel')),
            text(' '),
            h('span.nw__card-grund', null, text(`${info.label}${v.grund ? ` · ${v.grund}` : ''}`))));
        ul.appendChild(zeile);
      }
      box.appendChild(ul);
      const gewaehlt = k.vorschlaege.filter((v) => k.gewaehlt.has(v.id));
      box.appendChild(h('div.nw__card-actions', null,
        h('button.btn.btn--primary.btn--small', {
          type: 'button',
          disabled: k.busy || (k.bearbeiten && !gewaehlt.length),
          onClick: () => verbindeVorschlaege(k.bearbeiten ? gewaehlt : k.vorschlaege),
        }, icon(I.link), text(k.bearbeiten ? `Ausgewählte verbinden (${gewaehlt.length})` : 'Alle verbinden')),
        h('button.btn.btn--small', {
          type: 'button',
          disabled: k.busy,
          'aria-pressed': k.bearbeiten ? 'true' : 'false',
          onClick: () => { k.bearbeiten = !k.bearbeiten; renderLinks(); },
        }, icon(I.pen), text(k.bearbeiten ? 'Fertig' : 'Bearbeiten')),
        h('span.spacer'),
        h('button.btn.btn--ghost.btn--small', {
          type: 'button',
          disabled: k.busy,
          onClick: () => lehneAb(k.bearbeiten ? gewaehlt : k.vorschlaege),
        }, text('Ablehnen'))));
      return box;
    }

    async function verbindeVorschlaege(liste) {
      const o = st.open;
      const k = o && o.karte;
      if (!k || !liste.length || k.busy) return;
      k.busy = true;
      renderLinks();
      try {
        const res = await api.post('/graph/verbinden', {
          from: o.id,
          to: liste.map((v) => v.id),
          kind: 'related',
          reason: liste.length === 1 && liste[0].grund ? `Vorschlag angenommen: ${liste[0].grund}` : 'Verbindungsvorschlag angenommen',
        });
        if (!st.alive || st.open !== o) return;
        const neu = res && res.rueckgaengig && Array.isArray(res.rueckgaengig.edges) ? res.rueckgaengig.edges : (res && res.neu) || [];
        k.busy = false;
        k.status = 'verbunden';
        k.verbunden = liste;
        k.edges = neu;
        toast(liste.length === 1 ? 'Verbunden.' : `${liste.length} Verbindungen angelegt.`, 'success');
        loadVerknuepft(o.id, { markiere: (res && res.edges ? res.edges : []).map((e) => e.id) });
      } catch (err) {
        if (!st.alive || st.open !== o) return;
        k.busy = false;
        toast(`Verbinden hat nicht geklappt: ${errorText(err)}`, 'error');
        renderLinks();
      }
    }

    async function undoVerbinden() {
      const o = st.open;
      const k = o && o.karte;
      if (!k || !k.edges.length || k.busy) return;
      k.busy = true;
      renderLinks();
      try {
        await api.post('/graph/rueckgaengig', { edges: k.edges });
        if (!st.alive || st.open !== o) return;
        k.busy = false;
        k.status = 'offen';
        k.edges = [];
        k.bearbeiten = false;
        toast('Rückgängig gemacht – die Vorschläge stehen wieder.', 'info');
        loadVerknuepft(o.id);
      } catch (err) {
        if (!st.alive || st.open !== o) return;
        k.busy = false;
        toast(`Rückgängig hat nicht geklappt: ${errorText(err)}`, 'error');
        renderLinks();
      }
    }

    async function lehneAb(liste) {
      const o = st.open;
      const k = o && o.karte;
      if (!k || !liste.length || k.busy) return;
      k.busy = true;
      renderLinks();
      try {
        await api.post('/graph/ablehnen', { from: o.id, to: liste.map((v) => v.id) });
        if (!st.alive || st.open !== o) return;
        k.busy = false;
        const rest = k.vorschlaege.filter((v) => !liste.some((l) => l.id === v.id));
        if (rest.length) {
          k.vorschlaege = rest;
          k.gewaehlt = new Set(rest.map((v) => v.id));
          k.bearbeiten = false;
          toast(`${liste.length === 1 ? 'Ein Vorschlag' : `${liste.length} Vorschläge`} abgelehnt.`, 'info');
        } else {
          k.status = 'abgelehnt';
        }
        renderLinks();
      } catch (err) {
        if (!st.alive || st.open !== o) return;
        k.busy = false;
        toast(`Ablehnen hat nicht geklappt: ${errorText(err)}`, 'error');
        renderLinks();
      }
    }

    /* ---------------- Blatt: schreiben ---------------- */

    function renderEditor() {
      const o = st.open;
      const note = o.note;
      const data = note.data || {};
      const neu = o.mode === 'neu';
      const titleId = neu ? 'nw-title-neu' : `nw-title-${note.id}`;
      const close = h('button.icon-button', { type: 'button', 'aria-label': 'Schließen', title: 'Schließen (Esc)', onClick: () => closeSheet() }, icon(I.close));

      const titleInput = h('input.nw__edit-title', {
        type: 'text',
        id: titleId,
        value: data.title || '',
        maxlength: '500',
        placeholder: 'Titel',
        'aria-label': 'Titel',
        autocomplete: 'off',
        onInput: () => { o.dirty = true; },
        onKeydown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (event.metaKey || event.ctrlKey) save(); else editor.focus();
          }
        },
      });
      const host = h('div.nw__edit-host');
      const error = h('p.nw__edit-error', { role: 'alert', hidden: true });
      const saveBtn = h('button.btn.btn--primary', { type: 'button', onClick: () => save() }, text('Speichern'));

      const editor = createNoteEditor(host, {
        value: data.body || '',
        label: 'Text der Notiz',
        minRows: 12,
        onChange: () => { o.dirty = true; },
        onSave: () => save(),
        complete: async (kind, q) => {
          const res = await api.get('/notizen/vervollstaendigen', { query: { art: kind, q, limit: 8 }, timeoutMs: 5000 });
          return (res && res.items) || [];
        },
        onImage: async (file) => {
          try {
            const daten = await dateiAlsBase64(file);
            const res = await api.post('/notizen/dateien', { name: file.name || 'bild.png', mime: file.type, daten }, { timeoutMs: 60000 });
            return res && res.markdown ? res.markdown : '';
          } catch (err) {
            toast(`Das Bild ließ sich nicht ablegen: ${errorText(err)}`, 'error');
            throw err;
          }
        },
      });
      o.editor = editor;
      sheetCleanups.push(() => { try { editor.destroy(); } catch { /* schon weg */ } });

      let busy = false;
      async function save() {
        if (busy) return;
        const title = titleInput.value.trim();
        const body = editor.getValue();
        if (!title) {
          clear(error);
          error.appendChild(text('Eine Notiz braucht einen Titel.'));
          error.hidden = false;
          titleInput.focus();
          return;
        }
        busy = true;
        saveBtn.disabled = true;
        error.hidden = true;
        try {
          let id = note.id;
          if (neu) {
            const res = await api.post('/records', { type: 'note', data: { title, body, tags: [] } });
            id = res && (res.id || (res.record && res.record.id));
            if (!id) throw new Error('Der Server hat keine Kennung zurückgegeben.');
            st.neuAufWand.add(id);
          } else {
            st.eigene.set(id, Date.now() + 2000);
            await api.patch(`/records/${encodeURIComponent(id)}`, { data: { title, body } });
          }
          if (!st.alive) return;
          o.dirty = false;
          toast(neu ? 'Notiz angelegt.' : 'Notiz gespeichert.', 'success');
          await load();
          if (!st.alive) return;
          await openNote(id, { fromRoute: true });
          if (typeof ctx.replaceRoute === 'function') ctx.replaceRoute(`#/notes?id=${id}`);
        } catch (err) {
          if (!st.alive) return;
          clear(error);
          error.appendChild(text(`Speichern hat nicht geklappt: ${errorText(err)}`));
          error.hidden = false;
        } finally {
          busy = false;
          saveBtn.disabled = false;
        }
      }

      const foot = h('footer.nw__read-foot', null,
        saveBtn,
        h('button.btn.btn--ghost', { type: 'button', onClick: () => (neu ? closeSheet() : openNote(note.id, { fromRoute: true })) }, text('Abbrechen')),
        h('span.spacer'),
        h('span.meta', null, text('Strg+Enter speichert')));

      const card = h('article.nw__read', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
        h('div.nw__read-top', null, h('span.nw__kicker', null, text(neu ? 'Neue Notiz' : 'Notiz bearbeiten')), close),
        h('div.nw__read-body', null,
          h('div.nw__edit', null, titleInput, host, error)),
        foot);
      mountSheet(card, { focus: neu || !data.title ? titleInput : null });
      if (!neu && data.title) setTimeout(() => editor.focus(), 0);
    }

    /* ---------------- Blatt: Aufgabe, Link, Text ---------------- */

    function renderForm() {
      const o = st.open;
      const art = o.art;
      const titleId = `nw-form-${art}`;
      const close = h('button.icon-button', { type: 'button', 'aria-label': 'Schließen', title: 'Schließen (Esc)', onClick: () => closeSheet() }, icon(I.close));
      const error = h('p.nw__edit-error', { role: 'alert', hidden: true });
      const fail = (msg) => { clear(error); error.appendChild(text(msg)); error.hidden = false; };
      let busy = false;
      let kicker;
      let felder;
      let submitLabel;
      let hint;
      let submit;
      let focus;

      if (art === 'aufgabe') {
        kicker = 'Neue Aufgabe';
        const titel = h('input.input', { type: 'text', placeholder: 'Was ist zu tun?', 'aria-label': 'Aufgabe', maxlength: '500', autocomplete: 'off', onInput: () => { o.dirty = !!titel.value.trim(); } });
        const faellig = h('input.input', { type: 'date', 'aria-label': 'Fällig am' });
        felder = [titel, h('label.field', null, h('span.label', null, text('Fällig am (optional)')), faellig)];
        hint = 'Die Aufgabe erscheint unter Projekte und im Gehirn – ein #Schlagwort im Text bleibt Text.';
        submitLabel = 'Aufgabe anlegen';
        focus = titel;
        submit = async () => {
          const title = titel.value.trim();
          if (!title) { fail('Eine Aufgabe braucht einen Text.'); titel.focus(); return; }
          const data = { title };
          if (faellig.value) data.due = faellig.value;
          const res = await api.post('/records', { type: 'task', data });
          const id = res && (res.id || (res.record && res.record.id));
          o.dirty = false;
          closeSheet({ force: true });
          toast(`Aufgabe „${title}“ angelegt.`, 'success', { action: id ? { label: 'Projekte öffnen', run: () => navigate('#/projects') } : undefined });
        };
      } else if (art === 'link') {
        kicker = 'Link speichern';
        const url = h('input.input', { type: 'url', placeholder: 'https://…', 'aria-label': 'Adresse', maxlength: '2000', autocomplete: 'off', inputmode: 'url', onInput: () => { o.dirty = !!url.value.trim(); } });
        const titel = h('input.input', { type: 'text', placeholder: 'Titel (optional – sonst holt Neural OS ihn von der Seite, wenn es online darf)', 'aria-label': 'Titel', maxlength: '500', autocomplete: 'off' });
        felder = [url, titel];
        hint = 'Es entsteht eine Notiz mit der Adresse und dem Schlagwort #link. Den Seitentitel holt Neural OS nur, wenn es online ist und die Schleuse die Adresse freigibt – sonst steht ehrlich nur die Adresse da.';
        submitLabel = 'Link speichern';
        focus = url;
        submit = async () => {
          const roh = url.value.trim();
          if (!roh) { fail('Ohne Adresse gibt es nichts zu speichern.'); url.focus(); return; }
          const res = await api.post('/notizen/link', { url: roh, titel: titel.value.trim() || undefined }, { timeoutMs: 15000 });
          const rec = res && res.record;
          o.dirty = false;
          closeSheet({ force: true, keepRoute: true });
          if (res && res.titelGeholt === false && res.grund) toast(res.grund, 'info', { timeout: 7000 });
          else toast('Link gespeichert.', 'success');
          await load();
          if (rec && st.alive) openNote(rec.id);
        };
      } else {
        kicker = 'Text speichern';
        const area = h('textarea.textarea', { placeholder: 'Einfügen oder tippen. Die erste Zeile wird der Titel.', 'aria-label': 'Text', rows: '8', onInput: () => { o.dirty = !!area.value.trim(); } });
        felder = [area];
        hint = 'Aus der ersten Zeile wird der Titel, der Rest der Text. [[Links]] und #Schlagworte darin verbinden die Notiz sofort.';
        submitLabel = 'Als Notiz speichern';
        focus = area;
        submit = async () => {
          const parsed = titelAusText(area.value);
          if (!parsed) { fail('Noch nichts eingegeben.'); area.focus(); return; }
          const res = await api.post('/records', { type: 'note', data: { title: parsed.title, body: parsed.body, tags: [] } });
          const id = res && (res.id || (res.record && res.record.id));
          o.dirty = false;
          closeSheet({ force: true, keepRoute: true });
          toast('Text als Notiz gespeichert.', 'success');
          if (id) st.neuAufWand.add(id);
          await load();
          if (id && st.alive) openNote(id);
        };
      }

      const submitBtn = h('button.btn.btn--primary', { type: 'submit' }, text(submitLabel));
      const form = h('form.nw__form', {
        onSubmit: async (event) => {
          event.preventDefault();
          if (busy) return;
          busy = true;
          submitBtn.disabled = true;
          error.hidden = true;
          try {
            await submit();
          } catch (err) {
            if (st.alive) fail(`Das hat nicht geklappt: ${errorText(err)}`);
          } finally {
            busy = false;
            submitBtn.disabled = false;
          }
        },
      }, felder, h('p.nw__form-hint', null, text(hint)), error,
      h('div.nw__form-actions', null, submitBtn,
        h('button.btn.btn--ghost', { type: 'button', onClick: () => closeSheet() }, text('Abbrechen')),
        h('span.spacer'),
        h('span.meta', null, text(art === 'text' ? 'Strg+Enter speichert' : 'Enter speichert'))));
      if (art === 'text') {
        felder[0].addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); form.requestSubmit(); }
        });
      }
      const card = h('article.nw__read.nw__read--klein', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
        h('div.nw__read-top', null, h('span.nw__kicker', { id: titleId }, text(kicker)), close),
        h('div.nw__read-body', null, form));
      mountSheet(card, { focus });
    }

    /* ---------------- Anheften, Loeschen ---------------- */

    async function togglePin(note) {
      const pinned = !note.data.pinned;
      try {
        st.eigene.set(note.id, Date.now() + 2000);
        await api.patch(`/records/${encodeURIComponent(note.id)}`, { data: { pinned } });
      } catch (err) {
        toast(`Das hat nicht geklappt: ${errorText(err)}`, 'error');
        return;
      }
      if (!st.alive) return;
      toast(pinned ? 'Angeheftet – steht jetzt ganz oben.' : 'Gelöst.', 'success');
      await load();
      if (st.open && st.open.id === note.id) openNote(note.id, { fromRoute: true });
    }

    async function removeNote(note) {
      const ok = await confirm({
        title: 'Notiz löschen?',
        message: `„${note.data.title || 'Ohne Titel'}“ verschwindet von der Wand. Du kannst es gleich danach rückgängig machen.`,
        confirmLabel: 'Löschen',
        danger: true,
      });
      if (!ok || !st.alive) return;
      try {
        await api.del(`/records/${encodeURIComponent(note.id)}`);
      } catch (err) {
        toast(`Löschen hat nicht geklappt: ${errorText(err)}`, 'error');
        return;
      }
      closeSheet({ force: true });
      await load();
      toast(`„${note.data.title || 'Notiz'}“ gelöscht.`, 'success', {
        action: {
          label: 'Rückgängig',
          run: async () => {
            try {
              await api.post(`/records/${encodeURIComponent(note.id)}/restore`);
              await load();
            } catch (err) {
              toast(`Wiederherstellen hat nicht geklappt: ${errorText(err)}`, 'error');
            }
          },
        },
        timeout: 9000,
      });
    }

    /* ---------------- Live und Aufraeumen ---------------- */

    const typeOf = (payload) => payload && (payload.type || (payload.record && payload.record.type));
    for (const name of ['record.created', 'record.updated', 'record.deleted']) {
      cleanups.push(bus.on(name, (payload) => {
        const type = typeOf(payload);
        if (name !== 'record.updated') st.aufgeloest.clear(); // ein neuer Titel kann einen Link aufloesen
        // Ein umbenannter Chat aendert die Herkunftszeile seiner Notizen.
        if (type !== 'note' && type !== 'chat') return;
        if (name === 'record.created' && type === 'note') st.neuAufWand.add(payload.id);
        reloadSoon();
        if (type === 'note' && st.open && st.open.id === payload.id && st.open.mode === 'read') {
          if (name === 'record.deleted') { closeSheet({ force: true }); return; }
          const bis = st.eigene.get(payload.id) || 0;
          if (bis > Date.now()) return; // unsere eigene Aenderung: das Blatt steht schon richtig
          setTimeout(() => { if (st.open && st.open.mode === 'read' && st.open.id === payload.id) openNote(payload.id, { fromRoute: true }); }, 400);
        }
      }));
    }
    cleanups.push(bus.on('graph.vorschlaege', (payload) => {
      const o = st.open;
      if (!o || o.mode !== 'read' || !payload || payload.recordId !== o.id) return;
      const vorschlaege = Array.isArray(payload.vorschlaege) ? payload.vorschlaege : [];
      if (o.karte && (o.karte.status !== 'offen' || o.karte.bearbeiten || o.karte.busy)) return;
      o.karte = vorschlaege.length ? { vorschlaege, status: 'offen', bearbeiten: false, gewaehlt: new Set(vorschlaege.map((v) => v.id)), busy: false, edges: [] } : null;
      renderLinks();
    }));
    cleanups.push(bus.on('graph.kante', (payload) => {
      const o = st.open;
      if (!o || o.mode !== 'read' || !payload) return;
      const d = payload.edge && payload.edge.data ? payload.edge.data : payload.edge;
      if (!d || (d.from !== o.id && d.to !== o.id)) return;
      clearTimeout(verknuepftTimer);
      verknuepftTimer = setTimeout(() => loadVerknuepft(o.id), 150);
    }));

    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('.dialog')) return;
      if (menu) { closeMenu(); return; }
      if (sheet) {
        // Im Editor schliesst Escape erst die Vorschlagsliste (die haelt das Ereignis an).
        event.preventDefault();
        closeSheet();
      }
    };
    document.addEventListener('keydown', onKey);
    cleanups.push(() => document.removeEventListener('keydown', onKey));
    cleanups.push(() => clearTimeout(reloadTimer));
    cleanups.push(() => clearTimeout(verknuepftTimer));

    this._cleanup = () => {
      st.alive = false;
      container.style.overflowY = '';
      closeMenu();
      for (const fn of sheetCleanups.splice(0)) { try { fn(); } catch { /* weiter */ } }
      for (const fn of cleanups.splice(0)) {
        try { fn(); } catch { /* weiter aufraeumen */ }
      }
    };

    render();
    await load();
    if (!st.alive) return;
    if (params.id) await openNote(params.id, { fromRoute: true });
    else if (params.neu === 'notiz') openNew();
    else if (params.neu === 'aufgabe' || params.neu === 'link' || params.neu === 'text') openForm(params.neu);
  },

  async unmount() {
    if (typeof this._cleanup === 'function') this._cleanup();
    this._cleanup = null;
  },
};
