// KI-Anbieter hinter einer gemeinsamen Schnittstelle. Jeder Anbieter hat
// `strukturiert({ system, user, schema, effort, maxTokens, schnell, websuche })`
// und liefert `{ daten, nutzung }`, wobei `daten` das nach `schema` geparste
// JSON ist.
//
//   cloudflare  Workers AI, läuft im selben Worker (Binding AI), kostenlos bis
//               10.000 Neuronen am Tag, kein Schlüssel nötig. Standard.
//   groq        kostenloser Plan mit Schlüssel (GROQ_API_KEY), sehr schnell
//   gemini      Google AI Studio mit Schlüssel (GEMINI_API_KEY), kleine Tageskontingente
//   anthropic   Claude mit Schlüssel (ANTHROPIC_API_KEY), kostet Geld, beste Qualität
//
// `schnell: true` wählt das kleinere Modell (Übersetzung, Zwischenstand).

import Anthropic from "@anthropic-ai/sdk";

export const STANDARD = {
  anthropic: { modell: "claude-opus-5-5", schnell: "claude-opus-5-5" },
  cloudflare: { modell: "@cf/openai/gpt-oss-120b", schnell: "@cf/meta/llama-3.1-8b-instruct-fast" },
  groq: { modell: "llama-3.3-70b-versatile", schnell: "llama-3.1-8b-instant" },
  gemini: { modell: "gemini-2.5-flash", schnell: "gemini-2.5-flash-lite" },
};

// Holt aus einer Modellantwort das JSON, auch wenn Text oder ```-Zäune drumherum stehen.
export function jsonAusText(text) {
  if (text && typeof text === "object") return text;
  if (typeof text !== "string") throw new Error("Das Modell hat keinen Text geliefert.");
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* weiter */
  }
  const zaun = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (zaun) {
    try {
      return JSON.parse(zaun[1].trim());
    } catch {
      /* weiter */
    }
  }
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {
      /* weiter */
    }
  }
  throw new Error("Das Modell hat kein gültiges JSON geliefert.");
}

// Gemini und einige Modelle kennen additionalProperties nicht.
export function schemaOhneExtras(schema) {
  if (Array.isArray(schema)) return schema.map(schemaOhneExtras);
  if (schema && typeof schema === "object") {
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
      if (k === "additionalProperties") continue;
      out[k] = schemaOhneExtras(v);
    }
    return out;
  }
  return schema;
}

const schemaHinweis = (schema) => `\n\nAntworte ausschließlich mit einem JSON-Objekt, ohne Text davor oder danach, genau nach diesem JSON-Schema:\n${JSON.stringify(schema)}`;

// ---------------------------------------------------------------- Anthropic
export function anthropicAnbieter(client, modelle = {}) {
  const m = { ...STANDARD.anthropic, ...modelle };
  return {
    name: "anthropic",
    modell: m.modell,
    async strukturiert({ system, user, schema, effort, maxTokens, websuche }) {
      const messages = [{ role: "user", content: user }];
      const params = {
        model: m.modell,
        max_tokens: maxTokens || 8000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages,
        output_config: { effort: effort || "medium", format: { type: "json_schema", schema } },
      };
      if (websuche) params.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }];
      let response = await client.beta.messages.create(params);
      for (let runde = 0; response.stop_reason === "pause_turn" && runde < 3; runde++) {
        messages.push({ role: "assistant", content: response.content });
        response = await client.beta.messages.create(params);
      }
      if (response.stop_reason === "refusal") {
        const grund = response.stop_details?.explanation || response.stop_details?.category || "ohne Angabe";
        throw new Error(`Claude hat die Anfrage abgelehnt (${grund}).`);
      }
      if (response.stop_reason === "max_tokens") throw new Error("Die Antwort war zu lang und wurde abgeschnitten.");
      const texte = response.content.filter((b) => b.type === "text").map((b) => b.text);
      const daten = jsonAusText(texte.at(-1) || "");
      return {
        daten,
        nutzung: {
          anbieter: "anthropic",
          modell: response.model,
          eingabe: response.usage?.input_tokens ?? 0,
          ausgabe: response.usage?.output_tokens ?? 0,
          cache: response.usage?.cache_read_input_tokens ?? 0,
          suchen: response.content.filter((b) => b.type === "server_tool_use").length,
        },
      };
    },
    fehlerText(e) {
      if (e instanceof Anthropic.AuthenticationError) return { status: 503, text: "Der Anthropic-Schlüssel auf dem Server ist ungültig." };
      if (e instanceof Anthropic.RateLimitError) return { status: 429, text: "Claude ist gerade ausgelastet, bitte gleich noch einmal." };
      if (e instanceof Anthropic.APIError) return { status: 502, text: e.message };
      return null;
    },
  };
}

