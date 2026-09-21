# Neural OS auf dem USB-Stick

Stick rein, doppelklicken, dein System ist da — mit allen Notizen, auf jedem PC.

Der PC braucht dafür **nichts**. Kein Node, keine Installation, keine
Administratorrechte. Alles liegt auf dem Stick.

---

## Die wichtigste Einsicht zuerst

Du hattest zwei Dinge im Sinn: alles auf dem Stick haben, **und** ein Backup,
das sich abgleicht. Das sind zwei verschiedene Fälle, und der erste ist viel
einfacher, als du denkst:

**Liegt alles auf dem Stick, brauchst du überhaupt keine Synchronisation.**
Die Daten *sind* dort, wo du bist. Stick am Laptop rein → deine Notizen. Stick
am fremden PC rein → dieselben Notizen. Es gibt nichts abzugleichen, weil es nur
einen Datenbestand gibt.

Abgleichen musst du nur, wenn ein PC einen **eigenen** Datenbestand hat, den du
mit dem Stick zusammenführen willst. Dafür gibt es den Ordner-Abgleich weiter
unten. Aber fang mit dem einfachen Fall an — für die meisten ist er der richtige.

---

## Teil 1 · Den Stick vorbereiten

Einmalig, auf deinem eigenen PC, auf dem Neural OS schon läuft:

```bash
node bin/neural-os.js stick prepare /pfad/zum/stick
```

Das legt an:

```
DEIN-STICK/
  Neural OS starten.bat        ← Windows: doppelklicken
  Neural OS starten.command    ← macOS: doppelklicken
  Neural OS starten.sh         ← Linux
  LIESMICH.txt
  app/                         das Programm
  runtime/                     Node, mitgeliefert – deshalb braucht der PC nichts
  data/                        DEINE DATEN
  sync/                        Postfächer für den Ordner-Abgleich
  neural-os.portable           Markierung: "Daten liegen hier, nicht im PC"
```

**Deine bisherigen Daten mitnehmen:**

```bash
node bin/neural-os.js stick prepare /pfad/zum/stick --include-vault
```

Kopiert deinen aktuellen Datenbestand auf den Stick. Das Original auf dem PC
bleibt unverändert.

**Für andere Betriebssysteme:** Der Befehl legt immer die Laufzeit des Rechners
bei, auf dem du ihn ausführst — das geht ohne Internet. Willst du den Stick
zusätzlich auf Windows *und* Mac benutzen, brauchst du einmalig Internet:

```bash
node bin/neural-os.js stick prepare /pfad/zum/stick --runtimes win-x64,darwin-arm64
```

Das lädt die offiziellen Node-Pakete, **prüft ihre Prüfsummen** und entpackt nur
die Programmdatei. Es geht durch dieselbe Netzschleuse wie alles andere — du
musst also den Netzmodus auf *Internet* stellen oder eine Freigabe für
`stick:runtime` erteilen. Blockiert die Schleuse, ist das kein Fehler: der Stick
läuft trotzdem auf deinem eigenen Betriebssystem.

Platzbedarf: rund **120 MB pro Betriebssystem**, plus deine Daten. Ein 8-GB-Stick
reicht für alles außer den KI-Modellen.

## Teil 2 · Den Stick benutzen

Stick in irgendeinen PC → Ordner öffnen → **„Neural OS starten"** doppelklicken.

Der Starter sucht die passende Laufzeit, startet das Programm und öffnet deinen
Browser. Ist der übliche Port belegt, weicht die App selbständig aus und sagt
dir, unter welcher Adresse sie läuft.

Beim Beenden: **Strg+C** im schwarzen Fenster, dann den Stick auswerfen. Ziehst
du ihn mitten im Schreiben ab, geht höchstens die letzte Zeile verloren — das
Log ist absturzsicher und wird beim nächsten Start repariert. Sauber beenden ist
trotzdem besser.

### Beim ersten Start auf einem fremden PC

