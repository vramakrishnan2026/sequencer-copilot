import test from 'node:test';
import assert from 'node:assert/strict';
import { estimate, lineCost, parseGcLine, SEED_READINGS } from '../extension/src/heap/estimate.js';

test('a generated call costs about 15 bytes (measured 14.5 to 15.3)', () => {
  const { bytes } = lineCost('connmod.ConfigureCustomDatatypeModbusRegister(1,1,40001)');
  assert.ok(bytes >= 14 && bytes <= 16.5, `got ${bytes}`);
});

test('verdict bands: small fits, boiler-sized is getting full, over the limit is too big', async () => {
  const { verdict } = await import('../extension/src/heap/estimate.js');
  assert.equal(verdict({ total: 853, blocks: 55, fromPython: true }).level, 'fits');
  assert.equal(verdict({ total: 7400, blocks: 942, fromPython: true }).level, 'tight');
  assert.equal(verdict({ total: 9000, blocks: 1043, fromPython: true }).level, 'too-large');
});

test("readings from other sequences don't change a sequence's verdict", async () => {
  const { estimate } = await import('../extension/src/heap/estimate.js');
  const other = { sequence: { key: '/seq/boiler' }, outcome: 'failed', blocks: 55, gc: { used: 11000, maxBlk: 85 } };
  const r = estimate({ python: null, blocks: 55, sequence: { key: '/seq/test' } }, [other]);
  assert.equal(r.own.length, 0);
  assert.equal(r.verdict.level, 'fits');
});

test("a sequence's own reading: failed means too big; ran keeps it below too big and its max blk counts", async () => {
  const { verdict } = await import('../extension/src/heap/estimate.js');
  const failed = [{ outcome: 'failed', blocks: 500, gc: { used: 9000 } }];
  assert.equal(verdict({ total: 4000, blocks: 500, fromPython: true }, failed).level, 'too-large');
  const ran = [{ outcome: 'ran', blocks: 787, gc: { used: 11456, maxBlk: 120 } }];
  const v = verdict({ total: 4000, blocks: 787, fromPython: true, largest: { name: 'runContinuous', bytes: 1950 } }, ran);
  // Its own max blk (1,920) covers a 1,950-byte function, so no "very large" warning...
  assert.equal(v.plain.length, 0);
  // ...but its own reading (94% used) outranks the low estimate: getting full, not "too big", since it ran.
  assert.equal(v.level, 'tight');
  assert.equal(v.basis, 'a reading from the controller');
});

test('model points are counted at the measured 29 bytes each', () => {
  const pts = Array.from({ length: 32 }, (_, i) => `  connmod.ConfigureCustomDatatypeModbusRegister(1,1,${40001 + 2 * i})\n  connmod.WriteDataTypeRegister(1,1,${40001 + 2 * i},0)`).join('\n');
  const r = estimate({ python: `import connmod\n\ndef runStartup():\n${pts}\n\nrunStartup()\n`, blocks: 6 });
  assert.equal(r.analysis.modelPoints, 32);
  assert.equal(r.est.model, 928);
});

test('parses the controller GC lines', () => {
  const gc = parseGcLine('GC: total: 11968, used: 2640, free: 9328\n No. of 1-blocks: 28, 2-blocks: 2, max blk sz: 50, max free sz: 576');
  assert.deepEqual(gc, { total: 11968, used: 2640, free: 9328, oneBlocks: 28, twoBlocks: 2, maxBlk: 50, maxFree: 576 });
});

test('reads a real .mpy from the 75F compiler (641 bytes, two functions)', async () => {
  const { parseMpy } = await import('../extension/src/heap/estimate.js');
  const fs = await import('node:fs');
  const bytes = fs.readFileSync(new URL('./fixtures/small.mpy', import.meta.url));
  const m = parseMpy(new Uint8Array(bytes), ['runStartup', 'runContinuous']);
  assert.equal(m.total, 641);
  assert.equal(m.module, 103);
  assert.deepEqual(m.functions, [{ name: 'runStartup', bytes: 77 }, { name: 'runContinuous', bytes: 119 }]);
});

test('reads a .mpy with constants (decimals, strings, big int, tuple) to the last byte', async () => {
  const { parseMpy } = await import('../extension/src/heap/estimate.js');
  const fs = await import('node:fs');
  const m = parseMpy(new Uint8Array(fs.readFileSync(new URL('./fixtures/consts.mpy', import.meta.url))), ['runStartup', 'runContinuous', 'helper']);
  assert.equal(m.problem, undefined);
  assert.equal(m.objects, 8);
  assert.equal(m.consts.floats, 6);
  assert.equal(m.consts.strings, 2);
  assert.deepEqual(m.functions.map((f) => f.name), ['runStartup', 'runContinuous', 'helper']);
});

test('keeps the lowest and highest of several GC readings', async () => {
  const { parseGcLines } = await import('../extension/src/heap/estimate.js');
  const r = parseGcLines(`GC: total: 11968, used: 6592, free: 5376
 No. of 1-blocks: 230, 2-blocks: 1, max blk sz: 50, max free sz: 334
GC: total: 11968, used: 11488, free: 480
 No. of 1-blocks: 536, 2-blocks: 1, max blk sz: 50, max free sz: 28
GC: total: 11968, used: 4672, free: 7296
 No. of 1-blocks: 110, 2-blocks: 1, max blk sz: 50, max free sz: 456`);
  assert.equal(r.readings.length, 3);
  assert.equal(r.low.used, 4672);
  assert.equal(r.high.used, 11488);
  assert.equal(r.steady, false);
});
