---
description: Interactively configure the cc-limits statusline (colors, thresholds, segments, icons, bar style)
---

You are configuring the cc-limits statusline for the user. The goal is that the user never has to open or edit any file themselves — you ask, they answer, you write the config.

## Config file and schema

The config lives at `~/.claude/cc-limits-config.json`. It's optional — if missing or invalid, the statusline falls back to the built-in defaults below. Read the defaults from `${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js` (the `DEFAULT_CONFIG` constant near the top) so you always cite the real current values, not stale ones.

Schema:

```json
{
  "colorsEnabled": true,
  "thresholds": { "yellow": 70, "red": 90 },
  "colors": { "low": "green", "medium": "yellow", "high": "red" },
  "bar": { "width": 10, "filledChar": "▓", "emptyChar": "░", "staleMarker": "~" },
  "layout": { "joiner": " │ " },
  "git": { "timeoutMs": 250 },
  "state": { "enabled": true, "minSampleSeconds": 30, "maxHistory": 60, "maxAgeMinutes": 720 },
  "terminalTitle": { "enabled": false, "template": "ctx {ctx}% · 5h {5h}% · {dir}" },
  "segments": [
    { "id": "header", "type": "header", "show": true,
      "parts": [
        { "key": "model", "bracket": true, "effort": true },
        { "key": "dir", "icon": "📁", "separator": " ", "link": false },
        { "key": "branch", "icon": "🌿", "separator": " | ", "aheadBehind": true, "link": false },
        { "key": "worktree", "icon": "🌳", "separator": " | " }
      ] },
    { "id": "ctx", "type": "bar", "show": true, "label": "ctx",
      "source": "context_window.used_percentage",
      "showUsage": true,
      "usage": { "usedSource": "context_window.current_usage",
                 "totalSource": "context_window.context_window_size" } },
    { "id": "5h", "type": "bar", "show": true, "label": "5h ",
      "source": "rate_limits.five_hour.used_percentage",
      "presenceSource": "rate_limits.five_hour",
      "showResetIn": true, "resetSource": "rate_limits.five_hour.resets_at",
      "showDepletion": true },
    { "id": "7d", "type": "bar", "show": true, "label": "7d ",
      "source": "rate_limits.seven_day.used_percentage",
      "presenceSource": "rate_limits.seven_day",
      "showResetIn": false, "resetSource": "rate_limits.seven_day.resets_at",
      "showDepletion": false },
    { "id": "stats", "type": "stats", "show": true, "separator": " · ",
      "parts": [
        { "key": "cost" },
        { "key": "duration", "icon": "⏱" },
        { "key": "burn", "icon": "🔥" },
        { "key": "lines" }
      ] }
  ]
}
```

Notes on the schema:
- `segments` is the **complete list** of what renders, in that order. Omitting an id hides it — same effect as `"show": false`. When you write the file, always write the full list of all five ids (`header`, `ctx`, `5h`, `7d`, `stats`), using `"show": false` for anything the user wants hidden, never by leaving it out — that way nothing is accidentally lost if they ask you to tweak just one thing later.
- `thresholds`/`colors` on a segment (e.g. `{ "id": "5h", "thresholds": { "red": 50 } }`) override the global ones for just that segment. Only add these if the user actually wants per-segment differences — don't add them by default.
- `colors` values must be one of: `green`, `yellow`, `red`, `blue`, `magenta`, `cyan`, `white`.
- `header.parts` controls the first line: which of `model`/`dir`/`branch`/`worktree` show, in what order, with what icon and separator before them (the first part in the list never gets a separator).
  - `model` accepts `"effort": true` — appends the effort tier as `(MAX|X|H|M|L)` plus `↯` when fast mode is on. Read from `~/.claude/settings.json`, hidden for Haiku.
  - `dir` and `branch` accept `"link": true` — OSC8 hyperlink (folder, and remote branch page respectively). The branch link costs an extra `git remote get-url` per render.
  - `branch` accepts `"aheadBehind": true` — appends `↑2↓1` versus upstream.
  - `worktree` only renders during a `--worktree` session.
