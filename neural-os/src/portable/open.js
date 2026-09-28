'use strict';

/**
 * Open the local interface in the user's browser.
 *
 * This is the one place the application starts another program, and it earns
 * that by being what makes the stick usable: double-click the launcher, the
 * browser opens, you are in. Without it, a non-technical user is left with a
 * terminal window telling them to type an address.
 *
 * Three constraints keep it from becoming a liability:
 *
 *  - It only ever opens a LOOPBACK url. The address is rebuilt from parts and
 *    verified before use, so a value from config cannot turn this into a way
 *    to launch arbitrary things.
 *  - It is opt-in (`--open`), never automatic. A server started on purpose --
 *    as a background service, over ssh -- must not pop a window open.
 *  - A failure is not an error, but it is reported: the caller shows the
 *    address instead (a browser that did not open is the one case where the
 *    user needs it).
 *
 * Unter Windows läuft der Öffner als `cmd /c start "" <url>`: Ein `&` (oder
 * `|`, `<`, `>`, `^`, `%`, `"`) in der Adresse wäre für cmd ein zweiter
 * Befehl. Neural OS baut nie solche Adressen; kommt doch eine, wird sie
 * abgelehnt statt "repariert". `windowsHide`, damit kein cmd-Fenster
 * aufblitzt (Stick-Bauplan 0.3).
 *
 * NEURAL_OS_OEFFNER (nur für Tests und Werkzeuge): Statt eines Browsers wird
 * die Adresse als Zeile an diese Datei gehängt.
 */

const { spawn } = require('node:child_process');

/** Zeichen, die cmd.exe in `start "" <url>` als Steuerzeichen läse. */
const CMD_ZEICHEN = /[&|<>^%"\s]/;

/** Only loopback. Anything else is refused rather than "fixed". */
function isLocalUrl(value) {
  let url;
  if (CMD_ZEICHEN.test(String(value))) return false;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/**
 * @param {string} url
 * @param {{wartenMs?:number}} [opts] so lange wird auf das Ende des Öffners gewartet
 * @returns {Promise<{opened:boolean, reason?:string}>} never rejects
 */
function openInBrowser(url, opts = {}) {
  return new Promise((resolve) => {
    if (!isLocalUrl(url)) {
      resolve({ opened: false, reason: 'Nur lokale Adressen werden geöffnet.' });
      return;
    }

    const umgelenkt = process.env.NEURAL_OS_OEFFNER;
    if (umgelenkt) {
      try {
        require('node:fs').appendFileSync(umgelenkt, `${url}\n`);
        resolve({ opened: true, umgelenkt: true });
      } catch (err) {
        resolve({ opened: false, reason: err && err.message });
      }
      return;
    }

    let command;
    let args;
    if (process.platform === 'darwin') {
      command = 'open';
      args = [url];
    } else if (process.platform === 'win32') {
      // `start` is a cmd builtin, and the empty string is the window title --
      // without it cmd treats a quoted url as the title and opens nothing.
      command = 'cmd';
      args = ['/c', 'start', '', url];
    } else {
      command = 'xdg-open';
      args = [url];
    }

    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    } catch (err) {
      done({ opened: false, reason: err && err.message });
      return;
    }

    // Der Öffner (xdg-open, open, cmd start) übergibt und endet gleich; endet
    // er mit einem Fehler (kein Browser eingerichtet, Richtlinie), ist nichts
    // offen, und der Starter muss die Adresse zeigen (Prüfung von Welle 1).
    // Ein Öffner, der nach `wartenMs` noch läuft, hat an einen Browser
    // übergeben, der gerade startet: Das gilt als offen. Der Zeitgeber hält
    // Node bewusst am Leben: Mit unref endete der Starter, bevor „Fertig.
    // Dieses Fenster kann zu.“ geschrieben war (Prüfung Runde 1).
    const wartenMs = Number.isFinite(opts.wartenMs) ? opts.wartenMs : 3000;
    let gestartet = false;
    const timer = setTimeout(() => done(gestartet ? { opened: true } : { opened: false, reason: 'Der Öffner startet nicht.' }), wartenMs);
    const fertig = (result) => { clearTimeout(timer); done(result); };
    child.once('spawn', () => { gestartet = true; });
    child.on('error', (err) => fertig({ opened: false, reason: err && err.message }));
    child.once('exit', (code, signal) => {
      if (code === 0) fertig({ opened: true });
      else fertig({ opened: false, reason: signal ? `Der Öffner wurde beendet (${signal}).` : `Der Öffner endete mit Code ${code}.` });
    });
    child.unref();
  });
}

module.exports = { openInBrowser, isLocalUrl };
