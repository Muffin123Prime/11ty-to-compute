# Ideen — was ich als Nächstes bauen würde, und was nicht

Stand: 2026-09-21 · Neural OS 0.1.0

Du hast mich nach meinen eigenen Vorschlägen gefragt. Hier sind sie, ehrlich
sortiert: nicht nach dem, was sich gut anhört, sondern nach dem Verhältnis von
Nutzen zu Aufwand — und mit einer Liste am Ende, was ich **nicht** bauen würde
und warum. Diese zweite Liste ist mir die wichtigere.

Jede Idee steht mit einer Einschätzung:

- **Nutzen** — wie oft es dir tatsächlich Arbeit abnimmt
- **Aufwand** — grob, in Arbeitseinheiten, gemessen an dem, was hier schon steht
- **Offline?** — ob es ohne Internet und ohne Modell funktioniert

---

## 1 · Der Tagesbeginn

**Nutzen: hoch · Aufwand: klein · Offline: ja**

Ein Bildschirm, den du morgens einmal ansiehst, und der genau vier Dinge zeigt:
was heute fällig ist, was seit gestern passiert ist, was die Automatik über
Nacht vorgeschlagen hat, und die eine Notiz, die du vor drei Monaten geschrieben
und seitdem nie wieder geöffnet hast.

Der Kern davon existiert schon: `activity.recent`, `tasks.list` und die
Vorschläge liefern die Daten. Es fehlt nur die Seite, die sie zusammenzieht.

Warum ich das zuerst bauen würde: ein System, das man nur benutzt, wenn man
etwas sucht, wird vergessen. Eines, das einen begrüßt, wird benutzt.

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

## 3 · Kartenstapel zum Wiederholen

**Nutzen: mittel bis hoch · Aufwand: klein · Offline: ja**

Aus jeder Notiz mit einer Überschrift und einem Absatz lässt sich eine Frage
machen. Ein Stapel, der dir täglich fünf davon zeigt, in wachsenden Abständen.
Kein Modell nötig — das Verfahren (SM-2) ist dreißig Jahre alt und funktioniert.

Das verwandelt den Wissensspeicher von einem Ablageort in etwas, das dir
tatsächlich etwas beibringt. Für Notizen, die du behalten willst, ist das mehr
wert als jede Suchfunktion.

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

## 5 · Dateien beobachten statt importieren

**Nutzen: mittel · Aufwand: mittel · Offline: ja**

Du gibst einen Ordner frei, und was dort hineinkommt, wird automatisch gelesen,
verschlagwortet und im Gehirn verknüpft. Die Textextraktion für PDF, DOCX,
XLSX, PPTX und HTML ist schon da und getestet — es fehlt nur die Beobachtung
des Ordners (`fs.watch`) und die Entscheidung, was mit Änderungen passiert.

Wichtig dabei und der Grund, warum es nicht schon da ist: das muss sichtbar
bleiben. Ein Ordner, der still Dinge in den Tresor schiebt, ist genau die Art
von unsichtbarer Automatik, die dieses System sonst vermeidet. Also: eine Liste
„das habe ich aufgenommen", jederzeit einsehbar, und ein Schalter pro Ordner.

## 6 · Zwei Modelle, eine Antwort

**Nutzen: mittel · Aufwand: klein · Offline: teilweise**

Wenn ein Online-Anbieter eingerichtet ist: dieselbe Frage an das lokale und an
das Online-Modell schicken und beide Antworten nebeneinander zeigen. Du siehst
sofort, wann sich das Internet lohnt und wann nicht — und in den meisten Fällen
wirst du feststellen, dass es sich nicht lohnt.

Das ist die ehrlichste Art, für den Offline-Betrieb zu werben: nicht behaupten,
das lokale Modell sei gleich gut, sondern es dich selbst sehen lassen.

## 7 · Ein zweiter Blick auf lange Texte

**Nutzen: mittel · Aufwand: klein · Offline: ja (mit Modell)**

Ein Agent, der eine lange Notiz liest und dir drei Dinge zurückgibt: die
Kernaussage in zwei Sätzen, die Stellen, an denen etwas offen bleibt, und die
Begriffe, die schon anderswo im Tresor vorkommen. Kein „Zusammenfassen"-Knopf,
sondern etwas, das eine Meinung hat.

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

Deshalb ist sie inzwischen gebaut. Von den übrigen wäre der **Tagesbeginn**
(Nummer 1) als Nächstes dran: die Daten dafür liegen alle schon vor, es fehlt
nur die Seite, die sie zusammenzieht.
