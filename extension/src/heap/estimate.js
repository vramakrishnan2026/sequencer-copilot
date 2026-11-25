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

const FN_OVERHEAD = 40; // code object header, function object, name

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
  const qstrBytes = [...declared].reduce((n, v) => n + v.length + 5 + 8, 0)
    + out.filter((s) => s.kind === 'function').reduce((n, s) => n + s.name.length + 5 + 8, 0);

  const functions = out.filter((s) => s.kind === 'function');
  const program = out.reduce((n, s) => n + s.bytes + s.data, 0) + qstrBytes;
  const largest = functions.reduce((a, s) => (!a || s.bytes > a.bytes ? s : a), null);
  return {
    sections: out,
    functions: functions.length,
    variables: declared.size,
    modelPoints,
    modelDefaults: configured,
    program,
    names: qstrBytes,
    largest: largest ? { name: largest.name, bytes: largest.bytes } : null,
  };
}

// ------------------------------------------------------------------------------ calibration

/** Parses the controller's GC line(s). Returns null if no "GC: total" line is found. */
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

/**
 * Scale factor for the program estimate, from readings whose "max blk sz" shows the largest
 * function (over the firmware's own 800-byte block): measured bytes / estimated bytes.
 */
export function scaleFrom(readings) {
  const xs = readings
    .filter((r) => r.gc?.maxBlk && r.gc.maxBlk * HEAP.gcBlock > HEAP.firmwareBlock + 32 && r.largestEst > 0)
    .map((r) => (r.gc.maxBlk * HEAP.gcBlock) / r.largestEst);
  if (!xs.length) return { k: 1, n: 0 };
  const k = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { k: Math.min(2, Math.max(0.5, k)), n: xs.length };
}

// ------------------------------------------------------------------------------------ verdict

/**
 * est: { total, largest, blocks, fromPython }   total = bytes above the firmware baseline
 * readings: stored readings on this controller type, each { total, largest, blocks, outcome, gc }
 * Returns { level: 'fits'|'tight'|'too-large', confidence, reasons[], limit, tightFrom }.
 */
export function verdict(est, readings = []) {
  const reasons = [];
  const real = readings.filter((r) => r.outcome === 'ran' || r.outcome === 'failed');
  const realBytes = real.filter((r) => typeof r.total === 'number');
  const byBytes = est.fromPython && realBytes.some((r) => r.outcome === 'ran') && realBytes.some((r) => r.outcome === 'failed');

  // With readings of both kinds on this controller, compare estimated bytes. Otherwise compare
  // block counts against the measured loads (block count is a rough predictor).
  // Stored readings hold unscaled estimates, so compare like with like.
  const value = byBytes ? (est.totalRaw ?? est.total) : est.blocks;
  const pts = byBytes
    ? realBytes.map((r) => ({ v: r.total, outcome: r.outcome }))
    : [...SEED_READINGS, ...real.filter((r) => r.blocks)].map((r) => ({ v: r.blocks, outcome: r.outcome }));
  const unit = byBytes ? (n) => fmtBytes(n * (est.scale || 1)) : (n) => `${Math.round(n).toLocaleString('en-US')} blocks`;
  const failed = pts.filter((p) => p.outcome === 'failed').map((p) => p.v);
  const failMin = failed.length ? Math.min(...failed) : Infinity;
  const ran = pts.filter((p) => p.outcome === 'ran' && p.v < failMin).map((p) => p.v);
  const ranMax = ran.length ? Math.max(...ran) : 0;
  const limit = Number.isFinite(failMin) ? (ranMax + failMin) / 2 : ranMax * 1.1;
  const tightFrom = Math.min(ranMax, limit) * 0.9;
  const basis = byBytes
    ? `your ${realBytes.length} reading${realBytes.length > 1 ? 's' : ''} on this controller`
    : 'measured lighting and boiler loads';

  let level = 'fits';
  if (value >= limit) {
    level = 'too-large';
    reasons.push(`Size: ${unit(value)}. Loads failed from ${unit(failMin)} and ran up to ${unit(ranMax)} (${basis}).`);
  } else if (value >= tightFrom) {
    level = 'tight';
    reasons.push(`Size: ${unit(value)}, close to where loads failed (${unit(failMin)}; ran up to ${unit(ranMax)}, ${basis}).`);
  } else {
    reasons.push(`Size: ${unit(value)}. Loads ran up to ${unit(ranMax)} and failed from ${unit(failMin)} (${basis}).`);
  }
  if (est.fromPython && est.total > HEAP.budget) {
    level = 'too-large';
    reasons.push(`The estimate (${fmtBytes(est.total)}) is more than the ${fmtBytes(HEAP.budget)} the firmware leaves for a sequence.`);
  }

  if (est.largest) {
    if (est.largest.bytes > HEAP.largestRan) {
      if (level === 'fits') level = 'tight';
      reasons.push(`Largest function (${est.largest.name}): about ${fmtBytes(est.largest.bytes)}, bigger than any function seen running (${fmtBytes(HEAP.largestRan)}). It needs one unbroken piece of heap when the program loads.`);
    } else {
      reasons.push(`Largest function (${est.largest.name}): about ${fmtBytes(est.largest.bytes)}, within what has run (up to ${fmtBytes(HEAP.largestRan)}).`);
    }
  }

  let confidence = 'low';
  if (byBytes && realBytes.length >= 4) confidence = 'medium';
  else if (byBytes) confidence = 'low to medium';
  return { level, confidence, reasons, byBytes, limit, tightFrom, realReadings: real.length };
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
        text: `${n} startup write${n > 1 ? 's set' : ' sets'} a model point to the value its model default already writes. Delete ${n > 1 ? 'them' : 'it'}; about 15 bytes each.`,
      });
    }
  }

  // 4. A very large function.
  if (analysis.largest && analysis.largest.bytes > HEAP.largestRan * 0.8) {
    out.push({
      kind: 'split',
      saving: 0,
      text: `${analysis.largest.name} is about ${fmtBytes(analysis.largest.bytes)} on its own. A function this size needs one unbroken piece of heap at load; splitting it into two or three functions lowers that peak.`,
    });
  }
  return out.sort((a, b) => b.saving - a.saving);
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
export function estimate(src, readings = []) {
  const blocks = src.blocks ?? 0;
  if (src.python) {
    const a = analyzePython(src.python);
    const { k, n } = scaleFrom(readings);
    const model = a.modelPoints * HEAP.modelPerPoint;
    const program = a.program * k;
    const largest = a.largest ? { name: a.largest.name, bytes: a.largest.bytes * k, raw: a.largest.bytes } : null;
    const est = { total: model + program, totalRaw: model + a.program, model, program, largest, blocks, fromPython: true, scale: k, scaleReadings: n };
    return { est, analysis: a, verdict: verdict(est, readings), suggestions: suggestions(a) };
  }
  const total = blocks * 12;
  const est = { total, model: null, program: total, largest: null, blocks, fromPython: false, scale: 1, scaleReadings: 0 };
  return { est, analysis: null, verdict: verdict(est, readings), suggestions: [] };
}
