# Neural OS auf dem USB-Stick

**Jeder Stick ist eine eigene KI.** Stick rein, Doppelklick, und im Browser
öffnet sich die App mit allem, was *diese* KI weiß. Wissen teilen nur Sticks,
die du miteinander **gekoppelt** hast.

Der Rechner braucht dafür nichts: keine Installation, keine
Administratorrechte. Das Programm und seine Laufzeit liegen auf dem Stick. Die
KI antwortet online (Gemini kostenlos oder Claude); ihr Schlüssel liegt im
Tresor des Sticks und reist mit.

In der App steht alles unter **Einstellungen → Speicher → Stick** (oder die
Tasten `g` und dann `t`).

---

## Was auf dem Stick liegt

```
NEURAL OS (E:)
  Inhalt                        Programm, Daten, Abgleich: nicht anfassen
  LIESMICH
  Neural OS starten - Mac       ein Programm; Windows zeigt es als Ordner „… - Mac.app“
  Neural OS starten - Windows
```

`LIESMICH` hat fünf Zeilen:

```
Windows:  "Neural OS starten - Windows" doppelklicken.
Mac:      "Neural OS starten - Mac" doppelklicken.
Fertig:   in der App auf "Beenden".
Deine Daten liegen im Ordner "Inhalt". Sichern = ganzen Stick kopieren.
Geht etwas nicht, steht der Grund im Fenster. Mac-Notstart: Inhalt > "Notstart - Mac".
```

Ein Doppelklick bleibt nötig: Windows und macOS starten aus Schutzgründen
nichts von selbst vom Stick.

## Starten

**Windows:** Stick einstecken, im Explorer öffnen, **„Neural OS starten -
Windows“** doppelklicken. Ein schwarzes Fenster zeigt „Neural OS startet …“,
dann öffnet sich der Browser mit `http://127.0.0.1:2xxxx/` – die Adresse ist
für diesen Stick immer dieselbe – und das Fenster schließt sich von selbst.
Oben steht der Name der KI.

**Mac:** Stick einstecken, im Finder öffnen, **„Neural OS starten - Mac“**
doppelklicken. Das ist ein kleines Programm: Es öffnet kein Terminal-Fenster,
nur den Browser. Fragt macOS nach dem Zugriff auf einen Wechseldatenträger:
**Erlauben**. Geht etwas nicht, steht der Grund in einem Dialog.

**Notstart am Mac:** Öffnet macOS das Programm gar nicht, im Ordner
**„Inhalt“** **„Notstart - Mac“** doppelklicken. Das ist derselbe Start im
Terminal; dort steht danach „Fertig. Dieses Fenster kann zu.“

**Mit PIN** zeigt der Browser zuerst nur das Feld **„PIN“** und **[Öffnen]**.
Falsch: „Falsche PIN.“, nach fünf Fehlversuchen „Zu oft falsch. Kurz warten.“

**Noch einmal doppelklicken** öffnet nur den Browser mit derselben Adresse; ein
zweites Neural OS startet nicht. Läuft dort noch eine andere Fassung (der Stick
wurde mit [Erneuern] auf den neuen Stand gebracht, die alte lief noch), wird
sie sauber beendet und die neue gestartet.

Geht etwas schief, bleibt das Fenster offen (am Mac: ein Dialog) und nennt
genau einen Grund:

