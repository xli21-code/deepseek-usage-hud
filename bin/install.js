#!/usr/bin/env node
'use strict';
// Wire the DeepSeek usage HUD into Claude Code.
//
//   node bin/install.js                       install / repair (idempotent)
//   node bin/install.js --dry-run             show what would change
//   node bin/install.js --config-dir <path>   override the settings directory
//   node bin/install.js --no-patch-main       never touch ~/.claude/settings.json
//
// Three rules this script learned the hard way, from a review that found it
// breaking people's configs:
//
//   1. A re-run must be a no-op. An earlier version destroyed the user's own
//      status line on the second run, because "this command contains our
//      wrapper" was read as "there is nothing to preserve".
//   2. Never write over something we could not read. A corrupt settings.json
//      used to be silently replaced with a fresh object, discarding every
//      setting in it.
//   3. If a precondition fails, stop and exit non-zero. Continuing past a
//      failed clone produced a cheerful "Done" and no working HUD.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveInstallDir, isMainConfigDir, shellQuote } = require('../src/paths');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOME = os.homedir();
const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry-run');
const PATCH_MAIN = !ARGS.includes('--no-patch-main');
const EXPLICIT_DIR = ARGS.includes('--config-dir') ? ARGS[ARGS.indexOf('--config-dir') + 1] : null;

const DATA_DIR = process.env.DEEPSEEK_HUD_DATA_DIR?.trim()
  ? path.resolve(process.env.DEEPSEEK_HUD_DATA_DIR.trim().replace(/^~(?=\/|$)/, HOME))
  : path.join(HOME, '.local', 'share', 'deepseek-hud');
const VENDOR_DIR = path.join(DATA_DIR, 'vendor', 'claude-hud');
const VENDOR_DIST = path.join(VENDOR_DIR, 'dist');
const HUD_CONFIG_DIR = path.join(DATA_DIR, 'claude-hud-config');
const SNAPSHOT = path.join(DATA_DIR, 'usage-snapshot.json');
const HUD_TAG = 'v0.11.2';
const HUD_REPO = 'https://github.com/jarrodwatts/claude-hud.git';

const WRAPPER = path.join(REPO_ROOT, 'src', 'hud-wrapper.js');
const LAUNCHER_SRC = path.join(REPO_ROOT, 'bin', 'claude-ds');
const LAUNCHER_DEST = path.join(HOME, '.local', 'bin', 'claude-ds');

const CONFIG_DIR = resolveInstallDir(EXPLICIT_DIR);
const USING_MAIN_CONFIG = isMainConfigDir(CONFIG_DIR);

const ok = (m) => console.log(`  ok    ${m}`);
const skip = (m) => console.log(`  skip  ${m}`);
const todo = (m) => console.log(`  ${DRY ? 'would' : 'plan '} ${m}`);
const warn = (m) => console.log(`  WARN  ${m}`);

class InstallError extends Error {}

// --------------------------------------------------------------- safe file IO

/**
 * Read JSON, distinguishing "not there" from "there but unreadable".
 * Conflating the two is what let a corrupt settings file be overwritten: the
 * caller saw nothing usable, assumed a fresh install, and wrote a new file.
 */
function readJsonStrict(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'missing' };
    return { state: 'unreadable', detail: err.message };
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { state: 'corrupt', detail: err.message };
  }
  // A settings file whose root is an array or a scalar has no keys to set, so
  // writing to it would silently do nothing while reporting success.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { state: 'corrupt', detail: `root is ${Array.isArray(value) ? 'an array' : typeof value}, not an object` };
  }
  return { state: 'ok', value };
}

function requireReadableJson(file, what) {
  const r = readJsonStrict(file);
  if (r.state === 'ok') return r.value;
  if (r.state === 'missing') return null;
  throw new InstallError(
    `${what} at ${file} is ${r.state} (${r.detail}).\n` +
      '        Refusing to touch it — rewriting would discard whatever is in it.\n' +
      '        Fix or move the file, then re-run.',
  );
}

