// test/judge.test.mjs — the judge passes a clean record on all ten checks, and each check catches its own failure with
// pointers to the evidence; judgement items only ever flag; every flag is in the review queue; garbage never throws
// and never passes. (The sealed measurement uses the seeded suite, tools/suite.mjs; these records are hand-written.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, CHECKS, RUBRIC, PLAIN, P6_LIMITS } from '../src/judge.mjs';
import { canonical, intentContent, intentHash, factsOf, resolves, SCHEMA, KINDS, INTENT_FIELDS, list, text, sha256hex } from '../src/record.mjs';

const H = 'a'.repeat(64), H2 = 'b'.repeat(64);
function clean() {
  return {
    schema: SCHEMA, job_id: 'job-1', member_id: 'm-1', harness: { name: 'claude-code', version: '1' }, models: ['m'],
    intent: { goal: 'count the rows in the sales file', constraints: ['read only'], success_criteria: ['row count reported'], allowed_tools: ['read', 'count'], out_of_scope: ['editing'], sealed_at: '2026-10-29T10:00:00.000Z', hash: 'x' },
    timeline: [
      { seq: 0, at: '2026-10-29T10:00:01.000Z', kind: 'model_call', model: 'm' },
      { seq: 1, at: '2026-10-29T10:00:02.000Z', kind: 'question', text: 'which sales file' },
      { seq: 2, at: '2026-10-29T10:00:03.000Z', kind: 'answer', by: 'human', to: 1, text: 'the october file' },
      { seq: 3, at: '2026-10-29T10:00:04.000Z', kind: 'assumption', text: 'the header row is not counted', surfaced: true, basis: 'answer', answer: 2 },
      { seq: 4, at: '2026-10-29T10:00:05.000Z', kind: 'tool_use', tool: 'read' },
      { seq: 5, at: '2026-10-29T10:00:06.000Z', kind: 'tool_use', tool: 'count' },
      { seq: 6, at: '2026-10-29T10:00:07.000Z', kind: 'rerun', result: 'match', text: 'count again' },
      { seq: 7, at: '2026-10-29T10:00:08.000Z', kind: 'verification', by: 'independent', target: 'c1', method: 'count again' },
      { seq: 8, at: '2026-10-29T10:00:09.000Z', kind: 'accept', by: 'human' },
    ],
    artifacts: [{ id: 'in-sales', role: 'input', sha256: H, stored: true }, { id: 'out-count', role: 'output', sha256: H2, stored: true }],
    claims: [{ id: 'c1', text: 'the october file has 120 rows', evidence: [{ at: 'artifacts', id: 'out-count' }, { at: 'timeline', seq: 5 }], criterion: 'row count reported' }],
    summary: 'the agent asked which sales file, read the october file, counted 120 rows, and the count was checked again',
  };
}
const OK = { intentHashOk: true };
const one = (rec, id, facts = OK) => judge(rec, facts).results.find((x) => x.id === id);
const edit = (f) => { const r = clean(); f(r); return r; };

