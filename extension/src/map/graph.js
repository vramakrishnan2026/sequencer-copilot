/**
 * Logic map: turns the bridge's signal-flow graph into Mermaid flowchart text, and compares the
 * canvas before and after a plan so the map can colour what the plan adds, changes and removes.
 *
 * Graph shape (from the page bridge): { nodes: [{ key, kind: 'input'|'var'|'output', label, writes[] }],
 *   edges: [{ from, to, kind: 'value'|'gate' }], setup, sections, loose, blockCount }
 */

const edgeKey = (e) => `${e.from}>${e.to}`;

/** Marks each node and edge of `after` as added or changed, and brings back what `before` had but `after` lost. */
export function diffGraphs(before, after) {
  const oldNodes = new Map(before.nodes.map((n) => [n.key, n]));
  const newNodes = new Map(after.nodes.map((n) => [n.key, n]));
  const oldEdges = new Map(before.edges.map((e) => [edgeKey(e), e]));
  const newEdges = new Map(after.edges.map((e) => [edgeKey(e), e]));

  const nodes = after.nodes.map((n) => {
    const was = oldNodes.get(n.key);
    if (!was) return { ...n, state: 'added' };
    const same = was.writes.length === n.writes.length && was.writes.every((w, i) => w === n.writes[i]);
    return same ? { ...n } : { ...n, state: 'changed', was: was.writes };
  });
  for (const n of before.nodes) if (!newNodes.has(n.key)) nodes.push({ ...n, state: 'removed' });

  const edges = after.edges.map((e) => {
    const was = oldEdges.get(edgeKey(e));
    if (!was) return { ...e, state: 'added' };
    return was.kind === e.kind ? { ...e } : { ...e, state: 'changed' };
  });
  for (const e of before.edges) if (!newEdges.has(edgeKey(e))) edges.push({ ...e, state: 'removed' });

  return { ...after, nodes, edges, loose: after.loose, looseBefore: before.loose, diff: true };
}

/** Only what changed, plus one step of context either side, so a change in a big sequence is readable. */
export function focusOnChanges(graph) {
  const keep = new Set();
  for (const n of graph.nodes) if (n.state) keep.add(n.key);
  for (const e of graph.edges) if (e.state) { keep.add(e.from); keep.add(e.to); }
  if (!keep.size) return null;
  const core = new Set(keep);
  for (const e of graph.edges) {
    if (core.has(e.to)) keep.add(e.from);
    if (core.has(e.from)) keep.add(e.to);
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => keep.has(n.key)),
    edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
  };
}

export const hasChanges = (graph) => graph.nodes.some((n) => n.state) || graph.edges.some((e) => e.state);

