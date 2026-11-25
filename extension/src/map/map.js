import { diffGraphs, focusOnChanges, hasChanges, palette, toMermaid } from './graph.js';
import { diffFlow, flowCounts, toFlowMermaid } from './flow.js';

/*
 * The side panel captures the graph (from the canvas, or from a plan's dry run) into session
 * storage and opens this tab with its key in the URL hash. The map is a snapshot: it does not
 * follow later edits on the canvas.
 */

const $ = (id) => document.getElementById(id);
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
const pad = (n) => String(n).padStart(2, '0');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

const view = { x: 0, y: 0, k: 1, w: 0, h: 0 };
let source = '';
let entry = null;
let scope = 'changes';
let viewMode = 'flow';

// ---------------------------------------------------------------- sidebar

function renderAside(graph) {
  const runs = $('runs');
  runs.replaceChildren(el('h2', {}, 'What runs'));
  const facts = el('dl', { class: 'facts' });
  if (graph.setup.model) facts.append(el('dt', {}, 'Model'), el('dd', {}, graph.setup.model));
  if (graph.sections.length) facts.append(el('dt', {}, 'Runs'), el('dd', {}, graph.sections.map((s, i) => [i ? el('br') : null, s]).flat()));
  facts.append(el('dt', {}, 'Blocks'), el('dd', {}, String(graph.blockCount)));
  runs.append(facts);
  if (graph.loose) {
    runs.append(el('p', { class: 'note bad' },
      `${plural(graph.loose, 'block')} ${graph.loose === 1 ? 'sits' : 'sit'} outside startup and continuous, so ${graph.loose === 1 ? 'it' : 'they'} never ${graph.loose === 1 ? 'runs' : 'run'}. ${graph.diff && graph.loose > (graph.looseBefore || 0) ? 'This change adds some of them: check it connects its new blocks.' : 'They are not shown on the map.'}`));
  }

  const su = graph.setup;
  const groups = [
    ['Universal inputs', su.inputs],
    ['Modbus registers', su.registers],
    ['Home screen', su.screens],
    ['BACnet objects', su.bacnet],
    ['Other', su.other],
  ].filter(([, list]) => list.length);
  const setup = $('setup');
  setup.replaceChildren();
  if (groups.length || su.initialised.length) {
    setup.append(el('h2', {}, 'Set up at startup'));
    for (const [name, list] of groups) setup.append(el('details', {}, el('summary', {}, `${name} (${list.length})`), el('ul', {}, list.map((t) => el('li', {}, t)))));
    if (su.initialised.length) setup.append(el('details', {}, el('summary', {}, `Starting values (${su.initialised.length})`), el('ul', {}, su.initialised.map((t) => el('li', {}, t)))));
  }

  const at = new Date(entry.capturedAt);
  $('captured').textContent = `Captured at ${pad(at.getHours())}:${pad(at.getMinutes())}. The map doesn't follow later edits: open it again from the side panel.`;
}

// ---------------------------------------------------------------- drawing

function applyView(ease = false) {
  const c = $('canvas');
  c.classList.toggle('easing', ease);
  c.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
}

function fit(ease = true) {
  const stage = $('stage').getBoundingClientRect();
  if (!view.w || !view.h) return;
  const k = Math.min((stage.width - 48) / view.w, (stage.height - 48) / view.h, 1.4);
  view.k = Math.max(k, 0.05);
  view.x = (stage.width - view.w * view.k) / 2;
  view.y = (stage.height - view.h * view.k) / 2;
  applyView(ease);
}

function zoomAt(factor, px, py) {
  const k = Math.min(Math.max(view.k * factor, 0.05), 4);
  view.x = px - (px - view.x) * (k / view.k);
  view.y = py - (py - view.y) * (k / view.k);
  view.k = k;
  applyView();
}

function zoomCentre(factor) {
  const r = $('stage').getBoundingClientRect();
  zoomAt(factor, r.width / 2, r.height / 2);
}

function showEmpty(title, ...lines) {
  $('canvas').replaceChildren();
  const box = $('empty');
  box.replaceChildren(el('h2', {}, title), ...lines);
  box.hidden = false;
}

