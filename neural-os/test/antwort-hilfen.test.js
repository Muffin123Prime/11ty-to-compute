'use strict';

/**
 * Die reinen Rechnungen rund um eine KI-Antwort (web/lib/antwort-hilfen.js,
 * web/lib/auswahl-menue.js `lage`, web/views/chat.js `fassungInhalt`): ohne
 * Browser, gegen genau den Quelltext, den der Browser holt (siehe
 * test/chat-ansicht.test.js: kopiert nach .mjs). Was nur im Browser zu
 * sehen ist -- Bausteine bedienen, Fassungen blaettern, markieren --,
 * beweist tools/chat-beweis.js mit Chromium.
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
  const { home, cleanup } = tempHome('nos-antwort-hilfen');
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
      hilfen: await import(pathToFileURL(path.join(home, 'lib', 'antwort-hilfen.mjs')).href),
      menue: await import(pathToFileURL(path.join(home, 'lib', 'auswahl-menue.mjs')).href),
      chat: await import(pathToFileURL(path.join(home, 'views', 'chat.mjs')).href),
    };
  } finally {
    cleanup();
  }
  return geladen;
}

test('Codeblöcke: dieselbe Zählung wie der Server (auch eingerückt, ~~~, offen), und eine Schnittstelle zerschneidet keinen Zaun', async () => {
  const { codebloecke, schnittSicher } = (await laden()).hilfen;
  const md = 'Vorher\n\n```js\nconst a = 1;\n```\n\n- Punkt\n\n  ~~~python\n  print(1)\n  ~~~\n\n> ```ui\n> {"typ":"mehr","inhalt":"x"}\n> ```\n\n```\nnoch offen';
  const b = codebloecke(md);
  assert.deepEqual(b.map((x) => [x.nr, x.lang, x.closed]), [[0, 'js', true], [1, 'python', true], [2, 'ui', true], [3, '', false]]);
  assert.equal(b[1].code, 'print(1)', 'die Einrückung der Liste gehört nicht zum Code');
  assert.equal(b[2].code, '{"typ":"mehr","inhalt":"x"}', 'das Zitatzeichen gehört nicht zum Code');
  assert.equal(b[3].ende, md.length, 'ein offener Block läuft bis ans Textende');
  // Mitten im ersten Block: die Stelle rückt hinter den Zaun.
  const mitten = md.indexOf('const a');
  assert.equal(schnittSicher(md, mitten), b[0].ende);
  assert.equal(schnittSicher(md, 3), 3, 'außerhalb bleibt die Stelle, wo sie ist');
  assert.equal(schnittSicher(md, md.indexOf('noch')), md.length, 'im offenen Block: ans Ende');
  assert.equal(schnittSicher(md, 10 ** 9), md.length);
});

test('Sprache erkennen: eindeutig oder gar nicht – lieber „Text“ als eine falsche Farbe', async () => {
  const { spracheErkennen, ausfuehrbar } = (await laden()).hilfen;
  assert.equal(spracheErkennen('const x = 1;\nfunction f(a) { return a; }\nconsole.log(f(x));'), 'javascript');
  assert.equal(spracheErkennen('def f(x):\n    return x\n\nif __name__ == "__main__":\n    print(f(1))'), 'python');
  assert.equal(spracheErkennen('#!/bin/bash\nsudo apt install git\ncd /tmp && ls -la | grep x'), 'bash');
  assert.equal(spracheErkennen('<!doctype html>\n<html><body><div>Hi</div></body></html>'), 'html');
  assert.equal(spracheErkennen('{"a": 1, "b": [1, 2]}'), 'json');
  assert.equal(spracheErkennen('SELECT name FROM kunden WHERE ort = \'Rom\' ORDER BY name'), 'SQL');
  assert.equal(spracheErkennen('name: Neural OS\nversion: 1\nlisten:\n  - a\n  - b'), 'YAML');
  assert.equal(spracheErkennen('Hinweis: Das ist nur ein Satz.'), '', 'ein Satz mit Doppelpunkt ist kein YAML');
  assert.equal(spracheErkennen('a'), '');
  assert.equal(spracheErkennen('Nimm 200 g Mehl und 3 Eier.'), '', 'Prosa bleibt Text');
  assert.equal(ausfuehrbar('js'), 'js');
  assert.equal(ausfuehrbar('JavaScript'), 'js');
  assert.equal(ausfuehrbar('html'), 'html');
  assert.equal(ausfuehrbar('python'), null, 'Python läuft im Sandkasten nicht – also kein Knopf');
  assert.equal(ausfuehrbar(''), null);
});

test('Vergleichen: wortweise über die längste gemeinsame Teilfolge, mit Zählung und ehrlichem Rückfall', async () => {
  const { wortUnterschied, lcsSchritte, woerter, geaenderteStelle } = (await laden()).hilfen;
  const d = wortUnterschied('Rom ist alt und laut.', 'Rom ist sehr alt und schön.');
  assert.equal(d.gleich, false);
  assert.deepEqual(d.teile.map((t) => [t.art, t.text]), [
    ['gleich', 'Rom ist '], ['neu', 'sehr '], ['gleich', 'alt und '], ['weg', 'laut'], ['neu', 'schön'], ['gleich', '.'],
  ]);
  assert.equal(d.weg, 1);
  assert.equal(d.neu, 2);
  assert.equal(wortUnterschied('gleich', 'gleich').gleich, true);
  assert.deepEqual(wortUnterschied('', '').teile, []);
  // Ein Wort in der Mitte: gemeinsamer Anfang und Ende bleiben ein Stück.
  const s = lcsSchritte(woerter('a b c d'), woerter('a b x d'));
  assert.deepEqual(s.map((x) => x.art + ':' + x.stueck), ['gleich:a', 'gleich: ', 'gleich:b', 'gleich: ', 'weg:c', 'neu:x', 'gleich: ', 'gleich:d']);
  assert.equal(lcsSchritte(['a', 'b'], ['c', 'd'], 1), null, 'zu groß: null, kein eingefrorener Tab');
  // Zu groß für die Tabelle: zeilenweise, und wenn auch das nicht geht, „alles anders“.
  const gross = wortUnterschied('a b\nc d', 'a b\nx d', { maxZellen: 1 });
  assert.ok(gross.teile.some((t) => t.art === 'weg') && gross.teile.some((t) => t.art === 'neu'));
  const st = geaenderteStelle('Der Hund schläft im Garten.', 'Der Hund spielt im Garten.');
  assert.equal(st.text, 'spielt');
  assert.equal(geaenderteStelle('x', 'x').text, '');
});

test('Die Sätze an die KI und die Namen der Fassungen sind an einer Stelle', async () => {
  const { codeFrage, stellenFrage, stellenAuftrag, abschnittFrage, zitat, fassungsName, lesbar, UMWANDELN, STELLEN_AKTIONEN, NEU_VARIANTEN, SPRACHEN } = (await laden()).hilfen;
  assert.match(codeFrage('erklaeren', 'js', 'let a = `x`'), /^Erkläre mir diesen Code Schritt für Schritt:\n\n```js\nlet a = `x`\n```$/);
  assert.match(codeFrage('fehler', '', 'x'), /^Such in diesem Code nach Fehlern/);
  assert.ok(codeFrage('erklaeren', 'md', 'a ```` b').startsWith('Erkläre mir diesen Code Schritt für Schritt:\n\n`````md'), 'der Zaun ist länger als jede Backtick-Folge im Code');
  assert.equal(stellenFrage('zusammenfassen', 'Eins\nZwei'), 'Fasse diese Stelle aus deiner Antwort kurz zusammen:\n\n> Eins\n> Zwei');
  assert.match(stellenFrage('erklaeren', 'x'), /^Erkläre mir diese Stelle/);
  assert.equal(stellenAuftrag('kuerzen', 'Lang.'), 'Kürze diese Stelle deiner Antwort auf das Wesentliche:\n\n> Lang.');
  assert.match(stellenAuftrag('uebersetzen', 'Hallo', 'Englische'), /ins Englische:\n\n> Hallo$/);
  assert.match(stellenAuftrag('irgendwas', 'x'), /^Überarbeite diese Stelle/);
  assert.equal(abschnittFrage('  Dein   Lernplan ', 'Warum Montag?'), 'Zum Abschnitt „Dein Lernplan“ deiner Antwort: Warum Montag?');
  assert.equal(zitat('a'.repeat(20), 10), `> ${'a'.repeat(10)} …`);
  assert.equal(fassungsName({ art: 'original' }), 'Original');
  assert.equal(fassungsName({ art: 'neu', anweisung: 'kuerzer' }), 'Kürzer');
  assert.equal(fassungsName({ art: 'neu', anweisung: 'stil' }), 'Neuer Stil');
  assert.equal(fassungsName({ art: 'neu' }), 'Neu erstellt');
  assert.equal(fassungsName({ art: 'umgewandelt', anweisung: 'tabelle' }), 'Als Tabelle');
  assert.equal(fassungsName({ art: 'umgewandelt', anweisung: 'uebersetzen', sprache: 'Englische' }), 'Übersetzt ins Englische');
  assert.equal(fassungsName({ art: 'umgewandelt', anweisung: 'kuerzen', auswahl: true }), 'Stelle: kürzen');
  assert.equal(fassungsName({ art: 'bearbeitet', anweisung: 'block' }), 'Block bearbeitet');
  assert.equal(fassungsName(undefined), 'Original');
  assert.equal(lesbar('## Titel\n\n- **fett** und [Link](http://x)\n\n```js\ncode\n```'), 'Titel fett und Link code');
  assert.equal(UMWANDELN.length, 9);
  assert.deepEqual(UMWANDELN.filter((u) => u.gruppe === 'form').map((u) => u.anweisung), ['tabelle', 'diagramm', 'checkliste', 'schritte', 'wichtigste', 'nurtext']);
  assert.deepEqual(STELLEN_AKTIONEN.map((a) => a.id), ['erklaeren', 'kuerzen', 'umschreiben', 'uebersetzen', 'verbessern', 'zusammenfassen', 'frage']);
  assert.equal(NEU_VARIANTEN[0].variante, null, 'der erste Eintrag ist „einfach noch einmal“');
  assert.ok(SPRACHEN.every((s) => /e$/.test(s.ziel)), 'die Zielform passt in „ins …“');
});

test('Das schwebende Menü bleibt im Fenster: unten, sonst oben, nie über den Rand', async () => {
  const { lage } = (await laden()).menue;
  const fenster = { breite: 800, hoehe: 600 };
  const rect = { left: 100, top: 100, right: 200, bottom: 120, width: 100, height: 20 };
  const g = { breite: 220, hoehe: 200 };
  assert.deepEqual(lage(rect, g, fenster), { links: 100, oben: 126, seite: 'unten' });
  // Am unteren Rand: nach oben.
  const unten = { left: 100, top: 560, right: 200, bottom: 580, width: 100, height: 20 };
  const l2 = lage(unten, g, fenster);
  assert.equal(l2.seite, 'oben');
  assert.equal(l2.oben, 560 - 6 - 200);
  // Rechts am Rand: nach links geschoben, mindestens 8 px Abstand.
  const rechts = { left: 700, top: 100, right: 790, bottom: 120, width: 90, height: 20 };
  assert.equal(lage(rechts, g, fenster).links, 800 - 220 - 8);
  assert.equal(lage({ left: -50, top: 10, right: 10, bottom: 20, width: 60, height: 10 }, g, fenster, { ausrichtung: 'mitte' }).links, 8);
});

test('Fassungen ansehen: die aktive ist `content`, eine durchgeblätterte kommt aus `versionen`', async () => {
  const { fassungInhalt, inselSchluessel } = (await laden()).chat;
  const m = { data: { content: 'AKTIV', version: 1, versionen: [{ inhalt: 'ALT', art: 'original' }, { inhalt: 'AKTIV', art: 'neu' }, { inhalt: 'SPÄTER', art: 'umgewandelt' }] } };
  assert.deepEqual(fassungInhalt(m), { inhalt: 'AKTIV', version: 1, aktiv: true, anzahl: 3 });
  assert.deepEqual(fassungInhalt(m, null), { inhalt: 'AKTIV', version: 1, aktiv: true, anzahl: 3 });
  assert.deepEqual(fassungInhalt(m, 1), { inhalt: 'AKTIV', version: 1, aktiv: true, anzahl: 3 }, 'die aktive angesehen ist die aktive');
  assert.deepEqual(fassungInhalt(m, 0), { inhalt: 'ALT', version: 0, aktiv: false, anzahl: 3 });
  assert.deepEqual(fassungInhalt(m, 2), { inhalt: 'SPÄTER', version: 2, aktiv: false, anzahl: 3 });
  assert.deepEqual(fassungInhalt(m, 9), { inhalt: 'AKTIV', version: 1, aktiv: true, anzahl: 3 }, 'eine Fassung, die es nicht gibt: die aktive');
  // Alte Sätze ohne Fassungen: genau eine.
  assert.deepEqual(fassungInhalt({ data: { content: 'x' } }), { inhalt: 'x', version: 0, aktiv: true, anzahl: 1 });
  assert.equal(inselSchluessel(1, 2, 'code'), inselSchluessel(1, 2, 'code'));
  assert.notEqual(inselSchluessel(1, 2, 'code'), inselSchluessel(2, 2, 'code'), 'andere Fassung, andere Insel');
  assert.notEqual(inselSchluessel(1, 2, 'code'), inselSchluessel(1, 2, 'code2'));
});

module.exports = { name: 'antwort-hilfen', tests: drain() };
