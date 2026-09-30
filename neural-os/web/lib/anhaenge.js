/**
 * lib/anhaenge.js -- Bilder und PDF im Chat (docs/ANTWORT-BAUSTEINE.md 6):
 * erkennen, pruefen, verkleinern, ansehen.
 *
 * Die Entscheidungen, die diese Datei formen:
 *
 * - **Dieselben Grenzen wie der Server** (src/models/anhaenge.js): Bilder
 *   PNG, JPG, WEBP und GIF bis 5 MB, PDF bis 20 MB, hoechstens zehn je
 *   Nachricht. Wer hier schon scheitert, bekommt den Satz sofort und nicht
 *   erst nach dem Hochladen.
 * - **Grosse Fotos werden verkleinert, nicht abgelehnt.** Ein Handyfoto hat
 *   schnell 6 MB, und keine der beiden KIs liest 4000 Pixel (Claude
 *   verkleinert selbst auf rund 1500). Ueber der Grenze wird es auf
 *   hoechstens 2048 Pixel neu gezeichnet -- sichtbar verloren geht dabei
 *   nichts, und der Nutzer muss nichts tun.
 * - **Der Leuchtkasten ist ein Fenster in der Seite**, kein neuer Tab: Esc,
 *   Pfeiltasten und Wischen, und der Fokus kehrt dorthin zurueck, woher er
 *   kam. "Original" oeffnet das Bild in einem neuen Tab -- dort laesst es
 *   sich auf dem iPad mit zwei Fingern vergroessern.
 * - **Ein PDF "anzeigen" heisst: neuer Tab mit dem Betrachter des Browsers.**
 *   In einem Rahmen zeigt Safari auf dem iPad nur ein Bild der ersten Seite;
 *   ein Knopf, der dort "anzeigt", zeigte ein Drittel.
 * - **Schnellaktionen sind echte Auftraege**, keine Vorschlaege aus dem
 *   Inhalt geraten: sie haengen nur an der Art der Datei (Bild oder PDF).
 */

import { h, text, icon } from './dom.js';

/** Bildarten, die der Chat annimmt (wie der Server; Gemini liest GIF nicht). */
export const BILD_ARTEN = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const PDF_ART = 'application/pdf';
export const MAX_BILD_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_JE_NACHRICHT = 10;
/** Laengste Kante eines verkleinerten Bilds. */
export const ZIEL_KANTE = 2048;

const ALIAS = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'application/x-pdf': PDF_ART };
const ENDUNG = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: PDF_ART,
};
/** Textdateien, deren Inhalt als Text in die Nachricht geht. */
const TEXTDATEI = /\.(txt|md|markdown|csv|tsv|json|log|js|mjs|cjs|ts|py|html?|css|xml|ya?ml|ini|toml|sh|bat|ics|vcf|srt|tex|sql)$/i;

/** Der eine Satz, wenn eine Datei nicht geht. */
export const MOEGLICH = 'Möglich sind Textdateien, Bilder (PNG, JPG, WEBP, GIF) und PDF.';

/**
 * Was fuer eine Datei ist das? Nach der Angabe des Browsers, und nur wenn
 * er nichts sagt nach der Endung (manche Systeme liefern bei .pdf einen
 * leeren Typ). Ob der Inhalt stimmt, prueft der Server an den ersten Bytes.
 * @param {{name?:string, type?:string}} datei
 * @returns {{art:'bild'|'pdf'|'text', mime:string} | {art:null}}
 */
export function dateiArt(datei = {}) {
  const name = String((datei && datei.name) || '');
  const roh = String((datei && datei.type) || '').toLowerCase().trim();
  const typ = ALIAS[roh] || roh;
  if (BILD_ARTEN.includes(typ)) return { art: 'bild', mime: typ };
  if (typ === PDF_ART) return { art: 'pdf', mime: PDF_ART };
  if (!typ || typ === 'application/octet-stream') {
    const endung = (/\.([a-z0-9]+)$/i.exec(name) || [])[1];
    const ausEndung = endung ? ENDUNG[endung.toLowerCase()] : null;
    if (ausEndung === PDF_ART) return { art: 'pdf', mime: PDF_ART };
    if (ausEndung) return { art: 'bild', mime: ausEndung };
  }
  if (typ.startsWith('text/') || /json|xml|javascript|csv/.test(typ) || TEXTDATEI.test(name)) {
    return { art: 'text', mime: typ || 'text/plain' };
  }
  return { art: null };
}

