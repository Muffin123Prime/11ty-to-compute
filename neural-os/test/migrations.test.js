'use strict';

/**
 * Die Umwandlung alter Lernkarten in Notizen.
 *
 * Das Entscheidende an diesen Tests: sie schreiben die Karten mit dem ALTEN
 * Schema in einen ECHTEN Tresor und oeffnen ihn dann mit dem NEUEN. Ein Test,
 * der die Karten einfach als Objekte an die Umwandlung reicht, wuerde die
 * eigentliche Frage nicht stellen -- naemlich ob ein Satz, dessen Typ es nicht
 * mehr gibt, ueberhaupt noch aus dem Log zurueckkommt. Er kommt zurueck (der
 * Wiederaufbau prueft den Typ nicht nach), und genau deshalb braucht es die
 * Umwandlung: sonst bliebe er als Karteileiche liegen, fiele still aus jeder
 * neuen Sicherung heraus und waere weg, wenn man ihn braucht.
 *
 * `withAltemSchema()` traegt 'card' voruebergehend wieder in schema.TYPES ein.
 * Das ist kein Trick am Pruefling vorbei, sondern die einzige Art, einen
 * Tresor herzustellen, wie ihn ein Mensch nach dem Update wirklich hat.
 */

const assert = require('node:assert/strict');

const { test, tempHome } = require('./harness');

const schema = require('../src/store/schema');
const { openStore } = require('../src/store/engine');
const pathsMod = require('../src/kernel/paths');
const { lernkartenZuNotizen, titelUndText } = require('../src/store/migrations');

/** Die Felddefinition, wie sie vor dem Wegfall des Bereichs "Lernen" aussah. */
const ALTE_KARTE = {
  front: { type: 'string', required: true, max: 2000 },
  back: { type: 'string', default: '', max: 8000 },
  noteId: { type: 'string', nullable: true, default: null },
  deck: { type: 'string', default: 'Standard', max: 120 },
  ease: { type: 'number', default: 2.5 },
  intervalDays: { type: 'number', default: 0 },
  due: { type: 'string', nullable: true, default: null },
  reps: { type: 'number', default: 0 },
  lapses: { type: 'number', default: 0 },
  lastReviewedAt: { type: 'string', nullable: true, default: null },
  lastGrade: { type: 'number', nullable: true, default: null },
  suspended: { type: 'boolean', default: false },
  source: { type: 'string', default: 'manual' },
};

/** 'card' ist waehrend `fn()` wieder ein gueltiger Typ -- danach nie wieder. */
async function withAltemSchema(fn) {
  schema.TYPES.push('card');
  schema.FIELDS.card = ALTE_KARTE;
  try {
    return await fn();
  } finally {
    const i = schema.TYPES.indexOf('card');
    if (i >= 0) schema.TYPES.splice(i, 1);
    delete schema.FIELDS.card;
  }
}

/** Ein Tresor mit Karten, geschrieben wie vor dem Update, wieder geschlossen. */
async function tresorMitKarten(home) {
  const paths = pathsMod.ensureLayout(pathsMod.layout(home));
  const angelegt = await withAltemSchema(async () => {
    const s = await openStore({ paths });
    try {
      const quelle = s.create('note', { title: 'Crema', body: 'Die Schaumschicht.', tags: ['kaffee'] });
      s.create('card', { front: 'Was ist Crema?', back: 'Die Schaumschicht auf dem Espresso.', noteId: quelle.id });
      s.create('card', { front: 'Welche Brühtemperatur?', back: 'Rund 93 Grad.', noteId: quelle.id });
      s.create('card', { front: 'Was ist Fruchtfolge?', back: 'Nicht zweimal dieselbe Familie.', deck: 'Garten' });
      s.create('card', { front: 'Karte ohne Rückseite?' });
      const weg = s.create('card', { front: 'Schon weggeworfen', back: 'egal' });
      s.remove(weg.id); // Grabstein: bewusst geloescht, nicht zu beleben
      return { quelleId: quelle.id, lebend: 4, grabsteine: 1, notizen: s.count('note') };
    } finally {
      await s.close();
    }
  });
  return { paths, ...angelegt };
}

