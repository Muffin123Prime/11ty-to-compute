'use strict';

/**
 * What a pasted module may do.
 *
 * The honest framing, stated once here and repeated to the user in the
 * workshop: this is a guard rail, not a prison. Its purpose is to keep a
 * mistake -- in code the user asked an assistant to write -- from quietly
 * costing them their notes, their files or their privacy. It is NOT a defence
 * against code that is deliberately trying to escape, because `node:vm` is not
 * a security boundary and never claimed to be.
 *
 * What it does buy, concretely:
 *  - A module with no network capability cannot reach the network, because the
 *    gate is patched process-wide and its scope carries no grant.
 *  - A module with no file capability has no `fs` in its context at all.
 *  - Every capability is named in plain German BEFORE installation, with its
 *    consequence, so "install" is an informed act rather than a shrug.
 *  - Everything is reversible, which is what actually keeps the user safe.
 */

const { ValidationError } = require('../kernel/errors');

/**
 * @typedef {Object} Capability
 * @property {string} id
 * @property {string} label     short German name
 * @property {string} hint      what it allows, and what it costs
 * @property {'low'|'medium'|'high'} risk
 * @property {'ui'|'server'|'both'} kind  where it is meaningful
 */

/** @type {Capability[]} */
const CAPABILITIES = [
  {
    id: 'records.read',
    label: 'Einträge lesen',
    hint: 'Darf Notizen, Projekte, Aufgaben, Chats und Verknüpfungen lesen. Das ist dein gesamter Wissensbestand.',
    risk: 'medium',
    kind: 'both',
  },
  {
    id: 'records.write',
    label: 'Einträge ändern',
    hint: 'Darf Einträge anlegen, ändern und löschen. Ein Fehler hier kann Daten überschreiben – die Löschung ist umkehrbar, eine falsche Änderung nur über die Sicherung.',
    risk: 'high',
    kind: 'both',
  },
  {
    id: 'bus.listen',
    label: 'Ereignissen zuhören',
    hint: 'Wird benachrichtigt, wenn sich etwas ändert. Sieht dadurch mit, was du tust, während die App läuft.',
    risk: 'medium',
    kind: 'server',
  },
  {
    id: 'tools.add',
    label: 'Werkzeuge für Agenten bereitstellen',
    hint: 'Fügt Agenten neue Werkzeuge hinzu. Ein Agent kann das Werkzeug dann benutzen – begrenzt durch die Rechte des Agenten UND die dieses Moduls.',
    risk: 'medium',
    kind: 'server',
  },
  {
    id: 'routes.add',
    label: 'Eigene Adressen bereitstellen',
    hint: 'Darf neue Adressen unter /api/x/… anbieten. Sie sind für jeden erreichbar, der die Oberfläche erreicht – bei aktiver Freigabe also auch für andere Geräte.',
    risk: 'high',
    kind: 'server',
  },
  {
    id: 'files.read',
    label: 'Dateien lesen',
    hint: 'Darf Dateien in den unten freigegebenen Ordnern lesen. Ohne freigegebenen Ordner ist die Berechtigung wirkungslos.',
    risk: 'high',
    kind: 'server',
  },
  {
    id: 'files.write',
    label: 'Dateien schreiben',
    hint: 'Darf Dateien in den freigegebenen Ordnern anlegen und überschreiben. Überschriebene Dateien sind weg – Neural OS sichert sie nicht.',
    risk: 'high',
    kind: 'server',
  },
  {
    id: 'model.use',
    label: 'Das Modell benutzen',
    hint: 'Darf das lokale Sprachmodell aufrufen. Kostet Rechenzeit auf diesem Gerät, sonst nichts.',
    risk: 'low',
    kind: 'server',
  },
  {
    id: 'net.lan',
    label: 'Lokales Netz',
    hint: 'Darf Geräte im eigenen Netz erreichen. Geht weiterhin durch die Schleuse und steht im Netz-Protokoll.',
    risk: 'high',
    kind: 'server',
  },
  {
    id: 'net.online',
    label: 'Internet',
    hint: 'Darf das öffentliche Internet erreichen. Alles, was das Modul sendet, verlässt dein Gerät. Geht durch die Schleuse und steht im Protokoll.',
    risk: 'high',
    kind: 'server',
  },
  {
    id: 'ui.view',
    label: 'Eigene Ansicht',
    hint: 'Fügt der Seitenleiste eine Ansicht hinzu. Läuft im Browser und kann nur diesen Server erreichen – die Content-Security-Policy verbietet alles andere.',
    risk: 'low',
    kind: 'ui',
  },
  {
    id: 'ui.command',
    label: 'Eigener Befehl',
    hint: 'Fügt der Befehlspalette (Strg+K) einen Eintrag hinzu.',
    risk: 'low',
    kind: 'ui',
  },
  {
    id: 'ui.api',
    label: 'Die Oberflächen-Schnittstelle benutzen',
    hint: 'Darf dieselben Adressen aufrufen wie die App selbst – also alles lesen und ändern, was du auch könntest.',
    risk: 'medium',
    kind: 'ui',
  },
];

