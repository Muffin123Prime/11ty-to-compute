// Alle Claude-Aufrufe der Unterrichts-App: Antwort auf eine Lehrerfrage,
// Zusammenfassung einer Stunde, Nachfrage zu gespeicherten Stunden.
//
// Der Anbieter (lib/anbieter.mjs) wird hereingereicht: Workers AI, Groq,
// Gemini oder Claude. Hier stehen nur Prompts, Schemas und die Aufrufe.

export const STANDARD_MODELL = "claude-opus-5-5";

// --- Schemas für die strukturierte Ausgabe ---------------------------------

export const ANTWORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  // Reihenfolge ist Absicht: Die Antwort kommt zuerst, damit sie beim Streamen sofort erscheint.
  required: ["frage_erkannt", "antwort", "kurz", "frage", "bild", "erklaerung"],
  properties: {
    frage_erkannt: {
      type: "boolean",
      description:
        "true, wenn die Lehrkraft im Transkript zuletzt eine Frage oder Aufgabe an die Klasse gestellt hat (oder eine Frage vorgegeben ist).",
    },
    antwort: {
      type: "string",
      description:
        "Die Antwort zum Vorlesen: gesprochenes Deutsch, so wie ein guter Schüler dieser Klassenstufe sie im Unterricht sagen würde. Ein bis drei Sätze. Leer, wenn keine Frage erkannt.",
    },
    kurz: {
      type: "string",
      description: "Dieselbe Antwort in einem einzigen kurzen Satz. Leer, wenn keine Frage erkannt.",
    },
    frage: {
      type: "string",
      description: "Die Frage, so wie sie verstanden wurde, in einem Satz. Leer, wenn keine Frage erkannt.",
    },
    bild: {
      type: "object",
      additionalProperties: false,
      required: ["typ", "wert", "beschreibung"],
      properties: {
        typ: {
          type: "string",
          enum: ["keins", "molekuel", "wikipedia", "svg"],
          description:
            "Nur wenn die Frage nach dem Aussehen, Aufbau oder einer Darstellung fragt. molekuel: chemischer Stoff, wert = englischer Name (water, glucose). wikipedia: Artikel der deutschen Wikipedia mit passendem Hauptbild, wert = Artikeltitel. svg: nur wenn beides nicht passt, kleine Skizze als SVG (viewBox 0 0 400 300, höchstens 900 Zeichen, keine Skripte). Sonst keins.",
        },
        wert: { type: "string" },
        beschreibung: { type: "string", description: "Bildunterschrift in einem Satz. Leer bei typ keins." },
      },
    },
    erklaerung: {
      type: "string",
      description: "Höchstens ein Satz Hintergrund für eine Rückfrage der Lehrkraft. Sonst leer.",
    },
  },
};

export const ZUSAMMENFASSUNG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["titel", "thema", "zusammenfassung", "kernpunkte", "fragen", "hausaufgaben", "begriffe"],
  properties: {
    titel: { type: "string", description: "Kurzer Titel der Stunde, höchstens acht Wörter." },
    thema: { type: "string", description: "Worum ging es, in einem Satz." },
    zusammenfassung: { type: "string", description: "Zusammenfassung in fünf bis zehn Sätzen, als Fließtext." },
    kernpunkte: { type: "array", items: { type: "string" }, description: "Die wichtigsten Aussagen, je ein Satz." },
    fragen: {
      type: "array",
      description: "Fragen, die die Lehrkraft gestellt hat, jeweils mit einer kurzen Antwort.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["frage", "antwort"],
        properties: { frage: { type: "string" }, antwort: { type: "string" } },
      },
    },
    hausaufgaben: { type: "array", items: { type: "string" }, description: "Hausaufgaben, Termine, Tests, die genannt wurden." },
    begriffe: {
      type: "array",
      description: "Fachbegriffe der Stunde mit Erklärung in einem Satz.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["begriff", "erklaerung"],
        properties: { begriff: { type: "string" }, erklaerung: { type: "string" } },
      },
    },
  },
};

