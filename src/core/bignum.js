'use strict';
// Numbers that JavaScript cannot hold exactly, such as 64-bit IDs (12345678901234567891) or decimals with
// more than about 17 digits. JSON.parse would round them. With the reviver's source text (V8 11.4 and later,
// so VS Code 1.90 and later) the viewer keeps the digits exactly as the file has them.

class BigNum {
  constructor(src) { this.src = String(src); Object.freeze(this); }
  toString() { return this.src; }
  // JSON.stringify of a parent object writes the digits unchanged where JSON.rawJSON exists.
  toJSON() { return typeof JSON.rawJSON === 'function' ? JSON.rawJSON(this.src) : Number(this.src); }
  valueOf() { return Number(this.src); }
}

const isBig = v => v instanceof BigNum;

/** Canonical form of a decimal literal: sign, significant digits and exponent, e.g. "-12345e-2". Null if not a number. */
function canon(s) {
  const m = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(String(s).trim());
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) return null;
  const sign = m[1];
  const intPart = m[2] || '';
  const frac = m[3] || '';
  let exp = (m[4] ? parseInt(m[4], 10) : 0) - frac.length;
  let digits = (intPart + frac).replace(/^0+/, '');
  if (!digits) return '0';
  const t = digits.match(/0*$/)[0].length;
  if (t) { digits = digits.slice(0, digits.length - t); exp += t; }
  return `${sign}${digits}e${exp}`;
}

/** True when the number JSON.parse produced is not the same number the source text spells out. */
function lossy(value, src) {
  if (typeof value !== 'number' || typeof src !== 'string') return false;
  if (!Number.isFinite(value)) return true;
  const a = canon(src);
  if (a === null) return false;
  const b = canon(String(value));
  return b !== null && a !== b && !(a === '0' && b === '0');
}

/** Cheap check before the slower exact pass: a run of 16+ digits, or an exponent of 3+ digits. Strings can give false hits. */
function maybeBig(text) { return /\d{16}|\d\.\d{15}|[eE][+-]?\d{3}/.test(text); }

let sourceSupported = null;
/** Does this JavaScript engine give revivers the source text? */
function canKeepExact() {
  if (sourceSupported === null) {
    sourceSupported = false;
    try { JSON.parse('1', (k, v, ctx) => { sourceSupported = !!(ctx && ctx.source === '1'); return v; }); } catch { sourceSupported = false; }
  }
  return sourceSupported;
}

/** JSON.parse that keeps lossy numbers as BigNum. Returns {value, big} (big = how many were kept). */
function parseExact(text) {
  let big = 0;
  const value = JSON.parse(text, (k, v, ctx) => {
    if (typeof v === 'number' && ctx && typeof ctx.source === 'string' && lossy(v, ctx.source)) { big++; return new BigNum(ctx.source); }
    return v;
  });
  return { value, big };
}

module.exports = { BigNum, isBig, canon, lossy, maybeBig, canKeepExact, parseExact };
