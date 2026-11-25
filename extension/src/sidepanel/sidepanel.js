import { SKILL_NAME, SKILL_REFERENCE, buildAssistantInstructions, buildExport, buildSkillMd, friendlyError, loadGuide, parsePastedPlan, repairMessage } from './export.js';
import { makeZip } from './zip.js';
import { createSimulatorView } from '../simulator/view.js';
import { addFindings, clearFindings, findingsMarkdown, loadFindings, parseFindings, removeFinding, stripFindings } from './findings.js';

const $ = (id) => document.getElementById(id);
const { id: windowId } = await chrome.windows.getCurrent();
const VERSION = chrome.runtime.getManifest().version;

// Kept between sessions. mode: 'new' | 'edit'; assistant: 'chatgpt' | 'antigravity' | 'claude' | 'copilot' | 'other'.
const DEFAULTS = { mode: 'new', assistant: 'chatgpt', showTypes: true, setupDone: false, lastDownload: null };
const settings = { ...DEFAULTS, ...((await chrome.storage.local.get('settings')).settings || {}) };
const saveSettings = (patch) => { Object.assign(settings, patch); return chrome.storage.local.set({ settings }); };

const state = { busy: false, blockCount: null, ready: false, guideVersion: null };

// ------------------------------------------------------------------ plumbing

async function bg(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, windowId, ...payload });
  if (!res?.ok) throw new Error(res?.error || 'No response from the extension.');
  return res.result;
}

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

function show(node) {
  $('log').append(node);
  node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return node;
}
const say = (text, kind = '') => show(el('div', { class: `msg ${kind}` }, text));

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
const clock = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function download(data, filename, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// -------------------------------------------------------------------- views

function openSettings() {
  $('mainView').hidden = true;
  $('settingsView').hidden = false;
  renderSettings();
  $('closeSettings').focus();
}
function closeSettings() {
  $('settingsView').hidden = true;
  $('mainView').hidden = false;
  renderMain();
  $('openSettings').focus();
}
$('openSettings').addEventListener('click', openSettings);
$('bannerSettings').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', closeSettings);

// -------------------------------------------------------------- main screen

function renderMain() {
  const mode = settings.mode;
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  document.querySelectorAll('[data-show]').forEach((n) => { n.hidden = n.dataset.show !== mode; });
  $('pasteNum').textContent = mode === 'new' ? '2' : '3';
  $('setupBanner').hidden = settings.setupDone;
  $('describeHint').textContent = `Open ${whereToAsk()} and say what the sequence should do. Nothing to attach: it already knows every block.`;
  $('guideVersion').textContent = state.guideVersion ? `Assistant guide v${state.guideVersion} · ` : '';

  const count = state.blockCount;
  $('openMap').disabled = !state.ready || !count;
  $('openSimulator').disabled = !state.ready || !count;
  $('openMap').title = state.ready && !count ? 'The canvas is empty.' : 'What each output and register is worked out from, as a diagram';
  const note = $('notEmptyNote');
  note.hidden = !(mode === 'new' && count > 0);
  note.textContent = `This canvas already has ${plural(count ?? 0, 'block')}. New blocks are added beside them; nothing is removed.`;

  const last = settings.lastDownload;
  let text = 'Not downloaded or copied yet.';
  if (last) {
    text = `Last ${last.how || 'downloaded'} ${clock(last.at)} · ${plural(last.blocks, 'block')}.`;
    text += count != null && count !== last.blocks
      ? ' The canvas has changed since, so do it again.'
      : ' Do it again after every apply: block references change.';
  }
  $('lastDownload').textContent = text;
}

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', async () => {
  await saveSettings({ mode: b.dataset.mode });
  renderMain();
}));

async function refreshStatus() {
  const dot = $('statusDot');
  try {
    const s = await bg('status');
    state.ready = s.ready;
    state.blockCount = s.ready ? s.blockCount : null;
    dot.className = `dot ${s.ready ? 'ready' : 'down'}`;
    $('statusText').textContent = s.ready ? `Connected to Site Sequencer · ${plural(s.blockCount, 'block')} on canvas` : s.reason;
  } catch (err) {
    state.ready = false;
    state.blockCount = null;
    dot.className = 'dot down';
    $('statusText').textContent = /Open the 75F/.test(err.message) ? 'Open a Site Sequencer tab in this window to start.' : err.message;
  }
  renderMain();
}
chrome.tabs.onActivated.addListener(refreshStatus);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete') refreshStatus(); });

