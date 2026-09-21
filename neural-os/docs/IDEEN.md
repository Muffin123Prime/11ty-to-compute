# Ideen — was ich als Nächstes bauen würde, und was nicht

Stand: 2026-09-21 · Neural OS 0.1.0

Du hast mich nach meinen eigenen Vorschlägen gefragt. Das waren acht.

**Sieben davon sind inzwischen gebaut**, eine davon nur zur Hälfte (mit der
Begründung, warum die andere Hälfte nicht geht). Bei jeder steht jetzt, was
daraus geworden ist — und vor allem, was sie **nicht** kann. Eine erfüllte Idee,
die weiter als Vorschlag dasteht, ist ein Dokument, dem man nach einem halben
Jahr nicht mehr glaubt.

Die achte, „Der Tresor auf dem Telefon", habe ich bewusst liegen lassen: sie ist
keine Ergänzung, sondern eine zweite Oberfläche, und das ist eine Entscheidung,
die du treffen solltest, nicht ich.

Die Liste am Ende — **was ich nicht bauen würde** — ist mir die wichtigere von
beiden, und sie ist unverändert.

---

## 1 · Der Tagesbeginn — **gebaut**

Der Bereich **Heute** (`g` dann `h`), ganz oben in der Seitenleiste.

Der Kopfsatz ist eine Tatsache, keine Begrüßung: *„Zwei Aufgaben sind fällig,
eine davon überfällig."* Steht nichts an, steht das da — das ist eine gute
Nachricht und sieht auch so aus.

Darunter, nach Dringlichkeit: was fällig ist (direkt abhakbar), **was ohne dich
gelaufen ist**, was vorgeschlagen wurde, was sich seit gestern geändert hat, und
eine Notiz zur Wiedervorlage. Jeder Block führt dorthin, wo man etwas tun kann.

Fehlt ein Teilsystem, steht es mit Grund dabei, statt dass der Block
verschwindet — „nichts zu tun" und „konnte nicht nachsehen" sind verschiedene
Aussagen.

## 2 · Rückgängig für alles — **gebaut**

Diese stand hier als Vorschlag. Sie existiert inzwischen, also steht hier jetzt,
was daraus geworden ist und was sie nicht kann.

Jede Änderung an einer Notiz, Aufgabe, einem Projekt, Chat, Agenten, einer
Datei, Erinnerung, einem Zeitplan oder Auslöser wird in einem eigenen Journal
festgehalten — mit dem Zustand davor und mit der Antwort auf die Frage, die man
zuerst stellt: **wer war das?** Ein Agentenlauf setzt beim Start seinen Namen,
und alles, was innerhalb geschrieben wird, trägt ihn. Auch das, was der
Schreibvorgang seinerseits auslöst.

Das Journal ist absichtlich nicht das Schreib-Log der Datenbank: das wird alle
2000 Vorgänge verdichtet und gelöscht. Ein Rückgängig, das mal geht und mal
nicht, wäre schlimmer als keines.

**Was es nicht kann**, und warum:

- **Höchstens 2000 Einträge oder 30 Tage.** Danach ist es weg. Eine Sicherung
  ist etwas anderes (Einstellungen → Sicherung).
- **Verknüpfungen nicht.** Abgeleitete Links entstehen bei jedem Schreibvorgang
  neu — ein Knopf dafür würde sichtbar nichts tun.
- **Freigaben, Token und Läufe nicht.** Eine zurückgenommene Netz-Freigabe
  wiederzubeleben wäre ein Sicherheitsloch, kein Komfort.
- **Ein hart gelöschter Satz kommt unter neuer Kennung zurück**, und seine
  früheren Verknüpfungen sind weg. Das System sagt das, statt so zu tun, als
  wäre nichts gewesen.
- **Wurde der Satz seit der Änderung wieder geändert**, wird abgelehnt — sonst
  würde Rückgängig genau das anrichten, wogegen es da ist. Ein ausdrückliches
  „trotzdem" gibt es, mit Warnung.

## 3 · Kartenstapel zum Wiederholen — **gebaut**

Der Bereich **Lernen** (`g` dann `l`). SM-2, kein Modell nötig.

Eine Karte zur Zeit, groß und ruhig. **Leertaste** zeigt die Rückseite, dann
vier Knöpfe auf den Tasten **1–4**: Nochmal · Schwer · Gut · Leicht. Jeder sagt,
wann die Karte wiederkommt — *„heute"*, *„morgen"*, *„in 6 Tagen"* —, und dieser
Text kommt vom Server, damit Oberfläche und Rechnung nicht auseinanderlaufen
können.