/** "1,2 MB" -- wie der Server seine Grenzen nennt. */
export function mb(bytes) {
  return (Number(bytes) / (1024 * 1024)).toLocaleString('de-DE', { maximumFractionDigits: 1 });
}

/**
 * Was nach dem Anhaengen angeboten wird (docs/ANTWORT-BAUSTEINE.md 6): bei
 * Bildern Erklaeren, Aufgaben loesen, Text erkennen, Zusammenfassen; bei
 * PDF Zusammenfassen, Wichtigste Begriffe, Kapitel. Der Text ist genau der
 * Auftrag, der mit den Dateien an die KI geht.
 * @param {Array<{art:string}>} liste die angehaengten Dateien
 * @returns {Array<{id:string, label:string, text:string}>}
 */
export function schnellAktionen(liste) {
  const arten = (Array.isArray(liste) ? liste : []).map((a) => a && a.art);
  const bilder = arten.filter((a) => a === 'bild').length;
  const pdfs = arten.filter((a) => a === 'pdf').length;
  if (!bilder && !pdfs) return [];
  const bild = bilder > 1 ? 'den Bildern' : 'dem Bild';
  const pdf = pdfs > 1 ? 'die PDFs' : 'das PDF';
  const pdfDativ = pdfs > 1 ? 'den PDFs' : 'dem PDF';
  const out = [];
  if (bilder) {
    out.push({ id: 'erklaeren', label: 'Erklären', text: `Erklär mir, was auf ${bild} zu sehen ist.` });
    out.push({ id: 'aufgaben', label: 'Aufgaben lösen', text: `Löse die Aufgaben auf ${bild} – Schritt für Schritt, mit kurzer Erklärung.` });
    out.push({ id: 'text', label: 'Text erkennen', text: `Schreib den Text auf ${bild} genau ab.` });
  }
  if (bilder && pdfs) {
    out.push({ id: 'zusammenfassen', label: 'Zusammenfassen', text: 'Fass die Anhänge kurz zusammen.' });
  } else if (bilder) {
    out.push({ id: 'zusammenfassen', label: 'Zusammenfassen', text: `Fass kurz zusammen, was auf ${bild} steht.` });
  } else {
    out.push({ id: 'zusammenfassen', label: 'Zusammenfassen', text: `Fass ${pdf} kurz zusammen.` });
  }
  if (pdfs) {
    out.push({ id: 'begriffe', label: 'Wichtigste Begriffe', text: `Nenn die wichtigsten Begriffe aus ${pdfDativ} und erklär jeden in einem Satz.` });
    out.push({ id: 'kapitel', label: 'Kapitel', text: `Gliedere ${pdf} in Kapitel und fass jedes in einem Satz zusammen.` });
  }
  return out;
}

/** Wo der Server einen Anhang dieses Chats ausliefert. */
export function anhangUrl(chatId, id) {
  return `/api/chats/${encodeURIComponent(String(chatId || ''))}/anhaenge/${encodeURIComponent(String(id || ''))}`;
}

