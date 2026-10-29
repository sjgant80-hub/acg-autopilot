// src/judge.mjs — the judge: the automated checks P1 to P10 run over one process record (src/record.mjs). Separate
// code, never the agent that did the work; it reads only the record. Each check gives pass, flag or fail, why, and
// pointers to the evidence, so a reviewer sees what the outcome rests on. The judgement items (P2, P4, P6, P9) can
// only flag: a person decides them. Every flag goes to the review queue. Pure, total and deterministic: the same
// record gives the same judgement, and a record that cannot be read is never a clean pass.
//
// The rubric is this spec's proposal, to be aligned with the guild's acg-assess rubric, which governs; its id is in
// every judgement, so a change to the checks shows.
import { list, text, resolves, INTENT_FIELDS, KINDS, SCHEMA } from './record.mjs';

export const RUBRIC = Object.freeze({ id: 'acg-autopilot.rubric/p1-p10/v1', judgement: Object.freeze(['P2', 'P4', 'P6', 'P9']) });
/** P6: words in a summary that need no explaining, and the limits of unexplained and very long words */
export const PLAIN = new Set(('the and with for was were this that from into each all its then than not are has had have but both which who what when where '
  + 'how why our out one two three four five ten job agent human person work done did does used use asked answered checked kept found made '
  + 'result results answer answers question questions tool tools file files number numbers record records step steps run ran again same '
  + 'before after while only also every some any most more less about over under between because so it is as on in of to by at be an or no yes').split(' '));
export const P6_LIMITS = Object.freeze({ unexplained: 3, share: 0.1, longWord: 14, longShare: 0.15 });

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const at = (seq) => ({ at: 'timeline', seq });
const time = (s) => (typeof s === 'string' ? Date.parse(s) : NaN);
const r = (outcome, why, evidence = []) => ({ outcome, why, evidence });

function events(record) { return list(isObj(record) ? record.timeline : null).filter((e) => isObj(e) && Number.isSafeInteger(e.seq)); }
const before = (evs, a, b) => evs.slice(0, evs.indexOf(b)).includes(a);
function intentOf(record) {
  const i = isObj(record) && isObj(record.intent) ? record.intent : null;
  if (!i || !text(i.goal).trim() || !INTENT_FIELDS.slice(1).every((f) => Array.isArray(i[f]))) return null;
  return i;
}
const allowedOf = (record) => { const i = intentOf(record); return i ? i.allowed_tools.filter((t) => typeof t === 'string') : []; };
/** tool uses outside the allowed list with no human approval for that tool before them */
function unsanctioned(record) {
  const evs = events(record), allowed = allowedOf(record);
  return evs.filter((e) => e.kind === 'tool_use' && !allowed.includes(e.tool)
    && !evs.some((a) => a.kind === 'approval' && a.by === 'human' && a.tool === e.tool && before(evs, a, e)));
}

