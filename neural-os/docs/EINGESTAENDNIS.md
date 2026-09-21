# Eingeständnis

Was du wissen solltest, bevor du diesem System dein Denken anvertraust.

Dieses Dokument ist nicht das Kleingedruckte. Es ist der Teil, den man normalerweise
weglässt: die Fehler, die Grenzen, und die Stellen, an denen ich etwas behauptet
habe, das sich später als falsch herausstellte.

---

## 1. „Alle Tests grün" hieß nicht „korrekt"

Ich habe dir gemeldet: *373 Tests, 0 Fehlschläge.* Das stimmte. Es bedeutete
weniger, als es klang.

Ein anschließender gezielter Angriff auf die sicherheitskritischen Module fand
**elf echte Defekte**, mehrere davon kritisch — in genau dem Code, der vorher als
getestet galt. Darunter:

- Eine Freigabe „nur lokales Netz" **öffnete das öffentliche Internet**, weil die
  Prozess-Härtung nur den Hostnamen prüfte und die Antwort des Resolvers nie ansah.
- Ein Agent mit Netzstufe „lokales Netz" erreichte öffentliche Hosts, **während
  seine eigene Beschreibung und sein Systemprompt dir und dem Modell das Gegenteil
  sagten**.
- Jeder Schreibvorgang veränderte den Speicher, **bevor** er ins Log schrieb. Ein
  fehlgeschlagener Schreibvorgang löschte damit Daten, die niemand löschen wollte —
  endgültig beim nächsten `compact()`.
- `POST /api/records` legte Agenten mit `fileRoots: ["/"]` an und umging dabei die
  gesamte Rechteprüfung.
- Ein Drittel der Einträge im Netz-Audit war **frei erfunden** (`localhost:0`) — auf
  einem Protokoll, dessen einziger Zweck glaubwürdiger Nachweis ist.

**Was das für dich heißt:** Meine Tests prüfen, ob der Code tut, was ich beim
Schreiben im Kopf hatte. Sie prüfen nicht, ob das, was ich im Kopf hatte, richtig
war. Für Sicherheitseigenschaften ist das ein wesentlicher Unterschied. Alle elf
sind behoben und haben jetzt Regressionstests. Ich habe keinen Grund anzunehmen,
dass es die letzten waren.

## 2. Fehler, die ich in dieser Sitzung gemacht habe

Der Vollständigkeit halber, nicht aus Zerknirschung:

- **Ein unvollständiger Vertrag.** Ich habe in `CONTRACTS.md` nicht festgelegt, ob
  `logger` die Fabrik oder eine Instanz ist. Zwei Module lasen es unterschiedlich.
  Es krachte ausgerechnet in den Fehlerpfaden — also genau dann, wenn Protokollierung
  am wichtigsten ist.
- **Ein Fix, der einen neuen Fehler erzeugte.** Beim Umdrehen der Schreibreihenfolge
  lief der automatische Snapshot plötzlich *zwischen* Log und Speicher und hätte den
  jeweils neuesten Datensatz beim nächsten Laden verschluckt. Ein bestehender Test
  hat es gefangen. Ohne ihn wäre es stiller Datenverlust gewesen.
- **Ein Skript, das eine Klammer fraß.** Meine automatisierte Änderung an
  `engine.js` zerstörte die Datei; ich musste zurücksetzen und sauber neu ansetzen.
- **Ein Test, der am Code vorbeiging.** Meine erste Fassung der Berechtigungstests
  übergab Objekte in einer Form, die das Modul gar nicht als Agenten erkannte — der
  Test wäre grün geworden, ohne irgendetwas zu prüfen.
- **Erfundene CSS-Token.** Als ich für eine ausbleibende Ansicht einsprang, benutzte
  ich Variablennamen (`--space-4`, `--text-xl`), die es im Designsystem gar nicht
  gibt. Die Ansicht rendelte vollständig unformatiert. Aufgefallen ist es nur, weil
  ich mir einen Bildschirmabzug angesehen habe — kein Test hätte das gefangen, und
  „keine JavaScript-Fehler" war dabei die ganze Zeit wahr.
