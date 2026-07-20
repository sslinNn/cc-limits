#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

const dest = path.join(os.homedir(), '.claude', 'cc-limits-statusline.js');
const src = path.join(__dirname, 'statusline.js');

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
