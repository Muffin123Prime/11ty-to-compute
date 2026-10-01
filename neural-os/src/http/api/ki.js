'use strict';

/**
 * Die KI wählen und verbinden: Gemini (kostenlos) oder Claude.
 *
 *   GET    /api/ki                         -> Zustand beider Anbieter + der aktive (fragt NIE das Netz)
 *   POST   /api/ki/:anbieter/schluessel    { schluessel, aktivieren? } -> prüft mit Probeaufruf, speichert im Tresor;
 *                                          mit aktivieren antwortet dieser Anbieter ab jetzt
 *   DELETE /api/ki/:anbieter/schluessel    -> vergisst den Schlüssel
 *   PATCH  /api/ki                         { anbieter?, modell?, nachschlagen? (Wikipedia an/aus) }
 *   POST   /api/ki/transkribieren          { audio (WAV, Base64, höchstens 60 s), chatId? } -> { text, sekunden, modell }
 *
 * `/api/ki/name` (Name dieser KI) liegt in src/http/api/system.js und ist
 * etwas anderes: die Identität dieses Sticks, nicht der Anbieter.
 *
 * Die alten Routen unter /api/claude (src/http/api/claude.js) bleiben als
 * Alias auf den Claude-Dienst bestehen. Der Schlüssel geht nur hinein, nie
 * heraus; schreiben dürfen nur Zugänge am Gerät selbst (Owner).
 */

const { asObject } = require('./support');
const { NeuralError } = require('../../kernel/errors');
const anhaenge = require('../../models/anhaenge');

/**
 * Was Gemini mit der Aufnahme tun soll. Wörtlich, in der gesprochenen
 * Sprache, nichts dazu -- der Text landet im Eingabefeld, und der Nutzer
 * schickt ihn selbst ab.
 */
const TRANSKRIPT_AUFTRAG = 'Schreib wörtlich auf, was in dieser Aufnahme gesprochen wird, in der gesprochenen Sprache. Gib nur den gesprochenen Text aus – ohne Einleitung, ohne Anführungszeichen, ohne Zeitmarken. Ist nichts Verständliches zu hören, gib nichts aus.';

function kiVon(rc) {
  const k = rc.ctx.kiDienst;
  if (!k || typeof k.zustand !== 'function') {
    throw new NeuralError('SUBSYSTEM_UNAVAILABLE', 'Die KI ist in dieser Instanz nicht geladen. Neural OS kann deshalb nicht antworten.', { status: 503 });
  }
  return k;
}

function register(router) {
  router.get('/api/ki', (rc) => {
    rc.requireCapability('read');
    const z = kiVon(rc).zustand();
    // Ob das Mikrofon ohne Spracherkennung des Browsers etwas tun kann
    // (docs/ANTWORT-BAUSTEINE.md 6): nur mit verbundenem Gemini.
    const g = z.anbieter && z.anbieter.gemini;
    return { ...z, transkribieren: !!(g && g.verbunden) };
  });

  /**
   * Sprache in Text: eine WAV-Aufnahme (höchstens 60 s) geht an Gemini --
   * egal, welcher Anbieter gerade antwortet, denn Claude nimmt kein Audio.
   * Ohne Google-Schlüssel: 409 mit dem Satz, was fehlt. Gespeichert wird
   * nichts; die Aufnahme lebt nur für diese Anfrage.
   */
  router.post('/api/ki/transkribieren', async (rc) => {
    rc.requireCapability('chat');
    const ki = kiVon(rc);
    const body = asObject(await rc.body());
    const g = ki.gemini;
    if (!g || typeof g.schluesselVorhanden !== 'function' || !g.schluesselVorhanden()) {
      throw new NeuralError('TRANSKRIBIEREN_NICHT_MOEGLICH',
        'Sprache in Text umschreiben kann hier nur Gemini (kostenlos). Unter Einstellungen → KI einen Google-Schlüssel einfügen.',
        { status: 409 });
    }
    let wav;
    try {
      wav = anhaenge.wavPruefen(body.audio);
    } catch (err) {
      throw new NeuralError(err.code || 'AUDIO_UNGUELTIG', err.satz || err.message, { status: err.status || 400 });
    }
    g.zugang(); // 409 GEMINI_NICHT_VERBUNDEN mit dem Satz (offline, gesperrt, Schlüssel falsch)
    let scope = 'global';
    if (typeof body.chatId === 'string' && body.chatId && rc.ctx.store) {
      const chat = rc.ctx.store.get(body.chatId);
      if (chat && chat.type === 'chat') scope = `chat:${chat.id}`;
    }
    const gebaut = g.modul.anfrageBauen({
      modell: g.modell(),
      nachrichten: [{
        role: 'user',
        content: [
          { type: 'text', text: TRANSKRIPT_AUFTRAG },
          { type: 'audio', source: { type: 'base64', media_type: 'audio/wav', data: wav.buf.toString('base64') } },
        ],
      }],
      websuche: false,
      denken: false,
      maxTokens: 2048,
      stream: false,
    });
    const controller = new AbortController();
    rc.res.on('close', () => { if (!rc.res.writableEnded) controller.abort(); });
    const r = await g.senden({
      body: gebaut.body,
      modell: gebaut.modell,
      denken: gebaut.denken,
      stream: false,
      scope,
      purpose: 'Sprache in Text umschreiben',
      signal: controller.signal,
    });
    if (r.stopReason === 'refusal') {
      throw new NeuralError('GEMINI_ABGELEHNT', 'Gemini hat die Aufnahme abgelehnt.', { status: 422 });
    }
    const text = (r.inhalt || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
    return { text, sekunden: Math.round(wav.sekunden * 10) / 10, modell: r.modell || gebaut.modell };
  });

  router.post('/api/ki/:anbieter/schluessel', async (rc) => {
    rc.requireOwner('Der KI-Schlüssel');
    const ki = kiVon(rc);
    const body = asObject(await rc.body());
    const controller = new AbortController();
    // Wer den Tab schliesst, bricht die Pruefung ab; ein fertiger Aufruf nicht mehr.
    rc.res.on('close', () => { if (!rc.res.writableEnded) controller.abort(); });
    const zustand = await ki.schluesselSpeichern(rc.params.anbieter, body.schluessel, {
      signal: controller.signal,
      aktivieren: body.aktivieren === true,
      zusaetzlich: body.zusaetzlich === true,
      ersetzt: typeof body.ersetzt === 'string' ? body.ersetzt : undefined,
    });
    return { ok: true, ...zustand };
  });

  // ?zugang=<id>: nur diesen Schlüssel; ohne: alle des Anbieters.
  router.delete('/api/ki/:anbieter/schluessel', (rc) => {
    rc.requireOwner('Der KI-Schlüssel');
    const zugang = rc.query && typeof rc.query.get === 'function' ? rc.query.get('zugang') : null;
    const r = kiVon(rc).schluesselLoeschen(rc.params.anbieter, zugang || undefined);
    return { ok: true, geloescht: r.geloescht, ...r.zustand };
  });

  router.post('/api/ki/:anbieter/zugaenge/:zugang/vor', (rc) => {
    rc.requireOwner('Die Reihenfolge der Schlüssel');
    return kiVon(rc).zugangVor(rc.params.anbieter, rc.params.zugang);
  });

  router.patch('/api/ki', async (rc) => {
    rc.requireOwner('Die Wahl der KI');
    const body = asObject(await rc.body());
    return kiVon(rc).setzen({ anbieter: body.anbieter, modell: body.modell, nachschlagen: body.nachschlagen });
  });
}

module.exports = { register };
