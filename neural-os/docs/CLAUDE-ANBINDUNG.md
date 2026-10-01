# Claude-Anbindung — die Vorlage für den Online-Modus

Entscheidung des Nutzers (22.09.2026): **online antwortet Claude (Anthropic)**,
offline ein lokales Modell über Ollama. *Inzwischen gibt es keine Offline-KI
mehr (Ollama ist entfernt), und Gemini ist die kostenlose erste Wahl
(Abschnitt 9); Claude bleibt die zweite.* Dieses Dokument ist der Vertrag für
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

## 9. Gemini (kostenlos)

Der Nutzer will kein Geld ausgeben. Deshalb ist **Google Gemini** die erste
Wahl und Claude die zweite (Einstellungen → KI). Erste Recherche:
24. September 2026; **nachgesehen am 1. Oktober 2026** in Googles
Unterlagen (ai.google.dev: Modelle, Preise, Limits, Regionen, Bedingungen,
Änderungsprotokoll), nachdem der Nutzer mit seinem echten Schlüssel „gar
nichts“ zum Laufen bekam. Umgesetzt in `src/models/providers/gemini.js`;
der Verbund der Anbieter steht in `src/models/ki.js`, Schlüssel und
Ausweichen in `src/models/anbieter-dienst.js`.

**Modelle (Stand 01.10.2026).** Stabil und kostenlos: `gemini-3.8-flash`
(seit 02.09.2026, Voreinstellung), `gemini-3.7-flash`, `gemini-3.6-flash`,
`gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`; alle
1 048 576 Token Eingabe, 65 536 Ausgabe. Vorschau: `gemini-3-flash-preview`
(kostenlos), `gemini-3.1-pro-preview` (**nicht** kostenlos). Die
2.5-Modelle gibt es seit 18.09.2026 nur noch für Projekte, die sie schon
benutzt haben; 2.0 ist abgeschaltet. **Deshalb verlässt sich Neural OS nicht
auf eine feste Liste:** Beim Verbinden fragt es mit dem Schlüssel
`GET /v1beta/models` (`pageSize` bis 1000, `nextPageToken`), nimmt die
Chat-Modelle (generateContent, keine Einbettung/Sprachausgabe/Bilder/Live),
ordnet sie (Flash vor Flash-Lite vor Pro, stabil vor Vorschau vor Alias,
neuere Version zuerst) und probt das beste; geht es nicht (gibt es nicht,
nicht kostenlos, Tageslimit), das nächste. Gespeichert werden das Modell,
das antwortete, und die Liste.

**Die Google-Suche gibt es auf der kostenlosen Stufe nicht** (Preise:
„Grounding with Google Search … Not available“ für 3.8 und 3.7 Flash, die
übrigen 3.x nur in AI Studio; 2.5 hatte 500 je Tag). Das war der
wahrscheinliche Grund für „gar nichts“: Jede Chat-Anfrage trug
`googleSearch`, der Probeaufruf nicht. Wie Google die Suche ablehnt, steht
nirgends. Deshalb: Lehnt Google eine Anfrage **mit** Suche ab (400, 403,
429 — auch ein Limit, denn ob Suche oder Modell, zeigt erst der Versuch),
geht dieselbe Anfrage einmal **ohne**; klappt das, sagt der Chat „Ohne
Internetsuche: …“, und der Dienst merkt sich je Schlüssel und Modell, dass
es die Suche dort nicht gibt (`ohneSuche` im Tresor). Klappt es auch ohne
nicht, gilt der erste Fehler.

**Denken.** `generationConfig.thinkingConfig = {includeThoughts,
thinkingLevel}` für Gemini 3 und neuer (3.8/3.7 Flash: low, medium, high —
`minimal` ist dort ein Fehler; 3.6/3.5 Flash und 3.5 Flash-Lite auch
`minimal`); `thinkingBudget` nur für 2.5; **beides zusammen ist 400**, und
`thinkingLevel` an ein älteres Modell auch. Die Denk-Token zählen zu
`maxOutputTokens`. Neural OS baut die Denk-Einstellung je Modell
(`denkenFuer`); weicht der Dienst auf ein anderes Modell aus, passt `senden`
sie an (`fuerModell`). Der Probeaufruf schickt keine.

**Selbstheilung** einer abgelehnten Anfrage (je Art höchstens einmal, nur
was Googles Satz nennt): ohne Suche; Denken ohne Stufe, dann ganz ohne;
Antwortlänge 8 192; ohne angefangenen Zug der KI am Ende („Requests ending
with a model turn are not supported“, 3.8); ohne eigene Werkzeuge, wenn
Google ihre Beschreibung nicht nimmt (mit Satz). Was Google sagt, steht bei
allem Unbekannten im Fehlersatz („Google: …“), der Schlüssel nie.

