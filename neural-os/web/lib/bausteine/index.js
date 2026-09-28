/**
 * bausteine/index.js -- interaktive Bausteine in einer KI-Antwort.
 *
 * Die KI schreibt einen Baustein als Codeblock mit der Sprache `ui`, darin
 * genau ein JSON-Objekt mit `typ` (docs/ANTWORT-BAUSTEINE.md, Abschnitt 1):
 *
 *     ```ui
 *     {"typ":"auswahl","frage":"Wie möchtest du die Erklärung?","optionen":["Einfach","Normal","Detailliert"]}
 *     ```
 *
 * Dieses Modul ist die einzige Tuer dafuer:
 *
 * - `parse(text)` liest das JSON (streng, mit einer kleinen, vorsichtigen
 *   Reparatur fuer das, was Modelle gern falsch machen: Kommentare und ein
 *   Komma am Ende) und prueft es ueber das Modul des Typs. Unbekannte Felder
 *   fallen weg, Laengen werden gekappt, falsche Typen ergeben EINEN Satz.
 * - `render(spec, ctx)` baut den Baustein als DOM (nie innerHTML) und
 *   verdrahtet Zustand, Rueckgaengig und Neuzeichnen.
 * - `renderCodeBlock(block, ctx)` ist der Haken fuer den Markdown-Renderer:
 *   offener Block -> ruhiger Platzhalter ("Wird aufgebaut …"), nie rohes
 *   JSON; kaputter Block -> der Code als normaler Codeblock mit dem Hinweis
 *   "Konnte nicht angezeigt werden". Nichts stuerzt ab, nichts verschwindet.
 *
 * Der ctx-Vertrag (baut der Einbauer, z. B. web/views/chat.js):
 *   { senden(text, {anzeigen?}) -> Promise,
 *     zustand: {lesen(), schreiben(obj)}   (oder eine Funktion schluessel -> {lesen, schreiben}),
 *     stilSetzen(stil) -> Promise, api, oeffnen(route), renderMarkdown(text) -> Node,
 *     kiName, chatId, messageId, blockNr, version, laeuft? }
 * Fehlt etwas (kein `senden` ausserhalb des Chats), zeigt der Baustein den
 * Knopf dafuer nicht -- keine Attrappen.
 */

import { h, text } from '../dom.js';
import { renderMarkdown, extractPlain } from '../markdown.js';
import { CSS, ensureStyle, BausteinFehler, schluesselOk, objekt, sym, knopf, inline } from './gemeinsam.js';
import * as Z from './zustand.js';

import { typen as auswahlTypen, auswahlKarte } from './auswahl.js';
import { typen as formularTypen } from './formular.js';
import { typen as reglerTypen } from './regler.js';
import { typen as kartenTypen } from './karten.js';
import { typen as checklisteTypen } from './checkliste.js';
import { typen as schritteTypen } from './schritte.js';
import { typen as abschnitteTypen } from './abschnitte.js';
import { typen as mehrTypen } from './mehr.js';
import { typen as tabsTypen } from './tabs.js';
import { typen as listeTypen } from './liste.js';
import { typen as quizTypen } from './quiz.js';
import { typen as lernkartenTypen } from './lernkarten.js';
import { typen as lueckentextTypen } from './lueckentext.js';
import { typen as zuordnungTypen } from './zuordnung.js';
import { typen as timerTypen } from './timer.js';
import { typen as countdownTypen } from './countdown.js';
import { typen as terminTypen } from './termin.js';
import { typen as dateiTypen } from './datei.js';
import { typen as vorschauTypen } from './vorschau.js';
import { typen as fortschrittTypen } from './fortschritt.js';
// Das Diagramm baut der Renderer (web/lib/diagramm.js, mit web/lib/tabelle.js);
// es meldet sich hier an wie jeder andere Baustein.
import { typen as diagrammTypen } from '../diagramm.js';

export { auswahlKarte };
export {
  rueckgaengig, wiederholen, tasteBehandeln, stapelStand, abonnieren, nachrichtenZustand, letzteNachricht,
  GRENZE_BAUSTEIN, GRENZE_NACHRICHT, passt, groesse,
} from './zustand.js';

const STYLE_ID = 'nos-bausteine';

