# Übergabe – Neural OS (Stand 01.10.2026)

**Lies zuerst diese Seite, dann docs/STICK-BAUPLAN.md und docs/ANTWORT-BAUSTEINE.md.**
Branch: `claude/neural-os-personal-ai-nr8xf8` (nur dort pushen, **keinen** PR ohne Auftrag).
Commit-Fuß: `Co-Authored-By: Claude <Modell> <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_017W4PPMZ9ukVRvgHBxpNgPK`.
Letzter geprüfter Stand: Spitze des Branches (Code wie `80420a1`, danach nur Prüfpunkte und Doku): npm test grün (1596), `npm run ui` 261 Prüfpunkte ohne Fehler. Der Baum ist sauber.

## 1. Ziel
Private KI auf einem USB-Stick. Stick in Windows-Laptop (Schule, **ohne Admin/Installation**) oder MacBook, Doppelklick, App öffnet im Browser mit allem Wissen *dieser* KI. Jeder Stick = eigene KI; nur **gekoppelte** Sticks teilen Wissen. iPad (quer) zeigt sie per WLAN. Stil des Nutzers: schwarz/weiß/dunkelgrau, ein blauer Akzent, „per Knopfdruck, nichts erklären“, ehrlich, **keine Attrappen**. Nutzer ist Laie, will **Schritt für Schritt (1 Satz + Checkpoint, Foto)**; Sprache: Deutsch.