| Satz | Was es heißt |
|---|---|
| Dieser Rechner lässt keine Programme vom Stick starten. | Eine Richtlinie des Rechners (Schule, Firma) sperrt Programme vom Stick. An diesem Rechner hilft nichts; ein anderer Rechner ist nötig. |
| Auf diesem Stick fehlt das Programm für Windows. / … für den Mac. | Der Stick wurde ohne diese Laufzeit vorbereitet. An einem Rechner mit Neural OS und Internet [Für Windows holen] bzw. [Für Mac holen]. |
| Dieser Mac ist zu alt. Nötig ist macOS 11 oder neuer. | Die mitgelieferte Laufzeit verlangt macOS 11. |
| macOS hat den Start blockiert: Systemeinstellungen › Datenschutz & Sicherheit › Dennoch öffnen. | Einmal dort „Dennoch öffnen“, dann noch einmal doppelklicken. |
| Der Stick ist schreibgeschützt. | Schreibschutz-Schalter am Stick prüfen. |
| Neural OS konnte nicht starten: | Darunter stehen die letzten Zeilen des Protokolls. |
| Eine andere Version von Neural OS läuft noch und ließ sich nicht beenden. | Den Rechner neu starten, dann noch einmal doppelklicken. |
| Neural OS läuft schon (ältere Version). Bitte dort beenden. | Eine ganz alte Fassung im eigenen schwarzen Fenster: das Fenster schließen oder den Rechner neu starten, dann noch einmal doppelklicken. |

## Beenden

In der App unten links auf **[Beenden]**. Danach steht nur noch da:

- Windows: **„Gespeichert. Stick kann raus.“** USB-Sticks sind unter Windows
  auf „Schnelles Entfernen“ eingestellt; Auswerfen ist nicht nötig.
- Mac: **„Gespeichert. Stick kann raus, sobald er aus dem Finder
  verschwindet.“** Neural OS wirft den Stick selbst aus, sobald es zu ist.
  Kann dieser Mac das nicht, steht dort **„Gespeichert. Stick im Finder
  auswerfen.“**

Stick **ohne Beenden gezogen**: Neural OS beendet sich nach wenigen Sekunden
von selbst. Ein offener Tab zeigt **„Neural OS ist aus.“** und darunter „Zum
Öffnen den Starter auf dem Stick doppelklicken.“ Von der KI bleibt nichts
sichtbar. Verloren gehen höchstens die letzten Sekunden – deshalb immer
[Beenden] benutzen.

Browser zu, Stick steckt noch: Nach 10 Minuten ohne offenen Tab beendet sich
Neural OS selbst.

**Auf dem Laptop bleibt nichts Inhaltliches zurück.** Das Programm schreibt nur
auf den Stick. Der Browser merkt sich Ansicht und Adresse, nie Inhalte – kein
Entwurf, kein Zwischenspeicher der Seite. Im Browserverlauf stehen nur Adressen.

## Zwei Sticks am selben Laptop

Stick B einstecken und seinen Starter doppelklicken: B öffnet sich unter einer
**anderen Adresse** in einem eigenen Tab, mit eigenem Namen oben, und zeigt nur
das Wissen von B. A und B können gleichzeitig laufen; keiner sieht etwas vom
anderen, auch nicht im Browserspeicher. Ein alter Tab von A zeigt nach dem
Beenden „Neural OS ist aus.“ – nie Daten von B.

## Einen neuen Stick anlegen

In der Stick-Ansicht unter **Andere Sticks**: einen leeren Stick einstecken.
Nach wenigen Sekunden steht dort zum Beispiel
**„Leerer Stick: E:\ · 14,2 GB frei“** mit zwei Knöpfen:

- **[Neue KI]** – der Stick bekommt eine eigene, leere KI.
- **[Mit dieser KI gekoppelt]** – der neue Stick bekommt eine eigene KI und ist
  sofort mit dieser gekoppelt. Hat diese KI eine PIN, kommt das Feld **„PIN für
  den neuen Stick“** dazu: Gekoppelte Sticks sind entweder beide geschützt oder
  beide nicht.

Soll der Stick auch am anderen System starten (Windows *und* Mac), muss Neural
OS die Laufzeit dafür einmal von nodejs.org holen. Dann kommt genau eine Frage
mit zwei Knöpfen: **[Erlauben]** oder **[Nur Windows]** (bzw. **[Nur Mac]**).
Liegt ein Teil schon ohne Netz bereit – etwa auf dem Stick, von dem Neural OS
gerade läuft –, heißt der zweite Knopf **[Ohne Internet]**. „Erlauben“ gibt der
Netzschleuse genau eine Freigabe: nur nodejs.org, höchstens 30 Minuten, und
nach dem Vorgang wird sie zurückgezogen.

