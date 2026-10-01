# Status – was funktioniert, was nicht

Stand: 2026-10-01 · Neural OS 0.1.0 · Node 22

Dieses Dokument behauptet nichts, was nicht ausgeführt wurde. Die Zahlen unten
stammen aus den Läufen vor dem letzten Commit. Was nur am echten Rechner zu
prüfen ist, steht weiter unten – ungeschönt.

## Messwerte

```
npm test                             1693 Tests, 0 fehlgeschlagen
npm run check                        170 Funktionen über HTTP, 0 defekt
npm run ui                           267 Prüfpunkte im Browser, alles in Ordnung
npm run proof                        24 Prüfungen, ohne Freigabe geht nichts ins Netz (auch nicht zu Mistral, Groq, OpenRouter, OVHcloud, Wikipedia)
node tools/chat-beweis.js            239 Punkte, alle Baustein-Arten im Browser, eine zweite KI springt ein und schlägt in Wikipedia nach
node tools/insel-beweis.js           129 Punkte, das Wesen am Rand, Fenster, Live, Füttern, schwebendes Fenster im Browser
node tools/stick-trennung-check.js   17 Punkte, zwei Sticks im selben Browser, [Beenden] am Mac
node tools/screenshots.js            106 Bilder, kein Schritt fehlt
```

Die Werkzeuge prüfen absichtlich Verschiedenes: `test` den Code, `check` jede
Funktion über die echte HTTP-Schnittstelle, `ui` ob ein Klick in der
Oberfläche wirklich bis in den Tresor durchschlägt, `chat-beweis` den Chat mit
allen Baustein-Arten im echten Browser (mit nachgestellter KI),
`insel-beweis` die Insel (das Wesen am Rand bei allen Größen, Fragen, Live,
Dateien füttern, Bildschirm zeigen, Timer, schwebendes Fenster; Mikrofon,
Spracherkennung und Sprachausgabe dort nachgestellt) und `stick-trennung-check` zwei Sticks nacheinander im
selben Browser; `proof` beweist, dass ohne Freigabe nichts ins Netz geht.

## Was es gibt

- **Schale** nach der Vorlage des Nutzers (`docs/vorlage/app.png`): Leiste,
  Chat, rechte Spalte mit Kacheln; beide Seiten ein- und ausklappbar, der
  Zustand reist mit dem Stick. Dunkel und hell, iPad quer mit dem Finger.
- **KI** online: Gemini (kostenlos, Voreinstellung); einspringen können
  Mistral, Groq, OpenRouter (kostenlos, je ein Schlüssel), OVHcloud (ganz ohne
  Schlüssel) und, bezahlt, OpenAI und Claude — rohes HTTP ohne SDK
  (`src/models/providers/`: gemini, anthropic, openai für alle
  OpenAI-kompatiblen), Schlüssel versiegelt im Tresor, **mehrere Schlüssel je
  Anbieter**. Ist ein Modell, ein Schlüssel oder ein Anbieter am Limit,
  antwortet von selbst der nächste, mit einem Satz im Chat
  (`docs/CLAUDE-ANBINDUNG.md` 9 und 10). Ein Schlüssel wird an seinem Anfang
  erkannt (`AQ.`/`AIza` Gemini, `gsk_` Groq, `sk-or-v1-` OpenRouter, `sk-ant-`
  Claude, `sk-` OpenAI, ohne Vorsilbe Mistral), egal in welchem Feld er steht.
  Lehnt Google die Suche ab (kostenlose Stufe), geht dieselbe Frage ohne.
  **Nachschlagen in Wikipedia** für die KIs ohne eigene Suche, mit den Bildern
  der Artikel (`src/models/nachschlagen.js`, Abschnitt 11). Claude ohne Guthaben bietet
  „Kostenlos mit Gemini weiter“ an.
- **Chat** – 22 Bausteine (`docs/ANTWORT-BAUSTEINE.md`), Fassungen je Antwort,
  Umwandeln, Markier-Menü, Code-Aktionen mit Sandkasten, Bilder und PDF,
  Sprechen, Vorlese-Spieler, Live-Fortschritt, Quellen im Text, Modus „Mein
  Wissen“, Gedächtnis, Hintergrund-Agenten mit Vorschlägen.
