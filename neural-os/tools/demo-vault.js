'use strict';

/**
 * Ein Tresor, der aussieht wie der eines echten Menschen nach ein paar Monaten.
 *
 * Wofuer das gut ist
 * ------------------
 * `tools/screenshots.js` braucht eine Anwendung, in der etwas drinsteht --
 * sonst fotografiert man fuenfzehn Leerzustaende. Und ein Leerzustand luegt
 * in beide Richtungen: er zeigt weder, ob eine Liste mit dreissig Eintraegen
 * noch lesbar ist, noch ob die Vorschlaege ueberhaupt etwas finden.
 *
 * Warum die Fuelltexte alle verschieden sind
 * ------------------------------------------
 * Die erste Fassung erzeugte sechsundzwanzig Varianten desselben Satzes. Der
 * Doppel-Finder meldete daraufhin fuenfzig Treffer und die Vorschlagsliste war
 * eine Wand aus Dubletten -- ein Bild, das ueber die Anwendung nichts aussagt.
 * Jetzt hat jede Notiz einen eigenen Text, und die neunzehn Vorschlaege
 * verteilen sich auf alle sechs Regeln.
 *
 * Warum umdatiert und neu gestartet wird
 * --------------------------------------
 * Verwaiste Notizen und Wiedervorlagen gibt es erst ab vierzehn bzw. neunzig
 * Tagen. Der Speicher vergibt seine Zeitstempel selbst -- zu Recht, sonst
 * koennte jeder Aufrufer die Vergangenheit behaupten. Deshalb wird nicht der
 * Speicher ueberredet, sondern nach dem Schliessen das Protokoll umdatiert
 * (`altern()`) und die Anwendung neu gestartet: dieselbe Wiederherstellung
 * wie nach jedem anderen Neustart auch.
 */

const fs = require('node:fs');
const path = require('node:path');
const { withActor } = require('../src/kernel/actor');

/**
 * Fuellt einen frisch angelegten Tresor. Zurueck kommt, welche Saetze beim
 * naechsten Start aelter aussehen sollen -- siehe `altern()`.
 */