- **Windows** zeigt eventuell „Windows hat den Start dieser App verhindert"
  (SmartScreen). *Weitere Informationen* → *Trotzdem ausführen*. Das liegt
  daran, dass die Datei nicht bei Microsoft signiert ist — nicht daran, dass
  etwas nicht stimmt.
- **macOS** zeigt beim ersten Mal eine Sicherheitswarnung. **Rechtsklick** auf
  „Neural OS starten.command" → **Öffnen** → *Öffnen* bestätigen. Nur beim
  ersten Mal nötig.
- **Linux** braucht eventuell das Ausführbar-Bit:
  `chmod +x "Neural OS starten.sh"`

## Teil 3 · Die unbequemen Wahrheiten

Ich sage sie lieber jetzt als hinterher.

### Ein verlorener Stick ist ein verlorener Datenbestand

Die meisten Sticks sind mit exFAT oder FAT32 formatiert. Diese Dateisysteme
kennen **keine Zugriffsrechte** — der Schutz, den Neural OS auf deiner
Festplatte durch `0700` hat, existiert dort schlicht nicht. Wer den Stick
findet, liest alles.

**Deshalb: Verschlüsselung einschalten.** *Einstellungen → Verschlüsselung*.
Danach fragt die App beim Start nach deiner Passphrase, und wer den Stick
findet, sieht nur Rauschen.

> **Passphrase verloren heißt Daten verloren.** Es gibt keine Hintertür, weil
> eine Hintertür den Zweck aufhebt. Schreib sie irgendwo auf, wo du sie
> wiederfindest — aber nicht auf den Stick.

Noch sicherer ist zusätzlich eine Verschlüsselung des ganzen Datenträgers
(BitLocker To Go, VeraCrypt, LUKS). Dann sind auch die Dateinamen geschützt.

### Ein fremder PC ist ein fremder PC

Solange die App dort läuft und der Vault entsperrt ist, kann dieser PC deine
Daten grundsätzlich lesen. Ein Rechner mit Schadsoftware könnte deine Passphrase
mitlesen, während du sie tippst. Dagegen hilft keine Software auf dem Stick.

Praktisch heißt das: Der Stick ist gut für **deine** Rechner und Rechner, denen
du vertraust. In einem Internetcafé würde ich ihn nicht einstecken.

### FAT32 kann keine Datei über 4 GB

Falls du später ein KI-Modell mit auf den Stick nehmen willst: Modelle sind oft
größer. **Formatiere den Stick als exFAT**, dann fällt diese Grenze weg. Der
Vorbereitungsbefehl warnt dich, wenn er FAT32 vorfindet.

### Geschwindigkeit

Ein langsamer USB-2-Stick macht die App spürbar träger, weil jede Änderung
geschrieben wird. Ein USB-3-Stick oder eine kleine externe SSD fühlt sich an wie
eine interne Festplatte.

## Teil 4 · Das Programm auf dem Stick aktualisieren

```bash
node bin/neural-os.js stick update /pfad/zum/stick
```

Erneuert **nur** den Programmcode. `data/` wird dabei nicht angefasst — das ist
die wichtigste Zusage dieses Befehls, und sie ist durch einen Test abgesichert,
der beweist, dass keine einzige Datei in `data/` sich verändert.

Prüfen, ob mit dem Stick alles in Ordnung ist:

```bash
node bin/neural-os.js stick verify /pfad/zum/stick
```

## Teil 5 · Der zweite Fall: Stick trifft auf einen PC mit eigenen Daten

Du hast Neural OS fest auf deinem Laptop **und** willst den Stick benutzen.
Beide haben eigene Notizen. Dann gleichst du über einen Ordner ab — ohne Netz,
ohne Server.

In der App: **Abgleich** → *Ordner hinzufügen* → den `sync/`-Ordner auf dem
Stick auswählen → *Jetzt abgleichen*.

So funktioniert es: Jedes Gerät legt im `sync/`-Ordner ein eigenes Postfach an
und schreibt nur dort hinein. Beim Abgleich liest es die Postfächer der anderen
und führt zusammen. Der Stick ist dabei nur Briefkasten, nicht Besitzer.

