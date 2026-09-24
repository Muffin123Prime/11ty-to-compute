'use strict';

const crypto = require('node:crypto');
const os = require('node:os');

/**
 * Wer ist "dieser Rechner", und seit wann läuft er?
 *
 * Ein Stick wandert zwischen Rechnern. Eine Sperrdatei, die ein anderer
 * Laptop (oder derselbe vor dem letzten Neustart) hinterlassen hat, darf den
 * Start nicht blockieren, und ein beobachteter Ordner auf der Festplatte von
 * Laptop A darf an Laptop B nicht eingelesen werden. Dafür reichen zwei
 * Merkmale, die ohne Kindprozess und ohne Admin immer zu haben sind:
 *
 *  - der Rechnername (`os.hostname()`), gehasht, damit er nicht im Klartext
 *    auf einem Gegenstand steht, der verloren gehen kann;
 *  - die Bootzeit aus `os.uptime()`.
 *
 * MachineGuid/IOPlatformUUID wären eindeutiger, brauchen aber `reg.exe` bzw.
 * `ioreg`, und die sind an Schulrechnern oft gesperrt (Bauplan 0.2). Was der
 * Hash nicht unterscheiden kann (gleiche Schul-Images, gemeinsames
 * Einschalten), fängt die Gesundheitsabfrage aus Paket S ab.
 */

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Kleingeschrieben, weil Windows Rechnernamen ohne Groß/Klein vergleicht:
 * "LAPTOP-7" und "laptop-7" sind dieselbe Maschine und dürfen nicht zwei
 * Kennungen ergeben. `os` wird bei jedem Aufruf über das Modulobjekt gelesen,
 * damit Tests es gezielt ersetzen können.
 */
function rechnername() {
  try {
    return String(os.hostname() || '').toLowerCase();
  } catch {
    // In manchen Containern gibt es keinen Namen; dann ist es eben "".
    return '';
  }
}

/**
 * Kennung des Rechners, für Sperren (`data/.lock`, `vault/.lock`).
 * Bewusst ohne Benutzer: Eine Sperre schützt vor einem zweiten Prozess auf
 * derselben Maschine, egal unter welchem Konto er läuft.
 * @returns {string} 16 Hex-Zeichen
 */
function kennung() {
  return sha256(`nos-rechner|${rechnername()}`).slice(0, 16);
}

/**
 * Kennung von Rechner **und** Benutzerkonto, für beobachtete Ordner (Paket O).
 * `C:\Users\max\Dokumente` ist auf demselben Laptop unter einem anderen Konto
 * ein anderer Ordner, deshalb gehört der Benutzer hier dazu.
 * `os.userInfo()` wirft, wenn das Konto keinen Eintrag in der
 * Benutzerdatenbank hat (Container, manche Domänen-Konten); dann zählt ''.
 * @returns {string} 16 Hex-Zeichen
 */
function profil() {
  let benutzer = '';
  try {
    benutzer = String(os.userInfo().username || '');
  } catch {
    benutzer = '';
  }
  return sha256(`nos-profil|${rechnername()}|${benutzer}`).slice(0, 16);
}

/**
 * Wann dieser Rechner gestartet wurde, in Sekunden seit 1970.
 * Eine Sperre aus einem früheren Start ist verwaist, auch wenn ihre PID
 * zufällig wieder vergeben ist. Die Zahl schwankt um ein bis zwei Sekunden
 * (Rundung, Uhrabgleich); `gleicherStart` gleicht das aus.
 * @returns {number}
 */
function bootZeit() {
  return Math.round(Date.now() / 1000 - os.uptime());
}

/**
 * Stammen zwei Bootzeiten vom selben Start? 120 s Spielraum, weil ein
 * Uhrabgleich (NTP, Sommerzeit bei manchen VMs) die errechnete Bootzeit
 * verschiebt, ein echter Neustart aber nie in unter zwei Minuten gelingt,
 * ohne dass die Sperre ohnehin an der toten PID scheitert.
 *
 * Nur echte Zahlen zählen: Eine alte Sperre ohne `boot` ist nie "derselbe
 * Start" (sonst ergäbe `null` über die Zahlumwandlung 0 und damit Zufall).
 * @param {number} a @param {number} b
 * @returns {boolean}
 */
function gleicherStart(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 120;
}

module.exports = { kennung, profil, bootZeit, gleicherStart };
