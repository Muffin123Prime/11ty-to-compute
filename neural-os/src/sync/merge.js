'use strict';

const crypto = require('node:crypto');

const { ValidationError } = require('../kernel/errors');

/**
 * The merge rules for device synchronisation. Pure: no network, no
 * filesystem, no store, no clock of its own.
 *
 * Why a recorded common ancestor and not a comparison of `rev`/`updatedAt`
 * -----------------------------------------------------------------------
 * The obvious design is "higher rev wins, or newer updatedAt wins". Both are
 * wrong here, and both lose data:
 *
 *  - `rev` is assigned by the LOCAL store. A record that arrives from a peer
 *    is created here at rev 1 even though it carried rev 7 there, so the two
 *    counters do not live in the same sequence and comparing them is
 *    meaningless across devices.
 *  - `updatedAt` comes from two different wall clocks. A laptop whose clock
 *    is four minutes behind would silently lose every edit it made in those
 *    four minutes.
 *
 * What both of those try to approximate is a real question: *has this side
 * changed since the two devices last agreed?* That question has an exact
 * answer if the agreement itself is written down. After every successful
 * merge we store one content fingerprint per record -- the state both sides
 * held at that moment -- and from then on:
 *
 *      local  != base  ->  this device changed it
 *      remote != base  ->  the other device changed it
 *      both            ->  CONFLICT, and nobody gets overwritten
 *
 * That is exact, symmetric, and immune to clock skew and to rev numbering.
 * `rev` and `updatedAt` are still carried into the conflict record, because a
 * human deciding between two versions wants to see them.
 *
 * Without a base (the two devices have never agreed on this record) a
 * differing record is a CONFLICT, full stop. It is tempting to fall back to
 * "the newer timestamp wins" there, and that is precisely the line where real
 * synchronisations quietly delete a day of work. A conflict costs the user one
 * click; a wrong guess costs them the text.
 */

/** A record that is absent and a record that is tombstoned are the same state. */
const GONE = 'gone';

/**
 * Types that travel between devices.
 *
 * Everything left out is left out on purpose:
 *  - `token`, `grant`  credentials and egress policy. A peer that can push
 *    these could grant itself the internet or mint an access token, which
 *    would make synchronisation a privilege escalation channel.
 *  - `agent` carries a permission block (file roots, network level, approval
 *    requirement). Same reasoning as `src/http/api/records.js`: a second door
 *    into a permission system is a hole in it.
 *  - `peer` holds the ACCESS TOKENS of other devices in clear text.
 *  - `conflict`, `approval`, `run` record what happened on one device. They
 *    describe local decisions and local executions, not shared knowledge.
 *  - `schedule`, `trigger` would make an agent run TWICE -- once on each
 *    device -- for a single intention. Worse, they carry `enabled`, so a peer
 *    could switch on something that runs by itself on a machine its owner is
 *    not looking at. Automation is a per-device decision, like the network
 *    mode, and it is made where it takes effect.
 *  - `watch` names a path. A folder on one machine does not exist on the
 *    other, and a peer that could switch one on would have a way to make a
 *    foreign machine read a directory of its choosing.
 *  - `suggestion` is a local reading of a local vault. Once the notes it is
 *    about have travelled, the other device produces its own suggestions in
 *    milliseconds -- and a "dismissed" decision made there belongs to whoever
 *    made it, not to everyone.
 *
 * This is an ALLOW-list, and that is the point: a record type added later is
 * excluded until someone decides what sharing it would mean. The opposite
 * (a deny-list) would share every new type by default and only stop the ones
 * somebody remembered.
 */
const SYNC_TYPES = ['note', 'project', 'task', 'event', 'entity', 'memory', 'chat', 'message', 'file', 'edge'];

const CLASSIFICATIONS = ['identical', 'remote-newer', 'local-newer', 'conflict', 'remote-only', 'local-only'];

/**
 * Two devices whose clocks differ by more than this are reported, and the one
 * decision whose damage a user notices late -- an incoming deletion -- is
 * escalated to a conflict instead of being carried out.
 */
