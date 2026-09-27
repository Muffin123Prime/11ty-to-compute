'use strict';

/**
 * Claude als Teilsystem: Schlüssel, Zustand, Modellwahl, Verbrauch.
 *
 * Das Gemeinsame mit Gemini (Tresor-Datei, Probeaufruf, Freigabe des Hosts,
 * Verbrauch) steht in src/models/anbieter-dienst.js; hier steht nur, was
 * Claude eigen ist: Sätze, Schlüsselform, Host. `createClaude` bleibt der
 * Name, den Tests und Werkzeuge kennen.
 */

const anbieter = require('./providers/anthropic');
const { ValidationError } = require('../kernel/errors');
const { createAnbieterDienst } = require('./anbieter-dienst');

const SCHLUESSEL_DATEI = 'claude-schluessel.json';
const VERBRAUCH_DATEI = 'claude-verbrauch.json';

/** Was in der Oberfläche steht, wenn Claude nicht antworten kann -- je Grund ein Satz. */
const GRUENDE = Object.freeze({
  'kein-schluessel': 'Claude ist nicht verbunden. Unter Einstellungen → KI den Schlüssel einfügen.',
  gesperrt: 'Der Tresor ist gesperrt. Erst mit der PIN entsperren, dann kann Claude antworten.',
  offline: 'Offline — Claude ist gerade nicht erreichbar. Schalte auf „Online“, dann antwortet Claude.',
  gesperrtDurchSchleuse: 'Die Schleuse lässt api.anthropic.com nicht durch. Unter Netzwerk freigeben.',
  'schluessel-falsch': 'Der Claude-Schlüssel stimmt nicht (mehr). Bitte unter Einstellungen → KI neu eingeben.',
});

const ANLEITUNG = [
  'So verbindest du Claude:',
  '',
  '  1. Auf console.anthropic.com anmelden und unter „API Keys“ einen Schlüssel erzeugen.',
  '  2. In Neural OS unter Einstellungen → KI bei Claude den Schlüssel einfügen.',
  '  3. Oben auf „Online“ schalten. Neural OS prüft den Schlüssel sofort mit einem kleinen Probeaufruf.',
  '',
  'Ohne KI erfindet Neural OS keine Antworten. Notizen, Kalender, Projekte und die Suche funktionieren trotzdem.',
].join('\n');

function schluesselPruefen(roh) {
  if (typeof roh !== 'string') throw new ValidationError('Bitte den Claude-Schlüssel einfügen.');
  const s = roh.trim();
  if (!s) throw new ValidationError('Bitte den Claude-Schlüssel einfügen.');
  if (/\s/.test(s)) throw new ValidationError('Im Schlüssel steht ein Leerzeichen oder Zeilenumbruch. Bitte genau so einfügen, wie er in der Konsole steht.');
  if (s.length < 20 || s.length > 400) throw new ValidationError('Das sieht nicht nach einem Claude-Schlüssel aus (die beginnen mit „sk-ant-“).');
  if (!/^[\x21-\x7e]+$/.test(s)) throw new ValidationError('Im Schlüssel stehen Zeichen, die dort nicht hingehören.');
  return s;
}

const PROFIL = Object.freeze({
  id: 'claude',
  name: 'Claude',
  praefix: 'CLAUDE',
  modul: anbieter,
  schluesselDatei: SCHLUESSEL_DATEI,
  verbrauchDatei: VERBRAUCH_DATEI,
  gruende: GRUENDE,
  anleitung: ANLEITUNG,
  kostenlos: false,
  verbrauchHinweis: 'Geschätzt aus den Token-Angaben der Antworten und den Listenpreisen. Die Rechnung stellt Anthropic.',
  schluesselPruefen,
  sperrMuster: 'anthropic.com',
});

/**
 * @param {object} deps  siehe createAnbieterDienst; `basis` und `anbieter` nur für Tests
 */
function createClaude(deps = {}) {
  return createAnbieterDienst(PROFIL, deps);
}

module.exports = { createClaude, PROFIL, ANLEITUNG, GRUENDE, SCHLUESSEL_DATEI, VERBRAUCH_DATEI };
