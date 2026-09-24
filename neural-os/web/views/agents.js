/**
 * views/agents.js -- "Agenten": die Hintergrundaktivitaet, wie bei Claude.
 *
 * Wer arbeitet gerade, seit wann, was ist schon erledigt -- und was ist
 * dabei entstanden. Die Entscheidungen, die diese Ansicht formen:
 *
 * - **Agenten legt man nicht an.** Der Nutzer will das nicht selbst machen
 *   ("nichts einrichten"): die Agenten springen an, wenn er im Chat etwas
 *   sagt (Vertrag 7). Deshalb gibt es hier kein "Neuer Agent", keine
 *   Berechtigungsformulare, keinen Systemtext -- nur, was geschah.
 * - **Nach Chat gruppiert.** Ein Agent arbeitet immer fuer ein Gespraech;
 *   die Frage "was hat die KI aus meinem Satz gemacht?" wird so mit einem
 *   Blick beantwortet, und "Zum Chat" fuehrt an die Stelle.
 * - **Jeder Lauf zeigt, was er hinterliess**, mit einem Sprung dorthin
 *   (Termin, Notiz, Projekt, Gemerktes). Was zurueckgenommen wurde, steht so
 *   da -- ein Link auf etwas, das es nicht mehr gibt, waere eine Luege.
 * - **Live.** Jeder Lauf ist ein Satz (Satzart `run`); jede Aenderung kommt
 *   als `record.*` ueber den Bus. Dauern laufender Agenten zaehlen sichtbar
 *   mit. Ein Lauf, der seit einer Viertelstunde "laeuft", heisst
 *   "unterbrochen" (web/lib/agenten.js).
 * - **Freigaben bleiben erreichbar.** Die alte Agenten-Laufzeit (Zeitplaene)
 *   kann noch um Erlaubnis bitten; die Schale verweist dafuer hierher.
 */

import { h, text, clear, on, icon, cx, timeAgo } from '../lib/dom.js';
import { api as defaultApi } from '../lib/api.js';
import { rolle, zustandVon, dauerText, zielVon, ARTEN, uhrzeit } from '../lib/agenten.js';

const STYLE_ID = 'nos-agents-view';
const SEITE = 120;

let eingehaengt = null;

function mount(container, ctx) {
  ensureStyle();
  eingehaengt = baue(container, ctx);
  return eingehaengt.start();
}

function unmount() {
  if (eingehaengt) eingehaengt.weg();
  eingehaengt = null;
}

const ZUSTAND_TEXT = {
  laeuft: 'Aktiv',
  fertig: 'Fertig',
  fehler: 'Fehler',
  unterbrochen: 'Unterbrochen',
  zurueck: 'Zurückgenommen',
};

