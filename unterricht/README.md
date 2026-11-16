# Unterricht: zuhören, mitschreiben, antworten

Eine Web-App fürs Handy oder iPad. Sie hört im Unterricht über das Mikrofon mit,
schreibt alles als Text auf das Gerät, speichert jede Stunde nach Fach und Datum,
fasst sie am Ende zusammen und schlägt bei Fragen der Lehrkraft eine Antwort vor,
die man direkt vorlesen kann. Fragt die Lehrkraft, wie etwas aussieht
(„Wie wird H₂O dargestellt?“), kommt ein Bild dazu.

Es gibt keine Tonaufnahme: Die Spracherkennung des Browsers macht aus dem Gehörten
sofort Text, nur dieser Text wird gespeichert. Zum eigenen Server gehen nur die
letzten Minuten Text, wenn eine Frage erkannt wird, und das ganze Transkript
einmal für die Zusammenfassung. Der Server ruft Claude (Anthropic) auf.

> **Wichtig, bevor du es benutzt:** Unterricht ohne Einverständnis mitzuschneiden
> ist in Deutschland nicht erlaubt (§ 201 StGB, dazu die Schulordnung). Sprich mit
> der Lehrkraft und hol dir ihr Okay. Die App zeigt diesen Hinweis beim ersten Start.

## Was die App kann

- **Schwarz-weiß, ein roter Punkt**: Fach antippen, auf den leuchtenden Punkt tippen,
  die App hört zu. Oben läuft der Live-Text mit, links sammeln sich Fragen und
  Aufgaben der Lehrkraft, in der Mitte stehen Antworten und Bilder, rechts eine
  Zusammenfassung der bisherigen Stunde (alle vier Minuten neu, oder per Knopf).
  Auf dem Handy liegen die drei Spalten untereinander, auf dem iPad nebeneinander.
- **Mitschrift** mit Zeitmarken, der Bildschirm bleibt an (Wake Lock, wo der Browser es erlaubt).
- **Fragen erkennen**: Sätze wie „Wer kann mir sagen …“, „Wie sieht … aus“,
  „Nennt mir drei …“ werden im Text markiert und (wenn eingeschaltet) an Claude
  geschickt. Claude prüft, ob es wirklich eine Frage an die Klasse war, und schreibt
  eine Antwort in ein bis drei Sätzen, so wie ein guter Schüler sie sagen würde.
  Dazu bei Bedarf ein Satz Hintergrund für Rückfragen.
- **Jetzt antworten**: Knopf, wenn die automatische Erkennung die Frage
  verpasst hat. Oder die Frage eintippen.
- **Web-Suche**: Claude darf im Internet nachschlagen, wenn es sich bei einer Zahl,
  einem Namen oder einem aktuellen Ereignis nicht sicher ist (in den Einstellungen
  abschaltbar, weil jede Suche ein paar Sekunden kostet).
- **Bilder**: Moleküle als Strukturformel aus PubChem, Dinge mit gutem
  Wikipedia-Hauptbild aus der deutschen Wikipedia, einfache Skizzen (Lewis-Formel,
  Kräfte, Winkel, Aufbau) zeichnet Claude selbst als SVG.
- **Zusammenfassung** am Ende: Titel, Thema, Fließtext, Kernpunkte, Fragen der
  Lehrkraft mit Antworten, Hausaufgaben und Termine, Begriffe.
- **Stunden-Archiv**: nach Fach filtern, eigene Notizen, Mitschrift nachlesen,
  als Textdatei teilen oder löschen.
- **Frag deine Stunden**: „Worum ging es letzte Woche in Bio?“ über die
  gespeicherten Zusammenfassungen (bei bis zu drei Stunden auch mit Mitschrift).
