'use strict';
// Exact big numbers, Go to line and reload on file change (0.2.0).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { BigNum, canon, lossy, maybeBig, canKeepExact } = require('../src/core/bignum');
const { parseText } = require('../src/core/parse');
const { TreeModel } = require('../src/core/model');
const { locate } = require('../src/core/locate');
const { NESTED } = require('../src/core/paths');
const { createSession } = require('../src/core/session');
const { createHost, cleanMessage } = require('../src/core/host');
const { tmpDir, removeTmp } = require('./helpers');

// ---------- big numbers ----------
test('bignum: canon and lossy tell rounded numbers from exact ones', () => {
  assert.equal(canon('1.50e2'), '15e1');
  assert.equal(canon('150'), '15e1');
  assert.equal(canon('-0.0012'), '-12e-4');
  assert.equal(lossy(12345678901234567891, '12345678901234567891'), true);
  assert.equal(lossy(9007199254740991, '9007199254740991'), false);
  assert.equal(lossy(1e21, '1000000000000000000000'), false);
  assert.equal(lossy(0.1, '0.1'), false);
  assert.equal(lossy(1.5, '1.50'), false);
  assert.equal(lossy(0.30000000000000004, '0.300000000000000044408920985006'), true);
  assert.equal(lossy(Infinity, '1e400'), true);
  assert.equal(maybeBig('{"a": 12}'), false);
  assert.equal(maybeBig('{"id": 12345678901234567891}'), true);
});

test('bignum: 64-bit IDs are kept digit for digit, small numbers stay plain numbers', { skip: !canKeepExact() && 'engine without reviver source' }, () => {
  const text = '{"id": 12345678901234567891, "n": 42, "f": 0.5, "list": [9223372036854775807, 1], "s": "12345678901234567891"}';
  const r = parseText(text, '.json');
  assert.equal(r.big, 2);
  assert.ok(r.value.id instanceof BigNum);
  assert.equal(String(r.value.id), '12345678901234567891');
  assert.equal(r.value.n, 42);
  assert.equal(r.value.f, 0.5);
  assert.equal(String(r.value.list[0]), '9223372036854775807');
  assert.equal(r.value.s, '12345678901234567891');
  const m = new TreeModel(r.value);
  m.setLevel(2);
  const row = m.rowsOut(0, 10).find(x => x.k === 'id');
  assert.equal(row.t, 'number');
  assert.equal(row.pv, '12345678901234567891');
  assert.equal(row.big, 1);
  assert.equal(m.rowsOut(0, 10).find(x => x.k === 'n').big, undefined);
  // copy value of the number and of its parent keep the digits
  const idNode = m.rows.find(n => n.key === 'id');
  assert.equal(m.valueText({ id: idNode.id }).text, '12345678901234567891');
  if (typeof JSON.rawJSON === 'function') assert.match(m.valueText({ id: m.root.id }).text, /"id": 12345678901234567891,/);
  // search finds the exact digits
  assert.equal(m.search('4567891'), 2); // the number and the string
  assert.equal(m.detail({ id: idNode.id }).big, 1);
});

test('bignum: JSONC files keep big numbers too, and the table shows the exact value', { skip: !canKeepExact() && 'engine without reviver source' }, () => {
  const text = '// ids\n[{"id": 18446744073709551615, "name": "a"}, {"id": 2, "name": "b"},]';
  const r = parseText(text, '.jsonc');
  assert.equal(r.mode, 'jsonc');
  assert.equal(r.big, 1);
  const m = new TreeModel(r.value);
  const info = m.tableOpen(m.root.id);
  assert.ok(info);
  m.tableSort(0, 'desc');
  const rows = m.tableRowsOut(0, 5);
  assert.equal(rows[0].cells[0].s, '18446744073709551615');
  assert.equal(rows[0].cells[0].big, 1);
});

test('bignum: a plain file takes no second pass', () => {
  const r = parseText('{"a": [1, 2, 3], "b": "x"}', '.json');
  assert.equal(r.big, 0);
  assert.deepEqual(r.value, { a: [1, 2, 3], b: 'x' });
});

// ---------- locate (Go to line) ----------
const DOC = [
  '{',
  '  "name": "svc",',
  '  "server": {',
  '    "host": "0.0.0.0",',
  '    "ports": [80, 443,',
  '      8443]',
  '  },',
  '  "events": [{"payload": "{\\"user\\": {\\"id\\": 7}}"}],',
  '  "dup": 1,',
  '  "dup": 2,',
  '  "odd \\"key\\"": true',
  '}',
].join('\n');

