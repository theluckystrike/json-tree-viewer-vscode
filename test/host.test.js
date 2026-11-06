'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHost, cleanMessage, tooBigMessage, limitBytes, fmtSize } = require('../src/core/host');
const { realWorker } = require('./helpers');

const MB = 1024 * 1024;

function fakeWorker() {
  const w = { sent: [], handlers: {}, terminated: false };
  w.postMessage = m => w.sent.push(m);
  w.on = (ev, fn) => { w.handlers[ev] = fn; };
  w.terminate = () => { w.terminated = true; };
  w.emit = m => w.handlers.message(m);
  return w;
}

function setup(over = {}) {
  const posted = [], copied = [];
  let spawned = 0, rendered = 0, opened = 0;
  const w = fakeWorker();
  const host = createHost({
    source: { path: '/x/data.json', name: 'data.json', ext: '.json' },
    statSize: async () => 10 * MB,
    readBytes: async () => new Uint8Array([123, 125]),
    spawnWorker: () => { spawned++; return w; },
    post: m => posted.push(m),
    copy: async t => { copied.push(t); },
    openAsText: () => { opened++; },
    rendered: () => { rendered++; },
    ...over,
  });
  return { host, posted, copied, w, get spawned() { return spawned; }, get rendered() { return rendered; }, get opened() { return opened; } };
}
const tick = () => new Promise(r => setImmediate(r));

test('host: a file over 200 MB (mocked size) is not read and gets a clear message', async () => {
  let read = 0;
  const s = setup({ statSize: async () => 312 * MB, readBytes: async () => { read++; return new Uint8Array(); } });
  await s.host.handle({ type: 'ready' });
  assert.equal(s.spawned, 0, 'no worker');
  assert.equal(read, 0, 'no read');
  const m = s.posted.find(x => x.type === 'init');
  assert.equal(m.ok, false);
  assert.equal(m.kind, 'tooBig');
  assert.equal(m.message, 'This file is 312 MB. JSON Viewer opens files up to 200 MB so VS Code stays responsive. The file was not read. Open it as text, or raise the limit with the setting jsonTreeViewer.maxFileMB.');
  assert.equal(s.rendered, 0);
});

test('host: exactly 200 MB is still opened; the limit setting is clamped', async () => {
  const s = setup({ statSize: async () => 200 * MB });
  await s.host.handle({ type: 'ready' });
  assert.equal(s.spawned, 1);
  assert.equal(s.w.sent[0].type, 'load');
  assert.equal(s.w.sent[0].path, '/x/data.json');
  assert.equal(limitBytes(200), 200 * MB);
  assert.equal(limitBytes(0), 1 * MB);
  assert.equal(limitBytes(99999), 1024 * MB);
  assert.equal(limitBytes('x'), 200 * MB);
  assert.equal(fmtSize(1.5 * 1024 * MB), '1.5 GB');
  assert.match(tooBigMessage(2 * 1024 * MB, 200 * MB), /^This file is 2 GB\./);
});

test('host: remote files are read through readBytes, text sources skip the size check', async () => {
  const s = setup({ source: { name: 'r.json', ext: '.json' } });
  await s.host.handle({ type: 'ready' });
  assert.deepEqual([...s.w.sent[0].bytes], [123, 125]);
  let stat = 0;
  const t = setup({ source: { name: 'Clipboard', ext: '.json', text: '[1]' }, statSize: async () => { stat++; return 0; } });
  await t.host.handle({ type: 'ready' });
  assert.equal(stat, 0);
  assert.equal(t.w.sent[0].text, '[1]');
});

