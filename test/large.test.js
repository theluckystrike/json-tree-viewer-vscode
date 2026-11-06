'use strict';
// One large file (about 30 MB, under the 50 MB rule) in the product folder, parsed by the real worker.
// It is removed in teardown.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { usersText } = require('../scripts/make-samples');
const { tmpDir, removeTmp, realWorker } = require('./helpers');

let dir, file;
test.before(() => {
  dir = tmpDir('large');
  file = path.join(dir, 'users-350k.json');
  fs.writeFileSync(file, usersText(350000));
});
test.after(() => removeTmp(dir));

test('large: a 30 MB file parses in the worker and the first rows come back fast', async (t) => {
  const size = fs.statSync(file).size;
  assert.ok(size > 25 * 1024 * 1024 && size < 50 * 1024 * 1024, `size ${size}`);
  const w = realWorker();
  try {
    const t0 = Date.now();
    w.postMessage({ type: 'load', path: file, ext: '.json', limit: 200 * 1024 * 1024 });
    const init = await w.next('init');
    const ms = Date.now() - t0;
    assert.equal(init.ok, true);
    assert.equal(init.rootCount, 350000);
    assert.equal(init.level, 1);
    assert.equal(init.rows.length, 120);
    assert.ok(ms < 10000, `init took ${ms} ms`);
    w.postMessage({ type: 'rows', start: 349990, count: 50 });
    const tail = await w.next('rows');
    assert.equal(tail.rows.length, 11);
    const t1 = Date.now();
    w.postMessage({ type: 'search', q: 'Tallinn' });
    const found = await w.next('found');
    assert.equal(found.capped, true, 'hits capped at 10,000');
    assert.ok(Date.now() - t1 < 10000);
    t.diagnostic(`size ${(size / 1048576).toFixed(1)} MB, read+parse+first rows ${ms} ms, search ${found.ms} ms`);
  } finally { await w.terminate(); }
});

test('large: the worker refuses a file over the limit on its own too', async () => {
  const w = realWorker();
  try {
    w.postMessage({ type: 'load', path: file, ext: '.json', limit: 1024 * 1024 });
    const init = await w.next('init');
    assert.equal(init.ok, false);
    assert.equal(init.kind, 'tooBig');
  } finally { await w.terminate(); }
});
