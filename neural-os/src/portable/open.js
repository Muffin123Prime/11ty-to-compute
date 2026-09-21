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
 *  - A failure is a shrug, not an error. The address is printed anyway.
 */

const { spawn } = require('node:child_process');

/** Only loopback. Anything else is refused rather than "fixed". */
function isLocalUrl(value) {
  let url;
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
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{opened:boolean, reason?:string}>} never rejects
 */
function openInBrowser(url, opts = {}) {
  return new Promise((resolve) => {
    if (!isLocalUrl(url)) {
      resolve({ opened: false, reason: 'Nur lokale Adressen werden geöffnet.' });
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
      child = spawn(command, args, { stdio: 'ignore', detached: true });
    } catch (err) {
      done({ opened: false, reason: err && err.message });
      return;
    }

    child.on('error', (err) => done({ opened: false, reason: err && err.message }));
    // The opener returns immediately on every platform; waiting for exit would
    // hang on the ones that hand off to a long-lived process.
    child.unref();
    const timer = setTimeout(() => done({ opened: true }), opts.timeoutMs || 300);
    if (timer.unref) timer.unref();
  });
}

module.exports = { openInBrowser, isLocalUrl };
