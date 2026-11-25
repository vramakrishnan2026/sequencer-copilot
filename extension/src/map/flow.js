/**
 * Flowchart view of a sequence: the steps in running order, if/else as decision diamonds, loops
 * with a return arrow. Built from the page bridge's `logicFlow`:
 *   { sections: [{ kind: 'startup'|'continuous'|'function', title, body: items[] }], setup, loose, blockCount }
 *   item = { t: 'step', id, kind: 'calc'|'out'|'other', text }
 *        | { t: 'if', id, branches: [{ key, cond, body }], else: items[] | null }
 *        | { t: 'loop', id, key, cond, body }
 */
import { esc, palette } from './graph.js';

function index(flow) {
  const seen = new Map();
  const walk = (items, where) => {
    for (const it of items) {
      if (it.t === 'step') seen.set(it.id, { text: it.text, where });
      else if (it.t === 'loop') { seen.set(it.key, { text: it.cond, where, ask: true }); walk(it.body, where); }
      else if (it.t === 'if') {
        it.branches.forEach((br) => { seen.set(br.key, { text: br.cond, where, ask: true }); walk(br.body, where); });
        if (it.else) walk(it.else, where);
      }
    }
  };
  for (const s of flow.sections) walk(s.body, s.title);
  return seen;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

/** Marks what a plan adds or changes in `after`, and lists what it removes (removed steps can't be drawn in place). */
export function diffFlow(before, after) {
  const old = index(before);
  const now = index(after);
  const out = clone(after);
  const mark = (obj, key, text) => {
    const was = old.get(key);
    if (!was) obj.state = 'added';
    else if (was.text !== text) { obj.state = 'changed'; obj.was = was.text; }
  };
  const walk = (items) => {
    for (const it of items) {
      if (it.t === 'step') mark(it, it.id, it.text);
      else if (it.t === 'loop') { mark(it, it.key, it.cond); walk(it.body); }
      else if (it.t === 'if') {
        it.branches.forEach((br) => { mark(br, br.key, br.cond); walk(br.body); });
        if (it.else) walk(it.else);
      }
    }
  };
  out.sections.forEach((s) => walk(s.body));
  out.removed = [...old].filter(([key]) => !now.has(key)).map(([, v]) => v);
  out.diff = true;
  return out;
}

export function flowCounts(flow) {
  const c = { added: 0, changed: 0 };
  const walk = (items) => {
    for (const it of items) {
      if (it.state) c[it.state]++;
      if (it.t === 'loop') walk(it.body);
      if (it.t === 'if') { it.branches.forEach((br) => { if (br.state) c[br.state]++; walk(br.body); }); if (it.else) walk(it.else); }
    }
  };
  flow.sections.forEach((s) => walk(s.body));
  return { ...c, removed: flow.removed?.length || 0 };
}

// Long conditions wrap at "and" / "or" so diamonds stay compact.
const condText = (t) => esc(t).replace(/ (and|or) /g, '<br/>$1 ');
const MAX_LINES = 6;

/** Mermaid text for the flowchart (plain or diffed). */
export function toFlowMermaid(flow, { dark = false } = {}) {
  const c = palette(dark);
  const lines = ['flowchart TD'];
  const defs = {
    run: [c.input[0], c.input[1], '1.5px'],
    calc: [c.var[0], c.var[1], '1.5px'],
    out: [c.output[0], c.output[1], '1.5px'],
    other: [c.var[0], c.line, '1px'],
    ask: [c.ask[0], c.ask[1], '1.5px'],
    added: [c.added[0], c.added[1], '3px'],
    changed: [c.changed[0], c.changed[1], '3px'],
  };
  for (const [name, [fill, stroke, width]] of Object.entries(defs)) {
    lines.push(`  classDef ${name} fill:${fill},stroke:${stroke},stroke-width:${width},color:${c.ink}`);
  }

  let n = 0;
  const id = () => `f${n++}`;
  const classes = [];
  const node = (text, shape, cls) => {
    const k = id();
    const q = `"${text}"`;
    lines.push(`  ${k}${shape === 'pill' ? `([${q}])` : shape === 'double' ? `[[${q}]]` : shape === 'diamond' ? `{${q}}` : `[${q}]`}`);
    classes.push(`  class ${k} ${cls}`);
    return k;
  };
  const link = (exits, to) => {
    for (const e of exits) lines.push(`  ${e.id} ${e.label ? `-->|${e.label}|` : '-->'} ${to}`);
  };

  function emit(items, exits) {
    let i = 0;
    while (i < items.length) {
      const it = items[i];
      if (it.t === 'step') {
        // Neighbouring steps of the same kind share a box, except a changed step, which stands alone.
        const group = [it];
        while (i + group.length < items.length && group.length < MAX_LINES) {
          const nx = items[i + group.length];
          if (nx.t !== 'step' || nx.kind !== it.kind || it.state === 'changed' || nx.state === 'changed' || nx.state !== it.state) break;
          group.push(nx);
        }
        i += group.length;
        let text = group.map((s) => esc(s.text)).join('<br/>');
        if (it.state === 'changed') text += `<br/><i>was: ${esc(it.was)}</i>`;
        const k = node(text, it.kind === 'out' ? 'double' : 'box', it.state || it.kind);
        link(exits, k);
        exits = [{ id: k }];
        continue;
      }
      if (it.t === 'if') {
        const done = [];
        let pending = exits;
        for (const br of it.branches) {
          let text = `${condText(br.cond)}?`;
          if (br.state === 'changed') text += `<br/><i>was: ${esc(br.was)}</i>`;
          const q = node(text, 'diamond', br.state || 'ask');
          link(pending, q);
          const yes = [{ id: q, label: 'Yes' }];
          done.push(...(br.body.length ? emit(br.body, yes) : yes));
          pending = [{ id: q, label: 'No' }];
        }
        done.push(...(it.else?.length ? emit(it.else, pending) : pending));
        exits = done;
      } else if (it.t === 'loop') {
        let text = `${condText(it.cond)}?`;
        if (it.state === 'changed') text += `<br/><i>was: ${esc(it.was)}</i>`;
        const q = node(text, 'diamond', it.state || 'ask');
        link(exits, q);
        const bodyExits = it.body.length ? emit(it.body, [{ id: q, label: 'Yes' }]) : [{ id: q, label: 'Yes' }];
        link(bodyExits, q);
        exits = [{ id: q, label: 'No' }];
      }
      i++;
    }
    return exits;
  }

  const su = flow.setup;
  const setupLines = [
    su.model && `Model ${esc(su.model)}`,
    su.inputs.length && `${su.inputs.length} universal input${su.inputs.length === 1 ? '' : 's'}`,
    su.registers.length && `${su.registers.length} Modbus register${su.registers.length === 1 ? '' : 's'}`,
    su.screens.length && `${su.screens.length} home-screen line${su.screens.length === 1 ? '' : 's'}`,
    su.bacnet.length && `${su.bacnet.length} BACnet object${su.bacnet.length === 1 ? '' : 's'}`,
    su.initialised.length && `${su.initialised.length} starting value${su.initialised.length === 1 ? '' : 's'}`,
    ...su.other.map(esc),
  ].filter(Boolean);

  let carry = null; // startup's exits flow into continuous
  const sections = flow.sections.length ? flow.sections : [];
  for (const s of sections) {
    const start = node(`<b>${esc(s.title)}</b>`, 'pill', 'run');
    if (carry && s.kind === 'continuous') link(carry, start);
    let exits = [{ id: start }];
    if (s.kind === 'startup' && setupLines.length) {
      const k = node(`<b>Sets up</b><br/>${setupLines.join('<br/>')}`, 'box', 'other');
      link(exits, k);
      exits = [{ id: k }];
    }
    exits = emit(s.body, exits);
    if (s.kind === 'startup' && sections.some((x) => x.kind === 'continuous')) { carry = exits; continue; }
    const end = node(s.kind === 'continuous' ? 'Wait for the next run' : s.kind === 'startup' ? 'Startup done' : 'Back to where it was called', 'pill', 'run');
    link(exits, end);
  }
  lines.push(...classes);
  return lines.join('\n');
}
