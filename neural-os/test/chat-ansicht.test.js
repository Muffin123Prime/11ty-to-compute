'use strict';

/**
 * Die reinen Funktionen der Chat-Oberflaeche, ohne Browser.
 *
 * web/** ist Browser-ESM ohne Bauschritt, dieses Paket ist CommonJS. Der Test
 * kopiert die Dateien deshalb unveraendert in ein Zeitverzeichnis und gibt
 * ihnen nur die Endung .mjs -- geprueft wird genau der Quelltext, den der
 * Browser holt. Was nur im Browser zu sehen ist (Rueckfragen antippen,
 * Kopieren, Stopp), beweist tools/chat-beweis.js mit Chromium.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, drain, tempHome } = require('./harness');

let geladen = null;
async function laden() {
  if (geladen) return geladen;
  const web = path.join(__dirname, '..', 'web');
  const { home, cleanup } = tempHome('nos-chat-ansicht');
  // Die Ordnerstruktur bleibt erhalten (lib/, lib/bausteine/, views/), damit
  // relative Importe wie '../lib/bausteine/index.js' unveraendert stimmen;
  // nur die Endung wird .mjs, damit Node die Dateien als ESM liest.
  const alsModul = (src) => src.replace(/(from\s+')(\.[^']+)\.js(')/g, (m, kopf, spec, ende) => `${kopf}${spec}.mjs${ende}`);
  const kopieBaum = (von, nach) => {
    fs.mkdirSync(nach, { recursive: true });
    for (const eintrag of fs.readdirSync(von, { withFileTypes: true })) {
      if (eintrag.isDirectory()) kopieBaum(path.join(von, eintrag.name), path.join(nach, eintrag.name));
      else if (eintrag.name.endsWith('.js')) {
        fs.writeFileSync(path.join(nach, eintrag.name.replace(/\.js$/, '.mjs')), alsModul(fs.readFileSync(path.join(von, eintrag.name), 'utf8')));
      }
    }
  };
  kopieBaum(path.join(web, 'lib'), path.join(home, 'lib'));
  fs.mkdirSync(path.join(home, 'views'), { recursive: true });
  fs.writeFileSync(path.join(home, 'views', 'chat.mjs'), alsModul(fs.readFileSync(path.join(web, 'views', 'chat.js'), 'utf8')));
  try {
    geladen = {
      chat: await import(pathToFileURL(path.join(home, 'views', 'chat.mjs')).href),
      agenten: await import(pathToFileURL(path.join(home, 'lib', 'agenten.mjs')).href),
    };
  } finally {
    cleanup();
  }
  return geladen;
}

const antwort = (content, data = {}) => ({ id: 'message_x', data: { role: 'assistant', status: 'complete', content, ...data } });

test('Karten: „Termin eingetragen · Do, 25. Sep · 15:00 · Zahnarzt“ – ohne Zeitzonen-Falle', async () => {
  const { agenten } = await laden();
  const { wirkungZeilen, terminWann } = agenten;
  const jahr = new Date().getFullYear();
  // Ein Tag in diesem Jahr, damit keine Jahreszahl angehängt wird.
  const tag = new Date(jahr, 8, 25);
  const kurz = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][tag.getDay()];
  const [z] = wirkungZeilen([{ id: 'event_a', typ: 'event', aktion: 'angelegt', titel: 'Zahnarzt', start: `${jahr}-09-25T15:00`, ganztaegig: false }]);
  assert.equal(z.label, 'Termin eingetragen');
  assert.equal(z.detail, `${kurz}, 25. Sep · 15:00 · Zahnarzt`);
  assert.equal(z.href, '#/kalender?id=event_a');
  // 23:30 Ortszeit bleibt am selben Tag (keine Deutung als UTC).
  assert.match(terminWann(`${jahr}-09-25T23:30`), /25\. Sep · 23:30$/);
  assert.match(terminWann(`${jahr}-09-25`, { ganztaegig: true }), /ganztägig$/);
  assert.match(terminWann(`${jahr}-09-25`, { ganztaegig: true, ende: `${jahr}-09-30` }), /25\. Sep – .*30\. Sep$/);
  assert.match(terminWann(`${jahr + 1}-01-02T09:00`), new RegExp(`${jahr + 1} · 09:00$`), 'ein anderes Jahr steht dabei');

  const geloescht = wirkungZeilen([{ id: 'event_b', typ: 'event', aktion: 'geloescht', titel: 'Alt', start: `${jahr}-09-25` , ganztaegig: true }])[0];
  assert.equal(geloescht.label, 'Termin gelöscht');
  assert.equal(geloescht.href, null, 'kein „Öffnen“ für etwas Gelöschtes');

  // Ein Projekt mit seinen Aufgaben ist EINE Karte.
  const projekt = wirkungZeilen([
    { id: 'project_p', typ: 'project', aktion: 'angelegt', titel: 'Umzug' },
    { id: 'task_1', typ: 'task', aktion: 'angelegt', titel: 'Kartons', projectId: 'project_p' },
    { id: 'task_2', typ: 'task', aktion: 'angelegt', titel: 'Transporter', projectId: 'project_p' },
  ]);
  assert.equal(projekt.length, 1);
  assert.equal(projekt[0].detail, 'Umzug · 2 Aufgaben');
  assert.equal(wirkungZeilen([{ id: 'memory_m', typ: 'memory', aktion: 'angelegt', titel: 'Geht in die 10b.' }])[0].href, '#/graph?focus=memory_m');
});

test('Agenten: Zustand, Dauer und Namen sind überall dieselben', async () => {
  const { agenten } = await laden();
  const { zustandVon, dauerText, rolle, uhrzeit, VERWAIST_MS } = agenten;
  const jetzt = Date.parse('2026-09-24T10:00:00Z');
  assert.equal(zustandVon({ zustand: 'laeuft', rolle: 'recherche', beginn: '2026-09-24T09:59:00Z' }, jetzt), 'laeuft');
  assert.equal(zustandVon({ status: 'running', rolle: 'kalender', startedAt: new Date(jetzt - VERWAIST_MS - 1000).toISOString() }, jetzt), 'unterbrochen',
    'wer seit einer Viertelstunde „läuft“, ist liegengeblieben');
  assert.equal(zustandVon({ status: 'running', rolle: 'planung', startedAt: '2026-09-23T10:00:00Z' }, jetzt), 'laeuft', 'eine Rückfrage darf warten');
  assert.equal(zustandVon({ status: 'failed' }, jetzt), 'fehler');
  assert.equal(zustandVon({ status: 'waiting-approval' }, jetzt), 'laeuft');
  assert.equal(zustandVon({ status: 'done' }, jetzt), 'fertig');
  assert.equal(dauerText(300), 'unter 1 s');
  assert.equal(dauerText(12400), '12 s');
  assert.equal(dauerText(125000), '2 min 5 s');
  assert.equal(dauerText(3900000), '1 h 5 min');
  assert.equal(dauerText(undefined), '');
  assert.equal(rolle('recherche').name, 'Recherche-Agent');
  assert.equal(rolle('gibtsnicht').name, 'Agent');
  const heute = new Date();
  heute.setHours(10, 24, 0, 0);
  assert.equal(uhrzeit(heute.toISOString(), new Date()), '10:24');
});

module.exports = { name: 'chat-ansicht', tests: drain() };
