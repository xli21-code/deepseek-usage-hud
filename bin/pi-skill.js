#!/usr/bin/env node
'use strict';
// Regenerate the installed ds-usage skill for pi, in the one location pi reads:
// ~/.agents/skills. Deliberately not bin/install.js, which writes Claude Code's
// settings and a statusLine that pi has no use for. Idempotent - an identical
// file is left alone, so a re-run does not move its mtime. Run: node bin/pi-skill.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shellQuote } = require('../src/paths');

const REPO = path.resolve(__dirname, '..');
const SOURCE = path.join(REPO, 'skill', 'ds-usage', 'SKILL.md');
const TARGET = path.join(os.homedir(), '.agents', 'skills', 'ds-usage', 'SKILL.md');

const text = fs.readFileSync(SOURCE, 'utf8').replace(/<REPO_SH>/g, shellQuote(REPO)).replace(/<REPO>/g, REPO);

let current = null;
try { current = fs.readFileSync(TARGET, 'utf8'); } catch { /* first run */ }
if (current === text) { console.log(`unchanged  ${TARGET}`); process.exit(0); }

fs.mkdirSync(path.dirname(TARGET), { recursive: true, mode: 0o700 });
fs.writeFileSync(TARGET, text);
console.log(`wrote      ${TARGET}`);
