'use strict';
// src/pi-usage.js is read-only, so these tests build a sidecar fixture in a temp
// directory and assert what the aggregation reports. No network, no real data
// directory, nothing written outside the fixture.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { localToday, readPiUsage } = require('../src/pi-usage');

const entry = (input, output, cacheRead, cacheWrite, turns, updated_at) => ({
  input, output, cacheRead, cacheWrite, turns, updated_at,
});

/** A temp directory holding one sidecar; returns the aggregate for `now`. */
function readFrom(doc, now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshud-pi-usage-'));
  try {
    fs.writeFileSync(path.join(dir, 'pi-usage.json'), `${JSON.stringify(doc, null, 2)}\n`);
    return readPiUsage(dir, now);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('pi-usage: a missing sidecar reports nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshud-pi-usage-missing-'));
  try {
    assert.equal(readPiUsage(dir, new Date()), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pi-usage: corrupt JSON reports nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshud-pi-usage-corrupt-'));
  try {
    fs.writeFileSync(path.join(dir, 'pi-usage.json'), '{ "date": "2026-11-02", sessions: ');
    assert.equal(readPiUsage(dir, new Date()), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pi-usage: a sidecar dated another calendar day reports nothing', () => {
  const now = new Date('2026-11-02T23:30:00');
  const today = localToday(now);
  const sessions = { a: entry(10, 3, 5, 0, 2, '2026-11-02T10:00:00.000Z') };

  // Same content, only the date differs: the date is what makes it report nothing.
  assert.equal(readFrom({ schema: 1, updated_at: '2026-11-01T23:59:59.000Z', date: '2026-11-01', sessions }, now), null);

  const sameDay = readFrom({ schema: 1, updated_at: '2026-11-02T10:00:00.000Z', date: today, sessions }, now);
  assert.ok(sameDay, 'the identical sidecar dated today does report');
  assert.equal(sameDay.date, today);
  assert.equal(sameDay.sessions, 1);
});

test('pi-usage: two entries sum, and the hit rate is cacheRead over what was sent', () => {
  const now = new Date('2026-11-02T12:00:00');
  const today = localToday(now);
  const doc = {
    schema: 1,
    date: today,
    updated_at: '2026-11-02T12:00:00.000Z',
    sessions: {
      a: entry(4, 1, 6, 0, 3, '2026-11-02T09:00:00.000Z'),
      b: entry(3, 2, 5, 1, 2, '2026-11-02T11:00:00.000Z'),
    },
  };
  const got = readFrom(doc, now);
  assert.ok(got);
  assert.equal(got.sessions, 2);
  assert.equal(got.input, 7);
  assert.equal(got.output, 3);
  assert.equal(got.cacheRead, 11);
  assert.equal(got.cacheWrite, 1);
  assert.equal(got.turns, 5);
  // 11 / (7 + 11) = 0.611111..., kept at four places.
  assert.equal(got.cache_hit_rate, 0.6111);
  assert.equal(got.updated_at, '2026-11-02T11:00:00.000Z', 'newest entry, not the file mtime');
});

test('pi-usage: entries that never ran a turn report nothing on their own', () => {
  const now = new Date('2026-11-02T12:00:00');
  const doc = {
    schema: 1,
    date: localToday(now),
    updated_at: '2026-11-02T12:00:00.000Z',
    // Tokens with no turn: a session that opened and never answered.
    sessions: { a: entry(1000, 500, 900, 0, 0, '2026-11-02T10:00:00.000Z') },
  };
  assert.equal(readFrom(doc, now), null, 'nothing ran a turn, so nothing to report');
});

test('pi-usage: a mixed day counts and sums only the entries that ran a turn', () => {
  const now = new Date('2026-11-02T12:00:00');
  const doc = {
    schema: 1,
    date: localToday(now),
    updated_at: '2026-11-02T12:00:00.000Z',
    sessions: {
      empty: entry(1000, 500, 900, 700, 0, '2026-11-02T10:00:00.000Z'),
      live: entry(10, 3, 5, 0, 2, '2026-11-02T11:00:00.000Z'),
    },
  };
  const got = readFrom(doc, now);
  assert.ok(got);
  assert.equal(got.sessions, 1, 'sessions counts only the entry that ran a turn');
  assert.equal(got.input, 10, 'the zero-turn entry does not contribute to the totals');
  assert.equal(got.output, 3);
  assert.equal(got.cacheRead, 5);
  assert.equal(got.cacheWrite, 0);
  assert.equal(got.turns, 2);
  assert.equal(got.cache_hit_rate, 0.3333);
  assert.equal(got.updated_at, '2026-11-02T11:00:00.000Z');
});
