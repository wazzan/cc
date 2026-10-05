/** One plan window (`five_hour`, `seven_day`, a gateway's `spend_limit`). */
export type RateWindow = { kind: string; percentUsed: number; resetsAt?: string }

/** The latest figures the engine measured for the session. */
export type Snapshot = {
  /** Input tokens the last response was answered over; absent before one. */
  tokens?: number
  window: number
  percent?: number
  rateLimits: RateWindow[]
  costUsd?: number
}

/** Tokens summed over every turn of the session, subagents included. */
export type Totals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

declare module 'claude-code' {
  interface PluginState {
    'token-weather': {
      /** Context tokens at the end of each main-thread turn, newest last. */
      history: number[]
      snapshot: Snapshot | null
      totals: Totals
      /** The highest compaction warning already toasted: 0, 75 or 90. */
      warned: number
      /** Bumped each minute so the reset countdowns redraw. */
      tick: number
      /** The band is shrunk to one line; saved in $.store across sessions. */
      minimized: boolean
      /** When the main conversation last had a reply, in ms; null when nothing is cached. */
      cacheAt: number | null
      /** The prompt cache's lifetime in ms as Claude Code picks it; 0 when caching is off. */
      cacheTtl: number
      /** The share of the last main turn's input the cache served, 0 to 100; null before one. */
      lastHit: number | null
      /** A summary goes under each reply; saved in $.store across sessions. */
      inline: boolean
    }
  }
}
