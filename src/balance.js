'use strict';
// DeepSeek prepaid balance: the one ground-truth number this project has.
//
// Everything else we display is derived; this is read straight from the API.
// Two facts about it, both measured, shape the whole design:
//
//   1. It settles in BATCHES. Two adjacent 11-minute windows implied
//      contradictory price factors (12.08 vs 3.46), and a lag scan over
//      -15..+20 minutes found no alignment. So a balance delta is only
//      meaningful over hours, and a short window tells you nothing.
//   2. Resolution is ¥0.01, while a single turn can cost less than that.
//
// Consequence: we never derive "spend today" from balance deltas. The balance
// is shown as-is, and the ledger is kept for long-horizon reconciliation.
//
// The account is shared: the same key is also in ~/.config/litellm/litellm.env
// (the LiteLLM gateway). So this number is ACCOUNT-level, not Claude-Code-only.
// The gateway's own ledger was dormant when this was written, but if that
// batch line ever runs, the balance will drop for reasons this HUD cannot see.

const { PATHS, log, atomicWriteJson, readJson } = require('./util');

const BALANCE_URL = 'https://api.deepseek.com/user/balance';

function apiKey() {
  return process.env.ANTHROPIC_AUTH_TOKEN || process.env.DEEPSEEK_API_KEY || '';
}

/** Fetch the balance. Resolves to null on any failure; never throws, never blocks. */
async function fetchBalance(timeoutMs = 2500) {
  const key = apiKey();
  if (!key) {
    log('balance: no API key in ANTHROPIC_AUTH_TOKEN / DEEPSEEK_API_KEY');
    return null;
  }
  // Stamp the moment we ASK, not the moment the answer lands.
  //
  // Stamping after the response makes this a completion time, and two
  // overlapping refreshes then order by which reply arrived first — which is
  // precisely the ordering the ledger is meant to be immune to. Measured: a
  // request for 49 issued first but answered last took a later timestamp than a
  // request for 40 issued after it, so the ledger read 50 -> 40 -> 49 and the
  // resolver called the 40-to-49 step a top-up.
  //
  // Millisecond resolution: two requests issued inside the same millisecond get
  // identical stamps and cannot be ordered against each other. The lock
  // serialises refreshes, so that is a corner rather than the norm; when it does
  // happen, `previousBefore` finds no strictly-earlier reading and simply makes
  // no comparison, which errs toward leaving the scale alone.
  const requestedAt = new Date().toISOString();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(BALANCE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) {
      log(`balance: HTTP ${res.status}`);
      return null;
    }
    const body = await res.json();
    const info = (body.balance_infos || [])[0] || {};
    // Check the TYPE before converting. `Number(null)` and `Number('')` are both
    // 0, which is finite — a malformed response would otherwise be reported as a
    // perfectly plausible zero balance and drain the bar to empty.
    const raw = info.total_balance;
    const total =
      typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(total)) {
      log(`balance: unusable total_balance (${JSON.stringify(raw)})`);
      return null;
    }
    return {
      total,
      currency: info.currency ?? null,
      granted: Number(info.granted_balance),
      toppedUp: Number(info.topped_up_balance),
      isAvailable: body.is_available !== false,
      fetchedAt: requestedAt,
    };
  } catch (err) {
    log(`balance: ${err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The ledger, ordered by when each reading was TAKEN.
 *
 * Not by when it was written. Two refreshes can complete out of order — A reads
 * 49, B reads 40, B lands first — and in completion order the ledger shows a rise
 * from 40 to 49 that never happened. `resolveBaseline` reads that rise as a
 * top-up and rewrites the bar's scale, so a perfectly ordinary decrease silently
 * raised the scale from 100 to 49 and pinned the bar at 100%.
 *
 * Timestamps make the reader order-independent, which is what lets the lock be
 * weaker than perfect without the state being wrong: whichever write lands last,
 * a reader sees the readings in the sequence they actually occurred.
 */
function readLedger() {
  const fs = require('node:fs');
  let text;
  try {
    text = fs.readFileSync(PATHS.ledger, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row.at === 'string' && Number.isFinite(Number(row.total_balance))) rows.push(row);
    } catch {
      /* a truncated final line from an interrupted write */
    }
  }
  rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // Collapse repeats, so the file can be appended to without a read-modify-write
  // and still read as a sequence of changes.
  const out = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.total_balance === row.total_balance) continue;
    out.push(row);
  }
  return out;
}

/** The most recent reading strictly OLDER than `atISO` — i.e. the reading this
 *  one should be compared against, whatever order things were written in. A
 *  reading that arrived late must not be compared against one taken after it. */
function previousBefore(rows, atISO) {
  const t = Date.parse(atISO);
  let best = null;
  for (const row of rows) {
    const rt = Date.parse(row.at);
    if (!Number.isFinite(rt) || rt >= t) continue;
    if (!best || rt > Date.parse(best.at)) best = row;
  }
  return best;
}

/**
 * Append a reading. Deliberately append-only: no read-modify-write, so two
 * refreshes finishing at once cannot lose each other's rows. The duplicate check
 * is best-effort and racy by design — a duplicate row is harmless because
 * readLedger collapses repeats.
 */
function appendLedger(sample) {
  if (!sample) return false;
  const fs = require('node:fs');
  try {
    const row = {
      at: sample.fetchedAt,
      currency: sample.currency,
      total_balance: sample.total.toFixed(2),
      granted_balance: Number.isFinite(sample.granted) ? sample.granted.toFixed(2) : null,
      topped_up_balance: Number.isFinite(sample.toppedUp) ? sample.toppedUp.toFixed(2) : null,
      is_available: sample.isAvailable,
    };
    fs.mkdirSync(PATHS.DATA_DIR, { recursive: true });
    fs.appendFileSync(PATHS.ledger, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    return true;
  } catch (err) {
    log(`ledger append failed: ${err.message}`);
    return false;
  }
}

// `node balance.js` reads the balance and prints it. It deliberately does NOT
// write the ledger: the baseline is learned by comparing each reading against
// the previous one, so a reading appended out of band can hide a top-up from the
// generator — the next reading no longer looks like a step up. Anything that
// wants to record a reading goes through generate.js, which resolves the
// baseline first and holds the lock.
if (require.main === module) {
  fetchBalance(8000).then((s) => {
    if (!s) {
      console.error('balance fetch failed — see generator.log');
      process.exit(1);
    }
    const prior = readLedger();
    const last = prior[prior.length - 1];
    console.log(`${s.fetchedAt}  ${s.currency} ${s.total.toFixed(2)}  (ledger: ${prior.length} entries)`);
    if (last) console.log(`last recorded: ${last.at}  ${last.total_balance}`);
    console.log('(read-only — run `node src/generate.js --force` to record a reading)');
  });
}

module.exports = { fetchBalance, appendLedger, readLedger, previousBefore };
