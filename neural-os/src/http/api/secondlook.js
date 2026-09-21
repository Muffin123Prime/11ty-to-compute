'use strict';

/**
 * Der zweite Blick auf eine Notiz -- eine einzige Route.
 *
 * `POST /api/notes/:id/second-look`
 *
 * Ein POST, obwohl nichts geschrieben wird: der Aufruf lässt ein Sprachmodell
 * arbeiten, also kostet er Rechenzeit und darf nicht das sein, was ein
 * Vorausladen oder ein doppelt geöffneter Reiter nebenbei auslöst. Die
 * Berechtigung ist `chat` und nicht `read`, aus demselben Grund: wer nur lesen
 * darf, darf die Notiz lesen, aber kein Modell für sich rechnen lassen.
 *
 * Warum "kein Modell" hier **200** ist und nicht 503
 * -------------------------------------------------
 * 503 heißt: diese Anfrage konnte nicht beantwortet werden. Das stimmt hier
 * nicht. Der dritte Teil der Antwort -- welche Begriffe dieser Notiz schon
 * anderswo im Tresor vorkommen -- ist reine Indexarbeit und liegt fertig vor,
 * auch wenn nie ein Modell installiert wurde. Ihn wegzuwerfen, um einen
 * einheitlichen Fehlercode zu senden, wäre Ordnungsliebe auf Kosten des
 * Menschen davor.
 *
 * Damit daraus keine geschönte Antwort wird, trägt der 200er die Wahrheit
 * mit: `modell.verfuegbar` ist `false`, `kern` ist `null`, `offeneStellen` ist
 * leer und `hinweis` sagt in einem deutschen Satz, was fehlt und warum. Die
 * Oberfläche zeigt das -- ein Ergebnis ohne diese Felder auszuwerten wäre ein
 * Fehler im Aufrufer, kein unklares Versprechen dieser Route.
 *
 * Ein 503 bleibt für den Fall, für den er gedacht ist: das Teilsystem ist in
 * dieser Instanz gar nicht eingebaut, dann liegt auch der Indexteil nicht vor.
 * Ein Modell, das geantwortet hat und dessen Antwort nicht lesbar war, ist ein
 * 502 aus dem typisierten ModelError -- gescheitert ist gescheitert, daraus
 * wird hier keine Zusammenfassung erfunden.
 */

const { ValidationError } = require('../../kernel/errors');
const {
  need,
  needMethod,
  asObject,
  requireStringArray,
  mustGet,
} = require('./support');

/** Arten, in denen nach bekannten Begriffen gesucht werden darf. */
const { SEARCH_TYPES } = require('../../agents/secondlook');

/**
 * Abbruch, wenn der Aufrufer weg ist.
 *
 * Der Zuhörer sitzt auf der ANTWORT, nicht auf der Anfrage -- die Begründung
 * steht ausführlich in api/sync.js: eine `IncomingMessage` meldet 'close',
 * sobald ihr Körper gelesen ist, und das ist lange bevor das Modell fertig
 * ist. Ein geschlossener Reiter soll kein lokales Modell weiterrechnen lassen.
 */
function requestSignal(rc) {
  const controller = new AbortController();
  let settled = false;
  const onClose = () => {
    if (!settled) controller.abort();
  };
  rc.res.on('close', onClose);
  return {
    signal: controller.signal,
    done() {
      settled = true;
      rc.res.off('close', onClose);
    },
  };
}

function register(router) {
  router.post('/api/notes/:id/second-look', async (rc) => {
    rc.requireCapability('chat');
    const store = need(rc.ctx.store, 'Der Speicher');
    const secondLook = needMethod(
      rc.ctx.secondLook,
      'look',
      'Der zweite Blick',
      'Ohne ihn lässt sich zu einer Notiz weder etwas sagen noch etwas nachschlagen.',
    );
    // 404 für eine Notiz, die es nicht gibt, bevor irgendetwas rechnet.
    const note = mustGet(store, rc.params.id, 'note');

    const body = asObject(await rc.body());
    const types = body.types === undefined || body.types === null
      ? undefined
      : requireStringArray(body.types, 'types', { maxItems: 12, max: 40 });
    if (types) {
      // Eine leere Liste stillschweigend als "dann eben alle" zu lesen wäre
      // die kleine Sorte Unwahrheit, an der man später lange sucht.
      if (!types.length) throw new ValidationError('"types" darf keine leere Liste sein.');
      for (const type of types) {
        if (!SEARCH_TYPES.includes(type)) {
          throw new ValidationError(
            `In Einträgen der Art "${type}" wird nicht nach Begriffen gesucht. Möglich: ${SEARCH_TYPES.join(', ')}.`,
          );
        }
      }
    }

    const wanted = requestSignal(rc);
    try {
      // Weder der Geltungsbereich noch das Modell kommen vom Aufrufer.
      // Der Geltungsbereich nicht, weil sich ein Aufruf sonst unter einen
      // fremden Namen stellen könnte, für den eine Netzfreigabe existiert --
      // das wäre eine Tür an der Schleuse vorbei. Das Modell nicht, weil der
      // einzige Grund, hier eines zu wählen, ein entferntes wäre; wer das
      // will, stellt es dort ein, wo es sichtbar ist (Einstellungen → Modelle).
      return await secondLook.look(note.id, { signal: wanted.signal, types });
    } finally {
      wanted.done();
    }
  });
}

module.exports = { register };
