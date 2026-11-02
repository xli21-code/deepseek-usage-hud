#!/usr/bin/env node
'use strict';
// Human-readable DeepSeek usage report. Backs the /ds-usage skill.
//
//   node report.js            report from the snapshot + balance ledger
//   node report.js --refresh  force a balance fetch first
//
// Read-only except with --refresh. Everything it prints comes from either the
// balance API (ground truth) or the ledger of past readings; nothing here
// estimates token cost, because that number is not yet calibrated (see
// PLAN.md §13.3 — the console gives a blended rate, not a price table).

const { PATHS, readJson } = require('./util');
const { loadConfig } = require('./config');
const { readLedger } = require('./balance');
const { formatAmount } = require('./currency');

const REFRESH_WINDOW_MS = 24 * 3600 * 1000;

// Currency comes from the data, not from a default — see src/currency.js.
let CUR = null;
function money(n) {
  return formatAmount(n, CUR);
}

function bar(percent, width = 20) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function duration(ms) {
  const h = ms / 3600000;
  if (h >= 48) return `${(h / 24).toFixed(1)}d`;
  if (h >= 1) return `${h.toFixed(1)}h`;
  return `${Math.round(ms / 60000)}m`;
}

/** Token counts, at the precision a human reads them at. */
function tokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}G`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

/** Minimum span before a burn rate means anything. The endpoint settles in
 *  batches: two adjacent 11-minute windows once implied contradictory price
 *  factors (12.08 vs 3.46) purely from batch timing. Below this, the honest
 *  answer is "not enough data", not a number with a wide error bar. */
const MIN_BURN_SPAN_MS = 4 * 3600 * 1000;

/**
 * Burn rate from the ledger, over a window with no top-up in it.
 *
 * `first - last` is a NET change, so a top-up in the middle does not merely add
 * noise — it cancels out real spend. In a window that went 100 -> 200 -> 90 the
 * net fall is 10 while 110 was actually spent, a 10x understatement. So the
 * window starts after the most recent upward step; anything before that is a
 * different cycle and is not comparable.
 */
function burnRate(rows, jumpThreshold) {
  const usable = rows.filter((r) => Number.isFinite(Number(r.total_balance)));
  if (usable.length < 2) return null;

  // Walk backwards to the last top-up; the window starts at the reading just
  // after it (the balance it produced), not before.
  let start = 0;
  for (let i = usable.length - 1; i > 0; i--) {
    if (Number(usable[i].total_balance) > Number(usable[i - 1].total_balance) + jumpThreshold) {
      start = i;
      break;
    }
  }
  const window = usable.slice(start);
  if (window.length < 2) return { tooShort: true, reason: 'a top-up happened too recently' };

  const first = window[0];
  const last = window[window.length - 1];
  const spanMs = Date.parse(last.at) - Date.parse(first.at);
  const spent = Number(first.total_balance) - Number(last.total_balance);
  if (!Number.isFinite(spanMs) || spanMs < MIN_BURN_SPAN_MS) {
    return { tooShort: true, reason: `only ${Math.max(0, Math.round(spanMs / 60000))}m since the window began` };
  }
  if (spent <= 0) return null;
  return { spanMs, spent, perHour: spent / (spanMs / 3600000) };
}

function main() {
  const cfg = loadConfig();
  const snap = readJson(PATHS.snapshot, null);
  const rows = readLedger();
  CUR = snap?._meta?.currency ?? rows[rows.length - 1]?.currency ?? null;

  console.log('DeepSeek usage');
  console.log('─'.repeat(52));

  // Which account the status line is currently bar-tracking. The renderer reads
  // this from the live model (ctx.model / PI_MODEL); printing it here means
  // "the bar shows the wrong account" can be told apart from "the bar is wrong".
  const modelId = String(process.env.PI_MODEL || '').trim();
  if (modelId) {
    const account = /^ollama-cloud\//.test(modelId) ? 'Ollama Cloud' : 'DeepSeek';
    console.log(`model       ${modelId}`);
    console.log(`bar tracks  ${account} — it follows the model, not the snapshot`);
  }

  if (!snap) {
    console.log('No snapshot yet. Run `node src/generate.js --force` to create one.');
  } else {
    const scoped = (snap.model_scoped || [])[0] || {};
    const pct = scoped.utilization ?? 0;
    const ageS = Math.round((Date.now() - Date.parse(snap.updated_at)) / 1000);
    const base = snap._meta?.baseline;
    const src = snap._meta?.baseline_source;
    const SRC_EN = {
      seed: 'first run — highest balance ever recorded',
      topup: 'top-up detected — reset to the balance after it',
      held: 'holding the last top-up amount',
      config: 'fixed value (baseline_mode=fixed)',
    };
    console.log(`balance     ${snap.balance_label}`);
    console.log(`bar         ${bar(pct)} ${pct}%  (full scale ${money(base ?? cfg.usage_max)})`);
    console.log(`scale from  ${SRC_EN[src] || src || 'unknown'}`);
    console.log(`note        the bar shows REMAINING — shorter means less money left`);
    console.log(`snapshot    ${snap.updated_at}  (${ageS}s ago)`);
    if (snap._meta?.low_warning) console.log('warning     balance is below the alert line');
  }

  // Ollama Cloud is the second account, shown as its own block rather than
  // blended into the DeepSeek bar: different currency, different period, and a
  // single percentage over both would be arithmetic theatre.
  const ollama = snap?._meta?.ollama;
  console.log('');
  console.log('Ollama Cloud');
  console.log('─'.repeat(52));
  if (!ollama) {
    console.log('balance     no reading in the snapshot yet');
    console.log('            Set OLLAMA_API_KEY, or keep an ollama-cloud provider in');
    console.log('            ~/.config/magpie/providers.json — the key is read from there.');
  } else {
    const allowance = Number(ollama.allowance_usd) > 0 ? Number(ollama.allowance_usd) : null;
    const bal = Number(ollama.balance_usd) || 0;
    const pct = allowance ? Math.max(0, Math.min(100, (bal / allowance) * 100)) : null;
    const pctLabel = pct === null ? null : pct >= 99 && pct < 100 ? pct.toFixed(1) : String(Math.round(pct));
    const ends = ollama.period_until ? `  (period ends ${String(ollama.period_until).slice(0, 10)})` : '';
    console.log(`balance     $${bal.toFixed(4)}${allowance ? ` / $${allowance.toFixed(2)}` : ''}${ends}`);
    if (pct !== null) console.log(`bar         ${bar(pct)} ${pctLabel}%  (shows REMAINING)`);
    if (Number(ollama.purchased_usd) > 0) console.log(`purchased   $${Number(ollama.purchased_usd).toFixed(2)}`);
    const u = ollama.usage;
    if (!u) {
      console.log('usage 24h   not fetched yet');
    } else {
      console.log(`usage 24h   ${u.request_count} requests · $${Number(u.usage_usd).toFixed(4)}`);
      console.log(
        `tokens      ${tokens(u.input_tokens)} in (${tokens(u.cached_input_tokens)} cached, ${(Number(u.cache_hit_rate) * 100).toFixed(1)}%) · ${tokens(u.output_tokens)} out`,
      );
      console.log('            cached is a SUBSET of input on this endpoint: the rate is');
      console.log('            cached/input, not cached/(input+cached) as in pi-usage.');
    }
    const ageS = Math.round((Date.now() - Date.parse(ollama.updated_at)) / 1000);
    console.log(`read at     ${ollama.updated_at}${Number.isFinite(ageS) ? `  (${ageS}s ago)` : ''}`);
  }

  console.log('');
  console.log(`ledger      ${rows.length} entries (written only when the balance moves)`);
  if (rows.length) {
    const last = rows[rows.length - 1];
    const first = rows[0];
    console.log(`range       ${first.at} → ${last.at}`);
    if (Number.isFinite(Number(first.total_balance)) && Number.isFinite(Number(last.total_balance))) {
      console.log(`movement    ${money(first.total_balance)} → ${money(last.total_balance)}`);
    }
    const windowed = rows.filter((r) => Date.now() - Date.parse(r.at) <= REFRESH_WINDOW_MS);
    const rate = burnRate(windowed, Number(cfg.topup_min_jump) || 1);
    console.log('');
    if (rate && rate.tooShort) {
      console.log(`burn rate   withheld — ${rate.reason}.`);
      console.log('            A net balance change that spans a top-up is not spend.');
    } else if (rate) {
      console.log(`burn rate   about ${money(rate.perHour * 24)}/day  (measured over ${duration(rate.spanMs)})`);
      console.log('            Cross-check against the provider console for the same window:');
      console.log('            the balance settles in batches, so short windows describe');
      console.log('            settlement timing rather than spend.');
    } else {
      const span = windowed.length >= 2 ? duration(Date.parse(windowed[windowed.length - 1].at) - Date.parse(windowed[0].at)) : '—';
      console.log(`burn rate   withheld — only ${span} of history (needs 4h+).`);
      console.log('            The balance settles in batches, so a short-window delta');
      console.log('            describes settlement timing, not real spend.');
    }
  }

  // Whether the status line is actually wired up. Without this, "the HUD is
  // missing" cannot be told apart from "the HUD never ran".
  console.log('');
  const hb = readJson(PATHS.lastRender, null);
  if (hb?.at && hb.real) {
    const s = Math.round((Date.now() - Date.parse(hb.at)) / 1000);
    const ago = s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${(s / 3600).toFixed(1)}h ago`;
    console.log(`statusline  last rendered ${ago}   ${s > 600 ? 'STALE' : 'running'}`);
  } else if (hb?.at) {
    console.log('statusline  only hand-run tests seen (payload had no UUID session id).');
    console.log('            No real session has rendered it, so no HUD is showing.');
  } else {
    console.log('statusline  never invoked — the HUD is not wired up.');
    console.log('            Is the session using this config dir? Re-run the installer, or');
    console.log('            check that settings.json has a statusLine pointing at the wrapper.');
  }
  console.log('');
  console.log('Note: the balance is ACCOUNT-level. If the same key is used by another');
  console.log('      tool, its spend drains this number too.');
  console.log(`log         ${PATHS.logFile}`);
}

// Route through the generator rather than fetching here. An earlier version
// called buildSnapshot() directly, which rebuilt the snapshot WITHOUT the
// learned baseline — a bar sitting at 40% silently became 20% — and appended to
// the ledger before the baseline was resolved, so a top-up could be missed.
if (process.argv.includes('--refresh')) {
  require('./generate')
    .refresh({ force: true, config: loadConfig() })
    .then((r) => {
      if (!r.ok) console.error(`(refresh did not complete: ${r.reason || 'unknown'})`);
    })
    .catch((err) => console.error(`(refresh failed: ${err.message})`))
    .finally(main);
} else {
  main();
}
