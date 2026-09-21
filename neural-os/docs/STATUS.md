# Status — was funktioniert, was nicht

Stand: 2026-09-21 · Neural OS 0.1.0 · Node 22.22.2

Dieses Dokument behauptet nichts, was nicht ausgeführt wurde. Jede Zeile in der
ersten Tabelle ist durch einen Test belegt, der mit `npm test` läuft. Was nur
teilweise oder gar nicht funktioniert, steht weiter unten — ungeschönt.

## Messwerte

```
npm test          879 Tests, 879 bestanden, 0 fehlgeschlagen   (~45 s)
npm run check     131 Funktionen geprüft, 1 unklar, 0 defekt
npm run proof      19 Prüfpunkte bestanden
npm run ui         15 Ansichten geklickt, hell und dunkel, 0 Fehler
npm run doctor     24 von 24 Subsystemen geladen
```

Die vier Werkzeuge prüfen absichtlich Verschiedenes: `test` den Code,
`check` jede Funktion über die echte HTTP-Schnittstelle, `proof` das
Offline-Versprechen auf einer Maschine **mit** Internet, und `ui` ob ein Klick
in der Oberfläche wirklich bis in den Tresor durchschlägt. Ein Fehler, den
alle vier übersehen, ist noch möglich — aber er muss sich schon Mühe geben.

`npm run check` beginnt mit einem Bereich 0, der gegen den Fehler prüft, der in
diesem Projekt dreimal passiert ist: **gebaut, Tests grün, nicht erreichbar**.
Die Liste der zu prüfenden Teilsysteme leitet er aus `doctor()` ab, nicht aus
einer Aufzählung — ein neues Teilsystem, das jemand zu verdrahten vergisst,
fällt von selbst auf.

### Geschwindigkeit (gemessen, nicht geschätzt)

```
Start (createApp)                  126 ms
5.000 Notizen anlegen              829 ms
Volltextsuche darüber                9 ms
Link-Ableitung über 5.000 Notizen  280 ms   (zweiter Lauf idempotent)
Graph aus 5.000 Knoten bauen        88 ms
Vorschläge prüfen                  299 ms
3.000 Sätze importieren            238 ms   (am Änderungsjournal vorbei)
Speicher bei 5.000 Notizen          56 MB
```

Das Gehirn, im Browser gemessen (Chromium, DPR 2, 1280×860):

```
  200 Knoten     1,26 ms pro Bild
1.000 Knoten     5,09 ms pro Bild
3.000 Knoten    13,4 ms pro Bild   während das Layout noch läuft
```

Danach 0 CPU: die Simulation hält an, wenn sie sich gelegt hat, und läuft in
einem versteckten Tab gar nicht erst.

Die Link-Ableitung war vorher der Flaschenhals: 5.000 Notizen anzulegen
dauerte 21 Sekunden, davon 20 in der Ableitung. Ein zwischengespeicherter,
selbstheilender Index hat daraus 1,0 Sekunden gemacht — Faktor 21.

