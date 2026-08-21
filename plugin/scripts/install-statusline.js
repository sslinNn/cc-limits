#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

const MARKER = 'cc-limits-statusline.js';
const OUR_COMMAND = 'node ~/.claude/cc-limits-statusline.js';

const dest = path.join(os.homedir(), '.claude', 'cc-limits-statusline.js');
const src = path.join(__dirname, 'statusline.js');
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);

function readSettings() {
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    return { settings: {}, parseError: false };
  }
  try {
    return { settings: JSON.parse(raw), parseError: false };
  } catch {
    return { settings: null, parseError: true };
  }
}

function classifyStatusLine(settings) {
  const cmd = settings?.statusLine?.command;
  if (typeof cmd !== 'string' || cmd.length === 0) return 'unset';
  return cmd.includes(MARKER) ? 'ours' : 'foreign';
}

function emit(systemMessage) {
  console.log(JSON.stringify({
    systemMessage,
    hookSpecificOutput: { hookEventName: 'SessionStart' },
  }));
}

function main() {
  const { settings, parseError } = readSettings();

  if (parseError) {
    emit(
      `cc-limits: ~/.claude/settings.json has invalid JSON, so the statusline could not be configured automatically. ` +
      `Fix the file, then add this yourself:\n` +
      `{"statusLine": {"type": "command", "command": "${OUR_COMMAND}"}}`,
    );
    return;
  }

  const state = classifyStatusLine(settings);

  if (state === 'unset') {
    const next = { ...settings, statusLine: { type: 'command', command: OUR_COMMAND } };
    fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n');
    emit('cc-limits: statusline enabled automatically.');
    return;
  }

  if (state === 'foreign') {
    emit(
      `cc-limits: left your existing statusLine untouched. To switch to cc-limits instead, add this to ~/.claude/settings.json:\n` +
      `{"statusLine": {"type": "command", "command": "${OUR_COMMAND}"}}`,
    );
    return;
  }

  // state === 'ours' — already configured, nothing to do.
}

main();
