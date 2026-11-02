#!/usr/bin/env node
'use strict';
// Refresh the usage snapshot. This is the ONLY place a snapshot is written.
//
//   node generate.js            refresh if due
//   node generate.js --force    refresh regardless
//   node generate.js --status   print the current snapshot, change nothing
//
// `report.js --refresh` calls refresh() from here rather than doing its own
// fetch-and-write. A second implementation of that path shipped once and got the
// scale wrong — it rebuilt the snapshot without the learned baseline, so a bar
// sitting at 40% silently became 20%.
//
// Refreshes are serialized in-process and protected across processes by a
// listening UNIX socket. Recovery of a dead socket has its own exclusive gate.
// The throttle records attempts, including failures, and fetch has a timeout.

const fs = require('node:fs');
const { PATHS, ensureDataDir, log, readJson, atomicWriteJson } = require('./util');
const { loadConfig } = require('./config');
const { fetchBalance, appendLedger, readLedger } = require('./balance');
const { resolveBaseline } = require('./baseline');
const { buildSnapshot, writeSnapshot } = require('./snapshot');
const { readPiUsage } = require('./pi-usage');

const MAX_BACKOFF_MS = 15 * 60_000;
// mtimeMs is sub-millisecond precise, so `Date.now() - mtimeMs` is routinely a
// small NEGATIVE number for a file written microseconds ago. Only a skew beyond
// this is a real clock problem.
const CLOCK_SKEW_TOLERANCE_MS = 5_000;
const ATTEMPT_FILE = PATHS.attempt;

// ------------------------------------------------------------------ throttle

function readAttempt() {
  const a = readJson(ATTEMPT_FILE, null);
  if (!a || typeof a !== 'object' || typeof a.at !== 'string') return null;
  const t = Date.parse(a.at);
  if (Number.isNaN(t)) return null;
  // A timestamp implausibly far in the future is corrupt, not meaningful.
  // Treating it as "just attempted" froze refreshing until the wall clock caught
  // up; ignoring it instead lets the next attempt rewrite it.
  if (t - Date.now() > CLOCK_SKEW_TOLERANCE_MS) {
    log(`ignoring attempt timestamp ${a.at}: implausibly in the future`);
    return null;
  }
  // `failures: "garbage"` would make the backoff NaN and slip past every check.
  const failures = Number.isInteger(a.failures) && a.failures >= 0 ? a.failures : a.ok ? 0 : 1;
  return { ok: a.ok === true, atMs: t, failures };
}

/** Milliseconds still to wait before another attempt is due. 0 means "go". */
function throttledFor(cfg) {
  const a = readAttempt();
  if (!a) return 0;
  const age = Math.max(0, Date.now() - a.atMs); // small negative age is mtime noise
  const base = a.ok
    ? cfg.throttle_seconds * 1000
    : Math.min(MAX_BACKOFF_MS, cfg.throttle_seconds * 1000 * 2 ** Math.min(a.failures || 1, 6));
  return Math.max(0, base - age);
}

function recordAttempt(ok) {
  const prev = readAttempt();
  const failures = ok ? 0 : (prev && !prev.ok ? (prev.failures || 1) + 1 : 1);
  try {
    atomicWriteJson(ATTEMPT_FILE, { at: new Date().toISOString(), ok, failures });
  } catch (err) {
    log(`could not record attempt: ${err.message}`);
  }
}

// ---------------------------------------------------------------------- lock
//
// A listening socket is owned until the process exits. We never close/unlink it
// on release: Node's close() can unlink a successor's path.
//
// Dead-socket recovery is serialized by an exclusive directory. Once inside,
// recheck liveness before removing the dead socket. Nobody automatically steals
// this gate: if a process dies while recovering, fail closed and report the path
// for manual recovery. This trades availability after that crash for exclusion.

const net = require('node:net');
const LOCK = PATHS.lockFile;
const RECOVERY_GATE = `${LOCK}.recovery`;

let lockServer = null;

function tryListen() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      server.removeAllListeners();
      resolve({ ok: false, code: err.code });
    });
    server.listen(LOCK, () => resolve({ ok: true, server }));
  });
}

/**
 * True when something is listening — liveness observed, not inferred from an
 * mtime.
 *
 * Only errors that MEAN "nothing is there" count as dead. A timeout, or any
 * other failure, is treated as alive. That asymmetry matters: on a loaded
 * machine a connection to a live socket can exceed the timeout, and the earlier
 * version read that as "the holder is gone", moved its socket aside and took
 * over — leaving two processes each believing they held the lock. Being wrong in
 * the conservative direction costs a skipped refresh; being wrong the other way
 * costs mutual exclusion.
 */
