'use strict';

/**
 * Was der Chat rund um die Antwort kann (docs/ANTWORT-BAUSTEINE.md 6):
 * Bilder und PDF anhaengen (web/lib/anhaenge.js), Sprechen statt Tippen
 * (web/lib/sprechen.js) und der Vorlese-Spieler (web/lib/vorlesen.js) --
 * hier ohne Browser, gegen genau den Quelltext, den der Browser holt
 * (kopiert nach .mjs, siehe test/chat-ansicht.test.js). Was nur im Browser
 * zu sehen ist (Leuchtkasten, Mikrofon, Hervorheben), beweist
 * tools/chat-beweis.js mit Chromium.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, tempHome } = require('./harness');
const serverAnhaenge = require('../src/models/anhaenge');

let geladen = null;
async function laden() {
  if (geladen) return geladen;
  const web = path.join(__dirname, '..', 'web');
  const { home, cleanup } = tempHome('nos-chat-einbau');
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
      anhaenge: await import(pathToFileURL(path.join(home, 'lib', 'anhaenge.mjs')).href),
      sprechen: await import(pathToFileURL(path.join(home, 'lib', 'sprechen.mjs')).href),
      vorlesen: await import(pathToFileURL(path.join(home, 'lib', 'vorlesen.mjs')).href),
      chat: await import(pathToFileURL(path.join(home, 'views', 'chat.mjs')).href),
    };
  } finally {
    cleanup();
  }
  return geladen;
}

/* ---------------------------------------------------------- Anhänge */

test('Anhänge: dieselben Grenzen und Bildarten wie der Server (src/models/anhaenge.js)', async () => {
  const { anhaenge } = await laden();
  assert.deepEqual([...anhaenge.BILD_ARTEN].sort(), [...serverAnhaenge.BILD_MIME].sort());
  assert.equal(anhaenge.PDF_ART, serverAnhaenge.PDF_MIME);
  assert.equal(anhaenge.MAX_BILD_BYTES, serverAnhaenge.MAX_BILD_BYTES);
  assert.equal(anhaenge.MAX_PDF_BYTES, serverAnhaenge.MAX_PDF_BYTES);
  assert.equal(anhaenge.MAX_JE_NACHRICHT, serverAnhaenge.MAX_ANHAENGE_JE_NACHRICHT);
});

test('Anhänge: Art nach der Angabe des Browsers, ohne Angabe nach der Endung; HEIC und ZIP gehen nicht', async () => {
  const { dateiArt } = (await laden()).anhaenge;
  assert.deepEqual(dateiArt({ name: 'foto.jpg', type: 'image/jpeg' }), { art: 'bild', mime: 'image/jpeg' });
  assert.deepEqual(dateiArt({ name: 'foto.jpg', type: 'image/jpg' }), { art: 'bild', mime: 'image/jpeg' }, 'image/jpg ist JPEG');
  assert.deepEqual(dateiArt({ name: 'a.webp', type: 'image/webp' }), { art: 'bild', mime: 'image/webp' });
  assert.deepEqual(dateiArt({ name: 'a.gif', type: 'image/gif' }), { art: 'bild', mime: 'image/gif' });
  assert.deepEqual(dateiArt({ name: 'Brief.PDF', type: '' }), { art: 'pdf', mime: 'application/pdf' }, 'leerer Typ: die Endung zählt');
  assert.deepEqual(dateiArt({ name: 'scan.png', type: 'application/octet-stream' }), { art: 'bild', mime: 'image/png' });
  assert.deepEqual(dateiArt({ name: 'blatt.pdf', type: 'application/pdf' }), { art: 'pdf', mime: 'application/pdf' });
  assert.equal(dateiArt({ name: 'notiz.md', type: '' }).art, 'text');
  assert.equal(dateiArt({ name: 'daten.csv', type: 'text/csv' }).art, 'text');
  assert.equal(dateiArt({ name: 'foto.heic', type: 'image/heic' }).art, null, 'HEIC nimmt der Server nicht');
  assert.equal(dateiArt({ name: 'archiv.zip', type: 'application/zip' }).art, null);
  assert.equal(dateiArt({ name: 'bild.jpg', type: 'text/plain' }).art, 'text', 'die Angabe des Browsers gilt vor der Endung');
});

