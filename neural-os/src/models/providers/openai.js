'use strict';

/**
 * OpenAI-kompatible Anbieter -- rohes HTTP durch die Netzschleuse.
 *
 * Warum es sie gibt: Der Nutzer am 01.10.2026: "mehrere Keys … wenn es noch
 * andere Optionen gibt, wo ich einen API-Key kopieren kann für eine KI, dann
 * nehme ich auch jede andere … falls bei einem das Limit leer geht, wechselt
 * er zum nächsten". Viele Anbieter sprechen dieselbe Schnittstelle wie
 * OpenAI: `POST {basis}/chat/completions` mit `Authorization: Bearer …`,
 * Antwort als Server-Sent Events bis `data: [DONE]`, eigene Werkzeuge als
 * `tools` / `tool_calls`. Diese Datei baut daraus je Anbieter ein Modul mit
 * demselben Vertrag wie gemini.js und anthropic.js: nach innen Claudes
 * Blockform (text / thinking / tool_use / tool_result), nach außen OpenAIs
 * Nachrichten (system / user / assistant mit tool_calls / tool).
 *
 * Was je Anbieter gilt (nachgesehen am 01.10.2026 in seinen Unterlagen, die
 * Fehlerformen mit einem absichtlich falschen Schlüssel beobachtet; Einzel-
 * heiten in docs/CLAUDE-ANBINDUNG.md, Abschnitt 10), steht in VORLAGEN. Kein
 * Anbieter hier hat eine eigene Websuche über diese Schnittstelle.
 *
 * - **Kein SDK.** Jede Anfrage geht durch `gate.fetch` mit `allowedHosts`;
 *   der Schlüssel steht nur im Kopf `Authorization`, nie in einem Satz.
 * - **Werkzeug-IDs werden kurz und gleich gemacht** (9 Zeichen, a-z0-9):
 *   Mistral verlangt genau das, und ein Verlauf, den vorher Gemini oder
 *   Claude führte, trägt deren IDs.
 * - **Werkzeugargumente werden nicht repariert.** Sie kommen als JSON-Text
 *   in Stücken; was sich nicht lesen lässt, steht in `eingabeFehler`.
 * - **Fehler als deutsche Sätze**, Rohtexte nur in `details`; der Satz des
 *   Anbieters steht bei Unbekanntem mit dabei.
 */

const crypto = require('node:crypto');
const { NeuralError, ValidationError, AbortedError } = require('../../kernel/errors');
const strom = require('./strom');

/* --------------------------------------------------------------- Vorlagen */

/**
 * Die Anbieter. `modelle` sind die bekannten guten (in dieser Reihenfolge
 * bevorzugt); welche ein Schlüssel wirklich kann, fragt Neural OS beim
 * Verbinden ab (`GET {basis}/models`). `bilder`: nimmt das Modell Bilder.
 */
