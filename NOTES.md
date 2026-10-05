# token-weather: working notes

Running notes for this project: where things stand, what we decided and why, what's still open, and ideas for later. Update this file with every change, so work can continue without the chat history.

## Status (2026-10-05, v0.9.0)

Shipped, on `main` of github.com/wazzan/cc (public; the repo is also the plugin marketplace `wazzan-mods`):

- **Band above the prompt**: weather for the context fill, gauge, tokens of the window, prompt cache countdown, trend of the last 12 turns, last-turn growth; then the 5h and 7d plan windows (share, time-in-window marker, reset), tokens in/out/total, session cost, and a compaction warning at 75% and 90%.
- **Desktop app**: drawn as one transparent SVG in the app's own palette (option A: a forecast line over gray chips).
- **Terminal**: plain text in the terminal's own colors (option T2), sized to the window.
- **Minimize** to one line (desktop ×, terminal `m`/`e`, `/token-weather mini|full`), remembered across sessions, auto-expands when context crosses 75% (issue #1).
- **Cache countdown**: `◴ cache 42m left`, amber in its last fifth, then `expired`.
- **`/token-weather`**: prints everything as text on any surface; says whether the band was drawn and whether the inline summary is on.
- **Inline summary** (opt-in, `/token-weather inline on|off`): three labeled lines after each reply, as a notice row Claude never reads. Meant for apps that draw no band (Remote Control viewers).

### Install and update (any machine)

```sh
claude plugin marketplace add https://github.com/wazzan/cc.git
claude plugin install token-weather@wazzan-mods
# later updates:
claude plugin marketplace update wazzan-mods
claude plugin update token-weather@wazzan-mods
```

Then restart the desktop app, or `/reload-plugins` in an open session. Needs Claude Code v2.1.287 or later.

## Open items

- **Verify the inline summary shows in the desktop app for Remote Control sessions.** It is written: this development session's transcript has one `system`/`informational` row (level `info`) after each reply since 2026-10-05. The terminal hides info-level notices unless verbose (its system-message renderer returns null for them), so on the VM it only shows in the Ctrl+O transcript view. Still to check: whether the desktop app shows them, both for a Remote Control session and for a cloud session. If it doesn't, try returning `{ text }` from the `turn.complete` hook ("a text other than a main-loop answer's is shown beneath it"), or both.
- The cache lifetime is inferred, because the mods API doesn't expose it outside model-switch hooks. On usage credits the real TTL drops to 5 minutes; the mod only switches when a plan window reads 100%. Check this against `/usage` → "Prompt cache (main)" if it looks wrong.
- Not checked yet: terminals under 80 columns, light terminal themes in practice, the desktop band in a light app theme.
- The desktop band's text widths are estimates (SF Pro is proportional). Watch for overlaps on real Macs, especially "Consider compacting".

## Decisions and why

- **Design process**: the user wants options shown as mockups before any design change, and short replies.
- **Desktop palette**, sampled from the Code tab: page `#151515`, card `#212121`, chips and buttons `#373737`, muted text `#898782`, text `#f0efec`, green `#6bd45f`, red `#eb445b`, amber `#d09533`. Chips use rx 7. Options B (stat columns) and C (rings) were offered; the user picked A.
- **No `isInteractive` on the SVG**: it put the image in a frame with a white default background.
- **Terminal T2 over T1**: no backgrounds, so it reads on any theme over SSH. Uses named colors and `dimColor`. `terminalLayout()` grows the gauge and bars with the width and leaves 5 columns for the engine's `[-]`. Below 100 columns the second row packs left without separators.
- **The cache countdown sits on line one**, next to the context size: in row 2 it made the chips wrap.
- **Plan windows are saved in `$.store`**, because Claude Code reports them only on replies. A window whose reset has passed shows 0%.
- **Inline summary wording**: no dollar amounts or raw token counts. "Fine at this pace" means you won't hit 100% before the window resets; when you would, it says "at this pace it runs out in ~58m". Opt-in, so terminals don't get extra lines.
- **Minimize auto-expands** on crossing 75% and 90% for the session only; the saved choice stays minimized.

## Platform facts learned

- Mods draw only in the terminal and in the desktop app's **local** Code tab sessions. Cloud sessions don't load installed plugins. In Remote Control, drawing appears only in the terminal on the host (docs: Mods overview → "Where mods run").
- `$.state` resets on `/clear`, `/resume` and `/branch`, and `session.start` doesn't fire again: re-seed in `classic.SessionStart` with `source: ['clear', 'resume', 'fork']`. Resume carries `seconds_since_last_response`.
- The terminal hides `system` notices of level `info` (what `$.session.append` makes) unless verbose mode is on; Ctrl+O shows them.
- A mod's own `$.session.compact()` skips its own `session.compact` hook.
- `session.append` hooks must call `next`; a mod's `$.session.append` can't be exercised in `claude plugin test` (the kit keeps no conversation), so that path is guarded with try/catch and logged with `$.ui.log(..., { to: 'debug' })`.
- Tests need stand-ins for the engine: `mock.clock`, `mock.store`, `mock.env`, plus `on('settings.read')`, `on('session.usage')`, `on('ui.toast')`, `on('ui.render', AbovePrompt)` returning `{ value }` where it's an op.
- Install: a private repo over SSH failed in Claude Code's non-interactive clone; HTTPS works for the public repo. A local-folder marketplace reads the plugin in place.
- In Claude Code cloud sessions, the git proxy can push but can't delete branches.

## How to work on it

- Code: `token-weather/hooks/register.tsx` (hooks and terminal drawing), `weather.ts` (pure helpers), `desktop.ts` (SVG band), `types/index.d.ts` ($.state contract), `tests/`.
- Check: `claude plugin validate token-weather` and `claude plugin test token-weather` (34 tests). Type-check with `tsc -p` on a tsconfig that includes the engine's types (laid in `.claude-plugin/types/` once the mod loads).
- Release: bump `version` in `token-weather/.claude-plugin/plugin.json`, update README and this file, push to `main`.
- In a Claude Code cloud session the live copy is hot-reloaded from `~/.claude/dev-mods/<session>/token-weather`. Edit there, then copy `hooks/`, `tests/`, `types/` and `plugin.json` into the repo before committing.
- Previews: the desktop SVG rendered with `bun` into an HTML copy of the Code tab, and terminal trees dumped from `ui.drawn()` in a throwaway test and drawn as HTML, both screenshotted with Playwright's Chromium. Inter and JetBrains Mono (from npm `@fontsource`) stand in for SF Pro and SF Mono.

## Ideas for later

- `/token-weather` without bars or chart where no band is drawn: the app shows command output in a proportional font, which garbles them. Mock it up first.
- Token totals that cover the whole session, like the cost does; now they start over when the mod reloads.
- Drop the doubled "token-weather:" in command replies (Claude Code already adds the mod's name).

- Turn the inline summary on automatically when a remote viewer attaches (if `session.attach` reports it).
- The plan "runs out at this pace" projection in the band itself, not only in the summary.
- A light-theme palette for the desktop band.
- A toast a few minutes before the cache expires while you're idle.
- An estimate of what re-reading an expired cache costs, as a share of the 5h window.

## Changelog

- **0.9.0**: opt-in inline summary under each reply; `/token-weather inline on|off`.
- **0.8.0**: prompt cache countdown.
- **0.7.0**: terminal band sized to the window, blank line above it.
- **0.6.0**: terminal restyle T2 (plain text, theme colors).
- **0.5.0**: first public commit (earlier history squashed). Weather, chart, last-turn delta, plan windows remembered between sessions, tokens, cost, compact warning, `/token-weather`, `/clear` and `/resume` handling, the marketplace, the desktop band in the app's palette (option A), and minimize with auto-expand at 75% (issue #1).
