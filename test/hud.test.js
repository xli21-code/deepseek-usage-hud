'use strict';
// node --test test/
//
// Covers the two pure modules that decide what the bar says: how the scale is
// learned (baseline.js) and what the snapshot looks like (snapshot.js), plus
// the currency formatting both depend on. These are the parts a reader can
// check, so they are the parts worth pinning down.
//
// Data directory is redirected first — the modules resolve their paths at
// require() time, so this must happen before anything is imported.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dshud-test-'));
process.env.DEEPSEEK_HUD_DATA_DIR = TMP;

const { resolveBaseline, loadState, clearState } = require('../src/baseline');
const { buildSnapshot, clampPercent } = require('../src/snapshot');
const { formatAmount, symbolFor } = require('../src/currency');

const CFG = { baseline_mode: 'auto', topup_min_jump: 1, usage_max: 200, low_balance: 10 };

// Readings carry the time they were TAKEN, and the resolver compares against the
// latest one taken before the current reading — not against whatever happens to
// be last in the file. Fixtures therefore need real ordering; rows sharing one
// timestamp are not "earlier" than anything.
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const ledger = (...amounts) =>
  amounts.map((a, i) => ({
    at: minutesAgo(amounts.length - i),
    total_balance: a.toFixed(2),
  }));
const reading = (total, minutesAgoTaken = 0) => ({ total, fetchedAt: minutesAgo(minutesAgoTaken) });

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------- currency

test('currency: symbol follows the API value, never a default', () => {
  assert.strictEqual(formatAmount(42.1, 'CNY'), '¥42.10 CNY');
  assert.strictEqual(formatAmount(42.1, 'USD'), '$42.10 USD');
  assert.strictEqual(formatAmount(4200, 'JPY'), 'JP¥4200.00 JPY');
  assert.strictEqual(symbolFor('usd'), '$', 'case-insensitive');
});

test('currency: an unknown code shows the number and the code, not a made-up symbol', () => {
  assert.strictEqual(formatAmount(42.1, 'XYZ'), '42.10 XYZ');
  assert.strictEqual(formatAmount(42.1, null), '42.10');
  assert.strictEqual(formatAmount(42.1, ''), '42.10');
});

// ------------------------------------------------------------------ snapshot

test('snapshot: the bar is the balance over the scale, clamped to 0..100', () => {
  const at = (total, scale) =>
    buildSnapshot({ total, currency: 'CNY' }, CFG, new Date(), scale, 'manual').model_scoped[0].utilization;
  assert.strictEqual(at(50, 200), 25);
  assert.strictEqual(at(200, 200), 100);
  assert.strictEqual(at(0, 200), 0);
  // A balance above the scale — a top-up on top of an existing balance — reads
  // as full, which is the accepted behaviour (upstream clamps anything >100).
  assert.strictEqual(at(209.23, 200), 100);
  assert.strictEqual(clampPercent(-5), 0);
  assert.strictEqual(clampPercent(150), 100);
});

test('snapshot: the warning is strictly below the threshold, and is text because the colour is inverted', () => {
  const label = (total) =>
    buildSnapshot({ total, currency: 'CNY' }, CFG, new Date(), 200, 'manual').balance_label;
  assert.strictEqual(label(10), '¥10.00 CNY', 'exactly at the line: no warning');
  assert.strictEqual(label(9.99), '⚠ ¥9.99 CNY');
  const meta = buildSnapshot({ total: 9.99, currency: 'CNY' }, CFG, new Date(), 200, 'manual')._meta;
  assert.strictEqual(meta.low_warning, true);
});

test('snapshot: the quota windows stay empty — they carry semantics a prepaid balance lacks', () => {
  const s = buildSnapshot({ total: 50, currency: 'CNY' }, CFG, new Date(), 200, 'manual');
  assert.strictEqual(s.five_hour.used_percentage, null);
  assert.strictEqual(s.seven_day.used_percentage, null);
});

test('snapshot: falls back to the configured scale only when nothing was learned', () => {
  const util = (scale) =>
    buildSnapshot({ total: 100, currency: 'CNY' }, CFG, new Date(), scale, 'x').model_scoped[0].utilization;
  assert.strictEqual(util(null), 50, 'no scale learned -> usage_max');
  assert.strictEqual(util(0), 50, 'a zero scale is not a scale');
});

// ------------------------------------------------------------------ baseline

test('baseline: a fresh install seeds from the highest balance ever recorded', () => {
  clearState();
  const r = resolveBaseline(reading(70), CFG, ledger(100, 85));
  assert.strictEqual(r.baseline, 100, 'the top-up proxy is the highest seen, not the current');
  assert.strictEqual(r.source, 'seed');
});

test('baseline: spending never moves the scale', () => {
  clearState();
  resolveBaseline(reading(100, 10), CFG, []);
  assert.strictEqual(resolveBaseline(reading(88), CFG, ledger(100)).baseline, 100);
  assert.strictEqual(resolveBaseline(reading(60), CFG, ledger(100, 88)).baseline, 100);
});

test('baseline: a top-up sets the scale to the balance just after it', () => {
  clearState();
  resolveBaseline(reading(100, 10), CFG, []);
  // Not "200" — the money available is the top-up PLUS whatever was left.
  const r = resolveBaseline(reading(209.23), CFG, ledger(100, 9.23));
  assert.strictEqual(r.baseline, 209.23);
  assert.strictEqual(r.source, 'topup');
  assert.strictEqual(r.changed, true);
});

test('baseline: settlement noise is not a top-up, and the threshold is strict', () => {
  clearState();
  resolveBaseline(reading(205, 10), CFG, []);
  assert.strictEqual(resolveBaseline(reading(200.4), CFG, ledger(205, 199.9)).baseline, 205, '+0.5 ignored');
  assert.strictEqual(resolveBaseline(reading(206), CFG, ledger(205)).baseline, 205, 'exactly +1 ignored');
  assert.strictEqual(resolveBaseline(reading(206.01), CFG, ledger(205)).baseline, 206.01, '+1.01 counts');
});

test('baseline: fixed mode ignores the balance entirely', () => {
  clearState();
  const r = resolveBaseline(reading(77), { ...CFG, baseline_mode: 'fixed' }, ledger(205));
  assert.strictEqual(r.baseline, 200);
  assert.strictEqual(r.source, 'config');
});

test('baseline: state survives a reload, and an old baseline_cny key still reads', () => {
  clearState();
  resolveBaseline(reading(100, 10), CFG, []);
  assert.strictEqual(loadState().baseline, 100, 'persisted');
  // Written before the keys dropped their currency suffix.
  fs.writeFileSync(path.join(TMP, 'baseline.json'), JSON.stringify({ baseline_cny: 250, source: 'topup' }));
  // Balance below the previous reading, so this exercises the held-scale path
  // rather than tripping top-up detection.
  assert.strictEqual(resolveBaseline(reading(90), CFG, ledger(100)).baseline, 250, 'legacy key honoured');
  clearState();
});

test('config: legacy _cny key names still load', () => {
  const cfgPath = path.join(TMP, 'deepseek-hud.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ usage_max_cny: 150, low_balance_cny: 5 }));
  process.env.CLAUDE_CONFIG_DIR = TMP;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/util')];
  const { loadConfig } = require('../src/config');
  const cfg = loadConfig();
  assert.strictEqual(cfg.usage_max, 150);
  assert.strictEqual(cfg.low_balance, 5);
});
