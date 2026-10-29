// src/bundle.mjs — organ 3: a signed record. A bundle is { record, log, recorded, judged, reviewed }:
//   recorded — the recorder's signature over the record's hash, its job, and where its log ends (last hash, line count)
//   judged   — the judge's over the record's hash, the rubric, and the hash of the judgement (assessStrict, rubric v3)
//   reviewed — a reviewer's over the record's hash and a decision (upheld or overturned) on each flagged check
// verifyBundle() checks every one against a trust list, and checks the things a signature alone cannot: that the log
// verifies and ends where the recorder signed (so a log cut short or rewritten with fresh hashes is refused), that the
// record's timeline is the log's, that judging the record again gives the judgement signed, and that a reviewer
// decided only flagged checks. Total: garbage is refused with its reasons.
import { canonical, sha256hex, factsOf } from './record.mjs';
import { verifyLog, eventsOf, GENESIS } from './log.mjs';
import { toRecord } from './normalise.mjs';
import { assessStrict } from './judge.mjs';
import { signAs, verifySigned } from './sign.mjs';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const DECISIONS = Object.freeze(['upheld', 'overturned']);
export const recordHash = (record) => sha256hex(canonical(record));
const endOf = (lines) => ({ head: lines.length ? lines[lines.length - 1].hash : GENESIS, length: lines.length });
const timelineOf = (record) => (Array.isArray(record.timeline) ? record.timeline : null);   // called only with an object record

/** makeBundle({ record, log, recorder, judge, reviewer, decisions }) → the bundle, each signature present if its signer is */
export async function makeBundle({ record, log, recorder, judge, reviewer, decisions }) {
  const h = await recordHash(record), out = { record, log };
  if (recorder) out.recorded = await signAs(recorder, 'recorded', { job_id: record.job_id, record: h, log: endOf(log) });
  if (judge) { const j = assessStrict(record, await factsOf(record)); out.judged = await signAs(judge, 'judged', { record: h, rubric: j.rubric, judgement: await sha256hex(canonical(j)) }); }
  if (reviewer) out.reviewed = await signAs(reviewer, 'reviewed', { record: h, decisions: Array.isArray(decisions) ? decisions : [] });
  return out;
}

/** verifyBundle(bundle, { recorders, judges, reviewers }) → { ok, problems } */
export async function verifyBundle(b, trust) {
  const t = isObj(trust) ? trust : {}, problems = [];
  if (!isObj(b) || !isObj(b.record) || !Array.isArray(b.log)) return { ok: false, problems: ['not a bundle'] };
  const h = await recordHash(b.record);
  // the recorder: who wrote it, which job, and where the log ends
  const rec = await verifySigned(b.recorded, 'recorded', t.recorders);
  if (!rec.ok) problems.push('recorder: ' + rec.why);
  else {
    const p = isObj(b.recorded.payload) ? b.recorded.payload : {};
    if (p.record !== h) problems.push('recorder: signed a different record');
    if (p.job_id !== b.record.job_id) problems.push('recorder: signed for a different job');
    const v = await verifyLog(b.log);
    if (!v.ok) problems.push('log: ' + v.why);
    else if (!isObj(p.log) || p.log.head !== v.head || p.log.length !== v.length) problems.push('log: it does not end where the recorder signed (' + (isObj(p.log) && p.log.length === v.length ? 'the same ' + v.length + ' lines, but its last line is not the one signed' : v.length + ' lines, not ' + (isObj(p.log) ? p.log.length : '?')) + ')');
    const fromLog = toRecord({ events: eventsOf(b.log) }).timeline;
    if (JSON.stringify(fromLog) !== JSON.stringify(timelineOf(b.record))) problems.push('record: its timeline is not the log’s');
  }
  // the judge: the judgement must be what judging the record again gives
  const jud = await verifySigned(b.judged, 'judged', t.judges);
  let judgement = null;
  if (!jud.ok) problems.push('judge: ' + jud.why);
  else {
    const p = isObj(b.judged.payload) ? b.judged.payload : {};
    judgement = assessStrict(b.record, await factsOf(b.record));
    if (p.record !== h) problems.push('judge: signed a different record');
    if (p.rubric !== judgement.rubric || p.judgement !== await sha256hex(canonical(judgement))) problems.push('judge: the judgement signed is not what judging the record again gives');
  }
  // the reviewer, if there is one: decisions on flagged checks only, about this record
  if (b.reviewed !== undefined) {
    const rv = await verifySigned(b.reviewed, 'reviewed', t.reviewers);
    if (!rv.ok) problems.push('reviewer: ' + rv.why);
    else {
      const p = isObj(b.reviewed.payload) ? b.reviewed.payload : {}, flagged = judgement ? judgement.review : [];
      if (p.record !== h) problems.push('reviewer: decided on a different record');
      const ds = Array.isArray(p.decisions) ? p.decisions : null;
      if (!ds || ds.some((d) => !isObj(d) || !flagged.includes(d.check) || !DECISIONS.includes(d.decision) || typeof d.note !== 'string')) problems.push('reviewer: a decision is not on a flagged check, or is not upheld or overturned with a note');
    }
  }
  return { ok: problems.length === 0, problems };
}
