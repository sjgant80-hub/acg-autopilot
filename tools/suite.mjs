// tools/suite.mjs — the planted-failure suite for organ 1 (claims/organ-1.json), written after the seal. Seeded and
// deterministic: the same seed makes the same jobs. A clean job is a whole, well-run process record; a planted job is a
// clean job with exactly one failure of one of ten kinds put in, and the pointer to where it was put. Jobs vary by seed
// in length, tools, wording, order and timing, so no check can key on fixed strings. The same author wrote this and the
// judge, which the seal discloses.
import { intentHash, SCHEMA } from '../src/record.mjs';

export function prng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const TOOLS = ['read', 'grep', 'edit', 'test', 'build', 'search', 'fetch', 'count', 'diff', 'lint', 'format', 'query', 'plot', 'compile', 'parse', 'sort', 'merge', 'export'];
const OUTSIDE = ['load-database', 'send-email', 'deploy', 'delete-branch', 'shell', 'upload', 'install-package', 'scrape'];
const THINGS = ['sales', 'invoices', 'support tickets', 'survey', 'inventory', 'payroll', 'shipping', 'returns', 'leads', 'bookings', 'claims', 'orders'];
const MONTHS = ['january', 'march', 'may', 'july', 'september', 'october', 'november'];
const GOALS = [(t, m) => 'count the rows in the ' + m + ' ' + t + ' file', (t, m) => 'find duplicate entries in the ' + t + ' export for ' + m, (t, m) => 'fix the failing test in the ' + t + ' report script',
  (t, m) => 'summarise the ' + m + ' ' + t + ' figures for the manager', (t, m) => 'check the ' + t + ' totals for ' + m + ' against the ledger', (t, m) => 'clean the ' + t + ' list and remove empty rows'];
const JARGON = ['synergistic', 'leveraged', 'paradigm', 'orchestration', 'heuristics', 'holistic', 'ontology', 'stochastic', 'operationalised', 'heterogeneous', 'telemetry', 'idempotent', 'disambiguation', 'vectorised', 'hyperparameter', 'eigen-decomposition'];

