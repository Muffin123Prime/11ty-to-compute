// Lokaler Server zum Ausprobieren ohne Cloudflare:
//   ANTHROPIC_API_KEY=sk-... node server.mjs      → http://localhost:8787
//   node server.mjs --mock                         → ohne Schlüssel, mit Attrappen-Antworten
// Spracherkennung im Browser braucht https oder localhost; localhost reicht.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiAnfrage } from "./lib/api.mjs";
import { attrappenClient } from "./lib/attrappe.mjs";

const hier = path.dirname(fileURLToPath(import.meta.url));
const oeffentlich = path.join(hier, "public");
const port = Number(process.env.PORT || 8787);
const mock = process.argv.includes("--mock");

const env = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
  APP_KEY: process.env.APP_KEY || "",
  MODELL: process.env.MODELL || "",
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || "",
};
if (mock) env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY || "mock";

const TYPEN = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function statisch(pfad) {
  let datei = path.normalize(path.join(oeffentlich, pfad === "/" ? "index.html" : pfad));
  if (!datei.startsWith(oeffentlich)) return new Response("Nein.", { status: 403 });
  try {
    const s = await stat(datei);
    if (s.isDirectory()) datei = path.join(datei, "index.html");
    const inhalt = await readFile(datei);
    return new Response(inhalt, { headers: { "content-type": TYPEN[path.extname(datei)] || "application/octet-stream" } });
  } catch {
    return new Response("Nicht gefunden.", { status: 404 });
  }
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  const url = new URL(request.url);
  let antwort;
  try {
    antwort = url.pathname.startsWith("/api/")
      ? await apiAnfrage(request, env, mock ? { client: attrappenClient() } : {})
      : await statisch(decodeURIComponent(url.pathname));
  } catch (e) {
    antwort = new Response(JSON.stringify({ fehler: e.message }), { status: 500, headers: { "content-type": "application/json" } });
  }
  res.writeHead(antwort.status, Object.fromEntries(antwort.headers));
  res.end(Buffer.from(await antwort.arrayBuffer()));
}).listen(port, () => {
  console.log(`Unterrichts-App: http://localhost:${port}${mock ? "  (Attrappen-Modus, kein Claude)" : env.ANTHROPIC_API_KEY ? "" : "  (kein ANTHROPIC_API_KEY gesetzt)"}`);
});
