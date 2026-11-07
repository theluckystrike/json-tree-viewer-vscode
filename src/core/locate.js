'use strict';
// Finds where a node sits in the file text, for "Go to line". It walks the text along the path and skips
// every value it does not need, so it never builds a second tree. JSONC text is passed through stripJsonc
// first (that keeps every position). JSON5 is not supported (unquoted keys and single quotes).

const { isNested } = require('./paths');

/**
 * @param {string} text JSON (or JSONC with comments blanked out)
 * @param {Array} segs path segments (string keys, number indexes, NESTED)
 * @returns {{offset:number, line:number, col:number}|null}
 */
function locate(text, segs) {
  const n = text.length;
  let i = 0;
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break;
    }
  };
  const skipString = () => {
    i++;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 92) { i += 2; continue; }
      i++;
      if (c === 34) return true;
    }
    return false;
  };
  const skipValue = () => {
    ws();
    const c = text.charCodeAt(i);
    if (c === 34) return skipString();
    if (c === 123 || c === 91) {
      let depth = 0;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 34) { skipString(); continue; }
        if (d === 123 || d === 91) depth++;
        else if (d === 125 || d === 93) { depth--; if (depth === 0) { i++; return true; } }
        i++;
      }
      return false;
    }
    const s = i;
    while (i < n) {
      const d = text.charCodeAt(i);
      if (d === 44 || d === 125 || d === 93 || d === 32 || d === 9 || d === 10 || d === 13) break;
      i++;
    }
    return i > s;
  };

  ws();
  let at = i; // where the current node starts (its key for object members)
  for (const seg of segs) {
    if (isNested(seg)) return pos(text, at); // the string that holds the escaped JSON
    const c = text.charCodeAt(i);
    if (typeof seg === 'number') {
      if (c !== 91) return null;
      i++;
      for (let k = 0; k < seg; k++) {
        ws();
        if (!skipValue()) return null;
        ws();
        if (text.charCodeAt(i) !== 44) return null;
        i++;
      }
      ws();
      if (text.charCodeAt(i) === 93) return null;
      at = i;
    } else {
      if (c !== 123) return null;
      i++;
      // JSON.parse keeps the last of duplicate keys, so take the last match.
      let keyAt = -1, valAt = -1;
      for (;;) {
        ws();
        const d = text.charCodeAt(i);
        if (d === 125 || i >= n) break;
        if (d !== 34) return null;
        const ks = i;
        if (!skipString()) return null;
        let key;
        try { key = JSON.parse(text.slice(ks, i)); } catch { return null; }
        ws();
        if (text.charCodeAt(i) !== 58) return null;
        i++;
        ws();
        if (key === seg) { keyAt = ks; valAt = i; }
        if (!skipValue()) return null;
        ws();
        if (text.charCodeAt(i) === 44) i++;
      }
      if (valAt < 0) return null;
      i = valAt;
      at = keyAt;
    }
  }
  return pos(text, at);
}

/** 1-based line and column of an offset. */
function pos(text, offset) {
  let line = 1, last = -1;
  let k = text.indexOf('\n');
  while (k >= 0 && k < offset) { line++; last = k; k = text.indexOf('\n', k + 1); }
  return { offset, line, col: offset - last };
}

module.exports = { locate, pos };
