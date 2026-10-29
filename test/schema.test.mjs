// test/schema.test.mjs — organ 1c: the strict schema passes a whole record and fails each wrong field, naming it; each
// entry's fields are typed by its kind; assessStrict() is the strict P0 then the ten checks; garbage never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schemaCheck, entryProblems, BY, POINTER_AT, MIN_WORDS, FIELD, REQUIRED } from '../src/schema.mjs';
import { assessStrict, judge, RUBRIC_V3, CHECKS } from '../src/judge.mjs';
import { SCHEMA, KINDS } from '../src/record.mjs';

const H = 'c'.repeat(64);
function rec() {
  return { schema: SCHEMA, job_id: 'j', member_id: 'm', harness: { name: 'cc', version: '1' }, models: ['m'],
    intent: { goal: 'g', constraints: [], success_criteria: ['s'], allowed_tools: ['read'], out_of_scope: [], sealed_at: '2026-10-29T10:00:00Z', hash: H },
    timeline: [
      { seq: 0, at: '2026-10-29T10:00:01Z', kind: 'model_call', model: 'm' },
      { seq: 1, at: '2026-10-29T10:00:02Z', kind: 'question', text: 'q' },
      { seq: 2, at: '2026-10-29T10:00:03Z', kind: 'answer', by: 'human', to: 1, text: 'a' },
      { seq: 3, at: '2026-10-29T10:00:04Z', kind: 'assumption', text: 'x', surfaced: true, basis: 'answer', answer: 2 },
      { seq: 4, at: '2026-10-29T10:00:05Z', kind: 'tool_use', tool: 'read' },
      { seq: 5, at: '2026-10-29T10:00:06Z', kind: 'approval', by: 'human', tool: 'db' },
      { seq: 6, at: '2026-10-29T10:00:07Z', kind: 'intervention', by: 'human', refers_to: 4 },
      { seq: 7, at: '2026-10-29T10:00:08Z', kind: 'rerun', result: 'match' },
      { seq: 8, at: '2026-10-29T10:00:09Z', kind: 'verification', by: 'independent', target: 'c1', method: 'm' },
      { seq: 9, at: '2026-10-29T10:00:10Z', kind: 'accept', by: 'human' },
    ],
    artifacts: [{ id: 'o', role: 'output', sha256: H, stored: true }],
    claims: [{ id: 'c1', text: 't', evidence: [{ at: 'artifacts', id: 'o' }, { at: 'timeline', seq: 4 }, { at: 'intent', field: 'goal' }, { at: 'summary' }, { at: 'claims', id: 'c1' }], criterion: 's' }],
    summary: 'the agent read the file once' };
}
const edit = (f) => { const r = rec(); f(r); return r; };
const fails = (f, re) => { const s = schemaCheck(edit(f)); assert.equal(s.outcome, 'fail', String(f)); if (re) assert.match(s.why, re); return s; };

test('a whole record fits; the constants are what the seal says', () => {
  assert.deepEqual(schemaCheck(rec()), { outcome: 'pass', why: 'the record fits schema v1, field by field', evidence: [], problems: [] });
  assert.deepEqual([...BY], ['human', 'agent', 'independent']); assert.deepEqual([...POINTER_AT], ['timeline', 'artifacts', 'claims', 'intent', 'summary']); assert.equal(MIN_WORDS, 5);
  assert.deepEqual(Object.keys(REQUIRED).sort(), [...KINDS].sort());
  assert.equal(schemaCheck(edit((r) => { delete r.harness.version; r.extra = 1; r.timeline[0].note = 'x'; delete r.claims[0].criterion; })).outcome, 'pass', 'optional fields may be absent; unknown extras are allowed');
});

