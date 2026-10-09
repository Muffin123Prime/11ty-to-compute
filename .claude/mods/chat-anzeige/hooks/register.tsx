import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ResolveInput, Timer } from 'claude-code'

import type { ChatEintrag, ChatStatus } from '../types'

// Chat-Anzeige: jeder offene Chat schreibt seinen Stand in eine kleine Datei
// unter ~/.claude/chat-anzeige/, jeder Chat liest alle und zeigt sie als Liste
// ueber dem Eingabefeld: Ziel, Fortschritt der Aufgabenliste, Restzeit.

const eigen = atom({ plugin: 'chat-anzeige', key: 'eigen' } as const, null)
const chats = atom({ plugin: 'chat-anzeige', key: 'chats' } as const, [])
const ordnerPfad = atom({ plugin: 'chat-anzeige', key: 'ordnerPfad' } as const, null)

const PANE = 'chat-anzeige'
const MINUTE = 60_000
// Ohne Lebenszeichen so lange gilt ein Chat als geschlossen.
const TOT_NACH_MS = 3 * MINUTE
const BALKEN = 12

function minuten(ms: number) {
  const m = Math.round(ms / MINUTE)
  if (m < 1) return 'unter 1 Min'
  if (m < 60) return `${m} Min`

  return `${Math.floor(m / 60)} Std ${m % 60} Min`
}

function balken(fertig: number, gesamt: number) {
  const voll = gesamt === 0 ? 0 : Math.round((fertig / gesamt) * BALKEN)

  return '█'.repeat(voll) + '░'.repeat(BALKEN - voll)
}

/** Restzeit aus dem bisherigen Tempo: Zeit je erledigter Aufgabe mal die offenen. */
function restzeit(c: ChatEintrag, jetzt: number) {
  const { fertig, gesamt } = c.aufgaben
  if (c.aufgabenStart === null || fertig === 0 || fertig >= gesamt) return null

  return ((jetzt - c.aufgabenStart) / fertig) * (gesamt - fertig)
}

function beschriftung(c: ChatEintrag) {
  return c.ziel ?? (c.name !== '' ? c.name : c.ordner)
}

const REIHENFOLGE: Record<ChatStatus, number> = { arbeitet: 0, wartet: 1, fertig: 2, beendet: 3 }

async function schreiben($: EngineInterface) {
  const e = await read($, eigen)
  const pfad = await read($, ordnerPfad)
  if (e === null || pfad === null) return
  await $.fs.write(`${pfad}/${e.id}.json`, JSON.stringify(e))
}

async function aendern($: EngineInterface, fn: (alt: ChatEintrag) => ChatEintrag) {
  const jetzt = await $.clock.now()
  await update($, eigen, alt => (alt === null ? alt : { ...fn(alt), aktualisiert: jetzt }))
  await schreiben($)
  await sammeln($)
}

async function sammeln($: EngineInterface) {
  const jetzt = await $.clock.now()
  const pfad = await read($, ordnerPfad)
  const e = await read($, eigen)
  const gefunden: ChatEintrag[] = []

  if (pfad !== null) {
    const dateien = await $.fs.list(pfad).catch(() => [])
    for (const d of dateien) {
      if (d.kind !== 'file' || !d.name.endsWith('.json')) continue
      if (jetzt - d.mtimeMs > TOT_NACH_MS) continue
      if (e !== null && d.name === `${e.id}.json`) continue
      try {
        const c = JSON.parse(await $.fs.read(`${pfad}/${d.name}`)) as ChatEintrag
        if (c.status !== 'beendet' && jetzt - c.aktualisiert <= TOT_NACH_MS) gefunden.push(c)
      } catch {
        // halb geschriebene oder fremde Datei: beim naechsten Takt wieder
      }
    }
  }
  if (e !== null) gefunden.push(e)
  gefunden.sort((a, b) => REIHENFOLGE[a.status] - REIHENFOLGE[b.status] || a.seit - b.seit)
  await update($, chats, () => gefunden)
}

