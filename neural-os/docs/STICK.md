# Neural OS auf dem USB-Stick

Stick rein, starten antippen, läuft — mit allem, was deine KI über dich weiß.

Der fremde Rechner braucht dafür **nichts**: kein Node, keine Installation,
keine Administratorrechte. Alles liegt auf dem Stick. Die KI selbst ist Claude
und braucht Internet; dein Schlüssel dafür liegt in deinem Tresor und reist mit.

Alles Folgende findest du in Neural OS unter **Einstellungen → Stick**. Dort
gibt es genau vier Knöpfe.

---

## 1 · Stick vorbereiten

1. Stick einstecken. Neural OS sucht ihn selbst — unter Windows auf den
   Laufwerken D: bis Z:, am Mac unter `/Volumes`, unter Linux unter `/media`
   und `/run/media` — und trägt ihn ins Feld ein. Findet es keinen, steht
   genau das da; dann **Neu suchen** oder den Ort von Hand eintragen.
2. **Stick vorbereiten** tippen.
3. Soll der Stick auch an Windows *und* am Mac starten, muss Neural OS dafür
   einmal die Laufzeit von nodejs.org holen. Darum fragt der Knopf einmal:
   **Erlauben** oder **Nur <dieses System>**. „Erlauben" gibt der Netzschleuse
   genau eine Freigabe — nur für nodejs.org, höchstens 30 Minuten, und nach dem
   Vorgang wird sie wieder zurückgezogen.
4. Ein Balken läuft durch. Jede Bewegung darin kommt aus einem echten Schritt
   (kopierte Bytes, begonnener Download), keine Animation.
5. Danach: „Der Stick ist fertig", an welchen Rechnern er startet, und drei
   Sätze, wie es weitergeht.

Was dabei passiert, entscheidet der Stick selbst:

| Der Stick ist … | Dann passiert |
|---|---|
| leer, oder ein Neural-OS-Stick ohne Wissen | Programm, Laufzeiten und dein Wissen kommen drauf. Das Original bleibt, wie es ist. |
| schon ein Neural-OS-Stick mit Wissen | Das Wissen darauf bleibt **unberührt** — es kann neuer sein als das hier. Nur das Programm wird erneuert, fehlende Laufzeiten kommen dazu. |
| der Stick, von dem Neural OS gerade läuft | Nur fehlende Laufzeiten kommen dazu. Das laufende Programm kann sich nicht selbst ersetzen. |

Scheitert eine Laufzeit (kein Internet, Schleuse zu), ist der Stick trotzdem
fertig: er startet dann an Rechnern mit demselben Betriebssystem, und die
Ansicht sagt, welches System fehlt und warum. Ein späterer Klick mit Internet
holt es nach.

Danach liegt auf dem Stick:

```
DEIN-STICK/
  Neural OS starten.bat        ← Windows: doppelklicken
  Neural OS starten.command    ← Mac: beim ersten Mal Rechtsklick → Öffnen
  Neural OS starten.sh         ← Linux
  LIESMICH.txt
  app/                         das Programm
  runtime/                     die Laufzeit – deshalb braucht der PC nichts
  data/                        DEIN WISSEN
  Sicherungen/                 was „Jetzt sichern" hier ablegt
  sync/
  neural-os.portable           Markierung: "Daten liegen hier, nicht im PC"
```

Platzbedarf (gemessen): rund 8 MB Programm und 80–120 MB je Laufzeit — bis zu
vier Stück (Windows, Mac mit Apple-Chip, Mac mit Intel, dazu die des
vorbereitenden Rechners), plus dein Wissen. Ein 1-GB-Stick reicht.

## 2 · Jetzt sichern

Ein Knopf. Steckt ein Stick (der aus dem Feld), landet die Sicherung auf dem
Stick im Ordner `Sicherungen`; sonst im Sicherungsordner dieser Installation.
Daneben steht still, wann zuletzt gesichert wurde und wo.

