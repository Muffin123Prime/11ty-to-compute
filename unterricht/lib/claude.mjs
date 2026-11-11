// Alle Claude-Aufrufe der Unterrichts-App: Antwort auf eine Lehrerfrage,
// Zusammenfassung einer Stunde, Nachfrage zu gespeicherten Stunden.
//
// Der Client wird von außen hereingereicht (Worker: Schlüssel aus dem
// Secret, lokal: aus der Umgebung), damit die Funktionen in Tests mit einem
// Attrappen-Client laufen.

export const STANDARD_MODELL = "claude-opus-5-5";

const BETAS = ["server-side-fallback-2026-07-01"];

// --- Schemas für die strukturierte Ausgabe ---------------------------------

export const ANTWORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["frage_erkannt", "frage", "antwort", "kurz", "erklaerung", "bild"],
  properties: {
    frage_erkannt: {
      type: "boolean",
      description:
        "true, wenn die Lehrkraft im Transkript zuletzt eine Frage oder Aufgabe an die Klasse gestellt hat (oder der Schüler selbst eine Frage eingetippt hat).",
    },
    frage: {
      type: "string",
      description: "Die Frage, so wie sie verstanden wurde, in einem Satz. Leer, wenn keine Frage erkannt.",
    },
    antwort: {
      type: "string",
      description:
        "Die Antwort zum Vorlesen: gesprochenes Deutsch, so wie ein guter Schüler dieser Klassenstufe sie im Unterricht sagen würde. Ein bis drei Sätze (bei Erklär- und Rechenaufgaben bis vier). Leer, wenn keine Frage erkannt.",
    },
    kurz: {
      type: "string",
      description: "Dieselbe Antwort in einem einzigen kurzen Satz, für den Fall, dass der Schüler schnell dran ist. Leer, wenn keine Frage erkannt.",
    },
    erklaerung: {
      type: "string",
      description: "Optional ein bis drei Sätze Hintergrund, damit der Schüler Rückfragen beantworten kann. Sonst leer.",
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
            "molekuel: ein chemischer Stoff, wert = englischer Name (z.B. water, glucose, sodium chloride). wikipedia: ein Artikel der deutschen Wikipedia, dessen Hauptbild passt, wert = Artikeltitel. svg: selbst gezeichnete Skizze (Strukturformel, Diagramm, Schema), wert = vollständiger SVG-Code mit viewBox, ohne Skripte, höchstens 6000 Zeichen. keins: kein Bild nötig.",
        },
        wert: { type: "string" },
        beschreibung: { type: "string", description: "Bildunterschrift in einem Satz. Leer bei typ keins." },
      },
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
  return `Du hilfst einem Schüler, der im Unterricht sitzt und sich melden möchte. Die App hört den Unterricht mit und schreibt ihn automatisch mit. Das Transkript kommt von einer Spracherkennung: Es enthält Hörfehler (z. B. "H zwei O" statt "H2O", "Fotos Synthese" statt "Photosynthese", "Mohl" statt "Mol"), keine Satzzeichen, abgeschnittene Sätze und manchmal Stimmen von Mitschülern. Lies es so, wie ein Mensch es im Raum gehört hätte, und korrigiere Hörfehler stillschweigend.

Profil: ${profilText(profil)}.
Niveau: ${niveauText(profil)}
Länge: ${laengeText(profil)}

Deine Aufgabe:
1. Prüfe, ob die Lehrkraft zuletzt (am Ende des Transkripts) eine Frage oder Aufgabe an die Klasse gerichtet hat. Rhetorische Fragen ("Ist doch klar, oder?"), Organisatorisches ("Habt ihr alle das Buch?", "Wer fehlt?"), Rückfragen an einen einzelnen Schüler und Fragen, die die Lehrkraft danach selbst beantwortet hat, zählen nicht. Hat der Schüler selbst eine Frage eingetippt, beantworte genau diese, auch wenn sie nicht im Transkript steht.
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
3. "erklaerung": ein bis drei Sätze Hintergrund, damit der Schüler Rückfragen der Lehrkraft beantworten kann (warum das so ist, worauf es hinausläuft, was eine typische Nachfrage wäre). Sonst leer.
4. Fragt die Lehrkraft, wie etwas aussieht, dargestellt, gezeichnet oder aufgebaut ist (Molekül, Strukturformel, Zelle, Organ, Schaltkreis, Diagramm, Karte, geometrische Figur, Funktionsgraph), liefere ein Bild: Für chemische Stoffe "molekuel" mit dem englischen Stoffnamen. Für Dinge mit gutem Wikipedia-Hauptbild "wikipedia" mit dem deutschen Artikeltitel. Wenn eine einfache eigene Skizze besser passt (Lewis-Formel, Kräftediagramm, Winkel, Reaktionsgleichung, Aufbau, Graph), zeichne sie als SVG: schlicht, schwarze Linien auf weißem Grund, gut lesbare Beschriftungen auf Deutsch, viewBox 0 0 400 300, keine Skripte, kein externes Laden.
5. Wenn keine Frage da ist: frage_erkannt = false und alle anderen Felder leer bzw. typ "keins". Erfinde keine Frage.
6. Steht dir die Web-Suche zur Verfügung, nutze sie nur, wenn du dir bei einer Zahl, einem Datum, einem Namen oder einem aktuellen Ereignis nicht sicher bist. Für Schulstoff, den du sicher weißt, antworte direkt: Der Schüler wartet, jede Suche kostet Sekunden.

Beispiele für den Ton (Klassenstufe 9, Chemie):
- Lehrkraft: "wer kann mir sagen wie h2o aussieht also wie das dargestellt wird" → antwort: "Ein Wassermolekül hat in der Mitte ein Sauerstoffatom, und daran hängen zwei Wasserstoffatome. Die beiden stehen nicht gerade gegenüber, sondern in einem Winkel von ungefähr hundertvier Grad, deshalb nennt man das Molekül gewinkelt." kurz: "Ein Sauerstoffatom mit zwei Wasserstoffatomen dran, gewinkelt und nicht gerade." Bild: molekuel, water.
- Lehrkraft: "warum löst sich salz in wasser" → antwort: "Weil Wasser ein Dipol ist. Die Wassermoleküle lagern sich mit ihrer leicht negativen Seite an die Natrium-Ionen und mit der positiven Seite an die Chlorid-Ionen an und ziehen die Ionen so aus dem Kristall heraus." kurz: "Weil die Wasser-Dipole die Ionen aus dem Salzkristall herausziehen."
- Lehrkraft (Mathe, Klasse 7): "was ist denn jetzt drei viertel von zweihundert" → antwort: "Hundertfünfzig. Ein Viertel von zweihundert sind fünfzig, und drei davon sind hundertfünfzig." kurz: "Hundertfünfzig."

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

export function antwortUserPrompt({ fach, transkript, frage, modus, kontext, bisherige }) {
  const kopf = `Fach: ${fach || "unbekannt"}\nModus: ${modus === "manuell" ? "Der Schüler hat auf 'Jetzt antworten' gedrückt: Beantworte die letzte Frage oder, wenn keine klare Frage da ist, das, was die Lehrkraft gerade wissen will." : "automatische Erkennung"}`;
  const ctx = kontext ? `\n\nStundenkontext (bisheriger Zwischenstand):\n${kontext}` : "";
  const alt = bisherige?.length ? `\n\nSchon beantwortete Fragen dieser Stunde (nicht noch einmal beantworten, außer die Lehrkraft fragt sie erneut):\n- ${bisherige.join("\n- ")}` : "";
  const eigene = frage ? `\n\nVom Schüler eingetippte Frage (hat Vorrang): ${frage}` : "";
  return `${kopf}${ctx}${alt}\n\nTranskript der letzten Minuten (das Neueste steht unten):\n<transkript>\n${transkriptText(transkript)}\n</transkript>${eigene}`;
}

export function zusammenfassungSystemPrompt(profil, laufend = false) {
  if (laufend) {
    return `Die Stunde läuft noch. Du bekommst das bisherige automatische Transkript (mit Hörfehlern, ohne Satzzeichen) und schreibst für den Schüler (${profilText(profil)}) einen knappen Zwischenstand: Worum geht es bisher, die wichtigsten Aussagen bis jetzt (höchstens sechs Kernpunkte), Fragen und Aufgaben, die die Lehrkraft bisher gestellt hat, sowie Hausaufgaben, Tests und Termine, die genannt wurden. Kurz und konkret, auf Deutsch, nur was im Transkript vorkommt. Die Zusammenfassung ist drei bis fünf Sätze. Antworte ausschließlich im vorgegebenen JSON-Format.`;
  }
  return `Du fasst eine Unterrichtsstunde für einen Schüler zusammen (${profilText(profil)}). Grundlage ist ein automatisches Transkript mit Hörfehlern und ohne Satzzeichen. Schreibe so, dass der Schüler die Stunde eine Woche später daraus nachlernen kann: klar, konkret, in seinen Worten, auf Deutsch (${niveauText(profil).split(":")[0]}). Hörfehler der Spracherkennung stillschweigend korrigieren. Gib nur wieder, was im Transkript vorkommt. Wenn etwas unverständlich war, lass es weg, statt zu raten. Hausaufgaben, Tests und Termine, die genannt wurden, gehören immer hinein. Antworte ausschließlich im vorgegebenen JSON-Format.`;
}

export function nachfrageSystemPrompt(profil) {
  return `Du beantwortest Fragen eines Schülers (${profilText(profil)}) zu seinen gespeicherten Unterrichtsstunden. Du bekommst Zusammenfassungen und, wo vorhanden, Transkripte. Antworte auf Deutsch, kurz und konkret, und nenne, aus welcher Stunde die Information stammt. Wenn die Stunden nichts dazu hergeben, sag das offen und gib höchstens eine knappe allgemeine Antwort, deutlich als solche gekennzeichnet. Antworte ausschließlich im vorgegebenen JSON-Format.`;
}

// --- Aufrufe ----------------------------------------------------------------

async function strukturiert(client, { modell, system, user, schema, effort, maxTokens, websuche }) {
  const messages = [{ role: "user", content: user }];
  const params = {
    model: modell || STANDARD_MODELL,
    max_tokens: maxTokens || 8000,
    betas: BETAS,
    fallbacks: "default",
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages,
    output_config: { effort: effort || "medium", format: { type: "json_schema", schema } },
  };
  if (websuche) params.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }];

  let response = await client.beta.messages.create(params);
  // Ein langer Such-Durchlauf kann mit pause_turn anhalten: Antwort anhängen und weitermachen.
  for (let runde = 0; response.stop_reason === "pause_turn" && runde < 3; runde++) {
    messages.push({ role: "assistant", content: response.content });
    response = await client.beta.messages.create(params);
  }

  if (response.stop_reason === "refusal") {
    const grund = response.stop_details?.explanation || response.stop_details?.category || "ohne Angabe";
    throw new Error(`Claude hat die Anfrage abgelehnt (${grund}).`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Die Antwort war zu lang und wurde abgeschnitten.");
  }
  // Bei Web-Suche stehen vor dem JSON Such-Blöcke; das Ergebnis ist der letzte Textblock.
  const texte = response.content.filter((b) => b.type === "text").map((b) => b.text);
  const text = texte.at(-1) || "";
  let daten;
  try {
    daten = JSON.parse(text);
  } catch {
    throw new Error("Claude hat kein gültiges JSON geliefert.");
  }
  const suchen = response.content.filter((b) => b.type === "server_tool_use").length;
  return {
    daten,
    nutzung: {
      modell: response.model,
      eingabe: response.usage?.input_tokens ?? 0,
      ausgabe: response.usage?.output_tokens ?? 0,
      cache: response.usage?.cache_read_input_tokens ?? 0,
      suchen,
    },
  };
}

/**
 * Antwort auf die letzte Lehrerfrage im Transkript.
 * @param client Anthropic-Client
 * @param eingabe { fach, transkript: [{t, text}], frage?, modus: "auto"|"manuell", profil?, modell? }
 */
export async function antwort(client, eingabe) {
  const { daten, nutzung } = await strukturiert(client, {
    modell: eingabe.modell,
    system: antwortSystemPrompt(eingabe.profil),
    user: antwortUserPrompt(eingabe),
    schema: ANTWORT_SCHEMA,
    effort: eingabe.modus === "manuell" ? "high" : "medium",
    websuche: Boolean(eingabe.websuche),
  });
  if (!daten.frage_erkannt) {
    return { frage_erkannt: false, frage: "", antwort: "", kurz: "", erklaerung: "", bild: null, nutzung };
  }
  const bild = daten.bild && daten.bild.typ !== "keins" ? daten.bild : null;
  return { ...daten, bild, nutzung };
}

export async function zusammenfassung(client, eingabe) {
  const user = `Fach: ${eingabe.fach || "unbekannt"}\nDatum: ${eingabe.datum || "unbekannt"}\nDauer: ${eingabe.dauer ? formatZeit(eingabe.dauer) : "unbekannt"}\n\n<transkript>\n${transkriptText(eingabe.transkript)}\n</transkript>`;
  const { daten, nutzung } = await strukturiert(client, {
    modell: eingabe.modell,
    system: zusammenfassungSystemPrompt(eingabe.profil, Boolean(eingabe.laufend)),
    user,
    schema: ZUSAMMENFASSUNG_SCHEMA,
    effort: eingabe.laufend ? "low" : "high",
    maxTokens: 16000,
  });
  return { ...daten, nutzung };
}

export async function nachfrage(client, eingabe) {
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
  const { daten, nutzung } = await strukturiert(client, {
    modell: eingabe.modell,
    system: nachfrageSystemPrompt(eingabe.profil),
    user,
    schema: NACHFRAGE_SCHEMA,
    effort: "medium",
  });
  return { ...daten, nutzung };
}
