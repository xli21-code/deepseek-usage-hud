'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const ollama = require('../src/ollama');

// Payloads copied from live responses (2026-11-02), trimmed to the fields used.
const BALANCE = {
  included: {
    balance_usd: 59.8251,
    allowance_usd: 60,
    period: { from: '2026-11-02T03:19:59Z', until: '2026-12-02T03:19:59Z' },
  },
  purchased: { balance_usd: 0 },
};

const USAGE = {
  range: '24h',
  scope: 'self',
  granularity: 'hour',
  from: '2026-11-01T04:00:00Z',
  until: '2026-11-02T04:13:46Z',
  totals: {
    request_count: 218,
    usage_usd: 0.1749,
    input_tokens: 15523094,
    cached_input_tokens: 14999514,
    output_tokens: 83615,
  },
};

test('ollama: balance keeps the period and treats zero as a real balance', () => {
  const b = ollama.normalizeBalance(BALANCE);
  assert.equal(b.balance_usd, 59.8251);
  assert.equal(b.allowance_usd, 60);
  assert.equal(b.period_until, '2026-12-02T03:19:59Z');

  const empty = ollama.normalizeBalance({ included: { balance_usd: 0, allowance_usd: 0 } });
  assert.equal(empty.balance_usd, 0, 'a drained account is a reading, not a failed fetch');
  assert.equal(empty.allowance_usd, null, 'an allowance of 0 means "no included credits"');
});

test('ollama: a payload without a numeric balance is rejected, not read as zero', () => {
  for (const raw of [null, {}, { included: {} }, { included: { balance_usd: null } }, { included: { balance_usd: '' } }]) {
    assert.equal(ollama.normalizeBalance(raw), null, JSON.stringify(raw));
  }
});

test('ollama: the cache rate divides by input, because cached is a subset of it', () => {
  const u = ollama.normalizeUsage(USAGE);
  assert.equal(u.input_tokens, 15523094);
  assert.equal(u.cached_input_tokens, 14999514);
  // 14,999,514 / 15,523,094. Dividing by input+cached (the pi-usage formula)
  // would report 49.1% for the same numbers.
  assert.equal(u.cache_hit_rate, 0.9663);
  assert.equal(u.usage_usd, 0.1749);
});

test('ollama: a cached count above input is clamped, not allowed to exceed 100%', () => {
  const u = ollama.normalizeUsage({ totals: { input_tokens: 100, cached_input_tokens: 250 } });
  assert.equal(u.cached_input_tokens, 100);
  assert.equal(u.cache_hit_rate, 1);
  assert.equal(ollama.normalizeUsage({ totals: {} }), null, 'no input count, no rate');
});

test('ollama: the key comes from magpie when the env does not set one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-key-'));
  try {
    const file = path.join(dir, 'providers.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        providers: [
          { id: 'deepseek', key: 'not-this-one' },
          { id: 'ollama-cloud', key: '  ollama-fixture  ' },
        ],
      }),
    );
    assert.equal(ollama.readMagpieKey(file), 'ollama-fixture');
    assert.equal(ollama.readMagpieKey(path.join(dir, 'missing.json')), null);
    fs.writeFileSync(file, '{not json');
    assert.equal(ollama.readMagpieKey(file), null, 'a corrupt file is no key, not a throw');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ollama: usage freshness is anchored to when it was fetched', () => {
  const now = Date.parse('2026-11-02T04:00:00Z');
  assert.equal(ollama.usageIsFresh({ fetched_at: '2026-11-02T03:58:00Z' }, now, 300_000), true);
  assert.equal(ollama.usageIsFresh({ fetched_at: '2026-11-02T03:50:00Z' }, now, 300_000), false);
  assert.equal(ollama.usageIsFresh({}, now, 300_000), false);
});

test('generate: ollama rides in the snapshot, reuses its usage, and the report shows it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-ollama-'));
  try {
    const script = `
      const fs=require('node:fs'),path=require('node:path');
      let usageCalls=0;
      global.fetch=async(url)=>{
        const u=String(url);
        if(u.includes('ollama.com/api/usage')){
          usageCalls++;
          return {ok:true,json:async()=>({range:'24h',totals:{request_count:3,usage_usd:0.01,input_tokens:1000,cached_input_tokens:900,output_tokens:50}})};
        }
        if(u.includes('ollama.com/api/balance')){
          return {ok:true,json:async()=>({included:{balance_usd:59.5,allowance_usd:60,period:{from:'2026-11-02T00:00:00Z',until:'2026-12-02T00:00:00Z'}},purchased:{balance_usd:0}})};
        }
        return {ok:true,json:async()=>({balance_infos:[{currency:'CNY',total_balance:'40'}]})};
      };
      const g=require('./src/generate');
      (async()=>{
        await g.refresh({force:true});
        const first=JSON.parse(fs.readFileSync(path.join(process.env.DEEPSEEK_HUD_DATA_DIR,'usage-snapshot.json')));
        await g.refresh({force:true});
        const second=JSON.parse(fs.readFileSync(path.join(process.env.DEEPSEEK_HUD_DATA_DIR,'usage-snapshot.json')));
        console.log(JSON.stringify({
          balance_usd: first._meta.ollama.balance_usd,
          allowance_usd: first._meta.ollama.allowance_usd,
          rate: first._meta.ollama.usage.cache_hit_rate,
          usageCalls,
          reused: second._meta.ollama.usage.fetched_at === first._meta.ollama.usage.fetched_at,
          deepseekIntact: second.balance_label,
        }));
      })().catch(e=>{console.error(e);process.exitCode=1});
    `;
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        HOME: dir,
        CLAUDE_CONFIG_DIR: dir,
        DEEPSEEK_HUD_DATA_DIR: dir,
        ANTHROPIC_AUTH_TOKEN: 'fixture',
        DEEPSEEK_API_KEY: '',
        OLLAMA_API_KEY: 'fixture',
      },
      encoding: 'utf8',
      timeout: 15000,
    });
    const result = JSON.parse(out.trim());
    assert.equal(result.balance_usd, 59.5);
    assert.equal(result.allowance_usd, 60);
    assert.equal(result.rate, 0.9);
    assert.equal(result.usageCalls, 1, 'the second refresh reuses a fresh usage reading');
    assert.equal(result.reused, true);
    assert.equal(result.deepseekIntact, '¥40.00 CNY', 'the primary bar still comes from DeepSeek');

    const report = execFileSync(process.execPath, ['src/report.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: dir, DEEPSEEK_HUD_DATA_DIR: dir },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.match(report, /Ollama Cloud/);
    assert.match(report, /\$59\.5000 \/ \$60\.00/);
    assert.match(report, /1\.0k in \(900 cached, 90\.0%\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
