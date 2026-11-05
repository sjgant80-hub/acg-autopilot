#!/usr/bin/env node
// tools/measure-5.mjs — organ 5 measured against its seal (claims/organ-5.json). Organ 3's 1,000 jobs, given to 10
// members by their place in the list, signed and attested with the public demonstration keys; one job in ten (spread
// across the members) has no review; a reviewer overturns on every third job and upholds on the rest. Everything is
// seeded and Ed25519 is deterministic, so CI re-derives every number; the command line part uses fresh keys and
// reports only what does not depend on them.
//   node tools/measure-5.mjs          → receipts/organ-5.json
//   node tools/measure-5.mjs --check  → re-derive; refuse unless the facts and verdicts are the receipt's
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attest, buildPortfolio, checkPortfolio, scoresOf, CHECK_IDS, HABITS } from '../src/portfolio.mjs';
import { signerFromSeed, signAs, message } from '../src/sign.mjs';
import { makeBundle } from '../src/bundle.mjs';
import { revoke, verifyTrusted } from '../src/trust.mjs';
import { link, GENESIS, eventsOf } from '../src/log.mjs';
import { toRecord } from '../src/normalise.mjs';
import { assessStrict } from '../src/judge.mjs';
import { factsOf, sha256hex, canonical, intentHash } from '../src/record.mjs';
import { cleanJob, plantedJob, KINDS, prng } from './suite.mjs';

const ROOT = new URL('../', import.meta.url);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const path = 'claims/organ-5.json', text = readFileSync(new URL(path, ROOT), 'utf8');
const commit = git('log', '-1', '--format=%H', '--', path).trim();
if (!commit || git('show', commit + ':' + path) !== text) { console.log(path + ' differs from the commit that sealed it — refusing to measure'); process.exit(1); }
const claims = JSON.parse(text), CHECK = process.argv.includes('--check');

const AT = '2026-11-05T12:00:00.000Z';
const [R, J, V, X] = await Promise.all([0x11, 0x22, 0x33, 0x44].map((b) => signerFromSeed(new Uint8Array(32).fill(b))));   // public demonstration seeds
const TRUST = { recorders: [R.publicHex], judges: [J.publicHex], reviewers: [V.publicHex] };
async function chain(events) { const out = []; let p = GENESIS; for (const e of events) { const l = await link(p, e); out.push(l); p = l.hash; } return out; }
const eventsOfJob = (job) => [...job.timeline.map(({ seq, ...e }) => e), ...job.artifacts.map((a) => ({ kind: 'artifact', ...a })), ...job.claims.map((c) => ({ kind: 'claim', ...c }))];
const MEMBERS = 10, memberOf = (i) => 'member-' + (i % MEMBERS);
const noReview = (i) => Math.floor(i / 10) % 10 === 9;            // one job in ten, one per member in each hundred
const overturns = (i) => i % 3 === 0;                              // every third job
const decisionOf = (i) => (overturns(i) ? 'overturned' : 'upheld');
async function bundleOf(job, member, i, note = (c) => 'reviewed ' + c) {
  const log = await chain(eventsOfJob(job)), record = toRecord({ job_id: job.job_id, member_id: member, harness: job.harness, intent: job.intent, events: eventsOf(log) });
  const j = assessStrict(record, await factsOf(record));
  const bundle = noReview(i) ? await makeBundle({ record, log, recorder: R, judge: J })
    : await makeBundle({ record, log, recorder: R, judge: J, reviewer: V, decisions: j.review.map((c) => ({ check: c, decision: decisionOf(i), note: note(c) })) });
  return { bundle, judgement: j };
}
const att = async (payload, by) => ({ kind: 'attested', payload, by: by.publicHex, sig: await by.sign(message('attested', payload)) });
const rescore = (p) => { p.scores = scoresOf(p.entries); return p; };

const jobs = [];
for (let i = 1; i <= 500; i++) jobs.push(await cleanJob(i));
for (const [k, kind] of KINDS.entries()) for (let i = 0; i < 50; i++) jobs.push((await plantedJob(10000 + k * 1000 + i, kind)).job);
const made = [];
for (const [i, job] of jobs.entries()) made.push({ i, member: memberOf(i), ...(await bundleOf(job, memberOf(i), i)) });
const ALL = made.map((m) => m.bundle);
const mine = (m) => made.filter((x) => x.member === 'member-' + m);

