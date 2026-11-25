/**
 * Sequence simulator engine: runs the model the page bridge reads from the canvas
 * (simulatorModel). No DOM, no example-specific behaviour.
 *
 * How it runs, like the device as far as it's known:
 * - startup runs once; each continuous block then runs every cycle at its own rate;
 * - variables keep their values between cycles;
 * - outputs keep their last value until something writes them again (an output a branch forgets
 *   to command is shown as held, not reset);
 * - hardware numbers are stored 0-based (Relay 1 is 0), as on the canvas.
 * Anything it can't model is counted and reported, never guessed.
 */

const MAX_LOOP = 1000;
const MAX_DEPTH = 20;

const isConst = (a) => a && (a.op === 'number' || a.op === 'text' || a.op === 'boolean');
const num = (v) => {
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const fmt = (v) => {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v !== 'number') return String(v);
  if (!Number.isFinite(v)) return '0';
  return String(Math.round(v * 100) / 100);
};

// Slider range for an input, from what the canvas says about it. Every input also takes a typed value.
const QUANTITIES = [
  [/occupan/, { min: 0, max: 1, step: 1, unit: '', start: 0, toggle: true }],
  [/co2/, { min: 0, max: 2000, step: 10, unit: 'ppm', start: 400 }],
  [/humid/, { min: 0, max: 100, step: 1, unit: '%RH', start: 45 }],
  [/temp/, { min: 40, max: 100, step: 0.5, unit: '°F', start: 72 }],
];
const GENERIC = { min: 0, max: 100, step: 1, unit: '', start: 0 };
const quantity = (text) => QUANTITIES.find(([re]) => re.test(text.toLowerCase()))?.[1];

function inputRange(model, inp, key) {
  if (inp.kind === 'ui') {
    // Read through a sensor-type conversion: the fader is the converted reading.
    if (inp.as) return quantity(inp.as) || { ...GENERIC, note: `as ${inp.as}` };
    // A raw reading: its range comes from the input's configured mode, never from its name.
    const mode = (model.uiModes?.[key.split(':')[1]] || '').toLowerCase();
    if (/thermistor|resist/.test(mode)) return { min: 0, max: 25000, step: 10, unit: 'Ω', start: 10000 };
    if (/4.?20|ma\b|current/.test(mode)) return { min: 4, max: 20, step: 0.1, unit: 'mA', start: 4 };
    if (/digital|dry|contact|binary/.test(mode)) return { min: 0, max: 1, step: 1, unit: '', start: 0, toggle: true };
    return { min: 0, max: 10, step: 0.01, unit: 'V', start: 0 };
  }
  if (inp.kind === 'sensor' || inp.kind === 'por') return quantity(inp.sensorText || '') || GENERIC;
  if (inp.kind === 'pi') return { min: 0, max: 100, step: 1, unit: '%', start: 0, note: 'PI maths not simulated: set its output here' };
  return GENERIC;
}

const OUT_ORDER = ['relay', 'ao', 'model-point', 'modbus', 'bacnet', 'hs', 'ui-modbus'];