- **Insel** (`web/lib/insel.js`, das Wesen `insel-wesen.js`, das Ohr
  `insel-ohr.js`, reine Logik `insel-logik.js`) – ein kleines Wesen am rechten
  Rand (am Telefon unten rechts), das ausweicht, wo Knöpfe, rechte Spalte oder
  Eingabefeld sind: ruht, hört zu (der Ring folgt dem echten Mikrofon), denkt,
  spricht, frisst, freut sich, ist verwirrt, schläft – nur CSS, ohne
  Dauerschleife, mit „weniger Bewegung“. Daneben kleine Schilder mit dem, was
  läuft (KI schreibt, Timer, Termin gleich, Agent, Freigabe, Bildschirm
  geteilt, Mikrofon, Vorlesen); Erinnerungen als eine Zeile. Antippen: es
  wächst zu einem Fenster am Rand (400 px, höchstens 80 % hoch; am Telefon
  85 %), mit dem Gespräch mit der eigenen KI (derselbe Chat-Dienst mit allen
  Werkzeugen, als echter Chat „Insel · …“), Rückfragen zum Antippen und dem,
  was die KI angelegt hat. **Live**: es hört zu, merkt am Raumgeräusch, wann
  du fertig bist (1,2 s Stille), schreibt es auf (Spracherkennung des
  Browsers oder, etwa in Opera, Gemini), antwortet laut und hört wieder zu;
  Antippen unterbricht. **Dateien füttern**: auf das Wesen ziehen – Bilder,
  PDF, Text bis 200 KB; was es nicht lesen kann, sagt es. **Bildschirm zeigen**: mit jeder Frage geht ein frisches Bild
  mit – die KI sieht, was in einem anderen Programm offen ist. **Über allen
  Fenstern**: die Insel schwebt in einem eigenen kleinen Fenster über jedem
  Programm (Document Picture-in-Picture: Chrome, Edge, Opera, Firefox am
  Computer). Dazu Timer mit Ton und Mitteilung, „Notiz: …“, Kopiertes und
  Markiertes als Bezug („Erklär mir das“, „Übersetz ins Deutsche“), Bilder
  einfügen oder hineinziehen, Sprechen mit Vorlesen. Strg/⌘ + Umschalt +
  Leertaste.
- **Kalender** mit Serien, Erinnerungen, `.ics`; die KI legt Termine an,
  ändert und löscht sie (Werkzeuge mit Rückgängig).
- **Notizen** als Wand zum Wiederfinden, `[[Links]]` (auch
  `[[Name#Abschnitt]]`), „Verknüpft mit“ mit Gründen, Bilder im Text,
  Anheften, Import.
- **Gehirn** – zoombares Wissensuniversum: Themenbereiche, hineinzoomen,
  Detailkarte mit Verbindungen und gemerkter KI-Zusammenfassung; 10.000 Knoten
  in rund 150 ms (Server, `src/graph/universum.js`).
- **Projekte, Agenten, Werkstatt, Einstellungen** (Name, KI, Gedächtnis, PIN,
  iPad per QR-Code, Darstellung, Netzwerk, Speicher).
- **Netzschleuse** – drei Stufen, Freigaben mit Geltungsbereich, Ablauf und
  Nutzungszahl, vollständiges Protokoll.
- **Stick** – Start ohne offenes Fenster (Laufzettel, Wächter), Port je KI,
  PIN im Browser (Vorraum), eigene KI je Stick, [Neue KI] / [Mit dieser KI
  gekoppelt], Laufzeiten für Windows und Mac (offline vom eigenen Stick, sonst
  einmal von nodejs.org), Koppeln über verschlüsselte Postfächer mit beiden
  Fassungen bei Konflikten, Zwillings-Erkennung, [Beenden] mit Endtext, zwei
  Sticks im selben Browser streng getrennt (`web/lib/lokal.js`). Am Mac ein
  Programm statt Terminal-Fenster („Neural OS starten - Mac“, Notstart im
  Inhalt), und nach [Beenden] wirft der Mac den Stick selbst aus (Paket M).
  Läuft beim Doppelklick noch eine andere Fassung (Bau-Kennung im Laufzettel,
  `src/kernel/bau.js`), wird sie beendet und die neue gestartet.

## Nur am echten Rechner prüfbar

