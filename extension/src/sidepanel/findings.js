/**
 * Findings: lessons from working with an assistant, kept by the extension because assistants
 * cannot write to their own knowledge files. Two sources:
 *  - "assistant": lines from a ```findings block in a pasted reply;
 *  - "extension": what the extension saw itself (rejected plans, format repairs).
 * Everything is stored as [UNREVIEWED] until a person moves it into the block guide.
 */

const KEY = 'findings';
const MAX_FINDINGS = 500;
const MAX_TEXT = 600;

/** Lines of every ```findings block in a reply. Accepts "- ", "* " or numbered lines. */
export function parseFindings(text) {
  const out = [];
  for (const m of text.matchAll(/```\s*findings\s*\n([\s\S]*?)```/gi)) {
    for (const line of m[1].split('\n')) {
      const t = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
      if (t && !/^(none|nothing new)\.?$/i.test(t)) out.push(t.slice(0, MAX_TEXT));
    }
  }
  return out;
}

/** The reply without its findings blocks, so the plan parser never sees them. */
export function stripFindings(text) {
  return text.replace(/```\s*findings\s*\n[\s\S]*?```/gi, '').trim();
}

// Block ids differ on every reload, so "unknown block `a1$…`" errors would never repeat exactly.
// Grouping ignores quoted ids and numbers; the stored text keeps the original wording.
const groupKey = (source, text) => source + '|' + text.toLowerCase()
  .replace(/`[^`]*`|"[^"]*"|“[^”]*”/g, '…')
  .replace(/\d+(\.\d+)?/g, '#')
  .replace(/\s+/g, ' ').trim();

export async function loadFindings() {
  const got = await chrome.storage.local.get(KEY);
  return Array.isArray(got[KEY]) ? got[KEY] : [];
}

async function save(list) {
  await chrome.storage.local.set({ [KEY]: list.slice(-MAX_FINDINGS) });
}

/**
 * Adds findings; a repeat of an earlier one raises its count instead of adding a line.
 * items: [{ source, kind, text }]. Returns how many were new.
 */
export async function addFindings(items) {
  if (!items.length) return 0;
  const list = await loadFindings();
  const now = new Date().toISOString();
  let added = 0;
  for (const { source, kind, text } of items) {
    const key = groupKey(source, text);
    const hit = list.find((f) => f.key === key);
    if (hit) { hit.count += 1; hit.lastSeen = now; continue; }
    list.push({ id: crypto.randomUUID(), key, source, kind, text, count: 1, firstSeen: now, lastSeen: now });
    added += 1;
  }
  await save(list);
  return added;
}

export async function removeFinding(id) {
  await save((await loadFindings()).filter((f) => f.id !== id));
}

export async function clearFindings() {
  await chrome.storage.local.remove(KEY);
}

const KIND_TITLES = {
  assistant: 'Reported by the assistant',
  rejected: 'Plans the extension rejected',
  repaired: 'Format slips the extension repaired',
};

/** Markdown for review. Nothing here is trusted until a person confirms it. */
export function findingsMarkdown(list, version) {
  const day = (iso) => iso.slice(0, 10);
  const out = [
    '# 75F Sequencer Copilot: findings',
    '',
    `Collected by Sequencer Copilot v${version}. Exported ${day(new Date().toISOString())}. ${list.length} finding${list.length === 1 ? '' : 's'}.`,
    '',
    'Every line is **[UNREVIEWED]**. Confirm each one before moving it into the block guide: a finding is what an assistant believed or what the extension saw, not a verified fact. "×N" is how often it came up.',
  ];
  for (const kind of Object.keys(KIND_TITLES)) {
    const group = list.filter((f) => f.kind === kind).sort((a, b) => b.count - a.count || a.firstSeen.localeCompare(b.firstSeen));
    if (!group.length) continue;
    out.push('', `## ${KIND_TITLES[kind]}`, '');
    for (const f of group) {
      const seen = f.count > 1 ? ` (×${f.count}, ${day(f.firstSeen)} to ${day(f.lastSeen)})` : ` (${day(f.firstSeen)})`;
      out.push(`- [UNREVIEWED] ${f.text}${seen}`);
    }
  }
  return out.join('\n') + '\n';
}
