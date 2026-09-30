/**
 * lib/sprechen.js -- Sprechen statt Tippen (docs/ANTWORT-BAUSTEINE.md 6).
 *
 * Zwei Wege, der Reihe nach:
 *
 * 1. **Die Spracherkennung des Browsers** (SpeechRecognition), wenn es sie
 *    gibt: der Text erscheint schon waehrend des Sprechens im Feld.
 * 2. **Sonst eine Aufnahme als WAV**, die Gemini umschreibt
 *    (POST /api/ki/transkribieren) -- nur, wenn ein Google-Schluessel da ist.
 *
 * Geht keines, gibt es keinen Knopf (docs/ANTWORT-BAUSTEINE.md 8: keine
 * Attrappen). Manche Browser haben die Erkennung nur dem Namen nach (Opera,
 * Chromium ohne Google-Dienst): sie meldet dann sofort `network` oder
 * `service-not-allowed`. Dann nimmt der Chat stattdessen auf, ohne dass der
 * Nutzer etwas tun muss, und bleibt fuer diese Sitzung bei der Aufnahme.
 *
 * Warum WAV und nicht, was MediaRecorder liefert: Chromium nimmt WebM/Opus
 * auf, Safari MP4/AAC. Der Server prueft WAV (src/models/anhaenge.js
 * wavPruefen) und Gemini liest es sicher. 16 kHz, eine Spur, 16 Bit reicht
 * fuer Sprache: 60 Sekunden sind knapp 2 MB.
 */

/** So lange darf eine Aufnahme sein (wie der Server). */
export const MAX_SEKUNDEN = 60;
export const ZIEL_RATE = 16000;

/** Die Spracherkennung des Browsers, oder null. */
export function erkennungKlasse(w = globalThis) {
  return (w && (w.SpeechRecognition || w.webkitSpeechRecognition)) || null;
}

/** Kann dieser Browser ueberhaupt ans Mikrofon? (nur in sicherem Kontext: 127.0.0.1 ja, http://<LAN-IP> nein) */
export function mikrofonMoeglich(w = globalThis) {
  if (!w || w.isSecureContext === false) return false;
  const md = w.navigator && w.navigator.mediaDevices;
  return !!(md && typeof md.getUserMedia === 'function');
}

/** Kann dieser Browser aufnehmen und das Ergebnis als WAV bauen? */
export function aufnahmeMoeglich(w = globalThis) {
  return mikrofonMoeglich(w) && !!(w.AudioContext || w.webkitAudioContext);
}

/**
 * Welcher Weg gilt? `transkribieren` sagt der Server (GET /api/ki): ob ein
 * Google-Schluessel da ist. `nurAufnahme` merkt sich, dass die Erkennung
 * des Browsers hier nicht geht.
 * @returns {'erkennung'|'aufnahme'|null}
 */
export function sprechWeg({ transkribieren = false, nurAufnahme = false } = {}, w = globalThis) {
  if (!w || w.isSecureContext === false) return null;
  if (!nurAufnahme && erkennungKlasse(w)) return 'erkennung';
  if (transkribieren && aufnahmeMoeglich(w)) return 'aufnahme';
  return null;
}

/** Der Satz zu einem Fehler der Browser-Erkennung; `null` heisst: still (abgebrochen). */
export function erkennungFehlerSatz(code) {
  switch (code) {
    case 'aborted': return null;
    case 'not-allowed': return 'Das Mikrofon ist nicht erlaubt. Erlaube es oben in der Adressleiste.';
    case 'service-not-allowed': return 'Die Spracherkennung dieses Browsers ist hier gesperrt.';
    case 'network': return 'Die Spracherkennung dieses Browsers braucht Internet.';
    case 'no-speech': return 'Nichts gehört. Tippe noch einmal aufs Mikrofon und sprich.';
    case 'audio-capture': return 'Kein Mikrofon gefunden.';
    case 'language-not-supported': return 'Deutsch erkennt dieser Browser nicht.';
    default: return 'Die Spracherkennung ist gescheitert.';
  }
}

/** Fehler, nach denen die Aufnahme (Gemini) einspringen kann: die Erkennung gibt es hier nur dem Namen nach. */
export function erkennungUntauglich(code) {
  return code === 'network' || code === 'service-not-allowed' || code === 'language-not-supported';
}

/**
 * Float32-Stuecke einer Spur (Abtastrate `rate`) als WAV: 16 kHz, mono,
 * 16 Bit. Verkleinert wird durch Mitteln (ein grober Tiefpass, fuer Sprache
 * genug). Rein -- ohne Browser pruefbar.
 * @param {Float32Array[]} stuecke
 * @param {number} rate
 * @returns {Uint8Array}
 */