/** Die Sprache eines Bausteins im Codezaun. */
export const UI_SPRACHE = 'ui';

/** Hoechstens so viele Zeichen JSON je Baustein (Dateien und Vorschauen eingerechnet). */
export const MAX_QUELLE = 240000;

/** Verschachtelung: `inhalt` in tabs/abschnitte/schritte/mehr darf EINE weitere Ebene haben. */
const MAX_TIEFE = 1;

/* ------------------------------------------------------------------ */
/* Registry                                                             */
/* ------------------------------------------------------------------ */

const REGISTRY = new Map();

/**
 * Typen anmelden. `typen` ist `{name: {pruefen(roh) -> spec, render(spec, b) -> Node,
 * text?(spec) -> string, name?: 'Anzeigename', flach?: boolean}}`.
 * Ein spaeter angemeldeter Typ gleichen Namens ersetzt den frueheren.
 */
export function registrieren(typen) {
  for (const [name, def] of Object.entries(typen || {})) {
    if (!def || typeof def.pruefen !== 'function' || typeof def.render !== 'function') continue;
    REGISTRY.set(name, def);
  }
}

for (const t of [auswahlTypen, formularTypen, reglerTypen, kartenTypen, checklisteTypen, schritteTypen, abschnitteTypen,
  mehrTypen, tabsTypen, listeTypen, quizTypen, lernkartenTypen, lueckentextTypen, zuordnungTypen, timerTypen,
  countdownTypen, terminTypen, dateiTypen, vorschauTypen, fortschrittTypen, diagrammTypen]) {
  registrieren(t);
}

/** Welche Typen es gibt (fuer Tests, den Systemtext und die Pruefseite). */
export function typen() {
  return [...REGISTRY.keys()];
}

/* ------------------------------------------------------------------ */
/* Lesen und Pruefen                                                    */
/* ------------------------------------------------------------------ */

/**
 * Die vorsichtige Reparatur: Kommentare (// und /* *\/) und ein Komma vor
 * } oder ] ausserhalb von Zeichenketten entfernen, ein BOM vorn weg. Mehr
 * nicht -- ein Parser, der "ungefaehr JSON" liest, liest irgendwann etwas,
 * das nie gemeint war.
 */
