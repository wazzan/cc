// Pure helpers: no `$`, so the tests can call them directly.

import type { RateWindow, Snapshot, Totals } from '../types'

export type Weather = { icon: string; word: string; color: string }

export const HISTORY_LENGTH = 12

const SPARKS = '▁▂▃▄▅▆▇█'

const HOUR = 60 * 60 * 1000

/** How long each known plan window lasts, for the "where am I in it" marker. */
const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * HOUR,
  seven_day: 7 * 24 * HOUR,
}

export function weatherFor(percent: number): Weather {
  if (percent >= 90) return { icon: '↯', word: 'Compact soon', color: 'red' }
  if (percent >= 75) return { icon: '☇', word: 'Storm', color: 'magenta' }
  if (percent >= 50) return { icon: '☂', word: 'Showers', color: 'blue' }
  if (percent >= 25) return { icon: '☁', word: 'Cloudy', color: 'cyan' }

  return { icon: '☀', word: 'Clear', color: 'yellow' }
}

/** 842 → "842", 134_400 → "134.4k", 3_000 → "3.0k", 1_250_000 → "1.3M". */
export function formatTokens(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1000) return String(Math.round(n))
  if (abs < 1_000_000) return `${(n / 1000).toFixed(1)}k`

  return `${(n / 1_000_000).toFixed(1)}M`
}

/** A window size, without a trailing ".0": 200_000 → "200k", 1_000_000 → "1M". */
export function formatWindow(n: number): string {
  return formatTokens(n).replace(/\.0(?=[kM]$)/, '')
}

export function percentOf(tokens: number, window: number): number {
  return window > 0 ? Math.round((tokens / window) * 100) : 0
}

/** One bar per turn, scaled to the whole window and colored by its weather. */
export function sparkCells(history: number[], window: number): { char: string; color: string }[] {
  return history.slice(-HISTORY_LENGTH).map(tokens => {
    const percent = window > 0 ? (tokens / window) * 100 : 0
    const level = Math.max(0, Math.min(SPARKS.length - 1, Math.floor((percent / 100) * SPARKS.length)))

    return { char: SPARKS[level] ?? '▁', color: weatherFor(percent).color }
  })
}

/** "▲ +98.3k", "▼ −52.1k" or "► ±0"; undefined until two readings. */
export function lastTurnDelta(history: number[]): { text: string; delta: number } | undefined {
  const last = history.at(-1)
  const before = history.at(-2)
  if (last === undefined || before === undefined) return undefined
  const delta = last - before
  if (delta > 0) return { text: `▲ +${formatTokens(delta)}`, delta }
  if (delta < 0) return { text: `▼ −${formatTokens(-delta)}`, delta }

  return { text: '► ±0', delta }
}

/** 9_600_000 → "2h 40m", 112_000_000 → "1d 7h", 300_000 → "5m". */
export function formatDuration(ms: number): string {
  if (ms <= 0) return 'now'
  const minutes = Math.ceil(ms / 60_000)
  const days = Math.floor(minutes / (24 * 60))
  const hours = Math.floor((minutes % (24 * 60)) / 60)
  const mins = minutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`

  return `${mins}m`
}

export function windowLabel(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return '7d'
  if (kind === 'spend_limit') return 'spend'

  return kind.replace(/_/g, ' ')
}

/** How far through its window the clock is, 0..1; undefined when unknown. */
export function elapsedFraction(kind: string, resetsAt: string | undefined, now: number): number | undefined {
  const length = WINDOW_MS[kind]
  if (length === undefined || resetsAt === undefined) return undefined
  const resetMs = Date.parse(resetsAt)
  if (Number.isNaN(resetMs)) return undefined

  return Math.max(0, Math.min(1, 1 - (resetMs - now) / length))
}

export type Pace = 'ok' | 'ahead' | 'critical'

/** Ahead of pace when usage runs 10 points past the share of time gone by. */
export function paceOf(percentUsed: number, elapsed: number | undefined): Pace {
  if (percentUsed >= 90) return 'critical'
  if (elapsed !== undefined && percentUsed > elapsed * 100 + 10) return 'ahead'

  return 'ok'
}

export type BarCell = { char: string; part: 'fill' | 'track' | 'marker' }

/** A bar of `width` cells: the used share filled, a marker where the clock is. */
export function barCells(percentUsed: number, elapsed: number | undefined, width: number): BarCell[] {
  const filled = Math.round((Math.max(0, Math.min(100, percentUsed)) / 100) * width)
  const marker = elapsed === undefined ? -1 : Math.min(width - 1, Math.floor(elapsed * width))

  return Array.from({ length: width }, (_, i): BarCell => {
    if (i === marker) return { char: '┃', part: 'marker' }

    return i < filled ? { char: '━', part: 'fill' } : { char: '━', part: 'track' }
  })
}

export function formatPercent(percent: number): string {
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`
}