let renderCount = 0;
async function draw(graph) {
  $('empty').hidden = true;
  const isFlow = viewMode === 'flow';
  source = isFlow ? toFlowMermaid(graph, { dark }) : toMermaid(graph, { dark });
  const empty = isFlow ? !graph.sections.length : !graph.nodes.length;
  if (empty && isFlow) {
    showEmpty('Nothing runs yet', el('p', { class: 'hint' }, 'There is no startup or continuous block on this canvas, so nothing would run. Blocks outside them are counted on the left.'));
    return;
  }
  if (empty) {
    showEmpty('Nothing to draw yet', el('p', { class: 'hint' }, 'This sequence has no outputs, writes or variables that read anything. Once it sets an output or writes a register, it appears here.'));
    return;
  }
  if (!window.mermaid) {
    showEmpty('The diagram library is missing',
      el('p', { class: 'hint' }, 'The file lib/mermaid.min.js is not in the extension folder. Reinstall the extension from its zip. Meanwhile, Copy as Mermaid gives you the diagram text for any Mermaid editor.'));
    return;
  }
  try {
    const { svg } = await window.mermaid.render(`map${++renderCount}`, source);
    // Mermaid's HTML labels (<br>) aren't well-formed XML, so parse the SVG as HTML.
    const holder = document.createElement('div');
    holder.innerHTML = svg; // produced by Mermaid in strict mode, which sanitises every label
    const node = holder.querySelector('svg');
    const vb = node.viewBox?.baseVal;
    view.w = vb?.width || 800;
    view.h = vb?.height || 600;
    node.setAttribute('width', view.w);
    node.setAttribute('height', view.h);
    node.style.maxWidth = 'none';
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', isFlow ? 'Flowchart of the sequence, in running order.' : `Signal map: ${graph.nodes.length} items, ${graph.edges.length} connections.`);
    $('canvas').replaceChildren(node);
    fit(false);
    if (isFlow && entry.kind === 'change') focusFirstChange(node);
  } catch (err) {
    showEmpty('The map could not be drawn',
      el('p', { class: 'hint' }, `Mermaid reported: ${err?.message || err}. Copy as Mermaid and send the text to the extension's maintainer.`),
      el('pre', {}, source));
  }
}

// In a long flowchart, start on the first highlighted step rather than the whole, tiny picture.
function focusFirstChange(svg) {
  const hit = svg.querySelector('g.node.added, g.node.changed');
  if (!hit) return;
  const stageBox = $('stage').getBoundingClientRect();
  const box = hit.getBoundingClientRect();
  const cx = (box.left + box.width / 2 - stageBox.left - view.x) / view.k;
  const cy = (box.top + box.height / 2 - stageBox.top - view.y) / view.k;
  if (view.k >= 0.55) return; // the whole chart is readable as it is: keep the context
  view.k = 1;
  view.x = stageBox.width / 2 - cx;
  view.y = stageBox.height * 0.45 - cy;
  applyView(true);
}

function currentGraph() {
  if (viewMode === 'flow') return entry.kind === 'change' ? diffFlow(entry.flowBefore, entry.flowAfter) : entry.flow;
  if (entry.kind !== 'change') return entry.graph;
  const diff = diffGraphs(entry.before, entry.after);
  if (scope === 'changes') return focusOnChanges(diff) || diff;
  return diff;
}

// ---------------------------------------------------------------- setup

function initMermaid() {
  if (!window.mermaid) return;
  const c = palette(dark);
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    maxTextSize: 2_000_000,
    maxEdges: 5000,
    themeVariables: {
      fontFamily: '"Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
      fontSize: '13px',
      primaryColor: c.var[0],
      primaryTextColor: c.ink,
      primaryBorderColor: c.var[1],
      lineColor: c.line,
      edgeLabelBackground: c.var[0],
      textColor: c.ink,
      clusterBkg: 'transparent',
      clusterBorder: c.line,
      background: 'transparent',
    },
    flowchart: { htmlLabels: true, curve: 'basis', nodeSpacing: 26, rankSpacing: 64, padding: 10, useMaxWidth: false },
  });
}