// ------------------------------------------------------- Cloudflare Workers AI
function cfParams(modell, { system, user, schema, maxTokens }) {
  const params = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user + schemaHinweis(schema) },
    ],
    response_format: { type: "json_schema", json_schema: schemaOhneExtras(schema) },
    max_tokens: Math.min(maxTokens || 2000, 4096),
    temperature: 0.3,
  };
  // gpt-oss denkt vor der Antwort; auf "low" bleibt das kurz.
  if (/gpt-oss/.test(modell)) params.reasoning_effort = "low";
  return params;
}
function cfFehler(e) {
  const text = String(e?.message || e);
  if (/quota|neuron|limit|exceed|429/i.test(text)) return new Error("Das kostenlose Tageskontingent von Workers AI ist aufgebraucht (ab Mitternacht UTC geht es weiter).");
  return new Error(`Workers AI: ${text}`);
}

// Liest einen SSE-Strom von Workers AI (OpenAI-Chat-Stückchen) und ruft onDelta für jeden Textteil.
export async function sseLesen(stream, onDelta) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let rest = "";
  let text = "";
  let nutzung = {};
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += dec.decode(value, { stream: true });
    const zeilen = rest.split("\n");
    rest = zeilen.pop();
    for (const z of zeilen) {
      const t = z.trim();
      if (!t.startsWith("data:")) continue;
      const p = t.slice(5).trim();
      if (p === "[DONE]") continue;
      let d;
      try {
        d = JSON.parse(p);
      } catch {
        continue;
      }
      if (d.usage) nutzung = d.usage;
      const delta = d.choices?.[0]?.delta?.content ?? d.response ?? "";
      if (delta) {
        text += delta;
        if (onDelta) onDelta(delta, text);
      }
    }
  }
  return { text, nutzung };
}

export function cloudflareAnbieter(ai, modelle = {}) {
  const m = { ...STANDARD.cloudflare, ...modelle };
  return {
    name: "cloudflare",
    modell: m.modell,
    async strukturiert(p) {
      const modell = p.schnell ? m.schnell : m.modell;
      let antwort;
      try {
        antwort = await ai.run(modell, cfParams(modell, p));
      } catch (e) {
        throw cfFehler(e);
      }
      const roh = antwort?.response ?? antwort?.choices?.[0]?.message?.content ?? antwort;
      const daten = jsonAusText(roh);
      const u = antwort?.usage || {};
      return { daten, nutzung: { anbieter: "cloudflare", modell, eingabe: u.prompt_tokens ?? 0, ausgabe: u.completion_tokens ?? 0 } };
    },
    // Wie strukturiert, aber der Text kommt Stück für Stück über onDelta(delta, bisher).
    async strukturiertStream(p) {
      const modell = p.schnell ? m.schnell : m.modell;
      let stream;
      try {
        stream = await ai.run(modell, { ...cfParams(modell, p), stream: true });
      } catch (e) {
        throw cfFehler(e);
      }
      const { text, nutzung } = await sseLesen(stream, p.onDelta);
      const daten = jsonAusText(text);
      return { daten, nutzung: { anbieter: "cloudflare", modell, eingabe: nutzung.prompt_tokens ?? 0, ausgabe: nutzung.completion_tokens ?? 0 } };
    },
    fehlerText: () => null,
  };
}

// ------------------------------------------------------------------- Groq
export function groqAnbieter(key, modelle = {}, fetchFn = fetch) {
  const m = { ...STANDARD.groq, ...modelle };
  return {
    name: "groq",
    modell: m.modell,
    async strukturiert({ system, user, schema, maxTokens, schnell }) {
      const modell = schnell ? m.schnell : m.modell;
      const r = await fetchFn("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: modell,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user + schemaHinweis(schema) },
          ],
          response_format: { type: "json_object" },
          max_tokens: Math.min(maxTokens || 2000, 8000),
          temperature: 0.3,
        }),
      });
      if (r.status === 429) throw new Error("Groq: Kontingent für heute oder diese Minute aufgebraucht, bitte gleich noch einmal.");
      if (r.status === 401) throw new Error("Der Groq-Schlüssel auf dem Server ist ungültig.");
      if (!r.ok) throw new Error(`Groq antwortet mit Status ${r.status}.`);
      const d = await r.json();
      const daten = jsonAusText(d.choices?.[0]?.message?.content || "");
      return { daten, nutzung: { anbieter: "groq", modell, eingabe: d.usage?.prompt_tokens ?? 0, ausgabe: d.usage?.completion_tokens ?? 0 } };
    },
    fehlerText: () => null,
  };
}

