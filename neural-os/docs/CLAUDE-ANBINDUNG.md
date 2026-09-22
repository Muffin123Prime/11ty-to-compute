# Claude-Anbindung — die Vorlage für den Online-Modus

Entscheidung des Nutzers (22.09.2026): **online antwortet Claude (Anthropic)**,
offline ein lokales Modell über Ollama. Dieses Dokument ist der Vertrag für
alle, die den Online-Modus bauen. Es stammt aus der aktuellen
Schnittstellen-Referenz von Anthropic, nicht aus dem Gedächtnis — wer hier
etwas ändert, prüft es vorher gegen die Referenz.

---

## 1. Warum rohes HTTP statt SDK

Anthropic empfiehlt sein offizielles SDK (`@anthropic-ai/sdk`). Neural OS
benutzt es trotzdem nicht, aus zwei Gründen, die beide aus dem Grundauftrag
kommen:

1. **Null Abhängigkeiten.** Neural OS läuft vom Stick mit einer mitgebrachten
   `node.exe` auf Rechnern, auf denen nichts installiert werden darf. Es gibt
   dort kein `npm install`.
2. **Die Netzschleuse.** Jeder Netzzugriff muss durch `src/net/gate.js`. Ein
   SDK mit eigenem HTTP-Stapel ginge daran vorbei.

Also: `POST https://api.anthropic.com/v1/messages` über die Schleuse, mit den
Formen von unten. **Nicht** die OpenAI-kompatible Schnittstelle von Anthropic —
sie hat weder die Websuche noch Werkzeuge in voller Form noch Prompt-Caching.
Der alte Eintrag `anthropic` mit `kind: 'openai'` in `src/http/api/models.js`
wird durch einen eigenen Anbieter `src/models/providers/anthropic.js` ersetzt.

## 2. Anfrage

```http
POST https://api.anthropic.com/v1/messages
content-type: application/json
x-api-key: <Schlüssel>
anthropic-version: 2023-06-01
anthropic-beta: server-side-fallback-2026-07-01
```

```json
{
  "model": "claude-opus-5",
  "max_tokens": 64000,
  "stream": true,
  "fallbacks": "default",
  "thinking": { "type": "adaptive", "display": "summarized" },
  "output_config": { "effort": "medium" },
  "system": [
    { "type": "text", "text": "<fester Systemtext>" },
    { "type": "text", "text": "<Gedächtnis: was die KI über den Nutzer weiß>",
      "cache_control": { "type": "ephemeral" } }
  ],
  "tools": [ ... siehe 4 ... ],
  "messages": [ ... ]
}
```

- **Modell:** `claude-opus-5` als Voreinstellung (der Nutzer hat "Claude"
  gewählt, ohne ein Modell zu nennen — dann gilt das stärkste allgemein
  empfohlene). In den Einstellungen wählbar: `claude-sonnet-5` (günstiger),
  `claude-haiku-4-5` (am günstigsten). **Genau diese IDs, ohne Datumsanhang.**
- **`fallbacks: "default"` + Kopf `server-side-fallback-2026-07-01`:** lehnt
  Claudes Sicherheitsprüfung eine Anfrage ab, springt serverseitig ein
  Ersatzmodell ein. Der Kopf gehört exakt zu dieser Form; die Listenform
  (`[{model: ...}]`) hat einen anderen Kopf (`-2026-06-01`) — beides mischen gibt 400.
- **Denken:** auf `claude-opus-5` immer an, wenn nichts gesetzt ist.
  `budget_tokens` gibt 400. `display: "summarized"` liefert eine lesbare
  Zusammenfassung des Gedankengangs — die Oberfläche zeigt sie einklappbar
  ("Gedankengang"), wie Claude es tut. Ohne `display` kommen leere
  `thinking`-Blöcke und eine lange Pause vor dem ersten Wort.
