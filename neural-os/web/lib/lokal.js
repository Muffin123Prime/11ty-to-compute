/**
 * lib/lokal.js -- die EINZIGE Stelle mit localStorage und sessionStorage
 * (docs/STICK-BAUPLAN.md, Paket W1).
 *
 * Warum so streng:
 *
 * - **Jeder Stick ist eine eigene KI**, und zwei Sticks am selben Laptop
 *   laufen im selben Browser. Alles, was sich der Browser merkt, traegt
 *   deshalb die Kennung der KI: `neural-os:<kiId>:<name>`. Beim Start wird
 *   jeder `neural-os:`-Schluessel einer anderen KI geloescht (und die alten
 *   ohne Kennung) -- B sieht nie etwas von A.
 * - **Auf dem Laptop bleibt nichts Inhaltliches zurueck.** Im localStorage
 *   stehen nur Vorlieben der Oberflaeche und Kennungen (ERLAUBT), nie Text.
 *   Entwuerfe liegen in sessionStorage: weg, sobald der Tab zu ist.
 *
 * Solange die Kennung noch nicht vom Server kam (die ersten Millisekunden),
 * gilt die, deren Schluessel hier schon liegen (`vorlaeufig`) -- nur damit
 * Design und Seitenleisten nicht erst falsch aufblitzen. Stimmt sie nicht,
 * raeumt `kiSetzen` auf.
 *
 * Jeder Zugriff kann werfen (privates Fenster, abgeschalteter Speicher); dann
 * ueberlebt die Vorliebe eben den Neustart nicht.
 */

const PRAEFIX = 'neural-os:';
const KENNUNG = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Was im localStorage stehen darf: Vorlieben der Oberflaeche und Kennungen,
 * nie ein Titel oder Text. `design` und `seiten` spiegeln config.ui (sie
 * reisen mit dem Stick; hier nur, damit sie beim Laden sofort gelten).
 */
export const ERLAUBT = Object.freeze([
  'seiten',
  'kalender-ansicht',
  'aktiver-chat',
  'design',
  'notizen-modus',
  // Erinnerungen (lib/erinnerung.js): Kennungen und Zeiten, damit eine
  // Erinnerung nach dem Neuladen nicht noch einmal kommt.
  'erinnerungen-erledigt',
  'erinnerungen-mitgeteilt',
  'erinnerung-mitteilung',
  // Stick-Ansicht: welche zweite Fassung schon angesehen ist (nur Kennungen).
  'fassungen-gesehen',
]);

/** Alte Schluessel aus der Zeit ohne Kennung -- beim Start weg. */
const ALT_GENAU = new Set(['theme', 'active-chat', 'seiten', 'kalender-ansicht', 'notes-mode']);
const ALT_PRAEFIXE = ['chat-draft:'];

let ki = null;

function speicher(art) {
  try {
    return art === 'sitzung' ? globalThis.sessionStorage : globalThis.localStorage;
  } catch {
    return null;
  }
}

function alleSchluessel(s) {
  const out = [];
  try {
    for (let i = 0; i < s.length; i += 1) {
      const k = s.key(i);
      if (typeof k === 'string') out.push(k);
    }
  } catch {
    /* nicht lesbar: nichts zu tun */
  }
  return out;
}

/** Die Kennung dieser KI (vom Server) -- oder null, solange sie unbekannt ist. */
export function kiKennung() {
  return ki;
}

/**
 * Die Kennung, deren Schluessel schon hier liegen, als vorlaeufige -- nur,
 * wenn es genau eine ist. Fuer den allerersten Bildaufbau.
 */
export function vorlaeufig() {
  if (ki) return ki;
  const s = speicher('dauer');
  if (!s) return null;
  const gefunden = new Set();
  for (const k of alleSchluessel(s)) {
    if (!k.startsWith(PRAEFIX)) continue;
    const id = k.slice(PRAEFIX.length).split(':')[0];
    if (KENNUNG.test(id) && ERLAUBT.includes(k.slice(PRAEFIX.length + id.length + 1))) gefunden.add(id);
  }
  if (gefunden.size !== 1) return null;
  [ki] = [...gefunden];
  return ki;
}

