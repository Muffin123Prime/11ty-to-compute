# Neural OS — Machbarkeitsanalyse und Architekturentscheidungen

Dieses Dokument beantwortet zuerst die unbequemen Fragen. Was geht wirklich,
was geht nicht, und warum ich an mehreren Stellen etwas anderes gebaut habe,
als die ursprüngliche Idee nahelegte.

---

## 1. Die zentrale Frage: Kann eine Web-App wirklich offline funktionieren?

**Nein. Eine reine Browser-Anwendung kann deine Anforderung nicht erfüllen.**

Das ist keine Bequemlichkeit, sondern eine Eigenschaft der Browser-Sandbox:

| Deine Anforderung | Reine Web-App | Grund |
|---|---|---|
| Daten lokal auf dem Gerät | eingeschränkt | Nur IndexedDB/OPFS. Der Browser darf diesen Speicher jederzeit löschen ("storage pressure"). Kein Zugriff auf deine echten Ordner. |
| Lokale KI-Modelle nutzen | praktisch nein | WebGPU-Inferenz existiert, ist aber auf kleine Modelle begrenzt, lädt Gigabytes über HTTP nach und kann Ollama/llama.cpp nicht ansprechen (CORS, kein lokaler Socket). |
| Netzwerkzugriff wirklich kontrollieren | nein | Eine Seite kann ihre eigenen Requests nicht verbindlich unterbinden. Jede Bibliothek im Bundle könnte telefonieren. |
| Dateien und Projekte verwalten | eingeschränkt | File System Access API existiert nur in Chromium, jede Sitzung braucht neue Berechtigungen. |
| Agenten mit Werkzeugen | nein | Keine Prozesse, kein Dateisystem, keine lokalen Sockets. |

**Gewählte Lösung: lokaler Server + Browser als Oberfläche.**
Ein Node-Prozess auf deinem Gerät hält Daten, Modellanbindung, Agenten und die
Netzwerkschleuse. Der Browser ist nur die Anzeige und spricht ausschließlich mit
`127.0.0.1`. Du bekommst die Bedienbarkeit einer Web-App und die Fähigkeiten
einer nativen Anwendung, ohne Electron-Installation und ohne App-Store.

### Warum nicht Electron oder Tauri?
Beide bündeln eine Browser-Engine (Electron ~150 MB, Tauri braucht eine
Rust-Toolchain zum Bauen). Beide bringen einen Auto-Updater mit, der per Default
nach Hause telefoniert. Für ein System, dessen Kernversprechen "nichts verlässt
mein Gerät" ist, sind das die falschen Grundlagen. Ein Node-Prozess von ein paar
hundert Kilobyte Quelltext ist vollständig überprüfbar — du kannst jede Zeile lesen.

---

## 2. Die härteste Entscheidung: null Abhängigkeiten

**Neural OS hat keine einzige npm-Abhängigkeit.** Nur die Node-Standardbibliothek.

Das war die teuerste Entscheidung beim Bauen und die wichtigste für dich:

1. **`npm install` braucht kein Internet.** Es gibt nichts zu installieren. Die
   App läuft auf einem Rechner, der noch nie online war.
2. **Kein fremder Code.** Ein typisches Framework-Projekt zieht 300–1200 Pakete.
   Jedes davon könnte Telemetrie senden, und niemand liest das nach. Hier gibt es
   nichts, was ich nicht selbst geschrieben habe.
3. **Keine Lieferketten-Angriffe.** Der häufigste Weg, wie private Daten
   abfließen, ist ein kompromittiertes Transitiv-Paket. Diese Angriffsfläche
   ist hier null.
4. **Es verrottet nicht.** Kein Build-Schritt, keine Versionskonflikte, kein
   „läuft nicht mehr nach zwei Jahren".

Der Preis: Ich musste Speicher-Engine, Volltextsuche, Markdown-Parser,
Graph-Layout, SSE-Client, Krypto-Wrapper und Test-Runner selbst schreiben.
Das ist gemacht und getestet.

---

## 3. Was funktioniert bei komplett abgeschaltetem Internet?

Ehrlich aufgeschlüsselt. „Flugzeugmodus" heißt: WLAN aus, Kabel raus.

### Funktioniert vollständig
- Start der Anwendung, gesamte Oberfläche (Service Worker + lokale Auslieferung)
- Notizen anlegen, bearbeiten, verknüpfen, durchsuchen
- Das visuelle Gehirn: Graph, Cluster, Navigation, manuelle Verknüpfungen
- Projekte, Aufgaben, Dateien, Entitäten, Erinnerungen
- **Chat mit lokalem Modell** — sofern Ollama oder llama.cpp installiert ist
- **Agenten mit lokalen Werkzeugen** — Notizen lesen/schreiben, Graph verknüpfen,
  Dateien in freigegebenen Ordnern, Aufgaben, Rechnen, Gedächtnis
