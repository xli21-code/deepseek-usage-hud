'use strict';
// The state update must not depend on the order things happened to finish in.
//
// This is what lets the lock be weaker than perfect without the state being
// wrong. The case that broke it: the real balance goes 50 -> 49 -> 40, two
// refreshes run concurrently, and the one that read 40 lands first. The ledger
// then reads 50 -> 40 -> 49, the baseline resolver sees a rise that never
// happened, treats it as a top-up, and rewrites the bar's scale — from 100 to
// 49 — so a plain decrease silently pinned the bar at 100%.
//
// The fix is that every reading carries the time it was TAKEN, and readers sort
// by that rather than by write order.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dshud-state-'));
process.env.DEEPSEEK_HUD_DATA_DIR = TMP;

const { appendLedger, readLedger, fetchBalance } = require('../src/balance');
const { resolveBaseline } = require('../src/baseline');
const { buildSnapshot } = require('../src/snapshot');

const CFG = { baseline_mode: 'auto', topup_min_jump: 1, usage_max: 100, low_balance: 10 };
const at = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();
const sample = (total, secondsAgo) => ({
  total,
  currency: 'CNY',
  granted: 0,
  toppedUp: total,
  isAvailable: true,
  fetchedAt: at(secondsAgo),
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('state: a late-arriving reading does not invent a top-up', () => {
  fs.rmSync(path.join(TMP, 'balance-ledger.jsonl'), { force: true });
  fs.writeFileSync(path.join(TMP, 'baseline.json'), JSON.stringify({ baseline: 100, source: 'manual' }));

  appendLedger(sample(50, 300)); // the reading that started it

  // Two refreshes overlap. A read 49 first; B read 40 a little later; B lands
  // first, so the ledger is written out of order.
  const A = sample(49, 60);
  const B = sample(40, 10);
  resolveBaseline(B, CFG, readLedger());
  appendLedger(B);
  const r = resolveBaseline(A, CFG, readLedger());
  appendLedger(A);

  assert.strictEqual(r.baseline, 100, 'the scale is untouched');
  assert.notStrictEqual(r.source, 'topup', 'no top-up was seen');
  assert.deepStrictEqual(
    readLedger().map((x) => x.total_balance),
    ['50.00', '49.00', '40.00'],
    'read in the order the readings were taken',
  );

  const snap = buildSnapshot({ total: 49, currency: 'CNY' }, CFG, new Date(), r.baseline, r.source);
  assert.strictEqual(snap.model_scoped[0].utilization, 49, 'the bar reflects 49 of 100, not 100% of 49');
});

test('state: real fetchBalance responses that arrive out of order do not invent a top-up', async () => {
  // Drives the production path, not hand-built samples. The previous test
  // assigned timestamps itself, which is what hid the bug: `fetchedAt` was
  // stamped when the RESPONSE landed, so the request issued first but answered
  // last carried the later timestamp, and the ledger reordered a decrease into a
  // rise. Only the network is mocked here.
  fs.rmSync(path.join(TMP, 'balance-ledger.jsonl'), { force: true });
  fs.writeFileSync(path.join(TMP, 'baseline.json'), JSON.stringify({ baseline: 100, source: 'manual' }));

  const realFetch = global.fetch;
  const realKey = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = 'sk-test';
  let call = 0;
  global.fetch = () => {
    const mine = ++call;
    const value = mine === 1 ? 49 : 40; // issued first reads 49 and answers last
    const delay = mine === 1 ? 400 : 50;
    return new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            ok: true,
            json: async () => ({
              is_available: true,
              balance_infos: [
                {
                  currency: 'CNY',
                  total_balance: String(value),
                  granted_balance: '0',
                  topped_up_balance: String(value),
                },
              ],
            }),
          }),
        delay,
      ),
    );
  };

  try {
    appendLedger({ ...sample(50, 300), fetchedAt: at(300) });
    const A = fetchBalance(5000); // issued first, reads 49
    // A gap, because the stamp has millisecond resolution and two requests
    // issued inside the same millisecond are indistinguishable — which the lock
    // normally makes irrelevant, since it serialises refreshes.
    await new Promise((r) => setTimeout(r, 5));
    const B = fetchBalance(5000); // issued second, reads 40, answers first
    const b = await B;
    resolveBaseline(b, CFG, readLedger());
    appendLedger(b);
    const a = await A;
    const r = resolveBaseline(a, CFG, readLedger());
    appendLedger(a);

    assert.ok(Date.parse(a.fetchedAt) < Date.parse(b.fetchedAt), 'the earlier request carries the earlier stamp');
    assert.strictEqual(r.source, 'manual', 'no top-up was seen');
    assert.strictEqual(r.baseline, 100, 'and the scale is untouched');
    assert.deepStrictEqual(readLedger().map((x) => x.total_balance), ['50.00', '49.00', '40.00']);
  } finally {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = realKey;
  }
});

test('state: a genuine top-up is still detected when readings arrive in order', () => {
  fs.rmSync(path.join(TMP, 'balance-ledger.jsonl'), { force: true });
  fs.writeFileSync(path.join(TMP, 'baseline.json'), JSON.stringify({ baseline: 100, source: 'manual' }));

  appendLedger(sample(9.23, 120));
  const r = resolveBaseline(sample(209.23, 10), CFG, readLedger());
  assert.strictEqual(r.source, 'topup');
  assert.strictEqual(r.baseline, 209.23, 'top-up plus whatever was left');
});

test('state: repeated identical readings collapse on read', () => {
  fs.rmSync(path.join(TMP, 'balance-ledger.jsonl'), { force: true });
  appendLedger(sample(50, 300));
  appendLedger(sample(50, 240));
  appendLedger(sample(50, 180));
  appendLedger(sample(40, 60));
  assert.deepStrictEqual(readLedger().map((x) => x.total_balance), ['50.00', '40.00']);
});

test('state: concurrent refreshes leave the state consistent', async () => {
  // The property the design actually leans on, since reclaiming a dead socket
  // cannot be made exclusively atomic with path primitives (see src/generate.js).
  // Several refreshes run against the same ledger at once; whatever order they
  // finish in, the reading order must reflect the order they were TAKEN, and the
  // scale must not be rewritten by a rise that never happened.
  fs.rmSync(path.join(TMP, 'balance-ledger.jsonl'), { force: true });
  fs.writeFileSync(path.join(TMP, 'baseline.json'), JSON.stringify({ baseline: 100, source: 'manual' }));

  const readings = [50, 47, 44, 41, 38];
  const samples = readings.map((v, i) => sample(v, (readings.length - i) * 10));
  appendLedger(samples[0]);

  // Resolve and append concurrently, in an order unrelated to the timestamps.
  await Promise.all(
    [samples[3], samples[1], samples[4], samples[2]].map(
      (s) =>
        new Promise((r) =>
          setTimeout(() => {
            resolveBaseline(s, CFG, readLedger());
            appendLedger(s);
            r();
          }, Math.floor(Math.random() * 20)),
        ),
    ),
  );

  assert.deepStrictEqual(
    readLedger().map((x) => Number(x.total_balance)),
    [50, 47, 44, 41, 38],
    'read in the order the readings were taken, whatever order they landed in',
  );
  const after = resolveBaseline(sample(35, 1), CFG, readLedger());
  assert.strictEqual(after.baseline, 100, 'and the scale was never rewritten');
  assert.notStrictEqual(after.source, 'topup', 'no phantom top-up');
});
