# cc-limits

[![Listed on ClaudePluginHub](https://www.claudepluginhub.com/badge/sslinnn-cc-limits-plugin)](https://www.claudepluginhub.com/plugins/sslinnn-cc-limits-plugin?ref=badge)

A Claude Code statusline plugin that shows, in realtime:

- **context** — how much of the current session's context window is used, in percent and tokens
- **5h** — Claude.ai Pro/Max 5-hour rate-limit usage, with time until reset and an estimate of when you'll hit it
- **7d** — Claude.ai Pro/Max weekly rate-limit usage
- **stats** — session cost, duration, token burn rate, lines changed

All data comes from Claude Code's built-in [statusline JSON](https://code.claude.com/docs/en/statusline) — no polling, no external API calls, no daemon. The only thing kept on disk is a small local record of the rate-limit windows themselves (see [Remembered limits](#remembered-limits)).

```
[Opus 5(H)] 📁 my-project | 🌿 main ↑2

ctx ▓▓▓░░░░░░░ 32% 64K/200K

5h  ▓▓░░░░░░░░ 18% (2h1m until reset, ~4h33m to limit)

7d  ▓▓▓▓░░░░░░ 41% (6d3h until reset)

$1.23 · ⏱ 1h0m · 🔥 1.1K/min · +320 -85
```

Colors: green (<70%), yellow (70-89%), red (≥90%) per bar.

## Requirements

- Node.js on PATH
- `rate_limits` (5h/7d) only appears for Claude.ai Pro/Max subscribers, after the first API response in a session

## Install

```
/plugin marketplace add sslinNn/cc-limits
/plugin install cc-limits@cc-limits
```

Start a new session (or restart Claude Code). The plugin's `SessionStart` hook copies its script to `~/.claude/cc-limits-statusline.js` and configures `~/.claude/settings.json` for you automatically — no manual editing required.

If you already have a different `statusLine` configured, cc-limits leaves it untouched and just lets you know (with a ready-to-paste snippet) in case you want to switch to it yourself.

## What each segment shows

| Segment | Renders |
|---|---|
| `header` | Model (with effort tier and fast-mode `↯`), directory, git branch with `↑ahead ↓behind`, `🌳 worktree` name during a `--worktree` session |
| `ctx` | Context bar, percentage, and `used/total` tokens |
| `5h` | 5-hour limit bar, time until reset, and `~ETA to limit` at the current session's pace |
| `7d` | Weekly limit bar; reset countdown reads in days (`6d3h`) |
| `stats` | `$cost · ⏱ duration · 🔥 tokens/min · +added -removed` (an `apiTime` part showing API time as a share of session time is available too) |

The `~ETA to limit` estimate is measured from how fast the window has actually been filling (see below), which counts usage from your other sessions too. Until there's enough history to measure — the first couple of minutes — it falls back to assuming the whole window's usage came from this session, which reads pessimistically. It hides itself when the pace is too slow to matter or the estimate lands past a day.

## Remembered limits

Claude Code only puts `rate_limits` in the payload after a session's first API response, so at the start of every session the 5h/7d bars had nothing to draw. cc-limits now keeps the last values it saw in `~/.claude/cc-limits-state.json` and draws them with a `~` marker until the live numbers arrive:

```
5h ~▓▓░░░░░░░░ 18% (2h0m until reset)
```

A remembered value is dropped once its window has reset (the number would be a lie) or once it's older than 12 hours. Remembered values never get an ETA — that usage predates the session, so estimating from the session's runtime would invent a burn rate.

The same record holds a short sample history per window, which is what makes the ETA a measurement rather than a guess. Samples are taken at most every 30 seconds, capped at 60 per window, and thrown away when the window rolls over. The file is a few hundred bytes, written only when something actually changed, and rewritten atomically so parallel sessions can't tear each other's history.

Turn the whole thing off with `"state": { "enabled": false }` — the bars then behave as before, hiding until Claude Code sends live limits.

## Terminal title (opt-in)

The statusline is invisible when Claude Code sits in a background tab. cc-limits can put the same numbers in the terminal's title:

```json
"terminalTitle": { "enabled": true, "template": "ctx {ctx}% · 5h {5h}% · {dir}" }
```

Available placeholders: `{ctx}`, `{5h}`, `{7d}`, `{cost}`, `{dir}`, `{model}` (percentages are bare numbers, empty when unknown). The escape is written straight to `/dev/tty`, since stdout belongs to Claude Code — which also means it does nothing on Windows or without a controlling terminal. Off by default, because it writes outside our own line.

The effort tier comes from `effortLevel` in `~/.claude/settings.json` (or `CLAUDE_CODE_EFFORT_LEVEL`), since Claude Code doesn't put it in the statusline payload; an unset tier renders as `H`, Claude Code's own default. It's hidden for Haiku, which has no effort tier.

## Customization

Two ways, same result — colors, thresholds, which segments show and in what order, icons, bar style, layout:

**Answer questions:** run `/cc-limits:setup` in Claude Code and it writes the config for you.

**Or see everything at once:** open [`plugin/configurator.html`](plugin/configurator.html) in a browser — a single self-contained page, no server, no install. Every option is laid out with a live preview of the statusline, including sliders that show where your color thresholds kick in. When it looks right, hit **Copy command** and paste the result into Claude Code:

```
/cc-limits:apply {"colorsEnabled":true,...}
```

`/cc-limits:apply` checks the config, tells you what changes, and writes the file. Nothing to save by hand.

Already have a config? Ask Claude Code to show it, paste it into the page's **Start from your current config** box, and every control jumps to your settings.

Defaults:

| Setting | Default |
|---|---|
| Segments (in order) | header (model, dir, git branch, worktree), ctx, 5h, 7d, stats |
| Colors | green (`<70%`), yellow (`70-89%`), red (`≥90%`) |
| Bar | width 10, `▓` filled / `░` empty |
| Reset-time-until | shown for 5h and 7d |
| ETA to limit | shown for 5h |
| Context tokens | shown |
| Icons | 📁 directory, 🌿 branch, 🌳 worktree, ⏱ duration, 🔥 burn rate |
| Layout | one line per segment |
| Remembered limits | on, `~` marker, 12-hour max age |
| Terminal title | off |

### Compact layout

Give segments the same `row` number and they share a line, joined by `layout.joiner` (default ` │ `):

```json
{ "id": "ctx", "row": 1 }, { "id": "5h", "row": 1 }, { "id": "7d", "row": 1 }
```

```
[Opus 5(H)] 📁 my-project | 🌿 main
ctx ▓▓▓░░░░░░░ 32% │ 5h ▓▓░░░░░░░░ 18% │ 7d ▓▓▓▓░░░░░░ 41%
```

A segment without a `row` keeps a line to itself, which is the default.

### Clickable links

`{ "key": "dir", "link": true }` makes the directory an OSC8 link to the folder, and `{ "key": "branch", "link": true }` links the branch to its remote on GitHub/GitLab. Terminals without OSC8 support just print the text. The branch link costs one extra `git remote get-url` per render, so it's off by default.

Advanced: the config lives at `~/.claude/cc-limits-config.json` as plain JSON matching the schema `/cc-limits:setup` writes, if you'd rather edit it directly. The `segments` array is the complete list of what renders — a segment you leave out is hidden, so after an update that adds a new segment, run `/cc-limits:setup` (or add it yourself) to pick it up.

## Update

```
/plugin marketplace update cc-limits
```

The `SessionStart` hook re-copies the script on the next session, so `~/.claude/cc-limits-statusline.js` always matches the installed plugin version.

## License

MIT
