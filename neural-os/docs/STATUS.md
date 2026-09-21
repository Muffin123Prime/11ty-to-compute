# Status — was funktioniert, was nicht

Stand: 2026-09-21 · Neural OS 0.1.0 · Node 22.22.2

Dieses Dokument behauptet nichts, was nicht ausgeführt wurde. Jede Zeile in der
ersten Tabelle ist durch einen Test belegt, der mit `npm test` läuft. Was nur
teilweise oder gar nicht funktioniert, steht weiter unten — ungeschönt.

## Messwerte

```
npm test          509 Tests, 509 bestanden, 0 fehlgeschlagen   (~28 s)
npm run proof     15 Prüfpunkte bestanden, 0 fehlgeschlagen
npm run doctor    15 von 15 Subsystemen geladen
```

| Testdatei | Tests | Gegenstand |
|---|---:|---|
| `models.test.js` | 55 | Ollama- und OpenAI-Protokoll, Streaming, Tool-Calls, Abbruch |
| `agents.test.js` | 43 | Berechtigungen, Bestätigungen, Werkzeuge, Agentenschleife |
| `gate.test.js` | 38 | Klassifikation, Policy, Freigaben, DNS, Redirects |
| `store.test.js` | 36 | Persistenz, Absturzerholung, Kanten, Transaktionen |
| `server.test.js` | 34 | Routen, CSRF, Header, SSE, Body-Limit |
| `graph.test.js` | 31 | Linkableitung, Idempotenz, Graphaufbau, Cluster |
| `search.test.js` | 25 | BM25, deutsche Tokenisierung, Operatoren, Snippets |
| `chat.test.js` | 24 | Kontextaufbau, Streaming, Abbruch, Fehlerpfade |
| `auth.test.js` | 19 | Token, Host-Prüfung, CSRF, Ablauf und Widerruf |
| `backup.test.js` | 17 | Export, Import, Rundlauf, Manifest |
| `kernel.test.js` | 14 | Pfade, Konfiguration, Bus, Audit, Datenmodell |
| `integration.test.js` | 15 | Ende-zu-Ende über den echten Stapel |
| `harden.test.js` | 14 | Prozessweite Durchsetzung der Netzpolicy |
| `vaultcrypto.test.js` | 9 | AES-256-GCM, scrypt, Passphrase-Wechsel |
| `sync.test.js` | 40 | Zusammenführung, Konflikte, Idempotenz, Abbruch |
| `extract.test.js` | 30 | PDF, DOCX, XLSX, PPTX, HTML, Kodierungen |
| `embeddings.test.js` | 28 | Einbettungen, Modellwechsel, Abbruch |
| `vectors.test.js` | 24 | Vektorspeicher, Ähnlichkeit, Persistenz |
| `audit-regressions.test.js` | 13 | die Defekte aus dem Sicherheitsaudit |

## Bewiesen, nicht behauptet

Der Lauf von `npm run proof` auf einer Maschine **mit** funktionierender
Internetverbindung (Ausgangsmessung: `1.1.1.1 → connected`):

| Prüfpunkt | Ergebnis |
|---|---|
| `1.1.1.1:80` wird verhindert | von der Schleuse blockiert |
| `8.8.8.8:80` wird verhindert | von der Schleuse blockiert |
| `93.184.216.34:80` wird verhindert | von der Schleuse blockiert |
| DNS-Auflösung von `example.com` | verhindert — der Name verlässt das Gerät nicht |
| Eigene Oberfläche auf `127.0.0.1` | erreichbar, HTTP 200 |
| Lokales Modell auf `127.0.0.1:11434` | erlaubt |
| Notiz anlegen, Volltextsuche, Graph | funktioniert ohne Netz |
| `[[Wiki-Link]]` → echte Kante | funktioniert ohne Netz |
| Vollständiger Export | 19 Einträge geschrieben |
| Netzentscheidungen protokolliert | 12 Einträge, davon 8 erlaubt und 4 blockiert |

Das ist der entscheidende Punkt: Der Rechner **hatte** Internet, und die
Verbindungen kamen trotzdem nicht zustande. Ein Testlauf auf einer Maschine
ohne Internet hätte nichts bewiesen — deshalb misst das Werkzeug das zuerst
und meldet solche Punkte als „nicht entscheidbar" statt als Erfolg.

