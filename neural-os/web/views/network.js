/**
 * views/network.js -- Netzwerk, schlicht.
 *
 * Drei Dinge, mehr nicht (Wunsch des Nutzers: "kein Schnickschnack"):
 *  1. der Zustand in einem Satz;
 *  2. der Schalter online/offline;
 *  3. die Liste der Verbindungen: wohin Neural OS wirklich wollte, ob es
 *     durfte, wann zuletzt. Gelesen aus dem Protokoll auf der Platte
 *     (GET /api/network/audit), nicht aus einer Zählung im Speicher -- das
 *     Protokoll überlebt den Prozess, der es geschrieben hat.
 *
 * Alles andere (Hostlisten, Freigaben je Agent, Probe-Anfragen) gibt es
 * weiter über die Schnittstelle; hier steht davon nur, was der Nutzer
 * braucht: "Claude freigeben", wenn die Schleuse Claude gerade abweist.
 */

import { h, text, clear, icon, timeAgo, formatNumber, debounce } from '../lib/dom.js';

const STYLE_ID = 'nos-network-view-style';

/** Was als "Verbindung" zählt: jede Entscheidung der Schleuse über ein Ziel. */
const ARTEN = new Set(['network.allow', 'network.block', 'network.local', 'network.dns.block']);

let aktiv = null;

export default {
  id: 'network',
  title: 'Netzwerk',

  async mount(container, ctx) {
    ensureStyle();
    abbauen();
    const self = { ctx, api: ctx.api, alive: true, container, cleanups: [], dom: {}, netz: null, netzFehler: null, protokoll: null, protokollFehler: null, claude: null };
    aktiv = self;
    clear(container);
    self.dom.satz = h('div.nwv__zustand');
    self.dom.liste = h('div.nwv__liste');
    container.appendChild(h('div.page.nwv', null,
      self.dom.satz,
      h('section.nwv__karte', { 'aria-label': 'Verbindungen' },
        h('header.nwv__kopf', null,
          h('h2', null, text('Verbindungen')),
          h('span.meta', null, text('Wohin Neural OS wollte – und ob es durfte.'))),
        self.dom.liste)));
    const neu = debounce(() => { allesLaden(self).then(() => self.alive && zeichnen(self)); }, 400);
    if (ctx.bus && typeof ctx.bus.on === 'function') {
      self.cleanups.push(ctx.bus.on('*', (payload, event) => {
        const typ = (event && event.type) || '';
        if (typ === 'network.mode' || typ === 'network.attempt' || typ === 'network.grant' || typ === 'config.changed' || typ.startsWith('claude')) neu();
      }));
    }
    await allesLaden(self);
    if (self.alive) zeichnen(self);
  },

  async unmount() {
    abbauen();
  },
};

function abbauen() {
  const self = aktiv;
  aktiv = null;
  if (!self) return;
  self.alive = false;
  for (const off of self.cleanups) {
    try { off(); } catch { /* weg */ }
  }
}

async function allesLaden(self) {
  const [netz, protokoll, claude, ipad] = await Promise.allSettled([
    self.api.get('/network', { timeoutMs: 10000 }),
    self.api.get('/network/audit', { query: { limit: 400 }, timeoutMs: 10000 }),
    self.api.get('/claude', { timeoutMs: 8000 }),
    self.api.get('/ipad', { timeoutMs: 8000 }),
  ]);
  if (!self.alive) return;
  self.ipad = ipad.status === 'fulfilled' ? ipad.value : null;
  self.netz = netz.status === 'fulfilled' ? netz.value : null;
  self.netzFehler = netz.status === 'rejected' ? netz.reason : null;
  self.protokoll = protokoll.status === 'fulfilled' ? protokoll.value : null;
  self.protokollFehler = protokoll.status === 'rejected' ? protokoll.reason : null;
  self.claude = claude.status === 'fulfilled' ? claude.value : null;
}

function zeichnen(self) {
  zeichneZustand(self);
  zeichneListe(self);
}

const SAETZE = {
  online: ['Online', 'Neural OS darf ins Internet: Claude antwortet und sucht im Netz. Jede Verbindung steht unten.'],
  lan: ['Nur lokales Netz', 'Neural OS spricht nur mit Geräten in deinem WLAN, nicht mit dem Internet. Claude ist so nicht erreichbar.'],
  offline: ['Offline', 'Nichts verlässt diesen Rechner. Claude antwortet erst, wenn du online gehst.'],
};