- **`output_config.effort`:** `medium` für den Chat (schnell genug, deutlich
  günstiger; für Chat laut Referenz ohne spürbaren Qualitätsverlust). `high`
  für ausdrückliche Planungs- und Rechercheaufträge. Nicht `temperature` usw.
  — die werden auf diesem Modell mit 400 abgelehnt.
- **`max_tokens`:** Obergrenze für Denken **plus** Antwort. Beim Streamen
  großzügig (64000), sonst bricht die Antwort mitten im Satz ab.
- **Kein Vorausfüllen** der Assistentenantwort (letzte Nachricht `assistant`)
  — gibt 400.

## 3. Caching

Die Reihenfolge ist `tools` → `system` → `messages`; jede Änderung im Präfix
macht alles danach ungültig. Deshalb:

- Werkzeugliste immer gleich, immer gleiche Reihenfolge.
- Fester Systemtext zuerst, **ohne** Uhrzeit, Datum oder Zufallszahlen.
- Das Gedächtnis danach, mit dem `cache_control`-Punkt dahinter. Es ändert
  sich selten; wenn doch, wird nur ab dort neu gerechnet.
- Das heutige Datum gehört in die **Nutzernachricht** des aktuellen Zuges,
  nicht in den Systemtext.
- Prüfen über `usage.cache_read_input_tokens` — bleibt es bei 0, ist ein
  stiller Präfixwechsel im Spiel.

## 4. Werkzeuge

### Websuche (läuft bei Anthropic, nicht auf dem Laptop)

```json
{ "type": "web_search_20260209", "name": "web_search" },
{ "type": "web_fetch_20260209",  "name": "web_fetch" }
```

- Anthropic sucht und liest die Seiten; der Laptop spricht nur mit
  `api.anthropic.com`. Die Schleuse braucht also genau eine Freigabe.
- Ergebnisse kommen als `server_tool_use` + `web_search_tool_result`.
  Textblöcke können `citations` tragen → die Oberfläche zeigt die Quellen
  unter der Antwort.
- **Fehler werfen nicht:** HTTP 200, und `content` des Ergebnisblocks ist ein
  **Objekt** mit `error_code` statt einer **Liste**. Vor dem Lesen unterscheiden.
- **`stop_reason: "pause_turn"`:** die Suche hat ihre Schleife ausgeschöpft.
  Die Anfrage mit der bisherigen Assistentenantwort (vollständiges `content`)
  **ohne** zusätzliche Nutzernachricht erneut schicken — der Server macht
  weiter. Höchstens 5-mal pro Zug.
- Kein zusätzliches `code_execution`-Werkzeug daneben (die Suche bringt ihre
  eigene Filterung mit; ein zweites verwirrt das Modell).

### Eigene Werkzeuge (laufen in Neural OS)

Jedes eigene Werkzeug trägt `"strict": true` (dann braucht das Schema
`"additionalProperties": false` und `required`) und, weil gestreamt wird,
`"eager_input_streaming": true`. Die Beschreibung sagt **wann** es zu benutzen
ist, nicht nur was es tut.

Weil `eager_input_streaming` die Prüfung beim Server abschaltet, gilt für
jede Werkzeugeingabe:

1. Gesammelte `input_json_delta`-Stücke **streng** mit `JSON.parse` lesen,
   dann gegen das Schema prüfen.
2. Ist `stop_reason` `max_tokens` oder `refusal`, **kein** Werkzeug dieses
   Zuges ausführen.
3. Schlägt die Prüfung fehl: nicht ausführen, sondern
   `{"type":"tool_result","tool_use_id":"…","is_error":true,"content":"{\"INVALID_JSON\":\"…\"}"}`
   zurückschicken (mit `JSON.stringify` gebaut, nicht zusammengeklebt).
4. Alle Ergebnisse eines Zuges gehen in **einer** Nutzernachricht zurück.

Werkzeuge, die der Bauplan (`docs/NEUE-APP.md`) festlegt — Namen und Felder
dort. Mindestens:

