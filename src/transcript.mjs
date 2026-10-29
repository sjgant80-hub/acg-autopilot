// src/transcript.mjs — organ 2: a finished Claude Code job, read from its transcript (one JSON object a line), turned into
// a process record so it can be judged too. Each distinct model request becomes a model call and each tool use a tool
// use, in the transcript's order; side-chain (subagent) lines are left out. A past job sealed no intent, and the record
// says so rather than inventing one: its intent's goal reads "none sealed", recorded just after the job's last line, so
// P1 fails, as it should. Pure apart from the intent's hash; total — a line that cannot be read is skipped and counted.
import { SCHEMA, intentHash } from './record.mjs';
import { toRecord } from './normalise.mjs';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const EPOCH = '1970-01-01T00:00:00.000Z';
export const NONE_SEALED = 'none sealed: imported from a transcript after the job';

/** the main thread's events, in order: { events, counts: { lines, unreadable, sidechain, prompts, requests, toolUses } } */
export function eventsOfTranscript(text) {
  const counts = { lines: 0, unreadable: 0, sidechain: 0, prompts: 0, requests: 0, toolUses: 0 }, events = [], seen = new Set();
  let at = EPOCH, sessionId = null, version = null;
  for (const l of (typeof text === 'string' ? text : '').split('\n')) {
    if (!l.trim()) continue;
    counts.lines++;
    let o;
    try { o = JSON.parse(l); } catch { counts.unreadable++; continue; }
    if (!isObj(o)) { counts.unreadable++; continue; }
    if (o.isSidechain === true) { counts.sidechain++; continue; }
    if (typeof o.timestamp === 'string' && Number.isFinite(Date.parse(o.timestamp))) at = new Date(Date.parse(o.timestamp)).toISOString();
    if (typeof o.sessionId === 'string' && !sessionId) sessionId = o.sessionId;
    if (typeof o.version === 'string' && !version) version = o.version;
    const m = isObj(o.message) ? o.message : {};
    if (o.type === 'user' && typeof m.content === 'string') counts.prompts++;
    if (o.type !== 'assistant') continue;
    const req = typeof o.requestId === 'string' ? o.requestId : 'line-' + counts.lines;
    if (!seen.has(req)) { seen.add(req); counts.requests++; events.push({ kind: 'model_call', at, model: typeof m.model === 'string' && m.model ? m.model : 'unknown' }); }
    for (const c of Array.isArray(m.content) ? m.content : []) if (isObj(c) && c.type === 'tool_use' && typeof c.name === 'string' && c.name) { counts.toolUses++; events.push({ kind: 'tool_use', at, tool: c.name }); }
  }
  return { events, counts, sessionId, version, last: at };
}

/** importTranscript(text, { job_id, member_id }) → { record, counts } */
export async function importTranscript(text, opts = {}) {
  const t = eventsOfTranscript(text), o = isObj(opts) ? opts : {};
  const intent = { goal: NONE_SEALED, constraints: [], success_criteria: [], allowed_tools: [], out_of_scope: [], sealed_at: new Date(Date.parse(t.last) + 1).toISOString() };
  intent.hash = await intentHash(intent);
  const record = toRecord({ job_id: o.job_id || t.sessionId || 'imported', member_id: o.member_id || 'anonymous', harness: { name: 'claude-code', ...(t.version ? { version: t.version } : {}) }, intent, events: t.events });
  return { record: { ...record, schema: SCHEMA }, counts: t.counts };
}
