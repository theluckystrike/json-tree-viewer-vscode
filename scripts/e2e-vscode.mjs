// Release check in a real VS Code: installs the .vsix into an isolated profile, opens the generated samples,
// drives the webview with real mouse and key events, saves screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <shotDir> <outJson>
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const [work0, port, vsix, ws0, shotDir, outJson] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
const R = { install: null, steps: [], console: [], hashes: {}, unchanged: null };
const hash = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
for (const f of fs.readdirSync(ws)) R.hashes[f] = hash(path.join(ws, f));
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const clipBefore = (() => { try { return execSync('pbpaste', { encoding: 'utf8' }); } catch { return null; } })();
const baseSettings = { 'files.simpleDialog.enable': true, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false, 'window.titleBarStyle': 'custom', 'workbench.sideBar.location': 'left', 'jsonTreeViewer.askForRating': false };
const vs = await launch(work, Number(port), ws, baseSettings);
const settingsFile = path.join(work, 'ud', 'User', 'settings.json');
const setSetting = (k, v) => { const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); if (v === undefined) delete s[k]; else s[k] = v; fs.writeFileSync(settingsFile, JSON.stringify(s, null, 1)); };
const shots = [];
const shot = async name => { const f = path.join(shotDir, `json-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 600), ms: Date.now() - t0 }); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
const pb = () => execSync('pbpaste', { encoding: 'utf8' });
let wv;
const E = expr => vs.wvEval(wv, expr);
const getWv = async (title, ms = 20000) => vs.waitFor(async () => (await vs.webviews()).filter(w => w.title === title && w.w > 0).at(-1), ms);
const activeTab = () => vs.wbEval(`(document.querySelector('.editor-group-container.active .tab.active .label-name') || {}).textContent || ''`);
const rowsText = () => E(`JSON.stringify([...document.querySelectorAll('.row:not([hidden])')].sort((a, b) => a.dataset.pos - b.dataset.pos).map(r => [Number(r.dataset.pos), r.querySelector('.key').textContent, r.querySelector('.badge').textContent, r.querySelector('.count').textContent, r.querySelector('.val').textContent, r.className]))`).then(JSON.parse);
const ready = async () => {
  const ok = await vs.waitFor(() => E(`(document.querySelectorAll('.row:not([hidden])').length > 0 && ![...document.querySelectorAll('.row:not([hidden]) .val')].some(v => v.textContent === '…')) || !document.querySelector('.fatal').hidden`), 30000, 150);
  if (!ok) throw new Error('viewer did not render');
  await sleep(250);
};
const btn = t => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(t)} && b.offsetParent)`;
const text = sel => E(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
const activeIsText = () => vs.wbEval(`!!document.querySelector('.editor-group-container.active .editor-instance .monaco-editor') || !!document.querySelector('.editor-group-container.active .notebook-editor')`);
const titleButton = async file => {
  if (file) await vs.waitFor(async () => (await activeTab()) === file, 8000, 100);
  await sleep(300);
  const b = await vs.waitFor(() => vs.wbEval(`(() => { const a = [...document.querySelectorAll('.editor-group-container.active .editor-actions .action-label')].find(x => /Open in JSON Viewer/.test(x.getAttribute('aria-label') || x.title || '')); if (!a) return null; const r = a.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`), 10000);
  if (!b) throw new Error('no "Open in JSON Viewer" button in the editor title');
  const p = JSON.parse(b);
  await vs.click(p.x, p.y);
};
const openText = async file => { vs.open(path.join(ws, file)); await sleep(1200); };
const openViewer = async file => {
  const t0 = Date.now();
  await openText(file);
  const isText = await activeIsText();
  const before = (await vs.webviews()).filter(w => w.title === file).length;
  await titleButton(file);
  wv = await vs.waitFor(async () => { const l = (await vs.webviews()).filter(w => w.title === file && w.w > 0); return l.length > before ? l.at(-1) : null; }, 6000);
  if (!wv) { await titleButton(file); wv = await getWv(file); }
  if (!wv) throw new Error('no webview for ' + file);
  await ready();
  return { ms: Date.now() - t0, openedAsTextFirst: isText };
};
const typeSearch = async q => {
  await vs.wvClick(wv, `document.querySelector('.search')`);
  await E(`(() => { const s = document.querySelector('.search'); s.select(); return 1; })()`);
  await vs.type(q);
  await vs.key('Enter', 'Enter');
  await vs.waitFor(() => E(`/of|No matches/.test(document.querySelector('.hittext').textContent)`), 10000, 100);
  await sleep(300);
};

try {
  await sleep(2500);
  await vs.command('View: Close Primary Side Bar').catch(() => {});
  await step('text editor stays the default; title button opens users-50k.json in the viewer', async () => {
    const r = await openViewer('users-50k.json');
    if (!r.openedAsTextFirst) throw new Error('file did not open in the text editor first');
    const stats = await text('.stats');
    const rows = await rowsText();
    if (!/50,000 items/.test(stats) || rows[0][1] !== 'root' || rows[1][1] !== '0' || !/^\{id: 100000/.test(rows[1][4])) throw new Error(JSON.stringify({ stats, rows: rows.slice(0, 3) }));
    await E(`(() => { const l = document.querySelector('.vlist'); l.scrollTop = l.scrollHeight; return 1; })()`);
    await sleep(600);
    const end = await rowsText();
    const last = end.at(-1);
    if (last[1] !== '49999' || last[4].includes('…') && last[4].length < 3) throw new Error(JSON.stringify(last));
    return { openMs: r.ms, stats, lastRow: last.slice(0, 2) };
  });
  await step('users-50k: Table tab, sort score descending by two real header clicks, cell path and copy', async () => {
    await vs.wvClick(wv, btn('Table'));
    await vs.waitFor(() => E(`document.querySelectorAll('.ghcell').length === 7`), 5000);
    const header = await E(`[...document.querySelectorAll('.ghcell .hname')].map(h => h.textContent).join(',')`);
    const scoreHead = `[...document.querySelectorAll('.ghcell')].find(h => h.querySelector('.hname').textContent === 'score')`;
    await vs.wvClick(wv, scoreHead); await sleep(500);
    await vs.wvClick(wv, scoreHead); await sleep(700);
    const scores = JSON.parse(await E(`JSON.stringify([...document.querySelectorAll('.grow:not([hidden])')].slice(0, 15).map(r => Number(r.children[6].textContent)))`));
    const arrow = await E(`${scoreHead}.querySelector('.harrow').textContent`);
    const sorted = scores.every((v, i) => i === 0 || scores[i - 1] >= v);
    await vs.wvClick(wv, `[...document.querySelectorAll('.grow:not([hidden])')][2].children[2]`); await sleep(400);
    const p = await text('.dpath');
    await vs.wvClick(wv, btn('Copy value')); await sleep(400);
    const val = pb();
    const cellText = await E(`[...document.querySelectorAll('.grow:not([hidden])')][2].children[2].textContent`);
    await shot('users-table-sorted');
    if (header !== 'id,name,age,city,active,score,note' || !sorted || arrow !== '▼' || scores[0] !== 100 || !/^\$\[\d+\]\.name$/.test(p) || val !== cellText) throw new Error(JSON.stringify({ header, scores, arrow, p, val, cellText }));
    return { header, top: scores.slice(0, 5), cellPath: p, copied: val };
  });
  await step('config-nested via the command palette: level 3, search next and previous, copy JS path, keys', async () => {
    await openText('config-nested.json');
    await vs.command('JSON Viewer: Open in JSON Viewer');
    wv = await getWv('config-nested.json'); if (!wv) throw new Error('no webview');
    await ready();
    const n2 = (await rowsText()).length;
    await vs.wvClick(wv, btn('3')); await sleep(500);
    const n3 = await E(`document.querySelector('.vlist .sizer').style.height`);
    await typeSearch('host');
    const h1 = await text('.hittext');
    const p1 = await text('.dpath');
    await vs.key('Enter', 'Enter'); await sleep(400);
    const p2 = await text('.dpath');
    await vs.key('Enter', 'Enter', 8); await sleep(400); // Shift+Enter
    const p3 = await text('.dpath');
    await vs.wvClick(wv, btn('Copy JS path')); await sleep(400);
    const js = pb();
    await vs.wvClick(wv, btn('Copy JSONPath')); await sleep(400);
    const jp = pb();
    await shot('config-search-host');
    // keyboard: down arrow moves selection
    await vs.wvClick(wv, `document.querySelector('.row.sel')`);
    await vs.key('ArrowDown', 'ArrowDown'); await sleep(400);
    const p4 = await text('.dpath');
    const hits = (await rowsText()).filter(r => /\bhit\b/.test(r[5])).length;
    if (!/^1 of 4$/.test(h1) || p1 !== '$.server.host' || p2 !== '$.database.primary.host' || p3 !== p1 || js !== 'data.server.host' || jp !== '$.server.host' || p4 !== '$.server.port' || hits < 1) throw new Error(JSON.stringify({ n2, n3, h1, p1, p2, p3, js, jp, p4, hits }));
    return { rowsLevel2: n2, sizerLevel3: n3, hitText: h1, next: p2, back: p3, copiedJs: js, afterArrowDown: p4, highlightedRows: hits };
  });
  await step('odd keys get bracket paths; expand all and collapse', async () => {
    await vs.wvClick(wv, btn('All')); await sleep(500);
    await E(`(() => { const l = document.querySelector('.vlist'); l.scrollTop = l.scrollHeight; return 1; })()`); await sleep(500);
    await vs.wvClick(wv, `[...document.querySelectorAll('.row:not([hidden])')].find(r => r.querySelector('.key').textContent === "it's")`); await sleep(400);
    const p = await text('.dpath');
    await vs.wvClick(wv, btn('Copy JS path')); await sleep(300);
    const js = pb();
    await vs.wvClick(wv, btn('Collapse')); await sleep(400);
    const n = (await rowsText()).length;
    if (p !== "$['odd keys']['it\\'s']" || js !== `data["odd keys"]["it's"]` || n !== 1) throw new Error(JSON.stringify({ p, js, n }));
    return { jsonPath: p, jsPath: js, rowsAfterCollapse: n };
  });
  await step('escaped-json: JSON string chip opens payload as a tree; JS path uses JSON.parse', async () => {
    await openViewer('escaped-json.json');
    await vs.wvClick(wv, btn('3')); await sleep(500);
    await vs.wvClick(wv, `[...document.querySelectorAll('.row:not([hidden])')].find(r => r.querySelector('.key').textContent === 'payload' && !r.querySelector('.chip').hidden).querySelector('.chip')`);
    await sleep(600);
    await vs.wvClick(wv, `[...document.querySelectorAll('.row:not([hidden])')].find(r => r.querySelector('.key').textContent === 'user')`); await sleep(300);
    await vs.key('ArrowRight', 'ArrowRight'); await sleep(400);
    await vs.wvClick(wv, `[...document.querySelectorAll('.row:not([hidden])')].find(r => r.querySelector('.key').textContent === 'name' && r.querySelector('.val').textContent === '"Grace Hopper"')`); await sleep(400);
    await vs.wvClick(wv, btn('Copy JS path')); await sleep(300);
    const js = pb();
    const badge = await E(`[...document.querySelectorAll('.row:not([hidden])')].find(r => r.querySelector('.key').textContent === 'payload').querySelector('.badge').textContent`);
    await shot('escaped-json-nested');
    const chips = await E(`[...document.querySelectorAll('.row:not([hidden]) .chip')].filter(c => !c.hidden).map(c => c.textContent).join('|')`);
    if (js !== 'JSON.parse(data.events[0].payload).user.name' || badge !== 'json') throw new Error(JSON.stringify({ js, badge, chips }));
    return { jsPath: js, badge, chipsVisible: chips };
  });
  await step('settings.jsonc: comments and trailing commas accepted, badge and notice', async () => {
    await openViewer('settings.jsonc');
    const badge = await text('.fmt'), notice = await text('.notice');
    const rows = await rowsText();
    await shot('settings-jsonc');
    if (badge !== 'JSONC' || !/5 comments, 3 trailing commas/.test(notice) || !rows.some(r => r[1] === 'url' && r[4] === '"https://example.com/path//not-a-comment"')) throw new Error(JSON.stringify({ badge, notice }));
    return { badge, notice };
  });
  await step('app.json5 opens as JSON5', async () => {
    await openViewer('app.json5');
    const badge = await text('.fmt');
    const rows = await rowsText();
    const hex = rows.find(r => r[1] === 'hex');
    if (badge !== 'JSON5' || !hex || hex[4] !== '255') throw new Error(JSON.stringify({ badge, hex }));
    return { badge, hex: hex[4] };
  });
  await step('broken.json: plain error with line, column and the lines around it', async () => {
    await openViewer('broken.json');
    const head = await text('.fhead'), t = await text('.ftext'), snip = await text('.fsnip');
    await shot('broken-json-error');
    if (!/not valid JSON/.test(head) || !/line 5, column 15/.test(t) || !/"id": 2 "ok": false/.test(snip)) throw new Error(JSON.stringify({ head, t, snip }));
    await vs.wvClick(wv, `document.querySelector('.fatal .btn')`); await sleep(800);
    const backToText = await activeIsText();
    return { head, text: t, openAsTextWorks: backToText };
  });
  await step('geojson, HAR and webmanifest open from the title button', async () => {
    const out = {};
    for (const f of ['weather-stations.geojson', 'shop-session.har', 'site.webmanifest']) {
      const r = await openViewer(f);
      out[f] = { ms: r.ms, stats: await text('.stats'), rows: (await rowsText()).length };
    }
    wv = await getWv('shop-session.har');
    return out;
  });
  await step('analysis.ipynb: the notebook editor has the title button too', async () => {
    const r = await openViewer('analysis.ipynb');
    const rows = await rowsText();
    if (!rows.some(x => x[1] === 'cells')) throw new Error(JSON.stringify(rows.slice(0, 3)));
    return { ms: r.ms, stats: await text('.stats') };
  });
  await step('HAR: search a SKU inside a response body, open the body as JSON', async () => {
    await vs.command('View: Close All Editor Groups').catch(() => {}); await sleep(500);
    await openViewer('shop-session.har');
    await typeSearch('SKU-1017');
    const p = await text('.dpath');
    await vs.wvClick(wv, btn('Open JSON string')); await sleep(600);
    const rows = await rowsText();
    const hasItems = rows.some(r => r[1] === 'items');
    await shot('har-response-body');
    if (p !== '$.log.entries[17].response.content.text' || !hasItems) throw new Error(JSON.stringify({ p, rows: rows.length }));
    return { path: p };
  });
  await step('selection: Cmd+A in a text editor, then Open Selection or Clipboard', async () => {
    await openText('site.webmanifest');
    await vs.command('View: Close All Editor Groups').catch(() => {});
    await openText('site.webmanifest');
    const lp = JSON.parse(await vs.wbEval(`(() => { const r = document.querySelector('.editor-group-container.active .view-lines').getBoundingClientRect(); return JSON.stringify({ x: r.x + 60, y: r.y + 8 }); })()`));
    await vs.click(lp.x, lp.y); await sleep(200);
    await vs.key('a', 'KeyA', 4); await sleep(300);
    await vs.command('JSON Viewer: Open Selection or Clipboard in JSON Viewer');
    const w = await vs.waitFor(async () => (await vs.webviews()).find(x => /^Selection \(/.test(x.title) && x.w > 0), 15000);
    if (!w) throw new Error('no selection panel');
    wv = w;
    await ready();
    const rows = await rowsText();
    if (!rows.some(r => r[1] === 'short_name')) throw new Error(JSON.stringify(rows.slice(0, 4)));
    return { title: w.title, rows: rows.length };
  });
  await step('light theme: weather-stations features as a table', async () => {
    setSetting('workbench.colorTheme', 'Default Light Modern'); await sleep(1500);
    await openViewer('weather-stations.geojson');
    await vs.wvClick(wv, `[...document.querySelectorAll('.row:not([hidden])')].find(r => r.querySelector('.key').textContent === 'features').querySelector('.chip:not([hidden])')`);
    await vs.waitFor(() => E(`document.querySelectorAll('.ghcell').length > 0`), 5000);
    const cols = await E(`[...document.querySelectorAll('.ghcell .hname')].map(h => h.textContent).join(',')`);
    await shot('geojson-table-light');
    await vs.wvClick(wv, btn('Back to tree')); await sleep(300);
    await vs.wvClick(wv, btn('2')); await sleep(400);
    await shot('geojson-tree-light');
    setSetting('workbench.colorTheme', undefined); await sleep(1200);
    if (cols !== 'type,id,geometry,properties') throw new Error(cols);
    return { columns: cols };
  });
  await step('size limit: over the limit shows the message and the file is not read (setting lowered to 1 MB)', async () => {
    setSetting('jsonTreeViewer.maxFileMB', 1); await sleep(1200);
    await vs.command('View: Close All Editor Groups').catch(() => {}); await sleep(500);
    await openText('users-50k.json');
    await titleButton('users-50k.json');
    wv = await getWv('users-50k.json');
    await ready();
    const head = await text('.fhead'), t = await text('.ftext');
    await shot('over-limit-message');
    setSetting('jsonTreeViewer.maxFileMB', undefined);
    if (!/too big/.test(head) || !/^This file is 4 MB\. JSON Viewer opens files up to 1 MB so VS Code stays responsive\. The file was not read\./.test(t)) throw new Error(JSON.stringify({ head, t }));
    return { head, text: t };
  });
} finally {
  R.console = vs.console.filter(c => !/copilot|CloudSandboxApi|LESS API|reading 'selection'/i.test(c.text));
  R.logErrors = [];
  for (const f of vs.extHostLogs()) { const t = fs.readFileSync(f, 'utf8'); for (const l of t.split('\n')) if (/\[error\]/.test(l) && /json-tree|jsonTreeViewer|zovo/i.test(l)) R.logErrors.push(l.slice(0, 300)); }
  await vs.close();
  if (clipBefore !== null) try { execSync('pbcopy', { input: clipBefore }); } catch {}
  R.unchanged = Object.entries(R.hashes).every(([f, h]) => hash(path.join(ws, f)) === h);
  R.shots = shots;
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  console.log(JSON.stringify({ steps: R.steps.map(s => [s.ok ? 'PASS' : 'FAIL', s.name, s.error || '']), console: R.console, logErrors: R.logErrors, unchanged: R.unchanged, install: R.install.code }, null, 1));
}