// ── L1: the scores are the judgements, counted separately ───────────────────────────────────────────────────────────
const l1 = { portfolios: 0, jobs: 0, checked: 0, numbersCompared: 0, mismatches: 0 };
const FULL = [];
for (let m = 0; m < MEMBERS; m++) {
  const own = mine(m), { portfolio } = await buildPortfolio({ member: 'member-' + m, bundles: ALL, trust: TRUST, judge: J, include: own.map((x) => x.bundle.record.job_id) });
  FULL.push(portfolio);
  l1.portfolios++; l1.jobs += portfolio.entries.length;
  if ((await checkPortfolio(portfolio, TRUST)).ok) l1.checked++;
  // the expected numbers, from judging each record again and the reviewer's decisions as they were made — not scoresOf
  const want = { jobs: own.length, revealed: 0, flags: { upheld: 0, overturned: 0, undecided: 0 }, fullyReviewed: 0, checks: {}, habits: {} };
  for (const c of CHECK_IDS) want.checks[c] = { pass: 0, flag: 0, fail: 0 };
  for (const h of Object.keys(HABITS)) want.habits[h] = 0;
  for (const x of own) {
    const j = assessStrict(x.bundle.record, await factsOf(x.bundle.record));
    for (const r of j.results) want.checks[r.id][r.outcome]++;
    for (const c of j.review) want.flags[noReview(x.i) ? 'undecided' : decisionOf(x.i)]++;
    if (!j.review.length || !noReview(x.i)) want.fullyReviewed++;
    for (const h of Object.keys(HABITS)) { const o = j.results.find((r) => r.id === h).outcome; if (o === 'pass' || (o === 'flag' && !noReview(x.i) && overturns(x.i))) want.habits[h]++; }
  }
  const flat = (o, pre = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, pre + k + '.') : [[pre + k, v]]));
  const got = new Map(flat(portfolio.scores)), wanted = flat(want);
  for (const [k, v] of wanted) { l1.numbersCompared++; if (got.get(k) !== v) l1.mismatches++; }
  if (got.size !== wanted.length) l1.mismatches++;
}

// ── L2: only what the member chose, only what verifies ──────────────────────────────────────────────────────────────
const l2 = { members: 0, exact: 0, otherLeft: 0, notChosenLeft: 0, tamperedTried: 0, tamperedRefused: 0, reasonsRight: 0, otherReasons: 0, checked: 0 };
const TAMPER = [
  ['log: it does not end where the recorder signed', async (b) => { b.log.pop(); return b; }],
  ['recorder: signed a different record', async (b) => { b.record.summary += ' and nothing else'; return b; }],
  ['judge: the judgement signed is not what judging the record again gives', async (b) => { b.judged = await signAs(J, 'judged', { ...b.judged.payload, judgement: await sha256hex(canonical({ forged: true })) }); return b; }],
  ['recorder: signed by a key not on the trust list', async (b) => makeBundle({ record: b.record, log: b.log, recorder: X, judge: X })],
];
for (let m = 0; m < MEMBERS; m++) {
  const own = mine(m), chosen = own.filter((_, k) => k % 2 === 0).map((x) => x.bundle), ids = chosen.map((b) => b.record.job_id), tampered = [], reasons = [];
  for (const b of chosen.slice(0, 10)) for (const [why, change] of TAMPER) { tampered.push(await change(structuredClone(b))); reasons.push(why); }
  const { portfolio, left } = await buildPortfolio({ member: 'member-' + m, bundles: [...tampered, ...ALL], trust: TRUST, judge: J, include: ids });
  l2.members++;
  if (canonical(portfolio.entries.map((e) => e.attested.payload.job_id)) === canonical([...ids].sort())) l2.exact++;
  if ((await checkPortfolio(portfolio, TRUST)).ok) l2.checked++;
  for (const [k, l] of left.entries()) {
    if (k < tampered.length) { l2.tamperedTried++; if (l.why.startsWith('refused: ')) l2.tamperedRefused++; if (l.why.includes(reasons[k])) l2.reasonsRight++; }
    else if (l.why === 'another member’s job') l2.otherLeft++;
    else if (l.why === 'not chosen') l2.notChosenLeft++;
    else l2.otherReasons++;
  }
}