test('Aus N alten Karten werden N Notizen, und "card" verschwindet aus den Zahlen', async () => {
  const ctx = tempHome('nos-migr');
  try {
    const { paths, lebend, notizen } = await tresorMitKarten(ctx.home);

    // Ab hier gilt das NEUE Schema: 'card' steht nicht mehr in TYPES.
    assert.equal(schema.TYPES.includes('card'), false, 'card steht noch im Schema');

    const s = await openStore({ paths });
    try {
      // Der Befund, der die Umwandlung ueberhaupt noetig macht: die Saetze sind
      // noch da, obwohl es den Typ nicht mehr gibt.
      assert.equal(s.stats().counts.card, lebend,
        'die alten Karten kommen gar nicht erst aus dem Log zurueck — dann misst dieser Test nichts');

      const bericht = lernkartenZuNotizen(s, {});

      assert.equal(bericht.umgewandelt, lebend, `umgewandelt: ${bericht.umgewandelt} statt ${lebend}`);
      assert.deepEqual(bericht.fehler, []);
      assert.equal(s.count('note'), notizen + lebend, 'aus N Karten wurden nicht N Notizen');
      assert.ok(!('card' in s.stats().counts), `stats().counts nennt weiterhin card: ${JSON.stringify(s.stats().counts)}`);
    } finally {
      await s.close();
    }
  } finally {
    ctx.cleanup();
  }
});

test('Vorderseite wird Titel, Rückseite wird Text, "lernkarte" hält die Herkunft fest', async () => {
  const ctx = tempHome('nos-migr-inhalt');
  try {
    const { paths } = await tresorMitKarten(ctx.home);
    const s = await openStore({ paths });
    try {
      lernkartenZuNotizen(s, {});
      const aus = s.all('note').filter((n) => (n.data.tags || []).includes('lernkarte'));
      const crema = aus.find((n) => n.data.title === 'Was ist Crema?');
      assert.ok(crema, `keine Notiz mit der Vorderseite als Titel: ${aus.map((n) => n.data.title).join(' | ')}`);
      assert.equal(crema.data.body, 'Die Schaumschicht auf dem Espresso.');

      // Der Stapelname war eine Einteilung von Hand und geht nicht verloren.
      const garten = aus.find((n) => n.data.title === 'Was ist Fruchtfolge?');
      assert.ok(garten.data.tags.includes('garten'), `Stapel fehlt: ${JSON.stringify(garten.data.tags)}`);

      // Eine Karte ohne Rueckseite wird eine Notiz ohne Text, nicht eine mit
      // einem erfundenen Platzhalter darin.
      const ohne = aus.find((n) => n.data.title === 'Karte ohne Rückseite?');
      assert.equal(ohne.data.body, '');
    } finally {
      await s.close();
    }
  } finally {
    ctx.cleanup();
  }
});

test('Die Verknüpfung zur Quellnotiz bleibt erhalten', async () => {
  const ctx = tempHome('nos-migr-kante');
  try {
    const { paths, quelleId } = await tresorMitKarten(ctx.home);
    const s = await openStore({ paths });
    try {
      lernkartenZuNotizen(s, {});
      const kanten = s.all('edge').filter((e) => e.data.to === quelleId && e.data.kind === 'derived-from');
      // Zwei der Karten hatten eine Quellnotiz, die dritte nicht.
      assert.equal(kanten.length, 2, `Verknüpfungen zur Quelle: ${kanten.length} statt 2`);
      for (const k of kanten) assert.match(k.data.reason, /Lernkarte/);
    } finally {
      await s.close();
    }
  } finally {
    ctx.cleanup();
  }
});

