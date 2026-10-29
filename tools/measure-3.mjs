#!/usr/bin/env node
// tools/measure-3.mjs — organ 3 measured against its seal (claims/organ-3.json). F1-F4 on 1,000 synthetic jobs (organ 1's
// suite, each written as a log the way the recorder writes one), signed with fixed demonstration keys: deterministic, so
// CI re-derives them. F5 on this machine's real logs (organ 2's 31 transcripts, replayed into the hook), with --local only.
//   node tools/measure-3.mjs --local   → receipts/organ-3.json (F1-F5)
//   node tools/measure-3.mjs --check   → re-derive F1-F4; refuse unless their facts and verdicts are the receipt's
import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { signerFromSeed, signAs } from '../src/sign.mjs';
import { makeBundle, verifyBundle } from '../src/bundle.mjs';
import { link, GENESIS, eventsOf, parseLog } from '../src/log.mjs';
import { toRecord } from '../src/normalise.mjs';
import { assessStrict } from '../src/judge.mjs';
import { factsOf, sha256hex, canonical } from '../src/record.mjs';
import { cleanJob, plantedJob, KINDS } from './suite.mjs';

const ROOT = new URL('../', import.meta.url);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const path = 'claims/organ-3.json', text = readFileSync(new URL(path, ROOT), 'utf8');
const commit = git('log', '-1', '--format=%H', '--', path).trim();
if (!commit || git('show', commit + ':' + path) !== text) { console.log(path + ' differs from the commit that sealed it — refusing to measure'); process.exit(1); }
const claims = JSON.parse(text), LOCAL = process.argv.includes('--local'), CHECK = process.argv.includes('--check');

const SEEDS = { recorder: 0x11, judge: 0x22, reviewer: 0x33, attacker: 0x44 };   // public demonstration seeds, never real keys
const seedOf = (b) => new Uint8Array(32).fill(b);
const [R, J, V, X] = await Promise.all(Object.values(SEEDS).map((b) => signerFromSeed(seedOf(b))));
const TRUST = { recorders: [R.publicHex], judges: [J.publicHex], reviewers: [V.publicHex] };
async function chain(events) { const out = []; let p = GENESIS; for (const e of events) { const l = await link(p, e); out.push(l); p = l.hash; } return out; }
const eventsOfJob = (job) => [...job.timeline.map(({ seq, ...e }) => e), ...job.artifacts.map((a) => ({ kind: 'artifact', ...a })), ...job.claims.map((c) => ({ kind: 'claim', ...c }))];
async function bundleOf(job) {
  const log = await chain(eventsOfJob(job)), record = toRecord({ job_id: job.job_id, member_id: job.member_id, harness: job.harness, intent: job.intent, events: eventsOf(log) });
  const decisions = assessStrict(record, await factsOf(record)).review.map((c) => ({ check: c, decision: 'upheld', note: 'seen by the reviewer' }));
  return makeBundle({ record, log, recorder: R, judge: J, reviewer: V, decisions });
}
const ok = async (b) => (await verifyBundle(b, TRUST)).ok;
const otherAt = (a) => (a === '2000-01-01T00:00:00.000Z' ? '2001-01-01T00:00:00.000Z' : '2000-01-01T00:00:00.000Z');

/** every attack on one bundle's log: { tried, caught } */
async function attackLog(b) {
  let tried = 0, caught = 0;
  const hit = async (log) => { tried++; if (!(await ok({ ...b, log }))) caught++; };
  const L = b.log, n = L.length;
  for (let i = 0; i < n; i++) {
    const changed = structuredClone(L); changed[i].at = otherAt(changed[i].at); await hit(changed);
    await hit(L.filter((_, j) => j !== i));
    if (i + 1 < n) { const sw = L.slice(); [sw[i], sw[i + 1]] = [sw[i + 1], sw[i]]; await hit(sw); }
  }
  for (let k = 1; k <= Math.min(5, n); k++) await hit(L.slice(0, n - k));
  const evs = eventsOf(L);
  if (n) {   // whole logs rewritten with fresh hashes, without the recorder's key: one entry changed; the last one dropped
    const one = structuredClone(evs); one[0] = { ...one[0], at: otherAt(one[0].at) }; await hit(await chain(one));
    await hit(await chain(evs.slice(0, -1)));
  }
  return { tried, caught };
}

const N = { clean: 500, perKind: 50 };
const jobs = [];
for (let i = 1; i <= N.clean; i++) jobs.push(await cleanJob(i));
for (const [k, kind] of KINDS.entries()) for (let i = 0; i < N.perKind; i++) jobs.push((await plantedJob(10000 + k * 1000 + i, kind)).job);
const bundles = [];
for (const job of jobs) bundles.push(await bundleOf(job));

