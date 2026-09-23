/**
 * widgets/kalender.js -- Kachel "Kalender" (Platzhalter der Schale).
 *
 * Der Bereich Kalender ersetzt diese Datei (Termine ueber GET /api/events).
 * Bis dahin: das heutige Datum, das stimmt, und ein ehrliches "noch leer".
 *
 * Schnittstelle (Vertrag 2): export function mount(el, ctx) -> { unmount() }
 */

export function mount(el, ctx) {
  const { h, text, clear, icons, tileHead, formatDate } = ctx;
  const heute = `Heute, ${formatDate(new Date(), { day: 'numeric', month: 'short' })}`;
  el.append(
    tileHead({ icon: icons.calendar, title: 'Kalender', meta: heute, href: '#/kalender' }),
    h('div.tile__body', null,
      h('p.tile__empty', null, text('Noch leer. Termine, die im Chat entstehen, erscheinen hier.'))));
  return {
    unmount() {
      clear(el);
    },
  };
}
