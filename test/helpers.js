'use strict';
// Shared test helpers. Temporary files live in the product folder (test-tmp/) and are removed in teardown.
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const ROOT = path.join(__dirname, '..');
const WORKER = path.join(ROOT, 'dist', 'worker.js');

function tmpDir(name) {
  const d = path.join(ROOT, 'test-tmp', `${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function removeTmp(d) {
  fs.rmSync(d, { recursive: true, force: true });
  const parent = path.dirname(d);
  try { if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent); } catch { /* other test still using it */ }
}

/** A real worker thread with a promise helper that waits for the next message of a type. */
function realWorker() {
  const w = new Worker(WORKER);
  const queue = [];
  const waiters = [];
  w.on('message', m => {
    const i = waiters.findIndex(x => x.type === m.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else queue.push(m);
  });
  w.next = type => {
    const i = queue.findIndex(m => m.type === type);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise(resolve => waiters.push({ type, resolve }));
  };
  return w;
}

module.exports = { ROOT, WORKER, tmpDir, removeTmp, realWorker };
