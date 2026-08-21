#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const COLOR_CODES = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};
const RESET = '\x1b[0m';

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'cc-limits-config.json');

const DEFAULT_CONFIG = {
  colorsEnabled: true,
  thresholds: { yellow: 70, red: 90 },
  colors: { low: 'green', medium: 'yellow', high: 'red' },
  bar: { width: 10, filledChar: '▓', emptyChar: '░' },
  segments: [
    {
      id: 'header',
      type: 'header',
      show: true,
      parts: [
        { key: 'model', bracket: true },
        { key: 'dir', icon: '📁', separator: ' ' },
        { key: 'branch', icon: '🌿', separator: ' | ' },
      ],
    },
    {
      id: 'ctx',
      type: 'bar',
      show: true,
      label: 'ctx',
      source: 'context_window.used_percentage',
    },
    {
      id: '5h',
      type: 'bar',
      show: true,
      label: '5h ',
      source: 'rate_limits.five_hour.used_percentage',
      presenceSource: 'rate_limits.five_hour',
      showResetIn: true,
      resetSource: 'rate_limits.five_hour.resets_at',
    },
    {
      id: '7d',
      type: 'bar',
      show: true,
      label: '7d ',
      source: 'rate_limits.seven_day.used_percentage',
      presenceSource: 'rate_limits.seven_day',
      showResetIn: false,
      resetSource: 'rate_limits.seven_day.resets_at',
    },
  ],
};

function deepMergeObject(base, override) {
  if (override === undefined) return base;
  if (typeof override !== 'object' || override === null || Array.isArray(override)) return override;
  const out = { ...base };
  for (const key of Object.keys(override)) {
    out[key] = deepMergeObject(base?.[key], override[key]);
  }
  return out;
}

function mergeSegments(defaultSegments, userSegments) {
  if (!Array.isArray(userSegments)) return defaultSegments;
  const byId = new Map(defaultSegments.map(s => [s.id, s]));
  return userSegments.map(u => {
    const base = byId.get(u.id);
    return base ? deepMergeObject(base, u) : u;
  });
}

function mergeConfig(defaults, user) {
  const { segments: userSegments, ...userRest } = user || {};
  const merged = deepMergeObject(defaults, userRest);
  merged.segments = mergeSegments(defaults.segments, userSegments);
  return merged;
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const user = JSON.parse(raw);
    return mergeConfig(DEFAULT_CONFIG, user);
  } catch {
    return DEFAULT_CONFIG;
  }
}

function getByPath(obj, dottedPath) {
  return dottedPath.split('.').reduce((o, key) => (o == null ? undefined : o[key]), obj);
}

function resolveThresholds(segment, config) {
  return segment.thresholds ?? config.thresholds;
}

function resolveColors(segment, config) {
  return segment.colors ?? config.colors;
}

function color(pct, thresholds, colors, colorsEnabled) {
  if (!colorsEnabled || pct == null) return '';
  const name = pct >= thresholds.red ? colors.high : pct >= thresholds.yellow ? colors.medium : colors.low;
  return COLOR_CODES[name] ?? '';
}

function bar(pct, barConfig) {
  const { width, filledChar, emptyChar } = barConfig;
  if (pct == null) return '-'.repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return filledChar.repeat(filled) + emptyChar.repeat(width - filled);
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

function isSegmentPresent(segment, data) {
  if (!segment.presenceSource) return true;
  return getByPath(data, segment.presenceSource) != null;
}

function renderHeaderSegment(segment, data) {
  const values = {
    model: () => data.model?.display_name ?? '?',
    dir: () => path.basename(data.workspace?.current_dir ?? data.cwd ?? ''),
    branch: () => {
      try {
        return execSync('git branch --show-current', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim() || null;
      } catch {
        return null;
      }
    },
  };

  const rendered = [];
  for (const part of segment.parts || []) {
    const value = values[part.key]?.();
    if (!value) continue;
    const text = part.icon ? `${part.icon} ${value}` : value;
    const wrapped = part.bracket ? `[${text}]` : text;
    rendered.push(rendered.length === 0 ? wrapped : `${part.separator ?? ' '}${wrapped}`);
  }
  return rendered.join('');
}

function renderBarSegment(segment, data, config) {
  const pct = getByPath(data, segment.source) ?? null;
  const thresholds = resolveThresholds(segment, config);
  const colors = resolveColors(segment, config);
  const c = color(pct, thresholds, colors, config.colorsEnabled);
  const b = bar(pct, config.bar);

  let suffix = '';
  if (segment.showResetIn && segment.resetSource) {
    const eta = timeUntil(getByPath(data, segment.resetSource));
    if (eta) suffix = ` (${eta} until reset)`;
  }

  return `${segment.label} ${c}${b}${c ? RESET : ''} ${pctLabel(pct)}${suffix}`;
}

function render(data, config = loadConfig()) {
  const lines = [];
  for (const segment of config.segments) {
    if (segment.show === false) continue;
    if (segment.type === 'header') {
      const text = renderHeaderSegment(segment, data);
      if (text) lines.push(text);
    } else if (segment.type === 'bar') {
      if (!isSegmentPresent(segment, data)) continue;
      lines.push(renderBarSegment(segment, data, config));
    }
  }
  return lines.join('\n');
}

function main() {
  const config = loadConfig();
  let input = '';
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    try {
      console.log(render(JSON.parse(input), config));
    } catch {
      console.log('');
    }
  });
}

