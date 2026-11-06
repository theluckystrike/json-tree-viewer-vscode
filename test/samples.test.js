'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { makeSamples } = require('../scripts/make-samples');
const { createSession } = require('../src/core/session');
const { tmpDir, removeTmp } = require('./helpers');

let dir;
test.before(() => { dir = tmpDir('samples'); });
test.after(() => removeTmp(dir));

function open(name) {
  const out = [];
  const s = createSession({ post: m => out.push(m) });
  s.handle({ type: 'load', path: path.join(dir, name), ext: path.extname(name) });
  return { init: out[0], s, out };
}

test('samples: all generated, each under 5 MB', () => {
  const sizes = makeSamples(dir);
  assert.equal(Object.keys(sizes).length, 10);
  for (const [n, s] of Object.entries(sizes)) assert.ok(s < 5 * 1024 * 1024, `${n} is ${s} bytes`);
});

test('samples: each opens with the expected mode and shape', () => {
  const expect = {
    'config-nested.json': ['json', 'object'], 'users-50k.json': ['json', 'array'], 'weather-stations.geojson': ['json', 'object'],
    'shop-session.har': ['json', 'object'], 'escaped-json.json': ['json', 'object'], 'settings.jsonc': ['jsonc', 'object'],
    'app.json5': ['json5', 'object'], 'analysis.ipynb': ['json', 'object'], 'site.webmanifest': ['json', 'object'],
  };
  for (const [name, [mode, t]] of Object.entries(expect)) {
    const { init } = open(name);
    assert.equal(init.ok, true, name);
    assert.equal(init.mode, mode, name);
    assert.equal(init.rootType, t, name);
  }
  const users = open('users-50k.json').init;
  assert.equal(users.rootCount, 50000);
  assert.equal(users.level, 1, 'big array starts at level 1');
  assert.equal(users.total, 50001);
  assert.ok(users.rootTable > 0, 'root array of objects offers the table');
});

test('samples: the invalid file names line and column', () => {
  const { init } = open('broken.json');
  assert.equal(init.ok, false);
  assert.equal(init.kind, 'parse');
  assert.equal(init.line, 5);
  assert.equal(init.col, 15);
  assert.match(init.snippet, /\{ "id": 2 "ok": false \}/);
});

test('samples: the 50,000-row table sorts by score', () => {
  const { s, out, init } = open('users-50k.json');
  s.handle({ type: 'table', id: init.rootTable });
  const t = out.find(m => m.type === 'tableInit');
  assert.deepEqual(t.columns.map(c => c.name), ['id', 'name', 'age', 'city', 'active', 'score', 'note']);
  s.handle({ type: 'tableSort', col: 5, dir: 'desc' });
  const sorted = out.find(m => m.type === 'tableSorted');
  const scores = sorted.rows.slice(0, 20).map(r => Number(r.cells[5].s));
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test('samples: escaped JSON payloads open as trees, twice nested', () => {
  const { s } = open('escaped-json.json');
  const m = s.model;
  m.setLevel(3);
  const payload = m.rows.find(n => n.key === 'payload');
  assert.equal(m.rowOut(payload).js, 1);
  m.openNested(payload.id);
  const meta = m.rows.find(n => n.key === 'meta');
  assert.equal(m.rowOut(meta).js, 1, 'a JSON string inside the nested JSON');
  m.openNested(meta.id);
  const ab = m.rows.find(n => n.key === 'ab');
  assert.equal(m.detail({ id: ab.id }).jsPath, 'JSON.parse(JSON.parse(data.events[0].payload).meta).ab');
  const plain = m.rows.filter(n => n.key === 'payload')[2];
  assert.equal(m.rowOut(plain).js, undefined);
});

test('samples: HAR response bodies are escaped JSON too', () => {
  const { s } = open('shop-session.har');
  const m = s.model;
  m.search('SKU-1017');
  const h = m.gotoHit(0);
  const node = m.rows[h.row];
  assert.equal(node.key, 'text');
  assert.equal(m.detail({ id: node.id }).jsonPath, '$.log.entries[17].response.content.text');
  assert.equal(m.rowOut(node).js, 1);
});

test('samples: detail offers "Open JSON string" right after a search jump, before the row is drawn', () => {
  const { s } = open('shop-session.har');
  const m = s.model;
  m.search('SKU-1017');
  const h = m.gotoHit(0);
  assert.equal(m.rows[h.row].jsonOk, undefined, 'row not drawn yet');
  assert.equal(m.detail({ id: h.id }).js, 1);
});
