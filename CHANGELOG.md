# Changelog

Versions are the `version` field in [`plugin/.claude-plugin/plugin.json`](plugin/.claude-plugin/plugin.json).
Update with `/plugin marketplace update cc-limits`; the `SessionStart` hook re-copies the
script on your next session.

## 1.4.0 — 2026-08-22

**Two lines by default.** The five-line layout cost a third of a short terminal for
something you only glance at, so the compact one ships as the default: header and stats
on one line, the three bars on the next, short notes, width-8 bars. Clickable directory
and branch come on with it, as does the burn rate. The old look is one click away —
**Full** in the configurator.

- New `/cc-limits:configure`: builds a copy of the configurator carrying your live
  config and opens it, since a `file://` page can't read `~/.claude` itself.
- The configurator no longer chokes on a pasted config. A hard-wrapped terminal dump
  puts a raw newline inside a string and `JSON.parse` rejects the document over it;
  the page now tries the text as-is first, then repairs progressively — control
  characters, markdown fences, a slash-command prefix, trailing commas, curly quotes.
  The first thing that parses wins, so valid input is never rewritten by a guess.
- **Reset to defaults** in the configurator header.

**Heads up:** a config merges onto the defaults key by key, so a segment that wants a
line of its own now has to say `"row": null` — leaving the key out inherits the default's
row. Configs the configurator writes spell it out for every segment.

## 1.3.0 — 2026-08-22

Layout controls that actually shorten the line, rather than only moving it around.

- `layout.noteStyle: "short"` renders `↻3h53m ~3h0m` instead of
  `(3h53m until reset, ~3h0m to limit)`, and drops the never-changing context-window
  size from the token count. Overridable per segment, with configurable markers for
  terminals that can't draw the arrow.
- `showBar: false` leaves just `5h 40%` — the percentage takes over the color the bar
  was carrying.
- Full / Compact / Minimal presets in the configurator.

## 1.2.0 — 2026-08-22

- **Stats segment:** cost, duration, burn rate, lines changed, and an optional API
  time share.
- **ETA to limit:** `~4h33m to limit`, measured by least squares over sampled history
  instead of assuming the whole window came from this session — so it counts your other
  sessions too.
- **Remembered limits:** Claude Code only sends `rate_limits` after a session's first
  API response, so the 5h/7d bars used to sit blank exactly when you needed them — at
  the start. They now fall back to the last known value, marked stale, and drop it once
  the window resets or ages out. Remembered values never show an ETA.
- Context bar shows token counts; header gains the effort badge, fast-mode marker,
  ahead/behind, worktree name and OSC8 links; segments sharing a `row` render on one line.
- Opt-in terminal title, written to `/dev/tty` since stdout belongs to Claude Code.
- **`plugin/configurator.html`:** every option with a live preview, producing a
  `/cc-limits:apply` command — and `/cc-limits:apply` to write it.
- Fixes: countdowns read in days (`6d23h`, not `167h59m`); percentages clamped;
  sub-minute durations read in seconds; configs merge by key, so an old one picks up
  options added later; `7d` shows its countdown by default, as the README already claimed.

## 1.1.0 — 2026-08-21

- Install configures `statusLine` in `settings.json` on its own, leaving any foreign
  statusline untouched.
- Colors, thresholds, bar style, segment set and order, icons and reset-time display
  become configurable through `~/.claude/cc-limits-config.json`.
- New `/cc-limits:setup` to edit that config conversationally.

## 1.0.0 — 2026-07-20

First release: 5h and 7-day rate-limit bars, a context-window bar, model, directory and
git branch — from the JSON Claude Code already pipes into the statusline command. No
polling, no API calls, zero dependencies.