export function wavKodieren(stuecke, rate, zielRate = ZIEL_RATE) {
  let n = 0;
  for (const s of stuecke) n += s.length;
  const alle = new Float32Array(n);
  let o = 0;
  for (const s of stuecke) {
    alle.set(s, o);
    o += s.length;
  }
  const faktor = rate / zielRate;
  const laenge = faktor > 0 ? Math.floor(n / faktor) : 0;
  const pcm = new Int16Array(laenge);
  for (let i = 0; i < laenge; i += 1) {
    const von = Math.floor(i * faktor);
    const bis = Math.min(n, Math.max(von + 1, Math.floor((i + 1) * faktor)));
    let summe = 0;
    for (let j = von; j < bis; j += 1) summe += alle[j];
    const wert = Math.max(-1, Math.min(1, summe / (bis - von)));
    pcm[i] = wert < 0 ? Math.round(wert * 0x8000) : Math.round(wert * 0x7fff);
  }
  const daten = pcm.length * 2;
  const buf = new ArrayBuffer(44 + daten);
  const v = new DataView(buf);
  const kette = (pos, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(pos + i, s.charCodeAt(i)); };
  kette(0, 'RIFF');
  v.setUint32(4, 36 + daten, true);
  kette(8, 'WAVE');
  kette(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, zielRate, true);
  v.setUint32(28, zielRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  kette(36, 'data');
  v.setUint32(40, daten, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

/** Bytes als Base64 (in Happen, damit grosse Aufnahmen den Stapel nicht sprengen). */
export function bytesAlsBase64(bytes) {
  let s = '';
  const HAPPEN = 0x8000;
  for (let i = 0; i < bytes.length; i += HAPPEN) s += String.fromCharCode.apply(null, bytes.subarray(i, i + HAPPEN));
  return btoa(s);
}

/**
 * Die Erkennung des Browsers starten. Liefert laufend den Text (fertige
 * Teile plus das, was gerade noch erkannt wird).
 * @param {{onText:(fertig:string, vorlaeufig:string)=>void, onEnde:()=>void, onFehler:(code:string)=>void}} h
 * @returns {{stopp:()=>void, abbrechen:()=>void}}
 */
export function erkennungStarten({ onText, onEnde, onFehler, sprache = 'de-DE' }, w = globalThis) {
  const Klasse = erkennungKlasse(w);
  const r = new Klasse();
  r.lang = sprache;
  r.interimResults = true;
  r.continuous = true;
  r.maxAlternatives = 1;
  let fertig = '';
  let beendet = false;
  r.onresult = (e) => {
    let vorlaeufig = '';
    fertig = '';
    for (let i = 0; i < e.results.length; i += 1) {
      const erg = e.results[i];
      const t = erg && erg[0] ? String(erg[0].transcript || '') : '';
      if (erg.isFinal) fertig += t;
      else vorlaeufig += t;
    }
    if (typeof onText === 'function') onText(fertig.trim(), vorlaeufig.trim());
  };
  r.onerror = (e) => {
    if (typeof onFehler === 'function') onFehler(String((e && e.error) || 'unbekannt'));
  };
  r.onend = () => {
    if (beendet) return;
    beendet = true;
    if (typeof onEnde === 'function') onEnde();
  };
  r.start();
  return {
    stopp() { try { r.stop(); } catch { /* schon aus */ } },
    abbrechen() { try { r.abort(); } catch { /* schon aus */ } },
  };
}

/**
 * Eine Aufnahme starten (Mikrofon -> Float32 -> WAV). Die Aufnahme endet
 * mit `stopp()` oder nach MAX_SEKUNDEN von selbst (dann ruft sie `onGrenze`).
 * @param {{onZeit?:(sekunden:number)=>void, onGrenze?:()=>void, maxSekunden?:number}} opts
 * @returns {Promise<{stopp:()=>Promise<{wav:Uint8Array, sekunden:number}>, abbrechen:()=>void}>}
 */
export async function aufnahmeStarten(opts = {}, w = globalThis) {
  const max = Number(opts.maxSekunden) > 0 ? Number(opts.maxSekunden) : MAX_SEKUNDEN;
  const strom = await w.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const AC = w.AudioContext || w.webkitAudioContext;
  const ctx = new AC();
  if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
    try { await ctx.resume(); } catch { /* laeuft trotzdem an, sobald es darf */ }
  }
  const quelle = ctx.createMediaStreamSource(strom);
  const stuecke = [];
  let knoten = null;
  // Bevorzugt ein AudioWorklet (eigene Datei, gleiche Quelle); sonst der
  // alte ScriptProcessor, den jeder Browser noch hat.
  if (ctx.audioWorklet && typeof w.AudioWorkletNode === 'function') {
    try {
      await ctx.audioWorklet.addModule(new URL('./aufnahme-worklet.js', import.meta.url).href);
      knoten = new w.AudioWorkletNode(ctx, 'nos-aufnahme');
      knoten.port.onmessage = (e) => { if (e.data instanceof Float32Array) stuecke.push(e.data); };
    } catch {
      knoten = null;
    }
  }
  if (!knoten) {
    knoten = ctx.createScriptProcessor(4096, 1, 1);
    knoten.onaudioprocess = (e) => { stuecke.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  }
  quelle.connect(knoten);
  // Ohne Verbindung zum Ausgang laeuft ein ScriptProcessor in Chromium nicht; er gibt Stille aus.
  knoten.connect(ctx.destination);
  const beginn = Date.now();
  let vorbei = false;
  let uhr = null;
  const aufraeumen = () => {
    vorbei = true;
    clearInterval(uhr);
    try { quelle.disconnect(); } catch { /* egal */ }
    try { knoten.disconnect(); } catch { /* egal */ }
    for (const spur of strom.getTracks()) spur.stop();
    try { ctx.close(); } catch { /* egal */ }
  };
  uhr = setInterval(() => {
    const s = (Date.now() - beginn) / 1000;
    if (typeof opts.onZeit === 'function') opts.onZeit(s);
    if (s >= max && !vorbei && typeof opts.onGrenze === 'function') opts.onGrenze();
  }, 250);
  return {
    async stopp() {
      if (vorbei) return { wav: wavKodieren([], ctx.sampleRate), sekunden: 0 };
      const rate = ctx.sampleRate;
      // Was der Worklet noch im Puffer hat, schickt er auf Zuruf.
      if (knoten.port) knoten.port.postMessage('leeren');
      await new Promise((r) => setTimeout(r, 120));
      aufraeumen();
      const wav = wavKodieren(stuecke, rate);
      return { wav, sekunden: (wav.length - 44) / (ZIEL_RATE * 2) };
    },
    abbrechen() { if (!vorbei) aufraeumen(); },
  };
}
