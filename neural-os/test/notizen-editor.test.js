'use strict';

/**
 * Die reinen Funktionen des Notiz-Editors und der Markdown-Erweiterungen,
 * ohne Browser:
 *   web/lib/editor.js   completionContext, applyCompletion, wrapSelection,
 *                       toggleLinePrefix, continueList, countText
 *   web/lib/markdown.js extractTasks, setzeHaken, calloutInfo, und dass
 *                       Callouts und Aufgaben beim Lesen erkannt werden
 *
 * web/** ist Browser-ESM ohne Bauschritt; die Dateien werden unveraendert in
 * ein Zeitverzeichnis kopiert und nur mit der Endung .mjs geladen (wie in
 * test/chat-ansicht.test.js). Was nur im Browser zu sehen ist (die Liste
 * nach "[[", der Klick auf "Anlegen"), beweist tools/ui-check.js.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, tempHome } = require('./harness');

let geladen = null;
async function laden() {
  if (geladen) return geladen;
  const web = path.join(__dirname, '..', 'web');
  const { home, cleanup } = tempHome('nos-notizen-editor');
  const alsModul = (src) => src.replace(/(from\s+')([^']+)\.js(')/g, (m, kopf, spec, ende) => `${kopf}./${path.basename(spec)}.mjs${ende}`);
  for (const datei of fs.readdirSync(path.join(web, 'lib'))) {
    if (!datei.endsWith('.js')) continue;
    fs.writeFileSync(path.join(home, datei.replace(/\.js$/, '.mjs')), alsModul(fs.readFileSync(path.join(web, 'lib', datei), 'utf8')));
  }
  try {
    geladen = {
      editor: await import(pathToFileURL(path.join(home, 'editor.mjs')).href),
      markdown: await import(pathToFileURL(path.join(home, 'markdown.mjs')).href),
    };
  } finally {
    cleanup();
  }
  return geladen;
}

/* ------------------------------------------------------ Editor */

test('completionContext: "[[" oeffnet die Linkliste, "#" die Schlagwortliste, sonst nichts', async () => {
  const { completionContext: ctx } = (await laden()).editor;
  const t = 'Siehe [[Photo';
  assert.deepEqual(ctx(t, t.length), { kind: 'link', start: 8, query: 'Photo' });
  assert.deepEqual(ctx('Siehe [[', 8), { kind: 'link', start: 8, query: '' });
  assert.equal(ctx('Siehe [[Photosynthese]] und', 27), null, 'ein geschlossener Link ist keiner mehr');
  assert.deepEqual(ctx('[[a]] und [[b', 13), { kind: 'link', start: 12, query: 'b' }, 'der letzte offene zaehlt');
  assert.equal(ctx('[[Photo\nsynthese', 16), null, 'ein Link geht nicht ueber die Zeile');

  assert.deepEqual(ctx('Text #bio', 9), { kind: 'tag', start: 6, query: 'bio' });
  assert.deepEqual(ctx('Text #', 6), { kind: 'tag', start: 6, query: '' });
  assert.deepEqual(ctx('#bio', 4), { kind: 'tag', start: 1, query: 'bio' }, 'am Zeilenanfang mit Text: Schlagwort');
  assert.equal(ctx('#', 1), null, 'ein nacktes # am Zeilenanfang wird eine Ueberschrift');
  assert.equal(ctx('## Tit', 6), null);
  assert.equal(ctx('a#b', 3), null, 'mitten im Wort ist # kein Schlagwort');
  assert.equal(ctx('#bio und', 8), null, 'nach dem Leerzeichen ist die Liste zu');
  assert.deepEqual(ctx('(#bio', 5), { kind: 'tag', start: 2, query: 'bio' });
  assert.deepEqual(ctx('[[Pho #x', 8), { kind: 'link', start: 2, query: 'Pho #x' }, 'im offenen Link gewinnt der Link');
  assert.equal(ctx('', 0), null);
  assert.equal(ctx(null, 5), null);
});

test('applyCompletion: setzt [[Titel]] bzw. #schlagwort ein und nimmt den halb getippten Rest mit', async () => {
  const { completionContext: ctx, applyCompletion: apply } = (await laden()).editor;
  let t = 'Siehe [[Photo und mehr';
  let r = apply(t, ctx(t, 13), 'Photosynthese');
  assert.equal(r.value, 'Siehe [[Photosynthese]] und mehr');
  assert.equal(r.caret, 23);
  assert.deepEqual([r.from, r.to, r.insert], [6, 13, '[[Photosynthese]]'], 'nur der Ausschnitt wird ersetzt');
  assert.equal(r.value.slice(0, r.from) + r.insert + r.value.slice(r.from + r.insert.length), r.value);

  t = 'Siehe [[Pho|to]] x'.replace('|', '');
  r = apply(t, ctx(t, 11), 'Photosynthese');
  assert.equal(r.value, 'Siehe [[Photosynthese]] x', 'Cursor mitten im Link: der Rest "to]]" geht mit');

  t = 'Text #bio';
  r = apply(t, ctx(t, 9), 'biologie');
  assert.equal(r.value, 'Text #biologie ', 'am Ende kommt ein Leerzeichen, damit es weitergeht');
  assert.equal(r.caret, r.value.length);
  t = 'Text #bio weiter';
  r = apply(t, ctx(t, 9), '#biologie');
  assert.equal(r.value, 'Text #biologie weiter', 'vor einem Leerzeichen kein zweites; ein fuehrendes # wird nicht verdoppelt');
  t = 'Text #biolo';
  r = apply(t, ctx(t, 8), 'biologie');
  assert.equal(r.value, 'Text #biologie ', 'der Rest des angefangenen Wortes hinter dem Cursor wird ersetzt');
});

