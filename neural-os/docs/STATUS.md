# Status – was funktioniert, was nicht

Stand: 2026-10-01 · Neural OS 0.1.0 · Node 22

Dieses Dokument behauptet nichts, was nicht ausgeführt wurde. Die Zahlen unten
stammen aus den Läufen vor dem letzten Commit. Was nur am echten Rechner zu
prüfen ist, steht weiter unten – ungeschönt.

## Messwerte

```
npm test                             1604 Tests, 0 fehlgeschlagen
npm run check                        170 Funktionen über HTTP, 0 defekt
npm run ui                           264 Prüfpunkte im Browser, alles in Ordnung
npm run proof                        22 Prüfungen, ohne Freigabe geht nichts ins Netz
node tools/chat-beweis.js            226 Punkte, alle Baustein-Arten im Browser
node tools/stick-trennung-check.js   17 Punkte, zwei Sticks im selben Browser, [Beenden] am Mac
node tools/screenshots.js            106 Bilder, kein Schritt fehlt
```

Die Werkzeuge prüfen absichtlich Verschiedenes: `test` den Code, `check` jede
Funktion über die echte HTTP-Schnittstelle, `ui` ob ein Klick in der
Oberfläche wirklich bis in den Tresor durchschlägt, `chat-beweis` den Chat mit
allen Baustein-Arten im echten Browser (mit nachgestellter KI), und
`stick-trennung-check` zwei Sticks nacheinander im selben Browser; `proof`
beweist, dass ohne Freigabe nichts ins Netz geht.

## Was es gibt

- **Schale** nach der Vorlage des Nutzers (`docs/vorlage/app.png`): Leiste,
  Chat, rechte Spalte mit Kacheln; beide Seiten ein- und ausklappbar, der
  Zustand reist mit dem Stick. Dunkel und hell, iPad quer mit dem Finger.
- **KI** online: Gemini (kostenlos, Voreinstellung) oder Claude, rohes HTTP
  ohne SDK (`src/models/providers/`), Schlüssel versiegelt im Tresor.
- **Chat** – 22 Bausteine (`docs/ANTWORT-BAUSTEINE.md`), Fassungen je Antwort,
  Umwandeln, Markier-Menü, Code-Aktionen mit Sandkasten, Bilder und PDF,
  Sprechen, Vorlese-Spieler, Live-Fortschritt, Quellen im Text, Modus „Mein
  Wissen“, Gedächtnis, Hintergrund-Agenten mit Vorschlägen.
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
   Verbesserung nutzen. Beides steht in der Oberfläche.
4. **Verschlüsselung schützt ein ruhendes Laufwerk**, kein laufendes,
   kompromittiertes System.
5. **Der ganze Bestand liegt im Arbeitsspeicher.** Bis etwa 100.000 Einträge
   unproblematisch.
6. **`npm run ui` und die Browser-Werkzeuge brauchen Playwright.** Neural OS
   selbst hat null Abhängigkeiten.

Wie es weitergeht, steht in `docs/UEBERGABE.md`, Abschnitt 4.
