'use strict';
// The tree behind the viewer. It runs in the worker thread: the webview only ever asks for a window of rows,
// so a file with millions of values never builds millions of DOM nodes.
// Nodes are made lazily, the first time their parent is opened.

const { NESTED, isNested, jsonPath, jsPath } = require('./paths');
const { isBig } = require('./bignum');

const MAX_ROWS = 1000000; // visible rows after "Expand all"; more is capped with a message
const MAX_HITS = 10000;
const MAX_COLUMNS = 200;
const MAX_NESTED_CHARS = 10 * 1024 * 1024;
const MAX_COPY_CHARS = 50 * 1024 * 1024;
const STR_PREVIEW = 400;

const isBox = v => v !== null && typeof v === 'object' && !isBig(v);
const isPlain = v => isBox(v) && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (isBig(v)) return 'number';
  const t = typeof v;
  return t === 'object' ? 'object' : t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : t === 'string' ? 'string' : 'null';
}

function count(v) { return Array.isArray(v) ? v.length : Object.keys(v).length; }

function scalarText(v) {
  if (typeof v === 'string') return v.length > STR_PREVIEW ? JSON.stringify(v.slice(0, STR_PREVIEW)).slice(0, -1) + '…"' : JSON.stringify(v);
  return String(v);
}

/** One-line preview like {id: 1, name: "Ada", tags: […]} cut at about `budget` characters. */
function preview(v, budget = 120) {
  if (!isBox(v)) return scalarText(v).slice(0, budget + 2);
  const arr = Array.isArray(v);
  const keys = arr ? null : Object.keys(v);
  const n = arr ? v.length : keys.length;
  let s = arr ? '[' : '{';
  for (let i = 0; i < n; i++) {
    const k = arr ? i : keys[i];
    const x = v[k];
    let part = isBox(x) ? (Array.isArray(x) ? (x.length ? '[…]' : '[]') : (Object.keys(x).length ? '{…}' : '{}')) : scalarText(x);
    if (part.length > 40) part = part.slice(0, 39) + '…' + (typeof x === 'string' ? '"' : '');
    const item = arr ? part : `${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k)}: ${part}`;
    if (s.length + item.length > budget) { s += (i ? ', ' : '') + '…'; return s + (arr ? ']' : '}'); }
    s += (i ? ', ' : '') + item;
  }
  return s + (arr ? ']' : '}');
}

// Sort helpers adapted from table-viewer-vscode (src/core/table.js): nulls last, numbers before text.
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
function sortKey(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isBig(v)) return Number(v.src);
  return preview(v, 60);
}
function compareKeys(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const ta = typeof a, tb = typeof b;
  if (ta === 'string' && tb === 'string') return collator.compare(a, b);
  if (ta === tb) return a < b ? -1 : a > b ? 1 : 0;
  return ta === 'string' ? 1 : -1;
}

/** True for an array whose first 50 items are all plain objects (nulls allowed), with at least one object. */
function isTableArray(v) {
  if (!Array.isArray(v) || v.length === 0) return false;
  let objects = 0;
  const n = Math.min(v.length, 50);
  for (let i = 0; i < n; i++) {
    const x = v[i];
    if (x === null) continue;
    if (!isPlain(x)) return false;
    objects++;
  }
  return objects > 0;
}

/** Parsed value if a string holds a JSON object or array, else undefined. */
function nestedJson(s) {
  if (typeof s !== 'string' || s.length < 2 || s.length > MAX_NESTED_CHARS) return undefined;
  let a = 0, b = s.length - 1;
  while (a < b && s.charCodeAt(a) <= 32) a++;
  while (b > a && s.charCodeAt(b) <= 32) b--;
  const f = s[a], l = s[b];
  if (!((f === '{' && l === '}') || (f === '[' && l === ']'))) return undefined;
  try { const v = JSON.parse(s); return isBox(v) ? v : undefined; } catch { return undefined; }
}

class TreeModel {
  constructor(value, opts = {}) {
    this.maxRows = opts.maxRows || MAX_ROWS;
    this.maxHits = opts.maxHits || MAX_HITS;
    this.nextId = 1;
    this.byId = new Map();
    this.root = this.make(null, null, value, 0);
    this.rows = [this.root];
    this.capped = false;
    this.query = '';
    this.hits = [];
    this.hitsCapped = false;
    this.table = null;
    this.v = 1; // bumps on every change of the row list
  }

  make(parent, key, value, depth) {
    const n = { id: this.nextId++, parent, key, value, depth, open: false, kids: null, json: undefined, jsonOk: undefined };
    this.byId.set(n.id, n);
    return n;
  }

