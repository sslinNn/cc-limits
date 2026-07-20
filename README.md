# cc-limits

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

Start a new session (or restart Claude Code) so the plugin's `SessionStart` hook copies its script to `~/.claude/cc-limits-statusline.js`.

Then add this to your `~/.claude/settings.json` — this one manual step is required because Claude Code's `statusLine` command can't currently reference a plugin's own install path directly, only hooks/MCP/LSP commands can:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/cc-limits-statusline.js"
  }
}
```

## Update

```
/plugin marketplace update cc-limits
```

The `SessionStart` hook re-copies the script on the next session, so `~/.claude/cc-limits-statusline.js` always matches the installed plugin version.

## License

MIT
