'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

function world(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-wrapper-'));
  const entry = path.join(dir, 'vendor/claude-hud/dist/index.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, source);
  fs.writeFileSync(path.join(dir, 'usage-snapshot.json'), '{}');
  const child = spawn(process.execPath, [path.resolve(__dirname, '../src/hud-wrapper.js')], {
    env: { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: dir, DEEPSEEK_HUD_DATA_DIR: dir,
      ANTHROPIC_AUTH_TOKEN: '', DEEPSEEK_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { dir, child };
}

function output(child) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    child.stdout.on('data', c => out += c);
    child.stderr.on('data', c => err += c);
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)));
  });
}

test('wrapper: a slow complete payload renders once with the actual model', { timeout: 10000 }, async () => {
  const w = world("let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(JSON.parse(s).model.id));");
  try {
    const result = output(w.child);
    w.child.stdin.write('{"model":');
    await new Promise(r => setTimeout(r, 1700));
    w.child.stdin.end('{"id":"slow-model"}}');
    assert.equal(await result, 'slow-model\n');
  } finally { w.child.kill(); fs.rmSync(w.dir, { recursive: true, force: true }); }
});

test('wrapper: an incomplete input times out without fake heartbeat or refresh', { timeout: 10000 }, async () => {
  const w = world("console.log('SHOULD-NOT-RENDER')");
  try {
    const result = output(w.child);
    w.child.stdin.write('{"model":');
    assert.match(await result, /input did not finish/);
    assert.equal(fs.existsSync(path.join(w.dir, 'last-render.json')), false);
    assert.equal(fs.existsSync(path.join(w.dir, 'last-attempt.json')), false);
  } finally { w.child.kill(); fs.rmSync(w.dir, { recursive: true, force: true }); }
});

test('wrapper: output overflow renders a clean fallback without partial ANSI', async () => {
  const w = world("require('node:fs').writeSync(1,'界'.repeat(300000)+'\\x1b[')");
  try {
    const result = output(w.child); w.child.stdin.end('{}');
    const out = await result;
    assert.match(out, /too much output/);
    assert.ok(Buffer.byteLength(out) < 1024);
    assert.ok(!out.includes('\x1b'));
  } finally { w.child.kill(); fs.rmSync(w.dir, { recursive: true, force: true }); }
});

test('wrapper: complete JSON can render without producer EOF', { timeout: 10000 }, async () => {
  const w = world("let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(JSON.parse(s).model.id));");
  try {
    const result = output(w.child); w.child.stdin.write('{"model":{"id":"open-pipe"}}');
    assert.equal(await result, 'open-pipe\n');
  } finally { w.child.kill(); fs.rmSync(w.dir, { recursive: true, force: true }); }
});

test('wrapper: invalid documents produce diagnostics without session side effects', async () => {
  for (const raw of ['not-json', 'null', '[]']) {
    const w = world("console.log('SHOULD-NOT-RENDER')");
    try {
      const result = output(w.child); w.child.stdin.end(raw);
      assert.match(await result, /input (is not valid JSON|must be an object)/);
      assert.equal(fs.existsSync(path.join(w.dir, 'last-render.json')), false);
    } finally { w.child.kill(); fs.rmSync(w.dir, { recursive: true, force: true }); }
  }
});

test('wrapper: input grace and a hanging HUD share the invocation deadline', { timeout: 15000 }, async () => {
  const w = world("setInterval(()=>{},1000)");
  try {
    const result = output(w.child); w.child.stdin.write('{}');
    assert.match(await result, /status line took too long/);
  } finally { w.child.kill(); fs.rmSync(w.dir, { recursive: true, force: true }); }
});

test('wrapper: a blocked stdout consumer cannot keep the process alive', { timeout: 20000 }, async () => {
  const w = world("require('node:fs').writeSync(1,'x'.repeat(240000))");
  try {
    w.child.stderr.resume(); w.child.stdin.end('{}');
    const code = await new Promise((resolve, reject) => {
      w.child.once('error', reject); w.child.once('exit', resolve);
    });
    assert.equal(code, 0);
    w.child.stdout.resume();
  } finally { w.child.kill(); fs.rmSync(w.dir, { recursive: true, force: true }); }
});