/** Which compaction warning a fill calls for: 0 none, 75 consider, 90 now. */
export function warningLevel(percent: number | undefined): 0 | 75 | 90 {
  if (percent === undefined) return 0
  if (percent >= 90) return 90
  if (percent >= 75) return 75

  return 0
}

/** The bar as plain text: ▰ used, ▱ free, ┃ where the clock is. */
export function textBar(percentUsed: number, elapsed: number | undefined, width: number): string {
  return barCells(percentUsed, elapsed, width)
    .map(cell => (cell.part === 'marker' ? '┃' : cell.part === 'fill' ? '▰' : '▱'))
    .join('')
}

/** The band as plain lines, for surfaces that draw no band (`/token-weather`). */
export function textReport(snap: Snapshot, history: number[], totals: Totals, now: number): string[] {
  const lines: string[] = []

  if (snap.tokens === undefined || snap.percent === undefined) {
    lines.push(`☀ Clear  forecast after the next reply · ${formatWindow(snap.window)} window`)
  } else {
    const weather = weatherFor(snap.percent)
    const spark = sparkCells(history, snap.window).map(cell => cell.char).join('')
    const blank = '·'.repeat(HISTORY_LENGTH - Math.min(HISTORY_LENGTH, history.length))
    const delta = lastTurnDelta(history)
    lines.push(
      [
        `${weather.icon} ${weather.word}`,
        `${snap.percent}%`,
        `${formatTokens(snap.tokens)} / ${formatWindow(snap.window)}`,
        history.length > 0 ? blank + spark : undefined,
        delta === undefined ? undefined : `${delta.text} last turn`,
      ]
        .filter(part => part !== undefined)
        .join('  '),
    )
  }

  const limits = snap.rateLimits
    .filter(limit => limit.kind !== 'spend_limit' || limit.percentUsed > 0)
    .map(limit => {
      const elapsed = elapsedFraction(limit.kind, limit.resetsAt, now)
      const icon = limit.kind === 'seven_day' ? '▦' : '◔'
      const resets =
        limit.resetsAt === undefined ? '' : ` ↻ ${formatDuration(Date.parse(limit.resetsAt) - now)}`

      return `${icon} ${windowLabel(limit.kind)} ${textBar(limit.percentUsed, elapsed, 10)} ${formatPercent(limit.percentUsed)}${resets}`
    })
  if (limits.length > 0) lines.push(limits.join('   '))

  const inTokens = totals.input + totals.cacheWrite
  const counts = [
    `↑ ${formatTokens(inTokens)} in`,
    `↓ ${formatTokens(totals.output)} out`,
    `≋ ${formatTokens(inTokens + totals.cacheRead + totals.output)} total`,
  ]
  if (snap.costUsd !== undefined && snap.costUsd > 0) counts.push(formatUsd(snap.costUsd))
  lines.push(counts.join('   '))

  const level = warningLevel(snap.percent)
  if (level === 90) lines.push(`⚠ Context ${snap.percent}% full: compact now (/compact)`)
  else if (level === 75) lines.push(`☇ Context ${snap.percent}% full: consider /compact`)

  return lines
}

/** The plan windows worth a chip: every window, and a spend limit once it has spend. */
export function shownLimits(snap: Snapshot): RateWindow[] {
  return snap.rateLimits.filter(limit => limit.kind !== 'spend_limit' || limit.percentUsed > 0)
}

/** The minimized band as one line: "☁ 39% · 5h 20% · 7d 58%". */
export function miniText(snap: Snapshot): string {
  const weather = weatherFor(snap.percent ?? 0)
  const head = snap.percent === undefined ? `${weather.icon} ${weather.word}` : `${weather.icon} ${snap.percent}%`
  const limits = shownLimits(snap).map(limit => `${windowLabel(limit.kind)} ${formatPercent(limit.percentUsed)}`)

  return [head, ...limits].join(' · ')
}

/** The last turns as a trend, ▁ to ▇ from the lowest turn shown to the highest. */
export function trendText(history: number[]): string {
  const points = history.slice(-HISTORY_LENGTH)
  const low = Math.min(...points)
  const span = Math.max(...points) - low
  const levels = '▁▂▃▄▅▆▇'

  return points
    .map(tokens => levels[span > 0 ? Math.min(levels.length - 1, Math.floor(((tokens - low) / span) * levels.length)) : 0] ?? '▁')
    .join('')
}
