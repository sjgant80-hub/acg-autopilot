#!/usr/bin/env node
// tools/measure-1.mjs — organ 1 measured against its seal (claims/organ-1.json): the planted-failure suite
// (tools/suite.mjs) judged by src/judge.mjs, and each sealed claim held against what came out. Deterministic.
//   node tools/measure-1.mjs           → receipts/organ-1.json
//   node tools/measure-1.mjs --check   → re-run; refuse unless the receipt comes out byte for byte the same
// It refuses to run if the claims differ from the commit that sealed them.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { judge, RUBRIC } from '../src/judge.mjs';
import { factsOf, sha256hex } from '../src/record.mjs';
import { cleanJob, plantedJob, lateIntentJob, malformedJob, KINDS } from './suite.mjs';

const ROOT = new URL('../', import.meta.url);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const path = 'claims/organ-1.json', text = readFileSync(new URL(path, ROOT), 'utf8');
const commit = git('log', '-1', '--format=%H', '--', path).trim();
if (!commit || git('show', commit + ':' + path) !== text) { console.log(path + ' differs from the commit that sealed it — refusing to measure'); process.exit(1); }
const claims = JSON.parse(text), bar = Object.fromEntries(claims.claims.map((c) => [c.id, c.bar]));

const N = { clean: 500, perKind: 50, late: 200, malformed: 2000 };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function run(rec) { const f = await factsOf(rec), j = judge(rec, f); return { j, again: same(j, judge(rec, f)) }; }
const all = [];   // every judged job of A1-A3, for A4 and determinism

// A1: planted failures, 50 of each kind
const perKind = {};
for (const [k, kind] of KINDS.entries()) {
  let caught = 0; const missed = [];
  for (let i = 0; i < N.perKind; i++) {
    const seed = 10000 + k * 1000 + i, p = await plantedJob(seed, kind), { j, again } = await run(p.job), x = j.results.find((y) => y.id === kind);
    all.push({ j, again, set: 'planted' });
    if ((x.outcome === 'flag' || x.outcome === 'fail') && x.evidence.some((e) => same(e, p.pointer))) caught++; else if (missed.length < 3) missed.push({ seed, outcome: x.outcome, why: x.why });
  }
  perKind[kind] = { planted: N.perKind, caught, rate: caught / N.perKind, missed };
}
const caughtAll = Object.values(perKind).reduce((a, x) => a + x.caught, 0), plantedAll = KINDS.length * N.perKind;

// A2: clean jobs
let falseResults = 0; const falseBy = {};
for (let i = 1; i <= N.clean; i++) {
  const { j, again } = await run(await cleanJob(i)); all.push({ j, again, set: 'clean' });
  for (const x of j.results) if (x.outcome !== 'pass') { falseResults++; falseBy[x.id] = (falseBy[x.id] || 0) + 1; }
}

// A3: late intent — the 50 planted P1 above, and 200 more
let lateCaught = 0;
for (let i = 0; i < N.late; i++) { const { j, again } = await run(await lateIntentJob(50000 + i)); all.push({ j, again, set: 'late' }); if (j.results.find((y) => y.id === 'P1').outcome === 'fail') lateCaught++; }
const lateTotal = N.late + perKind.P1.planted, lateAll = lateCaught + perKind.P1.caught;

// A4: across every job judged above
const judgementFails = all.filter(({ j }) => j.results.some((x) => RUBRIC.judgement.includes(x.id) && x.outcome === 'fail')).length;
const queueExact = all.filter(({ j }) => same(j.review, j.results.filter((x) => x.outcome === 'flag').map((x) => x.id))).length;
const flagsTotal = all.reduce((a, { j }) => a + j.review.length, 0);

// A5: malformed records — judged without throwing, failing P1, never a clean pass; and every judgement deterministic
let threw = 0, p1Fail = 0, cleanPass = 0, malAgain = 0;
for (let i = 0; i < N.malformed; i++) {
  const rec = await malformedJob(90000 + i);
  try { const { j, again } = await run(rec); if (j.results.find((y) => y.id === 'P1').outcome === 'fail') p1Fail++; if (j.counts.pass === 10) cleanPass++; if (again) malAgain++; } catch { threw++; }
}
const deterministic = all.filter((x) => x.again).length;