// ── L3: a shared portfolio carries no client text ───────────────────────────────────────────────────────────────────
let mark = 0;
const M = () => 'qz' + (mark++).toString(16).padStart(6, '0') + 'x';
async function marked(src) {
  const job = structuredClone(src), ms = [], add = (s) => { const k = M(); ms.push(k); return s + ' ' + k; };
  const tools = new Map(), tool = (t) => { if (!tools.has(t)) { const k = M(); ms.push(k); tools.set(t, t + k); } return tools.get(t); };
  const crit = new Map(job.intent.success_criteria.map((c) => [c, add(c)])), arts = new Map(job.artifacts.map((a) => [a.id, add(a.id).replace(' ', '-')]));
  job.intent.goal = add(job.intent.goal);
  job.intent.constraints = job.intent.constraints.map(add);
  job.intent.success_criteria = job.intent.success_criteria.map((c) => crit.get(c));
  job.intent.out_of_scope = job.intent.out_of_scope.map(add);
  job.intent.allowed_tools = job.intent.allowed_tools.map(tool);
  for (const e of job.timeline) { if (typeof e.text === 'string') e.text = add(e.text); if (typeof e.method === 'string') e.method = add(e.method); if (typeof e.tool === 'string') e.tool = tool(e.tool); }
  for (const a of job.artifacts) a.id = arts.get(a.id);
  for (const c of job.claims) { c.text = add(c.text); if (crit.has(c.criterion)) c.criterion = crit.get(c.criterion); for (const p of c.evidence) if (p.at === 'artifacts' && arts.has(p.id)) p.id = arts.get(p.id); }
  delete job.intent.hash; job.intent.hash = await intentHash(job.intent);
  return { job, ms };
}
const l3 = { jobs: 0, markers: 0, foundNotRevealed: 0, foundRevealed: 0, checked: 0 };
{
  const bs = [], all = [];
  for (let i = 0; i < 100; i++) {
    const { job, ms } = await marked(jobs[i]), notes = [];
    const { bundle } = await bundleOf(job, 'member-marked', i % 9, (c) => { const k = M(); notes.push(k); return 'reviewed ' + c + ' ' + k; });
    bs.push(bundle); all.push(...ms, ...notes); l3.jobs++;
  }
  l3.markers = all.length;
  const ids = bs.map((b) => b.record.job_id);
  const hidden = (await buildPortfolio({ member: 'member-marked', bundles: bs, trust: TRUST, judge: J, include: ids })).portfolio;
  const shown = (await buildPortfolio({ member: 'member-marked', bundles: bs, trust: TRUST, judge: J, include: ids, reveal: ids })).portfolio;
  const h = JSON.stringify(hidden), s = JSON.stringify(shown);
  for (const k of all) { if (h.includes(k)) l3.foundNotRevealed++; if (s.includes(k)) l3.foundRevealed++; }
  if ((await checkPortfolio(hidden, TRUST)).ok && (await checkPortfolio(shown, TRUST)).ok) l3.checked++;
}