function setView(next) {
  viewMode = next;
  document.querySelectorAll('#views button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === viewMode)));
  $('flowLegend').hidden = viewMode !== 'flow';
  $('signalLegend').hidden = viewMode === 'flow';
  $('removedList').hidden = !(viewMode === 'flow' && entry?.kind === 'change' && removed.length);
  $('removedKey').hidden = viewMode === 'flow';
  $('scope').hidden = !(viewMode === 'signals' && entry?.kind === 'change' && signalChanges);
  if (entry?.kind === 'change') renderChangeNote();
  draw(currentGraph());
}

let removed = [];
let signalChanges = false;

function renderChangeNote() {
  const note = $('changeNote');
  const c = viewMode === 'flow'
    ? flowCounts(diffFlow(entry.flowBefore, entry.flowAfter))
    : (() => { const d = diffGraphs(entry.before, entry.after); const k = (s) => d.nodes.filter((n) => n.state === s).length; return { added: k('added'), changed: k('changed'), removed: k('removed') }; })();
  const any = c.added || c.changed || c.removed;
  const summary = [c.added && `${c.added} added`, c.changed && `${c.changed} changed`, c.removed && `${c.removed} removed`].filter(Boolean).join(', ');
  note.replaceChildren(any
    ? el('p', {}, viewMode === 'flow' ? 'Not applied yet. Follow the green and amber steps and check each decision leads where you expect.' : 'Not applied yet. Check each green and amber box reads from the right signal.')
    : el('p', {}, viewMode === 'flow' ? 'Not applied yet. This change doesn\'t alter any step that runs; it may only touch debug prints or layout.' : 'Not applied yet. This change doesn\'t alter what any output, register or variable reads.'),
  any ? el('p', { class: 'hint' }, summary) : null);
  note.hidden = false;
}

function setScope(next) {
  scope = next;
  document.querySelectorAll('#scope button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scope === scope)));
  draw(currentGraph());
}

async function start() {
  const key = decodeURIComponent(location.hash.slice(1));
  entry = key ? (await chrome.storage.session.get(key))[key] : null;
  if (!entry) {
    $('title').textContent = 'Logic map';
    showEmpty('This map has expired', el('p', { class: 'hint' }, 'Maps are kept only while the browser is open. Open a new one from the Sequencer Copilot side panel.'));
    for (const id of ['copyMermaid', 'downloadSvg', 'fit', 'zoomIn', 'zoomOut']) $(id).disabled = true;
    $('views').hidden = true;
    return;
  }
  initMermaid();

  // Snapshots from before the flowchart existed have only the signal map.
  const hasFlow = entry.kind === 'change' ? !!(entry.flowBefore && entry.flowAfter) : !!entry.flow;
  if (!hasFlow) { viewMode = 'signals'; $('views').hidden = true; }

  if (entry.kind === 'change') {
    const diff = diffGraphs(entry.before, entry.after);
    signalChanges = hasChanges(diff);
    if (!signalChanges) scope = 'all';
    $('title').textContent = 'Logic map of the proposed change';
    $('subtitle').textContent = entry.reply || 'Not applied yet: this shows what Apply would do.';
    $('diffLegend').hidden = false;
    if (hasFlow) {
      removed = diffFlow(entry.flowBefore, entry.flowAfter).removed;
      $('removedList').replaceChildren(el('h2', {}, 'Removed by this change'),
        el('ul', {}, removed.map((r) => el('li', {}, `${r.ask ? 'Decision: ' : ''}${r.text}`, el('span', { class: 'hint' }, ` (${r.where})`)))));
    }
    renderAside(diff);
  } else {
    $('title').textContent = 'Logic map of this sequence';
    $('subtitle').textContent = 'The steps in running order, or what each output is worked out from.';
    renderAside(entry.graph);
  }
  document.title = `${$('title').textContent} · Sequencer Copilot`;
  setView(viewMode);
}

// ---------------------------------------------------------------- controls

document.querySelectorAll('#scope button').forEach((b) => b.addEventListener('click', () => setScope(b.dataset.scope)));
document.querySelectorAll('#views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('zoomIn').addEventListener('click', () => zoomCentre(1.25));
$('zoomOut').addEventListener('click', () => zoomCentre(0.8));
$('fit').addEventListener('click', () => fit());
window.addEventListener('resize', () => fit(false));
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('button, input, textarea')) return;
  if (e.key === '+' || e.key === '=') zoomCentre(1.25);
  else if (e.key === '-') zoomCentre(0.8);
  else if (e.key === '0') fit();
});

const stage = $('stage');
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
let drag = null;
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  drag = { x: e.clientX - view.x, y: e.clientY - view.y };
  stage.setPointerCapture(e.pointerId);
  stage.classList.add('dragging');
});
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  view.x = e.clientX - drag.x;
  view.y = e.clientY - drag.y;
  applyView();
});
const endDrag = () => { drag = null; stage.classList.remove('dragging'); };
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

$('copyMermaid').addEventListener('click', async () => {
  const btn = $('copyMermaid');
  await navigator.clipboard.writeText(source);
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = 'Copy as Mermaid'; }, 1800);
});

$('downloadSvg').addEventListener('click', () => {
  const svg = $('canvas').querySelector('svg');
  if (!svg) return;
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  // A solid background, so the colours read the same in any viewer (the page's grid is behind the chart).
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', getComputedStyle(document.body).backgroundColor || '#ffffff');
  clone.insertBefore(bg, clone.firstChild);
  // XMLSerializer writes proper XML (<br/> inside the labels); outerHTML writes HTML that SVG viewers reject.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
  const d = new Date();
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
  const a = el('a', { href: url, download: `75f-logic-map-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.svg` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

start();
