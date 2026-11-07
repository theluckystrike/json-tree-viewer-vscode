'use strict';
const vscode = require('vscode');
const path = require('path');
const { Worker } = require('worker_threads');
const { buildHtml } = require('./html');
const { createHost, limitBytes } = require('./core/host');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const VIEW_TYPE = 'jsonTreeViewer.viewer';
const SNIPPET_TYPE = 'jsonTreeViewer.snippet';
const EXT_ID = 'zovo.zovo-json-tree-viewer';
let rating = { success() {} };

function settings() { return vscode.workspace.getConfiguration('jsonTreeViewer'); }

/** Wires one webview (custom editor or snippet panel) to a host session and a worker thread. */
function attach(context, panel, source, uri) {
  const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  // Command links are limited to the two support commands and the settings page (footer "Hide" link).
  panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media], enableCommandUris: commandUris('jsonTreeViewer') };
  panel.webview.html = buildHtml({
    cspSource: panel.webview.cspSource,
    scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
    styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
    title: source.name,
    showSupportLinks: showLinks(vscode, 'jsonTreeViewer'),
  });
  const host = createHost({
    source,
    limit: limitBytes(settings().get('maxFileMB', 200)),
    statSize: async () => (await vscode.workspace.fs.stat(uri)).size,
    readBytes: () => vscode.workspace.fs.readFile(uri),
    spawnWorker: () => new Worker(path.join(context.extensionPath, 'dist', 'worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 4096 } }),
    post: m => { panel.webview.postMessage(m).then(undefined, () => {}); },
    copy: text => vscode.env.clipboard.writeText(text),
    openAsText: () => (uri ? vscode.commands.executeCommand('vscode.openWith', uri, 'default') : openSnippetAsText(source.text)),
    rendered: () => rating.success(), // once per tab: the file parsed and its first rows were sent
    reveal: ({ line, col }) => revealAt(uri, source, line, col),
  });
  panel.webview.onDidReceiveMessage(m => host.handle(m));
  const subs = uri ? watchFile(uri, panel, host) : [];
  panel.onDidDispose(() => { host.dispose(); for (const d of subs) d.dispose(); });
  return host;
}

/** Opens the text editor beside the viewer with the cursor on the node (Go to line). */
async function revealAt(uri, source, line, col) {
  const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, col - 1));
  const selection = new vscode.Range(pos, pos);
  if (!uri) {
    const td = await vscode.workspace.openTextDocument({ content: source.text || '', language: 'jsonc' });
    await vscode.window.showTextDocument(td, { viewColumn: vscode.ViewColumn.Beside, selection });
    return;
  }
  const ed = await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, selection, preview: true });
  ed.revealRange(selection, vscode.TextEditorRevealType.InCenter);
}

/**
 * Reloads the tree when the file changes on disk or is saved in VS Code (setting jsonTreeViewer.autoReload).
 * Changes are collected for 300 ms. A hidden tab reloads when it is shown again.
 */
function watchFile(uri, panel, host) {
  let timer = null;
  let stale = false;
  const fire = () => {
    if (!settings().get('autoReload', true)) return;
    if (!panel.visible) { stale = true; return; }
    clearTimeout(timer);
    timer = setTimeout(() => host.fileChanged(), 300);
  };
  const same = u => u && u.toString() === uri.toString();
  const subs = [{ dispose: () => clearTimeout(timer) }];
  try {
    subs.push(vscode.workspace.onDidSaveTextDocument(d => { if (same(d.uri)) fire(); }));
    subs.push(panel.onDidChangeViewState(() => { if (panel.visible && stale) { stale = false; fire(); } }));
    const dir = vscode.Uri.joinPath(uri, '..');
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, path.posix.basename(uri.path)));
    w.onDidChange(fire); w.onDidCreate(fire);
    subs.push(w);
  } catch { /* some virtual file systems cannot be watched; the view then shows the file as it was opened */ }
  return subs;
}

/** The file in the active editor: a text editor, a notebook (.ipynb) or any tab with a uri. */
function activeUri() {
  const ed = vscode.window.activeTextEditor;
  if (ed) return ed.document.uri;
  const nb = vscode.window.activeNotebookEditor;
  if (nb) return nb.notebook.uri;
  const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.activeTab;
  return tab && tab.input && tab.input.uri instanceof vscode.Uri ? tab.input.uri : undefined;
}

async function openSnippetAsText(text) {
  const td = await vscode.workspace.openTextDocument({ content: text || '', language: 'jsonc' });
  await vscode.window.showTextDocument(td, { preview: true });
}

class JsonViewerProvider {
  constructor(context) { this.context = context; }
  openCustomDocument(uri) { return { uri, dispose() {} }; }
  resolveCustomEditor(document, panel) {
    const uri = document.uri;
    const name = path.posix.basename(uri.path);
    const source = { name, ext: path.posix.extname(uri.path).toLowerCase(), path: uri.scheme === 'file' ? uri.fsPath : undefined };
    attach(this.context, panel, source, uri);
  }
}

async function openSelectionOrClipboard(context) {
  const ed = vscode.window.activeTextEditor;
  let text = '';
  let from = '';
  if (ed && !ed.selection.isEmpty) { text = ed.document.getText(ed.selection); from = 'Selection'; }
  if (!text.trim()) { text = await vscode.env.clipboard.readText(); from = 'Clipboard'; }
  if (!text.trim()) {
    vscode.window.showInformationMessage('Select some JSON in the editor or copy it to the clipboard, then run this command again.');
    return null;
  }
  const panel = vscode.window.createWebviewPanel(SNIPPET_TYPE, `JSON: ${from}`, vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
  return attach(context, panel, { name: `${from} (${text.length.toLocaleString('en-US')} characters)`, ext: '.json', text }, null);
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: 'jsonTreeViewer', message: n => `JSON Viewer has opened ${n} files for you. A rating helps other people find it.` });
  registerSupport({ vscode, context, prefix: 'jsonTreeViewer', selfId: EXT_ID });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new JsonViewerProvider(context), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('jsonTreeViewer.open', async uri => {
      const target = uri instanceof vscode.Uri ? uri : activeUri();
      if (!target || target.scheme === 'untitled') return openSelectionOrClipboard(context);
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('jsonTreeViewer.openSelection', () => openSelectionOrClipboard(context)),
    vscode.commands.registerCommand('jsonTreeViewer.getStarted', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#jsonTreeViewer.start`, false)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, VIEW_TYPE, SNIPPET_TYPE };
