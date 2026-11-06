'use strict';
// Extension-host side of one viewer tab: checks the size, starts the worker and relays messages.
// No vscode import: extension.js passes in what it needs, so tests can use fakes (and a fake file size).

const DEFAULT_LIMIT_MB = 200;

function fmtSize(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1).replace(/\.0$/, '') + ' GB';
  if (n >= 1024 ** 2) return Math.round(n / 1024 ** 2) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function limitBytes(mb) {
  const v = Number(mb);
  const clamped = Number.isFinite(v) ? Math.min(1024, Math.max(1, v)) : DEFAULT_LIMIT_MB;
  return Math.round(clamped * 1024 * 1024);
}

function tooBigMessage(size, limit) {
  return `This file is ${fmtSize(size)}. JSON Viewer opens files up to ${fmtSize(limit)} so VS Code stays responsive. ` +
    'The file was not read. Open it as text, or raise the limit with the setting jsonTreeViewer.maxFileMB.';
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Keeps only the fields each message type needs, with the right types. Unknown types give null. */
function cleanMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return null;
  const target = t => {
    if (!t || typeof t !== 'object') return null;
    if (t.cell && typeof t.cell === 'object') return { cell: { r: num(t.cell.r), c: num(t.cell.c) } };
    return { id: num(t.id) };
  };
  switch (m.type) {
    case 'ready': case 'openText': return { type: m.type };
    case 'rows': return { type: 'rows', start: num(m.start), count: num(m.count) };
    case 'toggle': return { type: 'toggle', id: num(m.id), row: num(m.row), open: typeof m.open === 'boolean' ? m.open : undefined };
    case 'level': return { type: 'level', level: m.level === 'all' ? 'all' : num(m.level) };
    case 'nested': return { type: 'nested', id: num(m.id), row: num(m.row) };
    case 'search': return { type: 'search', q: String(m.q == null ? '' : m.q).slice(0, 500) };
    case 'goto': return { type: 'goto', index: num(m.index) };
    case 'select': case 'copyValue': return { type: m.type, target: target(m.target) };
    case 'table': return { type: 'table', id: num(m.id) };
    case 'tableRows': return { type: 'tableRows', start: num(m.start), count: num(m.count), tv: num(m.tv) };
    case 'tableSort': return { type: 'tableSort', col: num(m.col), dir: m.dir === 'asc' || m.dir === 'desc' ? m.dir : null };
    case 'copyText': return typeof m.text === 'string' ? { type: 'copyText', text: m.text.slice(0, 100000), what: String(m.what || '').slice(0, 40) } : null;
    default: return null;
  }
}

/**
 * @param {object} o
 *  source: {path?, text?, name, ext}  (path = local file read by the worker; text = selection or clipboard)
 *  statSize(): Promise<number>        size check before anything is read (mocked in tests)
 *  readBytes(): Promise<Uint8Array>   for files that are not on the local disk
 *  spawnWorker(): Worker-like {postMessage, on, terminate}
 *  post(msg), copy(text), openAsText(), rendered()
 */
function createHost(o) {
  let worker = null;
  let disposed = false;
  let counted = false;
  const limit = o.limit || limitBytes(DEFAULT_LIMIT_MB);
  const post = m => { if (!disposed) o.post(m); };

  function onWorker(m) {
    if (disposed || !m) return;
    if (m.type === 'clip') {
      if (m.text !== undefined) Promise.resolve(o.copy(m.text)).then(() => post({ type: 'toast', text: 'Copied value' }), () => {});
      else post({ type: 'toast', text: m.error || 'Nothing to copy', error: true });
      return;
    }
    if (m.type === 'init' && m.ok === false && m.kind === 'tooBig') m = { ...m, limit, message: tooBigMessage(m.size, limit) };
    if (m.type === 'init' && m.ok && !counted) { counted = true; if (o.rendered) o.rendered(); }
    post(m);
  }

  async function load() {
    if (worker) { worker.terminate(); worker = null; }
    const src = o.source;
    let size = 0;
    if (typeof src.text !== 'string') {
      try { size = await o.statSize(); } catch (e) {
        post({ type: 'init', ok: false, kind: 'read', message: `Could not read the file: ${e && e.message || e}` });
        return;
      }
      if (size > limit) {
        post({ type: 'init', ok: false, kind: 'tooBig', size, limit, message: tooBigMessage(size, limit) });
        return;
      }
    }
    if (disposed) return;
    post({ type: 'loading', size, name: src.name });
    const msg = { type: 'load', ext: src.ext || '', limit };
    if (typeof src.text === 'string') msg.text = src.text;
    else if (src.path) msg.path = src.path;
    else {
      try { msg.bytes = await o.readBytes(); } catch (e) {
        post({ type: 'init', ok: false, kind: 'read', message: `Could not read the file: ${e && e.message || e}` });
        return;
      }
    }
    if (disposed) return;
    worker = o.spawnWorker();
    worker.on('message', onWorker);
    worker.on('error', e => post({ type: 'init', ok: false, kind: 'crash', message: `The parser stopped: ${e && e.message || e}` }));
    worker.postMessage(msg);
  }

  function handle(raw) {
    const m = cleanMessage(raw);
    if (!m || disposed) return;
    if (m.type === 'ready') return load();
    if (m.type === 'openText') return o.openAsText && o.openAsText();
    if (m.type === 'copyText') {
      return Promise.resolve(o.copy(m.text)).then(() => post({ type: 'toast', text: m.what ? `Copied ${m.what}` : 'Copied' }), () => {});
    }
    if (worker) worker.postMessage(m);
  }

  function dispose() {
    disposed = true;
    if (worker) { worker.terminate(); worker = null; }
  }

  return { handle, dispose, get worker() { return worker; } };
}

module.exports = { createHost, cleanMessage, tooBigMessage, limitBytes, fmtSize, DEFAULT_LIMIT_MB };
