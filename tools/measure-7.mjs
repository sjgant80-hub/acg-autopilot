#!/usr/bin/env node
// tools/measure-7.mjs — organ 7 measured against its seal (claims/organ-7.json): the withhold list. Every job is
// synthetic and runs through the real command line (acg seal, acg hook, acg record) in its own temporary project, so CI
// re-derives all of it. Which files are on the list is decided here by a reference matcher written separately from
// src/withhold.mjs (W4 compares the two), reading examples/withhold, the starter list a team copies.
//   node tools/measure-7.mjs          → receipts/organ-7.json (W1-W5)
//   node tools/measure-7.mjs --check  → re-derive everything; refuse unless it is the receipt
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseWithhold, withheld } from '../src/withhold.mjs';
import { assessStrict } from '../src/judge.mjs';
import { factsOf, canonical, sha256hex } from '../src/record.mjs';
import { prng } from './suite.mjs';

const ROOT = new URL('../', import.meta.url);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const path = 'claims/organ-7.json', text = readFileSync(new URL(path, ROOT), 'utf8');
const commit = git('log', '-1', '--format=%H', '--', path).trim();
if (!commit || git('show', commit + ':' + path) !== text) { console.log(path + ' differs from the commit that sealed it — refusing to measure'); process.exit(1); }
const claims = JSON.parse(text), CHECK = process.argv.includes('--check');
const BIN = new URL('../bin/acg.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const STARTER = new URL('../examples/withhold', import.meta.url);
const sha = (x) => createHash('sha256').update(x).digest('hex');
const slash = (s) => s.replace(/\\/g, '/');

// ── the reference matcher: character by character, recursive, written apart from src/withhold.mjs ─────────────────────
function refMatch(p, s) {
  if (p === '') return s === '';
  if (p.startsWith('**')) { for (let i = 0; i <= s.length; i++) if (refMatch(p.slice(2), s.slice(i))) return true; return false; }
  if (p[0] === '*') { for (let i = 0; i <= s.length; i++) { if (refMatch(p.slice(1), s.slice(i))) return true; if (s[i] === '/') return false; } return false; }
  if (p[0] === '?') return s !== '' && s[0] !== '/' && refMatch(p.slice(1), s.slice(1));
  return s !== '' && s[0] === p[0] && refMatch(p.slice(1), s.slice(1));
}
const folded = (x) => { let o = ''; for (const ch of x) o += ch === '\\' ? '/' : ch.toLowerCase(); return o; };
function refWithheld(patterns, file) {
  if (!Array.isArray(patterns) || typeof file !== 'string') return false;
  let s = folded(file);
  while (s.startsWith('./')) s = s.slice(2);
  if (s === '') return false;
  for (const raw of patterns) {
    if (typeof raw !== 'string') continue;
    let p = folded(raw);
    while (p.startsWith('/')) p = p.slice(1);
    if (p === '') continue;
    if (p.includes('/') ? refMatch(p, s) : s.split('/').some((n) => refMatch(p, n))) return true;
  }
  return false;
}
const refList = (t) => t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const LIST = refList(readFileSync(STARTER, 'utf8'));

// ── the jobs: each sealed, then reading, writing and editing files on and off the list ────────────────────────────────
const ON = ['.env', '.env.local', 'prod.env', 'server.pem', 'tls.key', 'client.p12', 'id_rsa', 'id_ed25519.pub', '.npmrc', '.netrc', 'credentials', 'credentials.json', 'prod.tfvars', '.git-credentials', 'secrets/db.json', 'secrets/api.txt', 'SECRETS/Token.TXT', '.ENV', 'store.jks'];
const OFF = ['src/app.js', 'README.md', 'docs/envelope.md', 'data/keys.csv', 'notes/environment.txt', 'src/pem-parser.js', 'test/id.test.js', 'package.json', 'lib/secretary.js', 'config/settings.yaml', 'src/env.js', 'docs/credentials-howto.md'];
const DIRS = ['', 'app/', 'svc/api/', 'deep/er/still/'];
const OPS = [['Read', true], ['Read', false], ['Write', true], ['Write', false], ['Edit', true], ['Edit', false]];
const rnd = prng(7007), pick = (xs) => xs[Math.floor(rnd() * xs.length)], hex = () => Math.floor(rnd() * 0x100000000).toString(16).padStart(8, '0');
function plan(n) {
  const used = new Set(), ops = [];
  for (const [k, [tool, on]] of OPS.entries()) {
    let id; do id = pick(DIRS) + pick(on ? ON : OFF); while (used.has(id.toLowerCase()));
    used.add(id.toLowerCase());
    const marker = 'mk7-' + n + '-' + k + '-' + hex();
    ops.push({ tool, id, hold: refWithheld(LIST, id), marker, before: 'KEY=' + marker + '\nline two\n', after: tool === 'Edit' ? 'KEY=' + marker + '-edited\nline two\n' : null });
  }
  return ops;
}
const PLANS = Array.from({ length: 50 }, (_, n) => plan(n));

function run(args, input, cwd, home) {
  return new Promise((done) => {
    const c = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, ACG_HOME: home } });
    let out = '';
    c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
    c.on('close', (status) => done({ status, out }));
    c.stdin.end(input || '');
  });
}
const everything = (d) => (existsSync(d) ? readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? everything(join(d, f)) : [readFileSync(join(d, f), 'latin1')])) : []);