test('a clean record passes all ten, with nothing to review', () => {
  const j = judge(clean(), OK);
  assert.deepEqual(j.results.map((x) => [x.id, x.outcome]), Object.keys(CHECKS).map((id) => [id, 'pass']));
  assert.deepEqual(j.review, []); assert.deepEqual(j.counts, { pass: 10, flag: 0, fail: 0 });
  assert.equal(j.rubric, 'acg-autopilot.rubric/p1-p10/v1'); assert.equal(j.job_id, 'job-1');
  assert.deepEqual(Object.keys(CHECKS), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10']);
  assert.deepEqual([...RUBRIC.judgement], ['P2', 'P4', 'P6', 'P9']);
  assert.deepEqual(j.results.map((x) => x.judgement), [false, true, false, true, false, true, false, false, true, false]);
  assert.match(one(clean(), 'P5').why, /^1 reported number/); assert.match(one(clean(), 'P7').why, /^2 input/); assert.match(one(clean(), 'P8').why, /^1 check/); assert.match(one(clean(), 'P10').why, /^1 re-run/);
  assert.match(one(clean(), 'P9').why, /4 of 4/);
});

test('P1: no intent, no time, late intent, intent at the same moment, a bad hash — each fails; no model call at all passes', () => {
  assert.equal(one(edit((r) => { delete r.intent; }), 'P1').outcome, 'fail');
  assert.equal(one(edit((r) => { r.intent.goal = '  '; }), 'P1').outcome, 'fail');
  assert.equal(one(edit((r) => { r.intent.allowed_tools = 'read'; }), 'P1').outcome, 'fail');
  assert.equal(one(edit((r) => { r.intent.sealed_at = 'yesterday'; }), 'P1').outcome, 'fail');
  const late = one(edit((r) => { r.intent.sealed_at = '2026-10-29T10:00:01.500Z'; }), 'P1');
  assert.equal(late.outcome, 'fail'); assert.match(late.why, /after the first model call \(seq 0\)/); assert.deepEqual(late.evidence, [{ at: 'intent', field: 'goal' }, { at: 'timeline', seq: 0 }]);
  assert.equal(one(edit((r) => { r.intent.sealed_at = '2026-10-29T10:00:01.000Z'; }), 'P1').outcome, 'fail', 'the same moment is not before');
  assert.match(one(clean(), 'P1', { intentHashOk: false }).why, /hash/);
  assert.equal(one(clean(), 'P1', {}).outcome, 'fail'); assert.equal(one(clean(), 'P1', null).outcome, 'fail');
  assert.equal(one(edit((r) => { r.timeline = r.timeline.filter((e) => e.kind !== 'model_call'); }), 'P1').outcome, 'pass');
  assert.deepEqual(one(clean(), 'P1').evidence, [{ at: 'intent', field: 'goal' }, { at: 'timeline', seq: 0 }]);
  assert.deepEqual(one(edit((r) => { delete r.intent; }), 'P1').evidence, [{ at: 'timeline', seq: 0 }]);
});

test('P2: an assumption not surfaced, with no basis, or on an answer that came later or never — flagged, pointing at it', () => {
  for (const f of [(e) => { e.surfaced = false; }, (e) => { delete e.basis; }, (e) => { e.basis = 'guess'; }, (e) => { e.answer = 9; }, (e) => { e.answer = 3; }]) {
    const x = one(edit((r) => f(r.timeline[3])), 'P2');
    assert.equal(x.outcome, 'flag'); assert.deepEqual(x.evidence, [{ at: 'timeline', seq: 3 }]);
  }
  const later = edit((r) => { r.timeline.splice(3, 0, r.timeline.splice(2, 1)[0]); });   // the answer after the assumption
  assert.equal(one(later, 'P2').outcome, 'flag');
  assert.equal(one(edit((r) => { r.timeline[3].basis = 'intent'; delete r.timeline[3].answer; }), 'P2').outcome, 'pass');
  assert.equal(one(edit((r) => { r.timeline[3].surfaced = 'yes'; }), 'P2').outcome, 'flag');
});

test('P3: a tool outside the list fails unless the human approved it before; it names the tool', () => {
  const x = one(edit((r) => { r.timeline[5].tool = 'load-database'; }), 'P3');
  assert.equal(x.outcome, 'fail'); assert.match(x.why, /load-database/); assert.deepEqual(x.evidence, [{ at: 'timeline', seq: 5 }]);
  const approved = edit((r) => { r.timeline[5].tool = 'db'; r.timeline.splice(5, 0, { seq: 20, at: '2026-10-29T10:00:05.500Z', kind: 'approval', by: 'human', tool: 'db' }); });
  assert.equal(one(approved, 'P3').outcome, 'pass');
  const afterwards = edit((r) => { r.timeline[5].tool = 'db'; r.timeline.push({ seq: 20, at: '2026-10-29T10:00:10.000Z', kind: 'approval', by: 'human', tool: 'db' }); });
  assert.equal(one(afterwards, 'P3').outcome, 'fail', 'an approval after the use does not count');
  const byAgent = edit((r) => { r.timeline[5].tool = 'db'; r.timeline.splice(5, 0, { seq: 20, at: 'x', kind: 'approval', by: 'agent', tool: 'db' }); });
  assert.equal(one(byAgent, 'P3').outcome, 'fail');
  const otherTool = edit((r) => { r.timeline[5].tool = 'db'; r.timeline.splice(5, 0, { seq: 20, at: 'x', kind: 'approval', by: 'human', tool: 'web' }); });
  assert.equal(one(otherTool, 'P3').outcome, 'fail');
  assert.match(one(edit((r) => { delete r.timeline[5].tool; }), 'P3').why, /\(unnamed\)/);
  assert.equal(one(edit((r) => { delete r.intent; }), 'P3').outcome, 'fail', 'with no intent, nothing was allowed');
});

test('P4: a claim with no evidence, evidence that does not resolve, a criterion no claim addresses, no claims — flagged, never failed', () => {
  const bare = one(edit((r) => { r.claims[0].evidence = []; }), 'P4');
  assert.equal(bare.outcome, 'flag'); assert.deepEqual(bare.evidence, [{ at: 'claims', id: 'c1' }]); assert.equal(bare.why, '1 claim(s) with no evidence that resolves');
  assert.equal(one(edit((r) => { r.intent.success_criteria.push('totals checked'); }), 'P4').why, '1 success criterion(s) no claim addresses (scope narrowed?)');
  assert.equal(one(edit((r) => { r.claims[0].evidence = [{ at: 'artifacts', id: 'nope' }]; }), 'P4').outcome, 'flag');
  assert.equal(one(edit((r) => { r.claims[0].evidence.push({ at: 'timeline', seq: 99 }); }), 'P4').outcome, 'flag', 'every pointer must resolve');
  const narrowed = one(edit((r) => { r.intent.success_criteria.push('totals checked'); }), 'P4');
  assert.equal(narrowed.outcome, 'flag'); assert.match(narrowed.why, /scope narrowed/); assert.deepEqual(narrowed.evidence, [{ at: 'intent', field: 'success_criteria' }]);
  assert.match(one(edit((r) => { r.claims[0].evidence = []; r.intent.success_criteria.push('x'); }), 'P4').why, /evidence that resolves; 1 success/);
  assert.equal(one(edit((r) => { r.claims = []; }), 'P4').outcome, 'flag');
});

test('P5: a number in a claim must trace to a stored artifact or a re-runnable step', () => {
  assert.equal(one(edit((r) => { r.claims[0].evidence = [{ at: 'timeline', seq: 3 }]; }), 'P5').outcome, 'fail');
  assert.equal(one(edit((r) => { r.claims[0].evidence = [{ at: 'timeline', seq: 6 }]; }), 'P5').outcome, 'pass', 'a re-run is a re-runnable step');
  assert.equal(one(edit((r) => { r.claims[0].evidence = [{ at: 'artifacts', id: 'out-count' }]; }), 'P5').outcome, 'pass', 'a stored artifact alone backs it');
  assert.equal(one(edit((r) => { r.claims[0].evidence = [{ at: 'timeline', seq: 4 }]; }), 'P5').outcome, 'pass', 'a tool use is a re-runnable step');
  assert.equal(one(edit((r) => { r.claims[0].evidence = [{ at: 'artifacts', id: 'out-count' }]; r.artifacts[1].stored = false; }), 'P5').outcome, 'fail', 'an artifact not stored backs nothing');
  assert.equal(one(edit((r) => { r.claims[0].text = 'the file was counted'; r.claims[0].evidence = []; }), 'P5').outcome, 'pass', 'no number, nothing to trace');
  const x = one(edit((r) => { r.claims[0].evidence = []; }), 'P5');
  assert.deepEqual(x.evidence, [{ at: 'claims', id: 'c1' }]); assert.match(x.why, /^1 reported number/);
});

test('P6: a summary in words the record does not use is flagged; an empty one too; plain words and record words pass', () => {
  assert.equal(one(edit((r) => { r.summary = ''; }), 'P6').outcome, 'flag');
  const j = one(edit((r) => { r.summary = 'leveraged synergistic orchestration paradigms to operationalise heterogeneous telemetry'; }), 'P6');
  assert.equal(j.outcome, 'flag'); assert.match(j.why, /term\(s\) found nowhere else/); assert.deepEqual(j.evidence, [{ at: 'summary' }]);
  assert.equal(one(edit((r) => { r.summary = 'counted rows; read the file'; }), 'P6').outcome, 'pass');
  assert.equal(one(edit((r) => { r.summary = 'counted the october rows with zork blap'; }), 'P6').outcome, 'pass', 'two unknown words are under the limit');
  assert.equal(one(edit((r) => { r.summary = 'the agent read the october sales file, counted the rows with zork blap frob, then checked the count again and the count was the same as before, so the october file has the rows the human asked about'; }), 'P6').outcome, 'pass', 'three unknown words in 36: under a tenth');
  assert.equal(one(edit((r) => { r.summary = 'the agent read the october sales file and counted the rows with zork blap frob, then checked the count again'; }), 'P6').outcome, 'flag', 'three unknown words in 20: over a tenth');
  assert.equal(one(edit((r) => { r.summary = 'zork blap frob counted'; }), 'P6').outcome, 'flag', 'three unknown words over a tenth');
  assert.equal(one(edit((r) => { r.summary = 'counted rows incomprehensibilities'; }), 'P6').outcome, 'flag', 'a very long word is a third of the words');
  assert.ok(PLAIN.has('the') && PLAIN.has('checked')); assert.deepEqual({ ...P6_LIMITS }, { unexplained: 3, share: 0.1, longWord: 14, longShare: 0.15 });
  assert.equal(one(edit((r) => { r.summary = 'counted rows abcdefghijklmn'; }), 'P6').outcome, 'flag', 'a word of exactly 14 letters is very long');
  assert.equal(one(edit((r) => { r.summary = 'counted rows abcdefghijklm'; }), 'P6').outcome, 'pass', 'thirteen is not');
  const thirty = 'the agent read the october sales file and counted the rows with zork blap frob then checked the count again and the count was the same as before so the file has';
  assert.equal(thirty.split(' ').filter((w) => w.length >= 3).length, 30);
  assert.equal(one(edit((r) => { r.summary = thirty; }), 'P6').outcome, 'pass', 'three unknown in 30 is exactly a tenth: not over');
  const twenty = ['abcdefghijklmnop', 'abcdefghijklmnoq', 'abcdefghijklmnor', ...Array(17).fill('the')].join(' ');
  assert.equal(twenty.split(' ').length, 20);
  assert.equal(one(edit((r) => { r.summary = twenty; r.timeline[1].text += ' abcdefghijklmnop abcdefghijklmnoq abcdefghijklmnor'; }), 'P6').outcome, 'pass', 'three long words in 20 is exactly 0.15: not over');
  assert.equal(one(edit((r) => { delete r.intent; }), 'P6').outcome, 'pass', 'with no intent the summary is read against the rest of the record');
});

test('P7: nothing kept, an artifact not stored, or with no SHA-256 — fails, naming it', () => {
  assert.equal(one(edit((r) => { r.artifacts = []; }), 'P7').outcome, 'fail');
  const x = one(edit((r) => { r.artifacts[0].stored = false; }), 'P7');
  assert.equal(x.outcome, 'fail'); assert.deepEqual(x.evidence, [{ at: 'artifacts', id: 'in-sales' }]);
  assert.equal(one(edit((r) => { r.artifacts[1].sha256 = 'abc'; }), 'P7').outcome, 'fail');
  assert.equal(one(edit((r) => { r.artifacts[1].sha256 = 'A'.repeat(64); }), 'P7').outcome, 'fail', 'lower-case hex only');
  assert.equal(one(edit((r) => { r.artifacts.push('x'); }), 'P7').outcome, 'fail');
  assert.deepEqual(one(clean(), 'P7').evidence, [{ at: 'artifacts', id: 'in-sales' }, { at: 'artifacts', id: 'out-count' }]);
});

test('P8: only a check by something other than the agent, of a claim that exists, counts; a failure points at the self-checks', () => {
  const self = one(edit((r) => { r.timeline[7].by = 'agent'; }), 'P8');
  assert.equal(self.outcome, 'fail'); assert.deepEqual(self.evidence, [{ at: 'timeline', seq: 7 }]); assert.match(self.why, /the only checks recorded are its own/);
  const none = one(edit((r) => { r.timeline.splice(7, 1); }), 'P8');
  assert.equal(none.outcome, 'fail'); assert.deepEqual(none.evidence, []); assert.equal(none.why, 'nothing other than the agent checked its result');
  assert.equal(one(edit((r) => { r.timeline[7].target = 'c9'; }), 'P8').outcome, 'fail');
  assert.equal(one(edit((r) => { r.timeline[7].by = 'human'; }), 'P8').outcome, 'pass');
  assert.deepEqual(one(clean(), 'P8').evidence, [{ at: 'timeline', seq: 7 }]);
});

test('P9: the human’s direction — an unanswered question, an unchallenged unsanctioned tool, acceptance before any check, no acceptance — flagged with pointers', () => {
  const q = one(edit((r) => { r.timeline.splice(2, 1); r.timeline[2].basis = 'intent'; }), 'P9');
  assert.equal(q.outcome, 'flag'); assert.match(q.why, /3 of 4 — not: every question the agent asked was answered/); assert.deepEqual(q.evidence, [{ at: 'timeline', seq: 1 }]);
  const wrongTo = one(edit((r) => { r.timeline[2].to = 0; }), 'P9'); assert.equal(wrongTo.outcome, 'flag');
  const tool = one(edit((r) => { r.timeline[5].tool = 'db'; }), 'P9');
  assert.match(tool.why, /every unsanctioned action was caught/); assert.deepEqual(tool.evidence, [{ at: 'timeline', seq: 5 }]);
  const caught = edit((r) => { r.timeline[5].tool = 'db'; r.timeline.push({ seq: 30, at: 'x', kind: 'intervention', by: 'human', refers_to: 5 }); });
  assert.equal(one(caught, 'P9').outcome, 'pass'); assert.equal(one(caught, 'P3').outcome, 'fail', 'caught is not approved');
  for (const bad of [{ kind: 'intervention', by: 'agent', refers_to: 5 }, { kind: 'intervention', by: 'human', refers_to: 4 }, { kind: 'note', by: 'human', refers_to: 5 }])
    assert.equal(one(edit((r) => { r.timeline[5].tool = 'db'; r.timeline.push({ seq: 30, at: 'x', ...bad }); }), 'P9').outcome, 'flag', 'not a catch: ' + JSON.stringify(bad));
  const early = one(edit((r) => { const a = r.timeline.pop(); r.timeline.splice(6, 0, a); }), 'P9');
  assert.match(early.why, /checked before it was accepted/); assert.deepEqual(early.evidence, [{ at: 'timeline', seq: 8 }]);
  assert.match(one(edit((r) => { r.timeline.pop(); }), 'P9').why, /checked before it was accepted/);
  assert.match(one(edit((r) => { r.timeline[7].by = 'agent'; }), 'P9').why, /checked before it was accepted/, 'the agent checking itself is not a check');
  assert.match(one(edit((r) => { r.timeline.splice(7, 1); }), 'P9').why, /checked before it was accepted/, 'a human answer is not a check');
  const firstApproval = edit((r) => { r.timeline[5].tool = 'db'; r.timeline.unshift({ seq: 40, at: '2026-10-29T09:59:59.000Z', kind: 'approval', by: 'human', tool: 'db' }); });
  assert.equal(one(firstApproval, 'P3').outcome, 'pass', 'an approval as the very first event still counts');
  assert.match(one(edit((r) => { r.timeline[8].by = 'agent'; }), 'P9').why, /checked before it was accepted/);
  assert.match(one(clean(), 'P9', { intentHashOk: false }).why, /intent was recorded first/);
  const agentAnswer = one(edit((r) => { r.timeline[2].by = 'agent'; }), 'P9'); assert.equal(agentAnswer.outcome, 'flag');
});

test('P10: no re-run is flagged; one that did not match fails; matches pass', () => {
  assert.equal(one(edit((r) => { r.timeline.splice(6, 1); }), 'P10').outcome, 'flag');
  const x = one(edit((r) => { r.timeline[6].result = 'differs'; }), 'P10');
  assert.equal(x.outcome, 'fail'); assert.deepEqual(x.evidence, [{ at: 'timeline', seq: 6 }]);
  assert.deepEqual(one(clean(), 'P10').evidence, [{ at: 'timeline', seq: 6 }]);
});

test('humans own the judgement calls: P2, P4, P6 and P9 never fail; the review queue is exactly the flags', () => {
  const orig = { ...CHECKS };
  try {
    for (const id of Object.keys(CHECKS)) CHECKS[id] = () => ({ outcome: 'fail', why: 'forced', evidence: [] });
    const j = judge(clean(), OK);
    assert.deepEqual(j.results.filter((x) => x.outcome === 'flag').map((x) => x.id), ['P2', 'P4', 'P6', 'P9']);
    assert.deepEqual(j.review, ['P2', 'P4', 'P6', 'P9']); assert.deepEqual(j.counts, { pass: 0, flag: 4, fail: 6 });
    CHECKS.P3 = () => { throw new Error('boom'); };
    const t = judge(clean(), OK).results.find((x) => x.id === 'P3');
    assert.equal(t.outcome, 'flag'); assert.match(t.why, /could not be read/);
  } finally { Object.assign(CHECKS, orig); }
  const many = judge(edit((r) => { r.claims[0].evidence = []; r.timeline[3].surfaced = false; }), OK);
  assert.deepEqual(many.review, many.results.filter((x) => x.outcome === 'flag').map((x) => x.id));
});

test('the record helpers: canonical JSON, the intent hash, pointers', async () => {
  assert.equal(canonical({ b: 1, a: [1, 'x', null, undefined], c: undefined, d: () => 1 }), '{"a":[1,"x",null,null],"b":1}');
  assert.equal(canonical([() => 1, Symbol('s'), undefined, 2]), '[null,null,null,2]');
  assert.equal(canonical(NaN), 'null'); assert.equal(canonical(Symbol('s')), 'null'); assert.equal(canonical(true), 'true');
  const i = clean().intent;
  assert.equal(intentContent(i), canonical({ goal: i.goal, constraints: i.constraints, success_criteria: i.success_criteria, allowed_tools: i.allowed_tools, out_of_scope: i.out_of_scope, sealed_at: i.sealed_at }));
  assert.equal(intentContent(null), ''); assert.ok(!intentContent(i).includes('"hash"'));
  assert.equal(await sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const r = clean(); r.intent.hash = await intentHash(r.intent);
  assert.deepEqual(await factsOf(r), { intentHashOk: true });
  r.intent.goal += '!'; assert.deepEqual(await factsOf(r), { intentHashOk: false });
  r.intent.hash = 7; assert.deepEqual(await factsOf(r), { intentHashOk: false });
  assert.deepEqual(await factsOf(null), { intentHashOk: false }); assert.deepEqual(await factsOf({ intent: [] }), { intentHashOk: false });
  const c = clean();
  for (const [p, ok] of [[{ at: 'timeline', seq: 8 }, true], [{ at: 'timeline', seq: 9 }, false], [{ at: 'artifacts', id: 'in-sales' }, true], [{ at: 'artifacts', id: 'x' }, false],
    [{ at: 'claims', id: 'c1' }, true], [{ at: 'claims', id: 'c2' }, false], [{ at: 'intent', field: 'goal' }, true], [{ at: 'intent', field: 'hash' }, false], [{ at: 'summary' }, true], [{ at: 'elsewhere' }, false], [null, false], ['x', false]])
    assert.equal(resolves(c, p), ok, JSON.stringify(p));
  assert.equal(resolves(null, { at: 'summary' }), false); assert.equal(resolves({ summary: 3 }, { at: 'summary' }), false); assert.equal(resolves({}, { at: 'intent', field: 'goal' }), false);
  assert.equal(SCHEMA, 'acg-autopilot.process-record/1'); assert.equal(KINDS.length, 10); assert.equal(INTENT_FIELDS.length, 5);
  assert.deepEqual(list('x'), []); assert.equal(text(3), '');
});

test('deterministic, and garbage is judged — never thrown, never a clean pass', () => {
  assert.equal(JSON.stringify(judge(clean(), OK)), JSON.stringify(judge(clean(), OK)));
  const junk = [undefined, null, 0, 'x', [], {}, { intent: 'x' }, { timeline: 'x' }, { timeline: [null, 1, { seq: 'a' }] }, { claims: [null], artifacts: [null] }, { intent: {}, summary: 5 }, Object.create(null)];
  for (const r of junk) for (const f of [undefined, null, {}, OK]) {
    let j; assert.doesNotThrow(() => { j = judge(r, f); });
    assert.equal(j.results.find((x) => x.id === 'P1').outcome, 'fail');
    assert.ok(j.counts.pass < 10); assert.equal(j.results.length, 10);
  }
  assert.equal(judge({ job_id: 5 }).job_id, null);
});
