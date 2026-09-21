# Die App selbst verändern

Du musst nie wieder von vorne anfangen, nur weil etwas fehlt oder kaputt ist.

In der Seitenleiste gibt es **Werkstatt** (Taste `e`). Dort fügst du Code ein,
den ich dir geschrieben habe, drückst *Prüfen*, dann *Installieren* — und die
App kann danach etwas, das sie vorher nicht konnte.

Alles daran ist umkehrbar. Das ist keine Beteuerung, sondern der Entwurf:

- **Jede Fassung bleibt erhalten.** Du kannst zu jeder früheren zurück — und der
  Rückschritt ist selbst wieder umkehrbar.
- **Ein Klick schaltet ein Modul ab.** Sofort, ohne Neustart.
- **Ein Modul, das beim Start abstürzt, wird automatisch abgeschaltet.** Die App
  startet trotzdem und sagt dir, welches es war.
- **Es gibt einen Notausgang:** `npm start -- --safe` startet ohne jede
  Erweiterung. Damit kommst du immer wieder rein.

---

## Der Ablauf

### 1. Sag mir, was du willst

Im Chat, in normalen Worten. Zum Beispiel:

> „In der Notizenansicht fehlt mir ein Knopf, der alle Notizen ohne Schlagwort
> anzeigt."

> „Ich will eine Ansicht, die mir zeigt, an welchen Wochentagen ich am meisten
> schreibe."

> „Der Agent soll ein Werkzeug haben, mit dem er Aufgaben nach Fälligkeit
> sortiert."

Du musst nicht wissen, ob das ein Oberflächen- oder ein Server-Modul wird. Das
entscheide ich.

### 2. Ich schreibe dir ein Modul

Du bekommst einen Block Code. Er fängt immer mit einem `manifest` an, in dem
steht, wie das Modul heißt und welche Berechtigungen es braucht.

### 3. Du fügst ihn ein

Werkstatt öffnen → in den Editor einfügen → **Prüfen**.

Die Prüfung installiert noch nichts. Sie sagt dir:

- ob der Code überhaupt gültig ist (bei einem Fehler: mit Zeilennummer)
- wie das Modul heißt und was es tut
- **welche Berechtigungen es verlangt**, im Klartext und farblich nach Risiko

Dann **Installieren** — und danach ausdrücklich **Aktivieren**. Ein frisch
installiertes Modul ist aus. Nichts läuft, bevor du es angeschaltet hast.

### 4. Wenn es nicht tut, was es soll

Sag es mir. Kopier mir die Fehlermeldung aus der Werkstatt dazu — sie steht dort
mitsamt der Stelle, an der es schiefging. Ich schicke dir eine korrigierte
Fassung, die du über *Aktualisieren* einspielst. Die alte bleibt im Verlauf
stehen.

**Wichtig:** Du musst mir nicht die ganze App beschreiben. Sag einfach „das
Modul X wirft diesen Fehler" und füge ihn ein.

---

## Berechtigungen — was ein Modul darf

Dasselbe Prinzip wie bei den Agenten: **was nicht ausdrücklich erlaubt ist, ist
verboten.**

| Berechtigung | Was sie bedeutet |
|---|---|
| Einträge lesen | Sieht deine Notizen, Projekte, Aufgaben, Chats |
| Einträge ändern | Kann anlegen, ändern, löschen |
| Ereignissen zuhören | Wird benachrichtigt, wenn sich etwas ändert |
| Werkzeuge bereitstellen | Gibt deinen Agenten ein neues Werkzeug |
| Eigene Adressen | Bietet neue Adressen unter `/api/x/…` an |
| Dateien lesen / schreiben | Nur in Ordnern, die du ausdrücklich freigibst |
| Das Modell benutzen | Darf das lokale Sprachmodell aufrufen |
| Lokales Netz / Internet | Geht durch dieselbe Schleuse wie alles andere und steht im Netz-Protokoll |

Ein Modul **ohne** Netzberechtigung kann nichts von deinem Gerät senden. Das ist
keine Einstellung in der Oberfläche, sondern eine Eigenschaft: es bekommt die
Funktion zum Senden gar nicht erst.

---

## Was du wissen musst, bevor du etwas einfügst

**Eingefügter Code wird auf deinem Gerät ausgeführt.** Füge nur ein, was du
verstehst oder aus einer Quelle hast, der du vertraust.