test('Eine bereits gelöschte Karte wird nicht als Notiz wiederbelebt', async () => {
  const ctx = tempHome('nos-migr-grab');
  try {
    const { paths, grabsteine } = await tresorMitKarten(ctx.home);
    const s = await openStore({ paths });
    try {
      const bericht = lernkartenZuNotizen(s, {});
      assert.equal(bericht.verworfen, grabsteine, `verworfen: ${bericht.verworfen} statt ${grabsteine}`);
      const wieder = s.all('note').filter((n) => n.data.title === 'Schon weggeworfen');
      assert.equal(wieder.length, 0, 'eine weggeworfene Karte ist als Notiz zurückgekommen');
      // Und sie liegt auch nicht mehr als unlesbarer Rest im Tresor.
      assert.equal(s.list('card', { includeDeleted: true }).total, 0);
    } finally {
      await s.close();
    }
  } finally {
    ctx.cleanup();
  }
});

test('Die Umwandlung läuft nur einmal, auch über einen Neustart hinweg', async () => {
  const ctx = tempHome('nos-migr-einmal');
  try {
    const { paths, lebend, notizen } = await tresorMitKarten(ctx.home);

    let s = await openStore({ paths });
    let nachher;
    try {
      lernkartenZuNotizen(s, {});
      nachher = s.count('note');
      // Zweiter Aufruf in derselben Sitzung.
      const zweiter = lernkartenZuNotizen(s, {});
      assert.equal(zweiter.gefunden, 0, 'beim zweiten Mal wurden wieder Karten gefunden');
      assert.equal(s.count('note'), nachher, 'der zweite Aufruf hat Notizen verdoppelt');
    } finally {
      await s.close();
    }

    // Und nach einem echten Neustart aus dem Log.
    s = await openStore({ paths });
    try {
      assert.ok(!('card' in s.stats().counts), 'nach dem Neustart sind die Karten wieder da');
      assert.equal(s.count('note'), notizen + lebend, 'der Neustart hat die Notizenzahl verändert');
      const dritter = lernkartenZuNotizen(s, {});
      assert.equal(dritter.umgewandelt, 0);
      assert.equal(s.count('note'), notizen + lebend);
    } finally {
      await s.close();
    }
  } finally {
    ctx.cleanup();
  }
});

test('Eine überlange Vorderseite wird gekürzt, ohne dass ihr Wortlaut verlorengeht', () => {
  const lang = 'A'.repeat(900);
  const { titel, text } = titelUndText(lang, 'Die Antwort.');
  assert.equal(titel.length, 500, `Titel ist ${titel.length} Zeichen lang, note.title erlaubt 500`);
  assert.ok(text.includes(lang), 'der volle Wortlaut steht nirgends mehr');
  assert.ok(text.includes('Die Antwort.'));

  // Mehrzeilig: die erste Zeile trägt den Titel, der Rest darf nicht wegfallen.
  const mehr = titelUndText('Frage?\nZusatz dazu', 'Antwort');
  assert.equal(mehr.titel, 'Frage?');
  assert.ok(mehr.text.includes('Zusatz dazu'));

  // Eine leere Vorderseite bekommt einen ehrlichen Titel, keinen erfundenen.
  assert.equal(titelUndText('', 'nur hinten').titel, 'Lernkarte ohne Vorderseite');
});

test('Ein Tresor ohne Karten wird nicht angefasst', async () => {
  const ctx = tempHome('nos-migr-leer');
  try {
    const paths = pathsMod.ensureLayout(pathsMod.layout(ctx.home));
    const s = await openStore({ paths });
    try {
      s.create('note', { title: 'Nur eine Notiz' });
      const vorher = s.stats().seq;
      const bericht = lernkartenZuNotizen(s, {});
      assert.deepEqual(bericht, { gefunden: 0, umgewandelt: 0, verworfen: 0, fehler: [] });
      assert.equal(s.stats().seq, vorher, 'die Umwandlung hat in einen Tresor ohne Karten geschrieben');
    } finally {
      await s.close();
    }
  } finally {
    ctx.cleanup();
  }
});
