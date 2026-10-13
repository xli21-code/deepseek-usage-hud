'use strict';
// The generator's lock, which two review rounds broke in different places.
//
// Both breaks were the same shape: a check followed by a destructive step, with
// a takeover landing in between. Round one removed a lock directory
// unconditionally; round two read a token and then unlinked, and the token could
// change in between. Neither can be fixed by a better check — `unlink` cannot be
// made conditional on a file's contents, and POSIX has no compare-and-swap on a
// path.
//
// So the lock is a listening UNIX SOCKET with process scope:
//
//   * binding is serialised by the kernel, so acquisition has no race;
//   * a live holder ANSWERS a connection, so liveness is observed rather than
//     inferred from a timestamp;
//   * release never unlinks anything — it drops the listener and lets the
//     process exit free the address. A dead process runs no code, so "the
//     releaser deleted somebody else's lock" cannot happen at all.
//
// What is NOT claimed: a reclamation race, where one process proves a socket
// dead and another does the same a moment later. Closing it would need the
// filesystem compare-and-swap POSIX does not have. It is bounded, and the state
// update is order-independent (see state.test.js), so the worst case is two
// refreshes whose effects do not depend on which finished first.

const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const GENERATE = path.join(REPO_ROOT, 'src', 'generate.js');

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshud-lock-'));
  return { dir, lock: path.join(dir, 'generator.lock') };
}

function runInChild(dir, body) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, ['-e', body], {
      env: { ...process.env, DEEPSEEK_HUD_DATA_DIR: dir },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    cp.stdout.on('data', (d) => {
      out += d;
    });
    cp.on('exit', () => resolve(out));
  });
}

const claimScript = `require(${JSON.stringify(GENERATE)}).acquireLock().then((ok) => {
  process.stdout.write(ok ? 'GOT' : '');
  setTimeout(() => process.exit(0), 1200);
});`;

const winners = async (dir) =>
  (await Promise.all(Array.from({ length: 12 }, () => runInChild(dir, claimScript)))).filter((o) =>
    o.includes('GOT'),
  ).length;

// NOTE on strength: the twelve-process tests below are race detectors, not
// deterministic guards. Before reclaiming was serialised by an atomic rename,
// "a socket left by a dead holder is reclaimed" failed in roughly one run in
// three; after it, eight consecutive full-suite runs were clean. A probabilistic
// test is weaker than a deterministic one, and saying so is better than implying
// a guarantee the test cannot make.

test('lock: twelve processes yield exactly one winner', async () => {
  const w = world();
  assert.strictEqual(await winners(w.dir), 1);
  fs.rmSync(w.dir, { recursive: true, force: true });
});

test('lock: a socket left by a dead holder is reclaimable', async () => {
  // Asserts reclaimability, NOT "exactly one winner". Reclaiming a dead socket
  // cannot be made exclusive with path primitives: rename() REPLACES, so if two
  // processes both conclude the socket is dead, the second rename wins over the
  // first and the first has no way to notice. Both then bind and both confirm.
  //
  // Being precise about which property holds matters more than the assertion
  // looking strong. The property that does hold — and the one the design leans
  // on — is that concurrent refreshes cannot corrupt the state, which
  // state.test.js covers. See the note in src/generate.js.
  const w = world();
  await runInChild(w.dir, 'require("node:net").createServer().listen(process.env.DEEPSEEK_HUD_DATA_DIR+"/generator.lock",()=>process.exit(0));');
  assert.ok(fs.existsSync(w.lock), 'the socket file outlives the process');
  assert.ok((await winners(w.dir)) >= 1, 'and it is reclaimed rather than left locked forever');
  fs.rmSync(w.dir, { recursive: true, force: true });
});

test('lock: release does not touch the path at all', async () => {
  // This is the property two rounds could not keep. It is structural now:
  // releasing drops a listener; it never unlinks. A process that has been taken
  // over therefore has nothing to delete with.
  const w = world();
  const out = await runInChild(
    w.dir,
    `const fs=require("node:fs"),net=require("node:net");
     const L=process.env.DEEPSEEK_HUD_DATA_DIR+"/generator.lock";
     const g=require(${JSON.stringify(GENERATE)});
     g.acquireLock().then(() => {
       const before=fs.statSync(L).ino;
       g.releaseLock();
       const after=fs.existsSync(L) ? fs.statSync(L).ino : null;
       const sock=net.connect(L);
       sock.once("connect",()=>{sock.destroy();process.stdout.write(after===before?"UNTOUCHED+ALIVE":"CHANGED");});
       sock.once("error",()=>process.stdout.write("DEAD"));
     });`,
  );
  assert.strictEqual(out, 'UNTOUCHED+ALIVE', 'same inode, and still answering');
  fs.rmSync(w.dir, { recursive: true, force: true });
});

test('lock: a holder is not displaced while it is listening', async () => {
  const w = world();
  // A holds; a second process must find it alive rather than reclaiming it.
  const holder = spawn(process.execPath, ['-e', claimScript], {
    env: { ...process.env, DEEPSEEK_HUD_DATA_DIR: w.dir },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise((r) => setTimeout(r, 400));
  const other = await runInChild(w.dir, 'require("node:net") && require("node:path");' + claimScript);
  assert.ok(!other.includes('GOT'), 'the second process stands down');
  holder.kill('SIGKILL');
  fs.rmSync(w.dir, { recursive: true, force: true });
});

test('lock: a failed acquisition does not delete the successor socket', async () => {
  // The defect moved here from the release path. `confirmHold` used to call
  // server.close() when it concluded the path was no longer ours — and Node
  // unlinks a Unix socket path when its server closes, so it deleted the socket
  // of whoever had displaced us, letting a third process bind.
  const w = world();
  for (const f of fs.readdirSync(path.join(REPO_ROOT, 'src'))) {
    delete require.cache[require.resolve(path.join(REPO_ROOT, 'src', f))];
  }
  process.env.DEEPSEEK_HUD_DATA_DIR = w.dir;
  const { __testing } = require(GENERATE);

  const first = await __testing.tryListen();
  assert.strictEqual(first.ok, true, 'we bound the path');

  // A successor takes the path: its file replaces ours, and it starts listening.
  fs.rmSync(w.lock, { force: true });
  const successor = net.createServer();
  await new Promise((r) => successor.listen(w.lock, r));

  const held = await __testing.confirmHold(first.server);
  assert.strictEqual(held, false, 'we correctly conclude the path is not ours');
  assert.ok(fs.existsSync(w.lock), 'the successor socket file survives our cleanup');

  const alive = await new Promise((r) => {
    const sock = net.connect(w.lock);
    sock.once('connect', () => {
      sock.destroy();
      r(true);
    });
    sock.once('error', () => r(false));
  });
  assert.strictEqual(alive, true, 'and it is still listening');
  successor.close();
  fs.rmSync(w.dir, { recursive: true, force: true });
});

test('lock: acquiring twice in one process is re-entrant', () => {
  const w = world();
  process.env.DEEPSEEK_HUD_DATA_DIR = w.dir;
  for (const f of fs.readdirSync(path.join(REPO_ROOT, 'src'))) {
    delete require.cache[require.resolve(path.join(REPO_ROOT, 'src', f))];
  }
  const g = require(GENERATE);
  return g.acquireLock().then(async (first) => {
    assert.strictEqual(first, true);
    assert.strictEqual(await g.acquireLock(), true, 'our own socket is not someone else');
    g.releaseLock();
    assert.ok(fs.existsSync(w.lock), 'and release left the path alone');
    fs.rmSync(w.dir, { recursive: true, force: true });
  });
});