- **Der Audit war zunächst unvollständig.** Die Verifizierer für HTTP und Oberfläche
  brachen an einem Nutzungslimit ab. Ich habe das gemeldet statt es zu verschweigen,
  und die Funde anschließend von Hand nachgewiesen.

## 2a. Und einer, den ich beinahe übersehen hätte

Ich habe dir gemeldet, die vier letzten Bausteine seien fertig. Sie waren
gebaut — aber die **semantische Suche war über die API gar nicht erreichbar**.
Rund 1600 Zeilen Vektorspeicher und Einbettungsdienst lagen funktionsfähig auf
der Platte, ohne dass irgendeine Route sie aufgerufen hätte. Aufgefallen ist es
nur, weil die Bau-Agenten am Ende eine Liste offener Integrationspunkte
zurückgaben und ich sie gelesen habe.

Ebenso unverdrahtet: die Textextraktion (2627 Zeilen, niemand rief sie auf) und
der Knopf „Im Gehirn zeigen" in der Zeitachse, der einen Zeitraum übergab, den
die Graph-Ansicht schlicht ignorierte — ein Knopf, der aussah als täte er etwas.

Alle drei sind jetzt verdrahtet und geprüft. Der Punkt bleibt: **„Die Tests sind
grün" und „die Funktion ist erreichbar" sind zwei verschiedene Aussagen.** Die
Tests der semantischen Suche waren die ganze Zeit grün. Sie testeten ein Modul,
das kein Nutzer je hätte aufrufen können.

## 2b. Warum es `npm run check` gibt

Weil „alle Tests grün" in diesem Projekt mehr als einmal nicht bedeutet hat,
dass die Sache funktioniert. Die Testsuite prüft, ob jedes Modul tut, was beim
Schreiben gemeint war. Sie prüft nicht, ob die Teile zusammen ein Produkt
ergeben.

`npm run check` geht durch dieselben Türen wie du: laufender Server, echte
Schnittstelle, echter Vault. Beim allerersten Lauf fand er sofort zwei echte
Defekte — eine Modul-Route, die mit HTTP 500 antwortete, und einen Fehler in
meiner eigenen Dokumentation. Was er nicht prüfen kann, meldet er als
„unklar", niemals als bestanden.

## 2c. Die Fehler aus dieser Runde

Dieselbe Geschichte noch einmal, mit neuen Bausteinen. Alle vier fanden nicht
ich beim Nachdenken, sondern ein Werkzeug beim Ausführen:

- **Ich habe am deutschen Fehlertext geraten.** Der Verbindungstest für einen
  Online-Anbieter sollte unterscheiden, ob die Netzschleuse abgelehnt hat (deine
  eigene Einstellung) oder der Server nicht erreichbar war (eine Störung). Ich
  erkannte das an Stichwörtern wie „Schleuse" und „gesperrt". Der echte Satz der
  Schleuse lautet *„Netzmodus ist 'offline'. Für … wird Modus 'online' …
  benötigt"* und enthält keines davon. Deine bewusste Einstellung wäre dir als
  Störung gemeldet worden. `npm run check` fand es im ersten Lauf. Behoben an
  der Wurzel: die Provider reichen jetzt den Fehlercode mit, und geurteilt wird
  nach dem Code, nie nach Prosa.
- **Ein Gespräch kam rückwärts zurück.** Das neue Werkzeug `chats.read`
  sortierte nur nach Zeitstempel. Drei Nachrichten in derselben Millisekunde
  sind aber normal, und die Kennungen sind zufällig statt aufsteigend — die
  Reihenfolge war schlicht offen. Der Chat-Dienst hatte das Problem längst
  gelöst; ich hatte einen zweiten, schlechteren Vergleicher geschrieben, statt
  seinen zu benutzen. Zwei Stellen haben es unabhängig gefunden.
- **Der Dubletten-Erkenner übersah den häufigsten Fall.** Gleicher Text,
  Titel um ein Wort verschieden. Weil Titel und Text zusammen verglichen wurden,
  drückten die drei verschobenen Ketten den Wert unter die Schwelle — und zwar
  ausgerechnet bei kurzen, schnell getippten Notizen, wo man sich am ehesten
  verdoppelt.
