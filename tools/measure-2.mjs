#!/usr/bin/env node
// tools/measure-2.mjs — organ 2 measured against its seal (claims/organ-2.json), on this machine's own Claude Code
// transcripts. Each transcript is read once into memory; the same text is scanned (independently of the importer),
// imported, and replayed into the hook command — a separate process per event, its stdin the JSON Claude Code's hooks
// deliver. The transcripts are private: the receipt holds counts and hashes only, never text, paths or tool names.
// It runs here, not in CI (CI has no transcripts, and new sessions add new ones); the receipt says when and on what.
//   node tools/measure-2.mjs   → receipts/organ-2.json
import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { importTranscript } from '../src/transcript.mjs';
import { parseLog, verifyLog, eventsOf } from '../src/log.mjs';
import { toRecord } from '../src/normalise.mjs';
import { schemaCheck } from '../src/schema.mjs';
import { assessStrict } from '../src/judge.mjs';
import { factsOf, sha256hex } from '../src/record.mjs';
import { prng } from './suite.mjs';

const ROOT = new URL('../', import.meta.url);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const path = 'claims/organ-2.json', text = readFileSync(new URL(path, ROOT), 'utf8');
const commit = git('log', '-1', '--format=%H', '--', path).trim();
if (!commit || git('show', commit + ':' + path) !== text) { console.log(path + ' differs from the commit that sealed it — refusing to measure'); process.exit(1); }
const claims = JSON.parse(text), bar = Object.fromEntries(claims.claims.map((c) => [c.id, c.bar]));
const BIN = new URL('../bin/acg.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const outcome = (a, id) => a.results.find((x) => x.id === id).outcome;
const hookTimes = [];
function hook(home, input) {
  const t0 = performance.now(), r = spawnSync(process.execPath, [BIN, 'hook'], { env: { ...process.env, ACG_HOME: home }, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
  const ms = performance.now() - t0;
  return { ms, status: r.status, stdout: r.stdout };
}
const cli = (home, argv) => spawnSync(process.execPath, [BIN, ...argv], { env: { ...process.env, ACG_HOME: home }, encoding: 'utf8' });
async function recordIn(home, job) {
  const dir = join(home, 'jobs', job), l = parseLog(existsSync(join(dir, 'log.jsonl')) ? readFileSync(join(dir, 'log.jsonl'), 'utf8') : '');
  const ip = join(dir, 'intent.json');
  return { lines: l.lines || [], record: toRecord({ job_id: job, member_id: 'measure', harness: { name: 'claude-code' }, intent: existsSync(ip) ? JSON.parse(readFileSync(ip, 'utf8')) : undefined, events: eventsOf(l.lines || []) }) };
}

// the transcripts, by the sealed rule: under ~/.claude/projects, at most 30 MB, 1 to 300 main-thread tool uses
function scan(t) {   // written apart from src/transcript.mjs: the main thread's tool names in order, and its model requests
  const names = [], reqs = new Set(), steps = []; let n = 0;
  for (const l of t.split('\n')) {
    if (!l.trim()) continue; n++;
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (!isObj(j) || j.isSidechain === true) continue;
    const m = isObj(j.message) ? j.message : {};
    if (j.type === 'user' && typeof m.content === 'string') steps.push({ prompt: true });
    if (j.type !== 'assistant') continue;
    reqs.add(typeof j.requestId === 'string' ? j.requestId : 'line-' + n);
    for (const c of Array.isArray(m.content) ? m.content : []) if (isObj(c) && c.type === 'tool_use' && typeof c.name === 'string' && c.name) { names.push(c.name); steps.push({ tool: c.name, input: isObj(c.input) ? c.input : {} }); }
  }
  return { names, requests: reqs.size, steps };
}
const base = join(homedir(), '.claude', 'projects'), files = [];
for (const d of readdirSync(base).sort()) {
  const p = join(base, d); if (!statSync(p).isDirectory()) continue;
  for (const f of readdirSync(p).sort()) { if (!f.endsWith('.jsonl')) continue; const fp = join(p, f); if (statSync(fp).size <= 30e6) files.push(fp); }
}
const jobs = [];
for (const fp of files) { const t = readFileSync(fp, 'utf8'), s = scan(t); if (s.names.length >= 1 && s.names.length <= 300) jobs.push({ t, s }); }

const per = []; let e1 = 0, e2 = 0, e3early = 0, e3late = 0, e7 = 0, e5tried = 0, e5caught = 0, events = 0;
for (const [k, { t, s }] of jobs.entries()) {
  const row = { sha: (await sha256hex(t)).slice(0, 16), toolUses: s.names.length, requests: s.requests };
  // E1 + E7: the import
  const imp = (await importTranscript(t)).record, impNames = imp.timeline.filter((e) => e.kind === 'tool_use').map((e) => e.tool);
  const impOk = same(impNames, s.names) && imp.timeline.filter((e) => e.kind === 'model_call').length === s.requests && schemaCheck(imp).outcome === 'pass';
  if (impOk) e1++;
  if (outcome(assessStrict(imp, await factsOf(imp)), 'P1') === 'fail') e7++;
  // E2 + E3 (early): the whole job replayed into the hook, the intent sealed first
  const home = mkdtempSync(join(tmpdir(), 'acg-m2-')), job = 'replay' + k;
  try {
    cli(home, ['seal', '--goal', 'a past job, replayed']);
    for (const st of s.steps) {
      if (st.prompt) { hookTimes.push(hook(home, { session_id: job, hook_event_name: 'UserPromptSubmit', prompt: '' }).ms); events++; continue; }
      const h1 = hook(home, { session_id: job, hook_event_name: 'PreToolUse', tool_name: st.tool, tool_input: st.input }), h2 = hook(home, { session_id: job, hook_event_name: 'PostToolUse', tool_name: st.tool, tool_input: st.input, tool_response: {} });
      hookTimes.push(h1.ms, h2.ms); events += 2;
    }
    const { lines, record } = await recordIn(home, job), names = record.timeline.filter((e) => e.kind === 'tool_use').map((e) => e.tool);
    const v = await verifyLog(lines);
    if (same(names, s.names) && v.ok && schemaCheck(record).outcome === 'pass') e2++;
    if (outcome(assessStrict(record, await factsOf(record)), 'P1') === 'pass') e3early++;
    // E5: edits to this log, up to 200
    const positions = Math.min(lines.length, 66), step = lines.length / positions;   // at most 66 places, three edits each: 198 a log
    for (let p = 0; p < positions; p++) {
      const i = Math.floor(p * step), edits = [];
      const changed = structuredClone(lines); changed[i].at = changed[i].at === '2000-01-01T00:00:00.000Z' ? '2001-01-01T00:00:00.000Z' : '2000-01-01T00:00:00.000Z'; edits.push(changed);
      edits.push(lines.filter((_, j) => j !== i));
      if (i + 1 < lines.length) { const sw = lines.slice(); [sw[i], sw[i + 1]] = [sw[i + 1], sw[i]]; edits.push(sw); }
      for (const e of edits) { e5tried++; if (!(await verifyLog(e)).ok) e5caught++; }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
  // E3 (late): the first prompt, then the seal, then one more event
  const late = mkdtempSync(join(tmpdir(), 'acg-m2-'));
  try {
    hook(late, { session_id: 'late' + k, hook_event_name: 'UserPromptSubmit', prompt: '' });
    await new Promise((ok) => setTimeout(ok, 5));
    cli(late, ['seal', '--goal', 'sealed after the first prompt']);
    hook(late, { session_id: 'late' + k, hook_event_name: 'PreToolUse', tool_name: s.names[0], tool_input: {} });
    const { record } = await recordIn(late, 'late' + k);
    if (outcome(assessStrict(record, await factsOf(record)), 'P1') === 'fail') e3late++;
  } finally { rmSync(late, { recursive: true, force: true }); }
  per.push({ ...row, imported: impOk });
}

// E6: 500 garbage hook inputs, seeded
const rnd = prng(2026), pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const garbage = () => pick([
  () => pick(['', 'not json', '{', '}{', 'null', 'true', '42', '"text"', '[1,2]']),
  () => JSON.stringify(pick([null, 1, 'x', [], [{}], true])),
  () => JSON.stringify({ hook_event_name: pick(['Stop', 'PreToolUse']) }),
  () => JSON.stringify({ session_id: pick(['', '../up', 'a b', 'x'.repeat(200), 7, null, {}]), hook_event_name: 'Stop' }),
  () => JSON.stringify({ session_id: 'g', hook_event_name: pick(['', 'stop', 'Unknown', 3, null]) }),
  () => JSON.stringify({ session_id: 'g', hook_event_name: pick(['PreToolUse', 'PostToolUse']), ...pick([{}, { tool_name: 'Read' }, { tool_input: {} }, { tool_name: '', tool_input: {} }, { tool_name: 'Read', tool_input: 'x' }, { tool_name: 5, tool_input: {} }]) }),
])();
const ghome = mkdtempSync(join(tmpdir(), 'acg-m2g-'));
let e6ok = 0; const e6ms = [];
try {
  for (let i = 0; i < 500; i++) { const r = hook(ghome, garbage()); e6ms.push(r.ms); if (r.status === 0 && r.stdout === '' && r.ms < 2000) e6ok++; }
  var e6jobs = existsSync(join(ghome, 'jobs')), e6errors = existsSync(join(ghome, 'errors.log')) ? readFileSync(join(ghome, 'errors.log'), 'utf8').trim().split('\n').length : 0;
} finally { rmSync(ghome, { recursive: true, force: true }); }

const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10 : null; };
const facts = { when: new Date().toISOString().slice(0, 10), transcripts: jobs.length, toolUses: jobs.reduce((a, j) => a + j.s.names.length, 0), hookEvents: events,
  E1: { faithful: e1 }, E2: { matched: e2 }, E3: { earlyPassP1: e3early, lateFailP1: e3late }, E4: { events: hookTimes.length, medianMs: q(hookTimes, 0.5), p95Ms: q(hookTimes, 0.95) },
  E5: { tried: e5tried, caught: e5caught }, E6: { inputs: 500, cleanExits: e6ok, jobsMade: e6jobs, errorLines: e6errors, medianMs: q(e6ms, 0.5) }, E7: { failedP1: e7 }, per };
const T = facts.transcripts;
const RULES = {
  E1: (f) => [f.E1.faithful === T, f.E1.faithful + ' of ' + T + ' imports hold exactly the transcript’s tool uses in order, a model call per request, and fit the strict schema'],
  E2: (f) => [f.E2.matched === T, f.E2.matched + ' of ' + T + ' replays: tool uses the same as the import, the log verifying, the strict schema met (' + f.hookEvents + ' hook events)'],
  E3: (f) => [f.E3.earlyPassP1 === T && f.E3.lateFailP1 === T, 'sealed before the first prompt, P1 passed ' + f.E3.earlyPassP1 + ' of ' + T + '; sealed after it, P1 failed ' + f.E3.lateFailP1 + ' of ' + T],
  E4: (f) => [f.E4.medianMs <= bar.E4.medianMs && f.E4.p95Ms <= bar.E4.p95Ms, 'per hook event (' + f.E4.events + ' timed): median ' + f.E4.medianMs + ' ms, 95th percentile ' + f.E4.p95Ms + ' ms'],
  E5: (f) => [f.E5.tried > 0 && f.E5.caught === f.E5.tried, f.E5.caught + ' of ' + f.E5.tried + ' one-line edits (a changed field, a removed line, a swap) caught'],
  E6: (f) => [f.E6.cleanExits === 500 && f.E6.jobsMade === false && f.E6.errorLines === 500, f.E6.cleanExits + ' of 500 garbage inputs exited cleanly, silently, inside 2 s; jobs made: ' + f.E6.jobsMade + '; error lines: ' + f.E6.errorLines],
  E7: (f) => [f.E7.failedP1 === T, f.E7.failedP1 + ' of ' + T + ' imported past jobs failed P1'],
};
const verdicts = claims.claims.map((c) => { const [held, measured] = RULES[c.id](facts); return { id: c.id, kind: c.kind, claim: c.claim, held, measured }; });
const receipt = { kind: 'acg-autopilot.receipt', organ: 2, v: 1, sealed: { path, commit, claimsSha256: await sha256hex(text) }, local: 'measured on the machine that holds the transcripts; not re-run by CI', facts, verdicts, held: verdicts.filter((v) => v.held).length, failed: verdicts.filter((v) => !v.held).length };
writeFileSync(new URL('receipts/organ-2.json', ROOT), JSON.stringify(receipt, null, 1) + '\n');
for (const v of verdicts) console.log((v.held ? 'HELD   ' : 'FAILED ') + v.id + ' · ' + v.measured);
console.log('wrote receipts/organ-2.json · ' + receipt.held + ' held, ' + receipt.failed + ' failed');
