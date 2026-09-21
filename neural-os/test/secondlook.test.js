'use strict';

/**
 * Prüfungen für den zweiten Blick (src/agents/secondlook.js und die Route).
 *
 * Zwei Regeln gelten in jeder Prüfung hier:
 *   - kein Test fasst das echte Zuhause an (immer `tempHome`);
 *   - kein Test geht ins Netz.
 *
 * **Was hier nicht geprüft ist, und auch nicht geprüft werden kann:** in
 * dieser Umgebung ist kein Sprachmodell installiert. Alles, was ein Modell
 * bräuchte, läuft gegen eine handgeschriebene Registry-Attrappe. Was diese
 * Attrappe beweisen kann, ist genau das, was an den ersten beiden Teilen der
 * Antwort strukturell ist: dass eine unsaubere Antwort zu einem ehrlichen
 * Fehler wird, dass eine in Prosa eingewickelte Antwort trotzdem ausgepackt
 * wird, und dass der Aufruf den Geltungsbereich mitgibt, unter dem ihn die
 * Schleuse beurteilt. Sie beweist NICHT, dass ein echtes Modell brauchbare
 * Kernaussagen schreibt -- das kann hier niemand prüfen, und es wird deshalb
 * auch nicht behauptet.
 *
 * Der wichtigste Test in dieser Datei braucht ohnehin kein Modell: die
 * bekannten Begriffe kommen aus dem echten Volltextindex eines echten
 * Speichers, und sie müssen ohne jede Registry vollständig da sein.
 *
 * Die Schleuse ist überall die echte, mit der echten Voreinstellung
 * ('offline'). Die entfernte Adresse ist 203.0.113.5 -- RFC 5737 TEST-NET-3,
 * im öffentlichen Internet nie geroutet, damit aus einem Test unmöglich eine
 * echte Verbindung werden kann.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');

const { test, drain, tempHome } = require('./harness');

const { openStore } = require('../src/store/engine');
const configMod = require('../src/kernel/config');
const pathsMod = require('../src/kernel/paths');
const { Bus } = require('../src/kernel/bus');
const { Audit } = require('../src/kernel/log');
const { createGate } = require('../src/net/gate');
const {
  createSecondLook, MIN_TEXT_CHARS, MAX_MODEL_CHARS, MAX_COUNT_PROBE, __internals,
} = require('../src/agents/secondlook');
const secondLookApi = require('../src/http/api/secondlook');
const { NoModelError } = require('../src/kernel/errors');

/** Tests dürfen nicht über die Ausgabe des Läufers schreiben. */
const SILENT = { error() {}, warn() {}, info() {}, debug() {} };
const silentLogger = () => SILENT;

/** Die Graph-Einheit, so wie die Anwendung sie zusammensetzt. */
const GRAPH = { ...require('../src/graph/derive'), ...require('../src/graph/view') };

/** Ein lokales Modell der Attrappe. Es wird nie wirklich angesprochen. */
const LOKAL = { providerId: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'lokalmodell' };
/** Und eines, das nicht auf diesem Gerät läuft. Reservierte Adresse. */
const FERN = { providerId: 'fern', kind: 'openai', baseUrl: 'https://203.0.113.5/v1', model: 'fernmodell' };

/* ------------------------------------------------------------- Material */

const KAFFEE_TITEL = 'Espresso: was noch offen ist';
const KAFFEE = [
  'Die Brühtemperatur liegt bei 94 Grad, gemessen am Kessel und nicht am Auslauf.',
  'Der Mahlgrad steht auf Stufe zwölf, für den Siebträger ist das eher zu grob.',
  'Bei 18 Gramm Kaffee im Sieb laufen in 27 Sekunden etwa 36 Gramm heraus.',
  'Das Wasser hat eine Härte von 8 Grad deutscher Härte, gemessen habe ich das allerdings nie selbst.',
  'Offen ist, ob der Tamper wirklich 20 Kilo braucht oder ob die Verteilung schon reicht.',
  'Der Siebträger wird vorgewärmt, die Tasse bisher nicht, und ob das etwas ändert, weiß ich nicht.',
  'Nächste Woche will ich den Mahlgrad einen Schritt feiner stellen und dieselbe Messung wiederholen.',
].join(' ');

const WASSER_TITEL = 'Wasser und Entkalkung';
const WASSER = [
  'Die Bruehtemperatur faellt um zwei Grad, sobald der Kessel verkalkt ist.',
  'Deshalb wird alle sechs Wochen entkalkt, mit Zitronensaeure und zwei Durchlaeufen.',
  'Der Mahlgrad bleibt dabei unveraendert, das ist eine andere Baustelle.',
  'Die Haerte des Wassers liegt hier bei acht Grad, der Filter nimmt davon etwa die Haelfte weg.',
].join(' ');

const IMKER_TITEL = 'Imkerei im Frühjahr';
const IMKER = [
  'Der Imker prüft im Frühjahr jeden Stock auf Futter und Königin.',
  'Danach wird der Boden gereinigt, das Volk umgesetzt und der Honigraum aufgelegt.',
  'Wichtig ist, dass die Waben nicht zu kalt stehen und das Flugloch offen bleibt.',
].join(' ');

/* --------------------------------------------------------------- Aufbau */

/**
 * Eine Registry-Attrappe.
 *
 * `chatImpl(options)` bekommt genau das, was die echte Registry einem Anbieter
 * reicht -- inklusive `scope`. Damit kann ein Test dort die echte Schleuse
 * fragen, wo ein echter Anbieter sie fragen würde.
 */
