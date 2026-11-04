// test/keys-cli.test.mjs — organ 4 from the command line, end to end in a temporary folder: with a passphrase, keys are
// sealed and no plain seed is written anywhere; signing needs the passphrase; plain keys made earlier can be sealed with
// the same public keys; a revoked key's bundles are refused saying so; rotation trusts the new key and cuts off the old.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSeed } from '../src/keystore.mjs';
import { signerFromSeed } from '../src/sign.mjs';

const BIN = new URL('../bin/acg.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const run = (home, argv, env = {}, input = '') => spawnSync(process.execPath, [BIN, ...argv], { env: { ...process.env, ACG_HOME: home, ACG_PASSPHRASE: '', ...env }, input, encoding: 'utf8' });
const P = { ACG_PASSPHRASE: 'a long test passphrase' };
const ROLES = ['recorder', 'judge', 'reviewer'];
const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const trustOf = (home) => JSON.parse(readFileSync(join(home, 'keys', 'trust.json'), 'utf8'));
function job(home, id, env = {}) {
  run(home, ['seal', '--goal', 'read a note', '--allowed', 'Read'], env);
  run(home, ['hook'], env, JSON.stringify({ session_id: id, hook_event_name: 'UserPromptSubmit' }));
  run(home, ['hook'], env, JSON.stringify({ session_id: id, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }));
  return join(home, 'jobs', id, 'bundle.json');
}

test('with a passphrase: sealed keys, no plain seed anywhere, and signing only with the passphrase', async () => {
  const home = mkdtempSync(join(tmpdir(), 'acg-keys-'));
  try {
    const made = run(home, ['keys'], P);
    assert.equal(made.status, 0, made.stderr); assert.match(made.stdout, /sealed under your passphrase/);
    assert.deepEqual(readdirSync(join(home, 'keys')).sort(), ['judge.key.json', 'recorder.key.json', 'reviewer.key.json', 'trust.json']);
    const seeds = [];
    for (const r of ROLES) {
      const s = JSON.parse(readFileSync(join(home, 'keys', r + '.key.json'), 'utf8'));
      assert.equal(s.role, r); assert.equal(s.kdf.iterations, 600000);
      const o = await openSeed(s, P.ACG_PASSPHRASE); assert.equal(o.ok, true); seeds.push(o.seed);
      assert.equal((await signerFromSeed(o.seed)).publicHex, trustOf(home)[r + 's'][0]);
    }
    const p = job(home, 'j1', P), b = run(home, ['bundle'], P);
    assert.equal(b.status, 0, b.stderr); assert.equal(b.stdout.trim(), p);
    assert.equal(run(home, ['verify-bundle', p]).stdout.trim(), 'the bundle verifies');
    for (const f of files(home)) {
      const text = readFileSync(f, 'latin1');
      for (const seed of seeds) for (const form of [Buffer.from(seed).toString('hex'), Buffer.from(seed).toString('base64'), Buffer.from(seed).toString('base64url'), Buffer.from(seed).toString('latin1')]) assert.ok(!text.includes(form), 'a seed form in ' + f);
    }
    assert.equal(run(home, ['keys'], P).status, 0); assert.deepEqual(trustOf(home).recorders.length, 1, 'keys again keeps the same keys');
    rmSync(p);
    const wrong = run(home, ['bundle'], { ACG_PASSPHRASE: 'not the passphrase' });
    assert.equal(wrong.status, 1); assert.match(wrong.stderr, /the recorder key: the passphrase does not open this key/); assert.ok(!existsSync(p), 'no bundle written');
    const none = run(home, ['bundle']);
    assert.equal(none.status, 1); assert.match(none.stderr, /the recorder key is sealed: give its passphrase/); assert.ok(!existsSync(p));
    assert.equal(run(home, ['keys']).status, 1, 'keys cannot read sealed keys without the passphrase');
    const named = run(home, ['bundle', '--passphrase-env', 'MY_PASS'], { MY_PASS: P.ACG_PASSPHRASE });
    assert.equal(named.status, 0, named.stderr); assert.ok(existsSync(p), 'the passphrase from a named variable');
    assert.match(run(home, ['review', '--check', 'P4', '--decision', 'upheld', '--note', 'x']).stderr, /the reviewer key is sealed/);
    assert.match(run(home, ['review', '--check', 'P4', '--decision', 'upheld', '--note', 'x'], P).stdout, /reviewed P4: upheld/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('acg keys --seal: plain seeds made earlier, sealed with the same public keys, and gone', async () => {
  const home = mkdtempSync(join(tmpdir(), 'acg-keys-'));
  try {
    assert.match(run(home, ['keys']).stdout, /private: never share them; set ACG_PASSPHRASE and run acg keys --seal/);
    const before = trustOf(home);
    assert.ok(ROLES.every((r) => existsSync(join(home, 'keys', r + '.seed'))));
    const nopass = run(home, ['keys', '--seal']); assert.equal(nopass.status, 1); assert.match(nopass.stderr, /--seal needs the passphrase/);
    assert.match(run(home, ['keys'], P).stdout, /private: never share them\)/, 'a passphrase alone does not touch plain keys');
    const sealed = run(home, ['keys', '--seal'], P);
    assert.equal(sealed.status, 0, sealed.stderr); assert.match(sealed.stdout, /sealed under your passphrase/);
    assert.deepEqual(readdirSync(join(home, 'keys')).sort(), ['judge.key.json', 'recorder.key.json', 'reviewer.key.json', 'trust.json']);
    assert.deepEqual(trustOf(home), { ...before, revoked: [] }, 'the same public keys');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('revoke and rotate: the old key’s bundles refused saying why, the new key’s verified', () => {
  const home = mkdtempSync(join(tmpdir(), 'acg-keys-'));
  try {
    run(home, ['keys']);
    const old = trustOf(home), p1 = job(home, 'j1');
    assert.equal(run(home, ['bundle']).status, 0);
    const kept = join(home, 'old-bundle.json'); copyFileSync(p1, kept);
    const rot = run(home, ['rotate', '--role', 'recorder']);
    assert.equal(rot.status, 0, rot.stderr); assert.match(rot.stdout, /rotated the recorder key/);
    const t = trustOf(home);
    assert.notEqual(t.recorders[0], old.recorders[0]); assert.equal(t.recorders.length, 1);
    assert.equal(t.revoked[0].key, old.recorders[0]); assert.equal(t.revoked[0].reason, 'rotated');
    const refused = run(home, ['verify-bundle', kept]);
    assert.equal(refused.status, 2); assert.match(refused.stdout, /recorder: signed by a revoked key \(rotated, 20/);
    assert.equal(run(home, ['bundle']).status, 0);
    assert.equal(run(home, ['verify-bundle', p1]).stdout.trim(), 'the bundle verifies', 'signed again with the new key');
    const rev = run(home, ['revoke', '--key', old.judges[0], '--reason', 'stolen laptop']);
    assert.equal(rev.status, 0, rev.stderr); assert.match(rev.stdout, /every bundle it signed is refused/);
    assert.match(run(home, ['verify-bundle', p1]).stdout, /judge: signed by a revoked key \(stolen laptop, 20/);
    assert.match(run(home, ['keys']).stdout, /judge [0-9a-f]{16}… \(REVOKED: run acg rotate --role judge\)/);
    assert.equal(trustOf(home).revoked.length, 2, 'keys keeps the revocations');
    assert.equal(run(home, ['revoke', '--key', 'ab', '--reason', 'x']).status, 1);
    assert.equal(run(home, ['revoke', '--key', old.judges[0]]).status, 1, 'a revocation needs a reason');
    assert.equal(run(home, ['rotate', '--role', 'boss']).status, 1);
    const empty = mkdtempSync(join(tmpdir(), 'acg-keys-'));
    try { assert.match(run(empty, ['rotate', '--role', 'judge']).stderr, /no judge key to rotate/); } finally { rmSync(empty, { recursive: true, force: true }); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
