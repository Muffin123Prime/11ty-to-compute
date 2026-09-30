# Übergabe – Neural OS (Stand 30.09.2026)

**Lies zuerst diese Seite, dann docs/STICK-BAUPLAN.md und docs/ANTWORT-BAUSTEINE.md.**
Branch: `claude/neural-os-personal-ai-nr8xf8` (nur dort pushen, **keinen** PR ohne Auftrag).
Commit-Fuß: `Co-Authored-By: Claude <Modell> <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01WVPkX2aFLoq7NibabPsVSc`.
Letzter geprüfter Stand: Commit `5ba559a` (npm test grün, 1495). Stick-Paket R liegt ungesichert im Baum (siehe 4).

## 1. Ziel
Private KI auf einem USB-Stick. Stick in Windows-Laptop (Schule, **ohne Admin/Installation**) oder MacBook, Doppelklick, App öffnet im Browser mit allem Wissen *dieser* KI. Jeder Stick = eigene KI; nur **gekoppelte** Sticks teilen Wissen. iPad (quer) zeigt sie per WLAN. Stil des Nutzers: schwarz/weiß/dunkelgrau, ein blauer Akzent, „per Knopfdruck, nichts erklären“, ehrlich, **keine Attrappen**. Nutzer ist Laie, will **Schritt für Schritt (1 Satz + Checkpoint, Foto)**; Sprache: Deutsch.