Jede Sicherung ist ein eigener Ordner mit Zeitstempel; eine ältere wird nie
ersetzt. Sie enthält alles zum Zurückspielen (JSON) und eine lesbare Fassung
(Markdown), samt Anhängen.

## 3 · Von einer Sicherung wiederherstellen

Klein darunter, weil man es selten braucht. Sicherung antippen (oder ihren
Ordner eintragen) — Neural OS zeigt zuerst, was passieren würde: wie viele
Einträge kommen, was verschwindet. Geschrieben ist bis dahin nichts. Erst dann
wird **Wiederherstellen** frei.

- **Ergänzen** nimmt nichts weg; nur was fehlt, kommt dazu.
- **Gleiche ersetzen** überschreibt Einträge mit derselben Kennung.
- **Nur in leeren Tresor** bricht ab, sobald hier etwas liegt.
- **Alles ersetzen** löscht zuerst alles hier. Für einen frischen Rechner richtig.

Zugangstoken fürs lokale Netz und der Netzmodus reisen bewusst nicht mit.

## 4 · Beenden & abziehen

Ein Knopf, eine Rückfrage. Dann:

1. Läuft noch ein Kopiervorgang, passiert **nichts** — ein mitten im Schreiben
   abgezogener Stick ist ein halber Stick.
2. Dein Tresor wird auf den Stick geschrieben (fsync), bevor irgendwer
   „abziehen" sagt.
