/**
 * widgets/agenten.js -- Kachel "Agenten aktiv" (Platzhalter der Schale).
 *
 * Der Bereich Agenten ersetzt diese Datei. Bis dahin sagt die Kachel ehrlich,
 * dass sie noch nichts zeigt -- keine erfundene Liste, keine Beispielagenten.
 *
 * Schnittstelle (Vertrag 2): export function mount(el, ctx) -> { unmount() }
 */

export function mount(el, ctx) {
  const { h, text, clear, icons, tileHead } = ctx;
  el.append(
    tileHead({ icon: icons.agents, title: 'Agenten aktiv', meta: 'Automatisch erkannt', href: '#/agents' }),
    h('div.tile__body', null,
      h('p.tile__empty', null, text('Noch leer. Sobald ein Agent für dich arbeitet, steht er hier.'))));
  return {
    unmount() {
      clear(el);
    },
  };
}
