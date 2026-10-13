'use strict';
// Shared plumbing: canonical paths, a size-capped log, and atomic JSON writes.
//
// Every module in this project runs inside a status-line command, so the
// standing rule is: never throw, never block on I/O, never leave a partial file.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();

// The SESSION directory — where this process's own session reads settings, per
// src/paths.js. Not the install-discovery rule: that one searches for an
// existing dedicated install, and using it here would make a hand-run main
// config quietly read a different directory's settings.
const { resolveSessionDir } = require('./paths');
const CONFIG_DIR = resolveSessionDir();

// Overridable so tests (and anyone who wants state elsewhere) never touch the
// real ledger, baseline or snapshot.
const DATA_DIR = process.env.DEEPSEEK_HUD_DATA_DIR?.trim()
  ? path.resolve(process.env.DEEPSEEK_HUD_DATA_DIR.trim().replace(/^~(?=\/|$)/, HOME))
  : path.join(HOME, '.local', 'share', 'deepseek-hud');
const VENDOR_HUD = path.join(DATA_DIR, 'vendor', 'claude-hud', 'dist', 'index.js');

// claude-hud resolves its own config from $CLAUDE_CONFIG_DIR/plugins/claude-hud.
// We hand it a DEDICATED directory instead of the session's, so that:
//   * our display config never leaks into someone's Anthropic HUD, and
//   * the HUD works no matter where the user's Claude Code config lives.
// A `.claude.json` symlink is placed there at runtime so the CLAUDE.md / MCP
// counts still resolve (they are read from that file).
const HUD_CONFIG_DIR = path.join(DATA_DIR, 'claude-hud-config');

const PATHS = {
  CONFIG_DIR,
  DATA_DIR,
  VENDOR_HUD,
  userConfig: path.join(CONFIG_DIR, 'deepseek-hud.json'),
  hudConfig: path.join(HUD_CONFIG_DIR, 'plugins', 'claude-hud', 'config.json'),
  hudConfigDir: HUD_CONFIG_DIR,
  snapshot: path.join(DATA_DIR, 'usage-snapshot.json'),
  lastRender: path.join(DATA_DIR, 'last-render.json'),
  attempt: path.join(DATA_DIR, 'last-attempt.json'),
  baseline: path.join(DATA_DIR, 'baseline.json'),
  ledger: path.join(DATA_DIR, 'balance-ledger.jsonl'),
  // A FILE, not a directory: created with O_EXCL and holding a unique token,
  // which is what lets a release prove the lock is still its own.
  lockFile: path.join(DATA_DIR, 'generator.lock'),
  logFile: path.join(DATA_DIR, 'generator.log'),
};

const LOG_MAX_BYTES = 256 * 1024;

/**
 * Create the data directory if needed, and tighten anything in it that holds
 * account data.
 *
 * Setting mode 0600 only at creation does not repair files created before that
 * was true, and they hold the balance, the ledger and the log. A chmod on every
 * call would be a syscall per render, so this runs once per process — the
 * wrapper, the generator and the report each do their own, which is enough.
 */
let permsChecked = false;
function ensureDataDir() {
  try {
    fs.mkdirSync(PATHS.DATA_DIR, { recursive: true });
  } catch {
    /* best effort */
  }
  if (permsChecked) return;
  permsChecked = true;
  const sensitive = [
    PATHS.snapshot,
    PATHS.ledger,
    PATHS.logFile,
    PATHS.lastRender,
    PATHS.attempt,
    PATHS.baseline,
  ];
  for (const file of sensitive) {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* absent, or not ours to change */
    }
  }
}

function log(msg) {
  try {
    ensureDataDir();
    try {
      if (fs.statSync(PATHS.logFile).size > LOG_MAX_BYTES) {
        fs.renameSync(PATHS.logFile, `${PATHS.logFile}.1`);
      }
      fs.chmodSync(PATHS.logFile, 0o600);
    } catch {
      /* no log yet */
    }
    // Explicit mode: appendFileSync's default honours the umask, which produced
    // a world-readable log full of account data on the first version.
    fs.appendFileSync(PATHS.logFile, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch {
    /* logging must never break the status line */
  }
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write via a temp file in the same directory, then rename. Rename is atomic
// within a filesystem, so a reader either sees the old file or the new one,
// never a half-written one.
function atomicWriteJson(file, value) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'w' });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* not fatal */
  }
}

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

module.exports = { PATHS, HOME, ensureDataDir, log, readJson, atomicWriteJson, mtimeMs };
