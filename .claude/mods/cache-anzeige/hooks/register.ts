import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { CacheDauer, CacheStand } from '../types'

// Cache-Anzeige: zeigt in der Statuszeile, ob Claudes Prompt-Cache noch warm
// ist, wie lange noch, wie voll der Kontext ist und was es kostet, wenn alles
// neu eingelesen werden muss. Warnt einmal, kurz bevor der Cache kalt wird.

const LEER: CacheStand = { letzteAnfrage: null, modell: null, arbeitet: false, gewarnt: false }
const stand = atom({ plugin: 'cache-anzeige', key: 'stand' } as const, LEER)

const MINUTE = 60_000
const DAUER_MS = { '5m': 5 * MINUTE, '1h': 60 * MINUTE } as const
// So lange vor dem Ablauf kommt die Warnung.
const WARNUNG_MS = { '5m': 1 * MINUTE, '1h': 5 * MINUTE } as const

// Listenpreise in US-Dollar pro Million Tokens: Input und Cache-Lesen.
// Cache-Schreiben kostet das 1,25-fache des Inputs (5 Minuten) oder das
// Doppelte (1 Stunde). Quelle: Anthropic-Preistabelle, Stand 25.09.2026.
const PREISE: ReadonlyArray<readonly [string, string, number, number]> = [
  ['claude-fable-5-1', 'Fable 5.1', 10, 0.25],
  ['claude-mythos-5-1', 'Mythos 5.1', 10, 0.25],
  ['claude-fable-5', 'Fable 5', 10, 1],
  ['claude-opus-5-5', 'Opus 5.5', 4, 0.2],
  ['claude-opus-5', 'Opus 5', 5, 0.5],
  ['claude-opus-4', 'Opus 4', 5, 0.5],
  ['claude-sonnet-5-5', 'Sonnet 5.5', 2, 0.2],
  ['claude-sonnet-5', 'Sonnet 5', 2, 0.2],
  ['claude-sonnet-4', 'Sonnet 4', 3, 0.3],
  ['claude-haiku-4-5', 'Haiku 4.5', 1, 0.1],
]

function preisFuer(modell: string | null) {
  if (modell === null) return undefined
  const treffer = PREISE.filter(([kennung]) => modell.includes(kennung))
    .sort((a, b) => b[0].length - a[0].length)[0]
  if (treffer === undefined) return undefined
  const [, name, input, lesen] = treffer

  return { name, input, lesen }
}

function geld(usd: number) {
  if (usd < 0.01) return 'unter 0,01 $'

  return `${usd.toFixed(2).replace('.', ',')} $`
}

function tokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')} Mio`
  if (n >= 1000) return `${Math.round(n / 1000)}k`

  return String(n)
}

function dauer(ms: number) {
  const minuten = Math.floor(ms / MINUTE)
  if (minuten < 1) return 'unter 1 Min'
  if (minuten < 60) return `${minuten} Min`

  return `${Math.floor(minuten / 60)} Std ${minuten % 60} Min`
}

type Lage = {
  text: string
  details: string[]
  restMs: number | null
  ttl: '5m' | '1h'
  neuEinlesen: number | null
}

