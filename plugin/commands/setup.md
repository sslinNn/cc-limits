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
  "bar": { "width": 10, "filledChar": "▓", "emptyChar": "░" },
  "segments": [
    { "id": "header", "type": "header", "show": true,
      "parts": [
        { "key": "model", "bracket": true },
        { "key": "dir", "icon": "📁", "separator": " " },
        { "key": "branch", "icon": "🌿", "separator": " | " }
      ] },
    { "id": "ctx", "type": "bar", "show": true, "label": "ctx",
      "source": "context_window.used_percentage" },
    { "id": "5h", "type": "bar", "show": true, "label": "5h ",
      "source": "rate_limits.five_hour.used_percentage",
      "presenceSource": "rate_limits.five_hour",
      "showResetIn": true, "resetSource": "rate_limits.five_hour.resets_at" },
    { "id": "7d", "type": "bar", "show": true, "label": "7d ",
      "source": "rate_limits.seven_day.used_percentage",
      "presenceSource": "rate_limits.seven_day",
      "showResetIn": false, "resetSource": "rate_limits.seven_day.resets_at" }
  ]
}
```

Notes on the schema:
- `segments` is the **complete list** of what renders, in that order. Omitting an id hides it — same effect as `"show": false`. When you write the file, always write the full list of all four ids (`header`, `ctx`, `5h`, `7d`), using `"show": false` for anything the user wants hidden, never by leaving it out — that way nothing is accidentally lost if they ask you to tweak just one thing later.
- `thresholds`/`colors` on a segment (e.g. `{ "id": "5h", "thresholds": { "red": 50 } }`) override the global ones for just that segment. Only add these if the user actually wants per-segment differences — don't add them by default.
- `colors` values must be one of: `green`, `yellow`, `red`, `blue`, `magenta`, `cyan`, `white`.
- `header.parts` controls the first line: which of `model`/`dir`/`branch` (git branch) show, in what order, with what icon and separator before them (the first part in the list never gets a separator).

## Flow

1. **Load current state.** Read `~/.claude/cc-limits-config.json` if it exists. If it does, summarize the user's current settings in plain language in your first message (e.g. "Right now: default colors, thresholds 70/90, all four segments shown, 5h shows time-to-reset but 7d doesn't"). Ask if they want to keep tweaking from there, or reset to defaults first. If the file doesn't exist, say you're starting from the built-in defaults and go straight to questions.

2. **Ask in small groups, not one long form.** Suggested groups — ask conversationally, offer the current/default value as the easy "keep it" answer, and let the user skip anything they don't care about:
   - Segments & order: which of header (model/dir/git branch), context %, 5-hour limit, 7-day limit do they want shown, and in what order?
   - Header details: keep the 📁/🌿 icons or change/remove them; which of model/dir/branch to include.
   - Colors: keep color on? If so, keep green/yellow/red or use different colors from the supported palette?
   - Thresholds: keep 70/90 globally, or change them? Only ask about per-segment overrides if they show interest in more granularity.
   - Bar style: keep width 10 and ▓/░, or change width/characters (offer a couple of alternatives like `#`/`-` for plain-ASCII terminals)?
   - Reset-time display: show "(Xh Ym until reset)" for 5h, for 7d, both, or neither?

3. **Validate before writing:**
   - Thresholds must be 0–100, and `yellow < red`.
   - Bar width should be a small positive integer (roughly 4–40).
   - Colors must be from the supported palette listed above — if the user names something else, tell them the supported list and ask again.
   - The written `segments` array must include all four ids (`header`, `ctx`, `5h`, `7d`), using `show: false` rather than omission for anything hidden.

4. **Write the file.** Construct the complete config object (all top-level keys present, mirroring the schema above — merge the user's answered changes onto the current values/defaults yourself before writing) and use the Write tool to save it, pretty-printed, to `~/.claude/cc-limits-config.json`. Create `~/.claude/` first if it doesn't exist.

5. **Confirm.** Show a short human-readable summary of what changed (not a raw JSON dump). Mention that this takes effect on the very next statusline render — no session restart needed (unlike the install step). Mention they can run `/cc-limits:setup` again anytime, and that deleting `~/.claude/cc-limits-config.json` resets everything to defaults.

Keep the whole conversation focused and short — a handful of questions, not twenty. Don't touch any other plugin file, and don't ask about anything outside this schema.
