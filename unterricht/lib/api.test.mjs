import { test } from "node:test";
import assert from "node:assert/strict";
import { apiAnfrage } from "./api.mjs";
import { attrappenClient } from "./attrappe.mjs";
import { svgBereinigen, bildAufloesen, pubchemUrl } from "./bilder.mjs";
import { antwortUserPrompt, formatZeit } from "./claude.mjs";

const env = { ANTHROPIC_API_KEY: "test", APP_KEY: "", MODELL: "" };
const post = (pfad, body, kopf = {}) =>
  new Request(`http://x${pfad}`, { method: "POST", headers: { "content-type": "application/json", ...kopf }, body: JSON.stringify(body) });

test("status meldet Modell und Schlüssel", async () => {
  const r = await apiAnfrage(new Request("http://x/api/status"), env);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.modell, "claude-opus-5-5");
  assert.equal(d.schluessel, true);
});

test("App-Schlüssel wird verlangt, wenn gesetzt", async () => {
  const geschuetzt = { ...env, APP_KEY: "geheim" };
  const ohne = await apiAnfrage(post("/api/antwort", { transkript: [] }), geschuetzt, { client: attrappenClient() });
  assert.equal(ohne.status, 401);
  const mit = await apiAnfrage(post("/api/antwort", { frage: "Was ist H2O?" }, { "x-app-key": "geheim" }), geschuetzt, { client: attrappenClient() });
  assert.equal(mit.status, 200);
});

test("antwort: keine Frage → frage_erkannt false, kein Bild", async () => {
  const client = attrappenClient();
  const r = await apiAnfrage(post("/api/antwort", { fach: "Bio", transkript: [{ t: 1, text: "heute reden wir über die zelle" }] }), env, { client });
  const d = await r.json();
  assert.equal(d.frage_erkannt, false);
  assert.equal(d.bild, null);
  const params = client.aufrufe[0];
  assert.equal(params.model, "claude-opus-5-5");
  assert.equal(params.fallbacks, "default");
  assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(params.output_config.format.type, "json_schema");
  assert.equal(params.output_config.effort, "medium");
});

test("antwort: Lehrerfrage nach H2O → Antwort mit PubChem-Bild", async () => {
  const r = await apiAnfrage(
    post("/api/antwort", { fach: "Chemie", transkript: [{ t: 10, text: "so und wie sieht h2o aus wer kann mir das sagen" }] }),
    env,
    { client: attrappenClient() },
  );
  const d = await r.json();
  assert.equal(d.frage_erkannt, true);
  assert.match(d.antwort, /Sauerstoffatom/);
  assert.equal(d.bild.typ, "molekuel");
  assert.equal(d.bild.url, pubchemUrl("water"));
  assert.equal(d.nutzung.eingabe, 1200);
});

test("antwort: manueller Modus nutzt effort high", async () => {
  const client = attrappenClient();
  await apiAnfrage(post("/api/antwort", { transkript: [{ text: "irgendwas" }], modus: "manuell" }), env, { client });
  assert.equal(client.aufrufe[0].output_config.effort, "high");
  assert.match(client.aufrufe[0].messages[0].content, /Jetzt antworten/);
});

test("antwort: Ablehnung wird als Fehler gemeldet", async () => {
  const client = attrappenClient({ stop_reason: "refusal", stop_details: { type: "refusal", category: "x", explanation: "nein" } });
  const r = await apiAnfrage(post("/api/antwort", { frage: "?" }), env, { client });
  assert.equal(r.status, 500);
  assert.match((await r.json()).fehler, /abgelehnt/);
});

test("zusammenfassung verlangt ein Transkript und liefert Struktur", async () => {
  const kurz = await apiAnfrage(post("/api/zusammenfassung", { transkript: [{ text: "a" }] }), env, { client: attrappenClient() });
  assert.equal(kurz.status, 400);
  const r = await apiAnfrage(
    post("/api/zusammenfassung", { fach: "Chemie", datum: "2026-11-11", dauer: 2700, transkript: [{ t: 0, text: "a" }, { t: 5, text: "b" }, { t: 9, text: "c" }] }),
    env,
    { client: attrappenClient() },
  );
  const d = await r.json();
  assert.equal(d.titel, "Attrappen-Stunde");
  assert.ok(Array.isArray(d.kernpunkte));
  assert.ok(Array.isArray(d.hausaufgaben));
});

test("nachfrage bündelt die Stunden in den Prompt", async () => {
  const client = attrappenClient();
  const r = await apiAnfrage(
    post("/api/nachfrage", {
      frage: "Worum ging es letzte Woche in Bio?",
      stunden: [{ fach: "Bio", datum: "2026-11-04", titel: "Zellen", zusammenfassung: "Es ging um Zellen.", kernpunkte: ["Zellkern"] }],
    }),
    env,
    { client },
  );
  assert.equal(r.status, 200);
  const prompt = client.aufrufe[0].messages[0].content;
  assert.match(prompt, /<stunde nr="1" fach="Bio" datum="2026-11-04" titel="Zellen">/);
  assert.match(prompt, /Zellkern/);
});

test("fehlender Server-Schlüssel ergibt 503", async () => {
  const r = await apiAnfrage(post("/api/antwort", { frage: "?" }), { ANTHROPIC_API_KEY: "" });
  assert.equal(r.status, 503);
});

test("Prompt enthält Zeitmarken und eingetippte Frage", () => {
  const p = antwortUserPrompt({ fach: "Mathe", transkript: [{ t: 65, text: "hallo" }], frage: "Was ist 2+2?", modus: "auto" });
  assert.match(p, /\[01:05\] hallo/);
  assert.match(p, /eingetippte Frage \(hat Vorrang\): Was ist 2\+2\?/);
  assert.equal(formatZeit(3599), "59:59");
});

test("svgBereinigen entfernt Skripte, Events und externe Verweise", () => {
  const svg = `<svg viewBox="0 0 10 10"><script>alert(1)</script><a href="http://x" xlink:href="http://y"><circle onclick="x()" r="2"/></a><image href="http://z"/><use href="#a"/></svg>`;
  const s = svgBereinigen(svg);
  assert.ok(s.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.doesNotMatch(s, /script|onclick|http:\/\/[xyz]|<image|<use/);
  assert.equal(svgBereinigen("<div>nein</div>"), null);
});

test("bildAufloesen holt das Wikipedia-Hauptbild", async () => {
  const fetchFn = async () =>
    new Response(JSON.stringify({ title: "Zelle (Biologie)", originalimage: { source: "https://upload/x.jpg" }, content_urls: { desktop: { page: "https://de.wikipedia.org/wiki/Zelle" } } }));
  const b = await bildAufloesen({ typ: "wikipedia", wert: "Zelle (Biologie)", beschreibung: "Zelle" }, fetchFn);
  assert.equal(b.url, "https://upload/x.jpg");
  assert.equal(b.quelle, "Wikipedia: Zelle (Biologie)");
  const nichts = await bildAufloesen({ typ: "wikipedia", wert: "Gibtsnicht" }, async () => new Response("", { status: 404 }));
  assert.equal(nichts, null);
});
