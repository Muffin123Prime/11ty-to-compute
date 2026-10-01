# Erste Schritte – Windows, Stick, iPad

Diese Anleitung ist für den Fall, dass auf deinem Rechner noch gar nichts läuft.
Sie ist für **Windows 10/11** geschrieben; für den Mac steht das Abweichende
jeweils darunter.

Was am Ende dasteht:

* Neural OS läuft auf deinem Windows-Rechner, und die KI antwortet im Chat.
* Ein USB-Stick mit einer **eigenen KI**, der an Windows und am Mac per
  Doppelklick startet – ohne Installation, ohne Administratorrechte.
* Dein iPad zeigt Neural OS über dein WLAN.

**Kosten:** Neural OS selbst kostet nichts – keine Domain, kein Server, kein
Abo. Die KI ist entweder **Gemini von Google (kostenlos)** oder **Claude von
Anthropic (kostet je Nutzung)**.

---

## Teil 1 · Einmalig auf dem Windows-Rechner

### 1.1 Node.js holen – ohne Installation, ohne Administratorrechte

Neural OS ist ein Programm, das Node.js ausführt – so wie ein Word-Dokument
Word braucht. Node ist kostenlos und kommt von der offiziellen Quelle. Auf
vielen Schul- und Firmenrechnern darf man nichts installieren; deshalb nehmen
wir die Fassung, die einfach nur eine Datei ist:

1. <https://nodejs.org/en/download> öffnen.
2. Ganz nach unten scrollen zu den vorgefertigten Dateien – dort muss
   **Windows** und **x64** stehen.
3. **„Standalone-Binärdatei (.zip)“** nehmen – **nicht** den „Windows
   Installer (.msi)“.
4. Die ZIP-Datei im Download-Ordner mit Rechtsklick → **Alle extrahieren …**
   entpacken. Der Ordner `node-v…-win-x64` darf dort liegen bleiben – Neural OS
   findet ihn.

### 1.2 Neural OS auf den Rechner holen

1. Diese Adresse öffnen – die ZIP-Datei lädt sofort:
   `https://github.com/muffin123prime/11ty-to-compute/archive/refs/heads/claude/neural-os-personal-ai-nr8xf8.zip`
2. Die ZIP-Datei mit Rechtsklick → **Alle extrahieren …** entpacken.
3. In den entpackten Ordner hineingehen, bis du den Ordner **`neural-os`**
   siehst (darin liegen `Neural OS starten.bat`, `bin`, `src`, `web`).

### 1.3 Starten – per Doppelklick

1. **`Neural OS starten.bat`** doppelklicken.
2. Ein schwarzes Fenster zeigt kurz „Neural OS startet …“, dann öffnet sich der
   Browser mit `http://127.0.0.1:7777`, und das Fenster schließt sich von
   selbst.
3. **Beenden:** in der App unten links auf **[Beenden]**. Lässt du den Browser
   einfach zu, beendet sich Neural OS nach 10 Minuten von selbst.

Noch einmal doppelklicken öffnet nur den Browser; ein zweites Neural OS startet
nicht.

> **Windows warnt beim Doppelklick** („Der Computer wurde durch Windows
> geschützt“): auf **Weitere Informationen** und dann **Trotzdem ausführen**.
> Das ist die normale Warnung für jede Datei, die nicht aus dem Store kommt.

> **„Dieser Rechner lässt keine Programme vom Stick starten.“** heißt: Der
> Rechner (Schule, Firma) sperrt Programme außerhalb von „Programme“. An
> diesem Rechner hilft dann nichts; er kann aber Bildschirm sein, wie das iPad
> in Teil 3.

> **Mac:** Am einfachsten vom Stick (Teil 2) – dann braucht der Mac gar
> nichts. Wer Neural OS am Mac aus dem Ordner starten will: Node.js für macOS
> als `.tar.gz` holen, im Download-Ordner entpacken (Doppelklick) und im
> Terminal im Ordner `neural-os`
> `~/Downloads/node-v…-darwin-arm64/bin/node bin/neural-os.js start --hintergrund --open`
> eingeben (bei einem Mac mit Intel-Chip `darwin-x64`).

### 1.4 Eine KI verbinden (damit der Chat antwortet)

Neural OS erfindet keine Antworten. Ohne KI sagt der Chat genau das – Notizen,
Kalender, Projekte und das Gehirn funktionieren trotzdem vollständig.

