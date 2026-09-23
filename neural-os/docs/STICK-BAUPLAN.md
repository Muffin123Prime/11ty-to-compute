# Bauplan: Stick rein, Doppelklick, eigene KI – außer man koppelt

Stand 23.09.2026. Grundlage ist Repository-HEAD `dc847ac` plus der Arbeitsstand von heute Morgen. Dieser Plan ist **verbindlich** für die Entwickler-Agenten, die ihn umsetzen. Für den Plan selbst wurde im Repository nichts geändert.

**Kennzeichnung.** **belegt** heißt: durch einen Versuch hier oder durch eine Fundstelle in Quelltext oder Doku gezeigt. **Annahme** heißt: ohne echten Windows-PC oder Mac hier nicht prüfbar. Jede Annahme hat in Teil 3 einen Prüfpunkt.

**Der Wunsch des Nutzers, auf drei Sätze gebracht.**
1. Stick an einen Windows-Laptop oder ein MacBook, im Explorer oder Finder öffnen, doppelklicken. Die App öffnet sich im Browser mit allem, was die KI auf diesem Stick weiß. Kein Admin, keine Installation, kein Fenster, das offen bleiben muss.
2. Jeder Stick hat seine eigene KI. Zwei Sticks am selben Laptop sehen nichts voneinander, auch nicht über den Browser.
3. Ausnahme: Man koppelt zwei Sticks. Dann teilen sie ihr Wissen und bleiben abgeglichen.

Die Oberfläche soll schwarz-weiß und schlicht sein, alles geht per Knopfdruck, nichts wird erklärt.

---

## 0. Grundlage

### 0.1 Nachprüfung der Befunde „blockiert“ und „hoch“

Jeden Befund dieser beiden Schweregrade habe ich selbst am heutigen Code nachgeprüft. Meine Versuche liegen unter `versuche/bauplan-pruefung/`:
- `p1-start-sperren.js`
- `p2-abgleich.js`
- die erneuten Läufe von `v2-dritter`, `v3-was-reist-mit`, `v4-konflikte` und `v5-browser`
- `uv-win-process.c`, der libuv-Quelltext v1.51.0, also die libuv von Node 22.22.2

**Kein Befund fliegt raus.** Zwei Befunde sind in Teilen eine Annahme, einer ist in einem Teil schon erledigt.

| # | Befund (Prüfer) | Ergebnis | Wie geprüft |
|---|---|---|---|
| 1 | Stick bringt nur die Laufzeit des eigenen Systems mit (windows-mac) | **bestätigt** | `src/http/api/stick.js:447-454` setzt `includeRuntimes=true`; `resolvePlatforms()` in `src/portable/stick.js:1438-1458` macht daraus `extra=[]` |
| 2 | Fenster zu: kein sauberes Ende, PID-Sperren blockieren später (windows-mac, starten) | **bestätigt** | p1d: SIGHUP beendet den Prozess mit `sig:"SIGHUP"`, **beide** Sperren bleiben liegen, es kommt keine Meldung „schließe sauber“. p1b: `{pid:1}` in `data/.lock` bzw. `vault/.lock` führt zur Startverweigerung. Die Node-Doku sagt: „SIGHUP is generated on Windows when the console window is closed … terminated by Windows about 10 seconds later“ (`scratchpad/process.md:774`) |
| 3 | Kompaktierung löscht die Segmente ohne fsync (windows-mac) | **bestätigt**; Datenverlust beim Abziehen = **Annahme** | p1c, Aufrufreihenfolge: `writeFileSync(snapshot.tmp) → renameSync → unlinkSync(00001.jsonl)`, **kein** `fsyncSync` |
| 4 | Absolute Ordnerpfade im Tresor ohne Rechnerbindung (windows-mac) | **bestätigt**; „liest die Dokumente des fremden PCs“ = **Annahme** | `src/store/schema.js:365` speichert `watch.path` als String; `src/store/watch.js:1143` hängt beim Start jeden eingeschalteten Satz an |
| 5 | Stick mit PIN/Verschlüsselung startet nicht (starten, koppeln) | **bestätigt** | p1a: `createApp` ohne Passphrase meldet `STORAGE_ERROR … Der Vault ist gesperrt`. `app.store.reload` ist `undefined`, der Zweig in `bin/neural-os.js:99-104` kann also nie funktionieren |
| 6 | Alle Starter laufen im Vordergrund („Fenster offen lassen“) (starten) | **bestätigt** | `tools/launchers/start-windows.bat:51-56,112`, `start-macos.command:130-137,153` |
| 7 | Zweiter Doppelklick bringt eine englische Fehlermeldung statt des Browsers (starten) | **bestätigt** | `src/app.js:870-873` („Another Neural OS instance …“); der Starter meldet dann „Versuche es im abgesicherten Modus“ |
| 8 | Veraltete Sperre wird nur an der PID erkannt (starten) | **bestätigt** | wie Nr. 2 (p1b) |
| 9 | Alle Sticks teilen den Browser-Ursprung 127.0.0.1:7777 (starten, eigene-ki) | **bestätigt** | v5 lief erneut gegen den heutigen Code. B liest den Klartext-Entwurf von A. B wird vom Service Worker aus A gesteuert. Ein Cookie von Port 7811 ist auch auf 7812 sichtbar |
| 10 | Ordner-Abgleich ist nirgends angeschlossen (eigene-ki, koppeln) | **bestätigt** | `grep createFolderSync`: nur `folder.js`, `test/folder-sync.test.js`, `tools/feature-check.js` |
| 11 | „Datenbestand mitnehmen“ und jede Ordnerkopie klonen die Geräte-Kennung (eigene-ki, koppeln) | **bestätigt** | Code in `stick.js:161,1816`. p2a: gleiche Kennung, **0 Partner** in drei Läufen, `ok:true`, nichts wird ausgetauscht, nur **ein** Postfach im Ordner |
| 12 | Zwillinge drehen ein drittes Gerät still zurück (eigene-ki) | **bestätigt** | v2-dritter erneut: C steht wieder auf v0, „Konflikte bei C: 0, angewendet: 1“ |
| 13 | Rohkopie nimmt Gerätesachen mit (eigene-ki) | **bestätigt**, ein Teil **erledigt** | v3 erneut: `server.host 0.0.0.0`, Freigabe an, `network.mode online`, `token`-Satz, rohes `peer.token`, `watch C:\Users\…` an. **Erledigt durch dc847ac:** `apiKey` in `config.json` gibt es nicht mehr. Der Claude-Schlüssel liegt jetzt in `vault/claude-schluessel.json` (`src/models/claude.js:100`) und würde bei der Rohkopie trotzdem mitreisen |
| 14 | Browser: B sieht den Entwurf von A (eigene-ki) | **bestätigt** | v5 erneut |
| 15 | Offener Tab von A schreibt in den Tresor von B (eigene-ki) | **bestätigt** | v5 erneut: `POST /api/chats` aus dem alten Tab gibt HTTP 200, der Chat liegt danach in B |
| 16 | Zwei Sticks mit PIN gleichen nicht ab (koppeln) | **bestätigt** | p2f: in beiden Richtungen „lässt sich mit dem Schlüssel dieses Geräts nicht öffnen“ |
| 17 | Postfach und Zustandsdatei hängen an derselben Verschlüsselungs-Naht (koppeln) | **bestätigt** (Bauvorgabe, heute ohne Fehlverhalten) | `folder.js:201` hat **ein** `vaultCrypto` für `saveState` (383-394) und für das Postfach |
| 18 | Postfach älter als 5 min gilt als „falsche Uhr“ (koppeln) | **bestätigt** | p2b: „Die Uhr von B weicht um 93600 Sekunden ab“, die Löschung wird zum Konflikt, 1 offener Konflikt |
| 19 | Ältere vollständige Postfach-Kopie setzt still zurück (koppeln) | **bestätigt** | p2d: B hatte v3, liest die alte Kopie und hat danach **v2**, mit 0 Konflikten und 0 offenen |
| 20 | Falscher Konflikt, obwohl nur eine Seite geändert hat (koppeln) | **bestätigt** | p2c: `applied 0, conflicts 1`. Ursache ist `merge.js:181` (`if (!bh) return 'conflict'`) |
| 21 | Widersprüchlich entschiedene Konflikte laufen dauerhaft auseinander (koppeln) | **bestätigt** | v4 erneut: A behält „Fassung A“, B behält „Fassung B“, danach 0 offene Konflikte und drei stille Läufe |
| 22 | Fremde Postfächer werden mitgelesen (koppeln) | **bestätigt** | p2e: A übernimmt „Werbung vom Fremden“ |
| 23 | Stick-Kopie hat dieselbe Kennung (koppeln) | **bestätigt** | wie Nr. 11 |

Hinweise zu Befunden der Schwere „mittel“ und „niedrig“, die ich nebenbei geprüft habe:
- `src/portable/model.js` ist schon entfernt.
- Der Willkommenstext in `seedIfEmpty` enthält weiterhin `app.paths.home` (`src/app.js:781`). Die doppelte Einführung beim Koppeln bleibt also bestehen, nur mit neuen Titeln.
- libuv: `detached` setzt unter Windows `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` (belegt, `uv-win-process.c:1052-1063`).
- Nicht abgelöste Kinder landen in einem Job mit `KILL_ON_JOB_CLOSE` (belegt, :75-120, :1084-1100).
- `CREATE_NO_WINDOW` kommt **nur** dazu, wenn kein stdio-Eintrag geerbt wird (belegt, :1034-1042).
- libuv setzt `SetErrorMode(SEM_FAILCRITICALERRORS …)` (belegt, `src/win/core.c:181`). Leere Laufwerke lösen deshalb keinen Dialog aus.

### 0.2 Entscheidungen bei Widersprüchen

| Frage | Entscheidung | Ein Satz Begründung |
|---|---|---|
| Port je Stick: `7700+…mod 300` (eigene-ki), `20000+…mod 20000` (windows-mac) oder `20000+…mod 10000` (starten) | **`20000 + (parseInt(sha256(kiId)[0..7],16) mod 10000)`**, beim Anlegen in `config.server.port` gespeichert | 300 Plätze kollidieren zu oft; 20000–29999 liegt über allen von Browsern gesperrten Ports und unter den Ephemeral-Bereichen (Annahme: Windows/macOS ab 49152, Linux ab 32768). |
| Rechner-Kennung: MachineGuid/IOPlatformUUID (windows-mac) oder Hostname + Bootzeit (starten) | **Hostname-Hash + Bootzeit**, kein Kindprozess | `reg.exe` ist an Schulen oft per Richtlinie gesperrt (Annahme), während `os.hostname()` und `os.uptime()` immer gehen; die Gesundheitsabfrage fängt verbleibende Irrtümer ab. |
| Sperre frisch halten: `at` alle 15 s neu schreiben (windows-mac) oder Gesundheitsabfrage (starten) | **Gesundheitsabfrage `/api/health` mit Instanz-Kennung**, kein Herzschlag in Dateien | Ein Herzschlag schreibt dauernd auf den USB-Stick, die Abfrage beweist dagegen, dass wirklich *dieser* Server antwortet. |
| Mac-Starter: sofort `.app` (windows-mac) oder erst `.command` (starten) | **`.command` jetzt, `.app` erst nach dem Probelauf (Paket M)** | Das `.command` ist bewährt, beim unsignierten Skript-Bündel sind Gatekeeper und TCC Annahmen. |
| Ordnung auf dem Stick: Versteck-Attribute (windows-mac) oder Ordner „Inhalt“ (starten) | **Ordner „Inhalt“**, keine Versteck-Attribute | Versteck-Attribute brauchen je System ein anderes Werkzeug, ihr Verhalten am Mac ist Annahme, und `data/` muss für Sicherungen sichtbar bleiben. |
| KI mitnehmen: Rohkopie ohne `deviceId` (koppeln, windows-mac) oder über die Sicherung (eigene-ki) | **Keines von beiden: Die Rohkopie entfällt; beim Vorbereiten gibt es [Neue KI] und [Mit dieser KI gekoppelt]** | Gleiches Wissen auf zwei Sticks *ist* Koppeln; eine dritte, ungekoppelte Klonart widerspricht dem Wunsch des Nutzers und nimmt Freigaben, Token und Schlüssel mit (belegt, v3). |
| Einwilligung beim Koppeln: beide Sticks laufen gleichzeitig (eigene-ki) oder Angebot als Datei (koppeln) | **Angebotsdatei, B muss nicht laufen** | Wer beide Sticks in der Hand hat und die PIN von B kennt, darf koppeln; ein zweiter Klick auf B brächte einen Schritt mehr, aber keine Sicherheit. |
| Konflikte: nachfragen (heute) oder „beide behalten“ (koppeln) | **Beide Fassungen behalten, ohne Rückfrage, auf beiden Sticks gleich** | Rückfragen müssten auf beiden Sticks beantwortet werden und laufen bei widersprüchlichen Antworten still auseinander (belegt, v4). |
| Einigung nach dem Kopieren: `saeeEinigung` (eigene-ki) oder mitgereiste Basis (koppeln) | **Mitgereiste Basis im Postfach** | Ohne Rohkopie gibt es nichts mehr zu säen, und die mitgereiste Basis behebt auch den falschen Konflikt aus p2c. |
| Stick gezogen: Schreibsperre plus Anzeige (windows-mac) oder sofort beenden (starten) | **Sofort beenden, ohne flush** | `node.exe` liegt selbst auf dem Stick, und ein Server ohne Stick kann nichts mehr retten, nur Daten aus dem Speicher ausliefern (belegt, c1). |
| Leerlauf: 3 min (starten) | **10 min ohne offenen Tab**, 5 min Schonfrist nach dem Start | Schlafende Tabs und kurze Pausen sollen die App nicht beenden; den häufigen Fall „Stick gezogen“ deckt der Stick-Wächter ab. |
| Entsperren bei PIN: im Konsolenfenster (starten, Stufe 1) oder im Browser | **Im Browser, über einen „Vorraum“** (Paket V) | Das Konsolenfenster verschwindet ja gerade, und die PIN-Oberfläche baut der andere Ablauf ohnehin im Browser. |
| `Clear-Site-Data` beim Beenden (windows-mac, starten) | **Nein** | Ob Safari es unterstützt, ist Annahme, es würde „Gerät merken“ aus dem PIN-Ablauf löschen, und mit Port je KI plus einer Positivliste in `lokal.js` liegt ohnehin kein Inhalt mehr im Browser. |
| Nur-Lesen-Betrieb bei schreibgeschütztem Stick (windows-mac) | **Nein**, es gibt eine Ein-Satz-Meldung | Der Tresor öffnet heute nicht ohne Schreibzugriff, und der Umbau stünde in keinem Verhältnis zum seltenen Fall. |

