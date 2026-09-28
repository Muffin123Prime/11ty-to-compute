# Antwort-Bausteine – interaktive Antworten im Chat

Verbindlicher Bauplan (28.09.2026) für alles, was innerhalb einer KI-Antwort
passiert. Er setzt den Wunsch des Nutzers um: „Die KI soll die bestmögliche
Antwortform selbst auswählen … wie ein intelligenter Chat, der seine eigene
Benutzeroberfläche während der Unterhaltung passend zur Aufgabe aufbaut.“
Außerhalb des Chats ändert dieser Plan nichts.

## 1. Grundentscheidung: Bausteine als Codeblock `ui` mit JSON

Die KI schreibt einen interaktiven Baustein als eigenen Codeblock mit der
Sprache `ui`. Der Inhalt ist genau ein JSON-Objekt mit dem Feld `typ`:

    ```ui
    {"typ":"auswahl","frage":"Wie möchtest du die Erklärung?","optionen":["Einfach","Normal","Detailliert"]}
    ```

Warum so und nicht als Werkzeug (tool_use):

- **Keine zweite Anfrage.** Ein Werkzeug hält den Zug an und braucht einen
  weiteren Aufruf. Bei Gemini kostenlos (10–15 Anfragen je Minute) ist das
  spürbar, bei Claude kostet es Geld.
- **Gleich für beide Anbieter.** Text ist Text; Claude und Gemini schreiben
  dieselbe Form.
- **Streamt mit.** Solange der Block nicht geschlossen ist, zeigt der Chat
  einen ruhigen Platzhalter („Wird aufgebaut …“), nie rohes JSON.
- **Umwandelbar.** „Als Tabelle“ oder „Nur Text“ erzeugt einfach eine neue
  Fassung desselben Textes.
- **Ausfallsicher.** Ungültiges JSON oder ein unbekannter `typ` wird als
  normaler Codeblock gezeigt, darüber ein kleiner Hinweis „Konnte nicht
  angezeigt werden“. Nichts stürzt ab, nichts verschwindet.

Die Rückfrage **mitten im Zug** bleibt das Werkzeug `rueckfrage` (die KI
braucht die Antwort, um weiterzuarbeiten). Bausteine sind für das, was
**in und nach** der Antwort passiert. Beide zeichnet dieselbe Oberfläche
(eine Auswahl-Komponente), es gibt keine zweite.

Sicherheit: Alle Texte aus dem JSON kommen als Text in den DOM (nie
innerHTML). Felder `inhalt` sind Markdown und laufen durch `renderMarkdown`.
Links laufen durch `safeUrl`. HTML und Code laufen nur im Sandkasten (7.).

## 2. Die Bausteine (Katalog)

Gemeinsam: `typ` (Pflicht), `id` (optional, fester Schlüssel für den
gespeicherten Zustand; sonst die laufende Nummer des Blocks in der Fassung).
Kurze Textfelder erlauben Inline-Markdown (fett, kursiv, Code, Links).
Felder namens `inhalt` erlauben volles Markdown und darin höchstens eine
weitere Ebene `ui`-Blöcke (nur in `tabs`, `abschnitte`, `schritte`, `mehr`).

