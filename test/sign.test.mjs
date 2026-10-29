// test/sign.test.mjs — organ 3: a signature is for one purpose, by one key, over exact bytes; a bundle verifies only when
// every signature is trusted and true, its log is whole and ends where the recorder signed, its record is its log, the
// judgement re-runs, and the reviewer decided only flagged checks. Garbage is refused, never thrown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signerFromSeed, signAs, verifySigned, message, KINDS } from '../src/sign.mjs';
import { makeBundle, verifyBundle, recordHash, DECISIONS } from '../src/bundle.mjs';
import { link, GENESIS, eventsOf } from '../src/log.mjs';
import { toRecord } from '../src/normalise.mjs';
import { sha256hex, canonical, factsOf } from '../src/record.mjs';
import { assessStrict } from '../src/judge.mjs';

const seed = (b) => new Uint8Array(32).fill(b);
const [R, J, V, X] = await Promise.all([1, 2, 3, 4].map((b) => signerFromSeed(seed(b))));
const TRUST = { recorders: [R.publicHex], judges: [J.publicHex], reviewers: [V.publicHex] };
const intent = { goal: 'read the file', constraints: [], success_criteria: ['read'], allowed_tools: ['Read'], out_of_scope: [], sealed_at: '2026-10-29T09:00:00.000Z' };
intent.hash = await sha256hex('placeholder');
const EVENTS = [{ kind: 'model_call', at: '2026-10-29T10:00:00.000Z', model: 'm' }, { kind: 'tool_use', at: '2026-10-29T10:00:01.000Z', tool: 'Read' }, { kind: 'question', at: '2026-10-29T10:00:02.000Z', text: 'which' },
  { kind: 'artifact', id: 'f', role: 'input', sha256: 'a'.repeat(64), stored: true }, { kind: 'claim', id: 'c1', text: 'read', evidence: [{ at: 'artifacts', id: 'f' }], criterion: 'read' }];
async function chain(events) { const out = []; let p = GENESIS; for (const e of events) { const l = await link(p, e); out.push(l); p = l.hash; } return out; }
const LOG = await chain(EVENTS);
const RECORD = toRecord({ job_id: 'j1', member_id: 'm', harness: { name: 'claude-code' }, intent, events: eventsOf(LOG) });
const JUDGED = assessStrict(RECORD, await factsOf(RECORD));
const DECIDE = JUDGED.review.map((c) => ({ check: c, decision: 'upheld', note: 'seen' }));
const BUNDLE = await makeBundle({ record: RECORD, log: LOG, recorder: R, judge: J, reviewer: V, decisions: DECIDE });
const why = async (b, t = TRUST) => (await verifyBundle(b, t)).problems;
const copy = () => structuredClone(BUNDLE);

test('a signer from a seed: a 32-byte public key; a signature is for its kind, its payload and its key', async () => {
  assert.match(R.publicHex, /^[0-9a-f]{64}$/); assert.notEqual(R.publicHex, J.publicHex);
  assert.equal((await signerFromSeed(seed(1))).publicHex, R.publicHex, 'the same seed, the same key');
  assert.deepEqual([...KINDS], ['recorded', 'judged', 'reviewed']);
  assert.equal(new TextDecoder().decode(message('judged', { b: 1, a: 2 })), 'acg-autopilot/judged/v1|{"a":2,"b":1}');
  const s = await signAs(R, 'recorded', { x: 1 });
  assert.deepEqual(Object.keys(s), ['kind', 'payload', 'by', 'sig']); assert.match(s.sig, /^[0-9a-f]{128}$/);
  assert.deepEqual(await verifySigned(s, 'recorded', [R.publicHex]), { ok: true, why: 'signed by a trusted key' });
  assert.equal((await verifySigned(s, 'judged', [R.publicHex])).why, 'not a judged signature');
  assert.equal((await verifySigned(s, 'recorded', [J.publicHex])).why, 'signed by a key not on the trust list');
  assert.equal((await verifySigned(s, 'recorded', 'x')).why, 'signed by a key not on the trust list');
  assert.equal((await verifySigned({ ...s, payload: { x: 2 } }, 'recorded', [R.publicHex])).why, 'the signature does not verify');
  assert.equal((await verifySigned({ ...s, kind: 'judged' }, 'judged', [R.publicHex])).why, 'the signature does not verify', 'a signature cannot change purpose');
  for (const bad of [{ ...s, sig: 'ab' }, { ...s, sig: 'zz'.repeat(64) }, { ...s, by: 'ab', }, { ...s, sig: 7 }]) {
    const t = bad.by === 'ab' ? ['ab'] : [R.publicHex];
    assert.equal((await verifySigned(bad, 'recorded', t)).why, 'the key or the signature is malformed', JSON.stringify(bad).slice(0, 40));
  }
  assert.equal((await verifySigned({ ...s, by: '00'.repeat(32) }, 'recorded', ['00'.repeat(32)])).ok, false);
  for (const g of [null, 'x', [], {}]) assert.equal((await verifySigned(g, 'recorded', [R.publicHex])).ok, false);
  await assert.rejects(signAs(R, 'other', {}), /not a kind of signature/);
  await assert.rejects(signerFromSeed(new Uint8Array(31)), /32 bytes/); await assert.rejects(signerFromSeed('x'), /32 bytes/);
});

