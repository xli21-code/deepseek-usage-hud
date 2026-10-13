#!/usr/bin/env node
'use strict';
// Reconcile a measured balance delta against the token-derived cost for the
// same wall-clock window. The ratio is the price-unit -> CNY factor:
//
//   ~1.0  => the price page's numbers are already CNY
//   ~7.1  => they are USD, converted at the prevailing rate
//
// It also discriminates the cache-billing question, because the cache-hit and
// all-miss readings differ by ~15x and only one of them will land on a sane
// factor.
//
// Usage: node calibrate.js <sinceISO> <untilISO> <balanceDeltaCNY>

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
  console.error('usage: node calibrate.js <sinceISO> <untilISO> <balanceDeltaCNY>');
  process.exit(2);
}
const since = Date.parse(sinceArg);
const until = Date.parse(untilArg);
const deltaCNY = Number(deltaArg);
if (!Number.isFinite(since) || !Number.isFinite(until) || !Number.isFinite(deltaCNY)) {
  console.error('bad arguments');
  process.exit(2);
}

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

const seen = new Set();
// Only messages inside the window count. Note the window is bounded by the two
// balance readings, and a request that started before `since` but is billed
// after it will be misattributed -- acceptable at this scale, flagged in output.
const agg = {
  messages: 0,
  hit: 0,
  miss: 0,
  out: 0,
  costWithCache: 0,
  costAllMiss: 0,
  first: null,
  last: null,
  models: {},
};

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
    if (!Number.isFinite(t) || t < since || t > until) continue;
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

    agg.messages++;
    agg.hit += hit;
    agg.miss += miss;
    agg.out += out;
    agg.costWithCache += (hit * price.hit[band] + miss * price.miss[band] + out * price.out[band]) / 1e6;
    agg.costAllMiss += ((hit + miss) * price.miss[band] + out * price.out[band]) / 1e6;
    if (!agg.first || t < agg.first) agg.first = t;
    if (!agg.last || t > agg.last) agg.last = t;
    agg.models[msg.model] = (agg.models[msg.model] || 0) + 1;
  }
}

const mins = (until - since) / 60_000;
const fmt = (n) => n.toLocaleString('en-US');
console.log(`window      : ${new Date(since).toISOString()} .. ${new Date(until).toISOString()}  (${mins.toFixed(1)} min)`);
console.log(`balance     : fell ${deltaCNY.toFixed(4)} CNY`);
console.log(`messages    : ${agg.messages} billable  ${JSON.stringify(agg.models)}`);
if (agg.first) console.log(`msg span    : ${new Date(agg.first).toISOString()} .. ${new Date(agg.last).toISOString()}`);
console.log(`tokens      : hit ${fmt(agg.hit)} | miss ${fmt(agg.miss)} | out ${fmt(agg.out)}`);
console.log('');
console.log(`cost (cache-hit pricing) : ${agg.costWithCache.toFixed(6)} units`);
console.log(`cost (all-input-as-miss) : ${agg.costAllMiss.toFixed(6)} units`);
console.log('');
if (agg.costWithCache > 0) {
  console.log(`implied factor, cache-hit : ${(deltaCNY / agg.costWithCache).toFixed(3)} CNY per unit`);
}
if (agg.costAllMiss > 0) {
  console.log(`implied factor, all-miss  : ${(deltaCNY / agg.costAllMiss).toFixed(3)} CNY per unit`);
}
console.log('');
console.log('read: ~1.0 => price table is CNY | ~7.1 => price table is USD');
console.log('a factor far from both means a top-up landed inside the window, or the');
console.log('balance endpoint lags by more than the window length.');
