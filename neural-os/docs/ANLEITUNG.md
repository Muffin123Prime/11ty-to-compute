# Anleitung: die Bereiche von Neural OS

Wie du Neural OS zum ersten Mal startest, steht in `docs/ERSTE-SCHRITTE.md`;
alles zum Stick in `docs/STICK.md`. Diese Seite erklärt, was in den einzelnen
Bereichen der App steckt.

Links steht die Leiste: **Neuer Chat, Kalender, Notizen, Projekte, Agenten,
Gehirn, Werkstatt, Einstellungen**, darunter die letzten Chats, ganz unten
**[Beenden]** und der Status („Offline“, „Online verbunden · Gemini“ …).
Rechts stehen Kacheln mit dem, was gerade zählt (aktive Agenten, Termine von
heute, die letzte Notiz, ein Ausschnitt aus dem Gehirn). Beide Seiten lassen
sich ein- und ausklappen; eingeklappt bleibt nur der Chat. Am rechten Rand
wohnt die **Insel**, ein kleines Wesen.

---

## Die Insel

Das kleine Wesen am rechten Rand – schwarz, weiß und grau, mit einem blauen
Ring. Es ist deine KI für zwischendurch und auf jeder Seite von Neural OS da.
Es sitzt etwas unter der Mitte (am Telefon unten rechts) und rückt ein Stück
nach oben oder unten, wenn dort gerade ein Knopf liegt. Ist die rechte Spalte
zugeklappt, lässt der Inhalt ihm am Rand einen schmalen Streifen frei.

**Am Gesicht siehst du, was es tut:** Es ruht (atmet, blinzelt, schaut dem
Zeiger nach), hört zu (Ohren hoch, der Ring atmet mit deiner Stimme), denkt
(drei Punkte), schreibt oder spricht (der Mund bewegt sich), frisst eine
Datei (es kaut), freut sich, wenn etwas fertig ist, schaut fragend und
schüttelt den Kopf, wenn etwas nicht geht, und schläft, wenn Neural OS aus
oder noch keine KI verbunden ist. Hast du am Computer „Bewegung reduzieren“
eingestellt, bleibt es ruhig und zeigt alles ohne Hüpfen.

**Neben dem Wesen** stehen kleine Schilder mit dem, was gerade läuft: ein
Timer („4:12 Nudeln“), „Denkt …“, „Hört zu“, „Liest vor“, „Sieht deinen
Bildschirm“, ein Termin („In 12 Min · Zahnarzt“), ein Agent, eine wartende
Freigabe – höchstens zwei, der Rest steht drinnen. Kommt eine Antwort,
während die Insel zu ist, bekommt das Wesen einen blauen Punkt, und daneben
steht der Anfang der Antwort. Erinnerungen an Termine erscheinen als Kapsel
neben dem Wesen (× schließt sie). Findet sie keinen freien Platz (etwa im
Kalender auf einem kleinen Bildschirm), liegt die Kapsel kurz über dem
Inhalt wie eine Mitteilung.

**Antippen** (oder **Strg/⌘ + Umschalt + Leertaste**): Das Wesen wächst zu
einem Feld am rechten Rand, am Telefon zu einem Blatt, das von unten kommt.
Oben sitzt das Wesen groß und sagt in einem Satz, was es tut; darunter steht
das Gespräch, unten die Zeile zum Fragen. **Esc**, das Kreuz oben oder ein
Tipp auf das Wesen machen es wieder klein.

**Fragen:** Tippen und senden – oder das **Mikrofon** antippen, sprechen,
noch einmal antippen; dann wird die Antwort auch vorgelesen (ein Tipp auf das
große Wesen hält das Vorlesen an). Es ist dieselbe KI wie im Chat, mit allem,
was sie dort kann: Termine eintragen, Notizen anlegen, sich etwas merken, in
deinem Wissen und im Internet suchen.
Rückfragen beantwortest du mit einem Tipp; was sie angelegt hat, steht unter
der Antwort zum Antippen. Unter jeder Antwort: **Vorlesen, Kopieren, Als
Notiz, Im Chat öffnen**; solange sie noch schreibt, hält **[Stopp]** sie an.
Jedes Gespräch ist ein echter Chat „Insel · …“ unter „Zuletzt“ (öffnen,
weiterschreiben, löschen); nach zwei Stunden Ruhe beginnt sie selbst ein
neues, „Neues Gespräch“ im Menü **„…“** sofort.

**Nachschlagen, Quellen, Hinweise:** Sucht die KI im Internet oder schlägt
sie nach (etwa in Wikipedia), steht über der Antwort eine ruhige Zeile dazu –
erst, was sie gerade tut, dann, was dabei herauskam („Wikipedia: „Brandenburger
Tor“ · 2 Artikel gefunden“). Die Quellen stehen klein unter der Antwort; die
Zahlen [1], [2] im Text führen zur passenden Quelle. Musste sie ausweichen
(„Gemini ist gerade am Limit – es antwortet Mistral.“) oder ging die Suche
nicht, steht das als leiser grauer Satz darunter. Bilder in einer Antwort
zeigt die Insel wie der Chat (antippen vergrößert sie); ein Bild aus dem
Internet lädt Neural OS nicht – dort steht sein Name mit „öffnen ↗“.

