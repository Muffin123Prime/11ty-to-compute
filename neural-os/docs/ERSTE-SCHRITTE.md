# Erste Schritte — Windows, Stick, iPad

Diese Anleitung ist für den Fall, dass auf deinem Rechner noch gar nichts läuft.
Sie ist für **Windows 10/11** geschrieben; für Mac und Linux steht das
Abweichende jeweils darunter.

Was am Ende dasteht:

* Neural OS läuft auf deinem Windows-Rechner, und Claude antwortet im Chat.
* Ein USB-Stick, den du in jeden anderen Windows-Rechner (und in einen Mac)
  stecken kannst — doppelklicken, und dein System ist da, mit allem, was es
  über dich weiß, ohne Installation.
* Dein iPad zeigt dieselbe Oberfläche über dein WLAN.
* Eine Sicherung, mit der du auf einem neuen Rechner wieder da anfängst, wo du
  aufgehört hast.

**Kosten:** Neural OS selbst kostet nichts — keine Domain, kein Server, kein
Abo. Es läuft auf deinen eigenen Geräten unter `127.0.0.1`, und das iPad
erreicht den Rechner über dein WLAN. Die KI ist Claude von Anthropic; sie
braucht Internet und einen eigenen Schlüssel, und was Claude kostet, rechnet
Anthropic nach Verbrauch mit dir ab.

---

## Teil 1 · Einmalig auf dem Windows-Rechner

> Dieser ganze Teil gilt **nur für den Windows-Rechner**. Auf dem iPad ist
> nichts davon zu tun — dort wird nichts installiert und nichts
> heruntergeladen. Für das iPad ist Teil 3 zuständig.

### 1.1 Node.js holen — ohne Installation, ohne Administratorrechte

Neural OS ist ein Programm, das Node.js ausführt — so wie ein Word-Dokument
Word braucht. Node ist kostenlos und kommt von der offiziellen Quelle.

**Du musst dafür nichts installieren.** Auf vielen Schul- und Firmenrechnern
darf man das gar nicht; der Installer bricht dann mit „Setup Wizard was
interrupted" ab. Deshalb nehmen wir die Fassung, die einfach nur eine Datei
ist:

1. <https://nodejs.org/en/download> öffnen.
2. Den schwarzen Kasten in der Mitte ignorieren, egal was darin steht.
3. Ganz nach unten scrollen zu „Oder holen Sie sich einen vorgefertigten
   Node.js®" — dort muss **Windows** und **x64** stehen.
4. Den grünen Knopf **„Standalone-Binärdatei (.zip)"** nehmen — **nicht** den
   „Windows Installer (.msi)".
5. Die heruntergeladene ZIP-Datei im Explorer öffnen. Darin liegt ein Ordner
   `node-v24…-win-x64`, und darin eine Datei **`node.exe`**. Die brauchen wir
   gleich — mehr nicht.

> Wenn du auf einem Rechner bist, auf dem du installieren darfst, geht auch
> der Installer (.msi, durchklicken, das Häkchen „Tools for Native Modules"
> leer lassen). Nötig ist er nicht.

### 1.2 Neural OS auf den Windows-Rechner holen

1. Im Browser die Seite des Zweigs öffnen:
   `https://github.com/Muffin123Prime/11ty-to-compute/tree/claude/neural-os-personal-ai-nr8xf8`
2. Grüne Schaltfläche **Code** → **Download ZIP**.
3. Die ZIP-Datei im Explorer öffnen, den Inhalt irgendwohin entpacken, wo du
   ihn wiederfindest — zum Beispiel `C:\Neural-OS`.
4. In den entpackten Ordner hineingehen, bis du den Unterordner **`neural-os`**
   siehst (darin liegen `package.json`, `bin`, `src`, `web`). Dieser Ordner ist
   gemeint, wenn unten „der Programmordner" steht.

### 1.3 Starten — per Doppelklick

1. Die **`node.exe`** aus Schritt 1.1 in den Programmordner kopieren — genau
   dorthin, wo `Neural OS starten.bat` liegt.
2. **`Neural OS starten.bat`** doppelklicken.
3. Es öffnet sich ein schwarzes Fenster, kurz darauf der Browser mit deinem
   System. Falls der Browser nicht von allein aufgeht: die Adresse aus dem
   Fenster abtippen, meist `http://127.0.0.1:7777`.

