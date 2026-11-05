// test/portfolio-cli.test.mjs — organ 5 from the command line, end to end in a temporary folder: acg portfolio holds
// only the jobs named (or all of the member's), attested with the judge's key (sealed keys need the passphrase), the full
// bundle only for the jobs revealed; acg check-portfolio accepts it and refuses a changed copy with exit code 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = new URL('../bin/acg.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const run = (home, argv, env = {}, input = '') => spawnSync(process.execPath, [BIN, ...argv], { env: { ...process.env, ACG_HOME: home, ACG_PASSPHRASE: '', ACG_MEMBER: 'ana', ...env }, input, encoding: 'utf8' });
const P = { ACG_PASSPHRASE: 'a long test passphrase' };
function job(home, id, env = {}) {
  run(home, ['seal', '--goal', 'read a note', '--allowed', 'Read'], env);
  run(home, ['hook'], env, JSON.stringify({ session_id: id, hook_event_name: 'UserPromptSubmit' }));
  run(home, ['hook'], env, JSON.stringify({ session_id: id, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }));
  return run(home, ['bundle', '--job', id], env);
}

test('acg portfolio and acg check-portfolio, end to end', () => {
  const home = mkdtempSync(join(tmpdir(), 'acg-port-'));
  try {
    assert.equal(run(home, ['keys'], P).status, 0);
    assert.equal(job(home, 'j1', P).status, 0); assert.equal(job(home, 'j2', P).status, 0);
    assert.equal(job(home, 'k1', { ...P, ACG_MEMBER: 'bo' }).status, 0);
    const out = join(home, 'p.json');
    const none = run(home, ['portfolio', '--member', 'ana', '--include', 'j1', '--out', out]);
    assert.equal(none.status, 1); assert.match(none.stderr, /the judge key is sealed/); assert.ok(!existsSync(out), 'nothing written');
    assert.match(run(home, ['portfolio', '--member', 'ana', '--out', out], P).stderr, /needs --include/);
    assert.match(run(home, ['portfolio', '--include', 'all', '--out', out], { ...P, ACG_MEMBER: '' }).stderr, /needs --member/);
    const b = run(home, ['portfolio', '--member', 'ana', '--include', 'j1,k1', '--reveal', 'j1', '--out', out], P);
    assert.equal(b.status, 0, b.stderr); assert.equal(b.stdout.trim(), out + ' · 1 job(s), 1 revealed');
    const p = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(p.entries.map((e) => [e.attested.payload.job_id, e.bundle !== undefined]), [['j1', true]], 'only the job named, and only of this member');
    const c = run(home, ['check-portfolio', out]);
    assert.equal(c.status, 0); assert.equal(c.stdout.trim(), 'the portfolio checks: 1 job(s), 1 revealed');
    const bad = structuredClone(p); bad.entries[0].attested.payload.outcomes.P8 = 'pass'; writeFileSync(join(home, 'bad.json'), JSON.stringify(bad));
    const t = run(home, ['check-portfolio', join(home, 'bad.json')]);
    assert.equal(t.status, 2); assert.equal(t.stdout.trim(), 'REFUSED:\n  entry 0 (j1): the attestation: the signature does not verify');
    assert.equal(run(home, ['check-portfolio', out, '--trust', join(home, 'nowhere.json')]).status, 2, 'no trust list, nothing trusted');
    const all = run(home, ['portfolio', '--include', 'all'], P), allFile = join(home, 'portfolio-ana.json');
    assert.equal(all.status, 0, all.stderr); assert.equal(all.stdout.trim(), allFile + ' · 2 job(s), 0 revealed');
    assert.deepEqual(JSON.parse(readFileSync(allFile, 'utf8')).entries.map((e) => e.attested.payload.job_id), ['j1', 'j2']);
    assert.equal(run(home, ['check-portfolio', allFile]).status, 0);
    writeFileSync(join(home, 'jobs', 'j2', 'bundle.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(home, 'jobs', 'j2', 'bundle.json'), 'utf8')), log: [] }));
    const cut = run(home, ['portfolio', '--include', 'all', '--out', out], P);
    assert.equal(cut.status, 0); assert.match(cut.stdout, /· 1 job\(s\), 0 revealed\nnot in it, refused: j2 \(log: it does not end where the recorder signed/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