export function jsonReparieren(quelle) {
  const s = String(quelle || '').replace(/^\uFEFF/, '');
  let out = '';
  let i = 0;
  let inString = false;
  while (i < s.length) {
    const c = s[i];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < s.length) {
        out += s[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const ende = s.indexOf('*/', i + 2);
      i = ende === -1 ? s.length : ende + 2;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j += 1;
      if (s[j] === '}' || s[j] === ']') {
        i += 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Den Text eines ```ui-Blocks lesen und pruefen.
 * @param {string} quelle
 * @returns {{ok:true, spec:object} | {ok:false, fehler:string}}
 */
export function parse(quelle) {
  const s = String(quelle ?? '');
  if (!s.trim()) return { ok: false, fehler: 'Der Baustein ist leer.' };
  if (s.length > MAX_QUELLE) return { ok: false, fehler: 'Der Baustein ist zu groß.' };
  let roh;
  try {
    roh = JSON.parse(s);
  } catch (e1) {
    try {
      roh = JSON.parse(jsonReparieren(s));
    } catch {
      return { ok: false, fehler: `Kein gültiges JSON${jsonStelle(e1, s)}.` };
    }
  }
  return pruefen(roh);
}

/**
 * Wo das JSON kaputt ist, auf Deutsch: Die Meldungen der Browser sind
 * englisch und je Browser anders; Zeile und Spalte sind das, was hilft.
 */
function jsonStelle(err, quelle) {
  const m = String((err && err.message) || '');
  let z = /line (\d+) column (\d+)/i.exec(m);
  if (z) return ` (Zeile ${z[1]}, Spalte ${z[2]})`;
  z = /position (\d+)/i.exec(m);
  if (z) {
    const vor = quelle.slice(0, Number(z[1])).split('\n');
    return ` (Zeile ${vor.length}, Spalte ${vor[vor.length - 1].length + 1})`;
  }
  if (/end of (json )?input|unexpected end/i.test(m)) return ' (es endet mittendrin)';
  return '';
}

/**
 * Ein schon gelesenes Objekt pruefen und normalisieren.
 * @returns {{ok:true, spec:object} | {ok:false, fehler:string}}
 */
export function pruefen(roh) {
  const o = objekt(roh);
  if (!o) return { ok: false, fehler: 'Ein Baustein ist ein JSON-Objekt mit dem Feld „typ“.' };
  const typ = typeof o.typ === 'string' ? o.typ.trim().toLowerCase() : '';
  if (!typ) return { ok: false, fehler: 'Das Feld „typ“ fehlt.' };
  const def = REGISTRY.get(typ);
  if (!def) return { ok: false, fehler: `Unbekannter Baustein „${typ.slice(0, 40)}“.` };
  try {
    const felder = def.pruefen(o);
    const id = schluesselOk(o.id);
    return { ok: true, spec: { typ, ...(id ? { id } : {}), ...felder } };
  } catch (err) {
    if (err instanceof BausteinFehler) return { ok: false, fehler: err.message };
    return { ok: false, fehler: 'Der Baustein ließ sich nicht prüfen.' };
  }
}

/** Ist diese Sprache (erstes Wort des Info-Strings) ein Baustein? */
export function istUi(lang) {
  return String(lang || '').trim().toLowerCase().split(/\s+/)[0] === UI_SPRACHE;
}

/* ------------------------------------------------------------------ */
/* Bloecke in einem Markdown-Text finden                                */
/* ------------------------------------------------------------------ */

const ZAUN_AUF = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\n]*)$/;
const ZAUN_ZU = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Einen Markdown-Text in Stuecke teilen: Text und ```ui-Bloecke. Andere
 * Codezaeune bleiben ganz im Text (auch wenn darin "```ui" steht) -- die
 * Regeln sind dieselben wie in web/lib/markdown.js, damit beide dieselben
 * Bloecke sehen.
 *
 * @returns {Array<{art:'text', text:string} | {art:'ui', code:string, closed:boolean, nr:number}>}
 */
export function segmente(markdown) {
  const zeilen = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let puffer = [];
  let nr = 0;
  const textRaus = () => {
    if (puffer.length) out.push({ art: 'text', text: puffer.join('\n') });
    puffer = [];
  };
  for (let i = 0; i < zeilen.length; i += 1) {
    const zeile = zeilen[i];
    const auf = ZAUN_AUF.exec(zeile);
    if (!auf) {
      puffer.push(zeile);
      continue;
    }
    const marke = auf[2];
    const einzug = auf[1].length;
    const ui = istUi(auf[3]);
    const koerper = [];
    let j = i + 1;
    let closed = false;
    for (; j < zeilen.length; j += 1) {
      const zu = ZAUN_ZU.exec(zeilen[j]);
      if (zu && zu[1][0] === marke[0] && zu[1].length >= marke.length) {
        closed = true;
        break;
      }
      koerper.push(zeilen[j]);
    }
    if (ui) {
      textRaus();
      const code = koerper.map((z) => (z.slice(0, einzug).trim() === '' ? z.slice(einzug) : z)).join('\n');
      out.push({ art: 'ui', code, closed, nr });
      nr += 1;
    } else {
      puffer.push(zeile, ...koerper);
      if (closed) puffer.push(zeilen[j]);
    }
    i = closed ? j : zeilen.length;
  }
  textRaus();
  return out;
}

/** Ein Codezaun, der laenger ist als jede Backtick-Folge im Inhalt. */
export function zaun(code, sprache = '') {
  const laengste = Math.max(2, ...(String(code).match(/`+/g) || []).map((s) => s.length));
  const f = '`'.repeat(laengste + 1);
  return `${f}${sprache}\n${code}\n${f}`;
}

/* ------------------------------------------------------------------ */
/* Text-Fassung (Kopieren, Vorlesen, Suche)                             */
/* ------------------------------------------------------------------ */

/** Ein Baustein als lesbarer Klartext. */
export function textFassung(spec) {
  const def = spec && REGISTRY.get(spec.typ);
  if (!def || typeof def.text !== 'function') return '';
  try {
    return String(def.text(spec) || '').trim();
  } catch {
    return '';
  }
}

/**
 * Markdown, in dem jeder gueltige ```ui-Block durch seine Text-Fassung
 * ersetzt ist -- fuer "Kopieren" und "Vorlesen", die sonst rohes JSON
 * mitnaehmen. Ungueltige Bloecke bleiben als Code stehen (so wie sie auch
 * angezeigt werden).
 */
export function markdownOhneUi(markdown) {
  return segmente(markdown).map((s) => {
    if (s.art === 'text') return s.text;
    const erg = parse(s.code);
    return erg.ok ? textFassung(erg.spec) : zaun(s.code, 'json');
  }).join('\n');
}

/** Klartext einer ganzen Antwort mit Bausteinen (Vorlesen). */
export function klartext(markdown) {
  return extractPlain(markdownOhneUi(markdown));
}

/* ------------------------------------------------------------------ */
/* Zeichnen                                                             */
/* ------------------------------------------------------------------ */

const TYP_NAMEN = {
  auswahl: 'Auswahl', aktionen: 'Aktionen', formular: 'Formular', regler: 'Regler', karten: 'Karten',
  diagramm: 'Diagramm', checkliste: 'Checkliste', schritte: 'Schritte', abschnitte: 'Abschnitte', mehr: 'Mehr',
  tabs: 'Reiter', liste: 'Liste', quiz: 'Quiz', lernkarten: 'Lernkarten', lueckentext: 'Lückentext',
  zuordnung: 'Zuordnung', timer: 'Timer', countdown: 'Countdown', termin: 'Termin', datei: 'Datei',
  vorschau: 'Vorschau', fortschritt: 'Fortschritt',
};

/** Ruhiger Platzhalter, solange der Block noch geschrieben wird. */
export function platzhalter() {
  ensureStyle(STYLE_ID, CSS);
  return h('div.bs.bs--wird', { role: 'status', 'aria-live': 'polite', 'aria-busy': 'true', dataset: { baustein: 'wird' } },
    h('span.bs-wird__punkt', { 'aria-hidden': 'true' }), text('Wird aufgebaut …'));
}

function mdKnoten(quelle, ctx, eigenerRenderer = true) {
  if (eigenerRenderer && ctx && typeof ctx.renderMarkdown === 'function') {
    try {
      const n = ctx.renderMarkdown(quelle);
      if (n) return n;
    } catch { /* unten der eigene Weg */ }
  }
  return renderMarkdown(quelle, { kopierKarten: true, hakenKreise: true });
}

/**
 * "Konnte nicht angezeigt werden": der Hinweis mit Grund und darunter der
 * Code als ganz normaler Codeblock (mit Kopieren). Er wird immer mit dem
 * eigenen Renderer gezeichnet, damit ein Haken fuer ```ui-Bloecke sich hier
 * nicht selbst wieder aufruft.
 */
export function fehlerKarte(code, grund) {
  ensureStyle(STYLE_ID, CSS);
  return h('div.bs-kaputt', { dataset: { baustein: 'fehler' } },
    h('p.bs-kaputt__hinweis', null, sym('achtung'),
      h('span', null, text('Konnte nicht angezeigt werden')),
      grund ? h('span.bs-kaputt__grund', null, text(` · ${grund}`)) : null),
    renderMarkdown(zaun(String(code ?? ''), 'json')));
}

/**
 * Der Haken fuer den Markdown-Renderer an der Stelle, an der Codebloecke je
 * Sprache gezeichnet werden (web/lib/markdown.js, renderBlocks, case 'code').
 *
 * @param {{lang:string, code:string, closed?:boolean}} block wie parseBlocks ihn liefert
 * @param {object} ctx der ctx-Vertrag; `laeuft:false` sagt "die Antwort ist fertig" --
 *   dann wird auch ein nie geschlossener Block noch gelesen.
 * @returns {Node|null} null = kein Baustein, normal weiterzeichnen
 */
export function renderCodeBlock(block, ctx = {}) {
  if (!block) return null;
  const lang = String(block.lang || '').trim().toLowerCase();
  const offen = block.closed === false && ctx.laeuft !== false;
  // Waehrend die Zaunzeile selbst noch ankommt ("```u"), schon den
  // Platzhalter: sonst blitzt kurz ein Codeblock "u" auf.
  if (offen && (lang === 'u' || lang === UI_SPRACHE)) return platzhalter();
  if (!istUi(lang)) return null;
  const erg = parse(block.code);
  if (!erg.ok) return fehlerKarte(block.code, erg.fehler);
  return render(erg.spec, ctx, { quelle: block.code });
}

/* Der letzte selbst geschriebene Zustand je vollem Schluessel. Er ueberbrueckt
   die Zeit, bis der Einbauer ihn (nach PUT) wieder liefert -- sonst zeigte
   ein Neuzeichnen direkt nach dem Abhaken kurz den alten Stand. */
const LETZTER = new Map();
/* Ohne ctx.zustand (Pruefseite, andere Ansichten): nur im Speicher. */
const SPEICHER = new Map();

function zustandsQuelle(ctx, schluessel, voll) {
  if (typeof ctx.zustand === 'function') {
    const q = ctx.zustand(schluessel);
    if (q && typeof q.lesen === 'function' && typeof q.schreiben === 'function') return q;
  }
  if (ctx.zustand && typeof ctx.zustand.lesen === 'function' && typeof ctx.zustand.schreiben === 'function') return ctx.zustand;
  return {
    lesen: () => Z.kopie(SPEICHER.get(voll)) || {},
    schreiben: (z) => { SPEICHER.set(voll, Z.kopie(z) || {}); },
  };
}

function jsonText(wert) {
  try {
    return JSON.stringify(wert ?? {});
  } catch {
    return '';
  }
}

/**
 * Einen gepruefte Baustein zeichnen.
 * @param {object} spec  Ergebnis von parse()/pruefen()
 * @param {object} ctx   der ctx-Vertrag
 * @param {{quelle?:string, schluessel?:string, speicher?:{lesen, schreiben}, tiefe?:number}} [opts]
 * @returns {HTMLElement}
 */
export function render(spec, ctx = {}, opts = {}) {
  ensureStyle(STYLE_ID, CSS);
  const def = spec && REGISTRY.get(spec.typ);
  if (!def) return fehlerKarte(opts.quelle || jsonText(spec), 'Unbekannter Baustein.');
  ctx = ctx || {};
  const tiefe = Number.isInteger(opts.tiefe) ? opts.tiefe : 0;
  const nr = Number.isInteger(ctx.blockNr) ? ctx.blockNr : 0;
  const schluessel = opts.schluessel || spec.id || `b${nr}`;
  const nachricht = String(ctx.messageId || '_');
  const voll = [ctx.chatId || '_', nachricht, ctx.version ?? 0, schluessel].join('|');
  const quelle = opts.speicher || zustandsQuelle(ctx, schluessel, voll);
  const aufraeumen = [];
  const name = TYP_NAMEN[spec.typ] || spec.typ;

  const huelle = h('div.bs', {
    class: def.flach ? 'bs--flach' : null,
    role: 'group',
    // Faengt den Fokus auf, wenn das bediente Element beim Neuzeichnen
    // verschwindet ("Nochmal", "Weiter") -- sonst landete er auf <body>, und
    // Strg+Z oder die Pfeiltasten gingen ins Leere.
    tabindex: '-1',
    'aria-label': spec.titel || spec.frage || name,
    dataset: { baustein: spec.typ, schluessel },
  });
  const fehlerZeile = h('p.bs-fehler', { role: 'alert', hidden: true });

  const lesen = () => {
    let q;
    try {
      q = quelle.lesen();
    } catch {
      q = {};
    }
    q = objekt(q) ? q : {};
    const l = LETZTER.get(voll);
    if (l) {
      const jetzt = jsonText(q);
      if (jetzt === l.basis) return Z.kopie(l.wert);
      LETZTER.delete(voll);
    }
    return Z.kopie(q) || {};
  };

  const zeigeFehler = (satz) => {
    fehlerZeile.hidden = !satz;
    fehlerZeile.textContent = satz || '';
    if (satz && !fehlerZeile.isConnected) huelle.appendChild(fehlerZeile);
  };

  const schreiben = (neu) => {
    let basis = '';
    try {
      basis = jsonText(quelle.lesen());
    } catch { /* leer */ }
    quelle.schreiben(Z.kopie(neu) || {});
    LETZTER.delete(voll);
    LETZTER.set(voll, { wert: Z.kopie(neu) || {}, basis });
    if (LETZTER.size > 500) LETZTER.delete(LETZTER.keys().next().value);
  };

  const b = {
    spec,
    typ: spec.typ,
    schluessel,
    voll,
    tiefe,
    /** Der rohe Text des ```ui-Blocks (fuer PATCH …/block als `alt`). */
    quelle: typeof opts.quelle === 'string' ? opts.quelle : null,
    ctx,
    api: ctx.api || null,
    chatId: ctx.chatId || null,
    messageId: ctx.messageId || null,
    blockNr: nr,
    version: ctx.version ?? 0,
    kiName: ctx.kiName || 'KI',
    ansicht: Z.ansichtVon(voll),
    kannSenden: typeof ctx.senden === 'function',
    kannStil: typeof ctx.stilSetzen === 'function',
    kannOeffnen: typeof ctx.oeffnen === 'function',
    /** data-key fuer Bedienelemente: der Chat stellt den Fokus darueber wieder her. */
    key: (teil) => `bs:${voll}:${teil}`,
    zustand: {
      lesen,
      /**
       * Zustand aendern (flach zusammenfuehren). `verlauf:false` fuer
       * Dinge, die kein Rueckgaengig brauchen (Navigation, Gesendetes).
       * @returns {boolean} ob es geklappt hat (sonst steht der Grund im Baustein)
       */
      setzen(patch, { verlauf = true, was = '', zeichnen: neuZeichnen = true } = {}) {
        const vorher = lesen();
        const nachher = { ...vorher, ...patch };
        for (const k of Object.keys(nachher)) if (nachher[k] === undefined) delete nachher[k];
        const pr = Z.passt(nachher);
        if (!pr.ok) {
          zeigeFehler(pr.grund);
          return false;
        }
        try {
          schreiben(nachher);
        } catch (err) {
          zeigeFehler((err && err.message) || 'Das ließ sich nicht speichern.');
          return false;
        }
        zeigeFehler(null);
        if (verlauf) Z.aufzeichnen(nachricht, { schluessel: voll, vorher, nachher, was });
        if (neuZeichnen) b.neuZeichnen();
        return true;
      },
    },
    /** Eine Nachricht an die KI schicken (wirft mit einem lesbaren Satz). */
    async senden(nachrichtText, o) {
      if (typeof ctx.senden !== 'function') throw new Error('Von hier aus lässt sich nichts senden.');
      return ctx.senden(String(nachrichtText), o || {});
    },
    stilSetzen: (stil) => ctx.stilSetzen(stil),
    oeffnen: (route) => ctx.oeffnen(route),
    inline,
    fehler: zeigeFehler,
    /** Aufraeumen vor dem naechsten Neuzeichnen (Intervalle, Beobachter). */
    beiNeubau: (fn) => { if (typeof fn === 'function') aufraeumen.push(fn); },
    huelle: () => huelle,
    neuZeichnen: () => zeichnen(),
    /**
     * Markdown eines `inhalt`-Felds. `ui:true` erlaubt darin ```ui-Bloecke
     * (eine Ebene; nur tabs, abschnitte, schritte, mehr). `teil` trennt
     * mehrere Inhaltsfelder desselben Bausteins (Reiter 1, Reiter 2 …), damit
     * die Bausteine darin verschiedene Schluessel haben.
     */
    markdown(quelleText, { ui = false, teil = 0 } = {}) {
      const box = h('div.bs-md');
      let n = 0;
      for (const seg of segmente(quelleText)) {
        if (seg.art === 'text') {
          if (seg.text.trim()) box.appendChild(mdKnoten(seg.text, ctx));
          continue;
        }
        if (!ui || tiefe >= MAX_TIEFE) {
          box.appendChild(ui ? fehlerKarte(seg.code, 'Zu tief verschachtelt.') : renderMarkdown(zaun(seg.code, 'json')));
          continue;
        }
        if (!seg.closed && ctx.laeuft !== false) {
          box.appendChild(platzhalter());
          continue;
        }
        const erg = parse(seg.code);
        if (!erg.ok) {
          box.appendChild(fehlerKarte(seg.code, erg.fehler));
          continue;
        }
        const kind = `${schluessel}.${erg.spec.id || `${teil}-${n}`}`;
        n += 1;
        box.appendChild(render(erg.spec, ctx, {
          quelle: seg.code,
          schluessel: kind,
          tiefe: tiefe + 1,
          speicher: kindSpeicher(kind),
        }));
      }
      return box;
    },
  };

  // Verschachtelte Bausteine legen ihren Zustand im Zustand der Eltern ab
  // (Feld `_k`). So gilt die 16-KB-Grenze fuer das Ganze, und der Einbauer
  // muss von Kindern nichts wissen.
  function kindSpeicher(kind) {
    return {
      lesen: () => {
        const k = lesen()._k;
        return (objekt(k) && objekt(k[kind])) || {};
      },
      schreiben: (z) => {
        const k = { ...(objekt(lesen()._k) || {}) };
        k[kind] = Z.kopie(z) || {};
        if (!b.zustand.setzen({ _k: k }, { verlauf: false, zeichnen: false })) {
          throw new Error('Das ließ sich nicht speichern.');
        }
      },
    };
  }

  // Rueckgaengig/Wiederholen: ein Schritt des Stapels schreibt den alten
  // Stand zurueck und zeichnet neu.
  Z.anmelden(nachricht, voll, (z) => {
    schreiben(z);
    zeichnen();
  });

  const leiste = h('div.bs-verlauf-platz');
  function leisteZeichnen() {
    const st = Z.stapelStand(nachricht);
    if (st.bei !== voll) {
      leiste.replaceChildren();
      return;
    }
    const mac = typeof navigator !== 'undefined' && /Mac|iPad|iPhone/.test(navigator.platform || '');
    const mod = mac ? '⌘' : 'Strg+';
    leiste.replaceChildren(h('div.bs-verlauf', { role: 'toolbar', 'aria-label': 'Änderungen in dieser Antwort' },
      knopf('', {
        symbol: 'zurueck', titel: `Rückgängig (${mod}Z)`, disabled: !st.kannZurueck, key: b.key('rueck'),
        onClick: () => Z.rueckgaengig(nachricht),
      }),
      knopf('', {
        symbol: 'vor', titel: `Wiederholen (${mod}${mac ? '⇧Z' : 'Umschalt+Z'})`, disabled: !st.kannVor, key: b.key('vor'),
        onClick: () => Z.wiederholen(nachricht),
      })));
  }
  let verpasst = 0;
  const abo = Z.abonnieren(nachricht, () => {
    // Ein Knoten, den der Chat ersetzt hat, meldet sich hier ab.
    if (!huelle.isConnected) {
      verpasst += 1;
      if (verpasst > 2) abo();
      return;
    }
    verpasst = 0;
    leisteZeichnen();
  });

  huelle.addEventListener('keydown', (e) => {
    if (Z.tasteBehandeln(e, nachricht)) e.stopPropagation();
  });

  function zeichnen() {
    for (const fn of aufraeumen.splice(0)) {
      try { fn(); } catch { /* weiter */ }
    }
    const aktiv = typeof document !== 'undefined' ? document.activeElement : null;
    const fokusKey = aktiv && huelle.contains(aktiv) && aktiv.dataset ? aktiv.dataset.key : null;
    let inhalt;
    try {
      inhalt = def.render(spec, b);
    } catch (err) {
      if (typeof console !== 'undefined') console.error('[bausteine]', spec.typ, err);
      huelle.replaceChildren(fehlerKarte(opts.quelle || jsonText(spec), 'Beim Zeichnen ist etwas schiefgegangen.'));
      return;
    }
    leisteZeichnen();
    huelle.replaceChildren(inhalt, fehlerZeile, leiste);
    if (fokusKey) {
      const wieder = huelle.querySelector(`[data-key="${cssEsc(fokusKey)}"]`);
      if (wieder && typeof wieder.focus === 'function' && !wieder.disabled) wieder.focus({ preventScroll: true });
      else if (huelle.isConnected) huelle.focus({ preventScroll: true });
    }
  }

  zeichnen();
  return huelle;
}

function cssEsc(s) {
  const c = globalThis.CSS;
  if (c && typeof c.escape === 'function') return c.escape(s);
  return String(s).replace(/["\\]/g, '\\$&');
}

/** Name eines Typs fuer Menschen ("Lückentext"). */
export function typName(typ) {
  return TYP_NAMEN[typ] || String(typ || '');
}
