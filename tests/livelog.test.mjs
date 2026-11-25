import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLogReader, summarize, trendOf } from '../extension/src/heap/livelog.js';
import { parseGcLog } from '../extension/src/heap/estimate.js';

const read = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
function feed(text, size = 37) {
  let t = 0;
  const r = createLogReader({ now: () => (t += 1000) });
  for (let i = 0; i < text.length; i += size) r.push(text.slice(i, i + size));
  r.flush();
  return r.session;
}

test('live: boiler rebuild log gives the start-up reading and steady runs', () => {
  const s = feed(read('boiler-rebuild.log'));
  assert.equal(s.sequence.name, 'Boiler from Scratch');
  assert.equal(s.sequence.length, 4338);
  assert.ok(s.startup, 'start-up captured');
  assert.ok(s.startup.used < 8000, `start-up used ${s.startup.used}`);
  assert.equal(s.startupMissed, false);
  assert.ok(s.runs.length >= 2);
  assert.ok(s.runs.every((r) => r.used === 11456));
});

test('live: a log without the start-up section does not mistake the first run for it', () => {
  const s = feed(read('resolved-runs.log'), 101);
  assert.equal(s.sequence.name, 'Boiler Sequence - heapIssueResolved');
  assert.equal(s.sequence.length, 5215);
  assert.equal(s.startup, null);
  assert.equal(s.startupMissed, true);
  assert.ok(s.runs.length >= 3);
  assert.equal(s.runs[0].used, 11072);
  assert.equal(s.runs[0].maxFree, 5);
  assert.ok(s.runs[0].timeMs > 200);
});

test('pasted log: same start-up rule as the live reader', () => {
  const a = parseGcLog(read('resolved-runs.log'));
  assert.equal(a.startup, null);
  const b = parseGcLog(read('boiler-rebuild.log'));
  assert.ok(b.startup && b.startup.used < 8000);
});

test('trend: steady vs building up', () => {
  const flat = Array.from({ length: 50 }, (_, i) => ({ used: 11072 - (i % 3) * 16 }));
  assert.equal(trendOf(flat).trend, 'steady');
  const rising = Array.from({ length: 50 }, (_, i) => ({ used: 9000 + i * 16 }));
  assert.equal(trendOf(rising).trend, 'growing');
  assert.equal(summarize({ runs: flat, sequence: null }).trend, 'steady');
});