test('Anhänge: Schnellaktionen hängen nur an der Art – Bild: vier, PDF: drei, beides zusammen: ein Zusammenfassen', async () => {
  const { schnellAktionen } = (await laden()).anhaenge;
  assert.deepEqual(schnellAktionen([]), []);
  assert.deepEqual(schnellAktionen([{ art: 'text' }]), [], 'Textdateien bekommen keine');
  const bild = schnellAktionen([{ art: 'bild' }]);
  assert.deepEqual(bild.map((a) => a.label), ['Erklären', 'Aufgaben lösen', 'Text erkennen', 'Zusammenfassen']);
  assert.match(bild[0].text, /auf dem Bild/);
  assert.match(schnellAktionen([{ art: 'bild' }, { art: 'bild' }])[0].text, /auf den Bildern/, 'Mehrzahl');
  const pdf = schnellAktionen([{ art: 'pdf' }]);
  assert.deepEqual(pdf.map((a) => a.label), ['Zusammenfassen', 'Wichtigste Begriffe', 'Kapitel']);
  assert.equal(pdf[0].text, 'Fass das PDF kurz zusammen.');
  assert.match(schnellAktionen([{ art: 'pdf' }, { art: 'pdf' }])[2].text, /die PDFs/);
  const beides = schnellAktionen([{ art: 'bild' }, { art: 'pdf' }]);
  assert.deepEqual(beides.map((a) => a.id), ['erklaeren', 'aufgaben', 'text', 'zusammenfassen', 'begriffe', 'kapitel']);
  assert.equal(beides.filter((a) => a.label === 'Zusammenfassen').length, 1);
  assert.equal(beides.find((a) => a.id === 'zusammenfassen').text, 'Fass die Anhänge kurz zusammen.');
  for (const a of [...bild, ...pdf, ...beides]) assert.ok(a.text.length > 10 && a.text.endsWith('.'), a.text);
});

test('Anhänge: die Adresse zum Ansehen ist die Route des Servers (GET /api/chats/:id/anhaenge/:fileId)', async () => {
  const { anhangUrl } = (await laden()).anhaenge;
  assert.equal(anhangUrl('chat_abc', 'file_x1'), '/api/chats/chat_abc/anhaenge/file_x1');
  assert.equal(anhangUrl('chat a/b', 'file?1'), '/api/chats/chat%20a%2Fb/anhaenge/file%3F1');
});

/* ---------------------------------------------------------- Sprechen */

test('Sprechen: das WAV aus dem Browser besteht die Prüfung des Servers (16 kHz, mono, 16 Bit, Dauer stimmt)', async () => {
  const { wavKodieren, bytesAlsBase64, ZIEL_RATE } = (await laden()).sprechen;
  // 2,5 s Ton bei 48 kHz in Stücken wie aus dem Mikrofon.
  const rate = 48000;
  const stuecke = [];
  const gesamt = rate * 2.5;
  for (let i = 0; i < gesamt; i += 4096) {
    const n = Math.min(4096, gesamt - i);
    const s = new Float32Array(n);
    for (let j = 0; j < n; j += 1) s[j] = 0.5 * Math.sin(((i + j) / rate) * 2 * Math.PI * 440);
    stuecke.push(s);
  }
  const wav = wavKodieren(stuecke, rate);
  const buf = Buffer.from(wav);
  assert.equal(buf.slice(0, 4).toString('latin1'), 'RIFF');
  assert.equal(buf.slice(8, 12).toString('latin1'), 'WAVE');
  assert.equal(buf.readUInt16LE(20), 1, 'PCM');
  assert.equal(buf.readUInt16LE(22), 1, 'eine Spur');
  assert.equal(buf.readUInt32LE(24), ZIEL_RATE);
  assert.equal(buf.readUInt16LE(34), 16);
  assert.equal(buf.readUInt32LE(40), ZIEL_RATE * 2.5 * 2, 'genau 2,5 s bei 16 kHz');
  const b64 = bytesAlsBase64(wav);
  assert.equal(b64, buf.toString('base64'), 'Base64 in Happen ist dasselbe wie am Stück');
  const geprueft = serverAnhaenge.wavPruefen(b64);
  assert.equal(geprueft.sekunden, 2.5);
  // Die Werte bleiben im Rahmen und sind nicht alle null.
  const pcm = new Int16Array(wav.buffer, 44);
  assert.ok(Math.max(...pcm.slice(0, 2000)) > 10000, 'der Ton ist drin');
  // Übersteuert: wird gekappt, nicht umgeklappt.
  const laut = wavKodieren([new Float32Array([2, -2, 1, -1])], 16000);
  assert.deepEqual([...new Int16Array(laut.buffer, 44)], [32767, -32768, 32767, -32768]);
  // Leer ist ein gültiger Kopf ohne Daten (der Server lehnt es mit Satz ab).
  assert.equal(wavKodieren([], 44100).length, 44);
});

