/**
 * Isolated-world relay: chrome.runtime messaging <-> MAIN-world bridge.
 * Only resolves responses for requests it issued itself.
 */
(() => {
  'use strict';
  const CHANNEL = '75f-seq-copilot';
  const pending = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.dir !== 'res') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
  });

  function callPage(method, params, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`The page did not answer "${method}" in time.`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ channel: CHANNEL, dir: 'req', id, method, params }, window.location.origin);
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== 'page') return false;
    callPage(msg.method, msg.params).then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: err.message }),
    );
    return true; // async response
  });
})();