- Berechtigungen, Bestätigungen, Audit-Protokoll
- Verschlüsselung, Sperren/Entsperren
- Export und Wiederherstellung
- Zugriff von anderen Geräten im eigenen WLAN (das ist kein Internet)

### Funktioniert nicht — und das ist physikalisch so
- **Websuche und `web.fetch`.** Kein Netz, keine Webseite. Die App sagt das
  klar, statt so zu tun, als hätte sie etwas gefunden.
- **Externe KI-Dienste.** Selbe Sache.
- **Ein Modell herunterladen.** Das musst du einmal mit Internet erledigen.
  Danach nie wieder.

### Die eine echte Voraussetzung
Neural OS **enthält kein KI-Modell**. Das wäre ein Download von 2–20 GB und
gehört nicht in ein Git-Repository. Du installierst einmal Ollama
(`ollama.com/download`) und lädst ein Modell (`ollama pull llama3.2`).
Ab dann läuft alles offline. Die App erkennt Ollama automatisch auf
`127.0.0.1:11434` und sagt dir beim Start ehrlich, ob sie es gefunden hat.

**Wenn kein Modell da ist, erfindet die App keine Antwort.** Sie zeigt einen
typisierten Fehler (`NO_MODEL_AVAILABLE`) mit einer konkreten Anleitung. Das ist
der Unterschied zwischen einer Demo und einem System, dem man trauen kann.

### Hardware, realistisch
| Arbeitsspeicher | Sinnvolle Modellgröße | Erwartete Geschwindigkeit |
|---|---|---|
| 8 GB | 3B, 4-bit quantisiert (~2 GB) | CPU: 8–15 Token/s — brauchbar |
| 16 GB | 7–8B, 4-bit (~5 GB) | CPU: 3–7 Token/s, Apple Silicon: 15–30 |
| 32 GB+ oder dedizierte GPU | 14–32B | GPU: 20–60 Token/s |

Ein 7B-Modell ist kein Claude. Es ist gut für Zusammenfassen, Umformulieren,
Strukturieren, Verschlagworten und einfache Werkzeugnutzung; es ist schwach bei
langen Beweisketten und komplexem Code. Genau dafür gibt es den kontrollierten
Online-Modus — pro Anfrage, bewusst.

---

## 4. Offline, LAN und Internet sind drei verschiedene Dinge

Die meisten Apps kennen nur „online/offline". Diese hier unterscheidet sauber,
weil die Unterschiede für dich praktisch relevant sind:

- **`offline` (Standard)** — es sind ausschließlich Loopback-Adressen erlaubt
  (`127.0.0.0/8`, `::1`). Dein lokales Modell läuft auf `127.0.0.1` und
  funktioniert deshalb im Offline-Modus vollständig. Das ist der springende
  Punkt: *lokale KI ist kein Netzwerkzugriff.*
- **`lan`** — zusätzlich private Adressbereiche (`10/8`, `172.16/12`,
  `192.168/16`, `169.254/16`, `fc00::/7`). Für den Fall, dass dein Modellserver
  auf einem stärkeren Rechner im eigenen Netz läuft, oder du vom Tablet aus
  zugreifst. Immer noch kein öffentliches Internet.
- **`online`** — öffentliches Internet, standardmäßig zusätzlich durch eine
  Allowlist begrenzt.

Dazu kommen **Freigaben (Grants)** mit Geltungsbereich, Ablaufzeit und maximaler
Nutzungszahl: `einmal` → `lauf:<id>` → `agent:<id>` → `chat:<id>` → `global`.
„Dieser eine Agent darf für diesen einen Lauf `de.wikipedia.org` erreichen,
dreimal, für zehn Minuten" ist ausdrückbar und wird durchgesetzt.

### Wie die Durchsetzung wirklich funktioniert — und wo ihre Grenze liegt

Es gibt **drei Schichten**, keine davon ist ein Schalter in der Oberfläche:

1. **Die Schleuse (`src/net/gate.js`).** Der einzige Ausgang. Kein Modul ruft
   `fetch` direkt auf. Vor jeder Verbindung: Ziel klassifizieren, Policy prüfen,
   Entscheidung protokollieren.
2. **Prozess-Härtung (`src/net/harden.js`).** Beim Start werden `fetch`,
   `http.request`, `https.request`, `net.connect`, `tls.connect` und die
   DNS-Funktionen überschrieben, sodass sie durch die Schleuse müssen. Selbst
   ein Fehler an anderer Stelle im Code kann die Policy nicht umgehen.
