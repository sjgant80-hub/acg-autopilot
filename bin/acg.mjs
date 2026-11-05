#!/usr/bin/env node
// bin/acg.mjs — the Autopilot's command line, and the recorder Claude Code's hooks call.
//   acg seal --goal "…" [--allowed read,edit] [--criteria "a;b"] [--constraints "a;b"] [--out-of-scope "a;b"]
//        seal the intent BEFORE the first prompt: it waits as the pending intent and binds to the next job the hook sees
//   acg hook                    read one Claude Code hook event (JSON on stdin) and append it to that job's log
//   acg note <kind> [--text …] [--by human|agent|independent] [--to N] [--surfaced] [--basis intent|answer] [--answer N]
//            [--tool T] [--refers-to N] [--target ID] [--method M] [--result R] [--job ID]
//   acg claim --id ID --text "…" [--evidence artifacts:ID,timeline:N,intent:goal,summary] [--criterion "…"] [--job ID]
//   acg log | record | verify | judge [--job ID]      acg judge <record.json>      acg import <transcript.jsonl> [--out F]
//   acg import <session.jsonl> --harness gemini [--out F]   a finished Gemini CLI session (organ 6), from ~/.gemini/tmp/*/chats
//   acg keys                    make this machine's recorder, judge and reviewer keys (private seeds stay in .acg/keys)
//   acg bundle [--job ID]       the record and its log, signed by the recorder and the judge → jobs/<job>/bundle.json
//   acg review --check P2 --decision upheld|overturned --note "…" [--job ID]   a reviewer's signed decision on a flag
//   acg verify-bundle <bundle.json> [--trust trust.json]
// Key care (organ 4): with a passphrase in $ACG_PASSPHRASE (or the variable --passphrase-env names), acg keys seals each
// new key under it (<role>.key.json; no plain seed is written) and every command that signs opens it with that passphrase.
//   acg keys --seal             seal the plain .seed files made earlier, same public keys, and remove the plain files
//   acg revoke --key HEX --reason "…" [--trust trust.json]     a lost or stolen key: trusted for nothing from now on
//   acg rotate --role recorder|judge|reviewer [--trust trust.json]   a new key for the role; the old one revoked as rotated
// The member's portfolio (organ 5): only the jobs named are in it; the judge's key attests each after checking it whole.
//   acg portfolio --member ID --include all|JOB,JOB [--reveal JOB,JOB] [--trust trust.json] [--out portfolio.json]
//   acg check-portfolio <portfolio.json> [--trust trust.json]
// A withhold list (organ 7): files named in .acg/withhold are recorded by name only, never copied or hashed by content
// (see src/withhold.mjs for the patterns; examples/withhold is a starter list of common secret files to copy).
// State lives in $ACG_HOME, or .acg in the current folder: jobs/<job>/{log.jsonl, head, intent.json, store/, record.json}.
// The hook never blocks the harness and never prints: on any error it writes a line to errors.log and exits 0.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { link, parseLog, verifyLog, eventsOf, GENESIS } from '../src/log.mjs';
import { toRecord } from '../src/normalise.mjs';
import { importTranscript } from '../src/transcript.mjs';
import { importGemini, nothingToJudge } from '../src/gemini.mjs';
import { intentHash, canonical, factsOf, KINDS } from '../src/record.mjs';
import { assessStrict } from '../src/judge.mjs';
import { signerFromSeed } from '../src/sign.mjs';
import { makeBundle } from '../src/bundle.mjs';
import { sealSeed, openSeed } from '../src/keystore.mjs';
import { revoke as revokeKey, rotate as rotateKey, verifyTrusted } from '../src/trust.mjs';
import { buildPortfolio, checkPortfolio } from '../src/portfolio.mjs';
import { parseWithhold, withheld } from '../src/withhold.mjs';

