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

## Gelernte Regeln für Folgen (Rückmeldung des Auftraggebers)
- Stimme: Gemini "Fenrir", Stil "mitreißend, motivierend, überzeugend, nicht rau". Tempo `tempo` 1.04 bis 1.05, nicht schneller.
- Ton: sehr leiser Klangteppich, weiche Töne nur an Einblendungen, keine Schläge, nichts Lautes.
- Aufbau: Hook mit der Frage in den ersten Sekunden, Versprechen, Entwicklung, eigenes Ergebnis, dann offene Frage zum nächsten Teil. Leitlinien: kein künstlicher Cliffhanger, keine falschen Versprechen, kein Flackern.
- Keine Aufzählungen im Text ("Moment eins, Moment zwei, Moment drei"). Das fühlt sich länger an und die Konzentration sinkt. Stattdessen eine durchlaufende Geschichte erzählen, ohne Zählwörter.
- Kurz halten: Ziel deutlich unter 45 Sekunden, kurze Sätze, pro Szene wenig Text.
- Beispielvideo ki_01 war mit 58,8 s zu lang.
- API-Kontingent: gemini-3.8-flash-tts erlaubt im kostenlosen Tarif nur 10 Anfragen pro Tag. Stimme deshalb pro Szene erzeugen (`group_by_scene`).

## TikTok-Upload (Stand)
- Werkzeug: `upload/tiktok_upload.py`. Standard ist ein Testlauf ohne Netzwerk, `--send` sendet wirklich. Modus `draft` legt einen Entwurf ab (video.upload), `direct` postet (video.publish). Videos werden als KI-erzeugt gekennzeichnet.
- Ungeprüfte Apps posten nur privat. Das Konto muss dafür privat sein. Öffentlich geht es erst nach der TikTok-Prüfung.
- Umgebungsvariablen: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI`. Zugangstoken liegen in `.secrets/` (git-ignoriert) und gehen mit der Sitzung verloren.
- Webseiten für TikTok in `legal/`: Datenschutz, Nutzungsbedingungen, Rückleitung (zeigt den Code zum Kopieren). Betreiber: Nachgehakt, Kontakt: nachgehakt0@gmail.com (bewusst keine Wohnanschrift).
- Offen: Wo die Seiten gehostet werden (Repository ist privat, GitHub Pages braucht dann einen bezahlten Tarif). Wo die Token dauerhaft liegen, damit tägliche Läufe ohne Anmeldung funktionieren.
