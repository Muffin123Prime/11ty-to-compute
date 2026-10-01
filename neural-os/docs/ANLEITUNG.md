# Anleitung: die Bereiche von Neural OS

Wie du Neural OS zum ersten Mal startest, steht in `docs/ERSTE-SCHRITTE.md`;
alles zum Stick in `docs/STICK.md`. Diese Seite erklärt, was in den einzelnen
Bereichen der App steckt.

Links steht die Leiste: **Neuer Chat, Kalender, Notizen, Projekte, Agenten,
Gehirn, Werkstatt, Einstellungen**, darunter die letzten Chats, ganz unten
**[Beenden]** und der Status („Offline“, „Online verbunden · Gemini“ …).
Rechts stehen Kacheln mit dem, was gerade zählt (aktive Agenten, Termine von
heute, die letzte Notiz, ein Ausschnitt aus dem Gehirn). Beide Seiten lassen
sich ein- und ausklappen; eingeklappt bleibt nur der Chat.

---

## Chat

Unten das Eingabefeld: Text tippen und abschicken, mit der Büroklammer
**Bilder** (PNG, JPG, WEBP, GIF) oder **PDF** anhängen, mit dem Mikrofon
**sprechen** statt tippen.

**Antworten mit Bausteinen.** Die KI antwortet nicht nur mit Text, sondern
baut sich ihre Antwort aus Bausteinen: Auswahl-Knöpfe, Formulare, Karten,
Diagramme, Checklisten, Schritte zum Durchblättern, Reiter, Quiz,
Lernkarten, Lückentexte, Zuordnungen, Timer, Terminkarten, Dateien und
Vorschauen. Jede Tabelle ist sortierbar. Was du in einem Baustein antippst,
geht als neue Nachricht an die KI.

**Rund um jede Antwort** (beim Überfahren, am iPad immer):

- **Kopieren**, **Vorlesen** (kleiner Spieler mit Tempo, der gelesene Satz ist
  hervorgehoben),
- **Neu erstellen** – kürzer, einfacher, ausführlicher, kreativer, anders
  formuliert,
- **Umwandeln** – verbessern, zusammenfassen, übersetzen oder als Tabelle,
  Diagramm, Checkliste, Schritte darstellen,
- **Fassungen** – jede neue Erstellung ist eine weitere Fassung derselben
  Antwort; mit ← → blätterst du zwischen ihnen.

**Text markieren** in einer Antwort öffnet ein kleines Menü: Erklären, Kürzen,
Umschreiben, Übersetzen, Verbessern, Zusammenfassen, Frage dazu. Kürzen und
Umschreiben ändern nur die markierte Stelle.

**Quellen** stehen nummeriert unter der Antwort; die Zahlen im Text verweisen
darauf. Eine Quelle aus deinem Wissen öffnet die Notiz in der App, nicht im
Netz.

**„Mein Wissen“** (Knopf am Eingabefeld): Die KI antwortet dann nur aus deinen
eigenen Notizen, Terminen und Einträgen und sucht nicht im Internet.

**Was die KI im Chat tun darf:** Termine anlegen, ändern und löschen, Notizen
festhalten, sich etwas merken („Gemerkt“-Karte, alles ansehen und vergessen
unter **Einstellungen → Gedächtnis**) und einen **Hintergrund-Agenten**
starten. Jede solche Handlung steht als Karte im Chat, meist mit
**[Rückgängig]**.

Während die KI arbeitet, zeigt der Chat, was wirklich passiert („Denkt nach
…“, „Sucht: …“, „Termin eingetragen“); danach klappt es zu „3
Arbeitsschritte“ zusammen. **[Stopp]** bricht ab.

---

## Kalender

Tag, Woche, Monat oder Liste. Termine mit Uhrzeit oder ganztägig, Serien
(„jeden Dienstag bis Juni“), einzelne Vorkommen verschieben oder ausfallen
lassen, Erinnerungen (solange Neural OS offen ist, auf Wunsch als
Mitteilung). Einzelne Termine oder alle lassen sich als `.ics`-Datei
weitergeben – **„In Kalender übernehmen (.ics)“** trägt einen Termin etwa in
den Kalender des iPads ein.

Am einfachsten sagst du es im Chat: „Zahnarzt am Dienstag um 10“. Die KI trägt
ein, und die Karte im Chat hat [Öffnen] und [Rückgängig].

---

## Notizen

