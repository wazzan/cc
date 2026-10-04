import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput } from 'claude-code'

import type { RateWindow, Snapshot, Totals } from '../types'
import {
  HISTORY_LENGTH,
  barCells,
  elapsedFraction,
  formatDuration,
  formatPercent,
  formatTokens,
  formatWindow,
  lastTurnDelta,
  miniText,
  paceOf,
  percentOf,
  shownLimits,
  sparkCells,
  textReport,
  warningLevel,
  weatherFor,
  windowLabel,
} from './weather'
import type { BarCell } from './weather'
import { desktopBand, desktopMini } from './desktop'

const ZERO: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const history = atom({ plugin: 'token-weather', key: 'history' } as const, [])
const snapshot = atom({ plugin: 'token-weather', key: 'snapshot' } as const, null)
const totals = atom({ plugin: 'token-weather', key: 'totals' } as const, ZERO)
const warned = atom({ plugin: 'token-weather', key: 'warned' } as const, 0)
const tick = atom({ plugin: 'token-weather', key: 'tick' } as const, 0)
const minimized = atom({ plugin: 'token-weather', key: 'minimized' } as const, false)

const MINIMIZED_KEY = 'minimized'

type Palette = { bg: string; fg: string; accent: string; track?: string }

// Dark-mode pills, after the pastel ones in the reference screenshot.
const CHIP = {
  fiveHour: { bg: '#16302a', fg: '#a7dcc6', accent: '#5fbf9a', track: '#33534a' },
  sevenDay: { bg: '#25213f', fg: '#c3bcff', accent: '#8f86f0', track: '#45406e' },
  input: { bg: '#3a211d', fg: '#f2ae9f', accent: '#e07a64' },
  output: { bg: '#1b3322', fg: '#a6dcae', accent: '#6cc47c' },
  total: { bg: '#1e2647', fg: '#b3c0ff', accent: '#7f93f5' },
  cost: { bg: '#352d1a', fg: '#ecd08a', accent: '#d4a93f' },
  storm: { bg: '#3a1d3a', fg: '#f0a6f0', accent: '#d070d0' },
  compact: { bg: '#45191f', fg: '#ffa3ab', accent: '#ff6b78' },
} satisfies Record<string, Palette>

const PACE_COLOR = { ok: '#7cc98f', ahead: '#e6b85c', critical: '#ef6f6c' }
const MARKER_COLOR = '#f4f4f4'

type Figures = Pick<SessionMeasureInput, 'context' | 'rateLimits' | 'cost'>

function toSnapshot({ context, rateLimits, cost }: Figures): Snapshot {
  const next: Snapshot = {
    window: context.window,
    rateLimits: rateLimits.map(({ kind, percentUsed, resetsAt }) => {
      const one: RateWindow = { kind, percentUsed }
      if (resetsAt !== undefined) one.resetsAt = resetsAt

      return one
    }),
  }
  if (context.tokens !== undefined) {
    next.tokens = context.tokens
    next.percent = context.percent ?? percentOf(context.tokens, context.window)
  }
  if (cost !== undefined) next.costUsd = cost.usd

  return next
}

const LIMITS_KEY = 'rate-limits'
let savedLimits = ''

/**
 * Plan windows are the account's, and a session only reads them off its own
 * replies: until it has one, the last reading any session saved stands in.
 */
async function knownLimits($: EngineInterface, fresh: RateWindow[]): Promise<RateWindow[]> {
  if (fresh.length > 0) {
    const json = JSON.stringify(fresh)
    if (json !== savedLimits) {
      savedLimits = json
      await $.store.set(LIMITS_KEY, fresh)
    }

    return fresh
  }
  const saved = await $.store.get(LIMITS_KEY)
  if (!Array.isArray(saved)) return []
  const now = await $.clock.now()

  return saved.flatMap((one: unknown): RateWindow[] => {
    if (typeof one !== 'object' || one === null) return []
    const { kind, percentUsed, resetsAt } = one as Record<string, unknown>
    if (typeof kind !== 'string' || typeof percentUsed !== 'number') return []
    if (typeof resetsAt !== 'string') return [{ kind, percentUsed }]
    // A window that has reset since starts again from nothing.
    if (Date.parse(resetsAt) <= now) return [{ kind, percentUsed: 0 }]

    return [{ kind, percentUsed, resetsAt }]
  })
}