**Live – einfach reden:** **[Live]** antippen und sprechen wie mit einem
Menschen. Machst du eine kurze Pause (gut eine Sekunde), hat das Wesen
verstanden: Es antwortet, liest die Antwort vor und hört danach wieder zu.
Willst du dazwischenreden, tippst du das Wesen an – es hört sofort auf zu
sprechen und hört dir zu. Ein Tipp, während es zuhört, heißt „fertig“: Es
antwortet gleich. Am Stück darfst du bis zu einer Minute reden. **Esc** oder
**[Live]** oben beenden das Gespräch; hört das Wesen eine Minute lang nichts,
geht Live von selbst aus und sagt das. Versteht der Browser
Sprache selbst (Chrome, Edge), nimmt die Insel das; kann er es nur dem Namen
nach (etwa Opera), nimmt sie deine Worte auf und lässt sie von Gemini
aufschreiben – dafür braucht es den Google-Schlüssel (Einstellungen → KI).
Das Mikrofon gibt der Browser nur frei, wenn Neural OS auf diesem Gerät läuft
(127.0.0.1), nicht über das WLAN.

**Dateien füttern:** Zieh eine Datei auf das Wesen – es macht schon das Maul
auf – oder in das offene Feld, oder nimm die **Büroklammer**. Es frisst sie,
kaut kurz und liest sie dann wirklich: Bilder (PNG, JPG, WEBP, GIF) und PDF
wie im Chat, Textdateien (.txt, .md, .csv, .json) bis 200 KB als Text. Hast
du nichts dazugeschrieben, fragt es von selbst „Werte diese Datei aus.“ Was
es nicht lesen kann (etwa ZIP oder Word) oder was zu groß ist, nimmt es nicht:
Es schüttelt den Kopf und sagt in einem Satz, warum. Bilder kannst du auch
mit Strg+V einfügen.

**Das Menü „…“** neben der Büroklammer: **Bildschirm zeigen, Über allen
Fenstern, Aus der Zwischenablage, Timer, Neues Gespräch.** Was dein Browser
nicht kann, fehlt dort.

**Bildschirm zeigen:** Der Browser fragt, was du teilen willst – den ganzen
Bildschirm, ein Fenster oder einen Tab. Solange geteilt wird, steht dort ein
kleines Bild davon und „Ich sehe …“, und mit jeder Frage geht ein frisches
Bild mit. So kann die KI sehen, was du gerade in einem **anderen Programm**
vor dir hast („Was siehst du?“, „Erklär mir das“, „Hilf mir antworten“). Das
Bild geht an deine KI (Gemini oder Claude) und liegt danach als Anhang im
Insel-Chat. „Bildschirm geht mit“ antippen schickt die nächste Frage ohne
Bild; **[Stopp]** beendet das Teilen. Am Mac muss der Browser einmal erlaubt
werden (Systemeinstellungen → Datenschutz & Sicherheit → Bildschirm- &
Systemaudioaufnahme).

**Über allen Fenstern:** Die Insel zieht in ein eigenes kleines Fenster, das
über jedem Programm schwebt – auch wenn du in Word, im Browser oder in einem
Spiel bist. Dort geht alles genauso; **Kleiner** lässt nur das Wesen und
seinen Satz stehen, ein Tipp auf das Wesen macht es wieder groß, **Zurück in
Neural OS** holt die Insel zurück (solange steht in Neural OS am Rand „Insel
schwebt · zurückholen“). Das geht in Chrome, Edge, Opera und Firefox (ab
Version 151) am Computer, nicht in Safari und nicht auf dem iPad. Das Fenster gehört zum Tab von Neural
OS: Schließt du den, geht es mit zu.

**Ohne die KI, sofort:** „Timer 5 min“ (auch „Timer 8 min Nudeln“, „Timer
1:30“, „Timer“ allein zeigt die Auswahl) – am Ende klingelt es, das Wesen
hüpft aufgeregt, bis du den Timer ausmachst, und auf Wunsch kommt eine
Mitteilung. „Notiz: Milch kaufen“ legt eine Notiz an.

**Worauf sich „das“ bezieht:** Hast du etwas **kopiert** (Strg+C, in jedem
Programm), nehmen „Erklär mir das“, „Fass zusammen“, „Übersetz ins Deutsche“
und „Hilf mir antworten“ den kopierten Text. **Aus der Zwischenablage** (im
Menü „…“) holt Text oder Bild ausdrücklich. Hast du in Neural OS Text
**markiert**, kommt er beim Öffnen mit (als Kärtchen, × nimmt ihn weg).