## 2. Entscheidungen
- Null npm-Abhängigkeiten (src/** CommonJS, web/** Browser-ESM ohne Bauschritt), CSP `default-src 'self'`, jeder Netzzugriff über `src/net/gate.js`.
- **Keine Offline-KI** (Ollama komplett entfernt). KI online: **Gemini kostenlos (Standard, Nutzer will kein Geld ausgeben)** oder Claude (optional, kostet). Anbieter je Stick, Schlüssel versiegelt im Tresor. Rohes HTTP: `src/models/providers/{gemini,anthropic,strom}.js`, Verbund `src/models/ki.js`.
- Schutz = PIN (4–6 Ziffern), „Gerät merken“; PIN im Browser über „Vorraum“ (`/api/entsperren`).
- Stick: Start ohne offenes Fenster (Laufzettel, Wächter), Port je KI (20000–29999), Koppeln über verschlüsselte Postfächer, „beide Fassungen behalten“ bei Konflikt. Rohkopie „Datenbestand mitnehmen“ entfällt → **[Neue KI] / [Mit dieser KI gekoppelt]**.
- Chat: KI baut Oberfläche selbst über Codeblock ```` ```ui ```` mit JSON (22 Bausteine), Fassungen je Antwort, Umwandeln, Markier-Menü – nicht über Werkzeuge (spart Anfragen, gleich für beide Anbieter).
- Gehirn = zoombares Wissensuniversum (Themen → hineinzoomen), Themenkarte, Detailkarte, Backlinks, automatische Verbindungsvorschläge. Schale nach Nutzer-Vorlage (`docs/vorlage/app.png`, Obsidian-Bild `gehirn-obsidian.png`); beide Seitenleisten einklappbar.

## 3. Aufbau / fertig (alles gepusht bis 5ba559a)
Schale+Chat (Rückfragen, Prompt-Kasten, Quellen, Stopp, Vorlesen) · Kalender+Termin-Agent (Serien, .ics, Werkzeuge termine_lesen/ändern/löschen) · Notizen ([[Link]]-Liste, Verknüpft mit, Vorschlagskarte) · Gehirn + Server (`src/graph/universum.js`, 10.000 Knoten 143 ms) · Einstellungen (KI, PIN, iPad-QR) · Stick: Vorraum, Start, eigene KI, Koppeln, K2 (Dateien im Postfach), H (fsync), O (Ordner je Rechner) · Chat-Server (Fassungen, PUT /ui, Anhänge Bild/PDF, Transkribieren, /sandbox.html) · 22 Bausteine, Diagramme, Tabellen (`web/lib/bausteine/*`, `diagramm.js`, `tabelle.js`).
Prüfung: `npm test`, `npm run check`, `npm run ui`, `npm run proof`. Hilfsskripte/Bilder: Scratchpad `/tmp/claude-0/-home-user-11ty-to-compute/*/scratchpad/`.

## 4. Offen (in dieser Reihenfolge)
1. **Stick Paket R** (`src/portable/stick.js`, `src/http/api/stick.js`, `test/stick.test.js`, `src/app.js` eine Zeile): im Baum, **2 Tests rot** („[Mit dieser KI gekoppelt] ohne PIN / mit PIN“). Fertigstellen, dann committen.
2. **Chat-Einbau** fertigstellen (`web/views/chat.js`, `tools/chat-beweis.js`, ui-check/feature-check im Baum): Bausteine, Aktionsleiste, Fassungen, Markieren, Code-Aktionen, Anhänge, Sprechen, Vorlese-Spieler, Live-Fortschritt; Beweis mit allen Baustein-Arten im Browser.
3. **KI-Wissen**: „Mein Wissen“-Modus (Werkzeuge wissen_suchen/eintrag_lesen, nur eigene Quellen), KI-Zusammenfassung in der Gehirn-Detailkarte (`src/models/zusammenfassen.js`), Gedächtnis ansehen/löschen (Einstellungen), Hintergrund-Agenten (agent_starten, Vorschläge erst nach Bestätigung).
4. **Stick-Oberfläche W1/W2** (web/**): Knöpfe [Neue KI], [Koppeln], [Beenden], Sätze aus STICK-BAUPLAN 1.8; `web/app.js` Vorraum-Weiterleitung; Einstellungen-Satz „Noch nicht fertig …“ raus, „merken“ nicht voreingestellt; Paket M (Mac ohne Terminal) nur nach Probelauf.
5. Gehirn/Notizen: letzte Prüfrunde (Runde 2/3 wurde durch Limit unterbrochen). Vorschläge-Chips sind bewusst entfernt.
6. Aufräumen: README.md + docs/ANLEITUNG.md nennen noch Ollama/Heute/Vorschläge/Automatik/Zeitachse/Abgleich; `sw.js` VERSION vor Auslieferung hochsetzen; Gesamtprüfung mit Bildern (Vorlage vs. App), Bilder an Nutzer senden.
7. Nur am echten Rechner prüfbar (Probelauf `Probelauf - Windows.bat`/`- Mac.command`): Fenster schließt sich, Schul-Richtlinien, Mac-Gatekeeper, Auswerfen.

## 5. Stand beim Nutzer (Windows-Laptop)
Läuft mit älterer Fassung (Opera, `127.0.0.1:7777`). Neue ZIP: `https://github.com/muffin123prime/11ty-to-compute/archive/refs/heads/claude/neural-os-personal-ai-nr8xf8.zip`, entpacken, Node-Ordner (`node-v22…-win-x64`) liegt in Downloads, `Neural OS starten.bat` im Ordner `neural-os` doppelklicken (der Starter beendet eine alte Version jetzt selbst). Danach Google-Schlüssel (`aistudio.google.com/apikey` → Create API key, beginnt mit „AIza“) in „Verbinde eine KI“. **Schlüssel nie im Chat erfragen.** Claude-Konto hatte kein Guthaben („credit balance“).

## 6. Arbeitsweise
Große Arbeit in Workflows (Agenten) mit Prüfern; Nutzungslimit stoppt Agenten oft → mit `resumeFromRunId` fortsetzen. Commit nur bei grünem `npm test`; Syntaxcheck web/** per Kopie als `.mjs`. Stop-Hook verlangt sauberen Baum → Zwischenstände (grün) committen. Fakten zu Gemini/Claude **nicht aus dem Gedächtnis**, in `docs/CLAUDE-ANBINDUNG.md` (Abschn. 9 Gemini).
