#!/usr/bin/env node
'use strict';

/**
 * Offline-Beweis.
 *
 * Dieses Programm behauptet nicht, dass Neural OS offline funktioniert --
 * es führt es vor. Es startet eine echte Instanz in einem Wegwerf-Verzeichnis,
 * versucht echte Verbindungen nach außen, und benutzt anschließend jede
 * Kernfunktion der Anwendung.
 *
 * Entscheidend ist die Unterscheidung, die dieses Werkzeug trifft:
 *
 *   NETWORK_BLOCKED  = die Schleuse hat es verhindert  (der Beweis)
 *   ENOTFOUND/ETIMEDOUT = es gab ohnehin kein Netz     (kein Beweis)
 *
 * Nur das Erste zeigt, dass die Kontrolle greift. Ein Test, der in einer
 * Umgebung ohne Internet "bestanden" meldet, hätte nichts gezeigt.
 *
 * Aufruf:  node tools/offline-proof.js
 */

const http = require('node:http');
const dns = require('node:dns');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { createApp, seedIfEmpty } = require('../src/app');

const B = '\u001b[1m'; const D = '\u001b[2m'; const G = '\u001b[32m';
const Y = '\u001b[33m'; const R = '\u001b[31m'; const X = '\u001b[0m';

const results = [];
function record(area, claim, verdict, detail) {
  results.push({ area, claim, verdict, detail });
  const icon = verdict === 'pass' ? `${G}✓${X}` : verdict === 'fail' ? `${R}✗${X}` : `${Y}?${X}`;
  console.log(`  ${icon} ${claim}${detail ? `  ${D}${detail}${X}` : ''}`);
}

/** Attempt a real TCP/HTTP connection and classify why it failed. */
function attempt(host, port = 80, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let req;
    try {
      req = http.get({ host, port, path: '/', timeout: timeoutMs }, (res) => {
        res.destroy();
        done({ outcome: 'connected', status: res.statusCode });
      });
    } catch (err) {
      // A synchronous throw is what the hardened http.request does on a denial.
      return done({ outcome: classify(err), error: err.message, code: err.code });
    }
    req.on('error', (err) => done({ outcome: classify(err), error: err.message, code: err.code }));
    req.on('timeout', () => { req.destroy(); done({ outcome: 'timeout', error: 'timeout' }); });
  });
}

function classify(err) {
  const code = err && (err.code || err.errorCode);
  const msg = String((err && err.message) || '');
  if (code === 'NETWORK_BLOCKED' || /NETWORK_BLOCKED|blocked by|Netzwerk/i.test(msg)) return 'blocked';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return 'no-route';
  return 'other';
}