async function zeichnen($: EngineInterface, e: ResolveInput, platz: number) {
  const { Box, Text } = $.ui.resolve(e)
  const alle = await read($, chats)
  const ich = await read($, eigen)
  const jetzt = await $.clock.now()
  const offen = alle.filter(c => c.status !== 'fertig').length
  const sichtbar = alle.slice(0, Math.max(1, platz - 1))

  return (
    <Box flexDirection="column" key="chats">
      <Text>
        <Text bold>Chats</Text>
        <Text dimColor>
          {' '}
          · {alle.length === 1 ? '1 Chat' : `${alle.length} Chats`}, {offen} offen
        </Text>
      </Text>
      {sichtbar.map(c => {
        const rest = restzeit(c, jetzt)
        const zeichen = c.status === 'arbeitet' ? '●' : c.status === 'fertig' ? '✓' : '◌'
        const farbe = c.status === 'arbeitet' ? 'yellow' : c.status === 'fertig' ? 'green' : 'gray'
        const info =
          c.status === 'fertig'
            ? 'fertig'
            : c.status === 'wartet'
              ? `wartet auf dich seit ${minuten(jetzt - c.seit)}`
              : rest !== null
                ? `noch ca. ${minuten(rest)}`
                : (c.aufgaben.aktuell ?? 'arbeitet')
        const hier = ich !== null && c.id === ich.id ? ' (hier)' : ''

        return (
          <Box flexDirection="row" key={`chat-${c.id}`} gap={1}>
            <Text color={farbe}>{zeichen}</Text>
            <Box flexGrow={1} flexShrink={1} minWidth={8}>
              <Text wrap="truncate-end">
                {beschriftung(c)}
                <Text dimColor>{hier}</Text>
              </Text>
            </Box>
            {c.aufgaben.gesamt > 0 && (
              <Text color={farbe}>
                {balken(c.aufgaben.fertig, c.aufgaben.gesamt)} {c.aufgaben.fertig}/{c.aufgaben.gesamt}
              </Text>
            )}
            <Box flexShrink={0}>
              <Text dimColor>{info}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

export const register: Register = on => {
  let uhren: Timer[] = []

  on('session.start', async ($, e, next) => {
    const jetzt = await $.clock.now()
    const id = await $.session.id()
    const home = await $.env.get('HOME')
    await update($, ordnerPfad, () => (home !== undefined ? `${home}/.claude/chat-anzeige` : null))
    const ordner = e.cwd.split('/').filter(Boolean).at(-1) ?? e.cwd
    const frisch: ChatEintrag = {
      id,
      name: '',
      ordner,
      ziel: null,
      status: 'wartet',
      seit: jetzt,
      aufgaben: { gesamt: 0, fertig: 0, aktuell: null },
      aufgabenStart: null,
      aktualisiert: jetzt,
    }
    // Nach einem Neuladen der Mod bleibt der Stand derselben Sitzung stehen.
    await update($, eigen, alt => (alt !== null && alt.id === id ? alt : frisch))
    await $.command.register({ name: 'chats', description: 'Chat-Anzeige: alle offenen Chats als Fenster' })

    for (const u of uhren) u.cancel()
    uhren = [
      $.clock.every(5_000, () => void sammeln($)),
      $.clock.every(MINUTE, () => void aendern($, alt => alt)),
    ]
    await aendern($, alt => alt)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    for (const u of uhren) u.cancel()
    await aendern($, alt => ({ ...alt, status: 'beendet' }))

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const s = await read($, eigen)
    if (s !== null && s.name === '' && !e.text.startsWith('/')) {
      const name = e.text.replace(/\s+/g, ' ').trim().slice(0, 60)
      await aendern($, alt => ({ ...alt, name }))
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const jetzt = await $.clock.now()
    await aendern($, alt => ({ ...alt, status: 'arbeitet', seit: jetzt }))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ergebnis = await next(e)
    if (e.agentId === undefined) {
      const jetzt = await $.clock.now()
      await aendern($, alt => {
        const allesErledigt = alt.aufgaben.gesamt > 0 && alt.aufgaben.fertig === alt.aufgaben.gesamt

        return { ...alt, status: allesErledigt ? 'fertig' : 'wartet', seit: jetzt }
      })
    }

    return ergebnis
  })

  // Fortschritt: die Aufgabenliste, die Claude sich selbst fuehrt.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const lief = await next(e)
    if (e.agentId !== undefined || lief.deny !== undefined || lief.isError === true) return lief
    const jetzt = await $.clock.now()
    const gesamt = e.todos.length
    const fertig = e.todos.filter(t => t.status === 'completed').length
    const aktuell = e.todos.find(t => t.status === 'in_progress')?.activeForm ?? null
    await aendern($, alt => {
      // Neue Liste (noch nichts erledigt) startet die Uhr neu, sonst laeuft sie weiter.
      const neu = fertig === 0 && (alt.aufgabenStart === null || alt.aufgaben.fertig > 0 || gesamt !== alt.aufgaben.gesamt)
      const start = neu || alt.aufgabenStart === null ? jetzt : alt.aufgabenStart

      return { ...alt, aufgaben: { gesamt, fertig, aktuell }, aufgabenStart: gesamt === 0 ? null : start }
    })

    return lief
  })

  // Ziel: von Claude vorgeschlagen und angenommen ...
  on('tool.call', { tool: 'ProposeGoal' }, async ($, e, next) => {
    const lief = await next(e)
    if (e.agentId === undefined && lief.deny === undefined && lief.isError !== true) {
      await aendern($, alt => ({ ...alt, ziel: e.condition.slice(0, 120) }))
    }

    return lief
  })

  // ... oder von dir gesetzt mit /goal.
  on('command.run', { command: 'goal' }, async ($, e, next) => {
    const ziel = e.args.trim()
    if (ziel === 'clear') await aendern($, alt => ({ ...alt, ziel: null }))
    else if (ziel !== '') await aendern($, alt => ({ ...alt, ziel: ziel.slice(0, 120) }))

    return next(e)
  })

  on('command.run', { command: 'chats' }, async $ => {
    await sammeln($)
    await $.ui.open({ id: PANE, title: 'Chats' })

    return { text: 'Chat-Anzeige geöffnet.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    return zeichnen($, e, e.props.maxRows)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => zeichnen($, e, (e.viewport?.rows ?? 24) - 2))
}