Das schwarze Fenster bleibt offen, solange Neural OS läuft. Schließen beendet
das Programm; deine Daten bleiben natürlich da.

> **Wenn das Fenster „Node.js wurde gefunden, darf auf diesem Rechner aber
> nicht laufen" sagt:** dann sperrt dein Rechner (Schule, Firma) Programme
> außerhalb von „Programme". Dagegen hilft auf diesem Rechner nichts. Dann
> läuft Neural OS auf einem anderen Rechner (Teil 5), und dieser hier ist der
> Bildschirm dafür — genau wie das iPad in Teil 3.

> **Wenn Windows beim Doppelklick warnt** („Der Computer wurde durch Windows
> geschützt"): auf „Weitere Informationen" und dann „Trotzdem ausführen".
> Das ist die normale Warnung für jede Datei, die nicht aus dem Store kommt.

> **Mac:** Finder → Ordner → Rechtsklick → „Neues Terminal beim Ordner", dann
> `npm start`. **Linux:** Terminal im Ordner öffnen, `npm start`.

### 1.4 Claude verbinden (damit der Chat antwortet)

Neural OS erfindet keine Antworten. Ohne Claude sagt der Chat genau das —
Notizen, Kalender, Projekte und das Gehirn funktionieren trotzdem vollständig.

Für Antworten:

1. Auf <https://console.anthropic.com> ein Konto anlegen und unter
   **API Keys** einen Schlüssel erzeugen. Er beginnt mit `sk-ant-`.
2. In Neural OS auf **Einstellungen → Claude verbinden**, den Schlüssel
   einfügen, bestätigen. Neural OS probiert ihn einmal kurz aus und sagt,
   ob er geht.
3. Unten links steht danach **Online verbunden**.

Der Schlüssel liegt in deinem Tresor — also auch auf dem Stick, wenn du ihn
vorbereitest. Er reist mit, du musst ihn an keinem anderen Rechner noch
einmal eintippen. Claude braucht Internet; ohne Netz siehst du alles, was du
hast, bekommst aber keine neuen Antworten.

---

## Teil 2 · Den Stick vorbereiten

Voraussetzung: Neural OS läuft nach Teil 1.

1. Stick einstecken.
2. In Neural OS auf **Einstellungen → Stick**. Oben steht schon, welcher
   Stick gefunden wurde (unter Windows `E:\` oder ein anderer Buchstabe).
   Steht dort „Kein Stick gefunden", auf **Neu suchen** tippen oder den Ort
   von Hand eintragen.
3. **Stick vorbereiten** tippen.
4. Einmal kommt die Frage, ob Neural OS für Windows und Mac die Laufzeit von
   nodejs.org holen darf. **Erlauben** — dann startet der Stick an beiden.
   **Nur Windows** geht ohne Internet; dann startet er nur an Windows-Rechnern.
5. Der Balken läuft durch. Danach steht da: „Der Stick ist fertig."

Auf den Stick kommen das Programm, die Laufzeit (deshalb muss auf dem fremden
Rechner nichts installiert sein) und dein Wissen — Notizen, Chats, Termine,
Projekte und dein Claude-Schlüssel. Das Original auf dem Rechner bleibt, wie
es ist.

Liegt auf dem Stick schon Wissen (du hast ihn woanders weiterbenutzt), wird es
**nicht** überschrieben: „Stick vorbereiten" erneuert dann nur das Programm und
legt fehlende Laufzeiten dazu.

Danach liegt auf dem Stick:

```
E:\
  Neural OS starten.bat        ← Windows: doppelklicken
  Neural OS starten.command    ← Mac: beim ersten Mal Rechtsklick → Öffnen
  Neural OS starten.sh         ← Linux
  LIESMICH.txt
  app\          das Programm
  runtime\      die Laufzeit — deshalb braucht der fremde PC nichts
  data\         DEIN WISSEN
  Sicherungen\  was „Jetzt sichern" hier ablegt
```

### Den Stick benutzen

Stick in einen beliebigen Windows-Rechner stecken, **`Neural OS starten.bat`**
doppelklicken. Es öffnet sich ein Fenster und danach der Browser mit deinem
System. Fenster offen lassen, solange du arbeitest.

Alles, was du auf diesem fremden Rechner schreibst, landet auf dem Stick — nicht
auf dem fremden Rechner.

### Aufhören

**Einstellungen → Stick → Beenden & abziehen.** Neural OS speichert alles,
schließt sich und sagt dann: **„Jetzt kannst du den Stick abziehen."** Läuft
Neural OS nicht vom Stick, sondern vom Laptop, wirft es den Stick unter Windows
dabei auch gleich aus.

---

## Teil 3 · Das iPad

### Es gibt Neural OS nicht im App Store — und das ist kein Versehen

Such nicht danach, du wirst es nicht finden. Neural OS ist **keine App**,
sondern ein Programm, das auf deinem eigenen Rechner läuft und seine Oberfläche
im Browser zeigt. Genau darum geht es ja: deine Daten liegen auf deinem Gerät
und nicht bei einem Anbieter, der eine App verteilt.

Auf dem iPad **installierst du also gar nichts**. Du öffnest eine Adresse in
Safari. Wenn du willst, legst du dir davon ein Symbol auf den Home-Bildschirm —
das sieht dann aus wie eine App und öffnet sich auch so, ohne Browserleiste.

iPadOS kann Neural OS auch nicht selbst ausführen: es startet keine Programme
von einem USB-Stick und hat kein Node.js. Das ist eine Grenze des iPads und
wird sich nicht ändern. Das iPad ist der **Bildschirm** für die Instanz, die
auf deinem Windows-Rechner oder vom Stick läuft.

### 3.1 Am Windows-Rechner: Freigabe einschalten

Beide Geräte müssen im selben WLAN sein.

1. In Neural OS auf **Einstellungen → Freigabe im lokalen Netz**.
2. **„Freigabe im lokalen Netz erlauben"** einschalten.
3. Bei „Adresse, auf der der Server hört" auf **`0.0.0.0` – alle
   Netzwerkkarten** stellen.
4. Neural OS einmal neu starten, damit das wirkt: schwarzes Fenster schließen,
   neu öffnen, `npm start`.
5. **Token erzeugen** drücken. Das Token wird **genau einmal angezeigt** —
   liegen lassen, bis du es am iPad eingetippt hast.
6. Die Adresse des Rechners herausfinden: im schwarzen Fenster `ipconfig`
   eintippen und die Zeile **IPv4-Adresse** lesen, etwa `192.168.1.42`.

### 3.2 Am iPad: öffnen

1. **Safari** öffnen (nicht Chrome — das Symbol auf dem Home-Bildschirm
   funktioniert nur aus Safari heraus richtig).
2. In die Adresszeile tippen: `http://192.168.1.42:7777`
   — mit *deiner* Zahl aus Schritt 6 und ohne `https`.
3. Das Token eintragen, das der Rechner angezeigt hat.

Fertig. Ohne Token kommt kein Gerät herein, auch keines aus deinem eigenen
WLAN. Die Freigabe lässt sich jederzeit abschalten, einzelne Token einzeln
entziehen.

### 3.3 Als Symbol auf den Home-Bildschirm

1. In Safari unten (Querformat: oben rechts) auf **Teilen** — das Quadrat mit
   dem Pfeil nach oben.
2. Nach unten wischen zu **„Zum Home-Bildschirm"**.
3. Name bestätigen, **Hinzufügen**.

Auf dem Home-Bildschirm liegt danach ein richtiges Symbol, und ein Tipp darauf
öffnet Neural OS im Vollbild ohne Safari-Leisten. Es ist trotzdem keine App aus
dem App Store, sondern eine Verknüpfung zu deinem eigenen Rechner — läuft der
nicht, ist auch das Symbol leer. Genau das ist gewollt: es gibt nichts in der
Wolke, das weiterlaufen könnte.

### Querformat

Die Oberfläche passt sich an: bei schmalem Bild wandert die Seitenleiste nach
unten wie in einer App. Die Bedienung mit dem Finger ist gerade in Arbeit —
bis das fertig ist, sind einige Knöpfe kleiner, als sie sein sollten.

## Teil 4 · Sicherung

Der Fall, um den es geht: der Rechner oder der Stick ist weg, und du willst
auf einem neuen genau da weitermachen, wo du aufgehört hast.

**Sichern:** **Einstellungen → Stick → Jetzt sichern.** Steckt ein Stick, landet
die Sicherung auf dem Stick (Ordner `Sicherungen`), sonst im Sicherungsordner
von Neural OS. Daneben steht, wann zuletzt gesichert wurde. Jede Sicherung ist
ein eigener Ordner mit Datum; eine ältere wird nie überschrieben.

Am besten liegt eine Sicherung nicht nur da, wo auch das Original liegt: sichere
vom Laptop auf den Stick — und ab und zu vom Stick auf den Laptop.

**Wiederherstellen:** darunter, klein, **Von einer Sicherung wiederherstellen**.
Sicherung antippen — Neural OS zeigt erst, was passieren würde („geschrieben
ist noch nichts"), dann **Wiederherstellen**. Für einen frischen Rechner ist
**Alles ersetzen** richtig.

Zwei Dinge reisen bewusst **nicht** mit: Zugangstoken fürs lokale Netz (am
neuen Gerät neu erzeugen) und der Netzmodus.

Eine Sicherung liegt **im Klartext**. Wer den Stick findet, kann sie lesen —
genau wie den Ordner `data`. Schalte deshalb in den Einstellungen die
Verschlüsselung ein.

---

## Teil 5 · Welches Gerät kann Neural OS ausführen — und welches nicht

Neural OS braucht **ein** Gerät, auf dem das Programm läuft. Alle anderen
Geräte sind Bildschirme dafür (über dein WLAN, wie in Teil 3). Es reicht also,
wenn *irgendein* Rechner in deinem Haushalt es kann.

| Gerät | Kann das Programm ausführen? | Kann Bildschirm sein? |
|---|---|---|
| Windows-Laptop, Programme dürfen laufen | **ja** (Teil 1, ohne Installation) | ja |
| Windows-Laptop, Programme gesperrt (Schule/Firma) | nein | **ja**, im Browser |
| MacBook | **ja** — auch ohne Administrator, siehe unten | ja |
| iPad / iPhone | nein, iPadOS startet keine Programme | **ja** |
| PlayStation 4 | **nein** | **nein** |

**Zur PlayStation, weil die Frage naheliegt:** ihr Browser kann Webseiten
anzeigen, aber keine Programme ausführen und nichts von einem Stick starten.
Dass sie dauerhaft an sein kann, hilft deshalb nicht — es gäbe nichts, was
darauf laufen könnte. Und als Bildschirm fällt sie auch aus — nachgeprüft: ihr
Browser ist zu alt für die Technik, mit der die Oberfläche gebaut ist (ES-Module,
moderne CSS-Einheiten). Die Seite bliebe dort schlicht leer.

**Warum es nicht „rein im Browser" geht:** Neural OS läuft absichtlich nicht
bei einem Anbieter im Internet, sondern nur bei dir. Ein reines Browser-Angebot
wäre entweder ein fremder Server (dann lägen deine Daten dort) oder ein
Programm ohne Speicher. Claude beantwortet zwar online deine Fragen, aber was
Neural OS über dich weiß, liegt bei dir. Das Programm muss also auf einem Gerät
laufen, das dir gehört — aber es muss dort nicht *installiert* werden. Genau
dafür ist Teil 1 so gebaut.

**MacBook ohne Administratorrechte:** auf <https://nodejs.org/en/download>
unten „macOS" wählen und die **Standalone-Binärdatei (.tar.gz)** nehmen statt
des Installers; entpacken, den Ordner neben `neural-os` legen, dann im
Terminal im Ordner `neural-os`:

```
../node-v24*/bin/node bin/neural-os.js start --open
```

## Was heute noch nicht geht

Ehrlichkeitshalber, damit du nicht danach suchst:

* Die Starter für Windows und Mac konnten hier nur gelesen, nicht auf einem
  echten Windows oder Mac ausgeführt werden — ebenso das Auswerfen des Sticks.
  Wenn dort etwas anderes steht als oben beschrieben: Screenshot schicken.
* Laufzeiten für Windows und Mac holt „Stick vorbereiten" von nodejs.org. Ohne
  Internet startet der Stick nur an Rechnern mit demselben Betriebssystem wie
  der, an dem er vorbereitet wurde. Ein zweiter Klick mit Internet holt den
  Rest nach — dein Wissen darauf bleibt dabei, wie es ist.
* Neural OS **auf** dem iPad ausführen geht nicht und wird nicht gehen. Es gibt
  auch nichts im App Store; siehe Teil 3.
