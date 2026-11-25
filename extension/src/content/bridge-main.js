/**
 * MAIN-world bridge. Runs inside the page's JS context so it can reach the
 * page's Blockly instance directly. It never evaluates model output as code:
 * it only executes a fixed, validated set of operations.
 *
 * Protocol: window.postMessage({ channel, dir: 'req', id, method, params })
 *        -> window.postMessage({ channel, dir: 'res', id, ok, result | error })
 */
(() => {
  'use strict';
  if (window.__seqCopilotBridge) return;
  window.__seqCopilotBridge = true;

  const CHANNEL = '75f-seq-copilot';
  // Exports go to AI assistants as files, so keep the whole sequence unless it is enormous.
  const MAX_CONTEXT_CHARS = 1_500_000;
  const MAX_CATALOG_TYPES = 250;
  const MAX_OPTIONS = 1000; // BACnet units alone has ~250 options; never cut them silently
  // Blocks that only exist inside Blockly's gear pop-ups; they can never be placed on a canvas.
  const MUTATOR_HELPER = /(_container|_item|_if_if|_if_elseif|_if_else|mutatorcontainer|mutatorarg)$/;
  const INPUT_VALUE = 1; // Blockly.ConnectionType.INPUT_VALUE

  const catalogCache = new Map();
  let lastApply = null; // { groupId, snapshot }

  // ---------------------------------------------------------------- lookup

  // The real Blockly namespace: has block definitions and a way to reach the workspace.
  function isBlockly(v) {
    return !!v && typeof v === 'object' && !!v.Blocks &&
      (typeof v.getMainWorkspace === 'function' || typeof v.common?.getMainWorkspace === 'function');
  }

  let cached = null; // { B, ws }
  let lastDiagnosis = '';

  // Every Blockly copy we can reach. Apps sometimes ship more than one; we keep all of
  // them and later choose the copy that actually owns the visible canvas.
  function blocklyCandidates() {
    const found = new Set();
    const add = (v) => { if (isBlockly(v)) found.add(v); };
    try { add(typeof Blockly !== 'undefined' ? Blockly : null); } catch { /* not declared */ }
    add(window.Blockly);
    for (const key of Object.getOwnPropertyNames(window)) {
      try { add(window[key]); } catch { /* hostile getter */ }
    }
    for (const hit of blocklyFromWebpack()) add(hit);
    return [...found];
  }

  // The 75F app bundles Blockly inside its webpack build (window.Blockly is only a stub),
  // so reach into the webpack module registry for the real copies.
  function blocklyFromWebpack() {
    const hits = [];
    const pick = (exp) => { for (const c of [exp, exp?.default]) if (isBlockly(c)) hits.push(c); };
    const chunkKeys = Object.getOwnPropertyNames(window)
      .filter((k) => k.startsWith('webpackChunk') && Array.isArray(window[k]));
    webpackInfo = { registries: chunkKeys.length, bigModules: 0 };

    for (const key of chunkKeys) {
      let req = null;
      try {
        // Pushing a no-op chunk makes webpack hand us its require function.
        window[key].push([[`seq-copilot-${Date.now()}-${Math.random()}`], {}, (r) => { req = r; }]);
      } catch { continue; }
      if (!req?.m) continue;
      if (req.c) for (const id of Object.keys(req.c)) pick(req.c[id]?.exports);

      for (const id of Object.keys(req.m)) {
        let src = '';
        try { src = Function.prototype.toString.call(req.m[id]); } catch { continue; }
        if (src.length < 100_000 || !src.includes('getMainWorkspace')) continue;
        webpackInfo.bigModules++;
        try { pick(req(id)); } catch { /* try the next module */ }
      }
    }
    return hits;
  }
  let webpackInfo = { registries: 0, bigModules: 0 };

  const isCanvas = (w) => !!w && typeof w.getTopBlocks === 'function' && !w.isFlyout && !w.isMutator &&
    !w.disposed && w.rendered !== false;

  // All workspaces a Blockly copy knows about (API differs between versions).
  function allWorkspaces(B) {
    const lists = [
      () => B.common?.getAllWorkspaces?.(),
      () => B.Workspace?.getAll?.(),
      () => Object.values(B.Workspace?.WorkspaceDB_ ?? {}),
    ];
    for (const get of lists) {
      try { const l = get(); if (Array.isArray(l) && l.length) return l; } catch { /* next */ }
    }
    return [];
  }

  // The visible canvas: prefer the "main" workspace, else the attached one with most blocks.
  function getMainWorkspace(B) {
    const direct = [
      () => B.getMainWorkspace?.(),
      () => B.common?.getMainWorkspace?.(),
      () => B.mainWorkspace,
      () => (typeof B.getSelected === 'function' ? B.getSelected() : B.common?.getSelected?.())?.workspace,
    ];
    for (const get of direct) {
      try {
        const w = get();
        const svg = w?.getParentSvg?.();
        if (isCanvas(w) && (!svg || svg.isConnected)) return w;
      } catch { /* next */ }
    }
    return allWorkspaces(B)
      .filter((w) => isCanvas(w) && (w.getParentSvg?.()?.isConnected ?? true))
      .sort((a, b) => b.getAllBlocks(false).length - a.getAllBlocks(false).length)[0] || null;
  }

  // ----------------------------------------------------------- change watch
  // Counts real edits to the canvas (not selecting, scrolling or zooming), so the panel can tell
  // whether the sequence changed since it was last copied. canvasId changes when the page reloads
  // or the editor swaps in a new workspace, so an old count is never mistaken for the current one.
  const watch = { ws: null, canvasId: '', seq: 0, at: null };
  function watchCanvas(ws) {
    if (watch.ws === ws) return;
    watch.ws = ws;
    watch.canvasId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    watch.seq = 0;
    watch.at = null;
    try {
      ws.addChangeListener((e) => {
        if (!e || e.isUiEvent || e.type === 'ui' || e.type === 'finished_loading') return;
        watch.seq += 1;
        watch.at = new Date().toISOString();
      });
    } catch { /* an editor without change events: the panel falls back to block counts */ }
  }
  const changeInfo = () => ({ canvasId: watch.canvasId, changeSeq: watch.seq, changedAt: watch.at });

  function env() {
    if (cached && cached.ws.getParentSvg?.()?.isConnected !== false && !cached.ws.disposed) return cached;
    cached = null;
    const copies = blocklyCandidates();
    const options = copies
      .map((B) => ({ B, ws: getMainWorkspace(B) }))
      .filter((o) => o.ws)
      .sort((a, b) => b.ws.getAllBlocks(false).length - a.ws.getAllBlocks(false).length);
    if (options.length) {
      cached = options[0];
      watchCanvas(cached.ws);
      return cached;
    }

    const deepCount = (root) => {
      let n = root.querySelectorAll('.blocklySvg').length;
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) n += deepCount(el.shadowRoot);
      return n;
    };
    const frames = [...document.querySelectorAll('iframe')].map((f) => {
      try { return new URL(f.getAttribute('src') || 'about:blank', location.href).host || 'blank'; } catch { return '?'; }
    });
    lastDiagnosis = `copies=${copies.length} [${copies.map((B) => `${B.VERSION || '?'}:${allWorkspaces(B).length}ws`).join(', ')}], ` +
      `canvases=${document.querySelectorAll('.blocklySvg').length}/${deepCount(document)}, ` +
      `iframes=${frames.length ? frames.join('|') : 0}, frame=${window === window.top ? 'top' : location.host}, ` +
      `webpack=${webpackInfo.registries}/${webpackInfo.bigModules}`;
    if (!copies.length) throw new Error(`Blockly was not found on this page. (${lastDiagnosis})`);
    throw new Error(`Blockly ${copies[0].VERSION || ''} is loaded, but its canvas was not found. (${lastDiagnosis})`);
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  // ------------------------------------------------------------ describing

  function namedFields(block) {
    const out = [];
    for (const input of block.inputList) for (const f of input.fieldRow) if (f.name) out.push(f);
    return out;
  }

  function plain(v) {
    return v == null || typeof v !== 'object' ? v : JSON.stringify(v);
  }

  function inputKind(input) {
    if (!input.connection) return null;
    return input.connection.type === INPUT_VALUE ? 'value' : 'statement';
  }

  function checkOf(conn) {
    if (!conn) return null;
    return typeof conn.getCheck === 'function' ? conn.getCheck() : (conn.check_ ?? null);
  }

  const isVariableField = (f) => typeof f.getVariable === 'function';

  function fieldKind(B, f) {
    if (isVariableField(f)) return 'variable';
    if (typeof f.getOptions === 'function') return 'dropdown';
    if (B.FieldCheckbox && f instanceof B.FieldCheckbox) return 'checkbox';
    if (B.FieldNumber && f instanceof B.FieldNumber) return 'number';
    if (B.FieldTextInput && f instanceof B.FieldTextInput) return 'text';
    if (B.FieldLabel && f instanceof B.FieldLabel) return 'label';
    return 'other';
  }

  function dropdownOptions(field) {
    if (typeof field.getOptions !== 'function') return null;
    try {
      const all = field.getOptions(false);
      const list = all.slice(0, MAX_OPTIONS).map(([label, value]) =>
        typeof label === 'string' && label !== value ? { v: value, l: label } : value);
      if (all.length > MAX_OPTIONS) list.push({ v: '…', l: `${all.length - MAX_OPTIONS} more options not listed` });
      return list;
    } catch {
      return null; // dynamic generators can throw on a scratch workspace
    }
  }

  function describe(block, depth) {
    const node = { id: block.id, type: block.type };
    const fields = {};
    for (const f of namedFields(block)) {
      try {
        fields[f.name] = isVariableField(f) ? (f.getVariable()?.name ?? plain(f.getValue())) : plain(f.getValue());
      } catch { /* ignore */ }
    }
    if (Object.keys(fields).length) node.fields = fields;
    // Shape that fields don't show: a function's parameters, which function a call runs, else-if count.
    if (typeof block.saveExtraState === 'function') {
      try {
        const extra = block.saveExtraState(false);
        if (extra && Object.keys(extra).length) node.extraState = JSON.stringify(extra);
      } catch { /* ignore */ }
    }
    if (typeof block.isEnabled === 'function' && !block.isEnabled()) node.disabled = true;

    if (depth <= 0) {
      if (block.getChildren(false).length) node.truncated = true;
      return node;
    }
    const inputs = {};
    for (const input of block.inputList) {
      const kind = inputKind(input);
      const target = input.connection?.targetBlock();
      if (!kind || !target) continue;
      inputs[input.name] = kind === 'value' ? describe(target, depth - 1) : chain(target, depth - 1);
    }
    if (Object.keys(inputs).length) node.inputs = inputs;
    return node;
  }

  function chain(first, depth) {
    const list = [];
    for (let b = first; b; b = b.getNextBlock()) list.push(describe(b, depth));
    return list;
  }

  function workspaceContext(ws) {
    const tops = ws.getTopBlocks(true);
    for (const depth of [Infinity, 6, 3, 1]) {
      const stacks = tops.map((t) => {
        const xy = t.getRelativeToSurfaceXY();
        return { x: Math.round(xy.x), y: Math.round(xy.y), blocks: chain(t, depth) };
      });
      if (depth === 1 || JSON.stringify(stacks).length <= MAX_CONTEXT_CHARS) {
        return { stacks, truncated: depth !== Infinity };
      }
    }
  }

  function bounds(ws) {
    const b = ws.getBlocksBoundingBox?.();
    if (!b) return null;
    if ('right' in b) return { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) };
    return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
  }

  function meta(B, ws) {
    const selected = typeof B.getSelected === 'function' ? B.getSelected() : B.selected;
    return {
      blocklyVersion: B.VERSION || 'unknown',
      blockCount: ws.getAllBlocks(false).length,
      bounds: bounds(ws),
      selectedId: selected?.id ?? null,
      page: location.pathname + location.hash,
    };
  }

  // --------------------------------------------------------------- catalog

  // Blocks offered in the left-hand toolbox, with the category each one sits in.
  // Dynamic categories (e.g. site points) are filled by calling the app's own callback.
  function toolboxInfo(ws) {
    const types = new Map(); // type -> category name
    const dynamic = [];
    const defaults = new Map(); // type -> how the palette pre-fills it
    const add = (type, cat, preset) => {
      if (!type) return;
      if (!types.has(type)) types.set(type, cat);
      if (preset && !defaults.has(type) && (preset.fields || preset.inputs || preset.extraState || preset.mutation)) {
        defaults.set(type, preset);
      }
    };
    const expandDynamic = (key, name) => {
      dynamic.push(name);
      try {
        const cb = ws.getToolboxCategoryCallback?.(key);
        const items = cb ? cb(ws) : null;
        if (items) walk(items, name);
      } catch { /* callback needs UI state; skip */ }
    };
    function walk(n, cat) {
      if (!n) return;
      if (Array.isArray(n) || (typeof n.length === 'number' && typeof n !== 'string' && !n.nodeType)) {
        for (const c of Array.from(n)) walk(c, cat);
        return;
      }
      if (n.nodeType === 1) { // XML toolbox
        const tag = n.tagName.toLowerCase();
        if (tag === 'category') {
          const name = n.getAttribute('name') || cat;
          if (n.getAttribute('custom')) expandDynamic(n.getAttribute('custom'), name);
          for (const c of n.children) walk(c, name);
          return;
        }
        if (tag === 'block') add(n.getAttribute('type'), cat, presetFromXml(n));
        for (const c of n.children) walk(c, cat);
        return;
      }
      if (typeof n === 'object') { // JSON toolbox
        const kind = String(n.kind || '').toLowerCase();
        if (kind === 'category') {
          const name = n.name || cat;
          if (n.custom) expandDynamic(n.custom, name);
          walk(n.contents, name);
          return;
        }
        if (kind === 'block') {
          const preset = n.blockxml ? presetFromXml(n.blockxml) : presetFromJson(n);
          add(n.type || preset?.type, cat, preset);
        }
        walk(n.contents, cat);
      }
    }
    walk(ws.options?.languageTree, 'Other');
    return { types, dynamic, defaults };
  }

  // What a palette block comes pre-filled with (plugged-in blocks and field values).
  function presetFromJson(item, depth = 2) {
    if (!item?.type) return null;
    const p = { type: item.type };
    if (item.fields && Object.keys(item.fields).length) p.fields = item.fields;
    if (item.extraState) p.extraState = item.extraState;
    if (depth > 0 && item.inputs) {
      const ins = {};
      for (const [name, v] of Object.entries(item.inputs)) {
        const child = presetFromJson(v?.block || v?.shadow, depth - 1);
        if (child) ins[name] = child;
      }
      if (Object.keys(ins).length) p.inputs = ins;
    }
    return p;
  }

  function presetFromXml(el, depth = 2) {
    if (typeof el === 'string') {
      try { el = new DOMParser().parseFromString(el, 'text/xml').documentElement; } catch { return null; }
    }
    const type = el?.getAttribute?.('type');
    if (!type) return null;
    const p = { type };
    const fields = {};
    const ins = {};
    for (const c of el.children) {
      const tag = c.tagName.toLowerCase();
      if (tag === 'field') fields[c.getAttribute('name')] = c.textContent;
      else if (tag === 'mutation') p.mutation = Object.fromEntries([...c.attributes].map((a) => [a.name, a.value]));
      else if ((tag === 'value' || tag === 'statement') && depth > 0) {
        const kids = [...c.children];
        const child = kids.find((k) => k.tagName.toLowerCase() === 'block') || kids.find((k) => k.tagName.toLowerCase() === 'shadow');
        const cp = child && presetFromXml(child, depth - 1);
        if (cp) ins[c.getAttribute('name')] = cp;
      }
    }
    if (Object.keys(fields).length) p.fields = fields;
    if (Object.keys(ins).length) p.inputs = ins;
    return p;
  }

  function introspect(B, type) {
    if (catalogCache.has(type)) return catalogCache.get(type);
    let entry;
    const scratch = new B.Workspace();
    B.Events.disable();
    try {
      const b = scratch.newBlock(type);
      entry = { type };
      const label = b.toString();
      if (label) entry.label = label;
      const tip = typeof b.tooltip === 'function' ? b.tooltip() : b.tooltip;
      if (typeof tip === 'string' && tip) entry.tip = tip.slice(0, 400);
      if (typeof b.saveExtraState === 'function' || typeof b.mutationToDom === 'function') entry.expandable = true;

      const fields = namedFields(b).map((f) => {
        const d = { name: f.name, kind: fieldKind(B, f) };
        if (d.kind === 'variable') return d;
        const options = dropdownOptions(f);
        if (options) d.options = options;
        else { try { d.default = plain(f.getValue()); } catch { /* ignore */ } }
        if (d.kind === 'number') {
          for (const [k, get] of [['min', 'getMin'], ['max', 'getMax'], ['precision', 'getPrecision']]) {
            const v = typeof f[get] === 'function' ? f[get]() : undefined;
            if (Number.isFinite(v) && (k !== 'precision' || v !== 0)) d[k] = v;
          }
        }
        return d;
      });
      if (fields.length) entry.fields = fields;

      const inputs = [];
      for (const input of b.inputList) {
        const kind = inputKind(input);
        if (!kind) continue;
        const check = checkOf(input.connection);
        inputs.push(check ? { name: input.name, kind, check } : { name: input.name, kind });
      }
      if (inputs.length) entry.inputs = inputs;

      if (b.outputConnection) entry.output = checkOf(b.outputConnection) ?? true;
      if (b.previousConnection) entry.prev = true;
      if (b.nextConnection) entry.next = true;
    } catch (err) {
      entry = { type, error: `introspection failed: ${err?.message || err}` };
    } finally {
      B.Events.enable();
      scratch.dispose();
    }
    catalogCache.set(type, entry);
    return entry;
  }

  function buildCatalog(B, ws, info = toolboxInfo(ws)) {
    const types = new Set(info.types.keys());
    for (const b of ws.getAllBlocks(false)) types.add(b.type);
    // Offered only once a model is chosen, but the guide documents it for every sequence.
    if (B.Blocks.point_setter) types.add('point_setter');
    // Blockly's Variables category only shows these once a variable exists, but they can always be used.
    for (const t of ALWAYS_AVAILABLE) if (B.Blocks[t]) types.add(t);
    if (!types.size) Object.keys(B.Blocks).forEach((t) => types.add(t));
    return [...types].filter((t) => B.Blocks[t]).slice(0, MAX_CATALOG_TYPES).map((t) => {
      const entry = introspect(B, t);
      const preset = info.defaults.get(t);
      return preset ? { ...entry, palette: preset } : entry;
    });
  }

  // ------------------------------------------------------------ validation

  function validate({ actions }) {
    const { B, ws } = env();
    const errors = [];
    const warnings = [];
    const labels = {};
    let destructive = 0;
    if (!Array.isArray(actions)) return { errors: ['"actions" must be an array'], warnings, labels, destructive };

    const refs = new Map(); // ref -> type
    const expanded = new Set(); // refs created with extraState (their inputs depend on it)
    const deleted = new Set();
    const typeOf = (key) => refs.get(key) ?? ws.getBlockById(key)?.type ?? null;
    const variableExists = (v) => !!(ws.getVariableById?.(v) || ws.getVariable?.(v));

    const checkField = (at, type, name, value) => {
      const s = introspect(B, type);
      if (s.error) return;
      const f = s.fields?.find((x) => x.name === name);
      if (!f) {
        errors.push(`${at}: ${type} has no field "${name}" (fields: ${(s.fields || []).map((x) => x.name).join(', ') || 'none'})`);
        return;
      }
      if (f.kind === 'variable') {
        if (!variableExists(String(value))) warnings.push(`${at}: variable "${value}" does not exist yet and will be created`);
        return;
      }
      if (f.kind === 'number') {
        const n = Number(value);
        if (String(value).trim() === '' || Number.isNaN(n)) errors.push(`${at}: ${type}.${name} needs a number, got "${value}"`);
        else if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
          errors.push(`${at}: ${type}.${name} must be between ${f.min ?? '-∞'} and ${f.max ?? '∞'}, got ${value}`);
        }
        return;
      }
      // point_setter's options load at runtime; a model point type id is the value it stores.
      if (type === 'point_setter' && name === 'selected_point_name' && B.Blocks[String(value)]) return;
      if (f.options && !f.options.some((o) => String(o?.v ?? o) === String(value))) {
        warnings.push(`${at}: "${value}" is not a listed option for ${type}.${name}`);
      }
    };

    // Input spec from the real block when it already exists (its shape may be expanded),
    // otherwise from the catalog. null = cannot be known until apply time.
    const inputOf = (parentKey, parentType, name) => {
      const real = !refs.has(parentKey) && ws.getBlockById(parentKey);
      if (real) {
        const inp = real.getInput(name);
        if (!inp?.connection) return { missing: real.inputList.filter((i) => i.connection).map((i) => i.name) };
        return { name, kind: inputKind(inp), check: checkOf(inp.connection) };
      }
      if (expanded.has(parentKey)) return null;
      const p = introspect(B, parentType);
      if (p.error) return null;
      return p.inputs?.find((i) => i.name === name) || { missing: (p.inputs || []).map((i) => i.name) };
    };

    const checkInput = (at, parentKey, parentType, inputName, childType) => {
      const p = introspect(B, parentType);
      const c = introspect(B, childType);
      if (p.error || c.error) return;
      if (inputName === 'NEXT') {
        if (!p.next) errors.push(`${at}: ${parentType} has no NEXT connection`);
        if (!c.prev) errors.push(`${at}: ${childType} cannot be stacked (no previous connection)`);
        return;
      }
      const input = inputOf(parentKey, parentType, inputName);
      if (!input) return;
      if (input.missing) {
        errors.push(`${at}: ${parentType} has no input "${inputName}" (inputs: ${input.missing.join(', ') || 'none'})`);
        return;
      }
      if (input.kind === 'value' && !c.output) errors.push(`${at}: ${childType} has no output, so it cannot go in value input ${inputName}`);
      if (input.kind === 'statement' && !c.prev) errors.push(`${at}: ${childType} cannot go in statement input ${inputName}`);
      const childCheck = Array.isArray(c.output) ? c.output : null;
      if (input.check && childCheck && !input.check.some((t) => childCheck.includes(t))) {
        errors.push(`${at}: type mismatch — ${inputName} accepts ${input.check.join('/')}, ${childType} outputs ${childCheck.join('/')}`);
      }
    };

    actions.forEach((a, i) => {
      const at = `#${i + 1} ${a?.op}`;
      const need = (k) => {
        if (a[k] == null || a[k] === '') { errors.push(`${at}: missing "${k}"`); return false; }
        return true;
      };
      const known = (k) => {
        if (!need(k)) return null;
        if (deleted.has(a[k])) { errors.push(`${at}: "${a[k]}" was deleted earlier in this plan`); return null; }
        const t = typeOf(a[k]);
        if (!t) errors.push(`${at}: unknown block "${a[k]}"`);
        const existing = ws.getBlockById(a[k]);
        if (existing) labels[a[k]] = existing.toString(40);
        return t;
      };

      switch (a?.op) {
        case 'create': {
          if (!need('ref') || !need('type')) break;
          if (!B.Blocks[a.type]) { errors.push(`${at}: block type "${a.type}" does not exist`); break; }
          if (refs.has(a.ref) || ws.getBlockById(a.ref)) errors.push(`${at}: ref "${a.ref}" is already in use`);
          refs.set(a.ref, a.type);
          if (a.extraState) {
            try {
              if (typeof a.extraState === 'string' && a.extraState.trim().startsWith('{')) JSON.parse(a.extraState);
              expanded.add(a.ref);
            } catch { errors.push(`${at}: extraState is not valid JSON`); }
          }
          for (const f of a.fields || []) checkField(at, a.type, f.name, f.value);
          break;
        }
        case 'setField': {
          const t = known('block');
          if (t && need('field')) checkField(at, t, a.field, a.value);
          break;
        }
        case 'connect': {
          const pt = known('parent');
          const ct = known('child');
          if (pt && ct && need('input')) checkInput(at, a.parent, pt, a.input, ct);
          break;
        }
        case 'disconnect':
          known('block');
          break;
        case 'move':
          known('block');
          if (typeof a.x !== 'number' || typeof a.y !== 'number') errors.push(`${at}: x and y must be numbers`);
          break;
        case 'delete':
          if (known('block')) { deleted.add(a.block); destructive++; }
          break;
        default:
          errors.push(`${at}: unsupported op`);
      }
    });

    return { errors, warnings, labels, destructive };
  }

  // ----------------------------------------------------------------- apply

  function saveState(B, ws) {
    if (B.serialization?.workspaces?.save) return { kind: 'json', data: B.serialization.workspaces.save(ws) };
    return { kind: 'xml', data: B.Xml.workspaceToDom(ws) };
  }

  function loadState(B, ws, snap) {
    B.Events.setGroup(true);
    try {
      if (snap.kind === 'json') B.serialization.workspaces.load(snap.data, ws);
      else { ws.clear(); B.Xml.domToWorkspace(snap.data, ws); }
    } finally {
      B.Events.setGroup(false);
    }
  }

  // The canvas's content without positions: Blockly nudges blocks apart after a change, which
  // must not count as an edit when deciding whether undo can safely restore the saved copy.
  function fingerprint(B, ws) {
    if (!B.serialization?.workspaces?.save) return null;
    return JSON.stringify(B.serialization.workspaces.save(ws), (k, v) => (k === 'x' || k === 'y' ? undefined : v));
  }
  const fingerprintOf = (snap) => (snap.kind === 'json'
    ? JSON.stringify(snap.data, (k, v) => (k === 'x' || k === 'y' ? undefined : v)) : null);

  function undoStackTop(ws) {
    const stack = typeof ws.getUndoStack === 'function' ? ws.getUndoStack() : ws.undoStack_;
    return stack?.[stack.length - 1] ?? null;
  }

  // revert(), then make sure: blocks the change created are gone, and the canvas matches the copy
  // saved before the change. Returns true only when the canvas is really back as it was.
  async function restoreFully(B, ws, groupId, snapshot, created) {
    await revert(B, ws, groupId, snapshot, true);
    await tick(); await tick();
    for (const id of created) ws.getBlockById(id)?.dispose(false);
    const before = fingerprintOf(snapshot);
    if (before != null && fingerprint(B, ws) !== before) { loadState(B, ws, snapshot); await tick(); await tick(); }
    return before == null ? created.every((id) => !ws.getBlockById(id)) : fingerprint(B, ws) === before;
  }

  async function revert(B, ws, groupId, snapshot, mutated) {
    await tick(); await tick(); // let queued Blockly events reach the undo stack
    if (undoStackTop(ws)?.group === groupId) { ws.undo(false); return 'undo'; }
    if (mutated && snapshot) { loadState(B, ws, snapshot); return 'snapshot'; }
    return 'none';
  }

  /**
   * Runs a plan's steps on a workspace: the live canvas when applying, or a hidden copy when
   * previewing. Throws { step, message } on the first step that fails.
   */
  // ------------------------------------------------------- model point setters
  // point_setter's point list loads at runtime and the block rewrites its own fields when they
  // change, so its three fields are set together, in the editor's order, after the plan's other
  // steps: model id, then the point, then the reference (which always equals the point's type id,
  // as when a person picks the point by hand). Whatever the plan put in the reference is ignored.

  // Core blocks that are always usable even when their palette category is empty.
  const ALWAYS_AVAILABLE = ['variables_set', 'variables_get', 'math_change'];

  const POINT_FIELDS = new Set(['selected_point_name', 'selected_point_ref', 'setter_model_value']);

  function canvasModelId(ws) {
    const mb = ws.getAllBlocks(false).find((b) => b.type === 'model_block');
    return mb ? String(mb.getFieldValue('selectedModelId') || mb.getFieldValue('selected_model') || '') : '';
  }

  // The palette's point block label, as the Sequencer shows it in a setter:
  // "75F block <prefix>_Exhaust Fan 1 Status_40010 62ded583b877ba4d67083c7d 0" -> "<prefix>_Exhaust Fan 1 Status_40010"
  function setterLabel(type) {
    if (!pointNames.size) loadPointNames(env().B);
    const raw = pointNames.get(type);
    if (!raw) return '';
    return clean(raw).replace(/\s+[0-9a-f]{24}(\s+\d+)?\s*$/i, '').trim();
  }

  // A point_setter's dropdown only ever lists the point chosen in it: when a person picks a point,
  // the Sequencer replaces the block's list with that one entry and selects it. A new setter lists
  // only "select point". So to choose a point, give the dropdown that one entry, then select it.
  function offerPoint(field, type) {
    const label = setterLabel(type);
    if (!label) return false;
    const list = [[label, type]];
    if ('menuGenerator_' in field) field.menuGenerator_ = list;
    else field.menuGenerator = list;
    field.generatedOptions_ = null;
    return true;
  }

  // Returns a problem as text, or '' when the block holds exactly what was asked.
  function settlePointSetter(ws, block, want) {
    const model = want.model || canvasModelId(ws);
    const name = want.name ?? String(block.getFieldValue('selected_point_name'));
    if (model) block.setFieldValue(model, 'setter_model_value');
    const f = block.getField('selected_point_name');
    const pick = () => { block.setFieldValue(name, 'selected_point_name'); return String(f.getValue()) === name; };
    if (String(f.getValue()) !== name) {
      if (!offerPoint(f, name)) return `"${name}" is not one of this model's points (it isn't in the Model Points palette)`;
      if (!pick()) return `the Sequencer would not select model point "${name}" (the block stayed on "${f.getText?.() || f.getValue()}")`;
    }
    if (model && String(block.getFieldValue('setter_model_value')) !== model) block.setFieldValue(model, 'setter_model_value');
    for (let i = 0; i < 2 && String(block.getFieldValue('selected_point_ref')) !== name; i++) block.setFieldValue(name, 'selected_point_ref');
    const ref = String(block.getFieldValue('selected_point_ref'));
    return ref === name ? '' : `the point_setter kept "${ref}" as its point reference instead of "${name}"`;
  }

  function runActions(B, ws, actions, { strict = true } = {}) {
    const refs = new Map();
    const warnings = [];
    const touched = [];
    const setters = new Map(); // point_setter block id -> { name, model, step }
    const box = bounds(ws);
    const dropX = (box?.right ?? 0) + 80;
    let dropY = box?.top ?? 0;

    const get = (key) => {
      const b = ws.getBlockById(refs.get(key) ?? key);
      if (!b) throw new Error(`block "${key}" not found`);
      return b;
    };

    const setField = (block, name, value) => {
      const f = block.getField(name);
      if (!f) throw new Error(`${block.type} has no field "${name}"`);
      if (block.type === 'point_setter' && POINT_FIELDS.has(name)) {
        const want = setters.get(block.id) || { step };
        if (name === 'selected_point_name') want.name = String(value);
        if (name === 'setter_model_value') want.model = String(value);
        setters.set(block.id, want);
        return;
      }
      if (isVariableField(f)) {
        const key = String(value);
        let v = ws.getVariableById?.(key) || ws.getVariable?.(key);
        if (!v) {
          v = ws.createVariable(key);
          warnings.push(`Created new variable "${key}"`);
        }
        block.setFieldValue(v.getId(), name);
        return;
      }
      block.setFieldValue(String(value), name);
      const actual = String(f.getValue());
      if (actual !== String(value)) warnings.push(`${block.type}.${name}: asked for "${value}", the field kept "${actual}"`);
    };

    let step = 0;
    try {
      for (; step < actions.length; step++) {
        const a = actions[step];
        switch (a.op) {
          case 'create': {
            const x = a.x ?? dropX;
            const y = a.y ?? (dropY += 70);
            let block;
            let extraState;
            if (a.extraState) {
              extraState = typeof a.extraState === 'string' && a.extraState.trim().startsWith('{')
                ? JSON.parse(a.extraState) : a.extraState;
            }
            if (B.serialization?.blocks?.append) {
              block = B.serialization.blocks.append(extraState ? { type: a.type, x, y, extraState } : { type: a.type, x, y }, ws);
            } else {
              if (extraState) throw new Error('this Blockly version cannot create expanded blocks');
              block = ws.newBlock(a.type);
              block.initSvg?.();
              block.render?.();
              block.moveBy(x, y);
            }
            for (const f of a.fields || []) setField(block, f.name, f.value);
            refs.set(a.ref, block.id);
            touched.push(block.id);
            break;
          }
          case 'setField':
            setField(get(a.block), a.field, a.value);
            touched.push(get(a.block).id);
            break;
          case 'connect': {
            const parent = get(a.parent);
            const child = get(a.child);
            const parentConn = a.input === 'NEXT' ? parent.nextConnection : parent.getInput(a.input)?.connection;
            if (!parentConn) throw new Error(`${parent.type} has no input "${a.input}"`);
            const childConn = parentConn.type === INPUT_VALUE ? child.outputConnection : child.previousConnection;
            if (!childConn) throw new Error(`${child.type} does not fit ${parent.type}.${a.input}`);
            if (ws.connectionChecker && !ws.connectionChecker.canConnect(parentConn, childConn, false)) {
              throw new Error(`${child.type} is not compatible with ${parent.type}.${a.input}`);
            }
            if (child.getParent()) child.unplug(false);
            parentConn.connect(childConn);
            touched.push(child.id);
            break;
          }
          case 'disconnect': {
            const b = get(a.block);
            b.unplug(true);
            b.moveBy(30, 30);
            break;
          }
          case 'move': {
            const b = get(a.block);
            if (b.getParent()) throw new Error('only top-level blocks can be moved; disconnect it first');
            const xy = b.getRelativeToSurfaceXY();
            b.moveBy(a.x - xy.x, a.y - xy.y);
            break;
          }
          case 'delete':
            get(a.block).dispose(true);
            break;
        }
      }
      // Model point setters last, once their blocks sit in the sequence.
      for (const [id, want] of setters) {
        const block = ws.getBlockById(id);
        if (!block) continue;
        step = want.step;
        const problem = settlePointSetter(ws, block, want);
        if (problem && strict) throw new Error(`${problem}. Pick the point by hand, or reload the page so the model's points load, then apply again`);
        const note = 'Model points can only be checked on the real canvas, so Apply checks them and undoes the change if the Sequencer won\'t keep the point.';
        if (problem && !warnings.includes(note)) warnings.push(note);
      }
    } catch (err) {
      throw Object.assign(new Error(err.message), { step, applied: step > 0 || actions[step]?.op === 'create' });
    }
    return { refs, warnings, touched, setters: [...setters].map(([id, want]) => ({ id, ...want })) };
  }

  // ----------------------------------------------------------------- preview

  // What a block says on the canvas, using the labels people see ("Relay 1", "On"), not stored
  // values. Value inputs are read inline; statement inputs are listed as their own lines.
  function blockText(block) {
    const parts = [];
    for (const input of block.inputList) {
      if (input.connection && input.connection.type !== INPUT_VALUE) continue;
      for (const f of input.fieldRow) {
        let t = '';
        try { t = f.getText(); } catch { /* ignore */ }
        if (t && t.trim()) parts.push(t.trim());
      }
      const target = input.connection?.targetBlock();
      if (target) {
        const inner = blockText(target);
        parts.push(target.inputList.some((i) => i.connection) && inner.includes(' ') ? `(${inner})` : inner);
      } else if (input.connection) parts.push('[empty]');
    }
    return parts.join(' ').replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim() || block.type;
  }

  // A stack's own words ("on startup do"), without what is plugged into it: the preview's group heading.
  function headingText(block) {
    const words = [];
    for (const input of block.inputList) for (const f of input.fieldRow) {
      let t = '';
      try { t = f.getText(); } catch { /* ignore */ }
      if (t && t.trim()) words.push(t.trim());
    }
    return words.join(' ') || block.type;
  }

  // Types that make up one line: the block and everything plugged into its value inputs.
  function lineTypes(block, out = []) {
    out.push(block.type);
    for (const input of block.inputList) {
      if (input.connection?.type !== INPUT_VALUE) continue;
      const t = input.connection.targetBlock();
      if (t) lineTypes(t, out);
    }
    return out;
  }

  // The block a value block belongs to on screen: climb out of value inputs.
  function lineBlock(block) {
    let b = block;
    while (b.outputConnection?.targetBlock()) b = b.outputConnection.targetBlock();
    return b;
  }

  // Label of the statement input a block sits in ("do", "else"), for the preview's indentation.
  function slotLabel(block) {
    const parent = block.getSurroundParent?.();
    if (!parent) return '';
    for (const input of parent.inputList) {
      if (!input.connection || input.connection.type === INPUT_VALUE) continue;
      for (let b = input.connection.targetBlock(); b; b = b.getNextBlock()) {
        if (b === block) return input.fieldRow.map((f) => { try { return f.getText(); } catch { return ''; } }).join(' ').trim();
      }
    }
    return '';
  }

  function depthOf(block) {
    let d = 0;
    for (let p = block.getSurroundParent?.(); p && p.getSurroundParent?.(); p = p.getSurroundParent()) d++;
    return d;
  }

  // Select Model must stay the first block in Run on Startup: the Sequencer drops model point
  // setters when it isn't. A plan that connects into the startup block's own slot pushes it down.
  function firstInStartup(ws) {
    const map = new Map();
    for (const b of ws.getAllBlocks(false)) {
      if (b.type !== 'sequence_run_startup') continue;
      const first = b.getInputTargetBlock('sequence');
      if (first?.type === 'model_block') map.set(b.id, first.id);
    }
    return map;
  }
  function modelBlockMoved(before, ws) {
    for (const [startupId, modelId] of before) {
      const startup = ws.getBlockById(startupId);
      if (!startup || !ws.getBlockById(modelId)) continue; // a deliberate delete is the plan's business
      if (startup.getInputTargetBlock('sequence')?.id !== modelId) {
        return 'Select Model must stay the first block in Run on Startup, and this plan would push it down (it connects a block into the startup block\'s own slot). Stack new startup blocks after Select Model with NEXT instead.';
      }
    }
    return '';
  }

  function preview({ actions }) {
    const { B, ws } = env();
    const check = validate({ actions });
    if (check.errors.length) return { ...check, lines: [] };

    const copy = new B.Workspace();
    B.Events.disable();
    try {
      const snap = saveState(B, ws);
      if (snap.kind === 'json') B.serialization.workspaces.load(snap.data, copy);
      else B.Xml.domToWorkspace(snap.data, copy);

      let result;
      try {
        result = runActions(B, copy, actions, { strict: false });
      } catch (err) {
        return { ...check, errors: [`#${err.step + 1} ${actions[err.step]?.op}: ${err.message}`], lines: [] };
      }
      const moved = modelBlockMoved(firstInStartup(ws), copy);
      if (moved) return { ...check, errors: [moved], lines: [] };
      const createdIds = new Set([...result.refs.values()]);
      const lines = [];
      const lineFor = (kind, block, extra = {}) => {
        const root = block.getRootBlock();
        lines.push({
          kind,
          text: blockText(block),
          types: [...new Set(lineTypes(block))],
          slot: slotLabel(block),
          depth: depthOf(block),
          group: root === block ? '' : headingText(root),
          ...extra,
        });
      };

      // Every new line-level block once, in canvas order within each stack.
      const seen = new Set();
      for (const top of copy.getTopBlocks(true)) {
        for (const b of top.getDescendants(true)) {
          if (!createdIds.has(b.id)) continue;
          const line = lineBlock(b);
          if (seen.has(line.id)) continue;
          seen.add(line.id);
          if (createdIds.has(line.id)) lineFor('add', line);
          else lineFor('change', line, { before: blockText(lineBlock(ws.getBlockById(line.id))) });
        }
      }
      // Changes to existing blocks that no new block explains.
      actions.forEach((a) => {
        const id = a.block ?? a.child;
        if (!id || createdIds.has(result.refs.get(id)) || result.refs.has(id)) return;
        const live = ws.getBlockById(id);
        if (!live) return;
        const after = copy.getBlockById(id);
        if (a.op === 'delete') lines.push({ kind: 'remove', text: blockText(lineBlock(live)), types: [live.type], slot: '', depth: 0, group: '' });
        else if (after) {
          const line = lineBlock(after);
          if (seen.has(line.id)) return;
          seen.add(line.id);
          const kind = a.op === 'connect' || a.op === 'disconnect' || a.op === 'move' ? 'move' : 'change';
          lineFor(kind, line, { before: blockText(lineBlock(live)) });
        }
      });
      let map = null;
      try {
        map = { before: logicGraph(ws), after: logicGraph(copy), flowBefore: logicFlow(ws), flowAfter: logicFlow(copy) };
      } catch { /* the preview works without it */ }
      return { ...check, warnings: [...check.warnings, ...result.warnings.filter((w) => !w.startsWith('Created new variable'))], lines, map };
    } finally {
      copy.dispose();
      B.Events.enable();
    }
  }


  // -------------------------------------------------------------- logic map
  // A signal-flow view of a workspace: what each output, register and variable is computed from
  // (solid) and which conditions decide when it is written (dashed). Read-only; runs on any
  // workspace, including the preview copy.

  const clean = (t) => String(t ?? '').replace(/75F block/g, '').replace(/\s+/g, ' ').trim();
  const trunc = (t, n = 64) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const kid = (b, name) => (b?.getInput?.(name) ? b.getInputTargetBlock(name) : null);
  function ftext(b, name) {
    const f = b?.getField?.(name);
    if (!f) return '';
    try { return clean(f.getText()); } catch { return clean(f.getValue?.()); }
  }
  const SYM = { ADD: '+', MINUS: '−', MULTIPLY: '×', DIVIDE: '÷', POWER: '^', EQ: '=', NEQ: '≠', LT: '<', LTE: '≤', GT: '>', GTE: '≥', AND: 'and', OR: 'or' };
  const sym = (b) => SYM[b.getFieldValue('OP')] || ftext(b, 'OP');

  // "training_SI1_…_Kitchen Fan 1 Command_40000 62ded… 0" -> "Kitchen Fan 1 Command · 40000"
  function pointLabel(text) {
    const m = /_([^_]+)_(\d{5})(?!\d)/.exec(text);
    return m ? `${m[1]} · ${m[2]}` : trunc(clean(text), 48);
  }
  const regText = (b, addr = 'register_address') =>
    `${ftext(kid(b, 'register_type'), 'register_type') || 'register'} ${expr(kid(b, addr))}`;
  const uiNum = (b, input = 'uin_number') => expr(kid(b, input));

  // A value block with nothing plugged in (Relay output number, Set aout value, Sensor type…): the
  // value chosen in it, without the block's own words.
  function pickerText(b) {
    if (b.inputList.some((i) => i.connection?.targetBlock())) return '';
    const { B } = env();
    const parts = [];
    for (const f of namedFields(b)) {
      const kind = fieldKind(B, f);
      if (kind === 'label' || (B.FieldImage && f instanceof B.FieldImage) || f.name === 'blockImage') continue;
      let t = '';
      try { t = clean(f.getText()); } catch { t = clean(f.getValue?.()); }
      if (t) parts.push(t);
    }
    return parts.join(' ');
  }

  // Short, readable text for a value expression, in the labels people see.
  function expr(b) {
    if (!b) return '?';
    const w = (x) => { const t = expr(x); return x && /^(math_arithmetic|logic_operation)$/.test(x.type) ? `(${t})` : t; };
    switch (b.type) {
      case 'math_number': return ftext(b, 'NUM');
      case 'text': case 'text_multiline': return `"${ftext(b, 'TEXT')}"`;
      case 'logic_boolean': return ftext(b, 'BOOL');
      case 'variables_get': return ftext(b, 'VAR');
      case 'math_arithmetic': case 'logic_compare': case 'logic_operation': return `${w(kid(b, 'A'))} ${sym(b)} ${w(kid(b, 'B'))}`;
      case 'logic_negate': return `not ${w(kid(b, 'BOOL'))}`;
      case 'math_single': case 'math_round': return `${ftext(b, 'OP')}(${expr(kid(b, 'NUM'))})`;
      case 'math_constrain': return `limit ${expr(kid(b, 'VALUE'))} to ${expr(kid(b, 'LOW'))}–${expr(kid(b, 'HIGH'))}`;
      case 'conn_mod_get_universal_input_value': return `UI ${uiNum(b)}`;
      case 'universal_input_convert_value_from_standard_sensor_type':
        return `${expr(kid(b, 'uin_value'))} as ${ftext(kid(b, 'sensor_type_index'), 'sensor_type') || expr(kid(b, 'sensor_type_index'))}`;
      case 'conversion_scale_value':
        return `scale ${expr(kid(b, 'input_value'))} ${expr(kid(b, 'input_value_min'))}–${expr(kid(b, 'input_value_max'))} → ${expr(kid(b, 'output_value_min'))}–${expr(kid(b, 'output_value_max'))}`;
      case 'pi_controller_process':
        return `PI ${expr(kid(b, 'controller_number'))}: ${expr(kid(b, 'process_variable'))} to ${expr(kid(b, 'set_point'))}`;
      case 'conn_mod_read_modbus_register': return `Modbus ${regText(b)}`;
      case 'conn_mod_datatype_read_modbus_register': return `Modbus ${regText(b, 'NAME')}`;
      case 'conn_mod_get_sensor_bus_value': return `Sensor bus ${expr(kid(b, 'sensor_number'))} · ${expr(kid(b, 'sensor_type'))}`;
      case 'conn_mod_get_por_bus_value': return `POR bus ${expr(kid(b, 'sensor_number'))} · ${expr(kid(b, 'sensor_type'))}`;
      case 'get_device_time': return 'device time';
      default: {
        if (/^model_point_/.test(b.type)) return pointLabel(headingText(b));
        const picked = pickerText(b);
        return picked || trunc(clean(blockText(b)), 48);
      }
    }
  }

  // The signals a value expression reads: inputs, registers, model points and variables.
  function sources(b, out = []) {
    if (!b) return out;
    const add = (key, kind, label) => out.push({ key, kind, label });
    const t = b.type;
    if (t === 'variables_get') add(`var:${ftext(b, 'VAR')}`, 'var', ftext(b, 'VAR'));
    else if (t === 'conn_mod_get_universal_input_value') add(`ui:${uiNum(b)}`, 'input', `UI ${uiNum(b)}`);
    else if (t === 'conn_mod_read_universal_input_mapping_modbus_register') add(`uimap:${uiNum(b)}`, 'input', `UI ${uiNum(b)} (Modbus mapping)`);
    else if (t === 'conn_mod_read_modbus_register') add(`mbr:${regText(b)}`, 'input', `Modbus ${regText(b)}`);
    else if (t === 'conn_mod_datatype_read_modbus_register') add(`mbr:${regText(b, 'NAME')}`, 'input', `Modbus ${regText(b, 'NAME')}`);
    else if (/^model_point_/.test(t)) add(`mp:${t}`, 'input', `Model point ${pointLabel(headingText(b))}`);
    else if (t === 'conn_mod_read_analog_output_modbus_register') add(`aor:${expr(kid(b, 'aout_number'))}`, 'input', `AO ${expr(kid(b, 'aout_number'))} (read back)`);
    else if (t === 'conn_mod_read_relay_output_modbus_register') add(`rlr:${expr(kid(b, 'relay_number'))}`, 'input', `Relay ${expr(kid(b, 'relay_number'))} (read back)`);
    else if (/^conn_mod_read_custom_bacnet_(\w+)_object$/.test(t)) {
      const kind = /bacnet_(\w+)_object/.exec(t)[1].toUpperCase();
      add(`bacr:${kind}:${expr(kid(b, 'instance'))}`, 'input', `BACnet ${kind} ${expr(kid(b, 'instance'))}`);
    } else if (t === 'conn_mod_get_sensor_bus_value' || t === 'conn_mod_get_por_bus_value') {
      const label = expr(b);
      add(`bus:${label}`, 'input', label);
    } else if (t === 'get_device_time') add('time', 'input', 'Device time');
    else for (const input of b.inputList) if (input.connection?.type === INPUT_VALUE) sources(input.connection.targetBlock(), out);
    return out;
  }

  // Model point labels by type id, read from the palette's point blocks (for point_setter).
  let pointNames = new Map();

  // What a statement block writes, if anything.
  function target(b, screens) {
    const t = b.type;
    const w = (key, kind, label, value) => ({ key, kind, label, value });
    if (t === 'variables_set' || t === 'math_change' || t === 'text_append') {
      const name = ftext(b, 'VAR');
      return w(`var:${name}`, 'var', name, kid(b, t === 'variables_set' ? 'VALUE' : t === 'math_change' ? 'DELTA' : 'TEXT'));
    }
    if (t === 'conn_mod_set_analog_output') { const n = expr(kid(b, 'aout_number')); return w(`ao:${n}`, 'output', `AO ${n}`, kid(b, 'aout_value')); }
    if (t === 'conn_mod_set_relay_output') { const n = expr(kid(b, 'relay_number')); return w(`relay:${n}`, 'output', `Relay ${n}`, kid(b, 'relay_state')); }
    if (t === 'conn_mod_write_modbus_register' || t === 'conn_mod_datatype_write_modbus_register') {
      return w(`mbw:${regText(b)}`, 'output', `Modbus ${regText(b)}`, kid(b, 'register_value'));
    }
    if (t === 'point_setter') {
      const id = String(b.getFieldValue('selected_point_name') ?? '');
      const label = pointNames.has(id) ? pointLabel(pointNames.get(id)) : pointLabel(ftext(b, 'selected_point_name') || id);
      return w(`mpw:${id}`, 'output', `Model point ${label}`, kid(b, 'input_value_field'));
    }
    if (t === 'conn_mod_update_home_screen_input') {
      const n = expr(kid(b, 'uin_number'));
      return w(`hs:${n}`, 'output', `Home screen ${n}${screens.get(n) ? ` · ${screens.get(n)}` : ''}`, kid(b, 'input_val'));
    }
    if (t === 'conn_mod_write_universal_input_modbus_register') { const n = uiNum(b); return w(`uimbw:${n}`, 'output', `UI ${n} Modbus register`, kid(b, 'uin_value')); }
    const bac = /^conn_mod_write_custom_bacnet_(\w+)_object$/.exec(t);
    if (bac) { const n = expr(kid(b, 'instance')); return w(`bac:${bac[1]}:${n}`, 'output', `BACnet ${bac[1].toUpperCase()} ${n}`, kid(b, 'value')); }
    return null;
  }

  // What startup configures, collected for the map's summary instead of being drawn block by block.
  function setupCollector(ws) {
    const setup = { model: '', inputs: [], registers: [], screens: [], bacnet: [], initialised: [], other: [] };
    const screens = new Map();
    for (const b of ws.getAllBlocks(false)) {
      if (b.type === 'conn_mod_configure_home_screen_input') {
        screens.set(expr(kid(b, 'uin_number')), expr(kid(b, 'input_name')).replace(/^"|"$/g, '').replace(/[\s:-]+$/, '').trim());
      }
    }
    const unquote = (t) => t.replace(/"/g, '').trim();
    function configure(b) {
      const t = b.type;
      if (t === 'model_block') { setup.model = [ftext(b, 'selected_model'), b.getFieldValue('modelVersion')].filter(Boolean).join(' v'); return true; }
      if (t === 'conn_mod_set_universal_input_mode') { setup.inputs.push(`UI ${uiNum(b)}: ${expr(kid(b, 'uin_mode'))}`); return true; }
      if (t === 'conn_mod_configure_custom_modbus_register') { setup.registers.push(regText(b)); return true; }
      if (t === 'conn_mod_datatype_configure_custom_modbus_register') { setup.registers.push(`${regText(b)} (${expr(kid(b, 'register data type'))})`); return true; }
      if (t === 'conn_mod_configure_home_screen_input') {
        const n = expr(kid(b, 'uin_number'));
        const units = unquote(expr(kid(b, 'input_units')));
        setup.screens.push(`${n}: ${screens.get(n) || '?'}${units ? ` (${units})` : ''}`);
        return true;
      }
      const bac = /^conn_mod_configure_custom_bacnet_(\w+)_object$/.exec(t);
      if (bac) { setup.bacnet.push(`${bac[1].toUpperCase()} ${expr(kid(b, 'instance'))}: ${unquote(expr(kid(b, 'name')))}`); return true; }
      if (t === 'conn_mod_enable_fail_safe') { setup.other.push(`Fail safe: ${expr(kid(b, 'fail_safe_enable'))}`); return true; }
      return false;
    }
    // A variable given a fixed starting value in startup: listed, not drawn.
    function initialise(b) {
      if (b.type !== 'variables_set' || sources(kid(b, 'VALUE')).length) return false;
      setup.initialised.push(`${ftext(b, 'VAR')} = ${expr(kid(b, 'VALUE'))}`);
      return true;
    }
    return { setup, screens, configure, initialise };
  }

  function loadPointNames(B) {
    pointNames = new Map();
    for (const t of Object.keys(B.Blocks)) {
      if (!/^model_point_/.test(t)) continue;
      const label = introspect(B, t).label; // cached; built on a scratch workspace with events off
      if (label) pointNames.set(t, label);
    }
  }

  const isContainer = (t) => t === 'sequence_run_startup' || t === 'sequence_run_continuous' || /^procedures_def/.test(t);

  // Stacks that run: startup, continuous (top level or inside startup) and functions. Anything else is loose.
  function runningStacks(ws) {
    const stacks = [];
    let loose = 0;
    for (const top of ws.getTopBlocks(true)) {
      if (isContainer(top.type)) stacks.push(top);
      else loose += top.getDescendants(false).length;
    }
    return { stacks, loose };
  }

  function logicGraph(ws) {
    const { B } = env();
    loadPointNames(B);
    const { setup, screens, configure, initialise } = setupCollector(ws);
    const nodes = new Map();
    const edges = new Map();
    const sections = [];

    const node = (key, kind, label) => {
      if (!nodes.has(key)) nodes.set(key, { key, kind, label, writes: [] });
      return nodes.get(key);
    };
    const edge = (from, to, kind) => {
      if (from === to) return;
      const k = `${from}>${to}`;
      const old = edges.get(k);
      if (!old || (old.kind === 'gate' && kind === 'value')) edges.set(k, { from, to, kind });
    };

    function visit(b, gates, inStartup) {
      if (typeof b.isEnabled === 'function' && !b.isEnabled()) return; // disabled blocks never run
      if (configure(b)) return;
      if (inStartup && !gates.length && initialise(b)) return;
      if (b.type === 'controls_if') {
        const earlier = [];
        for (let i = 0; b.getInput(`IF${i}`); i++) {
          const cond = sources(kid(b, `IF${i}`));
          walk(kid(b, `DO${i}`), [...gates, ...earlier, ...cond], inStartup);
          earlier.push(...cond);
        }
        if (b.getInput('ELSE')) walk(kid(b, 'ELSE'), [...gates, ...earlier], inStartup);
        return;
      }
      if (b.type === 'sequence_run_continuous') sections.push(`Continuous, every ${expr(kid(b, 'run_rate'))} s`);
      if (/^procedures_call/.test(b.type)) {
        for (let i = 0; b.getInput(`ARG${i}`); i++) {
          const param = ftext(b, `ARGNAME${i}`);
          if (!param) continue;
          const n = node(`var:${param}`, 'var', param);
          const text = trunc(expr(kid(b, `ARG${i}`)), 60);
          if (!n.writes.includes(text)) n.writes.push(text);
          for (const s of sources(kid(b, `ARG${i}`))) { node(s.key, s.kind, s.label); edge(s.key, `var:${param}`, 'value'); }
          for (const g of gates) { node(g.key, g.kind, g.label); edge(g.key, `var:${param}`, 'gate'); }
        }
      }
      const tgt = target(b, screens);
      if (tgt) {
        const n = node(tgt.key, tgt.kind, tgt.label);
        const text = trunc(expr(tgt.value), 60);
        if (!n.writes.includes(text)) n.writes.push(text);
        for (const s of sources(tgt.value)) { node(s.key, s.kind, s.label); edge(s.key, tgt.key, 'value'); }
        for (const g of gates) { node(g.key, g.kind, g.label); edge(g.key, tgt.key, 'gate'); }
      }
      const inside = inStartup && b.type !== 'sequence_run_continuous';
      for (const input of b.inputList) {
        if (!input.connection || input.connection.type === INPUT_VALUE) continue;
        const extra = b.type === 'controls_whileUntil' ? sources(kid(b, 'BOOL')) : [];
        walk(input.connection.targetBlock(), [...gates, ...extra], inside);
      }
    }
    function walk(first, gates, inStartup) {
      for (let b = first; b; b = b.getNextBlock()) visit(b, gates, inStartup);
    }

    const { stacks, loose } = runningStacks(ws);
    for (const top of stacks) {
      if (top.type === 'sequence_run_startup') sections.push(`Startup (${ftext(top, 'DEVICE_TYPE') || 'device'})`);
      else if (/^procedures_def/.test(top.type)) sections.push(`Function ${ftext(top, 'NAME')}`);
      walk(top, [], top.type === 'sequence_run_startup');
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()], setup, sections, loose, blockCount: ws.getAllBlocks(false).length };
  }

  // ------------------------------------------------------------- flowchart
  // The same sequence in running order: steps, decisions (if / else if / else) and loops.
  // Each step keeps its block id so the extension can compare a plan's dry run with the canvas.

  // One statement block as a flowchart step: { kind: 'calc' | 'out' | 'other', text }, or null to leave it out.
  function stepOf(b, screens) {
    const t = b.type;
    const v = (name) => expr(kid(b, name));
    if (t === 'print_string') return null; // debug output only
    if (t === 'variables_set') return { kind: 'calc', text: `${ftext(b, 'VAR')} = ${v('VALUE')}` };
    if (t === 'math_change') return { kind: 'calc', text: `${ftext(b, 'VAR')} changes by ${v('DELTA')}` };
    if (t === 'text_append') return { kind: 'calc', text: `${ftext(b, 'VAR')} gets ${v('TEXT')} added` };
    if (t === 'conn_mod_set_relay_output') {
      const state = kid(b, 'relay_state');
      return { kind: 'out', text: state?.type === 'conn_mod_relay_output_state' ? `Relay ${v('relay_number')} ${expr(state)}` : `Relay ${v('relay_number')} = ${expr(state)}` };
    }
    if (t === 'conn_mod_set_analog_output') return { kind: 'out', text: `AO ${v('aout_number')} = ${v('aout_value')}` };
    if (t === 'conn_mod_write_modbus_register' || t === 'conn_mod_datatype_write_modbus_register') return { kind: 'out', text: `Modbus ${regText(b)} = ${v('register_value')}` };
    if (t === 'conn_mod_update_home_screen_input') {
      const n = v('uin_number');
      return { kind: 'out', text: `Home screen ${n}${screens.get(n) ? ` (${screens.get(n)})` : ''} shows ${v('input_val')}` };
    }
    if (t === 'point_setter') {
      const tgt = target(b, screens);
      return { kind: 'out', text: `${tgt.label} = ${v('input_value_field')}` };
    }
    const bac = /^conn_mod_write_custom_bacnet_(\w+)_object$/.exec(t);
    if (bac) return { kind: 'out', text: `BACnet ${bac[1].toUpperCase()} ${v('instance')} = ${v('value')}` };
    if (t === 'conn_mod_write_universal_input_modbus_register') return { kind: 'out', text: `UI ${uiNum(b)} Modbus register = ${v('uin_value')}` };
    if (t === 'conn_mod_set_universal_input_mode') return { kind: 'other', text: `UI ${uiNum(b)} mode: ${v('uin_mode')}` };
    if (t === 'sequence_delay_milliseconds') return { kind: 'other', text: `Wait ${v('delay_ms')} ms` };
    if (/^procedures_call/.test(t)) {
      const args = [];
      for (let i = 0; b.getInput(`ARG${i}`); i++) args.push(`${ftext(b, `ARGNAME${i}`) || `arg ${i + 1}`} = ${trunc(expr(kid(b, `ARG${i}`)), 40)}`);
      return { kind: 'other', text: `Run ${ftext(b, 'NAME') || 'function'}${args.length ? ` (${args.join(', ')})` : ''}` };
    }
    return { kind: 'other', text: trunc(clean(blockText(b)), 60) };
  }

  function logicFlow(ws) {
    const { B } = env();
    loadPointNames(B);
    const { setup, screens, configure, initialise } = setupCollector(ws);
    const sections = [];

    // Statement chain -> list of items. Continuous nested in startup becomes its own section.
    function items(first, inStartup) {
      const out = [];
      for (let b = first; b; b = b.getNextBlock()) {
        if (typeof b.isEnabled === 'function' && !b.isEnabled()) continue;
        if (b.type === 'sequence_run_continuous') { section(b); continue; }
        if (configure(b)) continue;
        if (inStartup && initialise(b)) continue;
        if (b.type === 'controls_if') {
          const branches = [];
          for (let i = 0; b.getInput(`IF${i}`); i++) {
            branches.push({ key: `${b.id}:${i}`, cond: trunc(expr(kid(b, `IF${i}`)), 90), body: items(kid(b, `DO${i}`), inStartup) });
          }
          out.push({ t: 'if', id: b.id, branches, else: b.getInput('ELSE') ? items(kid(b, 'ELSE'), inStartup) : null });
          continue;
        }
        if (b.type === 'controls_whileUntil' || b.type === 'controls_repeat_ext' || b.type === 'controls_for' || b.type === 'controls_forEach') {
          let q;
          if (b.type === 'controls_whileUntil') q = `${b.getFieldValue('MODE') === 'UNTIL' ? 'Repeat until' : 'Repeat while'} ${expr(kid(b, 'BOOL'))}`;
          else if (b.type === 'controls_repeat_ext') q = `Repeat ${expr(kid(b, 'TIMES'))} times`;
          else q = trunc(clean(headingText(b)), 70);
          out.push({ t: 'loop', id: b.id, key: `${b.id}:loop`, cond: trunc(q, 90), body: items(kid(b, b.getInput('DO') ? 'DO' : 'STACK'), inStartup) });
          continue;
        }
        const step = stepOf(b, screens);
        if (step) out.push({ t: 'step', id: b.id, ...step, text: trunc(step.text, 90) });
      }
      return out;
    }

    function section(top) {
      const t = top.type;
      const title = t === 'sequence_run_startup' ? 'On startup'
        : t === 'sequence_run_continuous' ? `Every ${expr(kid(top, 'run_rate'))} s`
          : `Function ${ftext(top, 'NAME')}`;
      const entry = { kind: t === 'sequence_run_startup' ? 'startup' : t === 'sequence_run_continuous' ? 'continuous' : 'function', title, body: [] };
      sections.push(entry);
      const input = top.inputList.find((i) => i.connection && i.connection.type !== INPUT_VALUE);
      entry.body = items(input?.connection.targetBlock(), entry.kind === 'startup');
      // Blocks stacked under a container run after it (for example continuous below startup).
      if (top.getNextBlock()) entry.body.push(...items(top.getNextBlock(), false));
    }

    const { stacks, loose } = runningStacks(ws);
    for (const top of stacks) section(top);
    // Startup first, then continuous, then functions.
    const order = { startup: 0, continuous: 1, function: 2 };
    sections.sort((a, b) => order[a.kind] - order[b.kind]);
    return { sections, setup, loose, blockCount: ws.getAllBlocks(false).length };
  }

  // ------------------------------------------------------------- simulator
  // A serialisable model of the running sequence for the side panel's simulator. Derived from the
  // live canvas, never from an example. Values are read the way the device gets them: a picker
  // block gives its STORED value (Relay 1 is 0), with the label kept for display. Anything the
  // simulator can't model is marked 'unsupported' so it can be reported, never guessed.

  // A block with no inputs whose single setting is its value (Relay output number, Set aout value…).
  function simPick(b) {
    if (b.inputList.some((i) => i.connection)) return null;
    const { B } = env();
    const fields = namedFields(b).filter((f) => {
      const kind = fieldKind(B, f);
      return kind !== 'label' && !(B.FieldImage && f instanceof B.FieldImage) && f.name !== 'blockImage';
    });
    if (fields.length !== 1) return null;
    const f = fields[0];
    const raw = f.getValue?.();
    let text = '';
    try { text = clean(f.getText()); } catch { text = clean(raw); }
    const n = Number(raw);
    return raw !== '' && raw != null && Number.isFinite(n) ? { op: 'number', value: n, text } : { op: 'text', value: text };
  }

  function simValue(b) {
    if (!b) return null;
    if (typeof b.isEnabled === 'function' && !b.isEnabled()) return null;
    const v = (name) => simValue(kid(b, name));
    const op = (name) => String(b.getFieldValue(name) ?? '');
    switch (b.type) {
      case 'math_number': return { op: 'number', value: Number(b.getFieldValue('NUM')) };
      case 'logic_boolean': return { op: 'boolean', value: op('BOOL') === 'TRUE' };
      case 'text': case 'text_multiline': return { op: 'text', value: String(b.getFieldValue('TEXT') ?? '') };
      case 'variables_get': return { op: 'var', name: ftext(b, 'VAR') };
      case 'math_arithmetic': return { op: 'arith', operator: op('OP'), a: v('A'), b: v('B') };
      case 'logic_compare': return { op: 'compare', operator: op('OP'), a: v('A'), b: v('B') };
      case 'logic_operation': return { op: 'logic', operator: op('OP'), a: v('A'), b: v('B') };
      case 'logic_negate': return { op: 'not', value: v('BOOL') };
      case 'logic_ternary': return { op: 'ternary', test: v('IF'), then: v('THEN'), else: v('ELSE') };
      case 'math_single': return { op: 'single', operator: op('OP'), value: v('NUM') };
      case 'math_round': return { op: 'round', operator: op('OP'), value: v('NUM') };
      case 'math_modulo': return { op: 'arith', operator: 'MODULO', a: v('DIVIDEND'), b: v('DIVISOR') };
      case 'math_constrain': return { op: 'constrain', value: v('VALUE'), low: v('LOW'), high: v('HIGH') };
      case 'conversion_scale_value':
        return { op: 'scale', value: v('input_value'), inMin: v('input_value_min'), inMax: v('input_value_max'), outMin: v('output_value_min'), outMax: v('output_value_max') };
      case 'conn_mod_get_universal_input_value':
        return { op: 'input', kind: 'ui', ch: v('uin_number'), label: `UI ${expr(kid(b, 'uin_number'))}` };
      case 'universal_input_convert_value_from_standard_sensor_type': {
        // The conversion's maths isn't known, so the simulated input is the converted reading itself.
        const inner = v('uin_value');
        const as = ftext(kid(b, 'sensor_type_index'), 'sensor_type') || expr(kid(b, 'sensor_type_index'));
        if (inner?.op === 'input' && inner.kind === 'ui') return { ...inner, as, label: `${inner.label} as ${as}` };
        return { op: 'unsupported', type: b.type, label: trunc(clean(blockText(b)), 60) };
      }
      case 'conn_mod_get_sensor_bus_value': case 'conn_mod_get_por_bus_value':
        return { op: 'input', kind: b.type.includes('por') ? 'por' : 'sensor', ch: v('sensor_number'), sensor: v('sensor_type'), label: expr(b) };
      case 'conn_mod_read_modbus_register':
        return { op: 'input', kind: 'modbus', reg: v('register_type'), ch: v('register_address'), label: `Modbus ${regText(b)}` };
      case 'conn_mod_datatype_read_modbus_register':
        return { op: 'input', kind: 'modbus', reg: v('register_type'), ch: v('NAME'), label: `Modbus ${regText(b, 'NAME')}` };
      case 'conn_mod_read_universal_input_mapping_modbus_register':
        return { op: 'input', kind: 'ui-mapping', ch: v('uin_number'), label: `UI ${expr(kid(b, 'uin_number'))} Modbus mapping` };
      // Reading back an output gives what the sequence last wrote to it.
      case 'conn_mod_read_analog_output_modbus_register': return { op: 'readback', kind: 'ao', ch: v('aout_number') };
      case 'conn_mod_read_relay_output_modbus_register': return { op: 'readback', kind: 'relay', ch: v('relay_number') };
      case 'pi_controller_process':
        // PI maths on the device is unconfirmed (ranges, time units), so the output is set by hand.
        return { op: 'input', kind: 'pi', ch: v('controller_number'), label: `PI ${expr(kid(b, 'controller_number'))} output` };
      default: {
        if (/^model_point_/.test(b.type)) return { op: 'input', kind: 'model-point', point: b.type, label: pointLabel(pointNames.get(b.type) || headingText(b)) };
        const m = /^conn_mod_read_custom_bacnet_(\w+)_object$/.exec(b.type);
        if (m) return { op: 'input', kind: 'bacnet', obj: m[1].toUpperCase(), ch: v('instance'), label: `BACnet ${m[1].toUpperCase()} ${expr(kid(b, 'instance'))}` };
        return simPick(b) || { op: 'unsupported', type: b.type, label: trunc(clean(blockText(b)), 60) };
      }
    }
  }

  function simStatement(b, ctx) {
    if (typeof b.isEnabled === 'function' && !b.isEnabled()) return null;
    const v = (name) => simValue(kid(b, name));
    const t = b.type;
    if (t === 'print_string') return null;
    if (t === 'sequence_run_continuous') { ctx.section(b); return null; }
    if (t === 'model_block') return null;
    if (t === 'conn_mod_configure_home_screen_input') {
      // Configures the line and shows a starting value.
      return { type: 'out', kind: 'hs', ch: v('uin_number'), value: v('input_val') };
    }
    if (ctx.configure(b)) return null; // input modes, register setup, BACnet objects: listed in setup
    switch (t) {
      case 'variables_set': return { type: 'set', name: ftext(b, 'VAR'), value: v('VALUE') };
      case 'math_change': return { type: 'change', name: ftext(b, 'VAR'), value: v('DELTA') };
      case 'conn_mod_set_analog_output': return { type: 'out', kind: 'ao', ch: v('aout_number'), value: v('aout_value') };
      case 'conn_mod_set_relay_output': return { type: 'out', kind: 'relay', ch: v('relay_number'), value: v('relay_state') };
      case 'conn_mod_write_modbus_register': case 'conn_mod_datatype_write_modbus_register':
        return { type: 'out', kind: 'modbus', reg: v('register_type'), ch: v('register_address'), value: v('register_value'), label: `Modbus ${regText(b)}` };
      case 'point_setter': {
        const point = String(b.getFieldValue('selected_point_name') || '');
        const named = pointNames.get(point);
        return { type: 'out', kind: 'model-point', point, value: v('input_value_field'),
          label: point === 'DEFAULT_MODAL' ? 'Model point (none selected)' : pointLabel(named || ftext(b, 'selected_point_name')) };
      }
      case 'conn_mod_update_home_screen_input': return { type: 'out', kind: 'hs', ch: v('uin_number'), value: v('input_val') };
      case 'conn_mod_write_universal_input_modbus_register': return { type: 'out', kind: 'ui-modbus', ch: v('uin_number'), value: v('uin_value') };
      case 'controls_if': {
        const branches = [];
        for (let i = 0; b.getInput(`IF${i}`); i++) branches.push({ test: simValue(kid(b, `IF${i}`)), label: trunc(expr(kid(b, `IF${i}`)), 90), body: simChain(kid(b, `DO${i}`), ctx) });
        return { type: 'if', branches, else: b.getInput('ELSE') ? simChain(kid(b, 'ELSE'), ctx) : null };
      }
      case 'controls_repeat_ext': return { type: 'repeat', times: v('TIMES'), body: simChain(kid(b, 'DO'), ctx) };
      case 'controls_repeat': return { type: 'repeat', times: { op: 'number', value: Number(b.getFieldValue('TIMES')) }, body: simChain(kid(b, 'DO'), ctx) };
      case 'controls_whileUntil': return { type: 'while', until: b.getFieldValue('MODE') === 'UNTIL', test: v('BOOL'), label: trunc(expr(kid(b, 'BOOL')), 90), body: simChain(kid(b, 'DO'), ctx) };
      case 'controls_for': return { type: 'for', name: ftext(b, 'VAR'), from: v('FROM'), to: v('TO'), by: v('BY'), body: simChain(kid(b, 'DO'), ctx) };
      case 'sequence_delay_milliseconds': return { type: 'delay', value: v('delay_ms') };
      default: {
        if (/^procedures_callnoreturn$/.test(t)) {
          const args = [];
          for (let i = 0; b.getInput(`ARG${i}`); i++) args.push(simValue(kid(b, `ARG${i}`))); // keep positions, even empty ones
          return { type: 'call', name: ftext(b, 'NAME'), args };
        }
        const m = /^conn_mod_write_custom_bacnet_(\w+)_object$/.exec(t);
        if (m) return { type: 'out', kind: 'bacnet', obj: m[1].toUpperCase(), ch: v('instance'), value: v('value'), label: `BACnet ${m[1].toUpperCase()} ${expr(kid(b, 'instance'))}` };
        return { type: 'unsupported', blockType: t, label: trunc(clean(blockText(b)), 60) };
      }
    }
  }

  function simChain(first, ctx) {
    const out = [];
    for (let b = first; b; b = b.getNextBlock()) {
      const s = simStatement(b, ctx);
      if (s) out.push(s);
    }
    return out;
  }

  function simulatorModel() {
    const { B, ws } = env();
    loadPointNames(B);
    const { setup, screens, configure } = setupCollector(ws);
    const model = { blockCount: ws.getAllBlocks(false).length, startup: [], continuous: [], functions: {}, setup, screens: Object.fromEntries(screens), uiModes: {}, loose: 0 };

    // Each universal input's configured mode, keyed by its stored channel number.
    for (const b of ws.getAllBlocks(false)) {
      if (b.type !== 'conn_mod_set_universal_input_mode') continue;
      const ch = simValue(kid(b, 'uin_number'));
      if (ch?.op === 'number') model.uiModes[ch.value] = expr(kid(b, 'uin_mode'));
    }

    const ctx = {
      configure,
      section(cont) {
        const input = cont.getInput('sequence');
        model.continuous.push({ rate: simValue(kid(cont, 'run_rate')), title: `Every ${expr(kid(cont, 'run_rate'))} s`, body: simChain(input?.connection?.targetBlock(), ctx) });
      },
    };
    const bodyOf = (top) => top.inputList.find((i) => i.connection && i.connection.type !== INPUT_VALUE)?.connection.targetBlock();
    for (const top of ws.getTopBlocks(true)) {
      if (typeof top.isEnabled === 'function' && !top.isEnabled()) continue;
      if (top.type === 'sequence_run_startup') {
        model.startup.push(...simChain(bodyOf(top), ctx));
        if (top.getNextBlock()) model.startup.push(...simChain(top.getNextBlock(), ctx)); // e.g. continuous stacked below
      } else if (top.type === 'sequence_run_continuous') {
        ctx.section(top);
        if (top.getNextBlock()) model.continuous[model.continuous.length - 1].body.push(...simChain(top.getNextBlock(), ctx));
      } else if (/^procedures_def/.test(top.type)) {
        let params = [];
        try { params = top.getVars?.() || []; } catch { /* ignore */ }
        if (!params.length) {
          try { params = (top.saveExtraState?.()?.params || []).map((p) => p.name); } catch { /* ignore */ }
        }
        model.functions[ftext(top, 'NAME')] = { params, body: simChain(top.getInput('STACK')?.connection?.targetBlock(), ctx),
          returns: top.type === 'procedures_defreturn' };
      } else {
        model.loose += top.getDescendants(false).length;
      }
    }
    return model;
  }

  // ----------------------------------------------------------------- apply

  async function apply({ actions }) {
    const { B, ws } = env();
    const check = validate({ actions });
    if (check.errors.length) throw new Error('Plan failed validation:\n' + check.errors.join('\n'));

    const snapshot = saveState(B, ws);
    const modelFirst = firstInStartup(ws);
    B.Events.setGroup(true);
    const groupId = B.Events.getGroup();
    let result;
    try {
      result = runActions(B, ws, actions, { strict: false });
      result.warnings = result.warnings.filter((w) => !w.startsWith('Model points can only be checked'));
    } catch (err) {
      B.Events.setGroup(false);
      const how = await revert(B, ws, groupId, snapshot, true);
      throw new Error(`Step ${err.step + 1} (${actions[err.step]?.op}) failed: ${err.message}. ` +
        (how === 'none' ? 'Nothing was changed.' : 'The canvas was restored.'));
    } finally {
      B.Events.setGroup(false);
    }

    const moved = modelBlockMoved(modelFirst, ws);
    if (moved) {
      const clean = await restoreFully(B, ws, groupId, snapshot, [...result.refs.values()]);
      throw new Error(`${moved} ${clean ? 'The canvas was restored.' : 'Check the canvas for leftover blocks.'}`);
    }

    // Model point setters: the point list loads at runtime (possibly from the server), and the
    // editor can rewrite the block's fields a moment later. So keep trying for a few seconds while
    // the list loads, check again after the editor has had its turn, and if the point still won't
    // hold, restore the canvas and say so: never leave a half-set setter behind.
    if (result.setters.length) {
      const pending = new Map(result.setters.map((w) => [w.id, w]));
      let problem = '';
      const deadline = Date.now() + 4000;
      while (pending.size && Date.now() < deadline) {
        B.Events.setGroup(groupId);
        try {
          for (const [id, want] of pending) {
            const block = ws.getBlockById(id);
            if (!block) { problem = 'the Sequencer removed a point_setter right after it was added'; pending.clear(); break; }
            try { block.getField('selected_point_name')?.getOptions?.(false); } catch { /* the list may still be loading */ }
            problem = settlePointSetter(ws, block, want);
            if (!problem) pending.delete(id);
          }
        } finally {
          B.Events.setGroup(false);
        }
        if (pending.size) await new Promise((r) => setTimeout(r, 250));
      }
      if (!problem) {
        // Let the editor react, then check that what we set is still there.
        for (let i = 0; i < 4; i++) await tick();
        await new Promise((r) => setTimeout(r, 400));
        for (const want of result.setters) {
          const block = ws.getBlockById(want.id);
          if (!block) { problem = 'the Sequencer removed a point_setter right after it was added'; break; }
          const got = String(block.getFieldValue('selected_point_name'));
          const ref = String(block.getFieldValue('selected_point_ref'));
          if (want.name && got !== want.name) { problem = `the Sequencer reset a point_setter to "${got === 'DEFAULT_MODAL' ? 'select point' : got}" right after the point was set`; break; }
          if (want.name && ref !== want.name) { problem = `the Sequencer changed a point_setter's point reference to "${ref}"`; break; }
        }
      }
      if (problem) {
        const clean = await restoreFully(B, ws, groupId, snapshot, [...result.refs.values()]);
        throw new Error(`Model point: ${problem}. ` + (clean
          ? 'The canvas was restored. For now, add this setter and pick its point by hand.'
          : 'The extension could not fully restore the canvas: check for leftover blocks, or reload the sequence without saving.'));
      }
    }

    lastApply = { groupId, snapshot, before: fingerprintOf(snapshot), after: fingerprint(B, ws), created: [...result.refs.values()] };
    const focus = result.touched.find((id) => ws.getBlockById(id));
    if (focus && typeof ws.centerOnBlock === 'function') ws.centerOnBlock(focus);
    return { applied: actions.length, warnings: result.warnings, created: Object.fromEntries(result.refs) };
  }

  /**
   * Reverts the last Copilot change. Blockly's own undo is tried first, but the Sequencer can add to
   * or clear its undo history (autosave, for example), so the result is always checked, and the copy
   * of the canvas saved before the change is restored when needed.
   * force: restore even though the canvas was edited after the change (the panel asks first).
   */
  async function undo({ force = false } = {}) {
    const { B, ws } = env();
    if (!lastApply) throw new Error('There is no Copilot change to undo. (Undo only covers the last change, and not after the page reloads.)');
    const { groupId, snapshot, before, after, created } = lastApply;
    const isBack = () => (before != null ? fingerprint(B, ws) === before : created.every((id) => !ws.getBlockById(id)));

    await tick(); await tick(); // let queued Blockly events reach the undo stack
    const edited = after != null && fingerprint(B, ws) !== after;

    if (!edited && undoStackTop(ws)?.group === groupId) {
      ws.undo(false);
      await tick();
      if (isBack()) { lastApply = null; return { undone: true, how: 'undo' }; }
    }
    if (edited && !force) {
      return { undone: false, needsConfirm: true };
    }
    loadState(B, ws, snapshot);
    await tick();
    // The editor may tidy the reloaded canvas slightly; what matters is that the change is gone.
    const createdGone = created.every((id) => !ws.getBlockById(id));
    if (!isBack() && !createdGone) throw new Error('The canvas could not be restored exactly. Use Ctrl+Z in the editor, or reload the sequence without saving.');
    lastApply = null;
    return { undone: true, how: 'restore' };
  }


  // ------------------------------------------------------- generated Python
  // The Sequencer turns the canvas into Python with a Blockly code generator. Find the page's
  // own generator (the one that knows the 75F blocks) and run it on the live canvas: this is
  // read-only and is what the editor itself does to produce the controller's program.
  function findPythonGenerator(B) {
    const looksRight = (g) => !!g && typeof g === 'object' && typeof g.workspaceToCode === 'function';
    // Blockly 10 keeps block generators in forBlock; older code assigns them on the generator.
    const knows75f = (g) => ['model_block', 'conn_mod_get_universal_input_value']
      .some((t) => typeof g.forBlock?.[t] === 'function' || typeof g[t] === 'function');
    const isPython = (g) => /python/i.test(g.name_ || g.name || '') || typeof g.forBlock?.controls_if === 'function';
    const candidates = [];
    const add = (v) => {
      if (looksRight(v)) candidates.push(v);
      if (v && typeof v === 'object') {
        for (const inner of ['pythonGenerator', 'Python', 'generator', 'default']) {
          let g;
          try { g = v[inner]; } catch { continue; }
          if (looksRight(g)) candidates.push(g);
        }
      }
    };
    [B.Python, B.python, window.python, window.pythonGenerator, window.Blockly?.Python].forEach(add);
    for (const key of Object.getOwnPropertyNames(window)) {
      let v;
      try { v = window[key]; } catch { continue; }
      if (v && typeof v === 'object' && !(v instanceof Node)) add(v);
    }
    // The 75F app bundles its generator with webpack: look through modules it has already loaded
    // (reading their exports only; nothing new is run).
    for (const key of Object.getOwnPropertyNames(window).filter((k) => k.startsWith('webpackChunk'))) {
      let req = null;
      try { window[key].push([[`seq-copilot-gen-${Date.now()}-${Math.random()}`], {}, (r) => { req = r; }]); } catch { continue; }
      for (const id of Object.keys(req?.c || {})) {
        const exp = req.c[id]?.exports;
        if (!exp || (typeof exp !== 'object' && typeof exp !== 'function')) continue;
        add(exp);
        for (const k of Object.keys(exp).slice(0, 200)) {
          let v;
          try { v = exp[k]; } catch { continue; }
          add(v);
        }
      }
    }
    return candidates.find((g) => knows75f(g) && isPython(g)) || candidates.find(knows75f) || null;
  }

  function heapSource() {
    const { B, ws } = env();
    const all = ws.getAllBlocks(false);
    const stacks = ws.getTopBlocks(true).map((top) => ({
      type: top.type,
      name: top.getFieldValue?.('NAME') || '',
      blocks: top.getDescendants(false).length,
    }));
    let python = null;
    let reason = '';
    const gen = findPythonGenerator(B);
    if (!gen) reason = 'The page\'s Python generator could not be found, so the estimate uses block counts.';
    else {
      try {
        python = gen.workspaceToCode(ws);
        if (typeof python !== 'string' || !python.trim()) { python = null; reason = 'The Python generator returned nothing for this canvas.'; }
      } catch (err) {
        reason = `The Python generator failed on this canvas: ${err.message}`;
      }
    }
    return { python, reason, blocks: all.length, stacks, change: changeInfo() };
  }

  // ----------------------------------------------------- real build (py-to-mpy)
  // Compiles the code with 75F's own py-to-mpy service, the way the Sequencer does when it
  // builds, using the session the person is already signed in with. The sign-in token is read
  // from this page's storage and used only for this request to that service; it is never
  // returned to the extension or stored.
  const MPY_URL = 'https://micropython-edge-api.azurewebsites.net/micro-python/py-to-mpy';

  function sessionToken() {
    const now = Date.now() / 1000;
    const found = [];
    const scan = (text) => {
      for (const m of String(text).matchAll(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g)) {
        try {
          const body = JSON.parse(atob(m[0].split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
          if (body.iss === '75f' && (!body.exp || body.exp > now + 30)) found.push({ token: m[0], exp: body.exp || 0 });
        } catch { /* not a token */ }
      }
    };
    for (const store of [window.localStorage, window.sessionStorage]) {
      try {
        for (let i = 0; i < store.length; i++) scan(store.getItem(store.key(i)));
      } catch { /* storage blocked */ }
    }
    try { scan(document.cookie); } catch { /* none */ }
    found.sort((a, b) => b.exp - a.exp);
    return found[0]?.token || null;
  }

  function toBytes(buf) {
    const u = new Uint8Array(buf);
    if (u[0] === 0x4d) return u; // the .mpy itself
    const text = new TextDecoder().decode(u).trim().replace(/^"|"$/g, '');
    if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) {
      return Uint8Array.from(text.match(/../g), (h) => parseInt(h, 16));
    }
    if (/^[A-Za-z0-9+/=\s]+$/.test(text)) {
      const bin = atob(text.replace(/\s/g, ''));
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    }
    throw new Error('The compiler answered with something other than a .mpy file.');
  }

  async function mpyBuild({ python }) {
    if (typeof python !== 'string' || !python.trim()) throw new Error('No code to build.');
    const token = sessionToken();
    if (!token) throw new Error('Couldn\'t find your 75F sign-in in this page. Reload the Sequencer, sign in again if asked, and retry.');
    const res = await fetch(MPY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', Authorization: `Bearer ${token}`, '75F-Application': 'INTERNAL' },
      body: JSON.stringify({ snippet: python, outputFileName: '__user_code__' }),
    });
    if (res.status === 401 || res.status === 403) throw new Error('The 75F compiler refused the sign-in. Reload the Sequencer and sign in again.');
    if (!res.ok) throw new Error(`The 75F compiler answered ${res.status}. If the code has an error, the Sequencer's own build will show it.`);
    const bytes = toBytes(await res.arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return { mpyBase64: btoa(bin), bytes: bytes.length };
  }

  // -------------------------------------------------------------- handlers

  const HANDLERS = {
    status() {
      try {
        const { B, ws } = env();
        return { ready: true, version: B.VERSION || 'unknown', blockCount: ws.getAllBlocks(false).length, ...changeInfo() };
      } catch (err) {
        return { ready: false, reason: err.message };
      }
    },
    heapSource() {
      return heapSource();
    },
    mpyBuild,
    getContext({ refreshCatalog } = {}) {
      const { B, ws } = env();
      if (refreshCatalog) catalogCache.clear();
      const { stacks, truncated } = workspaceContext(ws);
      const info = toolboxInfo(ws);
      return {
        meta: meta(B, ws),
        catalog: buildCatalog(B, ws, info),
        categories: Object.fromEntries(info.types),
        dynamicCategories: info.dynamic,
        variables: (ws.getAllVariables?.() || []).map((v) => (v.type ? { name: v.name, type: v.type } : { name: v.name })),
        notInPalette: Object.keys(B.Blocks).filter((t) => !info.types.has(t) && !ALWAYS_AVAILABLE.includes(t) && !MUTATOR_HELPER.test(t)).slice(0, 400),
        workspace: stacks,
        truncated,
        change: changeInfo(),
      };
    },
    // For working out how the Sequencer's own model point blocks behave: their definitions, the
    // code behind their dropdowns, and the state of the ones on the canvas. Read-only.
    diagnoseModelPoints() {
      const { B, ws } = env();
      const show = (v) => {
        if (typeof v === 'function') return v.toString();
        try { return JSON.stringify(v, null, 1); } catch { return String(v); }
      };
      const definition = (type) => {
        const def = B.Blocks[type];
        if (!def) return `(${type} is not registered)`;
        return Object.entries(def).map(([k, v]) => `// ${type}.${k}\n${show(v)}`).join('\n\n');
      };
      const fieldCode = (block, name) => {
        const f = block?.getField?.(name);
        if (!f) return `(no field ${name})`;
        const gen = f.menuGenerator_ ?? f.menuGenerator;
        let options = '';
        try { options = JSON.stringify(f.getOptions?.(false)).slice(0, 3000); } catch (e) { options = `getOptions failed: ${e.message}`; }
        return [`// field ${name} (${f.constructor?.name})`, `value: ${f.getValue?.()}`, `options now: ${options}`,
          `menu generator:\n${typeof gen === 'function' ? gen.toString() : show(gen)?.slice(0, 3000)}`,
          `validator:\n${show(f.getValidator?.()) || 'none'}`].join('\n');
      };
      const onCanvas = (type, fields) => ws.getAllBlocks(false).filter((b) => b.type === type).slice(0, 3)
        .map((b) => `### ${type} on canvas (${b.id})\n${fields.map((n) => fieldCode(b, n)).join('\n\n')}`).join('\n\n') || `(no ${type} on the canvas)`;
      let listeners = '';
      try { listeners = (ws.listeners || ws.listeners_ || []).map((l) => l.toString().slice(0, 4000)).join('\n\n---\n\n'); } catch { /* not exposed */ }
      const text = [
        `Blockly ${B.VERSION || '?'} · ${new Date().toISOString()}`,
        '## point_setter definition', definition('point_setter'),
        '## model_block definition', definition('model_block'),
        onCanvas('point_setter', ['selected_point_name']),
        onCanvas('model_block', ['selected_model']),
        '## Workspace change listeners', listeners || '(none visible)',
      ].join('\n\n');
      return text.slice(0, 400000);
    },
    logicMap() {
      const { ws } = env();
      return { graph: logicGraph(ws), flow: logicFlow(ws) };
    },
    simulatorModel() { return simulatorModel(); },
    validate,
    preview,
    apply,
    undo,
  };

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.dir !== 'req') return;
    let reply;
    try {
      if (!Object.hasOwn(HANDLERS, msg.method)) throw new Error(`Unknown method "${msg.method}"`);
      reply = { ok: true, result: await HANDLERS[msg.method](msg.params || {}) };
    } catch (err) {
      reply = { ok: false, error: err?.message || String(err) };
    }
    window.postMessage({ channel: CHANNEL, dir: 'res', id: msg.id, ...reply }, window.location.origin);
  });
})();