test('the record’s own fields, each wrong in turn', () => {
  for (const x of [null, 'x', [], 1]) assert.deepEqual(schemaCheck(x), { outcome: 'fail', why: 'not a record', evidence: [], problems: ['not a record'] });
  fails((r) => { r.schema = 'v0'; }, /schema is not/);
  fails((r) => { r.job_id = ''; }, /job_id is not a name/); fails((r) => { r.member_id = { a: 1 }; }, /member_id is not a name/); fails((r) => { delete r.member_id; }, /member_id/);
  for (const h of [undefined, 'cc', { name: ' ' }, { name: 'cc', version: 2 }]) fails((r) => { r.harness = h; }, /harness/);
  for (const m of [undefined, 'm', [1], ['']]) fails((r) => { r.models = m; }, /models/);
  fails((r) => { r.intent = []; }, /intent is missing/);
  fails((r) => { r.intent.goal = ''; }, /goal/);
  for (const f of ['constraints', 'success_criteria', 'allowed_tools', 'out_of_scope']) { fails((r) => { r.intent[f] = 'x'; }, new RegExp('intent ' + f)); fails((r) => { r.intent[f] = [1]; }, new RegExp(f)); }
  fails((r) => { r.intent.sealed_at = 'later'; }, /sealed_at/);
  for (const h of ['x', 'C'.repeat(64), 7]) fails((r) => { r.intent.hash = h; }, /hash/);
  fails((r) => { r.timeline = {}; }, /timeline is not a list/);
  fails((r) => { r.artifacts = null; }, /artifacts is not a list/); fails((r) => { r.claims = 'x'; }, /claims is not a list/);
  for (const s of [undefined, 3, 'four words only here']) fails((r) => { r.summary = s; }, /summary is under 5 words/);
  assert.equal(schemaCheck(edit((r) => { r.summary = 'five words are here now'; })).outcome, 'pass', 'exactly five words is enough');
});