function fakeRegistry(target, chatImpl) {
  return {
    calls: [],
    resolve(ref) {
      if (!target) throw new NoModelError('Es ist kein Modell eingerichtet (Attrappe).');
      if (ref && typeof ref === 'object' && ref.provider && ref.provider !== target.providerId) {
        throw new NoModelError(`Kein Anbieter "${ref.provider}" (Attrappe).`);
      }
      return { ...target };
    },
    installHint() {
      return 'Anleitung der Attrappe: ein Modell installieren.';
    },
    async chat(ref, options) {
      this.calls.push({ ref, options });
      return chatImpl(options, this.resolve(ref));
    },
  };
}

/**
 * Echter Speicher, echte Schleuse, echter Bus -- alles außer dem Modell.
 * @param {string} label
 * @param {(env:object)=>any} fn
 * @param {{registry?:object|null}} [opts]
 */
async function withVault(label, fn, opts = {}) {
  const { home, cleanup } = tempHome(label);
  const bus = new Bus();
  const store = await openStore({ paths: home, bus, lock: false, logger: silentLogger });
  const config = configMod.defaults();
  const audit = new Audit(`${home}/audit.jsonl`).open();
  const gate = createGate({ config, bus, audit, store, logger: silentLogger });
  const registry = opts.registry === undefined ? null : opts.registry;
  const secondLook = createSecondLook({
    store, registry, graph: GRAPH, gate, bus, config, logger: silentLogger,
  });
  const attempts = [];
  bus.on('network.attempt', (evt) => attempts.push(evt.payload));
  try {
    await fn({ store, gate, bus, config, secondLook, registry, attempts, home });
  } finally {
    await store.close().catch(() => {});
    try { audit.close(); } catch { /* schon zu */ }
    cleanup();
  }
}

/** Die drei Notizen, die in den meisten Prüfungen gebraucht werden. */
function seed(store) {
  const kaffee = store.create('note', { title: KAFFEE_TITEL, body: KAFFEE, tags: ['küche'] });
  const wasser = store.create('note', { title: WASSER_TITEL, body: WASSER, tags: ['küche'] });
  const imker = store.create('note', { title: IMKER_TITEL, body: IMKER, tags: ['garten'] });
  return { kaffee, wasser, imker };
}

function begriff(result, wort) {
  return result.bekannteBegriffe.find((b) => b.form === wort.toLowerCase()
    || b.begriff.toLowerCase() === wort.toLowerCase());
}

/* ------------------------------------------ 1. ohne Modell: die Begriffe */

test('ohne jedes Modell kommen die bekannten Begriffe trotzdem -- und zwar echte', async () => {
  await withVault('nos-sl-nomodel', async ({ store, secondLook }) => {
    const { kaffee, wasser } = seed(store);

    const result = await secondLook.look(kaffee.id);

    // Der Teil, der kein Modell braucht, ist vollständig da.
    assert.ok(result.bekannteBegriffe.length > 0, 'ohne Modell kamen gar keine Begriffe');
    const mahlgrad = begriff(result, 'mahlgrad');
    assert.ok(mahlgrad, `"Mahlgrad" fehlt; gefunden: ${result.bekannteBegriffe.map((b) => b.begriff).join(', ')}`);
    assert.ok(mahlgrad.treffer.some((t) => t.id === wasser.id), 'der Treffer zeigt nicht auf die andere Notiz');
    assert.equal(mahlgrad.treffer.every((t) => t.id !== kaffee.id), true, 'die Notiz selbst ist kein Fundort');

    // Die beiden anderen Teile sind ehrlich leer, nicht erfunden.
    assert.equal(result.kern, null);
    assert.deepEqual(result.offeneStellen, []);
    assert.equal(result.modell.verfuegbar, false);
    assert.equal(result.model, null);
    assert.match(result.hinweis, /Sprachmodell/);
    assert.match(result.hinweis, /Volltextindex/);
    assert.equal(result.usedNetwork, false);
    assert.equal(typeof result.ms, 'number');
  });
});

test('ein Begriff, den es nur in dieser Notiz gibt, ist kein bekannter Begriff', async () => {
  await withVault('nos-sl-nofalse', async ({ store, secondLook }) => {
    const { kaffee } = seed(store);
    const result = await secondLook.look(kaffee.id);
    // "Tamper" steht nur in der Kaffeenotiz.
    assert.equal(begriff(result, 'tamper'), undefined,
      'ein Wort, das nur hier vorkommt, darf nicht als "schon bekannt" gelten');
    // Und die Imkernotiz teilt kein Fachwort mit dieser hier.
    for (const b of result.bekannteBegriffe) {
      for (const t of b.treffer) {
        assert.notEqual(t.titel, IMKER_TITEL, `"${b.begriff}" soll nicht auf die Imkernotiz zeigen`);
      }
    }
  });
});

/**
 * Der Grund für die Wortartenregel, als Prüfung.
 *
 * "offen" steht in der Kaffeenotiz ("Offen ist, ob …") und in der Imkernotiz
 * ("das Flugloch offen bleibt"). Ohne die Regel verbindet dieser eine
 * Adjektivtreffer zwei Notizen, die nichts miteinander zu tun haben -- und die
 * Liste, die sich "belegbar" nennt, wird zu Lärm.
 */
test('Adjektive und Verben werden nicht zu Begriffen, auch wenn sie geteilt sind', async () => {
  await withVault('nos-sl-wortart', async ({ store, secondLook }) => {
    const { kaffee } = seed(store);
    const result = await secondLook.look(kaffee.id);
    for (const wort of ['offen', 'gemessen', 'wirklich', 'nicht']) {
      assert.equal(begriff(result, wort), undefined, `"${wort}" ist kein Begriff, sondern ein Füllwort`);
    }
    // Aber die Substantive sind da.
    assert.ok(begriff(result, 'mahlgrad'), 'ein echtes Substantiv fehlt');
  });
});

