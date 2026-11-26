/**
 * Writes the controller's log to a file in a folder the person picked (File System Access API).
 * The folder is remembered (IndexedDB) so it only has to be picked once. Lines are buffered and
 * written every few seconds; an existing file with the same name is added to, not replaced.
 * A file that passes PART_BYTES continues in "name-2.txt", "name-3.txt"…, so each save stays quick.
 */

const DB = 'copilot-files';
const STORE = 'handles';
const KEY = 'logFolder';
const PART_BYTES = 20 * 1024 * 1024;
const FLUSH_MS = 5000;

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { open.result.close(); resolve(req?.result); };
      tx.onerror = () => { open.result.close(); reject(tx.error); };
    };
  });
}
export const loadFolder = () => idb('readonly', (s) => s.get(KEY)).catch(() => null);
export const saveFolder = (handle) => idb('readwrite', (s) => s.put(handle, KEY));

/** Keeps a file name safe for Windows and gives it an extension. */
export function cleanName(name) {
  let n = String(name || '').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/, '');
  if (!n) n = defaultName();
  if (!/\.(txt|log)$/i.test(n)) n += '.txt';
  return n;
}

export function defaultName(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `controller-log-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`;
}

export function stamp(d = new Date()) {
  const p = (x, n = 2) => String(x).padStart(n, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Name of part n: "log.txt" → "log-2.txt". */
export const partName = (name, n) => (n <= 1 ? name : name.replace(/(\.[^.]+)$/, `-${n}$1`));

/** Asks for write access to the remembered folder (needs a click). Returns true if granted. */
export async function ensureAccess(folder) {
  if (!folder) return false;
  const opts = { mode: 'readwrite' };
  if ((await folder.queryPermission(opts)) === 'granted') return true;
  return (await folder.requestPermission(opts)) === 'granted';
}

export function createLogFile({ onState = () => {} } = {}) {
  let folder = null;
  let name = null;
  let part = 1;
  let queue = [];
  let timer = null;
  let writing = Promise.resolve();
  let state = { on: false, bytes: 0, lines: 0, file: null, error: '' };

  const set = (patch) => { state = { ...state, ...patch }; onState(state); };

  async function writeOut() {
    if (!queue.length || !folder) return;
    const text = queue.join('');
    queue = [];
    try {
      let handle = await folder.getFileHandle(partName(name, part), { create: true });
      let size = (await handle.getFile()).size;
      if (size > PART_BYTES) {
        part += 1;
        handle = await folder.getFileHandle(partName(name, part), { create: true });
        size = (await handle.getFile()).size;
      }
      const w = await handle.createWritable({ keepExistingData: true });
      await w.seek(size);
      await w.write(text);
      await w.close();
      set({ bytes: state.bytes + text.length, file: partName(name, part), error: '' });
    } catch (err) {
      queue.unshift(text); // keep it for the next try
      set({ error: /permission|not allowed/i.test(err.message)
        ? 'Chrome no longer lets the extension write to that folder. Press Start saving again.'
        : `Couldn't write the log: ${err.message}` });
    }
  }
  const flush = () => { writing = writing.then(writeOut); return writing; };

  return {
    get state() { return state; },
    /** Starts saving to folder/fileName, first writing the lines already received (backlog). */
    async start(dir, fileName, backlog = [], { times = true } = {}) {
      folder = dir;
      name = cleanName(fileName);
      part = 1;
      // Continue an earlier part if the file was already split.
      while (true) {
        try { await folder.getFileHandle(partName(name, part + 1)); part += 1; } catch { break; }
      }
      state = { on: true, bytes: 0, lines: backlog.length, file: partName(name, part), error: '', times };
      queue = [`===== Recording started ${stamp()} by 75F Sequencer Copilot =====\n`];
      if (backlog.length) queue.push(`----- ${backlog.length} lines received before saving started -----\n`, ...backlog.map((l) => `${l}\n`), '----- live from here -----\n');
      clearInterval(timer);
      timer = setInterval(flush, FLUSH_MS);
      onState(state);
      await flush();
      return name;
    },
    /** One complete line from the controller. */
    line(text) {
      if (!state.on) return;
      queue.push(state.times ? `[${stamp()}] ${text}\n` : `${text}\n`);
      state.lines += 1;
    },
    note(text) { if (state.on) queue.push(`===== ${text} ${stamp()} =====\n`); },
    async stop() {
      if (!state.on) return;
      queue.push(`===== Recording stopped ${stamp()} =====\n`);
      clearInterval(timer);
      await flush();
      set({ on: false });
    },
  };
}
