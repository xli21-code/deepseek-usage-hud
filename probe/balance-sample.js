#!/usr/bin/env node
'use strict';
// Balance sampler. Appends one timestamped reading of DeepSeek's prepaid
// balance to a ledger, so we can later reconcile a real balance delta against
// the token-derived cost and settle two open questions at once: which currency
// the price table is in, and whether cache reads bill at the cache-hit rate.
//
//   node balance-sample.js            append a sample
//   node balance-sample.js --show     print the ledger
//
// The key is read from ANTHROPIC_AUTH_TOKEN and never logged or written to the
// ledger. The endpoint is https://api.deepseek.com/user/balance.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = process.env.DEEPSEEK_HUD_DATA_DIR?.trim()
  ? path.resolve(process.env.DEEPSEEK_HUD_DATA_DIR.trim().replace(/^~(?=\/|$)/, os.homedir()))
  : path.join(os.homedir(), '.local', 'share', 'deepseek-hud');
// A separate file on purpose: the generator learns the bar's scale by
// comparing consecutive entries in ITS ledger, so an out-of-band append can
// hide a top-up from it. This sampler never touches that file.
const LEDGER = path.join(DATA, 'balance-samples.jsonl');
const KEY = process.env.ANTHROPIC_AUTH_TOKEN || process.env.DEEPSEEK_API_KEY || '';
const URL_BALANCE = 'https://api.deepseek.com/user/balance';

if (process.argv.includes('--show')) {
  // A truncated final line is normal if a write was interrupted; skip it rather
  // than crashing the whole listing.
  const rows = [];
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      console.error(`(skipping unreadable line in ${LEDGER})`);
    }
  }
  for (const r of rows) {
    console.log(
      `${r.at}  ${r.currency} ${r.total_balance}  (granted ${r.granted_balance}, topped_up ${r.topped_up_balance})` +
        `  available=${r.is_available}`,
    );
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first && last && rows.length > 1 && first.total_balance === last.total_balance) {
    console.log('\nno movement yet — calibration window still open');
  }
  process.exit(0);
}

if (!KEY) {
  console.error('no API key in ANTHROPIC_AUTH_TOKEN / DEEPSEEK_API_KEY');
  process.exit(1);
}

(async () => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  let body;
  try {
    const res = await fetch(URL_BALANCE, {
      headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    console.error(`balance fetch failed: ${err.message}`);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }

  const info = (body.balance_infos || [])[0] || {};
  const sample = {
    at: new Date().toISOString(),
    at_local: new Date().toString(),
    is_available: body.is_available,
    currency: info.currency ?? null,
    total_balance: info.total_balance ?? null,
    granted_balance: info.granted_balance ?? null,
    topped_up_balance: info.topped_up_balance ?? null,
  };

  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(LEDGER, `${JSON.stringify(sample)}\n`, { mode: 0o600 });
  console.log(`${sample.at}  ${sample.currency} ${sample.total_balance}  -> ${LEDGER}`);
})();