test('jeder gemeldete Treffer ist im Zieltext wirklich nachweisbar', async () => {
  await withVault('nos-sl-belegbar', async ({ store, secondLook }) => {
    const { kaffee } = seed(store);
    const result = await secondLook.look(kaffee.id);
    assert.ok(result.bekannteBegriffe.length > 0);
    for (const b of result.bekannteBegriffe) {
      for (const t of b.treffer) {
        const record = store.get(t.id);
        assert.ok(record, `Treffer ${t.id} gibt es nicht mehr`);
        const text = `${record.data.title || ''}\n${record.data.body || ''}\n${(record.data.tags || []).join(' ')}`;
        assert.ok(text.includes(t.wortform),
          `die gemeldete Wortform "${t.wortform}" steht nicht in "${t.titel}"`);
      }
    }
  });
});

/* ------------------------------------------------ 2. die deutsche Faltung */

test('Umlaut und Umschrift sind derselbe Begriff (Brühtemperatur = Bruehtemperatur)', async () => {
  await withVault('nos-sl-fold', async ({ store, secondLook }) => {
    const { kaffee, wasser } = seed(store);
    const result = await secondLook.look(kaffee.id);

    const bruehe = begriff(result, 'bruehtemperatur');
    assert.ok(bruehe, `"Brühtemperatur" wurde nicht als bekannter Begriff erkannt; gefunden: ${result.bekannteBegriffe.map((b) => b.form).join(', ')}`);
    assert.equal(bruehe.begriff, 'Brühtemperatur', 'die eigene Schreibweise der Notiz soll erhalten bleiben');
    const treffer = bruehe.treffer.find((t) => t.id === wasser.id);
    assert.ok(treffer, 'die Notiz mit der Umschrift wurde nicht gefunden');
    assert.equal(treffer.wortform, 'Bruehtemperatur',
      'der Fundort soll seine eigene Schreibweise zeigen, nicht die der Anfrage');
  });
});

test('die Faltung greift auch umgekehrt, von der Umschrift zum Umlaut', async () => {
  await withVault('nos-sl-fold-rueck', async ({ store, secondLook }) => {
    const { kaffee, wasser } = seed(store);
    // Die Wassernotiz ist für sich zu kurz; sie bekommt Text, damit die
    // Schwelle nicht den eigentlichen Punkt dieses Tests verdeckt.
    store.update(wasser.id, { body: `${WASSER} ${WASSER}` });
    const result = await secondLook.look(wasser.id);
    const bruehe = begriff(result, 'bruehtemperatur');
    assert.ok(bruehe, 'von der Umschrift aus wurde der Umlaut nicht gefunden');
    assert.ok(bruehe.treffer.some((t) => t.id === kaffee.id));
  });
});

/* ---------------------------------------- 3. unsaubere Modellantworten */

test('Prosa um das JSON herum wird ausgepackt, nicht verworfen', async () => {
  const registry = fakeRegistry(LOKAL, async () => ({
    content: 'Gerne! Hier ist meine Antwort:\n\n```json\n'
      + '{"kern": "Die Notiz hält Einstellungen für den Espresso fest.", '
      + '"offeneStellen": ["Ob der Tamper 20 Kilo braucht, ist offen."]}\n```\n'
      + 'Ich hoffe, das hilft. {Noch eine Klammer zum Schluss}',
    stats: {},
  }));
  await withVault('nos-sl-prosa', async ({ store, secondLook }) => {
    const { kaffee } = seed(store);
    const result = await secondLook.look(kaffee.id);
    assert.equal(result.kern, 'Die Notiz hält Einstellungen für den Espresso fest.');
    assert.deepEqual(result.offeneStellen, ['Ob der Tamper 20 Kilo braucht, ist offen.']);
    assert.equal(result.modell.verfuegbar, true);
    assert.deepEqual(result.model, { provider: 'ollama', model: 'lokalmodell' });
    // Auch der dritte Teil ist da -- er hängt nicht am Modell.
    assert.ok(result.bekannteBegriffe.length > 0);
  }, { registry });
});

test('eine Antwort ganz ohne JSON wird zum ehrlichen Fehler, nicht zur Zusammenfassung', async () => {
  const registry = fakeRegistry(LOKAL, async () => ({
    content: 'Zusammenfassend lässt sich sagen, dass es in dieser Notiz um Kaffee geht.',
    stats: {},
  }));
  await withVault('nos-sl-prosa-only', async ({ store, secondLook }) => {
    const { kaffee } = seed(store);
    await assert.rejects(
      () => secondLook.look(kaffee.id),
      (err) => {
        assert.equal(err.code, 'MODEL_ERROR');
        assert.equal(err.status, 502);
        assert.match(err.message, /erfunden|JSON/);
        // Der Satz des Modells darf höchstens als Beleg im Detail stehen --
        // niemals als Ergebnis.
        assert.equal(err.kern, undefined);
        return true;
      },
    );
  }, { registry });
});

test('fehlen die offenen Stellen, wird daraus keine leere Liste gemacht', async () => {
  const registry = fakeRegistry(LOKAL, async () => ({
    content: '{"kern": "Es geht um Espresso."}',
    stats: {},
  }));
  await withVault('nos-sl-nofield', async ({ store, secondLook }) => {
    const { kaffee } = seed(store);
    await assert.rejects(
      () => secondLook.look(kaffee.id),
      (err) => {
        assert.equal(err.code, 'MODEL_ERROR');
        assert.match(err.message, /offenen Stellen/);
        return true;
      },
    );
  }, { registry });
});