**Was übertragen wird:** Notizen, Projekte, Aufgaben, Begriffe, Erinnerungen,
Chats samt Nachrichten, Dateien und Verknüpfungen.

**Was ausdrücklich NICHT übertragen wird:** Zugangstoken, Netz-Freigaben,
Agenten mit ihren Berechtigungen, die Partnerliste und deine Erweiterungen. Ein
Stick, den du in einen fremden Rechner steckst, verteilt dort also weder Rechte
noch Netzzugang noch ausführbaren Code.

**Bei Konflikten entscheidest du.** Haben beide Geräte denselben Eintrag
geändert, wird nichts überschrieben. Beide Fassungen stehen nebeneinander mit
markierten Unterschieden, und nichts ist vorausgewählt.

Ist dein Vault verschlüsselt, ist auch das Postfach verschlüsselt. Ein Gerät
ohne deine Passphrase kann es nicht lesen — und sagt das, statt Müll zu liefern.

## Teil 6 · Ein KI-Modell mit auf den Stick

Geht, ist aber Handarbeit und lohnt sich nur bei einem schnellen Stick:

1. Stick als **exFAT** formatieren (wegen der 4-GB-Grenze).
2. Ollama portabel auf den Stick legen und mit
   `OLLAMA_MODELS=<stick>/models` starten.
3. Neural OS findet es wie immer auf `127.0.0.1:11434`.

Ehrlich: Ein 7B-Modell von einem USB-2-Stick ist zäh. Von einer externen SSD
läuft es gut. Die Alternative — Modell auf dem jeweiligen PC, Daten auf dem
Stick — ist in den meisten Fällen die bessere.

## Teil 7 · Wenn etwas nicht geht

| Problem | Abhilfe |
|---|---|
| „Keine passende Laufzeit auf dem Stick" | Der Stick wurde für ein anderes Betriebssystem vorbereitet. `stick prepare --runtimes <plattform>` auf einem passenden Rechner. |
| Windows blockiert den Start | SmartScreen: *Weitere Informationen* → *Trotzdem ausführen*. |
| macOS lässt nicht starten | Rechtsklick auf den Starter → *Öffnen* → bestätigen. |
| Das Fenster schließt sich sofort | Starter aus einem Terminal aufrufen, dann bleibt die Fehlermeldung stehen. |
| Nach einer Erweiterung geht nichts mehr | `app/bin/neural-os.js start --safe` startet ohne Erweiterungen. |
| Port belegt | Passiert automatisch — die App weicht aus und nennt die neue Adresse. |
| Stick war voll beim Schreiben | Platz schaffen, dann `stick verify`. Der Vault ist absturzsicher; die letzte unvollständige Zeile wird beim Start repariert. |

## Sicherungen

Auch auf dem Stick gilt: **eine Sicherung gehört woanders hin.** Ein Stick geht
verloren, geht kaputt, wird vergessen.

```bash
node bin/neural-os.js export --format both --dir /pfad/zur/sicherung
```

Schreibt eine vollständige JSON-Datei (wiederherstellbar) und eine lesbare
Markdown-Fassung deiner Notizen und Chats. Leg das regelmäßig auf deine
Festplatte oder eine zweite Platte.

---

## Zusammengefasst

| | |
|---|---|
| Was der fremde PC braucht | **Nichts.** Node liegt auf dem Stick. |
| Wo deine Daten liegen | `<stick>/data` — und nur dort |
| Wird das Heimatverzeichnis des PCs berührt? | Nein |
| Braucht es Internet? | Nur einmal, für ein KI-Modell und für zusätzliche Laufzeiten |
| Brauche ich Synchronisation? | Nur, wenn ein PC einen eigenen Datenbestand hat |
| Platzbedarf | ~120 MB je Betriebssystem plus deine Daten |
| Wichtigste Maßnahme | **Verschlüsselung einschalten.** Ein Stick geht verloren. |
