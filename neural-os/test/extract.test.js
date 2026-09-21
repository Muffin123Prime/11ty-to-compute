'use strict';

/**
 * Tests for src/store/extract.js.
 *
 * Every fixture is built here, in memory, from node:zlib and plain buffers:
 * no binary blobs in the repository, nothing written to disk, no temporary
 * home directory needed (this module never touches the filesystem) and
 * certainly no network. A hand-built docx and a hand-written PDF also prove
 * the parsers against the format, not against one exporter's output.
 */

const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { test, drain } = require('./harness');

const extract = require('../src/store/extract');
const { extractText, sniffKind } = extract;

/* ------------------------------------------------------------ fixtures */

/** A real zip container. `declaredSize` forges the size field, for bomb tests. */
function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const method = file.store ? 0 : 8;
    const body = method === 0 ? data : zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(file.name, 'utf8');
    const crc = typeof zlib.crc32 === 'function' ? zlib.crc32(data) >>> 0 : 0;
    const declared = file.declaredSize === undefined ? data.length : file.declaredSize;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.flags === undefined ? 0x800 : file.flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(file.flags === undefined ? 0x800 : file.flags, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(declared, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

/**
 * A minimal but genuinely valid PDF. Objects are numbered in array order;
 * `{dict, stream}` entries become stream objects with a correct /Length.
 */
function makePdf(objects, opts = {}) {
  const parts = [Buffer.from(`%PDF-${opts.version || '1.4'}\n`)];
  objects.forEach((obj, index) => {
    const num = index + 1;
    if (typeof obj === 'string') {
      parts.push(Buffer.from(`${num} 0 obj\n${obj}\nendobj\n`));
      return;
    }
    const body = Buffer.isBuffer(obj.stream) ? obj.stream : Buffer.from(obj.stream, 'latin1');
    parts.push(Buffer.from(`${num} 0 obj\n<< ${obj.dict} /Length ${body.length} >>\nstream\n`));
    parts.push(body, Buffer.from('\nendstream\nendobj\n'));
  });
  parts.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} ${opts.trailer || '/Root 1 0 R'} >>\n%%EOF\n`));
  return Buffer.concat(parts);
}

const flate = (text) => zlib.deflateSync(Buffer.from(text, 'latin1'));

/** One page, one content stream, one WinAnsi font: the common case. */
function onePagePdf(content, extra = {}) {
  return makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> ${extra.resources || ''} >> /Contents 4 0 R >>`,
    { dict: '/Filter /FlateDecode', stream: flate(content) },
    extra.font || '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    ...(extra.objects || []),
  ]);
}

function docxOf(bodyXml) {
  return makeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
    { name: 'word/document.xml', data: `<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body>${bodyXml}</w:body></w:document>` },
  ]);
}

const para = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

/* ------------------------------------------------------------- sniffing */

test('sniffKind entscheidet nach Magic Bytes, nicht nach der Dateiendung', () => {
  const docx = docxOf(para('Egal'));
  assert.equal(sniffKind(docx, 'bericht.docx'), 'docx');
  // The decisive case: a renamed file must not fool the dispatcher.
  assert.equal(sniffKind(docx, 'bericht.txt'), 'docx');
  assert.equal(sniffKind(onePagePdf('BT ET'), 'tabelle.xlsx'), 'pdf');
  assert.equal(sniffKind(Buffer.from('{\\rtf1\\ansi Hallo}'), 'notiz.md'), 'rtf');
  assert.equal(sniffKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), 'liste.csv'), 'image');
  assert.equal(sniffKind(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0]), 'notiz.txt'), 'binary');
  assert.equal(sniffKind(Buffer.from('Hallo Welt'), 'irgendwas'), 'text');
  assert.equal(sniffKind(Buffer.alloc(0), 'leer.txt'), 'empty');
});

test('sniffKind unterscheidet die ZIP-basierten Formate an ihrem Inhalt', () => {
  assert.equal(sniffKind(makeZip([{ name: 'xl/workbook.xml', data: '<workbook/>' }]), 'x'), 'xlsx');
  assert.equal(sniffKind(makeZip([{ name: 'ppt/presentation.xml', data: '<p/>' }]), 'x'), 'pptx');
  assert.equal(sniffKind(makeZip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
  ]), 'x'), 'epub');
  assert.equal(sniffKind(makeZip([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.spreadsheet', store: true },
  ]), 'x'), 'ods');
  assert.equal(sniffKind(makeZip([{ name: 'notizen.txt', data: 'hallo' }]), 'x'), 'zip');
});

test('sniffKind trennt HTML von XML und erkennt Fragmente', () => {
  assert.equal(sniffKind(Buffer.from('<!DOCTYPE html><html><body>x</body></html>'), 'a'), 'html');
  assert.equal(sniffKind(Buffer.from('<div><p>Hallo</p></div>'), 'a'), 'html');
  assert.equal(sniffKind(Buffer.from('<?xml version="1.0"?><note><to>Du</to></note>'), 'a'), 'xml');
});

/* ----------------------------------------------------------------- docx */