const DEFAULT_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Why a record that once existed here is not here any more. The applier
 * records the matching key on the base entry, so the reason survives into
 * every later run instead of degrading into a generic "deleted".
 */
const WITHHELD_DETAIL = {
  purged: 'Dieser Eintrag wurde hier endgültig gelöscht. Endgültige Löschungen werden nicht übertragen und nicht '
    + 'rückgängig gemacht.',
  duplicate: 'Diese Verknüpfung existiert hier bereits unter einer anderen ID.',
  'blob-missing': 'Der Inhalt dieser Datei liegt nur auf dem anderen Gerät. Dateiinhalte werden noch nicht '
    + 'übertragen, deshalb wird hier kein Eintrag angelegt, der ins Leere zeigt.',
};

/** Deterministic JSON: key order must not change a fingerprint. */
function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Content identity of a record, independent of `rev`, `updatedAt` and of which
 * device produced it. A tombstone collapses to {@link GONE} together with
 * "never existed here": for the merged outcome it makes no difference whether
 * the other side deleted the record or never saw it.
 *
 * @param {object|null} record
 * @returns {string}
 */
function fingerprint(record) {
  if (!record || record.deletedAt) return GONE;
  const body = stableStringify({ type: record.type, data: record.data === undefined ? null : record.data });
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 24);
}

function isSyncable(type) {
  return SYNC_TYPES.includes(type);
}

/** A base entry may be given as the bare hash or as `{h, at, note}`. */
function baseHash(base) {
  if (base === null || base === undefined) return null;
  if (typeof base === 'string') return base || null;
  if (typeof base === 'object' && typeof base.h === 'string' && base.h) return base.h;
  return null;
}

function baseNote(base) {
  return base && typeof base === 'object' && typeof base.note === 'string' ? base.note : null;
}

/**
 * How two versions of one record relate.
 *
 * @param {object|null} local  the record as this device holds it (tombstones included)
 * @param {object|null} remote the record as the peer sent it
 * @param {{h:string}|string|null} [base] the state both devices last agreed on
 * @returns {'identical'|'remote-newer'|'local-newer'|'conflict'|'remote-only'|'local-only'}
 */
function classify(local, remote, base) {
  if (!local && !remote) {
    throw new ValidationError('classify() braucht mindestens eine der beiden Fassungen.');
  }

  const bh = baseHash(base);

  if (!local) {
    // A tombstone we never had is nothing to do: both sides agree it is gone.
    if (remote.deletedAt) return 'identical';
    if (!bh) return 'remote-only';
    // The agreed state was "gone" and the peer has brought the record back.
    // Nothing was purged here -- we simply never held it -- so this is an
    // ordinary successor and creating it loses nothing.
    if (bh === GONE) return 'remote-newer';
    // We once agreed on actual content and the record is no longer here at
    // all, not even as a tombstone. Only a hard purge does that, and a purge
    // is irreversible and deliberate. Re-creating it from the peer would undo
    // an explicit decision, so the local side stands and the caller reports it.
    return 'local-newer';
  }

  if (!remote) {
    if (local.deletedAt) return 'identical';
    return 'local-only';
  }

  const lh = fingerprint(local);
  const rh = fingerprint(remote);
  if (lh === rh) return 'identical';
  if (!bh) return 'conflict';
  if (lh === bh) return 'remote-newer';
  if (rh === bh) return 'local-newer';
  return 'conflict';
}

/** Which store operation turns `local` into `remote`. */
function actionFor(local, remote) {
  const remoteGone = !remote || !!remote.deletedAt;
  if (!local) return remoteGone ? 'none' : 'create';
  if (remoteGone) return local.deletedAt ? 'none' : 'delete';
  return local.deletedAt ? 'restore' : 'update';
}

function toMap(records) {
  if (records instanceof Map) return records;
  const map = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record && typeof record.id === 'string') map.set(record.id, record);
  }
  return map;
}

