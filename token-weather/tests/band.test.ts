import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const MINUTE = 60_000

const BAND = {
  plugin: 'token-weather',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const TURN_USAGE = {
  input_tokens: 1_000,
  output_tokens: 1_500,
  cache_read_input_tokens: 300_000,
  cache_creation_input_tokens: 4_200,
  model: 'test-model',
}

function usageAt(tokens: number, fiveHour = 20): SessionUsage {
  return {
    startedAt: NOW,
    context: { tokens, window: 200_000, percent: Math.round((tokens / 200_000) * 100) },
    rateLimits: [
      { kind: 'five_hour', percentUsed: fiveHour, resetsAt: new Date(NOW + 160 * MINUTE).toISOString() },
      { kind: 'seven_day', percentUsed: 58, resetsAt: new Date(NOW + 31 * 60 * MINUTE).toISOString() },
    ],
    cost: { usd: 4.32 },
  }
}

let clock: MockClock

/** The engine beneath the mod: usage as `current()` says, turns and toasts recorded. */
function world(on: On, current: () => SessionUsage, stored: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const toasts: string[] = []
  clock = mock.clock(on, { now: NOW })
  mock.store(on, stored)
  mock.env(on, env)
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({ value: current() }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  // What the engine draws in the band when no plugin does: here, a marker.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['engine band'] }))

  return toasts
}

async function turn($: Engine, id: string, agentId?: string) {
  await $.turn.complete({
    answer: 'ok',
    durationMs: 1_000,
    isAborted: false,
    turnId: id,
    reason: 'answer',
    usage: TURN_USAGE,
    ...(agentId === undefined ? {} : { agentId }),
  })
}

describe('token-weather band', () => {
  test('before any turn it leaves the band to the engine', async ($, on) => {
    world(on, () => usageAt(0))
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  })

  test('draws the forecast and the plan, token and cost chips after each turn', async ($, on) => {
    let usage = usageAt(36_100)
    world(on, () => usage)

    await turn($, 't1')
    usage = usageAt(134_400)
    await turn($, 't2')
    // A subagent's turn adds tokens but no point on the chart.
    await turn($, 't3', 'agent-1')

    {
      const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
      expect(await ui.find({ type: 'Text', text: '☂ Showers' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '67%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '134.4k' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '/ 200k' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '+98.3k last turn' })).toBeDefined()
      // Plan windows, tokens and cost sit between dim separators, with no backgrounds.
      expect(await ui.findAll({ type: 'Text', text: '│' })).toHaveLength(3)
      expect(await ui.find({ type: 'Text', text: '1h left' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '↑15.6k' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '··········' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '5h' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '20%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '2h 40m' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '58%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '1d 7h' })).toBeDefined()
      // Three turns: in = (1.0k + 4.2k) × 3, out = 1.5k × 3, total adds the cache reads.
      expect(await ui.find({ type: 'Text', text: '15.6k' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '4.5k' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '920.1k' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '4.32' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'compact' })).toBeUndefined()
      await ui.unmount()
    }

    // The desktop app gets the same figures as one SVG.
    const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const svg = await desktop.find({ type: 'Svg' })
    const source = String(svg?.props.source)
    for (const shown of ['Showers', '67%', '134.4k', '/ 200k', '+98.3k', 'last turn', '20%', '2h 40m', '58%', '1d 7h', 'cache', '1h left', '15.6k', '4.5k', '920.1k', '$4.32']) {
      expect(source).toContain(shown)
    }
    expect(String(svg?.props.alt)).toContain('☂ Showers  67%  134.4k / 200k')
    expect(await desktop.find({ type: 'Button', key: 'compact' })).toBeUndefined()
  })

  test('warns once at 75% and again at 90%, and the Compact button compacts', async ($, on) => {
    let usage = usageAt(100_000)
    const toasts = world(on, () => usage)
    let compactions = 0
    on('session.compact', () => {
      compactions += 1
      usage = { ...usageAt(0), context: { window: 200_000 } }

      return {
        messages: [{ role: 'user' as const, text: 'Summary of the work so far.', toolUses: [] }],
        tokensBefore: 184_000,
        tokensAfter: 21_000,
      }
    })

    await turn($, 't1')
    usage = usageAt(152_000)
    await turn($, 't2')
    usage = usageAt(156_000)
    await turn($, 't3')
    expect(toasts.filter(text => text.includes('consider /compact'))).toHaveLength(1)

    usage = usageAt(184_000)
    await turn($, 't4')
    expect(toasts.filter(text => text.includes('compact soon'))).toHaveLength(1)

    {
      const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
      expect(await ui.find({ type: 'Text', text: '↯ Compact soon' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '⚠ Compact now' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'run /compact' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
      await ui.unmount()
    }
    {
      const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
      const source = String((await ui.find({ type: 'Svg' }))?.props.source)
      expect(source).toContain('Compact soon')
      expect(source).toContain('Compact now')
      expect(source).toContain('/compact')
      await ui.unmount()
    }

    const working = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: true } })
    expect(await working.find({ type: 'Button', key: 'compact' })).toBeUndefined()
    await working.unmount()

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'compact' })
    expect(compactions).toBe(1)
    expect(toasts).toContain('Compacted: 184.0k → 21.0k')
    expect(await ui.find({ type: 'Text', text: 'forecast after the next reply' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeUndefined()
  })

  test('a plan window that moves between turns redraws the band', async ($, on) => {
    const usage = usageAt(40_000)
    world(on, () => usage)
    await turn($, 't1')

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '20%' })).toBeDefined()

    const moved = usageAt(40_000, 71)
    await $.session.measure({
      context: moved.context,
      rateLimits: moved.rateLimits,
      cost: { usd: 5.1 },
      changed: ['rateLimits', 'cost'],
    })
    expect(await ui.find({ type: 'Text', text: '71%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '5.10' })).toBeDefined()
  })

  test('/clear starts the forecast over', async ($, on) => {
    let usage = usageAt(60_000)
    world(on, () => usage)
    on('classic.SessionStart', () => ({}))
    await turn($, 't1')
    await turn($, 't2')

    usage = { ...usageAt(0), context: { window: 200_000 } }
    await $.classic.SessionStart({ source: 'clear' })

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'forecast after the next reply' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /last turn/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '15.6k' })).toBeUndefined()
  })

  test('steps aside for a survey', async ($, on) => {
    world(on, () => usageAt(134_400))
    await turn($, 't1')

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
    expect(await ui.find({ type: 'Text', text: '67%' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  })

  test('/token-weather prints the band as text and says where it was drawn', async ($, on) => {
    let usage = usageAt(36_100)
    world(on, () => usage)
    on('session.surfaces', () => ({ value: ['desktop' as const] }))
    const run = () =>
      $.command.run({
        command: 'token-weather',
        args: '',
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 120 },
      })

    await turn($, 't1')
    usage = usageAt(184_000)
    await turn($, 't2')

    const text = (await run()).text ?? ''
    expect(text).toContain('↯ Compact soon  92%  184.0k / 200k')
    expect(text).toContain('▲ +147.9k last turn')
    expect(text).toContain('◔ 5h ▰▰▱▱┃▱▱▱▱▱ 20% ↻ 2h 40m')
    expect(text).toContain('▦ 7d ▰▰▰▰▰▰▱▱┃▱ 58% ↻ 1d 7h')
    expect(text).toContain('↑ 10.4k in   ↓ 3.0k out   ≋ 613.4k total   $4.32')
    expect(text).toContain('⚠ Context 92% full: compact now')
    expect(text).toContain('never requested. Attached surfaces: desktop')

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.unmount()
    expect((await run()).text).toContain('Band above the prompt: drawn on terminal (1×).')
  })

  test('plan windows from an earlier session show before this one has a reply', async ($, on) => {
    const stored = {
      'rate-limits': [
        { kind: 'five_hour', percentUsed: 41, resetsAt: new Date(NOW - 5 * MINUTE).toISOString() },
        { kind: 'seven_day', percentUsed: 58, resetsAt: new Date(NOW + 31 * 60 * MINUTE).toISOString() },
      ],
    }
    world(on, () => ({ ...usageAt(385_600), rateLimits: [] }), stored)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    // The 5h window reset since it was saved, so it starts again at 0%.
    expect(await ui.find({ type: 'Text', text: ' 0%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '58%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1d 7h' })).toBeDefined()
    // The chart starts from the fill the conversation already has, with no delta yet.
    expect(await ui.find({ type: 'Text', text: '···········' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /last turn/ })).toBeUndefined()
  })

  describe('minimizing (issue #1)', () => {
    const start = async ($: Engine, on: On) => {
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      on('command.register', ($, e) => ({ value: { command: e.name } }))
      on('command.run', () => ({ text: 'unanswered' }))
      await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    }
    const run = ($: Engine, args: string) =>
      $.command.run({
        command: 'token-weather',
        args,
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 120 },
      })

    test('the band shrinks to one line and expands again, in the terminal', async ($, on) => {
      let usage = usageAt(36_100)
      world(on, () => usage)
      await start($, on)
      usage = usageAt(80_000)
      await turn($, 't1')

      const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
      await ui.press({ key: 'minimize' })
      expect(await ui.find({ type: 'Text', text: '☁ 40%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '· 5h 20% · 7d 58%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '15.6k' })).toBeUndefined()

      await ui.press({ key: 'expand' })
      expect(await ui.find({ type: 'Text', text: '☁ Cloudy' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'minimize' })).toBeDefined()
    })

    test('the desktop band minimizes from its close control to a mini line', async ($, on) => {
      world(on, () => usageAt(80_000))
      await start($, on)

      const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
      const close = await ui.find({ type: 'Button', key: 'minimize' })
      expect(close?.props.role).toBe('dismiss')
      await ui.press({ key: 'minimize' })
      const svg = await ui.find({ type: 'Svg' })
      expect(svg?.props.alt).toBe('☁ 40% · 5h 20% · 7d 58%')
      expect(String(svg?.props.source)).not.toContain('last turn')
      await ui.press({ key: 'expand' })
      expect(await ui.find({ type: 'Button', key: 'minimize' })).toBeDefined()
    })

    test('a saved choice keeps the band minimized in a new session', async ($, on) => {
      world(on, () => usageAt(80_000), { minimized: true })
      await start($, on)

      const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
      expect(await ui.find({ type: 'Button', key: 'expand' })).toBeDefined()
    })

    test('it comes back on its own when context crosses 75%', async ($, on) => {
      let usage = usageAt(100_000)
      world(on, () => usage, { minimized: true })
      await start($, on)
      const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
      expect(await ui.find({ type: 'Button', key: 'expand' })).toBeDefined()

      usage = usageAt(152_000)
      await turn($, 't1')
      expect(await ui.find({ type: 'Text', text: '☇ Storm' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'expand' })).toBeUndefined()

      // Minimized again by hand, it stays put until the fill next crosses a line.
      await ui.press({ key: 'minimize' })
      usage = usageAt(156_000)
      await turn($, 't2')
      expect(await ui.find({ type: 'Button', key: 'expand' })).toBeDefined()
    })

    test('/token-weather mini and full switch the band', async ($, on) => {
      world(on, () => usageAt(80_000))
      await start($, on)
      const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

      expect((await run($, 'mini')).text).toContain('Minimized to one line')
      expect(await ui.find({ type: 'Button', key: 'expand' })).toBeDefined()
      expect((await run($, 'full')).text).toBe('Expanded.')
      expect(await ui.find({ type: 'Button', key: 'minimize' })).toBeDefined()
    })
  })

  describe('prompt cache countdown', () => {
    test('counts down from the last reply, turns amber, then expires', async ($, on) => {
      world(on, () => usageAt(80_000))
      await turn($, 't1')
      const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
      expect(await ui.find({ type: 'Text', text: '1h left' })).toBeDefined()

      await clock.advance(50 * MINUTE)
      await ui.redraw()
      const expiring = await ui.find({ type: 'Text', text: '10m left' })
      expect(expiring?.props.color).toBe('yellow')

      await clock.advance(11 * MINUTE)
      await ui.redraw()
      expect(await ui.find({ type: 'Text', text: 'expired' })).toBeDefined()

      // A new reply warms it again.
      await turn($, 't2')
      await ui.redraw()
      expect(await ui.find({ type: 'Text', text: '1h left' })).toBeDefined()
    })

    test('an API key, or FORCE_PROMPT_CACHING_5M, gets five minutes', async ($, on) => {
      world(on, () => ({ ...usageAt(80_000), rateLimits: [] }), {}, { FORCE_PROMPT_CACHING_5M: '1' })
      await turn($, 't1')
      const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
      expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toContain('5m left')
    })

    test('a resumed conversation counts from its last reply', async ($, on) => {
      world(on, () => usageAt(80_000))
      on('classic.SessionStart', () => ({}))
      await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 20 * 60 })
      const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
      expect(await ui.find({ type: 'Text', text: '40m left' })).toBeDefined()
    })

    test('/token-weather says how long the cache has', async ($, on) => {
      world(on, () => usageAt(80_000))
      on('session.surfaces', () => ({ value: [] }))
      await turn($, 't1')
      const text = (
        await $.command.run({
          command: 'token-weather',
          args: '',
          origin: { kind: 'composer' },
          presentation: { isFullscreen: false, columns: 120 },
        })
      ).text
      expect(text).toContain('◴ cache 1h left')
    })
  })

  describe('summary under each reply', () => {
    const run = ($: Engine, args: string) =>
      $.command.run({
        command: 'token-weather',
        args,
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 120 },
      })
    const start = async ($: Engine, on: On) => {
      const logged: string[] = []
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      on('command.register', ($, e) => ({ value: { command: e.name } }))
      on('session.surfaces', () => ({ value: [] }))
      on('ui.log', ($, e) => {
        if (e.to === 'transcript') logged.push(e.text)

        return { value: undefined }
      })
      await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

      return logged
    }

    test('/token-weather inline on and off switch it, and the report says so', async ($, on) => {
      world(on, () => usageAt(80_000))
      await start($, on)
      expect((await run($, '')).text).not.toContain('Summary under each reply')

      expect((await run($, 'inline on')).text).toContain('A summary now follows each reply')
      expect((await run($, '')).text).toContain('Summary under each reply: on')

      expect((await run($, 'inline off')).text).toContain('No more summaries')
      expect((await run($, '')).text).not.toContain('Summary under each reply')
    })

    test('a saved choice carries into a new session', async ($, on) => {
      world(on, () => usageAt(80_000), { inline: true })
      await start($, on)
      expect((await run($, '')).text).toContain('Summary under each reply: on')
    })

    test('the summary follows the reply as three log rows, once the turn is over', async ($, on) => {
      let usage = usageAt(60_000)
      world(on, () => usage, { inline: true })
      const logged = await start($, on)
      await turn($, 't1')
      usage = usageAt(80_000)
      await turn($, 't2')
      await clock.advance(1_500)
      expect(logged).toHaveLength(6)
      expect(logged.slice(3).map(line => line.split(/\s+/)[0])).toEqual(['Context', 'Cache', 'Plan'])
      expect(logged[3]).toContain('☁ Cloudy 40% · +10% last turn')

      // The band moves on as before.
      const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
      expect(await ui.find({ type: 'Text', text: '+20.0k last turn' })).toBeDefined()
    })

    test('with the summary off, nothing is logged', async ($, on) => {
      world(on, () => usageAt(60_000))
      const logged = await start($, on)
      await turn($, 't1')
      await clock.advance(1_500)
      expect(logged).toEqual([])
    })
  })
})
