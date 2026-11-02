'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

test('refresh: overlapping calls in one process serialize the complete state update', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-refresh-'));
  try {
    const script = `
      const fs=require('node:fs'),path=require('node:path');
      const base=require('./src/baseline'),balance=require('./src/balance');
      base.saveState({baseline:100,source:'manual'});
      balance.appendLedger({total:50,currency:'CNY',fetchedAt:new Date(Date.now()-1000).toISOString()});
      let calls=0,active=0,maxActive=0;
      global.fetch=async()=>{
        const n=++calls;maxActive=Math.max(maxActive,++active);
        await new Promise(r=>setTimeout(r,n===1?100:10));active--;
        return {ok:true,json:async()=>({balance_infos:[{currency:'CNY',total_balance:n===1?'49':'40'}]})};
      };
      const g=require('./src/generate');
      Promise.all([g.refresh({force:true}),g.refresh({force:true})]).then(async results=>{
        const third=await g.refresh({force:true});
        const snap=JSON.parse(fs.readFileSync(path.join(process.env.DEEPSEEK_HUD_DATA_DIR,'usage-snapshot.json')));
        console.log(JSON.stringify({maxActive,ok:results.every(r=>r.ok)&&third.ok,baseline:base.loadState().baseline,balance:snap.balance_label}));
      }).catch(e=>{console.error(e);process.exitCode=1});
    `;
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: dir, DEEPSEEK_HUD_DATA_DIR: dir,
        ANTHROPIC_AUTH_TOKEN: 'fixture', DEEPSEEK_API_KEY: '' },
      encoding: 'utf8', timeout: 10000,
    });
    const result = JSON.parse(out.trim());
    assert.equal(result.maxActive, 1, 'only one request/state transaction is active');
    assert.equal(result.ok, true, 'later calls work after a previous release');
    assert.equal(result.baseline, 100);
    assert.equal(result.balance, '¥40.00 CNY', 'snapshot contains the latest completed reading');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refresh: a failed state write does not poison later queued refreshes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-refresh-error-'));
  try {
    const script = `
      global.fetch=async()=>({ok:true,json:async()=>({balance_infos:[{currency:'CNY',total_balance:'40'}]})});
      const snapshot=require('./src/snapshot'),write=snapshot.writeSnapshot;let writes=0;
      snapshot.writeSnapshot=s=>{if(++writes===1)throw Error('fixture write failure');return write(s)};
      const g=require('./src/generate');
      Promise.allSettled([g.refresh({force:true}),g.refresh({force:true})]).then(r=>console.log(JSON.stringify(r.map(x=>x.status))));
    `;
    const out = execFileSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: dir, DEEPSEEK_HUD_DATA_DIR: dir,
        ANTHROPIC_AUTH_TOKEN: 'fixture', DEEPSEEK_API_KEY: '' }, encoding: 'utf8', timeout: 10000 });
    assert.deepEqual(JSON.parse(out.trim()), ['rejected', 'fulfilled']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'usage-snapshot.json'))).balance_label, '¥40.00 CNY');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