export function createEngine(model) {
  const inputs = new Map();   // key -> { key, kind, label, range, value }
  const outputs = new Map();  // key -> { key, kind, label, value, cycle }
  const vars = new Map();
  const unsupported = new Map(); // block type -> label
  const notes = new Set();
  const names = new Map();      // input key -> the name the sequence gives it (home screen line or variable)
  let trace = [];
  let cycle = 0;
  let depth = 0;

  // ---------------------------------------------------------------- keys and labels

  function inputKey(a, ch) {
    switch (a.kind) {
      case 'ui': return `ui:${ch}${a.as ? `:${a.as}` : ''}`;
      case 'sensor': case 'por': return `${a.kind}:${ch}:${num(val(a.sensor))}`;
      case 'modbus': return `modbus:${num(val(a.reg))}:${ch}`;
      case 'model-point': return `mp:${a.point}`;
      case 'bacnet': return `bacnet:${a.obj}:${ch}`;
      default: return `${a.kind}:${ch}`;
    }
  }
  function inputLabel(a, ch) {
    if (isConst(a.ch) || a.ch == null) return a.label;
    const names = { ui: 'UI', sensor: 'Sensor bus', por: 'POR bus', pi: 'PI', 'ui-mapping': 'UI mapping' };
    return a.kind === 'ui' || a.kind === 'pi' || a.kind === 'sensor' || a.kind === 'por' ? `${names[a.kind]} ${num(ch) + 1}` : `${a.label} (${ch})`;
  }
  function outKey(s, ch) {
    switch (s.kind) {
      case 'model-point': return `mp:${s.point}`;
      case 'modbus': return `modbus:${num(val(s.reg))}:${ch}`;
      case 'bacnet': return `bacnet:${s.obj}:${ch}`;
      default: return `${s.kind}:${ch}`;
    }
  }
  function outLabel(s, ch) {
    switch (s.kind) {
      case 'relay': return `Relay ${num(ch) + 1}`;
      case 'ao': return `AO ${num(ch) + 1}`;
      case 'hs': return `Home screen ${ch}${model.screens?.[ch] ? ` · ${model.screens[ch]}` : ''}`;
      case 'ui-modbus': return `UI ${num(ch) + 1} Modbus register`;
      case 'modbus': case 'bacnet': return isConst(s.ch) ? s.label : `${s.label} (${ch})`;
      default: return s.label || s.kind;
    }
  }

  function ensureInput(a, ch) {
    const key = inputKey(a, ch);
    if (!inputs.has(key)) {
      const sensorText = a.sensor?.text || '';
      const range = inputRange(model, { ...a, sensorText }, key);
      inputs.set(key, { key, kind: a.kind, label: inputLabel(a, ch), name: names.get(key) || '', range, value: range.start });
    }
    return inputs.get(key);
  }
  function ensureOutput(s, ch) {
    const key = outKey(s, ch);
    if (!outputs.has(key)) outputs.set(key, { key, kind: s.kind, label: outLabel(s, ch), value: s.kind === 'relay' ? false : 0, cycle: -1 });
    return outputs.get(key);
  }

  // ---------------------------------------------------------------- values

  function skip(type, label) {
    if (!unsupported.has(type)) unsupported.set(type, label || type);
  }

  function val(a) {
    if (!a) return 0;
    switch (a.op) {
      case 'number': case 'boolean': case 'text': return a.value;
      case 'var': return vars.has(a.name) ? vars.get(a.name) : 0;
      case 'input': {
        const ch = a.ch ? num(val(a.ch)) : '';
        return ensureInput(a, ch).value;
      }
      case 'readback': {
        const o = outputs.get(`${a.kind}:${num(val(a.ch))}`);
        return o ? num(o.value) : 0;
      }
      case 'arith': {
        const x = num(val(a.a));
        const y = num(val(a.b));
        switch (a.operator) {
          case 'ADD': return x + y;
          case 'MINUS': return x - y;
          case 'MULTIPLY': return x * y;
          case 'DIVIDE': if (y === 0) { notes.add('Division by zero gave 0 here; check what the device does.'); return 0; } return x / y;
          case 'POWER': return x ** y;
          case 'MODULO': return y === 0 ? 0 : x % y;
          default: skip(`arith ${a.operator}`); return 0;
        }
      }
      case 'compare': {
        let x = val(a.a);
        let y = val(a.b);
        if (typeof x !== 'string' || typeof y !== 'string') { x = num(x); y = num(y); }
        switch (a.operator) {
          case 'EQ': return x === y;
          case 'NEQ': return x !== y;
          case 'LT': return x < y;
          case 'LTE': return x <= y;
          case 'GT': return x > y;
          case 'GTE': return x >= y;
          default: skip(`compare ${a.operator}`); return false;
        }
      }
      case 'logic': return a.operator === 'OR' ? Boolean(val(a.a)) || Boolean(val(a.b)) : Boolean(val(a.a)) && Boolean(val(a.b));
      case 'not': return !val(a.value);
      case 'ternary': return val(a.test) ? val(a.then) : val(a.else);
      case 'single': {
        const x = num(val(a.value));
        const fns = { ROOT: Math.sqrt, ABS: Math.abs, NEG: (n) => -n, LN: Math.log, LOG10: Math.log10, EXP: Math.exp, POW10: (n) => 10 ** n };
        if (fns[a.operator]) return fns[a.operator](x);
        skip(`math ${a.operator}`); return x;
      }
      case 'round': {
        const x = num(val(a.value));
        return a.operator === 'ROUNDUP' ? Math.ceil(x) : a.operator === 'ROUNDDOWN' ? Math.floor(x) : Math.round(x);
      }
      case 'constrain': return Math.min(Math.max(num(val(a.value)), num(val(a.low))), num(val(a.high)));
      case 'scale': {
        const x = num(val(a.value));
        const [i0, i1, o0, o1] = [a.inMin, a.inMax, a.outMin, a.outMax].map((n) => num(val(n)));
        return i1 === i0 ? o0 : o0 + ((x - i0) * (o1 - o0)) / (i1 - i0);
      }
      case 'unsupported': skip(a.type, a.label); return 0;
      default: skip(a.op); return 0;
    }
  }

  // ---------------------------------------------------------------- statements

  function run(list) {
    for (const s of list || []) exec(s);
  }

  function exec(s) {
    switch (s.type) {
      case 'set': {
        const v = val(s.value);
        vars.set(s.name, v);
        trace.push({ kind: 'set', text: `${s.name} = ${fmt(v)}` });
        break;
      }
      case 'change': {
        const v = num(vars.get(s.name)) + num(val(s.value));
        vars.set(s.name, v);
        trace.push({ kind: 'set', text: `${s.name} changed to ${fmt(v)}` });
        break;
      }
      case 'out': {
        const ch = s.ch ? num(val(s.ch)) : '';
        const o = ensureOutput(s, ch);
        let v = val(s.value);
        if (s.kind === 'relay') v = typeof v === 'string' ? /^(on|1|true)$/i.test(v.trim()) : num(v) !== 0;
        else if (typeof v !== 'string') v = num(v);
        o.value = v;
        o.cycle = cycle;
        trace.push({ kind: 'out', text: `${o.label} = ${s.kind === 'relay' ? (v ? 'ON' : 'OFF') : fmt(v)}${s.kind === 'ao' ? ' V' : ''}` });
        break;
      }
      case 'if': {
        let taken = false;
        for (const [i, br] of s.branches.entries()) {
          const ok = Boolean(val(br.test));
          trace.push({ kind: 'if', text: `${i === 0 ? 'If' : 'Else if'} ${br.label || '…'}: ${ok ? 'yes' : 'no'}` });
          if (ok) { run(br.body); taken = true; break; }
        }
        if (!taken && s.else) { trace.push({ kind: 'if', text: 'Else' }); run(s.else); }
        break;
      }
      case 'repeat': {
        const n = Math.max(0, Math.floor(num(val(s.times))));
        for (let i = 0; i < Math.min(n, MAX_LOOP); i++) run(s.body);
        if (n > MAX_LOOP) notes.add(`A repeat loop asked for ${n} passes; the simulator stopped at ${MAX_LOOP}.`);
        break;
      }
      case 'for': {
        const from = num(val(s.from));
        const to = num(val(s.to));
        const by = Math.abs(num(val(s.by))) || 1;
        const up = from <= to;
        let n = 0;
        for (let i = from; up ? i <= to : i >= to; i += up ? by : -by) {
          if (++n > MAX_LOOP) { notes.add(`A count loop ran over ${MAX_LOOP} passes; stopped.`); break; }
          vars.set(s.name, i);
          run(s.body);
        }
        break;
      }
      case 'while': {
        let n = 0;
        while (s.until ? !val(s.test) : Boolean(val(s.test))) {
          if (++n > MAX_LOOP) { notes.add(`A repeat-while loop never ended within ${MAX_LOOP} passes. On the controller this would stall the sequence.`); break; }
          run(s.body);
        }
        break;
      }
      case 'delay':
        trace.push({ kind: 'note', text: `Wait ${fmt(num(val(s.value)))} ms (not timed in the simulator)` });
        notes.add('Delays are noted in the trace but not timed.');
        break;
      case 'call': {
        const fn = model.functions?.[s.name];
        if (!fn) { skip(`call:${s.name}`, `Run ${s.name} (function not found)`); break; }
        if (depth >= MAX_DEPTH) { notes.add(`Function ${s.name} calls itself too deeply; stopped.`); break; }
        // Parameters act as the function's own variables: set for the call, restored afterwards.
        const saved = fn.params.map((p) => [p, vars.has(p), vars.get(p)]);
        const values = fn.params.map((_, i) => val(s.args[i]));
        fn.params.forEach((p, i) => vars.set(p, values[i]));
        trace.push({ kind: 'call', text: `Run ${s.name}${fn.params.length ? ` (${fn.params.map((p, i) => `${p} = ${fmt(values[i])}`).join(', ')})` : ''}` });
        depth++;
        try { run(fn.body); } finally {
          depth--;
          for (const [p, had, v] of saved) { if (had) vars.set(p, v); else vars.delete(p); }
        }
        break;
      }
      case 'unsupported':
        skip(s.blockType, s.label);
        trace.push({ kind: 'skip', text: `Skipped: ${s.label}` });
        break;
      default:
        skip(s.type);
    }
  }

  // ---------------------------------------------------------------- discovery
  // Inputs and outputs with fixed channels are listed before anything runs; ones chosen by a
  // variable (a loop, a function parameter) appear the first time they're used.

  function discover(list) {
    const visitValue = (a) => {
      if (!a || typeof a !== 'object') return;
      if (a.op === 'input' && (a.ch == null || isConst(a.ch)) && (a.sensor == null || isConst(a.sensor)) && (a.reg == null || isConst(a.reg))) {
        ensureInput(a, a.ch ? num(a.ch.value) : '');
      }
      for (const v of Object.values(a)) if (v && typeof v === 'object') visitValue(v);
    };
    const visit = (s) => {
      if (!s) return;
      if (s.type === 'out' && (s.ch == null || isConst(s.ch)) && (s.reg == null || isConst(s.reg))) ensureOutput(s, s.ch ? num(s.ch.value) : '');
      for (const [k, v] of Object.entries(s)) {
        if (Array.isArray(v)) v.forEach((x) => (x && x.type ? visit(x) : x?.body ? (visitValue(x.test), x.body.forEach(visit)) : visitValue(x)));
        else if (v && typeof v === 'object' && k !== 'body') visitValue(v);
      }
    };
    list.forEach(visit);
  }
  // ---------------------------------------------------------------- names
  // An input is called what the sequence calls it: the home-screen line that shows it, else the
  // variable it's stored in ("set H2 to UI 1"). Only when that variable holds just this one input.

  function inputsIn(a, out = []) {
    if (!a || typeof a !== 'object') return out;
    if (a.op === 'input') { if ((a.ch == null || isConst(a.ch)) && (a.sensor == null || isConst(a.sensor)) && (a.reg == null || isConst(a.reg))) out.push(inputKey(a, a.ch ? num(a.ch.value) : '')); return out; }
    for (const v of Object.values(a)) if (v && typeof v === 'object') inputsIn(v, out);
    return out;
  }
  function soleInput(a) {
    const keys = [...new Set(inputsIn(a))];
    return keys.length === 1 && !JSON.stringify(a).includes('"op":"var"') ? keys[0] : null;
  }
  function eachStatement(list, fn) {
    for (const s of list || []) {
      fn(s);
      if (s.body) eachStatement(s.body, fn);
      if (s.branches) s.branches.forEach((b) => eachStatement(b.body, fn));
      if (s.else) eachStatement(s.else, fn);
    }
  }
  function nameInputs() {
    const all = [model.startup, ...(model.continuous || []).map((c) => c.body), ...Object.values(model.functions || {}).map((f) => f.body)];
    const fromVar = new Map();   // variable -> input key
    const byVar = new Map();     // input key -> variable name
    const byScreen = new Map();  // input key -> home-screen line name
    for (const list of all) eachStatement(list, (s) => {
      if (s.type !== 'set') return;
      const key = soleInput(s.value);
      if (!key) return;
      if (!fromVar.has(s.name)) fromVar.set(s.name, key);
      if (!byVar.has(key)) byVar.set(key, s.name);
    });
    for (const list of all) eachStatement(list, (s) => {
      if (s.type !== 'out' || s.kind !== 'hs' || !isConst(s.ch)) return;
      const screen = model.screens?.[s.ch.value];
      if (!screen) return;
      const key = s.value?.op === 'var' ? fromVar.get(s.value.name) : soleInput(s.value);
      if (key && !byScreen.has(key)) byScreen.set(key, screen);
    });
    for (const [key, name] of byVar) names.set(key, name);
    for (const [key, name] of byScreen) names.set(key, name);
  }
  nameInputs();

  discover(model.startup || []);
  for (const c of model.continuous || []) discover(c.body);
  for (const f of Object.values(model.functions || {})) discover(f.body);

  // ---------------------------------------------------------------- API

  function begin() {
    trace = [];
    notes.delete('Delays are noted in the trace but not timed.');
  }

  return {
    inputs, outputs, vars, unsupported, notes,
    get trace() { return trace; },
    get cycle() { return cycle; },
    sections: (model.continuous || []).map((c, i) => ({ index: i, title: c.title, rate: Math.max(0.25, num(val(c.rate)) || 1) })),

    /** Clears variables and outputs, then runs startup once. */
    startup() {
      vars.clear();
      for (const o of outputs.values()) { o.value = o.kind === 'relay' ? false : 0; o.cycle = -1; }
      cycle = 0;
      begin();
      trace.push({ kind: 'head', text: 'On startup' });
      run(model.startup);
    },

    /** One pass of a continuous block (all of them when no index is given). */
    tick(index) {
      cycle++;
      begin();
      const list = index == null ? model.continuous || [] : [model.continuous[index]];
      for (const c of list) {
        trace.push({ kind: 'head', text: c.title });
        run(c.body);
      }
    },

    setInput(key, value) {
      const inp = inputs.get(key);
      if (inp) inp.value = num(value);
    },

    /** Outputs in a stable order: relays, analog outputs, then the rest. */
    orderedOutputs() {
      return [...outputs.values()].sort((a, b) => OUT_ORDER.indexOf(a.kind) - OUT_ORDER.indexOf(b.kind) || a.label.localeCompare(b.label, undefined, { numeric: true }));
    },
  };
}