  node(id) { return this.byId.get(Number(id)); }
  inner(n) { return n.json !== undefined ? n.json : n.value; }
  expandable(n) { return isBox(this.inner(n)); }

  children(n) {
    if (!n.kids) {
      const v = this.inner(n);
      const d = n.depth + 1;
      if (Array.isArray(v)) { n.kids = new Array(v.length); for (let i = 0; i < v.length; i++) n.kids[i] = this.make(n, i, v[i], d); }
      else if (isBox(v)) n.kids = Object.keys(v).map(k => this.make(n, k, v[k], d));
      else n.kids = [];
    }
    return n.kids;
  }

  /** Visible descendants of n (not n itself), in display order. Returns false when cap was reached. */
  collect(n, out, cap) {
    const stack = [[this.children(n), 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top[1] >= top[0].length) { stack.pop(); continue; }
      const k = top[0][top[1]++];
      out.push(k);
      if (out.length >= cap) return false;
      if (k.open && this.expandable(k)) stack.push([this.children(k), 0]);
    }
    return true;
  }

  rowIndex(n, hint) {
    if (hint !== undefined && this.rows[hint] === n) return hint;
    return this.rows.indexOf(n);
  }

  /** Opens or closes one node. Returns the new row count. */
  toggle(id, want, hint) {
    const n = this.node(id);
    if (!n || !this.expandable(n)) return this.rows.length;
    const open = want === undefined ? !n.open : !!want;
    if (open === n.open) return this.rows.length;
    n.open = open;
    const idx = this.rowIndex(n, hint);
    if (idx < 0) return this.rows.length; // hidden under a closed parent: only the flag changes
    if (open) {
      const sub = [];
      const room = Math.max(1, this.maxRows - this.rows.length);
      if (!this.collect(n, sub, room)) this.capped = true;
      this.rows = this.rows.slice(0, idx + 1).concat(sub, this.rows.slice(idx + 1));
    } else {
      let j = idx + 1;
      while (j < this.rows.length && this.rows[j].depth > n.depth) j++;
      this.rows = this.rows.slice(0, idx + 1).concat(this.rows.slice(j));
    }
    this.v++;
    return this.rows.length;
  }

  /** Shows levels 0..level-1 opened (level 1 = the top keys). Infinity opens everything up to maxRows rows. */
  setLevel(level) {
    for (const n of this.byId.values()) n.open = false;
    const rows = [];
    this.capped = false;
    const stack = [this.root];
    while (stack.length) {
      const n = stack.pop();
      rows.push(n);
      if (n.depth < level && this.expandable(n)) {
        if (rows.length >= this.maxRows) { this.capped = true; continue; }
        n.open = true;
        const kids = this.children(n);
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      }
    }
    if (rows.length > this.maxRows) { rows.length = this.maxRows; this.capped = true; }
    this.rows = rows;
    this.v++;
    return rows.length;
  }

  /** Paths (segment lists) of the open nodes in view, for keeping the tree as it was after a reload. */
  openPaths(max = 20000) {
    const out = [];
    for (const n of this.rows) {
      if (n.open && n.parent) { out.push(this.segsOf(n)); if (out.length >= max) break; }
    }
    return out;
  }

  /** Walks to segs, opening every node on the way (and escaped JSON strings). Returns the node, or null. */
  openSegs(segs, openLast = true) {
    let n = this.root;
    if (this.expandable(n)) n.open = true;
    for (const seg of segs) {
      if (isNested(seg)) {
        if (typeof n.value !== 'string') return null;
        if (n.json === undefined) {
          const p = nestedJson(n.value);
          if (p === undefined) return null;
          n.json = p; n.kids = null;
        }
        n.open = true;
        continue;
      }
      if (!this.expandable(n)) return null;
      n.open = true;
      const kids = this.children(n);
      const next = Array.isArray(this.inner(n)) ? kids[seg] : kids.find(k => k.key === seg);
      if (!next) return null;
      n = next;
    }
    if (openLast && this.expandable(n)) n.open = true;
    return n;
  }

  /** Rebuilds the row list from the open flags. */
  rebuildRows() {
    const rows = [this.root];
    this.capped = false;
    if (this.root.open && this.expandable(this.root) && !this.collect(this.root, rows, this.maxRows)) this.capped = true;
    this.rows = rows;
    this.v++;
    return rows.length;
  }

  /** Opens a string that holds escaped JSON as a nested tree. */
  openNested(id, hint) {
    const n = this.node(id);
    if (!n || typeof n.value !== 'string') return false;
    if (n.json === undefined) {
      const parsed = nestedJson(n.value);
      if (parsed === undefined) { n.jsonOk = false; return false; }
      n.json = parsed;
      n.kids = null;
      n.open = false;
    }
    this.toggle(n.id, true, hint);
    return true;
  }

