/**
 * views/backup.js -- die alte Adresse „#/backup", nichts weiter.
 *
 * Die Sicherung ist im Bereich „Stick" aufgegangen (web/views/stick.js):
 * „Jetzt sichern" und darunter „Von einer Sicherung wiederherstellen".
 *
 * WARUM es diese Datei trotzdem noch gibt: die Schale (web/app.js, VIEWS)
 * fuehrt „backup" weiter als Adresse, und die Einstellungen
 * (web/views/settings.js) springen mit navigate('/backup') hierher. Ohne
 * diese Datei stuende dort „Sicherung ist nicht verfügbar – das Modul konnte
 * nicht geladen werden". Beide Dateien gehoeren anderen Bereichen; sobald
 * „backup" dort verschwunden ist, kann diese Datei weg.
 *
 * `location.replace` statt navigate(): die alte Adresse bleibt nicht im
 * Verlauf stehen, sonst fuehrte „Zurück" immer wieder hierher und von hier
 * sofort wieder weiter.
 */

export default {
  id: 'backup',
  title: 'Sicherung',

  mount() {
    const { pathname, search } = window.location;
    window.location.replace(`${pathname}${search}#/stick`);
  },

  unmount() {},
};
