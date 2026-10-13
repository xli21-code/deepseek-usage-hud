#!/usr/bin/env node
'use strict';
// If the balance endpoint settles with a delay, the CNY drop observed between
// two readings corresponds to usage from an EARLIER window. Scan candidate lags
// and report which one puts the implied factor on a recognisable value:
// ~1.0 (price table already CNY) or ~7.1 (price table USD).
//
// The scan is over token cost only; a recognisable factor is evidence, a flat
// scan means the window is simply too short for the balance's resolution.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PRICES = {
  'deepseek-flash': {
    hit: { off: 0.003, peak: 0.006 },
    miss: { off: 0.15, peak: 0.3 },
    out: { off: 0.6, peak: 1.2 },
  },
  'deepseek-v4-pro': {
    hit: { off: 0.022, peak: 0.044 },
    miss: { off: 0.66, peak: 1.32 },
    out: { off: 1.98, peak: 3.96 },
  },
};

function isPeak(d) {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

const [sinceArg, untilArg, deltaArg] = process.argv.slice(2);
if (!sinceArg || !untilArg || deltaArg === undefined) {
  console.error('usage: node lag-scan.js <sinceISO> <untilISO> <balanceDeltaCNY>');
  process.exit(2);
}
const since = Date.parse(sinceArg);
const until = Date.parse(untilArg);
const deltaCNY = Number(deltaArg);

const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
if (!fs.existsSync(root)) {
  console.error(`no transcript tree at ${root}`);
  console.error('set CLAUDE_CONFIG_DIR to the config directory whose transcripts you want.');
  process.exit(1);
}
const files = [];
(function walk(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) files.push(p);
  }
})(root);

// Parse once: every billable message with its timestamp and priced cost.
const rows = [];
const seen = new Set();
for (const f of files) {
  let text;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      continue;
    }
    if (d.type !== 'assistant') continue;
    const t = Date.parse(d.timestamp);
    if (!Number.isFinite(t)) continue;
    const msg = d.message || {};
    if (!msg.id || seen.has(msg.id)) continue;
    // Register the id only once the record is actually usable. A duplicate
    // whose FIRST copy lacks `usage` would otherwise claim the id and cause the
    // complete copy to be skipped, silently reporting zero for that request.
    const price = PRICES[msg.model];
    if (!price || !msg.usage) continue;
    seen.add(msg.id);
    const u = msg.usage || {};
    const band = isPeak(new Date(t)) ? 'peak' : 'off';
    const hit = u.cache_read_input_tokens || 0;
    const miss = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const out = u.output_tokens || 0;
    rows.push({
      t,
      withCache: (hit * price.hit[band] + miss * price.miss[band] + out * price.out[band]) / 1e6,
      allMiss: ((hit + miss) * price.miss[band] + out * price.out[band]) / 1e6,
      hit,
    });
  }
}

const span = until - since;
console.log(`observed drop: ${deltaCNY.toFixed(4)} CNY over ${(span / 60_000).toFixed(1)} min\n`);
console.log('  lag  window(UTC)        msgs      cost(hit)  factor   cost(miss)  factor');
for (let lagMin = -15; lagMin <= 20; lagMin += 1) {
  const s = since - lagMin * 60_000;
  const u = until - lagMin * 60_000;
  let n = 0;
  let cw = 0;
  let cm = 0;
  for (const r of rows) {
    if (r.t < s || r.t > u) continue;
    n++;
    cw += r.withCache;
    cm += r.allMiss;
  }
  const fw = cw > 0 ? deltaCNY / cw : NaN;
  const fm = cm > 0 ? deltaCNY / cm : NaN;
  const mark = (f) => {
    if (!Number.isFinite(f)) return '     ';
    if (Math.abs(f - 1) < 0.15) return '  CNY';
    if (Math.abs(f - 7.1) < 1.1) return '  USD';
    return '     ';
  };
  console.log(
    `  ${String(lagMin).padStart(3)}  ${new Date(s).toISOString().slice(11, 19)}-${new Date(u).toISOString().slice(11, 19)}` +
      `  ${String(n).padStart(5)}  ${cw.toFixed(5).padStart(10)}  ${fw.toFixed(2).padStart(6)}${mark(fw)}` +
      `  ${cm.toFixed(5).padStart(10)}  ${fm.toFixed(2).padStart(6)}${mark(fm)}`,
  );
}