- **`port: 0` fiel still unter den Tisch.** „Such dir einen freien Port" ist ein
  gültiger Wunsch, aber `0` ist falsy, und `if (opts.port)` machte stillschweigend
  7777 daraus. Ein Werkzeug, das absichtlich neben einer laufenden Instanz
  starten wollte, scheiterte dann an einem Port, den es nie angefordert hatte.

Und einer, der keiner war: mein Oberflächentest meldete, der Schalter in der
Automatik schreibe nichts in den Tresor. Richtig war — er fragt vorher nach, und
mein Test hatte nicht bestätigt. Auch das gehört hierher: nicht jeder rote
Befund ist ein Fehler im Programm.

## 2d. Warum es `npm run ui` gibt

Aus demselben Grund wie `npm run check`, eine Ebene höher. `npm test` prüft den
Code, `npm run check` die Schnittstelle — eine *Ansicht* kann keines von beiden
sehen. Genau dort sind in diesem Projekt zwei Fehler entstanden, die kein
Unit-Test je gefunden hätte: die erfundenen CSS-Namen oben, und ein Knopf, der
da ist, aber nichts bewirkt.

`npm run ui` startet einen echten Browser und klickt. Es prüft nicht, ob etwas
erscheint, sondern ob ein Klick **bis in den Tresor durchschlägt**: nach
„Übernehmen" muss die Aufgabe wirklich im Speicher stehen. Alles andere wäre
eine Oberfläche, die beim Zusehen funktioniert.

Dafür braucht es ein global installiertes Playwright. Neural OS selbst hat
weiterhin null Abhängigkeiten; fehlt Playwright, läuft das Werkzeug gar nicht
und sagt, dass es nichts geprüft hat — statt Entwarnung zu geben.

## 3. Was ich nicht überprüfen konnte

Ehrlich ist hier wichtiger als vollständig.

- **Kein echtes Sprachmodell.** In meiner Umgebung lief kein Ollama. Die
  Modellanbindung ist gegen einen nachgebauten Server getestet, der das Protokoll
  von Ollama und der OpenAI-kompatiblen Schnittstelle spricht — **nicht gegen ein
  echtes Modell**. Das Protokoll stimmt. Ob ein konkretes Modell auf deiner Hardware
  die Werkzeugaufrufe zuverlässig produziert, weiß ich nicht.
- **Keine echte Mehrgeräte-Nutzung.** Die Synchronisation ist zwischen zwei echten
  Instanzen auf **derselben Maschine** geprüft — zwei Prozesse, zwei Vaults, echtes
  HTTP dazwischen, inklusive eines echten Konflikts, der nichts überschrieben hat.
  Nicht geprüft: zwei physische Geräte, ein echtes WLAN mit Paketverlust,
  deutlich auseinanderlaufende Uhren, ein Abbruch mitten in der Übertragung über
  eine wacklige Verbindung.
- **Nur ein Browser.** Die Oberfläche ist in Chromium geprüft. Firefox und Safari
  sollten funktionieren (nichts darin ist exotisch), aber ich habe es nicht gesehen.
- **Kein Langzeitverhalten.** Niemand hat dieses System ein halbes Jahr benutzt. Wie
  sich 50 000 Notizen anfühlen, wie der Graph bei echtem Wildwuchs aussieht, ob die
  Kompaktierung nach Monaten noch schnell ist — unbekannt.
- **Keine menschliche Sicherheitsprüfung.** Der Audit wurde von KI-Agenten
  durchgeführt, die ich selbst angeleitet habe. Das ist besser als nichts und
  deutlich besser als Selbstprüfung. Es ersetzt keinen Fachmann.
- **Leistungszahlen sind synthetisch.** „2000 Knoten flüssig" und „5000 Datensätze
  unter 150 ms" stammen aus generierten Daten auf dieser Maschine, nicht aus deiner
  Nutzung auf deinem Laptop.

## 4. Die Grenzen, die bleiben

### Die Netzwerkkontrolle ist keine Firewall
Sie wirkt **auf Prozessebene**: sie bindet diese Anwendung und allen Code darin.
Sie kann einen *anderen* Prozess auf deinem Rechner nicht hindern — auch Ollama
nicht, wenn du damit Modelle nachlädst. Wer eine Garantie auf Systemebene will,
braucht zusätzlich eine OS-Firewall (Little Snitch, OpenSnitch, ufw).

