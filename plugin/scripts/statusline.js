#!/usr/bin/env node
const { execFileSync } = require('child_process');
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
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const STATE_PATH = path.join(os.homedir(), '.claude', 'cc-limits-state.json');
const STATE_VERSION = 1;

// Effort tiers, high→low. An explicit map because 'max' and 'medium' share a first letter.
const EFFORT_BADGE = { max: 'MAX', xhigh: 'X', high: 'H', medium: 'M', low: 'L' };
// Claude Code's unset default for every model whose picker exposes an effort tier.
const DEFAULT_EFFORT = 'high';
const EFFORT_MODELS = ['opus', 'sonnet', 'fable'];

// Below this utilization-per-minute the depletion estimate stretches past a week — useless.
const MIN_DEPLETION_RATE = 0.01;
// Past a day the estimate is meaningless anyway: the window itself resets first.
const MAX_DEPLETION_MINUTES = 24 * 60;
// Two samples a few seconds apart describe noise, not a trend.
const MIN_HISTORY_SPAN_MINUTES = 2;
// A drop this large means the window rolled over, even if resets_at didn't tell us.
const ROLLOVER_DROP_PCT = 1;

const DEFAULT_CONFIG = {
  colorsEnabled: true,
  thresholds: { yellow: 70, red: 90 },
  colors: { low: 'green', medium: 'yellow', high: 'red' },
  bar: { width: 10, filledChar: '▓', emptyChar: '░', staleMarker: '~' },
  layout: { joiner: ' │ ', noteStyle: 'full', noteMarkers: { reset: '↻', limit: '~' } },
  git: { timeoutMs: 250 },
  state: {
    enabled: true,
    minSampleSeconds: 30,
    maxHistory: 60,
    maxAgeMinutes: 720,
  },
  terminalTitle: { enabled: false, template: 'ctx {ctx}% · 5h {5h}% · {dir}' },
  segments: [
    {
      id: 'header',
      type: 'header',
      show: true,
      parts: [
        { key: 'model', bracket: true, effort: true },
        { key: 'dir', icon: '📁', separator: ' ', link: false },
        { key: 'branch', icon: '🌿', separator: ' | ', aheadBehind: true, link: false },
        { key: 'worktree', icon: '🌳', separator: ' | ' },
      ],
    },
    {
      id: 'ctx',
      type: 'bar',
      show: true,
      label: 'ctx',
      source: 'context_window.used_percentage',
      showBar: true,
      showUsage: true,
      usage: {
        usedSource: 'context_window.current_usage',
        totalSource: 'context_window.context_window_size',
      },
    },
    {
      id: '5h',
      type: 'bar',
      show: true,
      label: '5h ',
      source: 'rate_limits.five_hour.used_percentage',
      presenceSource: 'rate_limits.five_hour',
      showBar: true,
      showResetIn: true,
      resetSource: 'rate_limits.five_hour.resets_at',
      showDepletion: true,
    },
    {
      id: '7d',
      type: 'bar',
      show: true,
      label: '7d ',
      source: 'rate_limits.seven_day.used_percentage',
      presenceSource: 'rate_limits.seven_day',
      showBar: true,
      showResetIn: true,
      resetSource: 'rate_limits.seven_day.resets_at',
      showDepletion: false,
    },
    {
      id: 'stats',
      type: 'stats',
      show: true,
      separator: ' · ',
      parts: [
        { key: 'cost' },
        { key: 'duration', icon: '⏱' },
        { key: 'burn', icon: '🔥' },
        { key: 'lines' },
      ],
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

/**
 * Merge a user's `parts` onto the defaults by `key`, the way segments merge by `id`.
 * Plain array replacement would be simpler, but then a config written before a part
 * gained an option (effort badges, ahead/behind) could never pick that option up —
 * the array in the file would keep overwriting it with the older shape.
 * Order and membership stay the user's: a part they dropped stays dropped.
 */
function mergeParts(defaultParts, userParts) {
  if (!Array.isArray(userParts)) return defaultParts;
  const byKey = new Map((defaultParts || []).map(p => [p.key, p]));
  return userParts.map(u => {
    const base = byKey.get(u.key);
    return base ? deepMergeObject(base, u) : u;
  });
}

function mergeSegments(defaultSegments, userSegments) {
  if (!Array.isArray(userSegments)) return defaultSegments;
  const byId = new Map(defaultSegments.map(s => [s.id, s]));
  return userSegments.map(u => {
    const base = byId.get(u.id);
    if (!base) return u;
    const merged = deepMergeObject(base, u);
    if (base.parts) merged.parts = mergeParts(base.parts, u.parts);
    return merged;
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

function emptyState() {
  return { version: STATE_VERSION, windows: {} };
}

/**
 * Rate-limit windows Claude Code has told us about, remembered across renders.
 *
 * Two things need this. Claude Code only puts `rate_limits` in the payload after the
 * session's first API response, so the 5h/7d bars would otherwise sit blank at the
 * start of every session; and a single render can't tell how fast a window is filling,
 * which is what makes the "to limit" estimate a guess rather than a measurement.
 */
function loadState(statePath = STATE_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed?.version !== STATE_VERSION || typeof parsed.windows !== 'object') return emptyState();
    return { version: STATE_VERSION, windows: parsed.windows ?? {} };
  } catch {
    return emptyState();
  }
}

/**
 * Write via a temp file and rename: several Claude Code sessions share this file, and a
 * torn write would cost every one of them their history.
 */
function saveState(state, statePath = STATE_PATH) {
  const tmp = `${statePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, statePath);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Nothing left to clean up.
    }
  }
}

/** Every bar segment that reads a rate-limit window, keyed by that window's path. */
function windowSegments(config) {
  return (config.segments || []).filter(s => s.type === 'bar' && s.presenceSource);
}

/**
 * Fold this render's live values into the state. Returns true when something changed
 * and the file is worth rewriting — most renders add nothing and skip the write.
 */
function sampleWindows(config, data, state, nowSec) {
  const { minSampleSeconds, maxHistory } = config.state;
  let changed = false;

  for (const segment of windowSegments(config)) {
    if (getByPath(data, segment.presenceSource) == null) continue;
    const pct = getByPath(data, segment.source);
    if (!Number.isFinite(pct)) continue;

    const resetsAt = segment.resetSource ? getByPath(data, segment.resetSource) ?? null : null;
    const key = segment.presenceSource;
    const prev = state.windows[key];

    // A new reset timestamp — or a percentage that fell — means this is a fresh window,
    // and samples from the old one would flatten the slope into nonsense.
    const rolled = prev && (prev.resetsAt !== resetsAt || pct < prev.usedPercentage - ROLLOVER_DROP_PCT);
    const history = !prev || rolled ? [] : prev.history.slice();

    const last = history[history.length - 1];
    if (!last || nowSec - last[0] >= minSampleSeconds) {
      history.push([nowSec, pct]);
      if (history.length > maxHistory) history.splice(0, history.length - maxHistory);
      changed = true;
    } else if (pct !== last[1]) {
      // Same sampling slot, newer number: correct the point rather than adding one.
      last[1] = pct;
      changed = true;
    }

    if (!prev || prev.usedPercentage !== pct || prev.resetsAt !== resetsAt) changed = true;
    state.windows[key] = { usedPercentage: pct, resetsAt, seenAt: nowSec, history };
  }

  return changed;
}

/**
 * What to draw for a bar segment: the live payload when Claude Code sent one, otherwise
 * the last value we saw, flagged stale. A remembered value is dropped once its window
 * has reset (the number would be a lie) or once it's simply too old to trust.
 */
function windowValues(segment, data, state, config, nowSec) {
  const key = segment.presenceSource;
  const remembered = key ? state?.windows?.[key] : undefined;

  if (!key || getByPath(data, key) != null) {
    return {
      pct: getByPath(data, segment.source) ?? null,
      resetsAt: segment.resetSource ? getByPath(data, segment.resetSource) ?? null : null,
      history: remembered?.history,
      stale: false,
    };
  }

  if (!config.state?.enabled || !remembered) return null;
  if (remembered.resetsAt != null && remembered.resetsAt <= nowSec) return null;
  if (nowSec - remembered.seenAt > config.state.maxAgeMinutes * 60) return null;

  return {
    pct: remembered.usedPercentage,
    resetsAt: remembered.resetsAt,
    history: remembered.history,
    stale: true,
  };
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

function paint(text, colorName, colorsEnabled) {
  const code = colorsEnabled ? COLOR_CODES[colorName] : undefined;
  return code ? `${code}${text}${RESET}` : text;
}

function bar(pct, barConfig) {
  const { width, filledChar, emptyChar } = barConfig;
  if (pct == null) return '-'.repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return filledChar.repeat(filled) + emptyChar.repeat(width - filled);
}

function pctLabel(pct) {
  if (pct == null) return '--';
  return `${Math.min(100, Math.max(0, Math.round(pct)))}%`;
}

function formatTokens(tokens) {
  if (tokens == null || !Number.isFinite(tokens)) return null;
  const abs = Math.abs(tokens);
  if (abs >= 1e6) {
    const value = tokens / 1e6;
    return `${Math.abs(value) >= 10 ? Math.round(value) : value.toFixed(1)}M`;
  }
  if (abs >= 1e3) {
    const value = tokens / 1e3;
    return `${Math.abs(value) >= 10 ? Math.round(value) : value.toFixed(1)}K`;
  }
  return String(Math.round(tokens));
}

// Days matter here: a 7-day window's reset reads as "6d23h", not "167h59m".
function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  // Below a minute, "0m" reads as broken — a fresh session should show it ticking.
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function timeUntil(resetsAt) {
  if (resetsAt == null) return null;
  const diffMs = resetsAt * 1000 - Date.now();
  if (diffMs <= 0) return 'reset';
  return formatDurationMs(diffMs);
}

// Context is what the model reads back: input plus both cache halves, output excluded.
function contextUsedTokens(usage) {
  if (typeof usage === 'number') return usage;
  if (!usage || typeof usage !== 'object') return null;
  const sum =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  return Number.isFinite(sum) ? sum : null;
}

function totalTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const sum = (contextUsedTokens(usage) ?? 0) + (usage.output_tokens ?? 0);
  return Number.isFinite(sum) ? sum : null;
}

function elapsedMinutes(data) {
  const ms = data?.cost?.total_duration_ms;
  return Number.isFinite(ms) && ms > 0 ? ms / 60000 : null;
}

/**
 * Percent-per-minute this window is actually filling, by least squares over the
 * remembered samples. Measured rather than assumed: it counts usage from other
 * sessions, and from before this one started, both of which the session-elapsed
 * fallback below silently attributes to us.
 */
function historyRate(history) {
  if (!Array.isArray(history) || history.length < 2) return null;

  const spanMinutes = (history[history.length - 1][0] - history[0][0]) / 60;
  if (spanMinutes < MIN_HISTORY_SPAN_MINUTES) return null;

  const originSec = history[0][0];
  const points = history.map(([ts, pct]) => [(ts - originSec) / 60, pct]);
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / points.length;

  let covariance = 0;
  let variance = 0;
  for (const [x, y] of points) {
    covariance += (x - meanX) * (y - meanY);
    variance += (x - meanX) ** 2;
  }
  if (variance === 0) return null;

  const slope = covariance / variance;
  return Number.isFinite(slope) && slope > 0 ? slope : null;
}

/**
 * Percent-per-minute inferred from this session alone — the fallback used until the
 * history has enough spread to measure. It attributes the whole window's utilization
 * to this session, so it reads pessimistically early on and settles as the session runs.
 */
function sessionRate(pct, data) {
  const minutes = elapsedMinutes(data);
  if (minutes == null || pct == null) return null;
  const rate = pct / minutes;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * Minutes until this window hits 100% at the rate we can best establish.
 *
 * Pass `data` as null to withhold the session-elapsed fallback. Callers do that for a
 * remembered value, where the fallback's premise is known to be false: the percentage
 * came from earlier sessions, so dividing it by a young session's runtime invents a
 * furious burn rate and an ETA of minutes.
 */
function depletionEta(pct, data, history) {
  if (pct == null || pct < 1) return null;

  const ratePerMinute = historyRate(history) ?? sessionRate(pct, data);
  if (ratePerMinute == null || ratePerMinute < MIN_DEPLETION_RATE) return null;

  const remaining = (100 - pct) / ratePerMinute;
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > MAX_DEPLETION_MINUTES) return null;
  return formatDurationMs(remaining * 60000);
}

function burnRatePerMinute(data) {
  const minutes = elapsedMinutes(data);
  const tokens = totalTokens(data.context_window?.current_usage);
  if (minutes == null || tokens == null) return null;
  const perMinute = tokens / minutes;
  return Number.isFinite(perMinute) && perMinute >= 0 ? perMinute : null;
}

/**
 * Terminals that don't understand OSC8 print the text and drop the escapes, so
 * wrapping is always safe.
 * @see https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda
 */
function osc8Link(url, text) {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function gitExec(args, cwd, timeoutMs) {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim() || null;
  } catch {
    return null;
  }
}

function gitAheadBehind(cwd, timeoutMs) {
  const out = gitExec(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], cwd, timeoutMs);
  if (!out) return null;
  const [behind, ahead] = out.split(/\s+/).map(n => parseInt(n, 10));
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
  return { ahead, behind };
}

/** Turn a git remote (ssh or https) into a browsable branch URL, or null if unrecognized. */
function remoteBranchUrl(remote, branch) {
  if (!remote || !branch) return null;
  let host;
  let repoPath;
  const scp = remote.match(/^(?:[^@]+@)?([^/:]+):(.+?)(?:\.git)?$/);
  const url = remote.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/);
  if (url) {
    host = url[1].replace(/:\d+$/, '');
    repoPath = url[2];
  } else if (scp) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    return null;
  }
  return `https://${host}/${repoPath}/tree/${encodeURIComponent(branch)}`;
}

/**
 * Effort tier and fast mode as configured, not as reported: Claude Code doesn't put
 * either in the statusline payload, so settings.json (then the env override) is the
 * only source. An unset tier is 'high' — Claude Code's own default.
 */
function readModelSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    const effort = EFFORT_BADGE[settings.effortLevel] ? settings.effortLevel : null;
    return { effortLevel: effort ?? DEFAULT_EFFORT, fastMode: settings.fastMode === true };
  } catch {
    const envEffort = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    return {
      effortLevel: EFFORT_BADGE[envEffort] ? envEffort : DEFAULT_EFFORT,
      fastMode: false,
    };
  }
}

function workspaceDir(data) {
  return data.workspace?.current_dir ?? data.cwd ?? '';
}

function renderModelPart(part, data) {
  const name = data.model?.display_name ?? '?';
  if (!part.effort) return name;

  const lower = name.toLowerCase();
  if (!EFFORT_MODELS.some(m => lower.includes(m))) return name;

  const { effortLevel, fastMode } = readModelSettings();
  const badge = EFFORT_BADGE[effortLevel];
  // Fast mode is an Opus-only toggle; showing it elsewhere would be noise.
  const fast = fastMode && lower.includes('opus') ? ' ↯' : '';
  return `${name}(${badge})${fast}`;
}

function renderBranchPart(part, data, config) {
  const cwd = workspaceDir(data) || undefined;
  const timeoutMs = config.git?.timeoutMs ?? 250;
  const branch = gitExec(['branch', '--show-current'], cwd, timeoutMs);
  if (!branch) return null;

  let text = branch;
  if (part.aheadBehind) {
    const ab = gitAheadBehind(cwd, timeoutMs);
    if (ab) {
      const marks = `${ab.ahead > 0 ? `↑${ab.ahead}` : ''}${ab.behind > 0 ? `↓${ab.behind}` : ''}`;
      if (marks) text += ` ${marks}`;
    }
  }
  if (part.link) {
    const url = remoteBranchUrl(gitExec(['remote', 'get-url', 'origin'], cwd, timeoutMs), branch);
    if (url) text = osc8Link(url, text);
  }
  return text;
}

function renderHeaderSegment(segment, data, config) {
  const values = {
    model: part => renderModelPart(part, data),
    dir: part => {
      const dir = workspaceDir(data);
      if (!dir) return null;
      const name = path.basename(dir);
      return part.link ? osc8Link(`file://${dir}`, name) : name;
    },
    branch: part => renderBranchPart(part, data, config),
    worktree: () => data.worktree?.name ?? null,
  };

  const rendered = [];
  for (const part of segment.parts || []) {
    const value = values[part.key]?.(part);
    if (!value) continue;
    const text = part.icon ? `${part.icon} ${value}` : value;
    const wrapped = part.bracket ? `[${text}]` : text;
    rendered.push(rendered.length === 0 ? wrapped : `${part.separator ?? ' '}${wrapped}`);
  }
  return rendered.join('');
}

/**
 * The notes are by far the widest thing on a bar line, so `noteStyle: 'short'` trades
 * the words for markers: `↻3h53m ~3h0m` instead of `(3h53m until reset, ~3h0m to limit)`.
 * The markers are configurable because an ASCII-only terminal needs `r`/`~` where a
 * Unicode one wants the arrow.
 */
function resolveNotes(segment, config) {
  const style = segment.noteStyle ?? config.layout?.noteStyle ?? 'full';
  const markers = { ...DEFAULT_CONFIG.layout.noteMarkers, ...(config.layout?.noteMarkers ?? {}) };
  return { short: style === 'short', markers };
}

function renderBarSegment(segment, data, config, values) {
  const { pct, resetsAt, history, stale } = values;
  const thresholds = resolveThresholds(segment, config);
  const colors = resolveColors(segment, config);
  const c = color(pct, thresholds, colors, config.colorsEnabled);
  const off = c ? RESET : '';
  const { short, markers } = resolveNotes(segment, config);

  let usage = '';
  if (segment.showUsage && segment.usage) {
    const used = contextUsedTokens(getByPath(data, segment.usage.usedSource));
    const total = getByPath(data, segment.usage.totalSource);
    const usedText = formatTokens(used);
    const totalText = formatTokens(total);
    // Short form drops the window size: it never changes, so it carries no news.
    if (usedText && totalText) usage = short ? ` ${usedText}` : ` ${usedText}/${totalText}`;
  }

  const notes = [];
  if (segment.showResetIn && resetsAt != null) {
    const eta = timeUntil(resetsAt);
    if (eta) notes.push(eta === 'reset' ? 'reset' : short ? `${markers.reset}${eta}` : `${eta} until reset`);
  }
  if (segment.showDepletion) {
    const eta = depletionEta(pct, stale ? null : data, history);
    if (eta) notes.push(short ? `${markers.limit}${eta}` : `~${eta} to limit`);
  }
  const suffix = notes.length ? (short ? ` ${notes.join(' ')}` : ` (${notes.join(', ')})`) : '';

  // The marker takes the gap's place rather than adding a column, so bars stay aligned.
  const gap = stale ? (config.bar.staleMarker ?? '~') : ' ';

  // With the bar hidden there is nothing left to carry the color, so the percentage takes it.
  const showBar = segment.showBar !== false;
  const shape = showBar ? `${c}${bar(pct, config.bar)}${off} ` : '';
  const percentage = showBar ? pctLabel(pct) : `${c}${pctLabel(pct)}${off}`;

  return `${segment.label}${gap}${shape}${percentage}${usage}${suffix}`;
}

function renderStatsSegment(segment, data, config) {
  const enabled = config.colorsEnabled;
  const values = {
    cost: () => {
      const usd = data.cost?.total_cost_usd;
      return Number.isFinite(usd) ? `$${usd.toFixed(2)}` : null;
    },
    duration: () => {
      const ms = data.cost?.total_duration_ms;
      return Number.isFinite(ms) && ms > 0 ? formatDurationMs(ms) : null;
    },
    burn: () => {
      const perMinute = burnRatePerMinute(data);
      return perMinute == null ? null : `${formatTokens(Math.round(perMinute))}/min`;
    },
    lines: () => {
      const added = data.cost?.total_lines_added ?? 0;
      const removed = data.cost?.total_lines_removed ?? 0;
      if (!added && !removed) return null;
      return `${paint(`+${added}`, 'green', enabled)} ${paint(`-${removed}`, 'red', enabled)}`;
    },
    apiTime: () => {
      const api = data.cost?.total_api_duration_ms;
      const total = data.cost?.total_duration_ms;
      if (!Number.isFinite(api) || !Number.isFinite(total) || total <= 0) return null;
      return `api ${Math.round((api / total) * 100)}%`;
    },
  };

  const rendered = [];
  for (const part of segment.parts || []) {
    const value = values[part.key]?.();
    if (!value) continue;
    rendered.push(part.icon ? `${part.icon} ${value}` : value);
  }
  return rendered.join(segment.separator ?? ' · ');
}

/**
 * Segments sharing a `row` value land on one line, joined by `layout.joiner`;
 * a segment without one keeps a line to itself, which is the default layout.
 */
function render(data, config = loadConfig(), state = null, nowSec = Math.floor(Date.now() / 1000)) {
  const rows = new Map();
  const push = (key, text) => {
    if (!text) return;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(text);
  };

  for (const segment of config.segments) {
    if (segment.show === false) continue;
    const key = segment.row != null ? `row:${segment.row}` : `solo:${segment.id}`;

    if (segment.type === 'header') {
      push(key, renderHeaderSegment(segment, data, config));
    } else if (segment.type === 'bar') {
      const values = windowValues(segment, data, state, config, nowSec);
      if (!values) continue;
      push(key, renderBarSegment(segment, data, config, values));
    } else if (segment.type === 'stats') {
      push(key, renderStatsSegment(segment, data, config));
    }
  }

  const joiner = config.layout?.joiner ?? ' │ ';
  return [...rows.values()].map(parts => parts.join(joiner)).join('\n');
}

/**
 * Values a title template can interpolate. Percentages come from the state so the title
 * survives the same gaps the bars do, and render as an empty string when unknown.
 */
function titleTokens(data, state) {
  const windowPct = key => {
    const live = getByPath(data, `${key}.used_percentage`);
    const pct = Number.isFinite(live) ? live : state?.windows?.[key]?.usedPercentage;
    return Number.isFinite(pct) ? String(Math.round(pct)) : '';
  };
  const ctx = data.context_window?.used_percentage;
  const cost = data.cost?.total_cost_usd;

  return {
    model: data.model?.display_name ?? '',
    dir: path.basename(workspaceDir(data)) || '',
    ctx: Number.isFinite(ctx) ? String(Math.round(ctx)) : '',
    '5h': windowPct('rate_limits.five_hour'),
    '7d': windowPct('rate_limits.seven_day'),
    cost: Number.isFinite(cost) ? cost.toFixed(2) : '',
  };
}

/**
 * Set the terminal's title, so the numbers stay visible while Claude Code is in a
 * background tab. Written straight to the tty: stdout belongs to Claude Code, which
 * renders it as statusline text rather than passing the escape through.
 * Off by default — it writes outside our own line, which not every setup wants.
 */
function writeTerminalTitle(config, data, state) {
  const title = config.terminalTitle;
  if (!title?.enabled || typeof title.template !== 'string') return;

  const tokens = titleTokens(data, state);
  const text = title.template
    .replace(/\{(\w+)\}/g, (match, key) => (key in tokens ? tokens[key] : match))
    // Control characters would end the escape sequence early and spill into the terminal.
    .replace(/[\x00-\x1f\x7f]/g, '');

  try {
    fs.writeFileSync('/dev/tty', `\x1b]0;${text}\x07`);
  } catch {
    // No controlling terminal (or Windows) — the statusline itself is unaffected.
  }
}

function main() {
  const config = loadConfig();
  let input = '';
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    let data;
    try {
      data = JSON.parse(input);
    } catch {
      console.log('');
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    let state = null;
    if (config.state?.enabled) {
      state = loadState();
      if (sampleWindows(config, data, state, nowSec)) saveState(state);
    }

    try {
      console.log(render(data, config, state, nowSec));
    } catch {
      console.log('');
    }
    writeTerminalTitle(config, data, state);
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
  // a 7-day window reads in days, not a three-digit hour count
  assert.strictEqual(timeUntil(Date.now() / 1000 + 604740), '6d23h');

  // a percentage past the ends of the scale is clamped, never printed raw
  assert.strictEqual(pctLabel(105), '100%');
  assert.strictEqual(pctLabel(-3), '0%');
  assert.strictEqual(pctLabel(null), '--');

  assert.strictEqual(formatTokens(950), '950');
  assert.strictEqual(formatTokens(1500), '1.5K');
  assert.strictEqual(formatTokens(64000), '64K');
  assert.strictEqual(formatTokens(2500000), '2.5M');
  assert.strictEqual(formatTokens(null), null);

  assert.strictEqual(formatDurationMs(0), '0s');
  assert.strictEqual(formatDurationMs(30000), '30s');
  assert.strictEqual(formatDurationMs(300000), '5m');
  assert.strictEqual(formatDurationMs(5400000), '1h30m');
  assert.strictEqual(formatDurationMs(183600000), '2d3h');

  // context counts input plus both cache halves, and excludes output
  assert.strictEqual(
    contextUsedTokens({
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 3000,
    }),
    6000,
  );
  assert.strictEqual(contextUsedTokens(null), null);

  // depletion: 20% burned over 60 minutes leaves 80% at 0.333%/min → ~4 hours
  assert.strictEqual(depletionEta(20, { cost: { total_duration_ms: 3600000 } }), '4h0m');
  // too slow to matter, too little data, or already past a day → nothing to show
  assert.strictEqual(depletionEta(0.5, { cost: { total_duration_ms: 3600000 } }), null);
  assert.strictEqual(depletionEta(20, {}), null);
  assert.strictEqual(depletionEta(1, { cost: { total_duration_ms: 3600000 } }), null);

  // a measured slope of 1%/min over 10 minutes leaves 50% → 50 minutes, and it wins
  // over the session-elapsed guess (which would read 5h from the same numbers)
  const risingHistory = [[0, 40], [300, 45], [600, 50]];
  assert.strictEqual(historyRate(risingHistory), 1);
  assert.strictEqual(depletionEta(50, { cost: { total_duration_ms: 36000000 } }, risingHistory), '50m');
  // too few samples, too short a span, or a flat window → fall back / show nothing
  assert.strictEqual(historyRate([[0, 40]]), null);
  assert.strictEqual(historyRate([[0, 40], [30, 45]]), null);
  assert.strictEqual(historyRate([[0, 40], [600, 40]]), null);
  // a flat stretch usually means the limit just hasn't ticked yet (it updates far less
  // often than we sample), so the session estimate takes over rather than the bar
  // claiming the usage stopped: 50% over 600 minutes → 10h
  assert.strictEqual(depletionEta(50, { cost: { total_duration_ms: 36000000 } }, [[0, 40], [600, 40]]), '10h0m');

  assert.strictEqual(remoteBranchUrl('git@github.com:u/r.git', 'main'), 'https://github.com/u/r/tree/main');
  assert.strictEqual(remoteBranchUrl('https://gitlab.com/g/p.git', 'dev'), 'https://gitlab.com/g/p/tree/dev');
  assert.strictEqual(remoteBranchUrl('/srv/local.git', 'main'), null);

  const fixture = {
    model: { display_name: 'Sonnet' },
    workspace: { current_dir: '/x/project' },
    context_window: {
      used_percentage: 32,
      context_window_size: 200000,
      current_usage: {
        input_tokens: 4000,
        output_tokens: 1000,
        cache_creation_input_tokens: 10000,
        cache_read_input_tokens: 50000,
      },
    },
    cost: {
      total_cost_usd: 1.234,
      total_duration_ms: 3600000,
      total_api_duration_ms: 1200000,
      total_lines_added: 320,
      total_lines_removed: 85,
    },
    rate_limits: {
      five_hour: { used_percentage: 18, resets_at: Date.now() / 1000 + 7260 },
      seven_day: { used_percentage: 41 },
    },
  };

  const withLimits = render(fixture, DEFAULT_CONFIG);
  assert.ok(withLimits.includes('ctx'));
  // the weekly window's countdown reads in days, which is why it is on by default
  assert.ok(/7d .*6d23h until reset/.test(render({
    ...fixture,
    rate_limits: { ...fixture.rate_limits, seven_day: { used_percentage: 41, resets_at: Date.now() / 1000 + 604740 } },
  }, DEFAULT_CONFIG)));
  assert.ok(withLimits.includes('5h'));
  assert.ok(withLimits.includes('7d'));

  // ctx carries its token counts, the 5h bar carries both reset and depletion notes
  assert.ok(withLimits.includes('64K/200K'));
  assert.ok(/5h .*\dm until reset, ~4h33m to limit/.test(withLimits));

  // stats renders cost, duration, burn rate and the line delta
  assert.ok(withLimits.includes('$1.23'));
  assert.ok(withLimits.includes('⏱ 1h0m'));
  assert.ok(withLimits.includes('🔥 1.1K/min'));
  assert.ok(withLimits.includes('+320'));
  assert.ok(withLimits.includes('-85'));

  const withoutLimits = render({
    model: { display_name: 'Sonnet' },
    workspace: { current_dir: '/x/project' },
    context_window: { used_percentage: null },
  }, DEFAULT_CONFIG);
  assert.ok(!withoutLimits.includes('5h'));
  assert.ok(withoutLimits.includes('ctx'));
  // no usage payload means no token counts rather than a "null/null" placeholder
  assert.ok(!/\d+K\//.test(withoutLimits));

  // an effort badge is appended only for models that have an effort tier
  const effortHeader = renderHeaderSegment(
    { parts: [{ key: 'model', bracket: true, effort: true }] },
    { model: { display_name: 'Sonnet' } },
    DEFAULT_CONFIG,
  );
  assert.ok(/^\[Sonnet\((MAX|X|H|M|L)\)\]$/.test(effortHeader));
  assert.strictEqual(
    renderHeaderSegment(
      { parts: [{ key: 'model', bracket: true, effort: true }] },
      { model: { display_name: 'Haiku 4.5' } },
      DEFAULT_CONFIG,
    ),
    '[Haiku 4.5]',
  );

  // worktree shows up only during a --worktree session
  assert.ok(render({ ...fixture, worktree: { name: 'feature' } }, DEFAULT_CONFIG).includes('🌳 feature'));
  assert.ok(!withLimits.includes('🌳'));

  // a part keeps options it never listed, so an older config still gains new ones
  const olderPartsConfig = mergeConfig(DEFAULT_CONFIG, {
    segments: [
      { id: 'header', parts: [{ key: 'model', bracket: true }, { key: 'dir', icon: '📁', separator: ' ' }] },
      { id: 'ctx' }, { id: '5h' }, { id: '7d' },
    ],
  });
  const olderHeader = olderPartsConfig.segments.find(s => s.id === 'header');
  assert.strictEqual(olderHeader.parts[0].effort, true);
  // ...but a part the user dropped stays dropped
  assert.ok(!olderHeader.parts.some(p => p.key === 'branch'));

  // --- remembered windows -------------------------------------------------

  // The fixture's resets_at is relative to the real clock, so anchor the synthetic
  // "now" to it — a hardcoded timestamp would read as a window that already reset.
  const NOW = Math.floor(Date.now() / 1000);
  const stateFixture = () => {
    const state = emptyState();
    assert.strictEqual(sampleWindows(DEFAULT_CONFIG, fixture, state, NOW), true);
    return state;
  };

  // a live render records both windows, with one sample each
  const sampled = stateFixture();
  assert.deepStrictEqual(Object.keys(sampled.windows), ['rate_limits.five_hour', 'rate_limits.seven_day']);
  assert.strictEqual(sampled.windows['rate_limits.five_hour'].usedPercentage, 18);
  assert.deepStrictEqual(sampled.windows['rate_limits.five_hour'].history, [[NOW, 18]]);

  // an unchanged render inside the sampling interval is not worth a disk write
  assert.strictEqual(sampleWindows(DEFAULT_CONFIG, fixture, sampled, NOW + 5), false);
  assert.strictEqual(sampled.windows['rate_limits.five_hour'].history.length, 1);

  // past the interval a second point lands, and the pair drives the estimate
  const laterFixture = {
    ...fixture,
    rate_limits: { ...fixture.rate_limits, five_hour: { ...fixture.rate_limits.five_hour, used_percentage: 24 } },
  };
  assert.strictEqual(sampleWindows(DEFAULT_CONFIG, laterFixture, sampled, NOW + 600), true);
  assert.deepStrictEqual(sampled.windows['rate_limits.five_hour'].history, [[NOW, 18], [NOW + 600, 24]]);
  assert.strictEqual(historyRate(sampled.windows['rate_limits.five_hour'].history), 0.6);

  // a new resets_at means a fresh window: the old samples would flatten the slope
  const rolledFixture = {
    ...fixture,
    rate_limits: { ...fixture.rate_limits, five_hour: { used_percentage: 2, resets_at: NOW + 18000 } },
  };
  sampleWindows(DEFAULT_CONFIG, rolledFixture, sampled, NOW + 1200);
  assert.deepStrictEqual(sampled.windows['rate_limits.five_hour'].history, [[NOW + 1200, 2]]);

  // history is capped, oldest first
  const cappedConfig = mergeConfig(DEFAULT_CONFIG, { state: { maxHistory: 3, minSampleSeconds: 1 } });
  const capped = emptyState();
  for (let i = 0; i < 6; i++) {
    sampleWindows(cappedConfig, {
      rate_limits: { five_hour: { used_percentage: 10 + i, resets_at: NOW + 18000 } },
    }, capped, NOW + i * 60);
  }
  assert.deepStrictEqual(capped.windows['rate_limits.five_hour'].history, [[NOW + 180, 13], [NOW + 240, 14], [NOW + 300, 15]]);

  // a payload without rate_limits falls back to the remembered value, marked stale
  const noLimits = { model: fixture.model, workspace: fixture.workspace, context_window: fixture.context_window, cost: fixture.cost };
  const remembered = stateFixture();
  const staleOutput = render(noLimits, DEFAULT_CONFIG, remembered, NOW + 60);
  assert.ok(staleOutput.includes('5h ~'));
  assert.ok(staleOutput.includes('18%'));
  // a remembered percentage never gets the session-elapsed estimate: that usage predates
  // this session, and dividing it by a young session's runtime invents a 2-minute ETA
  assert.ok(!staleOutput.includes('to limit'));
  assert.strictEqual(depletionEta(18, null, undefined), null);
  // ...and the live path never shows the marker
  assert.ok(!render(fixture, DEFAULT_CONFIG, remembered, NOW).includes('5h ~'));

  // a remembered value is dropped once its own window has reset
  const expired = stateFixture();
  assert.ok(!render(noLimits, DEFAULT_CONFIG, expired, fixture.rate_limits.five_hour.resets_at + 1).includes('5h'));
  // ...or, for a window with no reset timestamp, once it is simply too old to trust
  const ageTest = stateFixture();
  assert.strictEqual(ageTest.windows['rate_limits.seven_day'].resetsAt, null);
  assert.ok(render(noLimits, DEFAULT_CONFIG, ageTest, NOW + 719 * 60).includes('7d ~'));
  assert.ok(!render(noLimits, DEFAULT_CONFIG, ageTest, NOW + 721 * 60).includes('7d'));
  // ...and with no memory at all the segment stays hidden, as it always did
  assert.ok(!render(noLimits, DEFAULT_CONFIG, emptyState(), NOW).includes('5h'));

  // titles interpolate known tokens, drop unknown percentages, and keep stray braces
  const tokens = titleTokens(fixture, sampled);
  assert.strictEqual(tokens['5h'], '18');
  assert.strictEqual(tokens.dir, 'project');
  assert.strictEqual(titleTokens(noLimits, emptyState())['5h'], '');
  assert.strictEqual(
    'ctx {ctx}% · 5h {5h}% · {nope}'.replace(/\{(\w+)\}/g, (m, k) => (k in tokens ? tokens[k] : m)),
    'ctx 32% · 5h 18% · {nope}',
  );

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

  // segments sharing a row collapse onto one line joined by layout.joiner
  const compactConfig = mergeConfig(DEFAULT_CONFIG, {
    segments: [
      { id: 'header' },
      { id: 'ctx', row: 1, showUsage: false },
      { id: '5h', row: 1, showResetIn: false, showDepletion: false },
      { id: '7d', row: 1 },
      { id: 'stats', show: false },
    ],
  });
  const compactLines = render(fixture, compactConfig).split('\n');
  assert.strictEqual(compactLines.length, 2);
  assert.strictEqual(compactLines[1].split(' │ ').length, 3);
  // the default layout still gives every segment its own line
  assert.strictEqual(render(fixture, DEFAULT_CONFIG).split('\n').length, 5);

  // short notes trade the words for markers, and drop the context window's fixed size
  const shortConfig = mergeConfig(DEFAULT_CONFIG, { layout: { noteStyle: 'short' } });
  const shortOutput = render(fixture, shortConfig);
  assert.ok(/5h .*18% ↻\dh\dm ~4h33m/.test(shortOutput));
  assert.ok(shortOutput.includes('ctx') && shortOutput.includes(' 64K') && !shortOutput.includes('64K/200K'));
  assert.ok(!shortOutput.includes('until reset') && !shortOutput.includes('to limit'));
  // ...and a segment may keep the long form while the rest go short
  const mixedOutput = render(fixture, mergeConfig(shortConfig, {
    segments: [{ id: 'header' }, { id: 'ctx' }, { id: '5h', noteStyle: 'full' }, { id: '7d' }, { id: 'stats' }],
  }));
  assert.ok(mixedOutput.includes('until reset'));

  // custom markers for terminals that can't draw the arrow
  assert.ok(render(fixture, mergeConfig(DEFAULT_CONFIG, {
    layout: { noteStyle: 'short', noteMarkers: { reset: 'r', limit: 'e' } },
  })).match(/18% r\dh\dm e4h33m/));

  // showBar:false drops the graphic, and the percentage inherits the color it carried
  const noBarConfig = mergeConfig(DEFAULT_CONFIG, {
    segments: [
      { id: 'header' },
      { id: 'ctx', showBar: false, showUsage: false },
      { id: '5h', showBar: false, showResetIn: false, showDepletion: false },
      { id: '7d', showBar: false, showResetIn: false },
      { id: 'stats', show: false },
    ],
  });
  const noBarLines = render(fixture, noBarConfig).split('\n');
  assert.strictEqual(noBarLines[1], `ctx ${COLOR_CODES.green}32%${RESET}`);
  assert.ok(!noBarLines[2].includes(DEFAULT_CONFIG.bar.emptyChar));
  // the stale marker still takes the gap's place with no bar to precede
  assert.ok(render(noLimits, noBarConfig, stateFixture(), NOW + 60).includes(`5h ~${COLOR_CODES.green}18%${RESET}`));

  // the fully compact layout: one header line and one line of numbers
  const tightLines = render(fixture, mergeConfig(DEFAULT_CONFIG, {
    layout: { noteStyle: 'short' },
    segments: [
      { id: 'header', row: 1 },
      { id: 'ctx', row: 2, label: 'ctx', showBar: false, showUsage: false },
      { id: '5h', row: 2, label: '5h', showBar: false, showDepletion: false },
      { id: '7d', row: 2, label: '7d', showBar: false },
      { id: 'stats', row: 1 },
    ],
  })).split('\n');
  assert.strictEqual(tightLines.length, 2);
  assert.ok(tightLines[1].length < 60);

  console.log('self-test OK');
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) {
    selfTest();
  } else {
    main();
  }
}
