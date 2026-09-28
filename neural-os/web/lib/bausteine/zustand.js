/**
 * bausteine/zustand.js -- was sich ein Baustein merkt, und wie man es
 * zuruecknimmt.
 *
 * Zwei Arten von Zustand, bewusst getrennt:
 *
 * - **Gespeichert** (`zustand`): das, was die Antwort ausmacht, nachdem der
 *   Nutzer etwas getan hat -- abgehakte Punkte, gegebene Quiz-Antworten, eine
 *   Reihenfolge, die Startzeit eines Timers, die gewaehlte Option. Es geht
 *   ueber `ctx.zustand.schreiben()` an den Einbauer (der Chat legt es mit
 *   PUT /api/chats/:id/messages/:mid/ui ab) und kommt beim naechsten Laden
 *   ueber `ctx.zustand.lesen()` zurueck. Grenzen: 16 KB je Baustein, 64 KB je
 *   Nachricht (docs/ANTWORT-BAUSTEINE.md, Abschnitt 5).
 * - **Ansicht** (`ansicht`): was nur fuer den Moment gilt -- der offene
 *   Reiter, ein halb ausgefuelltes Formular, die umgedrehte Lernkarte. Es
 *   lebt im Speicher dieses Tabs, aber AUSSERHALB des DOM: Der Chat baut eine
 *   Nachricht bei jeder Aenderung ihrer Signatur ganz neu (beim Streaming in
 *   jedem Bild). Was nur im DOM stuende, waere danach weg.
 *
 * Rueckgaengig/Wiederholen gibt es je NACHRICHT, nicht je Baustein: Wer in
 * einer Antwort zwei Punkte abhakt und eine Liste umsortiert, erwartet, dass
 * Strg+Z in genau dieser Reihenfolge zuruecknimmt. Der Stapel haelt nur
 * gespeicherte Aenderungen, die der Nutzer gemacht hat -- keine
 * Navigation, und nichts, was schon an die KI gesendet wurde (eine
 * gesendete Nachricht laesst sich nicht "ent-senden").
 */

export const GRENZE_BAUSTEIN = 16 * 1024;
export const GRENZE_NACHRICHT = 64 * 1024;
const STAPEL_MAX = 60;
const NICHT_TEXT = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file']);

/** Groesse eines Zustands in Bytes (UTF-8 des JSON), wie der Server zaehlt. */
export function groesse(wert) {
  let s;
  try {
    s = JSON.stringify(wert === undefined ? null : wert);
  } catch {
    return Infinity;
  }
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).length;
  return unescape(encodeURIComponent(s)).length;
}

/**
 * Passt ein Zustand in die Grenzen?
 * @param {object} zustand   der neue Zustand dieses Bausteins
 * @param {number} [uebrige] Bytes, die die anderen Bausteine der Nachricht schon belegen
 * @returns {{ok:boolean, grund?:string, bytes:number}}
 */
export function passt(zustand, uebrige = 0) {
  const bytes = groesse(zustand);
  if (!Number.isFinite(bytes)) return { ok: false, grund: 'Der Zustand lässt sich nicht speichern.', bytes };
  if (bytes > GRENZE_BAUSTEIN) return { ok: false, grund: 'Das ist mehr, als sich dieser Baustein merken kann (16 KB).', bytes };
  if (bytes + Math.max(0, uebrige) > GRENZE_NACHRICHT) return { ok: false, grund: 'Diese Antwort merkt sich schon so viel, dass nichts mehr dazupasst (64 KB).', bytes };
  return { ok: true, bytes };
}