Hier gibt es keinen Windows-PC und keinen Mac. Ob das schwarze Fenster unter
Windows wirklich zugeht, ob Schul-Richtlinien Programme vom Stick sperren, ob
die Ports 20000–29999 frei sind, was Gatekeeper zum Mac-Programm sagt, ob die
Frage nach dem Wechseldatenträger kommt und ob `diskutil eject` ohne
Administrator geht, ist **Annahme** (Bauplan Teil 3). Paket M ist trotzdem
gebaut, auf Wunsch des Nutzers vor dem Probelauf, und so, dass jede Annahme
einen Ausweg hat: Öffnet macOS das Programm nicht, gibt es den Notstart im
Ordner „Inhalt“ (der bisherige Start im Terminal); kann der Mac nicht
auswerfen, sagt der Endtext „Stick im Finder auswerfen.“ Belegt ist, was ohne
Mac geht: Das Skript im Programm läuft unter dash mit nachgestellten
Mac-Befehlen, der Helfer fürs Auswerfen unter sh gegen ein nachgestelltes
diskutil (`test/mac-paket.test.js`). Der freiwillige Probelauf
(`docs/PROBELAUF.md`) macht aus den Annahmen Belege.

## Bewusst entfernt

- **Offline-KI** (Ollama, llama.cpp, LM Studio) – auf einem Schul-Laptop nicht
  lauffähig; der Nutzer will Gemini kostenlos.
- **Heute, Vorschläge, Automatik, Zeitachse, Abgleich** als Bereiche der
  Oberfläche – Wunsch nach einer ruhigen App. Alte Adressen führen in den Chat.
- **Zwei Modelle nebeneinander, Zweiter Blick** in der Oberfläche.
- **„Datenbestand mitnehmen“** (Rohkopie auf den Stick) – ersetzt durch [Neue
  KI] und [Mit dieser KI gekoppelt].

## Bekannte Grenzen

1. **Die Netzschleuse wirkt auf Prozessebene**, sie ist keine Firewall für
   andere Programme.
2. **Die KI braucht Internet.** Ohne Netz bleibt alles lesbar und bearbeitbar,
   aber es gibt keine neuen Antworten.
3. **Gemini kostenlos** begrenzt die Anfragen je Tag; Google darf Inhalte zur
   Verbesserung nutzen; die Google-Suche gibt es dort nicht. Das steht in der
   Oberfläche. **Mit einem echten Schlüssel geprüft ist keiner der Anbieter**
   (beim Bau gab es keinen): gegen das Echte nur, was ohne Schlüssel geht —
   falsche Schlüssel bei Google, Mistral, Groq, OpenRouter und OpenAI, die
   öffentlichen Modelllisten, OVHcloud ohne Schlüssel und das Nachschlagen in
   Wikipedia; der Rest gegen Statisten (`test/*-statist.js`).
4. **Verschlüsselung schützt ein ruhendes Laufwerk**, kein laufendes,
   kompromittiertes System.
5. **Der ganze Bestand liegt im Arbeitsspeicher.** Bis etwa 100.000 Einträge
   unproblematisch.
6. **`npm run ui` und die Browser-Werkzeuge brauchen Playwright.** Neural OS
   selbst hat null Abhängigkeiten.
7. **Die Insel ist eine Webseite.** Sie schwebt über anderen Programmen nur in
   Chrome, Edge, Opera und Firefox am Computer (nicht in Safari, nicht auf dem
   iPad – dort bleibt sie in Neural OS). Das schwebende Fenster gehört zum Tab:
   wird der geschlossen, geht es mit zu. Sie sieht andere Programme nur, wenn
   man den Bildschirm teilt, und nur im Moment einer Frage; klicken oder tippen
   kann sie dort nicht. Ihr Tastenkürzel wirkt in Neural OS und im
   schwebenden Fenster – ein Kürzel für den ganzen Computer kann eine Webseite
   nicht anlegen. Wie groß das schwebende Fenster am echten Bildschirm ist,
   ließ sich hier nicht messen (ohne Bildschirm nimmt Chromium die Tabgröße).
8. **Nachschlagen ist Wikipedia, nicht das ganze Internet.** Nachrichten von
   heute, Preise und Wetter findet es nicht; ohne Kontaktangabe erlaubt
   Wikipedia 10 Anfragen je Minute (eine Suche braucht zwei). Eine echte
   Websuche haben nur Claude und Gemini auf der bezahlten Stufe.

Wie es weitergeht, steht in `docs/UEBERGABE.md`, Abschnitt 4.