const VORLAGEN = Object.freeze({
  mistral: Object.freeze({
    id: 'mistral',
    name: 'Mistral',
    praefix: 'MISTRAL',
    basis: 'https://api.mistral.ai/v1',
    kostenlos: true,
    seite: 'console.mistral.ai → API Keys',
    platzhalter: 'Schlüssel von console.mistral.ai',
    hinweis: 'Kostenlos ohne Karte (Free mode); Mistral begrenzt die Anfragen je Sekunde und Monat. Aus Frankreich.',
    modelle: [
      { id: 'mistral-small-latest', name: 'Mistral Small', bilder: true },
      { id: 'mistral-medium-latest', name: 'Mistral Medium', bilder: true },
      { id: 'ministral-8b-latest', name: 'Ministral 8B', bilder: false },
    ],
    modellMuster: /^(mistral|ministral|magistral|pixtral|codestral|devstral|open-mistral)[a-z0-9.-]*$/,
    ausschluss: /(embed|moderation|ocr|transcri|voxtral|tts|codestral)/,
  }),
  groq: Object.freeze({
    id: 'groq',
    name: 'Groq',
    praefix: 'GROQ',
    basis: 'https://api.groq.com/openai/v1',
    schluesselPraefix: 'gsk_',
    kostenlos: true,
    seite: 'console.groq.com/keys',
    platzhalter: 'gsk_…',
    hinweis: 'Kostenlos ohne Karte; je Modell etwa 1 000 Anfragen am Tag.',
    modelle: [
      { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B', bilder: false },
      { id: 'qwen/qwen3.8-27b', name: 'Qwen 3.8 27B', bilder: true },
      { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B', bilder: false },
    ],
    modellMuster: /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/,
    ausschluss: /(whisper|tts|guard|prompt-guard|compound|playai|orpheus|safety)/,
  }),
  openrouter: Object.freeze({
    id: 'openrouter',
    name: 'OpenRouter',
    praefix: 'OPENROUTER',
    basis: 'https://openrouter.ai/api/v1',
    schluesselPraefix: 'sk-or-v1-',
    kostenlos: true,
    seite: 'openrouter.ai/settings/keys',
    platzhalter: 'sk-or-v1-…',
    hinweis: 'Nur die kostenlosen Modelle (Endung „:free“); etwa 50 Anfragen am Tag.',
    modelle: [
      { id: 'qwen/qwen3.8-27b:free', name: 'Qwen 3.8 27B (frei)', bilder: true },
      { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B (frei)', bilder: true },
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super (frei)', bilder: false },
    ],
    modellMuster: /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/,
    ausschluss: /(safety|guard|code|embed)/,
    nurKostenlos: true,
  }),
  ovh: Object.freeze({
    id: 'ovh',
    name: 'OVHcloud',
    praefix: 'OVH',
    basis: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    ohneSchluessel: true,
    kostenlos: true,
    seite: 'kein Konto nötig',
    platzhalter: '',
    hinweis: 'Ohne Schlüssel und ohne Konto, dafür langsam: 2 Anfragen je Minute und Modell. Aus Frankreich.',
    modelle: [
      { id: 'Mistral-Small-3.2-24B-Instruct-2506', name: 'Mistral Small 3.2', bilder: false },
      { id: 'gpt-oss-120b', name: 'GPT-OSS 120B', bilder: false },
      { id: 'Qwen3.8-27B', name: 'Qwen 3.8 27B', bilder: false },
    ],
    modellMuster: /^[A-Za-z0-9][A-Za-z0-9._-]{1,80}$/,
    ausschluss: /(embed|bge|whisper|tts|guard|coder|nvr-|vl-)/i,
  }),
  openai: Object.freeze({
    id: 'openai',
    name: 'OpenAI',
    praefix: 'OPENAI',
    basis: 'https://api.openai.com/v1',
    schluesselPraefix: 'sk-',
    kostenlos: false,
    seite: 'platform.openai.com → API keys (kostet je Nutzung)',
    platzhalter: 'sk-…',
    hinweis: 'Kostet je Nutzung; die Rechnung stellt OpenAI.',
    // OpenAI: `max_tokens` ist veraltet, die Denkmodelle lehnen es ab.
    laengenFeld: 'max_completion_tokens',
    modelle: [],
    modellMuster: /^(gpt|o\d|chatgpt)[a-z0-9.-]*$/,
    ausschluss: /(realtime|audio|tts|transcribe|image|embedding|search|moderation|instruct|codex|dall)/,
  }),
});

const IDS = Object.freeze(Object.keys(VORLAGEN));

/** Wem ein Schlüssel gehört, an seinem Anfang -- längste Vorsilbe zuerst. */
function vorlageVonSchluessel(roh) {
  const s = typeof roh === 'string' ? roh.trim() : '';
  if (/^sk-or-v1-/.test(s)) return 'openrouter';
  if (/^gsk_/.test(s)) return 'groq';
  if (/^sk-ant-/.test(s)) return null; // Claude
  if (/^sk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,}$/.test(s)) return 'openai';
  return null;
}

/* --------------------------------------------------------- das Modul */

const VERBINDEN_MS = 60000;
/** Ohne Ping drei Minuten Stille: die Verbindung ist tot. */
const LEERLAUF_MS = 180000;
const MAX_TOKENS = 8192;

/** 9 Zeichen a-z0-9, je Ursprungs-ID immer dieselben (Mistral verlangt genau das). */
function kurzeId(id) {
  return crypto.createHash('sha256').update(String(id || '')).digest('hex').replace(/[^a-z0-9]/g, '').slice(0, 9).padEnd(9, '0');
}

function kurz(roh, max = 180) {
  const t = String(roh || '')
    .replace(/(sk-or-v1-|sk-proj-|sk-|gsk_|nvapi-|xai-)[0-9A-Za-z_-]{8,}/g, '$1…')
    .replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Ein Modul für einen Anbieter aus VORLAGEN.
 * @param {string} vorlageId
 */
function erstellen(vorlageId) {
  const V = VORLAGEN[vorlageId];
  if (!V) throw new ValidationError(`Unbekannter Anbieter „${vorlageId}“.`);
  const P = V.praefix;
  const API_BASIS = V.basis;
  const API_HOST = new URL(API_BASIS).hostname;
  const MODELLE = Object.freeze(Object.fromEntries(V.modelle.map((m) => [m.id, Object.freeze({
    id: m.id, name: m.name, hinweis: V.kostenlos ? 'Kostenlos.' : '', bilder: m.bilder !== false,
  })])));
  const STANDARD_MODELL = V.modelle.length ? V.modelle[0].id : null;
  /** Wie die Antwortlänge heißt: bei den meisten `max_tokens`, bei OpenAI `max_completion_tokens`. */
  const LAENGE = V.laengenFeld || 'max_tokens';
  const laengenName = (body) => (body && Object.prototype.hasOwnProperty.call(body, 'max_completion_tokens') ? 'max_completion_tokens'
    : (body && Object.prototype.hasOwnProperty.call(body, 'max_tokens') ? 'max_tokens' : null));
  const ABLEHNUNG = Object.freeze({
    code: `${P}_ABGELEHNT`,
    satz: `${V.name} hat die Antwort abgelehnt. Formuliere sie anders oder frag etwas anderes.`,
  });

  class AnbieterFehler extends NeuralError {
    constructor(code, satz, opts = {}) {
      super(code, satz, { status: opts.status || 502, details: opts.details || null });
      this.name = `${V.name}Fehler`;
      if (Number.isFinite(opts.wiederholenNachS)) this.wiederholenNachS = opts.wiederholenNachS;
      if (Array.isArray(opts.teilInhalt)) this.teilInhalt = opts.teilInhalt;
    }
  }

  function istModell(id) {
    if (typeof id !== 'string' || !id || id.length > 120) return false;
    if (Object.prototype.hasOwnProperty.call(MODELLE, id)) return true;
    // Modelle anderer Anbieter (ein Chat merkt sich das Modell) zählen hier nicht.
    if (/^(gemini|claude)-/.test(id)) return false;
    return V.modellMuster.test(id) && !(V.ausschluss && V.ausschluss.test(id));
  }

  function modellInfo(id) {
    if (typeof id === 'string' && Object.prototype.hasOwnProperty.call(MODELLE, id)) return MODELLE[id];
    if (istModell(id)) return { id, name: id.replace(/:free$/, ' (frei)'), hinweis: '', bilder: false };
    return STANDARD_MODELL ? MODELLE[STANDARD_MODELL] : { id: String(id || ''), name: String(id || ''), hinweis: '', bilder: false };
  }

  /* ------------------------------------------------------------ Fehler */

  /** Den Fehlerkörper lesen -- jeder Anbieter schreibt ihn anders. */
  function fehlerAus(text) {
    let j = null;
    try { j = JSON.parse(text); } catch { j = null; }
    if (Array.isArray(j)) j = j[0];
    const e = j && typeof j === 'object' ? j.error : null;
    let nachricht = '';
    let code = null;
    let typ = null;
    if (e && typeof e === 'object') {
      nachricht = String(e.message || '');
      code = e.code !== undefined ? String(e.code) : null;
      typ = e.type ? String(e.type) : null;
      if (e.metadata && typeof e.metadata.raw === 'string' && !nachricht) nachricht = e.metadata.raw;
    } else if (typeof e === 'string') {
      nachricht = e;
    }
    if (!nachricht && j && typeof j === 'object') nachricht = String(j.message || j.detail || '');
    if (!nachricht) nachricht = String(text || '').slice(0, 300);
    return { nachricht, code, typ };
  }

  function fehlerAusAntwort({ status, text, wiederholenNachS, teilInhalt, kopf = () => null }) {
    const { nachricht, code, typ } = fehlerAus(text);
    const roh = nachricht;
    const details = { status: status || null, typ, code };
    if (roh) details.api = kurz(roh, 300);
    const opts = (s) => ({ status: s, details, wiederholenNachS, teilInhalt });
    const wort = `${V.name}: „${kurz(roh)}“`;
    if (status === 401 || (status === 403 && /auth|api key|forbidden|unauthori/i.test(roh)) || code === 'invalid_api_key' || code === 'wrong_api_key'
      || (status === 400 && /api key/i.test(roh))) {
      return new AnbieterFehler(`${P}_SCHLUESSEL_FALSCH`, `Der ${V.name}-Schlüssel stimmt nicht.`, opts(400));
    }
    if (status === 402 || code === 'insufficient_quota' || code === 'credit_balance_exhausted' || typ === 'insufficient_quota') {
      return new AnbieterFehler(`${P}_GUTHABEN`, `Bei ${V.name} ist kein Guthaben (mehr).`, opts(402));
    }
    if (status === 403) {
      return new AnbieterFehler(`${P}_KEINE_BERECHTIGUNG`, `${V.name} lässt das nicht zu (${wort}).`, opts(403));
    }
    if (status === 404 || status === 410 || code === 'model_not_found' || /model .*(not found|does not exist|decommissioned|end of life)/i.test(roh)) {
      return new AnbieterFehler(`${P}_MODELL_UNBEKANNT`, `Dieses Modell gibt es bei ${V.name} nicht (mehr).`, opts(502));
    }
    if (status === 413 || /context length|context_length|too many tokens|maximum context|too large/i.test(roh)) {
      return new AnbieterFehler(`${P}_ZU_GROSS`, 'Das Gespräch ist zu lang für eine einzelne Anfrage. Fang einen neuen Chat an.', opts(413));
    }
    if (status === 429) {
      // Groq: x-ratelimit-remaining-requests ist das TAGES-Kontingent.
      const rest = kopf('x-ratelimit-remaining-requests');
      const tagRest = rest === null || rest === undefined || rest === '' ? NaN : Number(rest);
      const jeTag = /per day|daily|requests per day|RPD|free-models-per-day|tokens per day|TPD/i.test(roh) || (vorlageId === 'groq' && tagRest === 0);
      if (jeTag) return new AnbieterFehler(`${P}_LIMIT_TAG`, `${V.name}: Tageslimit erreicht – morgen geht es weiter.`, opts(429));
      const warte = Number.isFinite(wiederholenNachS) && wiederholenNachS > 0 ? ` (in etwa ${Math.ceil(wiederholenNachS)} s)` : '';
      return new AnbieterFehler(`${P}_LIMIT`, `${V.name}-Limit erreicht — gleich nochmal${warte}.`, opts(429));
    }
    if (status >= 500 && status <= 504) {
      return new AnbieterFehler(`${P}_UEBERLASTET`, `${V.name} ist gerade überlastet.`, opts(503));
    }
    if (status === 400 || status === 422) {
      return new AnbieterFehler(`${P}_ANFRAGE_ABGELEHNT`, `${V.name} hat die Anfrage nicht angenommen (${wort}).`, opts(502));
    }
    return new AnbieterFehler(`${P}_FEHLER`, `Bei ${V.name} ist ein Fehler aufgetreten${roh ? ` (${wort})` : ''}. Versuch es gleich noch einmal.`, opts(502));
  }

  function transportFehler(err, waechter, teilInhalt) {
    if (err instanceof AnbieterFehler) return err;
    if (waechter && waechter.grund === 'aufrufer') return new AbortedError('Die Antwort wurde abgebrochen.');
    const code = err && err.code;
    if (code === 'NETWORK_BLOCKED' && /Sperrliste|Freigabeliste|Hostliste/.test(String(err.message || ''))) {
      return new AnbieterFehler(`${P}_GESPERRT`, `Die Schleuse lässt ${API_HOST} nicht durch. Unter Netzwerk freigeben.`, { status: 409, details: { grund: err.message }, teilInhalt });
    }
    if (code === 'NETWORK_BLOCKED') {
      return new AnbieterFehler(`${P}_OFFLINE`, `Offline — ${V.name} ist gerade nicht erreichbar. Schalte auf „Online“, dann antwortet ${V.name}.`, { status: 409, details: { grund: err.message }, teilInhalt });
    }
    if (code === 'ABORTED' || (err && err.name === 'AbortError')) {
      if (waechter && waechter.grund === 'leerlauf') return new AnbieterFehler(`${P}_STILLE`, `${V.name} hat zu lange nichts mehr gesendet; die Antwort ist unvollständig.`, { status: 504, teilInhalt });
      if (waechter && waechter.grund === 'verbinden') return new AnbieterFehler(`${P}_ZEIT`, `${V.name} hat nicht rechtzeitig geantwortet.`, { status: 504, teilInhalt });
      return new AbortedError('Die Antwort wurde abgebrochen.');
    }
    if (code === 'NAME_RESOLUTION_FAILED' || code === 'REQUEST_FAILED' || code === 'NETWORK_TIMEOUT') {
      return new AnbieterFehler(`${P}_KEIN_NETZ`, `Keine Verbindung zu ${V.name}. Ist das Internet da?`, { status: 502, details: { grund: String(err.message || '').slice(0, 300) }, teilInhalt });
    }
    return new AnbieterFehler(`${P}_FEHLER`, `Die Verbindung zu ${V.name} ist abgebrochen.`, { status: 502, details: { grund: String((err && err.message) || err).slice(0, 300) }, teilInhalt });
  }

  const stromOpts = {
    zuLang: () => new AnbieterFehler(`${P}_FEHLER`, `${V.name} hat eine unplausibel lange Zeile gesendet.`),
    unlesbar: () => new AnbieterFehler(`${P}_FEHLER`, `Die Antwort von ${V.name} ließ sich nicht lesen.`),
  };

  /* ---------------------------------------------------- Übersetzen */

  function textAus(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
    if (content && typeof content === 'object') return JSON.stringify(content);
    return '';
  }

  /** Werkzeug-Schemata: so, wie werkzeuge.js sie schreibt (JSON-Schema); `strict` und Claude-Eigenes fallen weg. */
  function werkzeugeUebersetzen(defs) {
    if (!Array.isArray(defs) || !defs.length) return [];
    return defs.map((t) => {
      const fn = t && t.type === 'function' && t.function ? t.function : t;
      if (!fn || typeof fn.name !== 'string' || !fn.name) throw new ValidationError('Jedes Werkzeug braucht einen Namen.');
      const schema = fn.input_schema || fn.parameters;
      return {
        type: 'function',
        function: {
          name: fn.name,
          description: typeof fn.description === 'string' ? fn.description : '',
          parameters: schema && typeof schema === 'object' ? JSON.parse(JSON.stringify(schema)) : { type: 'object', properties: {} },
        },
      };
    });
  }

  /**
   * Der Verlauf (Claudes Blockform) als OpenAI-Nachrichten. Werkzeug-
   * ergebnisse stehen direkt hinter dem Zug, der sie verlangte, als je
   * eine `tool`-Nachricht; IDs werden kurz gemacht (`kurzeId`).
   */
  function nachrichtenUebersetzen(nachrichten, { bilder = true } = {}) {
    const out = [];
    for (const n of Array.isArray(nachrichten) ? nachrichten : []) {
      if (!n || (n.role !== 'user' && n.role !== 'assistant')) continue;
      const bloecke = Array.isArray(n.content) ? n.content : (typeof n.content === 'string' ? [{ type: 'text', text: n.content }] : []);
      if (n.role === 'user') {
        const teile = [];
        const ergebnisse = [];
        for (const b of bloecke) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text' && typeof b.text === 'string' && b.text) teile.push({ type: 'text', text: b.text });
          else if (b.type === 'image' && b.source && b.source.type === 'base64' && b.source.data) {
            if (bilder) teile.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
            else teile.push({ type: 'text', text: `[Bild – ${V.name} kann mit diesem Modell keine Bilder sehen]` });
          } else if (b.type === 'document') {
            teile.push({ type: 'text', text: `[PDF: ${String(b.title || 'Dokument').slice(0, 120)} – ${V.name} kann keine PDF lesen]` });
          } else if (b.type === 'tool_result') {
            ergebnisse.push({ role: 'tool', tool_call_id: kurzeId(b.tool_use_id), content: textAus(b.content) || (b.is_error ? 'Fehler' : '(leer)') });
          }
        }
        out.push(...ergebnisse);
        if (teile.length) {
          const nurText = teile.every((t) => t.type === 'text');
          out.push({ role: 'user', content: nurText ? teile.map((t) => t.text).join('\n\n') : teile });
        }
        continue;
      }
      const text = bloecke.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
      const calls = bloecke.filter((b) => b && b.type === 'tool_use').map((b) => ({
        id: kurzeId(b.id), type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input && typeof b.input === 'object' ? b.input : {}) },
      }));
      if (!text && !calls.length) continue;
      const m = { role: 'assistant', content: text || '' };
      if (calls.length) m.tool_calls = calls;
      out.push(m);
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
  }

  function systemText(system) {
    if (typeof system === 'string') return system.trim() ? system : '';
    if (!Array.isArray(system)) return '';
    return system.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n');
  }

  /**
   * Die Anfrage an chat/completions -- dieselben Parameter wie bei Gemini
   * und Claude. Eine Websuche gibt es hier nicht (`websuche` zählt nicht).
   */
  function anfrageBauen(p) {
    if (!Array.isArray(p.nachrichten) || !p.nachrichten.length) throw new ValidationError(`Es wurden keine Nachrichten an ${V.name} übergeben.`);
    const info = modellInfo(p.modell);
    const messages = [];
    const sys = systemText(p.system);
    if (sys) messages.push({ role: 'system', content: sys });
    messages.push(...nachrichtenUebersetzen(p.nachrichten, { bilder: info.bilder !== false }));
    if (!messages.some((m) => m.role === 'user')) throw new ValidationError(`Es wurden keine Nachrichten an ${V.name} übergeben.`);
    const body = { model: info.id, messages, stream: p.stream !== false };
    const tools = werkzeugeUebersetzen(p.werkzeuge);
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    body[LAENGE] = Number.isFinite(p.maxTokens) && p.maxTokens > 0 ? Math.floor(p.maxTokens) : MAX_TOKENS;
    return { body, modell: info.id, stream: body.stream, betas: [], denken: null };
  }

  function koepfe(apiKey) {
    const k = { 'content-type': 'application/json' };
    if (V.ohneSchluessel) return k;
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new AnbieterFehler(`${P}_KEIN_SCHLUESSEL`, `${V.name} ist nicht verbunden: es ist kein Schlüssel gespeichert.`, { status: 503 });
    }
    k.authorization = `Bearer ${apiKey.trim()}`;
    return k;
  }

  function adresse(basis, pfad) {
    const b = String(basis || API_BASIS).trim().replace(/\/+$/, '');
    let url;
    try {
      url = new URL(`${b}${pfad}`);
    } catch {
      throw new ValidationError(`Ungültige Adresse für ${V.name}: ${basis}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ValidationError(`Die Adresse für ${V.name} muss mit https:// beginnen.`);
    return url;
  }

  /**
   * Eine abgelehnte Anfrage so ändern, dass der Anbieter sie nimmt -- je Art
   * höchstens einmal, nur was sein Satz nennt.
   */
  function heilen(body, nachricht, geheilt) {
    const msg = String(nachricht || '');
    if (!geheilt.includes('bilder') && /image|vision|multimodal|image_url/i.test(msg)
      && body.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c && c.type === 'image_url'))) {
      const messages = body.messages.map((m) => (Array.isArray(m.content)
        ? { ...m, content: m.content.map((c) => (c && c.type === 'image_url' ? { type: 'text', text: `[Bild – ${V.name} kann mit diesem Modell keine Bilder sehen]` } : c)).map((c) => c.text).join('\n\n') }
        : m));
      return { art: 'bilder', body: { ...body, messages }, hinweis: `Ohne Bild: ${V.name} kann mit diesem Modell keine Bilder sehen.` };
    }
    // "Unsupported parameter: 'max_tokens' … Use 'max_completion_tokens' instead." (und umgekehrt)
    if (!geheilt.includes('laengenname') && /unsupported|not supported|unrecognized|unknown|extra/i.test(msg)) {
      const alt = laengenName(body);
      const neu = alt === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
      if (alt && msg.includes(alt)) {
        const b = { ...body, [neu]: body[alt] };
        delete b[alt];
        return { art: 'laengenname', body: b };
      }
    }
    const feld = laengenName(body);
    if (!geheilt.includes('laenge') && feld && body[feld] > 2048 && /max_tokens|max_completion_tokens|maximum.*tokens|tokens.*maximum/i.test(msg)) {
      return { art: 'laenge', body: { ...body, [feld]: 2048 } };
    }
    if (!geheilt.includes('werkzeuge') && Array.isArray(body.tools) && /tool|function|schema/i.test(msg)) {
      const neu = { ...body };
      delete neu.tools;
      delete neu.tool_choice;
      return { art: 'werkzeuge', body: neu, hinweis: `Ohne Werkzeuge: ${V.name} hat ihre Beschreibung nicht angenommen („${kurz(msg, 120)}“). Termine und Notizen legt die KI diesmal nicht selbst an.` };
    }
    return null;
  }

  /* ---------------------------------------------------------- Senden */

  /**
   * Eine Anfrage senden und den Strom lesen. Ereignisse an `beiEreignis`
   * haben dieselbe Form wie bei Gemini und Claude:
   *   {art:'start'|'ende', index, block}, {art:'text'|'denken', index, delta}, {art:'hinweis', satz}
   * @returns {Promise<{id, modell, inhalt, stopReason, stopDetails, usage, eingabeFehler, ms}>}
   */
  async function senden({
    basis, apiKey, modell, body, stream = true, gate, scope, purpose, signal, beiEreignis,
    verbindenMs = VERBINDEN_MS, leerlaufMs = LEERLAUF_MS, ausgabeMax, geheilt = [],
  } = {}) {
    if (!gate || typeof gate.fetch !== 'function') throw new ValidationError(`Interner Fehler: ohne Netzschleuse darf Neural OS ${V.name} nicht erreichen.`);
    if (typeof scope !== 'string' || !scope) throw new ValidationError(`Interner Fehler: jeder Aufruf an ${V.name} braucht einen Scope für die Schleuse.`);
    if (!body || typeof body !== 'object') throw new ValidationError(`Interner Fehler: keine Anfrage an ${V.name}.`);
    if (signal && signal.aborted) throw new AbortedError('Die Antwort wurde abgebrochen.');
    // Das Modell, das der Dienst gewählt hat (er weicht womöglich aus).
    body = { ...body, model: modellInfo(modell).id, stream };
    const feld = laengenName(body);
    if (feld && Number.isFinite(ausgabeMax) && ausgabeMax > 0 && body[feld] > ausgabeMax) body[feld] = ausgabeMax;
    const url = adresse(basis, '/chat/completions');
    const kopf = koepfe(apiKey);
    const begonnen = Date.now();
    const waechter = new strom.Waechter(signal);
    const melden = (e) => {
      if (typeof beiEreignis !== 'function') return;
      try { beiEreignis(e); } catch { /* ein kaputter Zuhörer bricht keinen Aufruf ab */ }
    };

    let res;
    try {
      waechter.stellen(verbindenMs, 'verbinden');
      res = await gate.fetch(url.toString(), {
        method: 'POST',
        headers: { ...kopf, accept: stream ? 'text/event-stream' : 'application/json' },
        body: JSON.stringify(body),
        scope,
        purpose: purpose || `Antwort von ${V.name}`,
        allowedHosts: [url.hostname],
        stream,
        timeoutMs: verbindenMs,
        signal: waechter.signal,
      });
    } catch (err) {
      waechter.aufraeumen();
      throw transportFehler(err, waechter);
    }
    if (!res || typeof res.status !== 'number') {
      waechter.aufraeumen();
      throw new AnbieterFehler(`${P}_FEHLER`, 'Die Netzschleuse hat keine verwertbare Antwort geliefert.');
    }
    const kopfWert = (n) => strom.kopfWert(res.headers, n);

    if (res.status < 200 || res.status >= 300) {
      waechter.stellen(10000, 'leerlauf');
      const text = await strom.auszug(res);
      waechter.aufraeumen();
      const ra = Number(kopfWert('retry-after'));
      const reset = Number(kopfWert('ratelimit-reset'));
      const warte = Number.isFinite(ra) && ra > 0 ? ra : (Number.isFinite(reset) && reset > 0 && reset < 3600 ? reset : undefined);
      const fehler = fehlerAusAntwort({ status: res.status, text, wiederholenNachS: warte, kopf: kopfWert });
      const heil = fehler.code === `${P}_ANFRAGE_ABGELEHNT` ? heilen(body, fehlerAus(text).nachricht, geheilt) : null;
      if (heil) {
        const r = await senden({
          basis, apiKey, modell, body: heil.body, stream, gate, scope, purpose, signal, beiEreignis, verbindenMs, leerlaufMs,
          ausgabeMax, geheilt: [...geheilt, heil.art],
        });
        if (heil.hinweis) melden({ art: 'hinweis', satz: heil.hinweis });
        return r;
      }
      throw fehler;
    }

    const z = { id: null, modell: null, bloecke: [], aufrufe: new Map(), finish: null, usage: null, eingabeFehler: {} };
    const letzter = () => z.bloecke[z.bloecke.length - 1] || null;
    const abschliessen = (block, index) => {
      if (block && !block._zu) {
        block._zu = true;
        melden({ art: 'ende', index, block: sauber(block) });
      }
    };
    const textDazu = (delta, art) => {
      if (typeof delta !== 'string' || !delta) return;
      const kind = art === 'denken' ? 'thinking' : 'text';
      const feld = art === 'denken' ? 'thinking' : 'text';
      let b = letzter();
      if (!b || b.type !== kind) {
        if (b) abschliessen(b, z.bloecke.length - 1);
        b = { type: kind, [feld]: '' };
        if (kind === 'thinking') b.openai = {};
        z.bloecke.push(b);
        melden({ art: 'start', index: z.bloecke.length - 1, block: sauber(b) });
      }
      b[feld] += delta;
      melden({ art, index: z.bloecke.length - 1, delta });
    };
    // Manche Modelle (Qwen 3 bei Groq, offene Modelle bei OVHcloud) schreiben
    // ihr Denken als <think>…</think> in den Text. Das ist Denken, nicht die
    // Antwort -- auch wenn eine Klammer über zwei Stücke geht.
    const klammer = { drin: false, rest: '' };
    const inhaltDazu = (stueck) => {
      let t = klammer.rest + stueck;
      klammer.rest = '';
      while (t) {
        const marke = klammer.drin ? '</think>' : '<think>';
        const i = t.indexOf(marke);
        if (i >= 0) {
          if (i > 0) textDazu(t.slice(0, i), klammer.drin ? 'denken' : 'text');
          klammer.drin = !klammer.drin;
          t = t.slice(i + marke.length);
          continue;
        }
        // Ein angefangenes Zeichen der Marke am Ende: auf das nächste Stück warten.
        let halb = 0;
        for (let n = Math.min(marke.length - 1, t.length); n > 0; n--) {
          if (marke.startsWith(t.slice(-n))) { halb = n; break; }
        }
        const fertig = t.slice(0, t.length - halb);
        if (fertig) textDazu(fertig, klammer.drin ? 'denken' : 'text');
        klammer.rest = t.slice(t.length - halb);
        t = '';
      }
    };
    const aufrufDazu = (tc) => {
      const i = Number.isInteger(tc.index) ? tc.index : z.aufrufe.size;
      let a = z.aufrufe.get(i);
      if (!a) {
        a = { id: null, name: '', args: '' };
        z.aufrufe.set(i, a);
      }
      if (typeof tc.id === 'string' && tc.id) a.id = tc.id;
      const fn = tc.function || {};
      if (typeof fn.name === 'string' && fn.name) a.name = a.name || fn.name;
      if (typeof fn.arguments === 'string') a.args += fn.arguments;
      else if (fn.arguments && typeof fn.arguments === 'object') a.args = JSON.stringify(fn.arguments);
    };
    const verarbeiten = (d) => {
      if (!d || typeof d !== 'object') return;
      if (d.error) {
        const e = typeof d.error === 'object' ? d.error : { message: String(d.error) };
        throw fehlerAusAntwort({ status: Number(e.code) || 502, text: JSON.stringify({ error: e }), teilInhalt: z.bloecke.filter(Boolean).map(sauber) });
      }
      if (typeof d.id === 'string') z.id = d.id;
      if (typeof d.model === 'string') z.modell = d.model;
      if (d.usage && typeof d.usage === 'object') z.usage = d.usage;
      const c = Array.isArray(d.choices) ? d.choices[0] : null;
      if (!c) return;
      const delta = c.delta || c.message || {};
      const denken = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
      if (denken) textDazu(denken, 'denken');
      if (typeof delta.content === 'string') inhaltDazu(delta.content);
      else if (Array.isArray(delta.content)) for (const t of delta.content) if (t && typeof t.text === 'string') inhaltDazu(t.text);
      if (Array.isArray(delta.tool_calls)) for (const tc of delta.tool_calls) if (tc) aufrufDazu(tc);
      if (c.finish_reason) {
        z.finish = String(c.finish_reason);
        if (z.finish === 'error') {
          throw new AnbieterFehler(`${P}_FEHLER`, `Bei ${V.name} ist mitten in der Antwort ein Fehler aufgetreten.`, { teilInhalt: z.bloecke.filter(Boolean).map(sauber) });
        }
      }
    };

    let fertig = false;
    try {
      if (!stream) {
        waechter.stellen(leerlaufMs, 'leerlauf');
        const text = await strom.auszug(res, 32 * 1024 * 1024);
        let j;
        try { j = JSON.parse(text); } catch { throw new AnbieterFehler(`${P}_FEHLER`, `${V.name} hat unlesbares JSON geschickt.`); }
        verarbeiten(j);
        fertig = true;
      } else {
        const leser = new strom.SseLeser(stromOpts);
        waechter.stellen(leerlaufMs, 'leerlauf');
        const ereignis = (evt) => {
          const roh = String(evt.data || '').trim();
          if (!roh) return;
          if (roh === '[DONE]') { fertig = true; return; }
          let d;
          try { d = JSON.parse(roh); } catch { throw new AnbieterFehler(`${P}_FEHLER`, `${V.name} hat ein unlesbares Ereignis geschickt.`, { details: { auszug: roh.slice(0, 200) } }); }
          verarbeiten(d);
        };
        for await (const stueck of strom.koerper(res, stromOpts)) {
          waechter.stellen(leerlaufMs, 'leerlauf');
          for (const evt of leser.push(stueck)) ereignis(evt);
        }
        for (const evt of leser.ende()) ereignis(evt);
      }
    } catch (err) {
      if (err instanceof AnbieterFehler) {
        if (!err.teilInhalt) err.teilInhalt = z.bloecke.filter(Boolean).map(sauber);
        throw err;
      }
      throw transportFehler(err, waechter, z.bloecke.filter(Boolean).map(sauber));
    } finally {
      waechter.aufraeumen();
      if (typeof res.destroy === 'function') {
        try { res.destroy(); } catch { /* schon zu */ }
      }
    }

    if (klammer.rest) {
      textDazu(klammer.rest, klammer.drin ? 'denken' : 'text');
      klammer.rest = '';
    }
    const b = letzter();
    if (b) abschliessen(b, z.bloecke.length - 1);
    // Werkzeugaufrufe: erst am Ende vollständig (die Argumente kommen in Stücken).
    for (const [, a] of [...z.aufrufe.entries()].sort((x, y) => x[0] - y[0])) {
      if (!a.name) continue;
      const block = { type: 'tool_use', id: a.id || `call_${kurzeId(`${Date.now()}${Math.random()}`)}`, name: a.name, input: {} };
      const roh = a.args.trim();
      if (roh) {
        try {
          const wert = JSON.parse(roh);
          if (wert && typeof wert === 'object' && !Array.isArray(wert)) block.input = wert;
          else z.eingabeFehler[block.id] = { roh, fehler: 'Die Eingabe ist kein JSON-Objekt.' };
        } catch {
          z.eingabeFehler[block.id] = { roh, fehler: 'Die Eingabe ist kein gültiges JSON.' };
        }
      }
      z.bloecke.push(block);
      const index = z.bloecke.length - 1;
      melden({ art: 'start', index, block: sauber(block) });
      abschliessen(block, index);
    }
    if (!fertig && !z.finish) {
      throw new AnbieterFehler(`${P}_ABGEBROCHEN`, `Die Verbindung zu ${V.name} ist mitten in der Antwort abgebrochen.`, { teilInhalt: z.bloecke.filter(Boolean).map(sauber) });
    }
    const inhalt = z.bloecke.filter(Boolean).map(sauber);
    return {
      id: z.id,
      modell: z.modell,
      inhalt,
      stopReason: stopReasonAus(z, inhalt),
      stopDetails: z.finish && z.finish !== 'stop' && z.finish !== 'tool_calls' ? { finishReason: z.finish } : null,
      usage: verbrauchAus(z),
      eingabeFehler: z.eingabeFehler,
      ms: Date.now() - begonnen,
    };
  }

  function sauber(block) {
    const { _zu, ...rest } = block;
    void _zu;
    return JSON.parse(JSON.stringify(rest));
  }

  function stopReasonAus(z, inhalt) {
    const f = z.finish || 'stop';
    if (f === 'content_filter') return 'refusal';
    // Abgeschnitten: ein halber Werkzeugaufruf wird nicht ausgeführt.
    if (f === 'length') return 'max_tokens';
    if (inhalt.some((b) => b.type === 'tool_use')) return 'tool_use';
    return 'end_turn';
  }

  function verbrauchAus(z) {
    const u = z.usage || {};
    const n = (v) => (Number.isFinite(v) ? v : 0);
    return {
      input_tokens: n(u.prompt_tokens),
      output_tokens: n(u.completion_tokens),
      cache_read_input_tokens: n(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens),
      cache_creation_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
      [vorlageId]: { ...u },
    };
  }

  /** Was zurück in den Verlauf geht: Text und Werkzeugaufrufe; eigene Denkblöcke nicht (es gibt keine Signatur). */
  function bloeckeZurueck(inhalt) {
    const out = [];
    for (const b of Array.isArray(inhalt) ? inhalt : []) {
      if (!b || typeof b !== 'object' || !b.type) continue;
      if (b.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input || {} });
      else if (b.type === 'tool_result') out.push(JSON.parse(JSON.stringify(b)));
    }
    return out;
  }

  function werkzeugAufrufe(inhalt) {
    return (Array.isArray(inhalt) ? inhalt : []).filter((b) => b && b.type === 'tool_use');
  }

  function kostenSchaetzen() {
    return 0;
  }

  /** Der kleine Probeaufruf beim Verbinden: ohne Strom, ohne Werkzeuge, wenige Token. */
  async function probe({ basis, apiKey, modell, gate, signal, timeoutMs = 30000 } = {}) {
    const id = modellInfo(modell).id;
    const body = { model: id, messages: [{ role: 'user', content: 'Antworte nur mit: OK' }], [LAENGE]: 16, stream: false };
    const r = await senden({ basis, apiKey, modell: id, body, stream: false, gate, scope: 'global', purpose: `${V.name}-Schlüssel prüfen`, signal, verbindenMs: timeoutMs });
    return { ok: true, modell: r.modell || id, usage: r.usage, ms: r.ms };
  }

  /** GET mit Schlüssel, JSON zurück -- oder der Fehler als Satz. */
  async function holen(basis, apiKey, pfad, { gate, signal, timeoutMs = 20000, zweck }) {
    const url = adresse(basis, pfad);
    const kopf = koepfe(apiKey);
    delete kopf['content-type'];
    const waechter = new strom.Waechter(signal);
    let res;
    let text = '';
    try {
      waechter.stellen(timeoutMs, 'verbinden');
      res = await gate.fetch(url.toString(), {
        method: 'GET', headers: { ...kopf, accept: 'application/json' }, scope: 'global', purpose: zweck,
        allowedHosts: [url.hostname], timeoutMs, signal: waechter.signal,
      });
      text = await strom.auszug(res, 8 * 1024 * 1024);
    } catch (err) {
      throw transportFehler(err, waechter);
    } finally {
      waechter.aufraeumen();
    }
    if (!res || typeof res.status !== 'number') throw new AnbieterFehler(`${P}_FEHLER`, 'Die Netzschleuse hat keine verwertbare Antwort geliefert.');
    if (res.status < 200 || res.status >= 300) throw fehlerAusAntwort({ status: res.status, text, kopf: (n) => strom.kopfWert(res.headers, n) });
    try {
      return JSON.parse(text);
    } catch {
      throw new AnbieterFehler(`${P}_FEHLER`, `${V.name} hat eine unlesbare Antwort geschickt.`);
    }
  }

  /** Reihenfolge: die bekannten guten zuerst (in ihrer Reihenfolge), dann der Rest. */
  function rangVon(id) {
    const i = V.modelle.findIndex((m) => m.id === id);
    return i >= 0 ? i : 1000;
  }

  /**
   * Unter den unbekannten: neuere Version zuerst ("gpt-6.1-…" vor "gpt-4o"),
   * teure Pro- und Vorschau-Fassungen zuletzt, sonst nach Namen.
   */
  function vergleichUnbekannt(a, b) {
    const teuer = (id) => (/(^|[-_.])(pro|preview|vorschau)([-_.]|$)/i.test(id) ? 1 : 0);
    const version = (id) => {
      const m = /(\d+(?:\.\d+)?)/.exec(id.replace(/^[^/]*\//, ''));
      return m ? Number(m[1]) : 0;
    };
    return (teuer(a) - teuer(b)) || (version(b) - version(a)) || (a < b ? -1 : (a > b ? 1 : 0));
  }

  /**
   * Welche Modelle dieser Schlüssel kann: GET {basis}/models. Bei
   * OpenRouter ist die Liste öffentlich (sie prüft den Schlüssel nicht) --
   * dort prüft GET /key den Schlüssel, und nur die kostenlosen Modelle mit
   * Werkzeugen zählen.
   * @returns {Promise<Array<{id,name,ausgabe,bilder}>>}
   */
  async function modelleAbfragen({ basis, apiKey, gate, signal, timeoutMs = 20000 } = {}) {
    if (!gate || typeof gate.fetch !== 'function') throw new ValidationError(`Interner Fehler: ohne Netzschleuse darf Neural OS ${V.name} nicht erreichen.`);
    if (vorlageId === 'openrouter') await holen(basis, apiKey, '/key', { gate, signal, timeoutMs, zweck: `${V.name}-Schlüssel prüfen` });
    const j = await holen(basis, apiKey, '/models', { gate, signal, timeoutMs, zweck: `${V.name}-Modelle abfragen` });
    const roh = Array.isArray(j && j.data) ? j.data : (Array.isArray(j) ? j : []);
    const liste = [];
    const gesehen = new Set();
    for (const m of roh) {
      const id = m && typeof m.id === 'string' ? m.id : null;
      if (!id || gesehen.has(id) || !istModell(id)) continue;
      // Mistral nennt, was ein Modell kann; nur Chat zählt.
      if (m.capabilities && m.capabilities.completion_chat === false) continue;
      // OpenRouter: nur mit Werkzeugen (sonst legt die KI nichts an); OVH: nur, was Text erzeugt.
      if (Array.isArray(m.supported_parameters) && !m.supported_parameters.includes('tools')) continue;
      if (m.max_completion_tokens === 0) continue;
      gesehen.add(id);
      const eingang = (m.architecture && Array.isArray(m.architecture.input_modalities)) ? m.architecture.input_modalities : null;
      const bilder = eingang ? eingang.includes('image') : (m.capabilities ? m.capabilities.vision === true : (MODELLE[id] ? MODELLE[id].bilder : false));
      liste.push({
        id,
        name: MODELLE[id] ? MODELLE[id].name : modellInfo(id).name,
        ausgabe: Number.isFinite(m.max_completion_tokens) && m.max_completion_tokens > 0 ? m.max_completion_tokens : null,
        bilder,
      });
    }
    liste.sort((a, b) => (rangVon(a.id) - rangVon(b.id)) || vergleichUnbekannt(a.id, b.id));
    return liste;
  }

  /** Der Registry-Weg (Agenten, Zusammenfassen): Nachrichten in, Text und Werkzeugaufrufe heraus. */
  async function chat({
    basis, apiKey, model, messages, options = {}, tools, gate, scope = 'global', purpose, signal, onDelta, timeoutMs,
  } = {}) {
    const system = [];
    const nachrichten = [];
    let ergebnisse = null;
    const abschliessen = () => {
      if (ergebnisse && ergebnisse.length) nachrichten.push({ role: 'user', content: ergebnisse });
      ergebnisse = null;
    };
    for (const m of Array.isArray(messages) ? messages : []) {
      if (!m || typeof m !== 'object') continue;
      const text = typeof m.content === 'string' ? m.content : '';
      if (m.role === 'system') { if (text.trim()) system.push(text); continue; }
      if (m.role === 'tool') {
        if (!ergebnisse) ergebnisse = [];
        ergebnisse.push({ type: 'tool_result', tool_use_id: String(m.toolCallId || ''), content: text || '(leer)' });
        continue;
      }
      abschliessen();
      if (m.role === 'assistant') {
        const content = [];
        if (text.trim()) content.push({ type: 'text', text });
        for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
          if (c && c.name) content.push({ type: 'tool_use', id: String(c.id), name: String(c.name), input: c.arguments && typeof c.arguments === 'object' ? c.arguments : {} });
        }
        if (content.length) nachrichten.push({ role: 'assistant', content });
        continue;
      }
      if (text.trim()) nachrichten.push({ role: 'user', content: [{ type: 'text', text }] });
    }
    abschliessen();
    if (!nachrichten.length) throw new ValidationError(`Es wurden keine Nachrichten an ${V.name} übergeben.`);
    const gebaut = anfrageBauen({
      modell: model, system: system.join('\n\n') || undefined, werkzeuge: tools, nachrichten,
      maxTokens: Number.isFinite(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : undefined,
    });
    const r = await senden({
      basis, apiKey, modell: gebaut.modell, body: gebaut.body, stream: true, gate, scope, purpose, signal,
      verbindenMs: Number.isFinite(timeoutMs) ? timeoutMs : VERBINDEN_MS,
      beiEreignis: (e) => { if (e.art === 'text' && typeof onDelta === 'function') onDelta(e.delta); },
    });
    if (r.stopReason === 'refusal') throw new AnbieterFehler(ABLEHNUNG.code, ABLEHNUNG.satz, { status: 422 });
    const text = r.inhalt.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const aufrufe = r.stopReason === 'max_tokens' ? [] : werkzeugAufrufe(r.inhalt);
    const u = r.usage || {};
    return {
      content: text,
      toolCalls: aufrufe.map((b) => {
        const call = { id: b.id, name: b.name, arguments: b.input || {} };
        const f = r.eingabeFehler[b.id];
        if (f) { call.argumentsError = f.fehler; call.argumentsRaw = f.roh.slice(0, 2000); }
        return call;
      }),
      stats: { promptTokens: u.input_tokens, completionTokens: u.output_tokens, cacheRead: u.cache_read_input_tokens, ms: r.ms },
      finishReason: r.stopReason,
      usage: u,
      modellAntwort: r.modell,
    };
  }

  /** Bei diesen Fehlern lohnt ein anderes Modell desselben Schlüssels. */
  const MODELL_WECHSELN_BEI = Object.freeze(new Set([
    `${P}_MODELL_UNBEKANNT`, `${P}_LIMIT_TAG`, `${P}_LIMIT`, `${P}_UEBERLASTET`,
  ]));

  return Object.freeze({
    kind: 'openai',
    anbieterId: V.id,
    vorlage: V,
    NAME: V.name,
    API_BASIS,
    API_HOST,
    MAX_TOKENS,
    STANDARD_MODELL,
    MODELLE,
    ABLEHNUNG,
    MODELL_WECHSELN_BEI,
    AnbieterFehler,
    modellInfo,
    istModell,
    anfrageBauen,
    senden,
    probe,
    modelleAbfragen,
    chat,
    bloeckeZurueck,
    werkzeugAufrufe,
    kostenSchaetzen,
    fehlerAusAntwort,
    __internals: { nachrichtenUebersetzen, werkzeugeUebersetzen, heilen, fehlerAus, kurzeId },
  });
}

module.exports = { VORLAGEN, IDS, erstellen, vorlageVonSchluessel, kurzeId };