**Kostenlos mit Google (Gemini):**

1. <https://aistudio.google.com/apikey> öffnen, mit dem Google-Konto anmelden
   und **Create API key** antippen – keine Karte nötig. Der Schlüssel beginnt
   mit `AIza`.
2. In Neural OS im Chat unter **„Kostenlos mit Google“** den Schlüssel einfügen
   und **Online gehen und verbinden** antippen. Neural OS prüft ihn sofort.

Auf der kostenlosen Stufe darf Google Inhalte zur Verbesserung nutzen, und die
Zahl der Anfragen je Tag ist begrenzt.

**Oder Claude (kostet je Nutzung):** Auf <https://console.anthropic.com> unter
**API Keys** einen Schlüssel erzeugen (beginnt mit `sk-ant-`) und in Neural OS
im Chat unter „Oder Claude“ oder unter **Einstellungen → KI** einfügen.

Unten links steht danach **Online verbunden · Gemini** (bzw. **· Claude**). Der
Schlüssel liegt im Tresor dieser KI. Gib ihn nirgends sonst ein und schick ihn
niemandem.

---

## Teil 2 · Ein Stick mit eigener KI

**Jeder Stick ist eine eigene KI** mit eigenem Wissen. Wissen teilen nur Sticks,
die du miteinander koppelst (Teil 2.3).

### 2.1 Den Stick vorbereiten

Voraussetzung: Neural OS läuft nach Teil 1, und der Stick ist mit **exFAT**
formatiert (so kommen die meisten Sticks; exFAT verstehen Windows und Mac).

1. Stick einstecken.
2. In Neural OS auf **Einstellungen → Speicher → Stick**. Unter **Andere Sticks**
   steht nach wenigen Sekunden: **„Leerer Stick: E:\ · 14,2 GB frei“**.
3. **[Neue KI]** antippen.
4. Einmal kommt die Frage, ob Neural OS die Laufzeit für den Mac von nodejs.org
   holen darf. **[Erlauben]** – dann startet der Stick an Windows und am Mac.
   **[Nur Windows]** geht ohne Internet; dann startet er nur an Windows.
5. Der Balken läuft: „Wird vorbereitet … 42 %“. Danach steht da:
   **„Fertig. Stick kann raus.“**

Auf dem Stick liegt danach:

```
NEURAL OS (E:)
  Inhalt                          Programm, Daten, Abgleich: nicht anfassen
  LIESMICH
  Neural OS starten - Mac         unter Windows als Ordner „… - Mac.app“ zu sehen
  Neural OS starten - Windows
```

### 2.2 Den Stick benutzen

Stick in einen Windows-Rechner stecken, im Explorer öffnen und **„Neural OS
starten - Windows“** doppelklicken. Am Mac im Finder **„Neural OS starten -
Mac“** doppelklicken – das ist ein kleines Programm, ein Terminal-Fenster
gibt es nicht (fragt macOS nach dem Zugriff auf einen Wechseldatenträger:
**Erlauben**). Der Browser öffnet sich, oben steht der Name dieser KI.

> **Öffnet der Mac das Programm nicht:** im Ordner **„Inhalt“** auf dem Stick
> **„Notstart - Mac“** doppelklicken. Das ist derselbe Start im Terminal.

Alles, was du dort schreibst, landet auf dem Stick – nicht auf dem Rechner.

**Aufhören:** unten links **[Beenden]**. Danach steht nur noch
**„Gespeichert. Stick kann raus.“** Am Mac wirft Neural OS den Stick selbst
aus; dort steht „Gespeichert. Stick kann raus, sobald er aus dem Finder
verschwindet.“

**Der Name der KI** steht unter **Einstellungen → Name dieser KI**.

### 2.3 Zwei Sticks koppeln (optional)

Sollen zwei Sticks dasselbe wissen: Stick A läuft, Stick B steckt daneben.
Unter **Andere Sticks** steht **„Anderer Stick: Lena“ [Koppeln]**. Antippen
(hat B eine PIN, erst die **„PIN von Lena“** eingeben). Danach steht unter
**Gekoppelt**: „Gekoppelt mit Lena · Lena übernimmt beim nächsten Start“. Ab
dann gleichen sich beide von selbst ab. Alles Weitere in `docs/STICK.md`.

### 2.4 Den Stick schützen

