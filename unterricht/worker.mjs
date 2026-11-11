// Cloudflare Worker: liefert die App (public/) als statische Dateien und
// beantwortet /api/* mit lib/api.mjs. Deploy: `npm run deploy`.
import { apiAnfrage } from "./lib/api.mjs";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return apiAnfrage(request, env);
    return env.ASSETS.fetch(request);
  },
};