- **Fremdsprachen mit Live-Übersetzung**: Beim Start „Lehrkraft spricht: Englisch,
  Französisch, Spanisch, Italienisch, Türkisch, Russisch“ wählen (bei Englisch,
  Französisch, Spanisch wird es aus dem Fachnamen vorgeschlagen). Die Mitschrift läuft
  dann in dieser Sprache, darunter steht ein, zwei Sekunden später die deutsche
  Übersetzung. Fragen werden auch auf Englisch, Französisch und Spanisch erkannt,
  die Antwort kommt in der Sprache der Lehrkraft, die Erklärung auf Deutsch.

## Aufbau

```
unterricht/
├── public/          die App (HTML, CSS, JS, ohne Build-Schritt)
├── lib/claude.mjs   die Claude-Aufrufe: Antwort, Zusammenfassung, Nachfrage
├── lib/bilder.mjs   Bildauflösung (PubChem, Wikipedia, SVG-Bereinigung)
├── lib/api.mjs      die API-Routen, für Worker und lokalen Server gleich
├── lib/attrappe.mjs Attrappen-Client für Tests und `--mock`
├── worker.mjs       Cloudflare Worker (App + API unter einer Adresse)
├── server.mjs       lokaler Server zum Ausprobieren
└── test/e2e.mjs     Durchlauf der Oberfläche im Browser (Playwright)
```

Die KI ist austauschbar (`lib/anbieter.mjs`). Standard ist **Cloudflare Workers AI**:
läuft im selben Worker, braucht keinen Schlüssel und ist bis 10.000 Neuronen am Tag
kostenlos, das reicht für etwa fünf bis acht Unterrichtsstunden täglich (Antworten mit
Llama 3.3 70B, Übersetzung und Zwischenstand mit dem kleineren Llama 3.1 8B). Sind
weitere Schlüssel hinterlegt, bilden sie eine Kette: Ist das Tageskontingent eines
Anbieters aufgebraucht, übernimmt der nächste.

| Anbieter | Kosten | Secret | Hinweis |
| --- | --- | --- | --- |
| Cloudflare Workers AI | kostenlos, 10.000 Neuronen/Tag | keins | Standard, nichts einzurichten |
| Groq | kostenlos, etwa 1.000 Anfragen/Tag | `GROQ_API_KEY` | sehr schnell, Schlüssel unter console.groq.com/keys |
| Google Gemini | kostenlos, aber nur rund 20 bis 500 Anfragen/Tag je Modell | `GEMINI_API_KEY` | reicht nur für wenige Antworten; Google nutzt Eingaben im Gratis-Plan zum Training |
| Claude (Anthropic) | kostet Geld | `ANTHROPIC_API_KEY` | beste Antworten, einzige mit Web-Suche |

Mit `KI_ANBIETER` in `wrangler.toml` legt man einen Anbieter fest, mit `KI_MODELL` und
`KI_MODELL_SCHNELL` die Modelle.

## Ins Netz bringen, Weg 1: automatisch über GitHub

Der Workflow `.github/workflows/unterricht.yml` veröffentlicht die App bei jedem
Push in `unterricht/` auf Cloudflare. Dafür einmalig zwei Secrets im Repo anlegen
(Settings → Secrets and variables → Actions → New repository secret):

| Secret | Woher |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → Profil → API Tokens → Vorlage „Edit Cloudflare Workers“ |
| `APP_KEY` | selbst ausdenken, das Passwort für die App |

Optional, nur wenn man einen anderen Anbieter will: `GROQ_API_KEY`, `GEMINI_API_KEY`,
`ANTHROPIC_API_KEY`. Nicht hinterlegte Secrets überspringt der Workflow.

Danach den Workflow unter Actions → „Unterrichts-App deployen“ einmal von Hand
starten oder einfach etwas pushen. Die Adresse steht am Ende des Laufs
(`https://unterricht.<name>.workers.dev`).

## Ins Netz bringen, Weg 2: von Hand (Cloudflare Workers, kostenlos)

Du brauchst nur ein Cloudflare-Konto.

