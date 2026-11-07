'use strict';
// Worker-side message handler. It owns the parsed document and answers the webview's requests
// (forwarded by the extension host). Pure Node: tests drive it directly or through a real worker thread.

const fs = require('fs');
const { decode, parseText, stripJsonc } = require('./parse');
const { TreeModel } = require('./model');
const { locate } = require('./locate');
const { jsonPath } = require('./paths');

const FIRST_SCREEN_ROWS = 400; // start at level 2 when that many rows or fewer, else level 1

function createSession({ post, readFile = p => fs.readFileSync(p), fileSize = p => fs.statSync(p).size }) {
  let model = null;

  function changed(extra) {
    post({ type: 'changed', v: model.v, total: model.rows.length, capped: model.capped, ...extra });
  }

  let src = null; // what was read: {path} | {bytes} | {text}, so Go to line can read it again
  let mode = 'json';

  /** Reads and parses. Returns {parsed, size, tRead} or {fail: {...init failure fields}}. */
  function readParse(m) {
    let text;
    let size = 0;
    if (typeof m.text === 'string') { text = m.text; size = Buffer.byteLength(text); }
    else {
      if (!m.bytes && m.limit) {
        const n = fileSize(m.path);
        if (n > m.limit) return { fail: { kind: 'tooBig', size: n } };
      }
      const bytes = m.bytes ? Buffer.from(m.bytes) : readFile(m.path);
      size = bytes.length;
      if (m.limit && size > m.limit) return { fail: { kind: 'tooBig', size } };
      text = decode(bytes);
    }
    const tRead = Date.now();
    try { return { parsed: parseText(text, m.ext || ''), size, tRead }; } catch (e) {
      return { fail: { kind: 'parse', size, message: e.message, line: e.line || 0, col: e.col || 0, snippet: e.snippet || '' } };
    }
  }

  function remember(m, parsed) {
    src = typeof m.text === 'string' ? { text: m.text } : m.bytes ? { bytes: Buffer.from(m.bytes) } : { path: m.path };
    mode = parsed.mode;
  }

  function initMsg(m, r, t0, level, extra) {
    const rootT = model.rowOut(model.root);
    return {
      type: 'init', ok: true, size: r.size, mode: r.parsed.mode, notes: r.parsed.notes, level,
      big: r.parsed.big || 0, bigUnsupported: !!r.parsed.bigUnsupported,
      rootType: rootT.t, rootCount: rootT.n || 0, rootTable: rootT.tab ? model.root.id : 0,
      v: model.v, total: model.rows.length, rows: model.rowsOut(extra && extra.start || 0, m.first || 120),
      readMs: r.tRead - t0, parseMs: Date.now() - r.tRead, ...extra,
    };
  }

  const handlers = {
    load(m) {
      const t0 = Date.now();
      const r = readParse(m);
      if (r.fail) { post({ type: 'init', ok: false, ...r.fail }); return; }
      remember(m, r.parsed);
      model = new TreeModel(r.parsed.value, m.maxRows ? { maxRows: m.maxRows } : {});
      let level = 2;
      if (model.setLevel(2) > FIRST_SCREEN_ROWS) { model.setLevel(1); level = 1; }
      post(initMsg(m, r, t0, level));
    },
    /** The file changed on disk: parse it again and keep open nodes, the selection, the search and the table. */
    reload(m) {
      const t0 = Date.now();
      const r = readParse(m);
      if (r.fail) {
        const why = r.fail.kind === 'parse'
          ? `The file changed but is not valid JSON right now${r.fail.line ? ` (line ${r.fail.line}, column ${r.fail.col})` : ''}. Showing the last good version.`
          : r.fail.kind === 'tooBig' ? 'The file changed and is now over the size limit. Showing the last good version.' : 'The file changed but could not be read. Showing the last good version.';
        post({ type: 'toast', text: why, error: true, sticky: true });
        return;
      }
      const old = model;
      const rootOpen = old.root.open;
      const open = old.openPaths();
      const selSegs = m.sel && m.sel.id ? (old.node(m.sel.id) ? old.segsOf(old.node(m.sel.id)) : null) : null;
      const tableSegs = old.table ? old.segsOf(old.table.node) : null;
      const topSegs = Number.isInteger(m.top) && old.rows[m.top] ? old.segsOf(old.rows[m.top]) : null;
      const query = old.query;
      remember(m, r.parsed);
      model = new TreeModel(r.parsed.value, m.maxRows ? { maxRows: m.maxRows } : {});
      if (rootOpen && model.expandable(model.root)) model.root.open = true;
      for (const segs of open) model.openSegs(segs);
      model.rebuildRows();
      const extra = { reloaded: true, start: 0 };
      if (selSegs) {
        const n = model.openSegs(selSegs, false);
        if (n) { model.rebuildRows(); extra.sel = { row: model.rowIndex(n), id: n.id }; }
      }
      if (topSegs) {
        let n = null;
        for (let k = topSegs.length; k >= 0 && !n; k--) {
          let x = model.root;
          for (const seg of topSegs.slice(0, k)) {
            const kids = x && model.expandable(x) && x.open ? model.children(x) : null;
            x = kids ? (Array.isArray(model.inner(x)) ? kids[seg] : kids.find(c => c.key === seg)) : null;
            if (!x) break;
          }
          if (x && model.rowIndex(x) >= 0) n = x;
        }
        if (n) extra.top = model.rowIndex(n);
      }
      if (extra.top) extra.start = Math.max(0, extra.top - 20);
      if (tableSegs) {
        const n = model.openSegs(tableSegs, false);
        if (n && model.tableOpen(n.id)) extra.tableId = n.id;
        model.rebuildRows();
        if (extra.sel) extra.sel.row = model.rowIndex(model.node(extra.sel.id));
      }
      post(initMsg(m, r, t0, '', extra));
      if (query) {
        const c = model.search(query);
        post({ type: 'found', q: model.query, count: c, capped: model.hitsCapped, ms: 0, keep: true });
      }
    },
    /** Line and column of a node or table cell in the file, for Go to line. */
    locate(m) {
      const x = model.resolve(m.target);
      if (!x) { post({ type: 'located', ok: false, message: 'Select a node first.' }); return; }
      if (mode === 'json5') { post({ type: 'located', ok: false, message: 'Go to line works for JSON and JSONC files. This file was read as JSON5.' }); return; }
      let text;
      try {
        text = src.text !== undefined ? src.text : decode(src.bytes || readFile(src.path));
      } catch (e) { post({ type: 'located', ok: false, message: `Could not read the file: ${e && e.message || e}` }); return; }
      if (text.charCodeAt(0) === 0xfeff) text = ' ' + text.slice(1);
      if (mode === 'jsonc') text = stripJsonc(text).text;
      const p = locate(text, x.segs);
      if (!p) { post({ type: 'located', ok: false, message: 'Could not find this node in the file. It may have changed since it was opened.' }); return; }
      post({ type: 'located', ok: true, line: p.line, col: p.col, path: jsonPath(x.segs) });
    },
    rows(m) { post({ type: 'rows', v: model.v, start: m.start | 0, rows: model.rowsOut(m.start, m.count), total: model.rows.length }); },
    toggle(m) { model.toggle(m.id, m.open, m.row); changed({ focus: model.rowIndex(model.node(m.id), m.row), id: m.id | 0 }); },
    level(m) {
      const n = m.level === 'all' ? Infinity : Math.max(0, Math.min(50, Number(m.level) | 0));
      model.setLevel(n);
      changed({ level: m.level, focus: 0 });
    },
    nested(m) {
      const ok = model.openNested(m.id, m.row);
      changed({ focus: model.rowIndex(model.node(m.id), m.row), id: m.id | 0, nestedFailed: !ok });
    },
    search(m) {
      const t0 = Date.now();
      const n = model.search(String(m.q || '').slice(0, 500));
      post({ type: 'found', q: model.query, count: n, capped: model.hitsCapped, ms: Date.now() - t0 });
      if (n) handlers.goto({ index: 0 });
      else changed({});
    },
    goto(m) {
      const r = model.gotoHit(m.index | 0);
      if (!r) return;
      changed({ focus: r.row, id: r.id, hit: r.index, hits: model.hits.length });
    },
    select(m) { post({ type: 'detail', target: m.target, detail: model.detail(m.target) }); },
    copyValue(m) { post({ type: 'clip', what: 'value', ...model.valueText(m.target) }); },
    table(m) {
      const info = model.tableOpen(m.id);
      if (!info) { post({ type: 'tableInit', ok: false }); return; }
      post({ type: 'tableInit', ok: true, ...info, rows: model.tableRowsOut(0, 120) });
    },
    tableRows(m) { post({ type: 'tableRows', tv: m.tv | 0, start: m.start | 0, rows: model.tableRowsOut(m.start, m.count) }); },
    tableSort(m) {
      model.tableSort(m.col | 0, m.dir === 'asc' || m.dir === 'desc' ? m.dir : null);
      post({ type: 'tableSorted', col: m.col | 0, dir: model.table && model.table.sort ? model.table.sort.dir : null, rows: model.tableRowsOut(0, 120) });
    },
  };

  function handle(m) {
    if (!m || typeof m.type !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, m.type)) return;
    if (m.type !== 'load' && !model) return;
    try { handlers[m.type](m); } catch (e) {
      post({ type: 'error', message: String(e && e.message || e) });
    }
  }

  return { handle, get model() { return model; } };
}

module.exports = { createSession, FIRST_SCREEN_ROWS };