/** Keeps the latest figures and toasts once as the fill crosses 75% and 90%. */
async function remember($: EngineInterface, figures: Figures): Promise<void> {
  const next = toSnapshot(figures)
  next.rateLimits = await knownLimits($, next.rateLimits)
  await update($, snapshot, () => next)

  const level = warningLevel(next.percent)
  let crossed = 0
  await update($, warned, before => {
    crossed = level > before ? level : 0

    return level
  })

  // A minimized band comes back on its own as the fill crosses 75% (and 90%),
  // for this session; the saved choice stays minimized.
  if (crossed > 0) await update($, minimized, () => false)

  const percent = next.percent ?? 0
  if (crossed === 90) {
    $.ui.toast(`↯ Context ${percent}% full: compact soon (/compact)`, { timeoutMs: 8000 })
  } else if (crossed === 75) {
    $.ui.toast(`☇ Storm ahead: context ${percent}% full, consider /compact`, { timeoutMs: 6000 })
  }
}

/** Loads the saved choice of a minimized band into this session. */
async function loadView($: EngineInterface): Promise<void> {
  const saved = await $.store.get(MINIMIZED_KEY)
  await update($, minimized, () => saved === true)
}

/** Minimizes or expands the band, and saves the choice for later sessions. */
async function setMinimized($: EngineInterface, value: boolean): Promise<void> {
  await update($, minimized, () => value)
  await $.store.set(MINIMIZED_KEY, value)
}

