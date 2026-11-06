'use strict';
// activate() and the custom editor on a fake vscode module.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const { tmpDir, removeTmp, ROOT } = require('./helpers');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function fakeVscode(state) {
  class Uri {
    constructor(p, scheme = 'file') { this.path = p; this.fsPath = p; this.scheme = scheme; }
    static file(p) { return new Uri(p); }
    static joinPath(u, ...parts) { return new Uri(path.join(u.path, ...parts), u.scheme); }
    toString() { return `${this.scheme}://${this.path}`; }
  }
  return {
    Uri,
    ViewColumn: { Beside: -2 },
    window: {
      registerCustomEditorProvider: (type, provider, opts) => { state.providers[type] = { provider, opts }; return { dispose() {} }; },
      createWebviewPanel: (type, titleText) => { const p = makePanel(state); p.viewType = type; p.title = titleText; state.panels.push(p); return p; },
      showInformationMessage: m => { state.info.push(m); return Promise.resolve(); },
      activeTextEditor: state.editor,
      state: { focused: true },
    },
    commands: {
      registerCommand: (id, fn) => { state.commands[id] = fn; return { dispose() {} }; },
      executeCommand: (...a) => { state.executed.push(a); return Promise.resolve(); },
    },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => (k in state.config ? state.config[k] : d) }),
      fs: { stat: async u => ({ size: state.sizeOverride !== undefined ? state.sizeOverride : fs.statSync(u.fsPath).size }), readFile: async u => fs.readFileSync(u.fsPath) },
      isTrusted: true,
      openTextDocument: async o => o,
    },
    env: { clipboard: { writeText: async t => { state.clip = t; }, readText: async () => state.clipboardText || '' }, sessionId: 's', remoteName: undefined },
  };
}

function makePanel(state) {
  const p = { posted: [], handlers: {}, disposeFns: [] };
  p.webview = {
    cspSource: 'vscode-webview://x', options: null, html: '',
    asWebviewUri: u => ({ toString: () => 'vscode-webview://x' + u.path }),
    postMessage: m => { p.posted.push(m); if (p.waiter && p.waiter.type === m.type) { const w = p.waiter; p.waiter = null; w.resolve(m); } return Promise.resolve(true); },
    onDidReceiveMessage: fn => { p.handlers.msg = fn; return { dispose() {} }; },
  };
  p.onDidDispose = fn => { p.disposeFns.push(fn); return { dispose() {} }; };
  p.dispose = () => p.disposeFns.forEach(f => f());
  p.next = type => { const m = p.posted.find(x => x.type === type); if (m) return Promise.resolve(m); return new Promise(resolve => { p.waiter = { type, resolve }; }); };
  return p;
}

function load(state) {
  const vs = fakeVscode(state);
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? vs : orig.call(this, req, ...rest); };
  try {
    delete require.cache[path.join(ROOT, 'dist', 'extension.js')];
    return { ext: require(path.join(ROOT, 'dist', 'extension.js')), vs };
  } finally { Module._load = orig; }
}

const newState = (over = {}) => ({ providers: {}, commands: {}, executed: [], info: [], panels: [], config: {}, ...over });
const context = () => ({ extensionUri: { path: ROOT, scheme: 'file' }, extensionPath: ROOT, subscriptions: [], globalState: { get: () => undefined, update: async () => {} } });

let dir;
test.before(() => { dir = tmpDir('ext'); fs.writeFileSync(path.join(dir, 'a.json'), '{"hello": [1, 2, 3], "x": {"y": "z"}}'); });
test.after(() => removeTmp(dir));

test('manifest: option priority, all file types, name, keywords, version', () => {
  const ed = pkg.contributes.customEditors[0];
  assert.equal(ed.priority, 'option', 'never replaces the text editor');
  assert.deepEqual(ed.selector.map(s => s.filenamePattern), ['*.json', '*.jsonc', '*.json5', '*.geojson', '*.har', '*.ipynb', '*.webmanifest']);
  assert.ok(pkg.displayName.length <= 45);
  assert.ok(pkg.displayName.toLowerCase().startsWith('json viewer'));
  assert.equal(pkg.publisher, 'zovo');
  assert.equal(pkg.version, '0.1.0');
  assert.ok(pkg.keywords.length <= 30);
  assert.equal(new Set(pkg.keywords).size, pkg.keywords.length);
  assert.equal(pkg.engines.vscode, '^1.90.0');
  const title = pkg.contributes.menus['editor/title'];
  assert.ok(title.every(t => t.command === 'jsonTreeViewer.open'));
  assert.match(title[0].when, /webmanifest/);
  assert.match(title[1].when, /ipynb/);
  assert.ok(pkg.contributes.commands.find(c => c.command === 'jsonTreeViewer.openSelection'));
});

