#!/usr/bin/env node
'use strict';
// Pilot of the token-accounting core: a full token accounting over the
// existing transcript history, used to sanity-check what a day of use actually
// costs before any of it was built on. Its proportions are what mattered, which
// is why it prints cost in the price table's own units rather than a currency.
//
// Two correctness rules that a naive counter gets wrong:
//
//   1. Claude Code writes one assistant record PER CONTENT BLOCK (thinking /
//      text / tool_use), all sharing message.id and all carrying a byte-identical
//      usage block. Summing per record overcounts ~2.4x. Dedupe by message.id.
//      (uuid is NOT a dedup key -- every record has a unique uuid.)
//   2. DeepSeek has peak/off-peak pricing: peak is 01:00-04:00 and 06:00-10:00
//      UTC, Mon-Fri, and off-peak is half price. So price each message by its own
//      timestamp; a single blended rate is wrong by up to 2x.
//
// Currency is unresolved: the price page prints "$" while the account is CNY.
// Everything here is therefore reported in "price units" (the page's own numbers)
// never in a currency. Calibrating it against a balance delta was attempted and
// did not settle it -- the endpoint settles in batches, so the short windows that
// would separate the hypotheses carry no information, and the console gives one
// equation for two unknowns. See docs/CALIBRATION.md.
//
// Cache billing is the other open question, and it is worth ~15x: whether
// /anthropic bills cache reads at the cache-hit rate. Both bounds are reported
// rather than picking one.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Per 1M tokens, in the price page's own units.
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

// Ignored: Chinese public holidays are excluded from peak upstream, but the
// holiday calendar is not in the docs feed and a handful of days barely moves
// the total. Flagged rather than silently assumed.
function isPeak(d) {
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  if (dow === 0 || dow === 6) return false;
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

const LOCAL_TZ_OFFSET_MIN = 600; // HST = UTC-10; local midnight = 10:00 UTC

function localDay(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  return new Date(t - LOCAL_TZ_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

function transcriptFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out;
}

const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const files = transcriptFiles(root);

const seen = new Set();
const byDay = new Map(); // localDay -> { byModel: {tokens, cost} }
const totals = { messages: 0, dupes: 0, noUsage: 0, synthetic: 0, unknownModel: 0 };
const bounds = { withCacheHit: 0, allCacheMiss: 0 };

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
    const msg = d.message || {};
    const id = msg.id;
    if (!id) continue;
    if (seen.has(id)) {
      totals.dupes++;
      continue;
    }

    const model = msg.model;
    if (model === '<synthetic>') {
      totals.synthetic++;
      continue;
    }
    const u = msg.usage;
    if (!u) {
      totals.noUsage++;
      continue;
    }
    const price = PRICES[model];
    if (!price) {
      totals.unknownModel++;
      continue;
    }
    // Register the id only once the record is known to be usable. Adding it
    // before the checks let a duplicate whose FIRST copy lacked `usage` claim
    // the id, so the complete copy was counted as a duplicate and the request
    // silently contributed nothing.
    seen.add(id);
    totals.messages++;

    const peak = isPeak(new Date(d.timestamp));
    const band = peak ? 'peak' : 'off';
    const hit = u.cache_read_input_tokens || 0;
    const miss = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const out = u.output_tokens || 0;

    const cost = (hit * price.hit[band] + miss * price.miss[band] + out * price.out[band]) / 1e6;
    const costAsMiss = ((hit + miss) * price.miss[band] + out * price.out[band]) / 1e6;
    bounds.withCacheHit += cost;
    bounds.allCacheMiss += costAsMiss;

    const day = localDay(d.timestamp);
    if (!byDay.has(day)) byDay.set(day, { byModel: {} });
    const slot = byDay.get(day).byModel;
    if (!slot[model]) slot[model] = { messages: 0, hit: 0, miss: 0, out: 0, cost: 0 };
    const s = slot[model];
    s.messages++;
    s.hit += hit;
    s.miss += miss;
    s.out += out;
    s.cost += cost;
  }
}

const fmt = (n) => n.toLocaleString('en-US');
const days = [...byDay.keys()].sort();

console.log(`transcripts : ${files.length} files under ${root}`);
console.log(
  `messages    : ${fmt(totals.messages)} billable | ${fmt(totals.dupes)} duplicate block-records skipped` +
    ` | ${totals.synthetic} synthetic | ${totals.unknownModel} unknown-model`,
);
console.log('');
console.log('per local day (HST) — price units, not confirmed CNY:');
console.log('  day          msgs      cache-read      cache-miss       output       cost');
for (const day of days) {
  const byModel = byDay.get(day).byModel;
  const agg = { messages: 0, hit: 0, miss: 0, out: 0, cost: 0 };
  for (const s of Object.values(byModel)) {
    agg.messages += s.messages;
    agg.hit += s.hit;
    agg.miss += s.miss;
    agg.out += s.out;
    agg.cost += s.cost;
  }
  console.log(
    `  ${day}  ${String(agg.messages).padStart(5)}  ${fmt(agg.hit).padStart(13)}  ${fmt(agg.miss).padStart(13)}` +
      `  ${fmt(agg.out).padStart(12)}  ${agg.cost.toFixed(4).padStart(9)}`,
  );
}
console.log('');
console.log('per model, all days:');
const modelAgg = {};
for (const day of days) {
  for (const [m, s] of Object.entries(byDay.get(day).byModel)) {
    if (!modelAgg[m]) modelAgg[m] = { messages: 0, hit: 0, miss: 0, out: 0, cost: 0 };
    for (const k of Object.keys(modelAgg[m])) modelAgg[m][k] += s[k];
  }
}
for (const [m, s] of Object.entries(modelAgg)) {
  const pct = bounds.withCacheHit > 0 ? ((s.cost / bounds.withCacheHit) * 100).toFixed(1) : '0';
  console.log(
    `  ${m.padEnd(17)} ${String(s.messages).padStart(5)} msgs  cost ${s.cost.toFixed(4).padStart(9)} (${pct}%)` +
      `  hit/miss/out = ${fmt(s.hit)}/${fmt(s.miss)}/${fmt(s.out)}`,
  );
}
console.log('');
console.log(`TOTAL, cache-hit billing   : ${bounds.withCacheHit.toFixed(4)}`);
console.log(`TOTAL, all-input-as-miss   : ${bounds.allCacheMiss.toFixed(4)}   (${(bounds.allCacheMiss / Math.max(bounds.withCacheHit, 1e-9)).toFixed(1)}x higher)`);
console.log(`days covered: ${days.length} (${days[0]} .. ${days[days.length - 1]})`);
console.log(`average per local day      : ${(bounds.withCacheHit / Math.max(days.length, 1)).toFixed(4)} (cache-hit) / ${(bounds.allCacheMiss / Math.max(days.length, 1)).toFixed(4)} (all-miss)`);