```bash
cd unterricht
npm install
npx wrangler login                          # einmalig, öffnet den Browser
npx wrangler secret put APP_KEY             # ein selbst gewähltes Passwort für die App
npm run deploy
```

Danach steht die Adresse im Terminal, etwa `https://unterricht.<name>.workers.dev`.
Auf dem Handy in **Safari** (iPhone/iPad) oder **Chrome** (Android) öffnen,
unter Einstellungen den App-Schlüssel eintragen, „Verbindung prüfen“, dann
„Zum Home-Bildschirm“ hinzufügen. Beim ersten Start fragt der Browser nach dem Mikrofon.

Ohne `APP_KEY` kann jeder, der die Adresse kennt, dein Tageskontingent verbrauchen.
Also setzen.

## Lokal ausprobieren

```bash
cd unterricht
npm install
npm run mock                      # ohne Schlüssel, mit Attrappen-Antworten
GROQ_API_KEY=gsk_... npm run dev  # echt (oder GEMINI_API_KEY / ANTHROPIC_API_KEY)
npm run preview                   # wrangler dev: wie auf Cloudflare, mit Workers AI
```

Dann http://localhost:8787 öffnen. Chrome am Computer kann zuhören (die Erkennung
läuft über Google); Firefox hat keine Spracherkennung, dort kann man die
Mitschrift nur tippen. Auf dem Handy erreicht man den lokalen Server nicht ohne
Weiteres, dafür ist der Worker da.

Tests:

```bash
npm test                 # Unit-Tests der API mit Attrappen-Client
npm run mock &           # und in einem zweiten Terminal:
node test/e2e.mjs        # Durchlauf im Browser (braucht Playwright)
```

## Was man wissen sollte

- **Spracherkennung**: Safari und Chrome schicken den Ton an Apple bzw. Google und
  beenden die Erkennung nach einer Weile von selbst; die App startet sie sofort
  wieder. Das klappt in einem Klassenraum mit einer Lehrkraft, die deutlich spricht,
  ordentlich; bei Gemurmel und Nebengesprächen wird es lückenhaft. Das Handy sollte
  mit dem Mikrofon Richtung Lehrkraft auf dem Tisch liegen.
- **Bildschirm**: Die Erkennung läuft nur, solange die Seite im Vordergrund ist.
  Die App hält den Bildschirm wach, Display nicht sperren.
- **Kosten**: Mit Workers AI null. Das Tageskontingent reicht für etwa fünf bis acht
  Stunden pro Tag (Fremdsprachenstunden mit Übersetzung verbrauchen etwa doppelt so viel
  wie deutsche). Ist es aufgebraucht, sagt die App das; ab Mitternacht UTC geht es weiter.
  Ein kostenloser Groq-Schlüssel als zweiter Anbieter fängt das ab.
- **Daten**: Alle Stunden liegen nur im Browser-Speicher des Geräts (IndexedDB).
  Löscht man die Website-Daten, sind sie weg. Wichtige Stunden als Text teilen.
- **Antworten prüfen**: Die Erkennung verhört sich, und Claude antwortet auf das,
  was im Text steht. Vor dem Melden einmal lesen.

## Einstellungen auf dem Worker

| Name | Wo | Bedeutung |
| --- | --- | --- |
| `APP_KEY` | Secret | Passwort, das die App im Header `x-app-key` mitschickt |
| `GROQ_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | Secret | optional, weitere Anbieter |
| `KI_ANBIETER` | wrangler.toml `[vars]` | `cloudflare` (Standard), `groq`, `gemini`, `anthropic`; leer = Kette aller vorhandenen |
| `KI_MODELL`, `KI_MODELL_SCHNELL` | wrangler.toml `[vars]` | Modelle, leer = Standard des Anbieters |
| `ALLOWED_ORIGINS` | wrangler.toml `[vars]` | Seiten-Origins, die die API nutzen dürfen; leer = alle |