Während der Arbeit steht dort **„Wird vorbereitet … 42 %“**; der Balken bewegt
sich nur, wenn wirklich etwas kopiert oder geladen wurde. Danach:
**„Fertig. Stick kann raus.“**

Was sonst dastehen kann:

| Satz | Bedeutung |
|---|---|
| Läuft bisher nur an Windows. [Für Mac holen] / Läuft bisher nur am Mac. [Für Windows holen] | Die Laufzeit für das andere System fehlt. Der Knopf holt sie einmal von nodejs.org. |
| Ohne Internet geht das nicht. | Holen ging nicht – kein Netz. Später noch einmal tippen. |
| Auf diesem Stick wohnt schon eine KI. | [Neue KI] überschreibt nie etwas. Dieser Stick erscheint dann als „Anderer Stick“. |
| Windows sieht diesen Stick nicht. | Am Mac mit APFS formatiert. Für beide Systeme: exFAT. |
| Programm auf dem Stick ist älter. [Erneuern] | Nur das Programm wird erneuert; das Wissen bleibt. |

Dieselbe Laufzeit-Zeile steht oben unter **Dieser Stick**, wenn dem Stick, von
dem Neural OS gerade läuft, ein System fehlt.

**Dateisystem:** exFAT ist richtig für Windows und Mac. NTFS kann ein Mac nur
lesen, APFS sieht Windows nicht. Ein 1-GB-Stick reicht: rund 8 MB Programm und
80–120 MB je Laufzeit, dazu dein Wissen.

## Koppeln

1. A läuft, Stick B steckt (B muss nicht laufen). Unter **Andere Sticks** steht
   **„Anderer Stick: Lena“ [Koppeln]**. Ohne Klick passiert nichts.
2. Hat B eine PIN, kommt das Feld **„PIN von Lena“** dazu. Falsch: „Falsche PIN.“
3. Ist die Schutzstufe ungleich, steht dort **„Lena hat eine PIN, dieser Stick
   nicht.“ [PIN festlegen]** bzw. **„Dieser Stick hat eine PIN, Lena nicht.“**
4. Danach steht unter **Gekoppelt**: **„Gekoppelt mit Lena · Lena übernimmt beim
   nächsten Start“**, und sobald abgeglichen ist **„Gekoppelt mit Lena ·
   abgeglichen 14:03“ [Jetzt abgleichen] [Entkoppeln]**. Steckt B nicht:
   „Gekoppelt mit Lena · zuletzt gestern 16:40“.
5. B zeigt beim nächsten Start einmal kurz: **„Gekoppelt mit Max.“**

Ab dann wird **von selbst** abgeglichen, ohne Knopf und ohne Meldung: bei jedem
Start, wenn der Partner-Stick eingesteckt wird, 20 Sekunden nach der letzten
Änderung und beim Beenden. [Jetzt abgleichen] braucht man nur, wenn man nicht
warten will; währenddessen steht „Gleiche ab …“ da.

- **Zweimal verschieden geändert:** „„Einkaufsliste“ gab es zweimal verschieden
  – beide sind da.“ [Ansehen]. Die zweite Fassung heißt „Einkaufsliste (Fassung
  von Lena)“. Wer sie nicht will, löscht sie.
- **[Entkoppeln]** fragt in der Seite: „Entkoppeln? Beide behalten, was sie
  wissen.“ [Entkoppeln] [Abbrechen].
- **Kopie eines Sticks** (Byte für Byte kopiert): „Zwei Sticks tragen dieselbe
  KI.“ [Diesen Stick eigenständig machen]. Danach hat dieser Stick eine eigene
  Kennung; Kopplungen müssen neu geknüpft werden.