// Most assistants handle an attached file better than a long paste: chat boxes can cut long
// text, and some assistants summarise pasted text instead of reading it all.
const LONG_PASTE = 100000;

async function sequenceExport() {
  const ctx = await bg('exportData');
  return { text: buildExport(ctx, { includeSequence: true, guide: null }), blocks: ctx.meta.blockCount ?? state.blockCount ?? 0 };
}

async function remember(how, blocks) {
  await saveSettings({ lastDownload: { at: new Date().toISOString(), blocks, how } });
  renderMain();
}

$('downloadSequence').addEventListener('click', async () => {
  try {
    const { text, blocks } = await sequenceExport();
    download(text, `75f-sequencer-sequence-${stamp()}.md`);
    await remember('downloaded', blocks);
  } catch (err) { say(err.message, 'error'); }
});

$('copySequence').addEventListener('click', async () => {
  const btn = $('copySequence');
  try {
    const { text, blocks } = await sequenceExport();
    await navigator.clipboard.writeText(text);
    await remember('copied', blocks);
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    if (text.length > LONG_PASTE) {
      say(`Copied ${Math.round(text.length / 1000)}k characters. That's long for a chat box: if your assistant cuts it off or only skims it, use Download this sequence and attach the file instead.`);
    }
  } catch (err) { say(err.message, 'error'); }
});

// --------------------------------------------------------------- logic map

// The map tab reads a snapshot from session storage (cleared when the browser closes). Keep the
// last few so older map tabs still work, and drop the rest.
async function openMap(snapshot) {
  const key = `map-${Date.now()}`;
  const old = Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith('map-')).sort().slice(0, -5);
  if (old.length) await chrome.storage.session.remove(old);
  await chrome.storage.session.set({ [key]: { ...snapshot, capturedAt: new Date().toISOString() } });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`src/map/map.html#${key}`), windowId });
}

// --------------------------------------------------------------- simulator
// A view of this panel, like Settings: it reads the canvas, then runs the blocks against virtual inputs.

let sim = null;

async function loadSimulator() {
  const btn = $('simReload');
  btn.disabled = true;
  $('simSub').textContent = 'Reading the canvas…';
  const ok = await sim.load();
  if (ok) $('simSub').textContent = 'Virtual inputs through this canvas\'s logic';
  btn.disabled = false;
}

$('openSimulator').addEventListener('click', async () => {
  $('mainView').hidden = true;
  $('simView').hidden = false;
  $('closeSim').focus();
  if (!sim) {
    sim = createSimulatorView($('simRoot'), {
      loadModel: () => bg('simulatorModel'),
      onError: (err) => {
        $('simSub').textContent = /Unknown method/.test(err.message)
          ? 'Reload the Sequencer tab once so the update reaches it, then try again.'
          : err.message;
      },
    });
  }
  await loadSimulator();
});
$('simReload').addEventListener('click', loadSimulator);
$('closeSim').addEventListener('click', () => {
  sim?.pause();
  $('simView').hidden = true;
  $('mainView').hidden = false;
  renderMain();
  $('openSimulator').focus();
});

