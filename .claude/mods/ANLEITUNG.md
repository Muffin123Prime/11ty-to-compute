# Zwei Mods für Claude Code

Von Titus Harmann, Stand 07.10.2026.

Mods gibt es in Claude Code seit dem 01.10.2026. Ein Mod ändert, wie Claude Code
aussieht und was es anzeigt. In diesem Ordner liegen zwei, die ich selbst benutze.

| Mod | Was er zeigt | Wo |
|---|---|---|
| `cache-anzeige` | ob Claudes Cache warm ist und wie lange noch, wie voll der Kontext ist, was Neu-Einlesen kostet und was die Sitzung bisher zum API-Preis gekostet hat. Kurz bevor der Cache kalt wird, kommt eine Warnung | Statuszeile unter dem Eingabefeld |
| `chat-anzeige` | alle Claude-Code-Chats, die gerade offen sind: Ziel, Fortschritt als Balken, wann jeder fertig wird, wer auf dich wartet | Leiste über dem Eingabefeld, oder als Fenster mit `/chats` |

## Was du brauchst

* Claude Code ab Version 2.1.287. Prüfen im Terminal: `claude --version`
* Mac oder Linux. Auf Windows ist es nicht getestet.

## Installieren, ein Befehl

1. Die ZIP entpacken. Danach liegt meist ein Ordner `claude-mods` in deinen Downloads.
2. Im Terminal diesen einen Befehl einfügen und Enter drücken:

```
mkdir -p ~/.claude/skills && cp -R ~/Downloads/claude-mods/cache-anzeige ~/Downloads/claude-mods/chat-anzeige ~/.claude/skills/
```

3. Claude Code einmal schließen und neu öffnen. Fertig.

Liegt der Ordner woanders, ersetzt du `~/Downloads/claude-mods` durch den Pfad.

**Ohne Terminal-Erfahrung geht es auch so:** Claude Code öffnen und schreiben:
"Installier die Mods aus dem Ordner ~/Downloads/claude-mods nach der ANLEITUNG.md dort."
Claude führt dann denselben Befehl aus.

**Prüfen, ob es geklappt hat:** `claude plugin list` im Terminal. Dort stehen
`cache-anzeige@skills-dir` und `chat-anzeige@skills-dir` mit "loaded".

## Benutzen

### Cache-Anzeige

Läuft von selbst. In der Statuszeile steht zum Beispiel:

```
Cache warm, noch 47 Min · Kontext 142k von 1,0 Mio · neu einlesen 1,14 $ · Sitzung 3,20 $ (API-Preis)
```

* **Cache:** Claude merkt sich eure bisherige Unterhaltung kurz im Cache, seinem
  Kurzzeitgedächtnis. Solange er warm ist, liest Claude sie billig wieder. Ist er
  kalt, muss Claude alles neu einlesen, und das kostet.
* **Wie lange noch:** mit Abo (Pro, Max) hält der Cache eine Stunde, mit
  API-Schlüssel fünf Minuten. Der Mod erkennt das selbst. Stimmt es bei dir nicht,
  stellst du es um: `/cache 1h`, `/cache 5m`, zurück mit `/cache auto`.
* **Neu einlesen:** was es kostet, wenn der Cache kalt ist und Claude den ganzen
  Kontext neu schreiben muss.
* **Sitzung:** Claude Codes eigene Kostenrechnung, dieselbe Zahl wie bei `/cost`.
* `/cache` zeigt alles im Detail.

Mit Abo zahlst du diese Beträge nicht direkt. Sie zeigen, was dieselbe Arbeit
über die API kosten würde. Preise: Anthropic-Listenpreise, Stand 25.09.2026.

### Chat-Anzeige

Läuft von selbst. Richtig nützlich wird sie, sobald du mehrere Chats gleichzeitig
offen hast, zum Beispiel in drei Terminal-Fenstern. Über dem Eingabefeld steht dann:

```
Chats · 3 Chats, 2 offen
● Landingpage fürs Archiv (hier)   ██████░░░░░░ 2/4  noch ca. 6 Min
● Rechnungen sortieren             █████░░░░░░░ 2/5  noch ca. 15 Min
◌ Angebot für Kunde M.                               wartet auf dich seit 3 Min
```

* Der **Balken** kommt aus der Aufgabenliste, die Claude sich bei größeren
  Aufgaben selbst anlegt. Ohne Aufgabenliste steht dort nur, ob der Chat arbeitet
  oder auf dich wartet.
* **Wann fertig:** aus dem bisherigen Tempo. Zeit pro erledigter Aufgabe mal die
  offenen. Eine Schätzung, keine Garantie.
* Setzt du ein **Ziel** mit `/goal`, steht das Ziel statt des Chat-Namens da.
* `/chats` öffnet dieselbe Liste als Fenster. In VS Code ist das der Weg, weil die
  Leiste über dem Eingabefeld dort nicht gezeichnet wird.
* Die Leiste klappst du mit dem `[-]` rechts daneben ein.

## Sicherheit, bitte lesen

Mods laufen ohne Sandbox. Wer einen Mod installiert, führt fremden Code auf
seinem Rechner aus. Installier nur Mods aus einer Quelle, der du traust.

Was diese zwei tun, und was nicht:

* Sie lesen nur Claude Codes eigene Zahlen (Cache, Kontext, Kosten, Aufgabenliste).
* `chat-anzeige` schreibt pro Chat eine kleine Datei nach `~/.claude/chat-anzeige/`,
  damit die Chats sich gegenseitig sehen. Sonst schreibt keiner der beiden etwas.
* Keine Internetverbindung, keine Schlüssel, keine Befehle im Hintergrund.

Der ganze Code liegt offen in `hooks/register.ts` und `hooks/register.tsx`.
Wenn du sichergehen willst, lass Claude selbst nachsehen:
"Prüf die zwei Mods in ~/Downloads/claude-mods auf Internetzugriffe,
Dateizugriffe und Befehle, bevor ich sie installiere."

## Wieder entfernen

```
rm -rf ~/.claude/skills/cache-anzeige ~/.claude/skills/chat-anzeige ~/.claude/chat-anzeige
```

Danach Claude Code neu starten.

## Selbst weiterbauen

Mods baust du, indem du Claude in normaler Sprache sagst, was du willst. Zum
Beispiel: "Bau mir einen Mod, der mir unten anzeigt, wie viele Dateien du in
dieser Sitzung geändert hast." Diese zwei sind genau so entstanden.
