/**
 * widgets/gehirn.js -- Kachel "Gehirn" (Platzhalter der Schale).
 *
 * Der Bereich Gehirn ersetzt diese Datei (ein kleiner Graph, der zuletzt
 * beruehrte Knoten im Akzent). Bis dahin sagt die Kachel ehrlich, dass sie
 * noch nichts zeigt -- kein gemaltes Beispielnetz.
 *
 * Schnittstelle (Vertrag 2): export function mount(el, ctx) -> { unmount() }
 */

export function mount(el, ctx) {
  const { h, text, clear, icons, tileHead } = ctx;
  el.append(
    tileHead({ icon: icons.graph, title: 'Gehirn', meta: 'Automatisch erkannt', href: '#/graph' }),
    h('div.tile__body', null,
      h('p.tile__empty', null, text('Noch leer. Was die KI über dich lernt, wächst hier als Netz.'))));
  return {
    unmount() {
      clear(el);
    },
  };
}