| Testdatei | Tests | Gegenstand |
|---|---:|---|
| `models.test.js` | 55 | Ollama- und OpenAI-Protokoll, Streaming, Tool-Calls, Abbruch |
| `extract.test.js` | 50 | PDF, DOCX, XLSX, PPTX, HTML, Kodierungen |
| `agents.test.js` | 48 | Berechtigungen, Bestätigungen, 24 Werkzeuge, Herkunftsstempel |
| `gate.test.js` | 38 | Klassifikation, Policy, Freigaben, DNS, Redirects |
| `automation.test.js` | 38 | Zeitpläne, Auslöser, Entprellung, Schleifenschutz |
| `store.test.js` | 36 | Persistenz, Absturzerholung, Kanten, Transaktionen |
| `sync.test.js` | 35 | Zusammenführung, Konflikte, Idempotenz, Abbruch |
| `history.test.js` | 35 | Änderungsverlauf, Rückgängig, Ablehnung bei Fremdänderung |
| `stick.test.js` | 41 | Portabler Betrieb, Vorschau, HTTP-Routen, Sicherung |
| `server.test.js` | 34 | Routen, CSRF, Header, SSE, Body-Limit |
| `secondlook.test.js` | 32 | Zweiter Blick: belegbar vs. nicht belegbar |
| `graph.test.js` | 31 | Linkableitung, Idempotenz, Graphaufbau, Cluster |
| `folder-sync.test.js` | 30 | Abgleich über einen Ordner (Stick) |
| `backup.test.js` | 36 | Export, Import, Rundlauf, Manifest, „alles ersetzen" |
| `assist.test.js` | 29 | Sechs Vorschlagsverfahren, Idempotenz, Übernehmen |
| `today.test.js` | 28 | „Heute": Fälliges, Agentenläufe, ehrliche Leerzustände |
| `watch.test.js` | 25 | Beobachtete Ordner: erst ansehen, dann aufnehmen |
| `search.test.js` | 25 | BM25, deutsche Tokenisierung, Operatoren, Snippets |
| `chat.test.js` | 24 | Kontextaufbau, Streaming, Abbruch, Fehlerpfade |
| `modules.test.js` | 23 | Werkstatt: Installation, Versionen, Rücknahme |
| `sandbox.test.js` | 22 | Modul-Sandbox, Fähigkeitsgrenzen |
| `embeddings.test.js` | 22 | Einbettungen, Modellwechsel, Abbruch |
| `auth.test.js` | 19 | Token, Host-Prüfung, CSRF, Ablauf und Widerruf |
| `vectors.test.js` | 16 | Vektorspeicher, Ähnlichkeit, Persistenz |
| `modules-api.test.js` | 15 | HTTP-Schicht der Werkstatt |
| `integration.test.js` | 18 | Ende-zu-Ende über den echten Stapel |
| `kernel.test.js` | 14 | Pfade, Konfiguration, Bus, Audit, Datenmodell |
| `harden.test.js` | 14 | Prozessweite Durchsetzung der Netzpolicy |
| `compare.test.js` | 14 | Zwei Modelle nebeneinander, Fehler je Seite |
| `models-remote.test.js` | 13 | Online-Anbieter: Schlüssel, Schleuse, Verbindungstest |
| `audit-regressions.test.js` | 13 | die Defekte aus dem Sicherheitsaudit |
| `vaultcrypto.test.js` | 9 | AES-256-GCM, scrypt, Passphrase-Wechsel |
| `migrations.test.js` | 7 | Alte Lernkarten werden zu Notizen, genau einmal |

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

Seit Neuestem prüft der Beweis auch, dass das **Nützlichste** ohne Netz und ohne
Modell funktioniert — denn das ist die eigentliche Zusage: Vorschläge werden
gefunden (Dublette, Aufgabe, fehlender Link, in 11 ms), ein übernommener
Vorschlag legt die Aufgabe wirklich an, und die Automatik ist ab Werk aus und
feuert von allein nichts.

Zusätzlich im Browser geprüft (`npm run ui`, Chromium, 15 Ansichten, hell und
dunkel, 1280 und 1000 px): **null externe Requests, null JavaScript-Fehler**,
kein waagerechter Scrollbalken. Die Oberfläche kontaktierte ausschließlich
`127.0.0.1`. Geprüft wird dabei nicht nur, ob etwas erscheint, sondern ob ein
Klick bis in den Tresor wirkt: nach „Übernehmen" steht die Aufgabe wirklich im
Speicher, und ein Zeitplan wird erst nach der Rückfrage eingeschaltet.

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
- **Agenten** — sechs Vorlagen, 24 Werkzeuge (lesend und schreibend, jedes an
  eine einzelne Berechtigung gebunden), Bestätigungen, Schritt- und Zeitlimit,
  vollständiges Laufprotokoll