let untouched = 0, f1tried = 0, f1caught = 0;
const f2 = { attackerKey: 0, movedRecorder: 0, judgementLie: 0, movedReview: 0 };
let f3 = 0;
for (const [i, b] of bundles.entries()) {
  if (await ok(b)) untouched++;
  const a = await attackLog(b); f1tried += a.tried; f1caught += a.caught;
  const other = bundles[(i + 1) % bundles.length];
  const forged = await makeBundle({ record: b.record, log: b.log, recorder: X, judge: X, reviewer: X, decisions: b.reviewed.payload.decisions });
  if (!(await ok(forged))) f2.attackerKey++;
  if (!(await ok({ ...b, record: other.record, log: other.log }))) f2.movedRecorder++;   // this job's signatures on another job's record and log
  const lie = { ...b, judged: await signAs(J, 'judged', { ...b.judged.payload, judgement: await sha256hex(canonical({ ...assessStrict(b.record, await factsOf(b.record)), counts: { pass: 11, flag: 0, fail: 0 } })) }) };
  if (!(await ok(lie))) f2.judgementLie++;
  if (!(await ok({ ...b, reviewed: other.reviewed }))) f2.movedReview++;
  if (await sha256hex(canonical(assessStrict(b.record, await factsOf(b.record)))) === b.judged.payload.judgement) f3++;
}

// F4: no private key, in any form held, in anything written
const forms = Object.values(SEEDS).flatMap((s) => {
  const raw = seedOf(s), h = [...raw].map((x) => x.toString(16).padStart(2, '0')).join(''), b64 = Buffer.from(raw).toString('base64'), b64u = Buffer.from(raw).toString('base64url');
  return [h, '302e020100300506032b657004220420' + h, b64, b64u];
});
let f4hits = 0;
const scanned = bundles.map((b) => JSON.stringify(b));