const HOME = resolve(process.env.ACG_HOME || join(process.cwd(), '.acg'));
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionStart'];
const SAFE = /^[A-Za-z0-9_-]{1,128}$/;
const READS = new Set(['Read', 'NotebookRead']), WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MAX_KEEP = 5 * 1024 * 1024;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const now = () => new Date().toISOString();
const jobDir = (job) => join(HOME, 'jobs', job);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** append one event to a job's log, under a lock so parallel hook calls cannot fork the chain */
async function append(job, event) {
  const dir = jobDir(job), lock = join(dir, '.lock');
  mkdirSync(dir, { recursive: true });
  for (let t = 0; ; t++) {
    try { mkdirSync(lock); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 5000) rmSync(lock, { recursive: true, force: true }); } catch {}
      if (t > 400) throw new Error('the log lock was not released');
      sleep(5);
    }
  }
  try {
    const headFile = join(dir, 'head'), head = existsSync(headFile) ? readFileSync(headFile, 'utf8').trim() : GENESIS;
    const line = await link(head, event);
    appendFileSync(join(dir, 'log.jsonl'), JSON.stringify(line) + '\n');
    writeFileSync(headFile, line.hash);
    return line;
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

function args(list) {
  const o = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('--')) { const k = a.slice(2), v = list[i + 1]; if (v === undefined || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; } } else o._.push(a);
  }
  return o;
}
const listOf = (s, sep = ';') => (typeof s === 'string' && s.trim() ? s.split(sep).map((x) => x.trim()).filter(Boolean) : []);
const currentJob = (o) => (typeof o.job === 'string' ? o.job : existsSync(join(HOME, 'current')) ? readFileSync(join(HOME, 'current'), 'utf8').trim() : null);

// ── organ 7: the withhold list ─────────────────────────────────────────────────────────────────────────────────────
// .acg/withhold names the files to keep out of .acg (src/withhold.mjs; a starter list is examples/withhold). No list:
// nothing is withheld, exactly as organ 2 measured. A list that exists but cannot be read fails closed: every file is
// withheld, and errors.log says why.
const idOf = (p) => relative(process.cwd(), resolve(p)) || p;
const withheldSha = (id) => createHash('sha256').update('withheld: ' + id).digest('hex');
let WITHHOLD = null;
function withholdList() {
  if (WITHHOLD) return WITHHOLD;
  const f = join(HOME, 'withhold');
  if (!existsSync(f)) return (WITHHOLD = []);
  try { return (WITHHOLD = parseWithhold(readFileSync(f, 'utf8'))); } catch (e) {
    try { mkdirSync(HOME, { recursive: true }); appendFileSync(join(HOME, 'errors.log'), JSON.stringify({ at: now(), error: 'the withhold list ' + f + ' could not be read (' + String(e && e.message || e) + '): every file withheld' }) + '\n'); } catch {}
    return (WITHHOLD = ['**']);
  }
}

// ── the hook ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** check a hook event against the recorder's contract; → the error, or null */
export function hookProblem(h) {
  if (!isObj(h)) return 'the hook input is not an object';
  if (typeof h.session_id !== 'string' || !SAFE.test(h.session_id)) return 'no usable session_id';
  if (!EVENTS.includes(h.hook_event_name)) return 'an unknown hook_event_name';
  if ((h.hook_event_name === 'PreToolUse' || h.hook_event_name === 'PostToolUse') && (typeof h.tool_name !== 'string' || !h.tool_name.trim() || !isObj(h.tool_input))) return h.hook_event_name + ' without a tool_name and a tool_input object';
  return null;
}
async function hook() {
  let h;
  try { h = JSON.parse(readFileSync(0, 'utf8')); } catch { throw new Error('the hook input is not JSON'); }
  const problem = hookProblem(h);
  if (problem) throw new Error(problem);
  const job = h.session_id, dir = jobDir(job), pending = join(HOME, 'pending-intent.json');
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'intent.json')) && existsSync(pending)) renameSync(pending, join(dir, 'intent.json'));
  writeFileSync(join(HOME, 'current'), job);
  const at = now();
  if (h.hook_event_name === 'UserPromptSubmit') await append(job, { kind: 'model_call', at, model: 'claude-code' });
  else if (h.hook_event_name === 'PreToolUse') {
    const named = typeof h.tool_input.file_path === 'string' ? h.tool_input.file_path : h.tool_input.notebook_path;
    const hold = typeof named === 'string' && withheld(withholdList(), idOf(named));   // organ 7: the input that carried it is not hashed
    await append(job, { kind: 'tool_use', at, tool: h.tool_name, input_sha: hold ? withheldSha(idOf(named)) : createHash('sha256').update(canonical(h.tool_input)).digest('hex'), ...(hold ? { withheld: true } : {}) });
  } else if (h.hook_event_name === 'PostToolUse') {
    const p = h.tool_input.file_path, role = READS.has(h.tool_name) ? 'input' : WRITES.has(h.tool_name) ? 'output' : null;
    if (role && typeof p === 'string' && existsSync(p) && statSync(p).isFile() && withheld(withholdList(), idOf(p))) {
      await append(job, { kind: 'artifact', at, id: idOf(p), role, sha256: withheldSha(idOf(p)), stored: false, withheld: true });   // organ 7: no copy, no hash of its bytes
    } else if (role && typeof p === 'string' && existsSync(p) && statSync(p).isFile()) {
      const big = statSync(p).size > MAX_KEEP, bytes = big ? null : readFileSync(p), sha = big ? createHash('sha256').update('too large to keep: ' + p).digest('hex') : createHash('sha256').update(bytes).digest('hex');
      if (!big) { mkdirSync(join(dir, 'store'), { recursive: true }); const kept = join(dir, 'store', sha); if (!existsSync(kept)) copyFileSync(p, kept); }
      await append(job, { kind: 'artifact', at, id: relative(process.cwd(), resolve(p)) || p, role, sha256: sha, stored: !big });
    }
  }
}