export const FRAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["frage_erkannt", "frage", "art"],
  properties: {
    frage_erkannt: { type: "boolean", description: "true, wenn die Lehrkraft im neuesten Teil des Transkripts eine Frage oder Aufgabe an die Klasse gerichtet hat, die noch nicht beantwortet wurde." },
    frage: { type: "string", description: "Die Frage oder Aufgabe in einem klaren Satz, so wie sie gemeint war. Leer, wenn keine." },
    art: { type: "string", enum: ["frage", "aufgabe", "keine"], description: "frage: Wissensfrage an die Klasse. aufgabe: Arbeitsauftrag (rechnet, beschreibt, nennt). keine: nichts davon." },
  },
};

export function frageSystemPrompt() {
  return `Du bist der Frage-Wächter einer Unterrichts-App. Du bekommst die letzten Sätze einer automatischen Mitschrift (Hörfehler, keine Satzzeichen, zerschnittene Sätze). Entscheide, ob die Lehrkraft im neuesten Teil (unten) gerade eine Frage oder Aufgabe an die Klasse gerichtet hat, auf die sich ein Schüler melden könnte.
Ja: "Wer kann mir sagen …", "Wie sieht … aus", "Was ist …", "Warum …", "Nennt mir …", "Rechnet mal …", "Was meint ihr …", "Überlegt mal …", auch mit Namensaufruf, auch ohne Fragewort, wenn klar eine Antwort erwartet wird.
Nein: rhetorische Fragen, die sofort selbst beantwortet werden; Organisatorisches ("Habt ihr das Buch?", "Seid ihr fertig?"); Rückfragen an einen Schüler, der schon antwortet; Fragen aus der Liste "schon beantwortet"; reine Erklärungen. Die Mitschrift enthält auch Zwischenrufe und Antworten von Mitschülern: kurze Einwürfe, halbe Sätze, Gelächter, Antwortversuche ("ähm Zellulose?"). Das sind keine Lehrerfragen und keine Aufgaben; nur was klar von der Lehrkraft an die Klasse geht, zählt. Arbeitsaufträge ("Schlagt Seite 42 auf", "Macht Aufgabe 3", "Schreibt bis morgen …") sind art "aufgabe".
Im Zweifel ja. "frage" sauber ausformuliert, Hörfehler korrigiert. Nur JSON.`;
}

export async function frageErkennen(anbieter, eingabe) {
  const alt = eingabe.bisherige?.length ? `Schon beantwortet (nicht noch einmal melden):\n- ${eingabe.bisherige.join("\n- ")}\n\n` : "";
  const user = `Fach: ${eingabe.fach || "unbekannt"}${eingabe.sprache && eingabe.sprache !== "de" ? ` (Lehrkraft spricht ${SPRACHEN[eingabe.sprache] || eingabe.sprache})` : ""}\n\n${alt}Mitschrift, das Neueste steht unten:\n<transkript>\n${transkriptText(eingabe.transkript)}\n</transkript>`;
  const { daten, nutzung } = await strukturiert(anbieter, {
    system: frageSystemPrompt(),
    user,
    schema: FRAGE_SCHEMA,
    effort: "low",
    schnell: true,
    maxTokens: 200,
  });
  if (!daten.frage_erkannt || !daten.frage) return { frage_erkannt: false, frage: "", art: "keine", nutzung };
  return { frage_erkannt: true, frage: daten.frage, art: daten.art === "aufgabe" ? "aufgabe" : "frage", nutzung };
}

export const AUFGABE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["aufgabe", "schritte", "loesung", "braucht_text", "hinweis"],
  properties: {
    aufgabe: { type: "string", description: "Was genau zu tun ist, in einem klaren Satz (mit Seite, Nummer, Abgabe, falls genannt)." },
    schritte: { type: "array", items: { type: "string" }, description: "Die Arbeitsschritte, kurz, höchstens fünf." },
    loesung: { type: "string", description: "Die erledigte Aufgabe: Ergebnis, Text, Rechnung oder Antwort, so dass der Schüler sie abschreiben oder vortragen kann. Bei Fremdsprachenunterricht in der Sprache der Aufgabe. Wenn der Aufgabentext fehlt: das, was sich schon vorbereiten lässt." },
    braucht_text: { type: "boolean", description: "true, wenn für eine vollständige Lösung der Aufgabentext (Buchseite, Arbeitsblatt) fehlt." },
    hinweis: { type: "string", description: "Was noch fehlt oder worauf die Lehrkraft Wert legt. Sonst leer." },
  },
};