function holderIsAlive() {
  return new Promise((resolve) => {
    const sock = net.connect(LOCK);
    let done = false;
    const finish = (alive) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(alive);
    };
    sock.once('connect', () => finish(true));
    sock.once('error', (err) => {
      const definitelyNobody = err.code === 'ECONNREFUSED' || err.code === 'ENOENT';
      finish(!definitelyNobody);
    });
    setTimeout(() => finish(true), 1000).unref();
  });
}

/**
 * Binding is not by itself proof the path still points at us: another process
 * can reclaim and rebind between our unlink and our listen. So connect, and see
 * whether the connection arrives HERE. This is the check that makes the
 * reclamation path safe rather than merely narrow.
 */
function confirmHold(server) {
  return new Promise((resolve) => {
    let ours = false;
    server.on('connection', (sock) => {
      ours = true;
      sock.destroy();
    });
    const sock = net.connect(LOCK);
    const done = () => {
      sock.destroy();
      if (ours) {
        lockServer = server;
        resolve(true);
      } else {
        // NOT server.close(). Node unlinks a Unix socket path when its server
        // closes, and in this branch the path belongs to whoever displaced us —
        // so closing here deletes THEIR socket, which is the same defect the
        // release path had, moved into the failure-cleanup path. Let the process
        // exit free it instead.
        try {
          server.unref();
        } catch {
          /* best effort */
        }
        resolve(false);
      }
    };
    sock.once('connect', () => setTimeout(done, 50));
    sock.once('error', () => setTimeout(done, 50));
  });
}

