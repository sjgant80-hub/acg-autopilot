#!/usr/bin/env node
// tools/measure-6b.mjs — organ 6b measured against its seal (claims/organ-6b.json). I1 on this machine's saved Gemini CLI
// sessions (private: counts only), with --local; I2-I3 on organ 6's synthetic sessions (the same generator and seed as
// tools/measure-6.mjs, copied here so that file stays as measured) and on small Claude Code transcripts, which CI re-derives.
//   node tools/measure-6b.mjs --local  → receipts/organ-6b.json (I1-I3)
//   node tools/measure-6b.mjs --check  → re-derive I2-I3; refuse unless they are the receipt's
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { importGemini, nothingToJudge } from '../src/gemini.mjs';
import { assessStrict } from '../src/judge.mjs';
import { factsOf, sha256hex } from '../src/record.mjs';
import { prng } from './suite.mjs';

const ROOT = new URL('../', import.meta.url);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const path = 'claims/organ-6b.json', text = readFileSync(new URL(path, ROOT), 'utf8');
const commit = git('log', '-1', '--format=%H', '--', path).trim();
if (!commit || git('show', commit + ':' + path) !== text) { console.log(path + ' differs from the commit that sealed it — refusing to measure'); process.exit(1); }
const claims = JSON.parse(text), LOCAL = process.argv.includes('--local'), CHECK = process.argv.includes('--check');
const BIN = new URL('../bin/acg.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const p1 = async (r) => assessStrict(r, await factsOf(r)).results.find((x) => x.id === 'P1').outcome;
/** acg import of one file, in a temporary folder → { refused, wrote, record } */
function cli(content, harness) {
  const home = mkdtempSync(join(tmpdir(), 'acg-m6b-')), f = join(home, 'in.jsonl'), out = join(home, 'out.json');
  try {
    writeFileSync(f, content);
    const r = spawnSync(process.execPath, [BIN, 'import', f, ...(harness ? ['--harness', harness] : []), '--out', out], { env: { ...process.env, ACG_HOME: join(home, '.acg') }, encoding: 'utf8' });
    const wrote = existsSync(out);
    return { refused: r.status === 1 && /^nothing to judge/.test(r.stderr) && !wrote, imported: r.status === 0 && wrote, record: wrote ? JSON.parse(readFileSync(out, 'utf8')) : null };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// ── I1 (local): the real sessions ─────────────────────────────────────────────────────────────────────────────────────
let i1 = null;
if (LOCAL) {
  const base = join(homedir(), '.gemini', 'tmp'), files = [];
  for (const d of existsSync(base) ? readdirSync(base) : []) { const c = join(base, d, 'chats'); if (existsSync(c) && statSync(c).isDirectory()) for (const f of readdirSync(c)) if (f.endsWith('.jsonl')) files.push(join(c, f)); }
  i1 = { sessions: 0, withReply: 0, importedFailingP1: 0, withoutReply: 0, refused: 0, importedPassingP1: 0 };
  for (const f of files.sort()) {
    const raw = readFileSync(f, 'utf8'), has = !nothingToJudge((await importGemini(raw)).record), c = cli(raw, 'gemini');
    i1.sessions++;
    if (has) { i1.withReply++; if (c.imported && (await p1(c.record)) === 'fail') i1.importedFailingP1++; } else { i1.withoutReply++; if (c.refused) i1.refused++; }
    if (c.imported && (await p1(c.record)) === 'pass') i1.importedPassingP1++;
  }
}

// ── I2: organ 6's synthetic sessions (the generator and seed of tools/measure-6.mjs), whole and cut short ──────────────
const rnd = prng(6006), int = (a, b) => a + Math.floor(rnd() * (b - a + 1)), pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const TOOLS = ['read_file', 'grep_search', 'write_file', 'run_shell_command', 'glob', 'replace', 'web_fetch'], MODELS = ['gemini-a', 'gemini-b'];
function synthetic(n) {
  let clock = Date.UTC(2026, 6, 10, 9, 0, 0) + n * 1000003;
  const t = () => new Date((clock += int(1, 4000))).toISOString(), lines = [], msgs = new Map(), L = (o) => lines.push(JSON.stringify(o));
  L({ sessionId: 'syn-' + n, projectHash: 'p' + n, startTime: t(), lastUpdated: t(), kind: 'main' });
  const ctx = Array.from({ length: int(0, 2) }, (_, k) => ({ id: 'ctx-' + n + '-' + k, timestamp: t(), type: 'user', content: [{ text: 'context' }] }));
  L({ $set: { messages: ctx, lastUpdated: t() } }); for (const m of ctx) msgs.set(m.id, m);
  for (let r = int(1, 6), k = 0; k < r; k++) {
    const u = { id: 'u-' + n + '-' + k, timestamp: t(), type: 'user', content: [{ text: 'a prompt' }] }; L(u); msgs.set(u.id, u); L({ $set: { lastUpdated: t() } });
    const g = { id: 'g-' + n + '-' + k, timestamp: t(), type: 'gemini', content: '', thoughts: [], tokens: { input: 1, output: 1 }, ...(rnd() < 0.9 ? { model: pick(MODELS) } : {}) };
    L(g); msgs.set(g.id, g);
    const calls = Array.from({ length: int(0, 3) }, (_, c) => ({ id: 'c-' + n + '-' + k + '-' + c, name: pick(TOOLS), args: { x: c }, status: pick(['success', 'error']), timestamp: t() }));
    if (calls.length) { L({ $set: { lastUpdated: t() } }); const again = { ...g, toolCalls: calls }; L(again); msgs.set(g.id, again); L({ id: 'r-' + n + '-' + k, timestamp: t(), type: 'user', content: [{ functionResponse: {} }] }); msgs.set('r-' + n + '-' + k, { id: 'r-' + n + '-' + k, type: 'user' }); }
    if (rnd() < 0.1) { const keep = [...msgs.values()].filter(() => rnd() < 0.5); L({ $set: { messages: keep, lastUpdated: t() } }); msgs.clear(); for (const m of keep) msgs.set(m.id, m); }
  }
  return lines.join('\n') + '\n';
}
const cut = prng(6106), inputs = [];
for (let n = 0; n < 500; n++) inputs.push(synthetic(n));
for (let n = 0; n < 500; n++) inputs.push(inputs[n].slice(0, Math.floor(cut() * (inputs[n].length + 1))));
const i2 = { inputs: 0, nothing: 0, agree: 0, cliTried: 0, cliRight: 0 };
for (const [k, s] of inputs.entries()) {
  const r = (await importGemini(s)).record, none = nothingToJudge(r), calls = r.timeline.filter((e) => e.kind === 'model_call').length;
  i2.inputs++; if (none) i2.nothing++; if (none === (calls === 0)) i2.agree++;
  if (k % 25 === 0) { const c = cli(s, 'gemini'); i2.cliTried++; if (none ? c.refused : c.imported) i2.cliRight++; }
}

// ── I3: a Claude Code transcript, with and without an assistant request ───────────────────────────────────────────────
const J = (o) => JSON.stringify(o);
const promptOnly = J({ type: 'user', sessionId: 'cc-1', timestamp: '2026-11-05T10:00:00.000Z', message: { role: 'user', content: 'a prompt' } }) + '\n';
const withRequest = promptOnly + J({ type: 'assistant', sessionId: 'cc-1', requestId: 'req-1', timestamp: '2026-11-05T10:00:01.000Z', message: { model: 'claude-x', content: [{ type: 'tool_use', name: 'Read', input: {} }] } }) + '\n';
const a = cli(promptOnly), b = cli(withRequest);
const i3 = { noRequestRefused: a.refused, withRequestImported: b.imported, withRequestFailsP1: b.imported && (await p1(b.record)) === 'fail' };

// ── verdicts ──────────────────────────────────────────────────────────────────────────────────────────────────────
const yes = (x) => (x ? 'yes' : 'no');
const RULES = {
  I1: () => (i1 ? [i1.sessions > 0 && i1.importedFailingP1 === i1.withReply && i1.refused === i1.withoutReply && i1.importedPassingP1 === 0,
    i1.sessions + ' real sessions: ' + i1.importedFailingP1 + ' of the ' + i1.withReply + ' with a reply imported, each failing P1; ' + i1.refused + ' of the ' + i1.withoutReply + ' without one refused, nothing written; imported records passing P1: ' + i1.importedPassingP1]
    : [false, 'not run here: it needs this machine’s saved sessions (node tools/measure-6b.mjs --local)']),
  I2: () => [i2.inputs === 1000 && i2.agree === i2.inputs && i2.nothing > 0 && i2.cliTried === 40 && i2.cliRight === i2.cliTried,
    i2.inputs + ' synthetic sessions, whole and cut short: nothing to judge said for exactly those with no model call in ' + i2.agree + ' (' + i2.nothing + ' had none); acg import refused or imported as it should in ' + i2.cliRight + ' of ' + i2.cliTried],
  I3: () => [i3.noRequestRefused && i3.withRequestImported && i3.withRequestFailsP1,
    'a Claude Code transcript with no assistant request refused, nothing written: ' + yes(i3.noRequestRefused) + '; one with a request imported: ' + yes(i3.withRequestImported) + ', failing P1: ' + yes(i3.withRequestFailsP1)],
};
const verdicts = claims.claims.map((c) => { const [held, measured] = RULES[c.id](); return { id: c.id, kind: c.kind, claim: c.claim, held, measured }; });
const receipt = { kind: 'acg-autopilot.receipt', organ: '6b', v: 1, sealed: { path, commit, claimsSha256: await sha256hex(text) }, local: 'I1: this machine’s saved Gemini CLI sessions, counts only', facts: { I1: i1, I2: i2, I3: i3 }, verdicts, held: verdicts.filter((v) => v.held).length, failed: verdicts.filter((v) => !v.held).length };
if (CHECK) {
  const was = JSON.parse(readFileSync(new URL('receipts/organ-6b.json', ROOT), 'utf8'));
  const pick6 = (r) => JSON.stringify({ sealed: r.sealed, steady: { I2: r.facts.I2, I3: r.facts.I3 }, verdicts: r.verdicts.filter((v) => v.id !== 'I1').map((v) => [v.id, v.held, v.measured]) });
  const same = pick6(was) === pick6(receipt);
  console.log(same ? 'ORGAN 6b REPRODUCED · I2-I3 as the receipt says (I1 is local: ' + (was.verdicts[0].held ? 'held' : 'failed') + ' on the machine that holds the sessions)' : 'ORGAN 6b DRIFT · I2-I3 differ from the receipt');
  if (!same) console.log(JSON.stringify({ I2: i2, I3: i3 }));
  process.exit(same ? 0 : 1);
}
if (!LOCAL) { console.log('run with --local to measure I1 and write the receipt, or --check'); process.exit(2); }
writeFileSync(new URL('receipts/organ-6b.json', ROOT), JSON.stringify(receipt, null, 1) + '\n');
for (const v of verdicts) console.log((v.held ? 'HELD   ' : 'FAILED ') + v.id + ' · ' + v.measured);
console.log('wrote receipts/organ-6b.json · ' + receipt.held + ' held, ' + receipt.failed + ' failed');
