// test/portfolio.test.mjs — organ 5: the judge attests a bundle only after checking all of it, and signs only what a
// portfolio shows; a portfolio holds only the jobs its member chose, the full bundle only where revealed; its scores are
// counts of the attestations; and anyone with the trust list checks it without the records: a changed outcome or
// decision, a job twice, another member's job, an unknown or revoked key, a wrong score, a revealed job that is not the
// one attested — each refused with its reason. Garbage is refused, never thrown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attest, buildPortfolio, checkPortfolio, scoresOf, CHECK_IDS, HABITS, KIND } from '../src/portfolio.mjs';
import { signerFromSeed, signAs, verifySigned, message } from '../src/sign.mjs';
import { makeBundle, recordHash } from '../src/bundle.mjs';
import { revoke, verifyTrusted } from '../src/trust.mjs';
import { link, GENESIS, eventsOf } from '../src/log.mjs';
import { toRecord } from '../src/normalise.mjs';
import { assessStrict, RUBRIC_V3 } from '../src/judge.mjs';
import { factsOf, sha256hex, canonical } from '../src/record.mjs';
import { cleanJob, plantedJob } from '../tools/suite.mjs';

const [R, J, V, X] = await Promise.all([1, 2, 3, 4].map((b) => signerFromSeed(new Uint8Array(32).fill(b))));
const TRUST = { recorders: [R.publicHex], judges: [J.publicHex], reviewers: [V.publicHex] };
const AT = '2026-11-05T12:00:00.000Z';
async function chain(evs) { const out = []; let p = GENESIS; for (const e of evs) { const l = await link(p, e); out.push(l); p = l.hash; } return out; }
const eventsOfJob = (job) => [...job.timeline.map(({ seq, ...e }) => e), ...job.artifacts.map((a) => ({ kind: 'artifact', ...a })), ...job.claims.map((c) => ({ kind: 'claim', ...c }))];
/** a signed bundle for a suite job; `decide` maps a flagged check to upheld/overturned; no `decide` = no review */
async function bundleOf(job, member, decide, recorder = R) {
  const log = await chain(eventsOfJob(job)), record = toRecord({ job_id: job.job_id, member_id: member, harness: job.harness, intent: job.intent, events: eventsOf(log) });
  const review = assessStrict(record, await factsOf(record)).review;
  return decide ? makeBundle({ record, log, recorder, judge: J, reviewer: V, decisions: review.map((c) => ({ check: c, decision: decide[c] || 'upheld', note: 'note for ' + c })) }) : makeBundle({ record, log, recorder, judge: J });
}
// member m1: A clean (reviewed, nothing to decide) · B P2 flag upheld · C P4 flag overturned, P5 fail · D P3 fail, P9 flag, no review · E P10 fail · F P1 fail, P9 flag upheld
const A = await bundleOf(await cleanJob(1), 'm1', {}), B = await bundleOf((await plantedJob(2, 'P2')).job, 'm1', { P2: 'upheld' });
const C = await bundleOf((await plantedJob(3, 'P4')).job, 'm1', { P4: 'overturned' }), D = await bundleOf((await plantedJob(4, 'P3')).job, 'm1');
const E = await bundleOf((await plantedJob(5, 'P10')).job, 'm1', {}), F = await bundleOf((await plantedJob(8, 'P1')).job, 'm1', { P9: 'upheld' });
const G = await bundleOf(await cleanJob(9), 'm2', {});
const ALL = [F, E, D, C, B, A, G];
const BUILT = await buildPortfolio({ member: 'm1', bundles: ALL, trust: TRUST, judge: J, include: ['job-1', 'job-2', 'job-3', 'job-4', 'job-5', 'job-8'], reveal: ['job-3', 'job-5'] });
const GOOD = BUILT.portfolio;
const copy = () => structuredClone(GOOD);
const rescore = (p) => { p.scores = scoresOf(p.entries); return p; };
const idx = (p, job) => p.entries.findIndex((e) => e.attested.payload.job_id === job);
const att = async (payload, by = J) => ({ kind: 'attested', payload, by: by.publicHex, sig: await by.sign(message('attested', payload)) });
const one = (entry, member = 'm1') => ({ kind: KIND, v: 1, member, rubric: RUBRIC_V3.id, entries: [entry], scores: {} });
const problems = async (p, t = TRUST) => (await checkPortfolio(p, t)).problems;