async function befuellen(app) {
  const s = app.store;
  const tage = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  // --- Projekte und Aufgaben --------------------------------------------
  const kueche = s.create('project', { name: 'Küche einrichten', description: 'Espressomaschine, Mühle, Wasserfilter.', tags: ['haushalt'] });
  const garten = s.create('project', { name: 'Gartenjahr 2027', description: 'Beete planen, Aussaat, Bewässerung.', tags: ['garten'] });
  s.create('project', { name: 'Steuererklärung', description: 'Belege sortieren.', status: 'paused' });

  s.create('task', { title: 'Mühle entkalken', projectId: kueche.id, due: tage(-3), priority: 1 });
  s.create('task', { title: 'Wasserfilter bestellen', projectId: kueche.id, due: tage(-1), priority: 2 });
  s.create('task', { title: 'Siebträger nachmessen', projectId: kueche.id, due: tage(0) });
  s.create('task', { title: 'Beete abstecken', projectId: garten.id, due: tage(2) });
  s.create('task', { title: 'Tomaten vorziehen', projectId: garten.id, due: tage(9), priority: 3 });
  s.create('task', { title: 'Regal bauen', projectId: kueche.id, status: 'doing' });
  s.create('task', { title: 'Bohnen nachbestellen', status: 'done' });

  // --- Notizen, mit echten Wiki-Links -----------------------------------
  const notizen = [
    ['Espresso in der Praxis',
     'Der Mahlgrad entscheidet über den Widerstand im Sieb. Ist er zu fein, steigt der Druck und der Espresso läuft nur tropfenweise; ist er zu grob, rauscht das Wasser durch und die [[Crema]] bleibt dünn.\n\nDie [[Brühtemperatur]] liegt bei rund 93 Grad, bei dunklen Röstungen eher darunter. Neun bar sind die Norm, aber viele Maschinen schwanken.\n\n## Was ist Crema?\n\nDie Schaumschicht auf dem Espresso, entsteht aus gelöstem CO₂ der Bohne.\n\n## Welcher Druck ist richtig?\n\nNeun bar am Sieb, gemessen nicht an der Pumpe.\n\n- [ ] Dichtung nachbestellen\n\nOffen bleibt, wie stark sich die Bohnenfrische auf den Druck auswirkt.',
     ['kaffee', 'technik']],
    ['Crema', 'Die Schaumschicht auf dem Espresso. Hängt an Frische, [[Mahlgrad]] und Druck.', ['kaffee']],
    ['Brühtemperatur', '93 Grad ist der übliche Wert. Bei dunklen Röstungen eher 90.', ['kaffee']],
    ['Mahlgrad', 'Feiner Mahlgrad erhöht den Widerstand und damit den Druck im Sieb.', ['kaffee', 'technik']],
    ['Espresso zu Hause',
     'Der Mahlgrad entscheidet über den Widerstand im Sieb. Ist er zu fein, steigt der Druck und der Espresso läuft nur tropfenweise; ist er zu grob, rauscht das Wasser durch und die Crema bleibt dünn.\n\nDie Brühtemperatur liegt bei rund 93 Grad, bei dunklen Röstungen eher darunter. Neun bar sind die Norm, aber viele Maschinen schwanken.\n\n## Was ist Crema?\n\nDie Schaumschicht auf dem Espresso, entsteht aus gelöstem CO₂ der Bohne.\n\n## Welcher Druck ist richtig?\n\nNeun bar am Sieb, gemessen nicht an der Pumpe.',
     ['kaffee']],
    ['Beetplanung',
     'Drei Beete: Tomaten in die Südwand, Salat in den Halbschatten, Kräuter in die Kiste.\n\nBegriff :: Erklärung\nFruchtfolge :: Nicht zweimal hintereinander dieselbe Familie ins selbe Beet.\n\nSiehe [[Bewässerung]].',
     ['garten']],
    ['Bewässerung', 'Tropfschlauch mit Zeitschaltuhr, morgens um sechs.', ['garten', 'technik']],
    ['Datenschutz im Alltag', 'Was ich wo preisgebe, und was nicht. Siehe [[Lokale Modelle]].', ['datenschutz']],
    ['Lokale Modelle', 'Ollama, llama.cpp, LM Studio. Alle sprechen auf 127.0.0.1.', ['technik', 'datenschutz']],
    ['Werkstatt – Grundlagen', 'Dübel, Schrauben, Holzmaße. Was wann gewartet wird, steht in [[Wartungsplan]].\n\nTODO: Bohrerständer kaufen', ['werkstatt']],
    ['Alte Notiz ohne Verbindung', 'Steht seit Monaten hier und zeigt auf nichts.', []],
  ];
  const ids = {};
  for (const [title, body, tags] of notizen) ids[title] = s.create('note', { title, body, tags }).id;
  s.update(ids['Espresso in der Praxis'], { pinned: true });
  /**
   * Weitere Notizen, wie sie sich ueber Monate ansammeln. Jede hat einen
   * eigenen Text: mit 26 Varianten desselben Satzes haette der Doppel-Finder
   * 50 Treffer gemeldet und die Vorschlagsliste waere eine Wand aus Dubletten
   * gewesen -- ein Bild, das nichts ueber die Anwendung aussagt.
   */
  const weitere = [
    ['Siebträger reinigen', 'Einmal die Woche Rückspülen mit Blindsieb, danach die Dusche abschrauben und den Kaffeefettring abbürsten. Auf den [[Mahlgrad]] hat das keinen Einfluss.', ['kaffee']],
    ['Bohnen: Lieferanten', 'Die Röstung aus der Markthalle ist heller und säurebetonter als die vom Versand. Preis pro Kilo ist fast gleich. Frische Bohnen ändern die [[Crema]] sofort.', ['kaffee']],
    ['Milchschaum', 'Kalte Milch, Düse knapp unter die Oberfläche, bis es zischt. Ab 37 Grad nur noch rollen lassen, nicht mehr ziehen.', ['kaffee']],
    ['Wasserhärte hier', 'Vierzehn Grad deutscher Härte laut Wasserwerk. Ohne Filter verkalkt der Kessel in einem halben Jahr. Das verschiebt auch die [[Brühtemperatur]].', ['kaffee', 'technik']],
    ['Tomatensorten', 'Ochsenherz braucht Stütze und viel Platz. Die Cocktailsorte trägt zuverlässiger, schmeckt aber flacher. Standorte stehen in [[Beetplanung]].', ['garten']],
    ['Kompost', 'Zwei Kammern: eine wird befüllt, die andere ruht. Umsetzen im Frühjahr, wenn es nicht mehr friert. Hängt am selben Plan wie die [[Bewässerung]].', ['garten']],
    ['Schnecken', 'Bierfallen ziehen mehr Schnecken an als sie fangen. Schafwolle um die Beete hat besser gewirkt.', ['garten']],
    ['Gartengeräte', 'Spaten und Hacke nach dem Graben abkratzen und ölen. Der Rost kommt über Nacht, nicht über den Winter.', ['garten', 'werkstatt']],
    ['Aussaatkalender', 'Vorziehen ab Ende Februar am Fenster. Ins Freie erst nach den Eisheiligen, also Mitte Mai. Siehe [[Beetplanung]].', ['garten']],
    ['Dübel und Lasten', 'Ein Sechser-Dübel in Beton trägt deutlich mehr als derselbe in Gasbeton. Für Hohlwände gehören Kippdübel hinein. Grundlagen in [[Werkstatt – Grundlagen]].', ['werkstatt']],
    ['Holzverbindungen', 'Flachdübel reichen für Regalböden. Für eine Tischplatte, die arbeitet, braucht es Nut und Feder.', ['werkstatt']],
    ['Schleifkörnungen', 'Achtzig zum Abtragen, hundertzwanzig zum Glätten, zweihundertvierzig vor dem Ölen. Nie eine Stufe überspringen. Gehört zu [[Werkstatt – Grundlagen]].', ['werkstatt']],
    ['Werkstattordnung', 'Alles, was zweimal gesucht wurde, bekommt einen festen Platz mit Beschriftung.', ['werkstatt']],
    ['Bohrerständer', 'TODO: Bohrerständer aus Restholz bauen, Löcher in Zehntelschritten von zwei bis zehn Millimeter.', ['werkstatt']],
    ['Gelesen: Der Wal und das Ende der Welt', 'Ein Dorf in Cornwall und ein Mann, der von einem Wal ans Ufer gebracht wird. Ruhiges Buch über das, was Gemeinschaft hält.', ['lesen']],
    ['Gelesen: Die Wand', 'Marlen Haushofer. Eine Frau, eine unsichtbare Wand, ein Tal. Ich habe lange danach nichts anderes lesen können.', ['lesen']],
    ['Leseliste', 'Noch offen: Stoner, Ein Mann seiner Klasse, Die Entdeckung der Langsamkeit.', ['lesen']],
    ['Notizen zum Lesen', 'Was ich beim Lesen anstreiche, schreibe ich am selben Abend ab. Sonst weiß ich in einer Woche nicht mehr, warum.', ['lesen']],
    ['Kühlschrank ausmessen', 'Nische ist 60 mal 178. Die Tür schlägt links an und lässt sich nicht wechseln.', ['haushalt']],
    ['Vorratshaltung', 'Reis, Linsen und Nudeln in Gläsern, Datum auf den Deckel. Was offen ist, kommt nach vorn.', ['haushalt']],
    ['Wäsche', 'Dreißig Grad reicht für fast alles. Handtücher bei sechzig, sonst riechen sie nach zwei Tagen.', ['haushalt']],
    ['Backup-Plan', 'Eine Platte hier, eine bei den Eltern, einmal im Quartal tauschen. Nichts liegt nur an einem Ort. Gilt auch für [[Lokale Modelle]].', ['technik', 'datenschutz']],
    ['Passwörter', 'Alles im Verwalter, nichts im Browser. Die zwei wichtigsten kann ich auswendig, der Rest muss es nicht sein.', ['datenschutz']],
    ['Router', 'Gastnetz für alles, was nach Hause telefonieren will. Der Drucker hängt dort und nicht im Hauptnetz. Siehe [[Datenschutz im Alltag]].', ['technik', 'datenschutz']],
    ['Telefon aufräumen', 'Standortverlauf aus, Werbe-ID zurückgesetzt, alle Apps ohne Zweck entfernt. Gehört zu [[Datenschutz im Alltag]].', ['datenschutz']],
    ['Wochenrückblick', 'Freitagnachmittag: offene Aufgaben durchgehen, drei Dinge für nächste Woche festlegen, den Rest bewusst liegen lassen.', ['alltag']],
  ];
  const weitereIds = {};
  for (const [title, body, tags] of weitere) weitereIds[title] = s.create('note', { title, body, tags }).id;

  if (app.graph && app.graph.scanAll) app.graph.scanAll(s, {});

  // --- Chats -------------------------------------------------------------
  const chat = s.create('chat', { title: 'Über Mahlgrad und Druck' });
  s.create('message', { chatId: chat.id, role: 'user', content: 'Warum läuft mein Espresso zu schnell durch?', ordinal: 0 });
  s.create('message', { chatId: chat.id, role: 'assistant', content: 'Meist ist der Mahlgrad zu grob. Stell ihn eine Stufe feiner und miss die Durchlaufzeit: 25 Sekunden für 30 ml sind ein guter Richtwert.', ordinal: 1 });
  s.create('chat', { title: 'Beetplanung 2027' });

  // --- Lernkarten --------------------------------------------------------
  s.create('card', { front: 'Was ist Crema?', back: 'Die Schaumschicht auf dem Espresso, aus gelöstem CO₂ der Bohne.', noteId: ids['Crema'] });
  s.create('card', { front: 'Welche Brühtemperatur?', back: 'Rund 93 Grad, bei dunklen Röstungen eher 90.', noteId: ids['Brühtemperatur'] });
  s.create('card', { front: 'Was ist Fruchtfolge?', back: 'Nicht zweimal hintereinander dieselbe Familie ins selbe Beet.', deck: 'Garten' });

  // --- Dateien -----------------------------------------------------------
  try {
    s.files.put(Buffer.from('# Handbuch\n\nEin kurzes Handbuch.\n'), { name: 'handbuch.md', mime: 'text/markdown' });
    s.files.put(Buffer.from('Messwert;Wert\nDruck;9 bar\n'), { name: 'messwerte.csv', mime: 'text/csv' });
  } catch { /* nicht jede Fassung erlaubt das so */ }

  // --- Ein Agentenlauf, der etwas geaendert hat --------------------------
  const agent = s.all('agent')[0];
  if (agent) {
    const run = s.create('run', { agentId: agent.id, goal: 'Notizen verschlagworten', status: 'done', result: 'Zwei Notizen ergänzt.', finishedAt: new Date().toISOString() });
    await withActor({ kind: 'agent', runId: run.id, agentId: agent.id }, async () => {
      s.update(ids['Bewässerung'], { body: 'Tropfschlauch mit Zeitschaltuhr, morgens um sechs.\n\nErgänzt: Druckminderer nicht vergessen.' });
      s.update(ids['Lokale Modelle'], { tags: ['technik', 'datenschutz', 'modelle'] });
    });
  }

  // --- Automatik ---------------------------------------------------------
  if (agent && app.scheduler) {
    app.scheduler.create({ agentId: agent.id, goal: 'Schreib mir einen Rückblick auf gestern', every: 'daily', atHour: 7, name: 'Tagesrückblick' });
    const zweiter = app.scheduler.create({ agentId: agent.id, goal: 'Neue Notizen verschlagworten', every: 'weekly', atHour: 20, onWeekday: 0, name: 'Wochenputz' });
    app.scheduler.update(zweiter.id, { enabled: true });
  }
  if (agent && app.triggers) {
    app.triggers.create({ agentId: agent.id, goal: 'Neue Notiz verschlagworten', on: 'record.created', recordType: 'note', tag: 'kaffee', name: 'Kaffee-Notizen' });
  }

  // --- Netz: eine Freigabe und ein paar Versuche -------------------------
  if (app.gate) {
    app.gate.addGrant({ scope: 'global', level: 'online', hosts: ['api.openai.com'], reason: 'Modellanbieter „OpenAI"' });
    for (const host of ['1.1.1.1', 'api.openai.com', '127.0.0.1', 'tracker.example.com']) {
      try { app.gate.check({ host, scope: 'global', purpose: 'Beispiel' }); } catch { /* egal */ }
    }
  }

  // --- Online-Anbieter ---------------------------------------------------
  try {
    app.saveConfig({ models: { remote: [{ id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', enabled: true }] } });
  } catch { /* egal */ }

  await s.flush();

  /**
   * Welche Saetze alt aussehen sollen. Der Speicher vergibt seine Zeitstempel
   * selbst -- zu Recht, sonst koennte jeder Aufrufer die Vergangenheit
   * behaupten. Fuer die Bildschirmfotos wird deshalb nicht der Speicher
   * ueberredet, sondern nach dem Schliessen das Protokoll umdatiert und die
   * Anwendung neu gestartet: dieselbe Wiederherstellung wie nach jedem Neustart.
   */
  const vorTagen = (n) => new Date(Date.now() - n * 86400000).toISOString();
  return {
    alt: {
      [ids['Alte Notiz ohne Verbindung']]: vorTagen(214),
      [ids['Espresso in der Praxis']]: vorTagen(151),
      [ids['Beetplanung']]: vorTagen(128),
      [ids['Datenschutz im Alltag']]: vorTagen(97),
      [ids['Crema']]: vorTagen(140),
      [ids['Brühtemperatur']]: vorTagen(139),
      [ids['Mahlgrad']]: vorTagen(138),
      [weitereIds['Leseliste']]: vorTagen(41),
      [weitereIds['Kompost']]: vorTagen(63),
      [weitereIds['Passwörter']]: vorTagen(58),
      [weitereIds['Wochenrückblick']]: vorTagen(22),
      [weitereIds['Bohrerständer']]: vorTagen(19),
      [weitereIds['Wäsche']]: vorTagen(33),
    },
  };
}

/**
 * Das Protokoll umdatieren. Gelesen wird jede Zeile, veraendert nur das Feld
 * `at` der genannten Saetze -- der Rest bleibt Zeichen fuer Zeichen stehen.
 */
function altern(logDir, alt) {
  let getroffen = 0;
  for (const datei of fs.readdirSync(logDir).sort()) {
    const voll = path.join(logDir, datei);
    const zeilen = fs.readFileSync(voll, 'utf8').split('\n');
    const neu = zeilen.map((zeile) => {
      if (!zeile.trim()) return zeile;
      let satz;
      try { satz = JSON.parse(zeile); } catch { return zeile; }
      const wann = alt[satz.id];
      if (!wann || !satz.at) return zeile;
      getroffen++;
      return JSON.stringify({ ...satz, at: wann });
    });
    fs.writeFileSync(voll, neu.join('\n'));
  }
  return getroffen;
}

module.exports = { befuellen, altern };