Karten entstehen von Hand oder **aus einer Notiz**. Dabei wird nichts geraten:
erkannt werden nur ausdrückliche Strukturen (`## Überschrift` + Absatz,
`Begriff :: Erklärung`). Aus Fließtext entsteht keine Karte.

Vier Entscheidungen, die im Code begründet stehen: `ease` fällt nie unter 1,3
(sonst gerät eine Karte in eine Falle, aus der sie nicht herauskommt); das
Intervall hat eine Obergrenze (neun Jahre sind keine Wiederholung mehr);
`due` ist ein Datum **ohne Uhrzeit** (wer morgens lernt, soll abends nicht
dieselbe Karte wiederbekommen); und „Nochmal" heißt heute, nicht morgen.

**Keine Gamification** — keine Serien, keine Punkte, keine Abzeichen. Das steht
weiter unten unter „Was ich nicht bauen würde", und daran habe ich mich gehalten.

## 4 · Die Zwischenablage-Taste — **teilweise gebaut**

**Strg+Umschalt+N** öffnet von überall in der App eine Zeile. Was du tippst, wird
eine Notiz — oder eine Aufgabe, wenn ein Merker davorsteht (`- [ ]`, `TODO:`,
`Offen:`, `Zu tun:`, dieselben, die auch die Vorschläge in einer Notiz finden).
`#schlagwort` wird erkannt. Die Vorschau sagt **vorher**, was daraus wird.

Strg+Enter speichert und lässt das Fenster offen, für mehrere Gedanken
hintereinander. Danach steht dort, wo du es zurücknehmen kannst.

**Was daran fehlt, und warum:** ein *systemweites* Tastenkürzel — eines, das auch
wirkt, während du in einem anderen Programm bist — geht aus dem Browser heraus
nicht. Das bräuchte ein kleines Zusatzprogramm pro Betriebssystem, und damit
verlässt man das „ein Ordner, überall lauffähig"-Versprechen des Sticks. Das
hier wirkt, solange ein Fenster von Neural OS offen ist. Mehr verspricht es nicht.

## 5 · Dateien beobachten statt importieren — **gebaut**

**Einstellungen → Beobachtete Ordner.**

Der Ablauf ist absichtlich dreistufig: anlegen → **erst ansehen** → einschalten.
„Erst ansehen" zeigt, *was passieren würde*, und legt nichts an. Ein Ordner, der
ab dem Anlegen still Dinge aufnimmt, wäre genau die unsichtbare Automatik, die
dieses System sonst vermeidet.

Ein aufklappbares **„Was wurde aufgenommen"** zeigt die echte Liste, inklusive
der übersprungenen Dateien **mit Grund**.

Was dabei nicht passiert, und zwar geprüft: einem symbolischen Link wird nicht
gefolgt (sonst reichte ein Link nach `~/.ssh` im beobachteten Ordner); der Tresor
selbst lässt sich nicht beobachten (sonst nimmt das System seine eigenen Dateien
auf, bis die Platte voll ist); zu große Dateien werden mit Grund übersprungen
statt halb gelesen; dieselbe Datei wird nicht zweimal aufgenommen; und im
Quellordner wird **niemals** etwas geändert oder gelöscht.

Ein großer Durchlauf läuft durch denselben Schutzraum wie ein Import, damit er
den Rückgängig-Verlauf nicht leerfegt.

## 6 · Zwei Modelle, eine Antwort — **gebaut**

Im Chat, Knopf **„Zwei Modelle"**.

Der heikle Punkt und der eigentliche Gegenstand: ein Vergleich mit einem
Online-Anbieter schickt deinen Text an einen fremden Dienst. Das darf einem
nicht *passieren*. Deshalb zeigt die Oberfläche vor dem Absenden den **Plan** —
für jede Seite, wo das Modell liegt und was die Schleuse dazu sagt. Verlässt
eine Seite das Gerät, steht das als Satz da, bevor man drückt, und Bestätigen
ist ein eigener Klick.

Scheitert eine Seite, liefert die andere trotzdem, und die gescheiterte trägt
ihren echten Fehler. Nie wird die eine Antwort als beide ausgegeben. Ob eine
Anfrage das Gerät verlassen hat, wird daraus gelesen, was die Schleuse
*wirklich* entschieden hat — nicht daraus, was konfiguriert war.

## 7 · Ein zweiter Blick auf lange Texte — **gebaut**

Ein Knopf an einer langen Notiz. Drei Dinge zurück: die Kernaussage, die
Stellen, an denen etwas offen bleibt, und die Begriffe, die schon anderswo im
Tresor vorkommen.

Das Entscheidende: **der dritte Teil braucht kein Modell.** „Welche Begriffe
kommen anderswo vor" ist reine Textarbeit und der Volltextindex. Ohne Modell
liefert er also trotzdem, setzt den Rest auf `null` statt ihn zu erfinden, und
sagt warum:

> Kernaussage und offene Stellen brauchen ein Sprachmodell; hier ist gerade
> keines erreichbar. Die bekannten Begriffe unten stammen aus dem Volltextindex
> und sind davon unabhängig.

Die drei Teile sind in der Ansicht sichtbar **als verschieden gekennzeichnet**:
der dritte ist belegbar, die ersten beiden stammen von einem Modell und sind es
nicht. Diese Unterscheidung ist der Punkt.

Eine Notiz unter 500 Zeichen wird abgewiesen — mit einer Begründung statt einer
Sperre: *„Bei so wenig Text siehst du beim Lesen schon alles, was ein zweiter
Blick sagen könnte."*

## 8 · Der Tresor auf dem Telefon

**Nutzen: hoch · Aufwand: groß · Offline: ja**

Der Abgleich zwischen Geräten funktioniert bereits über HTTP und über einen
Ordner. Was fehlt, ist eine Oberfläche, die auf einem Telefonbildschirm
brauchbar ist — im Moment ist alles für einen Laptop gebaut.

Das ist ehrlicherweise viel Arbeit, und es ist der Punkt, an dem ich fragen
würde, ob du es überhaupt willst, bevor ich anfange. Ein Telefon ist ein Gerät,
das man verliert. Der Tresor darauf müsste verschlüsselt sein und bleiben.

---

## Was ich nicht bauen würde

Diese Liste ist kürzer, aber sie ist der Teil, auf den es ankommt.

**Keine Cloud-Synchronisation über einen fremden Dienst.** Der Abgleich über
einen Ordner auf dem Stick und direkt zwischen zwei Geräten deckt denselben
Bedarf ab, ohne dass deine Daten bei jemandem liegen, der sie nicht braucht.

**Keine Spracheingabe, die ins Netz geht.** Ein lokales Spracherkennungsmodell
wäre in Ordnung. Alles andere wäre ein Mikrofon, das an einen fremden Rechner
angeschlossen ist, und das in einem Programm, das mit „offline zuerst" wirbt.

**Keine Nutzungsstatistik, auch keine „anonyme".** Es gibt keine anonyme
Statistik über die Notizen eines einzelnen Menschen. Wie oft du das Gehirn
öffnest, ist eine Information über dich.

**Kein Agent, der ohne Bestätigung Dateien löscht.** Die Werkzeugliste hat
bewusst kein `files.delete`. Ein Agent, der schreiben darf, kann eine Datei
überschreiben — das ist schlimm genug und deshalb bestätigungspflichtig.
Löschen käme ohne jeden Zugewinn an Nutzen dazu.

**Keine Empfehlungen, die aussehen wie Wissen.** Wenn die Vorschlagsfunktion
zwei Notizen für Dubletten hält, sagt sie, warum sie das denkt, und lässt dich
entscheiden. Sie führt nie selbst zusammen. Der Tag, an dem sie es täte, wäre
der Tag, an dem du dem Tresor nicht mehr trauen könntest.

**Keine Gamification.** Keine Streaks, keine Punkte, keine Abzeichen dafür,
dass du sieben Tage hintereinander etwas aufgeschrieben hast. Das ist ein
Werkzeug, kein Spiel, und es soll dich nicht zu etwas überreden.

---

## Wenn ich nur eine Sache bauen dürfte

Das war Nummer 2, „Rückgängig für alles" — nicht weil sie die auffälligste ist,
sondern weil sie die Voraussetzung dafür ist, dass du die anderen überhaupt
benutzt. Automatik, die man nicht zurücknehmen kann, schaltet man nicht ein.

Sie war die erste, die gebaut wurde. Danach kamen die übrigen sechs.

## Was als Nächstes käme

Nichts aus dieser Liste — sie ist abgearbeitet, bis auf die eine, die dir
gehört. Was ich jetzt vorschlagen würde, wäre kleiner und langweiliger, und
genau deshalb richtig:

1. **Den Tagesbeginn zur Startseite machen**, wenn du ihn ein paar Tage benutzt
   hast und er sich bewährt. Jetzt ist der Chat der Einstieg; das war richtig,
   solange es „Heute" nicht gab.
2. **Karten aus dem zweiten Blick.** Die offenen Stellen, die er findet, sind
   fast schon Fragen. Der Weg von dort zu einer Lernkarte ist kurz.
3. **Den Lernstand zwischen Geräten abgleichen.** Derzeit liegt dein
   Kartenstapel auf einem Gerät — das steht unter „Bekannte Grenzen" in
   `docs/STATUS.md` und ist die erste Zeile dort, die mich wirklich stört.