/**
 * Die Kennung vom Server setzen (GET /api/status → ki.id) und aufraeumen:
 * alles, was einer anderen KI gehoert, und die alten Schluessel ohne
 * Kennung. Gibt zurueck, ob sich die Kennung geaendert hat (dann gelten die
 * gelesenen Vorlieben nicht mehr).
 */
export function kiSetzen(id) {
  if (typeof id !== 'string' || !KENNUNG.test(id)) return false;
  const vorher = ki;
  ki = id;
  aufraeumen();
  return vorher !== id;
}

/** Jeder `neural-os:`-Schluessel, der nicht dieser KI gehoert, und die alten ohne Kennung. */
export function aufraeumen() {
  if (!ki) return 0;
  const eigen = `${PRAEFIX}${ki}:`;
  let weg = 0;
  for (const art of ['dauer', 'sitzung']) {
    const s = speicher(art);
    if (!s) continue;
    for (const k of alleSchluessel(s)) {
      const fremd = k.startsWith(PRAEFIX) && !k.startsWith(eigen);
      const alt = ALT_GENAU.has(k) || ALT_PRAEFIXE.some((p) => k.startsWith(p));
      if (!fremd && !alt) continue;
      try {
        s.removeItem(k);
        weg += 1;
      } catch {
        /* nicht loeschbar: dann bleibt er */
      }
    }
  }
  return weg;
}

function schluessel(name) {
  return `${PRAEFIX}${ki}:${name}`;
}

/** Eine Vorliebe lesen -- nur erlaubte Namen, nur mit Kennung. */
export function lesen(name, vorgabe = null) {
  if (!ki || !ERLAUBT.includes(name)) return vorgabe;
  const s = speicher('dauer');
  if (!s) return vorgabe;
  try {
    const wert = s.getItem(schluessel(name));
    return wert === null ? vorgabe : wert;
  } catch {
    return vorgabe;
  }
}

export function schreiben(name, wert) {
  if (!ki || !ERLAUBT.includes(name)) return false;
  const s = speicher('dauer');
  if (!s) return false;
  try {
    s.setItem(schluessel(name), String(wert));
    return true;
  } catch {
    return false;
  }
}

export function loeschen(name) {
  if (!ki || !ERLAUBT.includes(name)) return;
  const s = speicher('dauer');
  if (!s) return;
  try {
    s.removeItem(schluessel(name));
  } catch {
    /* dann eben nicht */
  }
}

/** JSON-Vorlieben (seiten, Erinnerungen): lesen mit Vorgabe, schreiben als Text. */
export function lesenJson(name, vorgabe) {
  const roh = lesen(name, null);
  if (roh === null) return vorgabe;
  try {
    const wert = JSON.parse(roh);
    return wert === null || wert === undefined ? vorgabe : wert;
  } catch {
    return vorgabe;
  }
}

export function schreibenJson(name, wert) {
  try {
    return schreiben(name, JSON.stringify(wert));
  } catch {
    return false;
  }
}

/**
 * Entwuerfe (was im Eingabefeld eines Chats steht): nur in sessionStorage,
 * unter `neural-os:<kiId>:entwurf:<chat>` -- weg, sobald der Tab zu ist.
 */
export const entwurf = {
  lesen(chat) {
    const s = speicher('sitzung');
    if (!ki || !s) return null;
    try {
      return s.getItem(`${PRAEFIX}${ki}:entwurf:${chat}`);
    } catch {
      return null;
    }
  },
  schreiben(chat, textWert) {
    const s = speicher('sitzung');
    if (!ki || !s) return false;
    try {
      s.setItem(`${PRAEFIX}${ki}:entwurf:${chat}`, String(textWert));
      return true;
    } catch {
      return false;
    }
  },
  loeschen(chat) {
    const s = speicher('sitzung');
    if (!ki || !s) return;
    try {
      s.removeItem(`${PRAEFIX}${ki}:entwurf:${chat}`);
    } catch {
      /* dann eben nicht */
    }
  },
};

/** Nur fuer Tests: den Zustand vergessen. */
export function _zuruecksetzen() {
  ki = null;
}