Was sie leistet, ist trotzdem substanziell: `npm run proof` weist auf einer Maschine
**mit** funktionierendem Internet nach, dass Verbindungen zu `1.1.1.1`, `8.8.8.8`
und `93.184.216.34` nicht zustande kommen und selbst die DNS-Auflösung unterbleibt.

### Verschlüsselung schützt nur ein ruhendes Laufwerk
Gegen ein gestohlenes oder ausgebautes Laufwerk: ja. Gegen ein bereits laufendes,
kompromittiertes System: nein — dort liegt der Schlüssel zwangsläufig im Speicher.
Und: **Passphrase verloren heißt Daten verloren.** Es gibt keine Hintertür, weil
eine Hintertür den Zweck aufhebt.

### Ein lokales Modell ist nicht Claude
Ein 7B-Modell ist gut im Zusammenfassen, Strukturieren, Umformulieren und
Verschlagworten. Es ist schwach bei langen Beweisketten und komplexem Code. Mit 3B
sind mehrstufige Werkzeugketten unzuverlässig — das Modell vergisst Zwischenstände
oder erfindet Werkzeugnamen. Das Schrittlimit fängt es ab, angenehm ist es nicht.
Dafür gibt es den kontrollierten Online-Modus.

### Stromausfall-Sicherheit erst nach `flush()`
Ein Absturz des *Prozesses* verliert nichts — jede Änderung wird synchron
geschrieben. Ein Stromausfall kann den noch nicht auf die Platte durchgeschriebenen
Rest verlieren.

### Eine korrupte Zeile mitten im Log wird übersprungen
Sie wird gemeldet und gezählt, aber nicht repariert. Der betroffene Datensatz fehlt
dann. Nur eine kaputte *letzte* Zeile (der klassische Absturz beim Schreiben) wird
sauber abgeschnitten.

### Die Vault-Sperre ist ratgebend
Sie stoppt einen zweiten Prozess auf derselben Maschine. Auf Netzlaufwerken (NFS,
SMB) ist sie unzuverlässig. Zwei gleichzeitige Schreiber auf einem Vault sind nicht
unterstützt.

### Alles liegt im Arbeitsspeicher
Bis etwa 100 000 Datensätze unproblematisch (grob 100–300 MB). Darüber hinaus
braucht es eine echte Datenbank hinter der `Store`-Schnittstelle. Der Umbau ist
vorbereitet, aber nicht gemacht.

## 5. Was bewusst nicht existiert

- **Kein Konto, keine Anmeldung, keine Cloud.** Es gibt keinen Server, der dich
  kennt, weil es keinen Server gibt.
- **Keine Telemetrie, kein Absturzbericht, keine Update-Prüfung.** Auch nicht
  „anonymisiert". Die App fragt nie von sich aus irgendwo nach.
- **Kein Auto-Update.** Ein Programm, das sich selbst nachlädt, ist eines, das du
  nicht mehr vollständig kennst. Du aktualisierst per `git pull`, wenn du willst.
- **Keine Sprachein- oder -ausgabe, keine Bildverarbeitung, kein Plugin-System.**
- **Keine Texterkennung (OCR).** Ein gescanntes PDF ohne Textebene liefert keinen
  Text — und die App sagt das, statt etwas zu erfinden.
- **Keine Mobil-App.** Die Oberfläche funktioniert auf einem Telefon im Browser,
  ist aber für deinen Laptop gebaut.

## 6. Wo du vorsichtig sein solltest

**Beim Aktivieren der Freigabe im lokalen Netz.** Der Server bindet dann auf eine
erreichbare Adresse. Die Token-Authentifizierung ist erzwungen (die App verweigert
sonst den Start), aber jeder in deinem WLAN kann den Port erreichen. In einem
fremden oder öffentlichen Netz: lass es aus.

**Beim Erteilen von Dateirechten an einen Agenten.** `fileRoots` ist die schärfste
Berechtigung im System. Gib den engsten Ordner an, der reicht — nicht dein
Benutzerverzeichnis.