test('Sprechen: welcher Weg gilt – Erkennung des Browsers, sonst Aufnahme für Gemini, sonst kein Knopf', async () => {
  const { sprechWeg, erkennungFehlerSatz, erkennungUntauglich } = (await laden()).sprechen;
  const mitMikro = { navigator: { mediaDevices: { getUserMedia() {} } }, AudioContext: function AC() {} };
  const sicher = (extra) => ({ isSecureContext: true, ...mitMikro, ...extra });
  assert.equal(sprechWeg({}, sicher({ webkitSpeechRecognition: function R() {} })), 'erkennung');
  assert.equal(sprechWeg({ transkribieren: true }, sicher({})), 'aufnahme', 'ohne Erkennung, mit Google-Schlüssel');
  assert.equal(sprechWeg({ transkribieren: false }, sicher({})), null, 'ohne Erkennung und ohne Google-Schlüssel: kein Knopf');
  assert.equal(sprechWeg({ transkribieren: true, nurAufnahme: true }, sicher({ SpeechRecognition: function R() {} })), 'aufnahme',
    'die Erkennung gibt es hier nur dem Namen nach: Aufnahme');
  assert.equal(sprechWeg({ transkribieren: true }, { ...mitMikro, isSecureContext: false, SpeechRecognition: function R() {} }), null,
    'http://<LAN-IP> ist kein sicherer Kontext: kein Mikrofon, kein Knopf');
  assert.equal(sprechWeg({ transkribieren: true }, sicher({ navigator: {} })), null, 'ohne getUserMedia keine Aufnahme');
  assert.equal(erkennungFehlerSatz('aborted'), null, 'selbst abgebrochen: still');
  assert.match(erkennungFehlerSatz('not-allowed'), /nicht erlaubt/);
  assert.match(erkennungFehlerSatz('no-speech'), /Nichts gehört/);
  assert.equal(erkennungUntauglich('network'), true);
  assert.equal(erkennungUntauglich('service-not-allowed'), true);
  assert.equal(erkennungUntauglich('not-allowed'), false, 'ein verbotenes Mikrofon hilft auch der Aufnahme nicht');
  assert.equal(erkennungUntauglich('no-speech'), false);
});

/* ---------------------------------------------------------- Vorlesen */

test('Vorlesen: Sätze enden an . ! ? … – nicht nach „z. B.“, „am 3.“, in 3.5 oder example.org; lange werden geteilt', async () => {
  const { saetzeTeilen } = (await laden()).vorlesen;
  assert.deepEqual(saetzeTeilen('Hallo Welt. Wie geht es dir? Gut!'), ['Hallo Welt.', 'Wie geht es dir?', 'Gut!']);
  assert.deepEqual(saetzeTeilen('Nimm z. B. Äpfel. Dann Birnen.'), ['Nimm z. B. Äpfel.', 'Dann Birnen.']);
  assert.deepEqual(saetzeTeilen('Am 3. Oktober ist frei. Schön.'), ['Am 3. Oktober ist frei.', 'Schön.']);
  assert.deepEqual(saetzeTeilen('Es kostet 3.5 Euro bei example.org heute. Ja.'), ['Es kostet 3.5 Euro bei example.org heute.', 'Ja.']);
  assert.deepEqual(saetzeTeilen('Er sagte: „Komm mit.“ Dann ging er.'), ['Er sagte: „Komm mit.“', 'Dann ging er.']);
  assert.deepEqual(saetzeTeilen('Zeile ohne Punkt\nNoch eine\n\n'), ['Zeile ohne Punkt', 'Noch eine'], 'eine Zeile ist ein Satz');
  assert.deepEqual(saetzeTeilen('Was nun … Weiter geht es.'), ['Was nun …', 'Weiter geht es.']);
  assert.deepEqual(saetzeTeilen(' — \n...'), [], 'nur Zeichen: nichts zu lesen');
  const lang = Array.from({ length: 30 }, (_, i) => `Teil ${i + 1} mit etwas Text`).join(', ');
  const teile = saetzeTeilen(`${lang}.`);
  assert.ok(teile.length >= 3, `${teile.length} Teile`);
  for (const t of teile) assert.ok(t.length <= 240, `${t.length} Zeichen`);
  assert.equal(teile.join(' ').replace(/\s+/g, ' '), `${lang}.`, 'geteilt wird nur an einem Komma, nichts geht verloren');
});