async function lage($: EngineInterface): Promise<Lage> {
  const jetzt = await $.clock.now()
  const s = await read($, stand)
  const nutzung = await $.session.usage()
  const eingestellt = ((await $.store.get('dauer')) ?? 'auto') as CacheDauer
  // Mit Abo (Pro, Max) cacht Claude Code eine Stunde, mit API-Schluessel fuenf
  // Minuten. Am Abo erkennbar: nur dort meldet die API Nutzungsfenster.
  const ttl = eingestellt === 'auto' ? (nutzung.rateLimits.length > 0 ? '1h' : '5m') : eingestellt
  const herkunft = eingestellt === 'auto' ? 'automatisch erkannt' : 'von dir eingestellt'

  const kontext = nutzung.context.tokens
  const preis = preisFuer(s.modell)
  const neuEinlesen =
    kontext !== undefined && preis !== undefined
      ? (kontext / 1_000_000) * preis.input * (ttl === '1h' ? 2 : 1.25)
      : null

  let cache: string
  let restMs: number | null = null
  if (s.letzteAnfrage === null) {
    cache = 'Cache noch leer'
  } else if (s.arbeitet) {
    cache = 'Cache warm, Claude arbeitet'
  } else {
    restMs = DAUER_MS[ttl] - (jetzt - s.letzteAnfrage)
    cache = restMs > 0 ? `Cache warm, noch ${dauer(restMs)}` : `Cache kalt seit ${dauer(-restMs)}`
  }

  const teile = [cache]
  if (kontext !== undefined) teile.push(`Kontext ${tokens(kontext)} von ${tokens(nutzung.context.window)}`)
  if (neuEinlesen !== null) teile.push(`neu einlesen ${geld(neuEinlesen)}`)
  if (nutzung.cost !== undefined) teile.push(`Sitzung ${geld(nutzung.cost.usd)} (API-Preis)`)

  const details = [
    `${cache} (Cache-Dauer ${ttl === '1h' ? '1 Stunde' : '5 Minuten'}, ${herkunft})`,
    kontext !== undefined
      ? `Kontext: ${kontext.toLocaleString('de-DE')} von ${nutzung.context.window.toLocaleString('de-DE')} Tokens (${nutzung.context.percent ?? 0} %)`
      : 'Kontext: noch keine Antwort in dieser Sitzung',
    neuEinlesen !== null && preis !== undefined
      ? `Neu einlesen, wenn er kalt ist: ${geld(neuEinlesen)} (Cache-Schreibpreis ${preis.name})`
      : 'Neu einlesen: Modell noch unbekannt, kein Preis',
    nutzung.cost !== undefined
      ? `Diese Sitzung bisher: ${geld(nutzung.cost.usd)} zum API-Preis`
      : 'Sitzungskosten: hier nicht verfügbar',
    'Mit Abo zahlst du das nicht direkt. Die Beträge zeigen, was dieselbe Arbeit über die API kosten würde.',
    'Cache-Dauer von Hand setzen: /cache 5m, /cache 1h, zurück mit /cache auto',
  ]

  return { text: teile.join(' · '), details, restMs, ttl, neuEinlesen }
}

async function zeichnen($: EngineInterface) {
  const l = await lage($)
  $.ui.status(l.text)

  const s = await read($, stand)
  const istKnapp = l.restMs !== null && l.restMs > 0 && l.restMs <= WARNUNG_MS[l.ttl]
  if (istKnapp && !s.gewarnt) {
    await update($, stand, alt => ({ ...alt, gewarnt: true }))
    const kosten = l.neuEinlesen !== null ? ` Danach kostet Neu-Einlesen ${geld(l.neuEinlesen)} zum API-Preis.` : ''
    $.ui.toast(`Cache wird in ${dauer(l.restMs ?? 0)} kalt.${kosten} Jetzt weiterschreiben hält ihn warm.`, {
      timeoutMs: 15_000,
    })
  }
}

export const register: Register = on => {
  let uhr: Timer | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cache',
      description: 'Cache-Anzeige: Stand im Detail, oder Cache-Dauer setzen (5m, 1h, auto)',
    })
    uhr?.cancel()
    uhr = $.clock.every(15_000, () => void zeichnen($))
    await zeichnen($)

    return next(e)
  })

  // Jede Anfrage im Hauptchat liest oder schreibt den Cache und setzt seine Uhr
  // neu. Gemessen wird ab dem Start der Anfrage, so zaehlt auch die API.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const jetzt = await $.clock.now()
      await update($, stand, alt => ({ ...alt, letzteAnfrage: jetzt, modell: e.model, gewarnt: false }))
    }

    return yield* next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, stand, alt => ({ ...alt, arbeitet: true }))
    await zeichnen($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ergebnis = await next(e)
    if (e.agentId === undefined) {
      await update($, stand, alt => ({ ...alt, arbeitet: false }))
      await zeichnen($)
    }

    return ergebnis
  })

  on('command.run', { command: 'cache' }, async ($, e) => {
    const wunsch = e.args.trim().toLowerCase()
    if (wunsch === '5m' || wunsch === '1h' || wunsch === 'auto') {
      await $.store.set('dauer', wunsch)
      await zeichnen($)

      return { text: `Cache-Dauer: ${wunsch === 'auto' ? 'automatisch erkennen' : wunsch}` }
    }
    if (wunsch !== '') return { text: 'Unbekannt. Möglich:/cache, /cache 5m, /cache 1h, /cache auto' }

    return { text: (await lage($)).details.join('\n') }
  })
}