test('attest: the judge checks the whole bundle, then signs only what a portfolio shows', async () => {
  const a = await attest(B, TRUST, J);
  assert.equal(a.ok, true);
  assert.deepEqual(Object.keys(a.attested), ['kind', 'payload', 'by', 'sig']);
  assert.equal(a.attested.kind, 'attested'); assert.equal(a.attested.by, J.publicHex);
  const j = assessStrict(B.record, await factsOf(B.record));
  assert.deepEqual(a.attested.payload, { record: await recordHash(B.record), job_id: 'job-2', member: 'm1', rubric: RUBRIC_V3.id, outcomes: Object.fromEntries(j.results.map((x) => [x.id, x.outcome])),
    review: ['P2'], decisions: [{ check: 'P2', decision: 'upheld' }], recorder: R.publicHex, reviewer: V.publicHex });
  assert.deepEqual(await verifySigned(a.attested, 'attested', [J.publicHex]), { ok: true, why: 'signed by a trusted key' });
  assert.ok(!JSON.stringify(a.attested).includes('note for'), 'no reviewer note');
  const d = await attest(D, TRUST, J);
  assert.deepEqual([d.attested.payload.review, d.attested.payload.decisions, d.attested.payload.reviewer], [['P9'], [], null]);
  assert.deepEqual((await attest(A, TRUST, J)).attested.payload.decisions, []);
  assert.equal((await attest(A, TRUST, J)).attested.payload.reviewer, V.publicHex);
  const cut = structuredClone(B); cut.log.pop();
  assert.deepEqual(await attest(cut, TRUST, J), { ok: false, problems: (await verifyTrusted(cut, TRUST)).problems });
  const twice = await makeBundle({ record: B.record, log: B.log, recorder: R, judge: J, reviewer: V, decisions: [{ check: 'P2', decision: 'upheld', note: 'a' }, { check: 'P2', decision: 'overturned', note: 'b' }] });
  assert.equal((await verifyTrusted(twice, TRUST)).ok, true, 'a bundle may carry it');
  assert.deepEqual(await attest(twice, TRUST, J), { ok: false, problems: ['reviewer: a check decided twice'] });
  assert.deepEqual(await attest(null, TRUST, J), { ok: false, problems: ['not a bundle'] });
  assert.deepEqual(await attest(B, TRUST, null), { ok: false, problems: ['not a bundle that can be attested'] });
});

test('scoresOf: counts of the attestations; a habit is kept by a pass or a flag a reviewer overturned', () => {
  const pass = Object.fromEntries(CHECK_IDS.map((c) => [c, 'pass'])), e = (o, review, decisions, bundle) => ({ attested: { payload: { outcomes: { ...pass, ...o }, review, decisions } }, ...(bundle ? { bundle } : {}) });
  const s = scoresOf([e({}, [], []), e({ P4: 'flag' }, ['P4'], [{ check: 'P4', decision: 'overturned' }], {}), e({ P9: 'flag' }, ['P9'], [{ check: 'P9', decision: 'upheld' }]),
    e({ P10: 'flag', P8: 'fail' }, ['P10'], []), e({ P3: 'fail', P1: 'fail' }, [], [], {})]);
  const checks = Object.fromEntries(CHECK_IDS.map((c) => [c, { pass: 5, flag: 0, fail: 0 }]));
  Object.assign(checks, { P4: { pass: 4, flag: 1, fail: 0 }, P9: { pass: 4, flag: 1, fail: 0 }, P10: { pass: 4, flag: 1, fail: 0 }, P8: { pass: 4, flag: 0, fail: 1 }, P3: { pass: 4, flag: 0, fail: 1 }, P1: { pass: 4, flag: 0, fail: 1 } });
  assert.deepEqual(s, { jobs: 5, revealed: 2, checks, flags: { upheld: 1, overturned: 1, undecided: 1 }, fullyReviewed: 4, habits: { P1: 4, P3: 4, P4: 5, P5: 5, P8: 4, P9: 4, P10: 4 } });
  assert.deepEqual(Object.keys(HABITS), ['P1', 'P3', 'P4', 'P5', 'P8', 'P9', 'P10']);
  assert.deepEqual(scoresOf([]).habits, { P1: 0, P3: 0, P4: 0, P5: 0, P8: 0, P9: 0, P10: 0 });
});