function baue(container, ctx) {
  const api = ctx.api || defaultApi;
  const I = ctx.icons || {};
  const offs = [];
  let lebt = true;
  /** runId -> Lauf-Satz */
  const laeufe = new Map();
  /** chatId -> Titel */
  const chats = new Map();
  let freigaben = [];
  let gesamt = 0;
  let offset = 0;
  let fehler = null;
  let geladen = false;
  /** runId -> aufgeklappt */
  const offen = new Set();
  /** Titel angelegter Saetze, einmal geholt. */
  const titel = new Map();
  const wunsch = ctx.route && ctx.route.params ? ctx.route.params.id || null : null;
  if (wunsch) offen.add(wunsch);

  clear(container);
  const root = h('div.agv');
  container.appendChild(root);

  /* ------------------------------------------------------ Daten */

  async function laden(mehr = false) {
    try {
      const [runs, chatListe, appr] = await Promise.all([
        api.get('/runs', { query: { limit: SEITE, offset: mehr ? offset : 0, sort: 'createdAt', order: 'desc' } }),
        mehr ? Promise.resolve(null) : api.get('/chats', { query: { limit: 300, sort: 'updatedAt', order: 'desc' } }).catch(() => null),
        mehr ? Promise.resolve(null) : api.get('/approvals').catch(() => null),
      ]);
      if (!lebt) return;
      const items = Array.isArray(runs && runs.items) ? runs.items : [];
      for (const r of items) laeufe.set(r.id, r);
      gesamt = Number(runs && runs.total) || laeufe.size;
      offset = (mehr ? offset : 0) + items.length;
      if (chatListe && Array.isArray(chatListe.items)) {
        for (const c of chatListe.items) chats.set(c.id, (c.data && c.data.title) || 'Chat');
      }
      if (appr) {
        const liste = Array.isArray(appr) ? appr : (Array.isArray(appr.items) ? appr.items : []);
        freigaben = liste.filter((a) => a && (!(a.data && a.data.status) || a.data.status === 'pending'));
      }
      fehler = null;
    } catch (err) {
      if (!lebt) return;
      fehler = (err && err.message) || 'unbekannter Fehler';
    }
    geladen = true;
    zeichne();
    if (wunsch && laeufe.has(wunsch)) {
      setTimeout(() => {
        const el = root.querySelector(`[data-run="${CSS.escape(wunsch)}"]`);
        if (el) el.scrollIntoView({ block: 'center' });
      }, 60);
    }
  }

  async function titelHolen(ids) {
    const fehlt = ids.filter((id) => !titel.has(id));
    if (!fehlt.length) return;
    for (const id of fehlt) titel.set(id, null);
    await Promise.all(fehlt.map(async (id) => {
      try {
        const r = await api.get(`/records/${encodeURIComponent(id)}`, { query: { includeDeleted: 1 } });
        const d = (r && r.record && r.record.data) || {};
        titel.set(id, {
          titel: String(d.title || d.name || d.text || '').slice(0, 120),
          geloescht: !!(r && r.record && r.record.deletedAt),
          projectId: d.projectId || null,
        });
      } catch {
        titel.set(id, { titel: '', geloescht: true, fehlt: true });
      }
    }));
    if (lebt) zeichne();
  }

  /* --------------------------------------------------- Zeichnen */

  function sicht(r, jetzt) {
    const d = r.data || {};
    if (d.zurueckgenommenAm) return 'zurueck';
    return zustandVon({ status: d.status, rolle: d.rolle, startedAt: d.startedAt || r.createdAt }, jetzt);
  }

  function dauer(r, jetzt) {
    const d = r.data || {};
    const beginn = Date.parse(d.startedAt || r.createdAt);
    if (d.status === 'running' && Number.isFinite(beginn)) return jetzt - beginn;
    if (Number.isFinite(d.dauerMs) && d.dauerMs > 0) return d.dauerMs;
    const ende = Date.parse(d.finishedAt || '');
    return Number.isFinite(beginn) && Number.isFinite(ende) ? ende - beginn : null;
  }

  function zeichne() {
    if (!lebt) return;
    // Neu gebaut wird alles; die Leseposition bleibt, wo sie war -- sonst
    // spraenge die Ansicht bei jedem Schritt eines Agenten nach oben.
    const rolle0 = container.scrollTop;
    const hoehe0 = root.offsetHeight;
    root.style.minHeight = `${hoehe0}px`;
    try {
      zeichneInnen();
    } finally {
      root.style.minHeight = '';
      container.scrollTop = rolle0;
    }
  }

  function zeichneInnen() {
    const jetzt = Date.now();
    const offenVorher = new Set(offen);
    clear(root);

    const alle = [...laeufe.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const aktiv = alle.filter((r) => sicht(r, jetzt) === 'laeuft');
    const heute = new Date().toDateString();
    const heuteFertig = alle.filter((r) => new Date(r.createdAt).toDateString() === heute && sicht(r, jetzt) === 'fertig').length;
    const fehlerZahl = alle.filter((r) => sicht(r, jetzt) === 'fehler').length;

    root.appendChild(h('header.agv__kopf', null,
      h('p.agv__intro', null, text('Was deine Agenten im Hintergrund tun: wer gerade arbeitet, wie lange, und was dabei entstanden ist. Anlegen musst du keinen – sie springen an, sobald du im Chat etwas sagst.')),
      h('div.agv__zahlen', null,
        h('span.agv__zahl', { class: aktiv.length ? 'is-aktiv' : '' }, aktiv.length ? h('span.dot.dot--accent.dot--live') : null, text(`${aktiv.length} aktiv`)),
        h('span.agv__zahl', null, text(`${heuteFertig} heute erledigt`)),
        fehlerZahl ? h('span.agv__zahl.is-fehler', null, text(`${fehlerZahl} mit Fehler`)) : null)));

    if (freigaben.length) root.appendChild(freigabenAbschnitt());

    if (fehler && !alle.length) {
      root.appendChild(h('div.view-state.view-state--error', { role: 'alert' },
        h('div.view-state__icon', { 'aria-hidden': 'true' }, icon(I.alert)),
        h('h2.view-state__title', null, text('Die Agenten ließen sich nicht laden')),
        h('p.view-state__text', null, text(fehler)),
        h('div.view-state__actions', null, h('button.btn.btn--primary', { type: 'button', onClick: () => laden() }, text('Erneut versuchen')))));
      return;
    }
    if (!geladen) {
      root.appendChild(h('div.view-state', { role: 'status' }, h('div.spinner', { 'aria-hidden': 'true' }), h('p.view-state__text', null, text('Lädt …'))));
      return;
    }

    // Gerade aktiv.
    const abschnittAktiv = h('section.agv__abschnitt', { 'aria-labelledby': 'agv-aktiv' },
      h('h2.agv__titel#agv-aktiv', null, text('Gerade aktiv')));
    if (aktiv.length) {
      abschnittAktiv.appendChild(h('ul.agv__liste', null, aktiv.map((r) => laufZeile(r, jetzt, offenVorher))));
    } else {
      abschnittAktiv.appendChild(h('p.agv__leer', null, text('Gerade arbeitet niemand. Schreib im Chat, was du vorhast – dann legen sie los.')));
    }
    root.appendChild(abschnittAktiv);

    // Verlauf, nach Chat.
    const rest = alle.filter((r) => sicht(r, jetzt) !== 'laeuft');
    const verlauf = h('section.agv__abschnitt', { 'aria-labelledby': 'agv-verlauf' },
      h('h2.agv__titel#agv-verlauf', null, text('Verlauf')));
    if (!rest.length) {
      verlauf.appendChild(h('p.agv__leer', null, text('Noch nichts erledigt. Sobald ein Agent fertig ist, steht hier, was er getan hat.')));
    } else {
      const gruppen = new Map();
      for (const r of rest) {
        const key = (r.data && r.data.chatId) || '';
        if (!gruppen.has(key)) gruppen.set(key, []);
        gruppen.get(key).push(r);
      }
      for (const [chatId, liste] of gruppen) {
        const name = chatId ? (chats.get(chatId) || 'Chat') : 'Ohne Chat';
        const juengster = liste[0];
        const kopf = h('div.agv__gruppe-kopf', null,
          chatId
            ? h('a.agv__chat', { href: `#/chat?id=${encodeURIComponent(chatId)}` }, icon(I.chat), h('span', null, text(name)))
            : h('span.agv__chat', null, icon(I.agents), h('span', null, text(name))),
          h('span.agv__gruppe-meta', null, text(`${liste.length} ${liste.length === 1 ? 'Lauf' : 'Läufe'} · ${timeAgo(juengster.updatedAt || juengster.createdAt)}`)));
        verlauf.appendChild(h('div.agv__gruppe', null, kopf,
          h('ul.agv__liste', null, liste.map((r) => laufZeile(r, jetzt, offenVorher)))));
      }
    }
    if (offset < gesamt) {
      verlauf.appendChild(h('div.agv__mehr', null, h('button.btn', { type: 'button', onClick: () => laden(true) },
        text(`Ältere laden (${gesamt - offset} weitere)`))));
    }
    root.appendChild(verlauf);
  }

  function laufZeile(r, jetzt, offenVorher) {
    const d = r.data || {};
    const ro = rolle(d.rolle);
    const z = sicht(r, jetzt);
    const ms = dauer(r, jetzt);
    const istOffen = offenVorher.has(r.id);
    const pill = h('span.agv__pill', { class: `is-${z}` },
      z === 'laeuft' ? h('span.dot.dot--accent.dot--live') : icon(z === 'fehler' ? I.alert : (z === 'zurueck' ? I.refresh : (z === 'unterbrochen' ? I.info : I.check))),
      text(ZUSTAND_TEXT[z] || z));
    const sub = [
      d.rolle ? ro.name : (d.agentId && d.agentId !== 'claude' ? 'Agent' : ro.name),
      z === 'laeuft' ? (ms !== null ? `seit ${dauerText(ms)}` : '') : (ms !== null ? dauerText(ms) : ''),
      uhrzeit(r.createdAt),
    ].filter(Boolean).join(' · ');
    const aktuellerSchritt = z === 'laeuft' && Array.isArray(d.steps) && d.steps.length ? d.steps[d.steps.length - 1].text : '';

    const det = h('details.agv__lauf', {
      'data-run': r.id,
      'data-zustand': z,
      open: istOffen,
      onToggle: (e) => {
        if (e.target.open) {
          offen.add(r.id);
          const ids = Array.isArray(d.producedIds) ? d.producedIds : [];
          if (ids.length) titelHolen(ids);
        } else {
          offen.delete(r.id);
        }
      },
    },
    h('summary.agv__summary', null,
      h('span.tile__avatar.agv__avatar', { 'aria-hidden': 'true' }, icon(I[ro.symbol] || I.agents)),
      h('span.agv__main', null,
        h('span.agv__lauftitel', null, text(d.titel || d.goal || ro.name)),
        h('span.agv__sub', null, text(aktuellerSchritt ? `${aktuellerSchritt} · ${sub}` : sub))),
      pill));
    det.appendChild(laufDetails(r, z));
    if (istOffen && Array.isArray(d.producedIds) && d.producedIds.length) titelHolen(d.producedIds);
    return h('li', null, det);
  }

  function laufDetails(r, z) {
    const d = r.data || {};
    const box = h('div.agv__details');
    const ergebnis = d.result || (d.error && d.error.message) || '';
    if (ergebnis) {
      box.appendChild(h('p.agv__ergebnis', { class: z === 'fehler' ? 'is-fehler' : '' },
        h('span.agv__label', null, text(z === 'fehler' ? 'Fehler' : 'Ergebnis')), text(ergebnis)));
    }
    const schritte = Array.isArray(d.steps) ? d.steps : [];
    if (schritte.length) {
      box.appendChild(h('ol.agv__schritte', null, schritte.map((st) => h('li', null,
        h('span.agv__schritt-zeit', null, text(uhrzeitSek(st.at))),
        h('span.agv__schritt-text', null, text(st.text || st.tool || st.type || '…'))))));
    }
    const ids = Array.isArray(d.producedIds) ? d.producedIds : [];
    if (ids.length) {
      const links = h('div.agv__entstanden', null, h('span.agv__label', null, text('Entstanden')));
      for (const id of ids) {
        const art = String(id).split('_')[0];
        const info = titel.get(id);
        const a = ARTEN[art] || { wort: 'Eintrag', symbol: 'info', oeffnen: 'Öffnen' };
        const name = info && info.titel ? info.titel : a.wort;
        const weg = !!(info && info.geloescht) || z === 'zurueck';
        const href = weg ? null : zielVon(id, art, { projectId: info && info.projectId });
        links.appendChild(href
          ? h('a.agv__link', { href }, icon(I[a.symbol] || I.info), h('span', null, text(`${a.wort}: ${name}`)), icon(I.arrow))
          : h('span.agv__link.is-weg', null, icon(I[a.symbol] || I.info), h('span', null, text(`${a.wort}: ${name}`)), h('span.agv__weg', null, text(z === 'zurueck' ? 'zurückgenommen' : 'gelöscht'))));
      }
      box.appendChild(links);
    }
    if (d.zurueckgenommenAm) {
      box.appendChild(h('p.agv__hinweis', null, text(`Zurückgenommen ${timeAgo(d.zurueckgenommenAm)}.`)));
    }
    if (d.chatId) {
      box.appendChild(h('div.agv__aktionen', null,
        h('a.btn.btn--small', { href: `#/chat?id=${encodeURIComponent(d.chatId)}` }, icon(I.chat), h('span', null, text('Zum Chat')))));
    }
    if (!box.childNodes.length) box.appendChild(h('p.agv__leer', null, text('Keine weiteren Angaben.')));
    return box;
  }

  function uhrzeitSek(iso) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    const dt = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
  }

  /* --------------------------------------------------- Freigaben */

  function freigabenAbschnitt() {
    return h('section.agv__abschnitt.agv__freigaben', { 'aria-labelledby': 'agv-freigaben' },
      h('h2.agv__titel#agv-freigaben', null, text('Wartet auf dich')),
      h('ul.agv__liste', null, freigaben.map((a) => {
        const d = a.data || {};
        const knopf = (label, decision, klasse) => h(`button.btn.btn--small${klasse}`, {
          type: 'button',
          onClick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await api.post(`/approvals/${encodeURIComponent(a.id)}`, { decision });
              freigaben = freigaben.filter((x) => x.id !== a.id);
              zeichne();
            } catch (err) {
              ctx.toast(`Nicht entschieden: ${(err && err.message) || 'unbekannter Fehler'}`, 'error');
              e.currentTarget.disabled = false;
            }
          },
        }, text(label));
        return h('li.agv__freigabe', null,
          h('span.agv__main', null,
            h('span.agv__lauftitel', null, text(d.summary || 'Ein Agent bittet um eine Freigabe.')),
            d.tool ? h('span.agv__sub', null, text(`Werkzeug: ${d.tool}`)) : null),
          h('span.agv__freigabe-knoepfe', null, knopf('Ablehnen', 'denied', ''), knopf('Erlauben', 'approved', '.btn--primary')));
      })));
  }

  /* ----------------------------------------------------- Live */

  let bald = null;
  const neuZeichnen = () => {
    if (bald) return;
    bald = setTimeout(() => {
      bald = null;
      zeichne();
    }, 150);
  };

  const istRun = (p) => p && (p.type === 'run' || (p.record && p.record.type === 'run'));
  for (const name of ['record.created', 'record.updated', 'record.deleted']) {
    offs.push(ctx.bus.on(name, (p) => {
      if (!istRun(p)) return;
      const rec = p.record;
      if (!rec || !rec.id) return;
      if (name === 'record.deleted') laeufe.delete(rec.id);
      else {
        if (!laeufe.has(rec.id)) {
          gesamt += 1;
          offset += 1;
        }
        laeufe.set(rec.id, rec);
      }
      neuZeichnen();
    }));
  }
  offs.push(ctx.bus.on('record.created', (p) => {
    if (p && p.record && p.record.type === 'chat') chats.set(p.record.id, (p.record.data && p.record.data.title) || 'Chat');
  }));
  offs.push(ctx.bus.on('record.updated', (p) => {
    if (p && p.record && p.record.type === 'chat') {
      chats.set(p.record.id, (p.record.data && p.record.data.title) || 'Chat');
      neuZeichnen();
    }
  }));
  for (const name of ['approval.requested', 'approval.resolved', 'hello']) {
    offs.push(ctx.bus.on(name, () => laden()));
  }
  // Laufende Dauern zaehlen sichtbar mit -- nur, wenn etwas laeuft.
  const tick = setInterval(() => {
    const jetzt = Date.now();
    if ([...laeufe.values()].some((r) => sicht(r, jetzt) === 'laeuft')) zeichne();
  }, 1000);

  function start() {
    zeichne();
    return laden();
  }

  function weg() {
    lebt = false;
    clearTimeout(bald);
    clearInterval(tick);
    for (const off of offs) {
      try { off(); } catch { /* weiter */ }
    }
  }

  return { start, weg };
}