test('artifacts and claims, field by field', () => {
  for (const a of [null, { role: 'output', sha256: H, stored: true }, { id: 'o', role: 'log', sha256: H, stored: true }, { id: 'o', role: 'input', sha256: 1, stored: true }, { id: 'o', role: 'input', sha256: H, stored: 'yes' }]) {
    const s = fails((r) => { r.artifacts = [a]; }, /artifact #0/); assert.deepEqual(s.evidence, [{ at: 'artifacts', index: 0 }]);
  }
  const ptrs = [null, { at: 'elsewhere' }, { at: 'timeline', seq: 'x' }, { at: 'timeline', seq: -1 }, { at: 'artifacts' }, { at: 'claims', id: '' }, { at: 'intent' }];
  for (const p of ptrs) fails((r) => { r.claims[0].evidence = [p]; }, /claim #0/);
  for (const f of [(c) => { c.id = 1; }, (c) => { c.text = null; }, (c) => { c.evidence = 'x'; }, (c) => { c.criterion = 4; }]) {
    const s = fails((r) => f(r.claims[0]), /claim #0/); assert.deepEqual(s.evidence, [{ at: 'claims', index: 0 }]);
  }
  fails((r) => { r.claims = [1]; }, /claim #0/);
});

test('timeline entries: their place, their time, their kind, and their kind’s fields', () => {
  assert.deepEqual(entryProblems(null, -1), ['not an entry']);
  assert.deepEqual(entryProblems({ seq: 0, at: 'x', kind: 'dance' }, -1), ['no time', 'an unknown kind']);
  assert.deepEqual(entryProblems({ seq: 'a', at: '2026-10-29T10:00:00Z', kind: 'accept', by: 'human' }, -1), ['seq is not a whole number from 0']);
  assert.deepEqual(entryProblems({ seq: 3, at: '2026-10-29T10:00:00Z', kind: 'accept', by: 'human' }, 3), ['seq 3 does not rise']);
  assert.deepEqual(entryProblems({ seq: 4, at: '2026-10-29T10:00:00Z', kind: 'accept', by: 'human' }, 3), []);
  for (const k of KINDS) for (const f of REQUIRED[k]) {
    const e = { ...rec().timeline.find((x) => x.kind === k) }; delete e[f];
    assert.ok(entryProblems(e, -1).includes(k + ' without ' + f), k + '.' + f);
  }
  const wrong = { model: '', text: 1, by: 'robot', to: -1, surfaced: 'yes', basis: 'hunch', answer: 1.5, tool: '', refers_to: 'x', target: '', method: 2, result: '' };
  for (const [f, v] of Object.entries(wrong)) assert.ok(entryProblems({ seq: 0, at: '2026-10-29T10:00:00Z', kind: 'accept', by: 'human', [f]: v }, -1).includes(f + ' of the wrong type'), f);
  assert.deepEqual(Object.keys(FIELD).sort(), Object.keys(wrong).sort());
  assert.ok(entryProblems({ seq: 0, at: '2026-10-29T10:00:00Z', kind: 'assumption', text: 't', surfaced: true, basis: 'answer' }, -1).includes('an assumption on an answer that names none'));
  assert.deepEqual(entryProblems({ seq: 0, at: '2026-10-29T10:00:00Z', kind: 'assumption', text: 't', surfaced: true, basis: 'intent' }, -1), []);
  const s = fails((r) => { r.timeline[1].by = 'x'; r.timeline.push(7); }, /timeline entry 1: by of the wrong type; timeline entry #10: not an entry/);
  assert.deepEqual(s.evidence, [{ at: 'timeline', seq: 1 }, { at: 'timeline', index: 10 }]);
  const order = schemaCheck(edit((r) => { r.timeline[2].seq = 0; }));
  assert.match(order.why, /entry 0: seq 0 does not rise/);
  assert.equal(schemaCheck(edit((r) => { r.timeline[2].seq = 0; })).problems.length, 1, 'a later entry is judged against the last good seq');
});

test('many problems are counted; assessStrict is the strict P0 then the ten', () => {
  const s = schemaCheck({ schema: 'x', timeline: 'x' });
  assert.match(s.why, /; and \d+ more$/); assert.ok(s.problems.length > 6);
  const six = schemaCheck(edit((r) => { r.schema = 'x'; r.job_id = ''; r.member_id = ''; r.models = 1; r.timeline = 1; r.artifacts = 1; }));
  assert.equal(six.problems.length, 6); assert.doesNotMatch(six.why, /more$/, 'six problems are all listed');
  const seven = schemaCheck(edit((r) => { r.schema = 'x'; r.job_id = ''; r.member_id = ''; r.models = 1; r.timeline = 1; r.artifacts = 1; r.claims = 1; }));
  assert.match(seven.why, /; and 1 more$/);
  const a = assessStrict(rec(), { intentHashOk: true });
  assert.equal(a.rubric, 'acg-autopilot.rubric/p0-strict-p10/v3'); assert.equal(RUBRIC_V3.judgement.length, 4);
  assert.deepEqual(a.results.map((x) => x.id), ['P0', ...Object.keys(CHECKS)]);
  assert.equal(a.results[0].outcome, 'pass'); assert.deepEqual(a.results.slice(1), judge(rec(), { intentHashOk: true }).results);
  const b = assessStrict(edit((r) => { r.member_id = 3; }), {});
  assert.equal(b.results[0].outcome, 'fail'); assert.match(b.results[0].why, /member_id/); assert.equal(b.results[0].judgement, false);
  assert.deepEqual(b.review, b.results.filter((x) => x.outcome === 'flag').map((x) => x.id));
  assert.equal(b.counts.pass + b.counts.flag + b.counts.fail, 11); assert.equal(b.job_id, 'j');
  assert.equal(assessStrict({ get schema() { throw new Error('x'); } }).results[0].why, 'the record could not be read');
});

test('garbage never throws', () => {
  const junk = [undefined, null, 0, 'x', [], {}, { timeline: [null, 1, 'x', {}] }, { claims: [{}], artifacts: [{}] }, { intent: { goal: 1 } }, Object.create(null)];
  for (const j of junk) { assert.doesNotThrow(() => schemaCheck(j)); assert.doesNotThrow(() => assessStrict(j)); assert.equal(schemaCheck(j).outcome, 'fail'); }
});
