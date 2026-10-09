import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const MINUTE = 60_000
const PRAESENTATION = { isFullscreen: false, columns: 120 }

// Die Welt unter der Mod: eine Sitzung mit Abo (Nutzungsfenster gemeldet),
// 200.000 Tokens Kontext von 1 Mio, 3,20 Dollar zum API-Preis.
function welt(on: On, mitAbo = true) {
  const zeilen: Array<string | undefined> = []
  const toasts: string[] = []
  on('ui.status', (_$, e) => (zeilen.push(e.text), { value: undefined }))
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 200_000, window: 1_000_000, percent: 20 },
      rateLimits: mitAbo ? [{ kind: 'five_hour', percentUsed: 12 }] : [],
      cost: { usd: 3.2 },
    },
  }))
  // Unter der Mod laeuft kein echter Befehl: unbekannte Befehle enden hier.
  on('command.run', () => ({ text: 'kein solcher Befehl' }))

  return { zeilen, toasts, letzte: () => zeilen.at(-1) ?? '' }
}

async function einZug($: Engine) {
  await $.turn.start({ text: 'los', turnId: 't1' })
  const schritt = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of schritt) {
    // nichts, nur durchlaufen lassen
  }
  await $.turn.complete({ answer: 'fertig', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
}

test('vor der ersten Antwort ist der Cache leer', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const w = welt(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(w.letzte()).toStartWith('Cache noch leer')
})

test('nach einem Zug: warm, Restzeit, Kontext, Neu-Einlesen und Sitzungskosten', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const w = welt(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await einZug($)
  // Abo erkannt: eine Stunde Cache. 200k Tokens zum doppelten Opus-5.5-Inputpreis
  // (4 $ je Mio) ergeben 1,60 $.
  expect(w.letzte()).toBe(
    'Cache warm, noch 1 Std 0 Min · Kontext 200k von 1,0 Mio · neu einlesen 1,60 $ · Sitzung 3,20 $ (API-Preis)',
  )
})

test('warnt einmal kurz vor dem Ablauf und meldet danach kalt', async ($, on) => {
  const uhr = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const w = welt(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await einZug($)
  await uhr.advance(56 * MINUTE)
  expect(w.letzte()).toStartWith('Cache warm, noch 4 Min')
  expect(w.toasts).toHaveLength(1)
  // Die Warnung kommt beim ersten Takt mit hoechstens fuenf Minuten Rest.
  expect(w.toasts[0]).toContain('Cache wird in 5 Min kalt')
  expect(w.toasts[0]).toContain('1,60 $')
  await uhr.advance(2 * MINUTE)
  expect(w.toasts).toHaveLength(1)
  await uhr.advance(3 * MINUTE)
  expect(w.letzte()).toStartWith('Cache kalt seit 1 Min')
})

test('ohne Abo rechnet sie mit fuenf Minuten und dem 1,25-fachen Schreibpreis', async ($, on) => {
  const uhr = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const w = welt(on, false)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await einZug($)
  expect(w.letzte()).toBe(
    'Cache warm, noch 5 Min · Kontext 200k von 1,0 Mio · neu einlesen 1,00 $ · Sitzung 3,20 $ (API-Preis)',
  )
  await uhr.advance(6 * MINUTE)
  expect(w.letzte()).toStartWith('Cache kalt seit 1 Min')
})

test('/cache 5m stellt die Dauer von Hand um, /cache zeigt die Details', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const w = welt(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await einZug($)
  const gesetzt = await $.command.run({ command: 'cache', args: '5m', origin: { kind: 'composer' }, presentation: PRAESENTATION })
  expect(gesetzt.text).toBe('Cache-Dauer: 5m')
  expect(w.letzte()).toStartWith('Cache warm, noch 5 Min')
  const details = await $.command.run({ command: 'cache', args: '', origin: { kind: 'composer' }, presentation: PRAESENTATION })
  expect(details.text).toContain('Cache-Dauer 5 Minuten, von dir eingestellt')
  expect(details.text).toContain('Kontext: 200.000 von 1.000.000 Tokens (20 %)')
  expect(details.text).toContain('Cache-Schreibpreis Opus 5.5')
})