Ein Stick geht verloren. **Einstellungen → Schutz → PIN einrichten** (4 bis 6
Ziffern, zweimal). Danach fragt der Browser beim Start nach der PIN, und wer
den Stick findet, kann nichts lesen. PIN vergessen heißt Daten weg – schreib sie
irgendwo auf, aber nicht auf den Stick.

---

## Teil 3 · Das iPad

Neural OS ist **keine App aus dem App Store**, sondern ein Programm, das auf
deinem Rechner oder vom Stick läuft und seine Oberfläche im Browser zeigt. Das
iPad kann es nicht selbst ausführen; es ist der **Bildschirm** dafür. Auf dem
iPad wird nichts installiert.

1. Beide Geräte ins **selbe WLAN**.
2. Am Rechner in Neural OS: **Einstellungen → iPad verbinden**. Es erscheint ein
   QR-Code und „Warte auf das iPad“.
3. Am iPad die **Kamera** auf den QR-Code richten und den gelben Link antippen.
   Safari öffnet Neural OS; am Rechner steht danach „iPad ist verbunden.“

Fragt Windows beim ersten Mal, ob Node.js im Netzwerk kommunizieren darf:
**Zulassen** (privates Netzwerk). Auf Schul-Laptops geht das ohne
Administrator oft nicht, und viele Schul- und Gast-WLANs trennen die Geräte
voneinander – dann kommt das iPad nicht durch.

Das iPad darf lesen und schreiben, aber keine Einstellungen ändern. Die
Freigabe gilt, bis Neural OS beendet wird oder du sie ausschaltest.

**Als Symbol auf den Home-Bildschirm:** In Safari auf **Teilen** (Quadrat mit
Pfeil) → **Zum Home-Bildschirm** → **Hinzufügen**. Läuft Neural OS am Rechner
nicht, bleibt das Symbol leer – es gibt nichts in der Wolke, das weiterlaufen
könnte.

**Querformat:** Die Oberfläche ist für das iPad quer gebaut und mit dem Finger
bedienbar.

---

## Teil 4 · Sicherung

**Sichern = ganzen Stick kopieren.** Dazu gibt es in der Stick-Ansicht
**[Jetzt sichern]**: eine vollständige Sicherung in den Ordner `Sicherungen`
(auf dem Stick, bzw. am Rechner im Sicherungsordner von Neural OS). Daneben
steht, wann zuletzt gesichert wurde. Eine ältere Sicherung wird nie
überschrieben.

**Wiederherstellen:** darunter, klein, **Von einer Sicherung wiederherstellen**.
Neural OS zeigt erst, was passieren würde („geschrieben ist noch nichts“), dann
wird **[Wiederherstellen]** frei.

Eine Sicherung auf demselben Stick schützt vor einem kaputten Tresor, nicht vor
einem verlorenen Stick: den Stick ab und zu auf den Laptop kopieren.

---

## Teil 5 · Welches Gerät kann Neural OS ausführen?

Neural OS braucht **ein** Gerät, auf dem das Programm läuft. Alle anderen sind
Bildschirme dafür (über dein WLAN, wie in Teil 3).

| Gerät | Programm ausführen? | Bildschirm sein? |
|---|---|---|
| Windows-Laptop, Programme dürfen laufen | **ja** (Teil 1 oder vom Stick) | ja |
| Windows-Laptop, Programme gesperrt (Schule/Firma) | nein | **ja**, im Browser |
| MacBook (macOS 11 oder neuer) | **ja**, vom Stick ohne Administrator | ja |
| iPad / iPhone | nein, iPadOS startet keine Programme | **ja** |
| PlayStation 4 | nein | nein (der Browser ist zu alt) |

## Was sich hier nicht prüfen ließ

Ehrlichkeitshalber: Die Starter für Windows und Mac konnten bei der Entwicklung
nur auf Linux ausprobiert werden, mit nachgestellten Mac-Befehlen, nicht auf
einem echten Windows oder Mac. Für alles, was dort anders sein könnte, gibt es
einen Ausweg: am Mac den Notstart im Ordner „Inhalt“, und kann ein Mac den
Stick nicht selbst auswerfen, sagt der Endtext „Stick im Finder auswerfen.“
Wer es genau wissen will, macht den freiwilligen **Probelauf** – ein
Doppelklick je Rechner. Die Schritte stehen in `docs/PROBELAUF.md`.
