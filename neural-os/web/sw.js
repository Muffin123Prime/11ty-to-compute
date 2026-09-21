/**
 * sw.js -- service worker for the application shell.
 *
 * Purpose and limits, stated plainly:
 *
 * - The shell (HTML, CSS, modules) is cached so the interface opens instantly
 *   and still opens when the server is stopped. It is a head start, not a
 *   feature: nothing here makes the application work offline in any sense
 *   beyond drawing its own frame -- the data lives in the server process.
 * - `/api/*` is **never** served from the cache. A cached `/api/status` would
 *   show yesterday's network mode as if it were current, and that indicator is
 *   the one thing in this app that must never be a guess. API requests go to
 *   the network; when the network fails, the failure is passed on as a clean
 *   503 with a German message instead of an opaque browser error.
 * - `/api/events` is not intercepted at all. It is an endless SSE stream;
 *   passing it through a worker's fetch handler risks buffering, and any delay
 *   between "the server said it" and "the UI shows it" is a correctness bug
 *   here, not a performance one.
 *
 * A new version takes over only when the page asks for it (SKIP_WAITING), so
 * an open session is never served half of one build and half of another.
 */

const VERSION = 'v3';
const CACHE_NAME = `neural-os-shell-${VERSION}`;

/**
 * Only the files that are guaranteed to exist. View modules are cached
 * opportunistically once they are actually requested: they are built by
 * separate parts of the project and any of them may be absent, and a missing
 * entry in a precache list would fail the whole installation.
 */
const SHELL_ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  // Manifest und Startbildschirm-Symbol: ohne sie zeigt ein vom
  // Home-Bildschirm gestartetes Fenster beim ersten Start ohne Server ein
  // leeres Symbol -- also genau dort, wo der Cache etwas taugen soll.
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './lib/api.js',
  './lib/dom.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Individually, so one 404 cannot prevent the worker from installing.
    await Promise.allSettled(SHELL_ASSETS.map(async (asset) => {
      const request = new Request(asset, { cache: 'reload' });
      const response = await fetch(request);
      if (response && response.ok) await cache.put(asset, response.clone());
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith('neural-os-shell-') && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  // Anything not served by this server is none of this worker's business.
  if (url.origin !== self.location.origin) return;

  const accept = request.headers.get('accept') || '';
  // Never come between the browser and a live event stream.
  if (url.pathname === '/api/events' || accept.includes('text/event-stream')) return;

  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    event.respondWith(networkOnly(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigation(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

/** API: network, and an honest error when the network is not there. */
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch (err) {
    return new Response(JSON.stringify({
      error: {
        code: 'SERVER_UNREACHABLE',
        message: 'Der lokale Neural-OS-Server antwortet nicht. Die Oberfläche wurde aus dem Zwischenspeicher geladen, die Daten liegen aber im Serverprozess.',
        details: { path: new URL(request.url).pathname },
      },
    }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
}

/**
 * Navigations: the cached shell first, so the window paints immediately, with
 * a background refresh. index.html is tiny and carries no data, so serving a
 * slightly older copy costs nothing -- the modules it loads are versioned by
 * the cache name.
 */
async function navigation(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = (await cache.match('./index.html')) || (await cache.match('./'));
  if (cached) {
    refresh(cache, './index.html');
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put('./index.html', response.clone());
    return response;
  } catch {
    return new Response(
      '<!doctype html><html lang="de"><meta charset="utf-8">'
      + '<title>Neural OS nicht erreichbar</title>'
      + '<body style="font-family:ui-sans-serif,system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">'
      + '<h1>Neural OS ist nicht erreichbar</h1>'
      + '<p>Der lokale Server läuft gerade nicht. Starte ihn im Terminal mit <code>neural-os</code> '
      + 'und lade diese Seite neu. Deine Daten sind davon nicht betroffen: sie liegen als Dateien '
      + 'in deinem Neural-OS-Verzeichnis.</p></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

/** Shell assets and view modules: cache first, refreshed in the background. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    refresh(cache, request);
    return cached;
  }
  const response = await fetch(request);
  if (isCacheable(response)) cache.put(request, response.clone());
  return response;
}

/** Fire-and-forget revalidation; a failure here must never surface. */
function refresh(cache, request) {
  fetch(request, { cache: 'no-cache' })
    .then((response) => {
      if (isCacheable(response)) return cache.put(request, response.clone());
      return undefined;
    })
    .catch(() => {
      /* offline: the cached copy stays, which is exactly the point */
    });
}

function isCacheable(response) {
  return !!response
    && response.ok
    && response.status === 200
    && (response.type === 'basic' || response.type === 'default')
    && !(response.headers.get('cache-control') || '').includes('no-store');
}