### 0.3 Regeln für alle Pakete

- Keine neue Abhängigkeit, kein Admin, keine Installation. Erlaubt sind nur Node-Bordmittel und Werkzeuge, die das System mitbringt (`cmd`, `sh`, `xattr`, `/sbin/mount`).
- Jeder Netzzugriff geht über `src/net/gate.js`.
- Meldungen sind deutsch, bestehen aus einem Satz und erklären nichts. Die genauen Texte stehen in Teil 1.8, die Oberfläche übernimmt sie wörtlich.
- `localStorage`/`sessionStorage` gibt es nur in `web/lib/lokal.js` (Paket W1).
- Jeder `spawn` in einem Prozess ohne Konsole setzt `windowsHide: true` (Annahme, Windows-Regel).
- Tests laufen mit `npm test`. Das ist `test/run.js` mit dem eigenen Harness `test/harness.js` (`test`, `tempHome`). Jeder im Plan genannte Test muss **vor** dem Paket rot und **nach** dem Paket grün sein. Wer umsetzt, zeigt beides im Protokoll.
- Andere Abläufe arbeiten gleichzeitig: Umbau von `web/**` und `src/portable/stick.js`, Einstellungen, PIN, Claude. Wer ein Paket beginnt, prüft zuerst die unter „Voraussetzung“ genannten Befehle. Ist ein fremder Umbau nicht fertig, **wartet** das Paket und greift nicht vor.

---

## 1. Was der Nutzer erlebt

### 1.1 Was auf dem Stick liegt (Explorer bzw. Finder)

```
NEURAL OS (E:)
  Inhalt                          (Programm, Daten, Abgleich: nicht anfassen)
  LIESMICH
  Neural OS starten - Mac
  Neural OS starten - Windows
```

Ein Doppelklick bleibt nötig. Windows und macOS starten aus Schutzgründen nichts von selbst vom Stick; AutoRun für USB ist bei Windows abgeschaltet (Annahme, allgemein bekannt).

`LIESMICH` hat genau fünf Zeilen:

```
Windows:  "Neural OS starten - Windows" doppelklicken.
Mac:      "Neural OS starten - Mac" doppelklicken.
Fertig:   in der App auf "Beenden".
Deine Daten liegen im Ordner "Inhalt". Sichern = ganzen Stick kopieren.
Geht etwas nicht, steht der Grund im Fenster, das dann offen bleibt.
```

### 1.2 Windows

1. Den Stick einstecken, im Explorer öffnen und **„Neural OS starten - Windows“** doppelklicken.
2. Ein schwarzes Fenster zeigt eine Zeile: **„Neural OS startet …“**. Dauert es länger als 10 s, kommt **„Neural OS startet … (dauert noch)“** dazu.
3. Der Browser öffnet `http://127.0.0.1:2xxxx/`. Die Adresse ist für diesen Stick immer dieselbe. Die App zeigt alles, was die KI auf diesem Stick weiß, und oben steht der Name der KI.
4. Das schwarze Fenster **schließt sich von selbst**. Ob es wirklich ganz verschwindet und nicht nur kurz aufblitzt, ist Annahme und wird im Probelauf geprüft.
5. Hat der Stick eine PIN, zeigt der Browser zuerst nur: **„PIN“** [Feld] **[Öffnen]**. Bei falscher Eingabe erscheint **„Falsche PIN.“**, nach fünf Fehlversuchen **„Zu oft falsch. Kurz warten.“**
6. **Noch einmal doppelklicken:** Es öffnet sich nur der Browser mit derselben Adresse. Ein zweites Neural OS startet nicht.

Geht etwas schief, bleibt das Fenster offen und zeigt genau einen der folgenden Sätze, dann folgt „Taste drücken“:
- **„Dieser Rechner lässt keine Programme vom Stick starten.“**
- **„Auf diesem Stick fehlt das Programm für Windows.“**
- **„Der Stick ist schreibgeschützt.“**
- **„Neural OS konnte nicht starten:“**, gefolgt von den letzten Zeilen des Protokolls

### 1.3 Mac (MacBook)

1. Den Stick einstecken, im Finder öffnen und **„Neural OS starten - Mac“** doppelklicken.
2. Beim ersten Mal fragt macOS vielleicht: „„Terminal“ möchte auf Dateien auf einem Wechseldatenträger zugreifen.“ → **Erlauben**. Ob die Frage kommt, ist Annahme (Probelauf).
3. Ein Terminal-Fenster zeigt **„Neural OS startet …“** und danach **„Fertig. Dieses Fenster kann zu.“**
4. Der Browser öffnet sich, wie unter Windows. Den Rest schließt ⌘W; Neural OS läuft weiter.
5. Ein Mac-Fenster ganz ohne Terminal kommt erst mit Paket M, und nur dann, wenn der Probelauf es erlaubt.

Mögliche Fehlersätze (das Fenster bleibt offen):
- **„Dieser Mac ist zu alt. Nötig ist macOS 11 oder neuer.“** Belegt: Die mitgelieferte Node 22 verlangt macOS ab 11.0.
- **„macOS hat den Start blockiert: Systemeinstellungen › Datenschutz & Sicherheit › Dennoch öffnen.“**
- **„Auf diesem Stick fehlt das Programm für den Mac.“**
- **„Der Stick ist schreibgeschützt.“**
- **„Neural OS konnte nicht starten:“** + Grund

### 1.4 Beenden, Abziehen, Vergessen

- In der App auf **[Beenden]** tippen. Der Platz des Knopfs gehört zum Oberflächen-Umbau, die Beschriftung ist festgelegt. Die Seite zeigt dann nur noch:
  - Windows: **„Gespeichert. Stick kann raus.“**
  - Mac: **„Gespeichert. Stick im Finder auswerfen.“** Das automatische Auswerfen kommt erst mit Paket M.
- Stick **ohne Beenden gezogen**: Neural OS beendet sich innerhalb von etwa 4 s von selbst. Ein offener Tab zeigt **„Neural OS ist aus.“** und darunter **„Zum Öffnen den Starter auf dem Stick doppelklicken.“** Von der KI bleibt nichts sichtbar.
- **Browser zu, Stick steckt noch:** Nach 10 min ohne offenen Tab beendet sich Neural OS selbst. Zum Weitermachen wieder doppelklicken.
- Auf dem Laptop bleibt nichts Inhaltliches zurück: kein Entwurf und kein Service-Worker-Cache. Im Browserverlauf stehen nur Adressen.

### 1.5 Zweiter Stick am selben Laptop

- Stick B einstecken und seinen Starter doppelklicken. B öffnet sich unter **einer anderen Adresse** in einem eigenen Tab, mit eigenem Namen oben. B zeigt nur das Wissen von B.
- A und B können **gleichzeitig** laufen; keiner sieht etwas vom anderen, auch nicht im Browserspeicher.
- Ein alter Tab von A, nachdem A beendet wurde, zeigt **„Neural OS ist aus.“** und nie Daten von B.
- In der Stick-Ansicht von A erscheint B als **„Anderer Stick: Lena“ [Koppeln]**. Ohne Klick passiert nichts.

### 1.6 Einen neuen Stick anlegen (in der laufenden App, Stick-Ansicht)

- Einen leeren Stick einstecken. Die Karte zeigt **„Leerer Stick: E:\ · 14,2 GB frei“** mit **[Neue KI]** und **[Mit dieser KI gekoppelt]**.
- Hat *diese* KI eine PIN, bekommt [Mit dieser KI gekoppelt] ein Feld **„PIN für den neuen Stick“**. Gekoppelte Sticks sind entweder beide geschützt oder beide nicht.
- Während der Arbeit steht dort **„Wird vorbereitet … 42 %“**, danach **„Fertig. Stick kann raus.“**
- Fehlen noch Laufzeiten, erscheint **„Läuft bisher nur an Windows.“ [Für Mac holen]** bzw. **„Läuft bisher nur am Mac.“ [Für Windows holen]**. Ohne Internet: **„Ohne Internet geht das nicht.“**
- Wohnt auf dem Stick schon eine KI und man wählt [Neue KI]: **„Auf diesem Stick wohnt schon eine KI.“** Es wird nichts überschrieben.
- Am Mac vorbereitet und mit APFS formatiert: **„Windows sieht diesen Stick nicht.“**
- Ein Stick mit älterem Programm: **„Programm auf dem Stick ist älter.“ [Erneuern]**

### 1.7 Koppeln

1. A läuft, Stick B steckt. B muss nicht laufen. Die Stick-Ansicht von A zeigt **„Anderer Stick: Lena“ [Koppeln]**.
2. Hat B eine PIN, kommt das Feld **„PIN von Lena“** dazu, dann [Koppeln]. Falsch: **„Falsche PIN.“**
3. Ist die Schutzstufe ungleich:
   - **„Lena hat eine PIN, dieser Stick nicht.“ [PIN festlegen]**
   - umgekehrt: **„Dieser Stick hat eine PIN, Lena nicht.“**
4. Danach steht dort **„Gekoppelt mit Lena · abgeglichen 14:03“ [Jetzt abgleichen] [Entkoppeln]**. Wenn B noch nie danach lief: **„Gekoppelt mit Lena · Lena übernimmt beim nächsten Start“**.
5. B zeigt beim nächsten Start einmal kurz: **„Gekoppelt mit Max.“**
6. Ab jetzt wird **automatisch** abgeglichen, ohne Knopf und ohne Meldung:
   - bei jedem Start;
   - wenn der Partner-Stick eingesteckt wird (Suchlauf alle 15 s);
   - 20 s nach der letzten Änderung;
   - beim Beenden.
7. Steckt B nicht: **„Gekoppelt mit Lena · zuletzt gestern 16:40“ [Entkoppeln]**
8. Haben beide denselben Eintrag verschieden geändert: **„„Einkaufsliste“ gab es zweimal verschieden – beide sind da.“ [Ansehen]**. Die zweite Fassung heißt „Einkaufsliste (Fassung von Lena)“. Wer sie nicht will, löscht sie.
9. **[Entkoppeln]** fragt in der Seite nach: **„Entkoppeln? Beide behalten, was sie wissen.“ [Entkoppeln] [Abbrechen]**
10. Ist ein Stick eine Kopie eines anderen: **„Zwei Sticks tragen dieselbe KI.“ [Diesen Stick eigenständig machen]**
11. Unterschiedliche Programmstände: **„Lena hat eine ältere Version.“ [Lena erneuern]** bzw. **„Lena hat eine neuere Version.“**
12. Bei drei Sticks: **„Gekoppelt mit Lena (über Lena auch: Tom)“**

**Was geteilt wird:** Notizen, Projekte, Aufgaben, Termine, Begriffe, Erinnerungen, Chats, Nachrichten, Verknüpfungen und Löschungen (`merge.SYNC_TYPES`). Anhänge folgen mit Paket K2.

**Was nicht geteilt wird:** der Claude-Schlüssel, die PIN, Einstellungen, Agenten, Zeitpläne, beobachtete Ordner und Freigaben.

### 1.8 Alle Texte auf einen Blick (wörtlich übernehmen)

| Ort | Text | Knöpfe |
|---|---|---|
| Starter | Neural OS startet … / … (dauert noch) | – |
| Starter Mac, Erfolg | Fertig. Dieses Fenster kann zu. | – |
| Starter, Fehler | Dieser Rechner lässt keine Programme vom Stick starten. · Auf diesem Stick fehlt das Programm für Windows. · Auf diesem Stick fehlt das Programm für den Mac. · Dieser Mac ist zu alt. Nötig ist macOS 11 oder neuer. · macOS hat den Start blockiert: Systemeinstellungen › Datenschutz & Sicherheit › Dennoch öffnen. · Der Stick ist schreibgeschützt. · Neural OS konnte nicht starten: | – |
| Vorraum | PIN · Falsche PIN. · Zu oft falsch. Kurz warten. | [Öffnen] |
| Nach Beenden | Gespeichert. Stick kann raus. · (Mac) Gespeichert. Stick im Finder auswerfen. | – |
| Verbindung weg | Neural OS ist aus. / Zum Öffnen den Starter auf dem Stick doppelklicken. | – |
| Stick-Ansicht | Leerer Stick: E:\ · 14,2 GB frei · PIN für den neuen Stick · Wird vorbereitet … 42 % · Fertig. Stick kann raus. · Läuft bisher nur an Windows. · Läuft bisher nur am Mac. · Ohne Internet geht das nicht. · Auf diesem Stick wohnt schon eine KI. · Windows sieht diesen Stick nicht. · Programm auf dem Stick ist älter. | [Neue KI] [Mit dieser KI gekoppelt] [Für Mac holen] [Für Windows holen] [Erneuern] |
| Kopplung | Anderer Stick: Lena · PIN von Lena · Falsche PIN. · Lena hat eine PIN, dieser Stick nicht. · Dieser Stick hat eine PIN, Lena nicht. · Gekoppelt mit Lena · abgeglichen 14:03 · Gekoppelt mit Lena · zuletzt gestern 16:40 · Gekoppelt mit Lena · Lena übernimmt beim nächsten Start · Gleiche ab … · Gekoppelt mit Max. · „X“ gab es zweimal verschieden – beide sind da. · Entkoppeln? Beide behalten, was sie wissen. · Zwei Sticks tragen dieselbe KI. · Lena hat eine ältere Version. · Lena hat eine neuere Version. · Gekoppelt mit Lena (über Lena auch: Tom) | [Koppeln] [Jetzt abgleichen] [Entkoppeln] [Abbrechen] [Ansehen] [PIN festlegen] [Diesen Stick eigenständig machen] [Lena erneuern] |
| Einstellungen | Name dieser KI | – |
| Beobachtete Ordner | Gehört zu einem anderen Rechner. · Hier liegt eine Neural-OS-KI. | – |