test('buildPortfolio: only the member’s chosen jobs that verify, sorted, revealed only where chosen; the rest left out with why', async () => {
  assert.deepEqual(GOOD.entries.map((x) => x.attested.payload.job_id), ['job-1', 'job-2', 'job-3', 'job-4', 'job-5', 'job-8']);
  assert.deepEqual(GOOD.entries.map((x) => x.bundle !== undefined), [false, false, true, false, true, false]);
  assert.equal(GOOD.entries[2].bundle, C); assert.deepEqual(Object.keys(GOOD.entries[0]), ['attested']);
  assert.deepEqual([GOOD.kind, GOOD.v, GOOD.member, GOOD.rubric], [KIND, 1, 'm1', RUBRIC_V3.id]);
  assert.deepEqual(GOOD.scores, scoresOf(GOOD.entries));
  assert.deepEqual(BUILT.left, [{ job: 'job-9', why: 'another member’s job' }]);
  const cut = structuredClone(B); cut.log.pop();
  const b = await buildPortfolio({ member: 'm1', bundles: [null, 5, {}, { record: {} }, { record: { job_id: 5 } }, cut, A, A, B, C], trust: TRUST, judge: J, include: ['job-1', 'job-2', 7] });
  assert.deepEqual(b.left.map((l) => [l.job, l.why]), [[null, 'not a bundle'], [null, 'not a bundle'], [null, 'not a bundle'], [null, 'not a bundle'], [null, 'not a bundle'],
    ['job-2', 'refused: ' + (await verifyTrusted(cut, TRUST)).problems.join('; ')], ['job-1', 'already in the portfolio'], ['job-3', 'not chosen']]);
  assert.deepEqual(b.portfolio.entries.map((x) => x.attested.payload.job_id), ['job-1', 'job-2']);
  assert.deepEqual(b.portfolio.entries.map((x) => Object.keys(x)), [['attested'], ['attested']]);
  assert.deepEqual((await buildPortfolio({ member: 'm1', bundles: ALL, trust: TRUST, judge: J })).portfolio.entries, [], 'nothing is in unless chosen');
  assert.deepEqual((await buildPortfolio({ member: 'm1', bundles: ALL, trust: TRUST, judge: J, include: 'job-1', reveal: 'job-1' })).portfolio.entries, []);
  assert.deepEqual((await buildPortfolio({ member: 'm1', bundles: ALL, trust: TRUST, judge: J, include: ['job-1'], reveal: 'job-1' })).portfolio.entries.map((x) => Object.keys(x)), [['attested']]);
  assert.deepEqual((await buildPortfolio({ member: 'm1', bundles: 'x' })).portfolio.entries, []);
  assert.deepEqual((await buildPortfolio()).left, []);
});

test('checkPortfolio: a good one checks, its revealed jobs judged again', async () => {
  assert.deepEqual(await checkPortfolio(GOOD, TRUST), { ok: true, problems: [], jobs: 6, revealed: 2 });
  const fewer = copy(); fewer.entries.splice(1, 2); rescore(fewer);
  assert.deepEqual(await checkPortfolio(fewer, TRUST), { ok: true, problems: [], jobs: 4, revealed: 1 }, 'leaving jobs out is the member’s choice');
  const none = copy(); none.entries = []; rescore(none);
  assert.deepEqual(await checkPortfolio(none, TRUST), { ok: true, problems: [], jobs: 0, revealed: 0 });
});

