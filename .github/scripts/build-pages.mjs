// Builds the GitHub Pages site out of the plugin's own configurator page.
//
// The page shipped in the plugin is standalone and opened from file://, so the
// hosted copy needs two things the local one doesn't: social-card metadata, and
// a way back to the repo for someone who arrived from a link. Both are injected
// here so plugin/configurator.html stays exactly what the plugin installs.

import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';

const SITE = 'https://sslinnn.github.io/cc-limits/';
const REPO = 'https://github.com/sslinNn/cc-limits';

const head = `
<link rel="canonical" href="${SITE}">
<meta name="description" content="Configure cc-limits: a Claude Code statusline showing your 5-hour and weekly rate limits, context window and session cost. Every option with a live preview.">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE}">
<meta property="og:title" content="cc-limits — know how much Claude you have left">
<meta property="og:description" content="A Claude Code statusline for your 5h/7-day rate limits, context window and session cost. Try every option here, with a live preview.">
<meta property="og:image" content="${SITE}social.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}social.png">
`.trim();

const banner = `
<style>
  .site-banner {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px;
    max-width: 1180px; margin: 0 auto 22px; padding: 12px 16px;
    background: var(--panel); border: 1px solid var(--line);
    border-radius: var(--radius); box-shadow: var(--shadow);
    font: 400 13px/1.5 'IBM Plex Sans', system-ui, sans-serif; color: var(--ink-soft);
  }
  .site-banner b { color: var(--ink); }
  .site-banner code {
    font: 500 12px/1.5 'IBM Plex Mono', monospace;
    background: var(--panel-sunk); border: 1px solid var(--line);
    border-radius: 4px; padding: 2px 6px; color: var(--ink);
  }
  .site-banner a { color: var(--accent); text-decoration: none; font-weight: 500; }
  .site-banner a:hover { text-decoration: underline; }
  .site-banner .spacer { margin-left: auto; }
</style>
<div class="site-banner">
  <span><b>cc-limits</b> — a Claude Code statusline for your rate limits, context window and session cost.</span>
  <span>Install: <code>/plugin marketplace add sslinNn/cc-limits</code></span>
  <a class="spacer" href="${REPO}">Read the docs on GitHub →</a>
</div>
`.trim();

let html = await readFile('plugin/configurator.html', 'utf8');

const before = html;
html = html.replace('</head>', `${head}\n</head>`);
html = html.replace('<div class="wrap">', `<div class="wrap">\n${banner}`);
if (html === before) throw new Error('injection points not found in plugin/configurator.html');

await mkdir('_site', { recursive: true });
await writeFile('_site/index.html', html);
await copyFile('assets/social.png', '_site/social.png');
console.log(`built _site/index.html (${html.length} bytes)`);
