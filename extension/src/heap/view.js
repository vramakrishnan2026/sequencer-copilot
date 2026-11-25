import { HEAP, estimate, fmtBytes, parseGcLine, parseMpy, withSuperloop } from './estimate.js';

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
  fits: { label: 'Fits', cls: 'ok' },
  tight: { label: 'Tight', cls: 'warn' },
  'too-large': { label: 'Likely too large', cls: 'bad' },
};

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

  function render() {
    const { src, result, readings } = last;
    const { est, analysis, verdict: v, suggestions } = result;
    const lv = LEVEL[v.level];

    const verdictCard = el('section', { class: `heap-verdict ${lv.cls}`, 'aria-live': 'polite' },
      el('div', { class: 'heap-level' }, lv.label),
      el('p', { class: 'hint' }, `An estimate, ${v.confidence} confidence. ${v.realReadings
        ? `Uses ${v.realReadings} reading${v.realReadings > 1 ? 's' : ''} from your controller.`
        : 'Add a reading from your controller below to make it sharper.'}`),
      el('ul', { class: 'heap-reasons' }, v.reasons.map((r) => el('li', {}, r))));

    const used = Math.min(1, (HEAP.baseline + est.total) / HEAP.total);
    const base = HEAP.baseline / HEAP.total;
    const bar = el('div', { class: 'heap-bar', role: 'img', 'aria-label': `About ${Math.round(used * 100)}% of the heap` },
      el('span', { class: 'firmware', style: `width:${base * 100}%` }),
      el('span', { class: `program ${lv.cls}`, style: `width:${Math.max(0, used - base) * 100}%` }));

    const row = (label, value, note) => el('div', { class: 'heap-row' },
      el('span', {}, label), el('strong', {}, value), note ? el('span', { class: 'hint' }, note) : null);
    const numbers = el('section', { class: 'card heap-card' },
      el('h2', {}, 'Estimated heap use'),
      bar,
      el('div', { class: 'heap-legend hint' },
        el('span', {}, el('i', { class: 'sw firmware' }), 'Firmware'),
        el('span', {}, el('i', { class: `sw program ${lv.cls}` }), 'This sequence'),
        el('span', {}, `of ${fmtBytes(HEAP.total)}`)),
      row('Firmware baseline', fmtBytes(HEAP.baseline), 'measured, empty sequence'),
      est.model != null
        ? row(`Model (${analysis.modelPoints} point${analysis.modelPoints === 1 ? '' : 's'})`, fmtBytes(est.model), `measured, ${HEAP.modelPerPoint} bytes a point`)
        : null,
      row('Program', `${est.exact ? '' : '≈ '}${fmtBytes(est.program)}`, est.exact
        ? 'compiled code from the 75F compiler, plus names'
        : est.fromPython
          ? (est.scaleReadings ? `scaled ×${est.scale.toFixed(2)} from ${est.scaleReadings} reading${est.scaleReadings > 1 ? 's' : ''}` : 'estimated from the generated Python')
          : 'rough: about 12 bytes a block'),
      row('Sequence total', `≈ ${fmtBytes(est.total)}`, `of about ${fmtBytes(HEAP.budget)} left by the firmware`),
      est.largest ? row('Largest function', `${est.largest.exact ? '' : '≈ '}${fmtBytes(est.largest.bytes)}`, `${est.largest.name}${est.largest.exact ? ', compiled' : ''}`) : null,
      analysis ? row('Variables · functions', `${analysis.variables} · ${analysis.functions}`) : null,
      row('Blocks on canvas', String(est.blocks)),
      !est.fromPython ? el('p', { class: 'note' }, src.reason || 'Generated Python not available.') : null,
      est.fromPython ? el('p', { class: 'hint' }, {
        build: `Code: the Sequencer's own build at ${clockOf(src.builtAt)}, and the canvas hasn't changed since.`,
        'old-build': `Code: the Sequencer's build at ${clockOf(src.builtAt)}. The canvas has changed since, so build again in the Sequencer for current figures.`,
        generator: 'Code: generated from the live canvas with the Sequencer\'s own generator.',
      }[src.source] || '') : null);

    let where = null;
    if (analysis) {
      const label = (n) => (n === '(module)' ? 'Module setup and superloop' : n);
      const parts = (est.exact
        ? [{ name: label('(module)'), bytes: est.exact.module }, ...est.exact.functions]
        : analysis.sections.map((s) => ({ name: label(s.name), bytes: (s.bytes + s.data) * est.scale })))
        .concat(analysis.names ? [{ name: 'Names (variables and functions)', bytes: analysis.names * est.scale }] : [])
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 8);
      const max = Math.max(...parts.map((p) => p.bytes), 1);
      where = el('section', { class: 'card heap-card' },
        el('h2', {}, 'Where the program space goes'),
        el('p', { class: 'hint' }, est.exact ? 'Compiled code per function, from the 75F compiler.' : 'Estimated. Model points are counted above, not here.'),
        parts.map((p) => el('div', { class: 'heap-part' },
          el('div', { class: 'heap-part-label' }, el('span', {}, p.name), el('span', { class: 'hint' }, `${est.exact ? '' : '≈ '}${fmtBytes(p.bytes)}`)),
          el('div', { class: 'heap-part-bar' }, el('span', { style: `width:${(p.bytes / max) * 100}%` })))));
    }

    const cuts = el('section', { class: 'card heap-card' },
      el('h2', {}, 'Ways to cut'),
      suggestions.length
        ? el('ol', { class: 'heap-cuts' }, suggestions.map((s) => el('li', {}, s.text)))
        : el('p', { class: 'hint' }, analysis ? 'Nothing obvious found: no repeated runs, single-use model reads, repeated defaults or loose blocks.' : 'Needs the generated code: build the sequence once in the Sequencer, then read the canvas again (↻).'));

    root.replaceChildren(...[verdictCard, numbers, where, cuts, exactCard(), calibrateCard(readings)].filter(Boolean));
  }

  function exactCard() {
    if (!last.src.python) return null;
    const out = el('p', { class: 'hint' }, last.mpy
      ? `Built ${new Date(last.mpy.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: .mpy file ${fmtBytes(last.mpy.total)} (code ${fmtBytes(last.mpy.code)}, names ${fmtBytes(last.mpy.namesBytes)}). The sizes above now use the compiled code.`
      : 'Compiles this canvas with 75F\'s py-to-mpy service, the compiler the Sequencer itself uses, with your current sign-in. Nothing is saved there, and the result replaces the estimates above with real code sizes.');
    const btn = el('button', { type: 'button' }, last.mpy ? 'Build again' : 'Get exact sizes from the 75F compiler');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      out.textContent = 'Compiling…';
      try {
        const res = await build(last.src.python);
        const bytes = Uint8Array.from(atob(res.mpyBase64), (c) => c.charCodeAt(0));
        const mpy = parseMpy(bytes, last.result.analysis?.defOrder || []);
        if (mpy.code == null) throw new Error(`Compiled (.mpy ${fmtBytes(mpy.total)}), but it holds constant objects this version can't split by function yet.`);
        last.mpy = { ...mpy, at: new Date().toISOString() };
        last.result = estimate(last.src, last.readings, mpy);
        render();
      } catch (err) {
        btn.disabled = false;
        out.textContent = /Unknown method/.test(err.message) ? 'Reload the Sequencer tab once so the update reaches it, then try again.' : err.message;
      }
    });
    return el('section', { class: 'card heap-card' }, el('h2', {}, 'Exact sizes'), btn, out);
  }

  function calibrateCard(readings) {
    const ta = el('textarea', { id: 'gcLine', rows: '3', 'aria-describedby': 'gcHelp',
      placeholder: 'GC: total: 11968, used: …, free: …\nNo. of 1-blocks: …, max blk sz: …, max free sz: …' });
    const ran = el('input', { type: 'radio', name: 'gcOutcome', value: 'ran', checked: true });
    const failed = el('input', { type: 'radio', name: 'gcOutcome', value: 'failed' });
    const msg = el('p', { class: 'hint', role: 'status' });
    const save = el('button', { type: 'button', class: 'primary' }, 'Save reading');
    save.addEventListener('click', async () => {
      const gc = parseGcLine(ta.value);
      if (!gc) { msg.textContent = 'Paste the line that starts with "GC: total:".'; return; }
      const a = last.result.analysis;
      const reading = {
        at: new Date().toISOString(),
        outcome: failed.checked ? 'failed' : 'ran',
        blocks: last.result.est.blocks,
        // Unscaled estimates, so later scale changes don't feed back into the readings.
        total: a ? a.modelPoints * HEAP.modelPerPoint + a.program : null,
        largestEst: a?.largest?.bytes ?? null,
        largestName: a?.largest?.name ?? null,
        mpy: last.mpy ? { total: last.mpy.total, code: last.mpy.code, largest: last.result.est.largest?.bytes ?? null } : null,
        gc,
      };
      const list = [reading, ...(await loadReadings())].slice(0, 50);
      await saveReadings(list);
      await load();
    });
    const list = readings.length
      ? el('ul', { class: 'heap-readings' }, readings.map((r, i) => el('li', {},
        el('span', { class: r.outcome === 'ran' ? 'outcome-ok' : 'outcome-bad' }, r.outcome === 'ran' ? 'Ran' : 'Failed'),
        el('span', {}, ` · ${new Date(r.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · ${r.blocks} blocks · used ${r.gc.used}, free ${r.gc.free}${r.gc.maxBlk != null ? `, max blk ${r.gc.maxBlk}` : ''}`),
        el('button', { type: 'button', class: 'link', 'aria-label': 'Delete this reading', onclick: async () => {
          const next = (await loadReadings()).filter((_, j) => j !== i);
          await saveReadings(next);
          await load();
        } }, 'Delete'))))
      : null;
    return el('section', { class: 'card heap-card' },
      el('h2', {}, 'Add a reading from the controller'),
      el('p', { class: 'hint', id: 'gcHelp' }, 'Load this canvas on the controller, paste the GC lines it prints, and say whether the sequence ran. Readings are kept in this browser and sharpen the estimate.'),
      ta,
      el('div', { class: 'heap-outcome', role: 'radiogroup', 'aria-label': 'Did it run?' },
        el('label', { class: 'radio' }, ran, el('span', {}, 'It ran')),
        el('label', { class: 'radio' }, failed, el('span', {}, 'It failed'))),
      save, msg,
      readings.length ? el('h3', { class: 'heap-sub' }, 'Saved readings') : null,
      list);
  }

  return { load };
}