test('checkPortfolio: every change is refused, with its reason', async () => {
  const flip = copy(), d = idx(flip, 'job-4'); flip.entries[d].attested.payload.outcomes.P3 = 'pass'; rescore(flip);
  assert.deepEqual(await problems(flip), ['entry 3 (job-4): the attestation: the signature does not verify']);
  const decide = copy(); decide.entries[idx(decide, 'job-2')].attested.payload.decisions[0].decision = 'overturned'; rescore(decide);
  assert.deepEqual(await problems(decide), ['entry 1 (job-2): the attestation: the signature does not verify']);
  const dup = copy(); dup.entries.push(structuredClone(dup.entries[0])); rescore(dup);
  assert.deepEqual(await problems(dup), ['entry 6 (job-1): in the portfolio twice']);
  const sameJob = copy(), p = structuredClone(sameJob.entries[0].attested.payload); p.record = 'f'.repeat(64); sameJob.entries.push({ attested: await att(p) }); rescore(sameJob);
  assert.deepEqual(await problems(sameJob), ['entry 6 (job-1): in the portfolio twice']);
  const sameRecord = copy(), q = structuredClone(sameRecord.entries[0].attested.payload); q.job_id = 'job-x'; sameRecord.entries.push({ attested: await att(q) }); rescore(sameRecord);
  assert.deepEqual(await problems(sameRecord), ['entry 6 (job-x): in the portfolio twice']);
  const lift = copy(); lift.entries.push({ attested: (await attest(G, TRUST, J)).attested }); rescore(lift);
  assert.deepEqual(await problems(lift), ['entry 6 (job-9): about another member']);
  const forger = copy(), fp = structuredClone(forger.entries[3].attested.payload); fp.outcomes.P3 = 'pass'; forger.entries[3].attested = await att(fp, X); rescore(forger);
  assert.deepEqual(await problems(forger), ['entry 3 (job-4): attested by a key not on the trust list']);
  const score = copy(); score.scores.habits.P1++;
  assert.deepEqual(await problems(score), ['the scores are not what the entries give']);
  const renamed = copy(); renamed.member = 'm9';
  assert.deepEqual(await problems(renamed), GOOD.entries.map((e, i) => 'entry ' + i + ' (' + e.attested.payload.job_id + '): about another member'));
});