export function aufgabeSystemPrompt(profil = {}) {
  return `Du erledigst für einen Schüler (${profilText(profil)}) eine Aufgabe, die die Lehrkraft im Unterricht gestellt hat. Du bekommst den Arbeitsauftrag (aus einer automatischen Mitschrift, mit Hörfehlern), den Stundenkontext und, falls der Schüler ihn eingetippt hat, den Aufgabentext aus Buch oder Arbeitsblatt.
Regeln:
- "aufgabe": Formuliere sauber, was zu tun ist, mit Seite, Nummer und Abgabetermin, falls genannt.
- "loesung": Erledige die Aufgabe so, wie ein guter Schüler dieser Klassenstufe sie abgeben würde: ${niveauText(profil)} Rechnungen mit Rechenweg, Texte ausformuliert, Fragen vollständig beantwortet. Fremdsprachenaufgaben in der Fremdsprache. Nutze den Stundenkontext.
- Fehlt der eigentliche Aufgabentext (etwa "Aufgabe 3 auf Seite 42" ohne den Wortlaut): braucht_text = true, "loesung" enthält, was sich aus dem Stundenkontext schon vorbereiten lässt, und "hinweis" sagt, dass der Schüler den Aufgabentext eintippen soll.
- Keine Einleitung, keine Floskeln. Antworte ausschließlich im vorgegebenen JSON-Format.`;
}

export async function aufgabe(anbieter, eingabe) {
  const teile = [`Fach: ${eingabe.fach || "unbekannt"}`, `Arbeitsauftrag der Lehrkraft: ${eingabe.aufgabe}`];
  if (eingabe.zusatz) teile.push(`\nAufgabentext (vom Schüler eingetippt):\n${eingabe.zusatz}`);
  if (eingabe.kontext) teile.push(`\nStundenkontext:\n${eingabe.kontext}`);
  if (eingabe.transkript?.length) teile.push(`\nMitschrift der letzten Minuten:\n<transkript>\n${transkriptText(eingabe.transkript)}\n</transkript>`);
  const { daten, nutzung } = await strukturiert(anbieter, {
    system: aufgabeSystemPrompt(eingabe.profil),
    user: teile.join("\n"),
    schema: AUFGABE_SCHEMA,
    effort: "medium",
    maxTokens: 1500,
  });
  return { ...daten, schritte: Array.isArray(daten.schritte) ? daten.schritte : [], nutzung };
}

export const UEBERSETZUNG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["uebersetzungen"],
  properties: {
    uebersetzungen: {
      type: "array",
      description: "Für jedes Segment genau ein Eintrag mit derselben id, in derselben Reihenfolge.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text"],
        properties: { id: { type: "string" }, text: { type: "string", description: "Die deutsche Übersetzung des Segments." } },
      },
    },
  },
};

export const NACHFRAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["antwort", "quellen"],
  properties: {
    antwort: { type: "string", description: "Antwort auf die Frage, gestützt auf die Stunden. Sag ehrlich, wenn die Stunden nichts dazu hergeben." },
    quellen: { type: "array", items: { type: "string" }, description: "Welche Stunden (Fach und Datum) die Antwort stützen." },
  },
};

// --- Prompts -----------------------------------------------------------------

function profilText(profil = {}) {
  const teile = [];
  if (profil.klasse) teile.push(`Klassenstufe ${profil.klasse}`);
  if (profil.schulform) teile.push(profil.schulform);
  if (profil.name) teile.push(`Name des Schülers: ${profil.name}`);
  return teile.length ? teile.join(", ") : "Klassenstufe unbekannt (gehe von Mittel- bis Oberstufe aus)";
}