async function acquireLock() {
  // Re-entrant within a process: we hold the socket until we exit, so asking
  // again is simply true. Without this the second refresh in one process would
  // find its own socket answering and conclude somebody else had it.
  if (lockServer) return true;
  ensureDataDir();
  const first = await tryListen();
  if (first.ok) return confirmHold(first.server);
  if (first.code !== 'EADDRINUSE') return false;
  if (await holderIsAlive()) return false;

  try {
    fs.mkdirSync(RECOVERY_GATE, { mode: 0o700 });
  } catch (err) {
    if (err.code === 'EEXIST') {
      log(`socket recovery is busy or interrupted: ${RECOVERY_GATE}; remove it only after stopping all HUD generators`);
    }
    return false;
  }
  try {
    fs.writeFileSync(`${RECOVERY_GATE}/owner.json`, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
    // A contender may have bound the path while we waited for the recovery gate.
    const retry = await tryListen();
    if (retry.ok) return confirmHold(retry.server);
    if (retry.code !== 'EADDRINUSE' || await holderIsAlive()) return false;
    // Only this gate's owner may remove a dead path. A normal acquirer can win
    // the bind after removal; in that case our bind fails and we stand down.
    fs.rmSync(LOCK, { recursive: true, force: true });
    const second = await tryListen();
    if (!second.ok) return false;
    const held = await confirmHold(second.server);
    if (held) log('reclaimed a socket whose holder is no longer listening');
    return held;
  } finally {
    try {
      fs.rmSync(RECOVERY_GATE, { recursive: true, force: true });
    } catch (err) {
      // Do not turn a successful acquisition into a rejection while its server
      // remains referenced. The caller must still reach its release/finally.
      log(`could not remove recovery gate ${RECOVERY_GATE}: ${err.message}`);
    }
  }
}

/**
 * Frees the lock for THIS process without touching the path.
 *
 * It deliberately does not call `server.close()`. Node unlinks a Unix socket
 * path when its server closes, so closing here would delete whatever is at that
 * path — which, if we have been taken over in the meantime, is the new holder's
 * socket. That is the same check-then-delete race in a different disguise, and
 * it took a review round to surface it.
 *
 * So the lock is process-scoped: `unref()` lets this process exit, the kernel
 * closes the socket, and the leftover file is reclaimed by the next acquirer
 * only after it has proved nobody is listening.
 */
function releaseLock() {
  if (!lockServer) return;
  const server = lockServer;
  // Retain the process-owned server so a later refresh can reuse it.
  try {
    server.unref();
  } catch {
    /* best effort */
  }
}

// ------------------------------------------------------------------- refresh

/**
 * Fetch, learn the scale, append the ledger, write the snapshot.
 *
 * The order matters: resolveBaseline runs BEFORE appendLedger, so the ledger
 * holds only past observations and a top-up is still visible as a step up.
 *
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, snapshot?:object}>}
 */
async function refreshOnce({ force = false, config } = {}) {
  const cfg = config || loadConfig();

  if (!force && throttledFor(cfg) > 0) return { ok: false, skipped: true, reason: 'throttled' };

  if (!(await acquireLock())) return { ok: false, skipped: true, reason: 'locked' };

  try {
    // Re-check after taking the lock: the previous holder may have just
    // finished, and without this the new holder repeats its request.
    if (!force && throttledFor(cfg) > 0) return { ok: false, skipped: true, reason: 'throttled' };

    const balance = await fetchBalance(cfg.balance_timeout_ms);
    if (!balance) {
      // Leave the previous snapshot alone: it keeps its old updated_at, so a
      // brief outage is invisible while a sustained one degrades to "hidden"
      // once claude-hud's freshness window lapses.
      recordAttempt(false);
      return { ok: false, reason: 'fetch-failed' };
    }

    const { baseline, source } = resolveBaseline(balance, cfg, readLedger());
    appendLedger(balance);
    const snapshot = buildSnapshot(balance, cfg, new Date(), baseline, source);
    // Additive: buildSnapshot is untouched and no existing _meta field changes.
    const pi_usage = readPiUsage(PATHS.DATA_DIR);
    if (pi_usage) (snapshot._meta ??= {}).pi_usage = pi_usage;
    writeSnapshot(snapshot);
    recordAttempt(true);
    return { ok: true, snapshot, baseline, source };
  } finally {
    releaseLock();
  }
}

// A process-owned socket alone does not exclude overlapping callers in the same
// process. Queue the entire fetch/baseline/ledger/snapshot transaction.
let refreshQueue = Promise.resolve();
function refresh(options) {
  const result = refreshQueue.then(() => refreshOnce(options));
  refreshQueue = result.catch(() => {});
  return result;
}

// -------------------------------------------------------------------- status

function printStatus() {
  const installed = readJson(`${PATHS.DATA_DIR}/installation.json`, null);
  if (installed?.node) console.log(`installed node: ${installed.node} (${fs.existsSync(installed.node) ? installed.node_version : 'MISSING — re-run installer'})`);
  if (fs.existsSync(RECOVERY_GATE)) console.log(`recovery gate : ${RECOVERY_GATE} (busy or interrupted; see README recovery instructions)`);
  const snap = readJson(PATHS.snapshot, null);
  if (!snap) {
    console.log('no snapshot yet');
    return;
  }
  const scoped = (snap.model_scoped || [])[0] || {};
  const ageS = Math.round((Date.now() - Date.parse(snap.updated_at)) / 1000);
  console.log(`updated_at   : ${snap.updated_at}  (${ageS}s ago)`);
  console.log(`balance_label: ${snap.balance_label}`);
  console.log(`bar          : ${scoped.display_name} ${scoped.utilization}% of ${snap._meta?.baseline}`);
  const a = readAttempt();
  if (a) {
    console.log(`last attempt : ${a.at}  ${a.ok ? 'ok' : `FAILED x${a.failures || 1}`}`);
    const wait = throttledFor(loadConfig());
    console.log(`next allowed : ${wait > 0 ? `in ${Math.round(wait / 1000)}s` : 'now'}`);
  }
}

module.exports = {
  refresh,
  throttledFor,
  readAttempt,
  acquireLock,
  releaseLock,
  ATTEMPT_FILE,
  // Exported so the failure-cleanup path can be tested directly. It is not
  // reachable through acquireLock on demand: it needs us to have bound the path
  // and then to have been displaced, which a test has to arrange by hand.
  __testing: { tryListen, confirmHold, LOCK, RECOVERY_GATE },
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--status')) {
    printStatus();
  } else {
    refresh({ force: args.includes('--force') })
      .then((r) => {
        if (args.includes('--verbose')) {
          if (r.ok) {
            console.log(
              `refreshed: ${r.snapshot.balance_label}  bar=${r.snapshot.model_scoped?.[0]?.utilization}%` +
                `  baseline=${r.baseline?.toFixed(2)} (${r.source})`,
            );
          } else {
            console.log(`no refresh: ${r.reason || 'unknown'}`);
          }
        }
      })
      .catch((err) => log(`generate failed: ${err && err.stack ? err.stack : err}`));
  }
}
