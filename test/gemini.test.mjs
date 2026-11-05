// test/gemini.test.mjs — organ 6: a finished Gemini CLI session imported as a process record. A reply becomes a model
// call and each of its tool calls a tool use, in order, by name and time; a message written again replaces the earlier
// version in its place; a $set of messages replaces the list; the intent says none was sealed, so P1 fails; garbage is
// counted or ignored, never thrown. The session below is synthetic, in the format as found; no real session is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagesOf, eventsOfGemini, importGemini } from '../src/gemini.mjs';
import { NONE_SEALED } from '../src/transcript.mjs';
import { assessStrict } from '../src/judge.mjs';
import { factsOf, SCHEMA } from '../src/record.mjs';
import { schemaCheck } from '../src/schema.mjs';

const T = (s) => '2026-07-10T13:18:' + s + '.000Z';
const L = (o) => JSON.stringify(o);
const SESSION = [
  L({ sessionId: 's-1', projectHash: 'p', startTime: T('00'), lastUpdated: T('00'), kind: 'main' }),
  L({ $set: { messages: [{ id: 'ctx', timestamp: T('00'), type: 'user', content: [{ text: 'context' }] }], lastUpdated: T('00') } }),
  L({ id: 'u1', timestamp: T('01'), type: 'user', content: [{ text: 'read the file' }] }),
  L({ $set: { lastUpdated: T('01') } }),
  L({ id: 'g1', timestamp: T('02'), type: 'gemini', content: '', thoughts: [], tokens: { input: 1, output: 1 }, model: 'gemini-x' }),
  L({ $set: { lastUpdated: T('02') } }),
  L({ id: 'g1', timestamp: T('02'), type: 'gemini', content: '', model: 'gemini-x', toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'a' }, status: 'success', timestamp: T('03') }] }),
  L({ id: 'u2', timestamp: T('04'), type: 'user', content: [{ functionResponse: {} }] }),
  L({ id: 'g2', timestamp: T('05'), type: 'gemini', content: 'done', model: 'gemini-y', toolCalls: [{ id: 't2', name: 'grep_search', status: 'error', timestamp: T('06') }, { id: 't3', name: 'grep_search', status: 'success', timestamp: T('07') }] }),
].join('\n') + '\n';
const WANT = [{ kind: 'model_call', at: T('02'), model: 'gemini-x' }, { kind: 'tool_use', at: T('03'), tool: 'read_file' }, { kind: 'model_call', at: T('05'), model: 'gemini-y' },
  { kind: 'tool_use', at: T('06'), tool: 'grep_search' }, { kind: 'tool_use', at: T('07'), tool: 'grep_search' }];

test('a reply is a model call, each of its tool calls a tool use, in order; a message written again replaces its earlier version in place', () => {
  const m = messagesOf(SESSION);
  assert.deepEqual(m.messages.map((x) => x.id), ['ctx', 'u1', 'g1', 'u2', 'g2']);
  assert.equal(m.messages[2].toolCalls.length, 1, 'the later version of g1');
  assert.deepEqual([m.sessionId, m.counts], ['s-1', { lines: 9, unreadable: 0 }]);
  const e = eventsOfGemini(SESSION);
  assert.deepEqual(e.events, WANT);
  assert.deepEqual(e.counts, { lines: 9, unreadable: 0, messages: 5, requests: 2, toolUses: 3 });
  assert.equal(e.last, T('07'));
  const replaced = messagesOf(SESSION + L({ $set: { messages: [{ id: 'g2', type: 'gemini', timestamp: T('05') }, null, {}, { id: 5 }, { id: ' ' }] } }));
  assert.deepEqual(replaced.messages.map((x) => x.id), ['g2'], 'a $set of messages replaces the list');
  assert.equal(messagesOf(L({ sessionId: 'a' }) + '\n' + L({ sessionId: 'b' })).sessionId, 'a', 'the first session id');
  assert.equal(messagesOf('x\n' + L({ sessionId: 5 }) + '\n' + L({ sessionId: 'b' })).sessionId, 'b');
});

test('the import: a record of the gemini-cli harness that fits the strict schema, and an intent that says none was sealed, so P1 fails', async () => {
  const { record, counts } = await importGemini(SESSION);
  assert.equal(record.schema, SCHEMA); assert.deepEqual(record.harness, { name: 'gemini-cli' });
  assert.deepEqual([record.job_id, record.member_id], ['s-1', 'anonymous']);
  assert.deepEqual(record.timeline.map(({ seq, ...e }) => e), WANT); assert.deepEqual(record.models, ['gemini-x', 'gemini-y']);
  assert.equal(record.intent.goal, NONE_SEALED); assert.equal(record.intent.sealed_at, '2026-07-10T13:18:07.001Z');
  assert.equal(counts.toolUses, 3);
  assert.equal(schemaCheck(record).outcome, 'pass', schemaCheck(record).why);
  const j = assessStrict(record, await factsOf(record));
  assert.equal(j.results.find((r) => r.id === 'P0').outcome, 'pass');
  assert.equal(j.results.find((r) => r.id === 'P1').outcome, 'fail');
  assert.deepEqual([(await importGemini(SESSION, { job_id: 'mine', member_id: 'me' })).record.job_id, (await importGemini(SESSION, { job_id: 'mine', member_id: 'me' })).record.member_id], ['mine', 'me']);
  assert.equal((await importGemini(SESSION.split('\n').slice(1).join('\n'))).record.job_id, 'imported');
  assert.equal((await importGemini(SESSION, null)).record.job_id, 's-1');
  const one = L({ id: 'g', timestamp: T('09'), type: 'gemini', model: 'm' });
  const r1 = (await importGemini(one)).record;
  assert.equal(r1.intent.sealed_at, '2026-07-10T13:18:09.001Z');
  assert.equal(assessStrict(r1, await factsOf(r1)).results.find((r) => r.id === 'P1').outcome, 'fail', 'sealed after the one reply, not before it');
});

test('garbage is counted or ignored, never thrown; times and names of the wrong type fall back', async () => {
  const junk = ['not json', '5', '"s"', 'null', '[1]', L({ id: 'x', type: 'system' }), L({ type: 'user' }), L({ id: 7, type: 'gemini' }), L({ $set: 5 }), L({ $set: { messages: 5 } }),
    L({ id: 'g', type: 'gemini', timestamp: 2020, toolCalls: [null, {}, { name: 5 }, { name: ' ' }, { name: 'ok', timestamp: 'later' }] }), '   '];
  const e = eventsOfGemini(junk.join('\n'));
  assert.deepEqual(e.counts, { lines: 11, unreadable: 5, messages: 1, requests: 1, toolUses: 1 });
  assert.deepEqual(e.events, [{ kind: 'model_call', at: '1970-01-01T00:00:00.000Z', model: 'unknown' }, { kind: 'tool_use', at: '1970-01-01T00:00:00.000Z', tool: 'ok' }]);
  assert.equal(e.sessionId, null);
  for (const g of [undefined, null, 5, {}, [], '', '\n\n']) {
    const r = await importGemini(g);
    assert.equal(r.record.timeline.length, 0); assert.equal(r.record.job_id, 'imported');
    assert.doesNotThrow(() => assessStrict(r.record, {}));
  }
  const t = eventsOfGemini(L({ id: 'g', type: 'gemini', timestamp: T('05') }) + '\n' + L({ id: 'h', type: 'user', timestamp: T('09') }));
  assert.equal(t.last, T('09'), 'the latest time in the session, a prompt after the last reply included');
});
