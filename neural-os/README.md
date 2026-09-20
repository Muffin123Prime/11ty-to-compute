# Neural OS

Ein persönliches, offline-first KI-System: Chat, visuelles Wissensgehirn und
Agenten — auf deinem Gerät, unter deiner Kontrolle.

```
git clone … && cd neural-os
npm start
# → http://127.0.0.1:7777
```

Das ist der gesamte Installationsvorgang. Es gibt nichts zu installieren:
**Neural OS hat null Abhängigkeiten** und benutzt ausschließlich die
Node-Standardbibliothek. `npm install` braucht kein Internet, weil es nichts zu
holen gibt. Die App startet auf einem Rechner, der noch nie online war.

Voraussetzung: **Node.js 20 oder neuer**. Sonst nichts.

---

## Was das hier ist

Eine einzige Anwendung, die zusammenführt, wofür man sonst fünf Programme
öffnet:

- **Chat** mit einem lokalen Modell, pro Unterhaltung wählbar
- **Visuelles Gehirn** — ein interaktiver Graph aus Notizen, Chats, Projekten,
  Aufgaben, Dateien, Agenten und Begriffen, und den Verbindungen dazwischen
- **Notizen** mit `[[Wiki-Links]]`, `#tags`, Rückverweisen und Volltextsuche
- **Agenten** mit einzeln erteilten Berechtigungen, Bestätigungspflicht und
  vollständigem Protokoll
- **Projekte und Aufgaben**, verknüpft mit allem anderen
- **Netzwerkkontrolle**, die tatsächlich durchgesetzt wird — nicht nur angezeigt

## Die drei Versprechen

**1. Offline ist der Normalzustand, nicht der Notfall.**
Im Standardmodus sind ausschließlich Loopback-Adressen erlaubt. Dein lokales
Modell läuft auf `127.0.0.1` und funktioniert deshalb vollständig weiter — denn
lokale KI ist kein Netzwerkzugriff. Zieh das Kabel und arbeite weiter.

**2. Online passiert nie stillschweigend.**
Drei Netzstufen (offline / lokales Netz / Internet), dazu Freigaben mit
Geltungsbereich, Ablaufzeit und maximaler Nutzungszahl — bis hinunter zu
„dieser eine Agent, für diesen einen Lauf, für diese eine Domain, dreimal".
Jeder Verbindungsversuch steht im Protokoll, auch die erlaubten.

**3. Nichts wird vorgetäuscht.**
Kein Modell da? Dann sagt die App das, statt eine Antwort zu erfinden. Ein
Werkzeug schlägt fehl? Dann steht da ein Fehler, keine plausible Erfindung. Ob
eine Antwort das Netz benutzt hat, kommt aus der Schleuse — nicht aus einer
Annahme.

---

## Ein lokales Modell einrichten

Neural OS enthält bewusst kein Modell (das wären 2–20 GB im Repository, und die
Wahl gehört dir). Einmalig, mit Internet:

```bash
# ollama.com/download installieren, dann:
ollama pull llama3.2      # ~2 GB, läuft auf fast jeder Hardware
ollama pull qwen2.5:7b    # ~4,7 GB, deutlich stärker, ab 16 GB RAM
```

Neural OS findet Ollama automatisch auf `127.0.0.1:11434`. Auch `llama.cpp`
(Port 8080) und LM Studio (Port 1234) werden erkannt. **Ab diesem Moment
funktioniert der Chat ohne jede Internetverbindung.**

Prüfen, was erkannt wurde:

```bash
npm run doctor
```

---

## Befehle

```bash
npm start                       # Server starten (Standard: 127.0.0.1:7777)
npm run doctor                  # ehrlicher Statusbericht: was geht, was fehlt
npm test                        # Testsuite

node bin/neural-os.js export --format both     # vollständige Sicherung
node bin/neural-os.js import <ordner>          # wiederherstellen
node bin/neural-os.js compact                  # Log zusammenfassen

# Optionen: --home <ordner> --port <n> --host <adresse> --log debug
```

## Wo deine Daten liegen

Alles unter **einem** Ordner, standardmäßig `~/.neural-os` (mit `--home` oder
`NEURAL_OS_HOME` änderbar), Zugriffsrechte 0700:

```
~/.neural-os/
  config.json          Einstellungen und Netzwerk-Policy (nie verschlüsselt,
                       damit die Policy vor dem Entsperren bekannt ist)
  audit.jsonl          jede Netzwerkentscheidung, fortlaufend angehängt
  vault/
    log/*.jsonl        Operationslog — die eigentliche Quelle der Wahrheit
    snapshot.json      periodischer Zwischenstand für schnelles Laden
    files/             inhaltsadressierte Dateien
  runs/                vollständige Agenten-Protokolle
  exports/             deine Sicherungen
```

Das Operationslog ist Klartext-JSON, eine Zeile pro Änderung. Du kannst deinen
gesamten Datenbestand mit `cat` lesen. Für ein System, dem du dein Denken
anvertraust, ist das keine Nebensache.

Optionale Verschlüsselung (AES-256-GCM, scrypt) lässt sich in den Einstellungen
aktivieren. Sie schützt ein gestohlenes Laufwerk. Sie schützt kein bereits
kompromittiertes laufendes System — dort liegt der Schlüssel zwangsläufig im
Speicher. Das sollte man wissen, bevor man sich darauf verlässt.

## Zugriff von anderen Geräten

Standardmäßig lauscht der Server nur auf `127.0.0.1` — kein anderes Gerät kommt
heran, auch nicht im selben WLAN. In den Einstellungen unter *Freigabe* kannst
du das ändern; die App erzeugt dann ein Token mit auswählbaren Rechten, das
**genau einmal** angezeigt wird. Ohne aktivierte Token-Authentifizierung
verweigert die Anwendung das Binden auf eine nicht-lokale Adresse.

Das ist kein Cloud-Dienst: Die Daten bleiben auf dem Gerät, das den Server
betreibt. Dein Tablet sieht dieselbe Instanz, es synchronisiert nicht.

---

## Die ehrlichen Grenzen

- **Netzwerkdurchsetzung wirkt auf Prozessebene**, nicht auf Systemebene. Sie
  bindet diese Anwendung und allen Code darin, ist aber keine Firewall und kann
  andere Programme auf deinem Rechner nicht hindern. Wer eine harte Garantie
  will, kombiniert sie mit einer OS-Firewall.
- **Ein 7B-Modell ist nicht Claude.** Es ist gut im Zusammenfassen,
  Strukturieren, Umformulieren und Verschlagworten; schwach bei langen
  Beweisketten und komplexem Code. Genau dafür gibt es den kontrollierten
  Online-Modus.
- **Keine Geräte-Synchronisation in Version 1.** Halb gebaut verliert sie Daten,
  und man merkt es spät. Das Operationslog ist die richtige Grundlage dafür;
  gebaut ist es noch nicht.
- **Keine semantische Suche per Embeddings in Version 1.** Die BM25-Volltextsuche
  ist für persönliches Wissen überraschend stark und sofort verfügbar.

`docs/STATUS.md` führt taggenau, was getestet ist — und was nicht.

## Weiterlesen

- `docs/ARCHITEKTUR.md` — Machbarkeitsanalyse und die Begründung jeder größeren
  Entscheidung (warum kein Electron, warum keine Datenbank, warum keine
  Abhängigkeiten)
- `docs/CONTRACTS.md` — Schnittstellen aller Module, für Erweiterungen
- `docs/STATUS.md` — was funktioniert, was fehlt

## Lizenz

MIT.