test('docx liefert Absätze als Zeilen und Tabellen als Zeilen mit Tabulatoren', () => {
  const doc = docxOf(
    `${para('Erster Absatz')}`
    + '<w:p><w:r><w:t xml:space="preserve">Zweiter </w:t><w:t>Absatz</w:t></w:r></w:p>'
    + '<w:tbl>'
    + `<w:tr><w:tc>${para('Monat')}</w:tc><w:tc>${para('Betrag')}</w:tc></w:tr>`
    + `<w:tr><w:tc>${para('Januar')}</w:tc><w:tc>${para('1200')}</w:tc></w:tr>`
    + '</w:tbl>'
    + para('Nach der Tabelle'),
  );
  const result = extractText(doc, { name: 'bericht.docx' });
  assert.equal(result.kind, 'docx');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.warnings, []);
  const lines = result.text.split('\n').filter(Boolean);
  assert.deepEqual(lines, ['Erster Absatz', 'Zweiter Absatz', 'Monat\tBetrag', 'Januar\t1200', 'Nach der Tabelle']);
});

test('docx berücksichtigt Tabulatoren, Zeilenumbrüche und keine gelöschten Passagen', () => {
  const doc = docxOf(
    '<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>'
    + '<w:p><w:r><w:delText>entfernt</w:delText><w:instrText>PAGE</w:instrText><w:t>geblieben</w:t></w:r></w:p>',
  );
  const { text } = extractText(doc, { name: 'a.docx' });
  assert.equal(text, 'A\tB\nC\ngeblieben');
});

test('docx respektiert maxBytes und meldet die Kürzung ehrlich', () => {
  const doc = docxOf(Array.from({ length: 500 }, (unused, i) => para(`Absatz Nummer ${i}`)).join(''));
  const result = extractText(doc, { name: 'lang.docx', maxBytes: 64 });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text, 'utf8') <= 64);
  assert.ok(result.text.startsWith('Absatz Nummer 0'));
  assert.ok(result.warnings.some((w) => /abgeschnitten/i.test(w)), result.warnings.join(' | '));
});

/* ----------------------------------------------------------------- xlsx */

test('xlsx liefert Zeilen als TSV, mit Blattnamen, Leerspalten und Zeichenketten', () => {
  const book = makeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="urn:r"><sheets><sheet name="Umsatz" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>Monat</t></si><si><t>Betrag</t></si><si><t>Januar</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>1234.5</v></c></row>'
      + '<row r="3"><c r="A3" t="inlineStr"><is><t>Februar</t></is></c><c r="B3" t="b"><v>1</v></c></row>'
      + '</sheetData></worksheet>' },
  ]);
  const result = extractText(book, { name: 'zahlen.xlsx' });
  assert.equal(result.kind, 'xlsx');
  assert.equal(result.pages, 1);
  const lines = result.text.split('\n');
  assert.deepEqual(lines, ['Umsatz', 'Monat\tBetrag', 'Januar\t\t1234.5', 'Februar\tWAHR']);
});

test('xlsx liest die Blätter in Arbeitsmappen-Reihenfolge, nicht in Dateireihenfolge', () => {
  const book = makeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="urn:r"><sheets>'
      + '<sheet name="Zweites" r:id="rId2"/><sheet name="Erstes" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships>'
      + '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row><c r="A1" t="str"><v>eins</v></c></row></sheetData></worksheet>' },
    { name: 'xl/worksheets/sheet2.xml', data: '<worksheet><sheetData><row><c r="A1" t="str"><v>zwei</v></c></row></sheetData></worksheet>' },
  ]);
  const { text, pages } = extractText(book, { name: 'reihenfolge.xlsx' });
  assert.equal(pages, 2);
  assert.deepEqual(text.split('\n'), ['Zweites', 'zwei', '', 'Erstes', 'eins']);
});

/* ----------------------------------------------------------------- pptx */

test('pptx liefert den Text je Folie mit Foliennummer in numerischer Reihenfolge', () => {
  const deck = makeZip([
    { name: 'ppt/presentation.xml', data: '<p:presentation/>' },
    { name: 'ppt/slides/slide10.xml', data: '<p:sld><p:txBody><a:p><a:r><a:t>Zehnte Folie</a:t></a:r></a:p></p:txBody></p:sld>' },
    { name: 'ppt/slides/slide2.xml', data: '<p:sld><p:txBody><a:p><a:r><a:t>Zweite Folie</a:t></a:r></a:p></p:txBody></p:sld>' },
    { name: 'ppt/slides/slide1.xml', data: '<p:sld>'
      + '<p:txBody><a:p><a:r><a:t>Titel</a:t></a:r></a:p></p:txBody>'
      + '<p:txBody><a:p><a:r><a:t>Untertitel</a:t></a:r></a:p></p:txBody></p:sld>' },
  ]);
  const result = extractText(deck, { name: 'vortrag.pptx' });
  assert.equal(result.kind, 'pptx');
  assert.equal(result.pages, 3);
  assert.deepEqual(result.text.split('\n').filter(Boolean), [
    'Folie 1', 'Titel', 'Untertitel',
    'Folie 2', 'Zweite Folie',
    'Folie 10', 'Zehnte Folie',
  ]);
});

