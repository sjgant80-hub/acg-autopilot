// src/gemini.mjs — organ 6: a second harness (claims/organ-6.json). A finished Gemini CLI session, read from its saved
// chat file (one JSON object a line), turned into a process record so it can be judged like any other. The format as
// found: a header line ({ sessionId, projectHash, startTime, lastUpdated, kind }); lines { $set: { … } } that update the
// session, where a $set of messages replaces the list; and message lines ({ id, timestamp, type: user | gemini,
// content, and on a reply its model and toolCalls: [{ id, name, status, timestamp, … }] }). A message written again with
// the same id replaces the earlier version in its place: that is how a reply gains its tool calls. Each reply becomes a
// model call and each of its tool calls a tool use, by name and time; arguments and results are not kept. A past
// session sealed no intent, and the record says so, as organ 2's import does. Pure apart from the intent's hash; total.
import { SCHEMA, intentHash } from './record.mjs';
import { toRecord } from './normalise.mjs';
import { NONE_SEALED } from './transcript.mjs';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const named = (s) => typeof s === 'string' && s.trim() !== '';
const EPOCH = '1970-01-01T00:00:00.000Z';
const iso = (s, was) => (typeof s === 'string' && Number.isFinite(Date.parse(s)) ? new Date(Date.parse(s)).toISOString() : was);

/** the session's messages as last written, in order: { messages, counts: { lines, unreadable }, sessionId } */
export function messagesOf(text) {
  const counts = { lines: 0, unreadable: 0 }, byId = new Map();
  let sessionId = null;
  for (const l of (typeof text === 'string' ? text : '').split('\n')) {
    if (!l.trim()) continue;
    counts.lines++;
    let o;
    try { o = JSON.parse(l); } catch { counts.unreadable++; continue; }
    if (!isObj(o)) { counts.unreadable++; continue; }
    if (sessionId === null && named(o.sessionId)) sessionId = o.sessionId;
    if (isObj(o.$set) && Array.isArray(o.$set.messages)) { byId.clear(); for (const m of o.$set.messages) if (isObj(m) && named(m.id)) byId.set(m.id, m); }
    else if (named(o.id) && ['user', 'gemini'].includes(o.type)) byId.set(o.id, o);
  }
  return { messages: [...byId.values()], counts, sessionId };
}

/** the events, in order: a model call per reply, then a tool use per tool call; and the latest time in the session */
export function eventsOfGemini(text) {
  const { messages, counts, sessionId } = messagesOf(text), events = [];
  let at = EPOCH;
  for (const m of messages) {
    at = iso(m.timestamp, at);
    if (m.type !== 'gemini') continue;
    events.push({ kind: 'model_call', at, model: named(m.model) ? m.model : 'unknown' });
    for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) if (isObj(c) && named(c.name)) { at = iso(c.timestamp, at); events.push({ kind: 'tool_use', at, tool: c.name }); }
  }
  const requests = events.filter((e) => e.kind === 'model_call').length;
  return { events, counts: { ...counts, messages: messages.length, requests, toolUses: events.length - requests }, sessionId, last: [EPOCH, at, ...events.map((e) => e.at)].sort().pop() };
}

/** importGemini(text, { job_id, member_id }) → { record, counts } */
export async function importGemini(text, opts = {}) {
  const t = eventsOfGemini(text), o = isObj(opts) ? opts : {};
  const intent = { goal: NONE_SEALED, constraints: [], success_criteria: [], allowed_tools: [], out_of_scope: [], sealed_at: new Date(Date.parse(t.last) + 1).toISOString() };
  intent.hash = await intentHash(intent);
  const record = toRecord({ job_id: o.job_id || t.sessionId || 'imported', member_id: o.member_id || 'anonymous', harness: { name: 'gemini-cli' }, intent, events: t.events });
  return { record: { ...record, schema: SCHEMA }, counts: t.counts };
}

// ── organ 6b (claims/organ-6b.json): a record with no model call cannot show an intent sealed before its work, because
// there is no work for it to come before, so P1 would pass on nothing. The command line refuses to import such a job.
/** nothingToJudge(record) → true when the record holds no model call (or is not a record with a timeline) */
export const nothingToJudge = (record) => !(isObj(record) && Array.isArray(record.timeline) && record.timeline.some((e) => isObj(e) && e.kind === 'model_call'));
