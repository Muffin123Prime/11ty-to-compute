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
- **Englischunterricht**: Erkennungssprache in den Einstellungen auf `en-GB` stellen.

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

Claude wird über das offizielle SDK (`@anthropic-ai/sdk`) aufgerufen, Modell
`claude-opus-5-5` (änderbar über die Variable `MODELL`), mit strukturierter
JSON-Ausgabe und eingeschaltetem Server-Fallback bei Ablehnungen.

## Ins Netz bringen, Weg 1: automatisch über GitHub

Der Workflow `.github/workflows/unterricht.yml` veröffentlicht die App bei jedem
Push in `unterricht/` auf Cloudflare. Dafür einmalig drei Secrets im Repo anlegen
(Settings → Secrets and variables → Actions → New repository secret):

| Secret | Woher |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → Profil → API Tokens → Vorlage „Edit Cloudflare Workers“ |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `APP_KEY` | selbst ausdenken, das Passwort für die App |

Danach den Workflow unter Actions → „Unterrichts-App deployen“ einmal von Hand
starten oder einfach etwas pushen. Die Adresse steht am Ende des Laufs
(`https://unterricht.<name>.workers.dev`).

## Ins Netz bringen, Weg 2: von Hand (Cloudflare Workers, kostenlos)

Du brauchst ein Cloudflare-Konto und einen Anthropic-Schlüssel (console.anthropic.com).

```bash
cd unterricht
npm install
npx wrangler login                          # einmalig, öffnet den Browser
npx wrangler secret put ANTHROPIC_API_KEY   # den Anthropic-Schlüssel eingeben
npx wrangler secret put APP_KEY             # ein selbst gewähltes Passwort für die App
npm run deploy
```

Danach steht die Adresse im Terminal, etwa `https://unterricht.<name>.workers.dev`.
Auf dem Handy in **Safari** (iPhone/iPad) oder **Chrome** (Android) öffnen,
unter Einstellungen den App-Schlüssel eintragen, „Verbindung prüfen“, dann
„Zum Home-Bildschirm“ hinzufügen. Beim ersten Start fragt der Browser nach dem Mikrofon.

Ohne `APP_KEY` kann jeder, der die Adresse kennt, auf deine Kosten Claude benutzen.
Also setzen.

## Lokal ausprobieren

```bash
cd unterricht
npm install
npm run mock                      # ohne Schlüssel, mit Attrappen-Antworten
ANTHROPIC_API_KEY=sk-... npm run dev   # echt
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
- **Kosten**: Pro erkannter Frage geht ein Aufruf mit etwa zwei Minuten Text an
  Claude, das sind grob ein bis zwei Cent, mit Web-Suche etwas mehr. Die laufende
  Zusammenfassung alle vier Minuten und die Endzusammenfassung einer 45-Minuten-Stunde
  liegen zusammen bei etwa 20 bis 40 Cent (das Transkript wird zwischengespeichert,
  deshalb nicht mehr). Ein Vorfilter in der App sorgt dafür, dass nicht
  jeder Satz, sondern nur fragend klingende Sätze geprüft werden, höchstens alle
  zwölf Sekunden.
- **Daten**: Alle Stunden liegen nur im Browser-Speicher des Geräts (IndexedDB).
  Löscht man die Website-Daten, sind sie weg. Wichtige Stunden als Text teilen.
- **Antworten prüfen**: Die Erkennung verhört sich, und Claude antwortet auf das,
  was im Text steht. Vor dem Melden einmal lesen.

## Einstellungen auf dem Worker

| Name | Wo | Bedeutung |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Secret | Pflicht. Schlüssel von console.anthropic.com |
| `APP_KEY` | Secret | Passwort, das die App im Header `x-app-key` mitschickt |
| `MODELL` | wrangler.toml `[vars]` | Claude-Modell, leer = `claude-opus-5-5` |
| `ALLOWED_ORIGINS` | wrangler.toml `[vars]` | Seiten-Origins, die die API nutzen dürfen; leer = alle |
