import test from 'node:test';
import assert from 'node:assert/strict';
import { estimate, lineCost, parseGcLine, SEED_READINGS } from '../extension/src/heap/estimate.js';

test('a generated call costs about 15 bytes (measured 14.5 to 15.3)', () => {
  const { bytes } = lineCost('connmod.ConfigureCustomDatatypeModbusRegister(1,1,40001)');
  assert.ok(bytes >= 14 && bytes <= 16.5, `got ${bytes}`);
});

test('block-count verdicts agree with every measured load', () => {
  for (const r of SEED_READINGS) {
    const level = estimate({ python: null, blocks: r.blocks }).verdict.level;
    if (r.outcome === 'failed') assert.equal(level, 'too-large', r.label);
    else assert.notEqual(level, 'too-large', r.label);
  }
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