$('openMap').addEventListener('click', async () => {
  const btn = $('openMap');
  btn.disabled = true;
  try {
    await openMap({ kind: 'sequence', ...(await bg('logicMap')) });
  } catch (err) {
    say(/Unknown method/.test(err.message) ? 'Reload the Sequencer tab once so the extension\'s update reaches it, then try again.' : err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------------- review

// Fallback wording when the canvas preview is unavailable.
function describeAction(a) {
  const fields = (a.fields || []).map((f) => `${f.name}=${f.value}`).join(', ');
  switch (a.op) {
    case 'create': return { kind: 'add', text: `${a.type}${fields ? ` (${fields})` : ''}`, types: [a.type] };
    case 'setField': return { kind: 'change', text: `Set ${a.field} to ${a.value}`, types: [] };
    case 'connect': return { kind: 'move', text: `Plug ${a.child} into ${a.parent} › ${a.input}`, types: [] };
    case 'disconnect': return { kind: 'move', text: `Unplug ${a.block}`, types: [] };
    case 'move': return { kind: 'move', text: `Move ${a.block}`, types: [] };
    case 'delete': return { kind: 'remove', text: `Remove ${a.block}`, types: [] };
    default: return { kind: 'change', text: JSON.stringify(a), types: [] };
  }
}

const VERBS = { add: 'Add', change: 'Change', move: 'Move', remove: 'Remove' };

function changeRow(line) {
  return el('div', { class: 'change', style: line.depth ? `padding-left: ${12 + line.depth * 14}px` : null },
    el('span', { class: `verb ${line.kind}` }, VERBS[line.kind] || line.kind),
    el('div', { class: 'change-body' },
      el('div', {}, line.slot ? el('span', { class: 'slot' }, `${line.slot} › `) : null, line.text),
      line.before && line.before !== line.text ? el('div', { class: 'was' }, `Was: ${line.before}`) : null,
      settings.showTypes && line.types?.length ? el('div', { class: 'types' }, line.types.join(' · ')) : null));
}

function problemsCard(errors) {
  const stale = errors.some((e) => /unknown block/.test(e));
  const copyBtn = el('button', { class: 'primary full', type: 'button' }, 'Copy message for your assistant');
  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(repairMessage(errors));
    copyBtn.textContent = 'Copied. Paste it into the same chat';
  });
  return el('section', { class: 'review bad', 'aria-label': 'Problems' },
    el('div', { class: 'review-head' },
      el('strong', {}, `This answer can't be applied · ${plural(errors.length, 'problem')}`),
      el('span', { class: 'hint' }, 'Nothing on the canvas was changed.')),
    el('ol', { class: 'problems' }, errors.map((e) => el('li', {},
      el('div', {}, friendlyError(e), settings.showTypes ? el('div', { class: 'types' }, e) : null)))),
    el('div', { class: 'review-foot stack' }, copyBtn,
      el('p', { class: 'hint' }, stale
        ? 'Paste it into the same chat, and attach a fresh download of this sequence too.'
        : 'Paste it into the same chat. The assistant will send a corrected answer.')));
}

function reviewCard(plan, result) {
  const lines = result.lines?.length ? result.lines : plan.actions.map(describeAction);
  const removes = lines.filter((l) => l.kind === 'remove').length;
  const head = `${plural(lines.length, 'change')} · ${removes ? `removes ${removes}` : 'nothing removed'}`;

  const body = [];
  let group = null;
  for (const line of lines) {
    const g = line.group || '';
    if (g !== group) {
      group = g;
      body.push(el('div', { class: 'group' }, g || 'New blocks'));
    }
    body.push(changeRow(line));
  }

  const notes = [
    ...(plan.fixes.length ? [`The answer's format was repaired, meaning unchanged: ${plan.fixes.join('; ')}.`] : []),
    ...result.warnings,
  ];

  const cancel = el('button', { type: 'button' }, 'Cancel');
  const mapBtn = result.map
    ? el('button', { type: 'button', class: 'link map-link', title: 'Opens in a new tab. Nothing is applied.' }, 'See on logic map')
    : null;
  mapBtn?.addEventListener('click', () => openMap({ kind: 'change', ...result.map, reply: plan.reply !== 'Plan pasted in.' ? plan.reply : '' }));
  const applyBtn = el('button', { class: removes ? 'danger' : 'primary', type: 'button' },
    removes ? `Apply (removes ${removes})` : 'Apply to canvas');
  const foot = el('div', { class: 'review-foot' }, mapBtn, cancel, applyBtn);
  const card = el('section', { class: 'review', 'aria-label': 'Changes to review' },
    el('div', { class: 'review-head' }, el('strong', {}, head),
      plan.reply && plan.reply !== 'Plan pasted in.' ? el('span', { class: 'hint' }, plan.reply) : null),
    body,
    notes.length ? el('div', { class: 'warns' }, notes.map((n) => el('p', {}, n))) : null,
    foot);

  cancel.addEventListener('click', () => foot.replaceWith(el('div', { class: 'done' }, 'Cancelled. Nothing was changed.')));
  applyBtn.addEventListener('click', () => applyPlan(plan, foot));
  return card;
}

async function applyPlan(plan, foot) {
  foot.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    const result = await bg('apply', { actions: plan.actions });
    const next = settings.mode === 'edit'
      ? 'Download or copy this sequence again before the next request.'
      : 'To keep working on it, switch to Edit this sequence.';
    const extra = result.warnings.length ? `\n${result.warnings.join('\n')}` : '';
    // Round 1 of a model-linked sequence: the person picks the model, then sends the sequence back.
    const addsModel = plan.actions.some((a) => a.op === 'create' && a.type === 'model_block');
    const msg = addsModel
      ? `Applied ${plural(result.applied, 'step')}. Next: pick your model in the Select Model block on the canvas, so its points load. Then, in Edit this sequence, copy or download the sequence and send it to your assistant for the rest of the plan.${extra}`
      : `Applied ${plural(result.applied, 'step')}. ${next}${extra}`;
    foot.replaceWith(el('div', { class: 'done' }, msg));
    $('undoBtn').disabled = false;
    refreshStatus();
  } catch (err) {
    foot.querySelectorAll('button').forEach((b) => (b.disabled = false));
    say(err.message, 'error');
  }
}

async function check(actions) {
  try {
    return await bg('preview', { actions });
  } catch {
    // An older bridge, or a preview failure: plain validation still protects the canvas.
    return { ...(await bg('validate', { actions })), lines: [] };
  }
}

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('answer').value.trim();
  if (!text || state.busy) return;

  const found = parseFindings(text);
  if (found.length) {
    const added = await record(found.map((t) => ({ source: 'assistant', kind: 'assistant', text: t })));
    if (added) say(`Saved ${plural(added, 'lesson')} from the assistant for review in Settings.`);
  }

  const plan = parsePastedPlan(stripFindings(text));
  if (!plan) {
    if (found.length) { $('answer').value = ''; return; }
    say('No changes found in that answer. Paste the whole reply, including its json block. Questions and diagnoses don\'t need pasting here.', 'error');
    return;
  }
  if (plan.error) {
    show(problemsCard([plan.error]));
    await record([{ source: 'extension', kind: 'rejected', text: 'The plan\'s JSON could not be read at all.' }]);
    return;
  }

  state.busy = true;
  $('reviewBtn').disabled = true;
  $('reviewBtn').textContent = 'Checking…';
  try {
    const result = await check(plan.actions);
    await record([
      ...plan.fixes.map((f) => ({ source: 'extension', kind: 'repaired', text: `Assistant format slip: ${f}.` })),
      ...result.errors.map((err) => ({ source: 'extension', kind: 'rejected', text: err })),
    ]);
    if (result.errors.length) show(problemsCard(result.errors));
    else if (!plan.actions.length) say('The answer has no changes, so there is nothing to apply.');
    else show(reviewCard(plan, result));
    $('answer').value = '';
  } catch (err) {
    say(err.message, 'error');
  } finally {
    state.busy = false;
    $('reviewBtn').disabled = false;
    $('reviewBtn').textContent = 'Review changes';
  }
});