test('checkPortfolio: revoked keys are named; a revealed job must be the one attested, whole, judged again the same', async () => {
  const jr = revoke(TRUST, J.publicHex, 'stolen', AT);
  assert.deepEqual(await problems(GOOD, jr), GOOD.entries.map((e, i) => 'entry ' + i + ' (' + e.attested.payload.job_id + '): attested by a revoked key (stolen, ' + AT + ')'));
  const rr = revoke(TRUST, R.publicHex, 'lost', AT), rp = await problems(GOOD, rr);
  assert.deepEqual(rp.filter((x) => x.includes('recorded by')), GOOD.entries.map((e, i) => 'entry ' + i + ' (' + e.attested.payload.job_id + '): recorded by a revoked key (lost, ' + AT + ')'));
  assert.deepEqual(rp.filter((x) => !x.includes('recorded by')), ['entry 2 (job-3): revealed, it is refused: recorder: signed by a revoked key (lost, ' + AT + ')', 'entry 4 (job-5): revealed, it is refused: recorder: signed by a revoked key (lost, ' + AT + ')']);
  const vr = revoke(TRUST, V.publicHex, 'left', AT), vp = await problems(GOOD, vr);
  assert.deepEqual(vp, ['entry 0 (job-1): reviewed by a revoked key (left, ' + AT + ')', 'entry 1 (job-2): reviewed by a revoked key (left, ' + AT + ')', 'entry 2 (job-3): reviewed by a revoked key (left, ' + AT + ')',
    'entry 2 (job-3): revealed, it is refused: reviewer: signed by a revoked key (left, ' + AT + ')', 'entry 4 (job-5): reviewed by a revoked key (left, ' + AT + ')',
    'entry 4 (job-5): revealed, it is refused: reviewer: signed by a revoked key (left, ' + AT + ')', 'entry 5 (job-8): reviewed by a revoked key (left, ' + AT + ')']);
  const unknownReviewer = { ...TRUST, reviewers: [] };
  assert.deepEqual((await problems(GOOD, unknownReviewer))[0], 'entry 0 (job-1): reviewed by a key not on the trust list');
  assert.deepEqual((await problems(GOOD, { ...TRUST, recorders: [] }))[0], 'entry 0 (job-1): recorded by a key not on the trust list');
  assert.deepEqual(await problems(GOOD, null), GOOD.entries.map((e, i) => 'entry ' + i + ' (' + e.attested.payload.job_id + '): attested by a key not on the trust list'));
  const swap = copy(); swap.entries[2].bundle = structuredClone(E);
  assert.deepEqual(await problems(swap), ['entry 2 (job-3): revealed, it is not the record attested']);
  const cut = copy(); cut.entries[4].bundle.log.pop();
  assert.deepEqual(await problems(cut), ['entry 4 (job-5): revealed, it is refused: ' + (await verifyTrusted(cut.entries[4].bundle, TRUST)).problems.join('; ')]);
  const redecided = copy(); redecided.entries[2].bundle = await makeBundle({ record: C.record, log: C.log, recorder: R, judge: J, reviewer: V, decisions: [{ check: 'P4', decision: 'upheld', note: 'changed my mind' }] });
  assert.deepEqual(await problems(redecided), ['entry 2 (job-3): revealed and judged again, it is not what was attested']);
  const unreviewed = copy(); unreviewed.entries[2].bundle = await makeBundle({ record: C.record, log: C.log, recorder: R, judge: J });
  assert.deepEqual(await problems(unreviewed), ['entry 2 (job-3): revealed and judged again, it is not what was attested']);
  const late = copy(); late.entries[3].bundle = D; rescore(late);
  assert.deepEqual(await checkPortfolio(late, TRUST), { ok: true, problems: [], jobs: 6, revealed: 3 }, 'an unreviewed job revealed');
});