// Text people typed (names, values, conditions) goes into labels as Mermaid entity codes, so it
// can never be read as Mermaid syntax or HTML.
export function esc(text) {
  return String(text)
    .replace(/&/g, '#amp;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
    .replace(/[\r\n]+/g, ' ');
}

function writesText(n) {
  const list = n.writes.filter((w) => w && w !== '?');
  if (!list.length) return '';
  const shown = list.slice(0, 2).map(esc).join('<br/>or ');
  return list.length > 2 ? `${shown}<br/>(+${list.length - 2} more)` : shown;
}

function label(n) {
  // Model points: the point name is the title, with what it is underneath in small type.
  const point = /^Model point (.+)$/.exec(n.label);
  const title = `<b>${esc(point ? point[1] : n.label)}</b>${point ? '<br/><i>model point</i>' : ''}`;
  if (n.kind === 'input') return title;
  const body = writesText(n);
  const was = n.state === 'changed' && n.was?.length ? `<br/><i>was: ${n.was.slice(0, 2).map(esc).join(' or ')}</i>` : '';
  // A variable named after its only value ("x = x") would say the same thing twice.
  return body && body !== esc(n.label) ? `${title}<br/>${body}${was}` : `${title}${was}`;
}

function shape(n, id) {
  const text = `"${label(n)}"`;
  if (n.kind === 'input') return `${id}([${text}])`;
  if (n.kind === 'output') return `${id}[[${text}]]`;
  return `${id}[${text}]`;
}

/** Colours shared with the side panel (duct teal, wire blue). */
export function palette(dark) {
  return dark
    ? { input: ['#183a40', '#4fb3c2'], var: ['#1a242d', '#3d4f5c'], output: ['#1c2a3d', '#86a7d6'],
        ask: ['#223039', '#97a8b4'], added: ['#16301f', '#6cc394'], changed: ['#3a2f14', '#e0b454'], removed: ['#3a2320', '#e27a6b'], ink: '#dce5ea', line: '#708390' }
    : { input: ['#dceff1', '#17707f'], var: ['#ffffff', '#aebbc4'], output: ['#e7edf6', '#2f5687'],
        ask: ['#f1f4f6', '#4d5c67'], added: ['#e2f3e8', '#2f7d4f'], changed: ['#fbf0d9', '#a86a12'], removed: ['#f6e4e0', '#a83a2b'], ink: '#1b2731', line: '#6b7c88' };
}

/** Mermaid flowchart text for a graph (plain or diffed). */
export function toMermaid(graph, { dark = false } = {}) {
  const c = palette(dark);
  const ids = new Map(graph.nodes.map((n, i) => [n.key, `n${i}`]));
  const lines = ['flowchart LR'];
  for (const [name, [fill, stroke]] of Object.entries({ input: c.input, var: c.var, output: c.output })) {
    lines.push(`  classDef ${name} fill:${fill},stroke:${stroke},stroke-width:1.5px,color:${c.ink}`);
  }
  lines.push(`  classDef added fill:${c.added[0]},stroke:${c.added[1]},stroke-width:3px,color:${c.ink}`);
  lines.push(`  classDef changed fill:${c.changed[0]},stroke:${c.changed[1]},stroke-width:3px,color:${c.ink}`);
  lines.push(`  classDef removed fill:${c.removed[0]},stroke:${c.removed[1]},stroke-width:2px,stroke-dasharray:5 4,color:${c.ink}`);

  const subgraphStyles = [];
  const group = (kind, title) => {
    const members = graph.nodes.filter((n) => n.kind === kind);
    if (!members.length) return;
    lines.push(`  subgraph ${kind}Col["${title}"]`, '    direction TB');
    for (const n of members) lines.push(`    ${shape(n, ids.get(n.key))}`);
    lines.push('  end');
    subgraphStyles.push(`  style ${kind}Col fill:transparent,stroke:${c.line},stroke-dasharray:2 4,color:${c.ink}`);
  };
  group('input', 'Inputs and readings');
  for (const n of graph.nodes.filter((x) => x.kind === 'var')) lines.push(`  ${shape(n, ids.get(n.key))}`);
  group('output', 'Outputs and writes');

  // linkStyle counts links in the order they are written, so count only the ones written.
  const linkStyles = [];
  let link = 0;
  for (const e of graph.edges) {
    const from = ids.get(e.from);
    const to = ids.get(e.to);
    if (!from || !to) continue;
    lines.push(`  ${from} ${e.kind === 'gate' ? '-.->' : '-->'} ${to}`);
    if (e.state === 'added') linkStyles.push(`  linkStyle ${link} stroke:${c.added[1]},stroke-width:3px`);
    else if (e.state === 'removed') linkStyles.push(`  linkStyle ${link} stroke:${c.removed[1]},stroke-width:2px,stroke-dasharray:3 4`);
    else if (e.state === 'changed') linkStyles.push(`  linkStyle ${link} stroke:${c.changed[1]},stroke-width:3px`);
    link++;
  }
  lines.push(...linkStyles);
  for (const n of graph.nodes) lines.push(`  class ${ids.get(n.key)} ${n.state || n.kind}`);
  lines.push(...subgraphStyles);
  return lines.join('\n');
}