3. **Content-Security-Policy im Browser.** Die Oberfläche darf per
   `connect-src 'self'` ausschließlich den lokalen Server kontaktieren. Das
   erzwingt der Browser, nicht mein Code.

**Die ehrliche Grenze:** Das ist Durchsetzung auf Prozessebene. Sie bindet diese
Anwendung und allen Code darin. Sie ist **keine Firewall des Betriebssystems**
und kann einen *anderen* Prozess auf deinem Rechner nicht hindern — auch nicht
Ollama selbst, falls du es zum Nachladen von Modellen benutzt. Wer eine harte
Garantie auf Systemebene will, kombiniert das mit einer OS-Firewall
(Little Snitch, OpenSnitch, ufw). Ich sage das lieber deutlich, als eine
Sicherheit zu versprechen, die die Architektur nicht hergibt.

**Ein Datenschutzdetail, das gerne übersehen wird:** Eine DNS-Auflösung ist
selbst schon eine Datenübertragung — sie verrät den Hostnamen an deinen
Resolver, noch bevor eine Verbindung steht. Die Schleuse verweigert deshalb die
Auflösung, wenn die Verbindung ohnehin blockiert würde. Der Name verlässt dein
Gerät gar nicht erst.

---

## 5. Speicherung: warum ein Ereignislog und keine Datenbank

`vault/log/*.jsonl` (append-only) + `vault/snapshot.json` + In-Memory-Indizes.

- **SQLite** hätte eine native Kompilierung gebraucht (`better-sqlite3`) — das
  bricht „Installation ohne Internet" und „läuft überall". Node 22 bringt
  `node:sqlite` mit, aber nur hinter einem experimentellen Flag; darauf baue ich
  dein Gedächtnis nicht auf.
- **Ein Append-only-Log** wird bei einem Absturz nie mitten im Datensatz
  beschädigt — schlimmstenfalls ist die letzte Zeile unvollständig, und die wird
  beim Laden abgeschnitten. Getestet, indem die Logdatei absichtlich zerschnitten wird.
- **Es ist lesbar.** Du kannst deinen gesamten Datenbestand mit `cat` ansehen.
  Für ein System, dem du dein Denken anvertraust, ist das eine Eigenschaft und
  kein Detail.
- **Es ermöglicht später Synchronisation.** Ein Operationslog lässt sich zwischen
  Geräten zusammenführen. Eine Datei, die überschrieben wird, nicht.

In-Memory bedeutet: Der gesamte Bestand liegt im RAM. Bei ~100 000 Records sind
das grob 100–300 MB — für persönliches Wissen die richtige Größenordnung. Wächst
es darüber hinaus, ist der Umstieg auf eine echte Datenbank ein isolierter
Eingriff hinter der `Store`-Schnittstelle.

**Verschlüsselung** (optional, aus per Default): AES-256-GCM, scrypt-Schlüssel-
ableitung, zufälliger Datenschlüssel der mit der Passphrase „gewrappt" wird —
damit lässt sich die Passphrase wechseln, ohne alles neu zu verschlüsseln.
*Was das schützt:* ein gestohlenes oder ausgebautes Laufwerk.
*Was das nicht schützt:* ein bereits laufendes, kompromittiertes System — dort
liegt der Schlüssel zwangsläufig im Speicher. Ein Passwortmanager ist kein
Virenschutz, und diese Verschlüsselung ist keiner.

---

## 6. Agenten: Fähigkeit vor Komfort

Ein Agent hat **keine** Rechte, bis du sie erteilst. Jedes einzeln schaltbar:
Notizen lesen/schreiben, Dateien lesen/schreiben (nur in freigegebenen Ordnern),
Verknüpfungen anlegen, Aufgaben ausführen, andere Agenten starten, Netzstufe
(offline/lan/online) mit eigener Hostliste, Bestätigungspflicht, Schritt- und
Zeitlimit.

Durchgesetzt wird das **im Werkzeug-Layer auf dem Server**, nicht in der
Oberfläche. Ein Agent, der einen nicht erlaubten Aufruf versucht, bekommt einen
`PERMISSION_DENIED`-Fehler zurück — und der Versuch steht im Audit-Protokoll.

Zwei Dinge, die ich bewusst anders gebaut habe, als es üblich ist:

1. **Der Systemprompt sagt dem Modell die Wahrheit über sein Netz.** Ohne diesen
   Satz halluzinieren kleine Modelle munter Websuchen und erfinden Quellen. Der
   Agent erfährt explizit „Du hast keinen Internetzugang".
