---
description: Open the visual cc-limits configurator with your current config already loaded
---

Build a copy of the cc-limits configurator with the user's live config baked into it, and point them at it. The page is opened from `file://`, so it can't read `~/.claude/cc-limits-config.json` on its own — injecting it is what makes the controls start from the user's real statusline instead of the defaults.

## What to do

1. **Read the current config** from `~/.claude/cc-limits-config.json`. If the file doesn't exist or doesn't parse as JSON, that's fine and expected — skip the injection entirely in step 3, and mention that the page starts from the plugin defaults because there's no config yet (or because the existing one is unreadable — quote the parse error in that case, and don't overwrite the file).

2. **Read the page** at `${CLAUDE_PLUGIN_ROOT}/configurator.html`.

3. **Inject the config.** The page contains this line:

   ```html
   <!-- cc-limits:injected-config -->
   ```

   Replace exactly that line with a script tag assigning the config to `window.CC_LIMITS_CONFIG`:

   ```html
   <script>window.CC_LIMITS_CONFIG = {…the config, as one line of JSON…};</script>
   ```

   Write the JSON compactly on one line, exactly as read — no reformatting, no fixing up, no adding keys. The page validates it itself and falls back to its defaults if it's not an object.

4. **Write the result** to `~/.claude/cc-limits-configurator.html`, overwriting any previous copy. This file is a generated artifact — it's rebuilt every time this command runs, so it's never a place the user should edit anything.

5. **Open it.** Run the platform's opener on that path — `xdg-open` on Linux, `open` on macOS, `start` on Windows — and don't treat a non-zero exit as a failure: plenty of setups have no default browser wired up. Either way, print the path so the user can open it themselves:

   ```
   ~/.claude/cc-limits-configurator.html
   ```

6. **Say what to do there,** in two lines at most: every control already matches their statusline; when it looks right, hit **Copy command** and paste the resulting `/cc-limits:apply …` line back into Claude Code. Mention **Reset to defaults** in the page header only if they seem to be looking for a way back.

Don't edit the plugin's own `configurator.html`, don't touch `~/.claude/cc-limits-config.json`, and don't try to apply anything yourself — this command only builds and opens the page.
