'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { jsonPath, jsPath, NESTED } = require('../src/core/paths');

test('paths: JSONPath and JS path for plain keys and indexes', () => {
  assert.equal(jsonPath([]), '$');
  assert.equal(jsonPath(['items', 3, 'id']), '$.items[3].id');
  assert.equal(jsPath(['items', 3, 'id']), 'data.items[3].id');
});

test('paths: odd keys are quoted', () => {
  assert.equal(jsonPath(['odd keys', "it's", '123start']), "$['odd keys']['it\\'s']['123start']");
  assert.equal(jsPath(['odd keys', 'with"quote', '$ok']), 'data["odd keys"]["with\\"quote"].$ok');
});

test('paths: nested JSON strings', () => {
  const segs = ['events', 0, 'payload', NESTED, 'user', 'id'];
  assert.equal(jsPath(segs), 'JSON.parse(data.events[0].payload).user.id');
  assert.equal(jsonPath(segs), '$.events[0].payload.user.id');
});