- **Verschlüsselung** — AES-256-GCM, scrypt, Passphrase-Wechsel ohne Neuverschlüsselung
- **Export/Import** — JSON und Markdown, Rundlauf getestet
- **USB-Stick** — der Bereich „Stick": Selbstauskunft (läuft diese Instanz
  portabel, von wo, wie viel Platz, welche Laufzeiten), „Erst ansehen" vor dem
  ersten geschriebenen Byte, Vorbereiten/Erneuern/Laufzeit-Holen als
  Ereignisstrom mit gemessenem Fortschritt. Zwei gleichzeitige Vorgänge auf
  demselben Stick ergeben 409 statt zwei halber Sticks; das Prüfen schreibt
  nichts. Der ganze Kreis ist gefahren worden: Tresor füllen → Stick
  vorbereiten (mit Daten) → Quellordner löschen → NUR vom Stick starten →
  Notiz schreiben → beenden → wieder NUR vom Stick starten → die Notiz ist da
- **Umwandlung alter Lernkarten** — der Bereich „Lernen" ist entfallen;
  vorhandene Karten werden beim ersten Start einmalig zu Notizen (Vorderseite →
  Titel, Rückseite → Text, Schlagwort `lernkarte`, Verknüpfung zur Quellnotiz
  bleibt). Nicht gelöscht und nicht liegengelassen: ein Satz eines Typs, den es
  nicht mehr gibt, fiele still aus jeder neuen Sicherung heraus
- **Oberfläche** — 15 Ansichten, Dark und Light, Befehlspalette, Tastaturbedienung
- **Vorschläge** — sechs Verfahren ganz ohne Modell: Dubletten (Vier-Wort-Ketten,
  Jaccard ≥ 0,72, Kandidaten über eine Skizze statt aller Paare), verwaiste
  Notizen, Schlagwörter aus der Nachbarschaft, Aufgaben aus ausdrücklichen
  Merkern, Wiedervorlage, unaufgelöste `[[Verweise]]`. Vorschlagen und
  Ausführen sind streng getrennt; ein verworfener Vorschlag kommt nie wieder
- **Automatik** — Zeitpläne (stündlich/täglich/wöchentlich) und Auslöser auf
  Ereignisse, beide ab Werk aus. Vier Bremsen gegen Selbstauslösung:
  Herkunftsstempel, Entprellung, Stundengrenze, höchstens drei gleichzeitige
  Läufe. Drei verpasste Tage holen genau einen Lauf nach
- **Online-Modus** — Anbieter mit Vorlage anlegen, Schlüssel aus einer
  Umgebungsvariable, Host getrennt freigeben, Verbindung wirklich testen. Der
  Schlüssel kommt über keine Route wieder heraus
- **Herkunft** — jeder Satz aus einem Agentenlauf trägt `runId`, `agentId` und
  `source: 'agent'`. Eine *Änderung* stempelt nicht um: eine Notiz des Nutzers
  bleibt seine, auch wenn ein Agent sie angefasst hat
