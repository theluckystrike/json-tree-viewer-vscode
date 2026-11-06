'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TreeModel, preview, isTableArray, nestedJson } = require('../src/core/model');

const doc = () => ({
  name: 'svc',
  server: { host: 'h', port: 80, tls: { on: true, ciphers: ['a', 'b'] } },
  items: [{ id: 3, name: 'b' }, { id: 1, name: 'a', extra: null }, { id: 2 }],
  payload: '{"user":{"id":42,"roles":["x"]}}',
  plain: 'not json {',
  'odd key': [1, [2, [3]]],
});

const keys = m => m.rowsOut(0, 1000).map(r => (r.k === null ? '$' : r.k));

test('model: level 1, 2, 3 and all', () => {
  const m = new TreeModel(doc());
  assert.equal(m.setLevel(0), 1);
  assert.equal(m.setLevel(1), 7);
  assert.deepEqual(keys(m), ['$', 'name', 'server', 'items', 'payload', 'plain', 'odd key']);
  assert.equal(m.setLevel(2), 7 + 3 + 3 + 2);
  const n3 = m.setLevel(3);
  assert.ok(n3 > 15);
  const all = m.setLevel(Infinity);
  assert.ok(all > n3);
  assert.equal(m.capped, false);
  assert.ok(keys(m).includes('ciphers'));
});

test('model: rows carry depth, type badge, child count and preview', () => {
  const m = new TreeModel(doc());
  m.setLevel(1);
  const rows = m.rowsOut(0, 10);
  assert.deepEqual([rows[0].t, rows[0].n, rows[0].d], ['object', 6, 0]);
  const server = rows.find(r => r.k === 'server');
  assert.equal(server.t, 'object');
  assert.equal(server.n, 3);
  assert.equal(server.d, 1);
  assert.equal(server.pv, '{host: "h", port: 80, tls: {…}}');
  const items = rows.find(r => r.k === 'items');
  assert.equal(items.tab, 1, 'array of objects can be a table');
  assert.equal(rows.find(r => r.k === 'name').pv, '"svc"');
  assert.equal(rows.find(r => r.k === 'payload').js, 1, 'escaped JSON detected');
  assert.equal(rows.find(r => r.k === 'plain').js, undefined);
});

test('model: toggle opens and closes one node in place', () => {
  const m = new TreeModel(doc());
  m.setLevel(1);
  const row = m.rows.findIndex(n => n.key === 'server');
  const id = m.rows[row].id;
  assert.equal(m.toggle(id, undefined, row), 10);
  assert.deepEqual(keys(m).slice(row, row + 4), ['server', 'host', 'port', 'tls']);
  const tls = m.rows.find(n => n.key === 'tls');
  m.toggle(tls.id);
  assert.equal(m.rows.length, 12);
  m.toggle(id); // close server: tls stays open inside, but hidden
  assert.equal(m.rows.length, 7);
  m.toggle(id);
  assert.equal(m.rows.length, 12, 'reopening restores the open child');
});

test('model: expand all is capped', () => {
  const big = Array.from({ length: 300 }, (_, i) => ({ i, v: [i, i] }));
  const m = new TreeModel(big, { maxRows: 500 });
  m.setLevel(Infinity);
  assert.equal(m.rows.length, 500);
  assert.equal(m.capped, true);
});

test('model: search keys and values, next and previous reveal the hit', () => {
  const m = new TreeModel(doc());
  m.setLevel(1);
  assert.equal(m.search('NAME'), 3, 'three keys called name, case-insensitive');
  const h0 = m.gotoHit(0);
  assert.equal(m.rows[h0.row].key, 'name');
  const h1 = m.gotoHit(1);
  assert.equal(m.rows[h1.row].key, 'name');
  assert.equal(m.rows[h1.row].parent.key, 0, 'opened items[0] to show the hit');
  const back = m.gotoHit(-1);
  assert.equal(back.index, 2, 'previous from the first wraps to the last');
  assert.equal(m.search('ciph'), 1);
  const c = m.gotoHit(0);
  assert.equal(m.rows[c.row].key, 'ciphers');
  assert.equal(m.search('80'), 1, 'numbers match as text');
  assert.equal(m.search('null'), 1, 'null matches');
  assert.equal(m.search('zzz'), 0);
  assert.equal(m.gotoHit(0), null);
  const rows = (m.search('host'), m.gotoHit(0), m.rowsOut(0, 100));
  assert.ok(rows.some(r => r.m === 1), 'matching rows are flagged');
});

test('model: search hit cap', () => {
  const m = new TreeModel(Array.from({ length: 50 }, () => 'x'), { maxHits: 10 });
  assert.equal(m.search('x'), 10);
  assert.equal(m.hitsCapped, true);
});