const pick = (rnd, xs) => xs[Math.floor(rnd() * xs.length)];
const int = (rnd, a, b) => a + Math.floor(rnd() * (b - a + 1));
const hex = (rnd) => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
function shuffle(rnd, xs) { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** a clean job: every check passes on it */
export async function cleanJob(seed) {
  const rnd = prng(seed), thing = pick(rnd, THINGS), month = pick(rnd, MONTHS), goal = pick(rnd, GOALS)(thing, month);
  const allowed = shuffle(rnd, TOOLS).slice(0, int(rnd, 3, 6)), criteria = shuffle(rnd, ['result reported', 'numbers checked', 'nothing edited outside scope', 'file named in the answer', 'steps listed']).slice(0, int(rnd, 1, 3));
  let clock = Date.UTC(2026, 9, int(rnd, 1, 28), int(rnd, 7, 18), int(rnd, 0, 59), 0) + int(rnd, 0, 999);
  const tick = () => (clock += int(rnd, 50, 90000), new Date(clock).toISOString());
  const intent = { goal, constraints: shuffle(rnd, ['read only', 'no network', 'stay in the project folder', 'ask before deleting']).slice(0, int(rnd, 1, 3)), success_criteria: criteria, allowed_tools: allowed, out_of_scope: [pick(rnd, ['editing other files', 'emailing anyone', 'changing settings'])], sealed_at: new Date(clock).toISOString() };
  intent.hash = await intentHash(intent);
  const timeline = [], ev = (o) => { const e = { seq: timeline.length, at: tick(), ...o }; timeline.push(e); return e; };
  ev({ kind: 'model_call', model: 'model-a' });
  const answers = [];
  for (let q = int(rnd, 0, 2); q > 0; q--) { const qu = ev({ kind: 'question', text: 'which ' + thing + ' file for ' + month }); answers.push(ev({ kind: 'answer', by: 'human', to: qu.seq, text: 'the ' + month + ' one' })); ev({ kind: 'model_call', model: 'model-a' }); }
  for (let a = int(rnd, 0, 3); a > 0; a--) {
    const ans = answers.length && rnd() < 0.5 ? pick(rnd, answers) : null;
    ev({ kind: 'assumption', text: 'the ' + thing + ' header row is not data', surfaced: true, ...(ans ? { basis: 'answer', answer: ans.seq } : { basis: 'intent' }) });
  }
  const uses = [];
  for (let u = int(rnd, 2, 8); u > 0; u--) { uses.push(ev({ kind: 'tool_use', tool: pick(rnd, allowed) })); if (rnd() < 0.4) ev({ kind: 'model_call', model: 'model-a' }); }
  const artifacts = [...Array.from({ length: int(rnd, 1, 3) }, (_, k) => ({ id: 'in-' + k, role: 'input', sha256: hex(rnd), stored: true })), ...Array.from({ length: int(rnd, 1, 2) }, (_, k) => ({ id: 'out-' + k, role: 'output', sha256: hex(rnd), stored: true }))];
  const outs = artifacts.filter((a) => a.role === 'output');
  const claims = criteria.map((c, k) => {
    const n = rnd() < 0.6 ? int(rnd, 2, 9000) : null;
    return { id: 'c' + (k + 1), text: n === null ? 'the ' + thing + ' work meets "' + c + '"' : 'the ' + month + ' ' + thing + ' file has ' + n + ' rows, meeting "' + c + '"', evidence: [{ at: 'artifacts', id: pick(rnd, outs).id }, { at: 'timeline', seq: pick(rnd, uses).seq }], criterion: c };
  });
  for (let k = int(rnd, 1, 2); k > 0; k--) ev({ kind: 'rerun', result: 'match', text: 'ran the ' + pick(rnd, allowed) + ' step again' });
  ev({ kind: 'verification', by: pick(rnd, ['independent', 'human']), target: pick(rnd, claims).id, method: 'checked the ' + thing + ' result again' });
  ev({ kind: 'accept', by: 'human' });
  const summary = 'the agent ' + pick(rnd, ['read', 'checked']) + ' the ' + month + ' ' + thing + ' file' + (answers.length ? ', asked which file and was answered' : '') + ', used ' + [...new Set(uses.map((u) => u.tool))].join(' and ')
    + ', and the result was checked again before the human accepted it';
  return { schema: SCHEMA, job_id: 'job-' + seed, member_id: 'member-' + (seed % 97), harness: { name: 'claude-code', version: '2' }, models: ['model-a'], intent, timeline, artifacts, claims, summary };
}

export const KINDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];
const renumber = (job) => { const map = new Map(job.timeline.map((e, i) => [e.seq, i])); for (const e of job.timeline) { e.seq = map.get(e.seq); for (const k of ['to', 'answer', 'refers_to']) if (map.has(e[k])) e[k] = map.get(e[k]); }
  for (const c of job.claims) for (const p of c.evidence) if (p.at === 'timeline' && map.has(p.seq)) p.seq = map.get(p.seq); return map; };
const insertAt = (rnd, job, e, from = 1) => { const i = int(rnd, from, job.timeline.length - 1); job.timeline.splice(i, 0, { ...e, seq: -1, at: job.timeline[i - 1].at }); const map = renumber(job); return map.get(-1) ?? job.timeline.findIndex((x) => x === job.timeline[i]); };