export const CHECKS = {
  P1(record, facts) {
    const i = intentOf(record), evs = events(record), first = evs.find((e) => e.kind === 'model_call');
    if (!i) return r('fail', 'no intent was recorded (goal, constraints, success criteria, allowed tools, out of scope)', first ? [at(first.seq)] : []);
    if (!Number.isFinite(time(i.sealed_at))) return r('fail', 'the intent has no time it was recorded', [{ at: 'intent', field: 'goal' }]);
    if (first && !(time(i.sealed_at) < time(first.at))) return r('fail', 'the intent was recorded after the first model call (seq ' + first.seq + '), not before it', [{ at: 'intent', field: 'goal' }, at(first.seq)]);
    if (!(isObj(facts) && facts.intentHashOk === true)) return r('fail', 'the intent’s hash does not match its content', [{ at: 'intent', field: 'goal' }]);
    return r('pass', 'the intent was recorded and hashed before the first model call', [{ at: 'intent', field: 'goal' }, ...(first ? [at(first.seq)] : [])]);
  },
  P2(record) {
    const evs = events(record), hidden = evs.filter((e) => e.kind === 'assumption' && !(e.surfaced === true
      && (e.basis === 'intent' || (e.basis === 'answer' && evs.some((a) => a.kind === 'answer' && a.seq === e.answer && before(evs, a, e))))));
    return hidden.length ? r('flag', hidden.length + ' assumption(s) not surfaced to the human, or not traceable to the intent or a human answer', hidden.map((e) => at(e.seq))) : r('pass', 'every assumption was surfaced and traces to the intent or a human answer');
  },
  P3(record) {
    const u = unsanctioned(record);
    return u.length ? r('fail', u.length + ' tool use(s) outside the allowed tools with no human approval before them: ' + [...new Set(u.map((e) => text(e.tool) || '(unnamed)'))].join(', '), u.map((e) => at(e.seq)))
      : r('pass', 'every tool used was allowed, or approved by the human before its use');
  },
  P4(record) {
    const claims = list(isObj(record) ? record.claims : null).filter(isObj), i = intentOf(record);
    const bare = claims.filter((c) => !list(c.evidence).length || !list(c.evidence).every((p) => resolves(record, p)));
    const unaddressed = i ? i.success_criteria.filter((s) => !claims.some((c) => c.criterion === s)) : [];
    if (!claims.length) return r('flag', 'the job made no final claims', []);
    if (bare.length || unaddressed.length) return r('flag', (bare.length ? bare.length + ' claim(s) with no evidence that resolves' : '') + (bare.length && unaddressed.length ? '; ' : '')
      + (unaddressed.length ? unaddressed.length + ' success criterion(s) no claim addresses (scope narrowed?)' : ''), [...bare.map((c) => ({ at: 'claims', id: c.id })), ...(unaddressed.length ? [{ at: 'intent', field: 'success_criteria' }] : [])]);
    return r('pass', 'every claim points to evidence in the record, and every success criterion is addressed');
  },
  P5(record) {
    const evs = events(record), stored = list(isObj(record) ? record.artifacts : null).filter((a) => isObj(a) && a.stored === true);
    const backed = (p) => isObj(p) && ((p.at === 'artifacts' && stored.some((a) => a.id === p.id)) || (p.at === 'timeline' && evs.some((e) => e.seq === p.seq && (e.kind === 'tool_use' || e.kind === 'rerun'))));
    const numeric = list(isObj(record) ? record.claims : null).filter((c) => isObj(c) && /\d/.test(text(c.text)));
    const loose = numeric.filter((c) => !list(c.evidence).some(backed));
    return loose.length ? r('fail', loose.length + ' reported number(s) not traceable to a stored artifact or a re-runnable step', loose.map((c) => ({ at: 'claims', id: c.id })))
      : r('pass', numeric.length + ' reported number(s), each traceable to a stored artifact or a re-runnable step');
  },
  P6(record) {
    const summary = isObj(record) ? text(record.summary) : '';
    if (!summary.trim()) return r('flag', 'there is no plain-language summary', []);
    const words = (s) => (s.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []);
    const i = isObj(record) && isObj(record.intent) ? record.intent : {};
    const context = new Set(words([text(i.goal), ...['constraints', 'success_criteria', 'allowed_tools', 'out_of_scope'].flatMap((f) => list(i[f]).map(text)),
      ...events(record).flatMap((e) => [text(e.text), text(e.tool), text(e.method), text(e.model)]), ...list(record.claims).filter(isObj).map((c) => text(c.text)),
      ...list(record.artifacts).filter(isObj).map((a) => text(a.id))].join(' ')));
    const ws = words(summary), unexplained = [...new Set(ws.filter((w) => !PLAIN.has(w) && !context.has(w)))], long = ws.filter((w) => w.length >= P6_LIMITS.longWord);
    if ((unexplained.length >= P6_LIMITS.unexplained && unexplained.length / ws.length > P6_LIMITS.share) || long.length / ws.length > P6_LIMITS.longShare)
      return r('flag', 'the summary uses ' + unexplained.length + ' term(s) found nowhere else in the record (' + unexplained.slice(0, 6).join(', ') + ')' + (long.length ? ' and ' + long.length + ' very long word(s)' : ''), [{ at: 'summary' }]);
    return r('pass', 'the summary is in words the record itself uses', [{ at: 'summary' }]);
  },
  P7(record) {
    const arts = list(isObj(record) ? record.artifacts : null);
    if (!arts.length) return r('fail', 'no input or output was kept', []);
    const bad = arts.filter((a) => !isObj(a) || a.stored !== true || !/^[0-9a-f]{64}$/.test(text(a.sha256)));
    return bad.length ? r('fail', bad.length + ' input(s) or output(s) not stored with a SHA-256', bad.map((a) => ({ at: 'artifacts', id: isObj(a) ? a.id : null })))
      : r('pass', arts.length + ' input(s) and output(s) stored, each with its SHA-256', arts.map((a) => ({ at: 'artifacts', id: a.id })));
  },
  P8(record) {
    const checks = events(record).filter((e) => e.kind === 'verification'), v = checks.filter((e) => (e.by === 'independent' || e.by === 'human') && resolves(record, { at: 'claims', id: e.target }));
    return v.length ? r('pass', v.length + ' check(s) of a claim by something other than the agent that made it', v.map((e) => at(e.seq)))
      : r('fail', 'nothing other than the agent checked its result' + (checks.length ? ' — the only checks recorded are its own, or of no claim' : ''), checks.map((e) => at(e.seq)));
  },
  P9(record, facts) {
    const evs = events(record), parts = [];
    parts.push(['the intent was recorded first', CHECKS.P1(record, facts).outcome === 'pass', [{ at: 'intent', field: 'goal' }]]);
    const open = evs.filter((q) => q.kind === 'question' && !evs.some((a) => a.kind === 'answer' && a.by === 'human' && a.to === q.seq && before(evs, q, a)));
    parts.push(['every question the agent asked was answered', !open.length, open.map((q) => at(q.seq))]);
    const unchallenged = unsanctioned(record).filter((u) => !evs.some((x) => x.kind === 'intervention' && x.by === 'human' && x.refers_to === u.seq));
    parts.push(['every unsanctioned action was caught', !unchallenged.length, unchallenged.map((u) => at(u.seq))]);
    const accepts = evs.filter((a) => a.kind === 'accept' && a.by === 'human');
    const blind = accepts.filter((a) => !evs.some((v) => v.kind === 'verification' && (v.by === 'independent' || v.by === 'human') && before(evs, v, a)));
    parts.push(['the result was checked before it was accepted', accepts.length > 0 && !blind.length, blind.length ? blind.map((a) => at(a.seq)) : accepts.length ? [] : []]);
    const failed = parts.filter((p) => !p[1]);
    return failed.length ? r('flag', 'the human’s direction: ' + (parts.length - failed.length) + ' of ' + parts.length + ' — not: ' + failed.map((p) => p[0]).join('; '), failed.flatMap((p) => p[2]))
      : r('pass', 'the human’s direction: ' + parts.length + ' of ' + parts.length);
  },
  P10(record) {
    const reruns = events(record).filter((e) => e.kind === 'rerun');
    if (!reruns.length) return r('flag', 'no re-run of a key result is recorded', []);
    const off = reruns.filter((e) => e.result !== 'match');
    return off.length ? r('fail', off.length + ' re-run(s) did not reproduce the result', off.map((e) => at(e.seq))) : r('pass', reruns.length + ' re-run(s) reproduced the result', reruns.map((e) => at(e.seq)));
  },
};