test('ein leerer Kern ist keine Kernaussage', async () => {
  const registry = fakeRegistry(LOKAL, async () => ({
    content: '{"kern": "   ", "offeneStellen": []}',
    stats: {},
  }));
  await withVault('nos-sl-leer', async ({ store, secondLook }) => {
    const { kaffee } = seed(store);
    await assert.rejects(() => secondLook.look(kaffee.id), /Kernaussage/);
  }, { registry });
});

test('eine leere Liste offener Stellen ist eine gültige Antwort', async () => {
  const registry = fakeRegistry(LOKAL, async () => ({
    content: '{"kern": "Espresso-Einstellungen.", "offeneStellen": []}',
    stats: {},
  }));
  await withVault('nos-sl-keine-offen', async ({ store, secondLook }) => {
    const { kaffee } = seed(store);
    const result = await secondLook.look(kaffee.id);
    assert.equal(result.kern, 'Espresso-Einstellungen.');
    assert.deepEqual(result.offeneStellen, []);
  }, { registry });
});

test('das Auspacken hält auch balancierte Klammern und Fließtext aus', () => {
  const { carveJson } = __internals;
  assert.equal(carveJson('{"a": 1}'), '{"a": 1}');
  assert.equal(carveJson('davor {"a": {"b": 2}} danach'), '{"a": {"b": 2}}');
  assert.equal(carveJson('{"a": "eine } in der Zeichenkette"}'), '{"a": "eine } in der Zeichenkette"}');
  assert.equal(carveJson('{"a": "ein \\" Anführungszeichen"}'), '{"a": "ein \\" Anführungszeichen"}');
  assert.equal(carveJson('gar kein Objekt'), null);
  assert.equal(carveJson('{"offen": 1'), null, 'ein unvollständiges Objekt wird nicht zurechtgebogen');
});

/* --------------------------------------------- 4. von sich aus kein Netz */

test('der Aufruf geht von sich aus nicht ins Netz', async () => {
  let gesehen = null;
  const registry = fakeRegistry(FERN, async (options) => {
    gesehen = options.scope;
    // Genau das, was ein echter Anbieter tut, bevor er eine Verbindung
    // aufbaut: die Schleuse fragen, unter dem Bereich, den er bekommen hat.
    // Die echte Schleuse, die echte Voreinstellung.
    gate.enforce({ host: '203.0.113.5', port: 443, scope: options.scope, purpose: 'test.zweiter-blick' });
    return { content: '{"kern": "…", "offeneStellen": []}', stats: {} };
  });
  let gate = null;

  await withVault('nos-sl-kein-netz', async ({ store, secondLook, gate: realGate, attempts }) => {
    gate = realGate;
    const { kaffee } = seed(store);

    await assert.rejects(
      () => secondLook.look(kaffee.id),
      (err) => {
        assert.equal(err.code, 'NETWORK_BLOCKED');
        return true;
      },
    );

    assert.equal(gesehen, `secondlook:${kaffee.id}`,
      'der Aufruf muss unter seinem eigenen Bereich laufen, nicht unter "global"');
    assert.ok(attempts.some((a) => a.scope === gesehen && a.allowed === false),
      'die Schleuse hat die Ablehnung nicht protokolliert');
    // Und er hat sich keine Freigabe geschrieben.
    assert.equal(store.all('grant').length, 0, 'der zweite Blick hat sich selbst eine Freigabe angelegt');
  }, { registry });
});

test('ein lokales Modell ist keine Netznutzung', async () => {
  let gate = null;
  const registry = fakeRegistry(LOKAL, async (options) => {
    // Loopback: die Schleuse erlaubt das immer, und genau das darf nicht als
    // "war im Netz" gezählt werden.
    gate.enforce({ host: '127.0.0.1', port: 11434, scope: options.scope, purpose: 'test.lokal' });
    return { content: '{"kern": "Espresso.", "offeneStellen": []}', stats: {} };
  });

  await withVault('nos-sl-lokal', async ({ store, secondLook, gate: realGate }) => {
    gate = realGate;
    const { kaffee } = seed(store);
    const result = await secondLook.look(kaffee.id);
    assert.equal(result.usedNetwork, false, 'Loopback wurde als Netznutzung gezählt');
    assert.deepEqual(result.netzZiele, ['127.0.0.1:11434'], 'das Ziel gehört trotzdem ins Protokoll');
    assert.equal(result.netzBeobachtet, true, 'mit Bus ist die Aussage gedeckt');
  }, { registry });
});

/**
 * Der Fall, für den es dieses Feld gibt.
 *
 * Ein fernes Modell, eine Freigabe für genau diesen Geltungsbereich, und die
 * echte Schleuse lässt die Verbindung durch. Was dabei herauskommt, muss die
 * Antwort tragen -- sonst hat der Mensch davor keine Möglichkeit zu erfahren,
 * dass bis zu 12000 Zeichen seiner Notiz an einen fremden Rechner gegangen
 * sind. 203.0.113.5 ist reserviert: hier wird nie wirklich verbunden.
 */
