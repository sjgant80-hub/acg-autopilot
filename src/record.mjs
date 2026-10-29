// src/record.mjs — the process record, schema v1: what an agentic job was asked to do (the intent, recorded before the
// first model call), what happened (the timeline), what it kept (the artifacts) and what it said at the end (the
// claims). The same code runs in Node 20+ and in a browser. Pure apart from the hash, which uses the platform's own
// SHA-256 (crypto.subtle), so it is async; everything else is total — a bad input gives an answer, never a throw.
//
// A record, in short:
//   { schema, job_id, member_id, harness: { name, version }, models: [..],
//     intent: { goal, constraints[], success_criteria[], allowed_tools[], out_of_scope[], sealed_at, hash },
//     timeline: [ { seq, at, kind, ... } ],   kinds below
//     artifacts: [ { id, role: 'input'|'output', sha256, stored } ],
//     claims: [ { id, text, evidence: [pointer], criterion } ],
//     summary }
// A pointer says where the evidence is: { at: 'timeline', seq } · { at: 'artifacts', id } · { at: 'claims', id } ·
// { at: 'intent', field }.

export const SCHEMA = 'acg-autopilot.process-record/1';
/** what can happen in a job */
export const KINDS = Object.freeze(['model_call', 'tool_use', 'assumption', 'question', 'answer', 'approval', 'intervention', 'verification', 'rerun', 'accept']);
export const INTENT_FIELDS = Object.freeze(['goal', 'constraints', 'success_criteria', 'allowed_tools', 'out_of_scope']);

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const list = (x) => (Array.isArray(x) ? x : []);
export const text = (x) => (typeof x === 'string' ? x : '');

/** one canonical JSON for any value: keys sorted, no whitespace; what is not JSON (functions, undefined) is left out */
export function canonical(x) {
  if (Array.isArray(x)) return '[' + x.map((v) => canonical(v)).join(',') + ']';   // what is not JSON in an array reads as null, below
  if (isObj(x)) return '{' + Object.keys(x).sort().filter((k) => x[k] !== undefined && typeof x[k] !== 'function' && typeof x[k] !== 'symbol').map((k) => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
  if (typeof x === 'number') return Number.isFinite(x) ? JSON.stringify(x) : 'null';
  if (typeof x === 'string' || typeof x === 'boolean' || x === null) return JSON.stringify(x);
  return 'null';
}

/** the intent's content, as hashed: its five fields and the time it was recorded — never the hash itself */
export const intentContent = (intent) => (isObj(intent) ? canonical({ ...Object.fromEntries(INTENT_FIELDS.map((f) => [f, intent[f]])), sealed_at: intent.sealed_at }) : '');

export async function sha256hex(s) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** the hash an intent must carry: SHA-256 of its content */
export const intentHash = async (intent) => sha256hex(intentContent(intent));

/** what the judge needs that only a hash can tell it: does the intent's hash match its content? */
export async function factsOf(record) {
  const intent = isObj(record) && isObj(record.intent) ? record.intent : null;
  return { intentHashOk: !!intent && typeof intent.hash === 'string' && intent.hash === (await intentHash(intent)) };
}

/** a pointer resolves if the thing it names is in the record */
export function resolves(record, p) {
  if (!isObj(record) || !isObj(p)) return false;
  if (p.at === 'timeline') return list(record.timeline).some((e) => isObj(e) && e.seq === p.seq);
  if (p.at === 'artifacts') return list(record.artifacts).some((a) => isObj(a) && a.id === p.id);
  if (p.at === 'claims') return list(record.claims).some((c) => isObj(c) && c.id === p.id);
  if (p.at === 'intent') return isObj(record.intent) && INTENT_FIELDS.includes(p.field);
  if (p.at === 'summary') return typeof record.summary === 'string';
  return false;
}