**Ausweichen** (Nutzer: „falls bei einem das Limit leer geht, wechselt er
zum nächsten“): Tageslimit (QuotaFailure `…PerDay…`, Rücksetzen um
Mitternacht kalifornischer Zeit), Minutenlimit (RetryInfo `retryDelay`),
überlastet, Modell fehlt oder nicht kostenlos → das nächste Modell
desselben Schlüssels, dann der nächste Schlüssel, dann der nächste
verbundene Anbieter (`ki.sendenAusweichend`) — immer mit einem Satz im
Chat, wer jetzt antwortet, und nur, solange noch nichts angekommen ist.

**Bedingungen (ehrlich).** Google-API-Bedingungen §2(d): Limits darf man
nicht umgehen („will not attempt to circumvent“); Limits gelten **je
Projekt, nicht je Schlüssel** — mehrere Schlüssel eines Projekts teilen
sie, mehrere Projekte oder Konten nur fürs Limit wären Umgehen. Neural OS
kann mehrere Schlüssel (etwa ein bezahlter als Ersatz), sagt das aber so.
Die Gemini-API-Bedingungen sehen die Nutzung ab 18 Jahren vor und, für
Programme, die man **anderen** im EWR anbietet, nur die bezahlte Stufe.

**Kostenlose Stufe, ohne Karte.** Schlüssel in AI Studio (legt Projekt und
Schlüssel selbst an); Limits je Modell stehen nur in AI Studio. Auf der
kostenlosen Stufe **darf Google Inhalte zur Verbesserung nutzen** — das
steht in der Oberfläche in einem Satz. Über dem Limit antwortet die API mit
429 `RESOURCE_EXHAUSTED`. Bilder erzeugen gibt es kostenlos nicht mehr
(alle Bildmodelle: „Not available“ auf der kostenlosen Stufe).

**Schlüssel:** aistudio.google.com/apikey → "Create API key" (Google-Konto,
keine Karte). Er liegt versiegelt in `vault/gemini-schluessel.json` (eine
Liste von Zugängen; oben steht für ältere Fassungen der erste), verlässt
Neural OS nur als Kopf `x-goog-api-key` an
`generativelanguage.googleapis.com`.

**REST — bewusst `generateContent`, nicht die neue "Interactions API"
(`/v1beta/interactions`), die Google inzwischen bewirbt:** `generateContent`
ist weiter dokumentiert, stabil und nicht abgekündigt.

```
POST https://generativelanguage.googleapis.com/v1beta/models/{modell}:streamGenerateContent?alt=sse
x-goog-api-key: <Schlüssel>
content-type: application/json

{ "systemInstruction": { "parts": [{ "text": "…" }] },
  "contents": [{ "role": "user"|"model", "parts": [ {"text"} | {"functionCall":{"name","args"}}
                 | {"functionResponse":{"name","response":{…}}} | {"text","thought":true} ] }],
  "tools": [{ "functionDeclarations": [{ "name", "description", "parameters": <OpenAPI-Teilmenge> }] },
            { "googleSearch": {} }],
  "toolConfig": { "functionCallingConfig": { "mode": "AUTO" } },
  "generationConfig": { "maxOutputTokens", "thinkingConfig": { "includeThoughts": true,
                        "thinkingLevel": "low"|"medium"|"high" (Gemini 3.x) bzw. "thinkingBudget" (2.5) } } }
```

Antwort als SSE: Zeilen `data: {candidates:[{content:{role:'model',parts:[…]},
finishReason:'STOP'|'MAX_TOKENS'|'SAFETY'|…, groundingMetadata:{webSearchQueries,
groundingChunks:[{web:{uri,title}}], groundingSupports, searchEntryPoint}}],
usageMetadata:{promptTokenCount, candidatesTokenCount, thoughtsTokenCount,
totalTokenCount, cachedContentTokenCount}, promptFeedback:{blockReason}}`.

**Übersetzung** (damit `src/models/chat.js` für beide Anbieter derselbe
bleibt): text ↔ text, thinking ↔ thought-Teile, tool_use ↔ functionCall
(id vergibt Neural OS), tool_result ↔ functionResponse (alle Ergebnisse eines
Zuges in EINEM user-Content), Websuche = `googleSearch` statt
web_search/web_fetch; groundingChunks → Ereignis `quelle`, webSearchQueries →
Recherche-Karte "Sucht: …". Werkzeugschemata aus `werkzeuge.js` verlieren
`strict`, `eager_input_streaming` und `additionalProperties`; `anyOf` mit
`null` wird `nullable`; ein Ganzzahl-`enum` wird zu `integer` mit den Werten
in der Beschreibung. Die strenge Prüfung bleibt `eingabePruefen()`.

