// Nimmt den aktuellen Stand der KryptoMiner-App entgegen.
// Die App weist sich mit ihrem geheimen Schlüssel aus; gespeichert wird unter
// dessen Prüfsumme, die zugleich die Kennung in der Handy-Adresse ist.
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const json = (status, data) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  const text = await req.text();
  if (text.length > 32768) return json(413, { error: "too large" });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "invalid json" });
  }
  const key = body?.key;
  const state = body?.state;
  if (typeof key !== "string" || !/^[0-9a-f]{48}$/.test(key)) return json(400, { error: "invalid key" });
  if (!state || typeof state !== "object" || Array.isArray(state)) return json(400, { error: "invalid state" });

  const id = createHash("sha256").update(key).digest("hex").slice(0, 32);
  const store = getStore({ name: "status", consistency: "strong" });
  await store.setJSON(id, { state, receivedAt: Date.now() });
  return json(200, { ok: true });
};

export const config = { path: "/api/push" };
