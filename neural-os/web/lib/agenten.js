/**
 * lib/agenten.js -- der gemeinsame Wortschatz fuer alles, was Agenten zeigt:
 * die Kachel "Agenten aktiv", die Ansicht "Agenten" und die Karten im Chat.
 *
 * Warum eine eigene Datei: dieselbe Taetigkeit erscheint an drei Stellen
 * gleichzeitig (Chat, Kachel, Ansicht). Heisst sie an einer davon
 * "Recherche" und an der anderen "Such-Agent", oder rechnet eine Stelle die
 * Dauer anders, sieht der Nutzer zwei Agenten, wo einer war.
 *
 * Nichts hier fragt den Server; alles sind reine Funktionen ueber den
 * Formen aus Vertrag 6/7 (Ereignis `agent`, Satzart `run`).
 */

/** Rollen aus Vertrag 7, mit dem Namen, den die Vorlage zeigt ("Recherche-Agent"). */
export const ROLLEN = Object.freeze({
  recherche: { name: 'Recherche-Agent', kurz: 'Recherche', symbol: 'globe' },
  planung: { name: 'Planungs-Agent', kurz: 'Planung', symbol: 'list' },
  kalender: { name: 'Kalender-Agent', kurz: 'Kalender', symbol: 'calendar' },
  notizen: { name: 'Notiz-Agent', kurz: 'Notizen', symbol: 'notes' },
  gedaechtnis: { name: 'Gedächtnis-Agent', kurz: 'Gedächtnis', symbol: 'graph' },
  projekte: { name: 'Projekt-Agent', kurz: 'Projekte', symbol: 'projects' },
});

const UNBEKANNT = Object.freeze({ name: 'Agent', kurz: 'Agent', symbol: 'agents' });

export function rolle(id) {
  return ROLLEN[id] || UNBEKANNT;
}

/**
 * Ein Lauf, der seit so langer Zeit "laeuft", ist nicht fleissig, sondern
 * liegengeblieben (Neustart mitten im Zug). Er wird ehrlich als
 * unterbrochen gezeigt statt als aktiv. Ausnahme: der Planungs-Agent, der
 * auf eine Antwort wartet -- das darf dauern.
 */
export const VERWAIST_MS = 15 * 60 * 1000;

/**
 * Der Zustand, den die Oberflaeche zeigt: 'laeuft' | 'fertig' | 'fehler' |
 * 'unterbrochen'. Nimmt ein Agenten-Ereignis (zustand) oder einen Lauf-Satz
 * (status) -- beide Formen kommen vor.
 */
export function zustandVon(lauf, jetzt = Date.now()) {
  const z = lauf.zustand || ({
    queued: 'laeuft', running: 'laeuft', 'waiting-approval': 'laeuft', done: 'fertig', failed: 'fehler', aborted: 'fehler',
  }[lauf.status]) || 'fertig';
  if (z !== 'laeuft') return z;
  if (lauf.rolle === 'planung') return 'laeuft';
  const beginn = Date.parse(lauf.startedAt || lauf.beginn || '') || null;
  if (beginn && jetzt - beginn > VERWAIST_MS) return 'unterbrochen';
  return 'laeuft';
}

/** "unter 1 s", "12 s", "2 min 5 s", "1 h 4 min" -- nie "0 s" fuer etwas, das lief. */
export function dauerText(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return 'unter 1 s';
  const s = Math.round(n / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const TAGE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MONATE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/**
 * 'YYYY-MM-DD' oder 'YYYY-MM-DDTHH:MM' (Ortszeit, ohne Zone, wie die KI sie
 * anlegt) -> "Do, 25. Sep · 15:00". Ohne `new Date(string)`: das laese eine
 * Uhrzeit ohne Zone je nach Browser als UTC.
 */
export function terminWann(start, { ganztaegig = false, ende = null } = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(start || ''));
  if (!m) return '';
  const tagText = (j, mo, t) => {
    const d = new Date(Number(j), Number(mo) - 1, Number(t));
    const jahr = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
    return `${TAGE[d.getDay()]}, ${d.getDate()}. ${MONATE[d.getMonth()]}${jahr}`;
  };
  const tag = tagText(m[1], m[2], m[3]);
  const e = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ende || ''));
  const mehrtaegig = e && `${e[1]}-${e[2]}-${e[3]}` > `${m[1]}-${m[2]}-${m[3]}`;
  if (ganztaegig || !m[4]) return mehrtaegig ? `${tag} – ${tagText(e[1], e[2], e[3])}` : `${tag} · ganztägig`;
  return `${tag} · ${m[4]}:${m[5]}`;
}

/**
 * Wohin "Oeffnen" fuehrt. Die Kennung traegt ihre Satzart vorn
 * (`event_…`, src/store/engine.js makeId), also geht das auch ohne den Satz.
 */