**Signaturen.** Gemini 3 hängt an functionCall-Teile (und an den letzten
Teil einer Antwort) eine `thoughtSignature`. Beim Zurückschicken der
Modellantwort gehen **alle Teile mit ihren Signaturen unverändert** zurück,
sonst 400. Neural OS trägt sie am Block unter `block.gemini.thoughtSignature`;
der Claude-Anbieter lässt genau das beim Anbieterwechsel weg.

**Suche und Werkzeuge zugleich.** Gemini-3-Modelle nehmen `googleSearch` und
eigene `functionDeclarations` zusammen. Lehnt die API das für ein Modell mit
400 ab, geht dieselbe Anfrage ohne `googleSearch` noch einmal — und der Chat
sagt ehrlich "Ohne Internetsuche".

**Fehler** (`{error:{code,message,status}}`), als deutsche Sätze:

| HTTP / status | Code | Satz |
|---|---|---|
| 400/401/403 mit "API key", `UNAUTHENTICATED` | `GEMINI_SCHLUESSEL_FALSCH` | "Der Google-Schlüssel stimmt nicht." |
| 429 `RESOURCE_EXHAUSTED` | `GEMINI_LIMIT` | "Google-Limit erreicht — … morgen geht es kostenlos weiter. Oder Claude wählen." |
| 503 `UNAVAILABLE` | `GEMINI_UEBERLASTET` | "Gemini ist gerade überlastet." |
| 404 `NOT_FOUND` | `GEMINI_MODELL_UNBEKANNT` | "Dieses Modell gibt es bei Google nicht (mehr)." → nächstes Modell |
| 429 mit `limit: 0` | `GEMINI_NICHT_KOSTENLOS` | "Dieses Gemini-Modell ist bei Google nicht kostenlos." → nächstes Modell |
| 429 QuotaFailure `…PerDay…` | `GEMINI_LIMIT_TAG` | "Google-Tageslimit für dieses Modell erreicht …" → nächstes Modell |
| 403 `SERVICE_DISABLED` | `GEMINI_API_AUS` | "Für diesen Google-Schlüssel ist die Gemini-API nicht eingeschaltet …" |
| "User location is not supported" | `GEMINI_ORT` | "Google bietet die Gemini-API an deinem Ort nicht an …" |
| 413 / Token-Grenze | `GEMINI_ZU_GROSS` | "Das Gespräch ist zu lang für eine einzelne Anfrage." |
| `finishReason: SAFETY`, `promptFeedback.blockReason` | `GEMINI_ABGELEHNT` | "Google hat die Antwort abgelehnt." |
| anderes 400 `INVALID_ARGUMENT` | `GEMINI_ANFRAGE_ABGELEHNT` | "Google hat die Anfrage nicht angenommen." |

**Verbrauch:** Tokens werden gezählt (`vault/gemini-verbrauch.json`), Kosten
sind auf der kostenlosen Stufe 0 — die Oberfläche sagt "kostenlos" und nennt
das Google-Limit. **Anbieterwahl:** `config.ki.anbieter` (`gemini` | `claude`);
nach dem ersten erfolgreichen Verbinden ist der verbundene Anbieter die
Einstellung, sind beide verbunden, gilt die Einstellung. Routen: `GET /api/ki`,
`POST/DELETE /api/ki/:anbieter/schluessel`, `PATCH /api/ki {anbieter, modell}`;
`/api/claude` bleibt als Alias. Geprüft gegen den Statisten
`test/gemini-statist.js` (`test/gemini.test.js`, `npm run check` Abschnitt 6b)
— **nicht** gegen die echte Google-API: einen echten Schlüssel gab es beim Bau nicht. Gegen das echte Google geprüft ist nur, was ohne Schlüssel geht: Ein falscher Schlüssel kommt als 400 `INVALID_ARGUMENT` mit ErrorInfo `API_KEY_INVALID` (und das schon bei der Modellliste, vor jeder Prüfung des Modells). Der Statist kann jetzt auch die Modellliste, Fehler mit Einzelheiten (QuotaFailure, RetryInfo) und die Ablehnung der Suche (`test/ausweichen.test.js`).
