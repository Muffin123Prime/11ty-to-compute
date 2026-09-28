/**
 * bausteine/regler.js -- Schieberegler, vor allem fuer den Antwortstil.
 *
 * Mit den Namen `laenge`, `fachlich`, `kreativ` stellt der Baustein den
 * Antwortstil DES CHATS ein (ctx.stilSetzen): Beim Loslassen, kurz
 * entprellt, wird der Stil gespeichert und die letzte Antwort in diesem
 * Stil als neue Fassung erzeugt. Man sieht also sofort, was der Regler
 * bewirkt -- ohne einen "Anwenden"-Knopf, den man vergessen kann.
 *
 * Mit anderen Namen (oder `anwenden: "senden"`) sind es einfach Werte, die
 * mit [Übernehmen] als Nachricht an die KI gehen.
 */

import { h, text } from '../dom.js';
import { str, liste, wahl, objekt, zahl, fehler, LAENGE, knopf, inline, ensureStyle, sym, spinner, reglerFuellen } from './gemeinsam.js';

const STYLE_ID = 'nos-bs-regler';
export const STIL_NAMEN = ['laenge', 'fachlich', 'kreativ'];
const ENTPRELLEN_MS = 450;

function reglerPruefen(roh, i, namen) {
  const x = objekt(roh);
  if (!x) return null;
  const label = str(x.label ?? x.name, 80);
  if (!label) throw fehler(`Regler ${i + 1} braucht ein „label“.`);
  let name = str(x.name, 40).toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  if (!name) name = `regler${i + 1}`;
  if (namen.has(name)) throw fehler(`Der Name „${name}“ kommt zweimal vor.`);
  namen.add(name);
  return {
    name,
    label,
    links: str(x.links, 40) || '0',
    rechts: str(x.rechts, 40) || '100',
    wert: zahl(x.wert, { min: 0, max: 100, ganz: true, standard: 50 }),
  };
}

function pruefen(roh) {
  const namen = new Set();
  const regler = liste(roh.regler, 'regler', { min: 1, max: 6, je: (x, i) => reglerPruefen(x, i, namen) });
  const nurStil = regler.every((r) => STIL_NAMEN.includes(r.name));
  const out = { regler, anwenden: wahl(roh.anwenden, ['stil', 'senden'], nurStil ? 'stil' : 'senden') };
  if (out.anwenden === 'stil' && !nurStil) throw fehler('„anwenden: stil“ geht nur mit den Namen laenge, fachlich und kreativ.');
  const titel = str(roh.titel, LAENGE.titel);
  if (titel) out.titel = titel;
  const k = str(roh.knopf, 40);
  if (k) out.knopf = k;
  return out;
}

/** Der Stil, wie er an ctx.stilSetzen geht: nur die vorhandenen Namen. */
export function stilAus(spec, werte) {
  const out = {};
  for (const r of spec.regler) if (STIL_NAMEN.includes(r.name)) out[r.name] = Math.round(werte[r.name] ?? r.wert);
  return out;
}

