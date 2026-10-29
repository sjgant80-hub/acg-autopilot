// test/capture.test.mjs — organ 2: the hash-chained log catches every edit; the normaliser makes a schema-v1 record whose
// summary is plain; the importer reads a transcript faithfully and never invents an intent; the command line records a
// job from its hook events, intent first, and a garbage hook input never breaks the harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { link, parseLog, verifyLog, eventsOf, GENESIS } from '../src/log.mjs';
import { toRecord, summaryOf } from '../src/normalise.mjs';
import { importTranscript, eventsOfTranscript, NONE_SEALED } from '../src/transcript.mjs';
import { schemaCheck } from '../src/schema.mjs';
import { assessStrict, CHECKS } from '../src/judge.mjs';
import { factsOf, SCHEMA, sha256hex, canonical } from '../src/record.mjs';
import { hookProblem } from '../bin/acg.mjs';

async function chain(events) { const out = []; let prev = GENESIS; for (const e of events) { const l = await link(prev, e); out.push(l); prev = l.hash; } return out; }
const EV = [{ kind: 'model_call', at: '2026-10-29T10:00:00.000Z', model: 'm' }, { kind: 'tool_use', at: '2026-10-29T10:00:01.000Z', tool: 'Read' }, { kind: 'tool_use', at: '2026-10-29T10:00:02.000Z', tool: 'Edit' }];

test('the log: each line carries the hash before it and its own; any edit, removal or swap is caught where it happens', async () => {
  assert.equal(GENESIS, '0'.repeat(64));
  const lines = await chain(EV);
  assert.equal(lines[0].prev, GENESIS); assert.equal(lines[1].prev, lines[0].hash);
  assert.equal(lines[0].hash, await sha256hex(GENESIS + '|' + canonical(EV[0])));
  assert.deepEqual(await verifyLog(lines), { ok: true, head: lines[2].hash, length: 3 });
  assert.deepEqual(await verifyLog([]), { ok: true, head: GENESIS, length: 0 });
  const changed = structuredClone(lines); changed[1].tool = 'Write';
  assert.deepEqual(await verifyLog(changed), { ok: false, at: 1, why: 'line 1 has been changed' });
  assert.deepEqual(await verifyLog([lines[0], lines[2]]), { ok: false, at: 1, why: 'line 1 does not follow the line before it' });
  assert.deepEqual(await verifyLog([lines[1], lines[0], lines[2]]), { ok: false, at: 0, why: 'line 0 does not follow the line before it' });
  assert.equal((await verifyLog([lines[0], 'x'])).why, 'line 1 is not an object');
  assert.equal((await verifyLog('x')).why, 'not a list of lines');
  const relinked = await link('x', { ...EV[0], prev: 'forged', hash: 'forged' });
  assert.equal(relinked.prev, 'x', 'a line cannot bring its own chain fields');
  assert.equal(relinked.hash, (await link('x', EV[0])).hash, 'and they do not touch its hash');
  assert.deepEqual(eventsOf(lines), EV); assert.deepEqual(eventsOf('x'), []); assert.deepEqual(eventsOf([null, ...lines]).length, 3);
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n\n';
  assert.deepEqual(parseLog(text).lines, lines);
  assert.deepEqual(parseLog('{"a":1}\nnope'), { error: 'line 1 is not JSON', at: 1 }); assert.deepEqual(parseLog('[1]'), { error: 'line 0 is not an object', at: 0 }); assert.deepEqual(parseLog(3), { error: 'not text', at: -1 });
  assert.deepEqual(await link('p', 'x'), { prev: 'p', hash: await sha256hex('p|{}') });
});

