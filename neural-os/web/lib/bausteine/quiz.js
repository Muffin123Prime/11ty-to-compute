/**
 * bausteine/quiz.js -- Wissen pruefen, mit Erklaerung.
 *
 * A/B/C/D antippen (oder die Taste), sofort ✓ Richtig / ✗ Falsch und die
 * Erklaerung; bei mehreren richtigen Antworten Kaestchen und [Prüfen]. Am
 * Ende die Punkte, [Nochmal] und je falscher Frage [Frage erklären], das
 * die Frage mit der eigenen Antwort an die KI schickt.
 *
 * `richtig` zaehlt ab 0 (erste Option = 0) oder nennt den Text der Option.
 * Schreibt ein Modell 1-basiert (erkennbar daran, dass die hoechste Zahl
 * genau die Anzahl der Optionen ist und keine 0 vorkommt), wird das
 * zurechtgerueckt statt die Frage zu verwerfen.
 */

import { h, text, cx } from '../dom.js';
import { str, strPflicht, bool, liste, objekt, fehler, LAENGE, sym, knopf, inline, ensureStyle, balken } from './gemeinsam.js';

const STYLE_ID = 'nos-bs-quiz';
const BUCHSTABEN = ['A', 'B', 'C', 'D', 'E', 'F'];

/** `richtig` in eine sortierte Liste von Indizes (ab 0) uebersetzen. */
export function richtigLesen(roh, optionen) {
  const werte = (Array.isArray(roh) ? roh : [roh]).filter((x) => x !== null && x !== undefined);
  if (!werte.length) throw fehler('„richtig“ fehlt.');
  const n = optionen.length;
  const zahlen = [];
  for (const w of werte) {
    if (typeof w === 'number' && Number.isInteger(w)) zahlen.push(w);
    else if (typeof w === 'string' && /^\d+$/.test(w.trim())) zahlen.push(Number(w.trim()));
    else if (typeof w === 'string') {
      const i = optionen.findIndex((o) => o.trim().toLowerCase() === w.trim().toLowerCase());
      if (i === -1) throw fehler(`„richtig“ nennt eine Option, die es nicht gibt: „${w.slice(0, 40)}“.`);
      zahlen.push(i);
    } else throw fehler('„richtig“ muss eine Zahl, ein Text oder eine Liste davon sein.');
  }
  let idx = zahlen;
  if (zahlen.every((z) => z >= 1 && z <= n) && zahlen.includes(n)) idx = zahlen.map((z) => z - 1);
  if (idx.some((z) => z < 0 || z >= n)) throw fehler('„richtig“ zeigt auf eine Option, die es nicht gibt (gezählt ab 0).');
  return [...new Set(idx)].sort((a, b) => a - b);
}

function pruefen(roh) {
  const out = {
    fragen: liste(roh.fragen, 'fragen', {
      min: 1,
      max: 20,
      je: (x, i) => {
        const o = objekt(x);
        if (!o) return null;
        const frage = strPflicht(o.frage, `fragen[${i}].frage`, 400);
        const optionen = liste(o.optionen, `fragen[${i}].optionen`, { min: 2, max: 6, je: (t) => str(t, 200) || null });
        const f = { frage, optionen, richtig: richtigLesen(o.richtig, optionen) };
        const e = str(o.erklaerung, 1000);
        if (e) f.erklaerung = e;
        return f;
      },
    }),
    einzeln: bool(roh.einzeln, true),
  };
  const titel = str(roh.titel, LAENGE.titel);
  if (titel) out.titel = titel;
  return out;
}

/** Stimmt die gegebene Antwort (Indizes) genau mit der richtigen ueberein? */
export function antwortRichtig(frage, gewaehlt) {
  const g = [...new Set((gewaehlt || []).filter(Number.isInteger))].sort((a, b) => a - b);
  return g.length === frage.richtig.length && g.every((x, i) => x === frage.richtig[i]);
}

/**
 * Die Wertung.
 * @returns {{richtig:number, beantwortet:number, gesamt:number, je:Array<boolean|null>}}
 */
export function quizWerten(spec, antworten) {
  const je = spec.fragen.map((f, i) => {
    const a = antworten && antworten[i];
    return Array.isArray(a) ? antwortRichtig(f, a) : null;
  });
  return {
    richtig: je.filter((x) => x === true).length,
    beantwortet: je.filter((x) => x !== null).length,
    gesamt: spec.fragen.length,
    je,
  };
}

