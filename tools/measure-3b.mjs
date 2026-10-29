#!/usr/bin/env node
// tools/measure-3b.mjs — organ 3b measured against its seal (claims/organ-3b.json): on organ 3's 1,000 bundles, the
// judge's key signing the true judgement with one check's outcome changed must be refused, and the true one verify.
// Deterministic.   node tools/measure-3b.mjs → receipts/organ-3b.json · --check: byte for byte
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { signerFromSeed, signAs } from '../src/sign.mjs';
import { makeBundle, verifyBundle } from '../src/bundle.mjs';
import { link, GENESIS, eventsOf } from '../src/log.mjs';
import { toRecord } from '../src/normalise.mjs';
import { assessStrict } from '../src/judge.mjs';
import { factsOf, sha256hex, canonical } from '../src/record.mjs';
import { cleanJob, plantedJob, KINDS } from './suite.mjs';

const ROOT = new URL('../', import.meta.url);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const path = 'claims/organ-3b.json', text = readFileSync(new URL(path, ROOT), 'utf8');
const commit = git('log', '-1', '--format=%H', '--', path).trim();
if (!commit || git('show', commit + ':' + path) !== text) { console.log(path + ' differs from the commit that sealed it — refusing to measure'); process.exit(1); }
const claims = JSON.parse(text);
const seedOf = (b) => new Uint8Array(32).fill(b);
const [R, J, V] = await Promise.all([0x11, 0x22, 0x33].map((b) => signerFromSeed(seedOf(b))));   // organ 3's demonstration keys
const TRUST = { recorders: [R.publicHex], judges: [J.publicHex], reviewers: [V.publicHex] };
async function chain(events) { const out = []; let p = GENESIS; for (const e of events) { const l = await link(p, e); out.push(l); p = l.hash; } return out; }
const eventsOfJob = (job) => [...job.timeline.map(({ seq, ...e }) => e), ...job.artifacts.map((a) => ({ kind: 'artifact', ...a })), ...job.claims.map((c) => ({ kind: 'claim', ...c }))];
const jobs = [];
for (let i = 1; i <= 500; i++) jobs.push(await cleanJob(i));
for (const [k, kind] of KINDS.entries()) for (let i = 0; i < 50; i++) jobs.push((await plantedJob(10000 + k * 1000 + i, kind)).job);

let refused = 0, trueVerified = 0, differed = 0;
for (const job of jobs) {
  const log = await chain(eventsOfJob(job)), record = toRecord({ job_id: job.job_id, member_id: job.member_id, harness: job.harness, intent: job.intent, events: eventsOf(log) });
  const b = await makeBundle({ record, log, recorder: R, judge: J }), truth = assessStrict(record, await factsOf(record));
  const falsified = structuredClone(truth); falsified.results[0].outcome = falsified.results[0].outcome === 'pass' ? 'fail' : 'pass';
  if (canonical(falsified) !== canonical(truth)) differed++;
  const lie = { ...b, judged: await signAs(J, 'judged', { ...b.judged.payload, judgement: await sha256hex(canonical(falsified)) }) };
  if (!(await verifyBundle(lie, TRUST)).ok) refused++;
  const honest = { ...b, judged: await signAs(J, 'judged', { ...b.judged.payload, judgement: await sha256hex(canonical(truth)) }) };
  if ((await verifyBundle(honest, TRUST)).ok) trueVerified++;
}
const facts = { bundles: jobs.length, falsifiedDiffered: differed, falseRefused: refused, trueVerified };
const held = refused === jobs.length && trueVerified === jobs.length && differed === jobs.length;
const verdicts = [{ id: 'F2b', kind: 'property', claim: claims.claims[0].claim, held, measured: refused + ' of ' + jobs.length + ' false judgements refused (each differing from the truth: ' + differed + '); the true judgement, signed the same way, verified ' + trueVerified + ' of ' + jobs.length }];
const receipt = { kind: 'acg-autopilot.receipt', organ: '3b', v: 1, sealed: { path, commit, claimsSha256: await sha256hex(text) }, facts, verdicts, held: held ? 1 : 0, failed: held ? 0 : 1 };
const json = JSON.stringify(receipt, null, 1) + '\n';
if (process.argv.includes('--check')) {
  const was = readFileSync(new URL('receipts/organ-3b.json', ROOT), 'utf8');
  console.log(was === json ? 'ORGAN 3b REPRODUCED · byte for byte' : 'ORGAN 3b DRIFT');
  process.exit(was === json ? 0 : 1);
}
writeFileSync(new URL('receipts/organ-3b.json', ROOT), json);
console.log((held ? 'HELD   ' : 'FAILED ') + 'F2b · ' + verdicts[0].measured);
