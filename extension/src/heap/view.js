import { HEAP, bandShares, estimate, fmtBytes, parseGcLines, parseMpy, withSuperloop } from './estimate.js';

/**
 * Memory check view: estimate, verdict, where the space goes, ways to cut, and calibration
 * readings pasted from the controller's GC line. Built with DOM nodes only (no innerHTML).
 */

const READINGS_KEY = 'heapReadings';
const clockOf = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?');

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
  return n;
}

const LEVEL = {
  fits: { label: 'Fits comfortably', cls: 'ok' },
  tight: { label: 'Getting full', cls: 'warn' },
  'too-large': { label: 'Likely too big', cls: 'bad' },
};

// One sentence for a non-specialist, per verdict.
function plainSummary(v) {
  if (v.level === 'fits') return `After it starts, this sequence takes about ${v.share} of the memory the controller has for sequences, and leaves plenty free.`;
  if (v.level === 'tight') return `After it starts, this sequence takes about ${v.share} of the memory the controller has for sequences. It should run, but the free memory left is getting small.`;
  return `After it starts, this sequence would take about ${v.share} of the memory the controller has for sequences. It's likely to stop with a memory error.`;
}

async function loadReadings() {
  const got = await chrome.storage.local.get(READINGS_KEY);
  return Array.isArray(got[READINGS_KEY]) ? got[READINGS_KEY] : [];
}
const saveReadings = (list) => chrome.storage.local.set({ [READINGS_KEY]: list });