$('answer').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('composer').requestSubmit(); }
});

$('undoBtn').addEventListener('click', async () => {
  const btn = $('undoBtn');
  btn.disabled = true;
  try {
    let result = await bg('undo');
    if (result.needsConfirm) {
      const ok = confirm('The canvas has been edited since the last Copilot change. Undoing restores the canvas to how it was before that change, so your later edits will be lost too.\n\nUndo anyway?');
      if (!ok) { btn.disabled = false; return; }
      result = await bg('undo', { force: true });
    }
    say('Undone. The canvas is back to how it was before the last Copilot change.', 'ok');
    refreshStatus();
  } catch (err) {
    say(err.message, 'error');
    btn.disabled = /no Copilot change/.test(err.message);
  }
});

// ----------------------------------------------------------------- settings

const knowledgeName = () => `75f-sequencer-block-reference.${settings.assistant === 'copilot' ? 'txt' : 'md'}`;
const skillZipName = () => `${SKILL_NAME}.zip`;
const assistantName = () => ({ chatgpt: 'ChatGPT skill', antigravity: 'Antigravity skill', copilot: 'Copilot agent', claude: 'Claude Project', other: 'assistant' })[settings.assistant] || 'assistant';
const whereToAsk = () => ({
  chatgpt: 'a new ChatGPT chat (with the 75F skill installed)',
  antigravity: 'an Antigravity agent chat in the workspace with the 75F skill',
  copilot: 'your 75F Copilot agent',
  claude: 'a chat in your 75F Claude Project',
})[settings.assistant] || 'your assistant';

