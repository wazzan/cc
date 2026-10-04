// The band for the desktop app: one transparent SVG drawn in the app's own
// dark palette, a forecast line over gray chips like its diff chip. Pure, no `$`.

import type { RateWindow, Snapshot, Totals } from '../types'
import type { CacheView } from './weather'
import {
  HISTORY_LENGTH,
  elapsedFraction,
  formatDuration,
  formatPercent,
  formatTokens,
  formatWindow,
  lastTurnDelta,
  paceOf,
  shownLimits,
  warningLevel,
  weatherFor,
  windowLabel,
} from './weather'

// The desktop app's colors, sampled from its Code tab.
const APP = {
  chip: '#373737',
  inChipTrack: '#505050',
  divider: '#4a4a4a',
  text: '#f0efec',
  muted: '#898782',
  green: '#6bd45f',
  red: '#eb445b',
  amber: '#d09533',
}

const WEATHER_HEX: Record<string, string> = {
  yellow: '#e2b84a',
  cyan: '#8fb8c9',
  blue: '#79a8e8',
  magenta: '#c38be0',
  red: APP.red,
}

const PACE = { ok: APP.green, ahead: APP.amber, critical: APP.red }

const SANS = "system-ui, -apple-system, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif"
const MONO = "'SF Mono', SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace"

// Advance per character as a share of the font size: exact for a monospace
// face, and generous for the sans so a label never runs into what follows.
const MONO_ADVANCE = 0.6
const SANS_ADVANCE = 0.6

const SIZE = 13
const LINE_HEIGHT = 22
const CHIP_HEIGHT = 28
const CHIP_PAD = 10
const CHIP_GAP = 8
const ITEM_GAP = 7
const ROW_GAP = 10

// Stroke icons in a 16 by 16 box, after Lucide's.
const ICON = {
  gauge: '<path d="M2.5 11.5a5.5 5.5 0 1 1 11 0"/><path d="M8 11.5l2.6-3.6"/>',
  calendar:
    '<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 7h11"/><path d="M5.5 2v3"/><path d="M10.5 2v3"/>',
  up: '<path d="M8 13V3"/><path d="M4.5 6.5 8 3l3.5 3.5"/>',
  down: '<path d="M8 3v10"/><path d="M4.5 9.5 8 13l3.5-3.5"/>',
  layers: '<path d="M8 2.2 14 5.2 8 8.2 2 5.2z"/><path d="M2 8.2l6 3 6-3"/><path d="M2 11l6 3 6-3"/>',
  warning: '<path d="M8 2.2 14.4 13.4H1.6z"/><path d="M8 6.5v3"/><path d="M8 11.4v.1"/>',
  hourglass:
    '<path d="M4 2.5h8M4 13.5h8"/><path d="M5 2.5v2a3 3 0 0 0 1.4 2.6L8 8l1.6-.9A3 3 0 0 0 11 4.5v-2"/><path d="M5 13.5v-2a3 3 0 0 1 1.4-2.6L8 8l1.6.9a3 3 0 0 1 1.4 2.6v2"/>',
  bolt: '<path d="M9 1.8 3.8 9h4l-1 5.2L12.2 7h-4z"/>',
} as const