/* ------------------------------------------------------------ odt, epub */

test('odt liest Überschriften, Absätze und Tabellenzeilen', () => {
  const doc = makeZip([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', store: true },
    { name: 'styles.xml', data: '<office:styles/>' },
    { name: 'content.xml', data: '<office:document-content><office:body><office:text>'
      + '<office:automatic-styles><style:style style:name="P1"/></office:automatic-styles>'
      + '<text:h text:outline-level="1">Überschrift</text:h>'
      + '<text:p>Ein Absatz mit <text:span>Auszeichnung</text:span>.</text:p>'
      + '<table:table><table:table-row>'
      + '<table:table-cell><text:p>links</text:p></table:table-cell>'
      + '<table:table-cell><text:p>rechts</text:p></table:table-cell>'
      + '</table:table-row></table:table>'
      + '</office:text></office:body></office:document-content>' },
  ]);
  const result = extractText(doc, { name: 'text.odt' });
  assert.equal(result.kind, 'odt');
  assert.deepEqual(result.text.split('\n').filter(Boolean), [
    'Überschrift', 'Ein Absatz mit Auszeichnung.', 'links\trechts',
  ]);
});

test('ods liefert je Tabellenblatt einen Namen und TSV-Zeilen', () => {
  const sheet = makeZip([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.spreadsheet', store: true },
    { name: 'styles.xml', data: '<office:styles/>' },
    { name: 'content.xml', data: '<office:document-content><office:body><office:spreadsheet>'
      + '<table:table table:name="Umsatz">'
      + '<table:table-row><table:table-cell><text:p>Monat</text:p></table:table-cell>'
      + '<table:table-cell><text:p>Betrag</text:p></table:table-cell></table:table-row>'
      + '<table:table-row><table:table-cell><text:p>Januar</text:p></table:table-cell>'
      + '<table:table-cell><text:p>1200</text:p></table:table-cell></table:table-row>'
      + '</table:table></office:spreadsheet></office:body></office:document-content>' },
  ]);
  const result = extractText(sheet, { name: 'zahlen.ods' });
  assert.equal(result.kind, 'ods');
  assert.equal(result.pages, 1);
  assert.deepEqual(result.text.split('\n'), ['Umsatz', 'Monat\tBetrag', 'Januar\t1200']);
});

test('docx und pptx nehmen mc:Fallback nicht zusätzlich zu mc:Choice', () => {
  // Word writes both variants of a text box; counting both duplicates the text.
  const doc = docxOf('<w:p><mc:AlternateContent>'
    + `<mc:Choice Requires="wps">${para('Textfeld')}</mc:Choice>`
    + `<mc:Fallback>${para('Textfeld')}</mc:Fallback>`
    + '</mc:AlternateContent></w:p>');
  assert.equal(extractText(doc, { name: 'textfeld.docx' }).text, 'Textfeld');

  const deck = makeZip([
    { name: 'ppt/presentation.xml', data: '<p:presentation/>' },
    { name: 'ppt/slides/slide1.xml', data: '<p:sld><mc:AlternateContent>'
      + '<mc:Choice><p:txBody><a:p><a:r><a:t>Einmal</a:t></a:r></a:p></p:txBody></mc:Choice>'
      + '<mc:Fallback><p:txBody><a:p><a:r><a:t>Einmal</a:t></a:r></a:p></p:txBody></mc:Fallback>'
      + '</mc:AlternateContent></p:sld>' },
  ]);
  assert.deepEqual(extractText(deck, { name: 'd.pptx' }).text.split('\n'), ['Folie 1', 'Einmal']);
});

test('epub folgt der Lesereihenfolge des Spine, nicht der Dateireihenfolge', () => {
  const book = makeZip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/buch.opf"/></rootfiles></container>' },
    { name: 'OEBPS/buch.opf', data: '<package><manifest>'
      + '<item id="k2" href="kapitel2.xhtml" media-type="application/xhtml+xml"/>'
      + '<item id="k1" href="kapitel1.xhtml" media-type="application/xhtml+xml"/>'
      + '<item id="stil" href="stil.css" media-type="text/css"/>'
      + '</manifest><spine><itemref idref="k1"/><itemref idref="k2"/></spine></package>' },
    { name: 'OEBPS/kapitel1.xhtml', data: '<html><body><h1>Kapitel eins</h1><p>Der Anfang.</p></body></html>' },
    { name: 'OEBPS/kapitel2.xhtml', data: '<html><body><h1>Kapitel zwei</h1><p>Das Ende.</p></body></html>' },
    { name: 'OEBPS/stil.css', data: 'body { color: black }' },
  ]);
  const result = extractText(book, { name: 'buch.epub' });
  assert.equal(result.kind, 'epub');
  assert.equal(result.pages, 2);
  assert.deepEqual(result.text.split('\n').filter(Boolean), [
    'Kapitel eins', 'Der Anfang.', 'Kapitel zwei', 'Das Ende.',
  ]);
  assert.ok(!result.text.includes('color'), 'Stylesheets gehören nicht in den Text');
});

