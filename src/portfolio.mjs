// src/portfolio.mjs — organ 5: the member's portfolio (claims/organ-5.json).
//   attest(bundle, trust, judge)   the judge checks the whole bundle (organ 3's checks, through organ 4's trust list:
//                                  every signature, where the log ends, the judgement judged again, the reviewer's
//                                  decisions), then signs only what a portfolio shows: the record's hash, the job, the
//                                  member's pseudonymous id, the rubric, each check's outcome, the review queue, each
//                                  decision as upheld or overturned (never its note), and the recorder's and reviewer's
//                                  public keys. No goal, note, claim, tool name or file name is in it.
//   buildPortfolio({ member, bundles, trust, judge, include, reveal })
//                                  only the jobs the member includes, each as its attestation; the full bundle only for
//                                  the jobs the member reveals; the scores counted from the attestations.
//   checkPortfolio(portfolio, trust)
//                                  anyone with the trust list checks it without seeing a record; a revealed job is
//                                  checked in full and judged again.
// A portfolio shows what its member chose: leaving a job out is the member's right, so it says how many jobs it holds,
// not how many there were. Pure apart from WebCrypto, and total: garbage is refused, never thrown.
import { factsOf, canonical } from './record.mjs';
import { assessStrict, RUBRIC_V3 } from './judge.mjs';
import { message, verifySigned } from './sign.mjs';
import { recordHash, DECISIONS } from './bundle.mjs';
import { verifyTrusted, effective, revokedOf } from './trust.mjs';