async function compactNow($: EngineInterface): Promise<void> {
  $.ui.toast('Compacting the conversation…')
  let result
  try {
    result = await $.session.compact()
  } catch (error) {
    $.ui.toast(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`)

    return
  }
  if (result.messages === undefined) {
    $.ui.toast(`Compaction skipped: ${result.skip}`)

    return
  }
  const { tokensBefore, tokensAfter } = result
  $.ui.toast(
    tokensBefore !== undefined && tokensAfter !== undefined
      ? `Compacted: ${formatTokens(tokensBefore)} → ${formatTokens(tokensAfter)}`
      : 'Compacted.',
  )
  // This plugin's own `session.compact` hook does not see its own call.
  await remember($, await $.session.usage())
}

export const register: Register = on => {
  // Which surfaces asked for the band since this module loaded, for /token-weather.
  const asked = new Map<string, number>()

  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({
      name: 'token-weather',
      description: 'Show the forecast as text; "mini" or "full" shrinks or expands the band',
      argumentHint: '[mini | full]',
    })
    await loadView($)
    const usage = await $.session.usage()
    await remember($, usage)
    // A resumed conversation already fills the window: start the chart there.
    const tokens = usage.context.tokens
    if (tokens !== undefined) await update($, history, past => (past.length > 0 ? past : [tokens]))
    // The reset countdowns move with the clock, not with turns.
    $.clock.every(60_000, () => {
      void update($, tick, n => n + 1)
    })

    return ran
  })

  // Pushed by the engine after each main-thread turn and whenever a plan
  // window moves a whole point.
  on('session.measure', async ($, e, next) => {
    await remember($, e)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    const usage = e.usage
    if (usage === undefined) return ran

    // Every loop's turns count toward the session's tokens, subagents' too.
    await update($, totals, sum => ({
      input: sum.input + usage.input_tokens,
      output: sum.output + usage.output_tokens,
      cacheRead: sum.cacheRead + usage.cache_read_input_tokens,
      cacheWrite: sum.cacheWrite + usage.cache_creation_input_tokens,
    }))

    // Only the main thread's turns move the context window.
    if (e.agentId === undefined) {
      const now = await $.session.usage()
      await remember($, now)
      const tokens = now.context.tokens
      if (tokens !== undefined) {
        await update($, history, past => [...past, tokens].slice(-HISTORY_LENGTH))
      }
    }

    return ran
  })

  // A compaction empties the window until the next reply measures it again.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.trigger !== 'precompute' && e.agentId === undefined && result.messages !== undefined) {
      await remember($, await $.session.usage())
    }

    return result
  })

  // /clear, /resume and /branch reset this mod's $.state and fire no
  // session.start, so start the forecast over from the engine's figures.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await update($, history, () => [])
    await update($, totals, () => ZERO)
    await update($, warned, () => 0)
    await loadView($)
    await remember($, await $.session.usage())

    return next(e)
  })

  // `/token-weather mini` and `full` switch the band; with no argument, the
  // band as text for any surface, saying whether the band was drawn.
  on('command.run', { command: 'token-weather' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (['mini', 'min', 'minimize', 'hide'].includes(arg)) {
      await setMinimized($, true)

      return { text: 'token-weather: minimized to one line. It expands on its own at 75% context; /token-weather full expands it now.' }
    }
    if (['full', 'show', 'expand', 'max'].includes(arg)) {
      await setMinimized($, false)

      return { text: 'token-weather: expanded.' }
    }
    const [snap, past, sum] = await Promise.all([read($, snapshot), read($, history), read($, totals)])
    const figures = snap ?? toSnapshot(await $.session.usage())
    const lines = textReport(figures, past, sum, await $.clock.now())
    const surfaces = await $.session.surfaces()
    const seen = [...asked].map(([surface, times]) => `${surface} (${times}×)`)
    lines.push(
      seen.length > 0
        ? `Band above the prompt: drawn on ${seen.join(', ')}.`
        : `Band above the prompt: never requested. Attached surfaces: ${surfaces.length > 0 ? surfaces.join(', ') : 'none'}; the app showing this session draws no mod bands, so use /token-weather here.`,
    )

    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    asked.set(e.surface, (asked.get(e.surface) ?? 0) + 1)
    if (e.props.hasSurvey) return next(e)

    const [snap, past, sum, isMini] = await Promise.all([
      read($, snapshot),
      read($, history),
      read($, totals),
      read($, minimized),
      read($, tick),
    ])
    if (snap === null) return next(e)

    const now = await $.clock.now()
    const level = warningLevel(snap.percent)
    const minimize = () => void setMinimized($, true)
    const expand = () => void setMinimized($, false)

    // The desktop app draws one SVG in its own palette: a transparent image,
    // so the band's own card shows through.
    if (e.surface === 'desktop') {
      const { Box, Svg, Button } = $.ui.resolve(e)
      if (isMini) {
        const mini = desktopMini(snap, now, miniText(snap))

        return (
          <Box flexDirection="row" alignItems="center" columnGap={2}>
            <Svg source={mini.source} alt={mini.alt} />
            <Button key="expand" label="Expand" dimColor onPress={expand} />
          </Box>
        )
      }
      const band = desktopBand(snap, past, sum, now, e.props.bodyColumns * 8 - 40, textReport(snap, past, sum, now).join('\n'))

      // `dismiss` has the app draw its own close control at the band's edge.
      return (
        <Box flexDirection="row" alignItems="flex-start" justifyContent="space-between">
          <Svg source={band.source} alt={band.alt} />
          <Button key="minimize" label="Minimize" role="dismiss" onPress={minimize} />
        </Box>
      )
    }

    const { Box, Text, Button } = $.ui.resolve(e)

    if (isMini) {
      const [head, ...rest] = miniText(snap).split(' · ')

      return (
        <Box flexDirection="row" columnGap={2}>
          <Text color={weatherFor(snap.percent ?? 0).color} bold>
            {head}
          </Text>
          {rest.length > 0 && <Text dimColor>· {rest.join(' · ')}</Text>}
          <Button key="expand" label="expand" hotkey="e" plain dimColor onPress={expand} />
        </Box>
      )
    }

    const barWidth = e.props.bodyColumns >= 120 ? 10 : 6

    const piece = (palette: Palette, text: string, color = palette.fg, bold = false) => (
      <Text color={color} backgroundColor={palette.bg} bold={bold}>
        {text}
      </Text>
    )

    const bar = (palette: Palette, cells: BarCell[], fillColor: string) => {
      // Runs of one part share a Text, so a bar is at most four elements.
      const runs: { part: BarCell['part']; text: string }[] = []
      for (const cell of cells) {
        const last = runs.at(-1)
        if (last !== undefined && last.part === cell.part) last.text += cell.char
        else runs.push({ part: cell.part, text: cell.char })
      }

      return runs.map(run =>
        piece(
          palette,
          run.text,
          run.part === 'fill' ? fillColor : run.part === 'marker' ? MARKER_COLOR : (palette.track ?? palette.fg),
          run.part === 'marker',
        ),
      )
    }

    const rateChip = (limit: RateWindow) => {
      const palette = limit.kind === 'seven_day' ? CHIP.sevenDay : CHIP.fiveHour
      const icon = limit.kind === 'seven_day' ? '▦' : '◔'
      const elapsed = elapsedFraction(limit.kind, limit.resetsAt, now)
      const pace = paceOf(limit.percentUsed, elapsed)
      const resetsIn =
        limit.resetsAt === undefined ? undefined : formatDuration(Date.parse(limit.resetsAt) - now)

      return (
        <Box flexDirection="row" backgroundColor={palette.bg}>
          {piece(palette, ` ${icon} `, palette.accent)}
          {piece(palette, `${windowLabel(limit.kind)} `)}
          {bar(palette, barCells(limit.percentUsed, elapsed, barWidth), PACE_COLOR[pace])}
          {piece(palette, ` ${formatPercent(limit.percentUsed)} `, pace === 'ok' ? '#ffffff' : PACE_COLOR[pace], true)}
          {resetsIn !== undefined && piece(palette, '│', palette.track)}
          {resetsIn !== undefined && piece(palette, ' ↻ ', palette.accent)}
          {resetsIn !== undefined && piece(palette, `${resetsIn} `)}
        </Box>
      )
    }

    const countChip = (palette: Palette, icon: string, value: string) => (
      <Box flexDirection="row" backgroundColor={palette.bg}>
        {piece(palette, ` ${icon} `, palette.accent)}
        {piece(palette, `${value} `)}
      </Box>
    )

    // Line one: the forecast.
    const forecast = (tokens: number, percent: number) => {
      const weather = weatherFor(percent)
      const spark = sparkCells(past, snap.window)
      const delta = lastTurnDelta(past)
      const blank = HISTORY_LENGTH - spark.length

      return (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text color={weather.color} bold>
            {weather.icon} {weather.word}
          </Text>
          <Text color={weather.color} bold>
            {percent}%
          </Text>
          <Text>
            {formatTokens(tokens)} / {formatWindow(snap.window)}
          </Text>
          {spark.length > 0 && (
            <Box flexDirection="row">
              {blank > 0 && <Text dimColor>{'·'.repeat(blank)}</Text>}
              {spark.map(cell => (
                <Text color={cell.color}>{cell.char}</Text>
              ))}
            </Box>
          )}
          {delta !== undefined && (
            <Text color={delta.delta < 0 ? 'green' : undefined} dimColor={delta.delta >= 0}>
              {delta.text} last turn
            </Text>
          )}
        </Box>
      )
    }

    const calm = (
      <Box flexDirection="row" columnGap={2}>
        <Text color="yellow" bold>
          ☀ Clear
        </Text>
        <Text dimColor>forecast after the next reply · {formatWindow(snap.window)} window</Text>
      </Box>
    )

    // Line two: plan windows, tokens, cost, and the compaction warning.
    const inTokens = sum.input + sum.cacheWrite
    const allTokens = inTokens + sum.cacheRead + sum.output
    const limits = shownLimits(snap)
    const warning = level === 0 ? undefined : level === 90 ? CHIP.compact : CHIP.storm

    return (
      <Box flexDirection="column">
        {snap.tokens === undefined || snap.percent === undefined ? calm : forecast(snap.tokens, snap.percent)}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {limits.map(rateChip)}
          {countChip(CHIP.input, '↑', formatTokens(inTokens))}
          {countChip(CHIP.output, '↓', formatTokens(sum.output))}
          {countChip(CHIP.total, '≋', formatTokens(allTokens))}
          {snap.costUsd !== undefined && snap.costUsd > 0 && countChip(CHIP.cost, '$', snap.costUsd.toFixed(2))}
          {warning !== undefined && (
            <Box flexDirection="row" backgroundColor={warning.bg}>
              {piece(warning, level === 90 ? ' ⚠ ' : ' ☇ ', warning.accent, true)}
              {piece(warning, level === 90 ? 'compact now ' : 'consider /compact ', warning.fg, level === 90)}
            </Box>
          )}
          {warning !== undefined && !e.props.isWorking && (
            <Button key="compact" label="Compact" hotkey="c" dimColor={level < 90} onPress={() => void compactNow($)} />
          )}
          <Button key="minimize" label="minimize" hotkey="m" plain dimColor onPress={minimize} />
        </Box>
      </Box>
    )
  })
}
