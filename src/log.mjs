// src/log.mjs — organ 2: the job's log. One JSON object a line, append-only; every line carries the hash of the line
// before it (prev) and its own (hash, over prev and its content), so changing, removing or reordering any line breaks
// the chain from there on. Pure apart from the hash (the platform's SHA-256, so async); total: garbage is answered.
import { canonical, sha256hex } from './record.mjs';

export const GENESIS = '0'.repeat(64);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** the line to append after `prev`: the event, prev, and the hash of both */
export async function link(prev, event) {
  const ev = isObj(event) ? Object.fromEntries(Object.entries(event).filter(([k]) => k !== 'prev' && k !== 'hash')) : {};
  return { ...ev, prev, hash: await sha256hex(prev + '|' + canonical(ev)) };
}

/** parse a log's text: one object a line; a line that is not an object is an error at its index */
export function parseLog(text) {
  if (typeof text !== 'string') return { error: 'not text', at: -1 };
  const lines = [];
  for (const [i, l] of text.split('\n').entries()) {
    if (!l.trim()) continue;
    let o;
    try { o = JSON.parse(l); } catch { return { error: 'line ' + i + ' is not JSON', at: i }; }
    if (!isObj(o)) return { error: 'line ' + i + ' is not an object', at: i };
    lines.push(o);
  }
  return { lines };
}

/** verifyLog(lines) → { ok, head, length } or { ok: false, at, why } */
export async function verifyLog(lines) {
  if (!Array.isArray(lines)) return { ok: false, at: -1, why: 'not a list of lines' };
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!isObj(l)) return { ok: false, at: i, why: 'line ' + i + ' is not an object' };
    if (l.prev !== prev) return { ok: false, at: i, why: 'line ' + i + ' does not follow the line before it' };
    const { prev: p, hash, ...ev } = l;
    if (hash !== await sha256hex(prev + '|' + canonical(ev))) return { ok: false, at: i, why: 'line ' + i + ' has been changed' };
    prev = hash;
  }
  return { ok: true, head: prev, length: lines.length };
}

/** the events of a log, without their chain fields */
export const eventsOf = (lines) => (Array.isArray(lines) ? lines.filter(isObj).map(({ prev, hash, ...ev }) => ev) : []);
