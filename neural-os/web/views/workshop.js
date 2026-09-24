/**
 * views/workshop.js -- die Werkstatt, schlicht.
 *
 * Ein großes Feld "Code einfügen", zwei Knöpfe ("Prüfen", "Einschalten"),
 * darunter die installierten Erweiterungen mit Aus-Schalter und
 * "Rückgängig". Keine Visualisierung (Wunsch des Nutzers).
 *
 * Die Regeln dahinter stehen in src/http/api/modules.js und gelten weiter:
 *  - "Prüfen" führt den Code probehalber aus und installiert NICHTS;
 *  - "Einschalten" zeigt vorher in einem Satz, was die Erweiterung darf,
 *    und erst die Bestätigung schaltet sie ein;
 *  - trägt der Code denselben Namen wie eine installierte Erweiterung, wird
 *    diese aktualisiert, nicht verdoppelt -- so bleibt die alte Fassung im
 *    Verlauf, und "Rückgängig" holt sie zurück;
 *  - "Rückgängig" heißt: die letzte Änderung zurücknehmen. Gibt es eine
 *    frühere Fassung, wird sie wiederhergestellt; gibt es keine, wird die
 *    Erweiterung (nach Rückfrage) entfernt.
 */

import { h, text, clear, icon, timeAgo } from '../lib/dom.js';

const STYLE_ID = 'nos-workshop-view-style';

const BEISPIEL = `// Eine Erweiterung ist ein kleines Modul mit Namen und Rechten.
module.exports = {
  manifest: { name: 'Hallo', kind: 'server', capabilities: [] },
  setup(api) {
    api.log('Hallo aus der Werkstatt');
  },
};`;

let aktiv = null;

