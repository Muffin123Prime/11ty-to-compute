# Neural OS

Eine private KI zum Mitnehmen: Chat, Kalender, Notizen, Projekte, Agenten und
ein „Gehirn“ aus deinem Wissen – auf deinem Rechner oder ganz auf einem
USB-Stick. **Jeder Stick ist eine eigene KI**; Wissen teilen nur Sticks, die du
miteinander koppelst.

```
Windows:  "Neural OS starten.bat" doppelklicken   (Node.js als ZIP daneben)
sonst:    npm start                                (Node.js 20 oder neuer)
→ http://127.0.0.1:7777
```

Es gibt nichts zu installieren: **Neural OS hat null Abhängigkeiten** und
benutzt nur die Standardbibliothek von Node. `npm install` holt nichts, weil es
nichts zu holen gibt. Die Schritt-für-Schritt-Anleitung für Windows, den Stick
und das iPad steht in **`docs/ERSTE-SCHRITTE.md`**.

---

## Was drin ist

- **Chat** mit der KI: Antworten mit Bausteinen (Tabellen, Diagramme, Listen,
  Karten), mehrere Fassungen je Antwort, Quellen im Text, Bilder und PDF
  anhängen, Sprechen statt Tippen, Vorlesen. Im Modus **„Mein Wissen“**
  antwortet die KI nur aus deinen eigenen Notizen und Einträgen.
- **Kalender** mit Serien und `.ics`; Termine legt die KI im Chat an, ändert
  und löscht sie.
- **Notizen** – die KI hält fest, was du ihr sagst; die Ansicht ist eine Wand
  zum Wiederfinden, mit `[[Links]]` und „Verknüpft mit“.
- **Gehirn** – dein Wissen als Universum: erst Themenbereiche, dann
  hineinzoomen, rechts die Karte mit Verbindungen, Gründen und einer
  KI-Zusammenfassung.
- **Projekte und Aufgaben**, verknüpft mit allem anderen.
- **Agenten** mit einzeln erteilten Rechten, Bestätigungspflicht und
  Protokoll. Ein Hintergrund-Agent aus dem Chat legt nichts an, sondern
  schlägt vor; erst dein [Übernehmen] macht es wahr.
- **Werkstatt** – die App verändert sich durch Code, den du einfügst; alles
  abschaltbar, jede Fassung bleibt erhalten.
- **Einstellungen** – KI verbinden, Name dieser KI, Gedächtnis ansehen und
  vergessen, Schutz mit PIN, iPad per QR-Code verbinden, Darstellung, Netzwerk.
- **Stick** – einen leeren Stick mit [Neue KI] vorbereiten, mit einem anderen
  Stick koppeln, sichern und wiederherstellen (`docs/STICK.md`).

## Die KI

Neural OS bringt kein Sprachmodell mit; es verbindet sich mit einer KI im
Internet. Die Wahl liegt bei dir, unter **Einstellungen → KI** oder direkt im
Chat unter „Verbinde eine KI“:

- **Gemini von Google – kostenlos.** Schlüssel auf
  <https://aistudio.google.com/apikey> mit dem Google-Konto anlegen („Create API
  key“, keine Karte). Auf der kostenlosen Stufe darf Google Inhalte zur
  Verbesserung nutzen, und die Zahl der Anfragen je Tag ist begrenzt.
- **Claude von Anthropic – kostet je Nutzung.** Schlüssel auf
  <https://console.anthropic.com> unter „API Keys“.

Der Schlüssel liegt versiegelt im Tresor (auf dem Stick: im Tresor des Sticks)
und verlässt Neural OS nur als Kopfzeile an den gewählten Anbieter. Ohne KI
funktionieren Notizen, Kalender, Projekte und das Gehirn vollständig; der Chat
sagt dann ehrlich, dass keine KI verbunden ist, statt eine Antwort zu erfinden.

## Die drei Versprechen

**1. Nichts geht still ins Netz.** Ab Werk ist das Netz zu. Drei Stufen
(offline / lokales Netz / Internet) und Freigaben mit Geltungsbereich,
Ablaufzeit und Nutzungszahl – jeder Zugriff nach draußen läuft durch eine
Schleuse (`src/net/gate.js`) und steht im Protokoll, auch die erlaubten.

**2. Nichts wird vorgetäuscht.** Keine KI da? Dann steht das da. Ein Werkzeug
schlägt fehl? Dann steht ein Fehler da, keine plausible Erfindung. Ein Balken
bewegt sich nur, wenn wirklich etwas passiert ist.

**3. Deine Daten bleiben bei dir.** Alles liegt in einem Ordner auf deinem
Rechner bzw. auf dem Stick, im Klartext-Log lesbar – oder mit deiner PIN
verschlüsselt. Auf einem fremden Laptop bleibt nichts Inhaltliches zurück.

---

## Befehle