/*
 * Setup steps per assistant. Each step is text (with <b> and <code> allowed, built as nodes) and
 * optionally one action. Wording follows each product's own labels as of Nov 2026.
 * ChatGPT and Antigravity take a skill package (SKILL.md + references/), the open Agent Skills
 * format; ChatGPT custom GPTs retire on 11 Dec 2026, so they are no longer offered.
 */
const DOWNLOAD = { action: 'download', label: 'Download knowledge file' };
const COPY = { action: 'copy', label: 'Copy instructions' };
const SKILL = { action: 'skill', label: 'Download skill package' };
const SETUP_STEPS = {
  chatgpt: [
    { text: 'Download the skill package. Keep a Site Sequencer tab open: it reads the palette.', ...SKILL },
    { text: 'In ChatGPT, open <b>Plugins</b> in the sidebar, then the <b>Skills</b> tab. Click <b>Create</b>, then <b>Upload from your computer</b>, and choose <code>{zip}</code>. Don\'t unzip it.' },
    { text: 'Install the skill. Start a new chat: ChatGPT uses it when you ask about the Site Sequencer, or you can name it.' },
    { text: 'To share it, use the skill\'s <b>•••</b> menu to share it with your workspace. To update it, remove the old version and upload the new package.' },
    { text: 'Skills are on Business, Enterprise and Edu workspaces. No <b>Skills</b> tab? Choose <b>Another assistant</b> above and use a ChatGPT project. An old 75F Custom GPT stops working on 11 Dec 2026: replace it with this skill rather than migrating it.' },
  ],
  antigravity: [
    { text: 'Download the skill package. Keep a Site Sequencer tab open: it reads the palette.', ...SKILL },
    { text: 'Unzip it into your workspace\'s <code>.agents/skills/</code> folder, so you get <code>.agents/skills/{skill}/SKILL.md</code>. For every workspace, unzip it into <code>~/.gemini/config/skills/</code> instead (Antigravity 2.0).' },
    { text: 'Start a new agent conversation. The agent loads the skill when you ask about the Site Sequencer, or type <code>/{skill}</code>.' },
    { text: 'For an edit, save the sequence download into the workspace and mention it with <b>@</b>. Paste the agent\'s reply into this panel as usual.' },
    { text: 'To update, delete the old <code>{skill}</code> folder and unzip the new package in its place.' },
  ],
  copilot: [
    { text: 'Download the knowledge file (a .txt: Copilot agents don\'t accept .md). Keep a Site Sequencer tab open.', ...DOWNLOAD },
    { text: 'Copy the instructions.', ...COPY },
    { text: 'In Microsoft 365 Copilot, select <b>New agent</b>, then <b>Skip to configure</b>. To update, open the agent and choose <b>Edit</b>.' },
    { text: 'Paste into <b>Instructions</b>. Under <b>Knowledge</b>, upload <code>{file}</code> and wait until it stops showing grey. Uploading needs a Microsoft 365 Copilot licence.' },
    { text: 'Turn off <b>Search all websites</b> and turn on <b>Only use specified sources</b>.' },
    { text: 'Create the agent, test it on the <b>Try it</b> tab, and share it with specific people or keep it to yourself.' },
  ],
  claude: [
    { text: 'Download the knowledge file. Keep a Site Sequencer tab open: it reads the palette.', ...DOWNLOAD },
    { text: 'Copy the instructions.', ...COPY },
    { text: 'Go to <b>claude.ai/projects</b> and click <b>New project</b>. Claude doesn\'t read the project\'s name or description, so name it for yourself.' },
    { text: 'Click <b>Set project instructions</b>, paste, and click <b>Save instructions</b>.' },
    { text: 'In the project knowledge panel, click <b>+</b> and upload <code>{file}</code>, removing any older copy.' },
    { text: 'Start each chat inside the project. On Team and Enterprise plans, <b>Share project</b> gives colleagues the same setup.' },
  ],
  other: [
    { text: 'Download the knowledge file. Keep a Site Sequencer tab open: it reads the palette.', ...DOWNLOAD },
    { text: 'Copy the instructions.', ...COPY },
    { text: 'Paste them where your assistant takes custom instructions or a system prompt (in a ChatGPT project: <b>Project settings</b>, <b>Instructions</b>). If it has none, paste them at the start of each chat.' },
    { text: 'Add <code>{file}</code> as the assistant\'s knowledge or project file, or attach it to each chat if it can\'t keep files. If your assistant takes skills, the skill package works too.', ...SKILL },
  ],
};