function zeichneZustand(self) {
  const box = self.dom.satz;
  clear(box);
  const n = self.netz;
  if (!n) {
    box.appendChild(h('p.nwv__satz.is-warn', null, text(self.netzFehler
      ? `Der Netzzustand ist gerade nicht abrufbar: ${self.netzFehler.message || self.netzFehler}`
      : 'Der Netzzustand ist nicht bekannt.')));
    return;
  }
  const mode = n.mode;
  const [wort, satz] = SAETZE[mode] || ['Unbekannt', 'Der Netzmodus ist unbekannt.'];
  const schalter = h('button.nwv__schalter', {
    type: 'button',
    role: 'switch',
    'aria-checked': mode === 'online' ? 'true' : 'false',
    'aria-label': 'Online',
    class: mode === 'online' ? 'is-an' : null,
    onClick: async (ev) => {
      const ziel = mode === 'online' ? 'offline' : 'online';
      ev.currentTarget.disabled = true;
      try {
        await self.api.put('/network', { mode: ziel });
        if (self.alive) self.ctx.toast(ziel === 'online' ? 'Neural OS ist online.' : 'Neural OS ist offline. Nichts verlässt mehr diesen Rechner.', 'success');
      } catch (err) {
        if (self.alive) self.ctx.toast(`Nicht umgeschaltet: ${err.message || err}`, 'error');
      }
      await allesLaden(self);
      if (self.alive) zeichnen(self);
    },
  }, h('span.nwv__knauf', { 'aria-hidden': 'true' }));

  box.appendChild(h('div.nwv__oben', null,
    h('div.nwv__text', null,
      h('p.nwv__modus', null,
        h(`span.dot${mode === 'online' ? '.dot--accent' : mode === 'lan' ? '.dot--warn' : ''}`, { 'aria-hidden': 'true' }),
        text(wort)),
      h('p.nwv__satz', null, text(satz)),
      // "Nichts verlässt diesen Rechner" stimmt nicht mehr, sobald ein iPad
      // mitliest -- das steht dann gleich dahinter.
      self.ipad && self.ipad.an
        ? h('p.nwv__satz.nwv__ipad', null, text('Ausnahme: Die Freigabe für das iPad ist an. Ein verbundenes iPad im WLAN sieht, was du hier siehst.'))
        : null),
    h('label.nwv__schalter-wrap', null, h('span', null, text(mode === 'online' ? 'Online' : 'Offline')), schalter)));

  // Claude will, aber die Schleuse lässt es nicht: das eine, was hier behoben werden kann.
  const c = self.claude;
  if (mode === 'online' && c && c.grundCode === 'schleuse') {
    box.appendChild(h('div.nwv__hinweis', null,
      icon((self.ctx.icons || {}).alert),
      h('span', null, text('Die Schleuse lässt api.anthropic.com nicht durch – Claude kann so nicht antworten.')),
      h('button.btn.btn--accent.btn--small', {
        type: 'button',
        onClick: async (ev) => {
          ev.currentTarget.disabled = true;
          const hosts = Array.isArray(n.allowHosts) ? n.allowHosts.slice() : [];
          if (!hosts.includes('api.anthropic.com')) hosts.push('api.anthropic.com');
          try {
            await self.api.put('/network', { allowHosts: hosts });
            if (self.alive) self.ctx.toast('Claude ist freigegeben.', 'success');
          } catch (err) {
            if (self.alive) self.ctx.toast(`Nicht freigegeben: ${err.message || err}`, 'error');
          }
          await allesLaden(self);
          if (self.alive) zeichnen(self);
        },
      }, text('Claude freigeben'))));
  }
  if (n.hardened === false) {
    box.appendChild(h('p.nwv__satz.meta', null, text('Hinweis: Die Schleuse ist in diesem Prozess nicht erzwungen. Neural OS hält sich daran; ein fremdes Modul müsste es nicht.')));
  }
}

/** Aus den Protokollzeilen je Ziel eine Zeile machen. */
function verbindungen(eintraege) {
  const je = new Map();
  for (const e of eintraege) {
    if (!e || !ARTEN.has(e.kind) || !e.host) continue;
    const ziel = e.port && e.port !== 443 && e.port !== 80 ? `${e.host}:${e.port}` : e.host;
    let v = je.get(ziel);
    if (!v) {
      v = { ziel, erlaubt: 0, gesperrt: 0, zuletzt: null, letzteEntscheidung: null, zweck: '', grund: '' };
      je.set(ziel, v);
    }
    if (e.allowed === true) v.erlaubt += 1;
    else v.gesperrt += 1;
    // readTail liefert die neuesten zuerst.
    if (!v.zuletzt) {
      v.zuletzt = e.at;
      v.letzteEntscheidung = e.allowed === true;
      v.zweck = e.purpose || '';
      v.grund = e.reason || '';
    }
  }
  return [...je.values()].sort((a, b) => String(b.zuletzt || '').localeCompare(String(a.zuletzt || '')));
}

