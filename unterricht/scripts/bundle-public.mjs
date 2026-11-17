// Packt alle Dateien aus public/ in generated/public.mjs, damit der Worker sie
// selbst ausliefert und kein separater Asset-Upload nötig ist.
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hier = path.dirname(fileURLToPath(import.meta.url));
const quelle = path.join(hier, "..", "public");
const ziel = path.join(hier, "..", "generated");
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
  ".txt": "text/plain; charset=utf-8",
};

const dateien = {};
function lauf(ordner, praefix) {
  for (const name of readdirSync(ordner)) {
    const voll = path.join(ordner, name);
    if (statSync(voll).isDirectory()) lauf(voll, `${praefix}${name}/`);
    else dateien[`${praefix}${name}`] = { typ: TYPEN[path.extname(name)] || "application/octet-stream", b64: readFileSync(voll).toString("base64") };
  }
}
lauf(quelle, "/");
mkdirSync(ziel, { recursive: true });
writeFileSync(path.join(ziel, "public.mjs"), `// automatisch erzeugt von scripts/bundle-public.mjs\nexport const DATEIEN = ${JSON.stringify(dateien)};\n`);
console.log(`${Object.keys(dateien).length} Dateien gebündelt`);
