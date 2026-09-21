# Status — was funktioniert, was nicht

Stand: 2026-09-21 · Neural OS 0.1.0 · Node 22.22.2

Dieses Dokument behauptet nichts, was nicht ausgeführt wurde. Jede Zeile in der
ersten Tabelle ist durch einen Test belegt, der mit `npm test` läuft. Was nur
teilweise oder gar nicht funktioniert, steht weiter unten — ungeschönt.

## Messwerte

```
npm test          382 Tests, 382 bestanden, 0 fehlgeschlagen   (~18 s)
npm run proof     15 Prüfpunkte bestanden, 0 fehlgeschlagen
npm run doctor    11 von 11 Subsystemen geladen
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
| `integration.test.js` | 14 | Ende-zu-Ende über den echten Stapel |
| `harden.test.js` | 14 | Prozessweite Durchsetzung der Netzpolicy |
| `vaultcrypto.test.js` | 9 | AES-256-GCM, scrypt, Passphrase-Wechsel |
| `audit-regressions.test.js` | 9 | die Defekte aus dem Sicherheitsaudit |

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

### Nicht gebaut
- **Geräte-Synchronisation.** Halb gebaut verliert sie Daten, und man merkt es
  spät. Das Operationslog ist die richtige Grundlage dafür. Heute möglich:
  Freigabe im eigenen Netz — mehrere Geräte sehen dieselbe Instanz.
- **Semantische Suche per Embeddings.** Braucht ein zweites Modell und einen
  Vektorindex. Die Provider-Schnittstelle hat `embed()` bereits vorgesehen.
- **Sprachein- und -ausgabe, Bildverarbeitung, Plugin-System.**

## Sicherheitsaudit

Nach der Fertigstellung wurden die sicherheitskritischen Module gezielt
angegriffen: fünf Prüfer suchten Wege, die Zusagen der Anwendung zu brechen,
und jeder Fund musste anschließend drei unabhängige Widerlegungsversuche
überstehen. Sieben Defekte wurden bestätigt und behoben — jeder mit einem
Regressionstest, damit er nicht zurückkommen kann.

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

Der Audit wurde nicht vollständig abgeschlossen: die Verifizierer für die
HTTP-Oberfläche und die Benutzeroberfläche brachen wegen eines Nutzungslimits
ab. Deren Funde sind ungeprüfte Kandidaten und stehen weiter unten.

### Offene, ungeprüfte Kandidaten

- Die generische Record-Route könnte die Normalisierung der Agentenrechte
  umgehen (`POST /api/records` mit `type:'agent'` statt `POST /api/agents`).
- `run.usedNetwork` könnte in einem Ablauf false bleiben, obwohl gesendet wurde.
- Die Socket-Schicht protokolliert bei manchen Aufrufen `localhost:0` statt des
  echten Ziels, was Audit-Einträge ungenau macht.

Diese drei sind weder bestätigt noch behoben. Sie stehen hier, weil ein
Sicherheitsbefund, den man verschweigt, gefährlicher ist als einer, den man
offen als ungeprüft kennzeichnet.

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
