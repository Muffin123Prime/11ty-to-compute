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

### 1.2 Neural OS herunterladen

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

Das iPad kann Neural OS **nicht selbst ausführen**. iPadOS lässt keine
Programme von einem USB-Stick starten und hat kein Node. Das ist eine Grenze des
iPads, keine fehlende Funktion hier.

Was geht: das iPad als **Bildschirm** für die Instanz, die auf deinem Windows-Rechner
oder vom Stick läuft. Beide Geräte im selben WLAN.

1. Am Rechner: **Einstellungen → Freigabe im lokalen Netz**.
2. „Freigabe im lokalen Netz erlauben" einschalten.
3. Adresse auf **`0.0.0.0` – alle Netzwerkkarten** stellen und Neural OS einmal
   neu starten (Fenster schließen, `npm start` erneut).
4. **Token erzeugen** drücken. Das Token wird **genau einmal** angezeigt —
   abschreiben oder gleich am iPad eintippen.
5. Die lokale Adresse des Rechners herausfinden: im schwarzen Fenster
   `ipconfig` eintippen, die Zeile „IPv4-Adresse" lesen, etwa `192.168.1.42`.
6. Am iPad in Safari öffnen: `http://192.168.1.42:7777`, Token eintragen.

Ohne Token kommt kein Gerät herein — auch keines aus deinem eigenen WLAN.
Die Freigabe lässt sich jederzeit wieder abschalten, einzelne Token einzeln
entziehen.

**Tipp:** in Safari auf „Teilen" → „Zum Home-Bildschirm" — dann hast du ein
Symbol wie bei einer App.

---

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
* Neural OS **auf** dem iPad ausführen geht nicht und wird nicht gehen.