test('was das Gerät verlassen hat, steht in der Antwort -- mit Ziel', async () => {
  let gate = null;
  const registry = fakeRegistry(FERN, async (options) => {
    gate.enforce({ host: '203.0.113.5', port: 443, scope: options.scope, purpose: 'test.zweiter-blick' });
    return { content: '{"kern": "Espresso.", "offeneStellen": []}', stats: {} };
  });

  await withVault('nos-sl-fern', async ({ store, secondLook, gate: realGate }) => {
    gate = realGate;
    const { kaffee } = seed(store);
    gate.addGrant({ scope: `secondlook:${kaffee.id}`, level: 'lan', hosts: ['203.0.113.5'], reason: 'Test' });

    const result = await secondLook.look(kaffee.id);

    assert.equal(result.usedNetwork, true, 'die Notiz ist an einen anderen Rechner gegangen');
    assert.deepEqual(result.netzZiele, ['203.0.113.5:443']);
    assert.equal(result.netzBeobachtet, true);
    // Und wie viel von der Notiz das war -- "etwas ging raus" ohne Menge ist
    // die halbe Auskunft.
    assert.equal(result.gesendeteZeichen, result.zeichen,
      'die ganze Notiz passte ins Fenster, also ging sie ganz hinaus');
  }, { registry });
});

test('bei einer gekürzten Notiz zählt, was wirklich hinausgegangen ist', async () => {
  const registry = fakeRegistry(LOKAL, async () => ({ content: '{"kern": "Lang.", "offeneStellen": []}', stats: {} }));
  await withVault('nos-sl-menge', async ({ store, secondLook }) => {
    const lang = store.create('note', {
      title: 'Sehr lange Notiz',
      body: `${KAFFEE} `.repeat(40),
    });
    const result = await secondLook.look(lang.id);
    assert.ok(result.zeichen > MAX_MODEL_CHARS, 'der Test braucht eine Notiz über dem Fenster');
    assert.equal(result.gekuerzt, true);
    assert.equal(result.gesendeteZeichen, MAX_MODEL_CHARS,
      'gegangen ist genau das Fenster, nicht die ganze Notiz');
  }, { registry });
});

test('ohne Modell ist die gesendete Menge null und keine Null', async () => {
  await withVault('nos-sl-menge-null', async ({ store, secondLook }) => {
    const { kaffee } = seed(store);
    const result = await secondLook.look(kaffee.id);
    assert.equal(result.gesendeteZeichen, null, '"nichts gefragt" ist keine gemessene Null');
  });
});

/**
 * "Nicht beobachtet" ist nicht "nicht passiert".
 *
 * Ohne Bus kann diese Einheit nichts von der Schleuse mitbekommen. Dann darf
 * die Antwort kein schlichtes `usedNetwork: false` tragen, ohne daneben zu
 * sagen, dass niemand hingesehen hat -- genau wie in src/models/compare.js.
 */
test('ohne Bus wird "kein Netzverkehr" nicht behauptet, sondern zugegeben', async () => {
  const { home, cleanup } = tempHome('nos-sl-blind');
  const registry = fakeRegistry(LOKAL, async () => ({ content: '{"kern": "Espresso.", "offeneStellen": []}', stats: {} }));
  try {
    const store = await openStore({ paths: home, lock: false, logger: silentLogger });
    const secondLook = createSecondLook({
      store, registry, graph: GRAPH, gate: null, bus: null, config: configMod.defaults(), logger: silentLogger,
    });
    const { kaffee } = seed(store);

    const result = await secondLook.look(kaffee.id);

    assert.equal(result.netzBeobachtet, false, 'ohne Bus ist nichts beobachtbar');
    assert.equal(result.usedNetwork, false);
    assert.deepEqual(result.netzZiele, []);
    await store.close().catch(() => {});
  } finally {
    cleanup();
  }
});

test('ein eigener Geltungsbereich des Aufrufers wird durchgereicht', async () => {
  let gesehen = null;
  const registry = fakeRegistry(LOKAL, async (options) => {
    gesehen = options.scope;
    return { content: '{"kern": "Espresso.", "offeneStellen": []}', stats: {} };
  });
  await withVault('nos-sl-scope', async ({ store, secondLook }) => {
    const { kaffee } = seed(store);
    await secondLook.look(kaffee.id, { scope: 'run:r1' });
    assert.equal(gesehen, 'run:r1');
  }, { registry });
});

/* ------------------------------------------------- 5. Grenzen der Eingabe */

test('eine zu kurze Notiz wird abgewiesen, mit der Schwelle im Satz', async () => {
  await withVault('nos-sl-kurz', async ({ store, secondLook }) => {
    const kurz = store.create('note', { title: 'Milch', body: 'Milch holen.' });
    await assert.rejects(
      () => secondLook.look(kurz.id),
      (err) => {
        assert.equal(err.code, 'VALIDATION_FAILED');
        assert.equal(err.status, 400);
        assert.match(err.message, new RegExp(String(MIN_TEXT_CHARS)));
        assert.equal(err.details.noetig, MIN_TEXT_CHARS);
        return true;
      },
    );
  });
});

test('nur Notizen, und nur vorhandene', async () => {
  await withVault('nos-sl-typ', async ({ store, secondLook }) => {
    const projekt = store.create('project', { name: 'Küche', description: KAFFEE });
    await assert.rejects(() => secondLook.look(projekt.id), /nur auf Notizen/);
    await assert.rejects(() => secondLook.look('note_gibtsnicht0000000000'), /not found/);
    await assert.rejects(() => secondLook.look(''), /Kennung/);
  });
});

/* -------------------------------------------- 6. die Teile für sich allein */

test('terms() liefert denselben dritten Teil, ganz ohne Modell im Spiel', async () => {
  await withVault('nos-sl-terms', async ({ store, secondLook }) => {
    const { kaffee } = seed(store);
    const nur = secondLook.terms(kaffee.id);
    const ganz = await secondLook.look(kaffee.id);
    assert.deepEqual(nur.begriffe.map((b) => b.form), ganz.bekannteBegriffe.map((b) => b.form));
    assert.ok(nur.begriffe.length > 0);
    assert.equal(nur.nichtNachschlagbar, ganz.nichtNachschlagbar);
  });
});

