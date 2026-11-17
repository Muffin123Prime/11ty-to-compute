// Die API der Unterrichts-App, unabhängig von der Laufzeit: Der Cloudflare
// Worker (worker.mjs) und der lokale Dev-Server (server.mjs) reichen jede
// Anfrage an /api/* an `apiAnfrage` weiter.
//
//   GET  /api/status            Läuft der Server, ist ein Schlüssel da, welches Modell
//   POST /api/antwort           Lehrerfrage im Transkript erkennen und beantworten (websuche: true erlaubt Claude die Web-Suche)
//   POST /api/zusammenfassung   Stunde zusammenfassen (laufend: true = kurzer Zwischenstand)
//   POST /api/nachfrage         Frage zu gespeicherten Stunden
//   POST /api/uebersetzung      Transkript-Stücke live ins Deutsche übersetzen
//
// Welche KI antwortet, entscheidet lib/anbieter.mjs (KI_ANBIETER, Standard:
// Workers AI im selben Worker, kostenlos). Ist APP_KEY gesetzt, muss jede Anfrage ihn im Header x-app-key tragen,
// damit nicht jeder, der die Adresse kennt, auf Kosten des Schülers
// Claude benutzt.

import { antwort, zusammenfassung, nachfrage, uebersetzung } from "./claude.mjs";
import { erzeugeAnbieter, anbieterName } from "./anbieter.mjs";
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
  const laenge = ["kurz", "mittel", "lang"].includes(profil.antwortlaenge) ? profil.antwortlaenge : "mittel";
  return { klasse: kurz(profil.klasse), schulform: kurz(profil.schulform), name: kurz(profil.name), antwortlaenge: laenge };
}

/**
 * @param request Fetch-Request
 * @param env { AI?, KI_ANBIETER?, KI_MODELL?, KI_MODELL_SCHNELL?, ANTHROPIC_API_KEY?, GROQ_API_KEY?, GEMINI_API_KEY?, APP_KEY?, ALLOWED_ORIGINS? }
 * @param optionen { client?: Anthropic-Attrappe für Tests, anbieter?, fetchFn? }
 */
export async function apiAnfrage(request, env, optionen = {}) {
  const url = new URL(request.url);
  const cors = corsKopf(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const pfad = url.pathname.replace(/\/+$/, "");
  const anbieter = optionen.anbieter || erzeugeAnbieter(env, optionen);

  if (pfad === "/api/status") {
    return json(
      {
        ok: true,
        anbieter: anbieter?.name || null,
        anbieterName: anbieter ? anbieterName(anbieter.name) : null,
        modell: anbieter?.modell || null,
        schluessel: Boolean(anbieter),
        websuche: anbieter?.name === "anthropic",
        geschuetzt: Boolean(env.APP_KEY),
      },
      200,
      cors,
    );
  }

  if (env.APP_KEY && request.headers.get("x-app-key") !== env.APP_KEY) {
    return json({ fehler: "App-Schlüssel fehlt oder ist falsch (Einstellungen → App-Schlüssel)." }, 401, cors);
  }
  if (request.method !== "POST") return json({ fehler: "Nur POST." }, 405, cors);
  if (!anbieter) {
    return json({ fehler: "Auf dem Server ist keine KI eingerichtet (Workers-AI-Binding oder ein Schlüssel für Groq, Gemini oder Anthropic)." }, 503, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ fehler: "Ungültiges JSON." }, 400, cors);
  }

  const client = anbieter;
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
        kontext: typeof body.kontext === "string" ? body.kontext.slice(0, 4000) : "",
        sprache: /^[a-z]{2}$/.test(String(body.sprache || "")) ? body.sprache : "de",
        bisherige: Array.isArray(body.bisherige) ? body.bisherige.slice(-8).map((f) => String(f).slice(0, 200)) : [],
        websuche: body.websuche === true && anbieter.name === "anthropic",
        profil,
      });
      const bild = await bildAufloesen(ergebnis.bild, optionen.fetchFn);
      return json({ ...ergebnis, bild }, 200, cors);
    }

    if (pfad === "/api/zusammenfassung") {
      const transkript = transkriptPruefen(body.transkript);
      if (transkript.length < 3) return json({ fehler: "Das Transkript ist zu kurz für eine Zusammenfassung." }, 400, cors);
      const ohneDoppelte = (liste, schluessel = (x) => x) => {
        const gesehen = new Set();
        return (Array.isArray(liste) ? liste : []).filter((x) => {
          const k = String(schluessel(x)).trim().toLowerCase();
          if (!k || gesehen.has(k)) return false;
          gesehen.add(k);
          return true;
        });
      };
      const ergebnis = await zusammenfassung(client, {
        fach: String(body.fach || "").slice(0, 80),
        datum: String(body.datum || "").slice(0, 40),
        dauer: typeof body.dauer === "number" ? body.dauer : undefined,
        laufend: body.laufend === true,
        transkript,
        profil,
      });
      ergebnis.kernpunkte = ohneDoppelte(ergebnis.kernpunkte);
      ergebnis.hausaufgaben = ohneDoppelte(ergebnis.hausaufgaben);
      ergebnis.fragen = ohneDoppelte(ergebnis.fragen, (f) => f?.frage);
      ergebnis.begriffe = ohneDoppelte(ergebnis.begriffe, (b) => b?.begriff);
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
      });
      return json(ergebnis, 200, cors);
    }

    if (pfad === "/api/uebersetzung") {
      const segmente = (Array.isArray(body.segmente) ? body.segmente : [])
        .filter((s) => s && typeof s.text === "string" && s.text.trim())
        .slice(0, 30)
        .map((s, i) => ({ id: String(s.id ?? i).slice(0, 40), text: s.text.trim().slice(0, 1000) }));
      if (!segmente.length) return json({ fehler: "Nichts zu übersetzen." }, 400, cors);
      const von = /^[a-z]{2}$/.test(String(body.von || "")) ? body.von : "en";
      const ergebnis = await uebersetzung(client, { segmente, von, fach: String(body.fach || "").slice(0, 80) });
      return json(ergebnis, 200, cors);
    }

    return json({ fehler: "Unbekannter Pfad." }, 404, cors);
  } catch (e) {
    const bekannt = anbieter.fehlerText?.(e);
    if (bekannt) return json({ fehler: bekannt.text }, bekannt.status, cors);
    const status = /kontingent|ausgelastet|limit|429/i.test(e?.message || "") ? 429 : 500;
    return json({ fehler: e?.message || "Unbekannter Fehler." }, status, cors);
  }
}