function niveauText(profil = {}) {
  const k = parseInt(profil.klasse, 10);
  if (!k) return "Sprich wie ein guter Schüler der Mittelstufe: klare, einfache Sätze, Fachwörter nur, wenn die Lehrkraft sie selbst benutzt hat.";
  if (k <= 6) return `Klassenstufe ${k}: kurze, einfache Sätze, Alltagswörter, keine Fremdwörter, höchstens ein Fachwort, das die Lehrkraft selbst benutzt hat. Beispiel: "Wasser besteht aus zwei Teilchen Wasserstoff und einem Teilchen Sauerstoff, deshalb heißt es H zwei O."`;
  if (k <= 9) return `Klassenstufe ${k}: klare Sätze, die Fachbegriffe aus dem Unterricht richtig verwendet, aber nichts darüber hinaus. Beispiel: "Ein Wassermolekül ist gewinkelt, weil die freien Elektronenpaare am Sauerstoff die beiden Wasserstoffatome wegdrücken."`;
  if (k <= 10) return `Klassenstufe ${k}: sicherer Umgang mit den Fachbegriffen des Fachs, ein Begründungsschritt ist erwünscht. Beispiel: "Wasser ist ein Dipol, weil Sauerstoff elektronegativer ist als Wasserstoff und das Molekül gewinkelt gebaut ist, dadurch heben sich die Ladungsschwerpunkte nicht auf."`;
  return `Oberstufe (Klassenstufe ${k}): fachsprachlich präzise, mit Begründung und, wo es passt, einem Fachbegriff mehr, aber immer noch gesprochen und nicht wie ein Lehrbuch. Beispiel: "Das Wassermolekül ist gewinkelt mit etwa 104,5 Grad, weil die beiden freien Elektronenpaare am Sauerstoff mehr Raum beanspruchen als die bindenden; zusammen mit der Elektronegativitätsdifferenz ergibt das den Dipolcharakter."`;
}

function laengeText(profil = {}) {
  if (profil.antwortlaenge === "kurz") return "Der Schüler will kurze Antworten: ein Satz, höchstens zwei.";
  if (profil.antwortlaenge === "lang") return "Der Schüler darf etwas ausführlicher antworten: drei bis fünf Sätze, mit Begründung oder Beispiel.";
  return "Normale Länge: ein bis drei Sätze, bei Erklär- und Rechenaufgaben bis vier.";
}