export default {
  id: 'workshop',
  title: 'Werkstatt',

  async mount(container, ctx) {
    ensureStyle();
    abbauen();
    const self = {
      ctx,
      api: ctx.api,
      alive: true,
      container,
      cleanups: [],
      dom: {},
      liste: null,
      listeFehler: null,
      pruefung: null,       // {quelle, ergebnis}
      busy: new Set(),
    };
    aktiv = self;
    geruest(self);
    if (ctx.bus && typeof ctx.bus.on === 'function') {
      self.cleanups.push(ctx.bus.on('*', (payload, event) => {
        const typ = (event && event.type) || '';
        if (typ.startsWith('module.')) laden(self).then(() => self.alive && zeichneListe(self));
      }));
    }
    await laden(self);
    if (self.alive) zeichneListe(self);
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

async function laden(self) {
  try {
    const r = await self.api.get('/modules', { timeoutMs: 10000 });
    if (!self.alive) return;
    self.liste = r;
    self.listeFehler = null;
  } catch (err) {
    if (!self.alive) return;
    self.liste = null;
    self.listeFehler = err;
  }
}

function meldung(err) {
  return (err && err.message) || String(err);
}

/* ------------------------------------------------------------------ */
/* Code einfügen                                                       */
/* ------------------------------------------------------------------ */

function geruest(self) {
  clear(self.container);
  const feld = h('textarea.textarea.wsv__code', {
    spellcheck: 'false',
    placeholder: BEISPIEL,
    'aria-label': 'Code einfügen',
    attrs: { autocorrect: 'off', autocapitalize: 'off', wrap: 'off' },
    onInput: () => ergebnisVeraltet(self),
  });
  const pruefen = h('button.btn', { type: 'button', onClick: () => pruefe(self) }, text('Prüfen'));
  const einschalten = h('button.btn.btn--primary', { type: 'button', disabled: true, onClick: () => schalteEin(self) }, text('Einschalten'));
  self.dom = { feld, pruefen, einschalten, ergebnis: h('div.wsv__ergebnis', { role: 'status' }), liste: h('div.wsv__liste') };
  self.container.appendChild(h('div.page.wsv', null,
    h('section.wsv__karte', { 'aria-label': 'Code einfügen' },
      h('header.wsv__kopf', null,
        h('h2', null, text('Code einfügen')),
        h('span.meta', null, text('Eine Erweiterung, die du irgendwo bekommen oder mit Claude geschrieben hast.'))),
      h('div.wsv__innen', null,
        feld,
        h('div.wsv__knoepfe', null, pruefen, einschalten, h('span.meta.wsv__regel', null, text('Prüfen installiert nichts. Eingeschaltet wird erst nach deiner Bestätigung.'))),
        self.dom.ergebnis)),
    h('section.wsv__karte', { 'aria-label': 'Installierte Erweiterungen' },
      h('header.wsv__kopf', null,
        h('h2', null, text('Installierte Erweiterungen'))),
      self.dom.liste)));
}

function ergebnisVeraltet(self) {
  if (!self.pruefung) return;
  if (self.pruefung.quelle !== self.dom.feld.value) {
    self.dom.einschalten.disabled = true;
    self.dom.ergebnis.classList.add('is-veraltet');
  } else {
    self.dom.einschalten.disabled = !(self.pruefung.ergebnis && self.pruefung.ergebnis.ok);
    self.dom.ergebnis.classList.remove('is-veraltet');
  }
}

async function pruefe(self) {
  const quelle = self.dom.feld.value;
  const box = self.dom.ergebnis;
  clear(box);
  box.classList.remove('is-veraltet');
  if (!quelle.trim()) {
    box.appendChild(h('p.wsv__zeile.is-warn', null, text('Das Feld ist leer. Füge zuerst den Code ein.')));
    return null;
  }
  self.dom.pruefen.disabled = true;
  box.appendChild(h('p.wsv__zeile', null, h('span.spinner', { 'aria-hidden': 'true' }), text('Wird probehalber ausgeführt …')));
  let ergebnis = null;
  try {
    const r = await self.api.post('/modules/validate', { source: quelle }, { timeoutMs: 30000 });
    ergebnis = r && r.validation ? r.validation : r;
  } catch (err) {
    if (!self.alive) return null;
    clear(box);
    box.appendChild(h('p.wsv__zeile.is-danger', null, text(meldung(err))));
    self.dom.pruefen.disabled = false;
    return null;
  }
  if (!self.alive) return null;
  self.dom.pruefen.disabled = false;
  self.pruefung = { quelle, ergebnis };
  zeichneErgebnis(self, ergebnis);
  self.dom.einschalten.disabled = !(ergebnis && ergebnis.ok);
  return ergebnis;
}

function zeichneErgebnis(self, e) {
  const box = self.dom.ergebnis;
  clear(box);
  const I = self.ctx.icons || {};
  if (!e) return;
  if (e.ok) {
    const name = (e.manifest && e.manifest.name) || 'Erweiterung';
    const vorhanden = findeNachName(self, name);
    box.appendChild(h('div.wsv__gut', null,
      icon(I.checkCircle || I.check),
      h('div', null,
        h('strong', null, text(`„${name}“ ist in Ordnung.`)),
        h('p', null, text(e.kind === 'ui' ? 'Eine Erweiterung der Oberfläche.' : 'Eine Erweiterung, die im Hintergrund läuft.')),
        h('p', null, text(e.description || 'Verlangt keine besonderen Rechte.')),
        vorhanden ? h('p.meta', null, text(`Es gibt „${name}“ schon. Einschalten ersetzt die installierte Fassung; die alte bleibt für „Rückgängig“.`)) : null)));
  } else {
    const probleme = Array.isArray(e.problems) ? e.problems : [];
    box.appendChild(h('div.wsv__schlecht', null,
      icon(I.alert),
      h('div', null,
        h('strong', null, text(probleme.length === 1 ? 'Ein Problem – so läuft es noch nicht.' : `${probleme.length} Probleme – so läuft es noch nicht.`)),
        h('ul', null, probleme.map((p) => h('li', null,
          p && p.line ? h('span.badge', null, text(`Zeile ${p.line}`)) : null,
          text(` ${(p && p.message) || String(p)}`)))))));
  }
  const warnungen = Array.isArray(e.warnings) ? e.warnings : [];
  if (warnungen.length) {
    box.appendChild(h('ul.wsv__warnungen', null, warnungen.map((w) => h('li.meta', null, text((w && w.message) || String(w))))));
  }
}

function findeNachName(self, name) {
  const items = self.liste && Array.isArray(self.liste.items) ? self.liste.items : [];
  return items.find((r) => datenVon(r).name === name && datenVon(r).builtin !== true) || null;
}

function datenVon(record) {
  return record && record.data && typeof record.data === 'object' ? record.data : (record || {});
}

async function schalteEin(self) {
  let p = self.pruefung;
  if (!p || p.quelle !== self.dom.feld.value) {
    const neu = await pruefe(self);
    p = self.pruefung;
    if (!neu || !neu.ok) return;
  }
  const e = p.ergebnis;
  const name = (e.manifest && e.manifest.name) || 'Erweiterung';
  const ok = await self.ctx.confirm({
    title: `„${name}“ einschalten?`,
    message: `${e.description || 'Verlangt keine besonderen Rechte.'} Ausschalten geht jederzeit mit einem Klick.`,
    confirmLabel: 'Einschalten',
  });
  if (!ok || !self.alive) return;
  self.dom.einschalten.disabled = true;
  try {
    const vorhanden = findeNachName(self, name);
    let id;
    if (vorhanden) {
      const r = await self.api.patch(`/modules/${encodeURIComponent(vorhanden.id)}`, { source: p.quelle, note: 'Aus der Werkstatt' }, { timeoutMs: 30000 });
      id = (r && r.record && r.record.id) || vorhanden.id;
    } else {
      const r = await self.api.post('/modules', { source: p.quelle, note: 'Aus der Werkstatt' }, { timeoutMs: 30000 });
      id = r && r.record && r.record.id;
    }
    if (!id) throw new Error('Die Erweiterung wurde gespeichert, aber ohne Kennung zurückgemeldet.');
    const an = await self.api.post(`/modules/${encodeURIComponent(id)}/enable`, { capabilities: e.capabilities || [] }, { timeoutMs: 30000 });
    if (!self.alive) return;
    if (an && an.enabled) {
      self.ctx.toast(`„${name}“ ist eingeschaltet.`, 'success');
      self.dom.feld.value = '';
      self.pruefung = null;
      clear(self.dom.ergebnis);
    } else {
      const fehler = an && an.record ? datenVon(an.record).lastError : null;
      self.ctx.toast(`„${name}“ ist installiert, lief aber nicht an${fehler ? `: ${fehler}` : '.'}`, 'error');
    }
  } catch (err) {
    if (!self.alive) return;
    self.ctx.toast(meldung(err), 'error');
    const v = err && err.details && err.details.validation;
    if (v) zeichneErgebnis(self, v);
  }
  await laden(self);
  if (self.alive) {
    zeichneListe(self);
    ergebnisVeraltet(self);
  }
}

/* ------------------------------------------------------------------ */
/* Installierte Erweiterungen                                          */
/* ------------------------------------------------------------------ */

function zeichneListe(self) {
  const box = self.dom.liste;
  clear(box);
  if (!self.liste) {
    box.appendChild(h('p.wsv__leer', null, text(self.listeFehler ? meldung(self.listeFehler) : 'Die Erweiterungen sind nicht abrufbar.')));
    return;
  }
  const items = Array.isArray(self.liste.items) ? self.liste.items : [];
  if (!items.length) {
    box.appendChild(h('p.wsv__leer', null, text('Noch keine Erweiterung. Füge oben Code ein, prüfe ihn und schalte ihn ein.')));
    return;
  }
  const beschreibungen = self.liste.descriptions || {};
  for (const record of items) {
    const d = datenVon(record);
    const versionen = Array.isArray(d.versions) ? d.versions : [];
    const an = d.enabled === true;
    const busyKey = record.id;
    const schalter = h('button.wsv__schalter', {
      type: 'button',
      role: 'switch',
      'aria-checked': an ? 'true' : 'false',
      'aria-label': `${d.name || record.id} ${an ? 'ausschalten' : 'einschalten'}`,
      class: an ? 'is-an' : null,
      disabled: self.busy.has(busyKey),
      onClick: () => umschalten(self, record, !an),
    }, h('span.wsv__knauf', { 'aria-hidden': 'true' }));
    const beschr = beschreibungen[record.id];
    const zustand = d.lastError ? ['danger', `Fehler: ${d.lastError}`] : an ? ['accent', 'Läuft'] : [null, 'Aus'];
    box.appendChild(h('div.wsv__eintrag', null,
      h('div.wsv__info', null,
        h('div.wsv__name', null,
          h('strong', null, text(d.name || record.id)),
          h('span.badge', null, text(d.kind === 'ui' ? 'Oberfläche' : 'Hintergrund')),
          h('span.meta', null, text(`Fassung ${d.version || 1}${record.updatedAt ? ` · ${timeAgo(record.updatedAt)}` : ''}`))),
        h('span.wsv__zustand', null,
          h(`span.dot${zustand[0] ? `.dot--${zustand[0]}` : ''}`, { 'aria-hidden': 'true' }),
          text(zustand[1])),
        beschr && beschr.text ? h('span.meta', null, text(beschr.text)) : null),
      h('div.wsv__aktionen', null,
        d.builtin === true && !versionen.length ? null : h('button.btn.btn--ghost.btn--small', {
          type: 'button',
          disabled: self.busy.has(busyKey),
          onClick: () => rueckgaengig(self, record),
        }, text('Rückgängig')),
        schalter)));
  }
}

async function umschalten(self, record, an) {
  const d = datenVon(record);
  if (an) {
    const beschr = (self.liste.descriptions || {})[record.id];
    const ok = await self.ctx.confirm({
      title: `„${d.name || record.id}“ einschalten?`,
      message: `${(beschr && beschr.text) || 'Verlangt keine besonderen Rechte.'} Ausschalten geht jederzeit.`,
      confirmLabel: 'Einschalten',
    });
    if (!ok || !self.alive) return;
  }
  self.busy.add(record.id);
  zeichneListe(self);
  try {
    if (an) {
      const r = await self.api.post(`/modules/${encodeURIComponent(record.id)}/enable`, { capabilities: d.capabilities || [] }, { timeoutMs: 30000 });
      if (r && !r.enabled) {
        const fehler = r.record ? datenVon(r.record).lastError : null;
        self.ctx.toast(`Lief nicht an${fehler ? `: ${fehler}` : '.'}`, 'error');
      }
    } else {
      await self.api.post(`/modules/${encodeURIComponent(record.id)}/disable`, {});
    }
  } catch (err) {
    if (self.alive) self.ctx.toast(meldung(err), 'error');
  }
  self.busy.delete(record.id);
  await laden(self);
  if (self.alive) zeichneListe(self);
}

async function rueckgaengig(self, record) {
  const d = datenVon(record);
  const versionen = (Array.isArray(d.versions) ? d.versions : []).map((v) => Number(v && v.version)).filter(Number.isInteger);
  const name = d.name || record.id;
  if (versionen.length) {
    const vorige = Math.max(...versionen);
    const ok = await self.ctx.confirm({
      title: `„${name}“ auf die vorige Fassung zurücksetzen?`,
      message: `Fassung ${vorige} wird wiederhergestellt. Die jetzige bleibt im Verlauf; auch das lässt sich also wieder zurücknehmen.`,
      confirmLabel: 'Zurücksetzen',
    });
    if (!ok || !self.alive) return;
    self.busy.add(record.id);
    zeichneListe(self);
    try {
      await self.api.post(`/modules/${encodeURIComponent(record.id)}/rollback`, { version: vorige });
      if (self.alive) self.ctx.toast(`„${name}“ ist zurückgesetzt. Einschalten, damit die alte Fassung läuft.`, 'success');
    } catch (err) {
      if (self.alive) self.ctx.toast(meldung(err), 'error');
    }
  } else {
    const ok = await self.ctx.confirm({
      title: `„${name}“ entfernen?`,
      message: 'Es gibt keine frühere Fassung; Rückgängig heißt hier: die Erweiterung wieder entfernen. Was sie angelegt hat, bleibt.',
      confirmLabel: 'Entfernen',
      danger: true,
    });
    if (!ok || !self.alive) return;
    self.busy.add(record.id);
    zeichneListe(self);
    try {
      await self.api.del(`/modules/${encodeURIComponent(record.id)}`);
      if (self.alive) self.ctx.toast(`„${name}“ ist entfernt.`, 'success');
    } catch (err) {
      if (self.alive) self.ctx.toast(meldung(err), 'error');
    }
  }
  self.busy.delete(record.id);
  await laden(self);
  if (self.alive) zeichneListe(self);
}

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = CSS; // hier geschrieben, niemals Nutzerdaten
  document.head.appendChild(node);
}

const CSS = `
.wsv { display: flex; flex-direction: column; gap: var(--sp-2); padding-top: var(--sp-3); }
.wsv p { margin: 0; }
.wsv__karte {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-4);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}
.wsv__kopf {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-1) var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
}
.wsv__kopf h2 { margin: 0; font-size: var(--fs-md); font-weight: 600; }
.wsv__innen { display: flex; flex-direction: column; gap: 12px; padding: var(--sp-2) var(--sp-3) var(--sp-3); }
.wsv__code {
  min-height: 260px;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  line-height: 1.6;
  background: var(--surface);
  border-radius: var(--r-3);
  white-space: pre;
  overflow: auto;
  tab-size: 2;
}
.wsv__knoepfe { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); }
.wsv__regel { margin-left: auto; }
.wsv__ergebnis:empty { display: none; }
.wsv__ergebnis { display: flex; flex-direction: column; gap: 8px; transition: opacity var(--dur-2) var(--ease); }
.wsv__ergebnis.is-veraltet { opacity: 0.45; }
.wsv__zeile { display: inline-flex; align-items: center; gap: 8px; color: var(--fg-muted); font-size: var(--fs-sm); }
.wsv__zeile.is-warn { color: var(--warn); }
.wsv__zeile.is-danger { color: var(--danger); }
.wsv__gut, .wsv__schlecht {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--r-3);
}
.wsv__gut { background: var(--accent-soft); }
.wsv__gut > svg { color: var(--accent-text); flex: none; width: 22px; height: 22px; }
.wsv__schlecht { background: var(--danger-soft); }
.wsv__schlecht > svg { color: var(--danger); flex: none; width: 22px; height: 22px; }
.wsv__gut > div, .wsv__schlecht > div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.wsv__schlecht ul { margin: 4px 0 0; padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.wsv__schlecht li { font-family: var(--font-mono); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.wsv__warnungen { margin: 0; padding-left: 1.2em; }
.wsv__liste { display: flex; flex-direction: column; }
.wsv__leer { padding: var(--sp-3); color: var(--fg-subtle); }
.wsv__eintrag {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 14px var(--sp-3);
  border-bottom: 1px solid var(--border);
}
.wsv__eintrag:last-child { border-bottom: 0; }
.wsv__info { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.wsv__name { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.wsv__zustand { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-sm); color: var(--fg-muted); overflow-wrap: anywhere; }
.wsv__zustand .dot:not([class*="dot--"]) { background: var(--fg-subtle); }
.wsv__aktionen { display: flex; align-items: center; gap: var(--sp-1); flex: none; }
.wsv__schalter {
  position: relative;
  width: 52px;
  height: 30px;
  padding: 0;
  border-radius: var(--r-full);
  border: 1px solid var(--border-strong);
  background: var(--surface-4);
  cursor: pointer;
  transition: background var(--dur-2) var(--ease), border-color var(--dur-2) var(--ease);
}
.wsv__schalter:disabled { opacity: 0.5; cursor: progress; }
.wsv__schalter.is-an { background: var(--accent); border-color: var(--accent); }
.wsv__knauf {
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
.wsv__schalter.is-an .wsv__knauf { transform: translateX(22px); }
.wsv__schalter:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
@media (pointer: coarse) {
  .wsv__schalter { width: 72px; height: var(--tap-min); }
  .wsv__knauf { top: 4px; left: 4px; width: 34px; height: 34px; }
  .wsv__schalter.is-an .wsv__knauf { transform: translateX(28px); }
}
@media (max-width: 640px) {
  .wsv__regel { margin-left: 0; }
  .wsv__eintrag { flex-wrap: wrap; }
}
`;
