// Löst Bildwünsche von Claude in eine URL auf. Zwei freie Quellen ohne
// Schlüssel: PubChem (2D-Strukturbilder nach englischem Stoffnamen) und die
// deutsche Wikipedia (Hauptbild eines Artikels). Selbst gezeichnete SVGs
// gehen unverändert an den Browser, der sie als Bild (nicht als Markup)
// einbettet.

const UA = "UnterrichtApp/0.1 (private Lern-App; kein Massenabruf)";

export function pubchemUrl(name) {
  return `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(name.trim())}/PNG?image_size=large`;
}

export async function wikipediaBild(titel, fetchFn = fetch) {
  const url = `https://de.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titel.trim().replace(/ /g, "_"))}`;
  const r = await fetchFn(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!r.ok) return null;
  const daten = await r.json();
  const quelle = daten.originalimage?.source || daten.thumbnail?.source;
  if (!quelle) return null;
  return {
    url: quelle,
    seite: daten.content_urls?.desktop?.page || `https://de.wikipedia.org/wiki/${encodeURIComponent(titel)}`,
    titel: daten.title || titel,
  };
}

// Entfernt alles aus einem SVG, was Code ausführen oder nachladen könnte.
export function svgBereinigen(svg) {
  if (typeof svg !== "string") return null;
  let s = svg.trim();
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return null;
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(href|xlink:href)\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, "")
    .replace(/<(image|use|iframe|embed|object|link|style)\b[^>]*\/?>/gi, "")
    .replace(/<\/(image|use|iframe|embed|object|link|style)>/gi, "");
  if (!/xmlns=/.test(s)) s = s.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return s.length > 20000 ? null : s;
}

/**
 * @param bild { typ: "molekuel"|"wikipedia"|"svg", wert, beschreibung }
 * @returns { typ, beschreibung, url?, svg?, quelle? } oder null
 */
export async function bildAufloesen(bild, fetchFn = fetch) {
  if (!bild || !bild.typ || bild.typ === "keins" || !bild.wert) return null;
  const beschreibung = bild.beschreibung || "";
  try {
    if (bild.typ === "molekuel") {
      return { typ: "molekuel", beschreibung, url: pubchemUrl(bild.wert), quelle: "PubChem", name: bild.wert };
    }
    if (bild.typ === "wikipedia") {
      const w = await wikipediaBild(bild.wert, fetchFn);
      if (!w) return null;
      return { typ: "wikipedia", beschreibung, url: w.url, quelle: `Wikipedia: ${w.titel}`, seite: w.seite };
    }
    if (bild.typ === "svg") {
      const svg = svgBereinigen(bild.wert);
      if (!svg) return null;
      return { typ: "svg", beschreibung, svg };
    }
  } catch {
    return null;
  }
  return null;
}
