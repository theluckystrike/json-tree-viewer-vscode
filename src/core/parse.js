'use strict';
// Reads JSON, JSONC (comments, trailing commas) and JSON5 text. No vscode import, so tests run under plain node.

const JSON5 = require('json5');
const { maybeBig, canKeepExact, parseExact } = require('./bignum');

const JSON5_MAX_CHARS = 50 * 1024 * 1024; // the JSON5 parser is slow; above this only JSON and JSONC are tried

class ParseError extends Error {
  constructor(message, line, col, snippet) {
    super(message);
    this.name = 'ParseError';
    this.line = line;
    this.col = col;
    this.snippet = snippet || '';
  }
}

/** Bytes (Buffer or Uint8Array) to text. Handles the UTF-8 BOM and UTF-16 with a BOM. */
function decode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  const start = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8').decode(b.subarray(start));
}

/**
 * Removes // and block comments and trailing commas outside strings. Each removed character becomes a space
 * (newlines stay), so positions in the result match the original text for error messages.
 * Returns {text, comments, commas}.
 */
function stripJsonc(src) {
  const n = src.length;
  let out = null; // array of chars, only made when something changes
  let comments = 0, commas = 0;
  const blank = (from, to) => {
    if (!out) out = src.split('');
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  let i = 0;
  let lastComma = -1; // position of a comma that may be trailing
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 34) { // "
      lastComma = -1;
      i++;
      while (i < n) {
        const d = src.charCodeAt(i);
        if (d === 92) { i += 2; continue; }
        i++;
        if (d === 34) break;
      }
      continue;
    }
    if (c === 47 && i + 1 < n) { // /
      const d = src.charCodeAt(i + 1);
      if (d === 47) {
        let j = i + 2;
        while (j < n && src.charCodeAt(j) !== 10) j++;
        blank(i, j); comments++; i = j; continue;
      }
      if (d === 42) {
        const end = src.indexOf('*/', i + 2);
        const j = end < 0 ? n : end + 2;
        blank(i, j); comments++; i = j; continue;
      }
    }
    if (c === 44) { lastComma = i; i++; continue; }
    if (c === 93 || c === 125) { // ] }
      if (lastComma >= 0) { blank(lastComma, lastComma + 1); commas++; }
      lastComma = -1; i++; continue;
    }
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) lastComma = -1;
    i++;
  }
  return { text: out ? out.join('') : src, comments, commas };
}

function lineCol(text, pos) {
  let line = 1, last = -1;
  for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) { line++; last = i; }
  return { line, col: pos - last };
}

function snippetAt(text, line) {
  const lines = [];
  let start = 0, ln = 1;
  // walk only to the needed line
  while (ln < line - 1 && start < text.length) { const nl = text.indexOf('\n', start); if (nl < 0) break; start = nl + 1; ln++; }
  for (let k = 0; k < 3 && start <= text.length; k++) {
    const nl = text.indexOf('\n', start);
    const s = text.slice(start, nl < 0 ? text.length : nl);
    lines.push(`${String(ln).padStart(5)} | ${s.length > 160 ? s.slice(0, 160) + '…' : s}`);
    if (nl < 0) break;
    start = nl + 1; ln++;
  }
  return lines.join('\n');
}

/** Turns a JSON.parse error into a ParseError with line and column (positions are V8 style). */
function toParseError(e, text) {
  const msg = String(e && e.message || e);
  let pos = -1;
  const m = msg.match(/at position (\d+)/) || msg.match(/position (\d+)/);
  if (m) pos = Number(m[1]);
  else if (/Unexpected end of JSON input/.test(msg)) pos = text.length;
  const lc = msg.match(/\(line (\d+) column (\d+)\)/);
  let line, col;
  if (lc) { line = Number(lc[1]); col = Number(lc[2]); }
  else if (pos >= 0) ({ line, col } = lineCol(text, pos));
  const clean = msg.replace(/^JSON5?: /, '').replace(/\s*in JSON at position \d+.*$/, '').replace(/,? ?"[^"]{40,}"/, '').trim();
  return new ParseError(clean || 'Not valid JSON', line || 0, col || 0, line ? snippetAt(text, line) : '');
}

/**
 * Parses text as JSON, then JSONC, then JSON5. Returns {value, mode, notes}.
 * mode: 'json' | 'jsonc' | 'json5'. Throws ParseError with line and column.
 */
function parseText(text, ext) {
  const r = parseLoose(text, ext);
  r.big = 0;
  // Second pass only when the text may hold a number JavaScript would round (64-bit IDs and the like).
  if ((r.mode === 'json' || r.mode === 'jsonc') && maybeBig(text)) {
    if (!canKeepExact()) r.bigUnsupported = true;
    else {
      try {
        const x = parseExact(r.mode === 'jsonc' ? stripJsonc(text).text : text);
        if (x.big) { r.value = x.value; r.big = x.big; }
      } catch { /* keep the first result */ }
    }
  }
  return r;
}

function parseLoose(text, ext) {
  if (!/\S/.test(text)) throw new ParseError('The file is empty.', 0, 0, '');
  const json5First = /^\.?json5$/i.test(ext || '');
  if (!json5First) {
    try { return { value: JSON.parse(text), mode: 'json', notes: [] }; } catch { /* try JSONC next */ }
  }
  const st = stripJsonc(text);
  let jsoncError = null;
  if (st.text !== text || json5First) {
    try {
      const value = JSON.parse(st.text);
      const notes = [];
      if (st.comments) notes.push(`${st.comments} comment${st.comments === 1 ? '' : 's'}`);
      if (st.commas) notes.push(`${st.commas} trailing comma${st.commas === 1 ? '' : 's'}`);
      return { value, mode: notes.length ? 'jsonc' : 'json', notes };
    } catch (e) { jsoncError = e; }
  } else {
    try { JSON.parse(text); } catch (e) { jsoncError = e; }
  }
  if (text.length <= JSON5_MAX_CHARS) {
    try { return { value: JSON5.parse(text), mode: 'json5', notes: ['read as JSON5'] }; } catch (e5) {
      if (json5First && e5 && e5.lineNumber) {
        const line = e5.lineNumber, col = e5.columnNumber;
        throw new ParseError(String(e5.message).replace(/^JSON5: /, '').replace(/ at \d+:\d+$/, ''), line, col, snippetAt(text, line));
      }
    }
  }
  throw toParseError(jsoncError, text); // stripJsonc keeps positions, so the original text gives the right line
}

module.exports = { decode, stripJsonc, parseText, ParseError, lineCol, toParseError, JSON5_MAX_CHARS };
