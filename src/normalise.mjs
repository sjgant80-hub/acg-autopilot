// src/normalise.mjs — organ 2: a job's log (src/log.mjs) and its sealed intent turned into a process record, schema v1.
// Timeline entries get seq 0, 1, 2… in log order; an artifact line goes to the record's artifacts and a claim line to its
// claims; a note that refers to an earlier entry (an answer's question, an assumption's answer, an intervention's
// action) names it by its seq, as `acg log` shows it. The summary is written from the log, never from the agent's own
// account. Pure and total.
import { SCHEMA, KINDS } from './record.mjs';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const n = (k, one, many) => k + ' ' + (k === 1 ? one : many);

/** the summary, from what the log holds: counts and the tools by name, only in words the judge's plain list or the
 *  record itself holds, so a reader needs no glossary and P6 has nothing to flag */
export function summaryOf(timeline, claims) {
  const count = (kind) => timeline.filter((e) => e.kind === kind).length, tools = [...new Set(timeline.filter((e) => e.kind === 'tool_use').map((e) => e.tool))];
  const qs = count('question'), as = count('answer'), uses = count('tool_use'), results = claims.length;
  const checked = timeline.some((e) => e.kind === 'verification' && (e.by === 'human' || e.by === 'independent'));
  return 'the agent used ' + (tools.length ? 'the tools ' + tools.join(' and ') + ' on ' + n(uses, 'step', 'steps') : 'no tools')
    + ', asked ' + n(qs, 'question', 'questions') + (qs ? ' and ' + as + ' were answered' : '') + ', and the job has ' + n(results, 'result', 'results') + '; '
    + (checked ? 'the results were checked by more than the agent' : 'only the agent checked the results') + (count('rerun') ? ' and run again' : '') + (count('accept') ? ', and the human answered yes' : '');
}

/** toRecord({ job_id, member_id, harness, intent, events }) → a schema-v1 record */
export function toRecord(job) {
  const j = isObj(job) ? job : {}, events = Array.isArray(j.events) ? j.events.filter(isObj) : [];
  const timeline = [], artifacts = [], claims = [];
  for (const e of events) {
    if (e.kind === 'artifact') { if (!artifacts.some((a) => a.id === e.id && a.sha256 === e.sha256)) artifacts.push({ id: e.id, role: e.role, sha256: e.sha256, stored: e.stored === true }); continue; }
    if (e.kind === 'claim') { claims.push({ id: e.id, text: e.text, evidence: Array.isArray(e.evidence) ? e.evidence : [], ...(typeof e.criterion === 'string' ? { criterion: e.criterion } : {}) }); continue; }
    if (!KINDS.includes(e.kind)) continue;
    timeline.push({ ...e, seq: timeline.length });
  }
  const models = [...new Set(timeline.filter((e) => e.kind === 'model_call' && typeof e.model === 'string').map((e) => e.model))];
  return {
    schema: SCHEMA, job_id: String(j.job_id || 'job'), member_id: String(j.member_id || 'anonymous'), harness: isObj(j.harness) ? j.harness : { name: 'claude-code' },
    models: models.length ? models : ['unknown'], intent: j.intent, timeline, artifacts, claims, summary: summaryOf(timeline, claims),
  };
}
