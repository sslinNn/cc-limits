---
description: Apply a cc-limits config produced by the visual configurator
---

The user pasted a cc-limits statusline config, normally straight from `plugin/configurator.html`. Write it to `~/.claude/cc-limits-config.json` for them.

The config is in `$ARGUMENTS`:

```
$ARGUMENTS
```

## What to do

1. **Parse it.** It's normally one line of JSON. If `$ARGUMENTS` is empty, ask the user to paste the config (or point them at `/cc-limits:setup` to answer questions instead) and stop. If it isn't valid JSON, show them the parse error and ask them to re-copy — don't guess at repairs.

2. **Sanity-check it** against the schema in `${CLAUDE_PLUGIN_ROOT}/commands/setup.md`, which is authoritative. Specifically:
   - `thresholds.yellow` and `thresholds.red` are 0–100 with `yellow < red`.
   - `colors.*` are from `green`, `yellow`, `red`, `blue`, `magenta`, `cyan`, `white`.
   - `bar.width` is a small positive integer (roughly 4–40).
   - `segments` is an array of objects with known `id`s (`header`, `ctx`, `5h`, `7d`, `stats`).

   The statusline falls back to its built-in defaults when the file is unreadable, so a malformed config costs the user their statusline rather than breaking Claude Code — still, tell them what's wrong and stop rather than writing something you know is broken.

   Anything you don't recognize but that parses fine, write through unchanged: the config schema grows, and this command shouldn't be the reason a new option gets dropped.

3. **Show what changes.** Read the existing `~/.claude/cc-limits-config.json` if there is one and summarize the difference in plain language — "5h bar gains the time-to-limit estimate, bars move onto one line, everything else unchanged". If there's no existing file, say which settings differ from the defaults. Keep it to a few lines; don't dump JSON at them.

4. **Write it.** Use the Write tool to save the config pretty-printed to `~/.claude/cc-limits-config.json`, creating `~/.claude/` first if needed. Write the whole object as given — don't merge it onto the old file, since the configurator always emits a complete config and a merge would resurrect settings the user just turned off.

5. **Confirm.** One line: it takes effect on the very next statusline render, no restart. Mention that deleting the file restores every default.

Don't touch any other file, and don't edit the plugin itself.