// ----------------------------------------------------------------- Gemini
export function geminiAnbieter(key, modelle = {}, fetchFn = fetch) {
  const m = { ...STANDARD.gemini, ...modelle };
  return {
    name: "gemini",
    modell: m.modell,
    async strukturiert({ system, user, schema, maxTokens, schnell }) {
      const modell = schnell ? m.schnell : m.modell;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modell)}:generateContent`;
      const r = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schemaOhneExtras(schema),
            maxOutputTokens: Math.min(maxTokens || 2000, 8000),
            temperature: 0.3,
          },
        }),
      });
      if (r.status === 429) throw new Error("Gemini: Tageskontingent oder Minutenlimit aufgebraucht, bitte später noch einmal.");
      if (r.status === 400 || r.status === 403) throw new Error("Der Gemini-Schlüssel auf dem Server ist ungültig oder das Modell gibt es nicht.");
      if (!r.ok) throw new Error(`Gemini antwortet mit Status ${r.status}.`);
      const d = await r.json();
      const text = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
      const daten = jsonAusText(text);
      return { daten, nutzung: { anbieter: "gemini", modell, eingabe: d.usageMetadata?.promptTokenCount ?? 0, ausgabe: d.usageMetadata?.candidatesTokenCount ?? 0 } };
    },
    fehlerText: () => null,
  };
}

// ------------------------------------------------------------- Auswahl
/**
 * Wählt den Anbieter nach env.KI_ANBIETER, sonst nach dem, was da ist:
 * Workers-AI-Binding → Anthropic-Schlüssel → Groq-Schlüssel → Gemini-Schlüssel.
 */
export function erzeugeAnbieter(env = {}, optionen = {}) {
  const modelle = {};
  if (env.KI_MODELL) modelle.modell = env.KI_MODELL;
  if (env.KI_MODELL_SCHNELL) modelle.schnell = env.KI_MODELL_SCHNELL;
  if (env.MODELL && !modelle.modell) modelle.modell = env.MODELL; // alter Name
  if (optionen.client) return anthropicAnbieter(optionen.client, modelle);

  const wunsch = String(env.KI_ANBIETER || "").toLowerCase();
  const kann = {
    cloudflare: () => env.AI && cloudflareAnbieter(env.AI, modelle),
    anthropic: () => env.ANTHROPIC_API_KEY && anthropicAnbieter(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 }), modelle),
    groq: () => env.GROQ_API_KEY && groqAnbieter(env.GROQ_API_KEY, modelle, optionen.fetchFn),
    gemini: () => env.GEMINI_API_KEY && geminiAnbieter(env.GEMINI_API_KEY, modelle, optionen.fetchFn),
  };
  if (wunsch && kann[wunsch]) {
    const a = kann[wunsch]();
    if (a) return a;
    return null;
  }
  // Ohne Wunsch: alle vorhandenen Anbieter als Kette. Ist das Tageskontingent
  // des ersten aufgebraucht, übernimmt der nächste.
  const kette = ["cloudflare", "groq", "gemini", "anthropic"].map((n) => kann[n]()).filter(Boolean);
  if (!kette.length) return null;
  return kette.length === 1 ? kette[0] : kettenAnbieter(kette);
}

export function kettenAnbieter(anbieter) {
  return {
    name: anbieter[0].name,
    modell: anbieter[0].modell,
    kette: anbieter.map((a) => a.name),
    async strukturiert(params) {
      let letzter;
      for (const a of anbieter) {
        try {
          return await a.strukturiert(params);
        } catch (e) {
          letzter = e;
          if (!/kontingent|limit|429|ausgelastet/i.test(e?.message || "")) throw e;
        }
      }
      throw letzter;
    },
    fehlerText: (e) => anbieter.map((a) => a.fehlerText?.(e)).find(Boolean) || null,
  };
}

export function anbieterName(name) {
  return { cloudflare: "Cloudflare Workers AI (kostenlos)", groq: "Groq (kostenlos)", gemini: "Google Gemini", anthropic: "Claude (Anthropic)" }[name] || name;
}
