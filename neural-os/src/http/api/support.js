'use strict';

/**
 * Shared helpers for the API route modules.
 *
 * Three things every route needs, kept in one place so that a route file
 * contains policy and nothing else:
 *
 * 1. `need()` -- a subsystem this instance does not have answers 503 with a
 *    German sentence naming it. The server is assembled from independently
 *    built parts and any of them may be absent (a failed optional load, a
 *    reduced test setup). A missing subsystem must never crash the process and
 *    must never be replaced by something that pretends to work.
 * 2. Strict readers for user input. Everything that arrives over HTTP is
 *    hostile until proven otherwise, and a `ValidationError` with a sentence
 *    the user can act on is worth more than a stack trace.
 * 3. Query-parameter readers that clamp instead of coercing. `?limit=1e9` must
 *    not turn into an allocation, and `?limit=abc` must not become NaN.
 */

const { NeuralError, ValidationError, NotFoundError } = require('../../kernel/errors');

/** 503 for a subsystem that was not wired into this instance. */
function unavailable(label, hint) {
  return new NeuralError(
    'SUBSYSTEM_UNAVAILABLE',
    `${label} ist in dieser Instanz nicht verfügbar.${hint ? ` ${hint}` : ''}`,
    { status: 503, details: { subsystem: label } },
  );
}

/** @returns the value, or throws the 503 above. */
function need(value, label, hint) {
  if (value === null || value === undefined || value === false) throw unavailable(label, hint);
  return value;
}

/** Like `need`, but also insists the object really carries the method we call. */
function needMethod(value, method, label, hint) {
  if (!value || typeof value[method] !== 'function') throw unavailable(label, hint);
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asObject(value, what = 'Der Anfragekörper') {
  if (!isPlainObject(value)) throw new ValidationError(`${what} muss ein JSON-Objekt sein.`);
  return value;
}

/**
 * @param {*} value
 * @param {string} field name as the caller sent it, used verbatim in the message
 * @param {{max?:number, min?:number, trim?:boolean}} [opts]
 */
function requireString(value, field, opts = {}) {
  const max = opts.max ?? 10000;
  const min = opts.min ?? 1;
  if (typeof value !== 'string') throw new ValidationError(`"${field}" muss ein Text sein.`);
  const out = opts.trim === false ? value : value.trim();
  if (out.length < min) throw new ValidationError(`"${field}" darf nicht leer sein.`);
  if (out.length > max) throw new ValidationError(`"${field}" ist zu lang (${out.length} Zeichen, erlaubt sind ${max}).`);
  return out;
}

/** @returns {string|undefined} undefined when the key was not sent at all. */
function optionalString(value, field, opts = {}) {
  if (value === undefined) return undefined;
  if (value === null) return opts.nullable === false ? undefined : null;
  return requireString(value, field, { ...opts, min: opts.min ?? 0 });
}

function requireStringArray(value, field, opts = {}) {
  const maxItems = opts.maxItems ?? 500;
  if (!Array.isArray(value)) throw new ValidationError(`"${field}" muss eine Liste von Texten sein.`);
  if (value.length > maxItems) throw new ValidationError(`"${field}" hat zu viele Einträge (${value.length}, erlaubt sind ${maxItems}).`);
  return value.map((entry, i) => {
    if (typeof entry !== 'string') throw new ValidationError(`"${field}[${i}]" muss ein Text sein.`);
    const trimmed = entry.trim();
    if (!trimmed) throw new ValidationError(`"${field}[${i}]" darf nicht leer sein.`);
    if (trimmed.length > (opts.max ?? 300)) throw new ValidationError(`"${field}[${i}]" ist zu lang.`);
    return trimmed;
  });
}

/** Read an integer query parameter, clamped. Never returns NaN. */
function intParam(query, name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = query.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ValidationError(`"${name}" muss eine Zahl sein (empfangen: ${clipForMessage(raw)}).`);
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function boolParam(query, name, fallback = false) {
  const raw = query.get(name);
  if (raw === null) return fallback;
  if (raw === '' || raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  throw new ValidationError(`"${name}" muss true oder false sein.`);
}

/** @returns {string|null} */
function strParam(query, name, max = 2000) {
  const raw = query.get(name);
  if (raw === null) return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.length > max) throw new ValidationError(`"${name}" ist zu lang (erlaubt sind ${max} Zeichen).`);
  return value;
}

/** Comma-separated list parameter, e.g. `?types=note,task`. @returns {string[]|null} */
function listParam(query, name, max = 50) {
  const raw = strParam(query, name);
  if (raw === null) return null;
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!items.length) return null;
  if (items.length > max) throw new ValidationError(`"${name}" hat zu viele Einträge (erlaubt sind ${max}).`);
  return items;
}

/** Fetch a record or throw 404. Optionally insist on a type. */
function mustGet(store, id, type, opts = {}) {
  const record = store.get(id, opts);
  if (!record || (type && record.type !== type)) {
    throw new NotFoundError(type ? `${type} ${id}` : `Eintrag ${id}`);
  }
  return record;
}

/** Copy only the listed keys, and only when they were actually sent. */
function pick(source, keys) {
  const out = {};
  if (!isPlainObject(source)) return out;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function clipForMessage(value, max = 60) {
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

module.exports = {
  unavailable,
  need,
  needMethod,
  isPlainObject,
  asObject,
  requireString,
  optionalString,
  requireStringArray,
  intParam,
  boolParam,
  strParam,
  listParam,
  mustGet,
  pick,
  clipForMessage,
};