const UPDATE_NOTE = {
  chatgpt: 'When the guide version changes, download the skill package again, replace the installed skill, then start a new chat.',
  antigravity: 'When the guide version changes, download the skill package again, replace the skill folder, then start a new conversation.',
};
const updateNote = () => UPDATE_NOTE[settings.assistant]
  || 'When the guide version changes, repeat steps 1, 2 and the upload, replacing the old file, then start a new chat.';

// Builds a step's text from its small markup (<b>, <code>) without using innerHTML.
function richText(src) {
  const out = [];
  const re = /<(b|code)>(.*?)<\/\1>/g;
  let last = 0;
  for (const m of src.matchAll(re)) {
    if (m.index > last) out.push(src.slice(last, m.index));
    out.push(el(m[1], {}, m[2]));
    last = m.index + m[0].length;
  }
  out.push(src.slice(last));
  return out;
}

function renderSetupSteps() {
  const steps = SETUP_STEPS[settings.assistant] || SETUP_STEPS.other;
  $('setupSteps').replaceChildren(...steps.map((st) => {
    const text = st.text.replaceAll('{file}', knowledgeName()).replaceAll('{zip}', skillZipName()).replaceAll('{skill}', SKILL_NAME);
    const body = [el('span', {}, richText(text))];
    if (st.action) {
      const b = el('button', { type: 'button', class: 'full' }, st.label);
      b.addEventListener('click', { copy: copyInstructions, download: downloadKnowledge, skill: downloadSkill }[st.action]);
      body.push(b);
      if (st.action === 'copy') body.push(el('span', { class: 'hint', id: 'instructionsHint' }, ''));
    }
    return el('li', {}, el('div', { class: 'step-text' }, body));
  }));
  $('setupNote').textContent = updateNote();
}

async function renderSettings() {
  document.querySelectorAll('input[name=assistant]').forEach((r) => { r.checked = r.value === settings.assistant; });
  renderSetupSteps();
  $('showTypes').checked = settings.showTypes;
  $('setupSub').textContent = state.guideVersion
    ? `Guide version ${state.guideVersion}. Do this once, and again when the guide changes.`
    : 'Do this once, and again when the guide changes.';
  $('about').textContent = `Version ${VERSION} · Made by Vinay · works on internal.75f.io and altius.75f.io`;
  if ($('instructionsHint')) try {
    const n = buildAssistantInstructions(await loadGuide(), knowledgeName()).length;
    const limit = { copilot: 8000 }[settings.assistant];
    $('instructionsHint').textContent = limit ? `${n.toLocaleString()} of ${limit.toLocaleString()} characters allowed.` : `${n.toLocaleString()} characters.`;
  } catch { /* guide unavailable */ }
  renderLessons();
}

document.querySelectorAll('input[name=assistant]').forEach((r) => r.addEventListener('change', async () => {
  await saveSettings({ assistant: r.value });
  $('settingsMsg').textContent = '';
  renderSettings();
}));

$('showTypes').addEventListener('change', (e) => saveSettings({ showTypes: e.target.checked }));

$('copyDiagnostics').addEventListener('click', async () => {
  try {
    const text = await bg('diagnoseModelPoints');
    await navigator.clipboard.writeText(text);
    $('diagMsg').textContent = `Copied (${Math.round(text.length / 1000)} kB). Paste it into a message or a text file.`;
  } catch (err) {
    $('diagMsg').textContent = /Unknown method/.test(err.message) ? 'Reload the Sequencer tab once so the update reaches it, then try again.' : err.message;
  }
});

async function copyInstructions() {
  try {
    await navigator.clipboard.writeText(buildAssistantInstructions(await loadGuide(), knowledgeName()));
    $('settingsMsg').textContent = `Instructions copied. Paste them into your ${assistantName()}.`;
  } catch (err) { $('settingsMsg').textContent = err.message; }
}

