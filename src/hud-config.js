#!/usr/bin/env node
'use strict';
// Read and write the two config files the HUD depends on, without ever
// hand-editing JSON.
//
//   node hud-config.js list                 current values + every option
//   node hud-config.js options              just the option catalogue
//   node hud-config.js set showTools=false usage_max=150
//   node hud-config.js cat                  the raw files
//
// Two files, deliberately kept separate:
//
//   claude-hud.json  (display.*)  what upstream renders — 67 keys, we expose
//                                 the ones a person would actually change
//   deepseek-hud.json             what we feed it — balance scale, warning
//                                 line, refresh cadence
//
// Writes are validated against a catalogue and go through a backup, because
// the failure mode of a typo here is a silently blank status bar: upstream
// reverts invalid values to defaults without saying so, and an invalid
// settings.json disables ALL settings from that file.

const fs = require('node:fs');
const path = require('node:path');
const { PATHS, readJson, atomicWriteJson } = require('./util');

// kind: 'bool' | 'string' | 'int' | 'enum' | 'float'
// scope: 'hud' (claude-hud.json) | 'ours' (deepseek-hud.json)
const CATALOGUE = [
  // ---- layout ----
  { key: 'lineLayout', scope: 'hud', kind: 'enum', values: ['expanded', 'compact'], def: 'expanded', desc: 'multi-line block vs single line' },
  { key: 'showSeparators', scope: 'hud', kind: 'bool', def: false, desc: 'separator between elements' },
  { key: 'language', scope: 'hud', kind: 'enum', values: ['en', 'zh-Hans', 'zh-Hant'], def: 'en', desc: 'label language' },

  // ---- first line ----
  { key: 'display.showModel', scope: 'hud', kind: 'bool', def: true, desc: 'model name' },
  { key: 'display.showEffortLevel', scope: 'hud', kind: 'bool', def: false, desc: 'effort icon next to the model' },
  { key: 'display.showProject', scope: 'hud', kind: 'bool', def: true, desc: 'project / directory' },
  { key: 'display.showSessionName', scope: 'hud', kind: 'bool', def: false, desc: 'session name' },
  { key: 'display.showDuration', scope: 'hud', kind: 'bool', def: false, desc: 'session duration' },

  // ---- context + usage ----
  { key: 'display.showContextBar', scope: 'hud', kind: 'bool', def: true, desc: 'context bar' },
  { key: 'display.contextValue', scope: 'hud', kind: 'enum', values: ['percent', 'tokens', 'both'], def: 'percent', desc: 'context value format' },
  { key: 'display.showUsage', scope: 'hud', kind: 'bool', def: true, desc: 'the Usage segment (this project: the balance)' },
  { key: 'display.usageBarEnabled', scope: 'hud', kind: 'bool', def: true, desc: 'usage bar' },
  { key: 'display.showModelScopedUsage', scope: 'hud', kind: 'bool', def: true, desc: 'the balance bar itself' },

  // ---- cache ----
  { key: 'display.showPromptCache', scope: 'hud', kind: 'bool', def: false, desc: 'prompt cache TTL countdown' },
  { key: 'display.showCacheHitRate', scope: 'hud', kind: 'bool', def: false, desc: 'cache hit rate' },
  { key: 'display.showTokenBreakdown', scope: 'hud', kind: 'bool', def: true, desc: 'token breakdown once context hits the critical threshold' },

  // ---- other lines ----
  { key: 'display.showConfigCounts', scope: 'hud', kind: 'bool', def: false, desc: 'CLAUDE.md / MCP counts' },
  { key: 'display.showTools', scope: 'hud', kind: 'bool', def: false, desc: 'tool activity line' },
  { key: 'display.showSkills', scope: 'hud', kind: 'bool', def: false, desc: 'skills line' },
  { key: 'display.showMcp', scope: 'hud', kind: 'bool', def: false, desc: 'MCP line' },
  { key: 'display.showAgents', scope: 'hud', kind: 'bool', def: false, desc: 'subagent line' },
  { key: 'display.showTodos', scope: 'hud', kind: 'bool', def: false, desc: 'todo progress line' },
  { key: 'display.showMemoryUsage', scope: 'hud', kind: 'bool', def: false, desc: 'system memory line' },
  { key: 'display.showSessionTokens', scope: 'hud', kind: 'bool', def: false, desc: 'session token breakdown line' },
  { key: 'display.showCompactions', scope: 'hud', kind: 'bool', def: false, desc: 'context compaction count' },
  { key: 'display.showOutputStyle', scope: 'hud', kind: 'bool', def: false, desc: 'output style' },
  { key: 'display.showClaudeCodeVersion', scope: 'hud', kind: 'bool', def: false, desc: 'Claude Code version' },
  { key: 'display.showSpeed', scope: 'hud', kind: 'bool', def: false, desc: 'output speed' },
  { key: 'display.showAuth', scope: 'hud', kind: 'bool', def: false, desc: 'auth method' },

  // ---- cost: upstream's number is wrong for this provider, keep these off ----
  { key: 'display.showCost', scope: 'hud', kind: 'bool', def: false, locked: false, desc: 'COST — Claude Code misprices this model 17-240x. Do not enable.' },
  { key: 'display.showDailyCost', scope: 'hud', kind: 'bool', def: false, locked: false, desc: 'COST — same bad source' },
  { key: 'display.showWeeklyCost', scope: 'hud', kind: 'bool', def: false, locked: false, desc: 'COST — same bad source' },
  { key: 'display.showRoutedCost', scope: 'hud', kind: 'bool', def: false, locked: false, desc: 'COST — same bad source' },

  // ---- thresholds and formats ----
  { key: 'display.contextWarningThreshold', scope: 'hud', kind: 'int', def: 70, min: 1, max: 100, desc: 'context turns yellow at' },
  { key: 'display.contextCriticalThreshold', scope: 'hud', kind: 'int', def: 85, min: 1, max: 100, desc: 'context turns red at' },
  { key: 'display.timeFormat', scope: 'hud', kind: 'enum', values: ['relative', 'absolute', 'elapsed'], def: 'relative', desc: 'time format' },
  { key: 'gitStatus.enabled', scope: 'hud', kind: 'bool', def: true, desc: 'git branch / dirty marker' },
  { key: 'gitStatus.showDirty', scope: 'hud', kind: 'bool', def: true, desc: 'git dirty marker' },
  { key: 'gitStatus.showAheadBehind', scope: 'hud', kind: 'bool', def: false, desc: 'git ahead/behind counts' },
  { key: 'gitStatus.showFileStats', scope: 'hud', kind: 'bool', def: false, desc: 'git changed-file count' },
  // colors.* is deliberately absent: it inherits the look of the main config,
  // and a broken colour is hard to notice.

  // ---- the bar's scale ----
  { key: 'baseline_mode', scope: 'ours', kind: 'enum', values: ['auto', 'fixed'], def: 'auto', desc: 'bar scale: auto learns it from top-ups, fixed uses the value below' },
  { key: 'topup_min_jump', scope: 'ours', kind: 'float', def: 1, min: 0.01, max: 100000, desc: 'smallest rise counted as a top-up (strictly greater than)' },
  { key: 'usage_max', scope: 'ours', kind: 'float', def: 200, min: 0.01, max: 100000, desc: 'full-scale value when baseline_mode=fixed' },
  { key: 'low_balance', scope: 'ours', kind: 'float', def: 10, min: 0, max: 100000, desc: 'below this the label gets a ⚠ prefix' },
  { key: 'throttle_seconds', scope: 'ours', kind: 'int', def: 60, min: 5, max: 540, desc: 'balance refresh throttle (seconds)' },
];

