import { OPS_GUIDE, PLAN_EXAMPLE, PLAN_SCHEMA } from '../ops.js';

/**
 * Builds the Markdown handed to an AI assistant (Claude, ChatGPT, Gemini…):
 * the permanent block guide, the live block list grouped by category, and the
 * current sequence, plus instructions for answering with a plan this extension can apply.
 */

/** The bundled guide, with the shared plan format filled in. */
export async function loadGuide() {
  const res = await fetch(chrome.runtime.getURL('src/guide/block-guide.md'));
  if (!res.ok) throw new Error('The block guide is missing from the extension folder.');
  return (await res.text())
    .replace('{{OPS_GUIDE}}', () => OPS_GUIDE)
    .replace('{{PLAN_SCHEMA}}', () => PLAN_SCHEMA)
    .replace('{{PLAN_EXAMPLE}}', () => PLAN_EXAMPLE);
}

/**
 * Text for a Custom GPT's "Instructions" box (ChatGPT allows 8,000 characters there).
 * ChatGPT searches uploaded knowledge files rather than always reading them whole, so the
 * output contract must live in the instructions, where it is always in view.
 */
export function buildAssistantInstructions(guide, fileName = '75f-sequencer-block-reference.md', { limit = 8000, fileWord = 'knowledge file' } = {}) {
  const start = guide.indexOf('## Output contract');
  const end = guide.indexOf('## How much to trust');
  let contract = guide.slice(start, end)
    .replace(/\*\*The plan's shape\*\* \(JSON Schema\)\s*```json[\s\S]*?```\s*/, '');
  const intro = `You help engineers build and debug control logic for the 75F Site Sequencer, a Blockly editor for building-automation sequences on 75F Connect modules.
Your ${fileWord} (${fileName}) has two parts: the block guide, and the live block list with every block type, field name, input name and dropdown value in the palette. Read it before answering; the block list wins over the guide when they disagree.
Requests are for a blank canvas unless the person attaches a sequence export. For a blank canvas, never ask for an export (unless model points are needed: they exist only in an export): build from the block list and create every block with a ref. For an existing sequence, use only the ids in the attached export; if none is attached, ask for one.
Rules tagged [NEEDS VERIFICATION] in the guide are unconfirmed: mention them when a plan depends on one.

`;
  let text = intro + contract.trim() + '\n';
  if (limit && text.length > limit) {
    // Keep the example and the rules; drop the long operations reference (it is in the knowledge file).
    // Cut only the operations section: stop at the next heading line (Edge only, Model points, Common mistakes…).
    text = text.replace(/\*\*Operations\*\*[\s\S]*?(?=\n\*\*[^*\n]+\*\*\n)/, '**Operations**\nSee "Plan format" and "Operations" in the knowledge file.\n');
  }
  return text;
}

export const SKILL_NAME = '75f-sequencer-copilot';
export const SKILL_REFERENCE = 'references/75f-sequencer-block-reference.md';

/**
 * SKILL.md for the skill package: the open Agent Skills format read by ChatGPT skills,
 * Google Antigravity and Claude. Skills have no 8,000-character box, so nothing is trimmed.
 */
export function buildSkillMd(guide, guideVersion) {
  const description = 'Builds and edits control logic for the 75F Site Sequencer (Blockly) with the Sequencer Copilot Chrome extension. '
    + 'Use whenever someone asks to create, change, explain, review or fix a 75F Site Sequencer sequence, or attaches a Sequencer Copilot export, block list or JSON plan.';
  const body = buildAssistantInstructions(guide, SKILL_REFERENCE, { limit: 0, fileWord: 'reference file' });
  return `---
name: ${SKILL_NAME}
description: ${description}
---

# 75F Sequencer Copilot${guideVersion ? ` (guide version ${guideVersion})` : ''}

${body}`;
}

/**
 * Plain-language version of a validation error, for the panel. The raw text still goes to the
 * assistant, which needs the exact names.
 */
export function friendlyError(raw) {
  const m = /^#(\d+) (\w+): ([\s\S]*)$/.exec(raw);
  if (!m) return raw;
  const [, n, , msg] = m;
  const step = `Step ${n}`;
  const rules = [
    [/unknown block "/, () => `${step} refers to a block that isn't on this canvas. The answer was probably made from an older download of this sequence, or the reference was made up.`],
    [/block type "(.+)" does not exist/, (t) => `${step} uses a block that isn't in the palette (${t}).`],
    [/(\S+) has no field "(.+?)"/, (type, f) => `${step} sets "${f}", which the ${type} block doesn't have.`],
    [/must be between (\S+) and (\S+), got (\S+)/, (lo, hi, v) => `${step} sets ${v}. The allowed range is ${lo} to ${hi}.`],
    [/needs a number, got "(.*)"/, (v) => `${step} needs a number, but the answer gave "${v}".`],
    [/has no input "(.+?)"/, (i) => `${step} plugs into a slot ("${i}") that the block doesn't have.`],
    [/type mismatch/, () => `${step} plugs a block into a slot that doesn't accept that kind of value.`],
    [/cannot go in|has no output|no previous connection|no NEXT connection|does not fit|is not compatible/, () => `${step} connects two blocks that don't fit together.`],
    [/missing "(.+?)"/, (k) => `${step} is incomplete: it has no "${k}".`],
    [/already in use/, () => `${step} gives a new block a name that's already used.`],
    [/was deleted earlier/, () => `${step} uses a block that the answer already removed.`],
    [/extraState is not valid JSON/, () => `${step} describes an if/else shape the extension can't read.`],
    [/x and y must be numbers/, () => `${step} moves a block to an invalid position.`],
    [/unsupported op/, () => `${step} asks for an action the extension doesn't support.`],
  ];
  for (const [re, say] of rules) {
    const hit = re.exec(msg);
    if (hit) return say(...hit.slice(1));
  }
  return `${step}: ${msg}`;
}

/** What to paste back to the assistant when the extension rejects its plan. */
export function repairMessage(errors) {
  return `The Sequencer Copilot extension rejected your plan when checking it against the live canvas:\n- ${errors.join('\n- ')}\n\nReturn a corrected, complete plan in the same JSON format.`;
}

const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;

function describeOption(o) {
  if (o && typeof o === 'object') return o.l && o.l !== o.v ? `${code(o.v)} (${o.l})` : code(o.v);
  return code(o);
}

function shape(entry) {
  const parts = [];
  if (entry.output) parts.push(Array.isArray(entry.output) ? `value block → outputs ${entry.output.join('/')}` : 'value block (plugs into value inputs)');
  if (entry.prev || entry.next) parts.push('statement block (stacks with NEXT)');
  if (!parts.length) parts.push('top-level block (starts a stack; nothing plugs above it)');
  return parts.join('; ');
}

function describeField(f) {
  if (f.options) return `${code(f.name)} dropdown: ${f.options.map(describeOption).join(', ')}`;
  if (f.kind === 'variable') return `${code(f.name)} variable (use a variable name)`;
  const extras = [];
  if (f.default !== undefined && f.default !== '' && f.default !== null) extras.push(`default ${code(f.default)}`);
  if (f.min !== undefined) extras.push(`min ${f.min}`);
  if (f.max !== undefined) extras.push(`max ${f.max}`);
  if (f.precision !== undefined) extras.push(`step ${f.precision}`);
  const kind = f.kind && f.kind !== 'other' ? ` ${f.kind}` : '';
  return `${code(f.name)}${kind}${extras.length ? ` (${extras.join(', ')})` : ''}`;
}

function presetText(p) {
  const fields = p.fields ? Object.entries(p.fields).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`) : [];
  let text = code(p.type) + (fields.length ? ` (${fields.join(', ')})` : '');
  if (p.inputs) text += ` { ${Object.entries(p.inputs).map(([k, c]) => `${k} ← ${presetText(c)}`).join('; ')} }`;
  return text;
}

// For each block type and input: which block types are plugged in on the current canvas.
function canvasUsage(workspace) {
  const usage = new Map(); // type -> Map(input -> Map(childType -> count))
  const walk = (node) => {
    for (const [input, value] of Object.entries(node.inputs || {})) {
      const children = Array.isArray(value) ? value : [value];
      if (!usage.has(node.type)) usage.set(node.type, new Map());
      const byInput = usage.get(node.type);
      if (!byInput.has(input)) byInput.set(input, new Map());
      const counts = byInput.get(input);
      for (const c of children) counts.set(c.type, (counts.get(c.type) || 0) + 1);
      children.forEach(walk);
    }
  };
  for (const stack of workspace || []) stack.blocks.forEach(walk);
  return usage;
}

function describeBlock(entry, usage) {
  const lines = [`**${code(entry.type)}**${entry.label ? ` — “${entry.label}”` : ''}`];
  if (entry.error) {
    lines.push('- (details unavailable: this block could not be inspected)');
    return lines.join('\n');
  }
  lines.push(`- Shape: ${shape(entry)}`);
  if (entry.tip) lines.push(`- Purpose: ${entry.tip}`);
  const fields = (entry.fields || []).filter((f) => f.kind !== 'label');
  if (fields.length) lines.push(`- Fields: ${fields.map(describeField).join(' · ')}`);
  if (entry.inputs?.length) {
    lines.push(`- Inputs: ${entry.inputs.map((i) => `${code(i.name)} ${i.kind}${i.check ? ` [${i.check.join('/')}]` : ''}`).join(' · ')}`);
  }
  if (entry.expandable) lines.push('- Expandable: accepts "extraState" to add inputs (see instructions)');
  if (entry.palette) lines.push(`- Palette version comes as: ${presetText(entry.palette)}`);
  const seen = usage.get(entry.type);
  if (seen) {
    lines.push(`- On this canvas: ${[...seen].map(([input, counts]) =>
      `${code(input)} ← ${[...counts].map(([t, n]) => `${code(t)}${n > 1 ? ` ×${n}` : ''}`).join(', ')}`).join(' · ')}`);
  }
  return lines.join('\n');
}

const isModelPoint = (type) => /^model_point_/.test(type);

// The selected Hayloft model on this canvas, from its model_block.
function selectedModel(workspace) {
  let found = null;
  const walk = (node) => {
    if (found) return;
    if (node.type === 'model_block' && node.fields?.selectedModelId) found = node.fields;
    for (const v of Object.values(node.inputs || {})) (Array.isArray(v) ? v : [v]).forEach(walk);
  };
  for (const stack of workspace || []) stack.blocks.forEach(walk);
  return found;
}

export function buildExport(ctx, { includeSequence = true, guide = null } = {}) {
  const usage = includeSequence ? canvasUsage(ctx.workspace) : new Map();
  // Model points belong to one Hayloft model, so the reusable knowledge file never carries them.
  const catalog = includeSequence ? ctx.catalog : ctx.catalog.filter((e) => !isModelPoint(e.type));
  const byCategory = new Map();
  for (const entry of catalog) {
    const cat = ctx.categories?.[entry.type]
      || (entry.type === 'point_setter' ? 'Model Points'
        : /^(variables_set|variables_get|math_change)$/.test(entry.type) ? 'Variables'
          : 'Used on canvas (not in toolbox)');
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(entry);
  }

  const date = new Date().toISOString().slice(0, 10);
  const out = [];
  out.push(`# 75F Site Sequencer export${guide ? ': block guide, ' : ': '}block list${includeSequence ? ' and current sequence' : ''}`);
  out.push(`Exported ${date} · Blockly ${ctx.meta.blocklyVersion} · ${catalog.length} block types` +
    (includeSequence ? ` · current sequence has ${ctx.meta.blockCount} blocks` : ''));

  if (guide) {
    out.push(`${includeSequence ? 'This file has three parts: the block guide (how to use the blocks and how to answer), the live block list read from the editor, and the current sequence.' : 'This file has two parts: the block guide (how to use the blocks and how to answer) and the live block list read from the editor. It describes no sequence: plan from a blank canvas unless an export of a specific sequence is attached.'} Where the guide and the live data disagree on a name or value, the live data wins.`);
    // Nest the guide under Part 1 by demoting its headings one level.
    out.push(guide.replace(/^(#{1,5}) /gm, '#$1 ').replace(/^## /, '## Part 1. '));
    out.push('## Part 2. Live block list');
  } else {
    out.push(`## Instructions for the assistant reading this file
You are helping design control logic for the 75F Site Sequencer, a Blockly-based visual editor for building-automation sequences.
A browser extension will apply your answer to the canvas, so precision matters:

1. Use only the block types listed under **Blocks**, with their exact field and input names.
2. Refer to existing blocks by their ${code('id')} from **Current sequence**; refer to new blocks by a short ${code('ref')} you invent (n1, n2…).
3. Make the smallest change that does the job and leave unrelated logic alone. Delete only if asked.
4. If something is ambiguous (which point, zone, setpoint or unit), ask before planning.
5. For a change, answer with a short explanation, then exactly one \`\`\`json code block containing the plan. Many 75F dropdowns are 0-based: "Relay 3" is stored as "2". "Add" means keep existing blocks.
6. \`fields\` is a list of {name, value} objects, never an object; every value is a string.
7. Model points: read one by plugging its \`model_point_*\` block into a value input. Write one with \`point_setter\`: \`selected_point_name\` and \`selected_point_ref\` both take the point's type id, \`setter_model_value\` takes the model id below. "Write model point" means \`point_setter\`; "write Modbus register" means \`conn_mod_write_modbus_register\`: never swap them.

${OPS_GUIDE}

Example of a complete plan:

\`\`\`json
${PLAN_EXAMPLE}
\`\`\``);
  }
  out.push(`Reading the block list: "value block" plugs into a value input; "statement block" stacks with NEXT or goes in a statement input; "Palette version comes as" shows the blocks the left pane pre-plugs, which is the intended way to fill that input.` +
    (includeSequence ? ' "On this canvas" shows how this sequence already wires it.' : ''));

  if (!guide) out.push('## Blocks');
  if (ctx.dynamicCategories?.length) {
    out.push(`Some categories are generated from the site's data (${ctx.dynamicCategories.map(code).join(', ')}); their dropdown options reflect this site at export time.`);
  }
  for (const [cat, entries] of byCategory) {
    out.push(`### ${cat}\n\n${entries.map((e) => describeBlock(e, usage)).join('\n\n')}`);
  }

  const model = includeSequence ? selectedModel(ctx.workspace) : null;
  if (model && catalog.some((e) => isModelPoint(e.type))) {
    out.push(`Model points on this canvas come from model ${code(model.selectedModelId)}${model.modelVersion ? ` (version ${model.modelVersion})` : ''}. A \`point_setter\` takes that id as \`setter_model_value\`.`);
  }

  // point_setter is only offered once a model is chosen, but it is never a block to avoid.
  const avoid = (ctx.notInPalette || []).filter((t) => t !== 'point_setter' && !isModelPoint(t));
  if (avoid.length) {
    out.push(`### Registered but not in this palette
These block types exist in the editor but are not offered in the left pane for this sequence (they may belong to other device types). Avoid them unless asked: ${avoid.map(code).join(', ')}`);
  }

  // Canvas variables describe one sequence, so they only go out with that sequence.
  if (includeSequence && ctx.variables?.length) {
    out.push(`${guide ? '### Variables on this canvas' : '## Variables'}\nVariables that exist on this canvas (use these names in variable fields): ${ctx.variables.map((v) => code(v.name) + (v.type ? ` (${v.type})` : '')).join(', ')}`);
  }

  if (includeSequence) {
    out.push(`${guide ? '## Part 3. Current sequence' : '## Current sequence'}
Stacks from top to bottom. Each block shows its ${code('id')}, type, field values and what is plugged into each input (statement inputs list blocks in order).` +
      (ctx.truncated ? ' Deep nesting was truncated; blocks marked "truncated" have hidden children.' : ''));
    out.push('```json\n' + JSON.stringify(ctx.workspace, null, 1) + '\n```');
  }
  return out.join('\n\n') + '\n';
}

/* ------------------------------------------------------------------ pasted plans
 * Assistants differ in how they write JSON. Harmless format slips are repaired here and
 * reported to the person; anything that changes meaning is left for validation to reject.
 */

const OP_NAMES = { create: 'create', setfield: 'setField', set_field: 'setField', setvalue: 'setField', connect: 'connect',
  disconnect: 'disconnect', move: 'move', delete: 'delete', remove: 'delete' };

// Repairs that only apply when strict JSON.parse fails: comments, trailing commas, curly quotes.
function lenientParse(raw) {
  try { return { value: JSON.parse(raw), repaired: false }; } catch { /* try repairs */ }
  const src = raw.replace(/[“”]/g, '"');
  let out = '';
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += src[++i] ?? ''; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    if (c === ',' && /^\s*[}\]]/.test(src.slice(i + 1, i + 200))) continue; // trailing comma
    out += c;
  }
  try { return { value: JSON.parse(out), repaired: true }; } catch (err) { return { error: err.message }; }
}

// Every JSON candidate in a reply: fenced blocks first, then the outermost {...} or [...].
function candidates(text) {
  const list = [...text.matchAll(/```[a-zA-Z0-9]*\s*\n?([\s\S]*?)```/g)].map((m) => m[1].trim());
  const t = text.trim();
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const a = t.indexOf(open);
    const b = t.lastIndexOf(close);
    if (a >= 0 && b > a) list.push(t.slice(a, b + 1));
  }
  return list.filter((c) => c.startsWith('{') || c.startsWith('['));
}

const RANK = { create: 0, delete: 2 };

function normalisePlan(obj, fixes) {
  let reply = 'Plan pasted in.';
  let actions = null;
  if (Array.isArray(obj)) { actions = obj; fixes.add('plan was a bare list of actions'); }
  else if (obj && typeof obj === 'object') {
    const inner = obj.plan && typeof obj.plan === 'object' ? obj.plan : obj;
    if (inner !== obj) fixes.add('plan was wrapped in "plan"');
    reply = inner.reply || inner.summary || reply;
    actions = inner.actions || inner.steps || inner.operations || null;
    if (actions && !inner.actions) fixes.add('"actions" was named differently');
  }
  if (!Array.isArray(actions)) return null;

  const str = (v) => (typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
  actions = actions.map((raw) => {
    const a = { ...raw };
    const opKey = String(a.op ?? a.action ?? a.type_of_op ?? '').replace(/\s/g, '').toLowerCase();
    if (a.op === undefined && a.action !== undefined) { fixes.add('"op" was written as "action"'); delete a.action; }
    if (OP_NAMES[opKey] && a.op !== OP_NAMES[opKey]) {
      if (a.op !== undefined) fixes.add('operation names had the wrong capitalisation');
      a.op = OP_NAMES[opKey];
    }
    if (a.fields && !Array.isArray(a.fields) && typeof a.fields === 'object') {
      a.fields = Object.entries(a.fields).map(([name, value]) => ({ name, value }));
      fixes.add('"fields" was an object instead of a list');
    }
    if (Array.isArray(a.fields)) {
      a.fields = a.fields.map((f) => {
        if (f && typeof f.value !== 'string' && f.value !== undefined) { fixes.add('field values were not strings'); return { ...f, value: str(f.value) }; }
        return f;
      });
    }
    if (a.op === 'setField' && a.value !== undefined && typeof a.value !== 'string') { a.value = str(a.value); fixes.add('field values were not strings'); }
    if (a.extraState && typeof a.extraState === 'object') { a.extraState = JSON.stringify(a.extraState); fixes.add('"extraState" was an object instead of a string'); }
    for (const k of ['x', 'y']) {
      if (typeof a[k] === 'string' && a[k].trim() !== '' && !Number.isNaN(Number(a[k]))) { a[k] = Number(a[k]); fixes.add('coordinates were strings'); }
    }
    return a;
  });

  // Creates first and deletes last; everything else keeps its order. Safe because a connect into an
  // occupied input bumps the old block out, and blocks being deleted are removed after rewiring.
  const sorted = actions.map((a, i) => ({ a, i })).sort((p, q) => ((RANK[p.a.op] ?? 1) - (RANK[q.a.op] ?? 1)) || p.i - q.i).map((p) => p.a);
  if (sorted.some((a, i) => a !== actions[i])) fixes.add('steps were reordered (creates first, deletes last)');
  return { reply, actions: sorted };
}

/**
 * Finds the plan in a pasted reply.
 * Returns { reply, actions, fixes[] }, or { error } when JSON was found but unusable, or null when there is none.
 */
export function parsePastedPlan(text) {
  let lastError = null;
  for (const raw of candidates(text)) {
    const parsed = lenientParse(raw);
    if (parsed.error) { lastError = parsed.error; continue; }
    const fixes = new Set();
    if (parsed.repaired) fixes.add('JSON had comments, trailing commas or curly quotes');
    const plan = normalisePlan(parsed.value, fixes);
    if (plan) return { ...plan, fixes: [...fixes] };
  }
  return lastError ? { error: `The plan's JSON could not be read (${lastError}). Ask your assistant to resend it as one valid json block.` } : null;
}