function zeichneListe(self) {
  const box = self.dom.liste;
  clear(box);
  if (!self.protokoll) {
    box.appendChild(h('p.nwv__leer', null, text(self.protokollFehler
      ? `Das Protokoll ist gerade nicht lesbar: ${self.protokollFehler.message || self.protokollFehler}`
      : 'Das Protokoll ist nicht verfügbar.')));
    return;
  }
  const liste = verbindungen(Array.isArray(self.protokoll.items) ? self.protokoll.items : []);
  if (!liste.length) {
    box.appendChild(h('p.nwv__leer', null, text('Noch keine Verbindung. Sobald Neural OS irgendwohin will, steht es hier – auch, wenn es nicht durfte.')));
    return;
  }
  for (const v of liste.slice(0, 60)) {
    box.appendChild(h('div.nwv__zeile', null,
      h(`span.dot${v.letzteEntscheidung ? '.dot--accent' : '.dot--danger'}`, { 'aria-hidden': 'true' }),
      h('div.nwv__ziel', null,
        h('span.nwv__host', null, text(v.ziel)),
        h('span.meta', null, text(v.letzteEntscheidung
          ? (v.zweck || 'erlaubt')
          : `gesperrt${v.grund ? ` – ${v.grund}` : ''}`))),
      h('span.nwv__zahl.meta', null, text([
        v.erlaubt ? `${formatNumber(v.erlaubt)}× erlaubt` : null,
        v.gesperrt ? `${formatNumber(v.gesperrt)}× gesperrt` : null,
      ].filter(Boolean).join(' · '))),
      h('span.nwv__zeit.meta', null, text(v.zuletzt ? timeAgo(v.zuletzt) : ''))));
  }
}

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS; // hier geschrieben, niemals Nutzerdaten
  document.head.appendChild(node);
}

const CSS = `
.nwv { display: flex; flex-direction: column; gap: var(--sp-2); padding-top: var(--sp-3); }
.nwv p { margin: 0; }
.nwv__zustand { display: flex; flex-direction: column; gap: var(--sp-1); }
.nwv__oben {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-4);
  box-shadow: var(--shadow-1);
}
.nwv__text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.nwv__modus {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: var(--fs-xl);
  font-weight: 500;
  line-height: var(--lh-tight);
}
.nwv__modus .dot:not(.dot--accent):not(.dot--warn) { background: var(--fg-subtle); }
.nwv__satz { color: var(--fg-muted); line-height: var(--lh); }
.nwv__satz.is-warn { color: var(--warn); }
.nwv__ipad { color: var(--accent-text); font-size: var(--fs-sm); }
.nwv__satz.meta { color: var(--fg-subtle); font-size: var(--fs-sm); padding: 0 var(--sp-1); }
.nwv__schalter-wrap {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  flex: none;
  color: var(--fg-muted);
  font-size: var(--fs-sm);
  cursor: pointer;
}
.nwv__schalter {
  position: relative;
  width: 52px;
  height: 30px;
  min-height: 30px;
  padding: 0;
  border-radius: var(--r-full);
  border: 1px solid var(--border-strong);
  background: var(--surface-4);
  cursor: pointer;
  transition: background var(--dur-2) var(--ease), border-color var(--dur-2) var(--ease);
}
.nwv__schalter.is-an { background: var(--accent); border-color: var(--accent); }
.nwv__knauf {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 22px;
  height: 22px;
  border-radius: var(--r-full);
  /* Weiss in beiden Darstellungen, wie ein Schalter am iPad: aus heisst
     grauer Grund, an heisst blauer Grund -- der Knauf bleibt derselbe. */
  background: var(--accent-fg);
  box-shadow: var(--shadow-1);
  transition: transform var(--dur-2) var(--ease);
}
.nwv__schalter.is-an .nwv__knauf { transform: translateX(22px); }
.nwv__schalter:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.nwv__hinweis {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: var(--r-3);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  font-size: var(--fs-sm);
}
.nwv__hinweis > svg { color: var(--warn); flex: none; }
.nwv__hinweis > span { flex: 1 1 240px; }
.nwv__karte {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-4);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}
.nwv__kopf {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-1) var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
}
.nwv__kopf h2 { margin: 0; font-size: var(--fs-md); font-weight: 600; }
.nwv__liste { display: flex; flex-direction: column; }
.nwv__zeile {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px var(--sp-3);
  border-bottom: 1px solid var(--border);
}
.nwv__zeile:last-child { border-bottom: 0; }
.nwv__ziel { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.nwv__host { font-family: var(--font-mono); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.nwv__ziel .meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nwv__zahl, .nwv__zeit { flex: none; white-space: nowrap; }
.nwv__zeit { min-width: 6.5em; text-align: right; }
.nwv__leer { padding: var(--sp-3); color: var(--fg-subtle); }
/* Mit dem Finger: ein Schalter von 44 px Höhe, wie jeder andere Knopf. */
@media (pointer: coarse) {
  .nwv__schalter { width: 72px; height: var(--tap-min); min-height: var(--tap-min); }
  .nwv__knauf { top: 4px; left: 4px; width: 34px; height: 34px; }
  .nwv__schalter.is-an .nwv__knauf { transform: translateX(28px); }
}
@media (max-width: 640px) {
  .nwv__oben { flex-direction: column; align-items: flex-start; }
  .nwv__zahl { display: none; }
}
`;