function selfTest() {
  const defaultBar = DEFAULT_CONFIG.bar;
  assert.strictEqual(bar(0, defaultBar), '░'.repeat(10));
  assert.strictEqual(bar(100, defaultBar), '▓'.repeat(10));
  assert.strictEqual(bar(50, defaultBar), '▓▓▓▓▓░░░░░');
  assert.strictEqual(bar(null, defaultBar), '-'.repeat(10));

  assert.strictEqual(timeUntil(null), null);
  assert.strictEqual(timeUntil(Date.now() / 1000 - 10), 'reset');
  assert.strictEqual(timeUntil(Date.now() / 1000 + 3660), '1h1m');
  assert.strictEqual(timeUntil(Date.now() / 1000 + 120), '2m');

  const fixture = {
    model: { display_name: 'Sonnet' },
    workspace: { current_dir: '/x/project' },
    context_window: { used_percentage: 32 },
    rate_limits: {
      five_hour: { used_percentage: 18, resets_at: Date.now() / 1000 + 7260 },
      seven_day: { used_percentage: 41 },
    },
  };

  const withLimits = render(fixture, DEFAULT_CONFIG);
  assert.ok(withLimits.includes('ctx'));
  assert.ok(withLimits.includes('5h'));
  assert.ok(withLimits.includes('7d'));

  const withoutLimits = render({
    model: { display_name: 'Sonnet' },
    workspace: { current_dir: '/x/project' },
    context_window: { used_percentage: null },
  }, DEFAULT_CONFIG);
  assert.ok(!withoutLimits.includes('5h'));
  assert.ok(withoutLimits.includes('ctx'));

  // deep merge: overriding one threshold must not clobber its sibling
  const mergedThresholds = mergeConfig(DEFAULT_CONFIG, { thresholds: { red: 95 } });
  assert.strictEqual(mergedThresholds.thresholds.red, 95);
  assert.strictEqual(mergedThresholds.thresholds.yellow, 70);

  // an empty user config is equivalent to the defaults (no config file case)
  assert.deepStrictEqual(mergeConfig(DEFAULT_CONFIG, {}), DEFAULT_CONFIG);

  // per-segment threshold override wins over the global one
  const perSegmentConfig = mergeConfig(DEFAULT_CONFIG, {
    segments: [{ id: 'header' }, { id: 'ctx' }, { id: '5h', thresholds: { yellow: 40, red: 50 } }, { id: '7d' }],
  });
  const fiveHourSegment = perSegmentConfig.segments.find(s => s.id === '5h');
  assert.strictEqual(
    color(60, resolveThresholds(fiveHourSegment, perSegmentConfig), resolveColors(fiveHourSegment, perSegmentConfig), true),
    COLOR_CODES.red,
  );
  assert.strictEqual(color(60, DEFAULT_CONFIG.thresholds, DEFAULT_CONFIG.colors, true), COLOR_CODES.green);

  // a segment explicitly hidden via show:false is absent from the output
  const hiddenConfig = mergeConfig(DEFAULT_CONFIG, {
    segments: [{ id: 'header' }, { id: 'ctx', show: false }, { id: '5h' }, { id: '7d' }],
  });
  assert.ok(!render(fixture, hiddenConfig).includes('ctx'));

  // segments render in whatever order the user's array specifies
  const reorderedConfig = mergeConfig(DEFAULT_CONFIG, {
    segments: [{ id: 'header' }, { id: '7d' }, { id: '5h' }, { id: 'ctx' }],
  });
  const reorderedOutput = render(fixture, reorderedConfig);
  assert.ok(reorderedOutput.indexOf('7d') < reorderedOutput.indexOf('5h'));
  assert.ok(reorderedOutput.indexOf('5h') < reorderedOutput.indexOf('ctx'));

  // colorsEnabled:false strips all ANSI escapes even past the red threshold
  const noColorOutput = render(fixture, mergeConfig(DEFAULT_CONFIG, { colorsEnabled: false }));
  assert.ok(!noColorOutput.includes('\x1b['));

  // an unresolvable source never throws, it just shows the placeholder
  const brokenSourceConfig = mergeConfig(DEFAULT_CONFIG, {
    segments: [{ id: 'header' }, { id: 'ctx', source: 'nope.does.not.exist' }, { id: '5h' }, { id: '7d' }],
  });
  assert.ok(render(fixture, brokenSourceConfig).includes('--'));

  // a segment omitted from the user's list is hidden, not silently re-appended
  const partialListConfig = mergeConfig(DEFAULT_CONFIG, {
    segments: [{ id: 'header' }, { id: 'ctx' }, { id: '5h' }],
  });
  assert.ok(!render(fixture, partialListConfig).includes('7d'));

  console.log('self-test OK');
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) {
    selfTest();
  } else {
    main();
  }
}