test('host: relays worker messages, counts one success per tab, copies through the host', async () => {
  const s = setup();
  await s.host.handle({ type: 'ready' });
  s.w.emit({ type: 'init', ok: true, rows: [] });
  s.w.emit({ type: 'init', ok: true, rows: [] });
  assert.equal(s.rendered, 1, 'rating success once per tab');
  s.w.emit({ type: 'clip', text: 'hello' });
  await tick();
  assert.deepEqual(s.copied, ['hello']);
  assert.ok(s.posted.some(m => m.type === 'toast' && m.text === 'Copied value'));
  s.w.emit({ type: 'clip', error: 'too big' });
  assert.ok(s.posted.some(m => m.type === 'toast' && m.error));
  await s.host.handle({ type: 'copyText', text: '$.a', what: '$.a' });
  assert.deepEqual(s.copied, ['hello', '$.a']);
  s.host.handle({ type: 'openText' });
  assert.equal(s.opened, 1);
  s.host.handle({ type: 'toggle', id: 5, row: 2, extra: 'dropped' });
  assert.deepEqual(s.w.sent.at(-1), { type: 'toggle', id: 5, row: 2, open: undefined });
  s.host.handle({ type: 'load', path: '/etc/passwd' });
  s.host.handle({ type: 'evil' });
  assert.equal(s.w.sent.filter(m => m.type === 'load').length, 1, 'webview cannot ask for another file');
  s.host.dispose();
  assert.equal(s.w.terminated, true);
  s.w.emit({ type: 'rows', rows: [] });
  assert.ok(!s.posted.some(m => m.type === 'rows'), 'nothing posted after dispose');
});

test('host: cleanMessage keeps only known fields with the right types', () => {
  assert.equal(cleanMessage(null), null);
  assert.equal(cleanMessage({ type: 'nope' }), null);
  assert.deepEqual(cleanMessage({ type: 'rows', start: '5', count: 100 }), { type: 'rows', start: 0, count: 100 });
  assert.deepEqual(cleanMessage({ type: 'level', level: 'all' }), { type: 'level', level: 'all' });
  assert.deepEqual(cleanMessage({ type: 'select', target: { cell: { r: 1, c: 2 }, id: 3 } }), { type: 'select', target: { cell: { r: 1, c: 2 } } });
  assert.deepEqual(cleanMessage({ type: 'tableSort', col: 1, dir: 'sideways' }), { type: 'tableSort', col: 1, dir: null });
  assert.equal(cleanMessage({ type: 'copyText', text: 5 }), null);
  assert.equal(cleanMessage({ type: 'search', q: 'x'.repeat(900) }).q.length, 500);
});

test('protocol: real worker thread end to end', async () => {
  const w = realWorker();
  try {
    const text = JSON.stringify({ a: 1, list: [{ id: 2, s: 'x' }, { id: 1, s: 'y' }], deep: { b: { c: { d: 'needle' } } } });
    w.postMessage({ type: 'load', text, ext: '.json' });
    const init = await w.next('init');
    assert.equal(init.ok, true);
    assert.equal(init.level, 2);
    assert.equal(init.rows[0].t, 'object');
    w.postMessage({ type: 'search', q: 'needle' });
    const found = await w.next('found');
    assert.equal(found.count, 1);
    const ch = await w.next('changed');
    assert.equal(ch.hit, 0);
    w.postMessage({ type: 'rows', start: ch.focus, count: 1 });
    const rows = await w.next('rows');
    assert.equal(rows.rows[0].k, 'd');
    assert.equal(rows.rows[0].m, 1);
    w.postMessage({ type: 'select', target: { id: ch.id } });
    const det = await w.next('detail');
    assert.equal(det.detail.jsonPath, '$.deep.b.c.d');
    w.postMessage({ type: 'copyValue', target: { id: ch.id } });
    assert.equal((await w.next('clip')).text, 'needle');
    const listRow = init.rows.find(r => r.k === 'list');
    w.postMessage({ type: 'table', id: listRow.id });
    const t = await w.next('tableInit');
    assert.equal(t.ok, true);
    assert.equal(t.count, 2);
    w.postMessage({ type: 'tableSort', col: 0, dir: 'asc' });
    const sorted = await w.next('tableSorted');
    assert.deepEqual(sorted.rows.map(r => r.i), [1, 0]);
    w.postMessage({ type: 'level', level: 'all' });
    const all = await w.next('changed');
    assert.ok(all.total > init.total);
    w.postMessage({ type: 'load', text: '{"a": 1,, }', ext: '.json' });
    const bad = await w.next('init');
    assert.equal(bad.ok, false);
    assert.equal(bad.kind, 'parse');
    assert.equal(bad.line, 1);
  } finally { await w.terminate(); }
});