// ── L4: it cannot be changed unseen ─────────────────────────────────────────────────────────────────────────────────
const l4 = { tried: 0, refused: 0, reasonsRight: 0, judgeRevokedRefused: 0, judgeRevokedNamed: 0, recorderRevokedRefused: 0, dropAccepted: 0 };
const flipOutcome = (p) => { p.outcomes.P8 = p.outcomes.P8 === 'pass' ? 'fail' : 'pass'; return p; };
for (let m = 0; m < MEMBERS; m++) {
  const base = FULL[m], at = [7, 41, 83], decided = base.entries.map((e, k) => [e, k]).filter(([e]) => e.attested.payload.decisions.length).map(([, k]) => k);
  const edits = [];
  for (const p of at) {
    edits.push(['the signature does not verify', (x) => { flipOutcome(x.entries[p].attested.payload); return rescore(x); }]);
    edits.push(['the signature does not verify', (x) => { const d = x.entries[decided[at.indexOf(p) * 10]].attested.payload.decisions[0]; d.decision = d.decision === 'upheld' ? 'overturned' : 'upheld'; return rescore(x); }]);
    edits.push(['in the portfolio twice', (x) => { x.entries.push(structuredClone(x.entries[p])); return rescore(x); }]);
    edits.push(['about another member', (x) => { x.entries.splice(p, 0, structuredClone(FULL[(m + 1) % MEMBERS].entries[p])); return rescore(x); }]);
    edits.push(['attested by a key not on the trust list', async (x) => { x.entries[p].attested = await att(flipOutcome(structuredClone(x.entries[p].attested.payload)), X); return rescore(x); }]);
  }
  edits.push(['the scores are not what the entries give', (x) => { x.scores.checks.P0.pass++; return x; }]);
  edits.push(['about another member', (x) => { x.member += '-renamed'; return x; }]);
  for (const [why, edit] of edits) {
    const v = await checkPortfolio(await edit(structuredClone(base)), TRUST);
    l4.tried++; if (!v.ok) l4.refused++; if (v.problems.some((q) => q.includes(why))) l4.reasonsRight++;
  }
  const jr = await checkPortfolio(base, revoke(TRUST, J.publicHex, 'stolen', AT));
  if (!jr.ok) l4.judgeRevokedRefused++;
  if (jr.problems.length === base.entries.length && jr.problems.every((q) => q.endsWith('attested by a revoked key (stolen, ' + AT + ')'))) l4.judgeRevokedNamed++;
  if (!(await checkPortfolio(base, revoke(TRUST, R.publicHex, 'lost', AT))).ok) l4.recorderRevokedRefused++;
  const fewer = structuredClone(base); fewer.entries = fewer.entries.filter((_, k) => k % 10 !== 0); rescore(fewer);
  if ((await checkPortfolio(fewer, TRUST)).ok && fewer.entries.length === base.entries.length - 10) l4.dropAccepted++;
}

// ── L5: a revealed job re-runs ──────────────────────────────────────────────────────────────────────────────────────
const l5 = { portfolios: 0, checked: 0, revealed: 0, verified: 0, judgedSame: 0, swapsTried: 0, swapsRefused: 0, cutsTried: 0, cutsRefused: 0 };
const SHOWN = [];
for (let m = 0; m < MEMBERS; m++) {
  const own = mine(m), ids = own.map((x) => x.bundle.record.job_id), reveal = ids.filter((_, k) => k % 10 === 5);
  const { portfolio } = await buildPortfolio({ member: 'member-' + m, bundles: ALL, trust: TRUST, judge: J, include: ids, reveal });
  SHOWN.push(portfolio);
  l5.portfolios++;
  const v = await checkPortfolio(portfolio, TRUST);
  if (v.ok && v.revealed === reveal.length) l5.checked++;
  for (const [k, e] of portfolio.entries.entries()) {
    if (e.bundle === undefined) continue;
    l5.revealed++;
    if ((await verifyTrusted(e.bundle, TRUST)).ok) l5.verified++;
    const j = assessStrict(e.bundle.record, await factsOf(e.bundle.record));
    if (j.results.every((r) => e.attested.payload.outcomes[r.id] === r.outcome)) l5.judgedSame++;
    const other = own.find((x) => x.bundle.record.job_id !== e.attested.payload.job_id && !reveal.includes(x.bundle.record.job_id)).bundle;
    const swap = structuredClone(portfolio); swap.entries[k].bundle = structuredClone(other);
    l5.swapsTried++; if (!(await checkPortfolio(swap, TRUST)).ok) l5.swapsRefused++;
    const cut = structuredClone(portfolio); cut.entries[k].bundle.log.pop();
    l5.cutsTried++; if (!(await checkPortfolio(cut, TRUST)).ok) l5.cutsRefused++;
  }
}