test('locate: keys, array items, nested escaped JSON, duplicate keys and quoted keys', () => {
  assert.deepEqual(pick(locate(DOC, [])), { line: 1, col: 1 });
  assert.deepEqual(pick(locate(DOC, ['name'])), { line: 2, col: 3 });
  assert.deepEqual(pick(locate(DOC, ['server', 'host'])), { line: 4, col: 5 });
  assert.deepEqual(pick(locate(DOC, ['server', 'ports', 2])), { line: 6, col: 7 });
  assert.deepEqual(pick(locate(DOC, ['events', 0, 'payload', NESTED, 'user', 'id'])), { line: 8, col: 15 });
  assert.deepEqual(pick(locate(DOC, ['dup'])), { line: 10, col: 3 }); // JSON.parse keeps the last one
  assert.deepEqual(pick(locate(DOC, ['odd "key"'])), { line: 11, col: 3 });
  assert.equal(locate(DOC, ['missing']), null);
  assert.equal(locate(DOC, ['server', 'ports', 9]), null);
  assert.equal(locate(DOC, ['name', 'x']), null);
});
function pick(p) { return p && { line: p.line, col: p.col }; }

test('session: locate answers with line and column, also for JSONC and table cells', () => {
  const d = tmpDir('locate');
  try {
    const f = path.join(d, 'a.jsonc');
    fs.writeFileSync(f, '{\n  // comment with "quotes" and {braces}\n  "rows": [\n    {"id": 1},\n    {"id": 2, "tag": "x"}\n  ],\n}\n');
    const out = [];
    const s = createSession({ post: m => out.push(m) });
    s.handle({ type: 'load', path: f, ext: '.jsonc' });
    assert.equal(out[0].ok, true);
    assert.equal(out[0].mode, 'jsonc');
    const rows = s.model.rows.find(n => n.key === 'rows');
    s.handle({ type: 'locate', target: { id: rows.id } });
    assert.deepEqual(pick(out.at(-1)), { line: 3, col: 3 });
    s.handle({ type: 'table', id: rows.id });
    s.handle({ type: 'locate', target: { cell: { r: 1, c: 1 } } });
    const l = out.at(-1);
    assert.equal(l.type, 'located');
    assert.deepEqual(pick(l), { line: 5, col: 15 });
    assert.equal(l.path, '$.rows[1].tag');
  } finally { removeTmp(d); }
});

test('session: Go to line explains why it cannot work for JSON5', () => {
  const out = [];
  const s = createSession({ post: m => out.push(m) });
  s.handle({ type: 'load', text: "{a: 1, b: 'two'}", ext: '.json5' });
  assert.equal(out[0].mode, 'json5');
  s.handle({ type: 'locate', target: { id: s.model.root.id } });
  assert.equal(out.at(-1).ok, false);
  assert.match(out.at(-1).message, /JSON5/);
});

// ---------- reload ----------
test('session: reload keeps open nodes, the selection, the search and the table', () => {
  const d = tmpDir('reload');
  try {
    const f = path.join(d, 'a.json');
    const v1 = { cfg: { a: { deep: { x: 1 } }, b: 2 }, users: [{ id: 1, n: 'ada' }, { id: 2, n: 'bob' }] };
    fs.writeFileSync(f, JSON.stringify(v1));
    const out = [];
    const s = createSession({ post: m => out.push(m) });
    s.handle({ type: 'load', path: f, ext: '.json' });
    const m1 = s.model;
    const a = m1.rows.find(n => n.key === 'a');
    m1.toggle(a.id, true);
    const deep = m1.rows.find(n => n.key === 'deep');
    m1.toggle(deep.id, true);
    const x = m1.rows.find(n => n.key === 'x');
    s.handle({ type: 'search', q: 'bob' });
    const users = m1.rows.find(n => n.key === 'users');
    s.handle({ type: 'table', id: users.id });
    // the file changes: a new user and a changed value
    fs.writeFileSync(f, JSON.stringify({ ...v1, cfg: { a: { deep: { x: 99 } }, b: 2 }, users: [...v1.users, { id: 3, n: 'bob jr' }] }));
    out.length = 0;
    s.handle({ type: 'reload', path: f, ext: '.json', sel: { id: x.id }, top: 0 });
    const init = out.find(m => m.type === 'init');
    assert.equal(init.ok, true);
    assert.equal(init.reloaded, true);
    const m2 = s.model;
    assert.notEqual(m2, m1);
    const x2 = m2.node(init.sel.id);
    assert.equal(x2.key, 'x');
    assert.equal(x2.value, 99);
    assert.equal(m2.rows[init.sel.row], x2);
    assert.ok(m2.rows.some(n => n.key === 'deep' && n.open));
    assert.ok(init.tableId);
    assert.equal(m2.table.arr.length, 3);
    const found = out.find(m => m.type === 'found');
    assert.equal(found.count, 2);
  } finally { removeTmp(d); }
});

