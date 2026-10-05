import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput } from 'claude-code'

import type { RateWindow, Snapshot, Totals } from '../types'
import {
  HISTORY_LENGTH,
  barCells,
  cacheTtlMs,
  cacheView,
  elapsedFraction,
  formatDuration,
  formatPercent,
  formatTokens,
  formatWindow,
  inlineSummary,
  lastTurnDelta,
  miniText,
  paceOf,
  percentOf,
  shownLimits,
  terminalLayout,
  textReport,
  trendText,
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
const cacheAt = atom({ plugin: 'token-weather', key: 'cacheAt' } as const, null)
const cacheTtl = atom({ plugin: 'token-weather', key: 'cacheTtl' } as const, 0)
const lastHit = atom({ plugin: 'token-weather', key: 'lastHit' } as const, null)
const inline = atom({ plugin: 'token-weather', key: 'inline' } as const, false)

const INLINE_KEY = 'inline'

const MINIMIZED_KEY = 'minimized'

// The terminal draws with its own named colors and dim style, so the band
// follows whatever theme the terminal has, light or dark.
const PACE_COLOR = { ok: 'green', ahead: 'yellow', critical: 'red' }

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

/** The prompt cache's lifetime, from what Claude Code reads to pick it. */
async function readCacheTtl($: EngineInterface, limits: RateWindow[]): Promise<number> {
  try {
    const settings: Record<string, unknown> = await $.settings.read()

    return cacheTtlMs(
      {
        disabled: await $.env.get('DISABLE_PROMPT_CACHING'),
        force5m: await $.env.get('FORCE_PROMPT_CACHING_5M'),
        ttl: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
        setting: settings.promptCacheTtl,
        enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
      },
      limits,
    )
  } catch {
    return cacheTtlMs({}, limits)
  }
}

/** Keeps the latest figures and toasts once as the fill crosses 75% and 90%. */
async function remember($: EngineInterface, figures: Figures): Promise<void> {
  const next = toSnapshot(figures)
  next.rateLimits = await knownLimits($, next.rateLimits)
  await update($, snapshot, () => next)
  const ttl = await readCacheTtl($, next.rateLimits)
  await update($, cacheTtl, () => ttl)

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

/** Loads the saved choices, a minimized band and the summary under replies, into this session. */
async function loadView($: EngineInterface): Promise<void> {
  const saved = await $.store.get(MINIMIZED_KEY)
  await update($, minimized, () => saved === true)
  const isInline = (await $.store.get(INLINE_KEY)) === true
  await update($, inline, () => isInline)
}

/** Turns the summary under each reply on or off, and saves the choice. */
async function setInline($: EngineInterface, value: boolean): Promise<void> {
  await update($, inline, () => value)
  await $.store.set(INLINE_KEY, value)
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
      description: 'Show the forecast as text; "mini" or "full" shrinks or expands the band; "inline on" adds a summary under each reply',
      argumentHint: '[mini | full | inline on | inline off]',
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

    // Only the main thread's turns move the context window and its cache.
    if (e.agentId === undefined) {
      const repliedAt = await $.clock.now()
      await update($, cacheAt, () => repliedAt)
      const cached = usage.cache_read_input_tokens
      const input = usage.input_tokens + cached + usage.cache_creation_input_tokens
      await update($, lastHit, () => (input > 0 ? Math.round((cached / input) * 100) : null))
      const now = await $.session.usage()
      await remember($, now)
      const tokens = now.context.tokens
      if (tokens !== undefined) {
        await update($, history, past => [...past, tokens].slice(-HISTORY_LENGTH))
      }

      // The summary under the reply: a notice row, which Claude never reads,
      // so it reaches apps that draw no band without spending context.
      if (await read($, inline)) {
        const [snap, past, hit, ttl] = await Promise.all([read($, snapshot), read($, history), read($, lastHit), read($, cacheTtl)])
        if (snap !== null) {
          const text = inlineSummary(snap, past, hit, cacheView(repliedAt, ttl, repliedAt), repliedAt)
          try {
            await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
          } catch (error) {
            $.ui.log(`token-weather: the summary was not added: ${error instanceof Error ? error.message : String(error)}`, {
              to: 'debug',
            })
          }
        }
      }
    }

    return ran
  })

  // A compaction empties the window until the next reply measures it again.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.trigger !== 'precompute' && e.agentId === undefined && result.messages !== undefined) {
      await update($, cacheAt, () => null)
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
    const seconds = e.seconds_since_last_response
    const repliedAt = typeof seconds === 'number' ? (await $.clock.now()) - seconds * 1000 : null
    await update($, cacheAt, () => repliedAt)
    await remember($, await $.session.usage())

    return next(e)
  })

  // `/token-weather mini` and `full` switch the band; with no argument, the
  // band as text for any surface, saying whether the band was drawn.
  on('command.run', { command: 'token-weather' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase().replace(/\s+/g, ' ')
    if (arg === 'inline on' || arg === 'inline off') {
      await setInline($, arg === 'inline on')

      return {
        text:
          arg === 'inline on'
            ? 'token-weather: a summary now follows each reply (context, cache and plan). /token-weather inline off stops it.'
            : 'token-weather: no more summaries under replies.',
      }
    }
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
    const at = await $.clock.now()
    const lines = textReport(figures, past, sum, at, cacheView(await read($, cacheAt), await read($, cacheTtl), at))
    const surfaces = await $.session.surfaces()
    const seen = [...asked].map(([surface, times]) => `${surface} (${times}×)`)
    if (await read($, inline)) lines.push('Summary under each reply: on (/token-weather inline off stops it).')
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

    const [snap, past, sum, isMini, repliedAt, ttl] = await Promise.all([
      read($, snapshot),
      read($, history),
      read($, totals),
      read($, minimized),
      read($, cacheAt),
      read($, cacheTtl),
      read($, tick),
    ])
    if (snap === null) return next(e)

    const now = await $.clock.now()
    // Only while the window holds a measured conversation: after a compaction
    // nothing is cached until the next reply.
    const cache = snap.tokens === undefined ? undefined : cacheView(repliedAt, ttl, now)
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
      const band = desktopBand(
        snap,
        past,
        sum,
        now,
        e.props.bodyColumns * 8 - 40,
        textReport(snap, past, sum, now, cache).join('\n'),
        cache,
      )

      // `dismiss` has the app draw its own close control at the band's edge.
      return (
        <Box flexDirection="row" alignItems="flex-start" justifyContent="space-between">
          <Svg source={band.source} alt={band.alt} />
          <Button key="minimize" label="Minimize" role="dismiss" onPress={minimize} />
        </Box>
      )
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    // Sized to the window: a blank line above, bars that grow with the width,
    // and the right-hand items held at the band's right edge.
    const cacheLabel = cache === undefined ? '' : `◴ cache ${cache.text}`
    const size = terminalLayout(e.props.bodyColumns, cacheLabel.length > 0 ? cacheLabel.length + 2 : 0)

    if (isMini) {
      const [head, ...rest] = miniText(snap).split(' · ')

      return (
        <Box flexDirection="row" justifyContent="space-between" width={size.width} paddingTop={1}>
          <Box flexDirection="row" columnGap={2}>
            <Text color={weatherFor(snap.percent ?? 0).color} bold>
              {head}
            </Text>
            {rest.length > 0 && <Text dimColor>· {rest.join(' · ')}</Text>}
          </Box>
          <Button key="expand" label="expand" hotkey="e" plain dimColor onPress={expand} />
        </Box>
      )
    }

    const weather = weatherFor(snap.percent ?? 0)

    // A bar's runs: the fill in its color, the rest dim, the clock's marker bold.
    const barText = (cells: BarCell[], fill: string) => {
      const runs: { part: BarCell['part']; text: string }[] = []
      for (const cell of cells) {
        const last = runs.at(-1)
        if (last !== undefined && last.part === cell.part) last.text += cell.char
        else runs.push({ part: cell.part, text: cell.char })
      }

      return (
        <Box flexDirection="row">
          {runs.map(run =>
            run.part === 'fill' ? (
              <Text color={fill}>{run.text}</Text>
            ) : run.part === 'marker' ? (
              <Text bold>{run.text}</Text>
            ) : (
              <Text dimColor>{run.text}</Text>
            ),
          )}
        </Box>
      )
    }

    // Line one: the forecast.
    const forecast = (tokens: number, percent: number) => {
      const delta = lastTurnDelta(past)
      const blank = HISTORY_LENGTH - Math.min(HISTORY_LENGTH, past.length)

      return (
        <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2}>
          <Box flexDirection="row" columnGap={2}>
            <Text color={weather.color} bold>
              {weather.icon} {weather.word}
            </Text>
            <Text bold>{percent}%</Text>
            {barText(barCells(percent, undefined, size.gauge), weather.color)}
            <Box flexDirection="row">
              <Text>{formatTokens(tokens)}</Text>
              <Text dimColor> / {formatWindow(snap.window)}</Text>
            </Box>
            {cache !== undefined && (
              <Box flexDirection="row">
                <Text dimColor>◴ cache </Text>
                <Text bold={cache.tone !== 'ok'} color={cache.tone === 'ok' ? undefined : 'yellow'}>
                  {cache.text}
                </Text>
              </Box>
            )}
          </Box>
          <Box flexDirection="row" columnGap={2}>
            {past.length > 0 && (
              <Box flexDirection="row">
                {blank > 0 && <Text dimColor>{'·'.repeat(blank)}</Text>}
                <Text color={weather.color} dimColor>
                  {trendText(past)}
                </Text>
              </Box>
            )}
            {delta !== undefined && (
              <Text color={delta.delta < 0 ? 'green' : undefined} dimColor={delta.delta >= 0}>
                {delta.delta < 0 ? '-' : '+'}
                {formatTokens(Math.abs(delta.delta))} last turn
              </Text>
            )}
          </Box>
        </Box>
      )
    }

    const calm = (
      <Box flexDirection="row" columnGap={2}>
        <Text color={weather.color} bold>
          {weather.icon} {weather.word}
        </Text>
        <Text dimColor>forecast after the next reply · {formatWindow(snap.window)} window</Text>
      </Box>
    )

    // Line two: plan windows, tokens and cost, between dim separators.
    const rate = (limit: RateWindow) => {
      const elapsed = elapsedFraction(limit.kind, limit.resetsAt, now)
      const pace = paceOf(limit.percentUsed, elapsed)
      const icon = limit.kind === 'seven_day' ? '▦' : '◔'

      return (
        <Box flexDirection="row">
          <Text dimColor>
            {icon} {windowLabel(limit.kind)}{' '}
          </Text>
          {barText(barCells(limit.percentUsed, elapsed, size.bar), PACE_COLOR[pace])}
          <Text bold color={pace === 'ok' ? undefined : PACE_COLOR[pace]}>
            {' '}
            {formatPercent(limit.percentUsed)}
          </Text>
          {limit.resetsAt !== undefined && (
            <Text dimColor> · {formatDuration(Date.parse(limit.resetsAt) - now)}</Text>
          )}
        </Box>
      )
    }
    const inTokens = sum.input + sum.cacheWrite
    const segments = [
      ...shownLimits(snap).map(rate),
      <Box flexDirection="row" columnGap={1}>
        <Text color="green">↑{formatTokens(inTokens)}</Text>
        <Text color="red">↓{formatTokens(sum.output)}</Text>
        <Text dimColor>≋ {formatTokens(inTokens + sum.cacheRead + sum.output)}</Text>
      </Box>,
    ]
    if (snap.costUsd !== undefined && snap.costUsd > 0) segments.push(<Text>${snap.costUsd.toFixed(2)}</Text>)

    // On a wide window the segments spread evenly to the right edge; on a
    // narrow one they pack left and wrap.
    return (
      <Box flexDirection="column" width={size.width} paddingTop={1}>
        {snap.tokens === undefined || snap.percent === undefined ? calm : forecast(snap.tokens, snap.percent)}
        <Box
          flexDirection="row"
          flexWrap="wrap"
          justifyContent={size.isNarrow ? 'flex-start' : 'space-between'}
          columnGap={size.isNarrow ? 3 : 2}
        >
          {size.isNarrow
            ? segments
            : segments.flatMap((segment, i) => (i === 0 ? [segment] : [<Text dimColor>│</Text>, segment]))}
          <Button key="minimize" label="minimize" hotkey="m" plain dimColor onPress={minimize} />
        </Box>
        {level > 0 && (
          <Box flexDirection="row" columnGap={2}>
            <Box flexDirection="row">
              <Text color={level === 90 ? 'red' : 'yellow'} bold>
                {level === 90 ? '⚠ Compact now' : '☇ Consider compacting'}
              </Text>
              <Text dimColor> · run /compact</Text>
            </Box>
            {!e.props.isWorking && (
              <Button key="compact" label="Compact" hotkey="c" dimColor={level < 90} onPress={() => void compactNow($)} />
            )}
          </Box>
        )}
      </Box>
    )
  })
}
