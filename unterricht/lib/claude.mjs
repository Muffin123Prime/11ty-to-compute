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
  required: ["frage_erkannt", "frage", "antwort", "erklaerung", "bild"],
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
        "Die Antwort, die der Schüler laut vorlesen kann: ein bis drei natürliche Sätze, wie ein guter Schüler sie sagen würde. Leer, wenn keine Frage erkannt.",
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

export function antwortSystemPrompt(profil) {
  return `Du hilfst einem Schüler, der im Unterricht sitzt und mitarbeiten möchte. Die App hört den Unterricht mit und schreibt ihn automatisch mit. Das Transkript kommt von einer Spracherkennung: Es enthält Hörfehler, fehlende Satzzeichen, abgeschnittene Sätze und manchmal Stimmen von Mitschülern. Lies es so, wie ein Mensch es hören würde.

Profil: ${profilText(profil)}.

Deine Aufgabe:
1. Prüfe, ob die Lehrkraft zuletzt (am Ende des Transkripts) eine Frage oder Aufgabe an die Klasse gerichtet hat. Rhetorische Fragen, Organisatorisches ("Habt ihr alle das Buch?") und Fragen, die schon beantwortet wurden, zählen nicht. Wenn der Schüler selbst eine Frage eingetippt hat, beantworte genau diese.
2. Wenn ja: Schreibe die Antwort so, wie der Schüler sie laut sagen würde, wenn er aufgerufen wird. Natürlich, kurz (ein bis drei Sätze), fachlich richtig, auf dem Niveau der Klassenstufe, ohne Einleitung wie "Die Antwort ist", ohne Aufzählungszeichen, ohne Fachjargon, den die Klasse nicht kennt. Nutze den Zusammenhang aus dem Transkript (worum ging es gerade, welche Begriffe hat die Lehrkraft benutzt). Bei Rechenaufgaben nenne das Ergebnis und in einem Halbsatz den Weg.
3. Fragt die Lehrkraft, wie etwas aussieht, dargestellt oder gezeichnet wird (Molekül, Strukturformel, Zelle, Organ, Schaltkreis, Diagramm, Karte, geometrische Figur), liefere ein Bild: Für chemische Stoffe "molekuel" mit dem englischen Stoffnamen. Für Dinge mit gutem Wikipedia-Hauptbild "wikipedia" mit dem deutschen Artikeltitel. Wenn eine einfache eigene Skizze besser passt (Lewis-Formel, Kräftediagramm, Winkel, Reaktionsgleichung, Aufbau), zeichne sie als SVG: schlicht, schwarze Linien auf weißem Grund, Beschriftungen in Deutsch, viewBox 0 0 400 300, keine Skripte, kein externes Laden.
4. Wenn keine Frage da ist: frage_erkannt = false und alle anderen Felder leer bzw. typ "keins". Erfinde keine Frage.

Antworte ausschließlich im vorgegebenen JSON-Format. Alle Texte auf Deutsch.`;
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

export function antwortUserPrompt({ fach, transkript, frage, modus }) {
  const kopf = `Fach: ${fach || "unbekannt"}\nModus: ${modus === "manuell" ? "Der Schüler hat auf 'Jetzt antworten' gedrückt: Beantworte die letzte Frage oder, wenn keine klare Frage da ist, das, was die Lehrkraft gerade wissen will." : "automatische Erkennung"}`;
  const eigene = frage ? `\n\nVom Schüler eingetippte Frage (hat Vorrang): ${frage}` : "";
  return `${kopf}\n\nTranskript der letzten Minuten (das Neueste steht unten):\n<transkript>\n${transkriptText(transkript)}\n</transkript>${eigene}`;
}

export function zusammenfassungSystemPrompt(profil) {
  return `Du fasst eine Unterrichtsstunde für einen Schüler zusammen (${profilText(profil)}). Grundlage ist ein automatisches Transkript mit Hörfehlern und ohne Satzzeichen. Schreibe so, dass der Schüler die Stunde eine Woche später daraus nachlernen kann: klar, konkret, in seinen Worten, auf Deutsch. Gib nur wieder, was im Transkript vorkommt. Wenn etwas unverständlich war, lass es weg, statt zu raten. Hausaufgaben, Tests und Termine, die genannt wurden, gehören immer hinein. Antworte ausschließlich im vorgegebenen JSON-Format.`;
}

export function nachfrageSystemPrompt(profil) {
  return `Du beantwortest Fragen eines Schülers (${profilText(profil)}) zu seinen gespeicherten Unterrichtsstunden. Du bekommst Zusammenfassungen und, wo vorhanden, Transkripte. Antworte auf Deutsch, kurz und konkret, und nenne, aus welcher Stunde die Information stammt. Wenn die Stunden nichts dazu hergeben, sag das offen und gib höchstens eine knappe allgemeine Antwort, deutlich als solche gekennzeichnet. Antworte ausschließlich im vorgegebenen JSON-Format.`;
}

// --- Aufrufe ----------------------------------------------------------------

async function strukturiert(client, { modell, system, user, schema, effort, maxTokens }) {
  const response = await client.beta.messages.create({
    model: modell || STANDARD_MODELL,
    max_tokens: maxTokens || 8000,
    betas: BETAS,
    fallbacks: "default",
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
    output_config: { effort: effort || "medium", format: { type: "json_schema", schema } },
  });

  if (response.stop_reason === "refusal") {
    const grund = response.stop_details?.explanation || response.stop_details?.category || "ohne Angabe";
    throw new Error(`Claude hat die Anfrage abgelehnt (${grund}).`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Die Antwort war zu lang und wurde abgeschnitten.");
  }
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  let daten;
  try {
    daten = JSON.parse(text);
  } catch {
    throw new Error("Claude hat kein gültiges JSON geliefert.");
  }
  return {
    daten,
    nutzung: {
      modell: response.model,
      eingabe: response.usage?.input_tokens ?? 0,
      ausgabe: response.usage?.output_tokens ?? 0,
      cache: response.usage?.cache_read_input_tokens ?? 0,
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
  });
  if (!daten.frage_erkannt) {
    return { frage_erkannt: false, frage: "", antwort: "", erklaerung: "", bild: null, nutzung };
  }
  const bild = daten.bild && daten.bild.typ !== "keins" ? daten.bild : null;
  return { ...daten, bild, nutzung };
}

export async function zusammenfassung(client, eingabe) {
  const user = `Fach: ${eingabe.fach || "unbekannt"}\nDatum: ${eingabe.datum || "unbekannt"}\nDauer: ${eingabe.dauer ? formatZeit(eingabe.dauer) : "unbekannt"}\n\n<transkript>\n${transkriptText(eingabe.transkript)}\n</transkript>`;
  const { daten, nutzung } = await strukturiert(client, {
    modell: eingabe.modell,
    system: zusammenfassungSystemPrompt(eingabe.profil),
    user,
    schema: ZUSAMMENFASSUNG_SCHEMA,
    effort: "high",
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
