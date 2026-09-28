/**
 * bausteine/bearbeiten.js -- den Inhalt einer Datei oder Vorschau aendern.
 *
 * Eine Aenderung am Inhalt ist eine neue FASSUNG der Antwort (PATCH
 * /api/chats/:id/messages/:mid/block, docs Abschnitt 4), kein Zustand: Die
 * alte Fassung bleibt erreichbar, und die KI sieht im weiteren Gespraech
 * den geaenderten Text. Deshalb gibt es [Bearbeiten] nur, wo das geht: im
 * Chat, an einem Baustein der obersten Ebene (ein verschachtelter steckt im
 * JSON seines Eltern-Bausteins).
 */

import { h, text } from '../dom.js';
import { knopf, spinner } from './gemeinsam.js';

/** Kann dieser Baustein eine neue Fassung anlegen? */
export function kannBearbeiten(b) {
  return !!(b.api && typeof b.api.patch === 'function' && b.chatId && b.messageId && b.tiefe === 0 && Number.isInteger(b.blockNr));
}

/**
 * Das Bearbeitungsfeld. `a` ist die Ansicht des Bausteins (Entwurf und
 * Status ueberleben den Neubau der Nachricht).
 */
export function bearbeitenFeld(b, a, inhalt, { sprache = 'Text' } = {}) {
  if (typeof a.entwurf !== 'string') a.entwurf = inhalt;
  const feld = h('textarea.bs-feld.bs-bearbeiten__feld', {
    spellcheck: 'false',
    'aria-label': `${sprache} bearbeiten`,
    'data-key': b.key('bearbeiten-feld'),
    onInput: (e) => { a.entwurf = e.target.value; },
    onKeydown: (e) => {
      // Tab rueckt ein, statt aus dem Feld zu springen: es ist ein Code-Feld.
      if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const t = e.target;
        const [s0, s1] = [t.selectionStart, t.selectionEnd];
        t.setRangeText('  ', s0, s1, 'end');
        a.entwurf = t.value;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        abbrechen();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        speichern();
      }
      e.stopPropagation();
    },
  });
  feld.value = a.entwurf;
  const zeilen = Math.min(24, Math.max(6, String(a.entwurf).split('\n').length + 1));
  feld.rows = zeilen;

  function abbrechen() {
    a.bearbeiten = false;
    a.entwurf = null;
    a.speicherFehler = null;
    b.neuZeichnen();
  }
  async function speichern() {
    if (a.speichert) return;
    if (a.entwurf === inhalt) {
      abbrechen();
      return;
    }
    a.speichert = true;
    a.speicherFehler = null;
    b.neuZeichnen();
    try {
      await b.api.patch(`/chats/${encodeURIComponent(b.chatId)}/messages/${encodeURIComponent(b.messageId)}/block`, {
        nr: b.blockNr,
        inhalt: a.entwurf,
        ...(b.quelle ? { alt: b.quelle } : {}),
      });
      a.speichert = false;
      a.bearbeiten = false;
      a.entwurf = null;
      a.gespeichert = true;
      b.neuZeichnen();
    } catch (err) {
      a.speichert = false;
      a.speicherFehler = (err && err.message) || 'Das ließ sich nicht speichern.';
      b.neuZeichnen();
    }
  }

  return h('div.bs-bearbeiten', null,
    feld,
    h('div.bs-fuss', null,
      h('span.bs-leise', null, text('Speichern legt eine neue Fassung der Antwort an.')),
      h('div.bs-fuss__rechts', null,
        knopf('Abbrechen', { art: 'leise', key: b.key('bearbeiten-ab'), onClick: abbrechen }),
        h('button.bs-knopf.bs-knopf--haupt', {
          type: 'button',
          disabled: !!a.speichert,
          'data-key': b.key('bearbeiten-ok'),
          onClick: (e) => { e.stopPropagation(); speichern(); },
        }, a.speichert ? spinner() : null, h('span', null, text('Speichern'))))),
    a.speicherFehler ? h('p.bs-fehler', { role: 'alert' }, text(a.speicherFehler)) : null);
}

export const BEARBEITEN_CSS = `
.bs-bearbeiten { margin-top: 12px; }
.bs-bearbeiten__feld { display: block; min-height: 140px; font-family: var(--font-mono); font-size: var(--fs-sm); line-height: 1.55; resize: vertical; tab-size: 2; white-space: pre; overflow: auto; }
`;