// ── the rest of the command line ─────────────────────────────────────────────────────────────────────────────────
async function seal(o) {
  if (typeof o.goal !== 'string' || !o.goal.trim()) throw new Error('acg seal needs --goal "what the job is for"');
  const intent = { goal: o.goal.trim(), constraints: listOf(o.constraints), success_criteria: listOf(o.criteria), allowed_tools: listOf(o.allowed, ','), out_of_scope: listOf(o['out-of-scope']), sealed_at: now() };
  intent.hash = await intentHash(intent);
  mkdirSync(HOME, { recursive: true });
  writeFileSync(join(HOME, 'pending-intent.json'), JSON.stringify(intent, null, 1) + '\n');
  return 'sealed ' + intent.hash.slice(0, 12) + ' at ' + intent.sealed_at + ' — it binds to the next job the hook sees';
}
const NOTE_FIELDS = { text: String, by: String, to: Number, basis: String, answer: Number, tool: String, 'refers-to': Number, target: String, method: String, result: String };
async function note(o) {
  const kind = o._[1], job = currentJob(o);
  if (!KINDS.includes(kind) || kind === 'model_call' || kind === 'tool_use') throw new Error('acg note needs a kind: question, answer, assumption, approval, intervention, verification, rerun, accept');
  if (!job) throw new Error('no job yet: the hook has not seen one (or pass --job)');
  const e = { kind, at: now() };
  for (const [k, cast] of Object.entries(NOTE_FIELDS)) if (k in o && o[k] !== true) e[k === 'refers-to' ? 'refers_to' : k] = cast(o[k]);
  if (kind === 'assumption') e.surfaced = o.surfaced === true;
  const line = await append(job, e);
  return 'noted ' + kind + ' in ' + job + ' (' + line.hash.slice(0, 12) + ')';
}
async function claim(o) {
  const job = currentJob(o);
  if (!job || typeof o.id !== 'string' || typeof o.text !== 'string') throw new Error('acg claim needs --id and --text (and a job)');
  const evidence = listOf(o.evidence, ',').map((p) => { const [at, v] = p.split(':'); return at === 'timeline' ? { at, seq: Number(v) } : at === 'intent' ? { at, field: v } : at === 'summary' ? { at } : { at, id: v }; });
  await append(job, { kind: 'claim', at: now(), id: o.id, text: o.text, evidence, ...(typeof o.criterion === 'string' ? { criterion: o.criterion } : {}) });
  return 'claim ' + o.id + ' recorded in ' + job;
}
function linesOf(job) { const p = join(jobDir(job), 'log.jsonl'); return existsSync(p) ? parseLog(readFileSync(p, 'utf8')) : { lines: [] }; }
async function recordOf(job) {
  const l = linesOf(job), ip = join(jobDir(job), 'intent.json');
  if (l.error) throw new Error('the log cannot be read: ' + l.error);
  return toRecord({ job_id: job, member_id: process.env.ACG_MEMBER || 'anonymous', harness: { name: 'claude-code' }, intent: existsSync(ip) ? JSON.parse(readFileSync(ip, 'utf8')) : undefined, events: eventsOf(l.lines) });
}
const KEYS = join(HOME, 'keys'), ROLES = ['recorder', 'judge', 'reviewer'];
const hexOf = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const plainOf = (role) => join(KEYS, role + '.seed'), sealedOf = (role) => join(KEYS, role + '.key.json');
const seedOfHex = (h) => Uint8Array.from(h.trim().match(/../g), (b) => parseInt(b, 16));
const passphraseOf = (o) => process.env[typeof o['passphrase-env'] === 'string' ? o['passphrase-env'] : 'ACG_PASSPHRASE'] || null;
/** the role's signer: a sealed key opened with the passphrase, else a plain seed made before organ 4, else null */
async function signer(role, o = {}) {
  if (existsSync(sealedOf(role))) {
    const pass = passphraseOf(o);
    if (!pass) throw new Error('the ' + role + ' key is sealed: give its passphrase in ACG_PASSPHRASE (or name the variable with --passphrase-env)');
    const r = await openSeed(JSON.parse(readFileSync(sealedOf(role), 'utf8')), pass);
    if (!r.ok) throw new Error('the ' + role + ' key: ' + r.why);
    return signerFromSeed(r.seed);
  }
  return existsSync(plainOf(role)) ? signerFromSeed(seedOfHex(readFileSync(plainOf(role), 'utf8'))) : null;
}
async function writeKey(role, seed, pass) {
  if (pass) writeFileSync(sealedOf(role), JSON.stringify(await sealSeed(seed, pass, { role }), null, 1) + '\n', { mode: 0o600 });
  else writeFileSync(plainOf(role), hexOf(seed) + '\n', { mode: 0o600 });
}
const trustPath = (o) => (typeof o.trust === 'string' ? o.trust : join(KEYS, 'trust.json'));
const readTrust = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {});
async function keys(o) {
  mkdirSync(KEYS, { recursive: true });
  const pass = passphraseOf(o), prior = readTrust(join(KEYS, 'trust.json')), revoked = Array.isArray(prior.revoked) ? prior.revoked : [];
  const trust = { recorders: [], judges: [], reviewers: [], revoked };
  const pubs = {};
  for (const role of ROLES) {
    if (!existsSync(sealedOf(role)) && !existsSync(plainOf(role))) await writeKey(role, globalThis.crypto.getRandomValues(new Uint8Array(32)), pass);
    else if (o.seal === true && existsSync(plainOf(role)) && !existsSync(sealedOf(role))) {
      if (!pass) throw new Error('acg keys --seal needs the passphrase in ACG_PASSPHRASE (or --passphrase-env)');
      const seed = seedOfHex(readFileSync(plainOf(role), 'utf8')), before = (await signerFromSeed(seed)).publicHex;
      await writeKey(role, seed, pass);
      if ((await signer(role, o)).publicHex !== before) { rmSync(sealedOf(role)); throw new Error('the sealed ' + role + ' key did not open to the same key; the plain seed is kept'); }
      rmSync(plainOf(role));
    }
    const pub = (pubs[role] = (await signer(role, o)).publicHex), was = Array.isArray(prior[role + 's']) ? prior[role + 's'] : [];
    trust[role + 's'] = [...new Set([...was, pub])].filter((k) => !revoked.some((r) => r && r.key === k));
  }
  writeFileSync(join(KEYS, 'trust.json'), JSON.stringify(trust, null, 1) + '\n');
  const plain = ROLES.filter((r) => existsSync(plainOf(r)));
  return 'keys in ' + KEYS + (plain.length ? ' (the .seed files are private: never share them' + (pass ? '' : '; set ACG_PASSPHRASE and run acg keys --seal to seal them') + ')' : ' (sealed under your passphrase: the .key.json files do not open without it)')
    + '\npublic: ' + ROLES.map((r) => r + ' ' + pubs[r].slice(0, 16) + '…' + (trust[r + 's'].includes(pubs[r]) ? '' : ' (REVOKED: run acg rotate --role ' + r + ')')).join(', ') + '\ntrust list: ' + join(KEYS, 'trust.json');
}
async function revoke(o) {
  const p = trustPath(o), t = revokeKey(readTrust(p), o.key, typeof o.reason === 'string' ? o.reason : '', now());
  writeFileSync(p, JSON.stringify(t, null, 1) + '\n');
  return 'revoked ' + String(o.key).slice(0, 16) + '… in ' + p + ': every bundle it signed is refused from now on';
}
async function rotate(o) {
  const role = o.role;
  if (!ROLES.includes(role)) throw new Error('acg rotate --role recorder|judge|reviewer');
  const old = await signer(role, o);
  if (!old) throw new Error('no ' + role + ' key to rotate: run acg keys first');
  const pass = passphraseOf(o);
  for (const f of [plainOf(role), sealedOf(role)]) if (existsSync(f)) rmSync(f);
  await writeKey(role, globalThis.crypto.getRandomValues(new Uint8Array(32)), pass);
  const fresh = await signer(role, o), p = trustPath(o);
  writeFileSync(p, JSON.stringify(rotateKey(readTrust(p), role + 's', old.publicHex, fresh.publicHex, now()), null, 1) + '\n');
  return 'rotated the ' + role + ' key: ' + fresh.publicHex.slice(0, 16) + '… trusted, ' + old.publicHex.slice(0, 16) + '… revoked in ' + p;
}
async function bundle(o) {
  const job = currentJob(o), l = linesOf(job), r = await recordOf(job), b = await makeBundle({ record: r, log: l.lines, recorder: await signer('recorder', o), judge: await signer('judge', o) });
  if (!b.recorded) throw new Error('no recorder key: run acg keys first');
  const p = join(jobDir(job), 'bundle.json'); writeFileSync(p, JSON.stringify(b, null, 1) + '\n'); return p;
}
async function review(o) {
  const job = currentJob(o), p = join(jobDir(job), 'bundle.json'), rv = await signer('reviewer', o);
  if (!existsSync(p) || !rv) throw new Error('acg review needs a bundle (acg bundle) and a reviewer key (acg keys)');
  if (typeof o.check !== 'string' || !['upheld', 'overturned'].includes(o.decision) || typeof o.note !== 'string') throw new Error('acg review --check P2 --decision upheld|overturned --note "why"');
  const b = JSON.parse(readFileSync(p, 'utf8')), decisions = [...((b.reviewed && b.reviewed.payload && b.reviewed.payload.decisions) || []).filter((d) => d.check !== o.check), { check: o.check, decision: o.decision, note: o.note }];
  const next = await makeBundle({ record: b.record, log: b.log, reviewer: rv, decisions });
  writeFileSync(p, JSON.stringify({ ...b, reviewed: next.reviewed }, null, 1) + '\n');
  return 'reviewed ' + o.check + ': ' + o.decision;
}
async function portfolio(o) {
  const member = typeof o.member === 'string' ? o.member : process.env.ACG_MEMBER;
  if (!member) throw new Error('acg portfolio needs --member: the id the jobs were recorded under (ACG_MEMBER when they were bundled)');
  if (typeof o.include !== 'string') throw new Error('acg portfolio needs --include: the jobs to show, by id, or all — nothing is in a portfolio unless you name it');
  const judge = await signer('judge', o);
  if (!judge) throw new Error('no judge key: run acg keys first');
  const dir = join(HOME, 'jobs'), files = existsSync(dir) ? readdirSync(dir).map((j) => join(dir, j, 'bundle.json')).filter((f) => existsSync(f)) : [];
  const bundles = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const include = o.include === 'all' ? bundles.filter((b) => isObj(b) && isObj(b.record) && b.record.member_id === member).map((b) => b.record.job_id) : listOf(o.include, ',');
  const { portfolio: p, left } = await buildPortfolio({ member, bundles, trust: readTrust(trustPath(o)), judge, include, reveal: listOf(typeof o.reveal === 'string' ? o.reveal : '', ',') });
  const out = typeof o.out === 'string' ? o.out : join(HOME, 'portfolio' + (SAFE.test(member) ? '-' + member : '') + '.json');
  writeFileSync(out, JSON.stringify(p, null, 1) + '\n');
  const refused = left.filter((l) => l.why.startsWith('refused'));
  return out + ' · ' + p.entries.length + ' job(s), ' + p.scores.revealed + ' revealed' + (refused.length ? '\nnot in it, refused: ' + refused.map((l) => l.job + ' (' + l.why.slice(9) + ')').join('; ') : '');
}
const show = (a) => a.results.map((x) => x.id.padEnd(4) + x.outcome.padEnd(5) + x.why).join('\n') + '\nreview queue: ' + (a.review.join(', ') || 'nothing to decide');