function erklaerenText(spec, i, gewaehlt) {
  const f = spec.fragen[i];
  const meine = (gewaehlt || []).map((x) => f.optionen[x]).filter(Boolean).join(', ') || 'nichts';
  const richtig = f.richtig.map((x) => f.optionen[x]).join(', ');
  return `Erkläre mir bitte Frage ${i + 1}${spec.titel ? ` aus „${spec.titel}“` : ''}: „${f.frage}“ – ich hatte „${meine}“ gewählt, richtig ist „${richtig}“.`;
}

function render(spec, b) {
  ensureStyle(STYLE_ID, CSS);
  const z = b.zustand.lesen();
  const a = b.ansicht;
  const antworten = z.antworten && typeof z.antworten === 'object' ? z.antworten : {};
  const n = spec.fragen.length;
  const wertung = quizWerten(spec, antworten);
  const aktuell = Number.isInteger(z.aktuell) && z.aktuell >= 0 && z.aktuell <= n ? z.aktuell : 0;
  const auswertung = spec.einzeln ? aktuell >= n : wertung.beantwortet === n;
  if (!a.wahl) a.wahl = {};

  const beantworten = (i, gewaehlt) => {
    b.zustand.setzen({ antworten: { ...antworten, [i]: [...gewaehlt].sort((x, y) => x - y) } }, { was: 'Antwort' });
  };

  const frageKnoten = (i) => {
    const f = spec.fragen[i];
    const gegeben = Array.isArray(antworten[i]) ? antworten[i] : null;
    const mehrere = f.richtig.length > 1;
    const vorlaeufig = new Set(a.wahl[i] || []);
    const box = h('div.bs-quiz__frage', {
      role: 'group',
      'aria-label': `Frage ${i + 1}`,
      onKeydown: (e) => {
        if (gegeben || e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.target.closest && e.target.closest('input, textarea, select')) return;
        const k = e.key.toUpperCase();
        let idx = BUCHSTABEN.indexOf(k);
        if (idx === -1 && /^[1-6]$/.test(k)) idx = Number(k) - 1;
        if (idx >= 0 && idx < f.optionen.length) {
          e.preventDefault();
          e.stopPropagation();
          waehlen(idx);
        }
      },
    });
    function waehlen(idx) {
      if (gegeben) return;
      if (!mehrere) {
        beantworten(i, [idx]);
        return;
      }
      if (vorlaeufig.has(idx)) vorlaeufig.delete(idx);
      else vorlaeufig.add(idx);
      a.wahl[i] = [...vorlaeufig];
      b.neuZeichnen();
    }
    box.appendChild(h('p.bs-quiz__text', null,
      !spec.einzeln ? h('span.bs-quiz__nr', null, text(`${i + 1}.`)) : null, inline(f.frage)));
    if (mehrere && !gegeben) box.appendChild(h('p.bs-leise.bs-quiz__hinweis', null, text(`${f.richtig.length} Antworten sind richtig.`)));
    const liste = h('div.bs-quiz__optionen', { role: mehrere ? 'group' : 'radiogroup', 'aria-label': 'Antworten' });
    f.optionen.forEach((o, k) => {
      const istRichtig = f.richtig.includes(k);
      const gewaehlt = gegeben ? gegeben.includes(k) : vorlaeufig.has(k);
      let zustand = '';
      if (gegeben) {
        if (istRichtig) zustand = 'is-richtig';
        else if (gewaehlt) zustand = 'is-falsch';
        else zustand = 'is-aus';
      }
      liste.appendChild(h('button', {
        type: 'button',
        class: cx('bs-quiz__option', zustand, { 'is-gewaehlt': gewaehlt }),
        role: mehrere ? 'checkbox' : 'radio',
        'aria-checked': String(gewaehlt),
        'aria-disabled': gegeben ? 'true' : null,
        'data-key': b.key(`q:${i}:${k}`),
        onClick: (e) => { e.stopPropagation(); waehlen(k); },
      },
      h('span.bs-quiz__buchstabe', { 'aria-hidden': 'true' },
        gegeben && istRichtig ? sym('haken') : (gegeben && gewaehlt ? sym('kreuz') : text(BUCHSTABEN[k]))),
      h('span.bs-quiz__option-text', null, inline(o, { ohneLinks: true })),
      gegeben && gewaehlt ? h('span.bs-nur-leser', null, text(istRichtig ? ' (deine Antwort, richtig)' : ' (deine Antwort, falsch)')) : null,
      gegeben && istRichtig && !gewaehlt ? h('span.bs-nur-leser', null, text(' (richtig)')) : null));
    });
    box.appendChild(liste);
    if (mehrere && !gegeben) {
      box.appendChild(h('div.bs-fuss', null, h('div.bs-fuss__rechts', null,
        knopf('Prüfen', { art: 'haupt', disabled: !vorlaeufig.size, key: b.key(`pruefen:${i}`), onClick: () => beantworten(i, vorlaeufig) }))));
    }
    if (gegeben) {
      const ok = antwortRichtig(f, gegeben);
      box.appendChild(h('div.bs-quiz__ergebnis', { class: ok ? 'is-richtig' : 'is-falsch', role: 'status' },
        h('p.bs-quiz__urteil', null, sym(ok ? 'haken' : 'kreuz'), text(ok ? 'Richtig' : 'Falsch')),
        f.erklaerung ? h('div.bs-quiz__erklaerung', null, inline(f.erklaerung)) : null));
    }
    return box;
  };

  const box = h('div.bs-quiz');
  const kopfMeta = auswertung ? `${wertung.richtig} von ${n} richtig` : (spec.einzeln ? `Frage ${Math.min(aktuell, n - 1) + 1} von ${n}` : `${wertung.beantwortet} von ${n} beantwortet`);
  box.appendChild(h('div.bs-kopf', null, h('p.bs-titel', null, spec.titel ? inline(spec.titel) : text('Quiz')), h('span.bs-meta', null, text(kopfMeta))));

  if (spec.einzeln && !auswertung) {
    box.appendChild(balken(aktuell / n, `Frage ${aktuell + 1} von ${n}`));
    box.appendChild(frageKnoten(aktuell));
    const gegeben = Array.isArray(antworten[aktuell]);
    if (gegeben) {
      box.appendChild(h('div.bs-fuss', null, h('div.bs-fuss__rechts', null,
        knopf(aktuell < n - 1 ? 'Nächste Frage' : 'Auswertung', {
          art: 'haupt',
          key: b.key('weiter'),
          onClick: () => b.zustand.setzen({ aktuell: aktuell + 1 }, { verlauf: false }),
        }))));
    }
  } else if (!spec.einzeln) {
    spec.fragen.forEach((_, i) => box.appendChild(frageKnoten(i)));
  }

  if (auswertung) {
    const anteil = n ? wertung.richtig / n : 0;
    const satz = anteil === 1 ? 'Alles richtig.' : anteil >= 0.7 ? 'Gut gemacht.' : anteil >= 0.4 ? 'Schon einiges sitzt.' : 'Da lohnt sich eine zweite Runde.';
    const ausw = h('div.bs-quiz__auswertung', null,
      h('div.bs-quiz__punkte', null,
        h('span.bs-quiz__zahl', null, text(`${wertung.richtig}/${n}`)),
        h('span.bs-quiz__satz', null, text(satz))),
      balken(anteil, `${wertung.richtig} von ${n} richtig`));
    if (spec.einzeln) {
      const falsch = spec.fragen.map((f, i) => ({ f, i })).filter(({ i }) => wertung.je[i] === false);
      if (falsch.length) {
        ausw.appendChild(h('ul.bs-quiz__falsch', { 'aria-label': 'Falsch beantwortet' }, falsch.map(({ f, i }) => h('li', null,
          h('span.bs-quiz__falsch-text', null, sym('kreuz'), h('span', null, inline(f.frage, { ohneLinks: true }))),
          b.kannSenden ? knopf('Frage erklären', { art: 'leise', key: b.key(`erkl:${i}`), onClick: () => sendeErklaerung(i) }) : null))));
      }
    } else if (b.kannSenden) {
      const erste = wertung.je.findIndex((x) => x === false);
      if (erste >= 0) ausw.appendChild(h('div.bs-fuss', null, knopf('Falsche Fragen erklären', { art: 'leise', key: b.key('erkl-alle'), onClick: () => sendeErklaerung(erste, true) })));
    }
    ausw.appendChild(h('div.bs-fuss', null, h('div.bs-fuss__rechts', null,
      knopf('Nochmal', {
        symbol: 'nochmal',
        key: b.key('nochmal'),
        onClick: () => {
          a.wahl = {};
          b.zustand.setzen({ antworten: {}, aktuell: 0 }, { was: 'Quiz neu' });
        },
      }))));
    box.appendChild(ausw);
  }
  if (a.fehler) box.appendChild(h('p.bs-fehler', { role: 'alert' }, text(a.fehler)));

  async function sendeErklaerung(i, alle = false) {
    a.fehler = null;
    try {
      if (alle) {
        const texte = wertung.je.map((x, k) => (x === false ? erklaerenText(spec, k, antworten[k]) : null)).filter(Boolean);
        await b.senden(texte.join('\n'), { anzeigen: 'Erkläre mir bitte die Fragen, die ich falsch hatte.' });
      } else {
        await b.senden(erklaerenText(spec, i, antworten[i]), { anzeigen: `Erkläre mir bitte Frage ${i + 1}.` });
      }
    } catch (err) {
      a.fehler = (err && err.message) || 'Das ließ sich nicht senden.';
      b.neuZeichnen();
    }
  }
  return box;
}

