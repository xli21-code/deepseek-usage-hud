'use strict';
// node --test test/
//
// The installer is where a review found this project breaking people's configs:
// a re-run that ate their status line, a corrupt settings file silently
// replaced, and a failed clone that still reported success. Those are the
// properties pinned here.
//
// Every case runs bin/install.js as a subprocess against a throwaway config
// directory and data directory, so the developer's real ~/.claude is never in
// scope.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL = path.join(REPO_ROOT, 'bin', 'install.js');

/**
 * A temp world: HOME, config dir, data dir, and a fake claude-hud that claims to
 * support balance_label so the installer does not try to clone.
 *
 * HOME is redirected too, and that is not incidental. The installer writes the
 * launcher into `$HOME/.local/bin/`, so a test that only redirects the config
 * and data directories silently overwrites the developer's real `claude-ds`
 * on every run — which is exactly what an earlier version of this file did.
 */
function makeWorld({ vendorUsable = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshud-install-'));
  const home = path.join(root, 'home');
  const cfg = path.join(root, 'cfg');
  const data = path.join(root, 'data');
  fs.mkdirSync(home, { recursive: true });
  const startedAt = Date.now();
  const dist = path.join(data, 'vendor', 'claude-hud', 'dist');
  fs.mkdirSync(cfg, { recursive: true });
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(
    path.join(dist, 'external-usage.js'),
    vendorUsable ? 'export const x = 1; // balanceLabel\n' : 'export const x = 1;\n',
  );
  fs.writeFileSync(path.join(dist, 'index.js'), 'process.exit(0);\n');
  return { root, home, cfg, data, startedAt, settings: path.join(cfg, 'settings.json'), launcher: path.join(home, '.local', 'bin', 'claude-ds') };
}

/** A synchronous pause. Atomics.wait on a throwaway buffer is the only
 *  non-blocking-the-loop way to sleep in a sync function. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove a temp world, tolerating a writer that has not finished yet.
 *
 * Retried rather than forced, because the goal is to stop the test racing its
 * own side effects — not to hide them. A run of the wrapper in these tests can
 * leave a detached generator writing into the world, and a plain rmSync then
 * fails with ENOTEMPTY, which reads as "the installer is flaky" and sends you
 * looking in the wrong file entirely.
 */
function cleanup(root) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      sleepSync(50);
    }
  }
}

