'use strict';

/**
 * Notizen als Teil des Wissensnetzes -- die Routen, die der Editor braucht.
 *
 * Was die Notizansicht (web/views/notes.js) ohne diese Routen nicht koennte:
 *
 *   GET  /api/notizen/vervollstaendigen?q=&art=link|tag
 *        Die kleine Liste beim Tippen von "[[" (Notizen, Projekte, Begriffe,
 *        Personen, Aufgaben) und von "#" (Schlagworte, mit Anzahl). Bei
 *        10.000 Notizen ist das ein Lauf ueber die Titel im Speicher -- kein
 *        Volltext, weil ein Titel-Anfang gemeint ist, nicht ein Wort im Text.
 *   POST /api/notizen/aufloesen {namen:[...]}
 *        Welche [[Namen]] es gibt: dieselbe Faltung wie die Ableitung
 *        (src/graph/derive.js), damit die Ansicht genau die Links gestrichelt
 *        zeigt, die beim Speichern KEINE Kante ergeben haben.
 *   POST /api/notizen/anlegen {title, body?, tags?, vonId?}
 *        "Notiz „Name“ anlegen?" -> [Anlegen]. Gibt es den Titel schon,
 *        kommt der vorhandene Eintrag zurueck (bereits:true) statt eines
 *        Doppelgaengers. Mit `vonId` wird die Notiz, in der der Link stand,
 *        sofort neu abgeleitet: die Kante entsteht in derselben Anfrage und
 *        wandert als 'graph.kante' ins Gehirn, ohne Neuladen.
 *   POST /api/notizen/dateien {name, mime, daten (Base64)}
 *   GET  /api/notizen/dateien/:id
 *        Bilder in Notizen. Abgelegt im vorhandenen Ablagefach des Tresors
 *        (store.files, inhaltsadressiert, verschluesselt wie alles andere),
 *        dazu ein `file`-Satz, damit das Bild im Netz ein Knoten ist. Nur
 *        Bildarten, die ein Browser als Bild zeigt -- kein SVG (Skripte).
 *   POST /api/notizen/import {dateien:[{name, text}]}
 *        "Importieren": Markdown-Dateien oder ein Ordner (Obsidian) werden
 *        Notizen; [[Links]] und #Schlagworte bleiben und verbinden danach.
 *   POST /api/notizen/link {url, titel?}
 *        "Link speichern": eine Notiz mit der Adresse. Der Seitentitel wird
 *        NUR geholt, wenn die Schleuse online ist und die Adresse freigibt;
 *        sonst steht ehrlich nur die Adresse in der Notiz und die Antwort
 *        sagt, warum (titelGeholt:false, grund).
 *
 * Alles hier ist deterministisch und bleibt auf diesem Geraet; die einzige
 * Verbindung nach draussen ist der Seitentitel, und der laeuft durch die
 * Schleuse wie jede andere Anfrage.
 */

const { fold } = require('../../store/search');
const { tagsOf } = require('../../graph/view');
const { ValidationError, NotFoundError } = require('../../kernel/errors');
const {
  need,
  asObject,
  requireString,
  optionalString,
  requireStringArray,
  intParam,
  strParam,
  mustGet,
} = require('./support');

/** Was "[[" vervollstaendigt, in der Reihenfolge, in der die Ableitung Titel aufloest. */
const LINK_TYPEN = ['note', 'project', 'entity', 'task'];
/** Wessen Schlagworte das "#" kennt (Feld und Text, siehe view.tagsOf). */
const TAG_TYPEN = ['note', 'project', 'file', 'task', 'event', 'entity'];

const ART_LABEL = {
  note: 'Notiz',
  project: 'Projekt',
  task: 'Aufgabe',
  entity: 'Begriff',
  event: 'Termin',
  file: 'Datei',
  chat: 'Chat',
};
const ENTITY_LABEL = { topic: 'Thema', person: 'Person', place: 'Ort', org: 'Organisation', term: 'Begriff', other: 'Begriff' };

/** Bildarten, die der Browser als <img> zeigt. Bewusst ohne SVG. */
const BILD_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const MAX_BILD_BYTES = 8 * 1024 * 1024;

const MAX_NAMEN = 200;
const MAX_TITEL_BYTES = 512 * 1024;

/* --------------------------------------------------------------- Helfer */

function titelVon(record) {
  const d = (record && record.data) || {};
  return String(d.title || d.name || '').trim();
}

function artVon(record) {
  if (record.type === 'entity') return ENTITY_LABEL[record.data && record.data.kind] || 'Begriff';
  return ART_LABEL[record.type] || record.type;
}

