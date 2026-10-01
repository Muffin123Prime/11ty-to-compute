# Probelauf – Schritt für Schritt

Der Probelauf klärt am echten Rechner, was sich bei der Entwicklung nicht
prüfen ließ: ob das schwarze Fenster unter Windows wirklich zugeht, ob eine
Schul-Richtlinie Programme vom Stick sperrt, was Gatekeeper am Mac sagt. Er
startet Neural OS **nicht** und ändert nichts an deinen Daten; er misst nur und
gibt dir einen kurzen Text, den du in den Chat einfügst.

Jeder Schritt ist **ein Satz**, darunter steht der **Checkpoint**: das, was du
danach sehen solltest. Siehst du etwas anderes, mach ein **Foto** vom
Bildschirm und schick es in den Chat – dann geht es von dort weiter.

Du brauchst: den Windows-Laptop, einen USB-Stick (am besten leer, exFAT), einmal
Internet – und für Teil C das MacBook.

---

## Teil A · Den Stick vorbereiten (am Windows-Laptop)

**A1.** Öffne diese Adresse im Browser:
`https://github.com/muffin123prime/11ty-to-compute/archive/refs/heads/claude/neural-os-personal-ai-nr8xf8.zip`
> ✔ Im Download-Ordner liegt eine neue ZIP-Datei `11ty-to-compute-claude-neural-os-personal-ai-nr8xf8`.

**A2.** Klick die ZIP-Datei mit der rechten Maustaste an und wähle **Alle extrahieren …** → **Extrahieren**.
> ✔ Ein Ordner mit demselben Namen öffnet sich.

**A3.** Geh in diesem Ordner hinein, bis du den Ordner **`neural-os`** siehst, und öffne ihn.
> ✔ Du siehst `Neural OS starten.bat` und `Probelauf auf den Stick legen.bat`.

**A4.** Doppelklicke **`Neural OS starten.bat`**.
> ✔ Der Browser zeigt Neural OS, unten links steht **Beenden**. (Eine ältere Fassung beendet der Starter selbst.)

**A5.** Steck den USB-Stick ein.
> ✔ Im Explorer erscheint ein neues Laufwerk, zum Beispiel **E:**.

**A6.** Geh in Neural OS auf **Einstellungen**, dort bei **Speicher** auf **Stick**.
> ✔ Unter **Andere Sticks** steht nach ein paar Sekunden **„Leerer Stick: E:\ · … frei“** mit **[Neue KI]**.

**A7.** Tipp auf **[Neue KI]**.
> ✔ Es erscheint die Frage „Damit der Stick auch an Mac startet, lädt Neural OS einmal die Laufzeit dafür von nodejs.org. Darf es?“ mit **[Erlauben]** und **[Nur Windows]**.

**A8.** Tipp auf **[Erlauben]**.
> ✔ Erst läuft „Wird vorbereitet … %“, nach ein paar Minuten steht da **„Fertig. Stick kann raus.“** – ohne „Läuft bisher nur an Windows.“ darunter. (Steht dort „Ohne Internet geht das nicht.“: Internet prüfen und auf **[Für Mac holen]** tippen.)

**A9.** Geh zurück in den Ordner `neural-os` und doppelklicke **`Probelauf auf den Stick legen.bat`**.
> ✔ Im schwarzen Fenster steht **„Der Probelauf liegt jetzt auf dem Stick E:\.“** Eine Taste drücken, das Fenster geht zu.

---

## Teil B · Probelauf am Windows-Laptop

**B1.** Öffne den Stick im Explorer.
> ✔ Dort liegen unter anderem **„Probelauf - Windows“** und **„Neural OS starten - Windows“**.

**B2.** Doppelklicke **„Probelauf - Windows“**.
> ✔ Kurz zeigt ein schwarzes Fenster „Probelauf startet …“, dann öffnet sich im Browser eine schwarz-weiße Seite **„Probelauf“**, oben „Misst …“.

Wenn stattdessen etwas anderes kommt – genau das ist ein Ergebnis:
- Eine blaue Warnung „Der Computer wurde durch Windows geschützt“: **Weitere Informationen** → **Trotzdem ausführen**, und dir merken, dass sie kam.
- Das schwarze Fenster bleibt mit **„Dieser Rechner lässt keine Programme vom Stick starten.“** offen: Foto machen und in den Chat schicken; Teil B ist dann fertig.

