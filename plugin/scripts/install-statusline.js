#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

const dest = path.join(os.homedir(), '.claude', 'cc-limits-statusline.js');
const src = path.join(__dirname, 'statusline.js');

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);

function isStatusLineConfigured() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return !!settings.statusLine?.command?.includes('cc-limits-statusline.js');
  } catch {
    return false;
  }
}

if (!isStatusLineConfigured()) {
  console.log(JSON.stringify({
    systemMessage:
      'cc-limits: add this to ~/.claude/settings.json to enable the statusline:\n' +
      '{"statusLine": {"type": "command", "command": "node ~/.claude/cc-limits-statusline.js"}}',
    hookSpecificOutput: { hookEventName: 'SessionStart' },
  }));
}