test('an untouched bundle verifies, and carries what it signed', async () => {
  assert.deepEqual(await verifyBundle(BUNDLE, TRUST), { ok: true, problems: [] });
  const h = await recordHash(RECORD);
  assert.equal(h, await sha256hex(canonical(RECORD)));
  assert.deepEqual(BUNDLE.recorded.payload, { job_id: 'j1', record: h, log: { head: LOG[LOG.length - 1].hash, length: 5 } });
  assert.deepEqual(BUNDLE.judged.payload, { record: h, rubric: JUDGED.rubric, judgement: await sha256hex(canonical(JUDGED)) });
  assert.deepEqual(BUNDLE.reviewed.payload, { record: h, decisions: DECIDE });
  assert.ok(DECIDE.length > 0, 'the record has flags to decide'); assert.deepEqual([...DECISIONS], ['upheld', 'overturned']);
  const noReview = await makeBundle({ record: RECORD, log: LOG, recorder: R, judge: J });
  assert.equal(noReview.reviewed, undefined); assert.deepEqual(await verifyBundle(noReview, TRUST), { ok: true, problems: [] });
  assert.deepEqual((await makeBundle({ record: RECORD, log: LOG, recorder: R, judge: J, reviewer: V })).reviewed.payload.decisions, []);
  const empty = await makeBundle({ record: toRecord({ intent, events: [] }), log: [], recorder: R, judge: J });
  assert.equal(empty.recorded.payload.log.head, GENESIS); assert.equal(empty.recorded.payload.log.length, 0);
  assert.deepEqual((await verifyBundle(empty, TRUST)).problems, []);
});

test('the log: changed, cut short, rewritten whole, or not the record’s timeline — each refused, saying why', async () => {
  const changed = copy(); changed.log[1].tool = 'Write';
  assert.deepEqual(await why(changed), ['log: line 1 has been changed', 'record: its timeline is not the log’s']);
  const cut = copy(); cut.log.pop();
  assert.deepEqual(await why(cut), ['log: it does not end where the recorder signed (4 lines, not 5)']);
  const re = copy(); re.log = await chain([...EVENTS.slice(0, 2), { kind: 'question', at: '2026-10-29T10:00:02.000Z', text: 'what' }, ...EVENTS.slice(3)]);
  assert.deepEqual(await why(re), ['log: it does not end where the recorder signed (5 lines, not 5)', 'record: its timeline is not the log’s']);
  const swapped = copy(); [swapped.log[1], swapped.log[2]] = [swapped.log[2], swapped.log[1]];
  assert.deepEqual(await why(swapped), ['log: line 1 does not follow the line before it', 'record: its timeline is not the log’s']);
  const noP = copy(); noP.recorded.payload.log = 'x'; noP.recorded = await signAs(R, 'recorded', noP.recorded.payload);
  assert.deepEqual(await why(noP), ['log: it does not end where the recorder signed (5 lines, not ?)']);
  const other = copy(); other.record.timeline[0].model = 'z';
  assert.ok((await why(other)).includes('recorder: signed a different record'));
});