// F5 (local): organ 2's real logs, replayed into the hook, then signed
let f5 = null;
if (LOCAL) {
  const BIN = new URL('../bin/acg.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const steps = (t) => { const out = []; for (const l of t.split('\n')) { if (!l.trim()) continue; let j; try { j = JSON.parse(l); } catch { continue; } if (!isObj(j) || j.isSidechain === true) continue; const m = isObj(j.message) ? j.message : {};
    if (j.type === 'user' && typeof m.content === 'string') out.push({ prompt: true }); if (j.type !== 'assistant') continue; for (const c of Array.isArray(m.content) ? m.content : []) if (isObj(c) && c.type === 'tool_use' && typeof c.name === 'string' && c.name) out.push({ tool: c.name, input: isObj(c.input) ? c.input : {} }); } return out; };
  const base = join(homedir(), '.claude', 'projects'), texts = [];
  for (const d of readdirSync(base).sort()) { const p = join(base, d); if (!statSync(p).isDirectory()) continue; for (const f of readdirSync(p).sort()) { if (!f.endsWith('.jsonl')) continue; const fp = join(p, f); if (statSync(fp).size <= 30e6) texts.push(readFileSync(fp, 'utf8')); } }
  let logs = 0, tried = 0, caught = 0, tail = 0, tailCaught = 0, verified = 0;
  for (const [k, t] of texts.entries()) {
    const s = steps(t), tools = s.filter((x) => x.tool).length;
    if (tools < 1 || tools > 300) continue;
    const home = mkdtempSync(join(tmpdir(), 'acg-m3-')), job = 'real' + k, hook = (o) => spawnSync(process.execPath, [BIN, 'hook'], { env: { ...process.env, ACG_HOME: home }, input: JSON.stringify(o), encoding: 'utf8' });
    try {
      spawnSync(process.execPath, [BIN, 'seal', '--goal', 'a past job, replayed'], { env: { ...process.env, ACG_HOME: home } });
      for (const st of s) { if (st.prompt) hook({ session_id: job, hook_event_name: 'UserPromptSubmit' }); else { hook({ session_id: job, hook_event_name: 'PreToolUse', tool_name: st.tool, tool_input: st.input }); hook({ session_id: job, hook_event_name: 'PostToolUse', tool_name: st.tool, tool_input: st.input }); } }
      const dir = join(home, 'jobs', job), lines = parseLog(readFileSync(join(dir, 'log.jsonl'), 'utf8')).lines;
      const record = toRecord({ job_id: job, member_id: 'measure', harness: { name: 'claude-code' }, intent: JSON.parse(readFileSync(join(dir, 'intent.json'), 'utf8')), events: eventsOf(lines) });
      const b = await makeBundle({ record, log: lines, recorder: R, judge: J });
      logs++; if (await ok(b)) verified++;
      const a = await attackLog(b); tried += a.tried; caught += a.caught;
      tail++; if (!(await ok({ ...b, log: lines.slice(0, -1) }))) tailCaught++;
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  f5 = { logs, verified, tried, caught, lastLineCut: tail, lastLineCutCaught: tailCaught };
}

const steady = { bundles: bundles.length, untouched, F1: { tried: f1tried, caught: f1caught }, F2: { each: bundles.length, ...f2 }, F3: { rerun: f3 } };
const RULES = {
  F1: () => [steady.untouched === steady.bundles && steady.F1.caught === steady.F1.tried && steady.F1.tried > 0, steady.untouched + ' of ' + steady.bundles + ' untouched bundles verified; ' + steady.F1.caught + ' of ' + steady.F1.tried + ' attacks on their logs refused (one-line edits, tail cuts of 1 to 5 lines, whole logs rewritten with fresh hashes)'],
  F2: () => [Object.values(f2).every((v) => v === steady.bundles), 'refused, of ' + steady.bundles + ' each: the attacker’s key ' + f2.attackerKey + ', signatures moved onto another job ' + f2.movedRecorder + ', a judgement a re-run does not give ' + f2.judgementLie + ', a reviewer’s decisions moved ' + f2.movedReview],
  F3: () => [steady.F3.rerun === steady.bundles, steady.F3.rerun + ' of ' + steady.bundles + ' judgements re-ran byte for byte to the hash the judge signed'],
  F4: (hits) => [hits === 0, 'private-key forms found in ' + scanned.length + ' bundles and the receipt: ' + hits],
  F5: () => (f5 ? [f5.logs > 0 && f5.verified === f5.logs && f5.caught === f5.tried && f5.lastLineCutCaught === f5.lastLineCut, f5.logs + ' real logs signed (' + f5.verified + ' verified untouched): ' + f5.caught + ' of ' + f5.tried + ' attacks refused; the cut of the last line, which organ 2’s chain alone missed, refused ' + f5.lastLineCutCaught + ' of ' + f5.lastLineCut] : [false, 'not run here: it needs this machine’s private transcripts (node tools/measure-3.mjs --local)']),
};
const build = (hits) => claims.claims.map((c) => { const [held, measured] = RULES[c.id](hits); return { id: c.id, kind: c.kind, claim: c.claim, held, measured }; });
// F4 scans the bundles and the receipt itself (written without F4's own line first, then with it)
for (const s of scanned) for (const f of forms) if (s.includes(f)) f4hits++;
const draft = JSON.stringify({ steady, f5, verdicts: build(f4hits) });
for (const f of forms) if (draft.includes(f)) f4hits++;
const verdicts = build(f4hits);
const receipt = { kind: 'acg-autopilot.receipt', organ: 3, v: 1, sealed: { path, commit, claimsSha256: await sha256hex(text) }, demoSeeds: 'public demonstration keys, never real ones', facts: { ...steady, F4: { forms: forms.length, hits: f4hits }, F5: f5 }, verdicts, held: verdicts.filter((v) => v.held).length, failed: verdicts.filter((v) => !v.held).length };
if (CHECK) {
  const was = JSON.parse(readFileSync(new URL('receipts/organ-3.json', ROOT), 'utf8'));
  const pick = (r) => JSON.stringify({ steady: { bundles: r.facts.bundles, untouched: r.facts.untouched, F1: r.facts.F1, F2: r.facts.F2, F3: r.facts.F3, F4: r.facts.F4 }, verdicts: r.verdicts.filter((v) => v.id !== 'F5').map((v) => [v.id, v.held, v.measured]) });
  const same = pick(was) === pick(receipt);
  console.log(same ? 'ORGAN 3 REPRODUCED · F1-F4 as the receipt says (F5 is local: ' + (was.verdicts.find((v) => v.id === 'F5').held ? 'held' : 'failed') + ' on the machine that holds the transcripts)' : 'ORGAN 3 DRIFT · F1-F4 differ from the receipt');
  process.exit(same ? 0 : 1);
}
if (!LOCAL) { console.log('run with --local to measure F5 and write the receipt, or --check'); process.exit(2); }
writeFileSync(new URL('receipts/organ-3.json', ROOT), JSON.stringify(receipt, null, 1) + '\n');
for (const v of verdicts) console.log((v.held ? 'HELD   ' : 'FAILED ') + v.id + ' · ' + v.measured);
console.log('wrote receipts/organ-3.json · ' + receipt.held + ' held, ' + receipt.failed + ' failed');
