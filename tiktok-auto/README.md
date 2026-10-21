# TikTok-Automation: Stand und Übergabe

## Tagesbetrieb (ab 21.10.)
- Die Beispielphase ist vorbei. Themen und Genres stehen in `themen.json`. Der Auftraggeber trägt Themen ein (oder nennt sie im Chat), Claude schreibt daraus Episoden.
- Status eines Themas: `offen` (Idee) -> `bereit` (Episodendatei geschrieben und mit Standbildern geprüft) -> `hochgeladen` (Entwurf bei TikTok, mit `publish_id` und Datum).
- `daily.sh` ist der Tageslauf: richtet die Python-Umgebung her, baut das erste Thema mit Status `bereit`, lädt es als Entwurf hoch, setzt den Status und sichert `themen.json` per git. `tools/daily.py --next` zeigt nur, was dran wäre. `--dry` baut ohne Upload. Rückgabe 3 heißt: keine Episode bereit, erst eine schreiben.
- Geplante Aufgabe "TikTok Tagesentwurf": täglich 11:41 Uhr (Europa/Berlin), neue Cloud-Sitzung, führt `daily.sh` aus und schreibt bei Bedarf vorher die nächste Episode. Nur Entwürfe, keine Direktposts.
- Voraussetzung in der Cloud-Umgebung: `TIKTOK_REFRESH_TOKEN` zusätzlich zu den anderen Variablen, weil `.secrets/` mit jeder Sitzung verloren geht. TikTok gibt beim Erneuern denselben Refresh-Token zurück (geprüft am 21.10.), er gilt ein Jahr.

## Episodenformat (für neue Folgen)
Datei `episodes/<id>.json`, Vorlage ist `episodes/ki_01.json`.
- Kopf: `id`, `series`, `part`, `title` (wird Bildunterschrift), `hashtags` (z.B. "#nachgehakt #wissen #weltraum", passend zum Genre), `label` (Kanalzeile oben rechts, z.B. aus dem Genre), `provider` "gemini", `gemini_voice` "Charon", `gemini_models` wie in ki_01, `style` wie in ki_01, `tempo` 1.12, `group_by_scene` true, `start_offset` 0.35.
- `sentences`: Liste mit `text`, `scene` (Szenen-Kennung), `accent` (betonte Wörter, genau wie im Text geschrieben), optional `event` (`stamp`, `cta`, `shock`), `gap_after`.
- `group_size` 2 statt `group_by_scene`: zwei Sätze pro Stimm-Anfrage, spart Kontingent und klingt aus einem Guss.
- `scenes`: Objekt Kennung -> Bildbeschreibung. Handgemalte Szenen (hook, question, turing, test, eliza, chess, go sowie für leben_01: helix, urerde, zellen, meteorit, einschlag, hypothese, offen) brauchen keinen Eintrag. Für ein hochwertiges Video lohnt sich eine eigene Szene pro Bildidee in `render/illu_scenes.js` (Vorbild: Block leben_01), generische Szenen sind die Rückfallebene. Alle anderen nutzen generische Szenen:
  - `{"visual":"year","text":"1969","pill":"vor 57 Jahren","bg":"nacht"}` große Zahl über der Erde (`"earth":false` ohne Erde)
  - `{"visual":"headline","lines":["WARUM VERGISST DU","NAMEN?"],"pill":"Teil 3"}` Karte mit 1 bis 3 Zeilen, letzte Zeile gelb
  - `{"visual":"chat","title":"ELIZA · 1966","messages":[["u","Text",0.5],["e","Antwort",1.6]],"pill":"..."}` Chatfenster, Zeiten in Sekunden ab Szenenstart, u rechts, e links
  - `{"visual":"versus","left":"MENSCH","right":"MASCHINE","title":"DUELL"}` zwei Figuren, VS in der Mitte
  - `{"visual":"stat","value":"86 %","label":"aller Erinnerungen sind nach einer Woche weg","pill":"Studie 1885"}` Zahl zählt hoch
  - `{"visual":"quote","text":"Zitat","author":"Name"}` Zitatkarte
  - `{"visual":"list","title":"DREI TRICKS","items":["...","...","..."],"step":1.1}` bis 4 Zeilen, erscheinen nacheinander
  - `{"visual":"question","text":"Können Maschinen denken?"}` Figur mit Gedankenblase
  - `bg`: violett, rot, blau, gruen, orange, nacht. Nebeneinanderliegende Szenen sollten verschiedene Hintergründe haben.