// ── L6: total ───────────────────────────────────────────────────────────────────────────────────────────────────────
const rnd = prng(5005);
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const GARBAGE = [null, true, false, 0, -1, 1.5, 2 ** 40, '', 'x', 'pass', [], [null], [1, 'a'], {}, { a: 1 }, { kind: 'attested' }];
const pathsOf = (x, pre = []) => (x !== null && typeof x === 'object' ? Object.keys(x).flatMap((k) => [[...pre, k], ...pathsOf(x[k], [...pre, k])]) : []);
function damage(x) {
  const ps = pathsOf(x), p = ps[Math.floor(rnd() * ps.length)], parent = p.slice(0, -1).reduce((o, k) => o[k], x), was = parent[p[p.length - 1]];
  const choices = GARBAGE.filter((g) => typeOf(g) !== typeOf(was));
  parent[p[p.length - 1]] = structuredClone(choices[Math.floor(rnd() * choices.length)]);
  return x;
}
const junk = (d = 0) => { const r = rnd(); if (d > 2 || r < 0.3) return structuredClone(GARBAGE[Math.floor(rnd() * GARBAGE.length)]); if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 4) }, () => junk(d + 1));
  return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, (_, k) => [['kind', 'v', 'member', 'entries', 'scores', 'rubric', 'record', 'log', 'attested', 'x'][Math.floor(rnd() * 10)] + (k > 2 ? k : ''), junk(d + 1)])); };
const l6 = { damaged: 0, damagedRefused: 0, garbage: 0, garbageRefused: 0, threw: 0, builderInputs: 0, builderThrew: 0, entered: 0 };
{
  const small = [];
  for (let m = 0; m < MEMBERS; m++) {
    const own = mine(m).slice(0, 10), ids = own.map((x) => x.bundle.record.job_id);
    small.push((await buildPortfolio({ member: 'member-' + m, bundles: own.map((x) => x.bundle), trust: TRUST, judge: J, include: ids, reveal: ids.slice(0, 3) })).portfolio);
  }
  const tryCheck = async (p) => { try { return (await checkPortfolio(p, TRUST)).ok; } catch { l6.threw++; return true; } };
  for (let t = 0; t < 2000; t++) { l6.damaged++; if (!(await tryCheck(damage(structuredClone(small[t % MEMBERS]))))) l6.damagedRefused++; }
  for (let t = 0; t < 200; t++) { l6.garbage++; const g = t % 2 ? junk() : { ...junk(), kind: 'acg-autopilot.portfolio', v: 1, member: 'member-0', rubric: small[0].rubric, entries: [junk(), junk()], scores: junk() }; if (!(await tryCheck(g))) l6.garbageRefused++; }
  const own0 = mine(0).map((x) => x.bundle), inputs = [];
  for (let t = 0; t < 1000; t++) { const g = junk(); inputs.push(t % 2 ? g : { ...(typeof g === 'object' && g !== null && !Array.isArray(g) ? g : {}), record: { job_id: 'g' + t, member_id: 'member-0' } }); }
  for (let t = 0; t < 1000; t++) inputs.push(damage(structuredClone(own0[t % own0.length])));
  for (let t = 0; t < inputs.length; t += 100) {
    const batch = inputs.slice(t, t + 100), include = batch.map((b) => (b && b.record && typeof b.record.job_id === 'string' ? b.record.job_id : '')).filter(Boolean);
    l6.builderInputs += batch.length;
    try { l6.entered += (await buildPortfolio({ member: 'member-0', bundles: batch, trust: TRUST, judge: J, include, reveal: include })).portfolio.entries.length; } catch { l6.builderThrew++; }
  }
}

