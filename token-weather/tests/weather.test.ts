import { describe, expect, test } from 'claude-code/testing'

import {
  barCells,
  elapsedFraction,
  formatDuration,
  formatTokens,
  formatWindow,
  lastTurnDelta,
  paceOf,
  sparkCells,
  trendText,
  warningLevel,
  weatherFor,
} from '../hooks/weather'

describe('weather', () => {
  test('each band of fill has its own weather', () => {
    expect(weatherFor(0)).toEqual({ icon: '☀', word: 'Clear', color: 'yellow' })
    expect(weatherFor(24)).toEqual({ icon: '☀', word: 'Clear', color: 'yellow' })
    expect(weatherFor(25)).toEqual({ icon: '☁', word: 'Cloudy', color: 'cyan' })
    expect(weatherFor(49)).toEqual({ icon: '☁', word: 'Cloudy', color: 'cyan' })
    expect(weatherFor(50)).toEqual({ icon: '☂', word: 'Showers', color: 'blue' })
    expect(weatherFor(74)).toEqual({ icon: '☂', word: 'Showers', color: 'blue' })
    expect(weatherFor(75)).toEqual({ icon: '☇', word: 'Storm', color: 'magenta' })
    expect(weatherFor(89)).toEqual({ icon: '☇', word: 'Storm', color: 'magenta' })
    expect(weatherFor(90)).toEqual({ icon: '↯', word: 'Compact soon', color: 'red' })
    expect(weatherFor(100)).toEqual({ icon: '↯', word: 'Compact soon', color: 'red' })
  })

  test('tokens read like 134.4k / 200k', () => {
    expect(formatTokens(842)).toBe('842')
    expect(formatTokens(3_000)).toBe('3.0k')
    expect(formatTokens(134_400)).toBe('134.4k')
    expect(formatTokens(1_250_000)).toBe('1.3M')
    expect(formatWindow(200_000)).toBe('200k')
    expect(formatWindow(1_000_000)).toBe('1M')
  })

  test('the sparkline keeps the last 12 turns, scaled to the window', () => {
    const history = Array.from({ length: 15 }, (_, i) => (i + 1) * 12_500)
    const cells = sparkCells(history, 200_000)
    expect(cells).toHaveLength(12)
    expect(cells.map(cell => cell.char).join('')).toBe('▃▃▄▄▅▅▆▆▇▇██')
    expect(sparkCells([0, 199_999], 200_000).map(cell => cell.char).join('')).toBe('▁█')
    expect(sparkCells([190_000], 200_000)[0]?.color).toBe('red')
  })

  test('the terminal trend runs from the lowest turn shown to the highest', () => {
    expect(trendText([100, 150, 200])).toBe('▁▄▇')
    expect(trendText([5_000])).toBe('▁')
    expect(trendText(Array.from({ length: 20 }, (_, i) => i))).toHaveLength(12)
  })

  test('the last turn says how much it added', () => {
    expect(lastTurnDelta([])).toBeUndefined()
    expect(lastTurnDelta([134_400])).toBeUndefined()
    expect(lastTurnDelta([36_100, 134_400])?.text).toBe('▲ +98.3k')
    expect(lastTurnDelta([150_000, 30_000])?.text).toBe('▼ −120.0k')
    expect(lastTurnDelta([5, 5])?.text).toBe('► ±0')
  })

  test('countdowns read like 2h 40m and 1d 7h', () => {
    expect(formatDuration((2 * 60 + 40) * 60_000)).toBe('2h 40m')
    expect(formatDuration((31 * 60) * 60_000)).toBe('1d 7h')
    expect(formatDuration(5 * 60_000)).toBe('5m')
    expect(formatDuration(-1)).toBe('now')
  })

  test('the bar marks where the clock is in the window', () => {
    const now = Date.parse('2026-10-03T12:00:00Z')
    const resetsAt = new Date(now + (2 * 60 + 40) * 60_000).toISOString()
    const elapsed = elapsedFraction('five_hour', resetsAt, now)
    expect(Math.round((elapsed ?? 0) * 100)).toBe(47)
    expect(elapsedFraction('spend_limit', resetsAt, now)).toBeUndefined()

    const cells = barCells(20, elapsed, 10)
    expect(cells.map(cell => cell.part)).toEqual([
      'fill', 'fill', 'track', 'track', 'marker', 'track', 'track', 'track', 'track', 'track',
    ])
    expect(paceOf(20, elapsed)).toBe('ok')
    expect(paceOf(70, elapsed)).toBe('ahead')
    expect(paceOf(95, elapsed)).toBe('critical')
  })

  test('compaction warnings start at 75% and grow at 90%', () => {
    expect(warningLevel(undefined)).toBe(0)
    expect(warningLevel(74)).toBe(0)
    expect(warningLevel(75)).toBe(75)
    expect(warningLevel(90)).toBe(90)
  })
})