/** a planted job: clean except for one failure of kind P1…P10; → { job, kind, pointer } (the pointer the judge must give) */
export async function plantedJob(seed, kind) {
  const job = await cleanJob(seed), rnd = prng(seed * 7919 + KINDS.indexOf(kind)), calls = job.timeline.filter((e) => e.kind === 'model_call');
  let pointer;
  if (kind === 'P1') {   // the intent recorded after a model call (its hash recomputed, so only the timing is wrong)
    const c = pick(rnd, calls);
    job.intent.sealed_at = new Date(Date.parse(c.at) + int(rnd, 0, 999)).toISOString(); job.intent.hash = await intentHash(job.intent);
    pointer = { at: 'timeline', seq: calls[0].seq };
  } else if (kind === 'P2') {
    const seq = insertAt(rnd, job, { kind: 'assumption', text: 'the ' + pick(rnd, THINGS) + ' rows with no date can be dropped', surfaced: false });
    pointer = { at: 'timeline', seq: job.timeline[seq].seq };
  } else if (kind === 'P3') {
    const seq = insertAt(rnd, job, { kind: 'tool_use', tool: pick(rnd, OUTSIDE) }, 1);
    pointer = { at: 'timeline', seq: job.timeline[seq].seq };
  } else if (kind === 'P4') {
    const c = pick(rnd, job.claims); c.evidence = []; pointer = { at: 'claims', id: c.id };
  } else if (kind === 'P5') {
    const c = pick(rnd, job.claims), q = job.timeline.find((e) => e.kind !== 'tool_use' && e.kind !== 'rerun');
    c.text = 'the job found ' + int(rnd, 2, 900) + ' problems'; c.evidence = [{ at: 'timeline', seq: q.seq }]; pointer = { at: 'claims', id: c.id };
  } else if (kind === 'P6') {
    job.summary = shuffle(rnd, JARGON).slice(0, int(rnd, 4, 7)).join(' ') + ' across the ' + pick(rnd, THINGS) + ' work'; pointer = { at: 'summary' };
  } else if (kind === 'P7') {
    const a = pick(rnd, job.artifacts); a.stored = false; pointer = { at: 'artifacts', id: a.id };
  } else if (kind === 'P8') {
    const v = job.timeline.find((e) => e.kind === 'verification'); v.by = 'agent'; pointer = { at: 'timeline', seq: v.seq };
  } else if (kind === 'P9') {   // a question the agent asked that nobody answered
    const seq = insertAt(rnd, job, { kind: 'question', text: 'should the ' + pick(rnd, THINGS) + ' totals include tax' });
    pointer = { at: 'timeline', seq: job.timeline[seq].seq };
  } else if (kind === 'P10') {
    const r = pick(rnd, job.timeline.filter((e) => e.kind === 'rerun')); r.result = 'differs'; pointer = { at: 'timeline', seq: r.seq };
  }
  return { job, kind, pointer };
}

/** a clean job's intent moved to after a model call chosen at random (A3's extra 200) */
export async function lateIntentJob(seed) {
  const job = await cleanJob(seed), rnd = prng(seed ^ 0x5bd1e995), calls = job.timeline.filter((e) => e.kind === 'model_call');
  job.intent.sealed_at = new Date(Date.parse(pick(rnd, calls).at) + int(rnd, 0, 999)).toISOString(); job.intent.hash = await intentHash(job.intent);
  return job;
}

/** a malformed record (A5): a clean job with one required part broken — removed, the wrong type, or garbage — or no record at all */
export async function malformedJob(seed) {
  const job = await cleanJob(seed), rnd = prng(seed * 31 + 7);
  const garbage = () => pick(rnd, [null, 0, -1, 'x', '', true, [], {}, [null], [1, 'a'], { a: 1 }, NaN, '<script>', 'DROP TABLE']);
  const how = int(rnd, 0, 7);
  if (how === 0) return garbage();
  const part = pick(rnd, ['intent', 'timeline', 'artifacts', 'claims', 'summary']);
  if (how === 1) { delete job[part]; return job; }
  if (how === 2) { job[part] = garbage(); return job; }
  if (how === 3 && Array.isArray(job[part])) { job[part] = job[part].map((x) => (rnd() < 0.5 ? garbage() : x)); return job; }
  if (how === 4) { const f = pick(rnd, ['goal', 'constraints', 'success_criteria', 'allowed_tools', 'out_of_scope', 'sealed_at', 'hash']); job.intent[f] = garbage(); return job; }
  if (how === 5) { for (const e of job.timeline) if (rnd() < 0.3) e[pick(rnd, ['seq', 'at', 'kind', 'by'])] = garbage(); return job; }
  if (how === 6) { for (const c of job.claims) c.evidence = garbage(); return job; }
  for (const k of Object.keys(job)) if (rnd() < 0.5) job[k] = garbage();
  return job;
}