test('session: a reload with broken JSON keeps the last good version on screen', () => {
  const d = tmpDir('reload-bad');
  try {
    const f = path.join(d, 'a.json');
    fs.writeFileSync(f, '{"a": 1}');
    const out = [];
    const s = createSession({ post: m => out.push(m) });
    s.handle({ type: 'load', path: f, ext: '.json' });
    const m1 = s.model;
    fs.writeFileSync(f, '{"a": 1,');
    s.handle({ type: 'reload', path: f, ext: '.json' });
    assert.equal(s.model, m1);
    const t = out.at(-1);
    assert.equal(t.type, 'toast');
    assert.equal(t.error, true);
    assert.match(t.text, /last good version/);
    assert.ok(!out.some(m => m.type === 'init' && m.ok === false));
  } finally { removeTmp(d); }
});

// ---------- host ----------
function fakeWorker() {
  const w = { sent: [], handlers: {} };
  w.postMessage = m => w.sent.push(m);
  w.on = (ev, fn) => { w.handlers[ev] = fn; };
  w.terminate = () => {};
  w.emit = m => w.handlers.message(m);
  return w;
}
const tick = () => new Promise(r => setImmediate(r));

test('host: fileChanged asks the webview, reload goes to the same worker, located opens the editor', async () => {
  const posted = [];
  const revealed = [];
  const w = fakeWorker();
  let spawned = 0;
  let size = 100;
  const host = createHost({
    source: { path: '/x/a.json', name: 'a.json', ext: '.json' },
    statSize: async () => size,
    spawnWorker: () => { spawned++; return w; },
    post: m => posted.push(m),
    copy: async () => {},
    reveal: async p => { revealed.push(p); },
  });
  await host.handle({ type: 'ready' });
  host.fileChanged();
  assert.deepEqual(posted.at(-1), { type: 'fileChanged' });
  await host.handle({ type: 'reload', sel: { id: 5 }, top: 12, junk: 'x' });
  await tick();
  assert.equal(spawned, 1);
  const r = w.sent.at(-1);
  assert.equal(r.type, 'reload');
  assert.equal(r.path, '/x/a.json');
  assert.deepEqual(r.sel, { id: 5 });
  assert.equal(r.top, 12);
  // too big after the change: a toast, no reload
  size = 500 * 1024 * 1024;
  const before = w.sent.length;
  await host.handle({ type: 'reload', sel: null, top: 0 });
  await tick();
  assert.equal(w.sent.length, before);
  assert.match(posted.at(-1).text, /size limit/);
  // Go to line
  await host.handle({ type: 'locate', target: { id: 3 } });
  assert.deepEqual(w.sent.at(-1), { type: 'locate', target: { id: 3 } });
  w.emit({ type: 'located', ok: true, line: 12, col: 5 });
  await tick();
  assert.deepEqual(revealed, [{ line: 12, col: 5 }]);
  assert.equal(posted.at(-1).text, 'Line 12, column 5');
  w.emit({ type: 'located', ok: false, message: 'nope' });
  assert.equal(posted.at(-1).error, true);
});

test('host: cleanMessage keeps only the fields of locate and reload', () => {
  assert.deepEqual(cleanMessage({ type: 'locate', target: { id: '4', x: 1 } }), { type: 'locate', target: { id: 0 } });
  assert.deepEqual(cleanMessage({ type: 'locate', target: { cell: { r: 2, c: 1 } } }), { type: 'locate', target: { cell: { r: 2, c: 1 } } });
  assert.deepEqual(cleanMessage({ type: 'reload', sel: { id: 9, evil: 1 }, top: -5 }), { type: 'reload', sel: { id: 9 }, top: 0 });
  assert.deepEqual(cleanMessage({ type: 'reload' }), { type: 'reload', sel: null, top: 0 });
});

test('host: a selection or clipboard view never reloads', async () => {
  const posted = [];
  const host = createHost({ source: { text: '{"a":1}', name: 'Selection', ext: '.json' }, statSize: async () => 0, spawnWorker: () => fakeWorker(), post: m => posted.push(m), copy: async () => {} });
  host.fileChanged();
  assert.equal(posted.length, 0);
});

test('package: autoReload setting and Go to line are documented', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.contributes.configuration.properties['jsonTreeViewer.autoReload'].default, true);
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /Go to line/);
  assert.match(readme, /64-bit/);
  assert.match(readme, /autoReload/);
});
