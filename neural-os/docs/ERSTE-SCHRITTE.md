# Erste Schritte — Windows, Stick, iPad

Diese Anleitung ist für den Fall, dass auf deinem Rechner noch gar nichts läuft.
Sie ist für **Windows 10/11** geschrieben; für Mac und Linux steht das
Abweichende jeweils darunter.

Was am Ende dasteht:

* Neural OS läuft auf deinem Windows-Rechner.
* Ein USB-Stick, den du in jeden anderen Windows-Rechner stecken kannst —
  doppelklicken, und dein System ist da, mit allen Notizen, ohne Installation.
* Dein iPad zeigt dieselbe Oberfläche über dein WLAN.
* Eine Sicherung, mit der du auf einem neuen Rechner wieder da anfängst, wo du
  aufgehört hast.

**Kosten: keine.** Keine Domain, kein Server, kein Abo. Alles läuft auf deinen
eigenen Geräten unter `127.0.0.1`, und das iPad erreicht den Rechner über dein
WLAN, nicht über das Internet.

---

## Teil 1 · Einmalig auf dem Windows-Rechner

> Dieser ganze Teil gilt **nur für den Windows-Rechner**. Auf dem iPad ist
> nichts davon zu tun — dort wird nichts installiert und nichts
> heruntergeladen. Für das iPad ist Teil 3 zuständig.

### 1.1 Node.js installieren

Neural OS ist ein Programm, das Node.js ausführt — so wie ein Word-Dokument
Word braucht. Node ist kostenlos und kommt von der offiziellen Quelle:

1. <https://nodejs.org> öffnen.
2. Die Schaltfläche mit **LTS** nehmen (die linke, nicht „Current").
3. Die heruntergeladene `.msi` doppelklicken, im Installationsprogramm alles
   bestätigen. Nichts umstellen, nichts dazu anklicken.

Das ist die einzige Installation in dieser ganzen Anleitung. **Jeder weitere
Rechner, der später den Stick benutzt, braucht sie nicht** — auf dem Stick
liegt Node mit drauf.

### 1.2 Neural OS auf den Windows-Rechner holen

1. Im Browser die Seite des Zweigs öffnen:
   `https://github.com/Muffin123Prime/11ty-to-compute/tree/claude/neural-os-personal-ai-nr8xf8`
2. Grüne Schaltfläche **Code** → **Download ZIP**.
3. Die ZIP-Datei im Explorer öffnen, den Inhalt irgendwohin entpacken, wo du
   ihn wiederfindest — zum Beispiel `C:\Neural-OS`.
4. In den entpackten Ordner hineingehen, bis du den Unterordner **`neural-os`**
   siehst (darin liegen `package.json`, `bin`, `src`, `web`). Dieser Ordner ist
   gemeint, wenn unten „der Programmordner" steht.

### 1.3 Starten

1. Den Programmordner im Explorer öffnen.
2. Oben in die **Adressleiste** klicken (dort wo der Pfad steht), das Wort
   `cmd` eintippen und Eingabetaste drücken. Es öffnet sich ein schwarzes
   Fenster, das schon im richtigen Ordner steht.
3. Eintippen und Eingabetaste:

   ```
   npm start
   ```

4. Nach ein paar Sekunden steht dort eine Adresse, meist
   `http://127.0.0.1:7777`. Die im Browser öffnen.

Das schwarze Fenster bleibt offen, solange Neural OS läuft. Schließen beendet
das Programm; deine Daten bleiben natürlich da.

> **Wenn `npm start` nicht gefunden wird:** Node war beim Öffnen des Fensters
> noch nicht installiert. Fenster schließen, neu öffnen, nochmal.

> **Mac:** Finder → Ordner → Rechtsklick → „Neues Terminal beim Ordner", dann
> `npm start`. **Linux:** Terminal im Ordner öffnen, `npm start`.

### 1.4 Ein Modell installieren (damit der Chat antwortet)

Neural OS erfindet keine Antworten. Ohne ein Sprachmodell auf dem Rechner sagt
der Chat genau das — Notizen, Graph, Suche, Aufgaben und alles andere
funktionieren trotzdem vollständig.

Für Antworten:

1. <https://ollama.com/download> → Windows-Installer, durchklicken.
2. Eingabeaufforderung öffnen und eintippen:

   ```
   ollama pull llama3.2
   ```

   Das lädt rund 2 GB. Läuft auf fast jedem Rechner.
   Mehr Leistung, ab 16 GB Arbeitsspeicher: `ollama pull qwen2.5:7b` (~4,7 GB).
3. Neural OS findet Ollama von allein auf `127.0.0.1:11434`. Oben rechts wird
   aus „Kein Modell" der Modellname.

Das ist **kein** Internetzugriff im Sinne der Netzschleuse: das Modell läuft auf
deinem Rechner. Du kannst danach das Netzwerkkabel ziehen und weiterarbeiten.

---

## Teil 2 · Den Stick vorbereiten

Voraussetzung: Neural OS läuft nach Teil 1.

**Der Stick muss exFAT oder NTFS sein, nicht FAT32.** Auf FAT32 passt keine
Datei über 4 GB — und ein Sprachmodell ist meistens eine. Ohne Modell reicht
FAT32; mit Modell nicht. Wie der Stick formatiert ist, sagt dir Neural OS im
Bereich **Stick**, nachdem du den Pfad eingetippt hast.

1. Stick einstecken. Im Explorer nachsehen, welchen Buchstaben er bekommen hat,
   zum Beispiel `E:`.
2. In Neural OS links auf **Stick**.
3. Bei „Pfad zum Stick" eintippen: `E:\`
4. **Erst ansehen** drücken. Jetzt wird nichts geschrieben — es steht nur da,
   wie viele Dateien kämen, wie viel Platz sie brauchen, wie viel frei ist, und
   was dagegen spricht.
5. Häkchen bei **Meinen Datenbestand mitnehmen** setzen, wenn deine Notizen mit
   auf den Stick sollen. Das Original auf dem Rechner bleibt unverändert.
6. **Stick vorbereiten** drücken.

Danach liegt auf dem Stick:

```
E:\
  Neural OS starten.bat        ← Windows: doppelklicken
  Neural OS starten.command    ← macOS: doppelklicken
  Neural OS starten.sh         ← Linux
  LIESMICH.txt
  app\        das Programm
  runtime\    Node — deshalb braucht der fremde PC nichts
  data\       DEINE DATEN
  models\     das Sprachmodell, falls du es mitnimmst
```

### Den Stick benutzen

Stick in einen beliebigen Windows-Rechner stecken, **`Neural OS starten.bat`**
doppelklicken. Es öffnet sich ein Fenster und danach der Browser mit deinem
System. Fenster offen lassen, solange du arbeitest.

Alles, was du auf diesem fremden Rechner schreibst, landet auf dem Stick — nicht
auf dem fremden Rechner. Stick abziehen, in einen anderen stecken, weiterarbeiten.

### Auch für den Mac

Mitkopiert wird immer nur die Node-Laufzeit **des Rechners, an dem du den Stick
vorbereitest**. Soll derselbe Stick auch an einem Mac starten, brauchst du
einmalig Internet: im Bereich **Stick** die fehlende Plattform hinzufügen. Der
Download geht durch die Netzschleuse, du musst ihn also ausdrücklich erlauben.

Für das **Sprachmodell** gilt das nicht — das kann Neural OS nicht
herunterladen. Dafür brauchst du einmal einen Mac, an dem du denselben Schritt
„Modell mitnehmen" ausführst.

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

Der Fall, um den es geht: der Rechner ist weg, und du willst auf einem neuen
genau da weitermachen, wo du aufgehört hast.

**Sichern:** links auf **Sicherung** → Ziel wählen → **Jetzt sichern**.
Als Ziel den Stick nehmen oder eine zweite Festplatte — nicht den Ordner auf
demselben Rechner, denn der ist im Schadensfall mit weg. Danach steht dort, wie
viele Sätze gesichert wurden und wo sie liegen.

**Prüfen:** in der Liste bei der Sicherung auf **Prüfen**. Das liest jede Datei
und vergleicht ihre Prüfsumme — erst danach weißt du, dass die Sicherung
vollständig ist.

**Wiederherstellen auf einem neuen Rechner:** Teil 1 durchführen, dann
**Sicherung** → Pfad der Sicherung eintragen → **Vorschau**. Dort steht, was
kommt und was verschwindet, bevor irgendetwas geschrieben wird. Für einen
wirklich frischen Rechner ist **„Alles ersetzen"** richtig: die
Erstausstattung fliegt raus und dein Stand kommt an ihre Stelle.

Zwei Dinge reisen bewusst **nicht** mit:

* **Zugangstoken.** Das sind Zugangsdaten eines bestimmten Geräts, kein Wissen.
  Am neuen Gerät erzeugst du neue.
* **Der Netzmodus.** Er wird angezeigt, aber nicht gesetzt — eine Sicherung von
  einem Online-Gerät soll ein bewusst offline gehaltenes nicht stillschweigend
  öffnen.

Und: eine Sicherung liegt standardmäßig **im Klartext**, auch wenn dein Tresor
verschlüsselt ist. Der Bereich sagt das an Ort und Stelle. Wenn du sie irgendwo
hinlegst, wo andere hinkommen, setz eine eigene Passphrase — aber merk sie dir,
denn ohne sie ist die Sicherung dann wertlos.

---

## Was heute noch nicht geht

Ehrlichkeitshalber, damit du nicht danach suchst:

* **Das Modell auf dem Stick** ist im Bau. Bis es fertig ist, reist dein Wissen
  mit, aber die Antworten nicht: auf einem fremden Rechner ohne Ollama siehst du
  alles, bekommst aber keine Chat-Antwort.
* **Das Design** ist noch nicht überarbeitet.
* **Die Fingerbedienung auf dem iPad** ist noch nicht fertig — rund die Hälfte
  der Knöpfe ist kleiner als das, was Apple für einen Finger empfiehlt.
* Neural OS **auf** dem iPad ausführen geht nicht und wird nicht gehen. Es gibt
  auch nichts im App Store; siehe Teil 3.
