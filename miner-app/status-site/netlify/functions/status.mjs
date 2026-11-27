// Liefert der Handy-Seite den zuletzt gemeldeten Stand.
import { getStore } from "@netlify/blobs";

const json = (status, data) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export default async (req) => {
  if (req.method !== "GET") return json(405, { error: "method not allowed" });
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!/^[0-9a-f]{32}$/.test(id)) return json(400, { error: "invalid id" });
  const store = getStore({ name: "status", consistency: "strong" });
  const entry = await store.get(id, { type: "json" });
  if (entry === null) return json(404, { error: "not found" });
  return json(200, { state: entry.state, receivedAt: entry.receivedAt, now: Date.now() });
};

export const config = { path: "/api/status" };
