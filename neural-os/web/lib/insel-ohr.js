/**
 * lib/insel-ohr.js -- das Ohr der Insel: ein Mikrofon, das zugleich
 *
 *  1. den Pegel misst (AnalyserNode) -- dafuer atmet der Ring ums Wesen,
 *  2. merkt, wann jemand fertig gesprochen hat (Stille nach Sprache,
 *     lib/insel-logik.js stilleSchritt), und
 *  3. auf Wunsch aufnimmt (WAV, 16 kHz mono, hoechstens 60 s) -- fuer den
 *     Weg ohne Spracherkennung des Browsers (Opera): Gemini schreibt die
 *     Aufnahme um (POST /api/ki/transkribieren).
 *
 * Ein einziger Strom fuer alles. Der Takt kommt aus dem Audio-Faden (das
 * AudioWorklet aus lib/aufnahme-worklet.js schickt seine Stuecke), nicht aus
 * requestAnimationFrame: so laeuft die Stille-Erkennung auch, wenn der Tab
 * im Hintergrund ist, und ohne Zuhoeren laeuft gar nichts.
 *
 * Das Mikrofon ist nur offen, solange `ohrOeffnen` lebt: `stopp()` oder
 * `abbrechen()` schliessen es (die Anzeige des Browsers geht aus).
 */

import { wavKodieren, bisZur, MAX_SEKUNDEN, ZIEL_RATE } from './sprechen.js';
import { stilleNeu, stilleSchritt, rmsVon, pegelAusRms } from './insel-logik.js';

/** Vor dem ersten Wort bleibt so viel stehen, nach dem letzten so viel (Sekunden). */
const VORLAUF_S = 0.45;
const NACHLAUF_S = 0.4;

/** Ein Float32Array -- auch aus dem schwebenden Fenster (anderes Fenster, andere Klassen). */
function istSamples(x) {
  return !!x && ArrayBuffer.isView(x) && Object.prototype.toString.call(x) === '[object Float32Array]';
}

/**
 * Das Mikrofon oeffnen.
 * @param {{w?:Window, aufnehmen?:boolean, stille?:boolean, onPegel?:(p:number)=>void,
 *   onEreignis?:(e:'sprache'|'stille'|'grenze'|'nichts'|'weg')=>void, maxSekunden?:number, jetzt?:()=>number}} opts
 * @returns {Promise<{stopp:()=>Promise<{wav:Uint8Array, sekunden:number, abgebrochen:boolean, gesprochen:boolean}>, abbrechen:()=>void, gesprochen:()=>boolean}>}
 */
