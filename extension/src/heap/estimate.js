/**
 * Heap estimate for a Site Sequencer program on the Connect Module (MicroPython, 11,968-byte heap).
 * Pure functions: no DOM, no chrome APIs, so they run in Node for tests.
 *
 * What is measured (user's controller, Nov 2026) and what is assumed is kept apart:
 *  MEASURED  firmware baseline 2,640 bytes; ~9,330 bytes left for a sequence
 *  MEASURED  a Select Model block costs ~29 bytes per model point (2 generated calls of ~15 bytes)
 *  MEASURED  one generated call statement costs ~15 bytes
 *  MEASURED  "max blk sz" tracks the largest function once it is over 800 bytes; 1,920 bytes ran
 *  MEASURED  which loads ran and which failed (seed readings below, by canvas block count)
 *  ASSUMED   everything else: per-token bytecode costs approximating MicroPython's compiler.
 *            The calibration readings correct the scale.
 */

export const HEAP = {
  total: 11968,
  baseline: 2640,
  budget: 9328,
  gcBlock: 16,
  firmwareBlock: 800, // "max blk sz" 50 blocks with nothing loaded
  modelPerPoint: 29,
  largestRan: 1920, // largest "max blk sz" seen on a load that ran (120 blocks)
  // Measured 25 Nov on the controller (format 6.2, MicroPython 1.22). "Used after startup" is the
  // true size; end-of-run figures include one run's garbage and are not a limit.
  //   true size above baseline = 1.3 x .mpy bytes - 780   (within 1.5% on 55, 787 and 942 blocks)
  mpyFactor: 1.3,
  mpyOffset: 780,
  // Largest free piece after startup = free - (100 + 1.7e-5 x true^2): fragmentation grows with
  // size. Fitted to 576 / 534 / 254 / 156 blocks measured; predicts 252 and 158 for the boilers.
  fragBase: 100,
  fragPerSquare: 1.7e-5,
  // Verdict on the largest free piece after startup: working sequences had 254 and 156 blocks;
  // the failing 1,043-block original showed 80 and 55 (its true size wasn't measured).
  tooBigBelow: 2000, // bytes (125 blocks)
  tightBelow: 3520, // bytes (220 blocks)
};

// Loads measured on the controller. Block counts only: the generated Python wasn't captured.
export const SEED_READINGS = [
  { label: 'Lighting, original', blocks: 1530, outcome: 'failed' },
  { label: 'Lighting, change 1', blocks: 739, outcome: 'ran', maxBlk: 100 },
  { label: 'Lighting, change 2', blocks: 608, outcome: 'ran', maxBlk: 100 },
  { label: 'Lighting, change 4', blocks: 560, outcome: 'ran', maxBlk: 77 },
  { label: 'Lighting, change 5', blocks: 528, outcome: 'ran', maxBlk: 77 },
  { label: 'Boiler, original', blocks: 1043, outcome: 'failed' },
  { label: 'Boiler, size-reduced', blocks: 942, outcome: 'ran', maxBlk: 85 },
  { label: 'Boiler rebuild, part built', blocks: 429, outcome: 'ran', maxBlk: 83 },
  { label: 'Boiler rebuild, complete', blocks: 787, outcome: 'ran', maxBlk: 120 },
];

// --------------------------------------------------------------------------- Python analysis

const KEYWORD_COST = {
  if: 3, elif: 6, else: 3, while: 6, for: 8, return: 1, break: 3, continue: 3, pass: 0,
  and: 3, or: 3, not: 1, in: 1, is: 1, True: 1, False: 1, None: 1, import: 3, from: 3, def: 0,
  global: 0, lambda: 6, try: 6, except: 6, finally: 3, with: 6, as: 0, del: 3, raise: 3,
};
const TOKEN = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\d+\.\d*|\.\d+|\d+(?:e[+-]?\d+)?)|([A-Za-z_]\w*)|(\*\*=?|\/\/=?|[-+*/%<>!=]=|[-+*/%<>=]|[()[\]{},.:])/g;

// -16..47 has a one-byte opcode; larger ints are an opcode plus a 7-bit varint.
function intCost(n) {
  if (n >= -16 && n <= 47) return 1;
  const bits = Math.floor(Math.log2(Math.abs(n) || 1)) + 2;
  return 1 + Math.ceil(bits / 7);
}