export function antwortSystemPrompt(profil = {}) {
  return `Du hilfst einem Schüler, der im Unterricht sitzt und sich melden möchte. Die App hört den Unterricht mit und schreibt ihn automatisch mit. Das Transkript kommt von einer Spracherkennung: Es enthält Hörfehler (z. B. "H zwei O" statt "H2O", "Fotos Synthese" statt "Photosynthese", "Mohl" statt "Mol"), keine Satzzeichen, abgeschnittene Sätze und Stimmen von Mitschülern (Zwischenrufe, halbe Antwortversuche). Lies es so, wie ein Mensch es im Raum gehört hätte, korrigiere Hörfehler stillschweigend und lass dich von Mitschüler-Einwürfen nicht ablenken: Maßgeblich ist, was die Lehrkraft fragt.

Profil: ${profilText(profil)}.
Niveau: ${niveauText(profil)}
Länge: ${laengeText(profil)}

Deine Aufgabe:
1. Prüfe, ob die Lehrkraft zuletzt (am Ende des Transkripts) eine Frage oder Aufgabe an die Klasse gerichtet hat. Rhetorische Fragen ("Ist doch klar, oder?"), Organisatorisches ("Habt ihr alle das Buch?", "Wer fehlt?"), Rückfragen an einen einzelnen Schüler und Fragen, die die Lehrkraft danach selbst beantwortet hat, zählen nicht. Im Zweifel beantworte die wahrscheinlichste Frage, statt frage_erkannt = false zu liefern. Steht unten eine "erkannte" oder "eingetippte" Frage, beantworte genau diese, immer mit frage_erkannt = true, auch wenn sie nicht wörtlich im Transkript steht. Im Modus "Jetzt antworten" ist frage_erkannt ebenfalls immer true: Beantworte die letzte Frage oder Aufgabe; gibt es keine, fasse in zwei Sätzen das zuletzt Erklärte so zusammen, wie der Schüler es sagen könnte, wenn er aufgerufen wird.
2. Wenn ja: Schreibe die Antwort so, wie der Schüler sie laut sagt, wenn er aufgerufen wird.
   - Gesprochene Sprache, erster Satz ist direkt die Antwort. Kein "Die Antwort ist", kein "Gerne", keine Anrede, keine Aufzählungszeichen, keine Klammern, keine Abkürzungen, die man nicht sprechen kann. Zahlen so, wie man sie sagt, wenn sie kompliziert sind ("ungefähr hundertvier Grad").
   - Nimm die Wörter auf, die die Lehrkraft gerade benutzt hat, und knüpfe an das an, was in der Stunde davor gesagt wurde. Der Stundenkontext unten sagt dir, worum es geht.
   - Fachlich richtig und auf dem Niveau der Klasse: nicht klüger als der beste Schüler der Klasse, nicht wie ein Lexikon.
   - Rechen- und Lösungsaufgaben: Ergebnis zuerst, dann in einem Halbsatz der Weg ("Das sind zwölf, weil drei mal vier zwölf ist.").
   - Erklärfragen ("Warum ..."): ein Grund, ein Beispiel, fertig.
   - Textarbeit in Deutsch oder Fremdsprachen: Antwort mit Bezug auf den Text, wie ein Schüler, der mitgelesen hat.
   - Fremdsprachenunterricht: Stellt die Lehrkraft die Frage auf Englisch (oder Französisch, Spanisch), antworte in dieser Sprache, auf dem Niveau der Klasse.
   - Meinungsfragen: eine klare Position mit einem Grund, in Ich-Form.
   - Wenn das Transkript die Frage nur halb hergibt, beantworte die wahrscheinlichste Lesart und formuliere in "frage", wie du sie verstanden hast.
3. "erklaerung": höchstens ein Satz Hintergrund für eine mögliche Rückfrage. Sonst leer. Fasse dich insgesamt kurz, der Schüler wartet.
4. Fragt die Lehrkraft, wie etwas aussieht, dargestellt, gezeichnet oder aufgebaut ist (Molekül, Strukturformel, Zelle, Organ, Schaltkreis, Diagramm, Karte, geometrische Figur, Funktionsgraph), liefere ein Bild: Für chemische Stoffe "molekuel" mit dem englischen Stoffnamen. Für Dinge mit gutem Wikipedia-Hauptbild "wikipedia" mit dem deutschen Artikeltitel. Nur wenn beides nicht passt, eine ganz kleine eigene Skizze als SVG (viewBox 0 0 400 300, schwarze Linien auf Weiß, höchstens 900 Zeichen, keine Skripte).
5. Wenn keine Frage da ist: frage_erkannt = false und alle anderen Felder leer bzw. typ "keins". Erfinde keine Frage.
6. Steht dir die Web-Suche zur Verfügung, nutze sie nur, wenn du dir bei einer Zahl, einem Datum, einem Namen oder einem aktuellen Ereignis nicht sicher bist. Für Schulstoff, den du sicher weißt, antworte direkt: Der Schüler wartet, jede Suche kostet Sekunden.

Beispiele für den Ton (nur der Stil zählt, der Inhalt muss immer zur tatsächlichen Frage passen):
- Physik, Klasse 8. Lehrkraft: "wer weiß warum der himmel blau ist" → antwort: "Weil das Sonnenlicht in der Luft gestreut wird, und blaues Licht wird viel stärker gestreut als rotes. Deshalb kommt von überall aus dem Himmel blaues Licht zu uns." kurz: "Weil die Luft blaues Licht stärker streut als rotes."
- Biologie, Klasse 10. Lehrkraft: "was passiert bei der fotosynthese" → antwort: "Die Pflanze nimmt Kohlenstoffdioxid und Wasser auf und macht daraus mit Lichtenergie Traubenzucker und Sauerstoff. Das läuft in den Chloroplasten ab, mit dem Chlorophyll als Lichtfänger." kurz: "Aus Kohlenstoffdioxid und Wasser entstehen mit Licht Zucker und Sauerstoff."
- Mathe, Klasse 7. Lehrkraft: "was ist denn jetzt drei viertel von zweihundert" → antwort: "Hundertfünfzig. Ein Viertel von zweihundert sind fünfzig, und drei davon sind hundertfünfzig." kurz: "Hundertfünfzig."
- Geschichte, Oberstufe. Lehrkraft: "warum ist die weimarer republik gescheitert" → antwort: "Ich würde sagen, vor allem an drei Dingen: Sie hatte von Anfang an wenige überzeugte Anhänger, die Wirtschaftskrise ab 1929 hat Millionen in die Arbeitslosigkeit getrieben, und die Verfassung erlaubte mit dem Notverordnungsrecht, am Parlament vorbei zu regieren. Das hat den Weg für Hitler frei gemacht." kurz: "Zu wenig Rückhalt, die Weltwirtschaftskrise und der Artikel 48, der das Regieren ohne Parlament erlaubte."

Antworte ausschließlich im vorgegebenen JSON-Format.`;
}

