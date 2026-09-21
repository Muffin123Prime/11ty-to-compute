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

## 2 · Rückgängig für alles

**Nutzen: hoch · Aufwand: mittel · Offline: ja**

Der Speicher ist ein Protokoll, das nur angehängt wird — jede Änderung steht
mit Zeitpunkt darin. Daraus lässt sich ein echtes „Zurück" bauen: nicht nur für
den Editor, sondern für jede Aktion, auch für die eines Agenten.

Das ist die Funktion, die den Unterschied macht zwischen „ich lasse den Agenten
mal laufen" und „ich traue mich nicht". Im Moment ist die einzige echte
Absicherung die Bestätigungsabfrage vorher. Eine Korrektur hinterher ist
bequemer und wirkt stärker.

Technisch: die Sätze der letzten Stunde mit ihren Revisionen anzeigen, und pro
Satz auf eine frühere Revision zurücksetzen. Die Daten sind da. Es ist eine
Ansicht und eine Route.

## 3 · Kartenstapel zum Wiederholen

**Nutzen: mittel bis hoch · Aufwand: klein · Offline: ja**

Aus jeder Notiz mit einer Überschrift und einem Absatz lässt sich eine Frage
machen. Ein Stapel, der dir täglich fünf davon zeigt, in wachsenden Abständen.
Kein Modell nötig — das Verfahren (SM-2) ist dreißig Jahre alt und funktioniert.

Das verwandelt den Wissensspeicher von einem Ablageort in etwas, das dir
tatsächlich etwas beibringt. Für Notizen, die du behalten willst, ist das mehr
wert als jede Suchfunktion.

## 4 · Die Zwischenablage-Taste

**Nutzen: hoch · Aufwand: mittel · Offline: ja**

Eine Tastenkombination, die von überall aus ein Fenster öffnet, in das du einen
Satz tippst — und es landet als Notiz oder Aufgabe im Tresor, ohne dass du das
Programm wechselst. Nichts anderes senkt die Hürde zum Aufschreiben so stark.

Einschränkung, ehrlich gesagt: ein systemweites Tastenkürzel geht nicht aus dem
Browser heraus. Das braucht ein kleines Zusatzprogramm pro Betriebssystem, und
damit verlässt man das „ein Ordner, überall lauffähig"-Versprechen des Sticks.
Als Kompromiss ginge: ein Lesezeichen im Browser und eine sehr schnelle
Eingabezeile in der App selbst.

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

Nummer 2, „Rückgängig für alles". Nicht weil sie die auffälligste ist, sondern
weil sie die Voraussetzung dafür ist, dass du die anderen überhaupt benutzt.
Automatik, die man nicht zurücknehmen kann, schaltet man nicht ein.