test('Vorlesen: gelesen wird, was man sieht – Bausteine als Text, kein Code, keine Aufzählungszeichen', async () => {
  const { chat, vorlesen } = await laden();
  assert.equal(vorlesen.sprechText('• Brot\n[x] Milch\n[ ] Eier\nTag | Thema\nMo | Brüche'), 'Brot\nMilch\nEier\nTag, Thema\nMo, Brüche');
  const md = '## Plan\n\nErst üben.\n\n```js\nconsole.log(1);\n```\n\n```ui\n{"typ":"checkliste","titel":"Diese Woche","punkte":["Brüche üben","Probe schreiben"]}\n```\n\nViel Erfolg!';
  const t = chat.vorleseText(md);
  assert.doesNotMatch(t, /console|\{|"typ"/, 'weder Code noch JSON');
  assert.match(t, /Plan/);
  assert.match(t, /Erst üben\./);
  assert.match(t, /Brüche üben/);
  assert.match(t, /Probe schreiben/);
  assert.match(t, /Viel Erfolg!/);
  assert.doesNotMatch(t, /\[ \]|•/, 'keine Kästchen, keine Punkte');
});

/** Eine nachgebaute Sprachausgabe: merkt sich, was gesprochen wird, und endet auf Zuruf. */
function falscheStimme() {
  const gesprochen = [];
  let abbrueche = 0;
  class Aeusserung {
    constructor(textInhalt) { this.text = textInhalt; this.rate = 1; this.lang = ''; }
  }
  const synth = {
    speak(u) { gesprochen.push(u); },
    cancel() {
      abbrueche += 1;
      const laufend = gesprochen[gesprochen.length - 1];
      if (laufend && !laufend.fertig && typeof laufend.onerror === 'function') {
        laufend.fertig = true;
        laufend.onerror({ error: 'interrupted' });
      }
    },
    getVoices: () => [{ lang: 'en-US', name: 'Englisch' }, { lang: 'de-DE', name: 'Anna', localService: true }],
  };
  const ende = () => {
    const u = gesprochen[gesprochen.length - 1];
    u.fertig = true;
    u.onend();
  };
  return { synth, Aeusserung, gesprochen, ende, abbrueche: () => abbrueche };
}

test('Vorlesen: Satz für Satz; Pause hält an, Weiter beginnt den Satz neu; ein neues Tempo gilt sofort; am Ende ist der Spieler weg', async () => {
  const { vorleser, TEMPI } = (await laden()).vorlesen;
  const f = falscheStimme();
  const v = vorleser({ synth: f.synth, Aeusserung: f.Aeusserung });
  const meldungen = [];
  v.abonnieren((z) => meldungen.push(z));
  assert.equal(v.start('m1', 'Eins. Zwei. Drei.'), true);
  assert.equal(f.gesprochen.length, 1);
  assert.equal(f.gesprochen[0].text, 'Eins.');
  assert.equal(f.gesprochen[0].lang, 'de-DE');
  assert.equal(f.gesprochen[0].voice.name, 'Anna', 'eine deutsche Stimme, die auf dem Gerät liegt');
  assert.deepEqual({ ...v.zustand() }, { id: 'm1', index: 0, anzahl: 3, satz: 'Eins.', spielt: true, tempo: 1 });
  f.ende();
  assert.equal(f.gesprochen[1].text, 'Zwei.');
  assert.equal(v.zustand().index, 1);
  v.pause();
  assert.equal(v.zustand().spielt, false);
  assert.equal(f.gesprochen.length, 2, 'die unterbrochene Äußerung löst keinen nächsten Satz aus');
  v.weiter();
  assert.equal(f.gesprochen[2].text, 'Zwei.', 'weiter heißt: diesen Satz noch einmal von vorn');
  v.tempo(1.5);
  assert.equal(f.gesprochen[3].text, 'Zwei.');
  assert.equal(f.gesprochen[3].rate, 1.5, 'das neue Tempo gilt ab sofort');
  v.tempo(3);
  assert.equal(v.zustand().tempo, 1.5, 'nur Tempi aus der Reihe');
  v.naechstesTempo();
  assert.equal(v.zustand().tempo, 2);
  v.naechstesTempo();
  assert.equal(v.zustand().tempo, TEMPI[0], 'nach 2× wieder 0,75×');
  f.ende();
  assert.equal(f.gesprochen[f.gesprochen.length - 1].text, 'Drei.');
  f.ende();
  assert.equal(v.zustand().id, null, 'nach dem letzten Satz ist Schluss');
  assert.equal(meldungen[meldungen.length - 1].id, null, 'und das wird gemeldet (der Spieler verschwindet)');
  // Stopp mitten drin; eine zweite Antwort ersetzt die erste.
  v.start('m1', 'A. B.');
  v.start('m2', 'C.');
  assert.equal(v.zustand().id, 'm2');
  assert.equal(f.gesprochen[f.gesprochen.length - 1].text, 'C.');
  v.stopp();
  assert.equal(v.zustand().id, null);
  assert.equal(v.start('m3', '   '), false, 'nichts zu lesen: kein Spieler');
});