export async function ohrOeffnen(opts = {}) {
  const w = opts.w || window;
  const aufnehmen = opts.aufnehmen === true;
  const mitStille = opts.stille !== false;
  const onPegel = typeof opts.onPegel === 'function' ? opts.onPegel : () => {};
  const onEreignis = typeof opts.onEreignis === 'function' ? opts.onEreignis : () => {};
  const max = Number(opts.maxSekunden) > 0 ? Number(opts.maxSekunden) : MAX_SEKUNDEN;
  const jetzt = typeof opts.jetzt === 'function' ? opts.jetzt : () => Date.now();

  const strom = await w.navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  let ctx = null;
  let vorbei = false;
  const spurenZu = () => {
    for (const s of strom.getTracks()) {
      try { s.stop(); } catch { /* schon aus */ }
    }
  };
  const ctxZu = () => {
    if (!ctx) return;
    try {
      const p = ctx.close();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* schon zu */ }
  };

  let quelle = null;
  let analyser = null;
  let knoten = null;
  const stuecke = [];
  let samples = 0;
  let rate = 48000;
  let zst = stilleNeu(jetzt());
  let spracheAb = null;
  let stilleAb = null;
  let gesprochen = false;
  let puffer = null;

  function takt(stueck) {
    if (vorbei) return;
    if (stueck) {
      if (aufnehmen) stuecke.push(stueck);
      samples += stueck.length;
    }
    let rms = 0;
    try {
      analyser.getFloatTimeDomainData(puffer);
      rms = rmsVon(puffer);
    } catch {
      rms = stueck ? rmsVon(stueck) : 0;
    }
    try { onPegel(pegelAusRms(rms), rms); } catch { /* der Ring darf nichts anhalten */ }
    if (!mitStille) return;
    const t = jetzt();
    const r = stilleSchritt(zst, rms, t);
    zst = r.z;
    if (!r.ereignis) return;
    if (r.ereignis === 'sprache') {
      gesprochen = true;
      spracheAb = Math.max(0, samples - Math.round(((t - zst.spracheBeginn) / 1000 + VORLAUF_S) * rate));
    } else if (r.ereignis === 'stille') {
      stilleAb = Math.min(samples, samples - Math.round(((t - zst.stilleSeit) / 1000 - NACHLAUF_S) * rate));
    }
    try { onEreignis(r.ereignis); } catch { /* der Aufrufer entscheidet */ }
  }

  try {
    const AC = w.AudioContext || w.webkitAudioContext;
    ctx = new AC();
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try { await ctx.resume(); } catch { /* laeuft an, sobald es darf */ }
    }
    rate = ctx.sampleRate;
    quelle = ctx.createMediaStreamSource(strom);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    puffer = new Float32Array(analyser.fftSize);
    quelle.connect(analyser);
    if (ctx.audioWorklet && typeof w.AudioWorkletNode === 'function') {
      try {
        await ctx.audioWorklet.addModule(new URL('./aufnahme-worklet.js', import.meta.url).href);
        knoten = new w.AudioWorkletNode(ctx, 'nos-aufnahme');
        knoten.port.onmessage = (e) => { if (istSamples(e.data)) takt(e.data); };
      } catch {
        knoten = null;
      }
    }
    if (!knoten) {
      knoten = ctx.createScriptProcessor(2048, 1, 1);
      knoten.onaudioprocess = (e) => { takt(new Float32Array(e.inputBuffer.getChannelData(0))); };
    }
    quelle.connect(knoten);
    // Ohne Verbindung zum Ausgang laeuft ein ScriptProcessor in Chromium nicht; er gibt Stille aus.
    knoten.connect(ctx.destination);
  } catch (err) {
    spurenZu();
    ctxZu();
    throw err;
  }

  const spur = strom.getAudioTracks()[0];
  if (spur) {
    spur.addEventListener('ended', () => {
      if (!vorbei) {
        try { onEreignis('weg'); } catch { /* egal */ }
      }
    });
  }

  function aufraeumen() {
    if (vorbei) return;
    vorbei = true;
    try { quelle.disconnect(); } catch { /* egal */ }
    try { knoten.disconnect(); } catch { /* egal */ }
    try { analyser.disconnect(); } catch { /* egal */ }
    if (knoten && knoten.port) knoten.port.onmessage = null;
    spurenZu();
    ctxZu();
    onPegel(0, 0);
  }

  let haelt = false;
  let abgebrochen = false;
  const leer = () => ({ wav: wavKodieren([], rate), sekunden: 0, abgebrochen: true, gesprochen });

  return {
    gesprochen: () => gesprochen,
    /** Aufhoeren und (wenn aufgenommen wurde) die WAV liefern -- ohne lange Stille vorn und hinten. */
    async stopp() {
      if (vorbei || haelt) return leer();
      haelt = true;
      if (aufnehmen && knoten && knoten.port) {
        // Was der Worklet noch im Puffer hat, schickt er auf Zuruf.
        try { knoten.port.postMessage('leeren'); } catch { /* egal */ }
        await new Promise((r) => setTimeout(r, 120));
      }
      if (abgebrochen) return leer();
      aufraeumen();
      if (!aufnehmen) return { wav: new Uint8Array(0), sekunden: 0, abgebrochen: false, gesprochen };
      let alle = stuecke;
      const von = spracheAb !== null ? spracheAb : 0;
      const bis = stilleAb !== null ? Math.max(von + 1, stilleAb) : samples;
      if (von > 0 || bis < samples) alle = ausschnitt(stuecke, von, bis);
      const wav = wavKodieren(bisZur(alle, Math.floor(max * rate)), rate);
      return { wav, sekunden: (wav.length - 44) / (ZIEL_RATE * 2), abgebrochen: false, gesprochen };
    },
    /** Sofort zu, nichts wird geliefert. */
    abbrechen() {
      abgebrochen = true;
      aufraeumen();
    },
  };
}

/** Die Samples von `von` bis `bis` (Indizes ueber alle Stuecke). */
export function ausschnitt(stuecke, von, bis) {
  const out = [];
  let pos = 0;
  for (const s of stuecke) {
    const a = pos;
    const b = pos + s.length;
    pos = b;
    if (b <= von || a >= bis) continue;
    out.push(s.subarray(Math.max(0, von - a), Math.min(s.length, bis - a)));
  }
  return out;
}

export default { ohrOeffnen, ausschnitt };