function run(world, extraArgs = []) {
  try {
    const out = execFileSync(process.execPath, [INSTALL, '--no-patch-main', ...extraArgs], {
      env: {
        ...process.env,
        HOME: world.home,
        CLAUDE_CONFIG_DIR: world.cfg,
        DEEPSEEK_HUD_DATA_DIR: world.data,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

const commandOf = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command;

/** What bin/install.js emits to mark a branch as its own. Kept in step with
 *  BRANCH_MARKER there; a mismatch would make these tests pass vacuously. */
const MARKER = ': deepseek-usage-hud ;';

test('installer: running twice does not eat the original status line', () => {
  const w = makeWorld();
  fs.writeFileSync(w.settings, JSON.stringify({ statusLine: { type: 'command', command: 'printf ORIGINAL-HUD' } }));

  assert.strictEqual(run(w).code, 0, 'first install succeeds');
  const first = commandOf(w.settings);
  assert.match(first, /ORIGINAL-HUD/, 'original preserved as the fallback');
  assert.strictEqual(first.split(MARKER).length - 1, 1, 'exactly one branch');

  assert.strictEqual(run(w).code, 0, 're-run succeeds');
  const second = commandOf(w.settings);
  assert.match(second, /ORIGINAL-HUD/, 'original STILL preserved after a re-run');
  assert.strictEqual(second.split(MARKER).length - 1, 1, 'still exactly one branch');
  assert.strictEqual(second, first, 'and the re-run is a no-op');

  // And the behaviour, not only the text: the earlier round kept the original
  // command in the string while a marker commented it out, so it never ran.
  run(w);
  const output = execFileSync('/bin/sh', ['-c', commandOf(w.settings)], {
    encoding: 'utf8',
    env: { ...process.env, ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CONFIG_DIR: '' },
  });
  assert.strictEqual(output.trim(), 'ORIGINAL-HUD', 'the fallback still prints after repeated installs');

  cleanup(w.root);
});

test('installer: the preserved fallback actually RUNS, not just survives in the string', () => {
  // The first version of this fix kept the original command in the string while
  // a `#` marker turned it into a trailing comment, so it never executed and the
  // bar went blank for every non-DeepSeek session. Asserting `includes` passed
  // anyway. This asserts behaviour.
  const w = makeWorld();
  fs.writeFileSync(w.settings, JSON.stringify({ statusLine: { type: 'command', command: 'printf ORIGINAL-HUD' } }));
  run(w);
  const cmd = commandOf(w.settings);

  const nonDeepSeek = execFileSync('/bin/sh', ['-c', cmd], {
    encoding: 'utf8',
    env: { ...process.env, ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CONFIG_DIR: '' },
  });
  assert.match(nonDeepSeek, /ORIGINAL-HUD/, 'the fallback runs for a non-DeepSeek session');

  cleanup(w.root);
});

test('installer: an install with no prior status line gets a plain command', () => {
  const w = makeWorld();
  fs.writeFileSync(w.settings, JSON.stringify({ model: 'haiku' }));
  run(w);
  const cmd = commandOf(w.settings);
  assert.ok(!cmd.includes(MARKER), 'nothing to preserve, so no branch');
  assert.match(cmd, /hud-wrapper\.js/);
  cleanup(w.root);
});

test('installer: our own unmarked command is recognised, not branched', () => {
  // An earlier version wrote the plain command with no marker. Bumping into one
  // of those must not be mistaken for "somebody else's status line" and wrapped
  // in a branch that can only ever be true.
  const w = makeWorld();
  const ours = `/opt/homebrew/bin/node '${path.join(REPO_ROOT, 'src', 'hud-wrapper.js')}'`;
  fs.writeFileSync(w.settings, JSON.stringify({ statusLine: { type: 'command', command: ours } }));
  run(w);
  const cmd = commandOf(w.settings);
  assert.ok(!cmd.includes(MARKER), 'stays plain');
  assert.match(cmd, /hud-wrapper\.js/);
  cleanup(w.root);
});

test('installer: everything it writes lands inside the temp world', () => {
  const w = makeWorld();
  fs.writeFileSync(w.settings, JSON.stringify({}));
  run(w);
  assert.ok(fs.existsSync(w.launcher), 'launcher installed under the fake HOME');
  const realLauncher = path.join(os.homedir(), '.local', 'bin', 'claude-ds');
  const realMtime = fs.existsSync(realLauncher) ? fs.statSync(realLauncher).mtimeMs : null;
  assert.ok(
    realMtime === null || realMtime < w.startedAt,
    'the real launcher must not be touched by a test run',
  );
  cleanup(w.root);
});

test('installer: the main config gets a provider check even with no prior status line', () => {
  // Installing into ~/.claude must not hand an Anthropic session a DeepSeek
  // status line — it would show a cached DeepSeek balance, and could send the
  // Anthropic token to DeepSeek's endpoint. With nothing underneath, the
  // non-DeepSeek path simply prints nothing, which is what an absent status
  // line does anyway.
  const w = makeWorld();
  const mainSettings = path.join(w.home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(mainSettings), { recursive: true });
  fs.writeFileSync(mainSettings, JSON.stringify({ model: 'opus' }));

  try {
    execFileSync(process.execPath, [INSTALL, '--no-patch-main'], {
      env: { ...process.env, HOME: w.home, CLAUDE_CONFIG_DIR: '', DEEPSEEK_HUD_DATA_DIR: w.data },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    /* non-zero is acceptable here; we only care what was written */
  }

  const cmd = JSON.parse(fs.readFileSync(mainSettings, 'utf8')).statusLine?.command || '';
  // Assert this first and separately. It failed once in a dozen loaded runs and
  // the downstream assertions reported "expected '' to not equal ''", which says
  // nothing about why. If the installer ever declines to write here, this is the
  // line that should say so.
  assert.ok(cmd.length > 0, `the installer wrote no statusLine to ${mainSettings}`);
  assert.ok(fs.existsSync(path.join(w.home, '.local', 'bin', 'claude-ds')), 'and it installed the launcher');
  assert.match(cmd, /ANTHROPIC_BASE_URL/, 'a provider check is present');

  // Executing it, not reading it. The earlier version only asserted the string
  // mentioned a base URL, and an implementation that ALSO matched on the config
  // directory passed — while running the DeepSeek wrapper, and with it a balance
  // request, on an Anthropic session that had exported
  // CLAUDE_CONFIG_DIR=$HOME/.claude.
  // A fresh snapshot, so the wrapper does not spawn a detached generator. That
  // generator writes into w.data while the test's own cleanup deletes w.root,
  // and the resulting ENOTEMPTY surfaced as "the installer is flaky" — a wrong
  // trail entirely, since nothing in the installer was involved.
  fs.mkdirSync(w.data, { recursive: true });
  fs.writeFileSync(
    path.join(w.data, 'usage-snapshot.json'),
    JSON.stringify({ updated_at: new Date().toISOString(), balance_label: '¥1.00 CNY' }),
  );

  const baseEnv = { ...process.env, DEEPSEEK_HUD_DATA_DIR: w.data };
  const runCmd = (env) => {
    try {
      return execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', env: { ...baseEnv, ...env } });
    } catch {
      return '<non-zero exit>';
    }
  };
  assert.strictEqual(
    runCmd({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CONFIG_DIR: path.join(w.home, '.claude') }).trim(),
    '',
    'an Anthropic session that sets CLAUDE_CONFIG_DIR to the main config runs nothing',
  );
  assert.strictEqual(
    runCmd({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CONFIG_DIR: '' }).trim(),
    '',
    'nor one that leaves it unset',
  );
  const deepseekRun = runCmd({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', CLAUDE_CONFIG_DIR: '' }).trim();
  assert.notStrictEqual(deepseekRun, '', `but a DeepSeek session does run it. command was: ${cmd}`);
  cleanup(w.root);
});

test('installer: a corrupt settings file is refused, not overwritten', () => {
  const w = makeWorld();
  const corrupt = '{ this is not valid json';
  fs.writeFileSync(w.settings, corrupt);

  const r = run(w);
  assert.notStrictEqual(r.code, 0, 'exits non-zero');
  assert.match(r.out, /corrupt|Refusing/i);
  assert.strictEqual(fs.readFileSync(w.settings, 'utf8'), corrupt, 'file left byte-for-byte');
  assert.ok(!fs.existsSync(`${w.settings}.bak`), 'and not backed up, because it was never touched');

  cleanup(w.root);
});

test('installer: an unusable vendored claude-hud stops the install', () => {
  const w = makeWorld({ vendorUsable: false });
  fs.writeFileSync(w.settings, JSON.stringify({ keep: 'me' }));

  const r = run(w);
  assert.notStrictEqual(r.code, 0, 'exits non-zero rather than reporting Done');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(w.settings, 'utf8')), { keep: 'me' }, 'settings untouched');

  cleanup(w.root);
});

test('installer: a checkout path containing spaces produces a command that RUNS', () => {
  // The previous version of this test inspected the string for quoting and never
  // created a checkout with a space in it — so it would have passed on a command
  // that split into two arguments.
  const w = makeWorld();
  const spaced = path.join(w.root, 'My Projects', 'hud');
  fs.mkdirSync(spaced, { recursive: true });
  for (const d of ['src', 'bin', 'skill']) {
    fs.cpSync(path.join(REPO_ROOT, d), path.join(spaced, d), { recursive: true });
  }
  fs.writeFileSync(w.settings, JSON.stringify({}));

  const out = execFileSync(
    process.execPath,
    [path.join(spaced, 'bin', 'install.js'), '--no-patch-main'],
    {
      env: { ...process.env, HOME: w.home, CLAUDE_CONFIG_DIR: w.cfg, DEEPSEEK_HUD_DATA_DIR: w.data },
      encoding: 'utf8',
    },
  );
  assert.match(out, /Done/, 'installed from the spaced checkout');

  const cmd = commandOf(w.settings);
  assert.match(cmd, /My Projects/, 'the path is in the command');
  // A DeepSeek session must actually start something, which it cannot do if the
  // path was split.
  const result = execFileSync('/bin/sh', ['-c', cmd], {
    encoding: 'utf8',
    env: { ...process.env, ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', CLAUDE_CONFIG_DIR: '' },
  });
  assert.notStrictEqual(result.trim(), '', 'the wrapper resolved through the spaced path');
  cleanup(w.root);
});

test('installer: a second run does not clobber the first backup', () => {
  const w = makeWorld();
  fs.writeFileSync(w.settings, JSON.stringify({ statusLine: { command: 'printf V1' }, keep: 1 }));
  run(w);
  const originalBackup = fs.readFileSync(`${w.settings}.bak`, 'utf8');

  fs.writeFileSync(w.settings, JSON.stringify({ statusLine: { command: 'printf V2' }, keep: 1 }));
  run(w);

  assert.strictEqual(fs.readFileSync(`${w.settings}.bak`, 'utf8'), originalBackup, 'backup is the pre-install file');
  assert.match(originalBackup, /V1/, 'and specifically the first version');

  cleanup(w.root);
});

test('launcher: every model slot is set, and deepseek-launcher.env overrides them', () => {
  // The failure this guards against is silent: a model slot left unset makes
  // Claude Code send the ANTHROPIC model name for that slot, DeepSeek accepts
  // it, and the session runs on a model nobody chose while Claude Code prices it
  // against Anthropic's table. No error surfaces anywhere except the status
  // line, which prints the model the API actually served.
  const w = makeWorld();
  fs.writeFileSync(w.settings, JSON.stringify({}));
  run(w);

  const envFile = path.join(w.cfg, 'deepseek-launcher.env');
  assert.ok(fs.existsSync(envFile), 'the installer writes a model-routing file');

  // Intercept what the launcher would export by shadowing `claude`.
  const fake = path.join(w.root, 'fakebin');
  fs.mkdirSync(fake, { recursive: true });
  const slots = [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
  ];
  fs.writeFileSync(
    path.join(fake, 'claude'),
    `#!/bin/sh\n${slots.map((v) => `echo "${v}=\${${v}:-UNSET}"`).join('\n')}\n`,
  );
  fs.chmodSync(path.join(fake, 'claude'), 0o755);

  const env = {
    ...process.env,
    HOME: w.home,
    CLAUDE_CONFIG_DIR: w.cfg,
    DEEPSEEK_HUD_DATA_DIR: w.data,
    ANTHROPIC_AUTH_TOKEN: 'sk-test',
  };
  // Deliberately clear the slots, to prove the launcher sets them rather than
  // inheriting them from whoever started it.
  for (const v of slots) delete env[v];

  const exported = execFileSync('/bin/sh', [path.join(w.home, '.local', 'bin', 'claude-ds')], {
    encoding: 'utf8',
    env: { ...env, PATH: `${fake}:${process.env.PATH}` },
  });
  for (const v of slots) {
    const line = exported.split('\n').find((l) => l.startsWith(`${v}=`)) || '';
    assert.ok(line && !line.endsWith('UNSET'), `${v} must be set by the launcher`);
  }

  // And the override is honoured.
  fs.writeFileSync(envFile, 'ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-flash\n');
  const after = execFileSync('/bin/sh', [path.join(w.home, '.local', 'bin', 'claude-ds')], {
    encoding: 'utf8',
    env: { ...env, PATH: `${fake}:${process.env.PATH}` },
  });
  assert.match(after, /ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-flash/, 'the env file wins');

  cleanup(w.root);
});