- `stats.parts` accepts `cost`, `duration`, `burn` (tokens/min), `lines` (`+added -removed`), and `apiTime` (API time as a share of session time). Each part renders only when its data is present, and the whole segment disappears when none is.
- Bar segments accept `"showUsage": true` (token counts next to the percentage — only meaningful for `ctx`, whose `usage` block points at the token fields) and `"showDepletion": true` (an `~ETA to limit` estimate at the session's current pace — only meaningful for rate-limit bars).
- Any segment accepts `"row": <number>`. Segments sharing a row render on one line joined by `layout.joiner`; a segment without a row keeps a line to itself. This is how a compact one-line layout is built.
- `git.timeoutMs` caps how long each git call may take before the branch info is silently dropped.
- `state` controls the remembered rate-limit windows kept in `~/.claude/cc-limits-state.json`. They let the 5h/7d bars show their last known value (prefixed with `bar.staleMarker`) before Claude Code sends live limits in a new session, and they hold the sample history that makes the `~ETA to limit` a measurement instead of a guess. `maxAgeMinutes` is how long a remembered value stays trustworthy; `minSampleSeconds` and `maxHistory` control sampling. `"enabled": false` disables the file entirely — bars then hide until live limits arrive, as they did before.
- `terminalTitle` optionally writes the same numbers to the terminal's title (useful when Claude Code is in a background tab). Placeholders: `{ctx}`, `{5h}`, `{7d}`, `{cost}`, `{dir}`, `{model}`. It writes to `/dev/tty`, so it silently does nothing on Windows or without a controlling terminal. Off by default — only enable it if the user asks.

## Flow

1. **Load current state.** Read `~/.claude/cc-limits-config.json` if it exists. If it does, summarize the user's current settings in plain language in your first message (e.g. "Right now: default colors, thresholds 70/90, all five segments shown, 5h shows time-to-reset but 7d doesn't"). Ask if they want to keep tweaking from there, or reset to defaults first. If the file doesn't exist, say you're starting from the built-in defaults and go straight to questions.

   If the existing file predates a segment the defaults now have (most likely `stats`), point that out — it's hidden purely because it isn't in their list — and offer to add it.

2. **Ask in small groups, not one long form.** Suggested groups — ask conversationally, offer the current/default value as the easy "keep it" answer, and let the user skip anything they don't care about:
   - Segments & order: which of header, context, 5-hour limit, 7-day limit, stats do they want shown, and in what order?
   - Layout: one line per segment (default), or should some share a line? If they want compact, put the bar segments on the same `row`.
   - Header details: which of model/dir/branch/worktree to include, keep the icons, and do they want the effort badge, `↑↓` ahead/behind, and clickable links?
   - Stats details: which of cost/duration/burn rate/lines changed/API time.
   - Colors: keep color on? If so, keep green/yellow/red or use different colors from the supported palette?
   - Thresholds: keep 70/90 globally, or change them? Only ask about per-segment overrides if they show interest in more granularity.
   - Bar style: keep width 10 and ▓/░, or change width/characters (offer a couple of alternatives like `#`/`-` for plain-ASCII terminals)?
   - Reset-time and ETA display: which bars show "(Xh Ym until reset)", and which show "~ETA to limit".
   - Only if they bring it up or seem interested: the terminal title, and whether to keep remembering limits between sessions.

3. **Validate before writing:**
   - Thresholds must be 0–100, and `yellow < red`.
   - Bar width should be a small positive integer (roughly 4–40).
   - Colors must be from the supported palette listed above — if the user names something else, tell them the supported list and ask again.
   - The written `segments` array must include all five ids (`header`, `ctx`, `5h`, `7d`, `stats`), using `show: false` rather than omission for anything hidden.
   - `showDepletion` only belongs on rate-limit bars, `showUsage` only on `ctx`.

4. **Write the file.** Construct the complete config object (all top-level keys present, mirroring the schema above — merge the user's answered changes onto the current values/defaults yourself before writing) and use the Write tool to save it, pretty-printed, to `~/.claude/cc-limits-config.json`. Create `~/.claude/` first if it doesn't exist.

5. **Confirm.** Show a short human-readable summary of what changed (not a raw JSON dump). Mention that this takes effect on the very next statusline render — no session restart needed (unlike the install step). Mention they can run `/cc-limits:setup` again anytime, and that deleting `~/.claude/cc-limits-config.json` resets everything to defaults.

If at any point the user seems to want to see the options laid out rather than answer questions one by one, point them at `${CLAUDE_PLUGIN_ROOT}/configurator.html` — a self-contained page they open in a browser, showing every option with a live preview. Its **Copy command** button produces a `/cc-limits:apply …` line that writes the config for them. Offer it; don't push it.

If the user asks to see their current config (usually to paste it into that page), print the contents of `~/.claude/cc-limits-config.json` as-is, or tell them there isn't one yet and they're on the defaults.

Keep the whole conversation focused and short — a handful of questions, not twenty. Don't touch any other plugin file, and don't ask about anything outside this schema.