| typ | Felder | Verhalten |
|---|---|---|
| `auswahl` | `frage?`, `optionen: [text \| {text, beschreibung?, senden?}]`, `mehrfach?`, `eigene?` (Standard true), `stil?`: `knoepfe` \| `liste` \| `umfrage` \| `bestaetigung`, `knopf?`, `senden?` (Vorlage mit `{auswahl}`) | Einfach: Tippen sendet sofort als neue Nachricht. Mehrfach: Kästchen + [Weiter]. Mehr als 6 Optionen: Aufklappliste. `umfrage`: [Abstimmen], danach Ergebnisbalken. `bestaetigung`: zwei Knöpfe, der zweite ist der Hauptknopf. Danach bleibt die Karte stehen und zeigt die Wahl. |
| `aktionen` | `frage?`, `aktionen: [text \| {text, symbol?, senden?}]` (höchstens 4) | Knopfreihe; Tippen sendet `senden ?? text`. Für Folgeschritte, Ja/Nein-Angebote, Vorschläge. |
| `formular` | `titel?`, `felder: [{name, label, art, optionen?, wert?, min?, max?, schritt?, pflicht?, platzhalter?}]`, `knopf?` | `art`: `text`, `textfeld`, `zahl`, `datum`, `uhrzeit`, `auswahl` (Aufklappliste), `mehrfach`, `schalter`, `regler`. Absenden schickt eine lesbare Nachricht „**Formular: Titel** – Feld: Wert …“. Pflichtfelder werden vorher geprüft. |
| `regler` | `titel?`, `regler: [{name, label, links, rechts, wert 0–100}]`, `anwenden?`: `stil` \| `senden` | `stil` (Standard bei den Namen `laenge`, `fachlich`, `kreativ`): setzt den Antwortstil des Chats und erzeugt die letzte Antwort mit diesem Stil neu (neue Fassung). `senden`: schickt die Werte als Nachricht. Übernommen wird beim Loslassen, entprellt. |
| `karten` | `layout?`: `raster` \| `karussell`, `karten: [{titel, symbol?, text?, zeilen?: [text], aktion?: {text, senden? \| link?}}]` | Karten; mit `aktion` ganz antippbar. `symbol` ist ein Name aus der festen Liste (buch, uhr, stern, ziel, idee, datei, kalender, ort, person, haken, blitz, herz, lernen, code, bild, musik, geld, frage) oder ein einzelnes Emoji. |
| `diagramm` | `art`: `balken` \| `saeulen` \| `linie` \| `flaeche` \| `kreis` \| `ring` \| `vergleich` \| `fortschritt`, `titel?`, `einheit?`, `x?: [text]`, `reihen?: [{name, werte: [zahl]}]`, `teile?: [{name, wert}]`, `wert?`, `ziel?`, `quelle?` | SVG, hell und dunkel. Antippen/Überfahren zeigt den Wert, die Legende blendet Reihen aus, [Als Tabelle] zeigt die Zahlen. Zeitverläufe sind `linie` mit Datumsbeschriftungen. |
| `checkliste` | `titel?`, `punkte: [text \| {text, erledigt?}]`, `sortierbar?` | Echte Kästchen, Fortschritt „3 von 5“ mit Balken, gespeichert. |
| `schritte` | `titel?`, `schritte: [{titel, inhalt}]` | Ein Schritt sichtbar, [← Zurück] [Weiter →], Punkte, „Schritt 2 von 5“, je Schritt „Erledigt“. |
| `abschnitte` | `abschnitte: [{titel, inhalt, offen?}]` | Aufklappbare Bereiche; der erste ist offen, wenn keiner `offen` sagt. |
| `mehr` | `inhalt`, `knopf?` | Zeigt erst nichts als [Mehr anzeigen]; dann den Inhalt und [Weniger]. |
| `tabs` | `tabs: [{titel, inhalt}]` | Reiter innerhalb der Antwort. |
| `liste` | `titel?`, `punkte: [text]`, `sortierbar` (true), `knopf?` | Reihenfolge per Ziehen (Maus, Finger) und Tastatur (Alt+↑/↓); [Reihenfolge übernehmen] schickt sie. |
| `quiz` | `titel?`, `fragen: [{frage, optionen: [text], richtig: zahl \| [zahl], erklaerung?}]`, `einzeln?` (Standard true) | A/B/C/D, danach ✓ Richtig / ✗ Falsch und die Erklärung, am Ende Punkte, [Nochmal], [Frage erklären] (sendet). |
| `lernkarten` | `titel?`, `karten: [{vorne, hinten}]` | Umdrehen, [Gewusst] / [Nochmal], Fortschritt, Mischen. |
| `lueckentext` | `titel?`, `text` mit `{{Lösung}}` oder `{{Lösung\|Alternative}}` | Eingabefelder, [Prüfen] (Groß/Klein und Umlaute egal), [Lösung zeigen]. |
| `zuordnung` | `titel?`, `paare: [{links, rechts}]` | Rechte Seite gemischt; links antippen, dann rechts (oder ziehen); [Prüfen]. |
| `timer` | `titel?`, `dauer`: `"mm:ss"` \| `"hh:mm:ss"` \| Sekunden | [Start] [Pause] [Fortsetzen] [Beenden]; läuft über Neuladen weiter; am Ende ein leiser Ton und, wenn erlaubt, eine Mitteilung. |
| `countdown` | `titel?`, `ziel`: `"YYYY-MM-DDTHH:MM"` | Läuft selbst (Tage, Stunden, Minuten, Sekunden); am Ziel „Jetzt“. |
| `termin` | `titel`, `start`, `ende?`, `ort?`, `notiz?` (Zeiten wie im Kalender: Wandzeit ohne Zone) | Terminkarte mit [Zum Kalender hinzufügen] (legt ihn wirklich an), danach „Eingetragen“ + [Öffnen] [Rückgängig]; [.ics]. Nur ein Vorschlag – wenn der Nutzer ausdrücklich eintragen lässt, benutzt die KI `termin_anlegen`. |
| `datei` | `name` (mit Endung), `inhalt` (Text), `art?` | Dateikarte: [Öffnen] (Vorschau: Markdown gesetzt, CSV als Tabelle, HTML/SVG im Sandkasten, Code hervorgehoben), [Herunterladen], [Bearbeiten] (neue Fassung), [Teilen] nur wenn das Gerät es kann. |
| `vorschau` | `art`: `html` \| `svg` \| `dokument` \| `folien`, `titel?`, `inhalt` | HTML/SVG im Sandkasten (7.), `dokument` = Markdown als Seite, `folien` = Markdown mit `---` als Foliengrenze, blätterbar; [Code] [Vollbild] [Herunterladen]. |
| `fortschritt` | `titel?`, `wert`, `ziel?` (Standard 100), `einheit?` | Fortschrittsbalken. |