Zusätzlich im Browser geprüft (Chromium, 14 Ansichten, hell und dunkel):
**null externe Requests, null JavaScript-Fehler.** Die Oberfläche kontaktierte
ausschließlich `127.0.0.1`.

## Funktionsumfang

### Vollständig und getestet
- **Speicher** — Operationslog, Snapshot, Absturzerholung, weiche Löschung mit
  Wiederherstellung, inhaltsadressierte Dateiablage, Vault-Sperre
- **Suche** — BM25, deutsche Tokenisierung (Umlaute, ß, Kompositum-Präfixe),
  Operatoren `tag:`, `type:`, `"Phrase"`, `-ausschluss`
- **Wissensgraph** — Ableitung aus `[[Wiki-Links]]`, `#tags` und Zugehörigkeit;
  idempotent; manuelle Kanten werden nie angefasst; Cluster; Ähnlichkeitsvorschläge
- **Visuelles Gehirn** — kraftgerichtetes Layout mit Barnes-Hut-Quadtree,
  Zoom/Pan/Ziehen, Nachbarschafts-Hervorhebung, Inspektor mit Kantenbegründung
- **Netzschleuse** — drei Modi, Freigaben mit Scope/Ablauf/Nutzungszahl,
  IP-Pinning, Redirect-Neuprüfung, vollständiges Audit
- **Prozess-Härtung** — 68 Einstiegspunkte von Node gepatcht
- **Modellanbindung** — Ollama und OpenAI-kompatibel, echtes Streaming,
  Tool-Calling nativ und als Textprotokoll-Fallback
- **Chat** — Streaming, Abbruch mit erhaltener Teilantwort, Token-Budget,
  Kontextknoten aus dem Graphen, wahrheitsgemäße Netz-Kennzeichnung
- **Agenten** — sechs Vorlagen, Berechtigungen einzeln schaltbar, Bestätigungen,
  Schritt- und Zeitlimit, vollständiges Laufprotokoll
- **Verschlüsselung** — AES-256-GCM, scrypt, Passphrase-Wechsel ohne Neuverschlüsselung
- **Export/Import** — JSON und Markdown, Rundlauf getestet
- **Oberfläche** — acht Ansichten, Dark und Light, Befehlspalette, Tastaturbedienung

### Eingeschränkt
- **Agenten sind nur so gut wie das Modell.** Mit einem 3B-Modell sind
  mehrstufige Werkzeugketten unzuverlässig — das Modell vergisst Zwischenstände
  oder erfindet Werkzeugnamen. Ab 7B wird es brauchbar. Das ist eine Eigenschaft
  kleiner Modelle, keine der Agentenschleife; das Schrittlimit fängt es ab.
- **Große Dateien.** Text wird aus `.md`, `.txt`, `.json`, `.csv` und Quellcode
  extrahiert. PDF, DOCX und Bilder werden gespeichert und verknüpft, ihr Inhalt
  aber nicht durchsucht — die Parser wären je ein eigenes Projekt.
- **Sehr große Wissensbestände.** Der gesamte Bestand liegt im Arbeitsspeicher.
  Bis etwa 100 000 Datensätze ist das unproblematisch; darüber hinaus braucht es
  eine echte Datenbank hinter der `Store`-Schnittstelle.

### Seit dem letzten Stand fertiggestellt
- **Geräte-Synchronisation.** Zwei Geräte gleichen ihre Datenbestände direkt ab,
  ohne Zwischenstation. Geprüft zwischen zwei echten laufenden Instanzen:
  einseitige Änderungen kommen an, und wenn **beide** Geräte denselben Eintrag
  geändert haben, entsteht ein Konflikt mit beiden Fassungen — nichts wird
  überschrieben. Bewusst nicht abgeglichen werden Token, Netz-Freigaben, Agenten
  mit ihren Berechtigungen und die Partnerliste: ein Partnergerät kann sich
  darüber weder Rechte noch Netzzugang verschaffen.
- **Semantische Suche.** Vektorindex in `vault/vectors.bin`, Kosinus-Ähnlichkeit,
  von der Vault-Verschlüsselung gedeckt. Braucht ein Einbettungsmodell
  (`ollama pull nomic-embed-text`); fehlt es, sagt die App das mit Anleitung und
  weicht **nicht** heimlich auf die Stichwortsuche aus.