/* ------------------------------------------------------------------ pdf */

test('pdf liest Tj, TJ, Hex-Strings und Oktal-Escapes', () => {
  const content = 'BT /F1 12 Tf 72 720 Td (Hallo Welt) Tj '
    + '0 -14 Td [(Zweite) -300 (Zeile)] TJ '
    + '0 -14 Td (Gr\\366\\337e) Tj '
    + '0 -14 Td <48616C6C6F> Tj ET';
  const result = extractText(onePagePdf(content), { name: 'brief.pdf' });
  assert.equal(result.kind, 'pdf');
  assert.equal(result.pages, 1);
  assert.deepEqual(result.text.split('\n'), ['Hallo Welt', 'Zweite Zeile', 'Größe', 'Hallo']);
});

test('pdf macht aus TJ-Abständen Leerzeichen, aber nicht aus Unterschneidung', () => {
  // -300 is word spacing, -20 is kerning inside a word: only one becomes a space.
  const content = 'BT /F1 12 Tf 10 700 Td [(Wort) -300 (Abstand)] TJ 0 -14 Td [(Ver) -20 (bund)] TJ ET';
  const { text } = extractText(onePagePdf(content), { name: 'abstand.pdf' });
  assert.deepEqual(text.split('\n'), ['Wort Abstand', 'Verbund']);
});

test('pdf behandelt die Zeilenoperatoren T*, \' und "', () => {
  const content = 'BT /F1 12 Tf 14 TL 10 700 Td (Erste) Tj T* (Zweite) Tj (Dritte) \' 0 0 (Vierte) " ET';
  const { text } = extractText(onePagePdf(content), { name: 'zeilen.pdf' });
  assert.deepEqual(text.split('\n'), ['Erste', 'Zweite', 'Dritte', 'Vierte']);
});

test('pdf hält die Seitenreihenfolge des Seitenbaums ein', () => {
  const pdf = makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    { dict: '/Filter /FlateDecode', stream: flate('BT /F1 12 Tf 10 700 Td (Seite eins) Tj ET') },
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    { dict: '/Filter /FlateDecode', stream: flate('BT /F1 12 Tf 10 700 Td (Seite zwei) Tj ET') },
  ]);
  const result = extractText(pdf, { name: 'zwei.pdf' });
  assert.equal(result.pages, 2);
  assert.deepEqual(result.text.split('\n').filter(Boolean), ['Seite eins', 'Seite zwei']);
});

test('pdf löst /Differences und WinAnsi-Kodierung auf', () => {
  const pdf = onePagePdf('BT /F1 12 Tf 10 700 Td (ABC) Tj 0 -14 Td (\\223Zitat\\224) Tj ET', {
    font: '<< /Type /Font /Subtype /Type1 /BaseFont /X /Encoding << /Type /Encoding '
      + '/BaseEncoding /WinAnsiEncoding /Differences [65 /germandbls /adieresis 67 /uni20AC] >> >>',
  });
  const { text } = extractText(pdf, { name: 'kodierung.pdf' });
  // 0x93/0x94 are typographic quotes in WinAnsi, not control characters.
  assert.deepEqual(text.split('\n'), ['ßä€', '“Zitat”']);
});

test('pdf nutzt die /ToUnicode-Tabelle eines Type0-Fonts mit Zwei-Byte-Codes', () => {
  const cmap = 'begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange '
    + '2 beginbfchar <0003> <0048> <0004> <00E4> endbfchar '
    + '1 beginbfrange <0010> <0012> <0061> endbfrange endcmap';
  const pdf = onePagePdf('BT /F1 12 Tf 10 700 Td <0003000400100011> Tj ET', {
    font: '<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+X /Encoding /Identity-H /ToUnicode 6 0 R >>',
    objects: [{ dict: '/Filter /FlateDecode', stream: flate(cmap) }],
  });
  assert.equal(extractText(pdf, { name: 'cid.pdf' }).text, 'Häab');
});

test('pdf findet Objekte in komprimierten Objektströmen', () => {
  // Modern producers put the catalogue and the page dictionaries into an
  // ObjStm; without expanding those the file looks empty.
  const members = [
    [10, '<< /Type /Catalog /Pages 11 0 R >>'],
    [11, '<< /Type /Pages /Kids [12 0 R] /Count 1 >>'],
    [12, '<< /Type /Page /Parent 11 0 R /Resources << /Font << /F1 13 0 R >> >> /Contents 2 0 R >>'],
    [13, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
  ];
  let header = '';
  let body = '';
  for (const [num, text] of members) { header += `${num} ${body.length} `; body += `${text} `; }
  const pdf = makePdf([
    { dict: `/Type /ObjStm /N ${members.length} /First ${header.length} /Filter /FlateDecode`, stream: zlib.deflateSync(Buffer.from(header + body, 'latin1')) },
    { dict: '', stream: 'BT /F1 12 Tf 10 700 Td (Aus dem Objektstrom) Tj ET' },
  ]);
  assert.equal(extractText(pdf, { name: 'modern.pdf' }).text, 'Aus dem Objektstrom');
});

test('pdf folgt Form-XObjects und erkennt eingebettete Bilder', () => {
  const pdf = makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fx 5 0 R >> >> /Contents 4 0 R >>',
    { dict: '', stream: 'BT 1 0 0 1 72 700 Tm (Auf der Seite) Tj ET /Fx Do' },
    { dict: '/Type /XObject /Subtype /Form', stream: 'BT 1 0 0 1 10 10 Tm (Im Formular) Tj ET' },
  ]);
  assert.deepEqual(extractText(pdf, { name: 'form.pdf' }).text.split('\n'), ['Auf der Seite', 'Im Formular']);
});

