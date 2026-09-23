/**
 * widgets/gehirn.js -- Kachel "Gehirn · Automatisch erkannt".
 *
 * Wie in docs/vorlage/app.png unten rechts: ein kleiner Ausschnitt des
 * Gehirns um das, worueber zuletzt gesprochen wurde. Der Knoten in der Mitte
 * ist blau, seine direkten Nachbarn tragen einen feinen Ring und ihren
 * Namen, was dahinter haengt, ist nur ein leiser Punkt. Antippen oeffnet das
 * grosse Gehirn genau dort.
 *
 * Was "zuletzt besprochen" heisst, entscheidet die Kachel aus den Daten,
 * nicht aus einer Vermutung:
 *   1. Der offene (sonst der juengste) Chat und alles, was mit ihm verbunden
 *      ist -- Notizen, Termine, Projekte, die die KI daraus gemacht hat. Die
 *      Mitte ist davon der Eintrag mit den meisten Verbindungen: das Thema,
 *      nicht der einzelne Zettel.
 *   2. Hat der Chat noch nichts Verbundenes, der zuletzt geaenderte Eintrag,
 *      der ueberhaupt eine Verbindung hat.
 *   3. Sonst sagt die Kachel ehrlich, dass das Netz noch leer ist.
 * Der Zeichner ist derselbe wie im grossen Bild (web/lib/graph-canvas.js),
 * nur ohne Bedienung: ein zweites, eigenes Netz-Bild wuerde anders aussehen
 * und anders altern.
 *
 * Schnittstelle (Vertrag 2): export function mount(el, ctx) -> { unmount() }
 */

import { createGraphCanvas } from '../lib/graph-canvas.js';

const STYLE_ID = 'nos-kachel-gehirn';