3. Läuft Neural OS **vom Laptop** und steht ein Stick im Feld, wird er
   ausgeworfen, soweit das ohne Administrator geht: unter Windows über die
   Shell („Auswerfen" wie im Kontextmenü), am Mac über `diskutil eject`.
   Unter Linux wird nur der Schreibpuffer geleert. Das Laufwerk, auf dem das
   Programm selbst liegt, wird nie ausgeworfen.
4. Neural OS schließt sich sauber.
5. Erst wenn der Server wirklich nicht mehr antwortet, steht da:
   **„Jetzt kannst du den Stick abziehen."**

Läuft Neural OS **vom Stick**, kann es ihn nicht selbst auswerfen — das
Programm liegt ja darauf. Der Starter schließt sein Fenster dann selbst und
gibt den Stick frei; abziehen geht, sobald die Meldung dasteht.

## Beim ersten Start auf einem fremden PC

- **Windows** zeigt eventuell „Windows hat den Start dieser App verhindert"
  (SmartScreen). *Weitere Informationen* → *Trotzdem ausführen*. Die Datei ist
  nicht bei Microsoft signiert; das heißt nicht, dass etwas nicht stimmt.
- **Mac** zeigt beim ersten Mal eine Sicherheitswarnung. **Rechtsklick** auf
  „Neural OS starten.command" → **Öffnen** → *Öffnen*. Nur beim ersten Mal.
- **Linux** braucht eventuell das Ausführbar-Bit:
  `chmod +x "Neural OS starten.sh"`

## Die unbequemen Wahrheiten

**Ein verlorener Stick ist ein verlorener Datenbestand — und ein gelesener.**
Die meisten Sticks sind mit exFAT oder FAT32 formatiert; diese Dateisysteme
kennen keine Zugriffsrechte. Wer den Stick findet, liest alles, auch die
Sicherungen darauf. Deshalb: **Einstellungen → Verschlüsselung einschalten.**
Passphrase verloren heißt Daten verloren; schreib sie irgendwo auf, aber nicht
auf den Stick.

**Ein fremder PC ist ein fremder PC.** Solange Neural OS dort läuft, kann dieser
Rechner deine Daten grundsätzlich lesen. Der Stick ist gut für deine Rechner und
Rechner, denen du vertraust.

**Eine Sicherung gehört woanders hin.** Eine Sicherung auf dem Stick schützt vor
einem kaputten Tresor, nicht vor einem verlorenen Stick. Sichere ab und zu vom
Laptop auf den Stick *und* vom Stick auf den Laptop.

**Claude braucht Internet.** Ohne Netz siehst du alles, was du hast — Notizen,
Termine, Projekte, das Gehirn —, bekommst aber keine neuen Antworten.

**Geschwindigkeit.** Ein langsamer USB-2-Stick macht die App spürbar träger,
weil jede Änderung geschrieben wird. Ein USB-3-Stick fühlt sich an wie eine
interne Platte.

## Wenn etwas nicht geht

| Problem | Abhilfe |
|---|---|
| „Kein Stick gefunden" | Stick steckt nicht oder ist noch nicht eingehängt: kurz warten, **Neu suchen**. Oder den Ort von Hand eintragen (`E:\`, `/Volumes/STICK`). |
| „Es fehlt die Laufzeitumgebung für …" (beim Starten) | Der Stick wurde ohne diese Laufzeit vorbereitet. An einem Rechner mit Neural OS und Internet noch einmal **Stick vorbereiten** → **Erlauben**. Das Wissen auf dem Stick bleibt. |
| „… fehlt: Die Netzschleuse hat den Zugriff … blockiert" | Du hast „Nur dieses System" gewählt oder die Schleuse ist zu. Noch einmal **Stick vorbereiten** → **Erlauben**. |
| „Gerade läuft noch …" beim Beenden | Ein Kopiervorgang läuft. Warten, bis der Balken durch ist. |
| „Ausgeworfen hat ihn Windows nicht" | Ein anderes Programm hat noch eine Datei darauf offen (z. B. ein Explorer-Fenster). Alles ist gespeichert; abziehen geht trotzdem. |
| „Neural OS antwortet noch" | Das schwarze Fenster schließen; dann abziehen. |
| Windows blockiert den Start | SmartScreen: *Weitere Informationen* → *Trotzdem ausführen*. |
| Nach einer Erweiterung geht nichts mehr | `app/bin/neural-os.js start --safe` startet ohne Erweiterungen. |
| Port belegt | Passiert automatisch — die App weicht aus und nennt die neue Adresse. |
| Stick beim Kopieren abgezogen | Noch einmal **Stick vorbereiten**. Halb Kopiertes wird repariert; `data/` wird dabei nie angefasst. |

## Derselbe Weg über die Kommandozeile

```bash
node bin/neural-os.js stick prepare /pfad/zum/stick
node bin/neural-os.js stick prepare /pfad/zum/stick --include-vault
node bin/neural-os.js stick prepare /pfad/zum/stick --runtimes win-x64,darwin-arm64
node bin/neural-os.js stick update  /pfad/zum/stick   # nur das Programm, data/ bleibt
node bin/neural-os.js stick verify  /pfad/zum/stick   # prüft, schreibt nichts
```

Es sind dieselben Funktionen wie hinter den Knöpfen (`src/portable/stick.js`),
mit denselben Zusagen: nichts wird geschrieben, bevor feststeht, dass der Platz
reicht; jeder Ordner landet in einem Zug; `data/` wird von einem Erneuern nie
angefasst — das ist im Code erzwungen und durch einen Test belegt.

---

## Zusammengefasst

| | |
|---|---|
| Was der fremde PC braucht | **Nichts.** Die Laufzeit liegt auf dem Stick. |
| Wo dein Wissen liegt | `<stick>/data` — und nur dort |
| Die KI | Claude, online. Der Schlüssel reist im Tresor mit. |
| Braucht es Internet? | Für Claude ja. Für den Stick nur einmal, für die Laufzeiten anderer Betriebssysteme. |
| Wo steht das alles in der App? | **Einstellungen → Stick** |
| Aufhören | **Beenden & abziehen** — erst wenn „Jetzt kannst du den Stick abziehen" dasteht, abziehen. |
| Wichtigste Maßnahme | **Verschlüsselung einschalten.** Ein Stick geht verloren. |