Hinweise und Statusmeldungen sind **keine** Bausteine, sondern die
Markdown-Hinweisblöcke, die es schon gibt: `> [!info]`, `> [!tipp]`,
`> [!achtung]`, `> [!fehler]`, `> [!fertig]` (die Namen, die
`calloutInfo()` in `web/lib/markdown.js` kennt; fehlende dort ergänzen).
Vergleiche sind **keine** Bausteine, sondern normale Markdown-Tabellen: jede
Tabelle im Chat wird automatisch sortierbar, ab 7 Zeilen filterbar, waagrecht
rollbar mit fester Kopfzeile.

## 3. Was die KI gesagt bekommt (Systemtext, Absatz „Darstellung“)

Kurz, im festen Teil (Caching!), sinngemäß:

1. Wähle für jede Antwort die einfachste Form, die der Aufgabe dient. Eine
   einfache Frage bekommt einen kurzen Absatz ohne Überschriften und ohne
   Bausteine.
2. Bausteine nur, wenn sie wirklich helfen: höchstens zwei pro Antwort, dazu
   höchstens ein `aktionen` am Ende. Nie zur Dekoration.
3. Zuordnung: Vergleich → Tabelle · Zahlenreihen → `diagramm` · Auswahl →
   `auswahl` · mehrere Angaben nötig → `formular` · Aufgabe/To-do →
   `checkliste` · Anleitung → `schritte` · langer Stoff → `abschnitte` oder
   `mehr` · Lernen/Üben → `quiz`, `lernkarten`, `lueckentext`, `zuordnung` ·
   Zeit → `timer`/`countdown` · Terminvorschlag → `termin` · erzeugte Datei →
   `datei` · Webseite/Design/Präsentation → `vorschau`.
4. Wenn du etwas brauchst, um weiterzuarbeiten: Werkzeug `rueckfrage`.
   Angebote nach der Antwort: `aktionen` (höchstens 4, passend zum Inhalt).
5. Das JSON ist gültig (doppelte Anführungszeichen, keine Kommentare, kein
   abschließendes Komma), die Texte darin sind kurz.