async function downloadKnowledge() {
  try {
    const [guide, ctx] = await Promise.all([loadGuide(), bg('exportData')]);
    const type = settings.assistant === 'copilot' ? 'text/plain' : 'text/markdown';
    download(buildExport(ctx, { includeSequence: false, guide }), knowledgeName(), type);
    await saveSettings({ setupDone: true });
    $('settingsMsg').textContent = `Downloaded ${knowledgeName()} (${ctx.catalog.length} block types). Upload it to your ${assistantName()}, replacing the old one.`;
  } catch (err) {
    $('settingsMsg').textContent = /Open the 75F|not attached/.test(err.message)
      ? 'Open a Site Sequencer tab in this window first: the knowledge file reads the palette.'
      : err.message;
  }
}

// Skill package: <skill>/SKILL.md + <skill>/references/<block reference>. ChatGPT takes the zip
// as is; Antigravity and Claude Code want the folder, which unzipping gives.
async function downloadSkill() {
  try {
    const [guide, ctx] = await Promise.all([loadGuide(), bg('exportData')]);
    const zip = makeZip({
      [`${SKILL_NAME}/SKILL.md`]: buildSkillMd(guide, state.guideVersion),
      [`${SKILL_NAME}/${SKILL_REFERENCE}`]: buildExport(ctx, { includeSequence: false, guide }),
    });
    download(zip, skillZipName(), 'application/zip');
    await saveSettings({ setupDone: true });
    $('settingsMsg').textContent = `Downloaded ${skillZipName()} (${ctx.catalog.length} block types). Add it to your ${assistantName().replace(/ skill$/, '')} as the next step says, replacing any older copy.`;
  } catch (err) {
    $('settingsMsg').textContent = /Open the 75F|not attached/.test(err.message)
      ? 'Open a Site Sequencer tab in this window first: the skill package reads the palette.'
      : err.message;
  }
}

// ----------------------------------------------------------------- lessons

async function record(items) {
  try { return await addFindings(items); } catch { return 0; }
}

const KIND_LABEL = { assistant: 'assistant', rejected: 'rejected', repaired: 'repaired' };

async function renderLessons() {
  const list = await loadFindings();
  const by = (k) => list.filter((f) => f.kind === k).length;
  $('lessonsSummary').textContent = list.length
    ? `${list.length} unreviewed: ${[by('assistant') && `${by('assistant')} from the assistant`, by('rejected') && `${by('rejected')} rejected`, by('repaired') && `${by('repaired')} repaired`].filter(Boolean).join(', ')}. Check them before they go into the guide.`
    : 'None yet. They come from findings in pasted answers, and from answers this extension rejects or repairs.';
  for (const id of ['downloadLessons', 'copyLessons', 'clearLessons']) $(id).disabled = !list.length;
  $('lessonsDetails').hidden = !list.length;
  $('lessonsList').replaceChildren(...[...list].reverse().map((f) => {
    const remove = el('button', { class: 'link', type: 'button' }, 'Remove');
    remove.addEventListener('click', async () => { await removeFinding(f.id); renderLessons(); });
    return el('li', {}, el('span', { class: `tag ${f.kind}` }, KIND_LABEL[f.kind] || f.kind),
      el('span', {}, f.text, f.count > 1 ? el('span', { class: 'count' }, ` ×${f.count}`) : null), remove);
  }));
}

$('downloadLessons').addEventListener('click', async () => {
  download(findingsMarkdown(await loadFindings(), VERSION), `75f-sequencer-lessons-${stamp()}.md`);
});
$('copyLessons').addEventListener('click', async () => {
  await navigator.clipboard.writeText(findingsMarkdown(await loadFindings(), VERSION));
  $('lessonsSummary').textContent = 'Copied.';
  setTimeout(renderLessons, 1500);
});
$('clearLessons').addEventListener('click', async () => {
  const n = (await loadFindings()).length;
  if (!confirm(`Delete all ${n} lessons? Download them first if you haven't reviewed them.`)) return;
  await clearFindings();
  renderLessons();
});

// ------------------------------------------------------------------- start

try {
  const m = /Guide version (\d+)/.exec(await loadGuide());
  state.guideVersion = m?.[1] ?? null;
} catch { /* the panel still works without it */ }
renderMain();
refreshStatus();