test('status() sagt die Schwelle und ob ein Modell da ist', async () => {
  await withVault('nos-sl-status-ohne', async ({ secondLook }) => {
    const status = secondLook.status();
    assert.equal(status.minZeichen, MIN_TEXT_CHARS);
    assert.equal(status.modell.verfuegbar, false);
    assert.equal(status.modell.ort, null);
  });

  await withVault('nos-sl-status-mit', async ({ secondLook }) => {
    const status = secondLook.status();
    assert.equal(status.modell.verfuegbar, true);
    assert.equal(status.modell.ort, 'lokal', 'ein Modell auf 127.0.0.1 läuft auf diesem Gerät');
  }, { registry: fakeRegistry(LOKAL, async () => ({ content: '{}' })) });

  await withVault('nos-sl-status-fern', async ({ secondLook }) => {
    assert.equal(secondLook.status().modell.ort, 'fern');
  }, { registry: fakeRegistry(FERN, async () => ({ content: '{}' })) });
});

test('eine Registry ohne erreichbares Modell liefert den dritten Teil und sagt, was fehlt', async () => {
  await withVault('nos-sl-registry-leer', async ({ store, secondLook }) => {
    const { kaffee } = seed(store);
    const result = await secondLook.look(kaffee.id);
    assert.equal(result.kern, null);
    assert.equal(result.modell.verfuegbar, false);
    assert.match(result.modell.grund, /Attrappe/);
    assert.match(result.modell.anleitung, /Anleitung/);
    assert.ok(result.bekannteBegriffe.length > 0);
  }, { registry: fakeRegistry(null, async () => ({ content: '{}' })) });
});

/* ------------------------------------------------- 7. die Zahl der Fundorte */

/**
 * Material für die Zählung: derselbe Begriff in vielen Einträgen.
 * Jeder Text ist lang genug, dass der Index ihn ernst nimmt.
 */
function vieleMit(store, wort, anzahl, praefix) {
  for (let i = 0; i < anzahl; i++) {
    store.create('note', {
      title: `${praefix} ${i}`,
      body: `${wort} wurde hier am ${i}. Tag notiert, zusammen mit der Uhrzeit und dem Wetter.`,
    });
  }
}

/**
 * Der Befund in seiner schärfsten Form: "in 4 Einträgen" war nie eine Zahl,
 * sondern die Länge der gekürzten Liste. Gezählt werden muss, was da ist.
 */
test('die Zahl der Fundorte ist gezählt, nicht die Länge der angezeigten Liste', async () => {
  await withVault('nos-sl-zaehlen', async ({ store, secondLook }) => {
    const { kaffee } = seed(store);
    // "Brühtemperatur" steht danach in 12 weiteren Einträgen (+1 aus seed()).
    vieleMit(store, 'Die Brühtemperatur', 12, 'Temperaturprotokoll');

    const b = begriff(await secondLook.look(kaffee.id), 'bruehtemperatur');
    assert.ok(b, 'der Begriff fehlt ganz');
    assert.equal(b.anzahl, 13, `gezählt wurden ${b.anzahl} Einträge, es sind 13`);
    assert.equal(b.genau, true, 'so wenige Fundorte sind vollständig nachgesehen');
    assert.equal(b.treffer.length, 4, 'angezeigt werden weiterhin nur die ersten vier');
    assert.ok(b.anzahl > b.treffer.length, 'sonst prüft dieser Test nichts');
  });
});

/**
 * Über der Sonde hört das Wissen auf. Dann wird die Zahl zur Untergrenze --
 * und sagt das auch, statt eine zweite Obergrenze als Tatsache auszugeben.
 */
test('über die Sonde hinaus wird die Zahl ehrlich zur Untergrenze', async () => {
  await withVault('nos-sl-untergrenze', async ({ store, secondLook }) => {
    const { kaffee } = seed(store);
    vieleMit(store, 'Der Mahlgrad', MAX_COUNT_PROBE + 20, 'Mahlprotokoll');

    const b = begriff(await secondLook.look(kaffee.id), 'mahlgrad');
    assert.ok(b);
    assert.equal(b.genau, false, 'so viele Fundorte kann diese Sonde nicht vollständig sehen');
    assert.ok(b.anzahl >= MAX_COUNT_PROBE - 1,
      `die Untergrenze soll so hoch sein, wie wirklich nachgesehen wurde (war ${b.anzahl})`);
    assert.ok(b.anzahl <= MAX_COUNT_PROBE, 'mehr als nachgesehen wurde, darf nicht behauptet werden');
  });
});

/**
 * Die Reihenfolge lief über dieselbe gedeckelte Zahl: bei jedem gut
 * verbundenen Begriff standen lauter Vieren nebeneinander, und entschieden
 * hat am Ende das Alphabet. Der stärker verbundene Begriff gehört nach oben.
 */
test('sortiert wird nach der gezählten Zahl, nicht nach der gekappten Liste', async () => {
  await withVault('nos-sl-reihenfolge', async ({ store, secondLook }) => {
    const { kaffee } = seed(store);
    // "Mahlgrad" steht zweimal in der Notiz, "Brühtemperatur" einmal -- die
    // gedeckelte Sortierung hat deshalb den schwächer verbundenen Begriff
    // nach oben gestellt.
    vieleMit(store, 'Die Brühtemperatur', 25, 'Temperaturprotokoll');
    vieleMit(store, 'Der Mahlgrad', 6, 'Mahlprotokoll');

    const liste = (await secondLook.look(kaffee.id)).bekannteBegriffe;
    const mahl = liste.findIndex((b) => b.form === 'mahlgrad');
    const bruehe = liste.findIndex((b) => b.form === 'bruehtemperatur');
    assert.ok(mahl >= 0 && bruehe >= 0, 'beide Begriffe müssen in der Liste stehen');
    assert.ok(bruehe < mahl,
      `"Brühtemperatur" (26 Fundorte) steht hinter "Mahlgrad" (7): ${liste.map((b) => `${b.form}=${b.anzahl}`).join(', ')}`);
  });
});