6. „Als Tabelle“, „Mach ein Diagramm“, „Nur die wichtigsten Punkte“, „Als
   Checkliste“, „Schritt für Schritt“, „Nur Text“: denselben Inhalt in der
   neuen Form, nichts dazuerfinden.
7. HTML für `vorschau` ist eigenständig: kein CDN, keine externen Dateien,
   alles inline.

Der Antwortstil des Chats (Regler) steht in der Nutzernachricht jedes Zuges,
nicht im Systemtext: `[Antwortstil: Länge 30/100 (eher kurz), Fachbegriffe
70/100, Kreativität 50/100]`.

## 4. Fassungen einer Antwort

Jede Assistenten-Nachricht kann mehrere Fassungen haben:
`versionen: [{inhalt, at, art: 'original'|'neu'|'umgewandelt'|'bearbeitet',
anweisung?, modell?}]` und `version` (die aktive, Index). `content` ist immer
die aktive Fassung – Suche, Export, Gehirn und Verlauf sehen nur sie. Die
rohen Anbieter-Blöcke (`data.claude.inhalt`) gehören zur Fassung 0; ist eine
spätere Fassung aktiv, geht in den Verlauf für die KI nur ihr Text.

- **Neu erstellen** (bestehend `POST /api/chats/:id/neu-antworten`) legt
  künftig eine neue Fassung an, statt die alte zu verwerfen. Mit `variante`:
  `kuerzer`, `einfacher`, `detaillierter`, `kreativer`, `anders`, `stil`.
- **Umwandeln** `POST /api/chats/:id/messages/:mid/umwandeln` (SSE)
  `{anweisung, sprache?, auswahl?}`: `anweisung` ∈ `verbessern`, `kuerzen`,
  `einfach`, `zusammenfassen`, `uebersetzen`, `tabelle`, `diagramm`,
  `checkliste`, `schritte`, `wichtigste`, `nurtext`, `knoepfe`, oder freier
  Text. Ohne Werkzeuge, ohne Websuche. Ergebnis = neue Fassung. Mit
  `auswahl` (markierter Text): Der Server sucht die Stelle in der aktiven
  Fassung (Leerraum und Markdown-Zeichen beim Vergleich großzügig), lässt nur
  sie umschreiben und setzt sie ein; ist sie nicht eindeutig zu finden →
  409 `AUSWAHL_NICHT_GEFUNDEN`, die Oberfläche fragt dann im Chat nach.
- **Fassung wählen** `PATCH /api/chats/:id/messages/:mid/version {version}`.
- **Block bearbeiten** `PATCH /api/chats/:id/messages/:mid/block {nr, inhalt}`
  (Code, Prompt, Datei, Vorschau) → neue Fassung `bearbeitet`.

Oberfläche: unter der Antwort „‹ 2/3 ›“, [Vergleichen] (wortweiser
Unterschied zweier Fassungen), [Wiederherstellen] auf einer älteren Fassung.

## 5. Zustand der Bausteine

`PUT /api/chats/:id/messages/:mid/ui {version, schluessel, zustand}` – je
Fassung und Baustein ein kleines Objekt (höchstens 16 KB, je Nachricht
64 KB), z. B. abgehakte Punkte, gegebene Quiz-Antworten, Reihenfolge,
Timer-Startzeit, gewählte Option. Die Oberfläche hält je Nachricht einen
Rückgängig/Wiederholen-Stapel (Strg+Z / Strg+Umschalt+Z, dazu kleine
Knöpfe ↶ ↷ nach einer Änderung). Inhaltliche Änderungen sind Fassungen (4.).

## 6. Rund um die Antwort (keine Bausteine, sondern Chat)