export const typen = {
  quiz: {
    pruefen,
    render,
    text: (s) => [s.titel || 'Quiz', ...s.fragen.map((f, i) => `${i + 1}. ${f.frage}\n${f.optionen.map((o, k) => `   ${BUCHSTABEN[k]}) ${o}`).join('\n')}`)].join('\n\n'),
  },
};

const CSS = `
.bs-quiz > .bs-balken { margin: -4px 0 14px; }
.bs-quiz__frage + .bs-quiz__frage { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
.bs-quiz__text { margin: 0 0 12px; font-size: var(--fs-md); font-weight: 500; line-height: 1.45; }
.bs-quiz__nr { margin-right: 6px; color: var(--fg-subtle); font-variant-numeric: tabular-nums; }
.bs-quiz__hinweis { margin: -6px 0 10px; }
.bs-quiz__optionen { display: flex; flex-direction: column; gap: 8px; }
.bs-quiz__option { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 46px; padding: 8px 14px 8px 8px; font: inherit; font-size: var(--fs-md); text-align: left; color: var(--fg); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-2); cursor: pointer; transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease), opacity var(--dur-2) var(--ease); -webkit-tap-highlight-color: transparent; }
.bs-quiz__option:hover:not([aria-disabled="true"]) { background: var(--surface-3); border-color: var(--border-strong); }
.bs-quiz__option:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.bs-quiz__option[aria-disabled="true"] { cursor: default; }
.bs-quiz__buchstabe { display: inline-grid; place-items: center; flex: none; width: 28px; height: 28px; font-size: var(--fs-sm); font-weight: 600; color: var(--fg-muted); background: var(--surface-3); border-radius: 8px; transition: background var(--dur-2) var(--ease), color var(--dur-2) var(--ease); }
.bs-quiz__buchstabe svg { width: 15px; height: 15px; stroke-width: 2.2; }
.bs-quiz__option-text { flex: 1 1 auto; min-width: 0; line-height: 1.4; overflow-wrap: anywhere; }
.bs-quiz__option.is-gewaehlt:not(.is-richtig):not(.is-falsch) { border-color: var(--accent); background: var(--accent-soft); }
.bs-quiz__option.is-gewaehlt:not(.is-richtig):not(.is-falsch) .bs-quiz__buchstabe { color: var(--accent-fg); background: var(--accent); }
.bs-quiz__option.is-richtig { border-color: color-mix(in srgb, var(--ok) 60%, transparent); background: color-mix(in srgb, var(--ok) 10%, transparent); }
.bs-quiz__option.is-richtig .bs-quiz__buchstabe { color: var(--surface); background: var(--ok); }
.bs-quiz__option.is-falsch { border-color: color-mix(in srgb, var(--danger) 60%, transparent); background: var(--danger-soft); }
.bs-quiz__option.is-falsch .bs-quiz__buchstabe { color: var(--surface); background: var(--danger); }
.bs-quiz__option.is-aus { opacity: 0.55; }
.bs-quiz__ergebnis { margin-top: 12px; padding: 12px 14px; border-radius: var(--r-2); background: var(--surface-2); border: 1px solid var(--border); animation: bs-ein var(--dur-3) var(--ease); }
.bs-quiz__urteil { display: flex; align-items: center; gap: 6px; margin: 0; font-size: var(--fs-base); font-weight: 600; }
.bs-quiz__urteil svg { width: 16px; height: 16px; stroke-width: 2.2; }
.bs-quiz__ergebnis.is-richtig .bs-quiz__urteil { color: var(--ok); }
.bs-quiz__ergebnis.is-falsch .bs-quiz__urteil { color: var(--danger); }
.bs-quiz__erklaerung { margin-top: 6px; font-size: var(--fs-base); line-height: 1.5; color: var(--fg-muted); }
.bs-quiz__auswertung { padding-top: 2px; }
.bs-quiz__punkte { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; }
.bs-quiz__zahl { font-size: var(--fs-2xl); font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.bs-quiz__satz { font-size: var(--fs-md); color: var(--fg-muted); }
.bs-quiz__falsch { list-style: none; margin: 14px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.bs-quiz__falsch li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 6px 6px 12px; background: var(--surface-2); border-radius: var(--r-2); }
.bs-quiz__falsch-text { display: inline-flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--fs-base); }
.bs-quiz__falsch-text svg { width: 14px; height: 14px; flex: none; color: var(--danger); }
@media (pointer: coarse) { .bs-quiz__option { min-height: 52px; } }
`;
