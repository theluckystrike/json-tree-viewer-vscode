'use strict';
// Runs in a worker thread so reading and parsing a large file never blocks the extension host.
const { parentPort } = require('worker_threads');
const { createSession } = require('./core/session');

const session = createSession({ post: m => parentPort.postMessage(m) });
parentPort.on('message', m => session.handle(m));