**Was sie nicht kann:** In anderen Programmen klicken oder tippen. Von selbst
zuhören – das Mikrofon ist nur an, solange du sprichst oder Live läuft (dann
steht „Hört zu“ daneben). Ein Tastenkürzel für den ganzen Computer –
Strg/⌘ + Umschalt + Leertaste gilt in Neural OS und im schwebenden Fenster.
Dateien, die sie nicht lesen kann, nimmt sie nicht an – sie tut nie so, als
hätte sie sie gelesen.

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
- **KI** – oben steht in einem Satz, wer zuerst antwortet und wer einspringt.
  Darunter **Gemini** (kostenlos) und **Weitere KIs**: Mistral, Groq und
  OpenRouter (kostenlos, je ein Schlüssel vom Anbieter), OVHcloud (ganz ohne
  Schlüssel, dafür langsam: **[Einschalten]**), OpenAI und Claude (kosten je
  Nutzung). Jede KI zeigt ihre Schlüssel mit Zustand („bereit“, „am Limit bis
  09:00“, „wird nicht angenommen“), dazu **[Zuerst fragen]**, **[Entfernen]**
  und **[Weiterer Schlüssel]**. Ist eine KI am Limit, antwortet von selbst die
  nächste – der Chat sagt es in einem Satz. Ein Schlüssel verrät, wem er gehört
  (`AQ.`/`AIza` Google, `gsk_` Groq, `sk-or-v1-` OpenRouter, `sk-ant-` Claude,
  `sk-` OpenAI, ohne Vorsilbe Mistral) – auch im falschen Feld. Ehrlich:
  Mehrere kostenlose Konten beim selben Anbieter, nur für mehr Limit, verbieten
  die Anbieter; verschiedene Anbieter zu verbinden ist erlaubt. Ganz unten
  **Nachschlagen in Wikipedia** (an/aus): die KIs ohne eigene Suche schlagen
  dort nach, die Artikel stehen als Quellen unter der Antwort, und auf „Zeig
  mir …“ zeigen sie das Bild aus Wikipedia (Bilder erzeugen kann die
  kostenlose KI nicht).
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
| **Online** | Die KI, ihre Websuche und das Nachschlagen in Wikipedia dürfen ins Internet – nur zu den Adressen auf der Freigabeliste (die trägt Neural OS beim Verbinden ein). „Online gehen und verbinden“ beim Einrichten der KI stellt es ein. |

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
| **Strg+Umschalt+Leertaste** | die Insel auf- und zuklappen (am Mac ⌘ statt Strg) |
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
| „Das Guthaben bei Anthropic reicht nicht.“ | Daneben **[Kostenlos mit Gemini weiter]** antippen und einen Google-Schlüssel einfügen; ab dann antwortet Gemini. |
| Im Chat gibt es nur ein Feld für Claude, oder oben in der Mitte steht noch die schwarze Pille statt des kleinen Wesens am rechten Rand | Im Browser läuft noch eine alte Fassung: die neue ZIP laden und dort den Starter doppelklicken (`docs/ERSTE-SCHRITTE.md`, 1.2) – er beendet die alte selbst. |
| „Google-Limit erreicht“ | Die kostenlose Stufe ist für heute aufgebraucht. Morgen geht es weiter – oder unter **Einstellungen → KI → Weitere KIs** eine zweite KI verbinden (etwa Mistral, kostenlos, oder OVHcloud ganz ohne Schlüssel); sie springt dann von selbst ein. |
| „… ist gerade am Limit – es antwortet …“ | Kein Fehler: Eine andere verbundene KI hat übernommen. |
| Die KI sagt, sie könne etwas nicht nachsehen | Ohne eigene Suche schlägt sie nur in Wikipedia nach (**Einstellungen → KI → Nachschlagen in Wikipedia**, nur online). Nachrichten von heute, Preise und Wetter findet das nicht. |
| Unten links „Offline“, die KI antwortet nicht | Netzstufe auf Online stellen (**Einstellungen → Netzwerk**). |
| „Neural OS ist aus.“ | Neural OS läuft nicht (Stick gezogen, beendet). Den Starter noch einmal doppelklicken. |
| „PIN nötig“ | Dieser Browser hat die KI noch nicht entsperrt; die PIN eingeben. |
| Das iPad kommt nicht durch | Beide im selben WLAN? Windows-Frage „im Netzwerk kommunizieren“ zugelassen? Schul- und Gast-WLANs trennen Geräte oft. |
| Nach einer Erweiterung geht nichts mehr | `node bin/neural-os.js start --safe` |
| Beim Stick | `docs/STICK.md`, „Starten“ und „Einen neuen Stick anlegen“ |
| Etwas anderes | `npm run doctor` sagt, was geht und was fehlt. |