// Bytes of bytecode (plus constant data) for one logical line, and its calls.
export function lineCost(line) {
  let bytes = 0.5; // line-number info (packed; about half a byte per line)
  let data = 0;
  let calls = 0;
  const toks = [];
  for (const m of line.matchAll(TOKEN)) {
    if (m[1]) toks.push({ k: 'str', v: m[1] });
    else if (m[2]) toks.push({ k: 'num', v: m[2] });
    else if (m[3]) toks.push({ k: 'name', v: m[3] });
    else toks.push({ k: 'op', v: m[4] });
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const prev = toks[i - 1];
    if (t.k === 'name') {
      if (Object.hasOwn(KEYWORD_COST, t.v)) bytes += KEYWORD_COST[t.v];
      else bytes += 3; // load/store name, attribute or method
    } else if (t.k === 'num') {
      if (/[.e]/i.test(t.v)) { bytes += 3; data += 16; } else bytes += intCost(Number(t.v));
    } else if (t.k === 'str') {
      bytes += 3;
      data += t.v.length + 3;
    } else if (t.v === '(') {
      if (prev && (prev.k === 'name' || prev.v === ')' || prev.v === ']') && !Object.hasOwn(KEYWORD_COST, prev.v)) {
        bytes += 2;
        calls += 1;
      }
    } else if (t.v === '[') {
      bytes += 2;
    } else if (/^(\*\*|\/\/|[-+*/%<>!=]=?|\*\*=|\/\/=)$/.test(t.v) && t.v !== '=') {
      bytes += 1;
    }
  }
  // An expression statement that is just a call discards its result.
  const first = toks[0];
  if (first?.k === 'name' && !Object.hasOwn(KEYWORD_COST, first.v) && calls && !toks.some((t) => t.v === '=')) bytes += 1;
  return { bytes, data, calls };
}

const FN_OVERHEAD = 8; // function prelude in the bytecode (the rest is counted as runtime bookkeeping)

/**
 * Splits generated Python into module code and functions, and estimates each.
 * Lines from the Select Model block (Configure/Write in runStartup, one pair per point) are
 * counted separately at the measured per-point cost.
 */
