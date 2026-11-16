import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonAusText, schemaOhneExtras, cloudflareAnbieter, groqAnbieter, geminiAnbieter, erzeugeAnbieter } from "./anbieter.mjs";
import { apiAnfrage } from "./api.mjs";
import { ANTWORT_SCHEMA } from "./claude.mjs";

const post = (pfad, body) => new Request(`http://x${pfad}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const antwortJson = { frage_erkannt: true, frage: "Wie sieht H2O aus?", antwort: "Gewinkelt.", kurz: "Gewinkelt.", erklaerung: "", bild: { typ: "molekuel", wert: "water", beschreibung: "Wasser" } };

test("jsonAusText verkraftet Zäune und Text drumherum", () => {
  assert.deepEqual(jsonAusText('{"a":1}'), { a: 1 });
  assert.deepEqual(jsonAusText('Hier:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(jsonAusText('Also {"a":{"b":2}} fertig'), { a: { b: 2 } });
  assert.deepEqual(jsonAusText({ a: 1 }), { a: 1 });
  assert.throws(() => jsonAusText("kein json"), /kein gültiges JSON/);
});

test("schemaOhneExtras entfernt additionalProperties überall", () => {
  const s = schemaOhneExtras(ANTWORT_SCHEMA);
  assert.equal(JSON.stringify(s).includes("additionalProperties"), false);
  assert.ok(s.properties.bild.properties.typ.enum.includes("svg"));
});

test("cloudflare: ruft Workers AI mit json_schema auf und parst die Antwort", async () => {
  const aufrufe = [];
  const ai = { run: async (modell, params) => { aufrufe.push({ modell, params }); return { response: antwortJson, usage: { prompt_tokens: 100, completion_tokens: 20 } }; } };
  const r = await apiAnfrage(post("/api/antwort", { fach: "Chemie", transkript: [{ text: "wie sieht h2o aus" }] }), { AI: ai });
  const d = await r.json();
  assert.equal(d.frage_erkannt, true);
  assert.equal(d.bild.typ, "molekuel");
  assert.equal(d.nutzung.anbieter, "cloudflare");
  assert.equal(aufrufe[0].modell, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.equal(aufrufe[0].params.response_format.type, "json_schema");
  assert.match(aufrufe[0].params.messages[1].content, /JSON-Schema/);
  // Übersetzung nimmt das schnelle Modell
  ai.run = async (modell) => { aufrufe.push({ modell }); return { response: '{"uebersetzungen":[{"id":"a","text":"Hallo"}]}' }; };
  const u = await apiAnfrage(post("/api/uebersetzung", { von: "en", segmente: [{ id: "a", text: "hello" }] }), { AI: ai });
  assert.equal((await u.json()).uebersetzungen[0].text, "Hallo");
  assert.equal(aufrufe.at(-1).modell, "@cf/meta/llama-3.1-8b-instruct-fast");
});

test("cloudflare: Kontingent-Fehler wird verständlich gemeldet", async () => {
  const ai = { run: async () => { throw new Error("4029: Daily neuron quota exceeded"); } };
  const r = await apiAnfrage(post("/api/antwort", { frage: "?" }), { AI: ai });
  assert.equal(r.status, 429);
  assert.match((await r.json()).fehler, /Tageskontingent/);
});

test("groq: OpenAI-Format mit json_object", async () => {
  let anfrage;
  const fetchFn = async (url, init) => { anfrage = { url, init: JSON.parse(init.body), headers: init.headers }; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(antwortJson) } }], usage: { prompt_tokens: 5, completion_tokens: 5 } })); };
  const r = await apiAnfrage(post("/api/antwort", { frage: "Wie sieht H2O aus?" }), { GROQ_API_KEY: "g" }, { fetchFn });
  assert.equal((await r.json()).antwort, "Gewinkelt.");
  assert.match(anfrage.url, /api\.groq\.com/);
  assert.equal(anfrage.headers.authorization, "Bearer g");
  assert.equal(anfrage.init.response_format.type, "json_object");
  assert.equal(anfrage.init.model, "llama-3.3-70b-versatile");
});

test("gemini: generateContent mit responseSchema ohne additionalProperties", async () => {
  let anfrage;
  const fetchFn = async (url, init) => { anfrage = { url, init: JSON.parse(init.body), headers: init.headers }; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(antwortJson) }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })); };
  const r = await apiAnfrage(post("/api/antwort", { frage: "Wie sieht H2O aus?" }), { GEMINI_API_KEY: "k", KI_MODELL: "gemini-2.5-flash-lite" }, { fetchFn });
  assert.equal((await r.json()).antwort, "Gewinkelt.");
  assert.match(anfrage.url, /gemini-2\.5-flash-lite:generateContent/);
  assert.equal(anfrage.headers["x-goog-api-key"], "k");
  assert.equal(JSON.stringify(anfrage.init.generationConfig.responseSchema).includes("additionalProperties"), false);
  assert.equal(anfrage.init.generationConfig.responseMimeType, "application/json");
});

test("erzeugeAnbieter: Reihenfolge und KI_ANBIETER", () => {
  const ai = { run: async () => ({}) };
  assert.equal(erzeugeAnbieter({ AI: ai, GROQ_API_KEY: "g", ANTHROPIC_API_KEY: "a" }).name, "cloudflare");
  assert.equal(erzeugeAnbieter({ GROQ_API_KEY: "g", GEMINI_API_KEY: "k" }).name, "groq");
  assert.equal(erzeugeAnbieter({ AI: ai, GROQ_API_KEY: "g", KI_ANBIETER: "groq" }).name, "groq");
  assert.equal(erzeugeAnbieter({ AI: ai, KI_ANBIETER: "gemini" }), null);
  assert.equal(erzeugeAnbieter({}), null);
  assert.equal(cloudflareAnbieter(ai, { modell: "@cf/x" }).modell, "@cf/x");
  assert.equal(groqAnbieter("k").name, "groq");
  assert.equal(geminiAnbieter("k").name, "gemini");
});

test("Kette: bei aufgebrauchtem Kontingent übernimmt Groq", async () => {
  const ai = { run: async () => { throw new Error("Daily neuron quota exceeded"); } };
  let groqGefragt = false;
  const fetchFn = async () => { groqGefragt = true; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(antwortJson) } }] })); };
  const r = await apiAnfrage(post("/api/antwort", { frage: "?" }), { AI: ai, GROQ_API_KEY: "g" }, { fetchFn });
  assert.equal(r.status, 200);
  assert.equal(groqGefragt, true);
  const st = await (await apiAnfrage(new Request("http://x/api/status"), { AI: ai, GROQ_API_KEY: "g" })).json();
  assert.equal(st.anbieter, "cloudflare");
});

test("status nennt den Anbieter", async () => {
  const r = await apiAnfrage(new Request("http://x/api/status"), { AI: { run: async () => ({}) } });
  const d = await r.json();
  assert.equal(d.anbieter, "cloudflare");
  assert.equal(d.websuche, false);
  assert.match(d.anbieterName, /kostenlos/);
});