function transkriptText(transkript = []) {
  return transkript
    .map((s) => {
      const t = typeof s.t === "number" ? `[${formatZeit(s.t)}] ` : "";
      return `${t}${s.text}`;
    })
    .join("\n");
}

export function formatZeit(sekunden) {
  const m = Math.floor(sekunden / 60);
  const s = Math.floor(sekunden % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function antwortUserPrompt({ fach, transkript, frage, modus, kontext, bisherige, sprache, erkannt }) {
  const spr = sprache && sprache !== "de" ? `\nSprache der Lehrkraft: ${SPRACHEN[sprache] || sprache} (antworte in dieser Sprache, auf dem Niveau der Klasse; Erklärung und Frage-Feld auf Deutsch)` : "";
  const kopf = `Fach: ${fach || "unbekannt"}${spr}\nModus: ${modus === "manuell" ? "Der Schüler hat auf 'Jetzt antworten' gedrückt: Beantworte die letzte Frage oder, wenn keine klare Frage da ist, das, was die Lehrkraft gerade wissen will." : "automatische Erkennung"}`;
  const ctx = kontext ? `\n\nStundenkontext (bisheriger Zwischenstand):\n${kontext}` : "";
  const alt = bisherige?.length ? `\n\nSchon beantwortete Fragen dieser Stunde (nicht noch einmal beantworten, außer die Lehrkraft fragt sie erneut):\n- ${bisherige.join("\n- ")}` : "";
  const eigene = frage ? (erkannt ? `\n\nVom Frage-Wächter erkannte Frage der Lehrkraft (beantworten, frage_erkannt = true): ${frage}` : `\n\nVom Schüler eingetippte Frage (hat Vorrang): ${frage}`) : "";
  return `${kopf}${ctx}${alt}\n\nTranskript der letzten Minuten (das Neueste steht unten):\n<transkript>\n${transkriptText(transkript)}\n</transkript>${eigene}`;
}

export function zusammenfassungSystemPrompt(profil, laufend = false) {
  if (laufend) {
    return `Die Stunde läuft noch. Du bekommst das bisherige automatische Transkript (mit Hörfehlern, ohne Satzzeichen) und schreibst für den Schüler (${profilText(profil)}) einen knappen Zwischenstand: Worum geht es bisher, die wichtigsten Aussagen bis jetzt (höchstens sechs Kernpunkte), Fragen und Aufgaben, die die Lehrkraft bisher gestellt hat, sowie Hausaufgaben, Tests und Termine, die genannt wurden. Kurz und konkret, auf Deutsch, nur was im Transkript vorkommt. Die Zusammenfassung ist drei bis fünf Sätze. Antworte ausschließlich im vorgegebenen JSON-Format.`;
  }
  return `Du fasst eine Unterrichtsstunde für einen Schüler zusammen (${profilText(profil)}). Grundlage ist ein automatisches Transkript mit Hörfehlern und ohne Satzzeichen, in dem auch Zwischenrufe und Antworten von Mitschülern stehen; die zählen nur, wenn die Lehrkraft sie bestätigt hat. Schreibe so, dass der Schüler die Stunde eine Woche später daraus nachlernen kann: klar, konkret, in seinen Worten, auf Deutsch (${niveauText(profil).split(":")[0]}). Hörfehler der Spracherkennung stillschweigend korrigieren. Gib nur wieder, was im Transkript vorkommt. Wenn etwas unverständlich war, lass es weg, statt zu raten. Hausaufgaben, Tests und Termine, die genannt wurden, gehören immer hinein. Antworte ausschließlich im vorgegebenen JSON-Format.`;
}

export function nachfrageSystemPrompt(profil) {
  return `Du beantwortest Fragen eines Schülers (${profilText(profil)}) zu seinen gespeicherten Unterrichtsstunden. Du bekommst Zusammenfassungen und, wo vorhanden, Transkripte. Antworte auf Deutsch, kurz und konkret, und nenne, aus welcher Stunde die Information stammt. Wenn die Stunden nichts dazu hergeben, sag das offen und gib höchstens eine knappe allgemeine Antwort, deutlich als solche gekennzeichnet. Antworte ausschließlich im vorgegebenen JSON-Format.`;
}

export const SPRACHEN = { de: "Deutsch", en: "Englisch", fr: "Französisch", es: "Spanisch", it: "Italienisch", la: "Latein", tr: "Türkisch", ru: "Russisch" };

export function uebersetzungSystemPrompt(von, fach) {
  const sprache = SPRACHEN[von] || von;
  return `Du übersetzt live den Unterricht für einen Schüler. Die Lehrkraft spricht ${sprache}${fach ? ` (Fach: ${fach})` : ""}. Du bekommst kurze Stücke aus einer automatischen Spracherkennung: ohne Satzzeichen, mit Hörfehlern, manchmal mitten im Satz abgeschnitten. Übersetze jedes Stück für sich ins Deutsche, natürlich und so, wie es im Unterricht gemeint ist. Korrigiere offensichtliche Hörfehler stillschweigend. Stücke, die schon Deutsch sind (die Lehrkraft wechselt die Sprache), lässt du unverändert. Zwischenrufe von Mitschülern übersetzt du knapp, ohne sie auszuschmücken. Namen, Zahlen und Fachbegriffe bleiben erhalten; bei Fachbegriffen darfst du das Original in Klammern dazusetzen, wenn es der Klasse hilft. Keine Kommentare, keine Erklärungen, pro Stück genau eine Übersetzung mit derselben id. Antworte ausschließlich im vorgegebenen JSON-Format.`;
}

// --- Aufrufe ----------------------------------------------------------------

async function strukturiert(anbieter, params) {
  return anbieter.strukturiert(params);
}

/**
 * Antwort auf die letzte Lehrerfrage im Transkript.
 * @param client Anthropic-Client
 * @param eingabe { fach, transkript: [{t, text}], frage?, modus: "auto"|"manuell", profil?, modell? }
 */
export async function antwort(anbieter, eingabe, onDelta) {
  const rufen = (params) => (onDelta && anbieter.strukturiertStream ? anbieter.strukturiertStream({ ...params, onDelta }) : strukturiert(anbieter, params));
  let { daten, nutzung } = await rufen({
    system: antwortSystemPrompt(eingabe.profil),
    user: antwortUserPrompt(eingabe),
    schema: ANTWORT_SCHEMA,
    effort: eingabe.modus === "manuell" ? "high" : "medium",
    maxTokens: 700,
    websuche: Boolean(eingabe.websuche),
  });
  // "Jetzt antworten" ohne erkennbare Frage: zweiter Anlauf mit klarem Auftrag,
  // damit der Schüler auf jeden Fall etwas zum Sagen hat.
  if (eingabe.modus === "manuell" && !eingabe.frage && !daten.frage_erkannt && eingabe.transkript?.length) {
    const zweiter = await rufen({
      system: antwortSystemPrompt(eingabe.profil),
      user: antwortUserPrompt({
        ...eingabe,
        erkannt: true,
        frage: "Fasse in zwei Sätzen zusammen, was die Lehrkraft zuletzt erklärt hat, so wie ich es sagen würde, wenn ich jetzt aufgerufen werde.",
      }),
      schema: ANTWORT_SCHEMA,
      effort: "medium",
      maxTokens: 700,
    });
    daten = zweiter.daten;
    nutzung = { ...zweiter.nutzung, eingabe: (nutzung.eingabe || 0) + (zweiter.nutzung.eingabe || 0), ausgabe: (nutzung.ausgabe || 0) + (zweiter.nutzung.ausgabe || 0) };
    if (daten.antwort) {
      daten.frage_erkannt = true;
      daten.frage = daten.frage || "Was wurde zuletzt erklärt?";
    }
  }
  const erzwungen = eingabe.modus === "manuell" || Boolean(eingabe.frage);
  if (!daten.frage_erkannt && !(erzwungen && daten.antwort)) {
    return { frage_erkannt: false, frage: "", antwort: "", kurz: "", erklaerung: "", bild: null, nutzung };
  }
  if (!daten.frage_erkannt) daten.frage_erkannt = true;
  const bild = daten.bild && daten.bild.typ !== "keins" ? daten.bild : null;
  return { ...daten, bild, nutzung };
}

export async function zusammenfassung(anbieter, eingabe) {
  const user = `Fach: ${eingabe.fach || "unbekannt"}\nDatum: ${eingabe.datum || "unbekannt"}\nDauer: ${eingabe.dauer ? formatZeit(eingabe.dauer) : "unbekannt"}\n\n<transkript>\n${transkriptText(eingabe.transkript)}\n</transkript>`;
  const { daten, nutzung } = await strukturiert(anbieter, {
    system: zusammenfassungSystemPrompt(eingabe.profil, Boolean(eingabe.laufend)),
    user,
    schema: ZUSAMMENFASSUNG_SCHEMA,
    effort: eingabe.laufend ? "low" : "high",
    schnell: Boolean(eingabe.laufend),
    maxTokens: eingabe.laufend ? 3000 : 6000,
  });
  return { ...daten, nutzung };
}

export async function nachfrage(anbieter, eingabe) {
  const stunden = (eingabe.stunden || [])
    .map((s, i) => {
      const kopf = `<stunde nr="${i + 1}" fach="${s.fach || ""}" datum="${s.datum || ""}" titel="${s.titel || ""}">`;
      const zf = s.zusammenfassung ? `Zusammenfassung: ${s.zusammenfassung}\n` : "";
      const kp = s.kernpunkte?.length ? `Kernpunkte:\n- ${s.kernpunkte.join("\n- ")}\n` : "";
      const tr = s.transkript?.length ? `Transkript:\n${transkriptText(s.transkript)}\n` : "";
      return `${kopf}\n${zf}${kp}${tr}</stunde>`;
    })
    .join("\n\n");
  const user = `${stunden}\n\nFrage des Schülers: ${eingabe.frage}`;
  const { daten, nutzung } = await strukturiert(anbieter, {
    system: nachfrageSystemPrompt(eingabe.profil),
    user,
    schema: NACHFRAGE_SCHEMA,
    effort: "medium",
  });
  return { ...daten, nutzung };
}

/**
 * Live-Übersetzung von Transkript-Stücken ins Deutsche.
 * @param eingabe { segmente: [{id, text}], von: "en", fach?, modell? }
 */
export async function uebersetzung(anbieter, eingabe) {
  const user = eingabe.segmente.map((s) => `<segment id="${s.id}">${s.text}</segment>`).join("\n");
  const { daten, nutzung } = await strukturiert(anbieter, {
    system: uebersetzungSystemPrompt(eingabe.von, eingabe.fach),
    user,
    schema: UEBERSETZUNG_SCHEMA,
    effort: "low",
    schnell: true,
    maxTokens: 3000,
  });
  const nachId = new Map((daten.uebersetzungen || []).map((u) => [u.id, u.text]));
  return { uebersetzungen: eingabe.segmente.map((s) => ({ id: s.id, text: nachId.get(s.id) ?? "" })), nutzung };
}
