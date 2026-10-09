import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { ChatEintrag } from '../types'

const MINUTE = 60_000
const START = 1_800_000_000_000
const ORDNER = '/Users/t/.claude/chat-anzeige'
const PRAESENTATION = { isFullscreen: false, columns: 120 }
const BAND = {
  plugin: 'chat-anzeige',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 110, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

// Ein zweiter Chat, der schon laeuft: 2 von 5 Aufgaben in 10 Minuten erledigt,
// also noch ca. 15 Minuten.
const ANDERER: ChatEintrag = {
  id: 'b',
  name: 'Rechnungen aus dem Postfach sortieren',
  ordner: 'buchhaltung',
  ziel: null,
  status: 'arbeitet',
  seit: START - 10 * MINUTE,
  aufgaben: { gesamt: 5, fertig: 2, aktuell: 'Lese Rechnung 3' },
  aufgabenStart: START - 10 * MINUTE,
  aktualisiert: START,
}

// Die Welt unter der Mod: ein Dateisystem im Speicher, Sitzung "a".
function welt(on: On) {
  const dateien = new Map<string, string>([[`${ORDNER}/b.json`, JSON.stringify(ANDERER)]])
  on('fs.write', (_$, e) => (dateien.set(e.path, e.text), { value: undefined }))
  on('fs.read', (_$, e) => ({ value: dateien.get(e.path) ?? '' }))
  on('fs.list', (_$, e) => ({
    value: [...dateien.keys()]
      .filter(p => p.startsWith(`${e.path}/`))
      .map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: START, isLink: false })),
  }))
  on('session.id', () => ({ value: 'a' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isOpen: true } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.run', () => ({ text: '' }))
  on('tool.call', () => ({ result: { oldTodos: [], newTodos: [] }, text: 'ok' }))

  return { eigen: () => JSON.parse(dateien.get(`${ORDNER}/a.json`) ?? 'null') as ChatEintrag | null }
}

async function aufgaben($: Engine, erledigt: number, gesamt: number) {
  const todos = Array.from({ length: gesamt }, (_, i) => ({
    content: `Schritt ${i + 1}`,
    activeForm: `Baue Schritt ${i + 1}`,
    status: i < erledigt ? ('completed' as const) : i === erledigt ? ('in_progress' as const) : ('pending' as const),
  }))
  await $.tool.call({ tool: 'TodoWrite', todos })
}

async function start($: Engine, on: On) {
  const uhr = mock.clock(on, { now: START })
  mock.store(on)
  mock.env(on, { HOME: '/Users/t' })
  const w = welt(on)
  await $.session.start({ cwd: '/Users/t/projekte/archiv', surface: 'terminal', isInteractive: true })

  return { uhr, w }
}

test('zeigt den eigenen und den anderen Chat mit Balken und Restzeit', async ($, on) => {
  const { uhr, w } = await start($, on)
  await $.prompt.submit({ text: 'Baue die Landingpage für das Archiv', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'Baue die Landingpage für das Archiv', turnId: 't1' })
  await aufgaben($, 0, 4)
  // Zwei Minuten: der andere Chat hat sein letztes Lebenszeichen vor zwei
  // Minuten gegeben und zaehlt noch (Grenze drei Minuten).
  await uhr.advance(2 * MINUTE)
  await aufgaben($, 2, 4)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const gezeichnet = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
    expect(await ui.find({ type: 'Text', text: /2 Chats, 2 offen/ }), gezeichnet).toBeDefined()
    // Eigener Chat: 2 von 4 in 2 Minuten, also noch ca. 2 Minuten.
    expect(await ui.find({ text: /Baue die Landingpage für das Archiv/ }), gezeichnet).toBeDefined()
    expect(await ui.find({ text: '(hier)' }), gezeichnet).toBeDefined()
    expect(await ui.find({ text: '██████░░░░░░ 2/4' }), gezeichnet).toBeDefined()
    expect(await ui.find({ text: 'noch ca. 2 Min' }), gezeichnet).toBeDefined()
    // Anderer Chat aus seiner Datei: 2 von 5 in 12 Minuten, also noch ca. 18.
    expect(await ui.find({ text: /Rechnungen aus dem Postfach sortieren/ }), gezeichnet).toBeDefined()
    expect(await ui.find({ text: '█████░░░░░░░ 2/5' }), gezeichnet).toBeDefined()
    expect(await ui.find({ text: 'noch ca. 18 Min' }), gezeichnet).toBeDefined()
    await ui.unmount()
  }
  expect(w.eigen()?.aufgaben).toEqual({ gesamt: 4, fertig: 2, aktuell: 'Baue Schritt 3' })
})

test('/goal ersetzt den Namen durch das Ziel, /goal clear nimmt es zurueck', async ($, on) => {
  const { w } = await start($, on)
  await $.command.run({ command: 'goal', args: 'Landingpage ist live und antwortet mit 200', origin: { kind: 'composer' }, presentation: PRAESENTATION })
  expect(w.eigen()?.ziel).toBe('Landingpage ist live und antwortet mit 200')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /Landingpage ist live und antwortet mit 200/ })).toBeDefined()
  await ui.unmount()
  await $.command.run({ command: 'goal', args: 'clear', origin: { kind: 'composer' }, presentation: PRAESENTATION })
  expect(w.eigen()?.ziel).toBeNull()
})

test('Status: arbeitet, wartet auf dich, fertig, beendet', async ($, on) => {
  const { uhr, w } = await start($, on)
  await $.turn.start({ text: 'los', turnId: 't1' })
  expect(w.eigen()?.status).toBe('arbeitet')
  await aufgaben($, 1, 3)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(w.eigen()?.status).toBe('wartet')
  await uhr.advance(3 * MINUTE)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: 'wartet auf dich seit 3 Min' })).toBeDefined()
  await ui.unmount()
  await $.turn.start({ text: 'weiter', turnId: 't2' })
  await aufgaben($, 3, 3)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  expect(w.eigen()?.status).toBe('fertig')
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'a', resume: { id: 'a' } } as never)
  expect(w.eigen()?.status).toBe('beendet')
})

test('/chats zeichnet dieselbe Liste als Fenster, auch in VS Code und auf dem Handy', async ($, on) => {
  await start($, on)
  const lief = await $.command.run({ command: 'chats', args: '', origin: { kind: 'composer' }, presentation: PRAESENTATION })
  expect(lief.text).toBe('Chat-Anzeige geöffnet.')
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'chat-anzeige',
      surface,
      component: 'Pane',
      requestId: 'chat-anzeige',
      props: { title: 'Chats', isFocused: false, bodyColumns: 80 } as never,
    })
    expect(await ui.find({ text: /Rechnungen aus dem Postfach sortieren/ }), surface).toBeDefined()
    await ui.unmount()
  }
})

test('ein Chat ohne Lebenszeichen seit drei Minuten verschwindet', async ($, on) => {
  const { uhr } = await start($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /Rechnungen aus dem Postfach/ })).toBeDefined()
  await uhr.advance(4 * MINUTE)
  expect(await ui.find({ text: /Rechnungen aus dem Postfach/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /1 Chat, 1 offen/ })).toBeDefined()
  await ui.unmount()
})