// Never touchable from here: these are wired to the HUD's data feed.
const PROTECTED = ['display.externalUsagePath', 'display.externalUsageFreshnessMs', 'display.usagePace', 'display.autoCompactWindow'];

const find = (key) => CATALOGUE.find((o) => o.key === key);

// The snapshot's freshness window is fixed at 600s in the claude-hud config.
// A throttle longer than that means the snapshot expires before it is refreshed
// and the Usage segment blinks out on a timer — so the ceiling is not arbitrary.
const FRESHNESS_SECONDS = 600;

function coerce(opt, raw) {
  const out = coerceInner(opt, raw);
  if (opt.locked !== undefined && out !== opt.locked) {
    throw new Error(
      `"${opt.key}" is locked to ${opt.locked}. ${opt.desc}`,
    );
  }
  if (opt.min !== undefined || opt.max !== undefined) {
    const lo = opt.min ?? -Infinity;
    const hi = opt.max ?? Infinity;
    if (out < lo || out > hi) {
      throw new Error(`"${opt.key}" must be between ${lo} and ${hi}, got ${out}`);
    }
  }
  if (opt.key === 'throttle_seconds' && out >= FRESHNESS_SECONDS) {
    throw new Error(
      `"throttle_seconds" must stay under ${FRESHNESS_SECONDS} — the snapshot expires then,` +
        ' and a longer throttle would make the Usage segment disappear periodically.',
    );
  }
  return out;
}