const facts = {
  rubric: RUBRIC.id, judged: { planted: plantedAll, clean: N.clean, late: N.late, all: all.length, malformed: N.malformed },
  A1: { caught: caughtAll, planted: plantedAll, rate: caughtAll / plantedAll, perKind },
  A2: { results: N.clean * 10, falseResults, rate: falseResults / (N.clean * 10), by: falseBy },
  A3: { late: lateTotal, failedP1: lateAll },
  A4: { jobs: all.length, judgementFails, queueExact, flags: flagsTotal },
  A5: { malformed: N.malformed, threw, failedP1: p1Fail, cleanPass, deterministicMalformed: malAgain, deterministicJudged: deterministic, judged: all.length },
};
const pct = (x) => (Math.round(x * 1000) / 10) + '%';
const RULES = {
  A1: (f) => [f.A1.rate >= bar.A1.overall && Object.values(f.A1.perKind).every((k) => k.rate >= bar.A1.perKind),
    'caught ' + f.A1.caught + ' of ' + f.A1.planted + ' (' + pct(f.A1.rate) + '); by kind: ' + KINDS.map((k) => k + ' ' + f.A1.perKind[k].caught + '/' + f.A1.perKind[k].planted).join(', ')],
  A2: (f) => [f.A2.rate <= bar.A2.falseRate, f.A2.falseResults + ' of ' + f.A2.results + ' results on clean jobs were a flag or a fail (' + pct(f.A2.rate) + ')' + (f.A2.falseResults ? ': ' + Object.entries(f.A2.by).map(([k, v]) => k + ' ' + v).join(', ') : '')],
  A3: (f) => [f.A3.failedP1 === f.A3.late, f.A3.failedP1 + ' of ' + f.A3.late + ' jobs with late intent failed P1'],
  A4: (f) => [f.A4.judgementFails === 0 && f.A4.queueExact === f.A4.jobs, f.A4.jobs + ' jobs judged (the seal says 1,250; the suite it seals makes 500 + 500 + 200 = 1,200): judgement items failed by automation in ' + f.A4.judgementFails + '; review queue exactly the flags in ' + f.A4.queueExact + ' (' + f.A4.flags + ' flags)'],
  A5: (f) => [f.A5.threw === 0 && f.A5.failedP1 === f.A5.malformed && f.A5.cleanPass === 0 && f.A5.deterministicMalformed === f.A5.malformed && f.A5.deterministicJudged === f.A5.judged,
    f.A5.malformed + ' malformed records: threw ' + f.A5.threw + ', failed P1 ' + f.A5.failedP1 + ', judged a clean pass ' + f.A5.cleanPass + '; the same judgement twice: ' + f.A5.deterministicMalformed + ' of ' + f.A5.malformed + ' malformed, ' + f.A5.deterministicJudged + ' of ' + f.A5.judged + ' others'],
};
const verdicts = claims.claims.map((c) => { const [held, measured] = RULES[c.id](facts); return { id: c.id, kind: c.kind, claim: c.claim, held, measured }; });
const receipt = { kind: 'acg-autopilot.receipt', organ: 1, v: 1, sealed: { path, commit, claimsSha256: await sha256hex(text) }, facts, verdicts, held: verdicts.filter((v) => v.held).length, failed: verdicts.filter((v) => !v.held).length };
const out = JSON.stringify(receipt, null, 1) + '\n';
if (process.argv.includes('--check')) {
  const was = readFileSync(new URL('receipts/organ-1.json', ROOT), 'utf8');
  console.log(was === out ? 'ORGAN 1 REPRODUCED · ' + receipt.held + ' held, ' + receipt.failed + ' failed, byte for byte' : 'ORGAN 1 DRIFT · the re-run differs from the receipt');
  process.exit(was === out ? 0 : 1);
}
mkdirSync(new URL('receipts/', ROOT), { recursive: true });
writeFileSync(new URL('receipts/organ-1.json', ROOT), out);
for (const v of verdicts) console.log((v.held ? 'HELD   ' : 'FAILED ') + v.id + ' · ' + v.measured);
console.log('wrote receipts/organ-1.json · ' + receipt.held + ' held, ' + receipt.failed + ' failed');