- Prüfen vor Status `bereit`: Dauer unter 40 s (`tools/make_voice.py` druckt sie), Standbilder mit `node render/render.mjs out/<id>/timeline.json out/<id>/stills --html render/anim_illu.html --stills 1,5,10,...` ansehen, kein Text über den Rand, Untertitel überdecken keine Pille.
- Texte prüfen: Fakten müssen stimmen (Jahreszahlen, Namen, Zahlen), keine erfundenen Zitate. Lieber eine Zahl weglassen als raten.

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
- Stimme (Stand 21.10., zweite Runde): Gemini "Charon" über `gemini-3.8-flash-tts`, Stil "Trailer-Sprecher, tief, klar, zügig, dramatisch, nicht rau". Tempo `tempo` 1.12. Fenrir wurde als "komisch" empfunden: Grundton lag bei ca. 219 Hz, Charon liegt bei ca. 120 bis 135 Hz. Hörproben anderer Stimmen (Puck, Orus, Iapetus, Sadaltager, Enceladus) wurden gemacht, Charon hatte die stärkste Tonhöhen- und Lautstärkevariation bei tiefer Lage.
- Gemini 3.8 TTS hat eine **neue Schnittstelle** (`/v1beta/interactions`): Der Text ist wörtliches Transkript, die Stil-Anweisung steht getrennt in `speech_metadata.style`. Schickt man den Stil wie früher im Text mit, liest das Modell ihn laut vor. `tools/make_voice.py` unterscheidet das nach Modellnamen. Kontingente pro Modell getrennt, je ca. 10 Anfragen pro Tag.
- Ton (Stand 21.10., zweite Runde): Rückmeldung zur ersten Fassung war "todesuninteressant, nach 10 Sekunden keine Konzentration mehr". Deshalb jetzt: leiser Puls im Herzschlag-Tempo (104 BPM), der zum Ende dichter wird, Whoosh plus weicher Bass an jedem Szenenwechsel, kleiner Luftzug an jedem Satzanfang, leiser Akzentton auf betonten Wörtern, Riser vor der Schlusswendung, dissonanter Schlag beim Ereignis `shock`. Weiterhin keine harten, lauten Schläge.
- Aufbau: Hook mit der Frage in den ersten Sekunden, Versprechen, Entwicklung, eigenes Ergebnis, dann offene Frage zum nächsten Teil. Leitlinien: kein künstlicher Cliffhanger, keine falschen Versprechen, kein Flackern.
- Keine Aufzählungen im Text ("Moment eins, Moment zwei, Moment drei"). Das fühlt sich länger an und die Konzentration sinkt. Stattdessen eine durchlaufende Geschichte erzählen, ohne Zählwörter.
- Kurz halten: Ziel deutlich unter 45 Sekunden, kurze Sätze, pro Szene wenig Text.
- Beispielvideo ki_01 war mit 58,8 s zu lang. Die zweite Fassung hat 34,5 s und 71 Wörter.

## Recherche: Was Kurzvideos spannend hält (21.10.)
Quellen sind Ratgeber von Werkzeuganbietern und Agenturen, keine kontrollierten Studien. Die Zahlen darin widersprechen sich teils, die Richtung ist aber einheitlich.
- Hook: Die ersten 3 Sekunden entscheiden über die Verbreitung. Eine starke Behauptung, ein Widerspruch oder eine offene Frage, kein Vorspann, kein Logo, keine Vorstellung ("Ich zeige dir drei Momente" ist ein Vorspann). Umgesetzt: "1966. Ein Computer bringt Menschen zum Weinen, ohne ein einziges Wort zu verstehen."
- Offene Schleife: Frage früh stellen, Spannung halten, am Ende auflösen oder bewusst offen lassen. Keine generischen "Bleib bis zum Ende"-Sätze.
- Tempo: Ein Bildwechsel alle 2 bis 4 Sekunden (Schnitt, Zoom, Einblendung, Ton). Umgesetzt im Renderer: Punch-in bei jedem Satzanfang, langsame Drift innerhalb der Szene, kleiner Kick auf betonten Wörtern, Szenenwechsel alle 3 bis 7 Sekunden.
- Länge: 15 bis 30 s ist der Normalfall, 45 bis 60 s nur bei sehr starkem Hook.
- Untertitel: Große fette Wörter, 2 bis 3 Wörter gleichzeitig, Schlüsselwort farbig (Gelb), Wort-für-Wort-Aufbau, in der Bildmitte, nicht am unteren Rand. Zu viel Animation schadet. Das entspricht dem bestehenden Stil, die Blöcke wurden auf maximal 16 Zeichen verkürzt, damit keine dritte Zeile entsteht.
- Ton: Belege für einzelne Effekte fehlen, Praktiker setzen einen kurzen Klang auf jeden Schnitt und auf Einblendungen als Energiesignal. Viele schauen ohne Ton, deshalb muss der Hook auch nur mit Bild und Text funktionieren.
- Stimme: Für Gemini TTS gilt, Stil in natürlicher Sprache beschreiben (Szene, Tempo, Haltung) statt eines einzelnen Adjektivs, Pausen über Satzzeichen und Auslassungspunkte, Tags in spitzen Klammern nur für kurze Ereignisse.
Quellen: teleprompter.com (3-Sekunden-Regel), stackmatix.com (Hook-Typen, Länge), influenceflow.io (Schnitte alle 2 bis 4 s), clipspeed.ai (Untertitel-Stile), socialk.it (offene Schleife), ai.google.dev/gemini-api/docs/speech-generation (Stimmen, Schnittstelle), livekit.com (Stil-Prompting).
- API-Kontingent: gemini-3.8-flash-tts erlaubt im kostenlosen Tarif nur 10 Anfragen pro Tag. Stimme deshalb pro Szene erzeugen (`group_by_scene`).