/* ------------------------------------------------------------------ */

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = STIL;
  document.head.appendChild(node);
}

const STIL = `
.agv { max-width: calc(var(--content-max) + 2 * var(--sp-4)); margin: 0 auto; padding: var(--sp-3) var(--sp-4) var(--sp-6); }
.agv__kopf { margin-bottom: var(--sp-3); }
.agv__intro { margin: 0 0 14px; max-width: 62ch; font-size: var(--fs-md); line-height: var(--lh); color: var(--fg-muted); }
.agv__zahlen { display: flex; flex-wrap: wrap; gap: 8px; }
.agv__zahl { display: inline-flex; align-items: center; gap: 7px; min-height: 28px; padding: 0 12px; font-size: var(--fs-sm); color: var(--fg-muted); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-full); }
.agv__zahl.is-aktiv { color: var(--fg); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.agv__zahl.is-fehler { color: var(--danger); }
.agv__abschnitt { margin-top: var(--sp-3); }
.agv__titel { margin: 0 0 12px; font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--fg-subtle); }
.agv__leer { margin: 0; font-size: var(--fs-sm); color: var(--fg-subtle); }
.agv__liste { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.agv__gruppe { margin-bottom: var(--sp-3); }
.agv__gruppe-kopf { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; margin: 0 0 10px; }
.agv__chat { display: inline-flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--fs-md); font-weight: 500; color: var(--fg); text-decoration: none; border-radius: var(--r-1); }
.agv__chat svg { width: 18px; height: 18px; flex: none; color: var(--fg-muted); }
a.agv__chat:hover span { text-decoration: underline; text-decoration-color: var(--border-strong); text-underline-offset: 3px; }
.agv__gruppe-meta { font-size: var(--fs-xs); color: var(--fg-subtle); }
.agv__lauf { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-3); }
.agv__lauf[data-zustand="laeuft"] { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
.agv__summary { display: flex; align-items: center; gap: 14px; min-width: 0; padding: 12px 14px; list-style: none; cursor: pointer; border-radius: var(--r-3); }
.agv__summary::-webkit-details-marker { display: none; }
.agv__summary:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.agv__avatar { width: 38px; height: 38px; }
.agv__main { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
.agv__lauftitel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-base); color: var(--fg); }
.agv__sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm); color: var(--fg-subtle); }
.agv__pill { display: inline-flex; align-items: center; gap: 6px; flex: none; font-size: var(--fs-sm); color: var(--fg-muted); }
.agv__pill svg { width: 15px; height: 15px; color: var(--fg-subtle); }
.agv__pill.is-laeuft { color: var(--fg); }
.agv__pill.is-fehler, .agv__pill.is-fehler svg { color: var(--danger); }
.agv__details { display: flex; flex-direction: column; gap: 12px; padding: 2px 16px 16px 66px; font-size: var(--fs-sm); color: var(--fg-muted); }
.agv__label { display: block; margin-bottom: 3px; font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg-subtle); }
.agv__ergebnis { margin: 0; color: var(--fg); overflow-wrap: anywhere; }
.agv__ergebnis.is-fehler { color: var(--danger); }
.agv__schritte { display: flex; flex-direction: column; gap: 5px; margin: 0; padding: 0 0 0 12px; list-style: none; border-left: 2px solid var(--border-strong); }
.agv__schritte li { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 10px; }
.agv__schritt-zeit { font-variant-numeric: tabular-nums; color: var(--fg-subtle); }
.agv__schritt-text { overflow-wrap: anywhere; }
.agv__entstanden { display: flex; flex-direction: column; gap: 6px; }
.agv__link { display: inline-flex; align-items: center; gap: 8px; width: fit-content; max-width: 100%; color: var(--accent-text); text-decoration: none; }
.agv__link svg { width: 15px; height: 15px; flex: none; }
.agv__link span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
a.agv__link:hover span { text-decoration: underline; text-underline-offset: 2px; }
.agv__link.is-weg { color: var(--fg-subtle); }
.agv__weg { font-size: var(--fs-xs); font-style: italic; }
.agv__hinweis { margin: 0; color: var(--fg-subtle); }
.agv__aktionen { display: flex; gap: 8px; }
.agv__mehr { display: flex; justify-content: center; margin-top: var(--sp-2); }
.agv__freigabe { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 14px; background: var(--surface-2); border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--border)); border-radius: var(--r-3); }
.agv__freigabe-knoepfe { display: flex; gap: 8px; margin-left: auto; }
@media (max-width: 760px) {
  .agv { padding: var(--sp-2) var(--sp-2) var(--sp-4); }
  .agv__details { padding-left: 16px; }
}
@media (pointer: coarse) {
  .agv__summary, .agv__link, .agv__chat { min-height: var(--tap-min); }
}
`;

export default { mount, unmount };
