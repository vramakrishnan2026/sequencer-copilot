/**
 * Service worker: finds the Sequencer tab and the frame that draws the Blockly canvas,
 * then relays side-panel requests to the page bridge. No AI calls happen here.
 */

// Portals that host the Site Sequencer. Add new ones here (and keep them under *.75f.io,
// which the manifest's host permissions and content scripts already cover).
const SEQ_PREFIXES = [
  'https://internal.75f.io/site-sequencer',
  'https://altius.75f.io/site-sequencer',
];
const isSequencer = (url) => typeof url === 'string' && SEQ_PREFIXES.some((p) => url.startsWith(p));

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

async function sequencerTab(windowId) {
  const query = windowId ? { active: true, windowId } : { active: true, lastFocusedWindow: true };
  const [tab] = await chrome.tabs.query(query);
  if (!isSequencer(tab?.url)) throw new Error('Open the 75F Site Sequencer in this window first.');
  return tab;
}

// The Blockly canvas may live in an iframe. Find the frame that draws it.
async function canvasFrame(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => document.querySelectorAll('.blocklySvg').length,
    });
    const best = results.filter((r) => r.result > 0).sort((a, b) => b.result - a.result)[0];
    if (best) return best.frameId;
  } catch { /* fall back to the top frame */ }
  return 0;
}

async function pageCall(tabId, method, params = {}) {
  const frameId = await canvasFrame(tabId);
  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, { target: 'page', method, params }, { frameId });
  } catch {
    throw new Error('The extension is not attached to this tab yet. Reload the Sequencer page.');
  }
  if (!res?.ok) throw new Error(res?.error || 'The page did not respond.');
  return res.result;
}

const onCanvas = (method, pick = () => ({})) => async (msg) => {
  const tab = await sequencerTab(msg.windowId);
  return pageCall(tab.id, method, pick(msg));
};

const HANDLERS = {
  status: onCanvas('status'),
  exportData: onCanvas('getContext', () => ({ refreshCatalog: true })),
  logicMap: onCanvas('logicMap'),
  simulatorModel: onCanvas('simulatorModel'),
  heapSource: onCanvas('heapSource'),
  mpyBuild: onCanvas('mpyBuild', (m) => ({ python: m.python })),
  diagnoseModelPoints: onCanvas('diagnoseModelPoints'),
  validate: onCanvas('validate', (m) => ({ actions: m.actions })),
  preview: onCanvas('preview', (m) => ({ actions: m.actions })),
  apply: onCanvas('apply', (m) => ({ actions: m.actions })),
  undo: onCanvas('undo', (m) => ({ force: !!m.force })),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg?.type || !Object.hasOwn(HANDLERS, msg.type)) return false;
  HANDLERS[msg.type](msg).then(
    (result) => sendResponse({ ok: true, result }),
    (err) => sendResponse({ ok: false, error: err?.message || String(err) }),
  );
  return true;
});
