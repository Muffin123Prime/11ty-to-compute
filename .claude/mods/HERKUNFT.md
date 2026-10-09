# Herkunft und Prüfung

Gebaut am 07.10.2026 von Claude (Opus 5.5) in Claude Code 2.1.289, auf Ansage
von Titus Harmann, nach der Mod-Schnittstelle von Claude Code (Function Hooks,
Typdatei der Version 2.1.289). Der Code ist eigens dafür geschrieben, nichts
davon ist aus einer anderen Quelle übernommen.

## Was gemessen wurde

* `claude plugin validate` für beide Mods: bestanden. Der Prüfer listet, was die
  Mods aufrufen. `cache-anzeige`: Uhr, Befehl anmelden, Sitzungsnutzung, eigener
  Speicher, Statuszeile, Hinweis. `chat-anzeige`: Uhr, Befehl anmelden, die
  Variable HOME, Sitzungs-ID, Dateien lesen, schreiben und auflisten (nur unter
  `~/.claude/chat-anzeige/`), Fenster öffnen, zeichnen. Kein Netz, kein Prozess.
* TypeScript-Typprüfung gegen die Typdatei von Claude Code 2.1.289: ohne Fehler.
* `claude plugin test`: `cache-anzeige` 5 von 5, `chat-anzeige` 5 von 5. Geprüft
  werden unter anderem: Restzeit und Warnung bei 1 Stunde und 5 Minuten, der
  Neu-Einlesen-Preis (200.000 Tokens Opus 5.5 mit 1 Stunde ergeben 1,60 $),
  zwei Chats mit Balken und Restzeit, Ziel per `/goal`, die Status arbeitet,
  wartet, fertig, beendet, ein Chat ohne Lebenszeichen verschwindet nach drei
  Minuten, `/chats` zeichnet im Terminal, in der Desktop-App, in VS Code und auf
  dem Handy.
* Echter Lauf am 07.10.2026 auf einem Mac mit Max-Abo, installiert mit dem Befehl
  aus der ANLEITUNG: `claude plugin list` meldet beide als "loaded". In einer
  echten Sitzung schrieb die Statuszeile "Cache warm, noch 59 Min · Kontext 33k
  von 200k · neu einlesen 0,07 $ · Sitzung 0,03 $ (API-Preis)", die
  Chat-Anzeige schrieb ihre Datei mit Name, Ordner und Status.

## Was nicht gemessen ist

* Kein Lauf auf Windows oder Linux.
* Ob die Statuszeile in der VS-Code-Erweiterung erscheint, ist nicht geprüft.
  Die Leiste über dem Eingabefeld zeichnet Claude Code laut Schnittstelle nur im
  Terminal und in der Desktop-App, deshalb gibt es `/chats` als Fenster.
* Die Cache-Dauer wird geschätzt: Abo heißt eine Stunde, API-Schlüssel fünf
  Minuten. Belegt ist die Stunde nur für ein Max-Abo (alle Cache-Schreibvorgänge
  einer echten Sitzung liefen mit 1 Stunde). Wer abweicht, stellt es mit
  `/cache 5m` oder `/cache 1h` um.
* Die Preise sind Anthropic-Listenpreise vom 25.09.2026, fest im Code. Ändert
  Anthropic sie, stimmt "neu einlesen" nicht mehr. Die Sitzungskosten kommen aus
  Claude Codes eigener Rechnung und sind davon nicht betroffen.
* Die Restzeit der Chats ist eine Hochrechnung aus dem bisherigen Tempo, kein
  Versprechen.
* Die Mod-Schnittstelle ist laut Anthropic noch "early access" und kann sich mit
  einer neuen Version ändern.