/** Back up once and never overwrite: a second backup of a file we already
 *  modified is not a backup of the original. */
function backupOnce(file) {
  const bak = `${file}.bak`;
  if (!fs.existsSync(file)) return null;
  if (fs.existsSync(bak)) return bak;
  fs.copyFileSync(file, bak);
  return bak;
}

function writeJsonSafe(file, value) {
  if (DRY) return todo(`write ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bak = backupOnce(file);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return bak;
}

// --------------------------------------------------------------- 1. vendor

/**
 * A pinned tag is not proof. A force-moved tag, a stale clone, or a shallow
 * checkout that landed elsewhere would all leave us writing a config upstream
 * silently ignores — and this has to run on a FRESH clone too, not only on one
 * that was already present.
 */
function vendorIsUsable() {
  try {
    return fs.readFileSync(path.join(VENDOR_DIST, 'external-usage.js'), 'utf8').includes('balanceLabel');
  } catch {
    return false;
  }
}

function stepVendor() {
  console.log(`\n[1/8] claude-hud ${HUD_TAG} -> ${VENDOR_DIR}`);
  if (fs.existsSync(VENDOR_DIST)) {
    if (vendorIsUsable()) return ok('already cloned, and it exposes balance_label');
    warn('cloned, but dist/external-usage.js has no balanceLabel');
    warn(`delete ${VENDOR_DIR} and re-run to fetch ${HUD_TAG} cleanly`);
    throw new InstallError('the vendored claude-hud is not usable');
  }
  if (DRY) return todo(`git clone --depth 1 --branch ${HUD_TAG} ${HUD_REPO}`);

  fs.mkdirSync(path.dirname(VENDOR_DIR), { recursive: true });
  try {
    execFileSync('git', ['clone', '--depth', '1', '--branch', HUD_TAG, HUD_REPO, VENDOR_DIR], { stdio: 'pipe' });
  } catch (err) {
    const first = String(err.message).split('\n')[0];
    throw new InstallError(
      `could not clone claude-hud: ${first}\n` +
        `        Check network access to github.com, or clone it by hand into\n` +
        `        ${VENDOR_DIR} and re-run.`,
    );
  }
  if (!vendorIsUsable()) {
    throw new InstallError(
      `cloned ${HUD_TAG}, but dist/external-usage.js does not expose balanceLabel —\n` +
        '        upstream may have moved or changed that API.',
    );
  }
  ok(`cloned ${HUD_TAG} and verified balance_label`);
}

// --------------------------------------------------- 2. isolated hud config

function hudConfigObject(existing) {
  const c = existing ? JSON.parse(JSON.stringify(existing)) : {};
  c.lineLayout = c.lineLayout || 'expanded';
  c.showSeparators = c.showSeparators ?? false;
  c.display = {
    ...(c.display || {}),
    showModel: true, showContextBar: true, showTools: true, showAgents: true, showTodos: true,
    showProject: true, showConfigCounts: true, showTokenBreakdown: true, showUsage: true,
    showDuration: true, showSessionName: true, usageBarEnabled: true,
    showPromptCache: true, showCacheHitRate: true, showEffortLevel: true,
    showSessionTokens: true, showCompactions: true, showMemoryUsage: false,
    // Claude Code misprices this provider 17-240x; usagePace assumes the quota
    // windows a prepaid account does not have. Both stay off.
    showCost: false, showRoutedCost: false, showDailyCost: false, showWeeklyCost: false,
    usagePace: false, showModelScopedUsage: true,
    externalUsagePath: SNAPSHOT,
    externalUsageFreshnessMs: 600000,
    autoCompactWindow: null,
  };
  // Neutral colours on purpose: the bar means REMAINING, so a high percentage is
  // good news, and upstream would paint it as critical.
  c.colors = {
    context: '#00ff88', usage: '#8be9fd', warning: '#f1fa8c',
    usageWarning: '#8be9fd', critical: '#8be9fd',
    ...(c.colors || {}),
  };
  c.gitStatus = { enabled: true, ...(c.gitStatus || {}) };
  return c;
}

function stepHudConfig() {
  const file = path.join(HUD_CONFIG_DIR, 'plugins', 'claude-hud', 'config.json');
  console.log(`\n[2/8] claude-hud config -> ${file}`);
  console.log('        (private, so this never touches a claude-hud config that');
  console.log('         your Anthropic sessions also read)');
  const existing = requireReadableJson(file, 'the claude-hud config');
  writeJsonSafe(file, hudConfigObject(existing));
  if (!DRY) ok(`externalUsagePath -> ${SNAPSHOT}`);
}

// --------------------------------------------------------- 3. our own config

function stepOurConfig() {
  const file = path.join(CONFIG_DIR, 'deepseek-hud.json');
  console.log(`\n[3/8] project config -> ${file}`);
  const existing = requireReadableJson(file, 'the project config');
  if (existing) return skip('exists, left alone');
  writeJsonSafe(file, {
    baseline_mode: 'auto',
    topup_min_jump: 1,
    usage_max: 200,
    low_balance: 10,
    throttle_seconds: 60,
    balance_timeout_ms: 2500,
    show_today_estimate: false,
    cost_per_mtok: 0.168,
    capture_correction: 1.074,
  });
  if (!DRY) ok('written with defaults (baseline_mode=auto learns your top-up)');
}

// -------------------------------------------------------------- 4. launcher

/** The launcher sources this before it exports the model variables, so anything
 *  here wins over its defaults. Written explicitly rather than left implicit:
 *  the whole model mapping is what keeps a session off an unexpected model, and
 *  a user who cannot see it cannot change it. */
function stepLauncherEnv() {
  const file = path.join(CONFIG_DIR, 'deepseek-launcher.env');
  console.log(`\n[4b/8] model routing -> ${file}`);
  if (fs.existsSync(file)) return skip('exists — edit it to change model routing');
  if (DRY) return todo(`write ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      '# Model routing for this config. bin/claude-ds sources this file BEFORE it',
      '# exports the model variables, so values set here override its defaults.',
      '#',
      '# Every slot is written out on purpose. A slot left to a default somewhere',
      '# else is a slot that can silently resolve to a model you did not choose —',
      '# and Claude Code has no way to tell you, because it does not know these',
      '# model names either.',
      'ANTHROPIC_MODEL=deepseek-flash',
      'ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro',
      'ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash',
      'ANTHROPIC_SMALL_FAST_MODEL=deepseek-flash',
      'CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-pro',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  ok('written with defaults (edit to change which model each slot uses)');
}

function stepLauncher() {
  console.log(`\n[4/8] launcher -> ${LAUNCHER_DEST}`);
  if (!fs.existsSync(LAUNCHER_SRC)) return warn(`missing ${LAUNCHER_SRC}`);
  if (DRY) return todo(`copy ${LAUNCHER_SRC}`);
  fs.mkdirSync(path.dirname(LAUNCHER_DEST), { recursive: true });
  // Substitute the checkout path so the installed copy can ask src/paths.js for
  // the directory instead of carrying its own copy of the rule. Two
  // implementations of one rule drift; see the note in src/paths.js.
  const text = fs.readFileSync(LAUNCHER_SRC, 'utf8').split('@@REPO@@').join(REPO_ROOT);
  fs.writeFileSync(LAUNCHER_DEST, text, { mode: 0o755 });
  fs.chmodSync(LAUNCHER_DEST, 0o755);
  ok('installed');
  const dir = path.dirname(LAUNCHER_DEST);
  if (!(process.env.PATH || '').split(':').includes(dir)) {
    warn(`${dir} is not on your PATH, so \`claude-ds\` will not resolve.`);
    warn('Add to your shell profile:  export PATH="$HOME/.local/bin:$PATH"');
  }
}

// ------------------------------------------------------------------ 5. skill

// The skill is read by an agent that will try to run the paths in it, so it must
// not ship placeholders. `<REPO>` is substituted here.
function stepSkill() {
  const dest = path.join(CONFIG_DIR, 'skills', 'ds-usage', 'SKILL.md');
  const src = path.join(REPO_ROOT, 'skill', 'ds-usage', 'SKILL.md');
  console.log(`\n[5/8] /ds-usage skill -> ${dest}`);
  if (!fs.existsSync(src)) return warn(`missing ${src}`);
  if (DRY) return todo(`copy ${src} (with <REPO> substituted)`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  backupOnce(dest);
  // Two placeholders on purpose: prose wants the bare path, commands want it
  // quoted. Substituting one string into both is how a checkout under a
  // directory with a space in it produced a command that split into two
  // arguments.
  // One pass with a callback. Sequential .split().join() calls rescan the text
  // they just inserted — a checkout whose path contains the literal text
  // "<REPO>" would have its own path expanded a second time, pointing the
  // installed skill at a directory that does not exist.
  const text = fs
    .readFileSync(src, 'utf8')
    .replace(/<REPO_SH>|<REPO>/g, (m) => (m === '<REPO_SH>' ? shellQuote(REPO_ROOT) : REPO_ROOT));
  fs.writeFileSync(dest, text);
  ok('installed — restart the session to pick it up');
}

// ------------------------------------------------------------- 6. statusLine

function stableNodePath() {
  const exec = process.execPath;
  const cellar = exec.match(/^(.*)\/Cellar\/[^/]+\/[^/]+\/bin\/node$/);
  if (cellar) {
    const stable = path.join(cellar[1], 'bin', 'node');
    try {
      if (fs.existsSync(stable)) return stable;
    } catch {
      /* fall through */
    }
  }
  return exec;
}

const NODE = stableNodePath();

/**
 * Marker identifying a branch we added, so a re-run can replace it.
 *
 * It is a shell NO-OP (`:`), not a comment. The first version used `#`, which
 * turned the generated command into `... fi; # deepseek-usage-hud printf
 * ORIGINAL` — everything after the marker became a comment, so the fallback we
 * had just carefully preserved never ran. The bar went blank for every
 * non-DeepSeek session, silently. A test that only asserts a string is still
 * present will not catch that; the tests now execute the command.
 */
const BRANCH_MARKER = ': deepseek-usage-hud ;';

/** POSIX only — `case` and `[ ]`, not `[[ ]]`. The generated command is run by
 *  whatever shell Claude Code uses, which is not necessarily bash or zsh. */
function isDeepSeekBranch() {
  const exec = `exec ${shellQuote(NODE)} ${shellQuote(WRAPPER)}`;
  const byUrl = `case "\${ANTHROPIC_BASE_URL:-}" in *deepseek*) ${exec};; esac`;
  // The config-directory condition is only evidence when the target is a
  // DEDICATED directory. If the target IS the main config then every provider
  // shares that directory, so a user who exports CLAUDE_CONFIG_DIR=$HOME/.claude
  // — which some do — would match it and get the DeepSeek HUD on an Anthropic
  // session, credentials and all. On the main config the base URL is the only
  // honest signal, and if we do not have one we do not take over.
  const byDir = USING_MAIN_CONFIG
    ? ''
    : `; [ "\${CLAUDE_CONFIG_DIR:-}" = ${shellQuote(CONFIG_DIR)} ] && ${exec}`;
  return `${byUrl}${byDir}; ${BRANCH_MARKER} `;
}

function plainCommand() {
  return `${shellQuote(NODE)} ${shellQuote(WRAPPER)}`;
}

/** True only for the exact command this installer writes, in either the current
 *  quoted form or the older unquoted one. Anything else belongs to the user. */
function isOurPlainCommand(text) {
  const t = String(text || '').trim();
  if (!t.endsWith(WRAPPER) && !t.endsWith(`'${WRAPPER}'`)) return false;
  const head = t.slice(0, t.length - (t.endsWith(`'${WRAPPER}'`) ? WRAPPER.length + 2 : WRAPPER.length)).trim();
  // A node path, and nothing else — no `;`, no pipes, no second command.
  return /^\S*(\/|^)node$/.test(head.replace(/^'|'$/g, '')) || /^'[^']*node'$/.test(head);
}

/**
 * Return whatever sits underneath a branch we added, or the text unchanged.
 *
 * Ownership is proven by matching the COMPLETE generated form, not by finding
 * our wrapper and our marker somewhere in the string. Checking two substrings
 * deleted this, which is a perfectly good user command:
 *
 *   printf '<wrapper> : deepseek-usage-hud ; KEEP'; printf AFTER
 *
 * The pattern below still accepts a branch written by an earlier run with a
 * different node path or config directory — those are legitimately ours and
 * must not be stacked on top of — while accepting nothing else.
 */
function stripOurBranch(command) {
  const text = String(command || '');
  const quoted = shellQuote(WRAPPER).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const node = "'[^']*'";
  const dir = "'[^']*'";
  const byUrl = `case "\\$\\{ANTHROPIC_BASE_URL:-\\}" in \\*deepseek\\*\\) exec ${node} ${quoted};; esac`;
  const byDir = `(; \\[ "\\$\\{CLAUDE_CONFIG_DIR:-\\}" = ${dir} \\] && exec ${node} ${quoted})?`;
  const re = new RegExp(`^${byUrl}${byDir}; : deepseek-usage-hud ; `);
  const m = text.match(re);
  return m ? text.slice(m[0].length).trim() : text;
}

/**
 * Idempotent. Strip any branch we added, then decide.
 *
 * A config shared with other providers always gets a branch, even when there is
 * nothing underneath: an unconditional wrapper there would make Anthropic
 * sessions run the DeepSeek HUD, and would have them send Anthropic credentials
 * to DeepSeek's endpoint. When nothing is underneath, the non-DeepSeek path
 * simply produces no output — which is what an absent status line does anyway.
 *
 * A dedicated config has no other provider to protect, so it gets the plain
 * command: no condition that can only ever be true.
 */
function statusLineValue(existing) {
  const current = existing && typeof existing === 'object' ? String(existing.command || '') : '';
  const carry = existing && typeof existing === 'object' ? existing : {};
  const type = carry.type || 'command';

  const underneath = isOurPlainCommand(current) ? '' : stripOurBranch(current);
  if (underneath === current && current.includes(WRAPPER)) {
    // Contains our wrapper but is not a form we recognise. Pre-release formats
    // are not migrated automatically — guessing ownership from two substrings
    // is what deleted a user's command before — so say so instead.
    warn('the existing status line mentions this project but is not a form we');
    warn('recognise; treating it as yours and preserving it. If it is a leftover');
    warn(`from an early build, remove it by hand from ${path.join(CONFIG_DIR, 'settings.json')}.`);
  }
  if (!underneath && !USING_MAIN_CONFIG) return { ...carry, type, command: plainCommand() };
  return { ...carry, type, command: isDeepSeekBranch() + underneath };
}

function stepStatusLine() {
  const file = path.join(CONFIG_DIR, 'settings.json');
  console.log(`\n[6/8] statusLine -> ${file}`);
  const settings = requireReadableJson(file, 'the settings file') || {};
  settings.statusLine = statusLineValue(settings.statusLine);
  const bak = writeJsonSafe(file, settings);
  if (DRY) return;
  ok('points at src/hud-wrapper.js');
  if (bak) console.log(`        backup: ${bak}`);
  if (String(settings.statusLine.command).includes('then exec')) {
    console.log('        branched — your existing status line still runs for');
    console.log('        sessions that are not talking to DeepSeek');
  }
}

// --------------------------------------------- 7. the home-cwd collision

function stepCollision() {
  const mainSettings = path.join(HOME, '.claude', 'settings.json');
  console.log('\n[7/8] project-settings collision check');

  if (path.resolve(mainSettings) === path.resolve(path.join(CONFIG_DIR, 'settings.json'))) {
    return ok('this IS the settings file sessions read — nothing to reconcile');
  }
  if (!fs.existsSync(mainSettings)) return ok(`no ${mainSettings} — nothing to reconcile`);

  const main = requireReadableJson(mainSettings, 'the main settings file');
  if (!main || !main.statusLine) return ok('main config defines no statusLine — no override');

  if (!PATCH_MAIN) {
    warn('the main config defines a statusLine, and it WINS for any session');
    warn('launched from your home directory. The HUD will not appear there.');
    warn('Re-run without --no-patch-main to fix it automatically.');
    return;
  }

  const current = String(main.statusLine.command || '');
  const desired = isDeepSeekBranch() + stripOurBranch(current);
  if (desired === current) return ok('already branches to this HUD, and is current');

  main.statusLine.command = desired;
  const bak = writeJsonSafe(mainSettings, main);
  if (DRY) return;
  console.log('');
  ok(`patched ${mainSettings}`);
  if (bak) console.log(`        backup : ${bak}`);
  console.log('        The original command is preserved verbatim as the fallback,');
  console.log('        so your other sessions keep working unchanged.');
}

// -------------------------------------------------- 8. clean up old layout

function stepCleanup() {
  const stale = path.join(CONFIG_DIR, 'plugins', 'claude-hud', 'config.json');
  console.log(`\n[8/8] stale config -> ${stale}`);
  if (!fs.existsSync(stale)) return ok('none');
  const r = readJsonStrict(stale);
  if (r.state !== 'ok') return ok(`unreadable (${r.state}) — left alone`);
  const feedKeys = ['externalUsagePath', 'externalUsageWritePath', 'externalUsageFreshnessMs'];
  // Ownership, not key names. Another provider's claude-hud config uses the same
  // three keys, and deleting them because the names match would break it.
  if (r.value?.display?.externalUsagePath !== SNAPSHOT) {
    return ok('external usage points elsewhere — belongs to another provider, left alone');
  }
  const present = r.value?.display ? feedKeys.filter((k) => k in r.value.display) : [];
  if (!present.length) return ok('nothing of ours in it');
  if (DRY) return todo(`remove ${present.join(', ')} from display`);
  for (const k of present) delete r.value.display[k];
  writeJsonSafe(stale, r.value);
  ok(`removed ${present.join(', ')} (backup kept)`);
}

// ------------------------------------------------------------------ report

function main() {
  console.log('deepseek-usage-hud installer');
  console.log(`  repo       ${REPO_ROOT}`);
  console.log(`  settings   ${CONFIG_DIR}`);
  console.log(`  data dir   ${DATA_DIR}`);
  console.log(`  hud config ${HUD_CONFIG_DIR}`);
  if (DRY) console.log('  MODE       dry run — nothing will be written');
  console.log('');
  if (USING_MAIN_CONFIG) {
    console.log('  CLAUDE_CONFIG_DIR is not set, so settings go to ~/.claude — what your');
    console.log('  sessions actually read. If that config also serves Anthropic models,');
    console.log('  the status line is branched so only DeepSeek sessions change.');
  } else {
    console.log(`  Writing to ${CONFIG_DIR}. Sessions must be launched with`);
    console.log('  CLAUDE_CONFIG_DIR set to that path — `claude-ds` does it for you.');
  }

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(`\nNode 18+ required (found ${process.versions.node}).`);
    process.exit(1);
  }

  try {
    stepVendor();
    stepHudConfig();
    stepOurConfig();
    stepLauncher();
    stepLauncherEnv();
    stepSkill();
    stepStatusLine();
    stepCollision();
    stepCleanup();
  } catch (err) {
    if (err instanceof InstallError) {
      console.error(`\nStopped: ${err.message}\n`);
      console.error('Nothing further was written. Re-run once the above is resolved.\n');
      process.exit(1);
    }
    throw err;
  }

  console.log('\nDone.\n');
  console.log('  Start a session:   claude-ds');
  console.log('  Check the feed:    node src/generate.js --status');
  console.log('  Full report:       /ds-usage');
  console.log('  Tune the display:  /ds-usage configure');
  console.log('\n  The first reading happens once a session renders a status line, so');
  console.log('  the Usage segment may be blank for the first second.\n');
}

main();
