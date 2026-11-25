import { HEAP, parseGcLine } from './estimate.js';

/**
 * Reads the controller's USB log line by line and keeps what the memory check needs: which
 * sequence is loaded, the GC reading after start-up (the true size) and the GC reading after
 * every run. Pure: no browser APIs, so it can be tested with saved logs.
 *
 * A reading counts as start-up when its Enter/Exit section configured registers, or when it is
 * the first section after the module loaded and it read no registers (a sequence without
 * registers). Otherwise it's a run: a log that starts mid-way has no start-up reading.
 */
export function createLogReader({ now = () => Date.now(), onBoot = () => {}, onReading = () => {} } = {}) {
  let session = null; // the current boot
  let meta = null;    // which metadata block we're in: 'active' | 'update' | null
  let section = null; // the current Enter/Exit section
  let pendingGc = null;
  let sectionsSinceLoad = 0;
  let loaded = false;

  function newSession(how) {
    if (session && (session.startup || session.runs.length)) onBoot(session);
    session = { bootAt: now(), how, sequence: null, startup: null, startupMissed: false, runs: [] };
    loaded = false;
    sectionsSinceLoad = 0;
    section = null;
    pendingGc = null;
  }

  function finishGc() {
    if (!pendingGc) return;
    const gc = parseGcLine(pendingGc.text);
    const sec = pendingGc.section;
    pendingGc = null;
    if (!gc) return;
    if (!session) newSession('joined');
    const reading = { at: now(), used: gc.used, free: gc.free, total: gc.total, maxFree: gc.maxFree, maxBlk: gc.maxBlk, timeMs: sec?.timeMs ?? null };
    const startup = sec && (sec.configuring || (sec.firstAfterLoad && !sec.reads));
    if (startup && !session.startup && !session.runs.length) {
      session.startup = reading;
      onReading('startup', reading, session);
    } else {
      if (!session.startup) session.startupMissed = true;
      session.runs.push(reading);
      onReading('run', reading, session);
    }
  }

  function line(raw) {
    const t = String(raw).replace(/\r$/, '');
    if (pendingGc) {
      if (/blocks:|max free sz/i.test(t)) { pendingGc.text += `\n${t}`; finishGc(); return; }
      finishGc();
    }
    if (/75F Connect-Module\(/.test(t)) { newSession('boot'); return; }
    if (!session) newSession('joined');
    if (/ACTIVE SEQUENCE METADATA/i.test(t)) { meta = 'active'; session.sequence = { name: null, length: null, signature: null }; return; }
    if (/UPDATE SEQUENCE METADATA/i.test(t)) { meta = 'update'; return; }
    if (meta === 'active') {
      let m;
      if ((m = t.match(/^\s*Name:\s*(.*)$/))) { session.sequence.name = m[1].trim(); return; }
      if ((m = t.match(/^\s*Length:\s*(-?\d+)/))) { session.sequence.length = Number(m[1]); return; }
      if ((m = t.match(/^\s*Signature:\s*([0-9A-F ]+)$/i))) { session.sequence.signature = m[1].replace(/\s+/g, '').toUpperCase(); meta = null; return; }
    }
    if (/Module Loaded/i.test(t)) { loaded = true; sectionsSinceLoad = 0; return; }
    if (/Enter Sequence/i.test(t)) {
      section = { configuring: false, reads: false, timeMs: null, firstAfterLoad: loaded && sectionsSinceLoad === 0 };
      sectionsSinceLoad += 1;
      return;
    }
    if (section) {
      if (/Configuring register/i.test(t)) section.configuring = true;
      else if (/readModbusRegister/i.test(t)) section.reads = true;
      const m = t.match(/Sequence Time\(ms\):\s*([\d.]+)/i);
      if (m) section.timeMs = Number(m[1]);
    }
    if (/GC:\s*total:/i.test(t)) {
      pendingGc = { text: t, section };
      section = null;
      if (/max free sz/i.test(t)) finishGc();
    }
  }

  let buf = '';
  return {
    line,
    /** Feeds raw text (any chunking); complete lines are processed. */
    push(text) {
      buf += text;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    },
    /** Processes anything left (end of a saved log). */
    flush() { if (buf) { line(buf); buf = ''; } finishGc(); },
    get session() { return session; },
  };
}

/** Share of the memory for sequences that a "used" figure stands for (as on the gauge). */
export const usedShare = (used) => Math.max(0, (used - HEAP.baseline) / HEAP.budget);

/**
 * Is memory building up over the runs? Each run ends near full and the controller cleans up, so
 * compare the lowest "used" early on with the lowest lately: a fixed set of values keeps it the same.
 */
export function trendOf(runs) {
  if (runs.length < 6) return { trend: 'unknown' };
  const n = Math.max(3, Math.floor(runs.length / 5));
  const low = (list) => Math.min(...list.map((r) => r.used));
  const early = low(runs.slice(0, n));
  const late = low(runs.slice(-n));
  const rise = late - early;
  return { trend: rise >= 64 ? 'growing' : 'steady', rise, early, late };
}

/** Summary of one boot's readings, for display and storage. */
export function summarize(session) {
  const runs = session.runs;
  const t = trendOf(runs);
  const lowFree = runs.reduce((m, r) => (r.maxFree != null && (m == null || r.maxFree < m) ? r.maxFree : m), null);
  const peak = runs.reduce((m, r) => Math.max(m, r.used), 0);
  return {
    sequence: session.sequence,
    bootAt: session.bootAt,
    how: session.how,
    startup: session.startup,
    startupMissed: session.startupMissed,
    runs: runs.length,
    firstRunAt: runs[0]?.at ?? null,
    lastRunAt: runs[runs.length - 1]?.at ?? null,
    lastUsed: runs[runs.length - 1]?.used ?? null,
    peakUsed: runs.length ? peak : null,
    lowestMaxFree: lowFree,
    ...t,
  };
}

/** Thins a long series to about n points for a chart, keeping each slice's highest value. */
export function thin(runs, n = 240) {
  if (runs.length <= n) return runs;
  const step = runs.length / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const slice = runs.slice(Math.floor(i * step), Math.floor((i + 1) * step));
    out.push(slice.reduce((a, b) => (b.used > a.used ? b : a)));
  }
  return out;
}