/** Eine Datei als Base64 (ohne den `data:`-Vorsatz). */
export function alsBase64(blob) {
  return new Promise((resolve, reject) => {
    const leser = new FileReader();
    leser.onload = () => {
      const s = String(leser.result || '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    leser.onerror = () => reject(leser.error || new Error('Die Datei ließ sich nicht lesen.'));
    leser.readAsDataURL(blob);
  });
}

/**
 * Ein Bild fuer den Versand vorbereiten: Passt es in die Grenze, bleibt es,
 * wie es ist (auch ein GIF bleibt bewegt). Sonst wird es auf hoechstens
 * ZIEL_KANTE Pixel als JPEG neu gezeichnet, auf weissem Grund (JPEG kennt
 * keine Durchsicht). Geht auch das nicht, wirft es mit einem Satz.
 * @returns {Promise<{datei:Blob, name:string, mime:string, verkleinert:boolean}>}
 */
export async function bildVorbereiten(datei, { name, mime }) {
  if (datei.size <= MAX_BILD_BYTES) return { datei, name, mime, verkleinert: false };
  const zuGross = `„${name}“ ist zu groß (${mb(datei.size)} MB, erlaubt sind ${mb(MAX_BILD_BYTES)} MB).`;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') throw new Error(zuGross);
  let bild;
  try {
    bild = await createImageBitmap(datei);
  } catch {
    throw new Error(`${zuGross} Verkleinern ging nicht.`);
  }
  const faktor = Math.min(1, ZIEL_KANTE / Math.max(bild.width, bild.height));
  const breite = Math.max(1, Math.round(bild.width * faktor));
  const hoehe = Math.max(1, Math.round(bild.height * faktor));
  const flaeche = document.createElement('canvas');
  flaeche.width = breite;
  flaeche.height = hoehe;
  const g = flaeche.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, breite, hoehe);
  g.drawImage(bild, 0, 0, breite, hoehe);
  if (typeof bild.close === 'function') bild.close();
  for (const guete of [0.88, 0.78, 0.66]) {
    const blob = await new Promise((resolve) => flaeche.toBlob(resolve, 'image/jpeg', guete));
    if (blob && blob.size <= MAX_BILD_BYTES) {
      return { datei: blob, name: `${name.replace(/\.[^.]+$/, '') || 'bild'}.jpg`, mime: 'image/jpeg', verkleinert: true };
    }
  }
  throw new Error(`${zuGross} Verkleinern reichte nicht.`);
}

/* ------------------------------------------------------------------ */
/* Leuchtkasten                                                         */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'nos-leuchtkasten';
const SYMBOL_ZU = '<path d="m5.2 5.2 9.6 9.6M14.8 5.2l-9.6 9.6"/>';
const SYMBOL_LINKS = '<path d="m12.2 5.4-4.6 4.6 4.6 4.6"/>';
const SYMBOL_RECHTS = '<path d="m7.6 5.4 4.6 4.6-4.6 4.6"/>';
const SYMBOL_NEUER_TAB = '<path d="M11.4 3.6h5v5M16.4 3.6l-7 7"/><path d="M14.6 11.6v3.2a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6V7a1.6 1.6 0 0 1 1.6-1.6h3.2"/>';

let offen = null;

/**
 * Bilder gross ansehen. `bilder`: [{src, name}], `start`: welches zuerst.
 * Ein zweiter Aufruf ersetzt den offenen Kasten.
 * @returns {{schliessen:()=>void}}
 */
export function leuchtkasten({ bilder, start = 0 } = {}) {
  const liste = (Array.isArray(bilder) ? bilder : []).filter((b) => b && b.src);
  if (!liste.length || typeof document === 'undefined') return { schliessen() {} };
  if (offen) offen.schliessen();
  stilEinsetzen();
  const vorherFokus = document.activeElement;
  let i = Math.max(0, Math.min(liste.length - 1, Number(start) || 0));

  const bild = h('img.lk__bild', { alt: '', draggable: 'false' });
  const name = h('span.lk__name');
  const stand = h('span.lk__stand');
  const original = h('a.lk__knopf', { target: '_blank', rel: 'noopener noreferrer' }, icon(SYMBOL_NEUER_TAB), h('span', null, text('Original')));
  const zu = h('button.lk__knopf', { type: 'button', 'aria-label': 'Schließen', title: 'Schließen (Esc)' }, icon(SYMBOL_ZU), h('span', null, text('Schließen')));
  const zurueck = h('button.lk__pfeil.lk__pfeil--links', { type: 'button', 'aria-label': 'Voriges Bild', title: 'Voriges Bild (←)' }, icon(SYMBOL_LINKS));
  const vor = h('button.lk__pfeil.lk__pfeil--rechts', { type: 'button', 'aria-label': 'Nächstes Bild', title: 'Nächstes Bild (→)' }, icon(SYMBOL_RECHTS));
  const buehne = h('div.lk__buehne', null, bild);
  const kasten = h('div.lk', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Bild ansehen', tabindex: '-1' },
    buehne,
    liste.length > 1 ? zurueck : null,
    liste.length > 1 ? vor : null,
    h('div.lk__leiste', null, h('span.lk__titel', null, name, liste.length > 1 ? stand : null), original, zu));

  function zeigen() {
    const b = liste[i];
    bild.src = b.src;
    bild.alt = b.name || 'Bild';
    name.textContent = b.name || 'Bild';
    stand.textContent = ` · ${i + 1} von ${liste.length}`;
    original.href = b.src;
    zurueck.disabled = i <= 0;
    vor.disabled = i >= liste.length - 1;
  }
  const blaettern = (schritt) => {
    const neu = i + schritt;
    if (neu < 0 || neu >= liste.length) return;
    i = neu;
    zeigen();
  };

  const taste = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      schliessen();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      blaettern(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      blaettern(1);
    } else if (e.key === 'Tab') {
      // Der Fokus bleibt im Kasten, solange er offen ist.
      const ziele = [...kasten.querySelectorAll('a[href], button:not([disabled])')];
      if (!ziele.length) return;
      const erstes = ziele[0];
      const letztes = ziele[ziele.length - 1];
      if (e.shiftKey && document.activeElement === erstes) {
        e.preventDefault();
        letztes.focus();
      } else if (!e.shiftKey && document.activeElement === letztes) {
        e.preventDefault();
        erstes.focus();
      }
    }
  };
  // Wischen mit dem Finger: links/rechts blaettert.
  let wisch = null;
  buehne.addEventListener('pointerdown', (e) => { wisch = { x: e.clientX, y: e.clientY }; });
  buehne.addEventListener('pointerup', (e) => {
    if (!wisch) return;
    const dx = e.clientX - wisch.x;
    const dy = e.clientY - wisch.y;
    wisch = null;
    if (Math.abs(dx) > 50 && Math.abs(dy) < 80) blaettern(dx < 0 ? 1 : -1);
  });
  // Ein Tippen neben das Bild schliesst.
  buehne.addEventListener('click', (e) => { if (e.target === buehne) schliessen(); });
  zu.addEventListener('click', () => schliessen());
  zurueck.addEventListener('click', () => blaettern(-1));
  vor.addEventListener('click', () => blaettern(1));
  kasten.addEventListener('keydown', taste);

  function schliessen() {
    if (!kasten.isConnected) return;
    kasten.remove();
    if (offen && offen.kasten === kasten) offen = null;
    if (vorherFokus && typeof vorherFokus.focus === 'function' && vorherFokus.isConnected) vorherFokus.focus({ preventScroll: true });
  }

  zeigen();
  document.body.appendChild(kasten);
  zu.focus({ preventScroll: true });
  offen = { kasten, schliessen };
  return { schliessen };
}

