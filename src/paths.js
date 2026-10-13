'use strict';
// Where things live, resolved by ONE rule.
//
// The installer and the launcher must agree on which config directory a session
// reads, or the installer writes settings a session never opens. That failure is
// silent — no error, just no HUD — so the rule is defined once here and
// mirrored verbatim in bin/claude-ds (a shell script that cannot import this).
//
//   CLAUDE_CONFIG_DIR set                -> use it (the user has chosen)
//   else a dedicated dir has settings    -> use it (a previous install put it there)
//   else                                 -> ~/.claude (what Claude Code itself uses)
//
// "Has settings" means a settings.json is present, not merely that the directory
// exists: a leftover empty directory must not capture a fresh install, and the
// launcher (bin/claude-ds) applies this same test in shell.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const DEDICATED_DIR = path.join(HOME, '.config', 'claude-deepseek');
const MAIN_DIR = path.join(HOME, '.claude');

const expand = (p) => path.resolve(String(p).trim().replace(/^~(?=\/|$)/, HOME));

/**
 * Where THIS process's session reads settings from — a question about the
 * environment, not a search. Claude Code resolves it as $CLAUDE_CONFIG_DIR when
 * set, otherwise ~/.claude, and nothing else is knowable from inside.
 *
 * Distinct from resolveInstallDir on purpose. Conflating the two looked like
 * unification and was a bug: a user running their MAIN config by hand, with no
 * CLAUDE_CONFIG_DIR, would have had the runtime quietly switch to a dedicated
 * directory that happened to exist on the machine — reading someone else's
 * balance scale.
 */
function resolveSessionDir() {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR?.trim();
  return fromEnv ? expand(fromEnv) : MAIN_DIR;
}

/**
 * Where a NEW install should write, and which directory a launcher should point
 * a session at. This one does search: an explicit choice wins, then an existing
 * dedicated install, then the main config.
 */
function resolveInstallDir(explicit) {
  if (explicit) return expand(explicit);
  const fromEnv = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (fromEnv) return expand(fromEnv);
  try {
    if (fs.statSync(path.join(DEDICATED_DIR, 'settings.json')).isFile()) return DEDICATED_DIR;
  } catch {
    /* not there */
  }
  return MAIN_DIR;
}

/** True when this directory is the user's main Claude Code config, i.e. not a
 *  DeepSeek-only directory. Installs there must not assume every session is
 *  talking to DeepSeek, so the status line gets branched rather than replaced. */
function isMainConfigDir(dir) {
  return path.resolve(dir) === MAIN_DIR;
}

/** Shell-quote a single argument. The status line is a shell command string, and
 *  a repo checked out under "~/My Projects/" must not break it. */
function shellQuote(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

// A CLI so bin/claude-ds can ask rather than reimplement. Two implementations of
// one rule drift, and the symptom of drift here is a session reading a config
// directory nobody wrote to — silent, again.
if (require.main === module && process.argv.includes('--print')) {
  process.stdout.write(resolveInstallDir());
}

module.exports = {
  resolveSessionDir,
  resolveInstallDir,
  isMainConfigDir,
  shellQuote,
  HOME,
  DEDICATED_DIR,
  MAIN_DIR,
};