test('extension: activate registers the editor and commands', () => {
  const state = newState();
  const { ext } = load(state);
  ext.activate(context());
  assert.ok(state.providers['jsonTreeViewer.viewer']);
  assert.equal(state.providers['jsonTreeViewer.viewer'].opts.supportsMultipleEditorsPerDocument, true);
  for (const c of ['jsonTreeViewer.open', 'jsonTreeViewer.openSelection', 'jsonTreeViewer.getStarted']) assert.ok(state.commands[c], c);
});

test('extension: a file opens through the worker and renders rows', async () => {
  const state = newState();
  const { ext, vs } = load(state);
  ext.activate(context());
  const panel = makePanel(state);
  await state.providers['jsonTreeViewer.viewer'].provider.resolveCustomEditor({ uri: vs.Uri.file(path.join(dir, 'a.json')) }, panel);
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.equal(panel.webview.options.enableScripts, true);
  assert.equal(panel.webview.options.localResourceRoots.length, 2);
  panel.handlers.msg({ type: 'ready' });
  const init = await panel.next('init');
  assert.equal(init.ok, true);
  assert.equal(init.rows[0].n, 2);
  panel.handlers.msg({ type: 'copyText', text: '$.hello', what: '$.hello' });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(state.clip, '$.hello');
  panel.handlers.msg({ type: 'openText' });
  assert.equal(state.executed.at(-1)[0], 'vscode.openWith');
  assert.equal(state.executed.at(-1)[2], 'default');
  panel.dispose();
});

test('extension: the size limit uses the setting and a mocked size', async () => {
  const state = newState({ sizeOverride: 250 * 1024 * 1024 });
  const { ext, vs } = load(state);
  ext.activate(context());
  const panel = makePanel(state);
  await state.providers['jsonTreeViewer.viewer'].provider.resolveCustomEditor({ uri: vs.Uri.file(path.join(dir, 'a.json')) }, panel);
  panel.handlers.msg({ type: 'ready' });
  const init = await panel.next('init');
  assert.equal(init.ok, false);
  assert.equal(init.kind, 'tooBig');
  assert.match(init.message, /^This file is 250 MB\. JSON Viewer opens files up to 200 MB/);
  const state2 = newState({ sizeOverride: 250 * 1024 * 1024, config: { maxFileMB: 300 } });
  const l2 = load(state2);
  l2.ext.activate(context());
  const p2 = makePanel(state2);
  await state2.providers['jsonTreeViewer.viewer'].provider.resolveCustomEditor({ uri: l2.vs.Uri.file(path.join(dir, 'a.json')) }, p2);
  p2.handlers.msg({ type: 'ready' });
  assert.equal((await p2.next('init')).ok, true, 'raised limit lets it open');
  panel.dispose(); p2.dispose();
});

test('extension: open selection, then clipboard, then a hint', async () => {
  const sel = { isEmpty: false };
  const state = newState({ editor: { selection: sel, document: { getText: () => '{"picked": true}', uri: { scheme: 'file' } } } });
  const { ext } = load(state);
  ext.activate(context());
  await state.commands['jsonTreeViewer.openSelection']();
  const p = state.panels[0];
  assert.equal(p.title, 'JSON: Selection');
  p.handlers.msg({ type: 'ready' });
  const init = await p.next('init');
  assert.equal(init.rows[1].k, 'picked');
  p.dispose();

  const s2 = newState({ clipboardText: '[{"a":1},{"a":2}]' });
  const l2 = load(s2);
  l2.ext.activate(context());
  await s2.commands['jsonTreeViewer.openSelection']();
  assert.equal(s2.panels[0].title, 'JSON: Clipboard');
  s2.panels[0].handlers.msg({ type: 'ready' });
  const i2 = await s2.panels[0].next('init');
  assert.ok(i2.rootTable > 0);
  s2.panels[0].dispose();

  const s3 = newState();
  const l3 = load(s3);
  l3.ext.activate(context());
  await s3.commands['jsonTreeViewer.openSelection']();
  assert.equal(s3.panels.length, 0);
  assert.match(s3.info[0], /Select some JSON/);
});
