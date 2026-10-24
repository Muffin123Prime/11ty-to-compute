#!/usr/bin/env python3
"""Holt frei lizenzierte Fotos von Wikimedia Commons und schreibt die Bildnachweise.

  python3 tools/fetch_photos.py <marke> search "Suchbegriff" [...]     zeigt Treffer mit Lizenz
  python3 tools/fetch_photos.py <marke> get "File:Name.jpg" [...]        lädt nach assets/<marke>/ und ergänzt credits.json

Erlaubt sind nur Public Domain, CC0, CC BY und CC BY-SA. Der Nachweis (Autor, Lizenz) wird im Video eingeblendet.
"""
import json, os, re, sys, time, urllib.parse, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.normpath(os.path.join(HERE, ".."))
UA = {"User-Agent": "NachgehaktBot/1.0 (TikTok Wissenskanal; nachgehakt0@gmail.com)"}
OK_LIC = re.compile(r"^(Public domain|CC0|CC BY(-SA)? ?[0-9.]*( [a-z]{2})?|PD.*)$", re.I)

def api(params):
    url = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(params)
    for i in range(5):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60))
        except urllib.error.HTTPError as e:
            if e.code == 429: time.sleep(20 * (i + 1)); continue
            raise
    sys.exit("Commons antwortet nicht (429)")

def clean(s): return re.sub(r"<[^>]+>", "", s or "").strip()

def info(titles):
    r = api({"action": "query", "titles": "|".join(titles), "prop": "imageinfo", "iiprop": "url|extmetadata|size",
             "iiurlwidth": 1280, "format": "json"})
    out = []
    for p in r.get("query", {}).get("pages", {}).values():
        if "imageinfo" not in p: print("nicht gefunden:", p.get("title")); continue
        ii = p["imageinfo"][0]; em = ii.get("extmetadata", {})
        out.append({"title": p["title"], "url": ii.get("thumburl") or ii["url"], "page": ii["descriptionurl"],
                    "w": ii["width"], "h": ii["height"], "license": clean(em.get("LicenseShortName", {}).get("value", "?")),
                    "author": re.sub(r"(Unknown author)+", "unbekannt", clean(em.get("Artist", {}).get("value", "unbekannt"))).replace("unbekannt – ", "").strip()[:40]})
    return out

def main():
    marke, cmd, args = sys.argv[1], sys.argv[2], sys.argv[3:]
    if cmd == "search":
        for q in args:
            r = api({"action": "query", "generator": "search", "gsrsearch": f"filetype:bitmap {q}", "gsrnamespace": 6,
                     "gsrlimit": 10, "prop": "imageinfo", "iiprop": "url|extmetadata|size", "format": "json"})
            print("===", q)
            for p in r.get("query", {}).get("pages", {}).values():
                ii = p["imageinfo"][0]; em = ii.get("extmetadata", {})
                lic = clean(em.get("LicenseShortName", {}).get("value", "?"))
                print(f"  {'OK ' if OK_LIC.match(lic) else 'NEIN'} {p['title'][:72]:72s} {ii['width']}x{ii['height']} {lic:16s} {clean(em.get('Artist', {}).get('value', '?'))[:30]}")
            time.sleep(1.5)
        return
    d = os.path.join(ROOT, "assets", marke); os.makedirs(d, exist_ok=True)
    cp = os.path.join(d, "credits.json"); credits = json.load(open(cp)) if os.path.exists(cp) else {}
    for it in info(args):
        if not OK_LIC.match(it["license"]):
            print("ÜBERSPRUNGEN (Lizenz nicht frei):", it["title"], it["license"]); continue
        name = re.sub(r"[^a-z0-9]+", "_", it["title"][5:].rsplit(".", 1)[0].lower()).strip("_")[:60] + ".jpg"
        path = os.path.join(d, name)
        if not os.path.exists(path):
            for i in range(5):
                try:
                    data = urllib.request.urlopen(urllib.request.Request(it["url"], headers=UA), timeout=120).read(); break
                except urllib.error.HTTPError as e:
                    if e.code == 429: time.sleep(8 * (i + 1)); continue
                    raise
            else: print("ÜBERSPRUNGEN (429):", it["title"]); continue
            open(path, "wb").write(data); time.sleep(1.5)
        credits[name] = {"author": it["author"], "license": it["license"], "source": it["page"], "title": it["title"]}
        print(f"ok {name}  {it['w']}x{it['h']}  {it['license']}  {it['author']}")
    json.dump(credits, open(cp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("Nachweise:", cp)

if __name__ == "__main__": main()