test('forgery: the attacker’s key, a signature moved to another record or job, a judgement that does not re-run, a reviewer off the flags', async () => {
  const forged = await makeBundle({ record: RECORD, log: LOG, recorder: X, judge: X, reviewer: X, decisions: DECIDE });
  assert.deepEqual(await why(forged), ['recorder: signed by a key not on the trust list', 'judge: signed by a key not on the trust list', 'reviewer: signed by a key not on the trust list']);
  const otherRecord = toRecord({ job_id: 'j2', member_id: 'm', harness: { name: 'claude-code' }, intent, events: eventsOf(LOG) });
  const moved = { ...copy(), record: otherRecord };
  assert.deepEqual(await why(moved), ['recorder: signed a different record', 'recorder: signed for a different job', 'judge: signed a different record', 'judge: the judgement signed is not what judging the record again gives', 'reviewer: decided on a different record']);
  const lie = copy(); lie.judged = await signAs(J, 'judged', { ...lie.judged.payload, judgement: '0'.repeat(64) });
  assert.deepEqual(await why(lie), ['judge: the judgement signed is not what judging the record again gives']);
  const rubric = copy(); rubric.judged = await signAs(J, 'judged', { ...rubric.judged.payload, rubric: 'v9' });
  assert.deepEqual(await why(rubric), ['judge: the judgement signed is not what judging the record again gives']);
  const job = copy(); job.recorded = await signAs(R, 'recorded', { ...job.recorded.payload, job_id: 'j9' });
  assert.deepEqual(await why(job), ['recorder: signed for a different job']);
  for (const d of [[{ check: 'P1', decision: 'upheld', note: 'x' }], [{ check: DECIDE[0].check, decision: 'maybe', note: 'x' }], [{ check: DECIDE[0].check, decision: 'upheld' }], 'x', [null]]) {
    const r = copy(); r.reviewed = await signAs(V, 'reviewed', { record: r.reviewed.payload.record, decisions: d });
    assert.deepEqual(await why(r), ['reviewer: a decision is not on a flagged check, or is not upheld or overturned with a note'], JSON.stringify(d));
  }
  const overturned = copy(); overturned.reviewed = await signAs(V, 'reviewed', { record: overturned.reviewed.payload.record, decisions: [{ ...DECIDE[0], decision: 'overturned' }] });
  assert.deepEqual(await why(overturned), []);
  const noJudge = copy(); delete noJudge.judged;
  assert.deepEqual(await why(noJudge), ['judge: not a judged signature', 'reviewer: a decision is not on a flagged check, or is not upheld or overturned with a note'], 'with no judgement there are no flags to decide');
  const noPayloads = copy(); noPayloads.recorded = await signAs(R, 'recorded', 'x'); noPayloads.judged = await signAs(J, 'judged', 'x'); noPayloads.reviewed = await signAs(V, 'reviewed', 'x');
  assert.ok((await why(noPayloads)).includes('reviewer: decided on a different record'));
  assert.deepEqual(await why(BUNDLE, { recorders: [R.publicHex] }), ['judge: signed by a key not on the trust list', 'reviewer: signed by a key not on the trust list']);
});

test('garbage is refused, never thrown', async () => {
  for (const g of [null, 'x', [], {}, { record: {} }, { log: [] }, { record: 'x', log: [] }]) assert.deepEqual(await verifyBundle(g, TRUST), { ok: false, problems: ['not a bundle'] });
  assert.equal((await verifyBundle(BUNDLE, null)).ok, false);
  const r = await verifyBundle({ record: {}, log: ['x'], recorded: 1, judged: 1, reviewed: 1 }, TRUST);
  assert.equal(r.ok, false); assert.ok(r.problems.length >= 3);
});