export function zielVon(id, typ, extra = {}) {
  const art = typ || String(id || '').split('_')[0];
  const q = encodeURIComponent(id);
  switch (art) {
    case 'event': return `#/kalender?id=${q}`;
    case 'note': return `#/notes?id=${q}`;
    case 'project': return `#/projects?id=${q}`;
    case 'task': return extra.projectId ? `#/projects?id=${encodeURIComponent(extra.projectId)}` : '#/projects';
    case 'memory': return `#/graph?focus=${q}`;
    case 'chat': return `#/chat?id=${q}`;
    default: return null;
  }
}

/** Welche Art ein angelegter Satz ist, als Wort und als Symbolname. */
export const ARTEN = Object.freeze({
  event: { wort: 'Termin', symbol: 'calendar', oeffnen: 'Termin öffnen' },
  note: { wort: 'Notiz', symbol: 'notes', oeffnen: 'Notiz öffnen' },
  memory: { wort: 'Gemerkt', symbol: 'graph', oeffnen: 'Im Gehirn zeigen' },
  project: { wort: 'Projekt', symbol: 'projects', oeffnen: 'Projekt öffnen' },
  task: { wort: 'Aufgabe', symbol: 'check', oeffnen: 'Zum Projekt' },
});

/**
 * Die Wirkung eines Werkzeugs (Schnappschuss aus src/models/chat.js) als
 * eine Zeile: "Termin eingetragen" + "Do, 25. Sep · 15:00 · Zahnarzt".
 * Aufgaben eines Projekts werden am Projekt gezaehlt statt einzeln gezeigt.
 *
 * @param {Array<object>} wirkung
 * @returns {Array<{id:string, typ:string, aktion:string, label:string, detail:string, href:string|null, symbol:string, geloescht:boolean}>}
 */
export function wirkungZeilen(wirkung) {
  const liste = Array.isArray(wirkung) ? wirkung.filter((w) => w && w.id) : [];
  const projekte = new Map(liste.filter((w) => w.typ === 'project').map((w) => [w.id, w]));
  const aufgabenJe = new Map();
  for (const w of liste) {
    if (w.typ === 'task' && w.projectId && projekte.has(w.projectId)) {
      aufgabenJe.set(w.projectId, (aufgabenJe.get(w.projectId) || 0) + 1);
    }
  }
  const out = [];
  for (const w of liste) {
    if (w.typ === 'task' && w.projectId && projekte.has(w.projectId)) continue;
    const art = ARTEN[w.typ] || { wort: 'Eintrag', symbol: 'info' };
    let label;
    let detail = w.titel || '';
    switch (w.typ) {
      case 'event':
        label = { angelegt: 'Termin eingetragen', geaendert: 'Termin geändert', geloescht: 'Termin gelöscht', ausgelassen: 'Termin fällt einmal aus' }[w.aktion] || 'Termin';
        detail = [terminWann(w.start, { ganztaegig: w.ganztaegig, ende: w.end }), w.titel, w.serie ? 'Serie' : ''].filter(Boolean).join(' · ');
        break;
      case 'note':
        label = w.aktion === 'geaendert' ? 'Notiz geändert' : 'Notiz angelegt';
        break;
      case 'memory':
        label = 'Gemerkt';
        break;
      case 'project': {
        label = w.aktion === 'geaendert' ? 'Projekt aktualisiert' : 'Projekt angelegt';
        const n = aufgabenJe.get(w.id) || 0;
        if (n) detail = `${detail} · ${n} Aufgabe${n === 1 ? '' : 'n'}`;
        break;
      }
      case 'task':
        label = 'Aufgabe angelegt';
        break;
      default:
        label = art.wort;
    }
    out.push({
      id: w.id,
      typ: w.typ,
      aktion: w.aktion,
      label,
      detail,
      href: w.aktion === 'geloescht' ? null : zielVon(w.id, w.typ, { projectId: w.projectId }),
      symbol: art.symbol,
      geloescht: w.aktion === 'geloescht',
    });
  }
  return out;
}

/** Uhrzeit fuer eine Nachricht: heute "10:24", sonst "23.09., 10:24". */
export function uhrzeit(iso, jetzt = new Date()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const heute = d.getFullYear() === jetzt.getFullYear() && d.getMonth() === jetzt.getMonth() && d.getDate() === jetzt.getDate();
  if (heute) return hm;
  const jahr = d.getFullYear() !== jetzt.getFullYear() ? String(d.getFullYear()) : '';
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${jahr}, ${hm}`;
}

export default { ROLLEN, rolle, zustandVon, dauerText, terminWann, zielVon, ARTEN, wirkungZeilen, uhrzeit, VERWAIST_MS };
