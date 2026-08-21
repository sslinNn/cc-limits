# cc-limits

[![Listed on ClaudePluginHub](https://www.claudepluginhub.com/badge/sslinnn-cc-limits-plugin)](https://www.claudepluginhub.com/plugins/sslinnn-cc-limits-plugin?ref=badge)

A Claude Code statusline plugin that shows, in realtime:

- **context** — how much of the current session's context window is used
- **5h** — Claude.ai Pro/Max 5-hour rate-limit usage, with time until reset
- **7d** — Claude.ai Pro/Max weekly rate-limit usage

All data comes from Claude Code's built-in [statusline JSON](https://code.claude.com/docs/en/statusline) — no polling, no external API calls, no daemon.

```
[Sonnet] 📁 my-project | 🌿 main

ctx ▓▓▓░░░░░░░ 32%

5h  ▓▓░░░░░░░░ 18% (2h0m until reset)

7d  ▓▓▓▓░░░░░░ 41%
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

## Customization

Run `/cc-limits:setup` any time to interactively customize colors, thresholds, which segments show and in what order, icons, and bar style — just answer the questions, no file editing required.

Defaults:

| Setting | Default |
|---|---|
| Segments (in order) | header (model, dir, git branch), ctx, 5h, 7d |
| Colors | green (`<70%`), yellow (`70-89%`), red (`≥90%`) |
| Bar | width 10, `▓` filled / `░` empty |
| Reset-time-until | shown for 5h, hidden for 7d |
| Icons | 📁 for the directory, 🌿 for the git branch |

Advanced: the config lives at `~/.claude/cc-limits-config.json` as plain JSON matching the schema `/cc-limits:setup` writes, if you'd rather edit it directly.

## Update

```
/plugin marketplace update cc-limits
```

The `SessionStart` hook re-copies the script on the next session, so `~/.claude/cc-limits-statusline.js` always matches the installed plugin version.

## License

MIT