const WEATHER_ICON: Record<string, string> = {
  Clear:
    '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
  Cloudy: '<path d="M4.6 12.5h6.6a3 3 0 0 0 .3-6 4 4 0 0 0-7.6 1A2.6 2.6 0 0 0 4.6 12.5z"/>',
  Showers:
    '<path d="M4.6 9.5h6.6a3 3 0 0 0 .3-6 4 4 0 0 0-7.6 1A2.6 2.6 0 0 0 4.6 9.5z"/><path d="M5.5 11.5l-.7 2M8.3 11.5l-.7 2M11.1 11.5l-.7 2"/>',
  Storm:
    '<path d="M4.6 9.5h6.6a3 3 0 0 0 .3-6 4 4 0 0 0-7.6 1A2.6 2.6 0 0 0 4.6 9.5z"/><path d="M8.6 9.5 7 12h2.2l-1.4 2.6"/>',
  'Compact soon': ICON.bolt,
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** One piece of a line: its width, and the markup it draws at an x and a mid-line y. */
type Piece = { width: number; draw: (x: number, mid: number) => string }

function icon(paths: string, color: string, size = 14): Piece {
  return {
    width: size,
    draw: (x, mid) =>
      `<g transform="translate(${x} ${mid - size / 2}) scale(${size / 16})" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`,
  }
}

function mono(text: string, color: string, weight = 400): Piece {
  return {
    width: text.length * SIZE * MONO_ADVANCE,
    draw: (x, mid) =>
      `<text x="${x}" y="${mid}" dy="0.35em" font-family="${MONO}" font-size="${SIZE}" font-weight="${weight}" fill="${color}">${escape(text)}</text>`,
  }
}

function sans(text: string, color: string, weight = 400): Piece {
  return {
    width: text.length * SIZE * SANS_ADVANCE,
    draw: (x, mid) =>
      `<text x="${x}" y="${mid}" dy="0.35em" font-family="${SANS}" font-size="${SIZE}" font-weight="${weight}" fill="${color}">${escape(text)}</text>`,
  }
}

function divider(): Piece {
  return { width: 1, draw: (x, mid) => `<rect x="${x}" y="${mid - 7}" width="1" height="14" fill="${APP.divider}"/>` }
}

/** A slim rounded bar; `elapsed` adds a marker for how far through its window the clock is. */
function bar(percent: number, width: number, fill: string, track: string, elapsed?: number): Piece {
  const height = 4

  return {
    width,
    draw: (x, mid) => {
      const top = mid - height / 2
      const share = Math.max(0, Math.min(100, percent)) / 100
      const filled = share > 0 ? Math.max(height, share * width) : 0
      const marker =
        elapsed === undefined
          ? ''
          : `<rect x="${(x + elapsed * width - 1).toFixed(1)}" y="${mid - 6}" width="2" height="12" rx="1" fill="${APP.text}" fill-opacity="0.9"/>`

      return (
        `<rect x="${x}" y="${top}" width="${width}" height="${height}" rx="2" fill="${track}"/>` +
        (filled > 0 ? `<rect x="${x}" y="${top}" width="${filled.toFixed(1)}" height="${height}" rx="2" fill="${fill}"/>` : '') +
        marker
      )
    },
  }
}

/** The last turns as a line over a soft area, scaled to the highest turn shown. */
function sparkline(history: number[], color: string): Piece {
  const width = 64
  const height = 18
  const points = history.slice(-HISTORY_LENGTH)

  return {
    width,
    draw: (x, mid) => {
      const top = mid - height / 2
      const peak = Math.max(...points, 1)
      const step = width / (points.length - 1)
      const coords = points.map((tokens, i) => [x + i * step, top + height - 2 - (tokens / peak) * (height - 4)] as const)
      const line = coords.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)} ${py.toFixed(1)}`).join('')
      const last = coords.at(-1) ?? [x, mid]

      return (
        `<path d="${line}L${last[0].toFixed(1)} ${top + height}L${x} ${top + height}Z" fill="url(#spark)"/>` +
        `<path d="${line}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
        `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.2" fill="${color}"/>`
      )
    },
  }
}

function line(pieces: Piece[], gap: number | number[]): Piece {
  const gapAt = (i: number) => (Array.isArray(gap) ? (gap[i] ?? 0) : gap)
  const width = pieces.reduce((sum, piece, i) => sum + piece.width + (i > 0 ? gapAt(i - 1) : 0), 0)

  return {
    width,
    draw: (x, mid) => {
      let at = x

      return pieces
        .map((piece, i) => {
          if (i > 0) at += gapAt(i - 1)
          const out = piece.draw(at, mid)
          at += piece.width

          return out
        })
        .join('')
    },
  }
}

function chip(pieces: Piece[]): Piece {
  const inner = line(pieces, ITEM_GAP)
  const width = inner.width + CHIP_PAD * 2

  return {
    width,
    draw: (x, mid) =>
      `<rect x="${x}" y="${mid - CHIP_HEIGHT / 2}" width="${width.toFixed(1)}" height="${CHIP_HEIGHT}" rx="7" fill="${APP.chip}"/>` +
      inner.draw(x + CHIP_PAD, mid),
  }
}

function rateChip(limit: RateWindow, now: number): Piece {
  const elapsed = elapsedFraction(limit.kind, limit.resetsAt, now)
  const pace = paceOf(limit.percentUsed, elapsed)
  const pieces = [
    icon(limit.kind === 'seven_day' ? ICON.calendar : ICON.gauge, APP.muted),
    sans(windowLabel(limit.kind), APP.muted),
    bar(limit.percentUsed, 48, PACE[pace], APP.inChipTrack, elapsed),
    mono(formatPercent(limit.percentUsed), pace === 'ok' ? APP.text : PACE[pace], 600),
  ]
  if (limit.resetsAt !== undefined) {
    pieces.push(divider(), mono(formatDuration(Date.parse(limit.resetsAt) - now), APP.muted))
  }

  return chip(pieces)
}

export type DesktopBand = { source: string; width: number; height: number; alt: string }