/** Einen offenen Leuchtkasten schliessen (z. B. wenn die Ansicht geht). */
export function leuchtkastenZu() {
  if (offen) offen.schliessen();
}

function stilEinsetzen() {
  if (document.getElementById(STYLE_ID)) return;
  const node = document.createElement('style');
  node.id = STYLE_ID;
  node.textContent = LEUCHTKASTEN_CSS;
  document.head.appendChild(node);
}

const LEUCHTKASTEN_CSS = `
.lk { position: fixed; inset: 0; z-index: 1200; display: grid; grid-template-rows: minmax(0, 1fr) auto; background: rgba(0, 0, 0, 0.9); color: #f5f5f7; outline: none; }
.lk__buehne { display: grid; place-items: center; min-height: 0; padding: 28px 72px 8px; touch-action: pan-y; }
.lk__bild { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 10px; background: #111; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5); user-select: none; }
.lk__leiste { display: flex; align-items: center; gap: 8px; padding: 12px 18px 18px; }
.lk__titel { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.lk__stand { color: rgba(245, 245, 247, 0.62); }
.lk__knopf { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 14px; font: inherit; font-size: 14px; color: #f5f5f7; text-decoration: none; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 999px; cursor: pointer; }
.lk__knopf:hover { background: rgba(255, 255, 255, 0.18); }
.lk__knopf svg { width: 16px; height: 16px; }
.lk__pfeil { position: absolute; top: 50%; display: grid; place-items: center; width: 48px; height: 48px; padding: 0; color: #f5f5f7; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 50%; transform: translateY(-50%); cursor: pointer; }
.lk__pfeil:hover:not(:disabled) { background: rgba(255, 255, 255, 0.2); }
.lk__pfeil:disabled { opacity: 0.3; cursor: default; }
.lk__pfeil svg { width: 22px; height: 22px; }
.lk__pfeil--links { left: 14px; }
.lk__pfeil--rechts { right: 14px; }
.lk__knopf:focus-visible, .lk__pfeil:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(47, 124, 246, 0.6); }
@media (max-width: 760px) {
  .lk__buehne { padding: 16px 12px 8px; }
  .lk__pfeil { top: auto; bottom: 76px; transform: none; }
}
@media (pointer: coarse) {
  .lk__knopf { min-height: 44px; }
}
`;