/** one job in its own project: seal, a prompt, the six file operations, acg record → what the claims look at */
async function job(n, ops, list) {
  const dir = mkdtempSync(join(tmpdir(), 'acg-m7-')), home = join(dir, '.acg'), session = 'w7-' + n;
  try {
    if (list === 'starter') { mkdirSync(home, { recursive: true }); copyFileSync(STARTER, join(home, 'withhold')); }
    if (list === 'folder') mkdirSync(join(home, 'withhold'), { recursive: true });
    await run(['seal', '--goal', 'job ' + n + ' tidy the service config', '--allowed', 'Read,Write,Edit', '--criteria', 'tests pass'], '', dir, home);
    const hooks = [], hook = async (e) => hooks.push(await run(['hook'], JSON.stringify({ session_id: session, ...e }), dir, home));
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    const put = (id, body) => { const p = join(dir, id); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); return p; };
    const inputs = [];
    for (const op of ops) {
      const p = join(dir, op.id);
      if (op.tool !== 'Write') put(op.id, op.before);
      const input = op.tool === 'Read' ? { file_path: p } : op.tool === 'Write' ? { file_path: p, content: op.before } : { file_path: p, old_string: 'KEY=' + op.marker, new_string: 'KEY=' + op.marker + '-edited' };
      inputs.push(input);
      await hook({ hook_event_name: 'PreToolUse', tool_name: op.tool, tool_input: input });
      if (op.tool === 'Write') put(op.id, op.before); else if (op.tool === 'Edit') put(op.id, op.after);
      await hook({ hook_event_name: 'PostToolUse', tool_name: op.tool, tool_input: input, tool_response: {} });
    }
    const rec = await run(['record'], '', dir, home), record = JSON.parse(readFileSync(rec.out.trim(), 'utf8'));
    const all = everything(home).join('\n'), store = join(home, 'jobs', session, 'store');
    const errors = existsSync(join(home, 'errors.log')) ? readFileSync(join(home, 'errors.log'), 'utf8') : '';
    const storeExists = existsSync(store), copies = new Map(storeExists ? readdirSync(store).map((f) => [f, readFileSync(join(store, f))]) : []);
    return { ops, inputs, record, all, storeExists, errors, quiet: hooks.every((h) => h.status === 0 && h.out === ''), stored: (s) => copies.get(s) || null };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
async function pool(n, f, width = 4) {
  const out = new Array(n); let next = 0;
  await Promise.all(Array.from({ length: width }, async () => { while (next < n) { const k = next++; out[k] = await f(k); } }));
  return out;
}
const finalBytes = (op) => Buffer.from(op.after ?? op.before);
const versions = (op) => [op.before, op.after].filter((x) => x !== null);
const outcome = (j, id) => j.results.find((r) => r.id === id);

// ── W1, W2: the starter list ──────────────────────────────────────────────────────────────────────────────────────
const w1 = { jobs: 0, withheldFiles: 0, keptFiles: 0, looked: 0, found: 0 }, w2 = { jobs: 0, right: 0 };
const withList = await pool(PLANS.length, (n) => job(n, PLANS[n], 'starter'));
for (const r of withList) {
  w1.jobs++; w2.jobs++;
  let ok = r.quiet;
  for (const [k, op] of r.ops.entries()) {
    if (!op.hold) { w1.keptFiles++; continue; }
    w1.withheldFiles++;
    const sought = [op.marker, ...versions(op).map(sha), sha(canonical(r.inputs[k]))];
    w1.looked += sought.length; w1.found += sought.filter((x) => r.all.includes(x)).length;
  }
  const art = (op) => r.record.artifacts.find((a) => slash(a.id) === op.id);
  const j = assessStrict(r.record, await factsOf(r.record)), held = r.ops.filter((o) => o.hold).map((o) => o.id).sort();
  for (const op of r.ops) {
    const a = art(op);
    if (op.hold) ok &&= !!a && a.stored === false && !versions(op).map(sha).includes(a.sha256);
    else ok &&= !!a && a.stored === true && a.sha256 === sha(finalBytes(op)) && Buffer.compare(r.stored(a.sha256) || Buffer.alloc(0), finalBytes(op)) === 0;
  }
  ok &&= held.length > 0 && outcome(j, 'P7').outcome === 'fail' && JSON.stringify(outcome(j, 'P7').evidence.map((e) => slash(e.id)).sort()) === JSON.stringify(held);
  ok &&= outcome(j, 'P0').outcome === 'pass' && r.record.artifacts.length === r.ops.length;
  if (ok) w2.right++;
}

// ── W3: the same jobs, no list ────────────────────────────────────────────────────────────────────────────────────
const w3 = { jobs: 0, right: 0, markersSought: 0, markersFound: 0 };
const noList = await pool(PLANS.length, (n) => job(n, PLANS[n], null));
for (const r of noList) {
  w3.jobs++;
  let ok = r.quiet && r.record.artifacts.length === r.ops.length;
  for (const op of r.ops) {
    const a = r.record.artifacts.find((x) => slash(x.id) === op.id);
    ok &&= !!a && a.stored === true && a.sha256 === sha(finalBytes(op)) && Buffer.compare(r.stored(a.sha256) || Buffer.alloc(0), finalBytes(op)) === 0;
    if (op.hold) { w3.markersSought++; if (r.all.includes(op.marker)) w3.markersFound++; }
  }
  if (ok) w3.right++;
}

// ── W4: the kernel against the reference; garbage ────────────────────────────────────────────────────────────────
const r4 = prng(7404), int = (a, b) => a + Math.floor(r4() * (b - a + 1)), one = (xs) => xs[Math.floor(r4() * xs.length)];
const PCH = ['a', 'A', 'b', '.', '/', '\\', '*', '**', '?', '(', ')', '+', '[', ']', '$', '^', '|', '{', '}', 'e', '-', ' '];
const SCH = ['a', 'A', 'b', '.', '/', '\\', '(', ')', '+', '[', ']', '$', '^', '|', '{', '}', 'e', '-', ' ', '*', '?'];
const NOSLASH = SCH.filter((c) => c !== '/' && c !== '\\');
const flip = (c) => (r4() < 0.3 ? (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) : c);
function pair() {
  const pat = Array.from({ length: int(1, 6) }, () => one(PCH)).join('');
  if (r4() < 0.5) return [pat, Array.from({ length: int(0, 12) }, () => one(SCH)).join('')];
  let s = r4() < 0.15 ? './' : '';                      // a path made to fit the pattern, then roughened
  for (let i = 0; i < pat.length; i++) {
    if (pat.startsWith('**', i)) { s += Array.from({ length: int(0, 4) }, () => one(SCH)).join(''); i++; }
    else if (pat[i] === '*') s += Array.from({ length: int(0, 3) }, () => one(NOSLASH)).join('');
    else if (pat[i] === '?') s += one(NOSLASH);
    else s += pat[i] === '/' && r4() < 0.3 ? '\\' : flip(pat[i]);
  }
  return [pat, s];
}
const w4 = { pairs: 0, disagreements: 0, matched: 0, garbage: 0, throws: 0 };
for (let k = 0; k < 5000; k++) {
  const [p, s] = pair(), lists = [[p], [one(PCH), p], ['zz', p, '']][k % 3], a = withheld(lists, s), b = refWithheld(lists, s);
  w4.pairs++; if (a !== b) w4.disagreements++; if (a) w4.matched++;
}
const hostile = []; Object.defineProperty(hostile, 0, { get() { throw new Error('toxic'); } }); hostile.length = 1;
const GARBAGE = [undefined, null, true, false, 0, -1, NaN, Infinity, 10n, Symbol('s'), '', 'x', '.env', '*', '\n\n#', [], [''], ['*'], [null], [1], [Symbol('p')], {}, { length: 1, 0: '*' },
  () => {}, new Date(0), /re/, hostile, { replace: () => '.env' }, { toString: () => '*' }, { split: () => { throw new Error('toxic'); } }, new Proxy({}, { get() { throw new Error('toxic'); } }), Object.create(null)];
for (let k = 0; k < 2000; k++) {
  w4.garbage++;
  try { parseWithhold(one(GARBAGE)); withheld(one(GARBAGE), one(GARBAGE)); } catch { w4.throws++; }
}

// ── W5: a list that cannot be read ────────────────────────────────────────────────────────────────────────────────
const w5 = { jobs: 0, right: 0 };
const folder = await pool(10, (n) => job(100 + n, PLANS[n], 'folder'));
for (const r of folder) {
  w5.jobs++;
  const noCopies = !r.storeExists && r.ops.every((op) => !r.all.includes(op.marker));
  if (r.quiet && noCopies && r.record.artifacts.length === r.ops.length && r.record.artifacts.every((a) => a.stored === false) && /the withhold list .*could not be read/.test(r.errors)) w5.right++;
}

// ── verdicts ──────────────────────────────────────────────────────────────────────────────────────────────────────
const RULES = {
  W1: () => [w1.jobs === 50 && w1.withheldFiles > 0 && w1.found === 0,
    w1.jobs + ' jobs, ' + w1.withheldFiles + ' files withheld and ' + w1.keptFiles + ' kept: ' + w1.looked + ' things looked for under .acg (each withheld file’s marker, the SHA-256 of every version of its bytes, the SHA-256 of the tool input that named it), ' + w1.found + ' found'],
  W2: () => [w2.right === w2.jobs && w2.jobs === 50,
    'records right in ' + w2.right + ' of ' + w2.jobs + ' jobs: every withheld file not stored, its hash not its bytes’; P7 failing at exactly those files; P0 passing; every other file stored, its copy byte for byte; the hook quiet'],
  W3: () => [w3.right === w3.jobs && w3.jobs === 50 && w3.markersFound === w3.markersSought && w3.markersSought === w1.withheldFiles,
    'with no list, every file stored, its copy byte for byte, in ' + w3.right + ' of ' + w3.jobs + ' jobs; the search found ' + w3.markersFound + ' of the ' + w3.markersSought + ' markers W1 withheld'],
  W4: () => [w4.pairs === 5000 && w4.disagreements === 0 && w4.matched > 0 && w4.garbage === 2000 && w4.throws === 0,
    w4.pairs + ' pairs of pattern and path: ' + w4.disagreements + ' disagreements with the reference (' + w4.matched + ' withheld, the rest kept); ' + w4.garbage + ' garbage inputs, ' + w4.throws + ' throws'],
  W5: () => [w5.right === w5.jobs && w5.jobs === 10,
    'a folder where the list should be: in ' + w5.right + ' of ' + w5.jobs + ' jobs no file was copied, every artifact not stored, the hook quiet and exiting 0, and errors.log naming the withhold list'],
};
const verdicts = claims.claims.map((c) => { const [held, measured] = RULES[c.id](); return { id: c.id, kind: c.kind, claim: c.claim, held, measured }; });
const receipt = { kind: 'acg-autopilot.receipt', organ: '7', v: 1, sealed: { path, commit, claimsSha256: await sha256hex(text) }, facts: { W1: w1, W2: w2, W3: w3, W4: w4, W5: w5 }, verdicts, held: verdicts.filter((v) => v.held).length, failed: verdicts.filter((v) => !v.held).length };
if (CHECK) {
  const was = JSON.parse(readFileSync(new URL('receipts/organ-7.json', ROOT), 'utf8'));
  const same = JSON.stringify({ s: was.sealed, f: was.facts, v: was.verdicts }) === JSON.stringify({ s: receipt.sealed, f: receipt.facts, v: receipt.verdicts });
  console.log(same ? 'ORGAN 7 REPRODUCED · W1-W5 as the receipt says' : 'ORGAN 7 DRIFT · the measurement differs from the receipt');
  if (!same) console.log(JSON.stringify(receipt.facts));
  process.exit(same ? 0 : 1);
}
writeFileSync(new URL('receipts/organ-7.json', ROOT), JSON.stringify(receipt, null, 1) + '\n');
for (const v of verdicts) console.log((v.held ? 'HELD   ' : 'FAILED ') + v.id + ' · ' + v.measured);
console.log('wrote receipts/organ-7.json · ' + receipt.held + ' held, ' + receipt.failed + ' failed');