/** Lays the band out: the forecast line, then chips wrapped to `maxWidth` CSS pixels. */
export function desktopBand(
  snap: Snapshot,
  history: number[],
  totals: Totals,
  now: number,
  maxWidth: number,
  alt: string,
  cache?: CacheView,
): DesktopBand {
  const percent = snap.percent ?? 0
  const weather = weatherFor(percent)
  const color = WEATHER_HEX[weather.color] ?? APP.text

  // Line one: the forecast.
  const forecast: Piece[] = [icon(WEATHER_ICON[weather.word] ?? ICON.bolt, color, 16), sans(weather.word, color, 600)]
  const gaps: number[] = [8]
  if (snap.tokens === undefined || snap.percent === undefined) {
    forecast.push(sans(`forecast after the next reply · ${formatWindow(snap.window)} window`, APP.muted))
    gaps.push(10)
  } else {
    forecast.push(
      mono(`${percent}%`, APP.text, 600),
      bar(percent, 96, color, APP.chip),
      mono(formatTokens(snap.tokens), APP.text),
      mono(`/ ${formatWindow(snap.window)}`, APP.muted),
    )
    gaps.push(10, 10, 10, 6)
    if (cache !== undefined) {
      // How long the prompt cache lasts before the next message re-reads it all.
      forecast.push(
        line(
          [
            icon(ICON.hourglass, APP.muted, 13),
            sans('cache', APP.muted),
            mono(cache.text, cache.tone === 'ok' ? APP.text : APP.amber, cache.tone === 'ok' ? 400 : 600),
          ],
          [5, 6],
        ),
      )
      gaps.push(14)
    }
    const delta = lastTurnDelta(history)
    if (delta !== undefined) {
      const sign = delta.delta < 0 ? '-' : '+'
      forecast.push(
        sparkline(history, color),
        mono(`${sign}${formatTokens(Math.abs(delta.delta))}`, delta.delta < 0 ? APP.green : APP.muted),
        sans('last turn', APP.muted),
      )
      gaps.push(16, 8, 6)
    }
  }
  const top = line(forecast, gaps)

  // Line two: the chips.
  const inTokens = totals.input + totals.cacheWrite
  const chips: Piece[] = shownLimits(snap).map(limit => rateChip(limit, now))
  chips.push(
    chip([
      line([icon(ICON.up, APP.green, 12), mono(formatTokens(inTokens), APP.green)], 2),
      line([icon(ICON.down, APP.red, 12), mono(formatTokens(totals.output), APP.red)], 2),
      line([icon(ICON.layers, APP.muted, 12), mono(formatTokens(inTokens + totals.cacheRead + totals.output), APP.muted)], 4),
    ]),
  )
  if (snap.costUsd !== undefined && snap.costUsd > 0) chips.push(chip([mono(`$${snap.costUsd.toFixed(2)}`, APP.text)]))
  const level = warningLevel(snap.percent)
  if (level > 0) {
    const tone = level === 90 ? APP.red : APP.amber
    chips.push(
      chip([
        icon(ICON.warning, tone),
        sans(level === 90 ? 'Compact now' : 'Consider compacting', tone, 600),
        mono('/compact', APP.muted),
      ]),
    )
  }

  // Wrap the chips to the width the band has.
  const limit = Math.max(top.width, maxWidth)
  const rows: Piece[][] = [[]]
  let used = 0
  for (const one of chips) {
    const row = rows.at(-1) ?? []
    if (row.length > 0 && used + CHIP_GAP + one.width > limit) {
      rows.push([one])
      used = one.width
    } else {
      row.push(one)
      used += (row.length > 1 ? CHIP_GAP : 0) + one.width
    }
  }
  const chipRows = rows.map(row => line(row, CHIP_GAP))

  const width = Math.ceil(Math.max(top.width, ...chipRows.map(row => row.width)) + 2)
  let body = top.draw(1, LINE_HEIGHT / 2)
  chipRows.forEach((row, i) => {
    body += row.draw(1, LINE_HEIGHT + ROW_GAP + i * (CHIP_HEIGHT + CHIP_GAP) + CHIP_HEIGHT / 2)
  })
  const height = LINE_HEIGHT + ROW_GAP + chipRows.length * CHIP_HEIGHT + (chipRows.length - 1) * CHIP_GAP

  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><linearGradient id="spark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>` +
    body +
    '</svg>'

  return { source, width, height, alt }
}

/** A small dot between the mini line's parts. */
function dot(): Piece {
  return { width: 3, draw: (x, mid) => `<circle cx="${x + 1.5}" cy="${mid}" r="1.5" fill="${APP.muted}"/>` }
}

/** The minimized band: weather and fill, then each plan window's share, on one line. */
export function desktopMini(snap: Snapshot, now: number, alt: string): DesktopBand {
  const percent = snap.percent ?? 0
  const weather = weatherFor(percent)
  const color = WEATHER_HEX[weather.color] ?? APP.text
  const pieces: Piece[] = [icon(WEATHER_ICON[weather.word] ?? ICON.bolt, color, 16)]
  const gaps: number[] = []
  if (snap.percent === undefined) {
    pieces.push(sans(weather.word, color, 600))
    gaps.push(8)
  } else {
    pieces.push(mono(`${percent}%`, color, 600), bar(percent, 40, color, APP.chip))
    gaps.push(8, 8)
  }
  for (const limit of shownLimits(snap)) {
    const pace = paceOf(limit.percentUsed, elapsedFraction(limit.kind, limit.resetsAt, now))
    pieces.push(dot(), sans(windowLabel(limit.kind), APP.muted), mono(formatPercent(limit.percentUsed), pace === 'ok' ? APP.text : PACE[pace], 600))
    gaps.push(12, 8, 6)
  }
  const row = line(pieces, gaps)
  const width = Math.ceil(row.width + 2)
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LINE_HEIGHT}" viewBox="0 0 ${width} ${LINE_HEIGHT}">` +
    row.draw(1, LINE_HEIGHT / 2) +
    '</svg>'

  return { source, width, height: LINE_HEIGHT, alt }
}
