'use strict';

/**
 * Der Statist für Wikipedia: ein Server auf 127.0.0.1, der die zwei
 * Anfragen von src/models/nachschlagen.js beantwortet --
 *   GET /w/api.php?action=query&list=search&srsearch=…   (Suche)
 *   GET /w/api.php?action=query&prop=extracts|info|pageimages&titles=…  (Kurztexte)
 * in der Form, die Wikipedia am 01.10.2026 echt geliefert hat (formatversion=2;
 * Antworten von de.wikipedia.org zu "Brandenburger Tor", gekürzt).
 *
 * Was er NICHT beweist: dass Wikipedia sich morgen noch genau so verhält.
 */

const http = require('node:http');

const ARTIKEL = {
  'Brandenburger Tor': {
    pageid: 11349,
    extract: 'Das Brandenburger Tor in Berlin ist ein frühklassizistisches Triumphtor, das an der Westflanke des quadratischen Pariser Platzes im Berliner Ortsteil Mitte steht. Es wurde 1789 bis 1793 nach Entwürfen von Carl Gotthard Langhans errichtet.',
    fullurl: 'https://de.wikipedia.org/wiki/Brandenburger_Tor',
    thumbnail: { source: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/11/BerlinBrandenburgerTor1985.jpg/500px-BerlinBrandenburgerTor1985.jpg', width: 480, height: 288 },
  },
  'Brandenburger Tor (Potsdam)': {
    pageid: 593912,
    extract: 'Das Brandenburger Tor am Luisenplatz in Potsdam wurde 1770/1771 von Carl von Gontard und Georg Christian Unger gebaut.',
    fullurl: 'https://de.wikipedia.org/wiki/Brandenburger_Tor_(Potsdam)',
  },
  Photosynthesis: {
    pageid: 24544,
    extract: 'Photosynthesis is a system of biological processes by which photosynthetic organisms convert light energy into chemical energy.',
    fullurl: 'https://en.wikipedia.org/wiki/Photosynthesis',
  },
};

/** Welche Titel eine Suche findet (je Sprache). */
const SUCHE = {
  de: { 'brandenburger tor': ['Brandenburger Tor', 'Brandenburger Tor (Potsdam)'] },
  en: { photosynthese: ['Photosynthesis'] },
};

function starten({ sprache = 'de' } = {}) {
  const anfragen = [];
  const schlange = []; // {status, json, koepfe} für die nächsten Anfragen (Fehler)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://statist');
    const p = Object.fromEntries(url.searchParams.entries());
    anfragen.push({ pfad: url.pathname, p, koepfe: { ...req.headers } });
    const json = (code, obj, koepfe = {}) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...koepfe });
      res.end(JSON.stringify(obj));
    };
    const n = schlange.shift();
    if (n) { json(n.status, n.json || {}, n.koepfe || {}); return; }
    if (url.pathname !== '/w/api.php' || p.action !== 'query' || p.format !== 'json' || p.formatversion !== '2') {
      json(400, { error: { code: 'badparams', info: 'Statist: unerwartete Anfrage' } });
      return;
    }
    if (p.list === 'search') {
      const titel = (SUCHE[sprache] || {})[String(p.srsearch || '').toLowerCase()] || [];
      json(200, {
        batchcomplete: true,
        query: {
          searchinfo: { totalhits: titel.length * 1000 + 871 },
          search: titel.map((t) => ({ ns: 0, title: t, pageid: ARTIKEL[t].pageid, snippet: `<span class="searchmatch">${t}</span> …` })),
        },
      });
      return;
    }
    if (String(p.prop || '').includes('extracts')) {
      const titel = String(p.titles || '').split('|').filter(Boolean);
      json(200, {
        batchcomplete: true,
        query: {
          pages: titel.map((t) => (ARTIKEL[t]
            ? { pageid: ARTIKEL[t].pageid, ns: 0, title: t, extract: ARTIKEL[t].extract, fullurl: ARTIKEL[t].fullurl, ...(ARTIKEL[t].thumbnail ? { thumbnail: ARTIKEL[t].thumbnail } : {}) }
            : { ns: 0, title: t, missing: true })),
        },
      });
      return;
    }
    json(400, { error: { code: 'badparams', info: 'Statist: unbekannte Abfrage' } });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        anfragen,
        weiter: (...a) => schlange.push(...a),
        close: () => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(r); }),
      });
    });
  });
}

module.exports = { starten, ARTIKEL };
