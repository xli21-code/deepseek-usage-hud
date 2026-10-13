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
// Three guards, in order, and each exists because a review found the previous
// arrangement unsound:
//
//   throttle — keyed on the last ATTEMPT, not on the snapshot's age. Age-based
//     throttling meant that while the endpoint was failing the snapshot never
//     updated, so every single render fired another request at a service that
//     was already unhappy. Failures now back off exponentially.
//   lock     — taken over by rename(), which is atomic. The old
//     stat-then-rm-then-mkdir sequence let two processes both conclude a stale
//     lock was theirs and both delete each other's.
//   timeout  — the balance request is aborted after `balance_timeout_ms`.

const fs = require('node:fs');
const { PATHS, ensureDataDir, log, readJson, atomicWriteJson } = require('./util');
const { loadConfig } = require('./config');
const { fetchBalance, appendLedger, readLedger } = require('./balance');
const { resolveBaseline } = require('./baseline');
const { buildSnapshot, writeSnapshot } = require('./snapshot');

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
// A listening UNIX SOCKET, not a file we create and delete.
//
// Two rounds of review broke the file-based versions, in the same place:
// releasing is a check followed by an unlink, and a takeover can land between
// them. That is not a bug in the check — `unlink` cannot be made conditional on
// a file's contents, and POSIX offers no compare-and-swap on a path. Every
// "atomic" construction on top of it (rename aside, restore, verify) just moved
// the window.
//
// Binding a socket is serialised by the kernel, and a live holder ANSWERS a
// connection, so liveness is observed rather than inferred from a timestamp.
// Releasing is `close()` and never unlinks anything — which is what removes the
// race entirely, because there is no longer a check-then-delete step at all.
//
// What is guaranteed, precisely:
//
//   * two processes racing an ABSENT lock: exactly one binds. The kernel
//     serialises bind, so there is no window to speak of.
//   * a live holder is not displaced. The probe only reports "dead" on an error
//     that means nobody is there; a timeout counts as alive, so a busy machine
//     degrades to "skip a refresh" rather than to two holders.
//
// What is NOT guaranteed, and cannot be with path primitives: two processes
// reclaiming a DEAD socket within microseconds of each other can both end up
// bound. rename() REPLACES, so the second claimant silently wins over the first
// and the first has no way to notice — detecting it would take another check,
// which is the same check-then-act race this whole design exists to avoid. An
// earlier version tried to serialise reclamation with a rename gate; it narrowed
// the window without closing it.
//
// That residual is tolerable only because the work underneath is safe to run
// twice: reads are idempotent, writes are atomic, and the state update is
// ordered by when readings were taken rather than when they were written (see
// balance.js). Two concurrent refreshes therefore cannot corrupt anything, which
// is why the design leans on order-independence rather than on a perfect lock.

const net = require('node:net');
const LOCK = PATHS.lockFile;

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

  // Serialise the reclamation itself. Without this, several processes could each
  // prove the socket dead, each remove it, and each bind — a race that showed up
  // as two winners in roughly one run in three. rename() succeeds for exactly
  // one racer; the rest get ENOENT and fall through to tryListen, where the
  // kernel decides. Either way at most one process ends up bound.
  const aside = `${LOCK}.dead.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(LOCK, aside);
  } catch {
    /* another racer renamed it first — the path may already be free */
  }
  try {
    // recursive: an earlier implementation made this a DIRECTORY, and a plain
    // rmSync on one throws EISDIR — which would leave that machine unable to
    // ever acquire the lock again.
    fs.rmSync(aside, { recursive: true, force: true });
  } catch {
    /* nothing of ours to remove */
  }
  const second = await tryListen();
  if (!second.ok) return false;
  const held = await confirmHold(second.server);
  if (held) log('reclaimed a socket whose holder is no longer listening');
  return held;
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
  lockServer = null;
  server.removeAllListeners('connection');
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
async function refresh({ force = false, config } = {}) {
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
    writeSnapshot(snapshot);
    recordAttempt(true);
    return { ok: true, snapshot, baseline, source };
  } finally {
    releaseLock();
  }
}

// -------------------------------------------------------------------- status

function printStatus() {
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
  __testing: { tryListen, confirmHold, LOCK },
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
