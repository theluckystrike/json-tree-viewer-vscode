'use strict';
// Writes the sample files used by the tests, the README screenshots and the VS Code gate.
// Usage: node scripts/make-samples.js [outDir]   (default: samples/). Every file is generated, under 5 MB.
const fs = require('fs');
const path = require('path');

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const FIRST = ['Ada', 'Grace', 'Alan', 'Linus', 'Margaret', 'Ken', 'Barbara', 'Dennis', 'Radia', 'Edsger', 'Frances', 'Donald', 'Hedy', 'Tim', 'Katherine', 'John'];
const LAST = ['Lovelace', 'Hopper', 'Turing', 'Torvalds', 'Hamilton', 'Thompson', 'Liskov', 'Ritchie', 'Perlman', 'Dijkstra', 'Allen', 'Knuth', 'Lamarr', 'Berners-Lee', 'Johnson', 'Backus'];
const CITIES = ['Oslo', 'Lisbon', 'Austin', 'Nairobi', 'Osaka', 'Lyon', 'Quito', 'Perth', 'Tallinn', 'Pune', 'Bergen', 'Leeds'];

function config() {
  return {
    name: 'billing-service',
    version: '3.4.1',
    environment: 'staging',
    server: { host: '0.0.0.0', port: 8443, tls: { enabled: true, cert: '/etc/ssl/billing.pem', ciphers: ['TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384'] }, timeouts: { readMs: 5000, writeMs: 5000, idleMs: 60000 } },
    database: { primary: { host: 'db-1.internal', port: 5432, pool: { min: 2, max: 20, idleTimeoutMs: 30000 } }, replicas: [{ host: 'db-2.internal', lagAlertMs: 500 }, { host: 'db-3.internal', lagAlertMs: 500 }] },
    features: { invoicesV2: true, taxEngine: 'internal', retries: { max: 3, backoff: { type: 'exponential', baseMs: 200, capMs: 5000 } }, flags: { darkLaunch: false, betaCustomers: [1042, 2210, 3381] } },
    logging: { level: 'info', sinks: [{ type: 'stdout', format: 'json' }, { type: 'file', path: '/var/log/billing.log', rotate: { maxMb: 100, keep: 7 } }] },
    owners: [{ team: 'payments', email: 'payments@example.com', oncall: true }, { team: 'platform', email: 'platform@example.com', oncall: false }],
    'odd keys': { 'with space': 1, 'with-dash': 2, "it's": 3, '123start': 4 },
    nothing: null,
  };
}

function usersText(n) {
  const r = rng(7);
  const lines = [];
  for (let i = 0; i < n; i++) {
    const u = {
      id: 100000 + i,
      name: `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`,
      age: 18 + Math.floor(r() * 60),
      city: CITIES[Math.floor(r() * CITIES.length)],
      active: r() < 0.7,
      score: Math.round(r() * 1000) / 10,
    };
    if (i % 97 === 0) u.note = null;
    lines.push(JSON.stringify(u));
  }
  return '[\n' + lines.join(',\n') + '\n]\n';
}

function geojson() {
  const r = rng(11);
  const features = [];
  for (let i = 0; i < 250; i++) {
    features.push({ type: 'Feature', id: i + 1, geometry: { type: 'Point', coordinates: [Math.round((-10 + r() * 40) * 1e5) / 1e5, Math.round((35 + r() * 25) * 1e5) / 1e5] }, properties: { name: `Station ${i + 1}`, city: CITIES[i % CITIES.length], elevation_m: Math.round(r() * 1800), open: r() < 0.85 } });
  }
  const ring = [[10.7, 59.9], [10.8, 59.9], [10.8, 59.95], [10.7, 59.95], [10.7, 59.9]];
  features.push({ type: 'Feature', id: 'oslo-zone', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { name: 'Oslo zone', zone: 'A' } });
  return { type: 'FeatureCollection', name: 'weather-stations', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } }, features };
}

