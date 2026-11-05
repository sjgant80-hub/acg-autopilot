#!/usr/bin/env node
// tools/measure-6.mjs — organ 6 measured against its seal (claims/organ-6.json). H1-H2 on this machine's saved Gemini CLI
// sessions (private: counts only in the receipt), with --local; H3-H5 on seeded synthetic sessions in the same format,
// which CI re-derives.
//   node tools/measure-6.mjs --local  → receipts/organ-6.json (H1-H5)
//   node tools/measure-6.mjs --check  → re-derive H3-H5; refuse unless they are the receipt's
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { importGemini, eventsOfGemini } from '../src/gemini.mjs';
import { NONE_SEALED } from '../src/transcript.mjs';
import { assessStrict } from '../src/judge.mjs';
import { factsOf, sha256hex } from '../src/record.mjs';
import { schemaCheck } from '../src/schema.mjs';
import { prng } from './suite.mjs';

const ROOT = new URL('../', import.meta.url);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const path = 'claims/organ-6.json', text = readFileSync(new URL(path, ROOT), 'utf8');
const commit = git('log', '-1', '--format=%H', '--', path).trim();
if (!commit || git('show', commit + ':' + path) !== text) { console.log(path + ' differs from the commit that sealed it — refusing to measure'); process.exit(1); }
const claims = JSON.parse(text), LOCAL = process.argv.includes('--local'), CHECK = process.argv.includes('--check');
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const outcome = async (r, id) => assessStrict(r, await factsOf(r)).results.find((x) => x.id === id).outcome;

// ── H1, H2 (local): the real sessions, and a separate reading of their raw lines ──────────────────────────────────────
let h1 = null, h2 = null;
if (LOCAL) {
  const base = join(homedir(), '.gemini', 'tmp'), files = [];
  for (const d of existsSync(base) ? readdirSync(base) : []) { const c = join(base, d, 'chats'); if (existsSync(c) && statSync(c).isDirectory()) for (const f of readdirSync(c)) if (f.endsWith('.jsonl')) files.push(join(c, f)); }
  h1 = { sessions: 0, toolCalls: 0, replies: 0, toolUsesImported: 0, modelCallsImported: 0, faithful: 0, schemaPass: 0 };
  h2 = { sessions: 0, p1Failed: 0, noneSealed: 0 };
  for (const f of files.sort()) {
    const raw = readFileSync(f, 'utf8'), calls = new Map(), replies = new Set();
    for (const l of raw.split('\n')) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      const ms = isObj(o) && isObj(o.$set) && Array.isArray(o.$set.messages) ? o.$set.messages : [o];
      for (const m of ms) if (isObj(m) && m.type === 'gemini' && typeof m.id === 'string') { replies.add(m.id); for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) if (isObj(c) && typeof c.id === 'string' && !calls.has(c.id)) calls.set(c.id, c.name); }
    }
    const { record } = await importGemini(raw), uses = record.timeline.filter((e) => e.kind === 'tool_use').map((e) => e.tool), mc = record.timeline.filter((e) => e.kind === 'model_call').length;
    h1.sessions++; h1.toolCalls += calls.size; h1.replies += replies.size; h1.toolUsesImported += uses.length; h1.modelCallsImported += mc;
    if (JSON.stringify(uses) === JSON.stringify([...calls.values()]) && mc === replies.size) h1.faithful++;
    if (schemaCheck(record).outcome === 'pass') h1.schemaPass++;
    h2.sessions++; if ((await outcome(record, 'P1')) === 'fail') h2.p1Failed++; if (record.intent.goal === NONE_SEALED) h2.noneSealed++;
  }
}

// ── H3: synthetic sessions in the format as found; the generator knows the events it meant ────────────────────────────
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
  const want = [];
  for (const m of msgs.values()) if (m.type === 'gemini') { want.push({ kind: 'model_call', at: m.timestamp, model: m.model || 'unknown' }); for (const c of m.toolCalls || []) want.push({ kind: 'tool_use', at: c.timestamp, tool: c.name }); }
  return { text: lines.join('\n') + '\n', want, sessionId: 'syn-' + n };
}
const h3 = { sessions: 0, exact: 0, events: 0, replacedLists: 0 };
for (let n = 0; n < 500; n++) {
  const s = synthetic(n), e = eventsOfGemini(s.text);
  h3.sessions++; h3.events += s.want.length; if (s.text.includes('"$set":{"messages":[') && s.text.split('"$set":{"messages":').length > 2) h3.replacedLists++;
  if (JSON.stringify(e.events) === JSON.stringify(s.want) && e.sessionId === s.sessionId) h3.exact++;
}