```bash
npm start                 # Neural OS starten (im Vordergrund, Strg+C beendet)
npm test                  # Testsuite
npm run check             # jede Funktion durchprüfen und ehrlich berichten
npm run ui                # die Oberfläche im echten Browser prüfen (braucht Playwright)
npm run proof             # Beweis: ohne Freigabe geht nichts ins Netz
npm run doctor            # Statusbericht: was geht, was fehlt

node bin/neural-os.js start --hintergrund --open   # wie der Doppelklick
node bin/neural-os.js stop                         # ein laufendes Neural OS beenden
node bin/neural-os.js export --format both         # vollständige Sicherung
node bin/neural-os.js import <ordner>              # wiederherstellen (zusammenführen)
node bin/neural-os.js stick prepare <stick>        # USB-Stick vorbereiten (docs/STICK.md)

# Optionen: --home <ordner> --port <n> --host <adresse> --log debug --safe
```

## Wo deine Daten liegen

Auf dem eigenen Rechner in **einem** Ordner, standardmäßig `~/.neural-os`
(unter Windows `C:\Users\<Name>\.neural-os`; mit `--home` oder `NEURAL_OS_HOME`
änderbar). Auf dem Stick im Ordner `Inhalt\data`.

```
.neural-os/
  config.json        Einstellungen und Netz-Policy (nie verschlüsselt, damit
                     die Policy vor dem Entsperren bekannt ist)
  secrets.json       nur mit PIN: der versiegelte Schlüssel des Tresors
  audit.jsonl        jede Netzentscheidung, fortlaufend angehängt
  vault/
    log/*.jsonl      Operationslog – die eigentliche Quelle der Wahrheit
    snapshot.json    Zwischenstand für schnelles Laden
    files/           Anhänge, nach Inhalt abgelegt
  runs/              vollständige Protokolle der Agenten
  exports/           deine Sicherungen
```

Das Operationslog ist Klartext-JSON, eine Zeile pro Änderung – ohne PIN mit
`cat` lesbar. Mit PIN (**Einstellungen → Schutz**) ist der Tresor verschlüsselt
(AES-256-GCM). Das schützt einen verlorenen Stick. Es schützt kein laufendes,
schon kompromittiertes System; dort liegt der Schlüssel zwangsläufig im
Speicher.

## Das iPad

Neural OS läuft nicht auf dem iPad selbst; das iPad zeigt die Instanz deines
Rechners über das WLAN. **Einstellungen → iPad verbinden** zeigt einen QR-Code
mit einem Einmal-Code; die iPad-Kamera darauf richten, fertig. Das iPad darf
lesen und schreiben, aber keine Einstellungen ändern. Einzelheiten in
`docs/ERSTE-SCHRITTE.md`, Teil 3.

## Die ehrlichen Grenzen

- **Die KI braucht Internet.** Eine KI, die ohne Netz auf jedem Schul-Laptop
  läuft, gibt es in dieser Größe nicht; Neural OS hat deshalb keine. Ohne Netz
  siehst du alles, was du hast, bekommst aber keine neuen Antworten.
- **Die Netzschleuse wirkt auf Prozessebene.** Sie bindet diese Anwendung und
  allen Code darin, ist aber keine Firewall für andere Programme.
- **Manches lässt sich nur am echten Rechner prüfen** – ob eine
  Schul-Richtlinie Programme vom Stick sperrt, was Gatekeeper am Mac sagt. Dafür
  gibt es den Probelauf (`docs/PROBELAUF.md`).

`docs/STATUS.md` führt, was getestet ist – und was nicht.
`docs/EINGESTAENDNIS.md` sagt, wo ich mich geirrt habe und was ich nicht
überprüfen konnte.

## Weiterlesen

- **`docs/ERSTE-SCHRITTE.md`** – Windows, Stick, iPad: Schritt für Schritt.
- **`docs/STICK.md`** – der Stick: starten, beenden, neue KI, koppeln, sichern.
- **`docs/PROBELAUF.md`** – der eine Doppelklick je Rechner, der klärt, was
  sich hier nicht prüfen lässt.
- **`docs/ANLEITUNG.md`** – die Bereiche der App im Einzelnen, Netzstufen,
  Sicherung, Fehlerbehebung.
- **`docs/ERWEITERN.md`** – die App selbst verändern: Code einfügen, prüfen,
  aktivieren, zu jeder früheren Fassung zurück.
- **`docs/EINGESTAENDNIS.md`** – Fehler, Grenzen und die Stellen, an denen ich
  etwas behauptet habe, das sich später als falsch herausstellte.
- `docs/ARCHITEKTUR.md` – die Begründung der großen Entscheidungen (warum kein
  Electron, keine Datenbank, keine Abhängigkeiten).
- `docs/CONTRACTS.md` – Schnittstellen aller Module, für Erweiterungen.
- `docs/STICK-BAUPLAN.md`, `docs/ANTWORT-BAUSTEINE.md`,
  `docs/CLAUDE-ANBINDUNG.md` – Baupläne und Fakten für die Entwicklung.

## Lizenz

MIT.
