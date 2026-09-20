'use strict';

/**
 * Zero-dependency test harness.
 *
 * A test file either exports `{name, tests}` or simply calls `test()` at module
 * scope and exports nothing -- `run.js` collects whichever it finds.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const collected = [];

/** Register a test. @param {string} name @param {(t:object)=>any} fn */
function test(name, fn) {
  collected.push({ name, fn });
}

function drain() {
  const out = collected.slice();
  collected.length = 0;
  return out;
}

/**
 * Create an isolated temporary Neural OS home. Never touches the real one.
 * @returns {{home:string, cleanup:()=>void}}
 */
function tempHome(label = 'nos') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  return {
    home,
    cleanup() {
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** Await a bus event (or reject after `ms`). */
function waitForEvent(bus, name, ms = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bus.off(name, handler);
      reject(new Error(`timed out waiting for bus event ${name}`));
    }, ms);
    function handler(evt) {
      clearTimeout(timer);
      bus.off(name, handler);
      resolve(evt);
    }
    bus.on(name, handler);
  });
}

/** Minimal local HTTP server for provider/gate tests (loopback only). */
function fakeServer(handler) {
  const http = require('node:http');
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { test, drain, tempHome, waitForEvent, fakeServer };