export const KIND = 'acg-autopilot.portfolio';
export const CHECK_IDS = Object.freeze(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10']);
/** the habits the spec names, by the check that shows each; a job keeps one with a pass, or a flag a reviewer overturned */
export const HABITS = Object.freeze({ P1: 'the intent sealed before work', P3: 'only allowed or approved tools', P4: 'claims backed by evidence', P5: 'every number traceable',
  P8: 'checked by something other than the agent', P9: 'the person’s direction', P10: 'a key result re-run, and it reproduced' });
const OUTCOMES = ['pass', 'flag', 'fail'];
const FIELDS = 'decisions,job_id,member,outcomes,record,recorder,review,reviewer,rubric';
const KEY = /^[0-9a-f]{64}$/;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const strings = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string') : []);
const no = (why) => ({ ok: false, problems: [why], jobs: 0, revealed: 0 });

/** what a portfolio shows of a bundle: judging its record again, and its reviewer's decisions without their notes */
async function shownOf(b) {
  const j = assessStrict(b.record, await factsOf(b.record)), ds = b.reviewed === undefined ? [] : b.reviewed.payload.decisions;
  return {
    record: await recordHash(b.record), job_id: b.record.job_id, member: b.record.member_id, rubric: j.rubric,
    outcomes: Object.fromEntries(j.results.map((x) => [x.id, x.outcome])), review: j.review,
    decisions: CHECK_IDS.flatMap((c) => ds.filter((d) => d.check === c).map((d) => ({ check: c, decision: d.decision }))),
    recorder: b.recorded.by, reviewer: b.reviewed === undefined ? null : b.reviewed.by,
  };
}

/** attest(bundle, trust, judge) → { ok, attested } or { ok: false, problems } */
export async function attest(b, trust, judge) {
  try {
    const v = await verifyTrusted(b, trust);
    if (!v.ok) return { ok: false, problems: v.problems };
    const shown = await shownOf(b);
    if (new Set(shown.decisions.map((d) => d.check)).size !== shown.decisions.length) return { ok: false, problems: ['reviewer: a check decided twice'] };
    return { ok: true, attested: { kind: 'attested', payload: shown, by: judge.publicHex, sig: await judge.sign(message('attested', shown)) } };
  } catch { return { ok: false, problems: ['not a bundle that can be attested'] }; }
}

/** the scores: counts worked out from well-formed entries (checkPortfolio checks them first) */
export function scoresOf(entries) {
  const s = { jobs: 0, revealed: 0, checks: Object.fromEntries(CHECK_IDS.map((c) => [c, { pass: 0, flag: 0, fail: 0 }])), flags: { upheld: 0, overturned: 0, undecided: 0 }, fullyReviewed: 0,
    habits: Object.fromEntries(Object.keys(HABITS).map((h) => [h, 0])) };
  for (const e of entries) {
    const p = e.attested.payload, decided = new Map(p.decisions.map((d) => [d.check, d.decision]));
    s.jobs++;
    if (e.bundle !== undefined) s.revealed++;
    for (const c of CHECK_IDS) s.checks[c][p.outcomes[c]]++;
    for (const c of p.review) s.flags[decided.get(c) || 'undecided']++;
    if (p.review.every((c) => decided.has(c))) s.fullyReviewed++;
    for (const h of Object.keys(HABITS)) if (p.outcomes[h] === 'pass' || decided.get(h) === 'overturned') s.habits[h]++;
  }
  return s;
}

/** buildPortfolio(…) → { portfolio, left: [{ job, why }] }; `left` is for the member, and is not part of the portfolio */
export async function buildPortfolio({ member, bundles, trust, judge, include, reveal } = {}) {
  const chosen = new Set(strings(include)), shown = new Set(strings(reveal)), by = new Map(), left = [];
  for (const b of Array.isArray(bundles) ? bundles : []) {
    const job = isObj(b) && isObj(b.record) && typeof b.record.job_id === 'string' ? b.record.job_id : null;
    if (job === null) { left.push({ job, why: 'not a bundle' }); continue; }
    if (b.record.member_id !== member) { left.push({ job, why: 'another member’s job' }); continue; }
    if (!chosen.has(job)) { left.push({ job, why: 'not chosen' }); continue; }
    if (by.has(job)) { left.push({ job, why: 'already in the portfolio' }); continue; }
    const a = await attest(b, trust, judge);
    if (!a.ok) { left.push({ job, why: 'refused: ' + a.problems.join('; ') }); continue; }
    by.set(job, shown.has(job) ? { attested: a.attested, bundle: b } : { attested: a.attested });
  }
  const entries = [...by.keys()].sort().map((j) => by.get(j));
  return { portfolio: { kind: KIND, v: 1, member, rubric: RUBRIC_V3.id, entries, scores: scoresOf(entries) }, left };
}

/** what is wrong with an attestation's payload for this portfolio, or null */
function payloadProblem(p, member) {
  if (!isObj(p) || Object.keys(p).sort().join() !== FIELDS) return 'not an attestation a portfolio holds';
  if (p.member !== member) return 'about another member';
  if (p.rubric !== RUBRIC_V3.id) return 'judged under another rubric';
  if (typeof p.record !== 'string' || !KEY.test(p.record) || typeof p.job_id !== 'string' || !p.job_id) return 'no record hash, or no job';
  if (!isObj(p.outcomes) || Object.keys(p.outcomes).length !== CHECK_IDS.length || !CHECK_IDS.every((c) => OUTCOMES.includes(p.outcomes[c]))) return 'its outcomes are not pass, flag or fail for each of P0 to P10';
  if (RUBRIC_V3.judgement.some((c) => p.outcomes[c] === 'fail')) return 'a judgement item failed by the machine';
  if (canonical(p.review) !== canonical(CHECK_IDS.filter((c) => p.outcomes[c] === 'flag'))) return 'its review queue is not its flags';
  if (!Array.isArray(p.decisions) || !p.decisions.every((d) => isObj(d) && Object.keys(d).length === 2 && p.review.includes(d.check) && DECISIONS.includes(d.decision))
    || new Set(p.decisions.map((d) => d.check)).size !== p.decisions.length) return 'a decision is not one flag upheld or overturned, once';
  if (p.reviewer === null && p.decisions.length > 0) return 'decisions, and no reviewer';
  return null;
}

/** checkPortfolio(portfolio, trust) → { ok, problems, jobs, revealed } */
export async function checkPortfolio(p, trust) {
  try {
    if (!isObj(p) || Object.keys(p).sort().join() !== 'entries,kind,member,rubric,scores,v' || p.kind !== KIND || p.v !== 1 || typeof p.member !== 'string' || !p.member
      || p.rubric !== RUBRIC_V3.id || !Array.isArray(p.entries) || !isObj(p.scores)) return no('not a portfolio');
    const eff = effective(trust), rev = revokedOf(trust), problems = [], jobs = new Set(), records = new Set();
    const whose = (role, k) => (rev.has(k) ? role + ' by a revoked key (' + rev.get(k).reason + ', ' + rev.get(k).at + ')' : role + ' by a key not on the trust list');
    for (const [i, e] of p.entries.entries()) {
      const at = 'entry ' + i + ' (' + (isObj(e) && isObj(e.attested) && isObj(e.attested.payload) ? String(e.attested.payload.job_id) : '?') + '): ';
      if (!isObj(e) || !isObj(e.attested) || !Object.keys(e).every((k) => k === 'attested' || k === 'bundle')) { problems.push(at + 'not an entry'); continue; }
      const s = await verifySigned(e.attested, 'attested', eff.judges);
      if (!s.ok) { problems.push(at + (s.why === 'signed by a key not on the trust list' ? whose('attested', e.attested.by) : 'the attestation: ' + s.why)); continue; }
      const a = e.attested.payload, bad = payloadProblem(a, p.member);
      if (bad !== null) { problems.push(at + bad); continue; }
      if (!eff.recorders.includes(a.recorder)) problems.push(at + whose('recorded', a.recorder));
      if (a.reviewer !== null && !eff.reviewers.includes(a.reviewer)) problems.push(at + whose('reviewed', a.reviewer));
      if (jobs.has(a.job_id) || records.has(a.record)) problems.push(at + 'in the portfolio twice');
      jobs.add(a.job_id); records.add(a.record);
      if (e.bundle !== undefined) {
        const v = await verifyTrusted(e.bundle, trust);
        if (!v.ok) problems.push(at + 'revealed, it is refused: ' + v.problems.join('; '));
        else {
          const shown = await shownOf(e.bundle);
          if (shown.record !== a.record) problems.push(at + 'revealed, it is not the record attested');
          else if (canonical(shown) !== canonical(a)) problems.push(at + 'revealed and judged again, it is not what was attested');
        }
      }
    }
    if (problems.length === 0 && canonical(scoresOf(p.entries)) !== canonical(p.scores)) problems.push('the scores are not what the entries give');
    return { ok: problems.length === 0, problems, jobs: p.entries.length, revealed: p.entries.filter((e) => isObj(e) && e.bundle !== undefined).length };
  } catch { return no('the portfolio could not be read'); }
}