function har() {
  const entries = [];
  const r = rng(3);
  for (let i = 0; i < 40; i++) {
    const body = JSON.stringify({ page: i + 1, items: [{ id: i * 10 + 1, sku: `SKU-${1000 + i}`, price: Math.round(r() * 9000) / 100 }], next: i < 39 ? `/api/products?page=${i + 2}` : null });
    entries.push({
      startedDateTime: new Date(Date.UTC(2026, 10, 5, 9, 0, i)).toISOString(),
      time: Math.round(20 + r() * 300),
      request: { method: 'GET', url: `https://shop.example.com/api/products?page=${i + 1}`, httpVersion: 'HTTP/2', headers: [{ name: 'accept', value: 'application/json' }, { name: 'user-agent', value: 'sample-browser/1.0' }], queryString: [{ name: 'page', value: String(i + 1) }], cookies: [], headersSize: -1, bodySize: 0 },
      response: { status: i === 17 ? 500 : 200, statusText: i === 17 ? 'Internal Server Error' : 'OK', httpVersion: 'HTTP/2', headers: [{ name: 'content-type', value: 'application/json' }], cookies: [], content: { size: body.length, mimeType: 'application/json', text: body }, redirectURL: '', headersSize: -1, bodySize: body.length },
      cache: {}, timings: { blocked: 1, dns: 0, connect: 0, send: 0, wait: Math.round(15 + r() * 250), receive: 2, ssl: -1 },
    });
  }
  return { log: { version: '1.2', creator: { name: 'sample-generator', version: '1.0' }, pages: [{ startedDateTime: '2026-11-05T09:00:00.000Z', id: 'page_1', title: 'Shop', pageTimings: { onLoad: 812 } }], entries } };
}

function escaped() {
  const inner = { user: { id: 42, name: 'Grace Hopper', roles: ['admin', 'billing'] }, cart: [{ sku: 'SKU-1001', qty: 2 }, { sku: 'SKU-2002', qty: 1 }], meta: JSON.stringify({ source: 'mobile', ab: { checkout: 'B' } }) };
  return {
    note: 'Each payload is a JSON document stored as a string, as many logs, queues and APIs do.',
    events: [
      { id: 'evt_1', type: 'checkout.started', payload: JSON.stringify(inner) },
      { id: 'evt_2', type: 'payment.failed', payload: JSON.stringify({ code: 'card_declined', retry: true, attempts: [{ at: '2026-11-05T09:01:00Z', gateway: 'A' }, { at: '2026-11-05T09:01:05Z', gateway: 'B' }] }) },
      { id: 'evt_3', type: 'note', payload: 'plain text, not JSON' },
      { id: 'evt_4', type: 'list', payload: JSON.stringify([1, 2, 3, { four: 4 }]) },
    ],
  };
}

const JSONC = `// Editor settings for the sample workspace
{
  /* Theme and font */
  "workbench.colorTheme": "Default Dark Modern",
  "editor.fontSize": 14, // a bit larger than default
  "editor.rulers": [80, 120,],
  "files.exclude": {
    "**/.git": true,
    "**/node_modules": true, // trailing comma next
  },
  "url": "https://example.com/path//not-a-comment", /* strings keep their slashes */
  "glob": "src/**/*.ts",
}
`;

const JSON5_TEXT = `// JSON5 sample
{
  name: 'json5 sample',
  unquoted: true,
  hex: 0xFF,
  leadingDot: .5,
  trailingDot: 2.,
  infinity: Infinity,
  list: [1, 2, 3,],
  'single quotes': 'it\\'s fine',
}
`;

const BROKEN = `{
  "name": "broken sample",
  "items": [
    { "id": 1, "ok": true },
    { "id": 2 "ok": false }
  ]
}
`;

const NOTEBOOK = { cells: [{ cell_type: 'markdown', metadata: {}, source: ['# Sales check\n', 'Totals by city.'] }, { cell_type: 'code', execution_count: 1, metadata: {}, outputs: [{ output_type: 'stream', name: 'stdout', text: ['Oslo 1204\n', 'Lyon 980\n'] }], source: ['for city, total in totals.items():\n', '    print(city, total)'] }], metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } }, nbformat: 4, nbformat_minor: 5 };
const MANIFEST = { name: 'Sample Shop', short_name: 'Shop', start_url: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#1b2a3a', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] };

function makeSamples(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    'config-nested.json': JSON.stringify(config(), null, 2) + '\n',
    'users-50k.json': usersText(50000),
    'weather-stations.geojson': JSON.stringify(geojson(), null, 1) + '\n',
    'shop-session.har': JSON.stringify(har(), null, 2) + '\n',
    'escaped-json.json': JSON.stringify(escaped(), null, 2) + '\n',
    'settings.jsonc': JSONC,
    'app.json5': JSON5_TEXT,
    'broken.json': BROKEN,
    'analysis.ipynb': JSON.stringify(NOTEBOOK, null, 1) + '\n',
    'site.webmanifest': JSON.stringify(MANIFEST, null, 2) + '\n',
  };
  const out = {};
  for (const [name, text] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text);
    out[name] = Buffer.byteLength(text);
  }
  return out;
}

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'samples'));
  const sizes = makeSamples(dir);
  for (const [n, s] of Object.entries(sizes)) console.log(`${n.padEnd(26)} ${(s / 1024).toFixed(1).padStart(8)} KB`);
}

module.exports = { makeSamples, usersText };