Die KI hält fest, was du ihr im Chat sagst; die Ansicht ist eine **Wand zum
Wiederfinden** (oder eine Liste): oben die Suche und die Auswahl „Alle /
Automatisch / Angeheftet“, an jeder Notiz, aus welchem Chat sie stammt. Eine Notiz öffnen zeigt sie gesetzt, mit
**„Verknüpft mit“** (welche Notizen dazugehören und warum) und den
`[[Links]]`, die auf sie zeigen. Notizen lassen sich anheften, bearbeiten,
löschen (mit Rückgängig) und aus Dateien importieren.

---

## Projekte

Projekte mit Aufgaben, nächstem Termin und allem, was dazu verknüpft ist.
**[Im Gehirn zeigen]** springt zum Projekt im Gehirn.

---

## Agenten

Agenten sind Helfer, die selbstständig Schritte ausführen – mit einzeln
erteilten Rechten (Notizen lesen, schreiben, Verbindungen anlegen, ins Netz),
Bestätigungspflicht für alles Heikle und einem vollständigen Protokoll.

- **Gerade aktiv** – was läuft, mit **[Abbrechen]**.
- **Wartet auf dich** – Freigaben, um die ein Agent bittet.
- **Vorschläge** – was ein Hintergrund-Agent aus dem Chat vorschlägt. Er legt
  selbst nichts an; erst **[Übernehmen]** macht es wahr, **[Verwerfen]**
  verwirft es.
- **Verlauf** – jeder Lauf mit jedem Schritt.

---

## Gehirn

Dein Wissen als Universum. Ganz außen siehst du **Themenbereiche** (aus
Schlagworten und Verbindungen); ein Klick auf ein Thema zoomt hinein, und das
Netz der Einträge darin kommt zur Ruhe. Oben die Brotkrumen („Mein Wissen ›
Alltag“), die Suche findet jeden Eintrag.

Rechts die **Karte** des gewählten Eintrags: **Verknüpft mit** (mit dem Grund
jeder Verbindung), Themen und eine **KI-Zusammenfassung** – auf Knopfdruck,
einmal erstellt und dann gemerkt, bis sich der Eintrag ändert. Neue
Verbindungen erscheinen sofort, ohne Neuladen.

---

## Werkstatt

Hier veränderst du die App selbst: **[Code einfügen]**, **[Prüfen]** (läuft
probehalber, ohne etwas zu ändern), **[Einschalten]**. Jede Erweiterung lässt
sich abschalten, jede frühere Fassung zurückholen. Geht nach einer
Erweiterung nichts mehr: `node bin/neural-os.js start --safe` startet ohne
Erweiterungen. Mehr in `docs/ERWEITERN.md`.

---

## Einstellungen

- **Name dieser KI** – steht oben in der App und auf anderen Sticks („Anderer
  Stick: …“).
- **KI** – Gemini (kostenlos) oder Claude verbinden, Schlüssel prüfen,
  wechseln.
- **Gedächtnis** – was sich die KI über dich gemerkt hat, mit Herkunft;
  einzeln **[Vergessen]** (mit Rückgängig) oder „Alles vergessen …“.
- **Schutz** – PIN einrichten (4 bis 6 Ziffern). Mit PIN ist der Tresor
  verschlüsselt, und der Browser fragt beim Start danach. „Dieses Gerät
  merken“ nur am eigenen Laptop.
- **iPad verbinden** – QR-Code für das iPad im selben WLAN
  (`docs/ERSTE-SCHRITTE.md`, Teil 3).
- **Darstellung** – dunkel, hell oder wie das System.
- **Netzwerk** – die Netzstufe in einem Satz; **[Zum Netzwerk]** zeigt jede
  Verbindung, die Neural OS versucht hat, und die Freigaben.
- **Speicher** – wo die Daten liegen und wie groß sie sind, mit den Wegen zu
  **Stick** und **Sicherung**.
- **Für Fortgeschrittene** (eingeklappt) – beobachtete Ordner (neue Dateien
  daraus kommen in den Tresor), Zugänge und Diagnose.

---

## Die Netzstufen

Jeder Zugriff nach draußen läuft durch eine Schleuse und steht im Protokoll –
auch die erlaubten.

| Stufe | Bedeutung |
|---|---|
| **Offline** | Nichts verlässt diesen Rechner. Ab Werk eingestellt. Notizen, Kalender, Gehirn gehen weiter; die KI antwortet nicht. |
| **Nur lokales Netz** | Zusätzlich dein WLAN – aber kein Internet, die KI ist so nicht erreichbar. |
| **Online** | Die KI und die Websuche dürfen ins Internet. „Online gehen und verbinden“ beim Einrichten der KI stellt es ein. |