**Beim Umschalten auf Online.** Alles, was ein Chat oder ein Agent in eine Anfrage
schreibt, geht dann an den jeweiligen Dienst. Die strikte Freigabeliste ist
standardmäßig an; lass sie an.

**Bei Inhalten aus fremder Quelle.** Modellausgaben und importierte Dateien sind
nicht vertrauenswürdig. Der Markdown-Renderer baut DOM-Knoten statt HTML zu
interpretieren und blockiert `javascript:`- und `data:`-Ziele. Trotzdem: ein Agent,
der eine Webseite liest, liest auch, was dort an Anweisungen für ihn stehen könnte.
Deshalb ist Bestätigungspflicht der Standard.

**Beim Einschalten eines Auslösers.** Ab dann startet ein Agent, ohne dass du
davorsitzt. Vier Bremsen verhindern, dass er sich selbst hochschaukelt, aber eine
davon hat eine Lücke, die du kennen solltest: das System weiß exakt, wer einen
Satz *angelegt* hat — der Stempel steht am Satz. Es weiß nicht, wer ein
bestehendes Ereignis *ausgelöst* hat. Ändert ein Agent also eine Notiz, die du
geschrieben hast, sieht das für einen Auslöser aus wie eine Änderung von dir.
Dagegen helfen dann nur noch Entprellung, Stundengrenze und die Obergrenze von
drei gleichzeitigen Läufen — das begrenzt die Menge, beantwortet die Frage aber
nicht. Fang mit engen Filtern an, nicht mit „jede Notiz".

**Beim direkt eingetragenen API-Schlüssel.** Er liegt dann im Klartext in
`config.json` (Dateirechte 0600). Über die Schnittstelle kommt er nicht wieder
heraus — dafür gibt es Tests —, aber jeder, der die Datei lesen kann, hat ihn.
Die Umgebungsvariable ist der Weg, bei dem er in keiner Datei steht.

**Beim Übernehmen eines Vorschlags.** Die Verfahren raten nicht, aber sie
bewerten. Eine „Dublette" bei 72 % Übereinstimmung sind manchmal zwei Notizen,
die sich zu Recht ähneln. Deshalb schlägt das System dort nur eine *Verknüpfung*
vor und führt nie zusammen: beim Zusammenführen verschwindet Text unwiderruflich,
und rückgängig machen kannst du das im Moment nicht.

## 7. Was ich für richtig halte

Damit dieses Dokument nicht nur eine Mängelliste ist — die Entscheidungen, zu denen
ich stehe:

- **Null Abhängigkeiten.** Teuer im Bau, aber es gibt keinen fremden Code, der
  telefonieren könnte, und `npm install` braucht kein Internet.
- **Ein Ordner, lesbares Klartext-Log.** Du kannst deinen gesamten Datenbestand mit
  `cat` ansehen. Für ein System, dem du dein Denken anvertraust, ist das keine
  Nebensache.
- **Loopback ist kein Netzzugriff.** Diese eine Unterscheidung ist der Grund, warum
  lokale KI im Offline-Modus vollständig funktioniert.
- **Kanten tragen ihre Herkunft.** `manual`, `derived` oder `agent`, mit Begründung.
  Ein Wissensgraph, dessen Verbindungen man nicht prüfen kann, wird zu Rauschen.
- **Nichts wird vorgetäuscht.** Kein Modell da? Dann steht da ein Fehler mit einer
  Anleitung, keine erfundene Antwort.
- **Konflikte beim Abgleich werden sichtbar gemacht, nie automatisch entschieden.**
  Genau dort verlieren echte Synchronisationen Daten.

## 8. Wenn du mir nicht glauben willst

Solltest du auch nicht. Prüf es:

```bash
npm run check                  # jede einzelne Funktion, über die echte
                               # Schnittstelle, gegen einen echten Vault
npm test                       # die gesamte Testsuite
npm run proof                  # der Offline-Beweis auf deiner Maschine
npm run doctor                 # was geladen ist und was fehlt
cat ~/.neural-os/audit.jsonl   # jede Netzentscheidung, die je getroffen wurde
cat ~/.neural-os/vault/log/*   # dein gesamter Datenbestand, im Klartext
```

Und der ehrlichste Test von allen: **zieh das Netzwerkkabel und arbeite weiter.**