2. **`run.usedNetwork` ist keine Vermutung.** Der Wert kommt aus der Schleuse,
   also aus dem, was tatsächlich passiert ist. Wenn dort „offline" steht, hat
   nichts das Gerät verlassen.

Keine künstlichen Credit-Limits — die realen Grenzen sind deine Hardware, das
Schrittlimit und das Zeitlimit, und die siehst du.

---

## 7. Das visuelle Gehirn

Kraftgerichteter Graph auf Canvas 2D mit Barnes-Hut-Quadtree. Kein D3, kein
WebGL — Canvas 2D bleibt mit Quadtree bis in den Bereich von ein paar tausend
Knoten flüssig und läuft überall.

Die wichtigere Entscheidung ist inhaltlich: **Kanten sind selbst Datensätze und
tragen ihre Herkunft.** `manual` (du hast verknüpft), `derived` (aus
`[[Wiki-Links]]`, `#tags`, Zugehörigkeit abgeleitet) oder `agent` (ein Agent hat
es vorgeschlagen). Sie sind im Graphen unterschiedlich gezeichnet und tragen
eine Begründung, die du im Inspektor lesen kannst.

Der Grund: Ein Wissensgraph, der automatisch Verbindungen erzeugt, die man nicht
prüfen kann, wird innerhalb weniger Wochen zu Rauschen. Deshalb gilt die
Kernregel: **Die Ableitung fasst Kanten mit `source: 'manual'` niemals an.**
Deine eigenen Verknüpfungen gehören dir.

Ähnlichkeitsvorschläge (`suggestLinks`) werden angeboten, aber nie automatisch
angelegt. Vorschlag ist nicht Tatsache.

---

## 8. Geräte-Synchronisation — bewusst nicht in Version 1

Sauberes verteiltes Zusammenführen ist ein eigenes Projekt (CRDTs,
Konfliktauflösung, Schlüsselaustausch). Halb gebaut ist es gefährlicher als
gar nicht gebaut: Es verliert Daten, und man merkt es spät.

**Was heute geht:** Freigabe im eigenen Netz (aus per Default). Du aktivierst
sie, bekommst ein Token mit ausgewählten Rechten, und greifst vom Tablet oder
zweiten Rechner auf *dieselbe* Instanz zu. Ein Gerät hält die Daten, die
anderen sehen sie. Kein fremder Cloud-Anbieter ist beteiligt.

**Was vorbereitet ist:** Das Operationslog ist die richtige Grundlage für echte
Mehrgeräte-Synchronisation über deinen eigenen Server. Jeder Datensatz hat
`rev` und Zeitstempel; die Zusammenführung ist eine spätere Erweiterung, kein
Umbau.

---

## 9. Entwicklungsphasen

| Phase | Inhalt | Stand |
|---|---|---|
| 0 | Architektur, Verträge, Kernel, Datenmodell, Test-Runner | fertig |
| 1 | Speicher, Suche, Verschlüsselung, Backup | siehe `STATUS.md` |
| 2 | Netzschleuse, Prozess-Härtung, Modellanbindung | siehe `STATUS.md` |
| 3 | Chat, Wissensgraph, visuelles Gehirn | siehe `STATUS.md` |
| 4 | Agenten, Berechtigungen, Bestätigungen | siehe `STATUS.md` |
| 5 | Kontrollierter Online-Modus, Audit-Ansicht | siehe `STATUS.md` |
| 6 | Mehrgeräte-Synchronisation, Einbettungen/semantische Suche, Plugins | offen |

`STATUS.md` führt taggenau, was getestet ist und was nicht. Dort steht auch, was
**nicht** funktioniert — das gehört genauso dokumentiert wie der Rest.

---

## 10. Was ich bewusst nicht gebaut habe

- **Kein Konto, keine Anmeldung, keine Cloud.** Es gibt keinen Server, der dich
  kennt, weil es keinen Server gibt.
- **Keine Telemetrie, kein Absturzbericht, keine Update-Prüfung.** Auch nicht
  „anonymisiert". Die App fragt nie von sich aus irgendwo nach.
- **Kein Auto-Update.** Ein Programm, das sich selbst nachlädt, ist ein Programm,
  das du nicht mehr vollständig kennst. Du aktualisierst per `git pull`, wenn du es willst.
- **Keine semantische Suche per Embeddings in v1.** Sie braucht ein zweites
  Modell und einen Vektorindex. BM25-Volltextsuche ist für persönliches Wissen
  überraschend stark und sofort da. Die Schnittstelle ist vorbereitet.