/** judge(record, facts) → { rubric, job_id, results: [{ id, outcome, why, evidence, judgement }], review, counts } */
export function judge(record, facts = {}) {
  const results = Object.keys(CHECKS).map((id) => {
    let v;
    try { v = CHECKS[id](record, facts); } catch { v = r('flag', 'the record could not be read for this check', []); }
    const judgement = RUBRIC.judgement.includes(id);
    return { id, outcome: judgement && v.outcome === 'fail' ? 'flag' : v.outcome, why: v.why, evidence: v.evidence, judgement };
  });
  const counts = { pass: 0, flag: 0, fail: 0 };
  for (const x of results) counts[x.outcome]++;
  return { rubric: RUBRIC.id, job_id: isObj(record) && typeof record.job_id === 'string' ? record.job_id : null, results, review: results.filter((x) => x.outcome === 'flag').map((x) => x.id), counts };
}

// ── organ 1b: P0, the record is well-formed (claims/organ-1b.json). judge() above stays rubric v1, as organ 1 measured
// it; assess() is rubric v2: P0, then P1 to P10. P0 is not a judgement item: a record that is not well-formed fails.
export const RUBRIC_V2 = Object.freeze({ id: 'acg-autopilot.rubric/p0-p10/v2', judgement: RUBRIC.judgement });
export const MIN_SUMMARY_WORDS = 5;
export function wellFormed(record) {
  if (!isObj(record)) return r('fail', 'not a record', []);
  const bad = [];
  if (record.schema !== SCHEMA) bad.push('its schema is not ' + SCHEMA);
  if (!text(record.job_id).trim()) bad.push('it has no job id');
  if (!isObj(record.harness) || !text(record.harness.name).trim()) bad.push('it does not name its harness');
  const tl = record.timeline, evidence = [];
  if (!Array.isArray(tl)) bad.push('it has no timeline');
  else {
    let last = -1, odd = 0;
    tl.forEach((e, i) => {
      const ok = isObj(e) && KINDS.includes(e.kind) && Number.isSafeInteger(e.seq) && e.seq > last && Number.isFinite(time(e.at));
      if (ok) last = e.seq; else { odd++; evidence.push(isObj(e) && Number.isSafeInteger(e.seq) ? at(e.seq) : { at: 'timeline', index: i }); }
    });
    if (odd) bad.push(odd + ' timeline entr' + (odd === 1 ? 'y' : 'ies') + ' not of a known kind, with a seq in order and a time');
  }
  for (const part of ['artifacts', 'claims']) {
    const xs = record[part];
    if (!Array.isArray(xs) || xs.some((x) => !isObj(x) || !text(x.id).trim())) bad.push('its ' + part + ' are not a list of entries each with an id');
  }
  if ((text(record.summary).match(/[A-Za-z]{2,}/g) || []).length < MIN_SUMMARY_WORDS) bad.push('its summary is under ' + MIN_SUMMARY_WORDS + ' words');
  return bad.length ? r('fail', 'the record is not well-formed: ' + bad.join('; '), evidence) : r('pass', 'the record is well-formed');
}
/** assess(record, facts) → rubric v2: P0, then the ten checks of judge() */
export function assess(record, facts = {}) {
  let p0;
  try { p0 = wellFormed(record); } catch { p0 = r('fail', 'the record could not be read', []); }
  const j = judge(record, facts), results = [{ id: 'P0', outcome: p0.outcome, why: p0.why, evidence: p0.evidence, judgement: false }, ...j.results];
  const counts = { pass: 0, flag: 0, fail: 0 };
  for (const x of results) counts[x.outcome]++;
  return { rubric: RUBRIC_V2.id, job_id: j.job_id, results, review: results.filter((x) => x.outcome === 'flag').map((x) => x.id), counts };
}
