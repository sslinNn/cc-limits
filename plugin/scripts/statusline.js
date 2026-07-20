#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m', RESET = '\x1b[0m';

function color(pct) {
  if (pct == null) return '';
  if (pct >= 90) return RED;
  if (pct >= 70) return YELLOW;
  return GREEN;
}

function bar(pct, width = 10) {
  if (pct == null) return '-'.repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

function pctLabel(pct) {
  return pct == null ? '--' : `${Math.round(pct)}%`;
}

function timeUntil(resetsAt) {
  if (resetsAt == null) return null;
  const diffMs = resetsAt * 1000 - Date.now();
  if (diffMs <= 0) return 'reset';
  const h = Math.floor(diffMs / 3600000);
  const m = Math.floor((diffMs % 3600000) / 60000);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

function render(data) {
  const model = data.model?.display_name ?? '?';
  const dir = path.basename(data.workspace?.current_dir ?? data.cwd ?? '');

  let branch = '';
  try {
    const out = execSync('git branch --show-current', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (out) branch = ` | 🌿 ${out}`;
  } catch {}

  const line1 = `[${model}] 📁 ${dir}${branch}`;

  const segment = (label, pct, suffix = '') =>
    `${label} ${color(pct)}${bar(pct)}${pct != null ? RESET : ''} ${pctLabel(pct)}${suffix}`;

  const lines = [line1];

  const ctxPct = data.context_window?.used_percentage ?? null;
  lines.push(segment('ctx', ctxPct));

  const fiveHour = data.rate_limits?.five_hour;
  if (fiveHour) {
    const eta = timeUntil(fiveHour.resets_at);
    lines.push(segment('5h ', fiveHour.used_percentage ?? null, eta ? ` (${eta} until reset)` : ''));
  }

  const sevenDay = data.rate_limits?.seven_day;
  if (sevenDay) {
    lines.push(segment('7d ', sevenDay.used_percentage ?? null));
  }

  return lines.join('\n');
}

function main() {
  let input = '';
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    try {
      console.log(render(JSON.parse(input)));
    } catch {
      console.log('');
    }
  });
}

function selfTest() {
  assert.strictEqual(bar(0), '░'.repeat(10));
  assert.strictEqual(bar(100), '▓'.repeat(10));
  assert.strictEqual(bar(50), '▓▓▓▓▓░░░░░');
  assert.strictEqual(bar(null), '-'.repeat(10));

  assert.strictEqual(timeUntil(null), null);
  assert.strictEqual(timeUntil(Date.now() / 1000 - 10), 'reset');
  assert.strictEqual(timeUntil(Date.now() / 1000 + 3660), '1h1m');
  assert.strictEqual(timeUntil(Date.now() / 1000 + 120), '2m');

  const withLimits = render({
    model: { display_name: 'Sonnet' },
    workspace: { current_dir: '/x/project' },
    context_window: { used_percentage: 32 },
    rate_limits: {
      five_hour: { used_percentage: 18, resets_at: Date.now() / 1000 + 7260 },
      seven_day: { used_percentage: 41 },
    },
  });
  assert.ok(withLimits.includes('ctx'));
  assert.ok(withLimits.includes('5h'));
  assert.ok(withLimits.includes('7d'));

  const withoutLimits = render({
    model: { display_name: 'Sonnet' },
    workspace: { current_dir: '/x/project' },
    context_window: { used_percentage: null },
  });
  assert.ok(!withoutLimits.includes('5h'));
  assert.ok(withoutLimits.includes('ctx'));

  console.log('self-test OK');
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) {
    selfTest();
  } else {
    main();
  }
}