test('the normaliser: timeline in order with seq from 0, artifacts and claims set apart, a plain summary, the strict schema met', async () => {
  const intent = { goal: 'g', constraints: [], success_criteria: ['done'], allowed_tools: ['Read'], out_of_scope: [], sealed_at: '2026-10-29T09:00:00.000Z' }; intent.hash = await sha256hex('x');
  const events = [...EV, { kind: 'artifact', id: 'a.txt', role: 'input', sha256: 'f'.repeat(64), stored: true }, { kind: 'artifact', id: 'a.txt', role: 'input', sha256: 'f'.repeat(64), stored: true },
    { kind: 'question', at: '2026-10-29T10:00:03.000Z', text: 'which' }, { kind: 'answer', at: '2026-10-29T10:00:04.000Z', by: 'human', to: 3, text: 'that' },
    { kind: 'claim', id: 'c1', text: 'done', evidence: [{ at: 'artifacts', id: 'a.txt' }], criterion: 'done' }, { kind: 'claim', id: 'c2', text: 'x', evidence: 'bad' },
    { kind: 'verification', at: '2026-10-29T10:00:05.000Z', by: 'independent', target: 'c1' }, { kind: 'rerun', at: '2026-10-29T10:00:06.000Z', result: 'match' }, { kind: 'accept', at: '2026-10-29T10:00:07.000Z', by: 'human' }, { kind: 'mystery' }, null];
  const r = toRecord({ job_id: 'j1', member_id: 'm1', harness: { name: 'claude-code', version: '1' }, intent, events });
  assert.equal(r.schema, SCHEMA); assert.deepEqual(r.models, ['m']);
  assert.deepEqual(r.timeline.map((e) => [e.seq, e.kind]), [[0, 'model_call'], [1, 'tool_use'], [2, 'tool_use'], [3, 'question'], [4, 'answer'], [5, 'verification'], [6, 'rerun'], [7, 'accept']]);
  assert.deepEqual(r.artifacts, [{ id: 'a.txt', role: 'input', sha256: 'f'.repeat(64), stored: true }], 'the same artifact twice is kept once');
  assert.deepEqual(r.claims, [{ id: 'c1', text: 'done', evidence: [{ at: 'artifacts', id: 'a.txt' }], criterion: 'done' }, { id: 'c2', text: 'x', evidence: [] }]);
  assert.equal(r.summary, 'the agent used the tools Read and Edit on 2 steps, asked 1 question and 1 were answered, and the job has 2 results; the results were checked by more than the agent and run again, and the human answered yes');
  assert.equal(schemaCheck(r).outcome, 'pass');
  assert.equal(assessStrict(r, await factsOf(r)).results.find((x) => x.id === 'P6').outcome, 'pass', 'the summary is plain to P6');
  assert.equal(summaryOf([], []), 'the agent used no tools, asked 0 questions, and the job has 0 results; only the agent checked the results');
  assert.match(summaryOf([{ kind: 'tool_use', tool: 'a' }, { kind: 'verification', by: 'agent' }], [{}]), /used the tools a on 1 step, .* has 1 result; only the agent checked/);
  assert.match(summaryOf([{ kind: 'answer', by: 'human' }, { kind: 'accept', by: 'human' }], []), /only the agent checked the results/, 'a human answer is not a check');
  const two = toRecord({ events: [{ kind: 'artifact', id: 'f', role: 'input', sha256: 'a'.repeat(64), stored: true }, { kind: 'artifact', id: 'f', role: 'output', sha256: 'b'.repeat(64), stored: true }, { kind: 'artifact', id: 'g', role: 'input', sha256: 'a'.repeat(64), stored: true }] });
  assert.equal(two.artifacts.length, 3, 'the same file with new content, and another file with the same content, are each kept');
  assert.deepEqual(toRecord({ events: [{ kind: 'model_call', at: 'x', model: 'm' }, { kind: 'question', at: 'x', text: 'q', model: 'z' }, { kind: 'model_call', at: 'x' }] }).models, ['m'], 'only model calls name models, and only by a name');
  const bare = toRecord(null);
  assert.equal(bare.job_id, 'job'); assert.equal(bare.member_id, 'anonymous'); assert.deepEqual(bare.harness, { name: 'claude-code' }); assert.deepEqual(bare.models, ['unknown']); assert.equal(bare.intent, undefined);
  assert.equal(toRecord({ harness: 'x', events: 'x' }).harness.name, 'claude-code');
});