---

## 2. Arbeitspakete

### 2.0 Wellen, Abhängigkeiten, Dateibesitz

```
Welle 0 (sofort, parallel):   G Grundbausteine   P Probelauf
Welle 1 (nach G, parallel):   H Haltbar   S Start ohne Fenster   V Vorraum   I Eigene KI   O Ordner je Rechner   K1 Koppeln-Kern
Welle 2 (nach dem fremden Umbau von stick.js bzw. web/**):   R Stick vorbereiten   W1 Oberfläche-Grundschicht   W2 Oberfläche-Ansichten
Welle 3:                      K2 Dateien im Postfach (nach K1)   M Mac ohne Terminal/Auswerfen (nur nach Probelauf)   D Doku (zuletzt)
```

**Wem welche Datei gehört.** Nur der Besitzer ändert die Datei. Ausnahmen sind genau benannt und betreffen getrennte Stellen. Wer später kommt, rebased.

| Datei | Besitzer | Kleine, benannte Mitänderung durch |
|---|---|---|
| `src/kernel/rechner.js`, `dateien.js`, `identitaet.js` (neu) | G | – |
| `tools/probelauf.js`, `tools/launchers/probelauf-windows.bat`, `probelauf-macos.command` (neu) | P | – |
| `src/store/engine.js`, `src/kernel/config.js`, `src/store/history.js` | H | – |
| `bin/neural-os.js`, `src/kernel/log.js`, `src/portable/open.js`, `tools/launchers/start-*.{bat,command,sh}` | S | – |
| `src/kernel/laufzettel.js`, `src/kernel/waechter.js`, `src/http/api/beenden.js` (neu) | S | – |
| `src/http/server.js` | S (listen, `/api/health`, Aktivitätszähler) | I: eine Zeile `guardKi(req)` neben `guardCsrf(req)`; K1: eine Zeile in der Routenliste (324-342) |
| `src/app.js` | I (Identitätsblock direkt nach `validateConfig`, `seedIfEmpty`) | S: nur `acquireLock`/`isProcessAlive` am Dateiende; K1: nur der Block „device synchronisation“ und ein Eintrag in der `close()`-Liste |
| `src/kernel/vorraum.js`, `web/entsperren.html` (neu) | V | – |
| `src/kernel/paths.js`, `src/sync/peer.js`, `src/http/auth.js`, `src/http/api/system.js` | I | – |
| `src/kernel/ortspfad.js` (neu), `src/store/watch.js`, `src/store/schema.js`, `src/agents/permissions.js`, `src/agents/tools.js`, `src/modules/sandbox.js` | O | – |
| `src/sync/folder.js`, `src/sync/merge.js` | K1, danach K2 | – |
| `src/sync/kopplung.js`, `src/http/api/kopplung.js` (neu) | K1 | – |
| `tools/feature-check.js` (nur der Abschnitt Ordner-Abgleich, heute ab Zeile 1106) | K1, **nach** dem Commit des anderen Ablaufs, der die Datei gerade ändert | – |
| `src/portable/stick.js`, `src/http/api/stick.js` | R, **nach** dem fremden Stick-Umbau | – |
| `web/**` | W1/W2, **nach** dem fremden Oberflächen-Umbau | V legt nur die neue Datei `web/entsperren.html` an |
| `docs/**`, `README.md` | D | – |

Neue Testdateien gehören dem jeweiligen Paket. Bestehende Tests passt nur ihr Besitzer an:
- `test/integration.test.js:329-334` → S
- `test/stick.test.js` → R
- `test/folder-sync.test.js` → K1
- `test/watch.test.js` → O
- `test/sync.test.js` → I

---

### 2.1 Paket G – Grundbausteine (Welle 0, klein)

**Ziel:** Drei neue Module mit festen Schnittstellen, damit Welle 1 parallel bauen kann.

**Dateien (alle neu):**
- `src/kernel/rechner.js`
- `src/kernel/dateien.js`
- `src/kernel/identitaet.js`
- `test/grundbausteine.test.js`

**Schnittstellen (verbindlich):**

```js
// src/kernel/rechner.js
kennung()      // sha256('nos-rechner|' + os.hostname().toLowerCase()).hex.slice(0,16)   -- für Sperren
profil()       // sha256('nos-profil|' + hostname + '|' + os.userInfo().username).slice(0,16) -- für Ordnerpfade; userInfo darf werfen -> ''
bootZeit()     // Math.round(Date.now()/1000 - os.uptime())
gleicherStart(a, b) // Math.abs(a - b) <= 120

// src/kernel/dateien.js
schreibeDauerhaft(ziel, inhalt, { modus = 0o600 } = {})
  // tmp im selben Ordner (".<name>.tmp-<pid>-<zufall>") -> openSync/writeSync/fsyncSync/closeSync
  // -> umbenennen(tmp, ziel) -> fsyncOrdner(dirname(ziel)); bei Fehler tmp löschen und werfen
umbenennen(von, nach)
  // win32: bis 2 s Wiederholung bei EPERM/EACCES/EBUSY (Backoff 20, 40, 80, … ms); sonst fs.renameSync
fsyncOrdner(dir)            // wie folder.js:152-162 (Fehler still schlucken; unter Windows geht das nicht)
OS_BEGLEITDATEIEN           // [/^\._/, '.DS_Store', '.Trashes', '.fseventsd', '.Spotlight-V100', '.TemporaryItems',
                            //  '.apdisk', '.VolumeIcon.icns', '.metadata_never_index', 'System Volume Information',
                            //  '$RECYCLE.BIN', 'desktop.ini', 'Thumbs.db']
istBegleitdatei(name)       // Groß/Klein egal

// src/kernel/identitaet.js
kiPort(id)                  // 20000 + (parseInt(sha256(id).slice(0,8), 16) % 10000)
createIdentitaet({ config, paths, portable, speichern })  -> {
  get id(), get name(), get port(),
  sicherstellen(),   // config.sync.deviceId (dev_ + 24 hex) und config.sync.deviceName anlegen, falls sie fehlen;
                     // portabel UND config.server.port === 7777 -> kiPort(id); speichern(config)
  pruefeMarker(),    // nur portabel: marker.kiId fehlt -> kiId und name in den Marker schreiben;
                     // marker.kiId !== id -> erneuern('daten-kopiert')
  erneuern(grund),   // neue deviceId, neuer Port (portabel); löscht <home>/sync-folder.json und <home>/kopplungen.json;
                     // speichert, schreibt den Marker neu, publish('ki.erneuert', {grund})
  umbenennen(name),  // 1..60 Zeichen; config.sync.deviceName + Marker
}
standardName(portable, id)  // Mac/Linux: Datenträgername aus /Volumes/<X>, /media/<u>/<X>, /run/media/<u>/<X>,
                            // wenn er nicht generisch ist (NO NAME, UNTITLED, Untitled, USB, USB DISK);
                            // sonst 'KI ' + id.slice(4,8).toUpperCase()
```

Der Marker wird mit `schreibeDauerhaft` geschrieben. Alle vorhandenen Felder bleiben erhalten, nur `kiId` und `name` werden gesetzt.

**Tests (heute rot, weil die Module fehlen):**
- `kiPort` liegt für 1000 Zufalls-IDs in 20000–29999 und ist für dieselbe ID stabil.
- `umbenennen` mit einem eingespielten fs, das zweimal `EPERM` und dann Erfolg liefert, gelingt unter `platform:'win32'` und wirft unter `linux` sofort.
- `schreibeDauerhaft`: Die Aufrufreihenfolge `fsyncSync(tmp-fd)` vor `renameSync` vor `fsyncSync(ordner-fd)` wird mit einem Spion auf `fs` geprüft.
- `pruefeMarker`: Temp-Stick mit Marker `kiId: dev_a…`, `config.json` mit `dev_b…` → danach neue ID, `sync-folder.json` und `kopplungen.json` gelöscht, Marker aktualisiert.
- `istBegleitdatei('._.app.old-deadbeef') === true`, `istBegleitdatei('app') === false`.

**Abnahme:** Die Tests sind grün. Kein bestehendes Modul wurde verändert.

---

### 2.2 Paket P – Probelauf (Welle 0, unabhängig)

**Ziel:** Ein Doppelklick je Rechner beantwortet alle Annahmen aus Teil 3. Der Probelauf nutzt **genau** den Start-Mechanismus aus Paket S: Starter, abgelöster Dienst, Browser. Er prüft ihn damit gleich mit.

**Dateien (neu):**
- `tools/probelauf.js`, eigenständig: nur Node-Bordmittel, kein `require` aus `src/`
- `tools/launchers/probelauf-windows.bat`
- `tools/launchers/probelauf-macos.command`
- `test/probelauf.test.js`

**Verhalten:**

`node tools/probelauf.js --auf-stick <Stick-Wurzel>` bereitet einen Stick vor. Voraussetzung ist ein Stick, der schon Laufzeiten trägt. Das Skript legt an:
- `Probelauf - Windows.bat`
- `Probelauf - Mac.command`
- `Inhalt/probelauf.js` bzw. `probelauf.js` im alten Aufbau
- `Inhalt/Probe.app`: ein Skript-Bündel mit `Contents/Info.plist` und `Contents/MacOS/probe`. Es wird mit `writeFile` erzeugt, nicht kopiert.

Das Skript startet nichts; es legt nur Dateien ab.

**Starter:** Er wählt Node wie der echte Starter und prüft zuerst `node -e ""`. Scheitert das, steht dort „Dieser Rechner lässt keine Programme vom Stick starten.“, und das ist schon ein Ergebnis. Danach ruft er `probelauf.js --start` auf.

**`--start`:**
1. `spawn(process.execPath, [probelauf.js, '--dienst'], { detached: true, windowsHide: true, stdio: ['ignore','ignore','ignore','ipc'], cwd: os.tmpdir() })`
2. Warten auf `{bereit:{url}}`.
3. `disconnect()` und `unref()`.
4. Den Browser öffnen (`cmd /c start "" url` bzw. `open url`) und mit `exit 0` enden.

**`--dienst`** misst und schreibt alles nach `<Stick>/PROBELAUF/<os>-<rechner.kennung>-<Datum>.json`:
- **Immer:** Betriebssystem, Version, Architektur, Node-Version und Bootzeit.
  - „Starter-PID beendet, Dienst lebt weiter“: Der Dienst prüft dazu 30 s lang `process.kill(ppid,0)`.
  - Zeit vom Starter bis „bereit“.
  - Schreibprobe auf dem Stick.
  - 300 × „tmp schreiben + rename über bestehende Datei“ mit Anzahl und Art der Fehler (`EPERM`/`EBUSY`) und der Gesamtzeit.
  - fsync-Dauer.
  - Bindeprobe auf 20 Ports aus 20000–29999, jeweils mit dem Fehlercode.
