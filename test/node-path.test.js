'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { stableNodePath } = require('../src/node-path');
const { shellQuote } = require('../src/paths');

test('node: keg-only Homebrew uses its formula link rather than another Node', () => {
  assert.equal(stableNodePath({ execPath: '/brew/Cellar/node@22/22.0/bin/node', env: {},
    executable: p => ['/brew/bin/node', '/brew/opt/node@22/bin/node'].includes(p) }), '/brew/opt/node@22/bin/node');
});

test('node: manager shims and nvm current are preserved when available', () => {
  const home = '/example';
  for (const [execPath, expected] of [
    ['/example/.nvm/versions/node/v22/bin/node', '/example/.nvm/current/bin/node'],
    ['/example/.asdf/installs/nodejs/22/bin/node', '/example/.asdf/shims/node'],
  ]) assert.equal(stableNodePath({ execPath, home, env: {}, executable: p => p === expected }), expected);
});

test('node: a custom NVM_DIR retains its current link', () => {
  assert.equal(stableNodePath({ execPath: '/opt/nvm/versions/node/v22/bin/node', env: { NVM_DIR: '/opt/nvm' },
    executable: p => p === '/opt/nvm/current/bin/node' }), '/opt/nvm/current/bin/node');
});

test('installer: a configured stable Node survives replacement of its version directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-node-'));
  try {
    const cfg = path.join(root, 'cfg'), data = path.join(root, 'data');
    const dist = path.join(data, 'vendor/claude-hud/dist');
    fs.mkdirSync(cfg); fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'external-usage.js'), '// balanceLabel');
    fs.writeFileSync(path.join(dist, 'index.js'), "process.stdin.resume();process.stdin.on('end',()=>console.log('STABLE-NODE-HUD'))");
    fs.writeFileSync(path.join(data, 'usage-snapshot.json'), '{}');
    const old = path.join(root, 'node-old'), next = path.join(root, 'node-new'), stable = path.join(root, 'node-stable');
    for (const p of [old, next]) fs.writeFileSync(p, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o755 });
    fs.symlinkSync(old, stable);
    const env = { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: cfg, DEEPSEEK_HUD_DATA_DIR: data,
      DEEPSEEK_HUD_NODE: stable, ANTHROPIC_AUTH_TOKEN: '', DEEPSEEK_API_KEY: '' };
    execFileSync(process.execPath, ['bin/install.js', '--no-patch-main'], { cwd: path.resolve(__dirname, '..'), env, stdio: 'pipe' });
    const firstCommand = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'))).statusLine.command;
    execFileSync(process.execPath, ['bin/install.js', '--no-patch-main'], { cwd: path.resolve(__dirname, '..'), env, stdio: 'pipe' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'))).statusLine.command, firstCommand, 'custom interpreter reinstalls are idempotent');
    fs.unlinkSync(stable); fs.symlinkSync(next, stable); fs.unlinkSync(old);
    const command = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'))).statusLine.command;
    const out = execFileSync('/bin/sh', ['-c', command], { env, input: '{}', encoding: 'utf8' });
    assert.equal(out, 'STABLE-NODE-HUD\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'installation.json'))).node, stable);
    const replacement = path.join(root, 'another-stable-interpreter'); fs.symlinkSync(next, replacement);
    execFileSync(process.execPath, ['bin/install.js', '--no-patch-main'], { cwd: path.resolve(__dirname, '..'),
      env: { ...env, DEEPSEEK_HUD_NODE: replacement }, stdio: 'pipe' });
    const changed = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'))).statusLine.command;
    assert.ok(changed.startsWith(shellQuote(replacement)));
    assert.ok(!changed.includes('deepseek-usage-hud ;'), 'the old custom interpreter is recognized, not retained as a fallback');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installer: an invalid Node override stops before changing settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-node-bad-'));
  try {
    const settings = path.join(root, 'settings.json'); fs.writeFileSync(settings, '{"keep":true}');
    const r = spawnSync(process.execPath, ['bin/install.js'], { cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: root, DEEPSEEK_HUD_DATA_DIR: path.join(root, 'data'), DEEPSEEK_HUD_NODE: '/missing/node' } });
    assert.notEqual(r.status, 0);
    assert.equal(fs.readFileSync(settings, 'utf8'), '{"keep":true}');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