**B3.** Beantworte die Fragen auf der Seite mit **Ja** oder **Nein** (zum Beispiel „Ist ein schwarzes Fenster offen geblieben?“).
> ✔ Oben steht **„Gemessen.“**, und der Knopf **[Ergebnis kopieren]** ist blau.

**B4.** Tipp auf **[Ergebnis kopieren]**.
> ✔ Auf dem Knopf steht kurz **„Kopiert“**.

**B5.** Füge den Text hier im Chat ein (Strg+V) und schick ihn ab.
> ✔ Der Text steht im Chat; er beginnt mit „Neural OS Probelauf“ und enthält keinen Namen und keinen Pfad.

**B6.** Tipp auf der Seite auf **[Fertig]**.
> ✔ Oben steht **„Probelauf beendet.“** Den Tab kannst du schließen.

**Am Schul-Laptop:** Teil B dort genauso wiederholen, wenn es geht – Schulrechner haben oft andere Regeln als der eigene.

---

## Teil C · Probelauf am MacBook

**C1.** Steck den Stick in den Mac und öffne ihn im Finder.
> ✔ Links unter „Orte“ steht der Stick, darin **„Probelauf - Mac“**.

**C2.** Doppelklicke **„Probelauf - Mac“**.
> ✔ Ein Terminal-Fenster zeigt „Probelauf startet …“, dann öffnet sich im Browser die Seite **„Probelauf“**.

Wenn stattdessen etwas anderes kommt – auch das ist ein Ergebnis:
- „„Probelauf - Mac“ kann nicht geöffnet werden …“: **Fertig** tippen, dann **Systemeinstellungen → Datenschutz & Sicherheit**, ganz unten **Dennoch öffnen**, und noch einmal doppelklicken. Dir merken, dass die Meldung kam.
- „„Terminal“ möchte auf Dateien auf einem Wechseldatenträger zugreifen“: **Erlauben**, und dir merken, dass die Frage kam.

**C3.** Beantworte die Fragen auf der Seite mit **Ja** oder **Nein**.
> ✔ Die Seite sagt dazu: **„Jetzt im Ordner Inhalt „Probe“ doppelklicken.“**

**C4.** Öffne im Finder auf dem Stick den Ordner **Inhalt** und doppelklicke **„Probe“**.
> ✔ Nach ein paar Sekunden steht auf der Seite **„Probe hat sich gemeldet.“** (Kommt nach einer Minute nichts, fragt die Seite „Kam eine Meldung?“ – ehrlich beantworten.)

**C5.** Tipp auf **[Ergebnis kopieren]**, füge den Text hier im Chat ein (⌘V) und schick ihn ab.
> ✔ Der Text steht im Chat.

**C6.** Tipp auf **[Fertig]** und wirf den Stick im Finder aus (Pfeil neben dem Stick).
> ✔ Oben steht **„Probelauf beendet.“**, und der Stick verschwindet aus dem Finder.

---

## Was danach passiert

Aus den Texten aus Teil B und C entscheidet sich, ob alles so bleiben kann
(etwa das Fenster, das sich von selbst schließt) oder ob etwas nachgebaut wird,
zum Beispiel ein Mac-Start ganz ohne Terminal-Fenster (Paket M im Bauplan).
Die Probelauf-Dateien dürfen auf dem Stick bleiben; sie stören nicht. Wer sie
nicht will, löscht „Probelauf - Windows“, „Probelauf - Mac“ und den Ordner
`PROBELAUF` wieder.

## Für Entwickler

```bash
node tools/probelauf.js --auf-stick /pfad/zum/stick   # Dateien auf einen bestimmten Stick legen
node tools/probelauf.js --auf-stick auto              # auf den einen eingesteckten Stick mit Neural OS
node tools/probelauf.js --trocken                     # nur messen, JSON auf der Konsole
```

Was der Probelauf misst und welche Entscheidung daran hängt, steht in
`docs/STICK-BAUPLAN.md`, Abschnitt 2.2 und Teil 3.