// ── H4: total ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const GARBAGE = ['not json', '{"id":', '5', '"s"', 'null', 'true', '[1,2]', '{}', '{"id":5,"type":"gemini"}', '{"id":"x","type":"system"}', '{"type":"gemini"}', '{"$set":5}', '{"$set":{"messages":5}}',
  '{"$set":{"messages":[null,5,{"id":3}]}}', '{"id":"g","type":"gemini","toolCalls":5}', '{"id":"g","type":"gemini","toolCalls":[null,{"name":7},{"name":"t","timestamp":5}]}', '{"id":"g","type":"gemini","timestamp":{},"model":[]}', '{"sessionId":[]}'];
const notObject = (l) => { try { return !isObj(JSON.parse(l)); } catch { return true; } };
const h4 = { inputs: 0, threw: 0, unreadableRight: 0, judged: 0 };
for (let n = 0; n < 2000; n++) {
  let input;
  if (n < 700) input = Array.from({ length: int(1, 12) }, () => pick(GARBAGE)).join('\n');
  else if (n < 1200) { const lines = synthetic(1000 + n).text.split('\n').filter(Boolean), k = int(0, lines.length - 1), o = JSON.parse(lines[k]), keys = Object.keys(o); o[pick(keys)] = pick([5, null, 'x', [], {}, true]); lines[k] = JSON.stringify(o); input = lines.join('\n'); }
  else { const s = synthetic(2000 + n).text; input = s.slice(0, int(0, s.length)); }
  h4.inputs++;
  const want = input.split('\n').filter((l) => l.trim()).filter(notObject).length;
  try {
    const { record, counts } = await importGemini(input);
    if (counts.unreadable === want) h4.unreadableRight++;
    try { assessStrict(record, await factsOf(record)); h4.judged++; } catch {}
  } catch { h4.threw++; }
}