- **Heute** — ein Bildschirm, der mit einer Tatsache beginnt („Zwei Aufgaben
  sind fällig, eine davon überfällig"), nicht mit einer Begrüßung. Fällig,
  was ohne dich lief, Vorschläge, seit gestern, Wiedervorlage. Fehlt ein
  Teilsystem, steht der Grund dabei
- **Beobachtete Ordner** — anlegen → erst ansehen → einschalten. Symbolischen
  Links wird nicht gefolgt, der Tresor selbst lässt sich nicht beobachten, im
  Quellordner wird nie etwas geändert. Ein großer Durchlauf läuft am
  Änderungsjournal vorbei, damit er es nicht leerfegt
- **Zwei Modelle** — dieselbe Frage an zwei Modelle. Vor dem Absenden steht da,
  ob eine Seite das Gerät verlässt; scheitert eine, liefert die andere trotzdem
  und die gescheiterte trägt ihren echten Fehler
- **Zweiter Blick** — Kernaussage, offene Stellen, bekannte Begriffe. Der dritte
  Teil braucht kein Modell und ist belegbar; ohne Modell liefert er ihn und sagt,
  dass die anderen beiden fehlen, statt sie zu erfinden
- **Schnellerfassung** — Strg+Umschalt+N, von überall aus, mit Vorschau dessen,
  was daraus wird
- **Rückgängig** — eigenes Journal (`vault/history.jsonl`), unabhängig vom
  Verdichten des Schreib-Logs, bei verschlüsseltem Tresor mitverschlüsselt.
  Höchstens 2000 Einträge oder 30 Tage. Jede Änderung trägt, **wer** sie
  gemacht hat: ein Agentenlauf setzt beim Start seinen Namen, und alles, was
  innerhalb geschrieben wird, trägt ihn — auch das, was der Schreibvorgang
  seinerseits auslöst (`src/kernel/actor.js`, AsyncLocalStorage). Ein Konflikt
  wird nie still überschrieben: wurde der Satz seitdem wieder geändert, wird
  abgelehnt und beide Revisionen benannt

### Eingeschränkt
- **Agenten sind nur so gut wie das Modell.** Mit einem 3B-Modell sind
  mehrstufige Werkzeugketten unzuverlässig — das Modell vergisst Zwischenstände
  oder erfindet Werkzeugnamen. Ab 7B wird es brauchbar. Das ist eine Eigenschaft
  kleiner Modelle, keine der Agentenschleife; das Schrittlimit fängt es ab.
- **Gescannte Dokumente.** Text wird inzwischen auch aus PDF, DOCX, XLSX, PPTX,
  EPUB, ODT, HTML und RTF gelesen (eigene Parser, siehe unten). Ein *gescanntes*
  PDF ohne Textebene bleibt unlesbar — dafür bräuchte es eine Texterkennung.
  Die App sagt das, statt Text zu erfinden.
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
7. **Der Schleifenschutz der Auslöser beantwortet zwei verschiedene Fragen
   unterschiedlich gut.** Er weiß exakt, wer einen Satz *angelegt* hat (der
   Stempel steht am Satz). Er weiß nicht, wer ein bestehendes Ereignis
   *ausgelöst* hat. Konkret: ändert ein Agent eine Notiz des Nutzers, sieht das
   für einen Auslöser aus wie eine Änderung des Nutzers. Dagegen helfen dann
   nur noch die Mengenbremsen — Entprellung, Stundengrenze, drei gleichzeitige
   Läufe. Das ist eine Begrenzung der Menge, keine Antwort auf die Frage, und
   im Code steht es genauso.
8. **Ein Schlüssel, den du direkt einträgst, liegt im Klartext** in
   `config.json` (Dateirechte 0600). Die Umgebungsvariable ist der sichere Weg,
   und die App sagt das auch — aber sie hindert dich nicht daran.
9. **Ein beobachteter Ordner liest, sobald er eingeschaltet ist.** `fs.watch`
   ist auf Netzlaufwerken und unter macOS unzuverlässig; deshalb läuft
   zusätzlich ein langsamer Rundlauf. Eine Datei kann also mit Verzögerung
   ankommen, aber sie geht nicht verloren.
10. **`npm run ui` braucht ein global installiertes Playwright.** Neural OS
   selbst hat weiterhin null Abhängigkeiten; das Prüfwerkzeug läuft ohne
   Playwright gar nicht und sagt dann, dass es nichts geprüft hat, statt
   Entwarnung zu geben.

## Nächste sinnvolle Schritte

Alle acht Vorschläge aus `docs/IDEEN.md` sind abgearbeitet — sieben gebaut, einer
(„Der Tresor auf dem Telefon") bewusst liegen gelassen, weil er keine Ergänzung
ist, sondern eine zweite Oberfläche, und das eine Entscheidung des Nutzers ist.

Was jetzt anstünde, steht am Ende von `docs/IDEEN.md` und ist kleiner und
langweiliger als das Bisherige — genau deshalb richtig:

1. **„Heute" zur Startseite machen**, wenn es sich im Alltag bewährt.
