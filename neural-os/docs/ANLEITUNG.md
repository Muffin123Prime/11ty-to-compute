# Anleitung: Neural OS auf deinen Geräten

Diese Anleitung ist ehrlich über eine Sache, die dir wichtig sein wird:
**Auf dem iPad kann Neural OS nicht offline laufen.** Warum, und was stattdessen
geht, steht in Teil 2. Fang mit dem PC an — dort funktioniert alles.

---

## Teil 1 · Der PC (Windows, macOS, Linux)

Hier läuft das vollständige System, vollständig offline.

### Schritt 1 — Node.js installieren (einmalig, braucht Internet)

Version 20 oder neuer, von [nodejs.org](https://nodejs.org). Prüfen:

```bash
node --version      # muss v20.0.0 oder höher zeigen
```

Das ist die einzige Voraussetzung. Neural OS selbst hat **keine einzige
Abhängigkeit** — es gibt nichts nachzuinstallieren.

### Schritt 2 — Neural OS holen

```bash
git clone <deine-repo-adresse>
cd neural-os
npm start
```

`npm install` brauchst du nicht. Es gibt nichts zu holen.

Im Browser öffnen: **http://127.0.0.1:7777**

Beim ersten Start legt die App einen Vault an und füllt ihn mit einer kurzen
Einführung, damit du nicht vor einer leeren Fläche sitzt.

### Schritt 3 — Ein lokales Modell (einmalig, braucht Internet)

Ohne Modell funktionieren Notizen, Graph, Suche, Projekte und Export — aber
Chat und Agenten bleiben leer. Die App erfindet keine Antworten.

```bash
# Ollama installieren: https://ollama.com/download
# Linux in einer Zeile:
curl -fsSL https://ollama.com/install.sh | sh

# Dann ein Modell laden. Wähle nach deinem Arbeitsspeicher:
ollama pull llama3.2        # ~2 GB   · ab 8 GB RAM  · brauchbar
ollama pull qwen2.5:7b      # ~4,7 GB · ab 16 GB RAM · deutlich stärker
ollama pull qwen2.5:14b     # ~9 GB   · ab 32 GB RAM · sehr gut

# Optional, für die semantische Suche (findet Inhalte nach Bedeutung,
# nicht nur nach Stichwort):
ollama pull nomic-embed-text   # ~274 MB
```

Nach dem Laden eines Einbettungsmodells: *Einstellungen → Modelle neu suchen*,
dann die semantische Suche einmal neu indizieren. Fehlt das Modell, sagt die App
das ausdrücklich und weicht **nicht** heimlich auf die Stichwortsuche aus.

Ollama lauscht danach auf `127.0.0.1:11434`. Neural OS findet es von allein.
**Ab diesem Moment brauchst du nie wieder Internet.**

Prüfen, was erkannt wurde:

```bash
npm run doctor
```

### Schritt 4 — Den Offline-Zustand selbst überprüfen

Glaub mir nicht. Prüf es:

```bash
npm run proof
```

Das Werkzeug startet eine echte Instanz, versucht echte Verbindungen nach außen
und unterscheidet dabei streng:

- **„von der Schleuse blockiert"** → die Kontrolle greift. Das ist der Beweis.
- **„nur ENOTFOUND"** → es gab ohnehin kein Netz. Das beweist nichts, und das
  Werkzeug sagt dir das ausdrücklich.

Der ehrlichste Test bleibt aber der einfachste: **WLAN ausschalten, Kabel ziehen,
weiterarbeiten.** Chat, Notizen, Graph, Agenten — alles läuft weiter.

### Schritt 5 — Automatisch starten (optional)

Damit die App nach dem Hochfahren bereitsteht.

**Linux (systemd, als Benutzerdienst):**

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/neural-os.service <<'EOF'
[Unit]
Description=Neural OS
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/neural-os
ExecStart=/usr/bin/node bin/neural-os.js start
Restart=on-failure

[Install]
WantedBy=default.target
EOF

systemctl --user enable --now neural-os
systemctl --user status neural-os
loginctl enable-linger $USER   # läuft auch ohne Anmeldung weiter
```

**macOS (launchd):**

```bash
cat > ~/Library/LaunchAgents/de.neural-os.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>de.neural-os</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>bin/neural-os.js</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/DEIN_NAME/neural-os</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF

launchctl load ~/Library/LaunchAgents/de.neural-os.plist
```

(Pfad zu `node` prüfen mit `which node`.)

**Windows (Aufgabenplanung):**

Aufgabenplanung öffnen → *Aufgabe erstellen* → Trigger *Bei Anmeldung* →
Aktion *Programm starten*: `node.exe`, Argumente `bin\neural-os.js start`,
Starten in: dein `neural-os`-Ordner. Unter *Bedingungen* den Haken bei
„Nur starten, wenn Netzverbindung besteht" **entfernen** — die App braucht keine.

---

## Teil 2 · Das iPad — die unbequeme Wahrheit

**Auf dem iPad kann Neural OS nicht eigenständig laufen.**

Apple erlaubt auf iPadOS keine beliebigen Laufzeitumgebungen. Node.js lässt sich
dort nicht installieren, und ohne Node gibt es keinen Server, keinen Vault, keine
Modellanbindung und keine Netzwerkschleuse. Das ist kein Versäumnis meinerseits,
sondern eine Eigenschaft der Plattform — und niemand kann es umgehen.

Was bleibt, sind zwei ehrliche Möglichkeiten.

### Möglichkeit A — Das iPad als Bildschirm für deinen PC

Dein PC (oder ein kleiner Dauerläufer, siehe unten) betreibt Neural OS. Das iPad
greift über dein WLAN darauf zu. **Kein fremder Cloud-Anbieter ist beteiligt** —
die Daten liegen weiterhin ausschließlich auf dem Gerät, das den Server betreibt.

**Auf dem PC einrichten:**

1. In Neural OS: *Einstellungen → Freigabe*
2. Freigabe einschalten. Die App verlangt dann zwingend Token-Authentifizierung —
   sie verweigert sonst den Start auf einer erreichbaren Adresse.
3. Ein Token erzeugen. Berechtigungen wählen (z. B. lesen + Chat, ohne Agenten).
   **Das Token wird genau einmal angezeigt.** Notiere es.
4. IP-Adresse des PCs herausfinden:
   - Linux/macOS: `ip addr` bzw. `ipconfig getifaddr en0`
   - Windows: `ipconfig` → „IPv4-Adresse"
5. Firewall: Port 7777 im lokalen Netz erlauben.

**Auf dem iPad:**

1. Safari öffnen, `http://192.168.x.x:7777` eingeben (deine PC-Adresse).
2. Token eintragen, wenn gefragt.
3. Teilen-Symbol → **Zum Home-Bildschirm**. Ab dann startet es wie eine App,
   ohne Browserleiste.

**Was dabei wirklich passiert — damit du dich nicht täuschst:**

| | |
|---|---|
| Läuft das iPad offline? | **Nein.** Es braucht dein WLAN und einen eingeschalteten PC. |
| Läuft es ohne Internet? | **Ja.** Dein WLAN ist kein Internet. Router aus dem Netz nehmen, es funktioniert weiter. |
| Gehen Daten in eine Cloud? | **Nein.** Nur zwischen deinen beiden Geräten. |
| Was, wenn der PC aus ist? | Die Oberfläche öffnet sich (sie ist zwischengespeichert), aber **ohne Inhalte**. Sie sagt dir das ehrlich, statt eine leere App zu zeigen. |

**Sicherheitshinweis, den ich nicht verschweigen will:** Der Server spricht reines
HTTP, **kein HTTPS**. Das Token und deine Inhalte reisen unverschlüsselt durch dein
WLAN. In einem WPA2/WPA3-gesicherten Heimnetz ist das vertretbar — die Funkstrecke
ist dort ohnehin verschlüsselt. In einem offenen, fremden oder geteilten Netz
(Hotel, Café, Uni, Büro) **schalte die Freigabe aus**. Wenn du von unterwegs
zugreifen willst, tunnele über SSH oder ein eigenes WireGuard — nicht über eine
offene Portfreigabe im Router.

### Möglichkeit B — Ein kleiner Dauerläufer

Wenn dein PC nicht immer laufen soll: ein Raspberry Pi 5 (8 GB), ein Mini-PC oder
ein NAS mit Docker. Neural OS selbst braucht fast nichts — ein paar hundert
Kilobyte Quelltext und der Vault. Die Frage ist das Modell:

| Gerät | Sinnvoll |
|---|---|
| Raspberry Pi 5, 8 GB | 3B-Modell, ~4–8 Token/s. Für Notizen und Graph völlig ausreichend; für Chat zäh. |
| Mini-PC, 16 GB | 7B-Modell, brauchbar. |
| NAS mit 8 GB | Neural OS ja, Modell eher nicht. Modell auf dem PC lassen. |

Einrichtung wie beim PC, plus Autostart (siehe oben). Danach erreichen **alle**
deine Geräte dieselbe Instanz.

### Was auf dem iPad gut funktioniert

Die Oberfläche ist für den Laptop gebaut, aber sie klappt auf schmalen Bildschirmen
um: die Seitenleiste wird zur unteren Navigationsleiste. Lesen, Notizen schreiben,
Chatten und Suchen gehen gut. Der Graph ist mit dem Finger bedienbar (ziehen,
zoomen), aber auf einem 11-Zoll-Bildschirm naturgemäß gedrängt.

---

## Teil 3 · Mehrere Geräte wirklich synchronisieren

Zwei PCs (oder PC und Dauerläufer) können ihre Daten abgleichen, ohne dass ein
fremder Anbieter beteiligt ist. In der Seitenleiste: **Abgleich**.

**So richtest du es ein:**

1. Auf Gerät A: *Einstellungen → Freigabe* einschalten, ein Token erzeugen.
   Es wird **genau einmal** angezeigt.
2. Auf Gerät B: *Abgleich → Partner hinzufügen*. Name, Adresse von A
   (`http://192.168.1.20:7777`) und das Token eintragen.
3. *Verbindung prüfen* zeigt Erreichbarkeit, Anzahl Einträge und eine etwaige
   Abweichung der Uhren zwischen den Geräten.
4. *Jetzt abgleichen*.

Der Abgleich braucht mindestens den Netzmodus **Lokales Netz** — im Modus
Offline lehnt die Schleuse ihn ab. Das ist richtig so und wird unter *Netzwerk*
geändert.

**Wie es funktioniert:** Jedes Gerät hält seinen eigenen vollständigen Vault. Beim
Abgleich tauschen sie nur die Änderungen aus.

**Wo es ernst wird:** Wenn du denselben Datensatz auf beiden Geräten geändert hast,
**wählt Neural OS keinen Gewinner**. Es legt einen Konflikt an und zeigt dir beide
Fassungen nebeneinander, mit hervorgehobenen Unterschieden. Du entscheidest. Nichts
wird überschrieben, bevor du es tust.

Das ist bewusst unbequemer als bei anderen Programmen. Genau an dieser Stelle
verlieren automatische Synchronisationen Daten — und man merkt es erst Wochen
später.

**Was bewusst nicht abgeglichen wird:** Zugangstoken, Netz-Freigaben, Agenten mit
ihren Berechtigungen, die Partnerliste selbst sowie Läufe und Bestätigungen. Ein
Partnergerät kann sich über den Abgleich also weder Rechte noch Netzzugang
verschaffen. Abgeglichen werden Notizen, Projekte, Aufgaben, Begriffe,
Erinnerungen, Chats samt Nachrichten, Dateien und Verknüpfungen.

**Ein iPad kann nicht synchronisieren**, weil es keinen eigenen Vault hat. Es bleibt
ein Fenster auf eine andere Instanz.

---

## Teil 4 · Deine Daten

Alles liegt unter **einem** Ordner, standardmäßig `~/.neural-os`
(unter Windows `C:\Users\DeinName\.neural-os`):

```
~/.neural-os/
  config.json          Einstellungen und Netzwerk-Policy
  audit.jsonl          jede Netzentscheidung, die je getroffen wurde
  vault/
    log/*.jsonl        dein Datenbestand — Klartext, eine Zeile pro Änderung
    snapshot.json      Zwischenstand fürs schnelle Laden
    files/             angehängte Dateien
  runs/                vollständige Agenten-Protokolle
  exports/             deine Sicherungen
```

**Sichern — in der Oberfläche:**

In der Seitenleiste **Sicherung** (oder `g` dann `b`). Ganz oben steht die
Frage, die man im Ernstfall stellt: *wann zuletzt gesichert, wohin, wie groß,
wie viele Sätze* — und wenn noch nie, dann steht genau das da. Darunter
**„Jetzt sichern"** mit einem Zielordner.

Das Ziel ist die eigentliche Entscheidung. Ab Werk landet die Sicherung in
`~/.neural-os/exports` — also auf derselben Platte wie der Tresor, und damit
genau dort, wo sie bei einem Plattendefekt mit verlorengeht. Trag einen Pfad
auf einem USB-Stick oder einer zweiten Platte ein; läuft Neural OS schon von
einem Stick, wird der Stick angeboten.

Ohne Passphrase liegt eine Sicherung **im Klartext**: der gesamte Tresor,
lesbar für jeden, der den Ordner öffnet. Das steht auch so dort. Mit
Passphrase wird sie verschlüsselt — und ist ohne diese Passphrase endgültig
nicht mehr zu öffnen, auch für dich nicht. Deshalb ist sie nicht voreingestellt.

**Sichern — auf der Kommandozeile:**

```bash
node bin/neural-os.js export --format both
node bin/neural-os.js export --format both --passphrase "..."   # verschlüsselt
```

Das schreibt eine vollständige JSON-Datei (wiederherstellbar) **und** eine
lesbare Markdown-Fassung deiner Notizen und Chats. Kopiere den Ordner wohin du
willst — auf einen USB-Stick, eine externe Platte, wohin auch immer.

**Wiederherstellen oder auf einen neuen Rechner umziehen:**

Im Bereich **Sicherung** den Ordner eintragen und **„Erst ansehen"** drücken.
Das schreibt nichts, sondern sagt vorher, was passieren wird: wie viele Sätze
kommen, was hier liegt, was dabei verschwindet — und was grundsätzlich nicht
mitreist. Erst danach wird „Wiederherstellen" anklickbar.

Vier Wege gibt es, und der Unterschied ist wichtig:

| Modus | Was er tut |
|---|---|
| **Zusammenführen** (Voreinstellung) | Vorhandenes bleibt. Nur was fehlt, kommt hinzu. |
| **Einträge ersetzen** | Gleiche Kennung wird überschrieben; was hier zusätzlich liegt, bleibt. |
| **Nur in einen leeren Tresor** | Bricht ab, sobald hier etwas liegt. |
| **Diese Installation vollständig ersetzen** | Löscht alles hier — auch die Erstausstattung des ersten Starts — und spielt dann die Sicherung ein. Danach ist dieser Tresor genau der gesicherte. Nicht umkehrbar. |

Der letzte ist der, den man auf einem **neuen Rechner** will. Grund: eine
frische Installation ist nicht leer — beim ersten Start legt Neural OS eine
Willkommensnotiz, ein Beispielprojekt, zwei Aufgaben und sechs eingebaute
Agenten an. „Nur in einen leeren Tresor" scheitert daran, und die beiden
anderen lassen diese vierzehn Sätze stehen: man bekommt dann seinen Stand
*plus* die Erstausstattung, nicht seinen Stand.

Auf der Kommandozeile:

```bash
node bin/neural-os.js import /pfad/zum/export                    # zusammenführen
node bin/neural-os.js import /pfad/zum/export --mode restore     # alles ersetzen
node bin/neural-os.js import /pfad/zum/export --passphrase "..." # verschlüsselte Sicherung
```

Oder einfach den ganzen Ordner `~/.neural-os` kopieren. Mehr ist es nicht.

**Was eine Sicherung bewusst NICHT mitnimmt:**

- **Zugangstoken** für das lokale Netz. Das sind Zugangsdaten für die Tür
  *eines bestimmten Geräts*, kein Wissen. Auf dem neuen Gerät legst du neue an.
- **Den Zugangsschlüssel gekoppelter Geräte.** Die Kopplung wird dort neu bestätigt.
- **Den Netzmodus.** Er steht in der Sicherung und wird beim Wiederherstellen
  *gemeldet*, aber nicht gesetzt: eine Datei darf ein Gerät, das absichtlich
  offline ist, nicht stillschweigend öffnen.
- **Das Schlüsselmaterial der Verschlüsselung.** Nach dem Wiederherstellen ist
  der Tresor unverschlüsselt, bis du die Verschlüsselung hier einschaltest.
  Auch das sagt das Ergebnis.
- **`audit.jsonl`**, das Netzprotokoll. Das gehört diesem Gerät.

Alles davon steht auch in der Vorschau, bevor etwas geschrieben wird.

**Alles mitnehmen — auf einem Stick:**

In der Seitenleiste **Stick** (oder `g` dann `t`). Dort steht zuerst, ob diese
Instanz gerade von der Festplatte oder schon vom Stick läuft. Pfad zum Stick
eintippen — der Browser kennt keine Dateipfade, es gibt keinen Ordnerwähler,
der einen absoluten Pfad liefern darf —, dann **„Erst ansehen"**: das sagt, was
passieren würde, bevor ein einziges Byte geschrieben ist. Danach **„Stick
vorbereiten"**, wahlweise mit deinem Datenbestand.

Auf dem Stick liegt danach alles, auch die Node-Laufzeit: ein fremder Rechner
braucht nichts. Zwei Dinge sagt der Bereich dabei ausdrücklich, weil sie sonst
hinterher enttäuschen: auf den meisten Sticks (exFAT, FAT32) gibt es **keine
Zugriffsrechte** — dort schützt nur die Verschlüsselung —, und das
**Sprachmodell kommt nicht mit**. Dein Wissen reist, das Modell bleibt. Die
ganze Geschichte steht in `docs/STICK.md`.

**Anderen Speicherort verwenden:**

```bash
node bin/neural-os.js start --home /pfad/zu/meinem/vault
# oder dauerhaft:
export NEURAL_OS_HOME=/pfad/zu/meinem/vault
```

**Verschlüsseln:** *Einstellungen → Verschlüsselung*. Danach fragt die App beim
Start nach der Passphrase. **Passphrase verloren heißt Daten verloren** — es gibt
keine Hintertür, weil eine Hintertür den Zweck aufhebt. Schreib sie irgendwo auf,
wo du sie wiederfindest.

---

## Teil 5 · Die Netzstufen im Alltag

Die Kopfzeile zeigt dauerhaft, was gerade gilt:

| Stufe | Bedeutung | Wann |
|---|---|---|
| **Offline** | Nur dieses Gerät. Lokale Modelle laufen weiter. | Standard. Lass es so. |
| **Lokales Netz** | Zusätzlich dein WLAN. | Modellserver auf einem anderen Rechner, Zugriff vom iPad, Geräte-Abgleich. |
| **Internet** | Öffentliches Netz, zusätzlich durch eine Freigabeliste begrenzt. | Wenn ein Agent wirklich recherchieren soll. |

Du musst nicht global umschalten. Feiner geht es auch:

- **Pro Chat:** im Chat oben das Netz-Symbol → nur dieser eine Chat darf online.
- **Pro Agent:** im Agenten-Editor die Netzstufe und eine eigene Hostliste.
- **Einmalig:** *Netzwerk → Freigaben* → Geltungsbereich, Ablaufzeit und maximale
  Anzahl. „Dieser Agent, für diesen Lauf, für `de.wikipedia.org`, dreimal,
  zehn Minuten."

Unter *Netzwerk* siehst du jede einzelne Verbindung, die versucht wurde — auch die
erlaubten. Ein Protokoll, das nur Blockaden zeigt, würde nichts beweisen.

---

## Teil 6 · Was dir Arbeit abnimmt

Sechs Dinge, und **vier davon funktionieren ohne jedes KI-Modell**. Das ist
Absicht: das Nützlichste soll nicht der Teil sein, für den du 5 GB herunterladen
musst.

| | Braucht ein Modell? |
|---|---|
| **Heute** — was fällig ist, was ohne dich lief | nein |
| **Vorschläge** — Dubletten, Waisen, Merker, fehlende Links | nein |
| **Automatik** — Zeitpläne und Auslöser | nein (die Agenten darin schon) |
| **Beobachtete Ordner** — Dateien automatisch aufnehmen | nein |
| **Zweiter Blick** — Kern, offene Stellen, bekannte Begriffe | teilweise |
| **Zwei Modelle** — dieselbe Frage an zwei Modelle | ja |

Und: **Strg+Umschalt+N** hält von überall aus eine Zeile fest, ohne dass du den
Bereich wechselst.

### Heute (`g` dann `h`)

Der Bildschirm, den du morgens einmal ansiehst. Der erste Satz ist eine Tatsache,
keine Begrüßung: *„Zwei Aufgaben sind fällig, eine davon überfällig."*

Darunter, in dieser Reihenfolge, weil sie nach Dringlichkeit sortiert ist:

1. **Fällig** — überfälliges zuerst, direkt hier abhakbar
2. **Ohne dich gelaufen** — was ein Agent gemacht hat, während du weg warst
3. **Vorgeschlagen** — was die Prüfung gefunden hat
4. **Seit gestern** — was sich geändert hat
5. **Wiedervorlage** — eine Notiz, die du lange nicht angesehen hast

Steht nichts an, steht das da. Das ist eine gute Nachricht und sieht auch so aus.

### Zwei Modelle nebeneinander (im Chat)

Ist ein Online-Anbieter eingerichtet, kannst du dieselbe Frage an beide schicken
und die Antworten nebeneinander sehen. Das ist die ehrlichste Art, den
Offline-Betrieb zu beurteilen: nicht meiner Behauptung glauben, sondern selbst
sehen, wann sich das Internet lohnt.

**Vorher** zeigt die App, was passieren wird — für jede Seite, wo das Modell
liegt und was die Netzschleuse dazu sagt. Verlässt eine Seite das Gerät, steht
das als Satz da, bevor du drückst, und Bestätigen ist ein eigener Klick.

### Zweiter Blick (an einer langen Notiz)

Drei Dinge zu einem längeren Text: die Kernaussage, die Stellen, an denen etwas
offen bleibt, und die Begriffe, die schon anderswo im Tresor vorkommen.

Der dritte Teil braucht **kein Modell** — er kommt aus dem Volltextindex und ist
damit belegbar. Ohne Modell bekommst du ihn trotzdem, und die App sagt dir, dass
die ersten beiden fehlen und warum. Die drei Teile sind sichtbar als verschieden
gekennzeichnet, denn das ist der Punkt: einer ist nachprüfbar, zwei sind es nicht.

### Beobachtete Ordner (Einstellungen)

Du gibst einen Ordner frei, und was dort liegt, wird gelesen und in den Tresor
aufgenommen. Der Ablauf ist absichtlich dreistufig:

```
anlegen  →  erst ansehen  →  einschalten
```

**„Erst ansehen"** zeigt, *was passieren würde*, und legt nichts an. Erst nach
dem Einschalten nimmt der Ordner wirklich auf. Unter „Was wurde aufgenommen"
steht danach die echte Liste — mitsamt den übersprungenen Dateien **und dem
Grund**.

Was dabei ausdrücklich nicht passiert: einem symbolischen Link wird nicht
gefolgt, der Tresor selbst lässt sich nicht beobachten, zu große Dateien werden
übersprungen statt halb gelesen, und im Quellordner wird **niemals** etwas
geändert oder gelöscht. Nur gelesen.

### Vorschläge (`g` dann `v`)

Ein Posteingang. Du drückst auf **Prüfen**, das System sieht sich deine Einträge an
und schlägt etwas vor. Geschehen tut davon nichts, bis du auf *Übernehmen* drückst —
und davor steht in klarem Deutsch, was genau passieren wird.

| Art | Was es findet |
|---|---|
| **Doppelt** | Zwei fast gleiche Notizen. Vorgeschlagen wird eine *Verknüpfung*, nie ein Zusammenführen: dabei verschwände Text unwiderruflich. |
| **Verwaist** | Eine alte Notiz, auf die keine Verknüpfung zeigt — samt den drei Notizen, die inhaltlich am ehesten dazugehören. |
| **Schlagwort** | Ein Schlagwort, das zwei Nachbarn im Graphen teilen und diese Notiz noch nicht hat. |
| **Aufgabe** | Ausdrückliche Merker im Text: `- [ ]`, `TODO:`, `Offen:`, `Zu tun:`. Aus gewöhnlichen Sätzen wird **nichts** geraten. |
| **Wiedervorlage** | Was du seit über 90 Tagen nicht mehr angesehen hast, aber gut verknüpft ist. |
| **Fehlender Link** | Ein `[[Verweis]]`, zu dem es noch keine Notiz gibt. |

Ein verworfener Vorschlag kommt nie wieder. Zweimal prüfen erzeugt keine doppelten
Vorschläge. Welche Verfahren nicht laufen konnten, steht dabei — statt so zu tun,
als hätte es nichts zu finden gegeben.

### Automatik (`g` dann `u`)

Agenten, die von allein laufen. **Beides ist ab Werk aus**, und ein neu angelegter
Plan bleibt aus, bis du ihn einschaltest. Ganz oben steht immer, was gerade gilt —
im Normalfall: *„Nichts läuft von allein."*

- **Zeitplan** — stündlich, täglich oder wöchentlich zu einer Uhrzeit.
  Beispiel: *täglich um 7 Uhr, „Schreib mir einen Rückblick auf gestern"*.
- **Auslöser** — reagiert, wenn ein Eintrag angelegt, geändert oder gelöscht wird,
  wahlweise gefiltert nach Satzart, Schlagwort oder Titel.
  Beispiel: *„sobald eine Notiz mit `#projekt` angelegt wird, verschlagworte sie"*.

Vier Bremsen sorgen dafür, dass ein Auslöser sich nicht selbst hochschaukelt: das
System weiß, welche Einträge aus einem Agentenlauf stammen (die reagieren nicht
noch einmal), eine Entprellung, eine Obergrenze pro Stunde und höchstens drei
gleichzeitige Läufe. War der Rechner drei Tage aus, holt ein Tagesplan **einen**
Lauf nach, nicht drei.

Scheitert ein Lauf, steht der echte Grund am Plan. Ein Zeitplan, der still
gescheitert ist, wäre genau die Unehrlichkeit, die dieses Programm vermeiden soll.

---

### Rückgängig — auch für das, was ohne dich passiert ist

Unter **Zeitachse** steht neben dem Inspektor eine zweite Liste: **Letzte
Änderungen**. Dort steht jede Änderung an einer Notiz, Aufgabe, einem Projekt,
Chat, Agenten, einer Datei, Erinnerung, einem Zeitplan oder Auslöser — mit dem
Zustand davor und mit der Antwort auf die Frage, die man zuerst stellt:

> **Wer war das — ich oder ein Agent?**

Ein Filter zeigt dir nur das, was **ohne dich** passiert ist. Das ist der
eigentliche Zweck: du kommst zurück an den Rechner und willst wissen, was
gelaufen ist, während du weg warst.

Zwei Dinge, auf die es ankommt:

- **Ein Konflikt wird nie still überschrieben.** Wurde der Satz seit der
  aufgezeichneten Änderung wieder geändert, wird das Zurücknehmen abgelehnt —
  sonst würde Rückgängig genau das anrichten, wogegen es da ist. Es gibt ein
  ausdrückliches „Trotzdem zurücknehmen", mit Warnung, als zweiten Klick.
- **Was nicht geht, steht dabei**, statt als grauer Knopf ohne Erklärung.

Was es **nicht** kann:

| | |
|---|---|
| Reichweite | höchstens 2000 Einträge oder 30 Tage. Danach ist es weg — wer länger zurückwill, nimmt eine Sicherung. |
| Verknüpfungen | werden nicht aufgezeichnet. Abgeleitete Links entstehen bei jedem Schreibvorgang neu; ein Knopf dafür würde sichtbar nichts tun. |
| Freigaben und Token | nicht. Eine zurückgenommene Netz-Freigabe wiederzubeleben wäre ein Sicherheitsloch, kein Komfort. |
| Endgültig Gelöschtes | kommt unter **neuer Kennung** zurück, und seine früheren Verknüpfungen sind weg. Die App sagt das, statt so zu tun, als wäre nichts gewesen. |

Einstellen lässt sich die Reichweite in `config.json` unter
`history.maxEntries` und `history.maxDays`.

---

## Teil 7 · Ein Online-Modell einrichten (optional)

Du brauchst das nicht. Der ganze Rest funktioniert ohne. Aber wenn du für schwere
Aufgaben ein großes Modell dazuschalten willst, geht das seit Neuestem, ohne eine
Datei von Hand zu bearbeiten:

**Einstellungen → Online-Modelle → Online-Anbieter hinzufügen.**

Es gibt Vorlagen für OpenAI, Anthropic, Mistral, Groq, OpenRouter, DeepSeek und
für einen eigenen Server im Heimnetz. Die Vorlagen sind mitgeliefert — ein
Anbieterverzeichnis aus dem Netz zu holen wäre genau der stille Online-Zugriff,
den dieses System verhindern soll.

Den Schlüssel gibst du am besten als **Umgebungsvariable** an, dann steht er in
keiner Datei dieses Programms:

```bash
export OPENAI_API_KEY="sk-..."       # Linux/macOS, vor dem Start
setx OPENAI_API_KEY "sk-..."         # Windows, einmalig
```

Trägst du ihn stattdessen direkt ein, liegt er im Klartext in `config.json`
(Dateirechte 0600). Die App sagt dir das auch.

**Anlegen öffnet die Schleuse nicht.** Der Anbieter steht danach da und ist
gesperrt; jeder Eintrag zeigt, was die Schleuse gerade über seinen Host sagt.
Freigeben ist ein zweiter, eigener Klick und steht als eigener Eintrag im
Protokoll. *Verbindung testen* verbindet wirklich und unterscheidet dabei
„die Schleuse hat abgelehnt" (deine eigene Einstellung) von „nicht erreichbar"
(eine Störung) — im nackten Fehlertext sehen die beiden gleich aus und sind das
Gegenteil voneinander.

---

## Teil 8 · Wenn etwas nicht geht

| Problem | Ursache und Abhilfe |
|---|---|
| `npm start` bricht mit `EADDRINUSE` ab | Port belegt. `node bin/neural-os.js start --port 7778` |
| „Ein anderer Neural-OS-Prozess benutzt diesen Vault" | Läuft schon (z. B. als Dienst). `systemctl --user status neural-os` |
| Chat sagt `NO_MODEL_AVAILABLE` | Ollama läuft nicht. `ollama serve` bzw. `ollama list` prüfen. Danach in den Einstellungen „Modelle neu suchen". |
| iPad erreicht den PC nicht | Firewall (Port 7777), gleiches WLAN?, Freigabe in den Einstellungen wirklich an? |
| Alles ist langsam beim Chat | Das Modell ist zu groß für deine Hardware. Ein kleineres nehmen. |
| Agent erfindet Websuchen | Kleines Modell ohne Netzzugang. Größeres Modell, oder dem Agenten gezielt eine Freigabe erteilen. |
| Abgleich schlägt mit „blockiert" fehl | Netzmodus steht auf Offline. Unter *Netzwerk* auf „Lokales Netz" stellen. |
| Semantische Suche findet nichts | Einbettungsmodell fehlt (`ollama pull nomic-embed-text`) oder der Index ist noch leer — einmal neu indizieren. |
| PDF liefert keinen Text | Ein gescanntes PDF ohne Textebene. Dafür bräuchte es eine Texterkennung, die Neural OS nicht hat. Die App sagt das, statt etwas zu erfinden. |
| Ich will wissen, was wirklich passiert ist | `cat ~/.neural-os/audit.jsonl` — jede Netzentscheidung, chronologisch. |
| „Heute" zeigt einen Block nicht | Steht dort ein Grund? Dann fehlt das Teilsystem. Steht kein Grund, ist der Block wirklich leer. |
| Meine Lernkarten sind verschwunden | Der Bereich „Lernen" gibt es nicht mehr. Deine Karten sind beim ersten Start **Notizen** geworden: Vorderseite als Titel, Rückseite als Text, Schlagwort `lernkarte`. Such nach `tag:lernkarte`. |
| Der beobachtete Ordner nimmt nichts auf | Ist er eingeschaltet? „Erst ansehen" legt absichtlich nichts an. Unter „Was wurde aufgenommen" steht, was übersprungen wurde und warum. |
| Eine Datei wurde übersprungen | Der Grund steht daneben: zu groß, unlesbar, schon vorhanden, oder ein symbolischer Link (dem wird bewusst nicht gefolgt). |
| „Zweiter Blick" liefert nur Begriffe | Kein Modell erreichbar. Der dritte Teil kommt aus dem Volltextindex und geht immer; die ersten beiden brauchen ein Modell. |
| Der Knopf „Zweiter Blick" fehlt | Die Notiz ist kürzer als 500 Zeichen. Bei so wenig Text siehst du beim Lesen schon alles. |
| „Prüfen" findet nie etwas | Normal bei wenigen Notizen: die meisten Verfahren brauchen Alter (14 bzw. 90 Tage) oder Verknüpfungen. Was übersprungen wurde, steht nach der Prüfung dabei. |
| Ein Zeitplan läuft nicht | Erst: ist er eingeschaltet? Dann: steht ein Fehler am Plan? Ohne Modell scheitert der Lauf — gestartet wird er trotzdem, und der Grund steht dran. |
| Ein Auslöser feuert nicht | Die Filter prüfen (der Satz unter dem Auslöser sagt, worauf er reagiert), und: Einträge aus einem Agentenlauf lösen absichtlich nichts aus. |
| Online-Anbieter bleibt „gesperrt" | Anlegen öffnet die Schleuse nicht. *Host freigeben* drücken, oder unter *Netzwerk* den Modus auf Internet stellen. |
| Online-Anbieter meldet HTTP 401 | Kein oder falscher Schlüssel. Bei `apiKeyEnv`: die Variable muss gesetzt sein, **bevor** Neural OS startet. |

---

## Zusammengefasst

| | PC | iPad |
|---|---|---|
| Läuft eigenständig | **Ja** | Nein — Apple lässt es nicht zu |
| Funktioniert ohne Internet | **Ja, vollständig** | Ja, aber nur mit erreichbarem PC im WLAN |
| Eigener Datenbestand | **Ja** | Nein |
| Kann synchronisieren | **Ja**, mit anderen PCs | Nein |
| Lokales KI-Modell | **Ja** | Nur über den PC |

Lies vor dem produktiven Einsatz noch `docs/EINGESTAENDNIS.md`. Dort steht, wo ich
mich geirrt habe und was ich nicht überprüfen konnte.