async function main() {
  const o = args(process.argv.slice(2)), cmd = o._[0];
  if (cmd === 'hook') return hook();
  if (cmd === 'seal') return console.log(await seal(o));
  if (cmd === 'note') return console.log(await note(o));
  if (cmd === 'claim') return console.log(await claim(o));
  if (cmd === 'log') { const job = currentJob(o); const r = await recordOf(job); return console.log(r.timeline.map((e) => e.seq + '  ' + e.kind + (e.tool ? ' ' + e.tool : '') + (e.text ? ' · ' + e.text : '')).join('\n') || '(empty)'); }
  if (cmd === 'verify') { const v = await verifyLog(linesOf(currentJob(o)).lines || []); return console.log(v.ok ? 'the log verifies: ' + v.length + ' lines' : 'BROKEN: ' + v.why); }
  if (cmd === 'record') { const job = currentJob(o), r = await recordOf(job), p = join(jobDir(job), 'record.json'); writeFileSync(p, JSON.stringify(r, null, 1) + '\n'); return console.log(p); }
  if (cmd === 'keys') return console.log(await keys(o));
  if (cmd === 'revoke') return console.log(await revoke(o));
  if (cmd === 'rotate') return console.log(await rotate(o));
  if (cmd === 'bundle') return console.log(await bundle(o));
  if (cmd === 'review') return console.log(await review(o));
  if (cmd === 'verify-bundle') { const b = JSON.parse(readFileSync(o._[1], 'utf8')), v = await verifyTrusted(b, JSON.parse(readFileSync(trustPath(o), 'utf8'))); console.log(v.ok ? 'the bundle verifies' : 'REFUSED:\n  ' + v.problems.join('\n  ')); process.exitCode = v.ok ? 0 : 2; return; }
  if (cmd === 'portfolio') return console.log(await portfolio(o));
  if (cmd === 'check-portfolio') { const p = JSON.parse(readFileSync(o._[1], 'utf8')), v = await checkPortfolio(p, readTrust(trustPath(o))); console.log(v.ok ? 'the portfolio checks: ' + v.jobs + ' job(s), ' + v.revealed + ' revealed' : 'REFUSED:\n  ' + v.problems.join('\n  ')); process.exitCode = v.ok ? 0 : 2; return; }
  if (cmd === 'judge') { const r = o._[1] ? JSON.parse(readFileSync(o._[1], 'utf8')) : await recordOf(currentJob(o)); return console.log(show(assessStrict(r, await factsOf(r)))); }
  if (cmd === 'import') {
    if (o.harness !== undefined && o.harness !== 'gemini' && o.harness !== 'claude-code') throw new Error('acg import --harness claude-code|gemini');
    const { record, counts } = await (o.harness === 'gemini' ? importGemini : importTranscript)(readFileSync(o._[1], 'utf8'));
    if (nothingToJudge(record)) throw new Error('nothing to judge: this ' + (o.harness === 'gemini' ? 'session' : 'transcript') + ' holds no model call, so it cannot show an intent sealed before its work; not imported');
    const out = typeof o.out === 'string' ? o.out : null; if (out) writeFileSync(out, JSON.stringify(record, null, 1) + '\n'); return console.log((out ? out + ' · ' : '') + counts.requests + ' model requests, ' + counts.toolUses + ' tool uses'); }
  console.log('acg seal | hook | note | claim | log | verify | record | judge | import | keys | bundle | review | verify-bundle | revoke | rotate | portfolio | check-portfolio — see the top of bin/acg.mjs');
}

const isMain = process.argv[1] && resolve(process.argv[1]).replace(/\\/g, '/').endsWith('bin/acg.mjs');
if (isMain) {
  main().catch((e) => {
    if (process.argv[2] === 'hook') { try { mkdirSync(HOME, { recursive: true }); appendFileSync(join(HOME, 'errors.log'), JSON.stringify({ at: now(), error: String(e && e.message || e) }) + '\n'); } catch {} process.exit(0); }
    console.error(String(e && e.message || e)); process.exit(1);
  });
}