- **Textextraktion** aus PDF, DOCX, XLSX, PPTX, EPUB, ODT, HTML, RTF und
  Klartext — eigene Parser, inklusive ZIP-Leser über `node:zlib`. Ein gescanntes
  PDF ohne Textebene liefert eine ehrliche Warnung statt erfundenem Text.
- **Zeitachse** als zweite Perspektive aufs Gehirn: Spuren je Typ, Zoomstufen
  Tag/Woche/Monat/Jahr, Auswahl eines Zeitraums mit Sprung in den Graphen.

### Nicht gebaut — und warum

- **Code ausführen.** Agenten können Quelltext lesen, schreiben und darüber
  reden, aber nichts starten. Ein Sprachmodell, das Befehle auf deinem Rechner
  ausführen darf, ist eine andere Klasse von Risiko als alles andere hier; das
  gehört hinter eine echte Sandbox (Container, eigener Benutzer), nicht hinter
  `node:vm`. Über die Werkstatt lässt sich ein Werkzeug dafür nachrüsten, wenn
  du es bewusst willst.
- **Sprachein- und -ausgabe.** Braucht Whisper und ein TTS-Modell — zwei
  weitere Downloads und eine Audio-Pipeline.
- **Bilder verstehen.** Braucht ein Vision-Modell (llava, qwen-vl). Die
  Provider-Schnittstelle könnte es, die Oberfläche kann es nicht.
- **Texterkennung (OCR)** für gescannte PDFs. Ein gescanntes PDF ohne
  Textebene liefert deshalb eine ehrliche Warnung statt erfundenem Text.
- **Mobil-App.** Die Oberfläche läuft im Browser eines Tablets, ist aber für
  den Laptop gebaut — und iPadOS kann den Server selbst nicht ausführen
  (siehe `docs/ANLEITUNG.md`).

Ein **Plugin-System** stand hier früher als „nicht gebaut". Es existiert
inzwischen: die Werkstatt (`docs/ERWEITERN.md`).

## Sicherheitsaudit

Nach der Fertigstellung wurden die sicherheitskritischen Module gezielt
angegriffen: fünf Prüfer suchten Wege, die Zusagen der Anwendung zu brechen,
und jeder Fund musste anschließend drei unabhängige Widerlegungsversuche
überstehen. **Elf Defekte wurden bestätigt und behoben** — jeder mit einem
Regressionstest, damit er nicht zurückkommen kann.

Der Audit ist abgeschlossen. Die Verifizierer für HTTP und Oberfläche waren an
einem Nutzungslimit abgebrochen; ihre Funde wurden anschließend von Hand am
laufenden System nachgewiesen und behoben.