const T = (o) => JSON.stringify(o);
const transcript = [
  T({ type: 'user', timestamp: '2026-10-29T10:00:00.000Z', sessionId: 's1', version: '9', message: { role: 'user', content: 'do it' } }),
  T({ type: 'assistant', timestamp: '2026-10-29T10:00:01.000Z', requestId: 'r1', message: { model: 'claude-x', content: [{ type: 'thinking' }] } }),
  T({ type: 'assistant', timestamp: '2026-10-29T10:00:02.000Z', requestId: 'r1', message: { model: 'claude-x', content: [{ type: 'tool_use', name: 'Read', input: {} }, { type: 'tool_use', name: 'Grep', input: {} }] } }),
  T({ type: 'user', timestamp: '2026-10-29T10:00:03.000Z', message: { role: 'user', content: [{ type: 'tool_result' }] } }),
  T({ type: 'assistant', isSidechain: true, timestamp: '2026-10-29T10:00:04.000Z', requestId: 'side', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
  T({ type: 'assistant', timestamp: '2026-10-29T10:00:05.000Z', requestId: 'r2', message: { content: [{ type: 'tool_use', name: 'Edit' }, { type: 'tool_use', name: '' }, { type: 'text' }] } }),
  T({ type: 'assistant', message: { model: 'claude-x', content: [] } }),
  'not json', '[1]', '',
].join('\n');

test('the importer: tool uses in order, a model call per request, side chains left out, and an intent that says none was sealed', async () => {
  const t = eventsOfTranscript(transcript);
  assert.deepEqual(t.counts, { lines: 9, unreadable: 2, sidechain: 1, prompts: 1, requests: 3, toolUses: 3 });
  assert.deepEqual(t.events.map((e) => e.kind === 'tool_use' ? e.tool : 'call:' + e.model), ['call:claude-x', 'Read', 'Grep', 'call:unknown', 'Edit', 'call:claude-x']);
  assert.equal(t.sessionId, 's1'); assert.equal(t.version, '9'); assert.equal(t.last, '2026-10-29T10:00:05.000Z');
  assert.equal(t.events[5].at, '2026-10-29T10:00:05.000Z', 'a line with no time keeps the last time seen');
  const { record, counts } = await importTranscript(transcript);
  assert.deepEqual(counts, t.counts);
  assert.equal(record.job_id, 's1'); assert.deepEqual(record.harness, { name: 'claude-code', version: '9' });
  assert.equal(record.intent.goal, NONE_SEALED); assert.equal(record.intent.sealed_at, '2026-10-29T10:00:05.001Z');
  assert.equal(schemaCheck(record).outcome, 'pass', 'the record fits the strict schema');
  const a = assessStrict(record, await factsOf(record));
  assert.equal(a.results.find((x) => x.id === 'P1').outcome, 'fail', 'a past job never passes P1');
  assert.match(a.results.find((x) => x.id === 'P1').why, /after the first model call/);
  assert.equal((await importTranscript(transcript, { job_id: 'mine', member_id: 'me' })).record.member_id, 'me');
  const empty = await importTranscript('');
  assert.equal(empty.record.job_id, 'imported'); assert.equal(empty.record.intent.sealed_at, '1970-01-01T00:00:00.001Z'); assert.equal(empty.counts.lines, 0);
  assert.deepEqual(eventsOfTranscript(null).counts.lines, 0); assert.deepEqual((await importTranscript(transcript, 'x')).record.member_id, 'anonymous');
  assert.equal(eventsOfTranscript(T({ type: 'assistant', timestamp: 'soon', message: { content: [{ type: 'tool_use', name: 'X' }] } })).events[0].at, '1970-01-01T00:00:00.000Z');
  const more = [T({ type: 'user', sessionId: 's1', version: '1', message: { content: 'a' } }), T({ type: 'user', sessionId: 's2', version: '2', message: { content: 'b' } }), T({ type: 'user', message: { content: [{ type: 'tool_result' }] } }), T({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
    T({ type: 'user' }), T({ type: 'assistant', requestId: 'q', message: { model: '', content: 'words' } })].join('\n');
  const m = eventsOfTranscript(more);
  assert.equal(m.counts.prompts, 2, 'two prompts; a tool result is not one'); assert.equal(m.sessionId, 's1'); assert.equal(m.version, '1');
  assert.deepEqual(m.events, [{ kind: 'model_call', at: '1970-01-01T00:00:00.000Z', model: 'unknown' }], 'an empty model name reads unknown');
});

const BIN = new URL('../bin/acg.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const run = (home, argv, input) => spawnSync(process.execPath, [BIN, ...argv], { env: { ...process.env, ACG_HOME: home }, input: input === undefined ? '' : input, encoding: 'utf8' });

test('the command line: seal first, the hook writes the job down, notes and a claim, a record that verifies and is judged', async () => {
  const home = mkdtempSync(join(tmpdir(), 'acg-')), file = join(home, 'note.txt');
  try {
    writeFileSync(file, 'hello');
    assert.match(run(home, ['seal', '--goal', 'read a note', '--allowed', 'Read,Edit', '--criteria', 'read it']).stdout, /^sealed [0-9a-f]{12} at .* binds to the next job/);
    const hk = (o) => run(home, ['hook'], JSON.stringify({ session_id: 'job1', ...o }));
    for (const r of [hk({ hook_event_name: 'SessionStart' }), hk({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }), hk({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: file } }),
      hk({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: file }, tool_response: {} }), hk({ hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' } }), hk({ hook_event_name: 'Stop' })]) {
      assert.equal(r.status, 0); assert.equal(r.stdout, '', 'the hook prints nothing');
    }
    assert.ok(existsSync(join(home, 'jobs', 'job1', 'intent.json')) && !existsSync(join(home, 'pending-intent.json')), 'the pending intent bound to the job');
    const sha = (await import('node:crypto')).createHash('sha256').update('hello').digest('hex');
    assert.ok(existsSync(join(home, 'jobs', 'job1', 'store', sha)), 'the file read was kept by its hash');
    assert.match(run(home, ['note', 'question', '--text', 'which note']).stdout, /noted question in job1/);
    assert.match(run(home, ['note', 'answer', '--by', 'human', '--to', '2', '--text', 'that one']).stdout, /noted answer/);
    assert.match(run(home, ['note', 'assumption', '--text', 'utf8', '--surfaced', '--basis', 'intent']).stdout, /noted assumption/);
    assert.match(run(home, ['note', 'verification', '--by', 'independent', '--target', 'c1', '--method', 'read again']).stdout, /noted/);
    assert.match(run(home, ['note', 'rerun', '--result', 'match']).stdout, /noted/);
    assert.match(run(home, ['note', 'accept', '--by', 'human']).stdout, /noted/);
    assert.match(run(home, ['claim', '--id', 'c1', '--text', 'the note says hello', '--evidence', 'timeline:1,intent:goal', '--criterion', 'read it']).stdout, /claim c1 recorded/);
    assert.match(run(home, ['verify']).stdout, /^the log verifies: 10 lines/);
    assert.match(run(home, ['log']).stdout, /^0 {2}model_call\n1 {2}tool_use Read\n2 {2}question · which note/);
    const recPath = run(home, ['record']).stdout.trim(), rec = JSON.parse(readFileSync(recPath, 'utf8'));
    assert.equal(rec.job_id, 'job1'); assert.equal(rec.intent.goal, 'read a note'); assert.equal(rec.artifacts.length, 1); assert.equal(rec.artifacts[0].role, 'input');
    assert.equal(rec.timeline.find((e) => e.kind === 'assumption').surfaced, true);
    const judged = run(home, ['judge']).stdout;
    assert.match(judged, /^P0 {2}pass/); assert.match(judged, /P1 {2}pass/); assert.match(judged, /P3 {2}pass/); assert.match(judged, /review queue:/);
    const a = assessStrict(rec, await factsOf(rec));
    assert.equal(a.results.find((x) => x.id === 'P0').outcome, 'pass'); assert.equal(a.results.find((x) => x.id === 'P1').outcome, 'pass');
    assert.match(run(home, ['judge', recPath]).stdout, /^P0 {2}pass/);
    const tr = join(home, 't.jsonl'); writeFileSync(tr, transcript);
    assert.match(run(home, ['import', tr, '--out', join(home, 'imp.json')]).stdout, /3 model requests, 3 tool uses/);
    assert.match(run(home, ['import', tr]).stdout, /^3 model requests/);
    assert.match(run(home, ['help']).stdout, /acg seal \| hook/);
    assert.equal(run(home, ['note', 'model_call']).status, 1); assert.equal(run(home, ['seal']).status, 1); assert.equal(run(home, ['claim', '--id', 'x']).status, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('intent after the first prompt fails P1; a note with no job is refused', async () => {
  const home = mkdtempSync(join(tmpdir(), 'acg-'));
  try {
    assert.equal(run(home, ['note', 'question', '--text', 'x']).status, 1);
    run(home, ['hook'], JSON.stringify({ session_id: 'late', hook_event_name: 'UserPromptSubmit' }));
    await new Promise((ok) => setTimeout(ok, 5));
    run(home, ['seal', '--goal', 'too late']);
    run(home, ['hook'], JSON.stringify({ session_id: 'late', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }));
    const rec = JSON.parse(readFileSync(run(home, ['record']).stdout.trim(), 'utf8'));
    assert.equal(rec.intent.goal, 'too late');
    assert.equal(assessStrict(rec, await factsOf(rec)).results.find((x) => x.id === 'P1').outcome, 'fail');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a garbage hook input never breaks the harness: exit 0, nothing printed, nothing logged to a job, one error line', () => {
  const home = mkdtempSync(join(tmpdir(), 'acg-'));
  try {
    const bad = ['not json', '[]', '3', '{}', T({ session_id: '../x', hook_event_name: 'Stop' }), T({ session_id: 'ok', hook_event_name: 'Nope' }), T({ session_id: 'ok', hook_event_name: 'PreToolUse', tool_input: {} }),
      T({ session_id: 'ok', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: 'x' }), T({ session_id: 'ok', hook_event_name: 'PreToolUse', tool_name: ' ', tool_input: {} })];
    for (const b of bad) { const r = run(home, ['hook'], b); assert.equal(r.status, 0, b); assert.equal(r.stdout, ''); }
    assert.ok(!existsSync(join(home, 'jobs')), 'no job was made');
    assert.equal(readFileSync(join(home, 'errors.log'), 'utf8').trim().split('\n').length, bad.length);
    for (const b of bad) assert.equal(typeof hookProblem((() => { try { return JSON.parse(b); } catch { return undefined; } })()), 'string', b);
    assert.equal(hookProblem({ session_id: 'a', hook_event_name: 'Stop' }), null);
    assert.equal(hookProblem({ session_id: 'a', hook_event_name: 'PostToolUse', tool_name: 'R', tool_input: {} }), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