test('pdf entpackt LZW-, ASCII85-, ASCIIHex- und RunLength-Ströme', () => {
  const content = 'BT /F1 12 Tf 10 700 Td (Aus einem LZW-Strom) Tj ET';
  // Golden vector: the same content stream LZW-encoded (9..12 bit codes,
  // 256 = clear, 257 = EOD), so the decoder is tested against the format
  // rather than against a round trip with itself.
  const lzw = Buffer.from('80108a820179186220188c840543342060201b8c21e543208050413a9cc4065349b8ca'
    + '6d10130b4571694ce872379b4530b350808a548080', 'hex');
  assert.equal(extractText(makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
    { dict: '/Filter /LZWDecode', stream: lzw },
  ]), { name: 'lzw.pdf' }).text, 'Aus einem LZW-Strom');

  const plain = 'BT /F1 12 Tf 10 700 Td (Klartext-Strom) Tj ET';
  const hex = `${Buffer.from(plain, 'latin1').toString('hex')}>`;
  assert.equal(extractText(makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
    { dict: '/Filter /ASCIIHexDecode', stream: hex },
  ]), { name: 'hex.pdf' }).text, 'Klartext-Strom');

  // ASCII85, five printable characters per four bytes, terminated by '~>'.
  const a85 = '6<#\'\\7PQ#?1*BP.+>GPm2_Zp.<+I+"5r^_R;fm%uD(-T,C*5rE~>';
  assert.equal(extractText(makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
    { dict: '/Filter /ASCII85Decode', stream: a85 },
  ]), { name: 'a85.pdf' }).text, 'A85-Strom');

  // RunLength: literal run, then a repeat, then the end marker.
  const runLength = Buffer.concat([
    Buffer.from([plain.length - 1]), Buffer.from(plain, 'latin1'),
    Buffer.from([257 - 3, 0x20]), Buffer.from([128]),
  ]);
  assert.equal(extractText(makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
    { dict: '/Filter /RunLengthDecode', stream: runLength },
  ]), { name: 'rl.pdf' }).text, 'Klartext-Strom');
});

test('pdf macht die PNG-Prädiktion eines Objektstroms rückgängig', () => {
  // Producers compress object and xref streams with /Predictor 12; without
  // undoing that, every dictionary in the file decodes to noise.
  const stream = Buffer.from('eJwBmQBm/wIxMCAwIDExIDM1IDEyIDc4Au8MHPAPI0hQMusPEi9UKjQCTyvkDyEN7vUOAALu'
    + 'v7y/5gKx1x7x7Nu5yuFZPzQA/zAPAkcnNQDzD0k1H6frzBLx4L8C6/itDxQkDAoBANbvDB7wHALqww8lNgHwsrswMEcn4g8U'
    + 'AiVSNhr7sMwR8eC/67sPFB8CDQIAAABT7wEAAAAAAA/7sQFENn8=', 'base64');
  const pdf = makePdf([
    { dict: '/Type /ObjStm /N 3 /First 17 /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 16 >>', stream },
    { dict: '', stream: 'BT /F1 12 Tf 10 700 Td (Hinter der Praediktion) Tj ET' },
  ]);
  assert.equal(extractText(pdf, { name: 'pred.pdf' }).text, 'Hinter der Praediktion');
});

test('pdf ohne Textinhalt liefert kind pdf-image, leeren Text und eine ehrliche Warnung', () => {
  const scan = makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    { dict: '/Filter /FlateDecode', stream: flate('q 595 0 0 842 0 0 cm /Im0 Do Q') },
    { dict: '/Type /XObject /Subtype /Image /Width 10 /Height 10 /Filter /DCTDecode', stream: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]) },
  ]);
  const result = extractText(scan, { name: 'scan.pdf' });
  assert.equal(result.kind, 'pdf-image');
  assert.equal(result.text, '', 'ein Scan darf niemals erfundenen Text liefern');
  assert.equal(result.pages, 1);
  assert.ok(result.warnings.some((w) => /Texterkennung|OCR/i.test(w)), result.warnings.join(' | '));
});

