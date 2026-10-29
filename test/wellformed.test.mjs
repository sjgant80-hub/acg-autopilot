// test/wellformed.test.mjs — organ 1b: P0 passes a well-formed record and fails each kind of malformation, naming it;
// assess() is P0 then the ten checks, P0 can fail, and the queue is exactly the flags; judge() is unchanged (rubric v1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wellFormed, assess, judge, RUBRIC_V2, RUBRIC, MIN_SUMMARY_WORDS, CHECKS } from '../src/judge.mjs';
import { SCHEMA } from '../src/record.mjs';

function rec() {
  return { schema: SCHEMA, job_id: 'j', harness: { name: 'claude-code' },
    timeline: [{ seq: 0, at: '2026-10-29T10:00:00Z', kind: 'model_call' }, { seq: 2, at: '2026-10-29T10:00:01Z', kind: 'tool_use', tool: 'read' }],
    artifacts: [{ id: 'a' }], claims: [{ id: 'c' }], summary: 'the agent read the file twice' };
}
const edit = (f) => { const r = rec(); f(r); return r; };
const why = (r) => wellFormed(r).why;

test('a well-formed record passes P0', () => {
  assert.deepEqual(wellFormed(rec()), { outcome: 'pass', why: 'the record is well-formed', evidence: [] });
  assert.equal(MIN_SUMMARY_WORDS, 5);
});

test('each malformation fails P0, and says which', () => {
  for (const x of [null, 'x', [], 3]) assert.deepEqual(wellFormed(x), { outcome: 'fail', why: 'not a record', evidence: [] });
  assert.match(why(edit((r) => { r.schema = 'other'; })), /schema is not acg-autopilot.process-record\/1/);
  assert.match(why(edit((r) => { r.job_id = '  '; })), /no job id/);
  for (const h of [undefined, 'cc', { name: '' }, { version: 1 }]) assert.match(why(edit((r) => { r.harness = h; })), /does not name its harness/);
  assert.match(why(edit((r) => { r.timeline = {}; })), /no timeline/);
  assert.match(why(edit((r) => { r.artifacts = 'x'; })), /artifacts are not a list/);
  assert.match(why(edit((r) => { r.artifacts = [{ id: ' ' }]; })), /artifacts are not a list/);
  assert.match(why(edit((r) => { r.claims = [null]; })), /claims are not a list/);
  assert.match(why(edit((r) => { r.summary = 'four words only here'; })), /summary is under 5 words/);
  assert.equal(wellFormed(edit((r) => { r.summary = 'five words are now here'; })).outcome, 'pass');
  assert.match(why(edit((r) => { r.summary = 'x DROP TABLE'; })), /under 5 words/);
  assert.match(why(edit((r) => { r.schema = 'x'; r.job_id = ''; })), /schema is not .*; it has no job id/);
});

test('timeline entries: unknown kind, no seq, a seq out of order or repeated, no time, not an object — each counted and pointed at', () => {
  const one = (e, k = 1) => { const w = wellFormed(edit((r) => { r.timeline[k] = e; })); return [w.outcome, w.why, w.evidence]; };
  assert.deepEqual(one({ seq: 2, at: '2026-10-29T10:00:01Z', kind: 'dance' }), ['fail', 'the record is not well-formed: 1 timeline entry not of a known kind, with a seq in order and a time', [{ at: 'timeline', seq: 2 }]]);
  assert.deepEqual(one({ seq: 'x', at: '2026-10-29T10:00:01Z', kind: 'tool_use' })[2], [{ at: 'timeline', index: 1 }]);
  assert.equal(one({ seq: 0, at: '2026-10-29T10:00:01Z', kind: 'tool_use' })[0], 'fail', 'a repeated seq');
  assert.equal(one({ seq: 2, at: 'soon', kind: 'tool_use' })[0], 'fail');
  assert.deepEqual(one('x')[2], [{ at: 'timeline', index: 1 }]);
  assert.equal(one({ seq: 1, at: '2026-10-29T10:00:01Z', kind: 'tool_use' })[0], 'pass', 'a gap in seq is fine; order is what counts');
  const two = wellFormed(edit((r) => { r.timeline.push(null, { kind: 'x' }); }));
  assert.match(two.why, /2 timeline entries/); assert.equal(two.evidence.length, 2);
  assert.equal(wellFormed(edit((r) => { r.timeline = []; })).outcome, 'pass', 'an empty timeline is well-formed');
  assert.equal(one({ seq: -1, at: '2026-10-29T10:00:01Z', kind: 'tool_use' }, 0)[0], 'fail', 'a seq counts from 0');
  assert.equal(one({ seq: 0, at: '2026-10-29T10:00:01Z', kind: 'tool_use' }, 0)[0], 'pass');
});

test('assess: P0 then the ten, P0 can fail, the queue is exactly the flags; judge() is still rubric v1', () => {
  const a = assess(edit((r) => { r.summary = 'x'; }), { intentHashOk: true });
  assert.equal(a.rubric, 'acg-autopilot.rubric/p0-p10/v2'); assert.equal(RUBRIC_V2.judgement, RUBRIC.judgement);
  assert.deepEqual(a.results.map((x) => x.id), ['P0', ...Object.keys(CHECKS)]);
  assert.equal(a.results[0].outcome, 'fail'); assert.equal(a.results[0].judgement, false);
  assert.deepEqual(a.review, a.results.filter((x) => x.outcome === 'flag').map((x) => x.id));
  assert.equal(a.counts.pass + a.counts.flag + a.counts.fail, 11);
  assert.equal(a.counts.fail, a.results.filter((x) => x.outcome === 'fail').length);
  assert.equal(a.job_id, 'j');
  const j = judge(rec(), {});
  assert.equal(j.rubric, 'acg-autopilot.rubric/p1-p10/v1'); assert.equal(j.results.length, 10);
  assert.deepEqual(a.results.slice(1), judge(edit((r) => { r.summary = 'x'; }), { intentHashOk: true }).results);
  assert.equal(assess(rec()).results[0].outcome, 'pass');
  assert.deepEqual(assess(null).results[0], { id: 'P0', outcome: 'fail', why: 'not a record', evidence: [], judgement: false });
  const bad = { get schema() { throw new Error('boom'); } };
  assert.equal(assess(bad).results[0].why, 'the record could not be read');
});