export function analyzePython(code) {
  const lines = code.replace(/\r/g, '').split('\n');
  const sections = [];
  let cur = { name: '(module)', kind: 'module', lines: [] };
  sections.push(cur);
  for (const raw of lines) {
    const def = raw.match(/^def\s+([A-Za-z_]\w*)\s*\(/);
    if (def) {
      cur = { name: def[1], kind: 'function', lines: [] };
      sections.push(cur);
      continue;
    }
    if (raw.trim() && !/^\s/.test(raw) && cur.kind === 'function') {
      cur = sections[0];
    }
    cur.lines.push(raw);
  }

  // Statements at module level before the superloop come from loose blocks on the canvas: they
  // compile into the program (and run once at load) without being part of the sequence.
  const loose = [];
  let inSuperloop = false;
  for (const raw of sections[0].lines) {
    const t = raw.replace(/#.*$/, '').trim();
    if (/^#+\s*Superloop/i.test(raw.trim())) inSuperloop = true;
    if (inSuperloop || !t || /^(import|from)\s/.test(t) || /^[A-Za-z_]\w*\s*=\s*None$/.test(t)) continue;
    if (/^(runStartup|runContinuous)\(\)$/.test(t) || /^(while|for)\s/.test(t)) { inSuperloop = true; continue; }
    if (/^\s/.test(raw)) continue;
    loose.push(t);
  }

  const declared = new Set();
  for (const l of sections[0].lines) {
    const m = l.match(/^([A-Za-z_]\w*)\s*=\s*None\s*$/);
    if (m) declared.add(m[1]);
  }

  let modelPoints = 0;
  const configured = new Map(); // address -> default written by Select Model
  const out = [];
  for (const s of sections) {
    let bytes = s.kind === 'function' ? FN_OVERHEAD : 0;
    let data = 0;
    let calls = 0;
    let statements = 0;
    const body = [];
    for (const raw of s.lines) {
      const line = raw.replace(/#.*$/, '').trimEnd();
      const text = line.trim();
      if (!text || /^global\s/.test(text) || /^(""".*"""|'''.*''')$/.test(text)) continue;
      if (s.kind === 'module' && declared.has(text.split(/\s*=/)[0]) && /=\s*None$/.test(text)) {
        bytes += 6; // module-level "Name = None"
        continue;
      }
      const cfg = text.match(/ConfigureCustomDatatypeModbusRegister\(\s*\d+\s*,\s*\d+\s*,\s*(\d+)\s*\)/);
      if (cfg && s.name === 'runStartup') {
        modelPoints += 1;
        configured.set(cfg[1], null);
        body.push({ text, indent: line.length - text.length, model: true });
        continue;
      }
      const wr = text.match(/^connmod\.WriteDataTypeRegister\(\s*\d+\s*,\s*\d+\s*,\s*(\d+)\s*,\s*(.+)\)$/);
      if (wr && s.name === 'runStartup' && configured.has(wr[1]) && configured.get(wr[1]) === null) {
        configured.set(wr[1], wr[2].trim()); // the model's default write, right after configure
        body.push({ text, indent: line.length - text.length, model: true });
        continue;
      }
      const c = lineCost(text);
      bytes += c.bytes;
      data += c.data;
      calls += c.calls;
      statements += 1;
      body.push({ text, indent: line.length - text.length, bytes: c.bytes });
    }
    if (s.kind === 'module' && !statements && !declared.size) continue;
    out.push({ name: s.name, kind: s.kind, bytes, data, calls, statements, body });
  }

  // Names held in the qstr pool and the globals dict.
  // Names the program brings: variables, functions and the library calls it uses.
  const attrs = new Set();
  for (const s of out) for (const b of s.body) for (const m of b.text.matchAll(/\.([A-Za-z_]\w*)\s*\(/g)) attrs.add(m[1]);
  // Library call names (connmod.X, uniInputMapping.X) are already in the firmware: measured on a
  // small sequence, counting them overshot by ~300 bytes. Only the sequence's own names cost heap.
  const qstrBytes = [...declared].reduce((n, v) => n + v.length + 5, 0)
    + out.filter((s) => s.kind === 'function').reduce((n, s) => n + s.name.length + 5, 0);
  const nameCount = declared.size + out.filter((s) => s.kind === 'function').length;

  const functions = out.filter((s) => s.kind === 'function');
  const program = out.reduce((n, s) => n + s.bytes + s.data, 0) + qstrBytes;

  // Predicted .mpy size (fitted against mpy-cross 1.22 on 14 programs, 550 B to 11 KB: within 2%):
  // 0.844 x estimated code + names table + constants + header and the service's file name.
  let codeEst = out.reduce((n, s) => n + s.bytes, 0);
  for (const s of out) for (const b of s.body) if (b.model) codeEst += lineCost(b.text).bytes;
  const ids = new Set(['connmod', 'uniInputMapping']);
  for (const s of out) for (const b of s.body) {
    for (const t of b.text.matchAll(/'([^']*)'|"([^"]*)"/g)) ids.add(t[1] ?? t[2]);
    for (const t of b.text.replace(/'[^']*'|"[^"]*"/g, '').matchAll(/[A-Za-z_]\w*/g)) if (!Object.hasOwn(KEYWORD_COST, t[0]) && t[0] !== 'range') ids.add(t[0]);
  }
  for (const d of declared) ids.add(d);
  for (const f of functions) ids.add(f.name);
  const namesEst = [...ids].reduce((n, x) => n + x.length + 2, 0);
  const floatsEst = [...new Set([...code.matchAll(/\b\d+\.\d+\b/g)].map((x) => x[0]))].reduce((n, x) => n + x.length + 2, 0);
  const mpyEst = Math.round(0.844 * codeEst + 28 + namesEst + floatsEst + 21 + 19);

  // Temporary data per run (rough): decimal results of arithmetic and of library calls in the
  // code that runs every cycle are 16-byte objects, about two per operation including the
  // libraries' own; input conversions add an 800-byte table plus about 160 bytes a call
  // (fitted to the boiler rebuild, measured 4,016+ a run with six conversions; h2 measured 96).
  let runOps = 0;
  let conversions = 0;
  const grows = new Set();
  for (const s of out) {
    if (s.name === 'runStartup') continue;
    for (const b of s.body) {
      if (b.model) continue;
      const t = b.text;
      if (/^(while|for|import|from)\b/.test(t) || /^[A-Za-z_]\w*\s*=\s*None$/.test(t) || /^(runStartup|runContinuous)\(\)$/.test(t)) continue;
      const arith = (t.replace(/'[^']*'|"[^"]*"/g, '').match(/[-+*/%](?!=)/g) || []).length;
      const calls = (t.match(/[A-Za-z_]\w*\s*\(/g) || []).length;
      const statementCall = /^[A-Za-z_][\w.]*\(/.test(t) ? 1 : 0;
      runOps += arith + Math.max(0, calls - statementCall);
      conversions += (t.match(/ConvertValueFromIndex|ConvertResistance/g) || []).length;
      // Data that grows every run: list appends, or text joined onto itself.
      const app = t.match(/^([A-Za-z_]\w*)\.(append|extend|insert)\(/);
      if (app && declared.has(app[1])) grows.add(app[1]);
      const join = t.match(/^([A-Za-z_]\w*)\s*(\+=|=\s*(?:str\()?\1\)?\s*\+)/);
      if (join && declared.has(join[1]) && /str\(|'|"/.test(t)) grows.add(join[1]);
    }
  }
  const garbagePerRun = Math.round(32 * runOps + (conversions ? 800 + 160 * conversions : 0));
  const largest = functions.reduce((a, s) => (!a || s.bytes > a.bytes ? s : a), null);
  return {
    sections: out,
    functions: functions.length,
    variables: declared.size,
    modelPoints,
    modelDefaults: configured,
    program,
    names: qstrBytes,
    nameCount,
    libNames: attrs,
    mpyEst,
    garbagePerRun,
    grows: [...grows],
    largest: largest ? { name: largest.name, bytes: largest.bytes } : null,
    loose,
    defOrder: functions.map((s) => s.name),
  };
}

// ------------------------------------------------------------------------------ calibration

/**
 * Parses every GC reading in the pasted text (each starts with "GC: total:"). Garbage builds up
 * between collections, so one reading is only a snapshot: the lowest "used" is the closest to what
 * the sequence really keeps, the highest shows how full the heap gets.
 */
export function parseGcLines(text) {
  const parts = String(text).split(/(?=GC:\s*total:)/i).map(parseGcLine).filter(Boolean);
  if (!parts.length) return null;
  const low = parts.reduce((a, b) => (b.used < a.used ? b : a));
  const high = parts.reduce((a, b) => (b.used > a.used ? b : a));
  return { readings: parts, low, high, steady: parts.length > 1 && low.used === high.used };
}

/**
 * Reads a pasted controller log (or bare GC lines). Each GC reading is printed when a run ends.
 * The one after the start-up run (its log shows "Configuring register" / "Module Loaded") is the
 * true size; the rest are end-of-run peaks, which include that run's temporary data.
 * hint: 'startup' when the person says a lone reading was taken right after start-up.
 */
export function parseGcLog(text, hint = null) {
  const t = String(text);
  const at = [];
  const re = /GC:\s*total:\s*\d+/gi;
  for (let m = re.exec(t); m; m = re.exec(t)) at.push(m.index);
  if (!at.length) return null;
  const items = at.map((pos, i) => ({
    gc: parseGcLine(t.slice(pos, at[i + 1] ?? t.length)),
    before: t.slice(i ? at[i - 1] : 0, pos),
  })).filter((x) => x.gc);
  if (!items.length) return null;
  let startIdx = items.findIndex((x) => /Configuring register|Module Loaded|Module Details/i.test(x.before));
  let detected = startIdx >= 0;
  if (!detected && hint === 'startup') startIdx = 0;
  const startup = startIdx >= 0 ? items[startIdx].gc : null;
  const runs = items.filter((_, i) => i !== startIdx && (startIdx < 0 || i > startIdx)).map((x) => x.gc);
  // Does memory build up from run to run? (The same figure every run means it doesn't.)
  let trend = 'unknown';
  if (runs.length >= 2) {
    const used = runs.map((r) => r.used);
    const rising = used.every((u, i) => !i || u >= used[i - 1]) && used[used.length - 1] - used[0] >= 64;
    trend = rising && runs.length >= 3 ? 'growing' : 'steady';
  }
  const peak = runs.length ? runs.reduce((a, b) => (b.used > a.used ? b : a)) : null;
  return { startup, runs, peak, trend, detected, count: items.length };
}

/** Parses one GC reading. Returns null if no "GC: total" line is found. */
export function parseGcLine(text) {
  const m = String(text).match(/GC:\s*total:\s*(\d+),\s*used:\s*(\d+),\s*free:\s*(\d+)/i);
  if (!m) return null;
  const n = (re) => { const x = String(text).match(re); return x ? Number(x[1]) : null; };
  return {
    total: Number(m[1]), used: Number(m[2]), free: Number(m[3]),
    oneBlocks: n(/1-blocks:\s*(\d+)/i), twoBlocks: n(/2-blocks:\s*(\d+)/i),
    maxBlk: n(/max blk sz:\s*(\d+)/i), maxFree: n(/max free sz:\s*(\d+)/i),
  };
}

// ------------------------------------------------------------------------------------ verdict

/** Readings saved for this sequence (older readings without a sequence don't count). */
export function readingsFor(readings, key) {
  return key ? readings.filter((r) => r.sequence?.key === key) : [];
}

/** True size above the firmware baseline, from the .mpy size. */
export const trueSizeFromMpy = (mpyBytes) => Math.max(0, HEAP.mpyFactor * mpyBytes - HEAP.mpyOffset);

/** Largest free piece right after startup, in bytes, from the true size. */
export function maxFreeAfterStartup(trueSize) {
  const free = HEAP.budget - trueSize;
  return Math.max(0, free - (HEAP.fragBase + HEAP.fragPerSquare * trueSize * trueSize));
}

const blocksOf = (bytes) => Math.round(bytes / HEAP.gcBlock);

/** Where the verdict bands fall on the true-size gauge (share of the budget), for its markers. */
export function bandShares() {
  const at = (limit) => {
    let lo = 0; let hi = HEAP.budget;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (maxFreeAfterStartup(mid) > limit) lo = mid; else hi = mid; }
    return lo / HEAP.budget;
  };
  return { tight: at(HEAP.tightBelow), tooBig: at(HEAP.tooBigBelow) };
}

/**
 * est: { total (true size above baseline), maxFree, blocks, basis, mpyBytes, largest }
 * own: readings saved for this same sequence.
 * The verdict rests on the true size and the largest free piece after startup.
 */
export function verdict(est, own = []) {
  const reasons = [];
  const plain = [];
  let trueSize = est.total;
  let maxFree = est.maxFree;
  let basis = est.basis;

  // A reading of this sequence at this size beats the prediction. Only a reading from right after
  // start-up gives the true size; end-of-run readings include temporary data.
  const measured = own.find((r) => r.blocks === est.blocks) || null;
  const mStartup = measured?.phase === 2 ? measured.startup : null;
  if (mStartup) {
    trueSize = Math.max(0, mStartup.used - HEAP.baseline);
    if (mStartup.maxFree != null) maxFree = mStartup.maxFree * HEAP.gcBlock;
    basis = 'a reading from the controller';
  }

  let level = 'fits';
  if (trueSize >= HEAP.budget || maxFree < HEAP.tooBigBelow) level = 'too-large';
  else if (maxFree < HEAP.tightBelow) level = 'tight';
  if (measured?.outcome === 'failed') level = 'too-large';
  else if (measured?.outcome === 'ran' && level === 'too-large') level = 'tight';

  // While running: memory fills with each run's temporary data and is cleared at the start of the
  // next run. What matters for "later" is whether it builds up from run to run.
  const mRuns = measured?.phase === 2 ? measured.runs || [] : measured?.gc ? [measured.gc] : [];
  const measuredPeak = mRuns.length ? Math.max(...mRuns.map((r) => r.used)) : null;
  const predictedPeak = est.garbagePerRun != null
    ? Math.min(HEAP.total - 512, HEAP.baseline + trueSize + est.garbagePerRun) : null;
  const peakUsed = measuredPeak ?? predictedPeak;
  const trend = measured?.phase === 2 ? measured.trend : 'unknown';
  const grows = est.grows || [];
  const run = {
    peakUsed,
    peakShare: peakUsed != null ? Math.min(1, (peakUsed - HEAP.baseline) / HEAP.budget) : null,
    measured: measuredPeak != null,
    runs: mRuns.length,
    trend,
    grows,
    garbagePerRun: est.garbagePerRun,
  };
  if (trend === 'growing') level = 'too-large';
  else if (grows.length && level === 'fits') level = 'tight';

  const pct = trueSize / HEAP.budget;
  const approx = basis === 'a reading from the controller' || est.exactMpy ? '' : 'about ';
  reasons.push(`True size (used after startup, above the 2,640 baseline): ${approx}${fmtBytes(trueSize)}, ${Math.round(pct * 100)}% of the ${fmtBytes(HEAP.budget)} left by the firmware${est.mpyBytes && basis !== 'a reading from the controller' ? `, from a ${est.exactMpy ? '' : 'predicted '}.mpy of ${fmtBytes(est.mpyBytes)} (1.3 × .mpy − 780)` : ''}.`);
  reasons.push(`Largest free piece after startup: ${approx}${fmtBytes(maxFree)} (${blocksOf(maxFree)} blocks). Working sequences had 254 and 156 blocks; the failing 1,043-block original showed 80 and 55. Getting full below 220 blocks, likely too big below 125.`);
  if (measured) {
    reasons.push(`Measured on the controller (${measured.blocks} blocks): ${measured.outcome === 'ran' ? 'it ran' : 'it failed'}${mStartup ? `; after start-up ${mStartup.used} used, largest free piece ${mStartup.maxFree ?? '?'} blocks` : '; no reading from right after start-up, so the true size is predicted'}.`);
  }
  if (peakUsed != null) {
    reasons.push(`While running: ${run.measured ? `measured up to ${peakUsed} used at the end of a run` : `about ${fmtBytes(est.garbagePerRun)} of temporary data a run (rough), so up to about ${Math.round(peakUsed)} used`}. That's cleared at the start of the next run and isn't a limit: the boiler rebuild runs at 11,456 used (17–30 blocks free) every run.`);
  }
  if (trend === 'growing') reasons.push(`Measured over ${mRuns.length} runs, "used" at the end of each run kept rising (${mRuns.map((r) => r.used).join(' → ')}). Memory is building up and will run out.`);
  else if (trend === 'steady') reasons.push(`Measured over ${mRuns.length} runs: the same pattern every run, so memory isn't building up.`);
  if (grows.length) reasons.push(`The code adds to ${grows.join(', ')} every run (a list append or text joined onto itself), so its memory can keep growing.`);

  if (level !== 'fits') {
    plain.push(level === 'tight'
      ? 'The controller needs some unbroken free memory to work with, and after this sequence starts there isn\'t much left in one piece.'
      : 'After this sequence starts, the controller would have too little free memory left in one piece to work with.');
  }
  if (trend === 'growing') plain.push('Measured on the controller, its memory use grew from run to run. It will run out of memory after a while.');
  else if (grows.length) plain.push(`It adds to ${grows.join(', ')} on every run, so its memory use can keep growing over time until it runs out.`);
  return { level, pct, share: `${Math.round(pct * 100)}%`, basis, reasons, plain, measured, trueSize, maxFree, run };
}

// -------------------------------------------------------------------------------- suggestions

export function suggestions(analysis) {
  const out = [];
  if (!analysis) return out;
  const fnSections = analysis.sections.filter((s) => s.kind === 'function');

  // 1. Repeated runs of statements (3 to 8 lines), same shape apart from numbers.
  const norm = (t) => t.replace(/\b\d+(\.\d+)?\b/g, '#');
  const seen = new Map();
  for (const s of fnSections) {
    const body = s.body.filter((b) => !b.model);
    for (let w = 8; w >= 3; w--) {
      for (let i = 0; i + w <= body.length; i++) {
        const run = body.slice(i, i + w);
        const key = run.map((b) => `${b.indent - run[0].indent}|${norm(b.text)}`).join('\n');
        if (!seen.has(key)) seen.set(key, { w, bytes: run.reduce((n, b) => n + (b.bytes || 0), 0), at: [], raw: new Set() });
        const e = seen.get(key);
        // Count only non-overlapping occurrences.
        const prev = e.last?.[s.name];
        if (prev != null && i < prev + w) continue;
        (e.last ||= {})[s.name] = i;
        e.at.push(`${s.name}:${i}`);
        e.raw.add(run.map((b) => b.text).join('\n'));
      }
    }
  }
  const repeats = [...seen.values()]
    .filter((e) => e.at.length >= 2)
    .map((e) => ({ ...e, saving: (e.at.length - 1) * e.bytes }))
    .sort((a, b) => b.saving - a.saving);
  // Keep the best runs that don't overlap lines already covered by a better one.
  const picked = [];
  const covered = new Set();
  for (const r of repeats) {
    if (picked.length >= 3) break;
    const lines = r.at.flatMap((a) => {
      const [fn, i] = a.split(':');
      return Array.from({ length: r.w }, (_, j) => `${fn}:${Number(i) + j}`);
    });
    if (lines.filter((l) => covered.has(l)).length > lines.length / 4) continue;
    lines.forEach((l) => covered.add(l));
    picked.push(r);
  }
  for (const r of picked) {
    const places = [...new Set(r.at.map((a) => a.split(':')[0]))].join(', ');
    const onlyNumbers = r.raw.size > 1;
    out.push({
      kind: 'repeat',
      saving: r.saving,
      plain: `The same ${r.w} steps are repeated ${r.at.length} times (in ${places}). Doing them once, in a loop or a shared function, frees about ${fmtBytes(r.saving)}.`,
      text: `${r.w} statements repeat ${r.at.length} times (in ${places}).${onlyNumbers ? ' They differ only in numbers, so a loop or a shared function with a number parameter can replace them.' : ' A shared function can replace them.'} Saves about ${fmtBytes(r.saving)}.`,
    });
  }

  // 2. Model points copied into a variable and read once.
  const all = analysis.sections.flatMap((s) => s.body.map((b) => b.text));
  const reads = [];
  for (const t of all) {
    const m = t.match(/^([A-Za-z_]\w*)\s*=\s*connmod\.ReadDataTypeRegister\(/);
    if (m) reads.push(m[1]);
  }
  const single = [...new Set(reads)].filter((v) => {
    const uses = all.reduce((n, t) => n + (t.match(new RegExp(`\\b${v}\\b`, 'g'))?.length || 0), 0);
    const assigns = all.filter((t) => new RegExp(`^${v}\\s*=`).test(t)).length;
    return uses - assigns === 1;
  });
  if (single.length) {
    out.push({
      kind: 'single-read',
      saving: single.length * 30,
      plain: `${single.length} model point${single.length > 1 ? 's are' : ' is'} copied into a variable but used only once. Using the point directly where it's needed saves memory.`,
      text: `${single.length} model point${single.length > 1 ? 's are' : ' is'} copied into a variable and read only once (${single.slice(0, 5).join(', ')}${single.length > 5 ? '…' : ''}). Read the point where it is used instead; each removed variable saves its name and its global slot.`,
    });
  }

  // 3. Startup writes that repeat the model's default.
  const startup = analysis.sections.find((s) => s.name === 'runStartup');
  if (startup) {
    let n = 0;
    for (const b of startup.body) {
      if (b.model) continue;
      const m = b.text.match(/^connmod\.WriteDataTypeRegister\(\s*\d+\s*,\s*\d+\s*,\s*(\d+)\s*,\s*(.+)\)$/);
      if (m && analysis.modelDefaults.get(m[1]) === m[2].trim()) n += 1;
    }
    if (n) {
      out.push({
        kind: 'default',
        saving: n * 15,
        plain: `${n} startup step${n > 1 ? 's set' : ' sets'} a model point to the value it already gets by default. ${n > 1 ? 'They' : 'It'} can be deleted.`,
        text: `${n} startup write${n > 1 ? 's set' : ' sets'} a model point to the value its model default already writes. Delete ${n > 1 ? 'them' : 'it'}; about 15 bytes each.`,
      });
    }
  }

  // 4. Loose blocks on the canvas.
  if (analysis.loose?.length) {
    const n = analysis.loose.length;
    const shown = analysis.loose.slice(0, 4).map((t) => (t.length > 24 ? `${t.slice(0, 24)}…` : t)).join(', ');
    out.push({
      kind: 'loose',
      saving: analysis.loose.reduce((sum, t) => sum + lineCost(t).bytes, 0),
      plain: `${n} block${n > 1 ? 's are' : ' is'} lying loose on the canvas, outside Startup and Continuous. ${n > 1 ? 'They' : 'It'} still take${n > 1 ? '' : 's'} memory: delete ${n > 1 ? 'them' : 'it'}.`,
      text: `${n} loose block${n > 1 ? 's' : ''} on the canvas, outside Startup, Continuous and functions (${shown}). ${n > 1 ? 'They still compile' : 'It still compiles'} into the program and ${n > 1 ? 'run' : 'runs'} once at load. Delete ${n > 1 ? 'them' : 'it'}.`,
    });
  }

  // 5. A very large function.
  if (analysis.largest && analysis.largest.bytes > HEAP.largestRan * 0.8) {
    out.push({
      kind: 'split',
      saving: 0,
      plain: `${analysis.largest.name} is very large. Splitting it into two or three smaller functions makes it easier for the controller to load.`,
      text: `${analysis.largest.name} is about ${fmtBytes(analysis.largest.bytes)} on its own. A function this size needs one unbroken piece of heap at load; splitting it into two or three functions lowers that peak.`,
    });
  }
  return out.sort((a, b) => b.saving - a.saving);
}

// ------------------------------------------------------------------------------ real .mpy build

/**
 * Reads a MicroPython .mpy file (version 6) as returned by 75F's py-to-mpy service: the names
 * table and the compiled code of the module and each function. Function code comes in the order
 * the functions are defined, so defOrder (from the Python) names them.
 */
export function parseMpy(bytes, defOrder = []) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u[0] !== 0x4d) throw new Error('Not a .mpy file.');
  if (u[1] !== 6) throw new Error(`.mpy version ${u[1]} isn't supported (expected 6).`);
  let p = 4;
  const uint = () => {
    let v = 0;
    let c;
    do { c = u[p++]; v = (v * 128) + (c & 0x7f); } while (c & 0x80 && p < u.length);
    return v;
  };
  const nQstr = uint();
  const nObj = uint();
  const names = [];
  for (let i = 0; i < nQstr; i++) {
    const l = uint();
    if (l & 1) continue; // a name already built into MicroPython
    const n = l >> 1;
    names.push(new TextDecoder().decode(u.slice(p, p + n)));
    p += n + 1;
  }
  const namesEnd = p;
  // Constant objects (decimal numbers, long strings, big ints, tuples). MicroPython 1.20+ tags
  // them with numbers 0-10; 1.19 used letters. Read past them to reach the code.
  const consts = { count: 0, floats: 0, strings: 0, bytes: 0 };
  const readObj = () => {
    const t = u[p++];
    consts.count += 1;
    const letter = String.fromCharCode(t);
    if (t <= 4 || 'te'.includes(letter)) return; // function table, None, False, True, Ellipsis
    if (t === 10) { const n = uint(); for (let i = 0; i < n; i++) readObj(); return; } // tuple
    const len = uint();
    p += len;
    if (t === 5 || t === 6 || letter === 's' || letter === 'b') p += 1; // trailing NUL
    if (t === 8 || letter === 'f') consts.floats += 1;
    if (t === 5 || letter === 's') consts.strings += 1;
  };
  for (let i = 0; i < nObj; i++) readObj();
  const objectsEnd = p;
  consts.bytes = objectsEnd - namesEnd;
  const rawCode = () => {
    const kl = uint();
    const len = Math.floor(kl / 8);
    const hasChildren = (kl >> 2) & 1;
    p += len;
    const children = [];
    if (hasChildren) {
      const n = uint();
      for (let i = 0; i < n; i++) children.push(rawCode());
    }
    return { len, children };
  };
  const root = rawCode();
  // A clean read ends exactly at the end of the file; anything else means the format differs.
  if (p !== u.length) {
    return { total: u.length, version: u[1], names, namesBytes: namesEnd, objects: nObj, consts, module: null, functions: [], code: null,
      problem: `read ${p} of ${u.length} bytes` };
  }
  const functions = root.children.map((c, i) => ({ name: defOrder[i] || `function ${i + 1}`, bytes: c.len }));
  const code = root.len + functions.reduce((n, f) => n + f.bytes, 0);
  return { total: u.length, version: u[1], names, namesBytes: namesEnd, objects: nObj, consts, module: root.len, functions, code };
}

/** The superloop the Sequencer appends when it builds, if the generated code doesn't have it. */
export function withSuperloop(python, intervalMs = 1000) {
  if (/#+\s*Superloop Section/i.test(python) || /^while True:/m.test(python)) return python;
  return `${python.trimEnd()}\n\n######## Superloop Section ########\nconnmod.EnterSequence()\nrunStartup()\nconnmod.ExitSequence()\nwhile True:\n  connmod.DelayMs(${intervalMs})\n  connmod.EnterSequence()\n  runContinuous()\n  connmod.ExitSequence()\n`;
}

// ------------------------------------------------------------------------------------- helpers

export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  return `${Math.round(n).toLocaleString('en-US')} bytes`;
}

/**
 * Whole estimate. src: { python, blocks, stacks } from the page; readings: stored readings.
 * Without the generated Python it falls back to ~12 bytes per block (measured range 9 to 16).
 */
/**
 * Whole estimate. src: { python, blocks, sequence, mpySize } from the page (mpySize: the .mpy the
 * Sequencer's own build returned, when caught); readings: all stored readings (only this
 * sequence's are used); mpy: a parsed build from the 75F compiler button, if any.
 */
export function estimate(src, readings = [], mpy = null) {
  const blocks = src.blocks ?? 0;
  const own = readingsFor(readings, src.sequence?.key);
  let analysis = null;
  let mpyBytes = null;
  let exactMpy = false;
  let basis;
  if (mpy?.total) { mpyBytes = mpy.total; exactMpy = true; basis = 'the compiled program'; }
  else if (src.mpySize) { mpyBytes = src.mpySize; exactMpy = true; basis = 'the Sequencer\'s last build'; }
  if (src.python) {
    analysis = analyzePython(src.python);
    if (!mpyBytes) { mpyBytes = analysis.mpyEst; basis = 'the generated code'; }
  }
  let total;
  if (mpyBytes) total = trueSizeFromMpy(mpyBytes);
  else {
    // No code: interpolate the measured sequences by block count (rough).
    total = blocks <= 55 ? blocks * 12.5 : 688 + (blocks - 55) * ((6064 - 688) / (942 - 55));
    basis = 'the number of blocks';
  }
  let largest = analysis?.largest ? { name: analysis.largest.name, bytes: analysis.largest.bytes } : null;
  if (mpy?.code != null) {
    const big = mpy.functions.reduce((x, f) => (!x || f.bytes > x.bytes ? f : x), null);
    if (big) largest = { name: big.name, bytes: big.bytes, exact: true };
  }
  const est = { total, maxFree: maxFreeAfterStartup(total), blocks, basis, mpyBytes, exactMpy, largest,
    fromPython: !!src.python, exact: mpy?.code != null ? mpy : null,
    garbagePerRun: analysis?.garbagePerRun ?? null, grows: analysis?.grows ?? [],
    modelPoints: analysis?.modelPoints ?? null };
  return { est, analysis, own, verdict: verdict(est, own), suggestions: analysis ? suggestions(analysis) : [] };
}
