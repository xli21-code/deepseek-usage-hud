'use strict';
// The bar's full scale: how much money the bar represents at 100%.
//
// There is no denominator to read off the API. DeepSeek only exposes a
// *balance* — a stock — and a stock has no scale of its own. "$77.11" is not
// "77% of" anything. So the scale has to come from watching the balance move.
//
// The signal we use is the only large POSITIVE step a prepaid balance makes:
//
//     a top-up.
//
// Everything else is spend (a decrease) or settlement noise (a cent or two).
// So the baseline is set to the balance just after a top-up, and the bar then
// drains from there until the next one.
//
// Two modes, because "what counts as the money I put in" is a preference:
//
//   auto   learn it from the balance (default)
//   fixed  use a configured number, for people who top up a fixed amount and
//          would rather not wait for the first top-up to be observed
//
// In auto mode on a fresh install there is nothing to learn from yet, so we
// seed from the highest balance ever recorded — the closest available proxy
// for "the money in there". A user who installs mid-cycle gets a bar that
// starts full and drains, which is at least honest about what it knows.

const path = require('node:path');
const { PATHS, readJson, atomicWriteJson, log } = require('./util');
const { previousBefore } = require('./balance');

const STATE_FILE = PATHS.baseline;
const DEFAULT_JUMP_CNY = 1;

function loadState() {
  const raw = readJson(STATE_FILE, null);
  if (raw && raw.baseline === undefined && raw.baseline_cny !== undefined) {
    // Written before the keys dropped their currency suffix; keep it working.
    raw.baseline = raw.baseline_cny;
  }
  return raw;
}

function saveState(state) {
  try {
    atomicWriteJson(STATE_FILE, state);
  } catch (err) {
    log(`baseline: could not persist state: ${err.message}`);
  }
}

/** Highest balance in the ledger, i.e. the best guess at the last top-up
 *  amount for a fresh install. Returns null when the ledger is empty. */
function highestSeen(ledgerRows) {
  let best = null;
  for (const row of ledgerRows || []) {
    const v = Number(row.total_balance);
    if (Number.isFinite(v) && (best === null || v > best)) best = v;
  }
  return best;
}

/**
 * Decide the scale for this reading.
 *
 * @param {{total:number}} balance   current reading
 * @param {object} config
 * @param {Array}  ledgerRows        past readings, oldest first
 * @returns {{baseline:number|null, source:'config'|'topup'|'seed'|'held', changed:boolean}}
 */
function resolveBaseline(balance, config, ledgerRows) {
  const mode = config.baseline_mode === 'fixed' ? 'fixed' : 'auto';

  if (mode === 'fixed') {
    const v = Number(config.usage_max);
    return { baseline: Number.isFinite(v) && v > 0 ? v : null, source: 'config', changed: false };
  }

  const state = loadState() || {};
  const jump = Number(config.topup_min_jump);
  const jumpThreshold = Number.isFinite(jump) && jump > 0 ? jump : DEFAULT_JUMP_CNY;

  // The most recent reading taken BEFORE this one — by its own timestamp, not by
  // where it sits in the file. Refreshes can complete out of order, and comparing
  // against a reading that was actually taken later invents a rise that never
  // happened and rewrites the scale with it.
  const last = previousBefore(ledgerRows || [], balance.fetchedAt || new Date().toISOString());
  const lastTotal = last ? Number(last.total_balance) : NaN;

  // A top-up: a step up clearly larger than settlement noise.
  if (Number.isFinite(lastTotal) && balance.total > lastTotal + jumpThreshold) {
    const baseline = balance.total;
    saveState({ baseline: baseline, source: 'topup', set_at: new Date().toISOString(), from_balance: lastTotal });
    log(`baseline: top-up detected (${lastTotal.toFixed(2)} -> ${balance.total.toFixed(2)}), bar resets to full`);
    return { baseline, source: 'topup', changed: true };
  }

  // A learned baseline: hold it. It only ever moves on a top-up.
  const held = Number(state.baseline);
  if (Number.isFinite(held) && held > 0) {
    return { baseline: held, source: state.source || 'held', changed: false };
  }

  // Fresh install, nothing learned yet.
  const seed = Math.max(balance.total, highestSeen(ledgerRows) ?? 0);
  saveState({ baseline: seed, source: 'seed', set_at: new Date().toISOString(), from_balance: balance.total });
  log(`baseline: seeded at ${seed.toFixed(2)} (no top-up observed yet)`);
  return { baseline: seed, source: 'seed', changed: true };
}

function clearState() {
  try {
    require('node:fs').rmSync(STATE_FILE, { force: true });
  } catch {
    /* best effort */
  }
}

module.exports = { resolveBaseline, loadState, saveState, clearState, STATE_FILE, DEFAULT_JUMP_CNY };

// `node src/baseline.js set 200` / `show` / `clear` — for when you know the
// top-up amount and would rather not wait for the next one to be observed.
if (require.main === module) {
  const fs = require('node:fs');
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'show') {
    console.log(JSON.stringify(loadState(), null, 2));
  } else if (cmd === 'clear') {
    clearState();
    console.log('baseline cleared — it will be re-seeded from the next reading');
  } else if (cmd === 'set') {
    const v = Number(arg);
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`usage: node src/baseline.js set <amount>   (got "${arg}")`);
      process.exit(1);
    }
    saveState({ baseline: v, source: 'manual', set_at: new Date().toISOString() });
    console.log(`baseline set to ${v.toFixed(2)} — the bar is now balance / ${v.toFixed(2)}`);
    console.log('regenerate the snapshot with: node src/generate.js --force');
  } else {
    console.log('usage: node src/baseline.js [show | set <amount> | clear]');
  }
}
