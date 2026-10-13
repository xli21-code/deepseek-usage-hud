'use strict';
// User-tunable settings, read from $CLAUDE_CONFIG_DIR/deepseek-hud.json.
//
// Defaults are written out explicitly rather than hidden, and every key here
// has an owner: `usage_max` and `low_balance` shape the bar, the two
// timing keys keep the status line responsive, and the last three are the
// Phase-2 estimate (kept visible so a measured constant never becomes an
// inlined magic number).

const { PATHS, readJson } = require('./util');

const DEFAULTS = {
  // How the bar's full scale is decided.
  //   auto  — learn it from the balance: a top-up sets it, everything else
  //           only ever drains it (see baseline.js). Default.
  //   fixed — use usage_max and never learn.
  baseline_mode: 'auto',
  // Smallest step UP between two readings that counts as a top-up rather than
  // settlement noise (the endpoint batches, so a cent or two can appear late).
  topup_min_jump: 1,
  // Only used when baseline_mode is 'fixed', or as a last-resort scale on a
  // fresh install that has not yet watched a single top-up.
  usage_max: 200,
  // STRICTLY BELOW this, balance_label gets a ⚠ prefix. Required, not
  // decorative: the bar means "remaining", so a nearly-empty balance renders
  // as a LOW percentage, which upstream colours as safe rather than critical.
  low_balance: 10,

  // How often a balance fetch is allowed. Read by generate.js AND by
  // hud-wrapper.js (via refreshAfterMs below), so the two cannot drift apart.
  throttle_seconds: 60,
  balance_timeout_ms: 2500,
  // NOTE: there is deliberately no freshness key here. How stale a snapshot
  // claude-hud will still render is `display.externalUsageFreshnessMs` in
  // ~/.config/claude-deepseek/plugins/claude-hud/config.json — a different
  // file, owned by the plugin. A key of that name used to live here and did
  // nothing.

  // Phase 2 (not used yet). cost_per_mtok is measured, not derived: console
  // cost / console tokens over a window we could also account for locally.
  // capture_correction covers the 7.3% of requests that never reach a
  // transcript file, so a local token sum is scaled before pricing it.
  show_today_estimate: false,
  cost_per_mtok: 0.168,
  capture_correction: 1.074,
};

// Renamed when the project stopped assuming a CNY-only account. Old files keep
// working; the current names win if both are present.
const LEGACY_KEYS = {
  usage_max_cny: 'usage_max',
  low_balance_cny: 'low_balance',
  topup_min_jump_cny: 'topup_min_jump',
  cny_per_mtok: 'cost_per_mtok',
};

function loadConfig() {
  const user = readJson(PATHS.userConfig, null);
  const cfg = { ...DEFAULTS };
  if (user && typeof user === 'object') {
    for (const [legacy, current] of Object.entries(LEGACY_KEYS)) {
      if (legacy in user && !(current in user)) user[current] = user[legacy];
    }
    for (const [k, v] of Object.entries(user)) {
      if (k in DEFAULTS && typeof v === typeof DEFAULTS[k] && v !== null) cfg[k] = v;
    }
  }
  return cfg;
}

/**
 * When hud-wrapper should ask for a refresh, derived from throttle_seconds so
 * the wrapper and the generator cannot drift apart. Deliberately slightly
 * below the throttle: asking early is free (generate.js re-checks and exits),
 * while asking late would let the snapshot outlive claude-hud's freshness
 * window and blank the Usage segment.
 */
function refreshAfterMs(cfg) {
  return Math.max(5_000, Math.round(cfg.throttle_seconds * 1000 * 0.9));
}

module.exports = { loadConfig, refreshAfterMs, DEFAULTS };