const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

const RISK_ORDER = { low: 0, medium: 1, high: 2 };

function get(id) {
  return BY_ID.get(id) || null;
}

function known(id) {
  return BY_ID.has(id);
}

/** Capabilities that make sense for a module of this kind. */
function forKind(kind) {
  return CAPABILITIES.filter((c) => c.kind === kind || c.kind === 'both');
}

/**
 * Validate a requested capability list.
 * Unknown entries are an error, not a silent drop: a module asking for
 * something this version does not have will not work, and the user deserves to
 * learn that at install time rather than through a mysterious failure later.
 */
function validate(list, kind) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new ValidationError('capabilities muss eine Liste sein.');
  const allowed = new Set(forKind(kind).map((c) => c.id));
  const out = [];
  const unknown = [];
  const wrongKind = [];
  for (const raw of list) {
    const id = String(raw || '').trim();
    if (!id) continue;
    if (!known(id)) { unknown.push(id); continue; }
    if (!allowed.has(id)) { wrongKind.push(id); continue; }
    if (!out.includes(id)) out.push(id);
  }
  const problems = [];
  if (unknown.length) problems.push(`unbekannt: ${unknown.join(', ')}`);
  if (wrongKind.length) {
    problems.push(`für ein ${kind === 'ui' ? 'Oberflächen' : 'Server'}-Modul nicht anwendbar: ${wrongKind.join(', ')}`);
  }
  if (problems.length) {
    throw new ValidationError(
      `Die verlangten Berechtigungen stimmen nicht (${problems.join('; ')}). `
      + `Erlaubt sind: ${forKind(kind).map((c) => c.id).join(', ')}.`,
    );
  }
  return out;
}

/** The highest risk level in a list. Drives how loud the install dialog is. */
function riskOf(list) {
  let worst = 'low';
  for (const id of list || []) {
    const cap = get(id);
    if (cap && RISK_ORDER[cap.risk] > RISK_ORDER[worst]) worst = cap.risk;
  }
  return worst;
}

/**
 * Plain-German summary, for the install dialog and the module list.
 * It says what the module may do AND what it may not -- a list of granted
 * permissions alone reads like a feature list and tells nobody what is out of
 * reach.
 */
function describe(list, kind = 'server') {
  const granted = new Set(list || []);
  const relevant = forKind(kind);
  const yes = relevant.filter((c) => granted.has(c.id));
  const notable = ['records.write', 'files.write', 'net.online', 'net.lan', 'routes.add'];
  const no = relevant.filter((c) => !granted.has(c.id) && notable.includes(c.id));

  const lines = [];
  if (!yes.length) {
    lines.push('Verlangt keine Berechtigungen. Kann weder Daten lesen noch ändern.');
  } else {
    lines.push(`Darf: ${yes.map((c) => c.label.toLowerCase()).join(', ')}.`);
  }
  if (no.length) {
    lines.push(`Darf NICHT: ${no.map((c) => c.label.toLowerCase()).join(', ')}.`);
  }
  if (!granted.has('net.lan') && !granted.has('net.online')) {
    lines.push('Kein Netzzugang – dieses Modul kann nichts von deinem Gerät senden.');
  }
  return lines.join(' ');
}

/** The gate scope a server module's requests are made under. */
function networkScope(moduleId) {
  return `module:${moduleId}`;
}

/** 'offline' | 'lan' | 'online' -- the ceiling handed to gate.fetch. */
function networkLevel(list) {
  const granted = new Set(list || []);
  if (granted.has('net.online')) return 'online';
  if (granted.has('net.lan')) return 'lan';
  return 'offline';
}

module.exports = {
  CAPABILITIES,
  get,
  known,
  forKind,
  validate,
  riskOf,
  describe,
  networkScope,
  networkLevel,
};