test('wrapSelection: einfassen, wieder loesen, Wort am Cursor, leeres Paar', async () => {
  const { wrapSelection: wrap } = (await laden()).editor;
  let r = wrap('ein Wort hier', 4, 8, '**');
  assert.equal(r.value, 'ein **Wort** hier');
  assert.deepEqual([r.start, r.end], [6, 10], 'die Auswahl bleibt auf dem Wort');
  assert.deepEqual([r.from, r.to, r.insert], [4, 8, '**Wort**']);
  r = wrap(r.value, r.start, r.end, '**');
  assert.equal(r.value, 'ein Wort hier', 'noch einmal: wieder weg');
  assert.deepEqual([r.start, r.end], [4, 8]);
  r = wrap('ein **Wort** hier', 4, 12, '**');
  assert.equal(r.value, 'ein Wort hier', 'auch wenn die Sterne mit ausgewaehlt sind');
  r = wrap('ein Wort hier', 6, 6, '*');
  assert.equal(r.value, 'ein *Wort* hier', 'ohne Auswahl: das Wort am Cursor');
  r = wrap('ein  hier', 4, 4, '*');
  assert.equal(r.value, 'ein ** hier', 'in keinem Wort: ein leeres Paar');
  assert.deepEqual([r.start, r.end], [5, 5], 'Cursor in der Mitte');
  r = wrap('Wörter mit Umlaut', 0, 0, '**');
  assert.equal(r.value, '**Wörter** mit Umlaut');
});

