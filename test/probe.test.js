'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const REPO = path.resolve(__dirname, '..');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'cfg'), data = path.join(dir, 'data');
  const agents = path.join(cfg, 'projects/p/session/subagents'); fs.mkdirSync(agents, { recursive: true });
  const usage = { cache_read_input_tokens: 1000000, input_tokens: 100000, cache_creation_input_tokens: 200000, output_tokens: 10000 };
  const row = (id, timestamp, model, u = usage) => ({ type: 'assistant', uuid: `${id}-${Math.random()}`, timestamp, message: { id, model, usage: u } });
  const a = row('a', '2026-10-12T01:30:00Z', 'deepseek-flash');
  const b = row('b', '2026-10-12T12:00:00Z', 'deepseek-flash');
  const c = row('c', '2026-10-11T01:30:00Z', 'deepseek-v4-pro');
  const d = row('d', '2026-10-12T06:30:00Z', 'deepseek-v4-pro');
  fs.writeFileSync(path.join(cfg, 'projects/p/main.jsonl'), [
    { ...a, message: { ...a.message, usage: undefined } }, a,
    { ...a, uuid: 'another-block' }, b, c,
  ].map(x => JSON.stringify(x)).join('\n'));
  fs.writeFileSync(path.join(agents, 'agent-fixture.jsonl'), [d, a].map(x => JSON.stringify(x)).join('\n'));
  const env = { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: cfg, DEEPSEEK_HUD_DATA_DIR: data,
    ANTHROPIC_AUTH_TOKEN: '', DEEPSEEK_API_KEY: '' };
  const run = (tool, args = [], input) => spawnSync(process.execPath, [`probe/${tool}.js`, ...args], {
    cwd: REPO, env, input, encoding: 'utf8', timeout: 10000,
  });
  return { dir, cfg, data, env, run };
}

test('probe: accounting deduplicates usable responses across blocks and subagents', t => {
  const { run } = fixture(t); const r = run('spend-report');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /4 billable \| 2 duplicate block-records/);
  // Independent fixture totals: flash peak .108, flash off .054,
  // pro weekend .2398, pro peak .4796. All-miss: .402+.201+.8778+1.7556.
  assert.match(r.stdout, /TOTAL, cache-hit billing\s+: 0\.8814/);
  assert.match(r.stdout, /TOTAL, all-input-as-miss\s+: 3\.2364/);
});

test('probe: calibration and zero-lag scan agree with the independent cost fixture', t => {
  const { run } = fixture(t);
  const args = ['2026-10-11T00:00:00Z', '2026-10-13T00:00:00Z', '0.8814'];
  const c = run('calibrate', args), lag = run('lag-scan', args);
  assert.equal(c.status, 0, c.stderr); assert.equal(lag.status, 0, lag.stderr);
  assert.match(c.stdout, /messages\s+: 4 billable/);
  assert.match(c.stdout, /cost \(cache-hit pricing\) : 0\.881400/);
  assert.match(c.stdout, /implied factor, cache-hit : 1\.000/);
  assert.match(c.stdout, /implied factor, all-miss\s+: 0\.272/);
  const lines = lag.stdout.split('\n').filter(x => /^\s+-?\d+\s/.test(x));
  assert.equal(lines.length, 36);
  assert.match(lines.find(x => /^\s+0\s/.test(x)), /\s4\s+0\.88140\s+1\.00\s+CNY\s+3\.23640\s+0\.27/);
});

test('probe: missing transcript trees and missing arguments fail visibly', t => {
  const f = fixture(t); fs.rmSync(path.join(f.cfg, 'projects'), { recursive: true });
  for (const tool of ['calibrate', 'lag-scan']) {
    const r = f.run(tool, ['2026-10-11', '2026-10-13', '1']);
    assert.equal(r.status, 1); assert.match(r.stderr, /no transcript tree/);
    assert.equal(f.run(tool).status, 2);
    for (const args of [['bad-date', '2026-10-13', '1'], ['2026-10-13', '2026-10-11', '1'], ['2026-10-11', '2026-10-13', '-1']]) {
      const invalid = f.run(tool, args);
      assert.equal(invalid.status, 2); assert.match(invalid.stderr, /bad arguments/);
    }
  }
});

test('probe: balance sampling uses a separate private ledger without storing credentials', t => {
  const f = fixture(t); fs.mkdirSync(f.data); const production = path.join(f.data, 'balance-ledger.jsonl');
  fs.writeFileSync(production, 'production-sentinel');
  const script = `global.fetch=async(url,options)=>{
    if(url!=='https://api.deepseek.com/user/balance'||options.headers.Authorization!=='Bearer fixture-only-key')throw Error('wrong request');
    return {ok:true,json:async()=>({is_available:true,balance_infos:[{currency:'USD',total_balance:'40.12',granted_balance:'0',topped_up_balance:'40.12'}]})};
  };require('./probe/balance-sample.js');`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: REPO,
    env: { ...f.env, ANTHROPIC_AUTH_TOKEN: 'fixture-only-key' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(f.data, 'balance-samples.jsonl'), text = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(text).total_balance, '40.12');
  assert.ok(!text.includes('fixture-only-key'));
  assert.equal(fs.readFileSync(production, 'utf8'), 'production-sentinel');
  fs.appendFileSync(file, '\n{"partial":');
  const show = f.run('balance-sample', ['--show']);
  assert.equal(show.status, 0); assert.match(show.stdout, /USD 40\.12/); assert.match(show.stderr, /skipping unreadable/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('probe: stdin capture repairs old permissions and avoids duplicate shapes', t => {
  const f = fixture(t); fs.mkdirSync(f.data);
  for (const name of ['stdin-latest.json', 'stdin-shapes.jsonl']) fs.writeFileSync(path.join(f.data, name), '', { mode: 0o644 });
  const payload = { model: { id: 'fixture-model' }, context_window: { context_window_size: 1000000, used_percentage: 25 } };
  for (let i = 0; i < 2; i++) assert.equal(f.run('stdin-probe', [], JSON.stringify(payload)).status, 0);
  const shapes = fs.readFileSync(path.join(f.data, 'stdin-shapes.jsonl'), 'utf8').trim().split('\n');
  assert.equal(shapes.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, 'stdin-latest.json'))).payload.model.id, 'fixture-model');
  for (const name of ['stdin-latest.json', 'stdin-shapes.jsonl']) assert.equal(fs.statSync(path.join(f.data, name)).mode & 0o777, 0o600);
});