| Defekt | Gebrochene Zusage | Behebung |
|---|---|---|
| Die Prozess-Härtung prüfte nur den Hostnamen, nie die Antwort des Resolvers. Eine Freigabe „nur lokales Netz" öffnete damit das öffentliche Internet, sobald ein Name auf eine öffentliche Adresse zeigte. | Offline/Freigaben | Jede zurückgegebene Adresse wird geprüft; eine einzige unerlaubte blockiert den Namen. |
| Eine vom Aufrufer mitgegebene `lookup`-Funktion umging die DNS-Kontrolle vollständig. | Offline | Wird abgelehnt statt stillschweigend ersetzt. |
| Ein Agent mit Stufe „lokales Netz" erreichte auf einem Gerät im Online-Modus öffentliche Hosts — Beschreibung und Systemprompt behaupteten das Gegenteil. | Agentenrechte | Die Schleuse nimmt jetzt eine Obergrenze des Aufrufers entgegen, die nur verengen kann und pro Weiterleitung neu greift. Ein unaufgelöster Name gilt als „öffentlich". |
| Weiterleitungen führten einen Agenten auf Hosts außerhalb seiner Liste. | Agentenrechte | Die Hostliste wird pro Sprung geprüft. |
| Ein Agent konnte einen Unteragenten mit **mehr** Rechten starten: Hostliste, Bestätigungspflicht und Budgets wurden nicht verglichen. | Agentenrechte | Alle vier werden geprüft, und zwar gegen die *angeforderte* Stufe, weil die gespeicherte Berechtigung den Gerätemodus überlebt. |
| `::ffff:1.2.3.4` umging einen Sperrlisteneintrag `1.2.3.4`. | Offline | Beide Schreibweisen ergeben denselben Adressschlüssel. |
| Ein fehlgeschlagener Schreibvorgang veränderte trotzdem den Speicher — ein abgelehntes hartes Löschen wurde beim nächsten `compact()` endgültig. | Datensicherheit | Log zuerst, Speicher danach. Der Snapshot wartet, bis beide übereinstimmen. |
| Die Kopfzeile behauptete fest verdrahtet „Läuft lokal." — auch bei einem Modellserver im LAN oder in der Cloud. | Ehrlichkeit | Der Ort wird aus der tatsächlichen Adresse des Backends bestimmt; was nicht beweisbar lokal ist, wird als nicht lokal gemeldet. |
| `POST /api/records` legte Agenten an und umging dabei die Rechteprüfung der dedizierten Route: ein geteiltes Token mit nur „schreiben" konnte einen Agenten mit `fileRoots: ["/"]`, ohne Bestätigungspflicht und mit vollem Netzzugang erzeugen. | Agentenrechte | Agenten entstehen und ändern sich nur noch über `/api/agents`. Eine zweite Tür in ein Berechtigungssystem ist ein Loch darin. |
| Eine eingefügte URL in der Sperrliste (`https://tracker.example.com/beacon`) traf auf nichts. Der Nutzer glaubte, einen Host gesperrt zu haben, während jede Anfrage durchging. | Offline | Muster werden normalisiert: Schema, Zugangsdaten, Pfad und abschließender Punkt fallen weg. Eine Liste, die ihre Einträge stillschweigend ignoriert, ist schlimmer als keine — weil man ihr vertraut. |
| Die Socket-Schicht las Nodes interne `connect([options, callback])`-Form als Objekt ohne Host und protokollierte `localhost:0`. Ein Drittel der Einträge für eine gewöhnliche Anfrage war frei erfunden — und jedes Ziel wurde auf dieser Ebene als „lokal" durchgewinkt. | Ehrlichkeit, Offline | Die Array-Form wird erkannt. Das Protokoll nennt das echte Ziel, und ein Verbindungsversuch zu `8.8.8.8` in dieser Form wird jetzt blockiert. |
| `run.usedNetwork` blieb bei einem Elternlauf `false`, während ein von ihm gestarteter Unteragent im Netz war — der Unteragent bekommt einen eigenen Lauf-Scope. | Ehrlichkeit | Der Netzverbrauch läuft über die Abstammungskette zum Elternlauf hoch. Wer eine Aktion auslöst, muss erfahren, was sie delegiert hat. |

Es sind keine offenen Funde aus diesem Audit mehr bekannt. Das heißt nicht,
dass keine mehr existieren — es heißt, dass die gefundenen behoben sind.

## Bekannte Grenzen

1. **Die Netzdurchsetzung wirkt auf Prozessebene.** Sie bindet diese Anwendung
   und allen Code darin. Sie ist keine Firewall des Betriebssystems und kann
   einen anderen Prozess nicht hindern — auch Ollama nicht, falls du es zum
   Nachladen von Modellen benutzt. Für eine Garantie auf Systemebene gehört
   eine OS-Firewall dazu (Little Snitch, OpenSnitch, ufw).
2. **Stromausfall-Sicherheit erst nach `flush()`.** Ein Absturz des *Prozesses*
   verliert nichts (jede Änderung wird synchron geschrieben). Ein Stromausfall
   kann den noch nicht auf die Platte durchgeschriebenen Rest verlieren.
3. **Die Vault-Sperre ist ratgebend.** Sie stoppt einen zweiten Prozess auf
   derselben Maschine. Auf Netzlaufwerken ist sie unzuverlässig.
4. **Verschlüsselung schützt ein ruhendes Laufwerk**, nicht ein laufendes,
   kompromittiertes System — dort liegt der Schlüssel zwangsläufig im Speicher.
5. **Eine korrupte Zeile in der Mitte eines Logsegments** wird übersprungen und
   gemeldet, aber nicht repariert. Der betroffene Datensatz fehlt dann.
6. **Kein Modell im Lieferumfang.** Einmalig `ollama pull llama3.2` mit Internet.

## Nächste sinnvolle Schritte

1. Semantische Suche über `embed()` — der größte Gewinn fürs Wissensgehirn.
2. Geräte-Synchronisation über den eigenen Server, aufbauend aufs Operationslog.
3. Textextraktion für PDF und DOCX.
4. Eine Zeitachsen-Ansicht als zweite Perspektive aufs Gehirn.
