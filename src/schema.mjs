// src/schema.mjs — organ 1c: the process record's schema v1, field by field. Every field has a type, and a field that is
// present must have it; each timeline entry's fields are typed by its kind. schemaCheck() lists every problem it finds,
// with pointers, so a reviewer sees which entry is broken and how. Unknown extra fields are allowed (a newer harness may
// add some); a known field of the wrong type is not. Pure, total, deterministic.
import { SCHEMA, KINDS } from './record.mjs';

export const BY = Object.freeze(['human', 'agent', 'independent']);
export const POINTER_AT = Object.freeze(['timeline', 'artifacts', 'claims', 'intent', 'summary']);
export const MIN_WORDS = 5;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isText = (x) => typeof x === 'string';
const isName = (x) => typeof x === 'string' && x.trim() !== '';
const isWhole = (x) => Number.isSafeInteger(x) && x >= 0;
const isTime = (x) => typeof x === 'string' && Number.isFinite(Date.parse(x));
const isTexts = (x) => Array.isArray(x) && x.every(isText);
/** the type of each field an entry may carry, and which its kind requires */
export const FIELD = Object.freeze({ model: isName, text: isText, by: (x) => BY.includes(x), to: isWhole, surfaced: (x) => typeof x === 'boolean', basis: (x) => x === 'intent' || x === 'answer',
  answer: isWhole, tool: isName, refers_to: isWhole, target: isName, method: isText, result: isName });
export const REQUIRED = Object.freeze({ model_call: ['model'], question: ['text'], answer: ['by', 'to'], assumption: ['text', 'surfaced'], tool_use: ['tool'], approval: ['by', 'tool'],
  intervention: ['by', 'refers_to'], verification: ['by', 'target'], rerun: ['result'], accept: ['by'] });

/** the problems with one timeline entry, given the seq before it */
export function entryProblems(e, last) {
  if (!isObj(e)) return ['not an entry'];
  const p = [];
  if (!isWhole(e.seq)) p.push('seq is not a whole number from 0'); else if (e.seq <= last) p.push('seq ' + e.seq + ' does not rise');
  if (!isTime(e.at)) p.push('no time');
  if (!KINDS.includes(e.kind)) return [...p, 'an unknown kind'];
  for (const f of REQUIRED[e.kind]) if (!(f in e)) p.push(e.kind + ' without ' + f);
  for (const [f, ok] of Object.entries(FIELD)) if (f in e && !ok(e[f])) p.push(f + ' of the wrong type');
  if (e.kind === 'assumption' && e.basis === 'answer' && !('answer' in e)) p.push('an assumption on an answer that names none');
  return p;
}
const pointerOk = (p) => isObj(p) && POINTER_AT.includes(p.at) && (p.at === 'timeline' ? isWhole(p.seq) : p.at === 'intent' ? isName(p.field) : p.at === 'summary' ? true : isName(p.id));

/** schemaCheck(record) → { outcome: pass|fail, why, evidence, problems } */
export function schemaCheck(record) {
  if (!isObj(record)) return { outcome: 'fail', why: 'not a record', evidence: [], problems: ['not a record'] };
  const problems = [], evidence = [];
  if (record.schema !== SCHEMA) problems.push('schema is not ' + SCHEMA);
  for (const f of ['job_id', 'member_id']) if (!isName(record[f])) problems.push(f + ' is not a name');
  if (!isObj(record.harness) || !isName(record.harness.name) || ('version' in record.harness && !isText(record.harness.version))) problems.push('harness is not { name, version }');
  if (!Array.isArray(record.models) || !record.models.every(isName)) problems.push('models is not a list of names');
  const i = record.intent;
  if (!isObj(i)) problems.push('intent is missing');
  else {
    if (!isName(i.goal)) problems.push('intent goal is not text');
    for (const f of ['constraints', 'success_criteria', 'allowed_tools', 'out_of_scope']) if (!isTexts(i[f])) problems.push('intent ' + f + ' is not a list of text');
    if (!isTime(i.sealed_at)) problems.push('intent sealed_at is not a time');
    if (!(typeof i.hash === 'string' && /^[0-9a-f]{64}$/.test(i.hash))) problems.push('intent hash is not 64 hex');
  }
  if (!Array.isArray(record.timeline)) problems.push('timeline is not a list');
  else {
    let last = -1;
    record.timeline.forEach((e, k) => {
      const p = entryProblems(e, last);
      if (isObj(e) && isWhole(e.seq)) last = Math.max(last, e.seq);
      if (p.length) { problems.push('timeline entry ' + (isObj(e) && isWhole(e.seq) ? e.seq : '#' + k) + ': ' + p.join(', ')); evidence.push(isObj(e) && isWhole(e.seq) ? { at: 'timeline', seq: e.seq } : { at: 'timeline', index: k }); }
    });
  }
  if (!Array.isArray(record.artifacts)) problems.push('artifacts is not a list');
  else record.artifacts.forEach((a, k) => {
    if (!isObj(a) || !isName(a.id) || !(a.role === 'input' || a.role === 'output') || !isText(a.sha256) || typeof a.stored !== 'boolean') { problems.push('artifact #' + k + ' is not { id, role, sha256, stored }'); evidence.push({ at: 'artifacts', index: k }); }
  });
  if (!Array.isArray(record.claims)) problems.push('claims is not a list');
  else record.claims.forEach((c, k) => {
    if (!isObj(c) || !isName(c.id) || !isText(c.text) || !Array.isArray(c.evidence) || !c.evidence.every(pointerOk) || ('criterion' in c && !isText(c.criterion))) { problems.push('claim #' + k + ' is not { id, text, evidence, criterion }'); evidence.push({ at: 'claims', index: k }); }
  });
  if (!isText(record.summary) || (record.summary.match(/[A-Za-z]{2,}/g) || []).length < MIN_WORDS) problems.push('summary is under ' + MIN_WORDS + ' words');
  return problems.length ? { outcome: 'fail', why: 'the record does not fit schema v1: ' + problems.slice(0, 6).join('; ') + (problems.length > 6 ? '; and ' + (problems.length - 6) + ' more' : ''), evidence, problems }
    : { outcome: 'pass', why: 'the record fits schema v1, field by field', evidence: [], problems: [] };
}
