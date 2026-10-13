'use strict';
// Rules about the repository itself, enforced rather than remembered.
//
// These are the kind of thing that is obvious in review and invisible in a
// hurry: a working note committed by accident, or a stray state file. The
// project keeps its design log and its review hand-offs inside the checkout, so
// the guarantee that they are never committed has to be mechanical.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return null; // not a checkout, or no git — nothing to assert
  }
}

test('repo: working notes are never tracked', () => {
  const files = trackedFiles();
  if (!files) return;
  const leaked = files.filter((f) => /(^|\/)(PLAN|REVIEW_PROMPT).*\.md$/.test(f));
  assert.deepStrictEqual(
    leaked,
    [],
    `these are local working notes and must not be committed: ${leaked.join(', ')}`,
  );
});

test('repo: runtime state is never tracked', () => {
  const files = trackedFiles();
  if (!files) return;
  const leaked = files.filter((f) => /\.(jsonl|log)$/.test(f) || /\.bak$/.test(f));
  assert.deepStrictEqual(leaked, [], `runtime state must not be committed: ${leaked.join(', ')}`);
});

test('repo: no file carries an API key pattern', () => {
  const files = trackedFiles();
  if (!files) return;
  const suspicious = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
    } catch {
      continue;
    }
    if (/\bsk-[A-Za-z0-9]{16,}/.test(text) || /\bgh[pousr]_[A-Za-z0-9]{20,}/.test(text)) {
      suspicious.push(f);
    }
  }
  assert.deepStrictEqual(suspicious, [], `possible credentials in: ${suspicious.join(', ')}`);
});