function parseTime(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** German one-liner describing which side looks newer, for the conflict record. */
function describeSides(local, remote) {
  const lt = parseTime(local && local.updatedAt);
  const rt = parseTime(remote && remote.updatedAt);
  if (lt === null || rt === null) return 'Beide Geräte haben diesen Eintrag seit dem letzten Abgleich geändert.';
  if (lt === rt) return 'Beide Fassungen tragen denselben Zeitstempel; entscheide nach Inhalt.';
  const newer = lt > rt ? 'Diese Gerät' : 'Das Partnergerät';
  const delta = Math.abs(lt - rt);
  return `Beide Geräte haben diesen Eintrag geändert. ${newer} hat die jüngere Fassung `
    + `(${Math.round(delta / 1000)} s Unterschied) -- der Zeitstempel entscheidet hier aber nichts.`;
}

/**
 * Decide what to do with a batch of records a peer sent us.
 *
 * Only ids present in `remoteRecords` are judged. A record missing from an
 * incremental delta means "unchanged since the watermark", NOT "deleted over
 * there" -- reading it as a deletion would wipe the local vault on the first
 * partial page. `opts.includeLocalOnly` additionally lists local ids the peer
 * did not send; it is off by default for exactly that reason.
 *
 * @param {Array|Map} localRecords records this device holds, tombstones included
 * @param {Array} remoteRecords    records the peer sent
 * @param {{bases?:object, watermark?:number}} [state] agreed state per record id
 * @param {{clockSkewMs?:number, skewToleranceMs?:number, includeLocalOnly?:boolean}} [opts]
 * @returns {{apply:Array, conflicts:Array, skip:Array, localOnly:Array, identical:Array, warnings:string[], stats:object}}
 */
function plan(localRecords, remoteRecords, state = {}, opts = {}) {
  const locals = toMap(localRecords);
  const bases = (state && typeof state.bases === 'object' && state.bases) || {};
  const tolerance = Number.isFinite(opts.skewToleranceMs) && opts.skewToleranceMs >= 0
    ? opts.skewToleranceMs
    : DEFAULT_SKEW_TOLERANCE_MS;
  const skewMs = Number.isFinite(opts.clockSkewMs) ? opts.clockSkewMs : 0;
  const skewed = Math.abs(skewMs) > tolerance;

  const apply = [];
  const conflicts = [];
  const skip = [];
  const identical = [];
  const localOnly = [];
  const warnings = [];
  const seen = new Set();

  if (skewed) {
    warnings.push(
      `Die Uhren der beiden Geräte weichen um ${Math.round(Math.abs(skewMs) / 1000)} Sekunden voneinander ab. `
      + 'Eingehende Löschungen werden deshalb nicht ausgeführt, sondern als Konflikt vorgelegt.',
    );
  }

  for (const remote of Array.isArray(remoteRecords) ? remoteRecords : []) {
    if (!remote || typeof remote.id !== 'string' || typeof remote.type !== 'string') {
      skip.push({ id: (remote && remote.id) || null, type: null, reason: 'malformed', detail: 'Der Datensatz hat keine brauchbare ID oder Art.' });
      continue;
    }
    if (seen.has(remote.id)) {
      skip.push({ id: remote.id, type: remote.type, reason: 'duplicate-in-batch', detail: 'Der Partner hat denselben Eintrag zweimal geschickt.' });
      continue;
    }
    seen.add(remote.id);

    if (!isSyncable(remote.type)) {
      skip.push({
        id: remote.id,
        type: remote.type,
        reason: 'type-not-synced',
        detail: `Einträge der Art "${remote.type}" werden zwischen Geräten grundsätzlich nicht übertragen.`,
      });
      continue;
    }

    const local = locals.get(remote.id) || null;
    if (local && local.type !== remote.type) {
      // Two different things wearing one id. Overwriting either would destroy
      // one of them, so neither is touched.
      skip.push({
        id: remote.id,
        type: remote.type,
        reason: 'type-mismatch',
        detail: `Hier ist ${remote.id} ein Eintrag der Art "${local.type}", beim Partner "${remote.type}".`,
      });
      continue;
    }

    const base = bases[remote.id] || null;
    let classification = classify(local, remote, base);
    const hash = fingerprint(remote);

    if (skewed && classification === 'remote-newer' && remote.deletedAt && local && !local.deletedAt) {
      // Deliberate extra caution, not a correctness requirement: the base says
      // this deletion is safe, and it is. But a device with a wrong clock has
      // a wrong idea of its own history in other places too, and an incoming
      // deletion is the one operation whose damage is noticed late.
      classification = 'conflict';
    }

    if (classification === 'identical') {
      identical.push({ id: remote.id, type: remote.type, hash });
      continue;
    }

    if (classification === 'conflict') {
      conflicts.push({
        recordId: remote.id,
        recordType: remote.type,
        local: local || null,
        remote,
        base: baseHash(base),
        reason: base
          ? describeSides(local, remote)
          : 'Dieser Eintrag ist auf beiden Geräten vorhanden, aber unterschiedlich, und die Geräte haben ihn noch nie '
            + 'gemeinsam abgeglichen. Ohne gemeinsamen Stand lässt sich nicht feststellen, welche Fassung die neuere ist.',
      });
      continue;
    }

    if (classification === 'local-newer') {
      const note = baseNote(base);
      skip.push({
        id: remote.id,
        type: remote.type,
        reason: local ? 'local-newer' : (note || 'purged'),
        detail: local
          ? 'Die hiesige Fassung ist die neuere; der Partner erhält sie beim nächsten Senden.'
          : (WITHHELD_DETAIL[note] || WITHHELD_DETAIL.purged),
      });
      continue;
    }

    // remote-only | remote-newer
    const action = actionFor(local, remote);
    if (action === 'none') {
      identical.push({ id: remote.id, type: remote.type, hash });
      continue;
    }
    apply.push({ id: remote.id, type: remote.type, action, classification, record: remote, local, hash });
  }

  if (opts.includeLocalOnly === true) {
    for (const [id, local] of locals) {
      if (seen.has(id)) continue;
      if (!local || local.deletedAt) continue;
      if (!isSyncable(local.type)) continue;
      localOnly.push({ id, type: local.type, record: local, classification: 'local-only', hash: fingerprint(local) });
    }
  }

  // Nodes before edges: an edge whose endpoints arrive in the same batch must
  // not be refused because they are not there yet.
  apply.sort((a, b) => (a.type === 'edge' ? 1 : 0) - (b.type === 'edge' ? 1 : 0));

  return {
    apply,
    conflicts,
    skip,
    localOnly,
    identical,
    warnings,
    clockSkewMs: skewMs,
    skewed,
    stats: {
      considered: seen.size,
      apply: apply.length,
      conflicts: conflicts.length,
      skip: skip.length,
      identical: identical.length,
      localOnly: localOnly.length,
    },
  };
}

/* ------------------------------------------------------ beide behalten */

/**
 * Konflikte ohne Rückfrage (Bauplan 2.8): Zwei gekoppelte Sticks müssten eine
 * Rückfrage beide beantworten, und widersprüchliche Antworten liefen still
 * auseinander (belegt, v4). Stattdessen entscheidet eine Regel, die auf
 * beiden Sticks dasselbe ergibt, ohne dass sie sich absprechen:
 *
 *  - Sieger ist die Fassung mit dem kleineren Fingerabdruck. Das hängt nur
 *    vom Inhalt ab, nicht davon, wer rechnet.
 *  - Die andere Fassung bleibt als neuer Satz erhalten. Ihre ID folgt aus der
 *    ID des Satzes und dem Fingerabdruck der Verlierer-Fassung, also legen
 *    beide Sticks DIESELBE Kopie an. Sie hat 32 statt 24 Zeichen; daran ist
 *    sie erkennbar, und von einer Kopie gibt es nie wieder eine Kopie – sonst
 *    liefe das nie zusammen.
 *  - Gelöscht gegen geändert: die lebende Fassung gewinnt, ohne Kopie.
 *  - Verknüpfungen: nur der Sieger; eine zweite Kante wäre dieselbe Kante.
 */

/** Länge des Zufallsteils einer Konflikt-Kopie; gewöhnliche IDs haben 24. */
const KOPIE_LAENGE = 32;
const KOPIE_RE = new RegExp(`^[a-z]+_[0-9a-z]{${KOPIE_LAENGE}}$`);

/** Wo der Titelzusatz hingehört, und wie lang das Feld sein darf (schema.js). */
const TITEL_FELD = {
  note: { feld: 'title', max: 500 },
  task: { feld: 'title', max: 500 },
  event: { feld: 'title', max: 500 },
  chat: { feld: 'title', max: 500 },
  project: { feld: 'name', max: 500 },
  entity: { feld: 'name', max: 300 },
};

/** Ist das die ID einer Konflikt-Kopie? */
function istKopieId(id) {
  return typeof id === 'string' && KOPIE_RE.test(id);
}

/**
 * Die feste ID der Kopie: `<typ>_` + 32 Zeichen base36 aus
 * sha256(recordId|fingerprintVerlierer).
 */
function kopieId(type, recordId, verliererHash) {
  const hex = crypto.createHash('sha256').update(`${recordId}|${verliererHash}`).digest('hex');
  const b36 = BigInt(`0x${hex}`).toString(36).padStart(50, '0');
  return `${type}_${b36.slice(-KOPIE_LAENGE)}`;
}

/** Der Zusatz steht immer ganz; gekürzt wird notfalls der Titel davor. */
function mitZusatz(titel, zusatz, max) {
  const zeichen = [...String(titel === undefined || titel === null ? '' : titel)];
  const platz = Math.max(0, max - [...zusatz].length);
  return `${zeichen.slice(0, platz).join('')}${zusatz}`;
}

/** Der Titel ohne „ (Fassung von …)“, für die Meldung über zwei Fassungen. */
function titelOhneZusatz(record) {
  const art = record && TITEL_FELD[record.type];
  const wert = art && record.data ? record.data[art.feld] : null;
  if (typeof wert !== 'string') return '';
  return wert.replace(/ \(Fassung von [^()]*\)$/, '');
}

/**
 * @param {{recordId:string, recordType:string, local:object|null, remote:object}} konflikt
 * @param {{nameLokal?:string, nameFern?:string}} [namen] Namen der beiden Sticks
 * @returns {{sieger:'lokal'|'fern', kopie:{id:string,type:string,data:object}|null}}
 */
function beideBehalten(konflikt, { nameLokal, nameFern } = {}) {
  if (!konflikt || !konflikt.remote) throw new ValidationError('beideBehalten() braucht einen Konflikt mit beiden Fassungen.');
  const local = konflikt.local || null;
  const remote = konflikt.remote;
  const lh = fingerprint(local);
  const rh = fingerprint(remote);
  if (lh === GONE) return { sieger: 'fern', kopie: null };
  if (rh === GONE) return { sieger: 'lokal', kopie: null };
  const sieger = lh <= rh ? 'lokal' : 'fern';

  const type = konflikt.recordType || remote.type;
  const recordId = konflikt.recordId || remote.id;
  if (type === 'edge' || istKopieId(recordId)) return { sieger, kopie: null };

  const verlierer = sieger === 'lokal' ? remote : local;
  const verliererHash = sieger === 'lokal' ? rh : lh;
  const name = (sieger === 'lokal' ? nameFern : nameLokal) || 'einem anderen Stick';
  const data = JSON.parse(JSON.stringify(verlierer.data === undefined ? {} : verlierer.data));
  const art = TITEL_FELD[type];
  if (art) data[art.feld] = mitZusatz(data[art.feld], ` (Fassung von ${name})`, art.max);
  return { sieger, kopie: { id: kopieId(type, recordId, verliererHash), type, data } };
}

module.exports = {
  GONE,
  SYNC_TYPES,
  WITHHELD_DETAIL,
  CLASSIFICATIONS,
  DEFAULT_SKEW_TOLERANCE_MS,
  KOPIE_LAENGE,
  stableStringify,
  fingerprint,
  isSyncable,
  classify,
  actionFor,
  baseHash,
  plan,
  beideBehalten,
  kopieId,
  istKopieId,
  titelOhneZusatz,
};