- **Windows:**
  - `powershell -NoProfile -NonInteractive -Command "$ExecutionContext.SessionState.LanguageMode; [IO.DriveInfo]::new('<L>:\').DriveFormat"` mit `windowsHide`: Ausgabe und Exit-Code.
  - `netsh int ipv4 show excludedportrange protocol=tcp`: die Ausgabe.
  - Die Namen der Verben von `(New-Object -ComObject Shell.Application).Namespace(17).ParseName('<L>:').Verbs()`. Nur auflisten, **nicht** ausführen.
  - `fs.promises.stat` auf `D:\`–`Z:\` mit Dauer und Fehlercode je Buchstabe, Zeitgrenze 3 s.
- **Mac:**
  - `sw_vers -productVersion`, `uname -m`
  - `/usr/bin/arch -x86_64 /usr/bin/true` (Exit-Code: Rosetta vorhanden?)
  - die Zeile aus `/sbin/mount` für den Stick (Typ, `read-only`, `noexec`, `noowners`)
  - `diskutil info -plist <Einhängepunkt>`, davon nur `FilesystemType`, `WritableVolume`, `Ejectable`, `Removable`
  - `xattr -l` auf Starter und Laufzeit (Quarantäne?)
  - Modus-Bits von drei Dateien
  - `EPERM` beim Lesen von `app/` (TCC)
- **Browserseite** (inline, schwarz-weiß):
  - misst selbst `navigator.userAgent`, ob `localStorage`/`sessionStorage` gehen und ob `serviceWorker` da ist;
  - stellt höchstens drei Ja/Nein-Fragen:
    - Windows: „Ist ein schwarzes Fenster offen geblieben?“ · „Kam eine Warnung (SmartScreen, Virenschutz)?“
    - Mac: „Ist das Terminal-Fenster noch offen?“ · „Hat macOS nach Zugriff auf einen Wechseldatenträger gefragt?“
  - Nur am Mac zusätzlich: **„Jetzt im Ordner Inhalt „Probe“ doppelklicken.“** Das `.app` meldet sich per HTTP beim Dienst und schreibt `PROBELAUF/app-gestartet.txt`. Kommt nach 60 s nichts, fragt die Seite: „Kam eine Meldung?“
  - Knöpfe **[Ergebnis kopieren]** (kurzer Text zum Einfügen in den Chat; `127.0.0.1` gilt als sicherer Kontext, Annahme) und **[Fertig]** (beendet den Dienst).

**Tests (heute rot, weil das Skript fehlt):**
- `--trocken` unter Linux liefert JSON mit allen Pflichtfeldern.
- `--start` in einem Temp-Ordner ohne TTY endet in unter 10 s mit Exit 0. Der Dienst lebt danach weiter, seine PPID ist nicht mehr der Starter, und `/proc/<pid>/cwd` liegt nicht im Stick-Ordner.
- `--auf-stick` legt genau die fünf Dateien an: die beiden Starter, die `.bat` mit CRLF, `probelauf.js` und das `.app` mit `Info.plist` und dem ausführbaren Skript.

**Abnahme:** Auf Linux laufen der Probelauf und seine Ergebnisdatei. Der Nutzer bekommt eine Anleitung von **einem Satz** je Rechner (Teil 3).

---

### 2.3 Paket H – Haltbar schreiben und Tresor-Sperre (Welle 1)

**Ziel:**
- Ein Stick, der ohne Beenden gezogen wird, verliert höchstens die letzten ~2 s und nie den ganzen Tresor.
- Die Tresor-Sperre eines anderen Rechners oder eines früheren Starts blockiert nicht mehr.

**Dateien:**
- `src/store/engine.js`
- `src/kernel/config.js`
- `src/store/history.js`
- `test/haltbar.test.js`

**Änderungen:**
1. `compactSync()` (`engine.js:1317-1345`) läuft in dieser Reihenfolge:
   1. `dateien.schreibeDauerhaft(paths.snapshot, body)`, also tmp + fsync + rename + fsync des Ordners;
   2. **dann** `closeFd()`;
   3. **dann** die Segmente löschen;
   4. **dann** `fsyncOrdner(paths.log)`.
2. Blobs in `files.put` (`engine.js:1197-1204`): vor dem `rename` ein fsync der tmp-Datei, danach `umbenennen` und `fsyncOrdner`.
3. Entprelltes Sichern: Jedes `append` plant `flush()` für 2 s nach dem letzten Schreiben. Der Zeitgeber ist `unref`. `close()` räumt ihn ab und macht den flush selbst.
4. `config.save` (`config.js:130-137`) und `history` beim Neuschreiben des Journals (`history.js:402-409`) benutzen `dateien.schreibeDauerhaft`.
5. Tresor-Sperre (`engine.js:244-283`):
   - Inhalt: `{pid, rechner: rechner.kennung(), boot: rechner.bootZeit(), at, scope:'store'}`.
   - **Verwaist**, wenn `rechner` fehlt oder abweicht, wenn `!gleicherStart(boot)` gilt oder wenn die PID tot ist.
   - Alte Sperren ohne `rechner` werden wie heute nach der PID beurteilt.
   - Die Meldung bleibt deutsch.
6. `history.actorOf` (`history.js:501-519`) übernimmt `{kind:'sync', label}` aus dem Ereignis-Akteur: `{kind:'sync', label, via:'kontext'}`. Heute kennt die Funktion nur `agent`.

**Tests (heute rot, belegt):**
- p1c als Test: Die Aufrufreihenfolge in `store.compact()` enthält `fsyncSync` **vor** dem ersten `unlinkSync(<segment>)`.
- `vault/.lock = {pid:1, rechner:'ffff…', boot:…}`: `openStore` gelingt. Heute kommt „Der Vault wird bereits von Prozess 1 verwendet“ (p1b).
- `vault/.lock = {pid:1, rechner:kennung(), boot: bootZeit()-86400}`: gelingt ebenfalls.
- Gegenprobe, bleibt grün: Eine lebende PID eines Kindprozesses mit eigenem Rechner und eigener Bootzeit führt zur Weigerung.
- `config.save` ruft `fsyncSync` auf (Spion).
- Nach 3 Schreibvorgängen und 2,5 s mit einer Uhr-Attrappe wurde `flush` genau einmal aufgerufen.
- Eine Änderung unter `withActor({kind:'sync', label:'Lena'})` erscheint im Journal mit `actor.kind === 'sync'`.

**Abnahme:** Alle Tests sind grün, `test/store.test.js` und `test/history.test.js` unverändert grün. `npm run proof` bleibt grün.

---

### 2.4 Paket S – Start ohne Fenster (Welle 1)

**Ziel:**
- Der Doppelklick startet einen **abgelösten Dienst**, öffnet den Browser, und das Fenster geht zu.
- Es läuft eine Instanz je Stick; der zweite Doppelklick öffnet nur den Browser.
- Sauberes Ende über [Beenden], wenn der Stick fehlt und im Leerlauf.

**Dateien:**
- `bin/neural-os.js`
- `src/kernel/log.js`
- neu: `src/kernel/laufzettel.js`, `src/kernel/waechter.js`, `src/http/api/beenden.js`
- `src/app.js` (nur `acquireLock`/`isProcessAlive` am Dateiende)
- `src/portable/open.js`
- `src/http/server.js` (siehe 2.0)
- `tools/launchers/start-windows.bat`, `start-macos.command`, `start-linux.sh`
- Tests: `test/laufzettel.test.js`, `test/start-dienst.test.js`, `test/waechter.test.js`; anpassen: `test/integration.test.js:329-334`, die Meldung ist jetzt deutsch

**Änderungen:**

1. **Laufzettel** `data/.lock` (`src/kernel/laufzettel.js`):
   ```json
   {"v":2,"pid":1234,"rechner":"<kennung>","boot":1790000000,"seit":"ISO","zustand":"startet|gesperrt|bereit",
    "port":21064,"url":"http://127.0.0.1:21064/","instanz":"<12 Zeichen zufällig>","heim":"<sha256(realpath(home))[0..15]>","version":"0.1.0"}
   ```
   `pruefen(paths)` liefert `frei | laeuft{url} | startet{seit} | verwaist{grund}`. Die Regeln der Reihe nach:
   1. Datei fehlt → frei.
   2. Datei unlesbar → verwaist.
   3. `rechner` weicht ab → verwaist.
   4. `!gleicherStart(boot)` → verwaist.
   5. PID tot → verwaist.
   6. `zustand` ist `bereit` oder `gesperrt` **und** `GET 127.0.0.1:<port>/api/health` antwortet innerhalb von 1,5 s mit gleicher `instanz` und gleichem `heim` → läuft.
   7. `zustand` ist `startet` und das Alter liegt unter 120 s → startet.
   8. Sonst → verwaist; das ist eine wiederverwendete PID.

   Eine alte Sperre `{pid, at}` gilt als verwaist, wenn die PID tot ist oder `at` vor der Bootzeit liegt. Sonst kommt die Meldung „Neural OS läuft schon (ältere Version). Bitte dort beenden.“

   Weitere Funktionen:
   - `anlegen()` legt die Datei mit `'wx'` an. Bei `EEXIST` wird `pruefen()` aufgerufen. Bei *verwaist* wird überschrieben, **und** `vault/.lock` wird gelöscht, wenn es dieselbe PID trägt.
   - `aktualisieren()` schreibt mit `dateien.schreibeDauerhaft`.
   - `freigeben(instanz)` löscht nur die eigene Datei.
   - `acquireLock` in `app.js` bleibt als dünner Wrapper exportiert.

2. **`bin/neural-os.js`:**
   - **`start`** läuft im Vordergrund, wie heute, mit diesen Änderungen:
     - Die Handler für `SIGINT`/`SIGTERM`/`SIGHUP`/`SIGBREAK` → `shutdown()` werden **direkt nach dem Anlegen des Laufzettels** registriert, also vor `boot()` und `listen()`.
     - Farben gibt es nur bei `process.stdout.isTTY`.
     - Der kaputte Zweig `promptSecret` + `store.reload` (Zeilen 99-104) entfällt. Ist der Tresor verschlüsselt und keine Passphrase gegeben, wird `vorraum` aus Paket V aufgerufen.
   - **`start --hintergrund [--open]`**, der **Starter**:
     1. `laufzettel.pruefen()`: *läuft* → Browser öffnen, `exit 0`; *startet* → warten, bis *bereit*.
     2. Schreibprobe in `home`. Scheitert sie → „Der Stick ist schreibgeschützt.“, `exit 1`.
     3. `spawn(process.execPath, [bin, 'dienst', …flags], { detached:true, windowsHide:true, stdio:['ignore','ignore','ignore','ipc'], cwd: os.tmpdir() })`.
        - **Kein** geerbter fd. Damit setzt libuv zusätzlich `CREATE_NO_WINDOW` (belegt, `uv-win-process.c:1034-1042`).
        - Ein Kind mit geerbtem stdio stirbt nach dem Schließen des Terminals an EIO (belegt, `erbt-stdio.js`; Node-Doku `child_process.md:937-941`).
     4. Warten auf eine IPC-Nachricht, höchstens 120 s, solange das Kind lebt:
        - `{bereit:{url}}` → `disconnect()`, `unref()`, `openInBrowser(url)`, „Fertig. Dieses Fenster kann zu.“ (nur auf dem Mac sichtbar), `exit 0`;
        - `{fehler:{text}}` oder Ende des Kinds → „Neural OS konnte nicht starten:“ + die letzten 15 Zeilen des Protokolls, `exit 1`.
     5. Nach 10 s ohne Antwort einmal „Neural OS startet … (dauert noch)“ ausgeben.
   - **`dienst`**, intern:
     - `process.chdir(os.tmpdir())`, damit der Stick nicht festgehalten wird.
     - `log.setSink()` → `data/protokoll/dienst.log`, ab 512 KB wird nach `.1` gedreht.
     - `SIGHUP` wird ignoriert; `SIGINT`/`SIGTERM` → `shutdown()`.
     - Laufzettel `startet`.
     - Verschlüsselt und ohne Passphrase → `vorraum`, Laufzettel `gesperrt`.
     - Dann `boot()`, `seedIfEmpty`, `loadModules`, `listen({ tryPorts: portable ? 20 : 12 })`.
     - Laufzettel `bereit`, `process.send({bereit:{url}})`, `waechter.starte()`.
     - `app.beenden = (grund) => …` wird **vor** `listen()` gesetzt.
   - **`stop`:** Laufzettel lesen, dann `POST /api/system/beenden` mit `X-Neural-OS: 1`. Unter Windows ist `process.kill(pid,'SIGTERM')` ein `TerminateProcess` ohne Aufräumen (Annahme nach starten-Prüfer, libuv `process.c:1374-1386`).

3. **`src/kernel/log.js`:** `setSink(fn)`. Ohne Sink gilt wie heute `stderr`.

4. **`src/http/server.js`:**
   - `listen`: Bei `attempts > 1` wird `PORT_FORBIDDEN` wie `PORT_IN_USE` weitergezählt.
   - `/api/health` → `{ok, at, instanz, heim}`, weiterhin nur über Loopback. `instanz` erzeugt `createServer` einmal zufällig.
   - Zähler `inFlight`, `letzteAnfrage` und Zugriff `aktivitaet()` → `{streams: streams.size, inFlight, letzteAnfrage}`.
   - Routenliste: `require('./api/beenden')`.

5. **`POST /api/system/beenden`** (`src/http/api/beenden.js`):
   - `requireOwner`; die CSRF-Prüfung greift wie bei jeder ändernden Anfrage.
   - Antwort `202 {ok:true, danach: 'auswerfen'|'abziehen'}`: `darwin` bekommt `auswerfen`, alle anderen `abziehen`.
   - Nach `res.finish` folgen `rc.ctx.beenden('knopf')`, also `app.close()`, `laufzettel.freigeben()` und `process.exit(0)`.

6. **Wächter** (`src/kernel/waechter.js`, nur im Dienst):
   - **Stick weg:** Alle 2 s `fs.stat(portable.marker)`. Zweimal hintereinander `ENOENT`/`EIO`/`ENODEV`/`ENXIO` → sofort `process.exit(0)`, ohne flush.
   - **Leerlauf:** Alle 15 s prüfen. Ist `streams === 0`, `inFlight === 0`, `jetzt − letzteAnfrage > 10 min` und `jetzt − start > 5 min` → `beenden('leerlauf')`.
   - Eine Lücke von mehr als 60 s zwischen zwei Prüfungen gilt als Ruhezustand und setzt `letzteAnfrage` auf jetzt.
   - Uhr und fs sind injizierbar.

7. **`src/portable/open.js`:** `windowsHide: true`. URLs tragen nie `&`.

8. **Starter:** `tools/launchers/*`; die Skizze aus dem starten-Entwurf §9 gilt mit folgenden Punkten:
   - Zuerst `Inhalt\app\…` suchen, dann `app\…` (alter Aufbau).
   - **Kein** `NEURAL_OS_HOME`; der Marker entscheidet (Paket I).
   - Windows: Probe `"%NODE%" -e ""` → „Dieser Rechner lässt keine Programme vom Stick starten.“
   - Mac:
     - Die Probe `sw_vers` verlangt mindestens Version 11 → „Dieser Mac ist zu alt. Nötig ist macOS 11 oder neuer.“
     - `xattr -dr com.apple.quarantine "$INHALT/runtime/darwin-"*`. Das heutige `xattr -d "$0"` ist wirkungslos und entfällt.
     - Probe `"$NODE" -e ''` → „macOS hat den Start blockiert: …“
   - Erfolg: `exit /b 0` bzw. `exit 0`. Nur im Fehlerfall `pause` bzw. `halt`.
   - Namen und Pfade ohne `()&!%`. Die Windows-Datei in ASCII mit CRLF.
   - Der Rat „Ordner auf die Festplatte kopieren“ entfällt überall.

**Tests (heute rot, belegt):**
- Laufzettel `{v:2, rechner:'ffff…', pid:1}` → verwaist; heute wird der Start verweigert (p1b).
- Laufzettel `bereit` + Attrappen-Server mit passender `instanz`/`heim` → `start --hintergrund --open`:
  - Der Öffner (per Umgebungsvariable `NEURAL_OS_OEFFNER` auf eine Datei umgelenkt) bekommt die URL.
  - `exit 0`, und es entsteht kein zweiter Prozess.
  - Heute kommt `STORAGE_ERROR`, Exit 1, englisch.
- `start --hintergrund` ohne TTY in einem Temp-Home:
  - Ende in unter 10 s mit 0.
  - Der Dienst lebt, `/api/health.instanz` ist gleich `laufzettel.instanz`.
  - `/proc/<dienst>/cwd` liegt nicht unter dem Home.
  - `dienst.log` enthält kein ESC-Zeichen.
- p1d als Test: SIGHUP an `start` im Vordergrund → Exit 0, `data/.lock` **und** `vault/.lock` sind weg. Heute bleiben beide liegen.
- `listen({tryPorts:3})`: Der erste Port meldet `EACCES` (mit `net.Server.prototype.listen` als Attrappe) → der zweite Port wird genommen. Heute kommt `PORT_FORBIDDEN`.
- `POST /api/system/beenden` gegen einen gespawnten Dienst → 202, der Prozess endet innerhalb von 5 s, `data/.lock` und `vault/.lock` sind weg.
- Wächter mit Attrappen:
  - zweimal `ENOENT` → Exit;
  - 10 min ohne Tab → `beenden('leerlauf')`;
  - `inFlight > 0` → kein Ende;
  - Zeitsprung → Zähler zurückgesetzt.
- `start-windows.bat` enthält kein `NEURAL_OS_HOME`, endet im Erfolgsweg auf `exit /b 0` ohne `pause` und hat CRLF (Textprüfung).

**Abnahme (Linux):**
- `node bin/neural-os.js start --hintergrund --open` aus einem Terminal endet in unter 5 s.
- Das Terminal lässt sich schließen, die App läuft weiter.
- Ein zweiter Aufruf öffnet nur den Browser.
- [Beenden] per `curl` beendet die App.
- `npm test` ist grün.

---

### 2.5 Paket V – Vorraum: gesperrt starten, im Browser entsperren (Welle 1)

**Ziel:** Ein Stick mit PIN startet ohne Konsole. Die PIN wird im Browser eingegeben. Heute scheitert dieser Start immer (belegt, p1a).

**Dateien (neu):**
- `src/kernel/vorraum.js`
- `web/entsperren.html`: schwarz-weiß, ohne `<form>` und ohne `type=password`. Ohne diese beiden bietet der Browser nicht an, die PIN zu speichern (Annahme).
- `test/vorraum.test.js`

Den Aufruf aus dem Dienst baut S ein, nach dieser Schnittstelle:

```js
const v = await vorraum.oeffnen({ paths, config, host: '127.0.0.1', port, tryPorts, ki: { id, name }, instanz, heim });
// liefert: GET /api/health -> {ok, instanz, heim, gesperrt:true}; GET /api/status -> {gesperrt:true, ki, portable};
//          POST /api/vault/unlock {passphrase} (Loopback + X-Neural-OS nötig) -> 200 | 401 "Falsche PIN."
//          nach 5 Fehlversuchen 30 s Pause -> 429 "Zu oft falsch. Kurz warten."; jeder andere Pfad -> entsperren.html
const { passphrase, port: belegterPort } = await v.entsperrt;   // geprüft mit createVaultCrypto({paths, config}).unlock()
await v.schliessen();                                          // danach createApp({passphrase}) und listen auf DEMSELBEN Port
```

Die Seite fragt nach `200` alle 300 ms `/api/status` ab, bis `gesperrt` fehlt, und lädt dann neu.

**Abstimmung mit dem PIN-Ablauf:**
- Das Aussehen von `entsperren.html` darf der PIN-Ablauf ersetzen. Route, Feldname `passphrase` und Kopf `X-Neural-OS` bleiben dabei gleich.
- Die Mindestlänge `MIN_PASSPHRASE = 8` (`vaultcrypto.js:63`) gegenüber einer kurzen PIN entscheidet der PIN-Ablauf.
- Verbindlich bleibt: **Ein Start ohne Passphrase bricht nie ab.**

**Tests (heute rot):**
- Ein verschlüsseltes Temp-Home.
- Der Dienst startet ohne Passphrase, `/api/status.gesperrt === true`.
- Falsche PIN → 401. Richtige PIN → `/api/status` ohne `gesperrt`, und `/api/records?type=note` liefert die Notiz.

**Abnahme:** Die Tests sind grün, und der Starter aus S endet auch bei einem PIN-Stick mit 0.

---

### 2.6 Paket I – Eigene KI (Server) (Welle 1)

**Ziel:**
- Jede KI hat genau eine Kennung, einen Namen und einen eigenen Port.
- Ein Tab einer fremden KI wird abgewiesen.
- Ein Datenordner, der auf einen anderen Stick kopiert wurde, bekommt eine neue Identität.
- Frische Sticks haben identische Startinhalte.

**Dateien:**
- `src/app.js` (Identitätsblock, `seedIfEmpty`)
- `src/kernel/paths.js`
- `src/sync/peer.js`
- `src/http/auth.js`
- `src/http/server.js` (eine Zeile)
- `src/http/api/system.js`
- Tests: `test/eigene-ki.test.js`, `test/sync.test.js` anpassen

**Änderungen:**
1. **`app.js`**, direkt nach `configMod.validateConfig(config)`:
   - `portable = pathsMod.portableInfo(paths.home)` wird hierher vorgezogen.
   - `identitaet = createIdentitaet({config, paths, portable, speichern})`, danach `sicherstellen()` und `pruefeMarker()`.
   - Auf dem App-Objekt: `app.identitaet` und `app.ki = {id, name}`.
   - Portabel mit `config.server.port === 7777` → Umzug auf `kiPort(id)`. Das macht `sicherstellen()`.
   - Die Heim-Installation bleibt bei 7777.
2. **`seedIfEmpty`:**
   - feste IDs mit 24 Zeichen, z. B. `note_start00000000000000willk`; das Format folgt `ID_RE` in `schema.js:50`;
   - **kein** Pfad im Text;
   - Projekt- und Aufgaben-IDs ebenfalls fest.
   - Wird übersprungen, wenn `<home>/kopplungen.json` existiert oder im eigenen `sync/koppeln/` ein `*.angebot` liegt. Ein gekoppelter neuer Stick bekommt sein Wissen dann vom Partner.
3. **`peer.js`** holt die Kennung über `deps.identitaet`, frisch bei jedem Vorgang. Der Rückfall auf das eigene `ensureDeviceId` bleibt nur, wenn `deps.identitaet` fehlt (Tests).
4. **`paths.js`:**
   - `portableInfo` vergleicht über `path.relative(a,b) === ''`, unter `win32`/`darwin` ohne Groß/Klein.
   - `resolveHome`: Findet `detectPortable()` einen Stick und zeigt `NEURAL_OS_HOME` woanders hin, **gewinnt der Stick**, und der Banner meldet das in einer Zeile.
   - Ein ausdrückliches `--home` gewinnt weiter.
5. **`auth.js`** bekommt `guardKi(req, kiId)`. Die Funktion greift für **alle** Methoden, auch für GET und SSE:
   - Kopf `x-neural-os` fehlt oder ist `1` → erlaubt.
   - Kopf ist gleich `kiId` → erlaubt.
   - sonst `409 KI_GEWECHSELT` „Dieser Tab gehört zu einer anderen KI.“

   `server.js` ruft sie direkt nach `guardCsrf(req)` auf. `/api/health` liegt davor und ist damit ausgenommen.
6. **`system.js`:**
   - `/api/status` liefert zusätzlich `ki: {id, name}`.
   - Neu: `POST /api/ki/name {name}` → `identitaet.umbenennen`, nur für den Besitzer.

**Tests (heute rot, belegt wo angegeben):**
- Zwei Temp-Sticks mit Marker → verschiedene `ki.id`, beide Ports in 20000–29999 und ungleich 7777.
- `data/` von Stick X nach Stick Y kopiert (anderer Marker mit anderer `kiId`) → beim Start neue ID, `sync-folder.json` fehlt.
- `GET /api/status` mit `X-Neural-OS: dev_<fremd>` → 409; mit `1` → 200; ohne Kopf → 200. Das ist der Kern von v5 („alter Tab schreibt in B“), heute überall 200.
- `POST /api/chats` mit fremder Kennung → 409, und in B entsteht **kein** Chat. Heute 200 (v5).
- `seedIfEmpty` auf zwei frischen Homes → gleiche IDs und `merge.fingerprint` je Satz identisch. Heute sind IDs und Texte verschieden.
- `NEURAL_OS_HOME=/anderswo` + Marker → `home` ist das Stick-`data/`.
- `portableInfo` mit `e:\data` gegen `E:\data`: mit `path.win32` als Attrappe eingespielt → erkannt.

**Abnahme:**
- Tests grün.
- `test/server.test.js` und `test/auth.test.js` unverändert grün; sie senden `X-Neural-OS: 1`.

---

### 2.7 Paket O – Ordner je Rechner (Welle 1)

**Ziel:**
- Ein beobachteter Ordner auf dem Stick funktioniert an jedem Rechner.
- Ein Ordner auf der Festplatte eines Rechners wirkt nur an diesem Rechner.
- Die Stick-KI liest nie die Dokumente eines fremden PCs ein.

**Dateien:**
- neu: `src/kernel/ortspfad.js`
- `src/store/watch.js`
- `src/store/schema.js` (nur der Typ `watch`)
- `src/agents/permissions.js`, `src/agents/tools.js`
- `src/modules/sandbox.js:976`
- `test/ortspfad.test.js`, `test/watch.test.js` erweitern

**Änderungen:**
1. **`ortspfad.js`:**
   - `erfassen(absolut, {portable})` → `{ort:'stick', rel}` (POSIX-relativ zur Stick-Wurzel) oder `{ort:'rechner', rechner: rechner.profil(), pfad}`.
   - `aufloesen(eintrag, {portable})` → absoluter Pfad **oder** `null`, wenn der Eintrag zu einem anderen Rechner gehört.
2. **`schema.js` `watch`** bekommt die optionalen Felder `ort`, `rel`, `rechner`. `path` bleibt für Anzeige und Altbestand.
3. **`watch.js`:**
   - `attach()` löst den Pfad über `aufloesen` auf. Bei `null`: Status „Gehört zu einem anderen Rechner.“, **kein** `lastError`-Schreiben je Runde.
   - Beim Anlegen wird der Pfad erfasst.
   - Begleitdateien (`istBegleitdatei`) werden still übersprungen.
   - Das Anlegen wird verweigert, wenn der Ordner selbst oder ein Elternordner einen `neural-os.portable`-Marker oder einen Neural-OS-`vault/` enthält: „Hier liegt eine Neural-OS-KI.“
   - **Altbestand ohne `ort`:**
     - liegt der Pfad unter `portable.root` → `stick`;
     - sonst `rechner` = `profil()` des Rechners, an dem das Update zuerst startet. Das ist bewusst so, siehe Teil 4.
4. `fileRoots` bei Agenten und Modulen gehen durch dieselbe Auflösung. Einträge, die aufgelöst `null` ergeben, fallen weg.

**Tests (heute rot):**
- Ein Satz, angelegt mit `profil()='aaaa'`, wird bei `profil()='bbbb'` nicht angehängt, und es wird kein `lastError` geschrieben.
- Ein Satz `{ort:'stick', rel:'Schule'}` wird bei `portable.root=/x` und bei `/y` jeweils richtig aufgelöst.
- `._brief.txt` und `.DS_Store` erzeugen keinen Eintrag.
- Die Stick-Wurzel beobachten wird verweigert.

**Abnahme:** Tests grün, `test/watch.test.js` grün.

---

### 2.8 Paket K1 – Koppeln, Kern (Welle 1)

**Ziel:** Zwei (oder mehr) Sticks gleichen sich über ihre `sync/`-Ordner ab. Dabei gilt:
- mit oder ohne PIN;
- ohne falsche Konflikte;
- ohne stilles Zurücksetzen;
- ohne fremde Postfächer;
- mit Kopplungsschlüssel je Paar;
- Konflikte werden ohne Rückfrage gelöst.

**Dateien:**
- `src/sync/folder.js`, `src/sync/merge.js`
- neu: `src/sync/kopplung.js`, `src/http/api/kopplung.js`
- `src/http/server.js` (Routenliste)
- `src/app.js`: im Block „device synchronisation“ `createKopplung(...)`, `app.kopplung`, und in `close()` der Eintrag `['kopplung', () => kopplung.beenden()]` vor `'store'`
- `test/folder-sync.test.js` anpassen, neu `test/kopplung.test.js`
- `tools/feature-check.js` (Abschnitt Ordner-Abgleich, siehe 2.0)

**Aufbau auf jedem Stick:**

```
<Stick>/[Inhalt/]neural-os.portable          Marker: kiId, name (Klartext)
<Stick>/[Inhalt/]data/kopplungen.json        NEU: {v:1, eigeneGeneration, partner:[{id,name,schluessel,seit,zustand,gesehen,zuletzt}]}
                                             mit PIN mit dem Tresor-Datenschlüssel versiegelt (encryptBuffer); nie Satz, nie Sicherung, nie HTTP
<Stick>/[Inhalt/]sync/<eigene-id>/           eigenes Postfach (für alle Partner lesbar)
<Stick>/[Inhalt/]sync/<partner-id>/          Postfach des Partners, das er hier abgelegt hat
<Stick>/[Inhalt/]sync/koppeln/<id>.angebot   Kopplungsangebot
<Stick>/[Inhalt/]sync/koppeln/<id>.entkoppelt
```

Die Heim-Installation hat keinen eigenen `sync/`-Ordner. Sie schreibt nur in `P:/sync/<heim-id>/` und liest `P:/sync/<P>/`.

**Postfach-Protokoll 2** (`FOLDER_PROTOCOL = 2`). Protokoll 1 wird still übergangen, nicht gelesen.

Die Datei `manifest.json` steht im Klartext und ist klein:

```
{ protocol:2, format:'neural-os-folder-sync', deviceId, deviceName, at, generation, bytes, sha256,
  verschluesselung:'paar-v1', empfaenger:{ <Y-id>: b64(iv|tag|AES-256-GCM(K_XY, CEK, aad="nos-paar|X|Y|gen")) } }
```

Dazu `records.enc` = `AES-256-GCM(CEK, gzip(Kopfzeile + Sätze), aad="nos-postfach|X|gen")`. Die Kopfzeile ist verschlüsselt:

```
{ generation, anzahl, version, partner:[{id,name}], gesehen:{<Y>:gen}, basen:{<Y>:{recordId:h}} }
```

- **Immer verschlüsselt**, auch ohne PIN. Das bringt eine natürliche Partnerliste, Echtheit und die Generation in der AAD. Die Klartext-Warnungen entfallen damit.
- **Zwei Nähte:**
  - `deps.postfach` ver- und entschlüsselt Postfächer mit den Paarschlüsseln.
  - `deps.vaultCrypto` ist nur für `sync-folder.json` und `kopplungen.json` da.
  - Heute hängt beides an einer Naht (Befund 17).
- **Generation:**
  - Der Schreiber verwendet `max(eigeneGeneration, max_Y gesehen_Y[ich]) + 1` (Quittung heilt zurückgesetzte Zähler).
  - Er schreibt **nur**, wenn sich seit dem letzten Schreiben in diesen Ordner etwas geändert hat.
  - Der Leser überspringt ein Postfach mit `generation ≤ gesehen[P]`.
  - Das behebt p2d/v3b und spart nebenbei Arbeit.
- **Mitgereiste Basis:** Der Leser nimmt `bases = { ...kopf.basen[ich], ...eigeneBasen }`, die eigene Basis gewinnt. Das ist die Regel aus `peer.js:622` und behebt p2c. `merge.plan(…, {bases})` bleibt rein.
- **Uhr:** `skew = max(0, at − jetzt)`. Nur ein Zeitstempel in der **Zukunft** über der Toleranz gilt als Uhrproblem. Das behebt p2b.
- **Nur Partner:** `syncAll(folder, {nur: Set(partnerIds)})`. Alles andere wird **still** übergangen. Fehlt ein Empfängereintrag für mich, ist das Postfach ebenfalls still unlesbar. Das behebt p2e.
- **Prüfsumme:** Wie heute werden Größe und SHA-256 vor dem Anwenden geprüft. Weicht etwas ab, weil der Partner gerade schreibt, wird still später noch einmal gelesen.

**Konflikte: beide behalten** (`merge.beideBehalten(konflikt, {nameLokal, nameFern})` → `{sieger, kopie|null}`):
- Der **Sieger** ist die Fassung mit dem kleineren `fingerprint`. Das hängt nicht davon ab, wer rechnet.
- Die **Kopie** ist die andere Fassung als **neuer** Satz:
  - ID = `<typ>_` + 32 Zeichen base36 aus `sha256(recordId|fingerprintVerlierer)`. Normale IDs haben 24 Zeichen, so ist die Kopie erkennbar.
  - Titelzusatz „ (Fassung von <Name des Verlierer-Sticks>)“, gesetzt bei `note`/`task`/`event`/`chat` in `title`, bei `project`/`entity` in `name`. Andere Typen bekommen keinen Zusatz.
- **Gelöscht gegen geändert:** Die lebende Fassung gewinnt, es gibt keine Kopie. Bei `edge` gilt nur der Sieger.
- Hat ein Konfliktsatz schon eine Kopie-ID mit 32 Zeichen, gibt es **nur** den Sieger und keine Kopie einer Kopie. Das sichert die Konvergenz.
- Die Kopie bekommt **keine** Basis. Sonst käme sie beim Partner nicht an (im Prototyp v8 belegt).
- Ein Ereignis `kopplung.zweiFassungen {titel, kopieId}` erzeugt den Satz aus 1.7.

**Kopplungsdienst** (`src/sync/kopplung.js`) – Methoden:
- `status()`
- `finden({leer})`
- `koppeln({root, pin})`
- `koppelnNeu({root, pin})` für Paket R
- `annehmen()`
- `abgleichen()`
- `entkoppeln(id)`
- `eigenstaendig()`
- `beenden()`

**Finden:**
- Windows: `D:`–`Z:` nacheinander, jeweils `X:\neural-os.portable` und `X:\Inhalt\neural-os.portable` mit 1,5 s Zeitgrenze. Ein Laufwerk, das nicht antwortet, wird 5 min übersprungen. Es läuft nie mehr als eine Suche.
- macOS: `/Volumes/*`.
- Linux: `/media/$USER/*`, `/run/media/$USER/*`, `/mnt/*`.
- Den eigenen Stick schließt der Vergleich von `realpath` und `kiId` aus.
- Gelesen werden nur der Marker, ob `secrets.json` existiert und `app/package.json`.
- **Nie** gelesen wird `config.json` des anderen Sticks.

**Zustände eines gefundenen Sticks:** `partner`, `fremd`, `zwilling` (gleiche `kiId`), `aelter`, `neuer`, und mit `leer:true` auch Datenträger ohne Marker.

**Suchlauf:** alle 15 s, solange mindestens eine Kopplung besteht oder die Stick-Ansicht offen ist. Die Oberfläche fragt dann `GET /api/kopplung?suchen=1` ab.

**Koppeln** (A läuft, B steckt):
1. Die Schutzstufe muss gleich sein. Sonst Fehler mit dem Satz aus 1.7.
2. Hat B eine PIN, wird `createVaultCrypto({paths:{secrets: B/secrets.json}, config:{}}).unlock(pin)` **nur im Speicher** ausgeführt und danach wieder gesperrt.
3. `K_AB` = 32 Zufallsbytes.
4. `B:/sync/koppeln/<A>.angebot` wird mit tmp + rename geschrieben. Inhalt: `{von, name, an, schluessel}`, bei PIN mit dem Datenschlüssel von B versiegelt.
5. A trägt die Kopplung als `wartet` ein und legt sofort sein Postfach mit B als Empfänger in `B:/sync/<A>/`.
6. B nimmt das Angebot beim nächsten entsperrten Start oder beim eigenen Suchlauf an.
   - **Nur** versiegelte Angebote werden angenommen, wenn B eine PIN hat. Ohne PIN dürfen sie unversiegelt sein.
   - Das Feld `an` muss die eigene ID sein.
   - B zeigt einmal den Hinweis, löscht das Angebot und trägt A als `aktiv` ein.

**Abgleichen:**
1. Aus dem eigenen `sync/` die Postfächer der Partner lesen.
2. Für jeden steckenden Partner P zusätzlich `P:/sync/<P>/` lesen.
3. Dann das eigene Postfach in das eigene `sync/<ich>/` und in `P:/sync/<ich>/` schreiben.
4. Das Ganze läuft in einer Warteschlange statt mit `claim()`-Fehlern, unter `withActor({kind:'sync', label:<Partnername>})`.
5. Der erste Abgleich nach dem Koppeln läuft unter `history.suspend()`.

**Auslöser:** Start, Suchlauf, 20 s nach der letzten Änderung (entprellt, Bus `record.*`) und `beenden()`.

**Zwilling:**
- Wird gemeldet, wenn die Suche denselben `kiId` findet **oder** das Postfach `P:/sync/<ich>/` ein Manifest trägt, das dieser Stick dort nicht geschrieben hat. Dazu wird je Zielordner `{generation, sha256}` des eigenen letzten Schreibens in `sync-folder.json` gemerkt.
- Folge: Zustand `zwilling`, **keine** weiteren Schreibvorgänge in diesen Ordner, der Satz aus 1.7.
- `eigenstaendig()` ruft `identitaet.erneuern('zwilling')` auf.
- Damit ist das stille Zurückdrehen eines Dritten ausgeschlossen (Befund 12).

**Entkoppeln:**
1. Schlüssel löschen, B aus den Empfängern nehmen, `A:/sync/<B>/` löschen.
2. Steckt B, auch `B:/sync/<A>/` löschen und `B:/sync/koppeln/<A>.entkoppelt` ablegen. Inhalt: `{von, an, at, mac: HMAC(K_AB, 'entkoppelt|A|B|at')}`, vor dem Löschen berechnet.
3. Beide behalten ihr Wissen und ihre Basen.

**Name:** Der Postfach-Name kommt aus `identitaet.name`, nicht mehr aus `os.hostname()` (`folder.js:250-260`).

**HTTP** (`/api/kopplung`, nur Besitzer, Ereignisse `kopplung.*` über den Bus):

```
GET  /api/kopplung[?suchen=1&leer=1]  -> {selbst:{id,name,pin}, partner:[{id,name,zustand,zuletzt,steckt,ueber:[name]}], gefunden:[{pfad,id,name,pin,zustand,version,frei}]}
POST /api/kopplung/koppeln      {pfad, pin?}
POST /api/kopplung/abgleichen
POST /api/kopplung/entkoppeln   {id}
POST /api/kopplung/eigenstaendig
```

**Tests** (`test/kopplung.test.js` mit zwei bzw. drei Temp-Sticks; „heute rot“ ist belegt):
1. B läuft nicht; A koppelt; B nimmt beim Start an und hat danach alles von A. **B zeigt keine eigene Einführung**, und es gibt keine Dubletten (heute rot wegen `seedIfEmpty` bzw. Befund 10).
2. Nur A ändert, bevor A das Echo liest → **kein** Konflikt (p2c).
3. Beide ändern → auf beiden Sticks dieselben zwei Fassungen, ohne Rückfrage; drei weitere Runden ohne neue Kopien (v4).
4. Gelöscht gegen geändert → die geänderte Fassung bleibt.
5. Eine ältere vollständige Postfach-Kopie wird übergangen, kein Stick fällt zurück (p2d, v3b).
6. Ein Postfach von gestern mit einer Löschung → die Löschung wird ausgeführt, keine Uhr-Warnung (p2b).
7. Zwei Sticks mit **verschiedenen** PINs gleichen über `K_AB` ab (p2f). In keiner Datei unter `sync/` steht Klartext; geprüft mit einer Suche nach dem Notiztitel.
8. `sync-folder.json` bleibt mit dem Tresorschlüssel lesbar, auch bei zwei Kopplungen mit verschiedenen Schlüsseln (Befund 17).
9. Ein fremdes Postfach (Protokoll 1 im Klartext oder Protokoll 2 ohne Empfängereintrag) wird nie gelesen und erzeugt keine Warnung (p2e).
10. Ungleiche Schutzstufe → `koppeln` lehnt mit dem Satz ab. Ein unversiegeltes Angebot an einen PIN-Stick wird nicht angenommen.
11. Zwilling: `data/` samt Marker kopiert → Zustand `zwilling`, es wird nicht mehr geschrieben. Ein Dritter wird **nie** zurückgedreht (v2-dritter als Regressionstest).
12. Entkoppeln → beide behalten ihr Wissen, danach fließt nichts mehr, und die Entkoppel-Nachricht kommt an.
13. A–B und B–C: Die Notiz von A erreicht C über B. `status()` von A zeigt bei B `ueber:['C-Name']`.
14. Ein Abgleich erscheint im Verlauf mit `actor.kind === 'sync'` (braucht H).
15. Zwei gleichzeitige Auslöser laufen nacheinander, ohne Fehler.
16. `finden()` mit einer injizierbaren Liste von Einhängepunkten: findet Partner, fremde Sticks und Zwillinge, aber nie sich selbst; liest keine `config.json` (Spion).
17. Ein Postfach mit Protokoll 3 wird nicht halb gelesen; der Status sagt `neuer`.

`test/folder-sync.test.js` wird auf Protokoll 2 umgestellt. Die Tests, die heute Protokoll-1-Verhalten festschreiben, bekommen neue Soll-Werte:
- das Kopieren von `secrets.json` (`:648-668`);
- die Klartext-Warnungen.

Der Test zur Uhr (`:684-709`, 20 min *vor*) bleibt gültig.

**Abnahme:**
- Tests grün.
- `npm run check` im Abschnitt Ordner-Abgleich grün.
- Die Versuche p2a–p2f, neu gegen K1 gefahren, zeigen jeweils das Soll.

---

### 2.9 Paket K2 – Dateien im Postfach (Welle 3, nach K1)

**Ziel:** Anhänge und ihr ausgelesener Text reisen mit. Heute werden Datei-Sätze ohne Blob mit `blob-missing` übersprungen (`folder.js:986-999`).

**Dateien:** `src/sync/folder.js`, `test/kopplung-dateien.test.js`.

**Änderungen:**
- In der Kopfzeile stehen die Hashes der Blobs, die der Schreiber **hat**.
- Er legt nur Blobs ab, die dem Empfänger laut dessen letzter Kopfzeile fehlen. Ablage: `<box>/dateien/<hash>.enc`, einzeln mit dem CEK und `aad=hash` versiegelt, höchstens 50 MB je Datei.
- Der Leser prüft den Hash (`store.files.put`) und legt erst dann den Satz an.
- Voller Stick → die vorhandene Meldung (`folder.js:127-131`), kein halber Stand.

**Tests (heute rot):**
- Ein Datei-Satz mit Blob kommt samt Inhalt und `data.text` an.
- Ein fehlender Platz führt nicht zu einem halb angelegten Satz.

---

### 2.10 Paket R – Stick vorbereiten (Welle 2)

**Voraussetzung:** Der fremde Umbau von `src/portable/stick.js` ist eingecheckt. Prüfen mit `grep -n "models" src/portable/stick.js src/http/api/stick.js`. Es dürfen keine Modell-Stellen mehr übrig sein, `/api/stick/models*` ist weg. Die Stick-Ansicht darf danach im fremden Stand bleiben; ihre Knöpfe baut W2 an.

**Dateien:** `src/portable/stick.js`, `src/http/api/stick.js`, `test/stick.test.js`.

**Änderungen:**
1. **Laufzeiten:** Das Ziel ist immer `win-x64`, `darwin-arm64` und `darwin-x64`, zusammen ≈ 315 MB (belegt v10: 87 + 113 + 115 MB).
   - `win-arm64` und `linux-x64` kommen nur auf Wunsch dazu; die Laufzeit des eigenen Systems ohnehin.
   - Reihenfolge der Quellen:
     1. die Laufzeit dieses Rechners;
     2. die Laufzeiten aus dem `runtime/` des **eigenen** Sticks, wenn die App portabel läuft (offline);
     3. ein Zwischenspeicher `<home>/laufzeiten/` auf der Heim-Installation;
     4. `downloadRuntime` über das Gate (Scope `stick:runtime`).
   - Ohne Netz ist das kein Fehler: Das Ergebnis trägt `fehlend:[…]`.
   - `verify()` meldet eine fehlende Zielplattform mit `FEHLT_WINDOWS`/`FEHLT_MAC` als Fehler.
   - `POST /api/stick/runtime {platforms}` ist [Für Mac holen].
2. **Identität:** `prepare(root, {ki:'neu'})` schreibt `data/config.json` = `{sync:{deviceId, deviceName}, server:{port: kiPort}}` und den Marker mit `kiId`, `name`, `createdAt`.
   - Liegt in `data/` schon etwas: `KI_VORHANDEN` „Auf diesem Stick wohnt schon eine KI.“ Heute bleibt die alte KI still erhalten (`stick.js:1881-1892`).
   - `writeMarker` erhält `kiId` und `name`.
3. **Rohkopie entfällt:** `includeVault`, `collectTree(homeDir)` und `HOME_EXCLUDED_NAMES` fliegen raus. Ein alter Aufruf mit `includeVault` bekommt `400` mit „Gibt es nicht mehr. Stattdessen: Mit dieser KI gekoppelt.“
   - Die Route `/api/stick/prepare` nimmt `{path, ki:'neu'|'gekoppelt', pin?}`.
   - Bei `gekoppelt` folgt nach `prepare`:
     - Hat diese KI eine PIN, wird zuerst `createVaultCrypto` für den neuen Stick mit `pin` angelegt und `security.encryption.enabled` gesetzt.
     - Dann `ctx.kopplung.koppelnNeu({root, pin})`.
   - Ohne K1: `501` „Koppeln gibt es noch nicht.“
4. **Aufbau „Inhalt/“** für neue Sticks: In der Wurzel liegen nur `Inhalt/`, `LIESMICH.txt`, `Neural OS starten - Windows.bat` (CRLF) und `Neural OS starten - Mac.command`. In `Inhalt/` liegen `app/`, `runtime/`, `data/`, `sync/`, `neural-os.portable` und `Starter fuer Linux.sh`.
   - Bestehende Sticks werden **nie** automatisch umgebaut, `data/` wird nie verschoben (Zusage aus `stick.js:34-41`).
   - `update` erneuert im jeweils vorhandenen Aufbau.
   - Alte Starter-Namen (`Neural OS starten.bat`/`.command`/`.sh`) werden beim Erneuern gelöscht.
   - Die Pfaderkennung der Stick-Ansicht prüft `<Wurzel>` und `<Wurzel>/Inhalt`.
5. **Begleitdateien:**
   - `STALE_RE` deutet nie einen Namen, der mit `._` beginnt; `cleanStale`, `verify`, `collectTree` und `EXCLUDED_NAMES` benutzen `istBegleitdatei`.
   - Das behebt die falsche Warnung `INTERRUPTED_COPY` und die angelegte Datei `_.app` (belegt v4).
   - Beim Vorbereiten eine leere `.metadata_never_index` anlegen (Annahme zur Wirkung).
6. **Mac:** Das Dateisystem wird über die Zeile aus `/sbin/mount` für die Wurzel geprüft. Bei `apfs` oder `hfs` erscheint der Hinweis „Windows sieht diesen Stick nicht.“
7. `renderReadme` erzeugt die fünf Zeilen aus 1.1. Die Ratschläge „ganzen Ordner auf die Festplatte kopieren“ (`stick.js:1095,1946`) und „Rechtsklick → Öffnen“ entfallen.
8. `swapIntoPlace` benutzt `dateien.umbenennen` (Wiederholung unter Windows).

**Tests (heute rot, belegt wo angegeben):**
- `prepare` ohne `runtimes` auf Linux, mit einem Attrappen-Gate aus kleinen, selbst gebauten tar.gz/zip-Fixtures → `runtime/win-x64`, `darwin-arm64` und `darwin-x64` existieren. Heute kommt nur die lokale Laufzeit mit (Befund 1).
- `ki:'neu'` auf ein belegtes `data/` → `KI_VORHANDEN`.
- Marker und `config.json` tragen dieselbe `kiId`, der Port liegt in 20000–29999.
- `includeVault:true` → 400. Die alten Tests `stick.test.js:506-529,1154-1169,1285,1638-1640` werden durch diese Soll-Tests ersetzt.
- `._.app.old-deadbeef` in der Wurzel → `verify` ohne `INTERRUPTED_COPY`, und nach `update` gibt es kein `_.app`.
- Die Wurzel eines neuen Sticks enthält genau vier Einträge. Die `.bat` hat CRLF, kein Name enthält `()&!%`.
- `verify` eines Sticks ohne `darwin-*` → Fehler `FEHLT_MAC`.

**Abnahme:** Tests grün. Ein Stick, der unter Linux vorbereitet wurde, startet hier mit dem Starter aus S.

---

### 2.11 Paket W1 – Oberfläche, Grundschicht (Welle 2)

**Voraussetzung:** Der fremde Oberflächen-Umbau ist eingecheckt; der Nutzer hat die neue Schale abgenommen. Die Ansichten `web/views/*.js` werden nur an den genannten Stellen berührt.

**Dateien:**
- neu: `web/lib/lokal.js`
- `web/lib/api.js`
- `web/app.js` (Start, Service Worker, Overlay, Name, [Beenden])
- `web/views/chat.js` (Entwürfe)
- `web/views/kalender.js` (`MODE_KEY`)
- neu: `test/web-lokal.test.js`, `tools/stick-trennung-check.js` (Browserprüfung, läuft, wenn Chromium da ist)

**Änderungen:**
1. **`lokal.js`** ist die einzige Stelle mit `localStorage`/`sessionStorage`.
   - Schlüssel haben die Form `neural-os:<kiId>:<name>`.
   - Für `localStorage` sind nur `seiten`, `kalender-ansicht` und `aktiver-chat` erlaubt; `aktiver-chat` ist eine ID, kein Inhalt.
   - **Entwürfe** liegen nur in `sessionStorage`, unter `neural-os:<kiId>:entwurf:<chatId>`.
   - Beim Start wird jeder `neural-os:*`-Schlüssel gelöscht, der nicht mit `neural-os:<kiId>:` beginnt, dazu alle Altschlüssel ohne Kennung: `theme`, `active-chat`, `seiten`, `chat-draft:*`, `kalender-ansicht`, `notes-mode`.
2. **Design und Seitenleisten** werden in `config.ui` gespeichert (`PATCH /api/config`). Sie reisen so mit dem Stick zu jedem Rechner.
3. **`api.js`:**
   - Nach dem ersten `/api/status` trägt **jede** Anfrage `X-Neural-OS: <ki.id>`, auch GET und SSE (`api.js:161,344`).
   - Auf `409 KI_GEWECHSELT` folgt `location.reload()`.
4. **Service Worker:** Bei `status.portable` wird nicht registriert. Vorhandene Registrierungen werden abgemeldet und `caches` mit dem Präfix `neural-os-shell-*` gelöscht. Die Heim-Installation bleibt wie heute.
5. **Overlay:** Ist der Ereignisstrom länger als 5 s weg, wird der Inhalt verdeckt, mit „Neural OS ist aus.“ und „Zum Öffnen den Starter auf dem Stick doppelklicken.“ Nach [Beenden] steht dort stattdessen der Endtext aus 1.4.
6. `document.title` enthält nie Titel von Notizen oder Chats.
7. Knopf **[Beenden]**: `POST /api/system/beenden`, dann der Endtext.
8. Der KI-Name steht oben (aus `status.ki.name`).
9. Der Vorraum aus V wird nicht angefasst.

**Tests (heute rot):**
- Eine Textsuche über `web/**`: `localStorage` und `sessionStorage` kommen nur in `web/lib/lokal.js` vor. Heute gibt es Treffer in `web/app.js:2203`, `web/views/chat.js:116-131` und `web/views/kalender.js:532-540`.
- `serviceWorker.register` steht nur hinter der Prüfung auf `portable`.
- `tools/stick-trennung-check.js` ist v5 als Soll:
  - B sieht keinen Schlüssel von A.
  - Ein alter Tab von A zeigt das Overlay und schreibt nie in B.
  - B wird nicht vom Service Worker gesteuert.

**Abnahme:** Die Tests sind grün, `npm run ui` bleibt grün.

### 2.12 Paket W2 – Oberfläche, Ansichten (Welle 2, nach R und K1)

**Dateien:**
- die Stick-Ansicht (`web/views/stick.js` bzw. deren Nachfolger aus dem fremden Umbau)
- `web/views/settings.js` (Feld „Name dieser KI“ → `POST /api/ki/name`)

**Inhalt:**
- Die Karten und Sätze aus 1.6 und 1.7, wörtlich.
- Die Stick-Ansicht fragt `GET /api/kopplung?suchen=1&leer=1` alle 15 s ab, solange sie sichtbar ist.
- Die Rückfrage beim Entkoppeln steht in der Seite, **ohne** `confirm()`.
- [Ansehen] öffnet den Kopie-Satz.

**Tests:** Die UI-Prüfung (`tools/ui-check.js`, Abschnitt Stick) wird um vier Punkte erweitert:
- „Anderer Stick“ → [Koppeln] → „Gekoppelt mit …“;
- „Leerer Stick“ → [Neue KI];
- die Laufzeit-Zeile;
- „Zwei Sticks tragen dieselbe KI.“

Heute ist das rot: Es gibt weder Knöpfe noch Routen.

---

### 2.13 Paket M – Mac ohne Terminal, automatisches Auswerfen (Welle 3, bedingt)

Paket M wird **nur** umgesetzt, soweit der Probelauf es erlaubt:
- **`.app` statt `.command`** (in R): wenn `app-gestartet.txt` entstand und keine Meldung kam. Die Datei `Neural OS starten - Mac.app` wird mit `writeFile` erzeugt; das `.command` wandert als Notausgang nach `Inhalt/`. Fehler zeigt `osascript -e 'display alert …'`.
- **Terminal schließt sich selbst:** wenn im Probelauf „Terminal noch offen: Ja“ angekreuzt wurde. Dann kommt der `osascript`-Einzeiler aus dem starten-Entwurf §3.5 hinzu, und ein zweiter Probelauf prüft ihn.
- **Automatisch auswerfen:**
  - Windows, wenn die Verbenliste „Auswerfen“ oder „Eject“ enthält.
  - Mac, wenn `diskutil info` `Ejectable` meldet.
  - Ablauf: `beenden` startet einen abgelösten Helfer mit `cwd` außerhalb des Sticks und einem Programm des Systems. Der Helfer wartet, bis die PID weg ist, und wirft dann aus.
  - Der Endtext wird dann „Gespeichert. Stick kann raus.“ auf beiden Systemen.

---

### 2.14 Paket D – Doku (Welle 3, zuletzt)

**Dateien:** `docs/STICK.md`, `docs/ERSTE-SCHRITTE.md`, `README.md`.

**Entfällt:**
- „Fenster offen lassen“, „Strg+C“ und der feste Port 7777 für Sticks;
- „Rechtsklick → Öffnen“; stattdessen „Dennoch öffnen“, nur als Fehlerfall;
- NTFS als Empfehlung; stattdessen: exFAT, ohne Modelle reicht FAT32;
- „geht höchstens die letzte Zeile verloren“; stattdessen: „höchstens die letzten Sekunden; immer [Beenden] benutzen“;
- „Heimatverzeichnis berührt? Nein“ (`STICK.md:366`); stattdessen: „Das Programm schreibt nur auf den Stick. Der Browser merkt sich Ansicht und Adresse, nie Inhalte.“

**Neu:** die Abschnitte Koppeln und Probelauf.

Die Heim-Installation (`Neural OS starten.bat` im Projektordner) bleibt im Vordergrund; das wird in einem Satz gesagt.

---

## 3. Was sich hier nicht beweisen lässt – und der eine Versuch

Hier gibt es keinen Windows-PC und keinen Mac. Alles unten ist **Annahme**, bis der Probelauf (Paket P) es klärt. Der Probelauf ist absichtlich **ein** Doppelklick je Rechner.

**So prüft der Nutzer selbst.** Ein Entwickler legt nach Welle 0 den Probelauf auf einen vorbereiteten Stick (`node tools/probelauf.js --auf-stick <pfad>`). Dann:
1. **Windows-Laptop:** Stick rein, **„Probelauf - Windows“** doppelklicken, zwei Ja/Nein-Fragen beantworten, **[Ergebnis kopieren]**, in den Chat einfügen.
2. **MacBook:** Stick rein, **„Probelauf - Mac“** doppelklicken, die Fragen beantworten, einmal **„Probe“** im Ordner `Inhalt` doppelklicken, **[Ergebnis kopieren]**, in den Chat einfügen.

Ist der Schul-Laptop dabei, auf dem Schul-Laptop wiederholen: Richtlinien unterscheiden sich von Rechner zu Rechner.

| Annahme | Warum hier nicht beweisbar | Was der Probelauf misst | Entscheidet über |
|---|---|---|---|
| Der abgelöste Dienst hat unter Windows **kein** Fenster, und das `.bat`-Fenster schließt sich (conhost und Windows Terminal) | Die Node-Doku sagt „own console window“, der libuv-Code sagt `DETACHED_PROCESS` + `CREATE_NO_WINDOW` | Frage „Ist ein schwarzes Fenster offen geblieben?“ und „Starter weg, Dienst lebt“ | Ob S so bleibt; Rückfall wäre ein abgelöster Enkelprozess über `cmd /c start /min` (A) |
| Programme vom Stick sind erlaubt (AppLocker, SRP, `DisableCMD`, Smart App Control, SmartScreen) | Das sind Richtlinien am Zielrechner | Startet der Probelauf überhaupt? Frage nach Warnungen | Nichts zu bauen; ist es gesperrt, steht der Satz aus 1.2 da |
| Ports 20000–29999 sind frei und nicht von Hyper-V/WSL ausgeschlossen | Die Windows-Ausschlussbereiche sind rechnerabhängig | Bindeprobe auf 20 Ports + `netsh … excludedportrange` | Den Portbereich in `kiPort` (G) |
| `rename` über eine bestehende Datei scheitert unter Windows mit Virenschutz sporadisch | Das Verhalten von Defender und exFAT unter Windows | 300 Umbenennungen mit Fehlerzählung | Wartezeit und Wiederholungen in `dateien.umbenennen` |
| Auswerfen ohne Admin (Shell-Verb, lokalisierter Name) | Ein Windows-Explorer fehlt hier | Liste der Verben | Paket M (Windows) |
| PowerShell ist erlaubt (Constrained Language Mode) | Richtlinie | `LanguageMode` + `DriveFormat` | Ob das Produkt je PowerShell nutzen darf (heute: nein) |
| Laufwerksbuchstaben durchsuchen hängt nicht an Netzlaufwerken | libuv-Threadpool unter Windows | `stat`-Dauer je Buchstabe | Die Zeitgrenzen in `kopplung.finden` |
| `.command` startet per Doppelklick ohne Rechtsklick; das Verhalten des Terminal-Fensters nach `exit 0` | Gatekeeper, Terminal-Profil | `xattr`, Frage „Terminal noch offen?“ | Paket M (Selbstschließen) |
| macOS fragt nach „Wechseldatenträger“ (TCC), und für welchen Prozess | TCC | `EPERM` beim Lesen von `app/`, Frage | Den Satz in 1.3, Schritt 2 |
| Ein unsigniertes Skript-`.app` startet von exFAT | Gatekeeper, App Translocation | `app-gestartet.txt` | Paket M (`.app`) |
| Das x-Bit ist auf exFAT/FAT am Mac gesetzt, kein `noexec` | Ein Mac-Treiber fehlt | Modus-Bits, Zeile aus `mount` | Das `chmod` im Starter |
| Rosetta auf Apple Silicon ist nicht verlässlich vorhanden | Es fehlt ein Apple-Silicon-Mac | `arch -x86_64 true` | Bestätigt die Pflicht für `darwin-arm64` (R) |
| `diskutil eject` ohne Admin | Ein Mac fehlt | `Ejectable`, `Removable` | Paket M (Mac) |
| Das Dateisystem ist wirklich exFAT, NTFS am Mac nur lesbar | Treiber | Zeile aus `mount`, `WritableVolume`, Schreibprobe | Die Meldungen in R und S |
| Dauer des Starts auf einem echten USB-2-Stick | Hier läuft alles auf einer SSD | Zeit bis „bereit“ | Die Zeitgrenzen des Starters (120 s) |

**Bewusst nicht per Versuch prüfen:**
- **Stick am Mac ohne Auswerfen ziehen:** Ob der exFAT-Treiber puffert (Annahme), ließe sich nur durch mutwilligen Datenverlust prüfen. Die Antwort sind [Beenden], die fsync-Reihenfolge aus H und das entprellte Sichern.
- **Schlafende Tabs** (Edge „Sleeping tabs“, Chrome „Memory Saver“) **über Stunden:** Das wird im Alltag beobachtet. Die Folge wäre nur ein erneuter Doppelklick.

---

## 4. Risiken und bewusst Weggelassenes

### 4.1 Risiken

- **Schulrechner-Richtlinien** können das Ganze unmöglich machen. Beispiele: „Removable Disks: Deny execute“, „Deny write access to removable drives not protected by BitLocker“, `DisableCMD` (Annahme). Dagegen gibt es bewusst keine Umgehung. Der Starter sagt es in einem Satz.
- **Das Fenster kann aufblitzen.** Unter Windows ist ein kurzes schwarzes Fenster wahrscheinlich (Annahme). Es muss nicht offen bleiben. Das ist die ehrliche Grenze eines `.bat`-Starters ohne VBScript. VBScript ist abgekündigt, an Schulen oft gesperrt und auf USB-Sticks ein Wurm-Muster (Annahme).
- **Abziehen ohne [Beenden].** FAT und exFAT haben kein Journal. Wird mitten im Umbenennen abgezogen, kann das Dateisystem Schaden nehmen, und das verhindert keine Software (Annahme). Schadensbegrenzung: H, entprelltes Sichern, „Schnelles Entfernen“ als Windows-Vorgabe (Annahme).
- **Offene Loopback-Tür.** Solange der Dienst läuft, ist jeder Prozess auf dem Laptop über `127.0.0.1:<port>` „Besitzer“ (`auth.js`, Kopf). Das gilt auch nach dem Entsperren einer PIN. Der Leerlauf-Wächter (10 min) und der Stick-Wächter verkürzen das Fenster.
  - Eine Sitzungsbindung nach dem Entsperren, etwa ein Cookie `nos_s_<kiId8>` für den Browser, der entsperrt hat, **übergebe ich dem PIN-Ablauf** als Anforderung.
  - Cookies trennen Ports nicht (RFC 6265 §8.5, belegt v5). Deshalb muss jedes Cookie die KI-Kennung im Namen tragen.
- **PIN-Stärke.** Mit einem Paarschlüssel ist ein Postfach nur so sicher wie die schwächere PIN. scrypt kostet etwa 0,9 s pro Versuch; eine 4-stellige PIN ist in Stunden durchprobiert (Überschlag, koppeln-Prüfer). Eine PIN schützt vor dem zufälligen Finder, nicht vor einem entschlossenen Angreifer.
- **Kopplung wirkt ansteckend.** Bei A–B und B–C kommt das Wissen von A über B zu C. Das folgt aus Postfächern mit dem vollen Stand, und die Anzeige sagt es („über Lena auch: Tom“). Will der Nutzer das nicht, bräuchte jeder Satz eine Herkunft; das ist nicht Teil dieses Plans.
- **Zwei Sticks mit demselben Port** (Wahrscheinlichkeit 1:10000 je Paar): Der zweite weicht aus. Sein Browser-Ursprung ist an diesem Rechner dann ein anderer. Das ist harmlos, weil die Vorlieben in `config.ui` stehen.
- **Rechnername.** Gleiche Hostnamen und gleiche Bootzeit (Schul-Images, gemeinsames Einschalten) machen die Rechnerprüfung blind. Die Gesundheitsabfrage und die Regel „Tresor-Sperre mit derselben PID wie der verwaiste Laufzettel“ fangen das ab.
- **Altbestand beobachteter Ordner** wird dem Rechner zugeordnet, an dem das Update zuerst startet. Das kann der falsche Rechner sein; dann den Ordner einmal neu wählen.
- **Speicherplatz:** Drei Laufzeiten (≈ 315 MB) plus Postfächer, mit K2 auch Anhänge, einmal je Partner. Auf einem 1-GB-Stick wird es eng.
- **Parallelbetrieb der Abläufe.** R, W1 und W2 warten auf fremde Umbauten. Werden sie vorgezogen, entstehen Konflikte in `stick.js` und `web/**`.

### 4.2 Bewusst weggelassen

| Weggelassen | Grund |
|---|---|
| Ungekoppelte Kopie „Datenbestand mitnehmen“ (`includeVault`) | Klont Identität, Freigaben und Schlüssel (belegt, v3). Stattdessen: [Mit dieser KI gekoppelt]; wer eine Kopie will, koppelt und entkoppelt danach. |
| Abgleich übers WLAN (`peer.js`) für Sticks | Beide müssten gleichzeitig laufen. Dazu kommen Firewall ohne Admin und Client-Isolation im Schul-WLAN (Annahme). Voraussetzung wäre eine gemeinsame Basis-Tabelle. |
| Nur-Lesen-Betrieb | Der Aufwand steht in keinem Verhältnis. Es bleibt der Satz „Der Stick ist schreibgeschützt.“ |
| Versteck-Attribute | Ersetzt durch den Ordner „Inhalt“. |
| `Clear-Site-Data` beim Beenden | Ersetzt durch Port je KI und die Positivliste in `lokal.js`. |
| Dateisystem-Erkennung per PowerShell im Produkt | Nur im Probelauf. Im Produkt gibt es die Schreibprobe und, am Mac, die Zeile aus `mount`. |
| MachineGuid/IOPlatformUUID | Hostname-Hash genügt, ohne Kindprozess. |
| Feldweises Zusammenführen von Aufgaben und Terminen | Bräuchte den Inhalt der Basis, nicht nur ihren Fingerabdruck. „Beide behalten“ genügt. |
| Endgültiges Löschen und „Sicherung ersetzen“ auf den Partner übertragen | Das Löschen in den Papierkorb reist als Grabstein mit. Endgültiges Löschen danach bleibt lokal. |
| Claude-Schlüssel beim Koppeln oder Vorbereiten mitgeben | Er ist ein Zugang und kein Wissen, er kostet Geld, und ohne PIN läge er im Klartext auf einem zweiten Stick. Jeder Stick verbindet Claude selbst. |
| Browser-Downloads im Stickbetrieb auf den Stick umlenken | Oberfläche des Sicherungs-Bereichs gehört dem anderen Ablauf. Das ist ein bewusster Nutzerschritt und gibt einer anderen KI keinen Zugriff. |
| Heim-Installation im Hintergrund | Nicht Teil des Wunsches. Sie bekommt aber SIGHUP-Behandlung und Laufzettel über S. |
| App-Fenster ohne Adressleiste (`msedge --app`) | Schulrichtlinien sind unklar. Später, nach einem Probelauf. |
| `win-arm64` standardmäßig | x64 läuft unter Windows 11 auf ARM emuliert (Annahme). Auf Wunsch gibt es `win-arm64`. |
| Ältere Macs (vor macOS 11) | Die mitgelieferte Node 22 verlangt macOS 11 (belegt). Es gibt nur die Meldung. |

---

## Anhang: Versuche und Fundstellen

Wurzel: `/tmp/claude-0/-home-user-11ty-to-compute/1e14e533-395f-5003-9429-fbaf77b78a15/scratchpad/stick-koppeln/versuche/`

- **`bauplan-pruefung/p1-start-sperren.js`:** Nachprüfung, gefahren gegen das Repository.
  - a) Tresor mit PIN startet nicht, `store.reload` fehlt.
  - b) PID-1-Sperren.
  - c) Reihenfolge in `compact()` ohne fsync.
  - d) SIGHUP lässt beide Sperren liegen.
- **`bauplan-pruefung/p2-abgleich.js`:** Nachprüfung zum Abgleich.
  - a) Zwilling.
  - b) Postfach von gestern.
  - c) falscher Konflikt.
  - d) alte Kopie.
  - e) fremdes Postfach.
  - f) zwei PINs.
- **`bauplan-pruefung/uv-win-process.c`:** libuv v1.51.0, Windows-Prozessstart: `DETACHED_PROCESS`, `CREATE_NO_WINDOW`, `KILL_ON_JOB_CLOSE`.
- **Erneut gefahren:** `v2-dritter.js`, `v3-was-reist-mit.js`, `v4-konflikte.js` und `v5-browser.mjs`. Letzterer lief gegen HEAD dc847ac mit echtem Chromium.
- **Belege der Prüfer:**
  - `win-mac/v1…v11` (exFAT/FAT-Abbilder, Laufzeiten, Begleitdateien);
  - `starter-proto.js`, `erbt-stdio.js`, `ipc-uebergabe.js`;
  - `v1…v10` aus dem Blickwinkel Koppeln (Prototypen v7 „mitgereiste Basis“ und v8 „beide behalten“).
- **Node-Doku:** `scratchpad/process.md:774-779` (SIGHUP unter Windows) und `scratchpad/child_process.md:914-941` (`detached`, stdio).