  matches(n) {
    const q = this.query;
    if (!q) return false;
    if (typeof n.key === 'string' && n.key.toLowerCase().includes(q)) return true;
    return !isBox(n.value) && String(n.value).toLowerCase().includes(q);
  }

  rowOut(n) {
    const v = this.inner(n);
    const t = typeOf(v);
    const r = { id: n.id, d: n.depth, k: n.key, t, o: n.open ? 1 : 0 };
    if (isBox(v)) {
      r.n = count(v);
      if (!n.open) r.pv = preview(v);
      if (t === 'array' && isTableArray(v)) r.tab = 1;
    } else {
      r.pv = scalarText(v);
      if (isBig(v)) r.big = 1;
      if (t === 'string') {
        if (v.length > STR_PREVIEW) r.len = v.length;
        if (n.jsonOk === undefined) n.jsonOk = nestedJson(v) !== undefined;
        if (n.jsonOk) r.js = 1;
      }
    }
    if (n.json !== undefined) r.js = 2;
    if (this.matches(n)) r.m = 1;
    return r;
  }

  rowsOut(start, cnt) {
    const s = Math.max(0, start | 0);
    const e = Math.min(this.rows.length, s + Math.max(0, Math.min(cnt | 0, 2000)));
    const out = [];
    for (let i = s; i < e; i++) out.push(this.rowOut(this.rows[i]));
    return out;
  }