export function createHeapView(root, { loadSource, build, onError }) {
  let last = null; // { src, result, readings, mpy }

  async function load() {
    root.replaceChildren(el('p', { class: 'hint pad' }, 'Reading the canvas…'));
    try {
      const [src, readings] = await Promise.all([loadSource(), loadReadings()]);
      // The Sequencer adds its superloop when it builds; include it so the sizes match.
      if (src.python) src.python = withSuperloop(src.python);
      const result = estimate(src, readings);
      last = { src, result, readings, mpy: null };
      render();
      return true;
    } catch (err) {
      root.replaceChildren();
      onError(err);
      return false;
    }
  }

  let showDetails = false;

  function render() {
    const { src, result, readings } = last;
    const { est, analysis, verdict: v, suggestions } = result;
    const lv = LEVEL[v.level];

    // ---------------------------------------------------------------- simple view
    const gaugePct = Math.min(100, Math.round(v.pct * 100));
    const gauge = el('div', { class: 'heap-gauge', role: 'img', 'aria-label': `About ${gaugePct}% of the memory for sequences` },
      el('span', { class: `fill ${lv.cls}`, style: `width:${gaugePct}%` }),
      el('i', { class: 'mark tight', style: `left:${bandShares().tight * 100}%` }),
      el('i', { class: 'mark full', style: `left:${bandShares().tooBig * 100}%` }));
    const measuredLine = v.measured
      ? el('p', { class: v.measured.outcome === 'ran' ? 'heap-measured ok' : 'heap-measured bad' },
        v.measured.outcome === 'ran' ? 'Measured on the controller: it ran.' : 'Measured on the controller: it failed.')
      : null;
    const simple = el('section', { class: `heap-verdict ${lv.cls}`, 'aria-live': 'polite' },
      el('div', { class: 'heap-level' }, lv.label),
      gauge,
      el('div', { class: 'heap-gauge-scale hint' }, el('span', {}, 'Empty'), el('span', {}, `About ${gaugePct}% used`), el('span', {}, 'Full')),
      el('p', {}, plainSummary(v)),
      v.plain.map((t) => el('p', {}, t)),
      measuredLine,
      el('p', { class: 'hint' }, `Worked out from ${v.basis}${v.basis === 'a reading from the controller' || est.exactMpy ? '' : '; an estimate'}.`));

    const todo = suggestions.filter((x) => x.plain).slice(0, 3);
    const actions = todo.length
      ? el('section', { class: 'card heap-card' },
        el('h2', {}, v.level === 'fits' ? 'Ways to save memory' : 'What you can do'),
        el('ol', { class: 'heap-cuts' }, todo.map((x) => el('li', {}, x.plain))))
      : null;

    const toggle = el('button', { type: 'button', class: 'link heap-toggle', 'aria-expanded': String(showDetails) },
      showDetails ? 'Hide details' : 'Show details');
    toggle.addEventListener('click', () => { showDetails = !showDetails; render(); });

    const parts = [simple, actions, exactCard(), toggle];
    if (showDetails) parts.push(...detailCards(src, result, readings));
    root.replaceChildren(...parts.filter(Boolean));
  }

  // -------------------------------------------------------------- technical details
  function detailCards(src, result, readings) {
    const { est, analysis, verdict: v, suggestions } = result;
    const lv = LEVEL[v.level];
    const reasons = el('section', { class: 'card heap-card' },
      el('h2', {}, 'How the verdict was reached'),
      el('ul', { class: 'heap-reasons' }, v.reasons.map((r) => el('li', {}, r))));

    const trueSize = v.trueSize;
    const used = Math.min(1, (HEAP.baseline + trueSize) / HEAP.total);
    const base = HEAP.baseline / HEAP.total;
    const bar = el('div', { class: 'heap-bar', role: 'img', 'aria-label': `About ${Math.round(used * 100)}% of the heap after startup` },
      el('span', { class: 'firmware', style: `width:${base * 100}%` }),
      el('span', { class: `program ${lv.cls}`, style: `width:${Math.max(0, used - base) * 100}%` }));
    const row = (label, value, note) => el('div', { class: 'heap-row' },
      el('span', {}, label), el('strong', {}, value), note ? el('span', { class: 'hint' }, note) : null);
    const fromReading = v.basis === 'a reading from the controller';
    const approx = fromReading || est.exactMpy ? '' : '≈ ';
    const numbers = el('section', { class: 'card heap-card' },
      el('h2', {}, 'Heap after startup'),
      bar,
      el('div', { class: 'heap-legend hint' },
        el('span', {}, el('i', { class: 'sw firmware' }), 'Firmware'),
        el('span', {}, el('i', { class: `sw program ${lv.cls}` }), 'This sequence'),
        el('span', {}, `of ${fmtBytes(HEAP.total)}`)),
      row('Firmware baseline', fmtBytes(HEAP.baseline), 'measured, empty sequence'),
      est.mpyBytes ? row('.mpy size', `${est.exactMpy ? '' : '≈ '}${fmtBytes(est.mpyBytes)}`, est.exactMpy
        ? (est.exact ? 'from the 75F compiler' : 'from the Sequencer\'s last build')
        : 'predicted from the generated code (within ~2% of the 1.22 compiler on 14 test programs)') : null,
      row('True size', `${approx}${fmtBytes(trueSize)}`, fromReading ? 'measured: used after startup, minus the baseline' : est.mpyBytes ? '1.3 × .mpy − 780 (fits the measured sequences within 1.5%)' : 'rough, from the block count'),
      row('Free after startup', `${approx}${fmtBytes(HEAP.budget - trueSize)}`, `of ${fmtBytes(HEAP.budget)} left by the firmware`),
      row('Largest free piece after startup', `${approx}${fmtBytes(v.maxFree)}`, `${Math.round(v.maxFree / HEAP.gcBlock)} blocks; getting full below 220, likely too big below 125`),
      est.modelPoints != null ? row('Model points', String(est.modelPoints)) : null,
      est.largest ? row('Largest function', `${est.largest.exact ? '' : '≈ '}${fmtBytes(est.largest.bytes)}`, `${est.largest.name}${est.largest.exact ? ', compiled' : ''}`) : null,
      analysis ? row('Variables · functions', `${analysis.variables} · ${analysis.functions}`) : null,
      row('Blocks on canvas', String(est.blocks)),
      !est.fromPython ? el('p', { class: 'note' }, src.reason || 'Generated code not available.') : null,
      est.fromPython ? el('p', { class: 'hint' }, {
        build: `Code: the Sequencer's own build at ${clockOf(src.builtAt)}, and the canvas hasn't changed since.`,
        'old-build': `Code: the Sequencer's build at ${clockOf(src.builtAt)}. The canvas has changed since, so build again in the Sequencer for current figures.`,
        generator: 'Code: generated from the live canvas with the Sequencer\'s own generator.',
      }[src.source] || '') : null);

    let where = null;
    if (analysis) {
      const label = (n) => (n === '(module)' ? 'Module setup and superloop' : n);
      const items = (est.exact
        ? [{ name: label('(module)'), bytes: est.exact.module }, ...est.exact.functions]
        : analysis.sections.map((x) => ({ name: label(x.name), bytes: x.bytes + x.data })))
        .concat([{ name: 'Names', bytes: est.exact ? est.exact.namesBytes : analysis.names }])
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 8);
      const max = Math.max(...items.map((p) => p.bytes), 1);
      where = el('section', { class: 'card heap-card' },
        el('h2', {}, 'Where the program space goes'),
        el('p', { class: 'hint' }, est.exact ? 'Compiled code per function, from the 75F compiler.' : 'Estimated code per function. Model register set-up is inside runStartup.'),
        items.map((p) => el('div', { class: 'heap-part' },
          el('div', { class: 'heap-part-label' }, el('span', {}, p.name), el('span', { class: 'hint' }, `${approx}${fmtBytes(p.bytes)}`)),
          el('div', { class: 'heap-part-bar' }, el('span', { style: `width:${(p.bytes / max) * 100}%` })))));
    }

    const cuts = suggestions.length
      ? el('section', { class: 'card heap-card' },
        el('h2', {}, 'Ways to cut, in detail'),
        el('ol', { class: 'heap-cuts' }, suggestions.map((x) => el('li', {}, x.text))))
      : null;

    return [reasons, numbers, where, cuts, calibrateCard(readings, result.own)];
  }

  function exactCard() {
    if (!last.src.python) return null;
    const out = el('p', { class: 'hint' }, last.mpy
      ? `Built ${new Date(last.mpy.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: .mpy file ${fmtBytes(last.mpy.total)} (code ${fmtBytes(last.mpy.code)}, names ${fmtBytes(last.mpy.namesBytes)}${last.mpy.objects ? `, ${last.mpy.objects} constants ${fmtBytes(last.mpy.consts.bytes)}` : ''}). The sizes above now use the compiled code.`
      : 'Compiles this canvas the way the Sequencer does, using your current sign-in, and replaces the estimate with real sizes. Nothing is saved.');
    const btn = el('button', { type: 'button' }, last.mpy ? 'Check again with the 75F compiler' : 'Check with the 75F compiler (more accurate)');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      out.textContent = 'Compiling…';
      try {
        const res = await build(last.src.python);
        const bytes = Uint8Array.from(atob(res.mpyBase64), (c) => c.charCodeAt(0));
        const mpy = parseMpy(bytes, last.result.analysis?.defOrder || []);
        if (mpy.code == null) throw new Error(`Compiled (.mpy ${fmtBytes(mpy.total)}), but the file couldn't be split by function (${mpy.problem || 'unknown layout'}).`);
        last.mpy = { ...mpy, at: new Date().toISOString() };
        last.result = estimate(last.src, last.readings, mpy);
        render();
      } catch (err) {
        btn.disabled = false;
        out.textContent = /Unknown method/.test(err.message) ? 'Reload the Sequencer tab once so the update reaches it, then try again.' : err.message;
      }
    });
    return el('section', { class: 'card heap-card' }, btn, out);
  }

  function calibrateCard(readings, own) {
    const seq = last.src.sequence || null;
    const ta = el('textarea', { id: 'gcLine', rows: '6', 'aria-describedby': 'gcHelp',
      placeholder: 'GC: total: 11968, used: …, free: …\nNo. of 1-blocks: …, max blk sz: …, max free sz: …\n(paste several readings)' });
    const ran = el('input', { type: 'radio', name: 'gcOutcome', value: 'ran', checked: true });
    const failed = el('input', { type: 'radio', name: 'gcOutcome', value: 'failed' });
    const msg = el('p', { class: 'hint', role: 'status' });
    const save = el('button', { type: 'button', class: 'primary' }, 'Save reading');
    save.addEventListener('click', async () => {
      const all = parseGcLines(ta.value);
      if (!all) { msg.textContent = 'Paste the lines that start with "GC: total:".'; return; }
      const est = last.result.est;
      const reading = {
        at: new Date().toISOString(),
        sequence: seq,
        outcome: failed.checked ? 'failed' : 'ran',
        blocks: est.blocks,
        total: est.total,
        largestEst: est.largest?.bytes ?? null,
        largestName: est.largest?.name ?? null,
        exact: !!est.exact,
        gc: all.low,
        gcHigh: all.readings.length > 1 ? all.high : null,
        gcCount: all.readings.length,
        gcSteady: all.steady,
      };
      // One reading per sequence and size: a new one replaces the old.
      const kept = (await loadReadings()).filter((r) => !(seq && r.sequence?.key === seq.key && r.blocks === reading.blocks));
      await saveReadings([reading, ...kept].slice(0, 50));
      await load();
    });

    const item = (r) => el('li', {},
      el('span', { class: r.outcome === 'ran' ? 'outcome-ok' : 'outcome-bad' }, r.outcome === 'ran' ? 'Ran' : 'Failed'),
      el('span', {}, ` · ${new Date(r.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · ${r.blocks} blocks · used ${r.gc.used}${r.gcHigh ? `–${r.gcHigh.used}` : ''}${r.gcCount > 1 ? ` (${r.gcCount} readings${r.gcSteady ? ', steady' : ''})` : ' (1 reading)'}${r.gc.maxBlk != null ? ` · max blk ${r.gc.maxBlk}` : ''}`),
      el('button', { type: 'button', class: 'link', 'aria-label': 'Delete this reading', onclick: async () => {
        await saveReadings((await loadReadings()).filter((x) => x.at !== r.at));
        await load();
      } }, 'Delete'));
    const others = readings.filter((r) => !own.includes(r));
    const groups = new Map();
    for (const r of others) {
      const name = r.sequence?.name || (r.sequence ? 'Unnamed sequence' : 'Saved before sequences were recorded');
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(r);
    }

    return el('section', { class: 'card heap-card' },
      el('h2', {}, 'Add a reading from the controller'),
      el('p', { class: 'hint', id: 'gcHelp' }, `Push this canvas, then paste the GC lines from right after startup and from the end of a run, all together, and say whether it ran. The lowest "used" is kept as the true size; the highest shows one run's temporary data, which isn't a limit. Readings are kept for this sequence${seq?.name ? ` (${seq.name})` : ''} only, in this browser.`),
      ta,
      el('div', { class: 'heap-outcome', role: 'radiogroup', 'aria-label': 'Did it run?' },
        el('label', { class: 'radio' }, ran, el('span', {}, 'It ran')),
        el('label', { class: 'radio' }, failed, el('span', {}, 'It failed'))),
      save, msg,
      own.length ? el('h3', { class: 'heap-sub' }, 'This sequence') : null,
      own.length ? el('ul', { class: 'heap-readings' }, own.map(item)) : null,
      others.length ? el('details', { class: 'heap-others' },
        el('summary', {}, `Other sequences (${others.length})`),
        [...groups].flatMap(([name, list]) => [el('h3', { class: 'heap-sub' }, name), el('ul', { class: 'heap-readings' }, list.map(item))])) : null);
  }

  return { load };
}
