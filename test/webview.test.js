'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildHtml } = require('../src/html');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'main.js'), 'utf8');

test('html: strict CSP with a nonce, no remote sources, escaped title', () => {
  const html = buildHtml({ cspSource: 'vscode-webview://abc', scriptUri: 'vscode-webview://abc/w.js', styleUri: 'vscode-webview://abc/s.css', title: '<img src=x onerror=alert(1)>.json', nonce: 'N0NCE' });
  const csp = html.match(/content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-N0NCE'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;\.json/);
  const n1 = buildHtml({ cspSource: 'a', scriptUri: 'b', styleUri: 'c', title: 't' }).match(/nonce-([^']+)'/)[1];
  assert.equal(n1.length, 32);
});

test('webview: file text only goes in through textContent', () => {
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  assert.match(src, /textContent/);
});

test('webview: posts only the message types the host accepts', () => {
  const { cleanMessage } = require('../src/core/host');
  const types = [...new Set([...src.matchAll(/post\(\{ type: '([a-zA-Z]+)'/g)].map(m => m[1]))];
  assert.ok(types.length >= 10);
  for (const t of types) assert.ok(cleanMessage({ type: t, text: '' }), `host drops ${t}`);
});

test('webview: no network APIs', () => {
  assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
});
