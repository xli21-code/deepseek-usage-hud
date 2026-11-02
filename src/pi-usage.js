'use strict';
// pi's HUD extension writes pi-usage.json — the only file that extension is
// allowed to write. The join happens on the writer's side, in the generator, so
// the snapshot stays the single source of truth rather than being recomputed by
// two renderers.
//
// This module exists so the two rules that matter can be tested without a
// network, without the real data directory and without running the generator:
//   * a sidecar whose date is not today is not today's data, and
//   * only entries that actually ran a turn are sessions.
// It takes the data directory as an argument, so a test can point it at a
// fixture. Reads only: no write, no log, no network, no throw.

const path = require('node:path');

const { readJson } = require('./util');

/** "Today" in the local calendar — the sidecar's date is a calendar day, not UTC. */
function localToday(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Aggregate the day's sessions from `dataDir/pi-usage.json`. A missing file,
 * corrupt JSON or a date that is not today means "nothing to report" (null), so
 * a sidecar from another calendar day never leaks into today's snapshot.
 *
 * An entry with turns 0 is a session that opened and never answered. It is not
 * counted, for `sessions` or for the totals, and when nothing ran a turn the
 * whole block is omitted rather than shown as a block of zeros.
 */
function readPiUsage(dataDir, now = new Date()) {
  const doc = readJson(path.join(dataDir, 'pi-usage.json'), null);
  if (!doc || typeof doc !== 'object' || doc.date !== localToday(now)) return null;
  if (!doc.sessions || typeof doc.sessions !== 'object') return null;

  const acc = { sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
  let newest = null;
  for (const entry of Object.values(doc.sessions)) {
    if (!entry || typeof entry !== 'object') continue;
    if (!(Number(entry.turns) > 0)) continue; // never ran a turn: not a session
    acc.sessions += 1;
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'turns']) {
      acc[field] += Number(entry[field]) || 0;
    }
    const at = Date.parse(entry.updated_at);
    if (!Number.isNaN(at) && (newest === null || at > newest)) newest = at;
  }
  if (!acc.sessions) return null;

  // Denominator is what was actually sent: cached tokens plus the new ones.
  const denom = acc.input + acc.cacheRead;
  return {
    date: doc.date,
    updated_at: newest !== null ? new Date(newest).toISOString() : doc.updated_at,
    sessions: acc.sessions,
    input: acc.input,
    output: acc.output,
    cacheRead: acc.cacheRead,
    cacheWrite: acc.cacheWrite,
    turns: acc.turns,
    cache_hit_rate: denom > 0 ? Math.round((acc.cacheRead / denom) * 10000) / 10000 : 0,
  };
}

module.exports = { localToday, readPiUsage };
