import { createEngine, fmt } from './engine.js';

/*
 * The simulator view inside the side panel. Built once; each run only updates readouts, so a
 * fader keeps working while it's being dragged. Text from the canvas is only ever set as text.
 */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}
const pad = (n) => String(n).padStart(2, '0');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function createSimulatorView(root, { loadModel, onError }) {
  let engine = null;
  let model = null;
  let timers = [];
  let running = true;
  let loadedAt = null;
  const strips = new Map();   // input key -> { range, box, readout, toggle }
  const cards = new Map();    // output key -> { card, value, led, meter, tag }

  // ---------------------------------------------------------------- skeleton

  const runLed = el('i', { class: 'sim-runled', 'aria-hidden': 'true' });
  const status = el('span', { class: 'sim-status' });
  const playBtn = el('button', { type: 'button', class: 'sim-btn', onclick: () => setRunning(!running) });
  const stepBtn = el('button', { type: 'button', class: 'sim-btn', title: 'Run one cycle now', onclick: () => cycle() }, 'Step');
  const restartBtn = el('button', { type: 'button', class: 'sim-btn', title: 'Clear variables and outputs, then run startup again', onclick: () => restart() }, 'Restart');
  const inputsGrid = el('div', { class: 'sim-strips' });
  const relays = el('div', { class: 'sim-relays' });
  const meters = el('div', { class: 'sim-meters' });
  const values = el('div', { class: 'sim-values' });
  const varsList = el('dl', { class: 'sim-vars' });
  const traceList = el('ol', { class: 'sim-trace' });
  const notesBox = el('div', { class: 'sim-notes' });
  const foot = el('p', { class: 'sim-foot' });

  root.replaceChildren(
    el('div', { class: 'sim-rack' },
      el('div', { class: 'sim-transport' },
        el('div', { class: 'sim-brand' }, '75F // SEQUENCE SIMULATOR'),
        el('div', { class: 'sim-transport-row' }, runLed, status),
        el('div', { class: 'sim-buttons' }, playBtn, stepBtn, restartBtn)),
      notesBox,
      el('section', { class: 'sim-panel', 'aria-label': 'Simulated inputs' },
        el('h2', { class: 'sim-title' }, 'Inputs', el('span', {}, 'applied on the next run')),
        inputsGrid),
      el('section', { class: 'sim-panel', 'aria-label': 'Simulated outputs' },
        el('h2', { class: 'sim-title' }, 'Outputs'),
        relays, meters, values),
      el('section', { class: 'sim-panel' },
        el('h2', { class: 'sim-title' }, 'Variables'), varsList),
      el('section', { class: 'sim-panel' },
        el('h2', { class: 'sim-title' }, 'Last run'), traceList),
      foot));

  // ---------------------------------------------------------------- inputs

  function addStrip(inp) {
    const r = inp.range;
    const readout = el('div', { class: 'sim-readout' });
    const show = () => { readout.textContent = `${fmt(inp.value)}${r.unit ? ` ${r.unit}` : ''}`; };
    let control;
    let range = null;
    let box = null;
    let toggle = null;
    if (r.toggle) {
      toggle = el('button', { type: 'button', class: 'sim-toggle', 'aria-label': inp.label });
      const paint = () => { const on = inp.value >= 1; toggle.setAttribute('aria-pressed', String(on)); toggle.textContent = on ? 'ON' : 'OFF'; };
      toggle.addEventListener('click', () => { engine.setInput(inp.key, inp.value >= 1 ? 0 : 1); paint(); show(); });
      paint();
      control = el('div', { class: 'sim-track toggle' }, toggle);
    } else {
      range = el('input', { type: 'range', min: r.min, max: r.max, step: r.step, 'aria-label': inp.name ? `${inp.name}, ${inp.label}` : inp.label });
      range.value = String(inp.value);
      box = el('input', { type: 'number', class: 'sim-box', step: 'any', 'aria-label': `${inp.label}, exact value` });
      box.value = String(inp.value);
      range.addEventListener('input', () => { engine.setInput(inp.key, range.value); box.value = range.value; show(); });
      box.addEventListener('change', () => {
        if (box.value.trim() === '' || Number.isNaN(Number(box.value))) { box.value = String(inp.value); return; }
        engine.setInput(inp.key, box.value);
        range.value = box.value; // the fader clamps to its range; the typed value is what's used
        show();
      });
      control = el('div', { class: 'sim-track' }, range);
    }
    show();
    const strip = el('div', { class: 'sim-strip' },
      el('div', { class: 'sim-head' },
        el('div', { class: 'sim-name', title: inp.name ? `${inp.name} (${inp.label})` : inp.label }, inp.name || inp.label),
        inp.name ? el('div', { class: 'sim-hw' }, inp.label) : null),
      control, readout, box,
      r.note ? el('div', { class: 'sim-small' }, r.note) : null);
    inputsGrid.append(strip);
    strips.set(inp.key, { range, box, toggle, show });
  }

  function syncInputs() {
    for (const inp of engine.inputs.values()) if (!strips.has(inp.key)) addStrip(inp);
    if (!engine.inputs.size && !inputsGrid.firstChild) inputsGrid.append(el('p', { class: 'sim-empty' }, 'This sequence reads no inputs.'));
  }

  // ---------------------------------------------------------------- outputs

  function addCard(o) {
    let card;
    const value = el('span', { class: 'sim-value' });
    const tag = el('span', { class: 'sim-tag' });
    const entry = { value, tag };
    if (o.kind === 'relay') {
      entry.led = el('i', { class: 'sim-led', 'aria-hidden': 'true' });
      card = el('div', { class: 'sim-relay' }, entry.led, el('b', {}, o.label), value, tag);
      relays.append(card);
    } else if (o.kind === 'ao') {
      entry.meter = el('i', {});
      card = el('div', { class: 'sim-ao' },
        el('div', { class: 'sim-row' }, el('b', {}, o.label), value),
        el('div', { class: 'sim-meter', 'aria-hidden': 'true' }, entry.meter, el('span', { class: 'sim-ticks' })),
        tag);
      meters.append(card);
    } else {
      card = el('div', { class: 'sim-val' }, el('b', { title: o.label }, o.label), value, tag);
      values.append(card);
    }
    entry.card = card;
    cards.set(o.key, entry);
  }

  function paintOutputs() {
    // New outputs (chosen by a variable) can appear while running: add them in order.
    for (const o of engine.orderedOutputs()) if (!cards.has(o.key)) addCard(o);
    for (const o of engine.outputs.values()) {
      const c = cards.get(o.key);
      if (o.kind === 'relay') {
        c.led.classList.toggle('on', Boolean(o.value));
        c.value.textContent = o.value ? 'ON' : 'OFF';
      } else if (o.kind === 'ao') {
        const v = Number(o.value) || 0;
        c.value.textContent = `${fmt(v)} V`;
        c.meter.style.width = `${Math.max(0, Math.min(100, v * 10))}%`;
      } else {
        c.value.textContent = fmt(o.value);
      }
      const never = o.cycle < 0;
      const held = !never && o.cycle < engine.cycle;
      c.card.classList.toggle('held', held);
      c.card.classList.toggle('never', never);
      c.tag.textContent = never ? 'not written yet' : held ? 'held' : '';
      c.tag.title = held ? 'Not written in the last run, so it keeps its last value, as on the controller.' : '';
    }
    if (!engine.outputs.size && !values.firstChild) values.append(el('p', { class: 'sim-empty' }, 'This sequence writes no outputs.'));
  }

  // ---------------------------------------------------------------- the rest

  function paintVars() {
    const list = [...engine.vars.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
    varsList.replaceChildren(...(list.length
      ? list.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, fmt(v))])
      : [el('p', { class: 'sim-empty' }, 'No variables yet.')]));
  }

  function paintTrace() {
    traceList.replaceChildren(...engine.trace.slice(0, 120).map((t) => el('li', { class: `t-${t.kind}` }, t.text)));
    if (engine.trace.length > 120) traceList.append(el('li', { class: 't-note' }, `… ${engine.trace.length - 120} more steps`));
  }

  function paintNotes() {
    const items = [];
    if (engine.unsupported.size) {
      items.push(el('div', { class: 'sim-note bad' },
        el('b', {}, `${plural(engine.unsupported.size, 'block')} not simulated`),
        el('span', {}, ' (values read as 0, steps skipped): '),
        el('span', {}, [...engine.unsupported.values()].join(' · '))));
    }
    if (model.loose) items.push(el('div', { class: 'sim-note' }, `${plural(model.loose, 'block')} outside startup and continuous never run, so they aren't simulated.`));
    for (const n of engine.notes) items.push(el('div', { class: 'sim-note' }, n));
    notesBox.replaceChildren(...items);
    notesBox.hidden = !items.length;
  }

  function paintStatus() {
    const rates = engine.sections.map((s) => `every ${fmt(s.rate)} s`).join(', ') || 'no continuous block';
    status.textContent = `${running ? 'RUNNING' : 'PAUSED'} · run ${engine.cycle} · ${rates}`;
    playBtn.textContent = running ? 'Pause' : 'Run';
    playBtn.title = running ? 'Stop the cycles; inputs still change' : 'Start the cycles again';
    runLed.classList.toggle('on', running);
  }

  function paint() {
    syncInputs();
    paintOutputs();
    paintVars();
    paintTrace();
    paintNotes();
    paintStatus();
  }

  function cycle(index) {
    engine.tick(index);
    runLed.classList.remove('beat');
    void runLed.offsetWidth; // restart the beat animation
    runLed.classList.add('beat');
    paint();
  }

  function stopTimers() { timers.forEach(clearInterval); timers = []; }
  function startTimers() {
    stopTimers();
    if (!running) return;
    timers = engine.sections.map((s) => setInterval(() => cycle(s.index), s.rate * 1000));
  }
  function setRunning(on) { running = on; startTimers(); paintStatus(); }

  function restart() {
    engine.startup();
    if (engine.sections.length) engine.tick(); // the controller goes straight from startup into continuous
    paint();
    startTimers();
  }

  async function load() {
    stopTimers();
    let next;
    try { next = await loadModel(); } catch (err) { onError?.(err); return false; }
    const previous = engine ? new Map([...engine.inputs].map(([k, v]) => [k, v.value])) : new Map();
    model = next;
    engine = createEngine(model);
    for (const [k, v] of previous) engine.setInput(k, v); // keep the values you'd set, where the input still exists
    strips.clear(); cards.clear();
    inputsGrid.replaceChildren(); relays.replaceChildren(); meters.replaceChildren(); values.replaceChildren();
    loadedAt = new Date();
    foot.textContent = `Read from the canvas at ${pad(loadedAt.getHours())}:${pad(loadedAt.getMinutes())} · ${plural(model.blockCount, 'block')}. `
      + 'After changing the canvas, read it again. The simulator follows the blocks; it is not the controller, so test on a unit before relying on it.';
    restart();
    return true;
  }

  return {
    load,
    pause() { stopTimers(); },
    resume() { if (engine) startTimers(); },
  };
}
