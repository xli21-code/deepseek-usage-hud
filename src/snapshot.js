'use strict';
// The one piece of glue between DeepSeek and claude-hud.
//
// claude-hud renders `display.externalUsagePath` as its Usage segment. The
// schema's `balance_label` field exists upstream for exactly this case (its
// own comment reads `// optional raw balance text (e.g. "¥6.35")`), so we do
// not fork the plugin — we just feed it.
//
// Two deliberate choices, both traceable to decisions in PLAN.md:
//
//   * The bar means REMAINING, not consumed:
//         utilization = round(clamp(0, 100, balance / usage_max * 100))
//     This is stateless by construction (D11: no cycles, no top-up detection,
//     no baseline), so a top-up needs no bookkeeping — the bar refills because
//     the balance went up.
//
//   * A low balance must be said in TEXT. Upstream colours by used-percentage
//     (>=90 red, >=75 magenta, else normal), so under inverted semantics a
//     nearly-empty balance renders short AND calm. The colour cannot be
//     trusted; the ⚠ prefix is load-bearing, not decoration.
//
// The upstream parser clamps utilization to 0..100 and truncates
// balance_label to 50 chars / display_name to 64, so overshooting ¥200 simply
// reads as "full". Accepted in D14: with top-ups below ¥10 the resulting dead
// zone is under 5% of the bar and does not accumulate.

const { PATHS, atomicWriteJson } = require('./util');
const { formatAmount } = require('./currency');

const LABEL_MAX = 50;

function clampPercent(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Pure: balance + scale -> snapshot object. Exported for tests.
 *
 * `baseline` is the bar's full scale, learned from the balance (see
 * baseline.js). It is passed in rather than read from config so this function
 * stays pure; the caller decides how the scale was arrived at. A null baseline
 * falls back to the configured `usage_max`, which is what a fresh install
 * shows before it has watched a single top-up.
 */
function buildSnapshot(balance, config, now = new Date(), baseline = null, baselineSource = 'config') {
  const configured = Number(config.usage_max);
  const max =
    Number.isFinite(baseline) && baseline > 0
      ? baseline
      : Number.isFinite(configured) && configured > 0
        ? configured
        : 200;
  const low = Number.isFinite(config.low_balance) ? config.low_balance : 0;
  const lowWarning = balance.total < low;

  // The symbol follows the currency the API reported; see src/currency.js for
  // why assuming one is a bug rather than a shortcut.
  let label = formatAmount(balance.total, balance.currency);
  if (lowWarning) label = `⚠ ${label}`;
  if (label.length > LABEL_MAX) label = `${label.slice(0, LABEL_MAX - 3)}...`;

  return {
    updated_at: now.toISOString(),
    balance_label: label,
    // 5h / 7d stay null on purpose: they carry quota semantics upstream
    // (usagePace, isLimitReached) that a prepaid balance does not have.
    five_hour: { used_percentage: null, resets_at: null },
    seven_day: { used_percentage: null, resets_at: null },
    // Rendered with forceLabel, so the label always shows: `Balance ████░░ 40%`.
    model_scoped: [
      { display_name: 'Balance', utilization: clampPercent((balance.total / max) * 100), resets_at: null },
    ],
    // Private bookkeeping for the skill and tests; upstream ignores unknown keys.
    _meta: {
      currency: balance.currency ?? null,
      baseline: max,
      baseline_source: baselineSource,
      usage_max: max,
      low_balance: low,
      low_warning: lowWarning,
      source_doc: 'PLAN.md §3, D11, D13, D14',
    },
  };
}

function writeSnapshot(snapshot) {
  atomicWriteJson(PATHS.snapshot, snapshot);
}

module.exports = { buildSnapshot, writeSnapshot, clampPercent };