/* ------------------------------- 8. nicht gefunden ist nicht nachgesehen */

/**
 * Wirft der Index, wurde der Begriff still übersprungen -- und der Satz
 * darunter behauptete danach trotzdem, im Tresor komme keiner dieser Begriffe
 * vor. Das ist eine Aussage über den Tresor, für die niemand nachgesehen hat.
 */
test('ein Begriff, der nicht nachgeschlagen werden konnte, wird gemeldet statt verschwiegen', async () => {
  await withVault('nos-sl-blindstelle', async ({ store, secondLook }) => {
    const { kaffee } = seed(store);
    store.search = () => { throw new Error('Der Volltextindex ist beschädigt (Attrappe).'); };

    const result = await secondLook.look(kaffee.id);

    assert.deepEqual(result.bekannteBegriffe, [], 'ohne Index kann nichts gefunden werden');
    assert.ok(result.nichtNachschlagbar > 0,
      'die übersprungenen Begriffe müssen gezählt in der Antwort stehen');
    assert.doesNotMatch(result.hinweis, /kommt bisher\s+anderswo im Tresor vor/,
      'ohne Index darf nicht behauptet werden, im Tresor stehe nichts davon');
    assert.match(result.hinweis, /konnte nicht nachgesehen werden/,
      'der Satz muss sagen, dass niemand nachgesehen hat');
    assert.match(result.hinweis, new RegExp(`${result.nichtNachschlagbar} Begriffen`),
      'und wie viele Begriffe das betrifft');
  });
});

/* --------------------------------------------------------------- Umfang */

test('auch in einem vollen Tresor bleibt der Begriffsteil bezahlbar', async () => {
  await withVault('nos-sl-umfang', async ({ store, secondLook }) => {
    const { kaffee } = seed(store);
    for (let i = 0; i < 300; i++) {
      store.create('note', {
        title: `Notiz ${i}`,
        body: `Thema ${i}: ${Array.from({ length: 30 }, (_, w) => `begriff${i}wort${w}`).join(' ')}`,
      });
    }
    const t0 = Date.now();
    const result = await secondLook.look(kaffee.id);
    const ms = Date.now() - t0;
    assert.ok(result.bekannteBegriffe.length > 0);
    assert.ok(ms < 4000, `der Begriffsteil brauchte ${ms} ms`);
  });
});

/* ----------------------------------------------------------------- HTTP */

/**
 * Der echte Server soll /api/notes/:id/second-look schon bedienen, bevor der
 * Integrator die Datei in seine Ladeliste aufgenommen hat: das zuletzt
 * geladene Routenmodul bekommt eine Hülle, die unsere Route mitregistriert.
 * Der Server selbst bleibt unangetastet, und die Naht verschwindet von selbst,
 * sobald `src/http/server.js` die Datei wirklich lädt.
 */
