// Cloudflare Worker: liefert die App (public/, beim Deploy in generated/public.mjs
// gebündelt) und beantwortet /api/* mit lib/api.mjs. Deploy: `npm run deploy`.
import { apiAnfrage } from "./lib/api.mjs";
import { DATEIEN } from "./generated/public.mjs";

function datei(pfad) {
  let p = pfad === "/" ? "/index.html" : pfad;
  let d = DATEIEN[p];
  if (!d && !path_hat_endung(p)) d = DATEIEN[(p = `${p.replace(/\/+$/, "")}/index.html`)];
  return d;
}
const path_hat_endung = (p) => /\.[a-z0-9]+$/i.test(p);

function base64ZuBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return apiAnfrage(request, env);
    const d = datei(decodeURIComponent(url.pathname));
    if (!d) return new Response("Nicht gefunden.", { status: 404 });
    const html = d.typ.startsWith("text/html");
    return new Response(base64ZuBytes(d.b64), {
      headers: {
        "content-type": d.typ,
        "cache-control": html ? "no-cache" : "public, max-age=600",
      },
    });
  },
};