## 2. Entscheidungen
- Null npm-Abhängigkeiten (src/** CommonJS, web/** Browser-ESM ohne Bauschritt), CSP `default-src 'self'`, jeder Netzzugriff über `src/net/gate.js`.
- **Keine Offline-KI** (Ollama komplett entfernt). KI online: **Gemini kostenlos (Standard, Nutzer will kein Geld ausgeben)** oder Claude (optional, kostet). Anbieter je Stick, Schlüssel versiegelt im Tresor. Rohes HTTP: `src/models/providers/{gemini,anthropic,strom}.js`, Verbund `src/models/ki.js`.
- Schutz = PIN (4–6 Ziffern), „Gerät merken“ nicht voreingestellt; PIN im Browser über „Vorraum“ (`/api/entsperren`).
- Stick: Start ohne offenes Fenster (Laufzettel, Wächter), Port je KI (20000–29999), Koppeln über verschlüsselte Postfächer, „beide Fassungen behalten“ bei Konflikt. Rohkopie „Datenbestand mitnehmen“ entfällt → **[Neue KI] / [Mit dieser KI gekoppelt]**. Browser-Speicher je KI nur über `web/lib/lokal.js` (`neural-os:<kiId>:<name>`).
- Chat: KI baut Oberfläche selbst über Codeblock ```` ```ui ```` mit JSON (22 Bausteine), Fassungen je Antwort, Umwandeln, Markier-Menü – nicht über Werkzeuge (spart Anfragen, gleich für beide Anbieter).
- Gehirn = zoombares Wissensuniversum (Themen → hineinzoomen), Detailkarte mit gemerkter KI-Zusammenfassung. Schale nach Nutzer-Vorlage (`docs/vorlage/app.png`); beide Seitenleisten einklappbar, Zustand reist mit dem Stick.

## 3. Aufbau / fertig (alles gepusht bis `80420a1`)
Was es gibt, steht in `docs/STATUS.md` (mit Messwerten), wie man es bedient in `docs/ANLEITUNG.md`, der Weg für Laien in `docs/ERSTE-SCHRITTE.md`, der Stick in `docs/STICK.md`.
Offene Liste vom 30.09. ist abgearbeitet: Stick Paket R · Chat-Einbau (22 Bausteine, Beweis `tools/chat-beweis.js`) · KI-Wissen (Mein Wissen, Zusammenfassung, Gedächtnis, Hintergrund-Agent) · Stick-Oberfläche W1 (Speicher je KI, [Beenden], Vorraum) und W2 (Stick-Ansicht: Dieser Rechner, Andere Sticks mit [Neue KI]/[Koppeln]/[Erneuern], Gekoppelt, beide Fassungen) · Gehirn/Notizen letzte Prüfrunde · Aufräumen (Doku ohne Ollama/Heute/Automatik, `sw.js` v16) · Probelauf (`tools/probelauf.js`, `Probelauf auf den Stick legen.bat`, `docs/PROBELAUF.md`).
Jede Welle hatte eine Prüfrunde mit unabhängigen Prüfern; alle Befunde sind behoben. Jeder hat einen Test (`npm test`) oder einen Prüfpunkt im Browser (`npm run ui`, Abschnitt 4e für Gehirn/Notizen Runde 2), der ohne die Behebung rot ist.
Prüfung: `npm test`, `npm run check`, `npm run ui`, `npm run proof`, `node tools/chat-beweis.js`, `node tools/stick-trennung-check.js`, `node tools/screenshots.js --out <ordner>` (Bilder). Hilfsskripte/Bilder: Scratchpad `/tmp/claude-0/-home-user-11ty-to-compute/*/scratchpad/`.

## 4. Offen (in dieser Reihenfolge)
1. **Probelauf beim Nutzer** (`docs/PROBELAUF.md`, Teil A–C, je Schritt ein Satz + Checkpoint). Zurück kommt je Rechner ein Text, der mit „Neural OS Probelauf“ beginnt. Auswerten nach STICK-BAUPLAN Teil 3: Fenster zu unter Windows? Schul-Richtlinie? Gatekeeper/Wechseldatenträger am Mac? Ports 20000–29999 frei? Auswerfen ohne Admin?
2. **Paket M** (Mac ohne Terminal-Fenster, automatisches Auswerfen) – nur, wenn der Probelauf es verlangt (STICK-BAUPLAN 2.13).
3. Was der Probelauf sonst zeigt, nachbessern; danach `docs/STATUS.md` („Nur am echten Rechner prüfbar“) auf belegt/Annahme aktualisieren.

Bekannte kleine Reste (bewusst offen, kein Fehlverhalten): Im Gehirn wird der Pfad oben links bei 761–850 px Gehirn-Breite mit offener Karte und am Telefon gekürzt (Platz, nicht Logik); `layoutThemen` ist O(n²), wird aber nie mit mehr als 41 Kreisen aufgerufen; ein Bild, das in den Notiz-Editor eingefügt und nie gespeichert wurde, bleibt nur dann liegen, wenn der Tab während des Bearbeitens geschlossen wird.

## 5. Stand beim Nutzer (Windows-Laptop)
Läuft mit älterer Fassung (Opera, `127.0.0.1:7777`). Nächster Schritt ist `docs/PROBELAUF.md` Teil A: neue ZIP (`https://github.com/muffin123prime/11ty-to-compute/archive/refs/heads/claude/neural-os-personal-ai-nr8xf8.zip`) entpacken, `Neural OS starten.bat` im Ordner `neural-os` doppelklicken (beendet die alte Fassung selbst), Stick unter Einstellungen › Speicher › Stick mit [Neue KI] vorbereiten, dann `Probelauf auf den Stick legen.bat`. Node-Ordner (`node-v22…-win-x64`) liegt in Downloads. Google-Schlüssel (`aistudio.google.com/apikey` → Create API key, beginnt mit „AIza“) in „Verbinde eine KI“. **Schlüssel nie im Chat erfragen.** Claude-Konto hatte kein Guthaben („credit balance“).

## 6. Arbeitsweise
Große Arbeit in Workflows (Agenten) mit Prüfern; Nutzungslimit stoppt Agenten oft → mit `resumeFromRunId` fortsetzen. Commit nur bei grünem `npm test`; Syntaxcheck web/** per Kopie als `.mjs`; `web/sw.js` VERSION bei jeder Änderung unter web/ hochsetzen. Stop-Hook verlangt sauberen Baum → Zwischenstände (grün) committen. Fakten zu Gemini/Claude **nicht aus dem Gedächtnis**, in `docs/CLAUDE-ANBINDUNG.md` (Abschn. 9 Gemini).
