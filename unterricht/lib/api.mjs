// Die API der Unterrichts-App, unabhängig von der Laufzeit: Der Cloudflare
// Worker (worker.mjs) und der lokale Dev-Server (server.mjs) reichen jede
// Anfrage an /api/* an `apiAnfrage` weiter.
//
//   GET  /api/status            Läuft der Server, ist ein Schlüssel da, welches Modell
//   POST /api/antwort           Lehrerfrage im Transkript erkennen und beantworten (websuche: true erlaubt Claude die Web-Suche)
//   POST /api/zusammenfassung   Stunde zusammenfassen (laufend: true = kurzer Zwischenstand)
//   POST /api/nachfrage         Frage zu gespeicherten Stunden
//
// Ist APP_KEY gesetzt, muss jede Anfrage ihn im Header x-app-key tragen,
// damit nicht jeder, der die Adresse kennt, auf Kosten des Schülers
// Claude benutzt.

import Anthropic from "@anthropic-ai/sdk";
import { antwort, zusammenfassung, nachfrage, STANDARD_MODELL } from "./claude.mjs";
import { bildAufloesen } from "./bilder.mjs";

const MAX_SEGMENTE = 4000;
const MAX_ZEICHEN = 400_000;

function json(daten, status = 200, extra = {}) {
  return new Response(JSON.stringify(daten), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

function corsKopf(request, env) {
  const origin = request.headers.get("origin");
  const erlaubt = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const kopf = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-app-key",
    "access-control-max-age": "86400",
  };
  if (!origin) return kopf;
  if (erlaubt.length === 0 || erlaubt.includes(origin)) {
    kopf["access-control-allow-origin"] = origin;
    kopf.vary = "origin";
  }
  return kopf;
}

function transkriptPruefen(transkript) {
  if (!Array.isArray(transkript)) return [];
  const sauber = [];
  let zeichen = 0;
  for (const s of transkript.slice(-MAX_SEGMENTE)) {
    if (!s || typeof s.text !== "string") continue;
    const text = s.text.trim();
    if (!text) continue;
    zeichen += text.length;
    if (zeichen > MAX_ZEICHEN) break;
    sauber.push({ t: typeof s.t === "number" && Number.isFinite(s.t) ? s.t : undefined, text });
  }
  return sauber;
}

function profilPruefen(profil) {
  if (!profil || typeof profil !== "object") return {};
  const kurz = (v) => (typeof v === "string" ? v.slice(0, 80) : undefined);
  return { klasse: kurz(profil.klasse), schulform: kurz(profil.schulform), name: kurz(profil.name) };
}

/**
 * @param request Fetch-Request
 * @param env { ANTHROPIC_API_KEY, APP_KEY?, MODELL?, ALLOWED_ORIGINS? }
 * @param optionen { client?: Anthropic-Attrappe für Tests, fetchFn? }
 */
export async function apiAnfrage(request, env, optionen = {}) {
  const url = new URL(request.url);
  const cors = corsKopf(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const pfad = url.pathname.replace(/\/+$/, "");
  const modell = env.MODELL || STANDARD_MODELL;

  if (pfad === "/api/status") {
    return json({ ok: true, modell, schluessel: Boolean(env.ANTHROPIC_API_KEY), geschuetzt: Boolean(env.APP_KEY) }, 200, cors);
  }

  if (env.APP_KEY && request.headers.get("x-app-key") !== env.APP_KEY) {
    return json({ fehler: "App-Schlüssel fehlt oder ist falsch (Einstellungen → App-Schlüssel)." }, 401, cors);
  }
  if (request.method !== "POST") return json({ fehler: "Nur POST." }, 405, cors);
  if (!env.ANTHROPIC_API_KEY && !optionen.client) {
    return json({ fehler: "Auf dem Server ist kein ANTHROPIC_API_KEY hinterlegt." }, 503, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ fehler: "Ungültiges JSON." }, 400, cors);
  }

  const client = optionen.client || new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 });
  const profil = profilPruefen(body.profil);

  try {
    if (pfad === "/api/antwort") {
      const transkript = transkriptPruefen(body.transkript);
      const frage = typeof body.frage === "string" ? body.frage.trim().slice(0, 1000) : "";
      if (!transkript.length && !frage) return json({ fehler: "Kein Transkript und keine Frage." }, 400, cors);
      const ergebnis = await antwort(client, {
        fach: String(body.fach || "").slice(0, 80),
        transkript,
        frage,
        modus: body.modus === "manuell" ? "manuell" : "auto",
        websuche: body.websuche === true,
        profil,
        modell,
      });
      const bild = await bildAufloesen(ergebnis.bild, optionen.fetchFn);
      return json({ ...ergebnis, bild }, 200, cors);
    }

    if (pfad === "/api/zusammenfassung") {
      const transkript = transkriptPruefen(body.transkript);
      if (transkript.length < 3) return json({ fehler: "Das Transkript ist zu kurz für eine Zusammenfassung." }, 400, cors);
      const ergebnis = await zusammenfassung(client, {
        fach: String(body.fach || "").slice(0, 80),
        datum: String(body.datum || "").slice(0, 40),
        dauer: typeof body.dauer === "number" ? body.dauer : undefined,
        laufend: body.laufend === true,
        transkript,
        profil,
        modell,
      });
      return json(ergebnis, 200, cors);
    }

    if (pfad === "/api/nachfrage") {
      const frage = typeof body.frage === "string" ? body.frage.trim().slice(0, 2000) : "";
      const stunden = Array.isArray(body.stunden) ? body.stunden.slice(0, 40) : [];
      if (!frage) return json({ fehler: "Keine Frage." }, 400, cors);
      if (!stunden.length) return json({ fehler: "Keine Stunden ausgewählt." }, 400, cors);
      const ergebnis = await nachfrage(client, {
        frage,
        stunden: stunden.map((s) => ({
          fach: String(s.fach || "").slice(0, 80),
          datum: String(s.datum || "").slice(0, 40),
          titel: String(s.titel || "").slice(0, 200),
          zusammenfassung: typeof s.zusammenfassung === "string" ? s.zusammenfassung.slice(0, 20000) : "",
          kernpunkte: Array.isArray(s.kernpunkte) ? s.kernpunkte.slice(0, 50).map(String) : [],
          transkript: transkriptPruefen(s.transkript),
        })),
        profil,
        modell,
      });
      return json(ergebnis, 200, cors);
    }

    return json({ fehler: "Unbekannter Pfad." }, 404, cors);
  } catch (e) {
    const status = e instanceof Anthropic.AuthenticationError ? 503 : e instanceof Anthropic.RateLimitError ? 429 : e instanceof Anthropic.APIError ? 502 : 500;
    const text =
      e instanceof Anthropic.AuthenticationError
        ? "Der Anthropic-Schlüssel auf dem Server ist ungültig."
        : e instanceof Anthropic.RateLimitError
          ? "Claude ist gerade ausgelastet, bitte gleich noch einmal."
          : e?.message || "Unbekannter Fehler.";
    return json({ fehler: text }, status, cors);
  }
}