/** Flache, tiefe Kopie ueber JSON: Zustand ist immer JSON-faehig. */
export function kopie(wert) {
  if (wert === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(wert));
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Ansicht (nur im Speicher, ueberlebt den Neubau des DOM)              */
/* ------------------------------------------------------------------ */

const ANSICHTEN = new Map();
const ANSICHT_MAX = 400;

/**
 * Das Ansichts-Objekt zu einem vollen Schluessel. Dasselbe Objekt kommt
 * bei jedem Neubau zurueck, so dass ein Baustein es einfach veraendern kann.
 */
export function ansichtVon(schluessel) {
  let a = ANSICHTEN.get(schluessel);
  if (!a) {
    a = {};
    ANSICHTEN.set(schluessel, a);
    // Nicht endlos wachsen: die aeltesten Eintraege gehen zuerst.
    if (ANSICHTEN.size > ANSICHT_MAX) ANSICHTEN.delete(ANSICHTEN.keys().next().value);
  }
  return a;
}

/* ------------------------------------------------------------------ */
/* Rueckgaengig / Wiederholen je Nachricht                              */
/* ------------------------------------------------------------------ */

const STAPEL = new Map(); // messageId -> {rueck:[], vor:[], abos:Set, anwender:Map}

function stapel(nachricht) {
  const id = String(nachricht || '_');
  let s = STAPEL.get(id);
  if (!s) {
    s = { rueck: [], vor: [], abos: new Set(), anwender: new Map() };
    STAPEL.set(id, s);
  }
  return s;
}

function melden(s) {
  for (const fn of [...s.abos]) {
    try { fn(); } catch { /* ein Abonnent darf die anderen nicht stoeren */ }
  }
}

/**
 * Wer einen Zustand zurueckschreiben kann. Der zuletzt gezeichnete Baustein
 * gewinnt: der Chat baut Knoten neu, und nur der neueste haengt im Dokument.
 * @param {string} nachricht
 * @param {string} schluessel voller Schluessel des Bausteins
 * @param {(zustand:object) => void} anwenden
 */
export function anmelden(nachricht, schluessel, anwenden) {
  const s = stapel(nachricht);
  s.anwender.set(schluessel, anwenden);
  return () => {
    if (s.anwender.get(schluessel) === anwenden) s.anwender.delete(schluessel);
  };
}

let zuletzt = null;
/**
 * Die Nachricht, in der zuletzt ein Baustein geaendert (oder ein Schritt
 * zurueckgenommen) wurde. Fuer ein Strg+Z, das nicht aus einem Baustein
 * kommt (Fokus auf der Seite): der Einbauer ruft
 * `tasteBehandeln(e, letzteNachricht())` auf Dokumentebene.
 */
export function letzteNachricht() {
  return zuletzt;
}

/** Eine Aenderung vormerken. `vorher`/`nachher` sind ganze Zustaende. */
export function aufzeichnen(nachricht, { schluessel, vorher, nachher, was = '' }) {
  zuletzt = String(nachricht || '_');
  const s = stapel(nachricht);
  s.rueck.push({ schluessel, vorher: kopie(vorher) ?? {}, nachher: kopie(nachher) ?? {}, was, at: Date.now() });
  if (s.rueck.length > STAPEL_MAX) s.rueck.shift();
  s.vor.length = 0;
  melden(s);
}

function schritt(nachricht, von, nach, feld) {
  if (!nachricht) return null;
  const s = stapel(nachricht);
  const e = s[von].pop();
  if (!e) return null;
  zuletzt = String(nachricht);
  const anwenden = s.anwender.get(e.schluessel);
  if (typeof anwenden === 'function') {
    try { anwenden(kopie(e[feld]) ?? {}); } catch { /* weiter: der Stapel bleibt stimmig */ }
  }
  s[nach].push(e);
  melden(s);
  return e;
}

/** Letzte Aenderung dieser Nachricht zuruecknehmen. @returns {object|null} der Eintrag */
export function rueckgaengig(nachricht) {
  return schritt(nachricht, 'rueck', 'vor', 'vorher');
}

/** Zurueckgenommene Aenderung wiederholen. */
export function wiederholen(nachricht) {
  return schritt(nachricht, 'vor', 'rueck', 'nachher');
}

/** Was der Stapel gerade kann -- und wo die Knoepfe hingehoeren. */
export function stapelStand(nachricht) {
  const s = stapel(nachricht);
  const oben = s.rueck[s.rueck.length - 1] || null;
  const naechstes = s.vor[s.vor.length - 1] || null;
  return {
    kannZurueck: s.rueck.length > 0,
    kannVor: s.vor.length > 0,
    // Die Knoepfe stehen an dem Baustein, den der naechste Schritt aendert.
    bei: oben ? oben.schluessel : (naechstes ? naechstes.schluessel : null),
    was: oben ? oben.was : '',
  };
}

/** Bei jeder Aenderung des Stapels benachrichtigt werden. */
export function abonnieren(nachricht, fn) {
  const s = stapel(nachricht);
  s.abos.add(fn);
  return () => s.abos.delete(fn);
}

/** Alles zu einer Nachricht vergessen (z. B. wenn sie geloescht wurde). */
export function vergessen(nachricht) {
  STAPEL.delete(String(nachricht || '_'));
}

/**
 * Strg+Z / Strg+Umschalt+Z (und Strg+Y) fuer eine Nachricht. In einem
 * Textfeld gehoert die Taste dem Feld (dort nimmt der Browser das Tippen
 * zurueck) -- das ist die Erwartung, und sie wird nicht gebrochen.
 * @returns {boolean} ob die Taste verbraucht wurde
 */
export function tasteBehandeln(event, nachricht) {
  if (!event || event.defaultPrevented) return false;
  const mod = event.ctrlKey || event.metaKey;
  if (!mod || event.altKey) return false;
  const taste = String(event.key || '').toLowerCase();
  if (taste !== 'z' && taste !== 'y') return false;
  const ziel = event.target;
  const feld = ziel && ziel.closest ? ziel.closest('input, textarea, [contenteditable=""], [contenteditable="true"]') : null;
  // Kaestchen, Regler und Knoepfe haben kein eigenes Rueckgaengig -- dort gilt das der Nachricht.
  if (feld && !(feld.tagName === 'INPUT' && NICHT_TEXT.has(String(feld.type || '').toLowerCase()))) return false;
  const vor = taste === 'y' || event.shiftKey;
  const e = vor ? wiederholen(nachricht) : rueckgaengig(nachricht);
  if (!e) return false;
  event.preventDefault();
  return true;
}

/* ------------------------------------------------------------------ */
/* Ein fertiger Speicher fuer den Einbauer                              */
/* ------------------------------------------------------------------ */

/**
 * Zustand einer Nachricht (einer Fassung) im Speicher halten und
 * entprellt abspeichern. Der Einbauer gibt `fuer(schluessel)` als
 * `ctx.zustand` an den Baustein.
 *
 *   const z = nachrichtenZustand({
 *     start: m.data.ui?.[version] || {},
 *     speichern: (schluessel, zustand) => api.put(`/chats/${id}/messages/${mid}/ui`, {version, schluessel, zustand}),
 *   });
 *   ctx.zustand = z.fuer(schluessel);
 *
 * @param {{start?:object, speichern?:(schluessel:string, zustand:object)=>Promise<any>, verzoegerungMs?:number, beiFehler?:(err:Error)=>void}} opts
 */
export function nachrichtenZustand(opts = {}) {
  const werte = new Map(Object.entries(opts.start && typeof opts.start === 'object' ? opts.start : {}));
  const offen = new Map(); // schluessel -> timer
  const warte = Math.max(0, Number(opts.verzoegerungMs ?? 350));

  const belegt = (ohne) => {
    let n = 0;
    for (const [k, v] of werte) if (k !== ohne) n += groesse(v);
    return n;
  };

  const abschicken = (schluessel) => {
    offen.delete(schluessel);
    if (typeof opts.speichern !== 'function') return;
    Promise.resolve()
      .then(() => opts.speichern(schluessel, kopie(werte.get(schluessel)) || {}))
      .catch((err) => { if (typeof opts.beiFehler === 'function') opts.beiFehler(err); });
  };

  return {
    fuer(schluessel) {
      return {
        lesen: () => kopie(werte.get(schluessel)) || {},
        schreiben: (zustand) => {
          const pruef = passt(zustand, belegt(schluessel));
          if (!pruef.ok) throw new Error(pruef.grund);
          werte.set(schluessel, kopie(zustand) || {});
          if (offen.has(schluessel)) clearTimeout(offen.get(schluessel));
          offen.set(schluessel, setTimeout(() => abschicken(schluessel), warte));
        },
      };
    },
    alle: () => Object.fromEntries([...werte].map(([k, v]) => [k, kopie(v)])),
    /** Alles Ausstehende sofort abschicken (z. B. beim Verlassen der Ansicht). */
    jetzt() {
      for (const [k, t] of [...offen]) {
        clearTimeout(t);
        abschicken(k);
      }
    },
  };
}