/**
 * Wie gut passt `q` (gefaltet) auf `titel` (gefaltet)?
 *   0 gleich, 1 Anfang, 2 Wortanfang, 3 irgendwo, -1 gar nicht.
 * Reine Funktion, damit die Reihenfolge der Liste pruefbar ist.
 */
function trefferGuete(titelKey, q) {
  if (!q) return 3;
  if (titelKey === q) return 0;
  if (titelKey.startsWith(q)) return 1;
  const idx = titelKey.indexOf(q);
  if (idx === -1) return -1;
  return titelKey[idx - 1] === ' ' ? 2 : 3;
}

function neuerZuerst(a, b) {
  if (a.updatedAt === b.updatedAt) return a.id < b.id ? -1 : 1;
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

/** Vervollstaendigung fuer "[[": Titel aus dem Speicher, beste zuerst. */
function linkKandidaten(store, q, limit) {
  const key = fold(q || '');
  const treffer = [];
  for (const type of LINK_TYPEN) {
    let items = [];
    try { items = store.all(type); } catch { continue; }
    for (const rec of items) {
      const titel = titelVon(rec);
      if (!titel) continue;
      const guete = trefferGuete(fold(titel), key);
      if (guete < 0) continue;
      treffer.push({ rec, titel, guete });
    }
  }
  treffer.sort((a, b) => (a.guete - b.guete) || neuerZuerst(a.rec, b.rec));
  return treffer.slice(0, limit).map(({ rec, titel }) => ({
    id: rec.id,
    type: rec.type,
    title: titel,
    kind: rec.type === 'entity' ? (rec.data.kind || 'topic') : rec.type,
    art: artVon(rec),
  }));
}

/** Vervollstaendigung fuer "#": Schlagworte mit Anzahl, haeufigste zuerst. */
function tagKandidaten(store, q, limit) {
  const key = fold(q || '').replace(/^#/, '');
  const zaehler = new Map(); // gefaltet -> {tag, anzahl}
  for (const type of TAG_TYPEN) {
    let items = [];
    try { items = store.all(type); } catch { continue; }
    for (const rec of items) {
      // Feld UND #worte im Text -- dieselbe Quelle wie Universum und Wand.
      const tags = tagsOf(rec);
      for (const raw of tags) {
        const tag = String(raw || '').trim().replace(/^#/, '');
        if (!tag) continue;
        const k = fold(tag);
        const eintrag = zaehler.get(k) || { tag, anzahl: 0 };
        eintrag.anzahl += 1;
        zaehler.set(k, eintrag);
      }
    }
  }
  const treffer = [];
  for (const [k, eintrag] of zaehler) {
    const guete = trefferGuete(k, key);
    if (guete < 0) continue;
    treffer.push({ ...eintrag, guete });
  }
  treffer.sort((a, b) => (a.guete - b.guete) || (b.anzahl - a.anzahl) || (a.tag < b.tag ? -1 : 1));
  return treffer.slice(0, limit).map(({ tag, anzahl }) => ({ tag, anzahl }));
}

/** Titel -> Satz, mit derselben Faltung wie die Ableitung. */
function titelIndex(store, graph) {
  if (graph && typeof graph.buildIndex === 'function') {
    try { return graph.buildIndex(store).byTitle; } catch { /* dann von Hand */ }
  }
  const byTitle = new Map();
  for (const type of ['note', 'project', 'entity', 'task', 'event', 'file', 'chat', 'agent']) {
    let items = [];
    try { items = store.list(type, { sort: 'createdAt', order: 'asc' }).items; } catch { continue; }
    for (const rec of items) {
      const k = fold(titelVon(rec));
      if (k && !byTitle.has(k)) byTitle.set(k, rec.id);
    }
  }
  return byTitle;
}

/** Den <title> einer HTML-Seite lesen -- ohne Parser, ohne Entitaeten zu erfinden. */
function seitenTitel(html) {
  const m = /<title[^>]*>([\s\S]{0,600}?)<\/title>/i.exec(String(html || ''));
  if (!m) return '';
  return m[1]
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '\'')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Der Titel einer Notiz, wenn die Seite keinen hergibt: Host und Pfad, kurz. */
function titelAusUrl(url) {
  const pfad = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/+$/, '') : '';
  return `${url.hostname}${pfad}`.slice(0, 120);
}

/* --------------------------------------------------------------- Import */

/** Was der Import annimmt: Markdown und reiner Text (Obsidian, Notizordner). */
const IMPORT_ENDUNG_RE = /\.(md|markdown|txt)$/i;
const MAX_IMPORT_DATEIEN = 500;
const MAX_IMPORT_ZEICHEN = 1000000;

/**
 * Eine Markdown-Datei in {title, body, tags} zerlegen. Kopfdaten (YAML
 * zwischen `---`) werden gelesen, soweit ein Notizprogramm sie schreibt:
 * `title:` und `tags:` (als `[a, b]`, als Liste mit `- a` oder als
 * `a, b`). Alles andere im Kopf bleibt weg -- es ist Verwaltung, kein Text.
 * [[Links]] und #Schlagworte im Text bleiben, wie sie sind; die Ableitung
 * macht daraus nach dem Import Kanten.
 * @returns {{title:string, body:string, tags:string[]}}
 */
function markdownZuNotiz(name, text) {
  let body = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let title = '';
  const tags = [];
  const kopf = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (kopf) {
    body = body.slice(kopf[0].length);
    const zeilen = kopf[1].split('\n');
    for (let i = 0; i < zeilen.length; i++) {
      const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(zeilen[i]);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const wert = m[2].trim();
      if (key === 'title' && wert) title = wert.replace(/^["']|["']$/g, '').trim();
      if (key === 'tags' || key === 'tag') {
        if (wert.startsWith('[')) {
          for (const t of wert.replace(/^\[|\]$/g, '').split(',')) tags.push(t);
        } else if (wert) {
          for (const t of wert.split(/[,\s]+/)) tags.push(t);
        } else {
          while (i + 1 < zeilen.length && /^\s*-\s+/.test(zeilen[i + 1])) tags.push(zeilen[++i].replace(/^\s*-\s+/, ''));
        }
      }
    }
  }
  if (!title) {
    const basis = String(name || '').split(/[\\/]/).pop().replace(IMPORT_ENDUNG_RE, '').trim();
    title = basis || 'Importierte Notiz';
  }
  const sauber = [];
  const seen = new Set();
  for (const roh of tags) {
    const t = String(roh || '').trim().replace(/^["'#]+|["']+$/g, '').trim();
    if (!t || t.length > 100 || seen.has(fold(t))) continue;
    seen.add(fold(t));
    sauber.push(t);
  }
  return { title: title.slice(0, 500), body: body.replace(/^\n+/, '').replace(/\s+$/, ''), tags: sauber.slice(0, 50) };
}

/* --------------------------------------------------------------- Routen */

function register(router) {
  router.get('/api/notizen/vervollstaendigen', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const art = strParam(rc.query, 'art', 10) || 'link';
    if (art !== 'link' && art !== 'tag') throw new ValidationError('"art" muss link oder tag sein.');
    const q = strParam(rc.query, 'q', 200) || '';
    const limit = intParam(rc.query, 'limit', 8, 1, 30);
    const items = art === 'tag' ? tagKandidaten(store, q, limit) : linkKandidaten(store, q, limit);
    return { art, q, items };
  });

  router.post('/api/notizen/aufloesen', async (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const body = asObject(await rc.body());
    const namen = requireStringArray(body.namen, 'namen', { max: 300, maxItems: MAX_NAMEN });
    const byTitle = titelIndex(store, rc.ctx.graph);
    const aufgeloest = {};
    for (const name of namen) {
      const id = byTitle.get(fold(name)) || null;
      const rec = id ? store.get(id) : null;
      aufgeloest[name] = rec ? { id: rec.id, type: rec.type, title: titelVon(rec) } : null;
    }
    return { aufgeloest };
  });

  router.post('/api/notizen/anlegen', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const body = asObject(await rc.body());
    const title = requireString(body.title, 'title', { max: 500 });
    const text = optionalString(body.body, 'body', { max: 2000000 }) || '';
    const tags = body.tags === undefined ? [] : requireStringArray(body.tags, 'tags', { max: 100, maxItems: 50 });
    const vonId = optionalString(body.vonId, 'vonId', { max: 80 }) || null;
    const graph = rc.ctx.graph;

    const byTitle = titelIndex(store, graph);
    const vorhandenId = byTitle.get(fold(title)) || null;
    const vorhanden = vorhandenId ? store.get(vorhandenId) : null;
    let record = vorhanden;
    const bereits = !!vorhanden;
    if (!record) {
      record = store.create('note', { title, body: text, tags, source: 'user' });
    }

    // Die Notiz, in der [[Name]] stand, jetzt neu ableiten: erst der neue
    // Satz (damit der Titelindex ihn kennt), dann die Quelle.
    let kanten = null;
    if (vonId && graph && typeof graph.deriveFor === 'function') {
      const quelle = store.get(vonId);
      if (quelle) {
        try {
          graph.deriveFor(store, record);
          const res = graph.deriveFor(store, quelle);
          kanten = {
            neu: res.created.map((e) => e.id),
            entfernt: res.removed.map((e) => e.id),
            unaufgeloest: res.unresolved.map((u) => u.text || u.title || '').filter(Boolean),
          };
        } catch (err) {
          kanten = { neu: [], entfernt: [], unaufgeloest: [], fehler: (err && err.message) || 'Ableitung fehlgeschlagen' };
        }
      }
    }
    return { record, bereits, kanten };
  });

  router.post('/api/notizen/dateien', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    if (!store.files || typeof store.files.put !== 'function') {
      throw new ValidationError('Dieser Speicher hat kein Ablagefach für Dateien.');
    }
    const body = asObject(await rc.body());
    const name = requireString(body.name, 'name', { max: 300 }).replace(/[\\/\u0000-\u001f]/g, '_');
    const mime = requireString(body.mime, 'mime', { max: 100 }).toLowerCase();
    if (!BILD_MIME.has(mime)) {
      throw new ValidationError(`„${mime}“ ist keine Bildart, die hier abgelegt wird. Möglich: ${[...BILD_MIME].join(', ')}.`);
    }
    const daten = requireString(body.daten, 'daten', { max: Math.ceil(MAX_BILD_BYTES * 4 / 3) + 16, trim: false });
    let buf;
    try {
      buf = Buffer.from(daten.replace(/^data:[^,]*,/, ''), 'base64');
    } catch {
      throw new ValidationError('"daten" ist kein gültiges Base64.');
    }
    if (!buf.length) throw new ValidationError('Die Datei ist leer.');
    if (buf.length > MAX_BILD_BYTES) {
      throw new ValidationError(`Das Bild ist zu groß (${Math.round(buf.length / 1024)} KB, erlaubt sind ${MAX_BILD_BYTES / 1024} KB).`);
    }
    const abgelegt = store.files.put(buf, { name, mime });
    const record = store.create('file', { name, hash: abgelegt.hash, mime, size: buf.length });
    return { record, url: `/api/notizen/dateien/${record.id}`, markdown: `![${name.replace(/[[\]]/g, '')}](/api/notizen/dateien/${record.id})` };
  });

  router.get('/api/notizen/dateien/:id', (rc) => {
    rc.requireCapability('read');
    const store = need(rc.ctx.store, 'Der Speicher');
    const record = mustGet(store, rc.params.id, 'file');
    const hash = record.data && record.data.hash;
    if (!hash || !store.files || typeof store.files.read !== 'function') throw new NotFoundError(`Datei ${record.id}`);
    const buf = store.files.read(hash);
    const mime = String(record.data.mime || '').toLowerCase();
    const alsBild = BILD_MIME.has(mime);
    const { res } = rc;
    const kopf = {
      'Content-Type': alsBild ? mime : 'application/octet-stream',
      'Content-Length': buf.length,
      // Der Satz zeigt immer auf denselben Inhalt (Hash): der Browser darf
      // das Bild behalten, aber nur fuer sich.
      'Cache-Control': 'private, max-age=31536000, immutable',
    };
    if (!alsBild) kopf['Content-Disposition'] = `attachment; filename="${String(record.data.name || 'datei').replace(/["\r\n]/g, '')}"`;
    res.writeHead(200, kopf);
    if (rc.method === 'HEAD') res.end();
    else res.end(buf);
    rc.handled = true;
    return undefined;
  });

  /**
   * "Importieren" im leeren Gehirn und auf der Notizwand: Markdown-Dateien
   * oder ein ganzer Ordner (Obsidian, ein Notizordner) werden Notizen. Die
   * Oberflaeche liest die Dateien im Browser und schickt ihren Text in
   * Portionen; hier entsteht je Datei eine Notiz (source 'import'). Ein
   * Titel, den es schon gibt, wird nicht doppelt angelegt, sondern mit Grund
   * uebersprungen. Alles laeuft als EIN Massenschreibvorgang (bulkWrite):
   * die Ableitung ruht waehrenddessen und zieht danach alle [[Links]] und
   * #Schlagworte auf einmal -- auch die auf Notizen, die erst spaeter in
   * derselben Portion kamen.
   */
  router.post('/api/notizen/import', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const body = asObject(await rc.body());
    if (!Array.isArray(body.dateien) || !body.dateien.length) throw new ValidationError('"dateien" muss mindestens eine Datei nennen.');
    if (body.dateien.length > MAX_IMPORT_DATEIEN) {
      throw new ValidationError(`Höchstens ${MAX_IMPORT_DATEIEN} Dateien je Anfrage (empfangen: ${body.dateien.length}).`);
    }
    const dateien = body.dateien.map((d, i) => {
      const obj = asObject(d, `dateien[${i}]`);
      const name = requireString(obj.name, `dateien[${i}].name`, { max: 1000 });
      const text = typeof obj.text === 'string' ? obj.text : '';
      return { name, text };
    });
    const byTitle = titelIndex(store, rc.ctx.graph);
    const angelegt = [];
    const uebersprungen = [];
    const run = () => {
      for (const { name, text } of dateien) {
        if (!IMPORT_ENDUNG_RE.test(name)) { uebersprungen.push({ name, grund: 'Keine Markdown- oder Textdatei.' }); continue; }
        if (text.length > MAX_IMPORT_ZEICHEN) { uebersprungen.push({ name, grund: 'Länger als 1 Million Zeichen.' }); continue; }
        const n = markdownZuNotiz(name, text);
        const key = fold(n.title);
        if (byTitle.has(key)) { uebersprungen.push({ name, grund: `„${n.title}“ gibt es schon.` }); continue; }
        const rec = store.create('note', { title: n.title, body: n.body, tags: n.tags, source: 'import' });
        byTitle.set(key, rec.id);
        angelegt.push(rec.id);
      }
    };
    let graph = null;
    if (typeof rc.ctx.bulkWrite === 'function') await rc.ctx.bulkWrite(run, { onRederive: (bericht) => { graph = bericht; } });
    else run();
    return { angelegt: angelegt.length, ids: angelegt, uebersprungen, graph };
  });

  router.post('/api/notizen/link', async (rc) => {
    rc.requireCapability('write');
    const store = need(rc.ctx.store, 'Der Speicher');
    const body = asObject(await rc.body());
    const roh = requireString(body.url, 'url', { max: 2000 });
    let url;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(roh) ? roh : `https://${roh}`);
    } catch {
      throw new ValidationError(`„${roh.slice(0, 120)}“ ist keine Adresse.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ValidationError(`Nur http- und https-Adressen lassen sich speichern, nicht ${url.protocol}`);
    }
    const gewuenscht = optionalString(body.titel, 'titel', { max: 500 }) || '';

    let titel = gewuenscht;
    let titelGeholt = false;
    let grund = null;
    if (!titel) {
      const gate = rc.ctx.gate;
      if (!gate || typeof gate.fetch !== 'function') {
        grund = 'Keine Netz-Schleuse: nur die Adresse gespeichert.';
      } else if (gate.mode === 'offline') {
        grund = 'Neural OS ist offline: nur die Adresse gespeichert.';
      } else {
        try {
          const antwort = await gate.fetch(url.href, {
            scope: 'global',
            purpose: 'Link speichern: Seitentitel',
            maxBytes: MAX_TITEL_BYTES,
            timeoutMs: 8000,
            headers: { accept: 'text/html' },
          });
          const art = String(antwort.headers.get('content-type') || '');
          if (antwort.ok && /html/i.test(art)) {
            titel = seitenTitel(await antwort.text());
            titelGeholt = !!titel;
            if (!titel) grund = 'Die Seite hat keinen Titel: Adresse als Titel.';
          } else {
            grund = antwort.ok ? 'Die Adresse ist keine HTML-Seite: Adresse als Titel.' : `Die Seite antwortet mit HTTP ${antwort.status}: Adresse als Titel.`;
          }
        } catch (err) {
          grund = `${(err && err.message) || 'Seite nicht erreichbar'} – nur die Adresse gespeichert.`;
        }
      }
    }
    if (!titel) titel = titelAusUrl(url);
    const zeilen = [`Gespeicherter Link: ${url.href}`];
    const record = store.create('note', { title: titel, body: zeilen.join('\n'), tags: ['link'], source: 'user' });
    return { record, url: url.href, titelGeholt, grund };
  });
}

module.exports = {
  register,
  trefferGuete,
  linkKandidaten,
  tagKandidaten,
  seitenTitel,
  titelAusUrl,
  markdownZuNotiz,
  BILD_MIME,
  MAX_BILD_BYTES,
};