test('checkPortfolio: an attestation a trusted judge signed is still checked for what a portfolio may hold', async () => {
  const base = GOOD.entries[1].attested.payload, why = async (change) => { const p = structuredClone(base); change(p); return (await problems(one({ attested: await att(p) })))[0]; };
  assert.equal((await problems(one({ attested: await att(null) })))[0], 'entry 0 (?): not an attestation a portfolio holds');
  assert.equal(await why((p) => { p.extra = 1; }), 'entry 0 (job-2): not an attestation a portfolio holds');
  assert.equal(await why((p) => { delete p.reviewer; }), 'entry 0 (job-2): not an attestation a portfolio holds');
  assert.equal(await why((p) => { p.member = 'm2'; }), 'entry 0 (job-2): about another member');
  assert.equal(await why((p) => { p.rubric = 'r'; }), 'entry 0 (job-2): judged under another rubric');
  for (const [k, v] of [['record', 'zz'], ['record', 5], ['job_id', ''], ['job_id', 5]]) assert.equal(await why((p) => { p[k] = v; }), 'entry 0 (' + (k === 'job_id' ? v : 'job-2') + '): no record hash, or no job', k + ' ' + v);
  const bad = 'entry 0 (job-2): its outcomes are not pass, flag or fail for each of P0 to P10';
  assert.equal(await why((p) => { p.outcomes = null; }), bad);
  assert.equal(await why((p) => { p.outcomes = CHECK_IDS.map(() => 'pass'); }), bad);
  assert.equal(await why((p) => { p.outcomes.P11 = 'pass'; }), bad);
  assert.equal(await why((p) => { delete p.outcomes.P10; }), bad);
  assert.equal(await why((p) => { p.outcomes.P0 = 'maybe'; }), bad);
  assert.equal(await why((p) => { p.outcomes.P2 = 'fail'; }), 'entry 0 (job-2): a judgement item failed by the machine');
  assert.equal(await why((p) => { p.review = []; }), 'entry 0 (job-2): its review queue is not its flags');
  assert.equal(await why((p) => { p.review = 'P2'; }), 'entry 0 (job-2): its review queue is not its flags');
  const once = 'entry 0 (job-2): a decision is not one flag upheld or overturned, once';
  for (const ds of [null, ['x'], [null], [{ check: 'P2', decision: 'upheld', note: 'n' }], [{ check: 'P4', decision: 'upheld' }], [{ check: 'P2', decision: 'maybe' }], [{ check: 'P2' , decision: 'upheld' }, { check: 'P2', decision: 'overturned' }]])
    assert.equal(await why((p) => { p.decisions = ds; }), once, JSON.stringify(ds));
  assert.equal(await why((p) => { p.reviewer = null; }), 'entry 0 (job-2): decisions, and no reviewer');
  assert.equal(await why((p) => { p.reviewer = 'zz'; }), 'entry 0 (job-2): reviewed by a key not on the trust list');
  assert.equal(await why((p) => { p.recorder = 'zz'; }), 'entry 0 (job-2): recorded by a key not on the trust list');
  const undecided = structuredClone(base); undecided.decisions = [];
  assert.deepEqual(await checkPortfolio(rescore(one({ attested: await att(undecided) })), TRUST), { ok: true, problems: [], jobs: 1, revealed: 0 }, 'a flag left undecided is allowed: it is counted as undecided');
});

test('checkPortfolio: not a portfolio, or not an entry — refused, never thrown', async () => {
  const shape = 'not a portfolio';
  const variants = [null, 5, 'x', [], { ...copy(), extra: 1 }, { ...copy(), kind: 'k' }, { ...copy(), v: 2 }, { ...copy(), member: 5 }, { ...copy(), member: '' }, { ...copy(), rubric: 'r' }, { ...copy(), entries: {} }, { ...copy(), scores: [] }, { ...copy(), scores: null }];
  for (const v of variants) assert.deepEqual(await checkPortfolio(v, TRUST), { ok: false, problems: [shape], jobs: 0, revealed: 0 }, JSON.stringify(v).slice(0, 60));
  const entry = async (e) => (await problems(one(e)))[0];
  assert.equal(await entry(null), 'entry 0 (?): not an entry');
  assert.equal(await entry({}), 'entry 0 (?): not an entry');
  assert.equal(await entry({ attested: 'x' }), 'entry 0 (?): not an entry');
  assert.equal(await entry({ attested: { payload: { job_id: 'q' } }, extra: 1 }), 'entry 0 (q): not an entry');
  assert.equal(await entry({ attested: { kind: 'judged', payload: { job_id: 'q' } } }), 'entry 0 (q): the attestation: not a attested signature');
  const live = { ...GOOD.entries[0], extra: 1 };
  assert.equal(await entry(live), 'entry 0 (job-1): not an entry');
  const got = await checkPortfolio(one(null), TRUST);
  assert.deepEqual([got.ok, got.jobs, got.revealed], [false, 1, 0]);
  const weird = copy(); Object.defineProperty(weird.entries, 'entries', { value: () => { throw new Error('no'); } });
  assert.deepEqual(await checkPortfolio(weird, TRUST), { ok: false, problems: ['the portfolio could not be read'], jobs: 0, revealed: 0 });
  const signedJudged = await signAs(J, 'judged', { x: 1 });
  assert.equal(await entry({ attested: signedJudged }), 'entry 0 (undefined): the attestation: not a attested signature');
  assert.equal(typeof (await sha256hex(canonical(GOOD))), 'string');
});
