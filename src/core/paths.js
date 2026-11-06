'use strict';
// Path strings for "Copy JSONPath" and "Copy JS path". Shared by the worker and the tests.
// A path is an array of segments: string keys, number indexes, and NESTED, which marks the point where a
// string holding escaped JSON was opened as a tree.

const NESTED = Object.freeze({ nested: true });
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isNested(seg) { return seg !== null && typeof seg === 'object' && seg.nested === true; }

/** JSONPath, for example $.items[3].id or $['a key']. Inside nested JSON the path simply continues. */
function jsonPath(segs) {
  let s = '$';
  for (const k of segs) {
    if (isNested(k)) continue;
    if (typeof k === 'number') s += `[${k}]`;
    else if (IDENT.test(k)) s += '.' + k;
    else s += `['${String(k).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
  }
  return s;
}

/** JavaScript access path, for example data.items[3].id or data["a key"]. Nested JSON becomes JSON.parse(...). */
function jsPath(segs, rootName = 'data') {
  let s = rootName;
  for (const k of segs) {
    if (isNested(k)) s = `JSON.parse(${s})`;
    else if (typeof k === 'number') s += `[${k}]`;
    else if (IDENT.test(k)) s += '.' + k;
    else s += `[${JSON.stringify(String(k))}]`;
  }
  return s;
}

module.exports = { NESTED, isNested, jsonPath, jsPath };
