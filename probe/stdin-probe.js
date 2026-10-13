#!/usr/bin/env node
'use strict';
// Step-0 probe: capture the real statusline stdin payload Claude Code sends
// when it is pointed at DeepSeek via ANTHROPIC_BASE_URL, and echo back a
// compact statusline so the HUD is not a regression while we measure.
//
// Writes:
//   ~/.local/share/deepseek-hud/stdin-latest.json    (overwritten every render)
//   ~/.local/share/deepseek-hud/stdin-shapes.jsonl   (appended only when the
//                                                     payload *shape* changes)
//
// The shape log is capped and deduped on purpose: the statusline renders many
// times per turn and the payload is a few KB, so logging every render would grow
// unbounded and tell us nothing new.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = process.env.DEEPSEEK_HUD_DATA_DIR?.trim()
  ? path.resolve(process.env.DEEPSEEK_HUD_DATA_DIR.trim().replace(/^~(?=\/|$)/, os.homedir()))
  : path.join(os.homedir(), '.local', 'share', 'deepseek-hud');
const LATEST = path.join(DATA, 'stdin-latest.json');
const SHAPES = path.join(DATA, 'stdin-shapes.jsonl');
const SHAPES_MAX = 500;

function shapeKey(d) {
  const cw = d.context_window || {};
  const cu = cw.current_usage || {};
  return JSON.stringify({
    top: Object.keys(d).sort(),
    cwKeys: Object.keys(cw).sort(),
    cuKeys: cu ? Object.keys(cu).sort() : null,
    modelId: d.model && d.model.id,
    modelName: d.model && d.model.display_name,
    windowSize: cw.context_window_size,
    cost: d.cost ? Object.keys(d.cost).sort() : null,
    rateLimits: d.rate_limits ? Object.keys(d.rate_limits).sort() : null,
    session: d.session_id,
    hasName: Boolean(d.session_name),
  });
}

function appendShape(entry) {
  let lines = [];
  try {
    lines = fs.readFileSync(SHAPES, 'utf8').split('\n').filter(Boolean);
  } catch {
    /* first run */
  }
  const last = lines.length ? lines[lines.length - 1] : null;
  if (last) {
    try {
      if (shapeKey(JSON.parse(last).payload) === shapeKey(entry.payload)) return;
    } catch {
      /* unreadable tail, fall through and append */
    }
  }
  lines.push(JSON.stringify(entry));
  if (lines.length > SHAPES_MAX) lines = lines.slice(-SHAPES_MAX);
  fs.writeFileSync(SHAPES, `${lines.join('\n')}\n`);
}

function fmtTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '?';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function line(d) {
  const parts = [];
  const model = (d.model && (d.model.display_name || d.model.id)) || 'no-model';
  parts.push(`DS-probe ${model}`);

  const cw = d.context_window || {};
  const cu = cw.current_usage || null;
  const live = cu
    ? (cu.input_tokens || 0) + (cu.cache_creation_input_tokens || 0) + (cu.cache_read_input_tokens || 0)
    : 0;
  const size = cw.context_window_size;
  const native = cw.used_percentage;
  parts.push(
    `ctx native=${native == null ? 'null' : native}%` +
      ` live=${fmtTokens(live)}/${fmtTokens(size)}`,
  );
  if (cu) parts.push(`in=${fmtTokens(cu.input_tokens)} cacheR=${fmtTokens(cu.cache_read_input_tokens)}`);

  const cost = d.cost || null;
  parts.push(`dur=${cost && cost.total_duration_ms != null ? `${Math.round(cost.total_duration_ms / 60000)}m` : 'null'}`);
  parts.push(`usd=${cost && cost.total_cost_usd != null ? cost.total_cost_usd : 'null'}`);
  parts.push(`rl=${d.rate_limits ? 'yes' : 'none'}`);
  parts.push(`effort=${(d.effort && d.effort.level) || 'null'}`);
  parts.push(`name=${d.session_name ? 'yes' : 'no'}`);
  return parts.join(' │ ');
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  raw += c;
});
process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    // Print something rather than nothing: an empty statusline looks broken.
    process.stdout.write('DS-probe: stdin not JSON');
    return;
  }
  const entry = { probe_at: new Date().toISOString(), payload };
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(LATEST, `${JSON.stringify(entry, null, 2)}\n`);
    appendShape(entry);
  } catch {
    /* never fail the statusline over logging */
  }
  process.stdout.write(line(payload));
});
