/**
 * widgets/notizen.js -- Kachel "Notizen" (Platzhalter der Schale).
 *
 * Der Bereich Notizen ersetzt diese Datei (neueste Notiz mit
 * data.source = 'auto'). Bis dahin sagt die Kachel ehrlich, dass sie noch
 * nichts zeigt.
 *
 * Schnittstelle (Vertrag 2): export function mount(el, ctx) -> { unmount() }
 */

export function mount(el, ctx) {
  const { h, text, clear, icons, tileHead } = ctx;
  el.append(
    tileHead({ icon: icons.notes, title: 'Notizen', meta: 'Automatisch erkannt', href: '#/notes' }),
    h('div.tile__body', null,
      h('p.tile__empty', null, text('Noch leer. Notizen, die aus dem Chat entstehen, erscheinen hier.'))));
  return {
    unmount() {
      clear(el);
    },
  };
}