test('model: detail and copy for a node', () => {
  const m = new TreeModel(doc());
  m.setLevel(2);
  const id = m.rows.find(n => n.key === 'items').id;
  m.toggle(id, true);
  const first = m.rows.find(n => n.parent && n.parent.key === 'items' && n.key === 0);
  m.toggle(first.id, true);
  const idNode = m.rows.find(n => n.parent === first && n.key === 'id');
  const d = m.detail({ id: idNode.id });
  assert.equal(d.jsonPath, '$.items[0].id');
  assert.equal(d.jsPath, 'data.items[0].id');
  assert.equal(m.valueText({ id: idNode.id }).text, '3');
  assert.equal(m.valueText({ id: first.id }).text, '{\n  "id": 3,\n  "name": "b"\n}');
  const nameNode = m.rows.find(n => n.key === 'name' && n.parent === m.root);
  assert.equal(m.valueText({ id: nameNode.id }).text, 'svc', 'strings are copied without quotes');
  const odd = m.rows.find(n => n.key === 'odd key');
  assert.equal(m.detail({ id: odd.id }).jsonPath, "$['odd key']");
});

test('model: escaped JSON string opens as a nested tree with JSON.parse path', () => {
  const m = new TreeModel(doc());
  m.setLevel(1);
  const p = m.rows.find(n => n.key === 'payload');
  assert.equal(m.openNested(p.id), true);
  const user = m.rows.find(n => n.key === 'user');
  assert.ok(user);
  assert.equal(m.rowOut(p).js, 2);
  assert.equal(m.rowOut(p).t, 'object');
  m.toggle(user.id, true);
  const uid = m.rows.find(n => n.key === 'id' && n.parent === user);
  const d = m.detail({ id: uid.id });
  assert.equal(d.jsPath, 'JSON.parse(data.payload).user.id');
  assert.equal(d.jsonPath, '$.payload.user.id');
  assert.equal(m.valueText({ id: uid.id }).text, '42');
  const plain = m.rows.find(n => n.key === 'plain');
  assert.equal(m.openNested(plain.id), false, 'plain text stays a string');
});

test('model: table view of an array of objects, sort and cells', () => {
  const m = new TreeModel(doc());
  m.setLevel(1);
  const items = m.rows.find(n => n.key === 'items');
  const t = m.tableOpen(items.id);
  assert.equal(t.count, 3);
  assert.deepEqual(t.columns.map(c => c.name), ['id', 'name', 'extra']);
  assert.equal(t.columns[0].type, 'number');
  assert.equal(t.path, '$.items');
  let rows = m.tableRowsOut(0, 10);
  assert.deepEqual(rows.map(r => r.cells[0].s), ['3', '1', '2']);
  assert.equal(rows[2].cells[1].t, 'missing');
  assert.equal(rows[1].cells[2].t, 'null');
  m.tableSort(0, 'asc');
  rows = m.tableRowsOut(0, 10);
  assert.deepEqual(rows.map(r => r.i), [1, 2, 0]);
  m.tableSort(1, 'desc');
  rows = m.tableRowsOut(0, 10);
  assert.deepEqual(rows.map(r => r.cells[1].s || '-'), ['b', 'a', '-'], 'missing sorts last');
  const d = m.detail({ cell: { r: 0, c: 1 } });
  assert.equal(d.jsonPath, '$.items[0].name');
  assert.equal(m.valueText({ cell: { r: 1, c: 1 } }).text, 'a');
  assert.equal(m.valueText({ cell: { r: 2, c: 1 } }).error, 'Nothing to copy here.');
  m.tableSort(0, null);
  assert.deepEqual(m.tableRowsOut(0, 10).map(r => r.i), [0, 1, 2]);
  const name = m.rows.find(n => n.key === 'name');
  assert.equal(m.tableOpen(name.id), null);
});

test('model: helpers', () => {
  assert.equal(preview([1, 'a', { b: 1 }, []]), '[1, "a", {…}, []]');
  assert.equal(isTableArray([{ a: 1 }, null, { b: 2 }]), true);
  assert.equal(isTableArray([{ a: 1 }, 2]), false);
  assert.equal(isTableArray([]), false);
  assert.deepEqual(nestedJson('  [1, 2] '), [1, 2]);
  assert.equal(nestedJson('"x"'), undefined);
  assert.equal(nestedJson('{bad}'), undefined);
  const long = preview({ a: 'x'.repeat(500) });
  assert.ok(long.length < 130);
});

test('model: a scalar root shows one row', () => {
  const m = new TreeModel(42);
  assert.equal(m.setLevel(2), 1);
  assert.equal(m.rowOut(m.root).pv, '42');
  assert.equal(m.search('42'), 1);
});