## TikTok-Upload (Stand)
- Werkzeug: `upload/tiktok_upload.py`. Standard ist ein Testlauf ohne Netzwerk, `--send` sendet wirklich. Modus `draft` legt einen Entwurf ab (video.upload), `direct` postet (video.publish). Videos werden als KI-erzeugt gekennzeichnet.
- Ungeprüfte Apps posten nur privat. Das Konto muss dafür privat sein. Öffentlich geht es erst nach der TikTok-Prüfung.
- Umgebungsvariablen: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI`. Zugangstoken liegen in `.secrets/` (git-ignoriert) und gehen mit der Sitzung verloren.
- Webseiten für TikTok in `legal/`: Datenschutz, Nutzungsbedingungen, Rückleitung (zeigt den Code zum Kopieren). Betreiber: Nachgehakt, Kontakt: nachgehakt0@gmail.com (bewusst keine Wohnanschrift).
- Offen: Wo die Seiten gehostet werden (Repository ist privat, GitHub Pages braucht dann einen bezahlten Tarif). Wo die Token dauerhaft liegen, damit tägliche Läufe ohne Anmeldung funktionieren.

## Stand TikTok-Einrichtung (21.10.)
- Konto Nachgehakt, Profilbild in `brand/`. Entwickler-App "Nachgehakt" angelegt, Entwurf in Production gespeichert.
- Seiten liegen auf https://nachgehakt.netlify.app (Datenschutz, Nutzungsbedingungen, callback.html, Bestätigungsdatei). Adresse bei TikTok als bestätigt eingetragen. Änderungen: ZIP bei Netlify unter Deploys hochladen.
- In Production liegt ein **Platzhaltervideo** (ki_01.mp4) nur zum Speichern. Vor dem Einreichen ersetzen durch ein echtes Demovideo, das den Ablauf in der Sandbox zeigt. Nicht einreichen, bevor das ersetzt ist.
- Sandbox "nachgehakt-test" angelegt. Sie hat **eigene Zugangsdaten** (Client key beginnt mit `sb`). Noch zu tun: Products, Scopes, Target users prüfen, Apply changes.
- Danach in der Cloud-Umgebung "Ki" die Variablen `TIKTOK_CLIENT_KEY` und `TIKTOK_CLIENT_SECRET` auf die **Sandbox-Werte** setzen und `TIKTOK_REDIRECT_URI=https://nachgehakt.netlify.app/callback.html` ergänzen. Dann neue Sitzung starten (Zweig tiktok-auto-pipeline).
- Dann: `python3 upload/tiktok_upload.py auth-url`, Anmeldung im Browser, Code von callback.html kopieren, `exchange <code>`, danach Testupload mit `--send` als Entwurf.
- Ungeprüfte Apps posten nur privat, das Konto muss privat sein.
- **Upload geprüft (21.10.):** Anmeldung über callback.html und `exchange` funktioniert, Entwurf kam im TikTok-Posteingang an. Der Status bleibt lange auf PROCESSING_UPLOAD, auch wenn der Entwurf längst da ist. Nicht darauf warten.
- Ereignisse in der Episodendatei: `stamp` (Stempel), `cta` (Schlusswendung mit Riser), `shock` (roter Blitz, Fensterwackeln, dissonanter Ton). Weitere Namen landen als Ereignis am Satzende in `timeline.json`.