test('verschlüsselte pdf wird erkannt und ehrlich gemeldet, statt geraten', () => {
  const encrypted = makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
    { dict: '', stream: 'BT (unlesbar) Tj ET' },
    '<< /Filter /Standard /V 2 /R 3 /Length 128 /P -44 >>',
  ], { trailer: '/Root 1 0 R /Encrypt 5 0 R' });
  assert.throws(() => extractText(encrypted, { name: 'geheim.pdf' }), (err) => {
    assert.equal(err.code, 'VALIDATION_FAILED');
    assert.match(err.message, /verschlüsselt/i);
    assert.match(err.message, /Passwort/i);
    return true;
  });
});

test('abgeschnittene pdf wirft einen Fehler statt abzustürzen', () => {
  const pdf = onePagePdf('BT /F1 12 Tf 10 700 Td (Text) Tj ET');
  assert.throws(() => extractText(pdf.subarray(0, 150), { name: 'kaputt.pdf' }), (err) => {
    assert.equal(err.code, 'VALIDATION_FAILED');
    assert.match(err.message, /beschädigt|unvollständig/i);
    return true;
  });
  // Nothing but a header: also an error, never a fabricated empty document.
  assert.throws(() => extractText(Buffer.from('%PDF-1.4\n%%EOF\n'), { name: 'leer.pdf' }), /beschädigt|unvollständig/i);
});

test('pdf mit beschädigtem Datenstrom liefert die lesbaren Teile und warnt', () => {
  const good = flate('BT /F1 12 Tf 10 700 Td (Lesbarer Teil) Tj ET');
  const pdf = makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    { dict: '/Filter /FlateDecode', stream: good },
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>',
    { dict: '/Filter /FlateDecode', stream: Buffer.from('völliger Unsinn statt deflate', 'latin1') },
  ]);
  const result = extractText(pdf, { name: 'halb.pdf' });
  assert.equal(result.text, 'Lesbarer Teil');
  assert.ok(result.warnings.some((w) => /entpacken/i.test(w)), result.warnings.join(' | '));
});

/* ------------------------------------------------------------ html, xml */

test('html verliert Skripte, Stile und Kommentare und löst Entities auf', () => {
  const html = '<!DOCTYPE html><html><head><title>Seitentitel</title>'
    + '<style>body { color: red }</style>'
    + '<script>var geheim = "nicht im Text";</script></head>'
    + '<body><!-- Kommentar --><h1>Überschrift</h1>'
    + '<p>Erster Absatz mit &amp; und &uuml;ber &#8222;Zitat&#8220;.</p>'
    + '<ul><li>Eins</li><li>Zwei</li></ul>'
    + '<table><tr><td>a</td><td>b</td></tr></table>'
    + '<p>Zeile<br>Umbruch</p></body></html>';
  const result = extractText(Buffer.from(html), { name: 'seite.html' });
  assert.equal(result.kind, 'html');
  assert.ok(!result.text.includes('geheim'), 'Skriptinhalt darf nicht im Text landen');
  assert.ok(!result.text.includes('color'), 'Stilinhalt darf nicht im Text landen');
  assert.ok(!result.text.includes('Kommentar'));
  assert.deepEqual(result.text.split('\n').filter(Boolean), [
    'Seitentitel', 'Überschrift', 'Erster Absatz mit & und über „Zitat“.',
    'Eins', 'Zwei', 'a\tb', 'Zeile', 'Umbruch',
  ]);
});

test('html mit unbeendetem script-Tag verrät den Skriptinhalt nicht', () => {
  const { text } = extractText(Buffer.from('<html><body><p>Davor</p><script>var a = 1 < 2;'), { name: 'kaputt.html' });
  assert.equal(text, 'Davor');
});

test('xml wird je Element zu einer Zeile, CDATA bleibt Text', () => {
  const xml = '<?xml version="1.0" encoding="UTF-8"?><notiz><titel>Einkauf</titel>'
    + '<text><![CDATA[Zwei < drei & vier]]></text></notiz>';
  const result = extractText(Buffer.from(xml), { name: 'notiz.xml' });
  assert.equal(result.kind, 'xml');
  assert.deepEqual(result.text.split('\n'), ['Einkauf', 'Zwei < drei & vier']);
});

/* ------------------------------------------------------------------ rtf */

test('rtf entfernt Steuerworte und löst \\uN sowie \\\'hh auf', () => {
  const rtf = '{\\rtf1\\ansi\\ansicpg1252\\deff0'
    + '{\\fonttbl{\\f0\\fnil Arial;}}{\\colortbl;\\red0\\green0\\blue0;}'
    + '{\\*\\generator Riched20 10.0;}'
    + '\\f0\\fs24 Gr\\u246?\\u223?e kostet 5 \\u8364? und \\\'e9clat.\\par '
    + 'Zweite Zeile\\line dritte Zeile\\par '
    + '\\trowd \\cellx1000 A1\\cell B1\\cell \\row}';
  const result = extractText(Buffer.from(rtf, 'latin1'), { name: 'notiz.rtf' });
  assert.equal(result.kind, 'rtf');
  assert.ok(!result.text.includes('Arial'), 'die Schrifttabelle ist kein Text');
  assert.ok(!result.text.includes('Riched'), 'die Erzeuger-Kennung ist kein Text');
  assert.deepEqual(result.text.split('\n'), [
    'Größe kostet 5 € und éclat.', 'Zweite Zeile', 'dritte Zeile', 'A1\tB1',
  ]);
});

