import test from 'node:test';
import assert from 'node:assert/strict';
import { estimate, lineCost, parseGcLine, SEED_READINGS } from '../extension/src/heap/estimate.js';

test('a generated call costs about 15 bytes (measured 14.5 to 15.3)', () => {
  const { bytes } = lineCost('connmod.ConfigureCustomDatatypeModbusRegister(1,1,40001)');
  assert.ok(bytes >= 14 && bytes <= 16.5, `got ${bytes}`);
});

test('true size from .mpy matches the measured sequences within 1.5%', async () => {
  const { trueSizeFromMpy } = await import('../extension/src/heap/estimate.js');
  for (const [mpy, measured] of [[1125, 688], [4338, 4800], [5215, 6064]]) {
    const t = trueSizeFromMpy(mpy);
    assert.ok(Math.abs(t - measured) / measured < 0.015, `${mpy}: ${t} vs ${measured}`);
  }
});

test('largest free piece after startup matches the measured blocks (within 10)', async () => {
  const { trueSizeFromMpy, maxFreeAfterStartup } = await import('../extension/src/heap/estimate.js');
  for (const [mpy, blocks] of [[1125, 534], [4338, 254], [5215, 156]]) {
    const b = maxFreeAfterStartup(trueSizeFromMpy(mpy)) / 16;
    assert.ok(Math.abs(b - blocks) <= 10, `${mpy}: ${b} vs ${blocks}`);
  }
});

test('verdicts: 55-block and rebuild fit, size-reduced boiler is getting full, bigger is too big', async () => {
  const { estimate } = await import('../extension/src/heap/estimate.js');
  const v = (mpySize, blocks) => estimate({ python: null, mpySize, blocks, sequence: { key: 'k' } }).verdict.level;
  assert.equal(v(1125, 55), 'fits');
  assert.equal(v(4338, 787), 'fits');
  assert.equal(v(5215, 942), 'tight');
  assert.equal(v(5800, 1043), 'too-large');
});

test("readings from other sequences don't change a sequence's verdict", async () => {
  const { estimate } = await import('../extension/src/heap/estimate.js');
  const other = { sequence: { key: '/seq/boiler' }, outcome: 'failed', blocks: 55, gc: { used: 11000, maxFree: 5 } };
  const r = estimate({ python: null, mpySize: 1125, blocks: 55, sequence: { key: '/seq/test' } }, [other]);
  assert.equal(r.own.length, 0);
  assert.equal(r.verdict.level, 'fits');
});

test("a sequence's own reading wins: failed means too big; a reading's numbers replace the prediction", async () => {
  const { estimate } = await import('../extension/src/heap/estimate.js');
  const key = { key: '/seq/x' };
  const failed = [{ sequence: key, outcome: 'failed', blocks: 500, gc: { used: 6000, maxFree: 300 } }];
  assert.equal(estimate({ python: null, mpySize: 2000, blocks: 500, sequence: key }, failed).verdict.level, 'too-large');
  const ran = [{ sequence: key, outcome: 'ran', blocks: 942, gc: { used: 8704, maxFree: 156 } }];
  const r = estimate({ python: null, mpySize: 3000, blocks: 942, sequence: key }, ran);
  assert.equal(r.verdict.trueSize, 6064);
  assert.equal(r.verdict.level, 'tight');
  assert.equal(r.verdict.basis, 'a reading from the controller');
});

test('predicted .mpy size is within 3% of mpy-cross 1.22 on a real 75F program', async () => {
  const { analyzePython } = await import('../extension/src/heap/estimate.js');
  const fs = await import('node:fs');
  const py = fs.readFileSync(new URL('./fixtures/small.py', import.meta.url), 'utf8');
  const est = analyzePython(py).mpyEst;
  assert.ok(Math.abs(est - 641) / 641 < 0.03, `${est} vs 641`);
});

test('model points are counted (their set-up is part of the .mpy size)', () => {
  const pts = Array.from({ length: 32 }, (_, i) => `  connmod.ConfigureCustomDatatypeModbusRegister(1,1,${40001 + 2 * i})\n  connmod.WriteDataTypeRegister(1,1,${40001 + 2 * i},0)`).join('\n');
  const r = estimate({ python: `import connmod\n\ndef runStartup():\n${pts}\n\nrunStartup()\n`, blocks: 6 });
  assert.equal(r.analysis.modelPoints, 32);
  assert.equal(r.est.modelPoints, 32);
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