// ── L7: the command line, end to end ────────────────────────────────────────────────────────────────────────────────
const BIN = new URL('../bin/acg.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), PASS = 'the measurement passphrase';
const run = (home, argv, env = {}, input = '') => spawnSync(process.execPath, [BIN, ...argv], { env: { ...process.env, ACG_HOME: home, ACG_PASSPHRASE: '', ACG_MEMBER: 'cli-member', ...env }, input, encoding: 'utf8' });
const l7 = { built: false, onlyIncluded: false, revealed: false, includeAll: false, accepted: false, tamperedRefused: false, noPassphraseRefused: false };
{
  const home = mkdtempSync(join(tmpdir(), 'acg-m5-')), P = { ACG_PASSPHRASE: PASS };
  try {
    run(home, ['keys'], P);
    for (const id of ['j1', 'j2']) {
      run(home, ['seal', '--goal', 'read a note', '--allowed', 'Read']);
      run(home, ['hook'], {}, JSON.stringify({ session_id: id, hook_event_name: 'UserPromptSubmit' }));
      run(home, ['hook'], {}, JSON.stringify({ session_id: id, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }));
      run(home, ['bundle', '--job', id], P);
    }
    const out = join(home, 'p.json'), none = run(home, ['portfolio', '--member', 'cli-member', '--include', 'j1', '--out', out]);
    l7.noPassphraseRefused = none.status === 1 && /the judge key is sealed/.test(none.stderr) && !existsSync(out);
    const b = run(home, ['portfolio', '--member', 'cli-member', '--include', 'j1', '--reveal', 'j1', '--out', out], P);
    const p = b.status === 0 && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
    l7.built = p !== null && p.entries.length === 1;
    l7.onlyIncluded = p !== null && p.entries.every((e) => e.attested.payload.job_id === 'j1');
    l7.revealed = p !== null && p.entries.length === 1 && p.entries[0].bundle !== undefined;
    const c = run(home, ['check-portfolio', out]);
    l7.accepted = c.status === 0 && c.stdout.trim() === 'the portfolio checks: 1 job(s), 1 revealed';
    if (p) { const bad = structuredClone(p); bad.entries[0].attested.payload.outcomes.P8 = bad.entries[0].attested.payload.outcomes.P8 === 'pass' ? 'fail' : 'pass'; writeFileSync(join(home, 'bad.json'), JSON.stringify(bad)); }
    const t = run(home, ['check-portfolio', join(home, 'bad.json')]);
    l7.tamperedRefused = t.status === 2 && /^REFUSED/.test(t.stdout);
    const all = join(home, 'all.json'), a = run(home, ['portfolio', '--member', 'cli-member', '--include', 'all', '--out', all], P);
    l7.includeAll = a.status === 0 && JSON.parse(readFileSync(all, 'utf8')).entries.map((e) => e.attested.payload.job_id).join() === 'j1,j2' && run(home, ['check-portfolio', all]).status === 0;
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// ── verdicts ──────────────────────────────────────────────────────────────────────────────────────────────────────
const yes = (b) => (b ? 'yes' : 'no');
const RULES = {
  L1: () => [l1.portfolios === MEMBERS && l1.jobs === 1000 && l1.checked === MEMBERS && l1.mismatches === 0 && l1.numbersCompared > 0,
    l1.portfolios + ' portfolios of ' + l1.jobs + ' jobs, ' + l1.checked + ' passed the check; ' + l1.numbersCompared + ' numbers compared with judging each record again, ' + l1.mismatches + ' differed'],
  L2: () => [l2.members === MEMBERS && l2.exact === MEMBERS && l2.checked === MEMBERS && l2.otherLeft === 9000 && l2.notChosenLeft === 500 && l2.tamperedTried === 400 && l2.tamperedRefused === 400 && l2.otherReasons === 0,
    'of ' + l2.members + ' members: ' + l2.exact + ' portfolios held exactly the 50 chosen jobs (' + l2.checked + ' passed the check); left out: ' + l2.otherLeft + ' as another member’s, ' + l2.notChosenLeft + ' as not chosen; tampered copies refused: ' + l2.tamperedRefused + ' of ' + l2.tamperedTried + ' (' + l2.reasonsRight + ' with the reason expected); any other outcome: ' + l2.otherReasons],
  L3: () => [l3.jobs === 100 && l3.markers > 0 && l3.foundNotRevealed === 0 && l3.foundRevealed === l3.markers && l3.checked === 1,
    l3.markers + ' markers in ' + l3.jobs + ' jobs: found in the entries not revealed ' + l3.foundNotRevealed + ', found once revealed ' + l3.foundRevealed + '; both portfolios passed the check: ' + yes(l3.checked === 1)],
  L4: () => [l4.tried === MEMBERS * 17 && l4.refused === l4.tried && l4.judgeRevokedRefused === MEMBERS && l4.judgeRevokedNamed === MEMBERS && l4.recorderRevokedRefused === MEMBERS && l4.dropAccepted === MEMBERS,
    l4.refused + ' of ' + l4.tried + ' edits refused (' + l4.reasonsRight + ' with the reason expected); judge’s key revoked: ' + l4.judgeRevokedRefused + ' of ' + MEMBERS + ' refused, ' + l4.judgeRevokedNamed + ' naming the revocation on every entry; recorder’s key revoked: ' + l4.recorderRevokedRefused + ' refused; 10 entries left out, scores worked out again: ' + l4.dropAccepted + ' of ' + MEMBERS + ' accepted'],
  L5: () => [l5.portfolios === MEMBERS && l5.checked === MEMBERS && l5.revealed === 100 && l5.verified === 100 && l5.judgedSame === 100 && l5.swapsRefused === l5.swapsTried && l5.swapsTried === 100 && l5.cutsRefused === l5.cutsTried && l5.cutsTried === 100,
    l5.checked + ' of ' + l5.portfolios + ' portfolios with revealed jobs passed the check; ' + l5.revealed + ' revealed, ' + l5.verified + ' verified, ' + l5.judgedSame + ' judged again to the outcomes attested; another bundle in place refused ' + l5.swapsRefused + ' of ' + l5.swapsTried + ', a cut log refused ' + l5.cutsRefused + ' of ' + l5.cutsTried],
  L6: () => [l6.damaged === 2000 && l6.damagedRefused === 2000 && l6.garbage === 200 && l6.garbageRefused === 200 && l6.threw === 0 && l6.builderInputs === 2000 && l6.builderThrew === 0 && l6.entered === 0,
    'damaged portfolios refused ' + l6.damagedRefused + ' of ' + l6.damaged + ', other garbage refused ' + l6.garbageRefused + ' of ' + l6.garbage + ', the check threw ' + l6.threw + ' times; the builder took ' + l6.builderInputs + ' garbage values and damaged bundles, threw ' + l6.builderThrew + ' times, and ' + l6.entered + ' entered a portfolio'],
  L7: () => [Object.values(l7).every(Boolean),
    'built from the folder with only the job included: ' + yes(l7.built && l7.onlyIncluded) + ', revealed as asked: ' + yes(l7.revealed) + ', --include all: ' + yes(l7.includeAll) + '; check-portfolio accepted it: ' + yes(l7.accepted) + ', refused a changed outcome with exit code 2: ' + yes(l7.tamperedRefused) + '; the sealed judge key without its passphrase refused, nothing written: ' + yes(l7.noPassphraseRefused)],
};
const verdicts = claims.claims.map((c) => { const [held, measured] = RULES[c.id](); return { id: c.id, kind: c.kind, claim: c.claim, held, measured }; });
const facts = { L1: l1, L2: l2, L3: l3, L4: l4, L5: l5, L6: l6, L7: l7 };
const receipt = { kind: 'acg-autopilot.receipt', organ: 5, v: 1, sealed: { path, commit, claimsSha256: await sha256hex(text) }, demoSeeds: 'public demonstration keys (0x11 recorder, 0x22 judge, 0x33 reviewer, 0x44 on no trust list), never real ones; L7 makes fresh keys and reports only what does not depend on them', facts, verdicts, held: verdicts.filter((v) => v.held).length, failed: verdicts.filter((v) => !v.held).length };
if (CHECK) {
  const was = JSON.parse(readFileSync(new URL('receipts/organ-5.json', ROOT), 'utf8'));
  const pick = (r) => JSON.stringify({ sealed: r.sealed, facts: r.facts, verdicts: r.verdicts.map((v) => [v.id, v.held, v.measured]) });
  const same = pick(was) === pick(receipt);
  console.log(same ? 'ORGAN 5 REPRODUCED · ' + receipt.held + ' held, ' + receipt.failed + ' failed, as the receipt says' : 'ORGAN 5 DRIFT · the facts or verdicts differ from the receipt');
  if (!same) console.log(JSON.stringify({ facts, verdicts: verdicts.map((v) => [v.id, v.held]) }));
  process.exit(same ? 0 : 1);
}
writeFileSync(new URL('receipts/organ-5.json', ROOT), JSON.stringify(receipt, null, 1) + '\n');
for (const v of verdicts) console.log((v.held ? 'HELD   ' : 'FAILED ') + v.id + ' · ' + v.measured);
console.log('wrote receipts/organ-5.json · ' + receipt.held + ' held, ' + receipt.failed + ' failed');
