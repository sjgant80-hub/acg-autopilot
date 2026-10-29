// page/app.mjs — the live page: the same judge (src/judge.mjs) and suite (tools/suite.mjs) the tests, the mutation gate
// and the measurements run, in the browser. Nothing is fetched but this site's own receipts; nothing is sent anywhere.
import { assessStrict } from '../src/judge.mjs';
import { factsOf } from '../src/record.mjs';
import { cleanJob, plantedJob, malformedJob, KINDS } from '../tools/suite.mjs';
import { signerFromSeed, signAs } from '../src/sign.mjs';
import { makeBundle, verifyBundle } from '../src/bundle.mjs';
import { link, GENESIS, eventsOf } from '../src/log.mjs';
import { toRecord } from '../src/normalise.mjs';
import { sha256hex, canonical } from '../src/record.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
async function go() {
  let rec;
  try { rec = JSON.parse($('rec').value); } catch (e) { $('out').innerHTML = '<p class="fail">That is not JSON: ' + esc(e.message) + '</p>'; return; }
  const a = assessStrict(rec, await factsOf(rec));
  $('out').innerHTML = '<p><b>' + a.counts.pass + ' pass · ' + a.counts.flag + ' flag · ' + a.counts.fail + ' fail</b> <span class="dim">· rubric ' + esc(a.rubric) + '</span></p>'
    + '<div class="tw"><table><thead><tr><th>Check</th><th>Outcome</th><th>Why</th><th>Evidence</th></tr></thead><tbody>'
    + a.results.map((x) => '<tr><td>' + esc(x.id) + (x.judgement ? ' <span class="dim">(judgement)</span>' : '') + '</td><td><span class="tag ' + esc(x.outcome) + '">' + esc(x.outcome) + '</span></td><td>' + esc(x.why) + '</td><td class="mono">' + esc(x.evidence.map(where).join(' · ') || '—') + '</td></tr>').join('')
    + '</tbody></table></div><p><b>Review queue</b> (for a person in acg-assess): ' + (a.review.length ? esc(a.review.join(', ')) : 'nothing to decide') + '</p>';
}