function coerceInner(opt, raw) {
  switch (opt.kind) {
    case 'bool':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new Error(`expected true/false, got "${raw}"`);
    case 'int': {
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new Error(`expected an integer, got "${raw}"`);
      return n;
    }
    case 'float': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`expected a number, got "${raw}"`);
      return n;
    }
    case 'enum':
      if (!opt.values.includes(raw)) throw new Error(`expected one of ${opt.values.join(' / ')}, got "${raw}"`);
      return raw;
    default:
      return raw;
  }
}

function getAt(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setAt(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (const k of parts.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function load() {
  return {
    hud: readJson(PATHS.hudConfig, {}) || {},
    ours: readJson(PATHS.userConfig, {}) || {},
  };
}

function fmt(v) {
  if (v === undefined) return '(unset)';
  return typeof v === 'string' ? `"${v}"` : String(v);
}

function cmdList(all) {
  console.log('Current values and options');
  console.log('─'.repeat(72));
  for (const opt of CATALOGUE) {
    const cur = getAt(opt.scope === 'hud' ? all.hud : all.ours, opt.key);
    const shown = cur === undefined ? `(default ${fmt(opt.def)})` : fmt(cur);
    console.log(`  ${opt.key.padEnd(38)} ${shown.padEnd(16)} ${opt.desc}`);
  }
  console.log('');
  console.log('Protected (wired to the data feed, not settable here):');
  for (const p of PROTECTED) console.log(`  ${p}`);
}

function cmdOptions() {
  for (const opt of CATALOGUE) {
    const vals = opt.kind === 'enum' ? ` [${opt.values.join('|')}]` : ` <${opt.kind}>`;
    console.log(`${opt.key}${vals}  default=${fmt(opt.def)}  ${opt.desc}`);
  }
}

// Deep clone, not a spread. A shallow copy shares the nested `display` object
// with the original, so setAt would mutate "old" and "new" at once and the
// change detection below would always conclude nothing changed — silently
// skipping the write while still reporting success.
const clone = (v) => JSON.parse(JSON.stringify(v));

function cmdSet(pairs, all) {
  const hud = clone(all.hud);
  const ours = clone(all.ours);
  const applied = [];
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new Error(`expected key=value, got "${pair}"`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    if (PROTECTED.includes(key)) throw new Error(`"${key}" is protected: it is wired to the data feed`);
    const opt = find(key);
    if (!opt) throw new Error(`unknown option "${key}" — run \`hud-config.js options\` for the list`);
    const value = coerce(opt, raw);
    setAt(opt.scope === 'hud' ? hud : ours, key, value);
    applied.push(`${key} = ${fmt(value)}`);
  }
  // Back up before the first overwrite, so a bad batch can always be undone.
  for (const [file, next, cur] of [
    [PATHS.hudConfig, hud, all.hud],
    [PATHS.userConfig, ours, all.ours],
  ]) {
    if (JSON.stringify(next) === JSON.stringify(cur)) continue;
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    atomicWriteJson(file, next);
  }
  console.log('Applied:');
  for (const a of applied) console.log(`  ${a}`);
  console.log('');
  console.log('Backups: *.bak alongside each file');
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const all = load();
  switch (cmd) {
    case 'list':
      return cmdList(all);
    case 'options':
      return cmdOptions();
    case 'cat':
      console.log(`--- ${PATHS.hudConfig} ---`);
      console.log(fs.readFileSync(PATHS.hudConfig, 'utf8'));
      console.log(`--- ${PATHS.userConfig} ---`);
      console.log(fs.readFileSync(PATHS.userConfig, 'utf8'));
      return;
    case 'set':
      if (!rest.length) throw new Error('usage: hud-config.js set key=value [key=value ...]');
      return cmdSet(rest, all);
    default:
      console.log('Usage:');
      console.log('  hud-config.js list            current values and every option');
      console.log('  hud-config.js options         the option catalogue only');
      console.log('  hud-config.js set k=v [k=v]   change values (validated, backed up)');
      console.log('  hud-config.js cat             print both config files');
  }
}

try {
  main();
} catch (err) {
  console.error(`hud-config: ${err.message}`);
  process.exit(1);
}
