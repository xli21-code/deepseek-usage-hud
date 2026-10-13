#!/usr/bin/env node
'use strict';
// Status-line entry point for the DeepSeek Claude Code config.
//
// Wired as `statusLine.command` in ~/.config/claude-deepseek/settings.json.
//
// Why this is Node and not a two-line shell script: claude-hud reads the
// status-line payload from stdin, and we want the same payload for ourselves
// (to answer "what does Claude Code actually report for deepseek-flash?").
// A stream cannot be both forwarded and inspected, so we buffer it here and
// hand claude-hud a fresh pipe. Node also gives a genuinely detached spawn for
// the background refresh — `nohup ... &` leaves the child in our process
// group, where a group kill can take it out mid-write.
//
// Contract: never block the render, never leave the bar empty, never throw.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PATHS, ensureDataDir, log } = require('./util');
const { loadConfig, refreshAfterMs } = require('./config');

const HUD_TIMEOUT_MS = 5000;
const STDIN_WAIT_MS = 1500;
/** A status line is a few hundred bytes; anything past this is a runaway. */
const MAX_HUD_OUTPUT_BYTES = 256 * 1024;
/** Ceiling on the whole invocation, including writing the result out. The child
 *  timeout alone is not enough: once the child is gone, a downstream that stops
 *  reading leaves the final write pending and the process alive indefinitely. */
const HARD_DEADLINE_MS = HUD_TIMEOUT_MS + 2000;

const LATEST = path.join(PATHS.DATA_DIR, 'stdin-latest.json');
const SHAPES = path.join(PATHS.DATA_DIR, 'stdin-shapes.jsonl');
const HEARTBEAT = path.join(PATHS.DATA_DIR, 'last-render.json');
const HEARTBEAT_MIN_MS = 10_000;

// mtimeMs is sub-millisecond precise, so `Date.now() - mtimeMs` is routinely a
// small negative number for a file written microseconds ago. Treating "any
// negative age" as "stamped in the future" makes every statistical check fire
// on every render — a refresh spawn per render, a heartbeat write per render,
// and (in generate.js) two racing processes both claiming the same lock.
// Only a skew past this tolerance is a real clock problem.
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

/**
 * Record that the status line ran, at most once every 10s.
 *
 * This exists because "the HUD is missing" has two very different causes that
 * otherwise look identical from the outside: Claude Code never invoked the
 * command (wrong config dir, settings not reloaded, a project-level override)
 * versus it invoked us and we rendered nothing. The stdin capture cannot tell
 * them apart — it only fires on the refresh branch. A heartbeat always answers
 * "has this command run, and when".
 *
 * One stat per render in the common case; a 38-byte write every 10s otherwise.
 */
