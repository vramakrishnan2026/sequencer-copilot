import { createLogReader, summarize, thin, usedShare } from './livelog.js';
import { createSerialLink } from './serial-link.js';

/**
 * "Controller on USB" card in the Memory check: reads the controller's log live over USB, records
 * the start-up reading and every run, and shows whether memory builds up over time. Recordings
 * are kept in this browser so a long test survives reopening the panel.
 */

const STORE_KEY = 'heapLive';
const MAX_SESSIONS = 5;
const MAX_RUNS = 20000; // about 55 hours at one run every 10 seconds
const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

function el(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(tag === 'svg' || attrs._svg ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === '_svg' || v == null || v === false) continue;
    if (k === 'class') n.setAttribute('class', v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
  return n;
}
const svg = (tag, attrs = {}, ...kids) => el(tag, { ...attrs, _svg: true }, ...kids);

const pct = (used) => `${Math.round(usedShare(used) * 100)}%`;
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (ms) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
function span(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ${min % 60} min` : `${Math.floor(h / 24)} days ${h % 24} h`;
}

/** Does the sequence on the controller look like the canvas? */
export function matchCanvas(seq, canvas) {
  if (!seq?.length || !canvas) return 'unknown';
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const a = norm(seq.name);
  const b = norm(canvas.name);
  const sameName = a && b && (a === b || a.includes(b) || b.includes(a));
  if (canvas.exact && canvas.mpyBytes) return Math.abs(seq.length - canvas.mpyBytes) <= 16 ? 'same' : 'different';
  if (sameName) return 'name';
  if (canvas.mpyBytes && Math.abs(seq.length - canvas.mpyBytes) / seq.length < 0.03) return 'likely';
  return 'different';
}

export function createLiveView(root, { canvas = () => null } = {}) {
  let status = { state: 'off', baud: 115200 };
  let error = '';
  let saved = [];          // earlier recordings: { id, summary, runs: [[t, used, maxFree]] }
  let tail = [];           // last lines of the raw log
  let lineBuf = '';
  let showLog = false;
  let dirty = false;
  let lastText = 0;

  const reader = createLogReader({
    onBoot: (old) => { store(old); },
    onReading: () => { dirty = true; schedule(); },
  });

  const link = createSerialLink({
    onText: (t) => {
      lastText = Date.now();
      reader.push(t);
      lineBuf += t;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      if (lines.length) tail = tail.concat(lines.map((x) => x.replace(/\r$/, ''))).slice(-200);
      if (showLog) schedule();
    },
    onStatus: (s) => { status = s; if (s.state !== 'connected') store(reader.session); schedule(); },
  });

  // --------------------------------------------------------------------------------- storage
  const idOf = (s) => `${s.sequence?.signature || 'unknown'}@${s.bootAt}`;
  async function loadSaved() {
    const got = await chrome.storage.local.get(STORE_KEY);
    saved = Array.isArray(got[STORE_KEY]) ? got[STORE_KEY] : [];
  }
  async function store(session) {
    if (!session || !(session.startup || session.runs.length)) return;
    if (session.runs.length > MAX_RUNS) session.runs.splice(0, session.runs.length - MAX_RUNS);
    const entry = {
      id: idOf(session),
      summary: summarize(session),
      runs: session.runs.map((r) => [Math.round(r.at / 1000), r.used, r.maxFree]),
    };
    saved = [entry, ...saved.filter((x) => x.id !== entry.id)].slice(0, MAX_SESSIONS);
    dirty = false;
    try { await chrome.storage.local.set({ [STORE_KEY]: saved }); } catch { /* storage full: keep going live */ }
  }
  setInterval(() => { if (dirty) store(reader.session); }, 15000);

  // ------------------------------------------------------------------------------- rendering
  let timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; render(); }, 500);
  }

  function chart(runs, startupUsed) {
    const pts = thin(runs);
    if (pts.length < 2) return null;
    const W = 300;
    const H = 80;
    const t0 = pts[0].at;
    const t1 = pts[pts.length - 1].at;
    const x = (t) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * W : 0);
    const y = (used) => H - Math.min(1, usedShare(used)) * H;
    const line = pts.map((r) => `${x(r.at).toFixed(1)},${y(r.used).toFixed(1)}`).join(' ');
    return el('figure', { class: 'live-chart' },
      svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img',
        'aria-label': `Memory used at the end of each run, from ${clock(t0)} to ${clock(t1)}` },
      svg('line', { x1: 0, x2: W, y1: 0.5, y2: 0.5, class: 'top' }),
      startupUsed != null ? svg('line', { x1: 0, x2: W, y1: y(startupUsed), y2: y(startupUsed), class: 'startup' }) : null,
      svg('polyline', { points: line, class: 'used' })),
      el('figcaption', {},
        el('span', {}, clock(t0)),
        el('span', {}, startupUsed != null ? 'end of each run · dashed: after start-up' : 'end of each run'),
        el('span', {}, clock(t1))));
  }

  function sessionBlock(s, { live }) {
    const sum = s.summary || summarize(s);
    const seq = sum.sequence;
    const cv = canvas();
    const match = matchCanvas(seq, cv);
    const matchText = {
      same: 'Same program as this canvas',
      name: 'Same name as this canvas',
      likely: 'Probably this canvas (size close)',
      different: 'Not this canvas',
      unknown: '',
    }[match];
    const compare = (match === 'same' || match === 'name' || match === 'likely') && cv?.pct != null;
    const runs = s.runs.map((r) => (Array.isArray(r) ? { at: r[0] * 1000, used: r[1], maxFree: r[2] } : r));

    let over;
    if (sum.trend === 'growing') over = el('p', { class: 'live-over bad' }, el('strong', {}, 'Over time: building up. '), `The lowest "used" has risen by ${sum.rise} bytes since the start. It will run out of memory if this continues.`);
    else if (sum.trend === 'steady') over = el('p', { class: 'live-over ok' }, el('strong', {}, 'Over time: steady. '), `Same pattern for ${sum.runs} runs over ${span(sum.lastRunAt - sum.firstRunAt)}. Nothing is building up.`);
    else if (sum.runs) over = el('p', { class: 'live-over' }, el('strong', {}, 'Over time: '), 'watching. A few more runs are needed to tell.');

    return el('div', { class: 'live-session' },
      seq?.name ? el('p', { class: 'live-seq' }, el('strong', {}, seq.name), ` · ${seq.length?.toLocaleString()} bytes`,
        matchText ? el('span', { class: `chip ${match === 'different' ? 'warn' : 'ok'}` }, matchText) : null) : null,
      sum.startup
        ? el('p', {}, el('strong', {}, 'After start-up: '), `${pct(sum.startup.used)} used, largest free piece ${sum.startup.maxFree ?? '?'} blocks`,
          compare ? el('span', { class: 'hint' }, ` (predicted ${Math.round(cv.pct * 100)}%, ${Math.round(cv.maxFreeBlocks)} blocks)`) : null)
        : el('p', { class: 'hint' }, sum.runs
          ? 'After start-up: not captured, the controller was already running. Restart it (or push the sequence again) with this panel open to capture it.'
          : 'Waiting for the first reading…'),
      sum.runs ? el('p', {}, el('strong', {}, 'Each run: '), `ends at ${pct(sum.lastUsed)} used (the controller clears it before the next run). Lowest free piece seen: ${sum.lowestMaxFree ?? '?'} blocks.`) : null,
      over,
      chart(runs, sum.startup?.used ?? null),
      sum.runs ? el('p', { class: 'hint' }, `${sum.runs} runs since ${live ? clock(sum.firstRunAt) : `${day(sum.firstRunAt)} ${clock(sum.firstRunAt)}`}${live ? '' : `, until ${clock(sum.lastRunAt)}`}.`) : null);
  }

  function render() {
    const supported = link.supported();
    const live = reader.session;
    const connected = status.state === 'connected' || status.state === 'waiting';

    // A controller on native USB ("USB Serial Device") ignores the speed; only a USB-to-serial
    // adapter needs it, so it's tucked away.
    const baud = el('select', { 'aria-label': 'Port speed (baud rate)' },
      BAUDS.map((b) => el('option', { value: String(b), selected: b === status.baud || null }, `${b.toLocaleString()} baud`)));
    const connectBtn = el('button', { type: 'button', class: 'primary', disabled: !supported || null, onclick: async () => {
      error = '';
      try { await link.connect(baud.value); } catch (err) {
        if (err.name !== 'NotFoundError') error = err.message; // NotFoundError: the person closed the picker
      }
      render();
    } }, 'Connect controller');
    const disconnectBtn = el('button', { type: 'button', onclick: async () => { await link.disconnect(); render(); } }, 'Disconnect');

    const head = el('div', { class: 'live-head' },
      el('h2', {}, 'Controller on USB'),
      connected ? el('span', { class: `chip ${status.state === 'connected' ? 'ok' : 'warn'}` },
        status.state === 'connected' ? 'Connected' : 'Reconnecting…') : null);

    const parts = [head];
    if (!connected) {
      parts.push(el('p', { class: 'hint' }, supported
        ? 'Plug the controller into this computer by USB to watch its memory live: the reading after start-up and every run after it. Keep this panel open while it records. Close Tera Term or any other program using the port first, then pick the controller (for example "USB Serial Device (COM26)").'
        : 'This browser can\'t open USB serial ports. Use Chrome or Edge on a desktop computer.'));
      parts.push(el('div', { class: 'live-row' }, connectBtn));
      parts.push(el('details', { class: 'live-earlier' },
        el('summary', {}, 'Using a USB-to-serial adapter instead?'),
        el('p', { class: 'hint' }, 'Pick the speed the adapter uses. A controller plugged in directly ignores this.'),
        el('div', { class: 'live-row' }, baud)));
    } else {
      const quiet = lastText && Date.now() - lastText > 30000;
      parts.push(live
        ? sessionBlock(live, { live: true })
        : el('p', { class: 'hint' }, 'Connected. Waiting for the controller\'s log… Restart the controller or push the sequence to capture the start-up reading.'));
      if (quiet) parts.push(el('p', { class: 'hint' }, `Nothing received for ${span(Date.now() - lastText)}. Is the controller on and running a sequence?`));
      const logToggle = el('button', { type: 'button', class: 'link', onclick: () => { showLog = !showLog; render(); } }, showLog ? 'Hide log' : 'Show log');
      parts.push(el('div', { class: 'live-row' }, disconnectBtn, logToggle));
      if (showLog) parts.push(el('pre', { class: 'live-log', 'aria-label': 'Latest lines from the controller' }, tail.slice(-80).join('\n')));
    }
    if (error) parts.push(el('p', { class: 'error', role: 'alert' }, error));

    const liveId = live ? idOf(live) : null;
    const earlier = saved.filter((x) => x.id !== liveId);
    if (earlier.length) {
      parts.push(el('details', { class: 'live-earlier' },
        el('summary', {}, `Earlier recordings (${earlier.length})`),
        earlier.map((x) => sessionBlock({ summary: x.summary, runs: x.runs }, { live: false })),
        el('button', { type: 'button', class: 'link', onclick: async () => {
          saved = saved.filter((x) => x.id === liveId);
          await chrome.storage.local.set({ [STORE_KEY]: saved });
          render();
        } }, 'Delete earlier recordings')));
    }
    root.replaceChildren(el('section', { class: 'card heap-card live-card' }, parts));
  }

  loadSaved().then(render);
  setInterval(() => { if (status.state === 'connected') schedule(); }, 10000);
  return { render };
}