const CSS = `
.ghk { position: relative; display: block; height: 100%; min-height: 168px; border-radius: var(--r-2); color: inherit; text-decoration: none; }
.ghk:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.ghk__canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; pointer-events: none; }
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS;
  document.head.appendChild(node);
}

/** Wie viele Nachbarn einen Namen bekommen. Mehr waere in 380 px Breite Gedraenge. */
const MAX_NAMEN = 6;
/** Direkte Nachbarn im Bild (die ohne Namen sind leise Punkte). */
const MAX_NACHBARN = 9;
/** Zweiter Kreis: nur ein Hauch, damit man sieht, dass es weitergeht. */
const MAX_ZWEITE = 6;
/** So viel wird geladen; gezeigt wird danach nur der Ausschnitt oben. */
const MAX_KNOTEN = 60;
/** Arten, die nie die Mitte sind: Buchhaltung, kein Thema. */
const NIE_MITTE = new Set(['run', 'agent']);

export function mount(el, ctx) {
  ensureStyle();
  const { h, text, clear, icons, tileHead, api, bus, state } = ctx;
  let alive = true;
  let token = 0;
  let graph = null;
  const offs = [];

  const body = h('div.tile__body');
  el.append(tileHead({ icon: icons.graph, title: 'Gehirn', meta: 'Automatisch erkannt', href: '#/graph' }), body);

  function leer(satz) {
    if (graph) {
      graph.destroy();
      graph = null;
    }
    clear(body);
    body.appendChild(h('p.tile__empty', null, text(satz)));
  }

  /** Die Mitte: siehe Kopfkommentar. */
  async function mitteFinden(my) {
    const recent = (state && state.get('recentChats')) || [];
    const chatId = (state && state.get('activeChatId')) || (recent[0] && recent[0].id) || null;
    if (chatId) {
      try {
        const nb = await api.get('/graph', { query: { focus: chatId, depth: 1, limit: 60 }, timeoutMs: 10000 });
        if (my !== token) return null;
        const kandidaten = (nb.nodes || []).filter((node) => !NIE_MITTE.has(node.type));
        if (kandidaten.length > 1) {
          kandidaten.sort((a, b) => ((b.totalDegree || 0) - (a.totalDegree || 0))
            || (a.id === chatId ? -1 : b.id === chatId ? 1 : 0));
          return kandidaten[0].id;
        }
      } catch (err) {
        // Ein geloeschter Chat ist kein Fehler der Kachel: weiter mit Schritt 2.
        if (!(err && err.status === 404)) throw err;
      }
    }
    const jung = await api.get('/graph', { query: { limit: 80, includeOrphans: true }, timeoutMs: 10000 });
    if (my !== token) return null;
    const treffer = (jung.nodes || []).find((node) => (node.totalDegree || 0) > 0 && !NIE_MITTE.has(node.type));
    return treffer ? treffer.id : null;
  }

  async function laden() {
    const my = ++token;
    let mitte;
    let netz;
    try {
      mitte = await mitteFinden(my);
      if (my !== token || !alive) return;
      if (!mitte) {
        leer('Noch leer. Was die KI über dich lernt, wächst hier als Netz.');
        return;
      }
      netz = await api.get('/graph', { query: { focus: mitte, depth: 2, limit: MAX_KNOTEN }, timeoutMs: 10000 });
    } catch (err) {
      if (my !== token || !alive) return;
      leer(`Das Gehirn ist gerade nicht erreichbar${err && err.message ? `: ${err.message}` : '.'}`);
      return;
    }
    if (my !== token || !alive) return;
    zeichnen(mitte, netz.nodes || [], netz.edges || []);
  }

  /**
   * Nur ein Ausschnitt: die Mitte, ihre wichtigsten Nachbarn, dahinter ein
   * paar leise Punkte. Ein Hub mit hundert Nachbarn waere in der Kachel ein
   * Igel, kein Bild.
   */
  function ausschnitt(mitte, nodes, edges) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const adj = new Map();
    for (const e of edges) {
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      if (!adj.has(e.from)) adj.set(e.from, new Set());
      if (!adj.has(e.to)) adj.set(e.to, new Set());
      adj.get(e.from).add(e.to);
      adj.get(e.to).add(e.from);
    }
    const wichtig = (a, b) => ((b.totalDegree || 0) - (a.totalDegree || 0))
      || String(a.label).localeCompare(String(b.label), 'de');
    const nachbarn = [...(adj.get(mitte) || [])].map((id) => byId.get(id)).sort(wichtig).slice(0, MAX_NACHBARN);
    const drin = new Set([mitte, ...nachbarn.map((node) => node.id)]);
    const zweite = [];
    for (const nb of nachbarn) {
      for (const id of adj.get(nb.id) || []) {
        if (drin.has(id) || zweite.length >= MAX_ZWEITE) continue;
        drin.add(id);
        zweite.push(id);
      }
    }
    return {
      nodes: nodes.filter((node) => drin.has(node.id)),
      edges: edges.filter((e) => drin.has(e.from) && drin.has(e.to)),
      nachbarn,
    };
  }

  function zeichnen(mitte, alleKnoten, alleKanten) {
    if (!alleKnoten.some((node) => node.id === mitte)) {
      leer('Noch leer. Was die KI über dich lernt, wächst hier als Netz.');
      return;
    }
    const { nodes, edges, nachbarn } = ausschnitt(mitte, alleKnoten, alleKanten);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const genannt = nachbarn.slice(0, MAX_NAMEN);

    const center = byId.get(mitte);
    const beschreibung = `Gehirn öffnen: ${center.label}${genannt.length ? `, verbunden mit ${genannt.map((node) => node.label).join(', ')}` : ''}`;

    let link = body.querySelector('a.ghk');
    let canvas = link && link.querySelector('canvas');
    if (!link || !graph) {
      clear(body);
      canvas = h('canvas.ghk__canvas', { 'aria-hidden': 'true' });
      link = h('a.ghk', { href: '#/graph' }, canvas);
      body.appendChild(link);
      if (graph) graph.destroy();
      graph = createGraphCanvas(canvas, { mini: true });
    }
    link.setAttribute('href', `#/graph?focus=${encodeURIComponent(mitte)}`);
    link.setAttribute('aria-label', beschreibung);
    link.setAttribute('title', beschreibung);

    graph.setData({ nodes, edges });
    graph.pin(mitte, 0, 0);
    graph.setLabels({ always: genannt.map((node) => node.id), rings: genannt.map((node) => node.id) });
    graph.setSelection(mitte);
    graph.prewarm(320, 120);
    graph.freeze();
    graph.fitToView({ animate: false });
  }

  // Live: nach neuen Eintraegen, Verbindungen, Chat-Nachrichten -- gebuendelt.
  let wartet = 0;
  const bald = () => {
    if (!alive) return;
    clearTimeout(wartet);
    wartet = setTimeout(() => { if (alive) laden(); }, 1800);
  };
  if (bus && typeof bus.on === 'function') {
    for (const name of ['record.created', 'record.updated', 'record.deleted', 'edge.created', 'edge.deleted', 'graph.rescanned', 'chat.message']) {
      offs.push(bus.on(name, bald));
    }
  }
  if (state && typeof state.on === 'function') {
    offs.push(state.on('activeChatId', bald));
    offs.push(state.on('theme', () => {
      requestAnimationFrame(() => { if (alive && graph) graph.refreshTheme(); });
    }));
  }
  try {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onMedia = () => { if (alive && graph) graph.refreshTheme(); };
    media.addEventListener('change', onMedia);
    offs.push(() => media.removeEventListener('change', onMedia));
  } catch { /* dann bleibt die erste Palette */ }

  body.appendChild(h('p.tile__empty', null, text('Wird geladen …')));
  laden();

  return {
    unmount() {
      alive = false;
      token++;
      clearTimeout(wartet);
      for (const off of offs.splice(0)) {
        try { off(); } catch { /* schon weg */ }
      }
      if (graph) graph.destroy();
      graph = null;
      clear(el);
    },
  };
}

export default { mount };
