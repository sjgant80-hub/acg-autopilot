// page/app.mjs — the live page: the same judge (src/judge.mjs) and suite (tools/suite.mjs) the tests, the mutation gate
// and the measurements run, in the browser. Nothing is fetched but this site's own receipts; nothing is sent anywhere.
import { assessStrict } from '../src/judge.mjs';
import { factsOf } from '../src/record.mjs';
import { cleanJob, plantedJob, malformedJob, KINDS } from '../tools/suite.mjs';

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
  const rs = (await Promise.all(['receipts/organ-1.json', 'receipts/organ-1b.json', 'receipts/organ-1c.json', 'receipts/organ-2.json'].map(get))).filter(Boolean);
  if (!rs.length) { $('receipts').textContent = 'The receipts did not load.'; return; }
  const held = rs.reduce((n, r) => n + r.held, 0), all = rs.reduce((n, r) => n + r.verdicts.length, 0);
  $('hdr-sum').textContent = held + ' of ' + all + ' sealed claims held so far' + (all - held ? ', ' + (all - held) + ' failed and kept' : '') + '.';
  $('receipts').innerHTML = rs.map((r) => '<div class="panel"><h3>Organ ' + esc(r.organ) + ' · ' + r.held + ' of ' + r.verdicts.length + ' held</h3><p class="dim">Sealed in <a href="https://github.com/sjgant80-hub/acg-autopilot/commit/' + esc(r.sealed.commit) + '">' + esc(r.sealed.commit.slice(0, 7)) + '</a>, before its code. Receipt: <a href="receipts/organ-' + esc(r.organ) + '.json">receipts/organ-' + esc(r.organ) + '.json</a>.' + (r.local ? ' Measured on the machine that holds its data (' + esc(r.local) + ').' : '') + '</p>'
    + r.verdicts.map((v) => '<p><span class="tag ' + (v.held ? 'pass' : 'fail') + '">' + (v.held ? 'HELD' : 'FAILED') + '</span> <b>' + esc(v.id) + '</b> ' + esc(v.claim) + '<br><span class="dim">measured: ' + esc(v.measured) + '</span></p>').join('') + '</div>').join('');
  const one = rs.find((r) => r.organ === 1), b = rs.find((r) => r.organ === '1b'), c = rs.find((r) => r.organ === '1c');
  $('paper-result').textContent = (one ? 'Organ 1: ' + one.held + ' of ' + one.verdicts.length + ' sealed claims held; ' + one.verdicts.filter((v) => !v.held).map((v) => v.id + ' failed (' + v.measured + ')').join('; ') + '. ' : '')
    + (b ? 'Organ 1b, sealed afresh after that failure: ' + b.held + ' of ' + b.verdicts.length + ' held. ' : '') + (c ? 'Organ 1c, the strict field-by-field schema, sealed after 1b’s failure: ' + c.held + ' of ' + c.verdicts.length + ' held.' : '');
}

$('load').addEventListener('click', load);
$('go').addEventListener('click', go);
load().then(go);
receipts();