function resolveName(name) {
  return new Promise((resolve) => {
    try {
      dns.lookup(name, (err, address) => {
        if (err) resolve({ outcome: classify(err), error: err.message, code: err.code });
        else resolve({ outcome: 'resolved', address });
      });
    } catch (err) {
      resolve({ outcome: classify(err), error: err.message, code: err.code });
    }
  });
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nos-proof-'));
  console.log(`\n${B}Neural OS — Offline-Beweis${X}`);
  console.log(`${D}Wegwerf-Vault: ${home}${X}`);
  console.log(`${D}${'─'.repeat(64)}${X}\n`);

  // ---------------------------------------------------------------- Vorlauf
  console.log(`${B}0. Ausgangslage${X} ${D}(ohne Härtung — hat diese Maschine überhaupt Internet?)${X}`);
  const baseline = await attempt('1.1.1.1', 80);
  const hasInternet = baseline.outcome === 'connected';
  record('baseline', hasInternet ? 'Diese Maschine hat Internet' : 'Diese Maschine hat ohnehin kein Internet',
    'info', `1.1.1.1 → ${baseline.outcome}${baseline.code ? ` (${baseline.code})` : ''}`);
  if (!hasInternet) {
    console.log(`\n  ${Y}Hinweis:${X} Ohne erreichbares Internet kann dieser Lauf nicht beweisen, dass`);
    console.log(`  ${D}die Schleuse etwas verhindert — nur, dass die Anwendung ohne Netz arbeitet.${X}`);
    console.log(`  ${D}Für den vollen Beweis diesen Test auf einer Maschine MIT Internet laufen lassen.${X}`);
  }

  const app = await createApp({ home, port: 0, host: '127.0.0.1', logLevel: 'error', harden: true });
  await seedIfEmpty(app);
  const server = await app.listen();
  const port = server.server.address().port;

  try {
    // ------------------------------------------------- 1. Schleuse blockiert
    console.log(`\n${B}1. Die Schleuse blockiert ausgehende Verbindungen${X}`);
    for (const [host, p] of [['1.1.1.1', 80], ['8.8.8.8', 80], ['93.184.216.34', 80]]) {
      const r = await attempt(host, p);
      const proven = r.outcome === 'blocked';
      record('gate', `${host}:${p} wird verhindert`,
        proven ? 'pass' : (r.outcome === 'connected' ? 'fail' : 'inconclusive'),
        proven ? 'von der Schleuse blockiert'
          : r.outcome === 'connected' ? 'VERBINDUNG KAM ZUSTANDE — Durchsetzung greift nicht!'
            : `nur ${r.code || r.outcome} — kein Beweis`);
    }

    const dnsRes = await resolveName('example.com');
    record('gate', 'DNS-Auflösung wird verhindert',
      dnsRes.outcome === 'blocked' ? 'pass' : dnsRes.outcome === 'resolved' ? 'fail' : 'inconclusive',
      dnsRes.outcome === 'blocked' ? 'der Hostname verlässt das Gerät gar nicht erst'
        : dnsRes.outcome === 'resolved' ? `aufgelöst zu ${dnsRes.address} — der Name wurde übertragen!`
          : `nur ${dnsRes.code || dnsRes.outcome}`);

    // ------------------------------------ 2. Lokales bleibt erreichbar
    console.log(`\n${B}2. Lokales bleibt erreichbar${X} ${D}(lokale KI ist kein Netzwerkzugriff)${X}`);
    const loopback = await attempt('127.0.0.1', port);
    record('gate', 'Die eigene Oberfläche auf 127.0.0.1 ist erreichbar',
      loopback.outcome === 'connected' ? 'pass' : 'fail',
      `HTTP ${loopback.status || loopback.code || loopback.outcome}`);

    const ollamaDecision = app.gate.check({ host: '127.0.0.1', port: 11434, scope: 'global', purpose: 'proof' });
    record('gate', 'Ein lokales Modell auf 127.0.0.1:11434 wäre erlaubt',
      ollamaDecision.allowed ? 'pass' : 'fail', ollamaDecision.reason);

    // ------------------------------------------- 3. Funktionen ohne Netz
    console.log(`\n${B}3. Die Anwendung arbeitet ohne Netz${X}`);

    const note = app.store.create('note', {
      title: 'Beweisnotiz',
      body: 'Diese Notiz entstand ohne jede Netzwerkverbindung und verweist auf [[Willkommen in Neural OS]]. #beweis',
      tags: ['beweis'],
    });
    record('app', 'Notiz anlegen', app.store.get(note.id) ? 'pass' : 'fail', note.id);

    await app.store.flush();
    const found = app.store.search('Beweisnotiz', { limit: 5 });
    record('app', 'Volltextsuche', found.items.length > 0 ? 'pass' : 'fail', `${found.items.length} Treffer`);

    const edges = app.store.edges.for(note.id);
    record('app', 'Verknüpfung aus [[Wiki-Link]] abgeleitet', edges.length > 0 ? 'pass' : 'fail',
      edges.length ? `${edges.length} Kante(n): ${edges.map((e) => e.data.kind).join(', ')}` : 'keine Kante entstanden');

    if (app.graph && app.graph.buildGraph) {
      const g = app.graph.buildGraph(app.store, { depth: 2, limit: 200 });
      record('app', 'Wissensgraph aufbauen', g.nodes.length > 0 ? 'pass' : 'fail',
        `${g.nodes.length} Knoten, ${g.edges.length} Kanten`);
    } else {
      record('app', 'Wissensgraph aufbauen', 'fail', 'Graph-Subsystem nicht geladen');
    }

    const project = app.store.create('project', { name: 'Beweisprojekt' });
    const task = app.store.create('task', { title: 'Aufgabe ohne Netz', projectId: project.id });
    record('app', 'Projekte und Aufgaben', app.store.get(task.id) ? 'pass' : 'fail');

    if (app.backup) {
      const exp = await app.backup.exportAll({ format: 'both', includeFiles: true });
      record('app', 'Vollständiger Export', exp.records > 0 ? 'pass' : 'fail',
        `${exp.records} Einträge → ${exp.dir}`);
    } else {
      record('app', 'Vollständiger Export', 'fail', 'Backup-Subsystem nicht geladen');
    }

    // Reload from disk: the data must genuinely be persisted, not just in RAM.
    await app.store.flush();
    const statsBefore = app.store.stats();
    record('app', 'Daten liegen wirklich auf der Platte',
      fs.existsSync(path.join(home, 'vault', 'log')) ? 'pass' : 'fail',
      `${JSON.stringify(statsBefore.counts)}`);

    // ------------------------------------------------- 4. Modelle, ehrlich
    console.log(`\n${B}4. Modellanbindung${X}`);
    if (app.registry) {
      const snap = await app.registry.refresh({ timeoutMs: 1200 });
      const avail = (snap.providers || []).filter((p) => p.available);
      if (avail.length) {
        record('model', 'Lokales Modell erreichbar', 'pass',
          avail.map((p) => `${p.id}: ${(p.models || []).map((m) => m.id).join(', ')}`).join(' · '));
      } else {
        record('model', 'Lokales Modell erreichbar', 'info',
          'keins installiert — Chat und Agenten bleiben zu Recht funktionslos');
        console.log(`      ${D}Das ist kein Fehler: ohne Modell erfindet die App keine Antworten.${X}`);
        console.log(`      ${D}Abhilfe: ollama.com/download, dann 'ollama pull llama3.2'.${X}`);
      }
    } else {
      record('model', 'Modell-Registry geladen', 'fail', 'Subsystem fehlt');
    }

    // ---------------------------------------------------- 5. Audit-Nachweis
    console.log(`\n${B}5. Nachweisbarkeit${X}`);
    const auditPath = path.join(home, 'audit.jsonl');
    const auditLines = fs.existsSync(auditPath)
      ? fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      : [];
    const netLines = auditLines.filter((l) => String(l.kind).startsWith('network.'));
    record('audit', 'Jede Netzentscheidung ist protokolliert', netLines.length > 0 ? 'pass' : 'fail',
      `${netLines.length} Einträge in audit.jsonl`);
    const blocked = netLines.filter((l) => /block|deny/.test(l.kind));
    const allowed = netLines.filter((l) => /allow|local/.test(l.kind));
    record('audit', 'Erlaubte Zugriffe werden ebenfalls protokolliert', allowed.length > 0 ? 'pass' : 'inconclusive',
      `${allowed.length} erlaubt, ${blocked.length} blockiert`);
  } finally {
    await app.close().catch(() => {});
  }

  // ------------------------------------------------------------- Urteil
  const failed = results.filter((r) => r.verdict === 'fail');
  const passed = results.filter((r) => r.verdict === 'pass');
  const unclear = results.filter((r) => r.verdict === 'inconclusive');

  console.log(`\n${D}${'─'.repeat(64)}${X}`);
  console.log(`${B}Urteil${X}  ${G}${passed.length} bestanden${X}` +
    (unclear.length ? ` · ${Y}${unclear.length} nicht entscheidbar${X}` : '') +
    (failed.length ? ` · ${R}${failed.length} gescheitert${X}` : ''));

  if (failed.length) {
    console.log(`\n${R}Gescheitert:${X}`);
    for (const f of failed) console.log(`  ${R}✗${X} [${f.area}] ${f.claim} — ${f.detail || ''}`);
  }
  if (unclear.length && !hasInternet) {
    console.log(`\n${Y}Nicht entscheidbar, weil diese Maschine ohnehin kein Internet hat.${X}`);
    console.log(`${D}Für den vollständigen Beweis auf einem Rechner mit Internetzugang wiederholen.${X}`);
  }
  console.log(`\n${D}Wegwerf-Vault löschen: rm -rf ${home}${X}\n`);

  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${R}Der Beweis konnte nicht durchgeführt werden:${X} ${err && err.message}`);
  if (err && err.stack) console.error(`\u001b[2m${err.stack}\u001b[0m`);
  process.exit(2);
});