/* -------------------------------------------------------------- klartext */

test('Klartext wird nach BOM als UTF-8, UTF-16LE und UTF-16BE erkannt', () => {
  const content = 'Grüße aus München\nZeile zwei';
  const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')]);
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]);
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(content, 'utf16le').swap16()]);
  for (const [label, buf] of [['utf8', utf8Bom], ['utf16le', utf16le], ['utf16be', utf16be]]) {
    const result = extractText(buf, { name: 'notiz.txt' });
    assert.equal(result.kind, 'text', label);
    assert.equal(result.text, content, label);
    assert.deepEqual(result.warnings, [], label);
  }
});

test('UTF-16 ohne BOM wird an den Nullbytes erkannt', () => {
  const buf = Buffer.from('Notiz ohne Kennung\nzweite Zeile', 'utf16le');
  const result = extractText(buf, { name: 'ohne-bom.txt' });
  assert.equal(result.text, 'Notiz ohne Kennung\nzweite Zeile');
  assert.ok(result.warnings.some((w) => /UTF-16/.test(w)), result.warnings.join(' | '));
});

test('ungültiges UTF-8 fällt auf Latin-1/Windows-1252 zurück und sagt das', () => {
  const result = extractText(Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65, 0x20, 0x93, 0x78, 0x94]), { name: 'alt.txt' });
  assert.equal(result.text, 'Grüße “x”');
  assert.ok(result.warnings.some((w) => /Latin-1|Windows-1252/.test(w)), result.warnings.join(' | '));
});

test('Klartext-Varianten bleiben Text und werden nicht verstümmelt', () => {
  const json = '{\n  "titel": "Notiz",\n  "tags": ["a", "b"]\n}';
  assert.equal(extractText(Buffer.from(json), { name: 'daten.json' }).text, json);
  const csv = 'Monat;Betrag\nJanuar;1200';
  assert.equal(extractText(Buffer.from(csv), { name: 'zahlen.csv' }).text, csv);
  const code = "const a = 1;\nif (a < 2) { console.log('ok'); }";
  assert.equal(extractText(Buffer.from(code), { name: 'skript.js' }).text, code);
});

test('leere Datei liefert einen leeren Text statt eines Fehlers', () => {
  const result = extractText(Buffer.alloc(0), { name: 'leer.txt' });
  assert.deepEqual(result, { text: '', kind: 'empty', truncated: false, warnings: ['Die Datei ist leer.'] });
});

test('maxBytes schneidet auf einer Zeichengrenze ab', () => {
  const result = extractText(Buffer.from('äöüäöü'), { name: 'um.txt', maxBytes: 5 });
  assert.equal(result.text, 'äö'); // 4 bytes: a half-written character would be a lie
  assert.equal(result.truncated, true);
});

/* --------------------------------------------------------------- Grenzen */

test('Zip-Bombe wird begrenzt und nicht entpackt', () => {
  const bomb = makeZip([{ name: 'word/document.xml', data: Buffer.alloc(8 * 1024 * 1024, 0x41) }]);
  assert.throws(() => extractText(bomb, { name: 'bombe.docx', maxUnpackedBytes: 512 * 1024 }), (err) => {
    assert.equal(err.code, 'VALIDATION_FAILED');
    assert.match(err.message, /ZIP-Bombe/);
    return true;
  });
});

test('Zip-Bombe mit gefälschter Größenangabe wird ebenfalls begrenzt', () => {
  // The header claims one byte; only the capped inflate can catch this.
  const bomb = makeZip([{ name: 'word/document.xml', data: Buffer.alloc(4 * 1024 * 1024, 0x42), declaredSize: 1 }]);
  assert.throws(() => extractText(bomb, { name: 'luege.docx', maxUnpackedBytes: 256 * 1024 }), /ZIP-Bombe/);
});

test('verschachteltes Archiv wird nicht verfolgt', () => {
  const inner = makeZip([{ name: 'word/document.xml', data: '<w:p><w:r><w:t>innen</w:t></w:r></w:p>' }]);
  const outer = makeZip([
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>aussen</w:t></w:r></w:p></w:body></w:document>' },
    { name: 'eingebettet.zip', data: inner },
  ]);
  assert.equal(extractText(outer, { name: 'aussen.docx' }).text, 'aussen');
});

test('abgeschnittenes oder kaputtes ZIP wirft einen typisierten Fehler', () => {
  const doc = docxOf(para('Inhalt'));
  assert.throws(() => extractText(doc.subarray(0, doc.length - 30), { name: 'halb.docx' }), (err) => {
    assert.equal(err.code, 'VALIDATION_FAILED');
    assert.match(err.message, /beschädigt|unvollständig/i);
    return true;
  });
  assert.throws(() => extractText(Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(200, 7)]), { name: 'schrott.docx' }), /beschädigt|unvollständig/i);
});

