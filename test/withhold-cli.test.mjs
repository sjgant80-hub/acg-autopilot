// test/withhold-cli.test.mjs — organ 7 end to end: the hook, in a temporary project, with a withhold list. A withheld
// file leaves no copy, no hash of its bytes and no hash of the tool input in .acg; the record names it as not stored and
// P7 fails there; without a list every file is kept as before; a list that cannot be read withholds every file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assessStrict } from '../src/judge.mjs';
import { factsOf, canonical } from '../src/record.mjs';

const BIN = new URL('../bin/acg.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const sha = (x) => createHash('sha256').update(x).digest('hex');
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'acg-w7-')), home = join(dir, '.acg');
  const run = (args, input) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, input, env: { ...process.env, ACG_HOME: home }, encoding: 'utf8' });
  const hook = (e) => run(['hook'], JSON.stringify({ session_id: 'job-1', ...e }));
  const file = (rel, text) => { const p = join(dir, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); return p; };
  const all = (d = home) => (existsSync(d) ? readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? all(join(d, f)) : [readFileSync(join(d, f), 'latin1')])) : []).join('\n');
  return { dir, home, run, hook, file, all, done: () => rmSync(dir, { recursive: true, force: true }) };
}
/** a sealed job that reads a secret and an ordinary file, writes a secret, edits a secret → its record */
async function job(P) {
  P.run(['seal', '--goal', 'tidy the config loader', '--allowed', 'Read,Write,Edit', '--criteria', 'tests pass']);
  P.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  const env = P.file('app/.env', 'TOKEN=marker-env-0001\n'), plain = P.file('src/app.js', 'marker-plain-0002\n'), key = join(P.dir, 'keys/server.pem'), cfg = P.file('secrets/db.json', '{"pw":"marker-db-0003"}');
  const read = { file_path: env }, plainRead = { file_path: plain }, write = { file_path: key, content: 'marker-pem-0004' }, edit = { file_path: cfg, old_string: 'marker-db-0003', new_string: 'marker-db-0005' };
  for (const [tool, input, before] of [['Read', read], ['Read', plainRead], ['Write', write, () => P.file('keys/server.pem', 'marker-pem-0004')], ['Edit', edit, () => P.file('secrets/db.json', '{"pw":"marker-db-0005"}')]]) {
    const pre = P.hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input });
    if (before) before();
    const post = P.hook({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_response: {} });
    for (const r of [pre, post]) { assert.equal(r.status, 0); assert.equal(r.stdout + r.stderr, ''); }
  }
  const path = P.run(['record']).stdout.trim(), record = JSON.parse(readFileSync(path, 'utf8'));
  return { record, inputs: [read, write, edit], plain };
}

test('a withheld file: no copy, no hash of its bytes or of the tool input in .acg; the record names it, and P7 fails there', async () => {
  const P = project();
  try {
    mkdirSync(P.home, { recursive: true }); copyFileSync(new URL('../examples/withhold', import.meta.url), join(P.home, 'withhold'));
    const { record, inputs, plain } = await job(P), text = P.all();
    for (const m of ['marker-env-0001', 'marker-db-0003', 'marker-db-0005', 'marker-pem-0004']) assert.ok(!text.includes(m), m + ' kept out');
    for (const b of ['TOKEN=marker-env-0001\n', '{"pw":"marker-db-0005"}', 'marker-pem-0004']) assert.ok(!text.includes(sha(b)), 'no hash of its bytes');
    for (const i of inputs) assert.ok(!text.includes(sha(canonical(i))), 'no hash of the tool input');
    assert.ok(text.includes('marker-plain-0002'), 'a file not on the list is kept as before');
    const held = record.artifacts.filter((a) => a.stored === false).map((a) => a.id.replace(/\\/g, '/')).sort();
    assert.deepEqual(held, ['app/.env', 'keys/server.pem', 'secrets/db.json']);
    const kept = record.artifacts.find((a) => a.stored === true);
    assert.equal(kept.id.replace(/\\/g, '/'), 'src/app.js'); assert.equal(kept.sha256, sha(readFileSync(plain)));
    const j = assessStrict(record, await factsOf(record)), out = (id) => j.results.find((r) => r.id === id);
    assert.equal(out('P0').outcome, 'pass'); assert.equal(out('P1').outcome, 'pass');
    assert.equal(out('P7').outcome, 'fail');
    assert.deepEqual(out('P7').evidence.map((e) => e.id.replace(/\\/g, '/')).sort(), held);
    assert.equal(record.timeline.filter((e) => e.kind === 'tool_use' && e.withheld === true).length, 3, 'the three tool uses that named a withheld file');
  } finally { P.done(); }
});

test('no list: every file kept as before, its copy byte for byte; a list that cannot be read withholds every file', async () => {
  const P = project();
  try {
    const { record } = await job(P), text = P.all();
    for (const m of ['marker-env-0001', 'marker-plain-0002', 'marker-pem-0004', 'marker-db-0005']) assert.ok(text.includes(m), m + ' kept');
    assert.ok(record.artifacts.length === 4 && record.artifacts.every((a) => a.stored === true));
    assert.ok(!record.timeline.some((e) => 'withheld' in e), 'nothing marked when nothing is withheld');
  } finally { P.done(); }
  const Q = project();
  try {
    mkdirSync(join(Q.home, 'withhold'), { recursive: true });   // a folder where the list should be
    const { record } = await job(Q), text = Q.all();
    for (const m of ['marker-env-0001', 'marker-plain-0002', 'marker-pem-0004', 'marker-db-0005']) assert.ok(!text.includes(m), m + ' withheld');
    assert.ok(record.artifacts.length === 4 && record.artifacts.every((a) => a.stored === false));
    assert.match(readFileSync(join(Q.home, 'errors.log'), 'utf8'), /the withhold list .* could not be read .*every file withheld/);
  } finally { Q.done(); }
});
