'use strict';
// Worker-side message handler. It owns the parsed document and answers the webview's requests
// (forwarded by the extension host). Pure Node: tests drive it directly or through a real worker thread.

const fs = require('fs');
const { decode, parseText } = require('./parse');
const { TreeModel } = require('./model');

const FIRST_SCREEN_ROWS = 400; // start at level 2 when that many rows or fewer, else level 1

function createSession({ post, readFile = p => fs.readFileSync(p), fileSize = p => fs.statSync(p).size }) {
  let model = null;

  function changed(extra) {
    post({ type: 'changed', v: model.v, total: model.rows.length, capped: model.capped, ...extra });
  }

  const handlers = {
    load(m) {
      const t0 = Date.now();
      let text;
      let size = 0;
      if (typeof m.text === 'string') { text = m.text; size = Buffer.byteLength(text); }
      else {
        if (!m.bytes && m.limit) {
          const n = fileSize(m.path);
          if (n > m.limit) { post({ type: 'init', ok: false, kind: 'tooBig', size: n }); return; }
        }
        const bytes = m.bytes ? Buffer.from(m.bytes) : readFile(m.path);
        size = bytes.length;
        if (m.limit && size > m.limit) { post({ type: 'init', ok: false, kind: 'tooBig', size }); return; }
        text = decode(bytes);
      }
      const tRead = Date.now();
      let parsed;
      try { parsed = parseText(text, m.ext || ''); } catch (e) {
        post({ type: 'init', ok: false, kind: 'parse', size, message: e.message, line: e.line || 0, col: e.col || 0, snippet: e.snippet || '' });
        return;
      }
      text = null;
      model = new TreeModel(parsed.value, m.maxRows ? { maxRows: m.maxRows } : {});
      let level = 2;
      if (model.setLevel(2) > FIRST_SCREEN_ROWS) { model.setLevel(1); level = 1; }
      const rootT = model.rowOut(model.root);
      post({
        type: 'init', ok: true, size, mode: parsed.mode, notes: parsed.notes, level,
        rootType: rootT.t, rootCount: rootT.n || 0, rootTable: rootT.tab ? model.root.id : 0,
        v: model.v, total: model.rows.length, rows: model.rowsOut(0, m.first || 120),
        readMs: tRead - t0, parseMs: Date.now() - tRead,
      });
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
