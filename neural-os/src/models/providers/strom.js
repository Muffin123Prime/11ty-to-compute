'use strict';

/**
 * Was jeder Anbieter zum Lesen eines Antwortstroms braucht -- und nur das.
 *
 * Claude und Gemini sprechen beide Server-Sent Events über die Schleuse, und
 * beide leiden unter denselben Tücken: TCP schneidet `data:`-Zeilen und
 * UTF-8-Zeichen mitten durch, ein toter Strom schweigt einfach, und ein
 * Abbruch braucht einen Grund ("der Nutzer" oder "die Frist"). Diese Helfer
 * stehen deshalb einmal hier statt zweimal in den Anbietern. Sie kennen
 * keinen Anbieter: wer sie benutzt, gibt seine eigene Fehlerklasse mit
 * (`zuLang`, `unlesbar`), damit der Satz in der Oberfläche zum Anbieter passt.
 */

const MAX_ZEILE = 16 * 1024 * 1024;

function ohneCr(zeile) {
  return zeile.endsWith('\r') ? zeile.slice(0, -1) : zeile;
}

/**
 * Zerlegt einen Byte-Strom in ganze Zeilen über Paketgrenzen hinweg. Der
 * TextDecoder überlebt zwischen den Stücken, damit ein halbiertes
 * UTF-8-Zeichen wieder zusammengesetzt statt zu U+FFFD wird.
 */
class Zeilen {
  /** @param {{zuLang?:()=>Error}} [opts] */
  constructor(opts = {}) {
    this.decoder = new TextDecoder('utf-8');
    this.rest = '';
    this.zuLang = typeof opts.zuLang === 'function' ? opts.zuLang : () => new Error('Eine unplausibel lange Zeile im Antwortstrom.');
  }

  push(stueck) {
    this.rest += typeof stueck === 'string' ? stueck : this.decoder.decode(stueck, { stream: true });
    if (this.rest.length > MAX_ZEILE) throw this.zuLang();
    if (this.rest.indexOf('\n') === -1) return [];
    const teile = this.rest.split('\n');
    this.rest = teile.pop();
    return teile.map(ohneCr);
  }

  ende() {
    this.rest += this.decoder.decode();
    const letzte = ohneCr(this.rest);
    this.rest = '';
    return letzte ? [letzte] : [];
  }
}

/**
 * Server-Sent Events nach den Regeln, die hier zählen: Leerzeile schickt ab,
 * `:` ist ein Kommentar, mehrere `data:`-Zeilen werden mit "\n" verbunden,
 * ein einzelnes Leerzeichen nach dem Doppelpunkt fällt weg.
 */
class SseLeser {
  constructor(opts = {}) {
    this.zeilen = new Zeilen(opts);
    this.daten = [];
    this.name = null;
  }

  push(stueck) {
    const aus = [];
    for (const zeile of this.zeilen.push(stueck)) this.zeile(zeile, aus);
    return aus;
  }

  ende() {
    const aus = [];
    for (const zeile of this.zeilen.ende()) this.zeile(zeile, aus);
    this.abschicken(aus);
    return aus;
  }

  zeile(zeile, aus) {
    if (zeile === '') {
      this.abschicken(aus);
      return;
    }
    if (zeile.charCodeAt(0) === 58 /* ':' */) return;
    const i = zeile.indexOf(':');
    const feld = i === -1 ? zeile : zeile.slice(0, i);
    let wert = i === -1 ? '' : zeile.slice(i + 1);
    if (wert.charCodeAt(0) === 32) wert = wert.slice(1);
    if (feld === 'data') this.daten.push(wert);
    else if (feld === 'event') this.name = wert;
  }

  abschicken(aus) {
    if (!this.daten.length) {
      this.name = null;
      return;
    }
    aus.push({ event: this.name || 'message', data: this.daten.join('\n') });
    this.daten = [];
    this.name = null;
  }
}

/** Verbindet das Abbruchsignal des Aufrufers mit eigenen Fristen und merkt sich, WARUM abgebrochen wurde. */
class Waechter {
  constructor(aussen) {
    this.controller = new AbortController();
    this.grund = null; // 'aufrufer' | 'verbinden' | 'leerlauf'
    this.timer = null;
    this.aussen = aussen || null;
    this.beiAussen = () => this.ausloesen('aufrufer');
    if (this.aussen) {
      if (this.aussen.aborted) this.ausloesen('aufrufer');
      else this.aussen.addEventListener('abort', this.beiAussen, { once: true });
    }
  }

  get signal() {
    return this.controller.signal;
  }

  ausloesen(grund) {
    if (!this.grund) this.grund = grund;
    this.stoppen();
    try { this.controller.abort(); } catch { /* schon abgebrochen */ }
  }

  stellen(ms, grund) {
    this.stoppen();
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.timer = setTimeout(() => this.ausloesen(grund), ms);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stoppen() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  aufraeumen() {
    this.stoppen();
    if (this.aussen) {
      try { this.aussen.removeEventListener('abort', this.beiAussen); } catch { /* egal */ }
    }
  }
}

/**
 * Den Antwortkörper stückweise liefern, egal in welcher Form die Schleuse
 * ihn gibt (Web-Stream, Node-Stream, String, Buffer).
 * @param {object} res
 * @param {{unlesbar?:()=>Error}} [opts]
 */
async function* koerper(res, opts = {}) {
  const body = res && res.body;
  if (!body) {
    if (res && typeof res.text === 'function') {
      const t = await res.text();
      if (t) yield t;
    }
    return;
  }
  if (typeof body === 'string' || ArrayBuffer.isView(body)) {
    if (body.length) yield body;
    return;
  }
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      try { reader.cancel().catch(() => {}); } catch { /* schon zu */ }
    }
    return;
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const stueck of body) if (stueck) yield stueck;
    return;
  }
  throw typeof opts.unlesbar === 'function' ? opts.unlesbar() : new Error('Die Antwort ließ sich nicht lesen.');
}

/** Die ersten `max` Zeichen eines Körpers (für Fehlertexte und kleine Antworten). */
async function auszug(res, max = 4000) {
  try {
    const decoder = new TextDecoder('utf-8');
    let out = '';
    for await (const s of koerper(res)) {
      out += typeof s === 'string' ? s : decoder.decode(s, { stream: true });
      if (out.length >= max) break;
    }
    return out.slice(0, max);
  } catch {
    return '';
  }
}

function kopfWert(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] || null;
}

module.exports = { Zeilen, SseLeser, Waechter, koerper, auszug, kopfWert, MAX_ZEILE };
