'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseText, stripJsonc, decode, ParseError } = require('../src/core/parse');

test('parse: plain JSON is mode json', () => {
  const r = parseText('{"a": [1, 2, {"b": null}]}', '.json');
  assert.equal(r.mode, 'json');
  assert.deepEqual(r.value, { a: [1, 2, { b: null }] });
});

test('parse: JSONC comments and trailing commas are accepted and counted', () => {
  const src = '// head\n{\n  "a": 1, // one\n  /* block */ "b": [1, 2,],\n  "c": {"d": true,},\n}\n';
  const r = parseText(src, '.jsonc');
  assert.equal(r.mode, 'jsonc');
  assert.deepEqual(r.value, { a: 1, b: [1, 2], c: { d: true } });
  assert.deepEqual(r.notes, ['3 comments', '3 trailing commas']);
});

test('parse: comment markers and commas inside strings are left alone', () => {
  const src = '{"url": "https://x.y//z", "g": "a/*b*/c", "s": "a,]", "q": "say \\"hi\\" // no", "e": [1,]}';
  const r = parseText(src, '.json');
  assert.equal(r.value.url, 'https://x.y//z');
  assert.equal(r.value.g, 'a/*b*/c');
  assert.equal(r.value.s, 'a,]');
  assert.equal(r.value.q, 'say "hi" // no');
  assert.deepEqual(r.value.e, [1]);
});

test('parse: stripJsonc keeps length and line breaks', () => {
  const src = '{\n/* a\nb */ "x": 1, // c\n}';
  const st = stripJsonc(src);
  assert.equal(st.text.length, src.length);
  assert.equal(st.text.split('\n').length, src.split('\n').length);
});

test('parse: JSON5 features', () => {
  const r = parseText("{name: 'x', hex: 0xFF, half: .5, inf: Infinity, list: [1,],}", '.json5');
  assert.equal(r.mode, 'json5');
  assert.equal(r.value.hex, 255);
  assert.equal(r.value.half, 0.5);
  assert.equal(r.value.inf, Infinity);
});

test('parse: invalid JSON gives line, column and a snippet', () => {
  const src = '{\n  "a": 1,\n  "b": 2\n  "c": 3\n}';
  assert.throws(() => parseText(src, '.json'), e => {
    assert.ok(e instanceof ParseError);
    assert.equal(e.line, 4);
    assert.equal(e.col, 3);
    assert.match(e.snippet, /4 \|\s+"c": 3/);
    return true;
  });
});

test('parse: invalid JSON5 file reports JSON5 position', () => {
  assert.throws(() => parseText("{a: 1,\n b: }", '.json5'), e => e instanceof ParseError && e.line === 2);
});

test('parse: empty and cut-off files', () => {
  assert.throws(() => parseText('   \n', '.json'), /empty/);
  assert.throws(() => parseText('{"a": [1, 2', '.json'), e => e instanceof ParseError && e.line === 1);
});

test('parse: decode strips the UTF-8 BOM and reads UTF-16 with a BOM', () => {
  assert.equal(decode(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), '{}');
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"a":1}', 'utf16le')]);
  assert.deepEqual(parseText(decode(u16), '.json').value, { a: 1 });
});

test('parse: __proto__ keys stay data', () => {
  const r = parseText('{"__proto__": {"polluted": true}}', '.json');
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(r.value), ['__proto__']);
});