Die Begrenzung, die Neural OS bietet, ist ehrlich gesagt eine **Schutzplanke
gegen Fehler, keine Mauer gegen Angriffe.** Module laufen in einer abgetrennten
Umgebung (`node:vm`) mit nur den Fähigkeiten, die du erteilst. Gegen Code, der
*absichtlich* ausbrechen will, ist das keine harte Grenze — das ist eine bekannte
Eigenschaft von `node:vm`, und ich sage es lieber deutlich, als eine Sicherheit
zu versprechen, die die Technik nicht hergibt.

Was dich tatsächlich schützt:

1. Du siehst vor dem Einschalten, was ein Modul verlangt.
2. Ohne Netzberechtigung kann es nichts senden — die Schleuse gilt auch für
   Module, und jeder Versuch steht im Protokoll unter *Netzwerk*.
3. Du kannst jederzeit alles abschalten und zu jeder früheren Fassung zurück.

---

## Wenn gar nichts mehr geht

```bash
npm start -- --safe
```

Startet die App ohne jede Erweiterung. Von dort kannst du in der Werkstatt in
Ruhe abschalten, zurückrollen oder entfernen.

Falls selbst das nicht hilft — deine Daten sind davon nie betroffen. Sie liegen
in `~/.neural-os/vault/` und werden von Modulen nicht angefasst, solange du
keine Schreibberechtigung erteilt hast. Im Zweifel:

```bash
node bin/neural-os.js export --format both   # Sicherung ziehen
```

---

## Zwei Beispiele

### Ein Werkzeug für deine Agenten (Server-Modul)

```js
module.exports = {
  manifest: {
    name: 'Offene Aufgaben',
    description: 'Gibt Agenten eine Liste der offenen Aufgaben.',
    kind: 'server',
    capabilities: ['records.read', 'tools.add'],
  },
  setup(api) {
    api.tool({
      name: 'tasks.open',
      description: 'Listet alle Aufgaben, die noch nicht erledigt sind.',
      parameters: { type: 'object', properties: {} },
      run() {
        // api.records.list(typ) liefert direkt eine Liste, kein { items }.
        const tasks = api.records.list('task')
          .filter((t) => t.data.status !== 'done')
          .map((t) => ({ id: t.id, titel: t.data.title, status: t.data.status }));
        return { anzahl: tasks.length, aufgaben: tasks };
      },
    });
  },
};
```

### Eine eigene Ansicht (Oberflächen-Modul)

```js
export const manifest = {
  name: 'Wortzähler',
  description: 'Zeigt, wie viele Wörter in deinen Notizen stehen.',
  kind: 'ui',
  capabilities: ['ui.view', 'ui.api'],
};

export default {
  id: 'wortzaehler',
  title: 'Wortzähler',
  icon: '<circle cx="10" cy="10" r="7"/><path d="M7 10h6"/>',
  async mount(container, ctx) {
    const res = await ctx.api.get('/api/records?type=note&limit=500');
    const woerter = res.items.reduce(
      (sum, n) => sum + String(n.data.body || '').split(/\s+/).filter(Boolean).length, 0);
    container.textContent = `Du hast ${woerter} Wörter in ${res.items.length} Notizen geschrieben.`;
  },
  async unmount() {},
};
```

Beide Vorlagen findest du in der Werkstatt unter *Vorlagen* — du musst sie nicht
abtippen.

---

## Was das System nicht kann

- **Der Kern selbst lässt sich so nicht ändern.** Module fügen hinzu; sie können
  die Netzschleuse, das Berechtigungssystem oder den Speicher nicht ersetzen.
  Das ist Absicht: sonst könnte eine Erweiterung genau die Zusagen aushebeln,
  wegen derer du dieses System benutzt. Änderungen am Kern gehen über `git` —
  sag mir Bescheid, dann bekommst du sie als Patch.
- **Module werden nicht zwischen Geräten abgeglichen.** Code ist eine
  Berechtigung; er soll nicht heimlich auf ein zweites Gerät wandern. Du
  exportierst ihn in der Werkstatt und fügst ihn dort ein.
- **Es gibt keinen Marktplatz.** Kein Katalog, kein automatisches Nachladen,
  keine Verbindung nach außen. Nur du und der Text, den du einfügst.
