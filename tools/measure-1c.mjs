#!/usr/bin/env node
// tools/measure-1c.mjs — organ 1c measured against its seal (claims/organ-1c.json): the strict P0 (assessStrict(),
// rubric v3) over fresh damaged records — the marker bug fixed, so a null record is judged — and over organ 1's clean
// and planted jobs; and the records organ 1b passed cleanly, made again from their seeds by 1b's own loop.
//   node tools/measure-1c.mjs           → receipts/organ-1c.json
//   node tools/measure-1c.mjs --check   → re-run; refuse unless the receipt comes out byte for byte the same
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { assess, assessStrict, judge, RUBRIC_V3 } from '../src/judge.mjs';
import { factsOf, sha256hex, canonical } from '../src/record.mjs';
import { cleanJob, plantedJob, malformedJob, KINDS } from './suite.mjs';

const ROOT = new URL('../', import.meta.url);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const path = 'claims/organ-1c.json', text = readFileSync(new URL(path, ROOT), 'utf8');
const commit = git('log', '-1', '--format=%H', '--', path).trim();
if (!commit || git('show', commit + ':' + path) !== text) { console.log(path + ' differs from the commit that sealed it — refusing to measure'); process.exit(1); }
const claims = JSON.parse(text), bar = Object.fromEntries(claims.claims.map((c) => [c.id, c.bar]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const outcome = (a, id) => a.results.find((x) => x.id === id).outcome;
/** a damaged record for this seed that differs from its clean source; found is false only if fifty damages all left it whole */
async function damaged(seed) {
  for (let k = 0; k < 50; k++) { const s = seed + k * 1000003, m = await malformedJob(s); if (canonical(m) !== canonical(await cleanJob(s))) return { found: true, record: m }; }
  return { found: false, record: undefined };
}

// C1, C2, and C4's null half: fresh damage
const N = 2000;
let unmade = 0, threw = 0, cleanPass = 0, p0Fail = 0, nulls = 0, nullsFailP0 = 0, again1 = 0;
for (let i = 0; i < N; i++) {
  const d = await damaged(290000 + i);
  if (!d.found) { unmade++; continue; }
  try {
    const f = await factsOf(d.record), a = assessStrict(d.record, f);
    if (same(a, assessStrict(d.record, f))) again1++;
    if (a.counts.pass === a.results.length) cleanPass++;
    if (outcome(a, 'P0') === 'fail') p0Fail++;
    if (d.record === null) { nulls++; if (outcome(a, 'P0') === 'fail') nullsFailP0++; }
  } catch { threw++; }
}

// C4's other half: the records organ 1b judged a clean pass, made again by 1b's own loop (seeds 190000 on, null as its marker)
let v2Clean = 0, nowFailP0 = 0;
for (let i = 0; i < N; i++) {
  const seed = 190000 + i; let rec = null;
  for (let k = 0; k < 50; k++) { const s = seed + k * 1000003, m = await malformedJob(s); if (canonical(m) !== canonical(await cleanJob(s))) { rec = m; break; } }
  if (rec === null) continue;
  const f = await factsOf(rec), a = assess(rec, f);
  if (a.counts.pass === a.results.length) { v2Clean++; if (outcome(assessStrict(rec, f), 'P0') === 'fail') nowFailP0++; }
}

// C3: organ 1's clean and planted jobs
let goodP0 = 0, moved = 0, again3 = 0, good = 0;
const check = async (rec) => { good++; const f = await factsOf(rec), a = assessStrict(rec, f); if (outcome(a, 'P0') === 'pass') goodP0++; if (!same(a.results.slice(1), judge(rec, f).results)) moved++; if (same(a, assessStrict(rec, f))) again3++; };
for (let i = 1; i <= 500; i++) await check(await cleanJob(i));
for (const [k, kind] of KINDS.entries()) for (let i = 0; i < 50; i++) await check((await plantedJob(10000 + k * 1000 + i, kind)).job);

const facts = { rubric: RUBRIC_V3.id,
  fresh: { damaged: N, unmade, threw, cleanPass, failedP0: p0Fail, deterministic: again1, nulls, nullsFailedP0: nullsFailP0 },
  earlier: { cleanPassesUnderV2: v2Clean, nowFailStrictP0: nowFailP0 },
  good: { jobs: good, p0Passed: goodP0, otherChecksMoved: moved, deterministic: again3 } };
const judged = N - facts.fresh.unmade;
const RULES = {
  C1: (f) => [f.fresh.unmade === 0 && f.fresh.threw === 0 && f.fresh.cleanPass <= bar.C1.cleanPasses && f.fresh.deterministic === judged,
    f.fresh.damaged + ' fresh damaged records (' + f.fresh.unmade + ' could not be made different): clean passes ' + f.fresh.cleanPass + ', threw ' + f.fresh.threw + ', the same judgement twice ' + f.fresh.deterministic],
  C2: (f) => [f.fresh.failedP0 / f.fresh.damaged >= bar.C2.rate, f.fresh.failedP0 + ' of ' + f.fresh.damaged + ' failed the strict P0 (' + Math.round(f.fresh.failedP0 / f.fresh.damaged * 1000) / 10 + '%)'],
  C3: (f) => [f.good.p0Passed === f.good.jobs && f.good.otherChecksMoved === 0 && f.good.deterministic === f.good.jobs,
    'the strict P0 passed ' + f.good.p0Passed + ' of ' + f.good.jobs + ' clean and planted jobs; the other ten moved on ' + f.good.otherChecksMoved + '; the same twice on ' + f.good.deterministic],
  C4: (f) => [f.earlier.cleanPassesUnderV2 > 0 && f.earlier.nowFailStrictP0 === f.earlier.cleanPassesUnderV2 && f.fresh.nullsFailedP0 === f.fresh.nulls && f.fresh.nulls > 0,
    'the ' + f.earlier.cleanPassesUnderV2 + ' records organ 1b passed cleanly: ' + f.earlier.nowFailStrictP0 + ' now fail the strict P0; null records among the fresh damage: ' + f.fresh.nulls + ', judged and failing P0: ' + f.fresh.nullsFailedP0],
};
const verdicts = claims.claims.map((c) => { const [held, measured] = RULES[c.id](facts); return { id: c.id, kind: c.kind, claim: c.claim, held, measured }; });
const receipt = { kind: 'acg-autopilot.receipt', organ: '1c', v: 1, sealed: { path, commit, claimsSha256: await sha256hex(text) }, facts, verdicts, held: verdicts.filter((v) => v.held).length, failed: verdicts.filter((v) => !v.held).length };
const json = JSON.stringify(receipt, null, 1) + '\n';
if (process.argv.includes('--check')) {
  const was = readFileSync(new URL('receipts/organ-1c.json', ROOT), 'utf8');
  console.log(was === json ? 'ORGAN 1c REPRODUCED · ' + receipt.held + ' held, ' + receipt.failed + ' failed, byte for byte' : 'ORGAN 1c DRIFT · the re-run differs from the receipt');
  process.exit(was === json ? 0 : 1);
}
writeFileSync(new URL('receipts/organ-1c.json', ROOT), json);
for (const v of verdicts) console.log((v.held ? 'HELD   ' : 'FAILED ') + v.id + ' · ' + v.measured);
console.log('wrote receipts/organ-1c.json · ' + receipt.held + ' held, ' + receipt.failed + ' failed');