- **`rueckfrage`** — stellt dem Nutzer eine Frage mit antippbaren Antworten.
  `stop_reason` wird `tool_use`; die Oberfläche zeigt Frage + Knöpfe; das
  Antippen wird als `tool_result` zurückgeschickt und der Zug läuft weiter.
- Die Werkzeuge der Automatik (Termin anlegen, Notiz anlegen, etwas über den
  Nutzer merken, Projekt anpassen) — sie schreiben in den Tresor und sind
  in der Hintergrundaktivität als Agenten sichtbar.

`tool_choice` bleibt `auto`.

## 5. Streaming lesen

Server-Sent Events, in dieser Folge:

```
message_start          → message.id, usage (Eingabe, Cache)
content_block_start    → Blocktyp: text | thinking | tool_use | server_tool_use | web_search_tool_result | …
content_block_delta    → text_delta | thinking_delta | input_json_delta | citations_delta
content_block_stop
message_delta          → delta.stop_reason, usage.output_tokens
message_stop
```

Dazu `ping` (ignorieren) und `error` (z. B. `overloaded_error`) — ein
Fehler kann **mitten** im Strom kommen, nach bereits gezeigtem Text.

**Vor dem Lesen von `content` immer `stop_reason` prüfen:**

| `stop_reason` | bedeutet | Oberfläche |
|---|---|---|
| `end_turn` | fertig | nichts |
| `tool_use` | eigenes Werkzeug gewünscht | ausführen (bzw. Rückfrage zeigen), weiter |
| `pause_turn` | Suche pausiert | ohne neue Nutzernachricht erneut senden |
| `max_tokens` | abgeschnitten | ehrlich sagen, "weiter" anbieten |
| `refusal` | abgelehnt (auch nach Ersatzmodell) | ehrlich sagen; `stop_details.category` nicht roh zeigen |

Der ganze bisherige Assistenteninhalt (inklusive `thinking`-Blöcken
unverändert) geht bei jedem Folgezug zurück — nie nur der Text.

## 6. Fehler

| HTTP | Bedeutung | Satz für den Nutzer |
|---|---|---|
| 401 | Schlüssel falsch | "Der Claude-Schlüssel stimmt nicht." |
| 403 | keine Berechtigung | "Dieses Konto darf das Modell nicht benutzen." |
| 429 | zu viele Anfragen | "Kurz zu viele Anfragen — gleich nochmal." (`retry-after` beachten) |
| 529 / `overloaded_error` | überlastet | "Claude ist gerade überlastet." |
| Schleuse blockiert | offline | "Offline — dein lokales Modell antwortet." |

Keine englischen Rohtexte in der Oberfläche.

## 7. Der Schlüssel

- Ein Knopf "Claude verbinden" → ein Feld für den Schlüssel → sofort ein
  Probeaufruf (kleines `max_tokens`), der sagt, ob er funktioniert.
- Er liegt **im Tresor**, nicht in `config.json` im Klartext — damit reist er
  mit dem Stick und ist mit der PIN geschützt, sobald sie eingerichtet ist.
- Er verlässt Neural OS nur als `x-api-key` an `api.anthropic.com`, nie in
  eine Antwort, nie in ein Protokoll, nie an die Oberfläche zurück.
- Er kostet pro Nutzung. Die Einstellungen zeigen, was bisher verbraucht
  wurde (aus `usage` summiert) — ehrlich als Schätzung bezeichnet.

## 8. Online/Offline-Schalter

**Online** = Schleuse auf "Internet" mit Freigabe für `api.anthropic.com`,
Chat über Claude mit Websuche. **Offline** = Schleuse zu, Chat über das
lokale Modell, keine Websuche. Der Schalter zeigt immer den **tatsächlichen**
Zustand; schlägt Online fehl (kein Schlüssel, kein Netz), springt er nicht
stillschweigend um, sondern sagt, warum.