const SERVER_FILE = require.resolve('../src/http/server');
if (!/require\(['"]\.\/api\/secondlook['"]\)/.test(fs.readFileSync(SERVER_FILE, 'utf8'))) {
  const lastLoadedApi = require('../src/http/api/compare');
  const originalRegister = lastLoadedApi.register;
  lastLoadedApi.register = function registerWithSecondLook(router) {
    originalRegister.call(this, router);
    secondLookApi.register(router);
  };
}

function request(base, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...(method !== 'GET' && method !== 'HEAD' ? { 'x-neural-os': '1' } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* nicht jede Route antwortet JSON */ }
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('Die Route hält den vereinbarten Vertrag -- auch ohne Modell', async () => {
  const { createServer } = require('../src/http/server');

  const { home, cleanup } = tempHome('nos-sl-http');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  config.server.host = '127.0.0.1';

  const bus = new Bus();
  const store = await openStore({ paths, bus, logger: silentLogger });
  const audit = new Audit(`${home}/audit.jsonl`).open();
  const gate = createGate({ config, bus, audit, store, logger: silentLogger });
  const secondLook = createSecondLook({ store, registry: null, graph: GRAPH, gate, bus, config, logger: silentLogger });

  const server = await createServer({
    version: 'test', config, paths, store, bus, gate, secondLook, graph: GRAPH, logger: silentLogger, failures: [],
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;

  // Ein zweiter Server, dem das Teilsystem fehlt: dort ist 503 die richtige
  // Antwort, weil dann auch der Indexteil nicht vorliegt.
  const blind = await createServer({
    version: 'test', config, paths, store, bus, gate, graph: GRAPH, logger: silentLogger, failures: [],
  });
  await blind.listen({ port: 0, host: '127.0.0.1' });
  const blindBase = `http://127.0.0.1:${blind.server.address().port}`;

  try {
    const { kaffee, wasser } = seed(store);

    const ok = await request(base, 'POST', `/api/notes/${kaffee.id}/second-look`);
    assert.equal(ok.status, 200, ok.text);
    assert.ok(ok.json.bekannteBegriffe.length > 0, 'ohne Modell kam nichts zurück');
    assert.equal(ok.json.kern, null);
    assert.deepEqual(ok.json.offeneStellen, []);
    assert.equal(ok.json.modell.verfuegbar, false);
    assert.match(ok.json.hinweis, /Sprachmodell/);
    assert.equal(ok.json.usedNetwork, false);
    assert.ok(ok.json.bekannteBegriffe.some((b) => b.treffer.some((t) => t.id === wasser.id)));

    const kurz = store.create('note', { title: 'Milch', body: 'Milch holen.' });
    const zuKurz = await request(base, 'POST', `/api/notes/${kurz.id}/second-look`);
    assert.equal(zuKurz.status, 400, zuKurz.text);
    assert.match(zuKurz.json.error.message, /zu kurz/);

    const fehlt = await request(base, 'POST', '/api/notes/note_gibtsnicht000000000/second-look');
    assert.equal(fehlt.status, 404, fehlt.text);

    const projekt = store.create('project', { name: 'Küche', description: KAFFEE });
    const falsch = await request(base, 'POST', `/api/notes/${projekt.id}/second-look`);
    assert.equal(falsch.status, 404, 'ein Projekt ist unter /api/notes/ keine Notiz');

    const schlechteArt = await request(base, 'POST', `/api/notes/${kaffee.id}/second-look`, { types: ['gibtsnicht'] });
    assert.equal(schlechteArt.status, 400, schlechteArt.text);
    assert.match(schlechteArt.json.error.message, /note/);

    const nurNotizen = await request(base, 'POST', `/api/notes/${kaffee.id}/second-look`, { types: ['note'] });
    assert.equal(nurNotizen.status, 200, nurNotizen.text);

    const leereListe = await request(base, 'POST', `/api/notes/${kaffee.id}/second-look`, { types: [] });
    assert.equal(leereListe.status, 400, 'eine leere Liste ist keine Auswahl und wird auch nicht als eine gelesen');

    const ohneTeilsystem = await request(blindBase, 'POST', `/api/notes/${kaffee.id}/second-look`);
    assert.equal(ohneTeilsystem.status, 503, ohneTeilsystem.text);
    assert.match(ohneTeilsystem.json.error.message, /zweite Blick/);
  } finally {
    await server.close().catch(() => {});
    await blind.close().catch(() => {});
    await store.close().catch(() => {});
    try { audit.close(); } catch { /* schon zu */ }
    cleanup();
  }
});

test('mit einem Modell trägt die Antwort beide Teile und sagt, welcher woher kommt', async () => {
  const { createServer } = require('../src/http/server');

  const { home, cleanup } = tempHome('nos-sl-http-modell');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  const bus = new Bus();
  const store = await openStore({ paths, bus, logger: silentLogger });
  const audit = new Audit(`${home}/audit.jsonl`).open();
  const gate = createGate({ config, bus, audit, store, logger: silentLogger });
  const registry = fakeRegistry(LOKAL, async () => ({
    content: 'Klar:\n{"kern": "Zwei Sätze zum Espresso.", "offeneStellen": ["Der Tamperdruck ist ungeklärt."]}',
    stats: {},
  }));
  const secondLook = createSecondLook({ store, registry, graph: GRAPH, gate, bus, config, logger: silentLogger });

  const server = await createServer({
    version: 'test', config, paths, store, bus, gate, secondLook, graph: GRAPH, logger: silentLogger, failures: [],
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;

  try {
    const { kaffee } = seed(store);
    const res = await request(base, 'POST', `/api/notes/${kaffee.id}/second-look`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.kern, 'Zwei Sätze zum Espresso.');
    assert.deepEqual(res.json.offeneStellen, ['Der Tamperdruck ist ungeklärt.']);
    assert.equal(res.json.modell.verfuegbar, true);
    assert.deepEqual(res.json.model, { provider: 'ollama', model: 'lokalmodell' });
    assert.ok(res.json.bekannteBegriffe.length > 0);
    assert.equal(res.json.usedNetwork, false);
    // Geschrieben wird nichts: der zweite Blick hinterlässt keinen Satz.
    assert.equal(store.count('note'), 3, 'der Aufruf hat etwas in den Tresor geschrieben');
  } finally {
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    try { audit.close(); } catch { /* schon zu */ }
    cleanup();
  }
});

test('eine unlesbare Modellantwort wird über HTTP zu 502, nicht zu einer Zusammenfassung', async () => {
  const { createServer } = require('../src/http/server');

  const { home, cleanup } = tempHome('nos-sl-http-kaputt');
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const config = configMod.defaults();
  const bus = new Bus();
  const store = await openStore({ paths, bus, logger: silentLogger });
  const audit = new Audit(`${home}/audit.jsonl`).open();
  const gate = createGate({ config, bus, audit, store, logger: silentLogger });
  const registry = fakeRegistry(LOKAL, async () => ({ content: 'Ich denke, es geht um Kaffee.', stats: {} }));
  const secondLook = createSecondLook({ store, registry, graph: GRAPH, gate, bus, config, logger: silentLogger });

  const server = await createServer({
    version: 'test', config, paths, store, bus, gate, secondLook, graph: GRAPH, logger: silentLogger, failures: [],
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.server.address().port}`;

  try {
    const { kaffee } = seed(store);
    const res = await request(base, 'POST', `/api/notes/${kaffee.id}/second-look`);
    assert.equal(res.status, 502, res.text);
    assert.equal(res.json.error.code, 'MODEL_ERROR');
    assert.equal(res.json.kern, undefined, 'im Fehlerfall darf keine Kernaussage mitgeliefert werden');
  } finally {
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    try { audit.close(); } catch { /* schon zu */ }
    cleanup();
  }
});

module.exports = { name: 'secondlook', tests: drain() };