test('toggleLinePrefix: Listen, Aufgaben, Ueberschriften, Zitate -- setzen und nehmen', async () => {
  const { toggleLinePrefix: lines } = (await laden()).editor;
  const clear = /^(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/;
  let r = lines('eins\nzwei\n\ndrei', 0, 15, '- ', { pattern: /^[-*+]\s(?!\[)/, clear });
  assert.equal(r.value, '- eins\n- zwei\n\n- drei', 'leere Zeilen bleiben leer');
  assert.deepEqual([r.from, r.to, r.insert], [0, 15, '- eins\n- zwei\n\n- drei']);
  r = lines(r.value, r.start, r.end, '- ', { pattern: /^[-*+]\s(?!\[)/, clear });
  assert.equal(r.value, 'eins\nzwei\n\ndrei', 'alle haben es: weg damit');
  r = lines('- eins\n- zwei', 0, 13, '1. ', { ordered: true, pattern: /^\d{1,9}[.)]\s/, clear });
  assert.equal(r.value, '1. eins\n2. zwei', 'aus Punkten werden Nummern');
  r = lines('1. eins\n2. zwei', 0, 15, '- [ ] ', { pattern: /^[-*+]\s\[[ xX]\]\s/, clear: /^(?:[-*+]|\d{1,9}[.)])\s+/ });
  assert.equal(r.value, '- [ ] eins\n- [ ] zwei', 'aus Nummern werden Aufgaben');
  r = lines('Titel', 2, 2, '## ', { pattern: /^##\s/, clear: /^#{1,6}\s+/ });
  assert.equal(r.value, '## Titel');
  assert.deepEqual([r.start, r.end], [5, 5], 'der Cursor rueckt mit');
  r = lines('### Titel', 4, 4, '## ', { pattern: /^##\s/, clear: /^#{1,6}\s+/ });
  assert.equal(r.value, '## Titel', 'eine andere Ebene wird ersetzt, nicht gestapelt');
  r = lines('## Titel', 3, 3, '## ', { pattern: /^##\s/, clear: /^#{1,6}\s+/ });
  assert.equal(r.value, 'Titel');
  r = lines('a\nb\n', 0, 4, '> ', { pattern: /^>\s?/ });
  assert.equal(r.value, '> a\n> b\n', 'die Auswahl endet nach dem Umbruch: die leere Zeile danach bleibt');
  r = lines('', 0, 0, '- ', { pattern: /^[-*+]\s/ });
  assert.equal(r.value, '- ', 'ein leerer Text bekommt den Punkt');
});

test('continueList: Enter setzt Listen fort, zaehlt weiter, haelt Aufgaben und beendet leere Punkte', async () => {
  const { continueList: weiter } = (await laden()).editor;
  let r = weiter('- eins', 6);
  assert.deepEqual(r, { start: 6, end: 6, insert: '\n- ', caret: 9 });
  r = weiter('  - [ ] eins', 12);
  assert.equal(r.insert, '\n  - [ ] ', 'Einzug und Aufgabe bleiben');
  r = weiter('3. drei', 7);
  assert.equal(r.insert, '\n4. ');
  r = weiter('3) drei', 7);
  assert.equal(r.insert, '\n4) ');
  r = weiter('* x\n- [x] fertig', 15);
  assert.equal(r.insert, '\n- [ ] ', 'nach einer erledigten Aufgabe kommt eine offene');
  r = weiter('- eins\n- ', 9);
  assert.deepEqual(r, { start: 7, end: 9, insert: '', caret: 7 }, 'ein leerer Punkt beendet die Liste');
  r = weiter('- eins\n- [ ] ', 13);
  assert.deepEqual(r, { start: 7, end: 13, insert: '', caret: 7 });
  assert.equal(weiter('nur Text', 8), null);
  assert.equal(weiter('-nicht', 6), null, 'ohne Leerzeichen ist es kein Punkt');
  r = weiter('- ei|ns'.replace('|', ''), 4);
  assert.equal(r.insert, '\n- ', 'mitten im Punkt: der Rest wandert in den neuen');
});

test('countText: Woerter und Zeichen', async () => {
  const { countText } = (await laden()).editor;
  assert.deepEqual(countText(''), { words: 0, chars: 0 });
  assert.deepEqual(countText('Ein  Satz\nmit Umbruch.'), { words: 4, chars: 22 });
  assert.deepEqual(countText(null), { words: 0, chars: 0 });
});

/* ---------------------------------------------------- Markdown */

test('extractTasks/setzeHaken: die n-te Aufgabe im Quelltext, in der Reihenfolge des Lesers', async () => {
  const { extractTasks, setzeHaken, extractPlain } = (await laden()).markdown;
  const src = '# Plan\n\n- [ ] Erste\n- [x] Zweite [[Photosynthese]]\n\n```\n- [ ] nicht zaehlen\n```\n\n> [!warning] Achtung\n> - [ ] Dritte im Zitat\n\n1. [ ] Vierte\n2. keine Aufgabe\n- [ ]\n\t- [ ] Fünfte\r\n';
  const tasks = extractTasks(src);
  assert.deepEqual(tasks.map((t) => [t.index, t.checked, t.text]), [
    [0, false, 'Erste'], [1, true, 'Zweite [[Photosynthese]]'], [2, false, 'Dritte im Zitat'], [3, false, 'Vierte'], [4, false, 'Fünfte'],
  ], 'Codeblock und "- [ ]" ohne Text zaehlen nicht -- genau wie beim Lesen');
  // "- [ ]" ohne Text ist auch fuer den Leser keine Aufgabe, sondern ein Punkt mit dem Text "[ ]".
  assert.ok(extractPlain('- [ ]\n- [ ] echt').startsWith('• [ ]'));
  assert.ok(extractPlain('- [ ] echt').startsWith('[ ] echt'));

  const zu = setzeHaken(src, 2, true);
  assert.ok(zu.includes('> - [x] Dritte im Zitat'));
  assert.equal(zu.length, src.length, 'sonst aendert sich nichts, auch nicht das CRLF');
  assert.ok(zu.endsWith('\r\n'));
  const auf = setzeHaken(zu, 1, false);
  assert.ok(auf.includes('- [ ] Zweite [[Photosynthese]]'));
  assert.equal(setzeHaken(src, 4, true).split('\n')[15], '\t- [x] Fünfte\r', 'Tabs bleiben Tabs');
  assert.equal(setzeHaken(src, 99, true), src, 'gibt es nicht: unveraendert');
  assert.equal(setzeHaken('', 0, true), '');
  assert.equal(setzeHaken('- [ ] x', 0, true), '- [x] x');
});

test('Callouts: "> [!info] Titel" wird erkannt, Links und Schlagworte darin auch', async () => {
  const { calloutInfo, extractPlain, extractLinks } = (await laden()).markdown;
  assert.deepEqual(calloutInfo('warning'), { kind: 'warning', label: 'Achtung', tone: 'warn' });
  assert.deepEqual(calloutInfo('TIP'), { kind: 'tip', label: 'Tipp', tone: 'accent' });
  assert.deepEqual(calloutInfo('danger'), { kind: 'danger', label: 'Gefahr', tone: 'danger' });
  assert.deepEqual(calloutInfo('success'), { kind: 'success', label: 'Erledigt', tone: 'ok' });
  assert.deepEqual(calloutInfo('quote'), { kind: 'quote', label: 'Zitat', tone: 'neutral' });
  assert.deepEqual(calloutInfo('unbekannt'), { kind: 'unbekannt', label: 'Unbekannt', tone: 'accent' }, 'Unbekanntes wird gezeigt, nicht abgelehnt');
  assert.deepEqual(calloutInfo(''), { kind: '', label: 'Hinweis', tone: 'accent' });

  const src = '> [!info] Licht und [[Chlorophyll]]\n> Pflanzen brauchen #licht.\n\n> normales Zitat';
  assert.equal(extractPlain(src), 'Licht und Chlorophyll\nPflanzen brauchen #licht.\nnormales Zitat');
  assert.deepEqual(extractLinks(src), { wikiLinks: ['Chlorophyll'], tags: ['licht'] });
});