test('passwortgeschütztes Dokument wird ehrlich gemeldet', () => {
  const locked = makeZip([{ name: 'word/document.xml', data: '<w:p/>', flags: 0x801 }]);
  assert.throws(() => extractText(locked, { name: 'geschuetzt.docx' }), /passwortgeschützt/i);
});

test('fehlender Bestandteil eines Dokuments wird benannt', () => {
  const broken = makeZip([{ name: 'word/styles.xml', data: '<x/>' }, { name: 'word/document.xml.bak', data: '<x/>' }]);
  // Not recognisable as a docx any more: it is reported as what it is.
  assert.throws(() => extractText(broken, { name: 'ohne-inhalt.docx' }), /ZIP-Archiv|Bestandteil/);
});

test('kopiergeschützte oder verschlüsselte Dokumente werden gemeldet, nicht geraten', () => {
  const drm = makeZip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/encryption.xml', data: '<encryption><EncryptedData/></encryption>' },
    { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="b.opf"/></rootfiles></container>' },
  ]);
  assert.throws(() => extractText(drm, { name: 'gekauft.epub' }), /DRM|kopiergesch/i);

  const locked = makeZip([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', store: true },
    { name: 'styles.xml', data: '<s/>' },
    { name: 'META-INF/manifest.xml', data: '<manifest><file-entry><encryption-data/></file-entry></manifest>' },
    { name: 'content.xml', data: '<o><text:p>unlesbar</text:p></o>' },
  ]);
  assert.throws(() => extractText(locked, { name: 'geschuetzt.odt' }), /Passwort/i);
});

test('nicht auslesbare Formate werfen einen Fehler mit brauchbarer Anleitung', () => {
  const cases = [
    [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), 'alt.doc', /\.docx/],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0]), 'foto.png', /OCR|Texterkennung/],
    [makeZip([{ name: 'a.txt', data: 'hallo' }]), 'archiv.zip', /Entpacke/],
    [Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0]), 'programm', /kein.*Text/i],
  ];
  for (const [buf, name, pattern] of cases) {
    assert.throws(() => extractText(buf, { name }), (err) => {
      assert.equal(err.code, 'VALIDATION_FAILED', name);
      assert.equal(err.status, 400, name);
      assert.match(err.message, pattern);
      return true;
    }, name);
  }
});

test('widersprüchliche Endung oder MIME-Angabe wird gemeldet, der Inhalt gewinnt', () => {
  const pdf = onePagePdf('BT /F1 12 Tf 10 700 Td (Echt ein PDF) Tj ET');
  const result = extractText(pdf, {
    name: 'bericht.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  assert.equal(result.kind, 'pdf');
  assert.equal(result.text, 'Echt ein PDF');
  assert.ok(result.warnings.some((w) => /gekennzeichnet/.test(w)), result.warnings.join(' | '));
  // A .md file containing HTML is normal and must not produce noise.
  assert.deepEqual(extractText(Buffer.from('<p>Hallo</p>'), { name: 'notiz.md' }).warnings, []);
});

test('fehlende Eingabe wird abgelehnt, statt etwas zu erfinden', () => {
  assert.throws(() => extractText(null, { name: 'x.txt' }), /Buffer/);
  assert.throws(() => extractText('kein Buffer', { name: 'x.txt' }), /Buffer/);
});

test('bösartig verschachtelte Eingaben hängen den Prozess nicht auf', () => {
  const deepXml = `${'<a>'.repeat(20000)}Kern${'</a>'.repeat(20000)}`;
  const started = Date.now();
  assert.equal(extractText(Buffer.from(deepXml), { name: 'tief.xml' }).text, 'Kern');
  // Deeply nested PDF arrays are refused by the depth limit rather than by RAM.
  const deepPdf = onePagePdf(`BT /F1 12 Tf 10 700 Td ${'['.repeat(400)}(x)${']'.repeat(400)} TJ ET`);
  extractText(deepPdf, { name: 'tief.pdf' });
  assert.ok(Date.now() - started < 5000, 'darf nicht hängen');
});

test('das Zeitbudget beendet eine zu aufwendige Datei mit truncated statt mit einem Hänger', () => {
  const many = Array.from({ length: 4000 }, (unused, i) => para(`Absatz ${i}`)).join('');
  const result = extractText(docxOf(many), { name: 'viel.docx', timeBudgetMs: 0 });
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.some((w) => /Zeitlimit/.test(w)), result.warnings.join(' | '));
});

/* ------------------------------------------------------------- Bauregeln */

test('extract.js hält die Projektregeln ein: keine Abhängigkeiten, kein Netz', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'store', 'extract.js'), 'utf8');
  const requires = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  for (const dependency of requires) {
    assert.ok(
      dependency.startsWith('node:') || dependency.startsWith('.'),
      `unerlaubte Abhängigkeit: ${dependency}`,
    );
  }
  // Only src/net/gate.js may reach the network; an extractor never does.
  assert.equal(/\bfetch\s*\(|http\.request|net\.connect|dns\./.test(source), false);
});

module.exports = { name: 'extract', tests: drain() };