  segsOf(n) {
    const chain = [];
    for (let x = n; x && x.parent; x = x.parent) chain.push(x);
    const segs = [];
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].parent.json !== undefined) segs.push(NESTED);
      segs.push(chain[i].key);
    }
    return segs;
  }

  /** Finds keys and values that contain q (case-insensitive) in the whole document. */
  search(q) {
    this.query = String(q || '').toLowerCase();
    this.hits = [];
    this.hitsCapped = false;
    this.v++;
    const query = this.query;
    if (!query) return 0;
    const rootV = this.root.value;
    if (!isBox(rootV)) {
      if (String(rootV).toLowerCase().includes(query)) this.hits.push([]);
      return this.hits.length;
    }
    const frame = v => (Array.isArray(v) ? { v, keys: null, i: 0, n: v.length } : { v, keys: Object.keys(v), i: 0, n: 0 });
    const path = [];
    const frames = [frame(rootV)];
    if (frames[0].keys) frames[0].n = frames[0].keys.length;
    while (frames.length) {
      const f = frames[frames.length - 1];
      if (f.i >= f.n) { frames.pop(); if (frames.length) path.pop(); continue; }
      const idx = f.i++;
      const key = f.keys ? f.keys[idx] : idx;
      const child = f.v[key];
      const hit = (f.keys && key.toLowerCase().includes(query)) || (!isBox(child) && String(child).toLowerCase().includes(query));
      if (hit) {
        this.hits.push(path.concat([key]));
        if (this.hits.length >= this.maxHits) { this.hitsCapped = true; break; }
      }
      if (isBox(child)) {
        path.push(key);
        const nf = frame(child);
        if (nf.keys) nf.n = nf.keys.length;
        frames.push(nf);
      }
    }
    return this.hits.length;
  }

  /** Opens the parents of the node at segs and returns {row, id}. */
  reveal(segs) {
    let n = this.root;
    for (const seg of segs) {
      if (!n.open) this.toggle(n.id, true);
      const kids = this.children(n);
      const v = this.inner(n);
      const next = Array.isArray(v) ? kids[seg] : kids.find(k => k.key === seg);
      if (!next) break;
      n = next;
    }
    return { row: this.rowIndex(n), id: n.id };
  }

  gotoHit(index) {
    if (!this.hits.length) return null;
    const i = ((index % this.hits.length) + this.hits.length) % this.hits.length;
    return { index: i, ...this.reveal(this.hits[i]) };
  }

  // ---------- table view of an array of objects ----------
  tableOpen(id) {
    const n = this.node(id);
    if (!n) return null;
    const arr = this.inner(n);
    if (!isTableArray(arr)) return null;
    const cols = new Map();
    let more = false;
    for (let i = 0; i < arr.length; i++) {
      const el = arr[i];
      if (!isPlain(el)) continue;
      for (const k of Object.keys(el)) {
        let c = cols.get(k);
        if (!c) {
          if (cols.size >= MAX_COLUMNS) { more = true; continue; }
          c = { name: k, types: {} };
          cols.set(k, c);
        }
        const t = typeOf(el[k]);
        c.types[t] = (c.types[t] || 0) + 1;
      }
    }
    const columns = [...cols.values()].map(c => {
      const ts = Object.keys(c.types).filter(t => t !== 'null');
      return { name: c.name, type: ts.length === 1 ? ts[0] : ts.length === 0 ? 'null' : 'mixed' };
    });
    this.table = { node: n, arr, columns, order: null, sort: null };
    return { id: n.id, path: jsonPath(this.segsOf(n)), count: arr.length, columns, moreColumns: more };
  }

  tableSort(col, dir) {
    const t = this.table;
    if (!t) return false;
    if (!dir || col < 0 || col >= t.columns.length) { t.order = null; t.sort = null; return true; }
    const name = t.columns[col].name;
    const n = t.arr.length;
    const keys = new Array(n);
    for (let i = 0; i < n; i++) { const el = t.arr[i]; keys[i] = sortKey(isPlain(el) && has(el, name) ? el[name] : null); }
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const sign = dir === 'desc' ? -1 : 1;
    order.sort((a, b) => {
      const ka = keys[a], kb = keys[b];
      if (ka === null || kb === null) return ka === kb ? a - b : ka === null ? 1 : -1;
      return compareKeys(ka, kb) * sign || a - b;
    });
    t.order = order;
    t.sort = { col, dir };
    return true;
  }

  tableRowsOut(start, cnt) {
    const t = this.table;
    if (!t) return [];
    const n = t.arr.length;
    const s = Math.max(0, start | 0);
    const e = Math.min(n, s + Math.max(0, Math.min(cnt | 0, 1000)));
    const out = [];
    for (let r = s; r < e; r++) {
      const i = t.order ? t.order[r] : r;
      const el = t.arr[i];
      const cells = t.columns.map(c => {
        if (!isPlain(el) || !has(el, c.name)) return { t: 'missing' };
        const v = el[c.name];
        const ty = typeOf(v);
        return { t: ty, big: isBig(v) ? 1 : undefined, s: isBox(v) ? preview(v, 80) : typeof v === 'string' ? (v.length > 300 ? v.slice(0, 300) + '…' : v) : String(v) };
      });
      out.push({ i, cells });
    }
    return out;
  }

  // ---------- targets: a tree node {id} or a table cell {cell: {r, c}} ----------
  resolve(target) {
    if (!target) return null;
    if (target.cell && this.table) {
      const t = this.table;
      const r = target.cell.r | 0, c = target.cell.c | 0;
      if (r < 0 || r >= t.arr.length) return null;
      const i = t.order ? t.order[r] : r;
      const el = t.arr[i];
      const segs = this.segsOf(t.node).concat([i]);
      if (c >= 0 && c < t.columns.length) {
        const name = t.columns[c].name;
        segs.push(name);
        return { segs, value: isPlain(el) && has(el, name) ? el[name] : undefined };
      }
      return { segs, value: el };
    }
    const n = this.node(target.id);
    if (!n) return null;
    return { segs: this.segsOf(n), value: n.value, node: n };
  }

  detail(target) {
    const x = this.resolve(target);
    if (!x) return null;
    const v = x.value;
    const out = { jsonPath: jsonPath(x.segs), jsPath: jsPath(x.segs), t: v === undefined ? 'missing' : typeOf(v) };
    if (isBox(v)) out.n = count(v);
    if (typeof v === 'string') out.len = v.length;
    if (isBig(v)) out.big = 1;
    if (x.node) {
      const n = x.node;
      out.id = n.id;
      // The row may not have been drawn yet (for example right after a search jump), so check here too.
      if (n.jsonOk === undefined && typeof n.value === 'string') n.jsonOk = nestedJson(n.value) !== undefined;
      if (n.json !== undefined) out.js = 2; else if (n.jsonOk) out.js = 1;
    }
    out.tab = isTableArray(x.node ? this.inner(x.node) : v) ? 1 : 0;
    return out;
  }

  /** Text for "Copy value": strings as they are, everything else as formatted JSON. */
  valueText(target) {
    const x = this.resolve(target);
    if (!x || x.value === undefined) return { error: 'Nothing to copy here.' };
    const v = x.value;
    if (typeof v === 'string') return { text: v };
    const text = isBox(v) ? JSON.stringify(v, null, 2) : String(v);
    if (text.length > MAX_COPY_CHARS) return { error: `This value is ${Math.round(text.length / 1048576)} MB as text, too big for the clipboard.` };
    return { text };
  }
}

module.exports = { TreeModel, typeOf, preview, scalarText, isTableArray, nestedJson, sortKey, compareKeys, MAX_ROWS, MAX_HITS, MAX_COLUMNS };
