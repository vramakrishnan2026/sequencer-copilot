import { HEAP, estimate, fmtBytes, parseGcLine } from './estimate.js';

/**
 * Memory check view: estimate, verdict, where the space goes, ways to cut, and calibration
 * readings pasted from the controller's GC line. Built with DOM nodes only (no innerHTML).
 */

const READINGS_KEY = 'heapReadings';

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

export function createHeapView(root, { loadSource, getService, onError }) {
  let last = null; // { src, result }

  async function load() {
    root.replaceChildren(el('p', { class: 'hint pad' }, 'Reading the canvas…'));
    try {
      const [src, readings] = await Promise.all([loadSource(), loadReadings()]);
      const result = estimate(src, readings);
      last = { src, result, readings };
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
        ? row(`Model (${analysis.modelPoints} points)`, fmtBytes(est.model), `measured, ${HEAP.modelPerPoint} bytes a point`)
        : null,
      row('Program', `≈ ${fmtBytes(est.program)}`, est.fromPython
        ? (est.scaleReadings ? `scaled ×${est.scale.toFixed(2)} from ${est.scaleReadings} reading${est.scaleReadings > 1 ? 's' : ''}` : 'estimated from the generated Python')
        : 'rough: about 12 bytes a block'),
      row('Sequence total', `≈ ${fmtBytes(est.total)}`, `of about ${fmtBytes(HEAP.budget)} left by the firmware`),
      est.largest ? row('Largest function', `≈ ${fmtBytes(est.largest.bytes)}`, est.largest.name) : null,
      analysis ? row('Variables · functions', `${analysis.variables} · ${analysis.functions}`) : null,
      row('Blocks on canvas', String(est.blocks)),
      !est.fromPython ? el('p', { class: 'note' }, src.reason || 'Generated Python not available.') : null);

    let where = null;
    if (analysis) {
      const parts = analysis.sections
        .map((s) => ({ name: s.name === '(module)' ? 'Module setup and superloop' : s.name, bytes: (s.bytes + s.data) * est.scale }))
        .concat(analysis.names ? [{ name: 'Names (variables and functions)', bytes: analysis.names * est.scale }] : [])
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 8);
      const max = Math.max(...parts.map((p) => p.bytes), 1);
      where = el('section', { class: 'card heap-card' },
        el('h2', {}, 'Where the program space goes'),
        el('p', { class: 'hint' }, 'Model points are counted above, not here.'),
        parts.map((p) => el('div', { class: 'heap-part' },
          el('div', { class: 'heap-part-label' }, el('span', {}, p.name), el('span', { class: 'hint' }, `≈ ${fmtBytes(p.bytes)}`)),
          el('div', { class: 'heap-part-bar' }, el('span', { style: `width:${(p.bytes / max) * 100}%` })))));
    }

    const cuts = el('section', { class: 'card heap-card' },
      el('h2', {}, 'Ways to cut'),
      suggestions.length
        ? el('ol', { class: 'heap-cuts' }, suggestions.map((s) => el('li', {}, s.text)))
        : el('p', { class: 'hint' }, analysis ? 'Nothing obvious found: no repeated runs, single-use model reads or repeated defaults.' : 'Needs the generated Python.'));

    root.replaceChildren(...[verdictCard, numbers, where, cuts, exactCard(), calibrateCard(readings)].filter(Boolean));
  }

  function exactCard() {
    const url = getService();
    if (!url || !last.src.python) return null;
    const out = el('p', { class: 'hint' }, 'Sends the generated Python to your size service and shows the real .mpy size.');
    const btn = el('button', { type: 'button' }, 'Get exact .mpy size');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      out.textContent = 'Asking the service…';
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: last.src.python });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || typeof body.bytes !== 'number') throw new Error(body.error || `The service answered ${res.status}.`);
        last.mpyBytes = body.bytes;
        out.textContent = `.mpy file: ${fmtBytes(body.bytes)}. The file size is not the same as heap use, but tracks it; it is saved with the next reading.`;
      } catch (err) {
        out.textContent = /Failed to fetch/.test(err.message)
          ? 'Could not reach the service. Check its address in Settings.'
          : err.message;
      } finally {
        btn.disabled = false;
      }
    });
    return el('section', { class: 'card heap-card' }, el('h2', {}, 'Exact size'), btn, out);
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
        mpyBytes: last.mpyBytes ?? null,
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
