'use strict';
// Ollama Cloud: the second account this HUD can show.
//
// Three facts, each measured against https://ollama.com on 2026-11-02, shape
// this file:
//
//   1. GET /api/balance returns a credit period, not a top-up history:
//        { included: { balance_usd, allowance_usd, period: { from, until } },
//          purchased: { balance_usd } }
//      That maps onto the same "the bar means REMAINING" rule the DeepSeek bar
//      already uses, so the two accounts can share one renderer.
//
//   2. GET /api/usage?range=24h|7d|30d returns `input_tokens` INCLUSIVE of
//      `cached_input_tokens`. Measured: 14,999,514 cached of 15,523,094 input,
//      i.e. 96.63% — matching pi's own sidecar (96.67%) only under that reading.
//      DeepSeek reports the two counts disjoint and pi follows it, so the
//      formula in pi-usage.js must NOT be reused here; doing so doubles the rate.
//
//   3. `today` is not a range. The endpoint answers 400 with
//      `{"error":"range must be 24h, 7d, or 30d"}`.
//
// The key already lives in ~/.config/magpie/providers.json (the gateway pi and
// Claude Code both talk to), so reading it there avoids asking the user to
// paste the same secret a second time. Env still wins.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { log } = require('./util');

const BALANCE_URL = 'https://ollama.com/api/balance';
const USAGE_URL = 'https://ollama.com/api/usage';
const RANGES = new Set(['24h', '7d', '30d']);
const MAGPIE_PROVIDERS = path.join(os.homedir(), '.config', 'magpie', 'providers.json');

/** A JSON number, or NaN. `Number(null)` is 0 and would read as a real balance. */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * magpie keeps provider credentials in one file. Accept the two field names a
 * provider record has used; anything else means "no key here", not a crash.
 */
function readMagpieKey(file = MAGPIE_PROVIDERS) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(doc?.providers) ? doc.providers : [];
    const provider = list.find((p) => p && p.id === 'ollama-cloud');
    for (const field of ['key', 'apiKey']) {
      const value = provider?.[field];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    /* missing or unreadable: not an error, just no key */
  }
  return null;
}

function apiKey() {
  const fromEnv = process.env.OLLAMA_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  return readMagpieKey();
}

/** Pure: the balance payload -> what the renderer needs. */
function normalizeBalance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const included = raw.included;
  const balance = num(included?.balance_usd);
  // Unlike the DeepSeek ledger, zero is a legitimate answer here: pay-as-you-go
  // accounts really do run out. Only a non-number is a rejection.
  if (!Number.isFinite(balance)) return null;
  const allowance = num(included?.allowance_usd);
  const purchased = num(raw.purchased?.balance_usd);
  return {
    balance_usd: balance,
    allowance_usd: Number.isFinite(allowance) && allowance > 0 ? allowance : null,
    purchased_usd: Number.isFinite(purchased) ? purchased : 0,
    period_from: typeof included?.period?.from === 'string' ? included.period.from : null,
    period_until: typeof included?.period?.until === 'string' ? included.period.until : null,
  };
}

/** Pure: the usage payload -> totals. `cached` is a SUBSET of `input`. */
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const totals = raw.totals;
  if (!totals || typeof totals !== 'object') return null;
  const input = num(totals.input_tokens);
  if (!Number.isFinite(input)) return null;
  const cachedRaw = num(totals.cached_input_tokens);
  const cached = Number.isFinite(cachedRaw) ? Math.min(Math.max(cachedRaw, 0), Math.max(input, 0)) : 0;
  const count = (v) => (Number.isFinite(num(v)) ? num(v) : 0);
  return {
    range: typeof raw.range === 'string' ? raw.range : null,
    from: typeof raw.from === 'string' ? raw.from : null,
    until: typeof raw.until === 'string' ? raw.until : null,
    request_count: count(totals.request_count),
    usage_usd: count(totals.usage_usd),
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: count(totals.output_tokens),
    // Denominator is input_tokens itself here — see fact 2 in the header.
    cache_hit_rate: input > 0 ? Math.round((cached / input) * 10000) / 10000 : 0,
  };
}

async function getJson(url, key, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      log(`ollama: HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    log(`ollama: ${err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve to a normalized balance, or null. Never throws. */
async function fetchOllamaBalance(timeoutMs = 2500) {
  const key = apiKey();
  if (!key) {
    log('ollama: no API key (OLLAMA_API_KEY or magpie providers.json)');
    return null;
  }
  const requestedAt = new Date().toISOString();
  const raw = await getJson(BALANCE_URL, key, timeoutMs);
  const balance = normalizeBalance(raw);
  if (!balance) {
    if (raw) log('ollama: unusable balance payload');
    return null;
  }
  return { ...balance, requested_at: requestedAt };
}

/** Resolve to normalized totals for `range`, or null. Never throws. */
async function fetchOllamaUsage(range = '24h', timeoutMs = 4000) {
  if (!RANGES.has(range)) {
    log(`ollama: refusing range ${JSON.stringify(range)} — only 24h, 7d, 30d are accepted`);
    return null;
  }
  const key = apiKey();
  if (!key) return null;
  const fetchedAt = new Date().toISOString();
  const raw = await getJson(`${USAGE_URL}?range=${range}`, key, timeoutMs);
  const usage = normalizeUsage(raw);
  if (!usage) {
    if (raw) log('ollama: unusable usage payload');
    return null;
  }
  return { ...usage, fetched_at: fetchedAt };
}

/**
 * Usage is a 24h aggregate that the provider updates lazily ("new usage may
 * take time to appear"), so re-reading it on every 60s refresh buys nothing.
 * Keep the previous reading until this window lapses.
 */
function usageIsFresh(usage, nowMs, minMs) {
  const at = Date.parse(usage?.fetched_at ?? '');
  if (!Number.isFinite(at)) return false;
  return nowMs - at < minMs;
}

module.exports = {
  apiKey,
  readMagpieKey,
  normalizeBalance,
  normalizeUsage,
  fetchOllamaBalance,
  fetchOllamaUsage,
  usageIsFresh,
  BALANCE_URL,
  USAGE_URL,
  RANGES,
};