- **Verschiedene Programmstände:** „Lena hat eine ältere Version.“ [Lena
  erneuern] bzw. „Lena hat eine neuere Version.“
- **Drei Sticks:** „Gekoppelt mit Lena (über Lena auch: Tom)“.

**Was geteilt wird:** Notizen, Projekte, Aufgaben, Termine, Begriffe,
Erinnerungen, Chats, Nachrichten, Verknüpfungen, Anhänge und Löschungen.
**Was nicht geteilt wird:** der KI-Schlüssel, die PIN, Einstellungen, Agenten,
Zeitpläne, beobachtete Ordner und Freigaben.

## Sicherung

**Sichern = ganzen Stick kopieren.** Dazu gibt es in
der Stick-Ansicht **[Jetzt sichern]**: eine vollständige Sicherung auf dem Stick
im Ordner `Sicherungen`, jedes Mal ein neuer Ordner mit Zeitstempel; eine ältere
wird nie ersetzt. Daneben steht still,
wann zuletzt gesichert wurde und wo.

**Von einer Sicherung wiederherstellen** steht klein darunter. Neural OS zeigt
zuerst, was passieren würde – geschrieben ist bis dahin nichts. Erst dann wird
**[Wiederherstellen]** frei.

## Die unbequemen Wahrheiten

- **Ein verlorener Stick ist ein gelesener.** exFAT und FAT32 kennen keine
  Zugriffsrechte. Deshalb: **Einstellungen → Schutz → PIN einrichten.** Ohne
  PIN kann jeder, der den Stick findet, alles lesen.
- **Ein fremder Rechner ist ein fremder Rechner.** Solange Neural OS dort läuft,
  kann dieser Rechner grundsätzlich mitlesen. Der Stick ist für deine Rechner
  und für Rechner, denen du vertraust.
- **Eine Sicherung auf demselben Stick** schützt vor einem kaputten Tresor,
  nicht vor einem verlorenen Stick. Den Stick ab und zu auf den Laptop kopieren.
- **Die KI braucht Internet.** Ohne Netz siehst du alles, was du hast, bekommst
  aber keine neuen Antworten.
- **Ein langsamer USB-2-Stick** macht die App träger; jede Änderung wird
  geschrieben.

## Der Probelauf (freiwillig)

Einiges ließ sich bei der Entwicklung nur nachstellen, nicht am echten Rechner
prüfen: ob das Fenster unter Windows wirklich zugeht, ob eine Schul-Richtlinie
Programme vom Stick sperrt, was Gatekeeper zum Mac-Programm sagt. Für jeden
dieser Fälle gibt es einen Ausweg (Notstart, Endtext ohne Auswerfen). Wer es
genau wissen will, macht den **Probelauf** – ein Doppelklick je Rechner, ein
paar Ja/Nein-Fragen, das Ergebnis zum Einfügen in den Chat. Die Schritte stehen
in `docs/PROBELAUF.md`.

## Derselbe Weg über die Kommandozeile

```bash
node bin/neural-os.js stick prepare /pfad/zum/stick              # neue KI, alle Laufzeiten
node bin/neural-os.js stick prepare /pfad/zum/stick --runtimes win-x64,darwin-arm64
node bin/neural-os.js stick update  /pfad/zum/stick              # nur das Programm, das Wissen bleibt
node bin/neural-os.js stick runtime /pfad/zum/stick darwin-x64   # eine Laufzeit nachlegen
node bin/neural-os.js stick verify  /pfad/zum/stick              # prüft, schreibt nichts
```

Es sind dieselben Funktionen wie hinter den Knöpfen (`src/portable/stick.js`):
Nichts wird geschrieben, bevor feststeht, dass der Platz reicht; jeder Ordner
landet in einem Zug; das Wissen in `Inhalt/data` wird von einem Erneuern nie
angefasst – das ist im Code erzwungen und durch Tests belegt.