function heartbeat(payload) {
  let age = null;
  try {
    age = Date.now() - fs.statSync(HEARTBEAT).mtimeMs;
  } catch {
    /* no heartbeat yet */
  }
  if (age !== null && age >= 0 && age < HEARTBEAT_MIN_MS) return;
  try {
    ensureDataDir();
    // `real` records whether this looked like an actual Claude Code render
    // rather than someone piping a fixture in by hand. Synthetic payloads have
    // been mistaken for real ones more than once while building this, so the
    // bar is deliberately high: Claude Code stamps a UUID session id, and a
    // hand-written fixture almost never does. Checking only for the presence of
    // session_id + transcript_path was not enough — a test payload carried both
    // and the report confidently said "✅ running" when nothing was running.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const real = Boolean(
      payload && UUID_RE.test(String(payload.session_id || '')) && payload.transcript_path,
    );
    fs.writeFileSync(
      HEARTBEAT,
      `${JSON.stringify({
        at: new Date().toISOString(),
        pid: process.pid,
        real,
        sessionId: payload?.session_id ?? null,
      })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* never break the bar over bookkeeping */
  }
}

// Derived from `throttle_seconds` in deepseek-hud.json rather than hardcoded,
// so the wrapper and the generator cannot drift apart when the throttle is
// tuned. config.js is a tiny JSON read; the wrapper already stats two files.

/**
 * Capture is SAMPLED, not exhaustive: this only runs on the refresh branch
 * (at most once a minute), not on every render. That is deliberate — an
 * unconditional 2KB write on every render is real churn in a hot path, and the
 * question this data answers ("what does Claude Code actually put in the
 * payload for deepseek-flash?") needs one good sample, not all of them.
 * The cost is that a shape which appears only between refreshes goes
 * unrecorded; the shape log is therefore a lower bound, not a census.
 *
 * A cheap fingerprint of the payload's SHAPE, so the log records distinct
 * kinds of render rather than thousands of near-identical ones. */
function shapeKey(d) {
  const cw = d.context_window || {};
  const cu = cw.current_usage || {};
  return JSON.stringify({
    top: Object.keys(d).sort(),
    cw: Object.keys(cw).sort(),
    cu: cu ? Object.keys(cu).sort() : null,
    modelId: d.model?.id,
    modelName: d.model?.display_name,
    windowSize: cw.context_window_size,
    cost: d.cost ? Object.keys(d.cost).sort() : null,
    rateLimits: d.rate_limits ? Object.keys(d.rate_limits).sort() : null,
    hasSessionName: Boolean(d.session_name),
  });
}

function captureStdin(payload) {
  try {
    ensureDataDir();
    fs.writeFileSync(LATEST, `${JSON.stringify({ at: new Date().toISOString(), payload }, null, 2)}\n`, {
      mode: 0o600,
    });
    let rows = [];
    try {
      rows = fs.readFileSync(SHAPES, 'utf8').split('\n').filter(Boolean);
    } catch {
      /* first capture */
    }
    const last = rows.length ? rows[rows.length - 1] : null;
    let sameShape = false;
    if (last) {
      try {
        sameShape = shapeKey(JSON.parse(last).payload) === shapeKey(payload);
      } catch {
        sameShape = false;
      }
    }
    if (!sameShape) {
      rows.push(JSON.stringify({ at: new Date().toISOString(), payload }));
      fs.writeFileSync(SHAPES, `${rows.slice(-500).join('\n')}\n`, { mode: 0o600 });
    }
  } catch {
    /* observability must never break the bar */
  }
}

function snapshotAgeMs() {
  try {
    return Date.now() - fs.statSync(PATHS.snapshot).mtimeMs;
  } catch {
    return null;
  }
}

function maybeRefresh(rawStdin) {
  const age = snapshotAgeMs();
  const threshold = refreshAfterMs(loadConfig());
  // Fresh means: inside the window, and not stamped implausibly far in the
  // future. A large negative age (real clock skew, not mtime float noise) is
  // treated as stale so the snapshot cannot be pinned as "fresh forever"; the
  // write that follows restamps it with the current clock, so it self-heals.
  if (age !== null && age < threshold && age > -CLOCK_SKEW_TOLERANCE_MS) return;

  let payload = null;
  try {
    payload = JSON.parse(rawStdin);
    captureStdin(payload);
  } catch {
    /* not JSON; still refresh, just without the capture */
  }

  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'generate.js')], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    log(`wrapper: could not spawn generate.js: ${err.message}`);
  }
}

// The reason matters: an earlier version printed "refresh pending" for all
// three failure paths, which was wrong for two of them and pointed debugging
// in the wrong direction.
function fallbackLine(rawStdin, reason) {
  let label = 'DS';
  try {
    const d = JSON.parse(rawStdin);
    label = d.model?.display_name || d.model?.id || 'DS';
  } catch {
    /* keep default */
  }
  return `${label} │ ⚠ ${reason}\n`;
}

// Only one render per invocation. The empty-stdin fallback and the real
// `end` handler can both fire on a slow producer; without this guard each
// would spawn its own claude-hud, and two children writing to the same stdout
// pipe is a corrupted status bar, not a harmless duplicate.
let rendered = false;

/**
 * Write and then exit from the write's own callback. stdout is a PIPE here,
 * where writes are asynchronous — calling process.exit() straight after
 * process.stdout.write() drops the buffered line, which would blank the bar
 * on exactly the failure path the fallback exists to cover.
 */
function finishWith(text) {
  process.stdout.write(text, () => process.exit(0));
}

/**
 * Hand claude-hud a private config directory instead of the session's.
 *
 * claude-hud reads its display config from `$CLAUDE_CONFIG_DIR/plugins/claude-hud/`,
 * so without this our settings would land in — and be read from — whatever
 * config directory the user's session happens to use. Two problems follow: a
 * user whose main `~/.claude` is pointed at DeepSeek would get the balance
 * appended to their Anthropic HUD too, and an install into a directory the
 * session does not read fails silently. A dedicated directory removes both.
 *
 * The one thing that must still come from the session is `.claude.json`, which
 * is where the CLAUDE.md / MCP counts are read from — hence the symlink. Point
 * it at wherever Claude Code would have looked.
 */
function ensureHudConfigDir() {
  try {
    fs.mkdirSync(PATHS.hudConfigDir, { recursive: true });
  } catch {
    return;
  }
  const sessionJson = process.env.CLAUDE_CONFIG_DIR?.trim()
    ? path.join(process.env.CLAUDE_CONFIG_DIR.trim().replace(/^~(?=\/|$)/, os.homedir()), '.claude.json')
    : path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(sessionJson)) return;

  const link = path.join(PATHS.hudConfigDir, '.claude.json');
  try {
    if (fs.readlinkSync(link) === sessionJson) return;
  } catch {
    // Not a symlink, or absent — fall through and (re)create it.
  }
  try {
    fs.rmSync(link, { force: true });
    fs.symlinkSync(sessionJson, link);
  } catch {
    /* best effort: the HUD still renders, minus the config counts */
  }
}

function renderHud(rawStdin) {
  if (rendered) return;
  rendered = true;

  if (!fs.existsSync(PATHS.VENDOR_HUD)) {
    finishWith(fallbackLine(rawStdin, 'claude-hud is not installed'));
    return;
  }
  ensureHudConfigDir();
  const child = spawn(process.execPath, [PATHS.VENDOR_HUD], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, CLAUDE_CONFIG_DIR: PATHS.hudConfigDir },
  });

  // Buffer the child's output rather than letting it write straight through.
  // Piping it straight out made two failure modes indistinguishable from
  // success: a non-zero exit that produced nothing showed an empty bar, and a
  // child that printed and then hung got a fallback line appended after its own
  // output, so the bar carried two contradictory statuses at once.
  // Buffers, not a string. `out.length` counts UTF-16 code units while a chunk
  // carries bytes, so a cap written against the former let a CJK status line
  // reach 2.25x the stated limit.
  const chunks = [];
  let bytes = 0;
  let overflowed = false;
  let settled = false;
  const settle = (reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(bail);
    // hardStop is deliberately NOT cleared here. This is the path that needs it
    // most: `finishWith` writes and then exits from the write callback, so if
    // the downstream has stopped reading, the write never completes and the
    // process would sit here forever. Cancelling the backstop at exactly that
    // moment made the deadline useless.
    if (overflowed) return finishWith(fallbackLine(rawStdin, 'status line produced too much output'));
    // Partial output beats none: a status line that rendered four of five lines
    // before being killed is still worth showing. Decoding whole buffers keeps
    // multi-byte characters intact.
    const out = Buffer.concat(chunks).toString('utf8');
    finishWith(out.trim() ? out : fallbackLine(rawStdin, reason));
  };

  // Not unref'd: a pending stdout write keeps the loop alive, and this is the
  // thing that has to fire in exactly that situation.
  //
  // It goes through settle() rather than exiting directly. Exiting here wrote
  // NOTHING, which made this the one path that could leave the bar completely
  // blank — and it fired under load, where two node startups can exceed the
  // deadline, showing up as a rare empty status line.
  const hardStop = setTimeout(() => {
    log(`wrapper: hard deadline of ${HARD_DEADLINE_MS}ms reached, rendering a fallback`);
    settle('status line took too long');
  }, HARD_DEADLINE_MS);
  // Last resort for the case the deadline itself cannot get past: a downstream
  // that has stopped reading holds the final write open, and a status bar is not
  // worth hanging for.
  const finalStop = setTimeout(() => {
    log(`wrapper: write still pending at ${HARD_DEADLINE_MS + 2000}ms, exiting unlodged`);
    process.exit(0);
  }, HARD_DEADLINE_MS + 2000);
  finalStop.unref();

  const bail = setTimeout(() => {
    log(`wrapper: claude-hud exceeded ${HUD_TIMEOUT_MS}ms, killing`);
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    settle(`status line timed out after ${HUD_TIMEOUT_MS}ms`);
  }, HUD_TIMEOUT_MS);

  child.stdout.on('data', (c) => {
    if (overflowed) return;
    bytes += c.length;
    if (bytes > MAX_HUD_OUTPUT_BYTES) {
      // Drop everything rather than keep a prefix. A truncated stream can end
      // mid-escape-sequence, leaving an unterminated CSI that colours whatever
      // the terminal prints next.
      overflowed = true;
      chunks.length = 0;
      log(`wrapper: claude-hud output exceeded ${MAX_HUD_OUTPUT_BYTES} bytes, discarding`);
      return;
    }
    chunks.push(c);
  });
  child.on('error', (err) => {
    log(`wrapper: claude-hud spawn failed: ${err.message}`);
    settle('status line failed to start');
  });
  child.on('exit', (code) => {
    settle(code === 0 ? 'status line produced no output' : `status line exited with code ${code}`);
  });
  // A child that dies early makes this write fail with EPIPE; unhandled, that
  // would crash the wrapper and leave the bar blank.
  child.stdin.on('error', () => {});
  child.stdin.end(rawStdin);
}

/** One entry point for both paths, so the heartbeat and the refresh fire
 *  whichever way the payload arrived — and exactly once. The timer and the
 *  `end` event can both fire on a slow producer; without this guard the second
 *  one repeats the heartbeat, re-captures stdin and asks for another refresh,
 *  even though `renderHud` would refuse to render twice. */
let inputSettled = false;
function handleInput(raw) {
  if (inputSettled) return;
  inputSettled = true;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* keep null: an unparseable payload still gets a render */
  }
  heartbeat(parsed);
  maybeRefresh(raw);
  renderHud(raw);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
});
process.stdin.on('error', () => {
  // A closed pipe mid-read must not take the whole render down.
  log('wrapper: stdin error, rendering what arrived');
  handleInput(buf);
});

process.stdin.on('end', () => handleInput(buf));

// The timer is unconditional, not gated on an empty buffer. Gating it meant a
// payload that arrived PARTIALLY and then never closed hung the wrapper for as
// long as the harness kept the pipe open — no render, no fallback, no timeout,
// because the child had not been started yet.
setTimeout(() => {
  if (rendered) return;
  log(`wrapper: stdin still open after ${STDIN_WAIT_MS}ms, rendering what arrived`);
  handleInput(buf);
}, STDIN_WAIT_MS).unref();
