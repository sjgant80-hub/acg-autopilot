#!/usr/bin/env node
// tools/measure-1b.mjs — organ 1b measured against its seal (claims/organ-1b.json): P0 in place (assess(), rubric v2)
// over fresh malformed records, each checked to differ from its clean source, and over organ 1's clean and planted jobs.
//   node tools/measure-1b.mjs           → receipts/organ-1b.json
//   node tools/measure-1b.mjs --check   → re-run; refuse unless the receipt comes out byte for byte the same
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { assess, RUBRIC_V2 } from '../src/judge.mjs';
import { factsOf, sha256hex, canonical } from '../src/record.mjs';
import { cleanJob, plantedJob, malformedJob, KINDS } from './suite.mjs';

const ROOT = new URL('../', import.meta.url);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const path = 'claims/organ-1b.json', text = readFileSync(new URL(path, ROOT), 'utf8');
const commit = git('log', '-1', '--format=%H', '--', path).trim();
if (!commit || git('show', commit + ':' + path) !== text) { console.log(path + ' differs from the commit that sealed it — refusing to measure'); process.exit(1); }
const claims = JSON.parse(text);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function run(rec) { const f = await factsOf(rec), a = assess(rec, f); return { a, again: same(a, assess(rec, f)) }; }
const out = (a, id) => a.results.find((x) => x.id === id).outcome;

// B1: fresh malformed records (seeds 190000 on, none used before), each differing from its clean source — a damage
// that left the record unchanged is replaced by the next damage of the same seed, so every one is malformed
let threw = 0, failed = 0, cleanPass = 0, viaP0 = 0, retried = 0, again1 = 0, unmade = 0;
const N = 2000;
for (let i = 0; i < N; i++) {
  const seed = 190000 + i;
  let rec = null;
  for (let k = 0; k < 50; k++) { const m = await malformedJob(seed + k * 1000003); if (canonical(m) !== canonical(await cleanJob(seed + k * 1000003)) ) { rec = m; break; } retried++; }
  if (rec === null) { unmade++; continue; }
  try { const { a, again } = await run(rec); if (out(a, 'P0') === 'fail' || out(a, 'P1') === 'fail') failed++; if (out(a, 'P0') === 'fail') viaP0++; if (a.counts.pass === a.results.length) cleanPass++; if (again) again1++; } catch { threw++; }
}

// B2 and B3: organ 1's clean and planted jobs, judged with P0 in place
let p0Clean = 0, otherFalse = 0, again2 = 0, caught = 0, p0Planted = 0;
for (let i = 1; i <= 500; i++) { const { a, again } = await run(await cleanJob(i)); if (out(a, 'P0') === 'pass') p0Clean++; otherFalse += a.results.filter((x) => x.id !== 'P0' && x.outcome !== 'pass').length; if (again) again2++; }
for (const [k, kind] of KINDS.entries()) for (let i = 0; i < 50; i++) {
  const p = await plantedJob(10000 + k * 1000 + i, kind), { a, again } = await run(p.job), x = a.results.find((y) => y.id === kind);
  if ((x.outcome === 'flag' || x.outcome === 'fail') && x.evidence.some((e) => same(e, p.pointer))) caught++;
  if (out(a, 'P0') === 'pass') p0Planted++; if (again) again2++;
}

const facts = { rubric: RUBRIC_V2.id,
  B1: { malformed: N, unmade, threw, failed, viaP0, cleanPass, deterministic: again1, unchangedDamagesReplaced: retried },
  B2: { clean: 500, p0Passed: p0Clean, otherFlagsOrFails: otherFalse },
  B3: { planted: 500, caught, p0PassedOnPlanted: p0Planted, deterministic: again2, judged: 1000 } };
const RULES = {
  B1: (f) => [f.B1.unmade === 0 && f.B1.threw === 0 && f.B1.failed === f.B1.malformed && f.B1.cleanPass === 0 && f.B1.deterministic === f.B1.malformed,
    f.B1.malformed + ' fresh malformed records, each differing from its source (' + f.B1.unchangedDamagesReplaced + ' damages that changed nothing were replaced): failed ' + f.B1.failed + ' (' + f.B1.viaP0 + ' at P0), clean passes ' + f.B1.cleanPass + ', threw ' + f.B1.threw + ', deterministic ' + f.B1.deterministic],
  B2: (f) => [f.B2.p0Passed === f.B2.clean && f.B2.otherFlagsOrFails === 0, 'P0 passed ' + f.B2.p0Passed + ' of ' + f.B2.clean + ' clean jobs; the other ten gave ' + f.B2.otherFlagsOrFails + ' flags or fails'],
  B3: (f) => [f.B3.caught === f.B3.planted && f.B3.deterministic === f.B3.judged, 'planted failures still caught with their pointer: ' + f.B3.caught + ' of ' + f.B3.planted + ' (P0 passed ' + f.B3.p0PassedOnPlanted + ' of them); the same judgement twice on ' + f.B3.deterministic + ' of ' + f.B3.judged],
};
const verdicts = claims.claims.map((c) => { const [held, measured] = RULES[c.id](facts); return { id: c.id, kind: c.kind, claim: c.claim, held, measured }; });
const receipt = { kind: 'acg-autopilot.receipt', organ: '1b', v: 1, sealed: { path, commit, claimsSha256: await sha256hex(text) }, facts, verdicts, held: verdicts.filter((v) => v.held).length, failed: verdicts.filter((v) => !v.held).length };
const json = JSON.stringify(receipt, null, 1) + '\n';
if (process.argv.includes('--check')) {
  const was = readFileSync(new URL('receipts/organ-1b.json', ROOT), 'utf8');
  console.log(was === json ? 'ORGAN 1b REPRODUCED · ' + receipt.held + ' held, ' + receipt.failed + ' failed, byte for byte' : 'ORGAN 1b DRIFT · the re-run differs from the receipt');
  process.exit(was === json ? 0 : 1);
}
writeFileSync(new URL('receipts/organ-1b.json', ROOT), json);
for (const v of verdicts) console.log((v.held ? 'HELD   ' : 'FAILED ') + v.id + ' · ' + v.measured);
console.log('wrote receipts/organ-1b.json · ' + receipt.held + ' held, ' + receipt.failed + ' failed');