async function receipts() {
  const get = (p) => fetch(p, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const rs = (await Promise.all(['receipts/organ-1.json', 'receipts/organ-1b.json', 'receipts/organ-1c.json', 'receipts/organ-2.json', 'receipts/organ-3.json', 'receipts/organ-3b.json'].map(get))).filter(Boolean);
  if (!rs.length) { $('receipts').textContent = 'The receipts did not load.'; return; }
  const held = rs.reduce((n, r) => n + r.held, 0), all = rs.reduce((n, r) => n + r.verdicts.length, 0);
  $('hdr-sum').textContent = held + ' of ' + all + ' sealed claims held so far' + (all - held ? ', ' + (all - held) + ' failed and kept' : '') + '.';
  $('receipts').innerHTML = rs.map((r) => '<div class="panel"><h3>Organ ' + esc(r.organ) + ' · ' + r.held + ' of ' + r.verdicts.length + ' held</h3><p class="dim">Sealed in <a href="https://github.com/sjgant80-hub/acg-autopilot/commit/' + esc(r.sealed.commit) + '">' + esc(r.sealed.commit.slice(0, 7)) + '</a>, before its code. Receipt: <a href="receipts/organ-' + esc(r.organ) + '.json">receipts/organ-' + esc(r.organ) + '.json</a>.' + (r.local ? ' Measured on the machine that holds its data (' + esc(r.local) + ').' : '') + '</p>'
    + r.verdicts.map((v) => '<p><span class="tag ' + (v.held ? 'pass' : 'fail') + '">' + (v.held ? 'HELD' : 'FAILED') + '</span> <b>' + esc(v.id) + '</b> ' + esc(v.claim) + '<br><span class="dim">measured: ' + esc(v.measured) + '</span></p>').join('') + '</div>').join('');
  const one = rs.find((r) => r.organ === 1), b = rs.find((r) => r.organ === '1b'), c = rs.find((r) => r.organ === '1c');
  $('paper-result').textContent = (one ? 'Organ 1: ' + one.held + ' of ' + one.verdicts.length + ' sealed claims held; ' + one.verdicts.filter((v) => !v.held).map((v) => v.id + ' failed (' + v.measured + ')').join('; ') + '. ' : '')
    + (b ? 'Organ 1b, sealed afresh after that failure: ' + b.held + ' of ' + b.verdicts.length + ' held. ' : '') + (c ? 'Organ 1c, the strict field-by-field schema, sealed after 1b’s failure: ' + c.held + ' of ' + c.verdicts.length + ' held.' : '');
}

// ── signed records, in the browser: public demonstration keys (the measurement's own), never real ones ──────────────
const DEMO = {};
async function demoKeys() { if (!DEMO.R) [DEMO.R, DEMO.J, DEMO.V, DEMO.X] = await Promise.all([0x11, 0x22, 0x33, 0x44].map((b) => signerFromSeed(new Uint8Array(32).fill(b)))); return DEMO; }
async function chainOf(events) { const out = []; let p = GENESIS; for (const e of events) { const l = await link(p, e); out.push(l); p = l.hash; } return out; }
let SIGNED = null;
const say = (title, v) => '<p><span class="tag ' + (v.ok ? 'pass' : 'fail') + '">' + (v.ok ? 'VERIFIES' : 'REFUSED') + '</span> <b>' + esc(title) + '</b>' + (v.ok ? '' : '<br><span class="dim">' + v.problems.map(esc).join('<br>') + '</span>') + '</p>';
async function signSample() {
  try {
    const k = await demoKeys(), job = await cleanJob(42);
    const events = [...job.timeline.map(({ seq, ...e }) => e), ...job.artifacts.map((x) => ({ kind: 'artifact', ...x })), ...job.claims.map((c) => ({ kind: 'claim', ...c }))];
    const log = await chainOf(events), record = toRecord({ job_id: job.job_id, member_id: job.member_id, harness: job.harness, intent: job.intent, events: eventsOf(log) });
    SIGNED = { bundle: await makeBundle({ record, log, recorder: k.R, judge: k.J }), trust: { recorders: [k.R.publicHex], judges: [k.J.publicHex], reviewers: [k.V.publicHex] } };
    $('sg-out').innerHTML = say('The sample, signed by the recorder and the judge (' + log.length + ' log lines, recorder key ' + k.R.publicHex.slice(0, 12) + '…)', await verifyBundle(SIGNED.bundle, SIGNED.trust));
  } catch (e) { $('sg-out').innerHTML = '<p class="fail">This browser could not sign: ' + esc(e.message) + ' (Ed25519 in WebCrypto needs a recent browser)</p>'; }
}
async function tamper(title, change) {
  if (!SIGNED) await signSample();
  if (!SIGNED) return;
  const b = await change(structuredClone(SIGNED.bundle));
  $('sg-out').innerHTML += say(title, await verifyBundle(b, SIGNED.trust));
}

$('load').addEventListener('click', load);
$('sg-make').addEventListener('click', signSample);
$('sg-cut').addEventListener('click', () => tamper('The same bundle, its last log line cut off', (b) => { b.log.pop(); return b; }));
$('sg-rewrite').addEventListener('click', () => tamper('The log rewritten from scratch with fresh hashes, one entry changed', async (b) => { const ev = eventsOf(b.log); ev[1] = { ...ev[1], at: '2000-01-01T00:00:00.000Z' }; b.log = await chainOf(ev); return b; }));
$('sg-lie').addEventListener('click', () => tamper('The judge’s key signing a judgement with one check changed', async (b) => { const k = await demoKeys(), j = JSON.parse(JSON.stringify(b.judged.payload)); j.judgement = await sha256hex(canonical({ forged: true })); b.judged = await signAs(k.J, 'judged', j); return b; }));
$('sg-forger').addEventListener('click', () => tamper('The whole bundle re-signed with a key not on the trust list', async (b) => { const k = await demoKeys(); return makeBundle({ record: b.record, log: b.log, recorder: k.X, judge: k.X }); }));
$('go').addEventListener('click', go);
load().then(go);
receipts();
