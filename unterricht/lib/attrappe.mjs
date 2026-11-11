// Ein Attrappen-Client mit der Form von `client.beta.messages.create`, für
// Tests und `node server.mjs --mock`. Er liest das Schema der Anfrage und
// antwortet passend, ohne Claude zu rufen.
export function attrappenClient(ueberschreiben = {}) {
  const aufrufe = [];
  const client = {
    aufrufe,
    beta: {
      messages: {
        async create(params) {
          aufrufe.push(params);
          const schema = params.output_config?.format?.schema;
          const felder = Object.keys(schema?.properties || {});
          const text = JSON.stringify(ueberschreiben.antwort || standardAntwort(felder, params));
          return {
            model: params.model,
            stop_reason: ueberschreiben.stop_reason || "end_turn",
            stop_details: ueberschreiben.stop_details || null,
            content: [{ type: "text", text }],
            usage: { input_tokens: 1200, output_tokens: 150, cache_read_input_tokens: 900 },
          };
        },
      },
    },
  };
  return client;
}

function standardAntwort(felder, params) {
  const user = typeof params.messages?.[0]?.content === "string" ? params.messages[0].content : "";
  if (felder.includes("frage_erkannt")) {
    const manuell = /Modus: Der Schüler/.test(user);
    const eingetippt = user.match(/eingetippte Frage \(hat Vorrang\): (.+)$/m)?.[1];
    const letzte = user.split("\n").filter((z) => z.trim() && !z.startsWith("<")).at(-1) || "";
    const fragend = eingetippt || manuell || /\?|wie sieht|was ist|warum|wer kann|erklär/i.test(letzte);
    if (!fragend) {
      return { frage_erkannt: false, frage: "", antwort: "", erklaerung: "", bild: { typ: "keins", wert: "", beschreibung: "" } };
    }
    const wasser = /h2o|wasser/i.test(eingetippt || user);
    return {
      frage_erkannt: true,
      frage: eingetippt || "Wie sieht ein Wassermolekül aus?",
      antwort: wasser
        ? "Ein Wassermolekül besteht aus einem Sauerstoffatom, an dem zwei Wasserstoffatome hängen. Die beiden Bindungen stehen in einem Winkel von etwa 104 Grad, deshalb ist das Molekül gewinkelt und nicht gerade."
        : "Das ist eine Attrappen-Antwort: Hier stünde, was du laut sagen könntest.",
      erklaerung: wasser ? "Der Sauerstoff zieht die Elektronen stärker an, dadurch ist Wasser ein Dipol." : "",
      bild: wasser
        ? { typ: "molekuel", wert: "water", beschreibung: "Wassermolekül H₂O, Strukturformel aus PubChem" }
        : { typ: "keins", wert: "", beschreibung: "" },
    };
  }
  if (felder.includes("kernpunkte")) {
    return {
      titel: "Attrappen-Stunde",
      thema: "Eine Beispielstunde ohne echten Claude-Aufruf.",
      zusammenfassung: "Dies ist eine Attrappen-Zusammenfassung. Mit einem Anthropic-Schlüssel fasst Claude hier die Stunde in fünf bis zehn Sätzen zusammen.",
      kernpunkte: ["Erster Kernpunkt", "Zweiter Kernpunkt"],
      fragen: [{ frage: "Wie sieht H2O aus?", antwort: "Gewinkelt, ein Sauerstoff mit zwei Wasserstoffen." }],
      hausaufgaben: ["Seite 42, Aufgabe 3"],
      begriffe: [{ begriff: "Dipol", erklaerung: "Ein Molekül mit einer positiven und einer negativen Seite." }],
    };
  }
  if (felder.includes("quellen")) {
    return { antwort: "Attrappen-Antwort zu deinen Stunden.", quellen: ["Attrappen-Stunde"] };
  }
  return {};
}