// ── H5: the command line ──────────────────────────────────────────────────────────────────────────────────────────────
const BIN = new URL('../bin/acg.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const h5 = { wrote: false, harness: false, toolsInOrder: false, judged: false, p1Failed: false };
{
  let s = null;
  for (let n = 9999; !s || !s.want.some((e) => e.kind === 'tool_use'); n++) s = synthetic(n);   // the first session from 9999 on that has a tool call
  const home = mkdtempSync(join(tmpdir(), 'acg-m6-')), f = join(home, 'session.jsonl'), out = join(home, 'record.json');
  try {
    writeFileSync(f, s.text);
    const run = (argv) => spawnSync(process.execPath, [BIN, ...argv], { env: { ...process.env, ACG_HOME: join(home, '.acg') }, encoding: 'utf8' });
    const i = run(['import', f, '--harness', 'gemini', '--out', out]);
    h5.wrote = i.status === 0 && existsSync(out);
    const r = h5.wrote ? JSON.parse(readFileSync(out, 'utf8')) : null;
    h5.harness = r !== null && r.harness.name === 'gemini-cli';
    h5.toolsInOrder = r !== null && JSON.stringify(r.timeline.filter((e) => e.kind === 'tool_use').map((e) => e.tool)) === JSON.stringify(s.want.filter((e) => e.kind === 'tool_use').map((e) => e.tool)) && s.want.some((e) => e.kind === 'tool_use');
    const j = run(['judge', out]);
    h5.judged = j.status === 0 && /^P0\s+pass/m.test(j.stdout);
    h5.p1Failed = /^P1\s+fail/m.test(j.stdout);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// ── verdicts ──────────────────────────────────────────────────────────────────────────────────────────────────────
const yes = (b) => (b ? 'yes' : 'no');
const RULES = {
  H1: () => (h1 ? [h1.sessions > 0 && h1.faithful === h1.sessions && h1.schemaPass === h1.sessions && h1.toolUsesImported === h1.toolCalls && h1.modelCallsImported === h1.replies,
    h1.sessions + ' real sessions: ' + h1.faithful + ' imported faithfully (' + h1.toolUsesImported + ' tool uses for ' + h1.toolCalls + ' tool calls read separately; ' + h1.modelCallsImported + ' model calls for ' + h1.replies + ' replies); ' + h1.schemaPass + ' fit the strict schema']
    : [false, 'not run here: it needs this machine’s saved sessions (node tools/measure-6.mjs --local)']),
  H2: () => (h2 ? [h2.sessions > 0 && h2.p1Failed === h2.sessions && h2.noneSealed === h2.sessions, h2.sessions + ' real sessions: P1 failed on ' + h2.p1Failed + '; the intent says none was sealed on ' + h2.noneSealed]
    : [false, 'not run here: it needs this machine’s saved sessions (node tools/measure-6.mjs --local)']),
  H3: () => [h3.sessions === 500 && h3.exact === 500 && h3.replacedLists > 0, h3.exact + ' of ' + h3.sessions + ' synthetic sessions imported to exactly the ' + h3.events + ' events meant (' + h3.replacedLists + ' of them with a list of messages replaced)'],
  H4: () => [h4.inputs === 2000 && h4.threw === 0 && h4.unreadableRight === 2000 && h4.judged === 2000, h4.inputs + ' garbage inputs: the importer threw ' + h4.threw + ' times; unreadable lines counted right in ' + h4.unreadableRight + '; judged without throwing ' + h4.judged],
  H5: () => [Object.values(h5).every(Boolean), 'acg import --harness gemini wrote a record: ' + yes(h5.wrote) + ', of the gemini-cli harness: ' + yes(h5.harness) + ', its tool uses the session’s in order: ' + yes(h5.toolsInOrder) + '; acg judge judged it: ' + yes(h5.judged) + ', P1 failed: ' + yes(h5.p1Failed)],
};
const verdicts = claims.claims.map((c) => { const [held, measured] = RULES[c.id](); return { id: c.id, kind: c.kind, claim: c.claim, held, measured }; });
const steady = { H3: h3, H4: h4, H5: h5 };
const receipt = { kind: 'acg-autopilot.receipt', organ: 6, v: 1, sealed: { path, commit, claimsSha256: await sha256hex(text) }, local: 'H1 and H2: this machine’s saved Gemini CLI sessions, counts only', facts: { H1: h1, H2: h2, ...steady }, verdicts, held: verdicts.filter((v) => v.held).length, failed: verdicts.filter((v) => !v.held).length };
if (CHECK) {
  const was = JSON.parse(readFileSync(new URL('receipts/organ-6.json', ROOT), 'utf8'));
  const pick6 = (r) => JSON.stringify({ sealed: r.sealed, steady: { H3: r.facts.H3, H4: r.facts.H4, H5: r.facts.H5 }, verdicts: r.verdicts.filter((v) => v.id !== 'H1' && v.id !== 'H2').map((v) => [v.id, v.held, v.measured]) });
  const same = pick6(was) === pick6(receipt);
  console.log(same ? 'ORGAN 6 REPRODUCED · H3-H5 as the receipt says (H1-H2 are local: ' + was.verdicts.filter((v) => v.id === 'H1' || v.id === 'H2').map((v) => v.id + ' ' + (v.held ? 'held' : 'failed')).join(', ') + ' on the machine that holds the sessions)' : 'ORGAN 6 DRIFT · H3-H5 differ from the receipt');
  if (!same) console.log(JSON.stringify({ steady, verdicts: verdicts.map((v) => [v.id, v.held]) }));
  process.exit(same ? 0 : 1);
}
if (!LOCAL) { console.log('run with --local to measure H1-H2 and write the receipt, or --check'); process.exit(2); }
writeFileSync(new URL('receipts/organ-6.json', ROOT), JSON.stringify(receipt, null, 1) + '\n');
for (const v of verdicts) console.log((v.held ? 'HELD   ' : 'FAILED ') + v.id + ' · ' + v.measured);
console.log('wrote receipts/organ-6.json · ' + receipt.held + ' held, ' + receipt.failed + ' failed');