/** Die Nachricht im Modus `senden`. */
export function reglerText(spec, werte) {
  const zeilen = [spec.titel ? `**${spec.titel}**` : '**Meine Einstellung**'];
  for (const r of spec.regler) zeilen.push(`${r.label}: ${Math.round(werte[r.name] ?? r.wert)}/100 (${r.links} ↔ ${r.rechts})`);
  return zeilen.join('\n');
}

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  const z = b.zustand.lesen();
  const a = b.ansicht;
  // Ohne ctx.stilSetzen (ausserhalb des Chats) wird aus "stil" ehrlich "senden".
  const modus = spec.anwenden === 'stil' && b.kannStil ? 'stil' : 'senden';
  if (!a.werte) {
    a.werte = {};
    for (const r of spec.regler) a.werte[r.name] = objekt(z.werte) && Number.isFinite(z.werte[r.name]) ? z.werte[r.name] : r.wert;
  }
  const box = h('div.bs-reglerbox');
  if (spec.titel) box.appendChild(h('div.bs-kopf', null, h('p.bs-titel', null, inline(spec.titel))));

  let timer = null;
  const anwenden = async () => {
    const stil = stilAus(spec, a.werte);
    a.status = 'laeuft';
    a.fehler = null;
    b.neuZeichnen();
    try {
      await b.stilSetzen(stil);
      a.status = 'ok';
      b.zustand.setzen({ werte: { ...a.werte } }, { verlauf: false });
    } catch (err) {
      a.status = null;
      a.fehler = (err && err.message) || 'Der Stil ließ sich nicht übernehmen.';
      b.neuZeichnen();
    }
  };
  b.beiNeubau(() => { if (timer) clearTimeout(timer); });

  spec.regler.forEach((r, i) => {
    const id = b.key(`r:${i}`).replace(/[^A-Za-z0-9_-]/g, '_');
    const wert = h('span.bs-meta.bs-reglerbox__wert', null, text(String(Math.round(a.werte[r.name]))));
    const eingabe = h('input.bs-regler', {
      id,
      type: 'range',
      min: 0,
      max: 100,
      step: 1,
      disabled: a.status === 'laeuft' || a.sendet,
      'data-key': b.key(`r:${i}`),
      'aria-valuetext': `${Math.round(a.werte[r.name])} von 100 (${r.links} bis ${r.rechts})`,
      onInput: (e) => {
        const v = Number(e.target.value);
        a.werte[r.name] = v;
        wert.textContent = String(v);
        e.target.setAttribute('aria-valuetext', `${v} von 100 (${r.links} bis ${r.rechts})`);
        reglerFuellen(e.target);
        if (a.status === 'ok') {
          a.status = null;
          const s = b.huelle().querySelector('.bs-reglerbox__status');
          if (s) s.replaceChildren();
        }
      },
      // Uebernommen wird beim Loslassen (change), nicht bei jedem Pixel.
      onChange: () => {
        if (modus !== 'stil') return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(anwenden, ENTPRELLEN_MS);
      },
    });
    eingabe.value = String(Math.round(a.werte[r.name]));
    reglerFuellen(eingabe);
    box.appendChild(h('div.bs-reglerbox__zeile', null,
      h('div.bs-reglerbox__kopf', null, h('label.bs-reglerbox__label', { for: id }, text(r.label)), wert),
      eingabe,
      h('div.bs-reglerbox__enden', { 'aria-hidden': 'true' }, h('span', null, text(r.links)), h('span', null, text(r.rechts)))));
  });

  const fuss = h('div.bs-fuss');
  if (modus === 'stil') {
    const status = h('span.bs-meta.bs-reglerbox__status', { role: 'status', 'aria-live': 'polite' });
    if (a.status === 'laeuft') status.append(spinner(), text(' Wird im neuen Stil geschrieben …'));
    else if (a.status === 'ok') status.append(h('span.bs-ok', null, sym('haken')), text(' Übernommen – neue Fassung darunter.'));
    else status.append(text('Loslassen übernimmt den Stil für diesen Chat.'));
    fuss.appendChild(status);
  } else if (b.kannSenden) {
    fuss.appendChild(h('div.bs-fuss__rechts', null, knopf(spec.knopf || 'Übernehmen', {
      art: 'haupt',
      key: b.key('senden'),
      disabled: !!a.sendet,
      onClick: async () => {
        a.sendet = true;
        a.fehler = null;
        b.neuZeichnen();
        try {
          await b.senden(reglerText(spec, a.werte));
          b.zustand.setzen({ werte: { ...a.werte }, gesendet: true }, { verlauf: false, zeichnen: false });
        } catch (err) {
          a.fehler = (err && err.message) || 'Das ließ sich nicht senden.';
        }
        a.sendet = false;
        b.neuZeichnen();
      },
    })));
    if (z.gesendet && !a.sendet) fuss.prepend(h('span.bs-meta.bs-reglerbox__status', null, h('span.bs-ok', null, sym('haken')), text(' Gesendet')));
  }
  box.appendChild(fuss);
  if (a.fehler) box.appendChild(h('p.bs-fehler', { role: 'alert' }, text(a.fehler)));
  return box;
}

export const typen = {
  regler: {
    pruefen,
    render,
    text: (s) => [s.titel || '', ...s.regler.map((r) => `${r.label}: ${r.wert}/100 (${r.links} ↔ ${r.rechts})`)].filter(Boolean).join('\n'),
  },
};

const CSS = `
.bs-reglerbox__zeile { display: flex; flex-direction: column; gap: 4px; }
.bs-reglerbox__zeile + .bs-reglerbox__zeile { margin-top: 14px; }
.bs-reglerbox__kopf { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.bs-reglerbox__label { font-size: var(--fs-base); font-weight: 500; color: var(--fg); }
.bs-reglerbox__wert { min-width: 3ch; text-align: right; }
.bs-reglerbox__enden { display: flex; justify-content: space-between; gap: 12px; font-size: var(--fs-xs); color: var(--fg-subtle); }
.bs-reglerbox__status { display: inline-flex; align-items: center; gap: 6px; }
.bs-reglerbox__status .spinner { width: 14px; height: 14px; border-width: 2px; }
.bs-reglerbox__status svg { width: 15px; height: 15px; vertical-align: -3px; }
`;