- **Aktionsleiste** unter jeder Antwort, ruhig, erscheint beim Überfahren
  (iPad: immer): Kopieren · Neu erstellen ▾ (Kürzer, Einfacher,
  Detaillierter, Kreativer, Anders formuliert) · Umwandeln ✨ ▾ (Verbessern,
  Zusammenfassen, Übersetzen ▸ Sprache · Darstellung: Tabelle, Diagramm,
  Checkliste, Schritte, Wichtigste Punkte, Nur Text) · Vorlesen · Fassungen.
  Die bisherigen, aus dem Inhalt geratenen Vorschlags-Chips entfallen: die KI
  bietet passende nächste Schritte selbst über `aktionen` an.
- **Markierter Text** in einer Antwort → kleines Menü: Erklären, Kürzen,
  Umschreiben, Übersetzen ▾, Verbessern, Zusammenfassen, Frage dazu. Kürzen,
  Umschreiben, Übersetzen, Verbessern ändern nur die Stelle (Umwandeln mit
  `auswahl`); Erklären, Zusammenfassen, Frage dazu stellen eine neue Frage mit
  dem Zitat.
- **„KI fragen“** je Abschnitt (Überschrift h2/h3): beim Überfahren (iPad:
  langes Drücken) ein kleines „Frage dazu“ → Eingabe direkt darunter.
- **Codeblöcke**: Sprache (erkannt, wenn nicht angegeben), [Kopieren],
  [Bearbeiten] (neue Fassung), [Ausführen] nur für JavaScript und HTML (im
  Sandkasten, mit Ausgabe darunter), [Erklären], [Fehler suchen] (neue Frage).
- **Anhänge**: Bilder (PNG, JPG, WEBP, GIF) und PDF gehen an beide KIs
  (Claude: image/document-Blöcke; Gemini: inlineData). Im Chat: Vorschaubild,
  mehrere als Galerie/Karussell, [Vergrößern] (Leuchtkasten), PDF-Karte mit
  [Anzeigen]. Nach dem Anhängen passende Schnellaktionen (Bild: Erklären,
  Aufgaben lösen, Text erkennen, Zusammenfassen; PDF: Zusammenfassen,
  Wichtigste Begriffe, Kapitel). Bilder **erzeugen** kann die App nicht (kein
  kostenloses Modell) – dafür gibt es keinen Knopf.
- **Quellen**: nummeriert, antippbar (neuer Tab), Zahlen im Text verweisen
  darauf.
- **Live-Fortschritt** während der Antwort aus echten Ereignissen: „Denkt
  nach …“, „Sucht: …“, „Termin eingetragen“, „Schreibt die Antwort …“ –
  danach eingeklappt zu „3 Arbeitsschritte“.
- **Vorlesen** als kleiner Spieler: ▶/⏸, Tempo 0,75–2×, der gerade gelesene
  Satz ist hervorgehoben.
- **Sprechen**: Mikrofon im Eingabefeld. Hat der Browser Spracherkennung,
  wird sie benutzt („Ich höre zu …“, Zwischentext im Feld). Sonst nimmt die
  App auf (WAV) und lässt Gemini umschreiben (`POST /api/ki/transkribieren`),
  wenn ein Gemini-Schlüssel da ist. Sonst kein Knopf. Wurde gesprochen, wird
  die Antwort vorgelesen.

## 7. Der Sandkasten (HTML, SVG, JavaScript)

`/sandbox.html` mit eigenem Kopf `Content-Security-Policy: default-src 'none';
script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; style-src
'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none';
form-action 'none'; frame-ancestors 'self'`. Der Chat bettet ihn als
`<iframe sandbox="allow-scripts">` ein (ohne allow-same-origin: undurchsichtiger
Ursprung, kein Zugriff auf Cookies, Speicher oder `/api`). Die App-CSP bekommt
`frame-src 'self'`. JavaScript läuft darin in einem Worker mit 3 s
Zeitgrenze; `console.log` und Fehler kommen per `postMessage` zurück. HTML-
Vorschauen laufen direkt im Rahmen; [Anhalten] entfernt ihn.

## 8. Keine Attrappen

Jeder Knopf tut, was er sagt. Was ein Gerät nicht kann (Teilen, Mitteilung,
Spracherkennung), zeigt keinen Knopf statt eines toten. Grenzen stehen in
einem Satz da, nicht in einer Anleitung.
