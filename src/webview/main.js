'use strict';
// Webview UI: a virtual tree and a virtual table. It never holds the document, only the rows on screen;
// everything else lives in the worker. All file text goes into the DOM with textContent.

const vscode = acquireVsCodeApi();
const ROW_H = 22;
const PAGE = 100;
const COL_W = 170;
const IDX_W = 64;

const S = {
  name: document.getElementById('app').dataset.title || '',
  v: 0, total: 0, cache: new Map(), pending: new Set(),
  sel: null, // {row, id} in the tree, or {cell:{r,c}} in the table
  hits: 0, hit: -1, q: '', capped: false,
  mode: 'tree',
  table: null, // {id, path, count, columns, tv, cache, pending, sort}
  rootTable: 0,
  ready: false,
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
function btn(text, title, cls) { const b = el('button', 'btn' + (cls ? ' ' + cls : ''), text); if (title) b.title = title; return b; }
function fmtN(n) { return Number(n).toLocaleString('en-US'); }
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB'];
  let v = n, k = -1;
  do { v /= 1024; k++; } while (v >= 1024 && k < u.length - 1);
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[k];
}
function fmtMs(ms) { return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(2)} s`; }
function post(m) { vscode.postMessage(m); }

// ---------- layout ----------
const app = document.getElementById('app');
const toolbar = el('div', 'toolbar');
const title = el('span', 'title', S.name);
const fmtBadge = el('span', 'fmt');
fmtBadge.hidden = true;
const stats = el('span', 'stats');
const levels = el('div', 'seg');
const levelBtns = [['0', 'Collapse', 'Collapse to the root'], ['1', '1', 'Expand to level 1'], ['2', '2', 'Expand to level 2'], ['3', '3', 'Expand to level 3'], ['all', 'All', 'Expand everything (up to 1,000,000 rows)']]
  .map(([lv, text, tip]) => { const b = btn(text, tip, 'seg-btn'); b.dataset.level = lv; b.addEventListener('click', () => post({ type: 'level', level: lv === 'all' ? 'all' : Number(lv) })); levels.append(b); return b; });
const searchBox = el('div', 'searchbox');
const search = el('input', 'search');
search.type = 'text';
search.placeholder = 'Search keys and values';
search.setAttribute('aria-label', 'Search keys and values');
const btnPrev = btn('↑', 'Previous match (Shift+Enter)', 'icon');
const btnNext = btn('↓', 'Next match (Enter)', 'icon');
const hitText = el('span', 'hittext');
searchBox.append(search, btnPrev, btnNext, hitText);
const tabs = el('div', 'seg');
const tabTree = btn('Tree', 'Tree view', 'seg-btn on');
const tabTable = btn('Table', 'Array of objects as a table', 'seg-btn');
tabTable.disabled = true;
tabs.append(tabTree, tabTable);
const btnText = btn('Open as Text', 'Open in the normal text editor');
toolbar.append(title, fmtBadge, stats, el('span', 'spacer'), levels, searchBox, tabs, btnText);

const notice = el('div', 'notice');
notice.hidden = true;

const main = el('div', 'main');
const treePane = el('div', 'pane');
const list = el('div', 'vlist');
list.tabIndex = 0;
const sizer = el('div', 'sizer');
list.append(sizer);
treePane.append(list);

const tablePane = el('div', 'pane');
tablePane.hidden = true;
const tableBar = el('div', 'tablebar');
const tableTitle = el('span', 'tabletitle');
const btnBack = btn('Back to tree', 'Show the tree again');
tableBar.append(tableTitle, el('span', 'spacer'), btnBack);
const grid = el('div', 'grid');
grid.tabIndex = 0;
const gsizer = el('div', 'gsizer');
const ghead = el('div', 'ghead');
const gbody = el('div', 'gbody');
gsizer.append(ghead, gbody);
grid.append(gsizer);
tablePane.append(tableBar, grid);

const fatal = el('div', 'fatal');
fatal.hidden = true;
main.append(treePane, tablePane, fatal);

const detail = el('div', 'detail');
const detailPath = el('span', 'dpath', 'Click a node to see its path.');
const detailType = el('span', 'dtype');
const btnCopyPath = btn('Copy JSONPath', 'Copy the JSONPath, for example $.items[3].id');
const btnCopyJs = btn('Copy JS path', 'Copy the JavaScript path, for example data.items[3].id');
const btnCopyVal = btn('Copy value', 'Copy the value (strings as plain text, the rest as JSON)');
const btnTable = btn('Show as table', 'Show this array of objects as a table', 'primary');
const btnNested = btn('Open JSON string', 'Parse this string as JSON and show it as a tree', 'primary');
detail.append(detailPath, detailType, el('span', 'spacer'), btnNested, btnTable, btnCopyPath, btnCopyJs, btnCopyVal);
for (const b of [btnCopyPath, btnCopyJs, btnCopyVal, btnTable, btnNested]) b.disabled = true;

const toast = el('div', 'toast');
toast.hidden = true;
app.append(toolbar, notice, main, detail, toast);

let toastTimer = null;
function flash(text, error) {
  toast.textContent = text;
  toast.classList.toggle('err', !!error);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 1800);
}

function showFatal(head, text, snippet, canOpen) {
  treePane.hidden = true; tablePane.hidden = true; fatal.hidden = false;
  levels.hidden = true; searchBox.hidden = true; tabs.hidden = true;
  fatal.replaceChildren();
  fatal.append(el('div', 'fhead', head), el('div', 'ftext', text));
  if (snippet) fatal.append(el('pre', 'fsnip', snippet));
  if (canOpen) { const b = btn('Open as Text', 'Open in the normal text editor', 'primary'); b.addEventListener('click', () => post({ type: 'openText' })); fatal.append(b); }
  detail.hidden = true;
}

// ---------- tree rows ----------
const pool = [];
let raf = false;
function schedule() { if (!raf) { raf = true; requestAnimationFrame(() => { raf = false; render(); }); } }

function makeRow() {
  const r = el('div', 'row');
  r._ind = el('span', 'ind');
  r._tog = el('span', 'tog');
  r._key = el('span', 'key');
  r._colon = el('span', 'colon', ': ');
  r._badge = el('span', 'badge');
  r._count = el('span', 'count');
  r._val = el('span', 'val');
  r._js = btn('{ } JSON string', 'This string holds escaped JSON. Click to open it as a tree.', 'chip');
  r._tab = btn('⊞ Table', 'Show this array of objects as a table', 'chip');
  r.append(r._ind, r._tog, r._key, r._colon, r._badge, r._count, r._val, r._js, r._tab);
  r._tog.addEventListener('click', e => { e.stopPropagation(); if (r._data) toggleRow(r._pos, r._data); });
  r._js.addEventListener('click', e => { e.stopPropagation(); if (r._data) { select(r._pos, r._data.id); post({ type: 'nested', id: r._data.id, row: r._pos }); } });
  r._tab.addEventListener('click', e => { e.stopPropagation(); if (r._data) openTable(r._data.id); });
  r.addEventListener('click', () => { if (r._data) { select(r._pos, r._data.id); list.focus(); } });
  r.addEventListener('dblclick', () => { if (r._data) toggleRow(r._pos, r._data); });
  sizer.append(r);
  return r;
}

const BADGE = { object: 'obj', array: 'arr', string: 'str', number: 'num', boolean: 'bool', null: 'null' };
function fillRow(r, pos, d) {
  r._pos = pos;
  r._data = d;
  r.dataset.pos = pos;
  r.style.transform = `translateY(${pos * ROW_H}px)`;
  r.className = 'row' + (S.sel && S.sel.id === (d && d.id) ? ' sel' : '') + (d && d.m ? ' hit' : '');
  if (!d) { r._ind.style.width = '0'; for (const k of ['_tog', '_key', '_colon', '_badge', '_count', '_val']) r[k].textContent = ''; r._badge.className = 'badge'; r._val.textContent = '…'; r._js.hidden = true; r._tab.hidden = true; return; }
  r._ind.style.width = (d.d * 16) + 'px';
  const box = d.t === 'object' || d.t === 'array';
  r._tog.textContent = box ? (d.o ? '▾' : '▸') : '';
  r._colon.textContent = d.k === null || d.k === undefined ? ' ' : ': ';
  if (d.k === null || d.k === undefined) { r._key.textContent = 'root'; r._key.className = 'key rootkey'; }
  else if (typeof d.k === 'number') { r._key.textContent = d.k; r._key.className = 'key idx'; }
  else { r._key.textContent = d.k; r._key.className = 'key'; }
  r._badge.textContent = d.js === 2 ? 'json' : BADGE[d.t] || d.t;
  r._badge.className = 'badge b-' + (d.js === 2 ? 'json' : d.t);
  r._count.textContent = box ? (d.t === 'array' ? `[${fmtN(d.n)}]` : `{${fmtN(d.n)}}`) : '';
  r._val.textContent = d.pv || '';
  r._val.className = 'val v-' + d.t + (box ? ' pv' : '');
  if (d.len) r._val.title = `${fmtN(d.len)} characters (copy the value to get all of it)`; else r._val.removeAttribute('title');
  r._js.hidden = d.js !== 1;
  r._tab.hidden = !d.tab;
}

function visible() {
  const first = Math.max(0, Math.floor(list.scrollTop / ROW_H));
  const n = Math.ceil(list.clientHeight / ROW_H) + 1;
  return { first, last: Math.min(S.total - 1, first + n - 1) };
}

function render() {
  if (!S.ready || S.mode !== 'tree') return;
  sizer.style.height = (S.total * ROW_H) + 'px';
  const { first, last } = visible();
  const need = Math.max(0, last - first + 1);
  while (pool.length < need) pool.push(makeRow());
  for (let i = 0; i < pool.length; i++) {
    const r = pool[i];
    if (i < need) { r.hidden = false; fillRow(r, first + i, S.cache.get(first + i)); }
    else r.hidden = true;
  }
  request(first, last);
}

function request(first, last) {
  if (last < first) return;
  const p0 = Math.floor(Math.max(0, first - 40) / PAGE), p1 = Math.floor(Math.min(S.total - 1, last + 40) / PAGE);
  for (let p = p0; p <= p1; p++) {
    if (S.pending.has(p) || S.cache.has(p * PAGE)) continue;
    S.pending.add(p);
    post({ type: 'rows', start: p * PAGE, count: PAGE });
  }
}

function putRows(start, rows) { for (let i = 0; i < rows.length; i++) S.cache.set(start + i, rows[i]); }

function toggleRow(pos, d) {
  if (d.t !== 'object' && d.t !== 'array') return;
  post({ type: 'toggle', id: d.id, row: pos });
}

function select(pos, id) {
  S.sel = { row: pos, id };
  post({ type: 'select', target: { id } });
  schedule();
}

function scrollToRow(pos) {
  const top = pos * ROW_H;
  if (top < list.scrollTop || top + ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = Math.max(0, top - list.clientHeight / 3);
}

list.addEventListener('scroll', schedule);
window.addEventListener('resize', () => { schedule(); renderTable(); });

list.addEventListener('keydown', e => {
  if (!S.sel || S.sel.row === undefined) return;
  const pos = S.sel.row;
  const d = S.cache.get(pos);
  const move = p => { const x = S.cache.get(p); if (x) { select(p, x.id); scrollToRow(p); } };
  if (e.key === 'ArrowDown') { e.preventDefault(); if (pos < S.total - 1) move(pos + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (pos > 0) move(pos - 1); }
  else if (e.key === 'ArrowRight' && d) { e.preventDefault(); if ((d.t === 'object' || d.t === 'array') && !d.o) post({ type: 'toggle', id: d.id, row: pos, open: true }); else move(pos + 1); }
  else if (e.key === 'ArrowLeft' && d) {
    e.preventDefault();
    if (d.o) post({ type: 'toggle', id: d.id, row: pos, open: false });
    else for (let p = pos - 1; p >= 0; p--) { const x = S.cache.get(p); if (x && x.d < d.d) { move(p); break; } }
  } else if (e.key === 'Enter' && d) { e.preventDefault(); toggleRow(pos, d); }
});

// ---------- search ----------
function runSearch(dir) {
  const q = search.value;
  if (q !== S.q) { S.q = q; hitText.textContent = q ? 'Searching…' : ''; post({ type: 'search', q }); return; }
  if (S.hits) post({ type: 'goto', index: S.hit + dir });
}
search.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { search.value = ''; runSearch(1); }
});
btnNext.addEventListener('click', () => runSearch(1));
btnPrev.addEventListener('click', () => runSearch(-1));
function hitLabel() {
  if (!S.q) return '';
  if (!S.hits) return 'No matches';
  return `${fmtN(S.hit + 1)} of ${fmtN(S.hits)}${S.hitsCapped ? '+' : ''}`;
}
window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); search.focus(); search.select(); }
  else if (e.key === 'F3') { e.preventDefault(); runSearch(e.shiftKey ? -1 : 1); }
});

// ---------- table ----------
const tpool = [];
function openTable(id) { post({ type: 'table', id }); }
function setMode(mode) {
  S.mode = mode;
  treePane.hidden = mode !== 'tree';
  tablePane.hidden = mode !== 'table';
  tabTree.classList.toggle('on', mode === 'tree');
  tabTable.classList.toggle('on', mode === 'table');
  if (mode === 'tree') { schedule(); list.focus(); } else renderTable();
}
tabTree.addEventListener('click', () => setMode('tree'));
btnBack.addEventListener('click', () => setMode('tree'));
tabTable.addEventListener('click', () => { if (S.table) setMode('table'); else if (S.rootTable) openTable(S.rootTable); });

function buildHead() {
  const t = S.table;
  ghead.replaceChildren();
  const corner = el('div', 'gcell gidx', '#');
  ghead.append(corner);
  t.columns.forEach((c, i) => {
    const h = el('div', 'gcell ghcell');
    h.style.width = COL_W + 'px';
    const name = el('span', 'hname', c.name);
    const ty = el('span', 'htype b-' + c.type, BADGE[c.type] || c.type);
    const arrow = el('span', 'harrow', t.sort && t.sort.col === i ? (t.sort.dir === 'asc' ? '▲' : '▼') : '');
    h.append(name, ty, arrow);
    h.title = `${c.name} (${c.type}). Click to sort.`;
    h.addEventListener('click', () => {
      const cur = t.sort && t.sort.col === i ? t.sort.dir : null;
      const dir = cur === null ? 'asc' : cur === 'asc' ? 'desc' : null;
      post({ type: 'tableSort', col: i, dir });
    });
    ghead.append(h);
  });
  const w = IDX_W + t.columns.length * COL_W;
  gsizer.style.width = w + 'px';
}

function makeTRow() {
  const r = el('div', 'grow');
  r._idx = el('div', 'gcell gidx');
  r.append(r._idx);
  r._cells = [];
  gbody.append(r);
  return r;
}

function renderTable() {
  const t = S.table;
  if (!t || S.mode !== 'table') return;
  gsizer.style.height = (t.count * ROW_H + ROW_H + 4) + 'px';
  const first = Math.max(0, Math.floor(grid.scrollTop / ROW_H));
  const n = Math.ceil(grid.clientHeight / ROW_H) + 1;
  const last = Math.min(t.count - 1, first + n - 1);
  const need = Math.max(0, last - first + 1);
  while (tpool.length < need) tpool.push(makeTRow());
  for (let i = 0; i < tpool.length; i++) {
    const r = tpool[i];
    if (i >= need) { r.hidden = true; continue; }
    r.hidden = false;
    const pos = first + i;
    const d = t.cache.get(pos);
    r.style.transform = `translateY(${pos * ROW_H}px)`;
    r._idx.textContent = d ? d.i : '';
    while (r._cells.length < t.columns.length) {
      const c = el('div', 'gcell');
      c.style.width = COL_W + 'px';
      const ci = r._cells.length;
      c.addEventListener('click', () => { if (r._pos !== undefined) selectCell(r._pos, ci); });
      r.append(c); r._cells.push(c);
    }
    while (r._cells.length > t.columns.length) r._cells.pop().remove();
    r._pos = pos;
    r._cells.forEach((c, ci) => {
      const x = d && d.cells[ci];
      c.textContent = x ? (x.t === 'missing' ? '' : x.t === 'null' ? 'null' : x.s) : '…';
      c.className = 'gcell c-' + (x ? x.t : 'pending') + (S.sel && S.sel.cell && S.sel.cell.r === pos && S.sel.cell.c === ci ? ' csel' : '');
    });
  }
  const p0 = Math.floor(Math.max(0, first - 40) / PAGE), p1 = Math.floor(Math.min(t.count - 1, last + 40) / PAGE);
  for (let p = p0; p <= p1; p++) {
    if (t.pending.has(p) || t.cache.has(p * PAGE)) continue;
    t.pending.add(p);
    post({ type: 'tableRows', start: p * PAGE, count: PAGE, tv: t.tv });
  }
}
grid.addEventListener('scroll', () => requestAnimationFrame(renderTable));

function selectCell(r, c) {
  S.sel = { cell: { r, c } };
  post({ type: 'select', target: { cell: { r, c } } });
  renderTable();
}

// ---------- detail bar ----------
let detailInfo = null;
function setDetail(d) {
  detailInfo = d;
  const on = !!d;
  for (const b of [btnCopyPath, btnCopyJs, btnCopyVal]) b.disabled = !on;
  btnTable.disabled = !(d && d.tab && d.id);
  btnTable.hidden = !(d && d.tab && d.id);
  btnNested.hidden = !(d && d.js === 1);
  btnNested.disabled = !(d && d.js === 1);
  if (!d) { detailPath.textContent = 'Click a node to see its path.'; detailType.textContent = ''; return; }
  detailPath.textContent = d.jsonPath;
  detailPath.title = d.jsPath;
  const bits = [d.t];
  if (d.n !== undefined) bits.push(`${fmtN(d.n)} ${d.t === 'array' ? 'items' : 'keys'}`);
  if (d.len !== undefined) bits.push(`${fmtN(d.len)} chars`);
  detailType.textContent = bits.join(' · ');
}
setDetail(null);
btnCopyPath.addEventListener('click', () => detailInfo && post({ type: 'copyText', text: detailInfo.jsonPath, what: detailInfo.jsonPath }));
btnCopyJs.addEventListener('click', () => detailInfo && post({ type: 'copyText', text: detailInfo.jsPath, what: detailInfo.jsPath }));
btnCopyVal.addEventListener('click', () => { if (detailInfo && S.sel) post({ type: 'copyValue', target: S.sel.cell ? { cell: S.sel.cell } : { id: S.sel.id } }); });
btnTable.addEventListener('click', () => detailInfo && detailInfo.id && openTable(detailInfo.id));
btnNested.addEventListener('click', () => { if (detailInfo && detailInfo.id) post({ type: 'nested', id: detailInfo.id, row: S.sel && S.sel.row || 0 }); });
btnText.addEventListener('click', () => post({ type: 'openText' }));

// ---------- messages ----------
function setLevelOn(level) { for (const b of levelBtns) b.classList.toggle('on', String(level) === b.dataset.level); }

window.addEventListener('message', ev => {
  const m = ev.data;
  if (!m || typeof m.type !== 'string') return;
  switch (m.type) {
    case 'loading':
      stats.textContent = m.size ? `Reading ${fmtBytes(m.size)}…` : 'Reading…';
      break;
    case 'init': {
      if (!m.ok) {
        stats.textContent = m.size ? fmtBytes(m.size) : '';
        if (m.kind === 'tooBig') showFatal('This file is too big for the tree view', m.message, '', true);
        else if (m.kind === 'parse') {
          const where = m.line ? ` (line ${fmtN(m.line)}, column ${fmtN(m.col)})` : '';
          showFatal('This is not valid JSON', `${m.message}${where}. JSON with comments, trailing commas and JSON5 are also tried.`, m.snippet, true);
        } else showFatal('Could not open the file', m.message || 'Unknown error', '', true);
        return;
      }
      S.ready = true;
      S.v = m.v; S.total = m.total; S.cache.clear(); S.pending.clear();
      putRows(0, m.rows);
      S.rootTable = m.rootTable || 0;
      tabTable.disabled = !S.rootTable;
      fmtBadge.hidden = false;
      fmtBadge.textContent = m.mode.toUpperCase();
      const notes = m.notes && m.notes.length && m.mode !== 'json' ? ` (${m.notes.join(', ')})` : '';
      fmtBadge.title = notes ? `Read with ${notes.slice(2, -1)}` : 'Valid JSON';
      stats.textContent = `${fmtBytes(m.size)} · ${m.rootType === 'array' ? fmtN(m.rootCount) + ' items' : m.rootType === 'object' ? fmtN(m.rootCount) + ' keys' : m.rootType} · parsed in ${fmtMs(m.parseMs)}`;
      if (notes) { notice.hidden = false; notice.textContent = `Read as ${m.mode.toUpperCase()}${notes}. The tree shows the data; comments are not part of it.`; }
      setLevelOn(m.level);
      S.sel = { row: 0, id: m.rows[0] && m.rows[0].id };
      if (S.sel.id) post({ type: 'select', target: { id: S.sel.id } });
      render();
      list.focus();
      break;
    }
    case 'rows':
      if (m.v !== S.v) return;
      S.pending.delete(Math.floor(m.start / PAGE));
      putRows(m.start, m.rows);
      S.total = m.total;
      schedule();
      break;
    case 'changed':
      S.v = m.v; S.total = m.total; S.cache.clear(); S.pending.clear();
      if (m.level !== undefined) setLevelOn(m.level); else if (m.id) setLevelOn('');
      if (m.capped) { notice.hidden = false; notice.textContent = `Showing the first ${fmtN(m.total)} rows. Collapse some nodes or use search to reach the rest.`; }
      if (m.nestedFailed) flash('This string is not valid JSON', true);
      if (m.hit !== undefined) { S.hit = m.hit; S.hits = m.hits; hitText.textContent = hitLabel(); }
      if (m.focus !== undefined && m.focus >= 0) {
        const id = m.id || (S.sel && S.sel.id);
        S.sel = { row: m.focus, id };
        if (m.id) post({ type: 'select', target: { id: m.id } });
        if (S.mode !== 'tree' && m.hit !== undefined) setMode('tree');
        scrollToRow(m.focus);
      }
      render();
      break;
    case 'found':
      S.hits = m.count; S.hitsCapped = m.capped; S.hit = m.count ? 0 : -1;
      hitText.textContent = hitLabel();
      hitText.title = `Searched in ${fmtMs(m.ms)}`;
      break;
    case 'detail':
      setDetail(m.detail);
      break;
    case 'tableInit':
      if (!m.ok) { flash('This node is not an array of objects', true); return; }
      S.table = { id: m.id, path: m.path, count: m.count, columns: m.columns, tv: (S.table ? S.table.tv : 0) + 1, cache: new Map(), pending: new Set(), sort: null };
      S.table.rows0 = m.rows;
      m.rows.forEach((r, i) => S.table.cache.set(i, r));
      tableTitle.textContent = `${m.path} · ${fmtN(m.count)} rows · ${fmtN(m.columns.length)} columns${m.moreColumns ? ' (first 200 shown)' : ''}`;
      tabTable.disabled = false;
      buildHead();
      grid.scrollTop = 0;
      setMode('table');
      grid.focus();
      break;
    case 'tableRows': {
      const t = S.table;
      if (!t || m.tv !== t.tv) return;
      t.pending.delete(Math.floor(m.start / PAGE));
      m.rows.forEach((r, i) => t.cache.set(m.start + i, r));
      renderTable();
      break;
    }
    case 'tableSorted': {
      const t = S.table;
      if (!t) return;
      t.tv++; t.cache.clear(); t.pending.clear();
      t.sort = m.dir ? { col: m.col, dir: m.dir } : null;
      m.rows.forEach((r, i) => t.cache.set(i, r));
      buildHead();
      renderTable();
      break;
    }
    case 'toast':
      flash(m.text, m.error);
      break;
    case 'error':
      flash(m.message, true);
      break;
  }
});

post({ type: 'ready' });