Feiner geht es mit **Freigaben**: Geltungsbereich, Ablaufzeit und maximale
Anzahl („dieser Agent, für diesen Lauf, für `de.wikipedia.org`, dreimal“).
[Für Mac holen] in der Stick-Ansicht legt zum Beispiel genau eine Freigabe für
nodejs.org an und zieht sie danach wieder zurück.

---

## Tastenkürzel

| Taste | Was |
|---|---|
| **Strg+K** | Befehle und Suche über alles |
| **Strg+Umschalt+N** | eine Zeile festhalten, ohne den Bereich zu wechseln |
| **g**, dann **c / k / n / p / a / g / w / e** | Chat, Kalender, Notizen, Projekte, Agenten, Gehirn, Werkstatt, Einstellungen |
| **g**, dann **t** | Stick |
| **?** | alle Tastenkürzel |

---

## Deine Daten und die Sicherung

Am eigenen Rechner liegt alles in einem Ordner (`~/.neural-os`, unter Windows
`C:\Users\<Name>\.neural-os`), auf dem Stick im Ordner `Inhalt`. Das
Operationslog ist Klartext, eine Zeile pro Änderung – mit PIN verschlüsselt.

**Sichern:** in der Stick-Ansicht **[Jetzt sichern]** – eine vollständige
Sicherung in einen neuen Ordner mit Zeitstempel (auf dem Stick im Ordner
`Sicherungen`, am Rechner im Sicherungsordner). Oder auf der Kommandozeile:

```bash
node bin/neural-os.js export --format both                      # JSON zum Zurückspielen + lesbares Markdown
node bin/neural-os.js export --format both --passphrase "..."   # verschlüsselt
```

**Wiederherstellen:** in der Stick-Ansicht **Von einer Sicherung
wiederherstellen**. Erst kommt die Vorschau („geschrieben ist noch nichts“),
dann wird **[Wiederherstellen]** frei.

| Modus | Was er tut |
|---|---|
| **Ergänzen** (Voreinstellung) | Vorhandenes bleibt, nur was fehlt, kommt dazu. |
| **Gleiche ersetzen** | Gleiche Kennung wird überschrieben; was hier zusätzlich liegt, bleibt. |
| **Nur in leeren Tresor** | Bricht ab, sobald hier etwas liegt. |
| **Alles ersetzen** | Löscht zuerst alles hier und spielt dann die Sicherung ein. Richtig für einen neuen Rechner. |

Bewusst **nicht** mit reisen: Zugangstoken fürs lokale Netz, der Netzmodus,
das Netzprotokoll dieses Geräts und der Schlüssel der Verschlüsselung (nach
dem Wiederherstellen PIN neu einrichten).

---

## Rückgängig

Fast alles, was du oder die KI ändert, lässt sich zurücknehmen: an der Karte im
Chat ([Rückgängig]), an der kurzen Meldung unten nach dem Löschen, in den
Einstellungen beim Vergessen. Was ein Hintergrund-Agent vorschlägt, wird gar
erst mit [Übernehmen] wahr.

---

## Wenn etwas nicht geht

| Was du siehst | Was hilft |
|---|---|
| Der Chat sagt, es sei keine KI verbunden | **Einstellungen → KI**: Schlüssel einfügen, „Online gehen und verbinden“. |
| „Google-Limit erreicht“ | Die kostenlose Stufe ist für heute aufgebraucht. Morgen geht es weiter – oder Claude wählen. |
| Unten links „Offline“, die KI antwortet nicht | Netzstufe auf Online stellen (**Einstellungen → Netzwerk**). |
| „Neural OS ist aus.“ | Neural OS läuft nicht (Stick gezogen, beendet). Den Starter noch einmal doppelklicken. |
| „PIN nötig“ | Dieser Browser hat die KI noch nicht entsperrt; die PIN eingeben. |
| Das iPad kommt nicht durch | Beide im selben WLAN? Windows-Frage „im Netzwerk kommunizieren“ zugelassen? Schul- und Gast-WLANs trennen Geräte oft. |
| Nach einer Erweiterung geht nichts mehr | `node bin/neural-os.js start --safe` |
| Beim Stick | `docs/STICK.md`, „Starten“ und „Einen neuen Stick anlegen“ |
| Etwas anderes | `npm run doctor` sagt, was geht und was fehlt. |
