# TikTok-Automation: Stand und Übergabe

Ziel: täglich automatisch kurze, hochkante Erklärvideos (TikTok und Instagram Reels) im gemalten Illustrationsstil, deutsche männliche KI-Stimme, offenes Ende pro Folge, Wochenthema (aktuell: KI-Woche).

## Stand
- Pipeline: `build.sh episodes/<folge>.json` erzeugt Stimme, Zeiten, Ton, Bild und fertiges MP4. Ausgabe liegt in `out/` und ist git-ignoriert.
- Look: `render/illu_scenes.js` (gemalter Flat-Vector-Stil) wird mit `tools/build_illu.py` zu `render/anim_illu.html` zusammengesetzt. Fertig sind die Szenen hook, question, turing, test. Offen: eliza, chess, go im neuen Stil. `render/anim.html` ist der alte Neon-Look und wird nicht mehr gewünscht.
- Layout: TikTok-Sicherheitszone 1080x1920, rechts 120 px, links 60 px, oben 108 px, unten 320 px frei. Untertitel in Bildmitte unten bei y=1260. Mit `--guides` zeigt der Renderer den Rand.
- Stimme: Provider "edge" mit Giuseppe gefällt nicht. Neu eingebaut ist Provider "gemini" in `tools/make_voice.py`. Er ist noch ungetestet, weil der Schlüssel fehlt.
- Wortzeiten kommen aus faster-whisper (`tools/align.py`), unabhängig vom Sprecher.

## Nächste Schritte
1. Den Schlüssel `GEMINI_API_KEY` in den Einstellungen der Cloud-Umgebung hinterlegen, dann eine neue Sitzung starten.
2. Hörproben mit mehreren Gemini-Stimmen erzeugen, die zu "jung, spannend, leicht rau" passen, zum Beispiel Algenib, Fenrir, Puck, Charon, Orus, Alnilam. Stil-Satz in der Episoden-Datei unter `style`.
3. Gewählte Stimme eintragen (`provider`, `gemini_voice`, `style`), Folge neu bauen.
4. Restliche Szenen im gemalten Stil bauen, dann ganze Folge 1 rendern.
5. Später: Kanalname, Konten, Upload (Instagram Graph API, TikTok Content Posting API, TikTok zunächst nur als Entwurf), tägliche geplante Aufgabe.

## Hinweise
- Python-Umgebung mit edge-tts, numpy, scipy, faster-whisper: `python3 -m venv` und dann pip. Der Renderer nutzt Playwright mit Chromium (`PW_PATH` auf das Playwright-Paket setzen).
- Hinter dem Proxy muss `SSL_CERT_FILE=/root/.ccr/ca-bundle.crt` gesetzt sein.
- Quellen nur als Stil-Vorbild nutzen. Keine Bilder, Figuren oder Videos anderer Kanäle übernehmen.
