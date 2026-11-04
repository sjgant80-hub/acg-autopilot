// page/app.mjs — the live page: the same judge (src/judge.mjs), suite (tools/suite.mjs), recorder pieces, signatures and
// cost case the tests, the mutation gate and the measurements run, in the browser. Nothing is fetched but this site's own
// receipts and sourced figures; nothing is sent anywhere. Every number on the page comes from a receipt, the gate's
// receipt, the sourced basis, or a run of the code in this browser.
import { assessStrict } from '../src/judge.mjs';
import { factsOf } from '../src/record.mjs';
import { cleanJob, plantedJob, malformedJob, KINDS } from '../tools/suite.mjs';
import { signerFromSeed, signAs } from '../src/sign.mjs';
import { makeBundle, verifyBundle } from '../src/bundle.mjs';
import { link, GENESIS, eventsOf, verifyLog } from '../src/log.mjs';
import { toRecord } from '../src/normalise.mjs';
import { sha256hex, canonical } from '../src/record.mjs';
import { reviewCase, sourcesOf, DEFAULTS } from '../src/reviewcase.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-GB') : String(n));
const gbp = (n) => '£' + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const get = (p) => fetch(p, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const NAMES = { P1: 'intent recorded after work began', P2: 'an assumption never surfaced', P3: 'a tool nobody approved', P4: 'a claim with no evidence', P5: 'a number with nothing behind it',
  P6: 'a summary in jargon', P7: 'an output not kept', P8: 'only the agent checked itself', P9: 'a question left unanswered', P10: 'a re-run that did not match' };
const SAMPLES = [['clean', 'A clean job'], ...KINDS.map((k) => ['plant:' + k, 'One failure planted: ' + NAMES[k] + ' (' + k + ')']), ['malformed', 'A malformed record']];
$('sample').innerHTML = SAMPLES.map(([v, t]) => '<option value="' + esc(v) + '">' + esc(t) + '</option>').join('');

async function load() {
  const v = $('sample').value, seed = 7 + $('sample').selectedIndex;
  let rec;
  if (v === 'clean') rec = await cleanJob(seed);
  else if (v === 'malformed') rec = await malformedJob(190000 + seed);
  else rec = (await plantedJob(seed, v.slice(6))).job;
  $('rec').value = JSON.stringify(rec, null, 1);
  $('out').innerHTML = '<p class="dim">Loaded. Judge it.</p>';
}
const where = (p) => (p.at === 'timeline' ? (p.seq !== undefined ? 'entry ' + p.seq : 'entry #' + p.index) : p.at === 'artifacts' ? 'artifact ' + p.id : p.at === 'claims' ? 'claim ' + p.id : p.at === 'intent' ? 'intent · ' + p.field : p.at);
const table = (a) => '<div class="tw"><table><thead><tr><th>Check</th><th>Outcome</th><th>Why</th><th>Evidence</th></tr></thead><tbody>'
  + a.results.map((x) => '<tr><td>' + esc(x.id) + (x.judgement ? ' <span class="dim">(judgement)</span>' : '') + '</td><td><span class="tag ' + esc(x.outcome) + '">' + esc(x.outcome) + '</span></td><td>' + esc(x.why) + '</td><td class="mono">' + esc(x.evidence.map(where).join(' · ') || '—') + '</td></tr>').join('')
  + '</tbody></table></div>';
async function go() {
  let rec;
  try { rec = JSON.parse($('rec').value); } catch (e) { $('out').innerHTML = '<p class="fail">That is not JSON: ' + esc(e.message) + '</p>'; return; }
  const a = assessStrict(rec, await factsOf(rec));
  $('out').innerHTML = '<p><b>' + a.counts.pass + ' pass · ' + a.counts.flag + ' flag · ' + a.counts.fail + ' fail</b> <span class="dim">· rubric ' + esc(a.rubric) + '</span></p>'
    + table(a) + '<p><b>Review queue</b> (for a person): ' + (a.review.length ? esc(a.review.join(', ')) : 'nothing to decide') + '</p>';
}

// ── the receipts: the Measured panels, the header line, the white paper's result, every bound number in the prose ─────
const RECEIPTS = ['1', '1b', '1c', '2', '3', '3b', '4'];
const at = (o, path) => path.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
async function receipts() {
  const got = await Promise.all(RECEIPTS.map((o) => get('receipts/organ-' + o + '.json')));
  const by = Object.fromEntries(RECEIPTS.map((o, i) => [o, got[i]])), rs = got.filter(Boolean);
  for (const el of document.querySelectorAll('[data-r]')) {
    const [organ, path] = el.getAttribute('data-r').split(':'), v = by[organ] ? at(by[organ], path) : undefined;
    el.textContent = v === undefined ? '?' : num(v);
  }
  if (!rs.length) { $('receipts').textContent = 'The receipts did not load.'; return; }
  const held = rs.reduce((n, r) => n + r.held, 0), all = rs.reduce((n, r) => n + r.verdicts.length, 0);
  $('hdr-sum').textContent = held + ' of ' + all + ' sealed claims held so far' + (all - held ? ', ' + (all - held) + ' failed and kept' : '') + '.';
  $('receipts').innerHTML = rs.map((r) => '<div class="panel"><h3>Organ ' + esc(r.organ) + ' · ' + r.held + ' of ' + r.verdicts.length + ' held</h3><p class="dim">Sealed in <a href="https://github.com/sjgant80-hub/acg-autopilot/commit/' + esc(r.sealed.commit) + '">' + esc(r.sealed.commit.slice(0, 7)) + '</a>, before its code. Receipt: <a href="receipts/organ-' + esc(r.organ) + '.json">receipts/organ-' + esc(r.organ) + '.json</a>.' + (r.local ? ' Measured on the machine that holds its data (' + esc(r.local) + ').' : '') + '</p>'
    + r.verdicts.map((v) => '<p><span class="tag ' + (v.held ? 'pass' : 'fail') + '">' + (v.held ? 'HELD' : 'FAILED') + '</span> <b>' + esc(v.id) + '</b> ' + esc(v.claim) + '<br><span class="dim">measured: ' + esc(v.measured) + '</span></p>').join('') + '</div>').join('');
  $('paper-result').textContent = rs.map((r) => 'Organ ' + r.organ + ': ' + r.held + ' of ' + r.verdicts.length + ' sealed claims held' + (r.failed ? ' (' + r.verdicts.filter((v) => !v.held).map((v) => v.id).join(', ') + ' failed and kept)' : '') + '.').join(' ')
    + ' Every failure is on the record with what was measured; each later organ was sealed after the failure it answers, and says so.';
}
async function gate() {
  const g = await get('receipts/gate.json');
  if (!g) { $('gate-sum').textContent = 'the gate’s receipt did not load.'; return; }
  const by = Object.fromEntries(g.kernels.map((k) => [k.file, k]));
  $('gate-sum').textContent = g.tests.count + ' tests, all passing; ' + g.kernels.length + ' kernels, ' + num(g.kernels.reduce((n, k) => n + k.total, 0)) + ' mutants, every one killed (witness ' + g.witness + ').';
  for (const el of document.querySelectorAll('[data-gate]')) { const k = by[el.getAttribute('data-gate')]; el.textContent = k ? k.killed + ' of ' + k.total + ' mutants killed' : 'not in the gate’s receipt'; }
}

// ── signed records, in the browser: public demonstration keys (the measurement's own), never real ones ──────────────
const DEMO = {};
async function demoKeys() { if (!DEMO.R) [DEMO.R, DEMO.J, DEMO.V, DEMO.X] = await Promise.all([0x11, 0x22, 0x33, 0x44].map((b) => signerFromSeed(new Uint8Array(32).fill(b)))); return DEMO; }
async function chainOf(events) { const out = []; let p = GENESIS; for (const e of events) { const l = await link(p, e); out.push(l); p = l.hash; } return out; }
const eventsOfJob = (job) => [...job.timeline.map(({ seq, ...e }) => e), ...job.artifacts.map((x) => ({ kind: 'artifact', ...x })), ...job.claims.map((c) => ({ kind: 'claim', ...c }))];
let SIGNED = null;
const say = (title, v) => '<p><span class="tag ' + (v.ok ? 'pass' : 'fail') + '">' + (v.ok ? 'VERIFIES' : 'REFUSED') + '</span> <b>' + esc(title) + '</b>' + (v.ok ? '' : '<br><span class="dim">' + v.problems.map(esc).join('<br>') + '</span>') + '</p>';
const noCrypto = (e) => '<p class="fail">This browser could not sign: ' + esc(e.message) + ' (Ed25519 in WebCrypto needs a recent browser)</p>';
async function signSample() {
  try {
    const k = await demoKeys(), job = await cleanJob(42);
    const log = await chainOf(eventsOfJob(job)), record = toRecord({ job_id: job.job_id, member_id: job.member_id, harness: job.harness, intent: job.intent, events: eventsOf(log) });
    SIGNED = { bundle: await makeBundle({ record, log, recorder: k.R, judge: k.J }), trust: { recorders: [k.R.publicHex], judges: [k.J.publicHex], reviewers: [k.V.publicHex] } };
    $('sg-out').innerHTML = say('The sample, signed by the recorder and the judge (' + log.length + ' log lines, recorder key ' + k.R.publicHex.slice(0, 12) + '…)', await verifyBundle(SIGNED.bundle, SIGNED.trust));
  } catch (e) { $('sg-out').innerHTML = noCrypto(e); }
}
async function tamper(title, change) {
  if (!SIGNED) await signSample();
  if (!SIGNED) return;
  const b = await change(structuredClone(SIGNED.bundle));
  $('sg-out').innerHTML += say(title, await verifyBundle(b, SIGNED.trust));
}

// ── a whole run traced: every stage of the flow, on one sample job, by the code itself ──────────────────────────────
let TSEED = 0;
const short = (h) => esc(String(h).slice(0, 12)) + '…';
async function trace() {
  try {
    const k = await demoKeys(), { job } = await plantedJob(31000 + TSEED, 'P2');
    const log = await chainOf(eventsOfJob(job)), v = await verifyLog(log);
    const record = toRecord({ job_id: job.job_id, member_id: job.member_id, harness: job.harness, intent: job.intent, events: eventsOf(log) });
    const facts = await factsOf(record), a = assessStrict(record, facts);
    const decisions = a.review.map((c) => ({ check: c, decision: 'upheld', note: 'seen by the demonstration reviewer' }));
    const bundle = await makeBundle({ record, log, recorder: k.R, judge: k.J, reviewer: k.V, decisions });
    const ok = await verifyBundle(bundle, { recorders: [k.R.publicHex], judges: [k.J.publicHex], reviewers: [k.V.publicHex] });
    const flagged = a.results.filter((x) => x.outcome !== 'pass');
    $('trace').innerHTML = [
      '<b>Seal.</b> The goal “' + esc(job.intent.goal) + '”, sealed at ' + esc(job.intent.sealed_at) + ', hash ' + short(job.intent.hash) + ' — it matches its content: ' + (facts.intentHashOk ? 'yes' : 'no') + '.',
      '<b>Record.</b> ' + log.length + ' log lines, each hashing the one before; the last is ' + short(v.head) + '; the chain verifies: ' + (v.ok ? 'yes' : 'no') + '.',
      '<b>Normalise.</b> ' + record.timeline.length + ' timeline entries, ' + record.artifacts.length + ' artifacts, ' + record.claims.length + ' claims. The summary, written from the log: “' + esc(record.summary) + '”.',
      '<b>Judge.</b> ' + a.counts.pass + ' pass · ' + a.counts.flag + ' flag · ' + a.counts.fail + ' fail (' + esc(a.rubric) + ').' + flagged.map((x) => ' ' + esc(x.id) + ', ' + esc(x.outcome) + ': ' + esc(x.why) + ' (' + esc(x.evidence.map(where).join(', ')) + ').').join(''),
      '<b>A person decides.</b> The review queue: ' + (a.review.length ? esc(a.review.join(', ')) : 'empty') + '. ' + (decisions.length ? 'The demonstration reviewer upheld ' + (decisions.length === 1 ? 'it' : 'them') + ', with a note.' : 'Nothing to decide.'),
      '<b>Sign.</b> Recorder ' + short(bundle.recorded.by) + ' signed the record ' + short(bundle.recorded.payload.record) + ' and that its log ends at line ' + bundle.recorded.payload.log.length + '; judge ' + short(bundle.judged.by) + ' signed the judgement ' + short(bundle.judged.payload.judgement) + '; reviewer ' + short(bundle.reviewed.by) + ' signed ' + decisions.length + ' decision' + (decisions.length === 1 ? '' : 's') + '.',
      '<b>Verify.</b> Against the trust list: <span class="tag ' + (ok.ok ? 'pass' : 'fail') + '">' + (ok.ok ? 'VERIFIES' : 'REFUSED') + '</span>' + (ok.ok ? '' : ' ' + ok.problems.map(esc).join('; ')),
      '<span class="dim"><b>Into acg-assess.</b> Waits on its record format.</span>',
      '<span class="dim"><b>Portfolio.</b> After the bridge.</span>',
    ].map((x) => '<li>' + x + '</li>').join('');
  } catch (e) { $('trace').innerHTML = '<li>' + noCrypto(e) + '</li>'; }
}

// ── the cost case: the kernel over the sourced basis, with the reader's inputs ───────────────────────────────────────
const INPUTS = { 'c-jobs': 'jobsPerWeek', 'c-min': 'minutesPerJob', 'c-share': 'share', 'c-tin': 'tokensIn', 'c-tout': 'tokensOut', 'c-years': 'years' };
let BASIS = null;
function cost() {
  if (!BASIS) return;
  const input = {};
  for (const [id, k] of Object.entries(INPUTS)) { const v = $(id).value; input[k] = v === '' ? NaN : Number(v); }
  const r = reviewCase(BASIS, input);
  if (!r.ok) { $('c-out').innerHTML = '<p class="fail">Check the inputs: ' + esc(r.why) + '.</p>'; return; }
  const y = r.inputs.years, row = (name, k) => '<tr><td>' + name + '</td><td>' + gbp(r.perYear[k]) + '</td><td>' + gbp(r.over[k]) + '</td></tr>';
  $('c-out').innerHTML = '<div class="tw"><table><thead><tr><th>Reviewing how the agent work was done</th><th>A year</th><th>Over ' + y + ' year' + (y === 1 ? '' : 's') + '</th></tr></thead><tbody>'
    + row('Today: a reviewer’s time', 'today') + row('With a cloud model as judge', 'cloudJudge') + row('With this', 'own') + '</tbody></table></div>'
    + '<p><b>Against today: ' + gbp(r.savingPerYear) + ' a year, ' + gbp(r.savingOver) + ' over ' + y + ' year' + (y === 1 ? '' : 's') + '.</b> Against a cloud model as judge: ' + gbp(r.versusCloudOver) + ' over the same time, and no transcript leaves your machines.</p>'
    + '<p class="dim">' + num(r.lines.jobs) + ' jobs a year; ' + gbp(r.lines.perJob) + ' of reviewer time a job today; the cloud model’s tokens ' + gbp(r.lines.cloud) + ' a year; electricity at most ' + gbp(r.lines.power) + ' a year.</p>';
}
async function costSetup() {
  BASIS = await get('data/basis.json');
  if (!BASIS) { $('c-out').textContent = 'The sourced figures did not load.'; return; }
  for (const [id, k] of Object.entries(INPUTS)) { $(id).value = String(DEFAULTS[k]); $(id).addEventListener('input', cost); }
  const value = (k) => { const b = BASIS[k]; return b.inPerM !== undefined ? '$' + b.inPerM + ' in, $' + b.outPerM + ' out ' + (b.unit || '') : b.value + (b.unit ? ' ' + b.unit : ''); };
  $('c-src').innerHTML = sourcesOf(BASIS).map((s) => '<li><b>' + esc(value(s.key)) + '</b> · ' + esc(s.what || s.key) + (s.source ? ' · <a href="' + esc(s.source) + '">source</a>' : '') + '</li>').join('');
  cost();
}

$('load').addEventListener('click', load);
$('sg-make').addEventListener('click', signSample);
$('sg-cut').addEventListener('click', () => tamper('The same bundle, its last log line cut off', (b) => { b.log.pop(); return b; }));
$('sg-rewrite').addEventListener('click', () => tamper('The log rewritten from scratch with fresh hashes, one entry changed', async (b) => { const ev = eventsOf(b.log); ev[1] = { ...ev[1], at: '2000-01-01T00:00:00.000Z' }; b.log = await chainOf(ev); return b; }));
$('sg-lie').addEventListener('click', () => tamper('The judge’s key signing a judgement with one check changed', async (b) => { const k = await demoKeys(), j = JSON.parse(JSON.stringify(b.judged.payload)); j.judgement = await sha256hex(canonical({ forged: true })); b.judged = await signAs(k.J, 'judged', j); return b; }));
$('sg-forger').addEventListener('click', () => tamper('The whole bundle re-signed with a key not on the trust list', async (b) => { const k = await demoKeys(); return makeBundle({ record: b.record, log: b.log, recorder: k.X, judge: k.X }); }));
$('tr-run').addEventListener('click', trace);
$('tr-next').addEventListener('click', () => { TSEED++; trace(); });
$('go').addEventListener('click', go);
load().then(go);
receipts();
gate();
costSetup();
