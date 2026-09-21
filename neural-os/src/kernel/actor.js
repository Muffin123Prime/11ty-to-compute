'use strict';

/**
 * Wer gerade schreibt.
 *
 * Das Problem, das dieses Modul löst
 * ----------------------------------
 * Der Speicher weiß nicht, wer ihn aufruft — und das ist richtig so: er kennt
 * keine Agenten, keine Läufe und keine Oberfläche. Trotzdem ist „wer hat das
 * geändert?" die erste Frage, die jemand stellt, dem eine Notiz anders vorkommt
 * als gestern. Und sie muss beantwortbar sein, gerade weil in diesem System
 * Agenten nach der Uhr laufen können, während niemand davorsitzt.
 *
 * Bisher gab es nur den Herkunftsstempel am Satz (`runId`, `agentId`, gesetzt
 * beim *Anlegen*). Der beantwortet zuverlässig „wer hat diesen Satz erzeugt?"
 * — aber nicht „wer hat ihn gerade geändert?". Eine Notiz, die du geschrieben
 * und ein Agent später bearbeitet hat, sah aus wie deine eigene Änderung.
 *
 * Warum AsyncLocalStorage
 * -----------------------
 * Die Alternative wäre gewesen, jedem schreibenden Aufruf einen Parameter
 * mitzugeben. Das hätte zwei Nachteile: man vergisst ihn irgendwann irgendwo
 * (und dann ist die Antwort still falsch statt fehlend), und es erfasst nur
 * die *direkten* Schreibvorgänge. Ein Agent, der eine Notiz anlegt, löst aber
 * auch die Linkableitung aus, die ihrerseits Kanten schreibt — und die sind
 * genauso sein Werk.
 *
 * `AsyncLocalStorage` (Node-Standardbibliothek, keine Abhängigkeit) trägt den
 * Kontext durch die gesamte asynchrone Aufrufkette. Ein Lauf setzt ihn einmal;
 * alles, was innerhalb dieses Laufs geschrieben wird, trägt ihn, ohne dass eine
 * einzige Zwischenstation davon wissen muss.
 *
 * Grenzen, ehrlich gesagt
 * -----------------------
 * - Der Kontext geht verloren, wenn Code die Kette verlässt: `setTimeout` aus
 *   einer anderen Wurzel, ein Ereignis, das später von einem fremden Aufrufer
 *   abgearbeitet wird. Dann ist die Antwort `null` — also „unbekannt", nicht
 *   „der Nutzer". Falsch zuschreiben wäre schlimmer als nichts zu sagen.
 * - Er sagt nichts über die *Absicht*. Ein Agent, der auf Anweisung des
 *   Nutzers läuft, ist trotzdem ein Agent. Das ist beabsichtigt: die Frage
 *   lautet „lief da etwas ohne mich?", nicht „wollte ich das?".
 */

const { AsyncLocalStorage } = require('node:async_hooks');

/** @typedef {{kind:'agent'|'user'|'sync'|'module'|'system', runId?:string, agentId?:string, label?:string}} Actor */

const storage = new AsyncLocalStorage();

/**
 * Führt `fn` aus, während `actor` als Urheber jedes Schreibvorgangs gilt.
 * @template T
 * @param {Actor|null} actor
 * @param {() => T} fn
 * @returns {T}
 */
function withActor(actor, fn) {
  if (!actor || typeof actor !== 'object') return fn();
  return storage.run(freeze(actor), fn);
}

/**
 * Der gerade gültige Urheber, oder `null`.
 *
 * `null` heißt ausdrücklich „unbekannt", nicht „der Nutzer". Wer daraus
 * „der Nutzer" macht, trifft eine Annahme — und genau die soll hier niemand
 * unbemerkt treffen.
 * @returns {Actor|null}
 */
function currentActor() {
  return storage.getStore() || null;
}

/** Ein Urheber, der sich unterwegs nicht mehr ändern lässt. */
function freeze(actor) {
  const out = { kind: String(actor.kind || 'system') };
  if (actor.runId) out.runId = String(actor.runId);
  if (actor.agentId) out.agentId = String(actor.agentId);
  if (actor.label) out.label = String(actor.label);
  return Object.freeze(out);
}

module.exports = { withActor, currentActor };
