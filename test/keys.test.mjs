// test/keys.test.mjs — organ 4: a sealed key holds no seed and opens only with its passphrase, from an unchanged file;
// a trust list can revoke a key, and a bundle a revoked key signed is refused saying so; rotation cuts the old key off.
// Garbage is answered, never thrown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KIND, ITERATIONS, LIMITS, strengthOk, sealSeed, openSeed } from '../src/keystore.mjs';
import { ROLES, revokedOf, effective, revoke, rotate, verifyTrusted } from '../src/trust.mjs';
import { signerFromSeed } from '../src/sign.mjs';
import { makeBundle } from '../src/bundle.mjs';
import { link, GENESIS, eventsOf } from '../src/log.mjs';
import { toRecord } from '../src/normalise.mjs';
import { factsOf, sha256hex } from '../src/record.mjs';
import { assessStrict } from '../src/judge.mjs';

const PASS = 'correct horse battery', SEVEN = new Uint8Array(32).fill(7);
// sealed with the code as written (1,000 iterations): a known answer, so a change to the stretch, the cipher or what is
// bound in shows even though sealing and opening would still agree with each other
const FIXTURE = { kind: 'acg-autopilot.sealed-key/1', role: 'judge', kdf: { name: 'PBKDF2-SHA-256', iterations: 1000, salt: '8261c8c863c68bc5d170d56bf5285d51' }, cipher: { name: 'AES-256-GCM', iv: 'c2b16169bb6183c148d9dd0b' }, sealed: '44043dd0f1b48d258ad70a3f66307f417220925b15752db1205d1a620f3ce1992ada2aa34d517ba145469b598facd809' };
const NOPE = 'the passphrase does not open this key, or the file has been changed';
const flip = (h, i) => h.slice(0, i) + (h[i] === '0' ? '1' : '0') + h.slice(i + 1);

test('the settings: the kind, the default stretch, the limits', () => {
  assert.equal(KIND, 'acg-autopilot.sealed-key/1'); assert.equal(ITERATIONS, 600000);
  assert.deepEqual({ ...LIMITS }, { min: 1000, max: 10000000, passphrase: 8 });
  for (const ok of [1000, 600000, 10000000]) assert.equal(strengthOk(ok), true, String(ok));
  for (const no of [999, 10000001, 1000.5, '1000', null, NaN, -1000]) assert.equal(strengthOk(no), false, String(no));
});

test('a known sealed key opens to its seed with its passphrase, and to nothing else', async () => {
  assert.deepEqual(await openSeed(FIXTURE, PASS), { ok: true, seed: SEVEN });
  assert.deepEqual(await openSeed(FIXTURE, PASS + ' '), { ok: false, why: NOPE });
  assert.deepEqual(await openSeed({ ...FIXTURE, role: 'recorder' }, PASS), { ok: false, why: NOPE }, 'the role is bound in');
  for (const i of [0, 31]) assert.deepEqual(await openSeed({ ...FIXTURE, kdf: { ...FIXTURE.kdf, salt: flip(FIXTURE.kdf.salt, i) } }, PASS), { ok: false, why: NOPE }, 'salt ' + i);
  for (const i of [0, 23]) assert.deepEqual(await openSeed({ ...FIXTURE, cipher: { ...FIXTURE.cipher, iv: flip(FIXTURE.cipher.iv, i) } }, PASS), { ok: false, why: NOPE }, 'nonce ' + i);
  for (const i of [0, 63, 95]) assert.deepEqual(await openSeed({ ...FIXTURE, sealed: flip(FIXTURE.sealed, i) }, PASS), { ok: false, why: NOPE }, 'sealed ' + i);
  assert.deepEqual(await openSeed({ ...FIXTURE, kdf: { ...FIXTURE.kdf, iterations: 1001 } }, PASS), { ok: false, why: NOPE }, 'the stretch is bound in');
  assert.deepEqual(await openSeed({ ...FIXTURE, extra: 1 }, PASS), { ok: true, seed: SEVEN }, 'an extra field binds nothing and breaks nothing');
});

test('sealing: the default stretch, a fresh salt and nonce each time, no seed in the file, and it opens again', async () => {
  const s = await sealSeed(SEVEN, PASS);
  assert.deepEqual(Object.keys(s), ['kind', 'role', 'kdf', 'cipher', 'sealed']);
  assert.equal(s.kind, KIND); assert.equal(s.role, 'key'); assert.equal(s.kdf.iterations, 600000);
  assert.equal(s.kdf.name, 'PBKDF2-SHA-256'); assert.equal(s.cipher.name, 'AES-256-GCM');
  assert.match(s.kdf.salt, /^[0-9a-f]{32}$/); assert.match(s.cipher.iv, /^[0-9a-f]{24}$/); assert.match(s.sealed, /^[0-9a-f]{96}$/);
  assert.deepEqual(await openSeed(s, PASS), { ok: true, seed: SEVEN });
  const t = await sealSeed(SEVEN, PASS, { role: 'recorder', iterations: 1000 });
  assert.equal(t.role, 'recorder'); assert.equal(t.kdf.iterations, 1000);
  assert.notEqual(t.kdf.salt, s.kdf.salt); assert.notEqual(t.cipher.iv, s.cipher.iv); assert.notEqual(t.sealed, s.sealed);
  const text = JSON.stringify(t);
  for (const form of ['07'.repeat(32), Buffer.from(SEVEN).toString('base64'), Buffer.from(SEVEN).toString('base64url'), String.fromCharCode(...SEVEN)]) assert.ok(!text.includes(form));
  assert.deepEqual(await openSeed(t, PASS), { ok: true, seed: SEVEN });
  assert.deepEqual(await openSeed(await sealSeed(SEVEN, 'eight ch', { iterations: 1000, role: 7 }), 'eight ch'), { ok: true, seed: SEVEN }, 'eight characters is enough; a role that is not text reads "key"');
  assert.equal((await sealSeed(SEVEN, PASS, 'x')).kdf.iterations, 600000, 'options that are not an object are ignored');
});

test('sealing refuses what it cannot keep safely', async () => {
  await assert.rejects(sealSeed(new Uint8Array(31), PASS), /a seed is 32 bytes/);
  await assert.rejects(sealSeed([...SEVEN], PASS), /a seed is 32 bytes/);
  await assert.rejects(sealSeed(SEVEN, 'seven c'), /a passphrase of 8 characters or more/);
  await assert.rejects(sealSeed(SEVEN, 12345678), /a passphrase of 8 characters or more/);
  for (const n of [999, 10000001, 1000.5, '1000']) await assert.rejects(sealSeed(SEVEN, PASS, { iterations: n }), /iterations: a whole number from 1000 to 10000000/, String(n));
});

test('opening garbage, a malformed key, an out-of-range stretch or no passphrase: answered, never thrown', async () => {
  const no = { ok: false, why: 'not a sealed key' };
  for (const g of [null, 'x', [], 7, {}, { ...FIXTURE, kind: 'other' }, { ...FIXTURE, role: 1 }, { ...FIXTURE, kdf: null }, { ...FIXTURE, cipher: [] },
    { ...FIXTURE, kdf: { ...FIXTURE.kdf, name: 'scrypt' } }, { ...FIXTURE, cipher: { ...FIXTURE.cipher, name: 'AES-128-GCM' } }]) assert.deepEqual(await openSeed(g, PASS), no, JSON.stringify(g).slice(0, 60));
  assert.deepEqual(await openSeed({ get kind() { throw new Error('toxic'); } }, PASS), { ok: false, why: 'the sealed key could not be read' });
  const bad = { ok: false, why: 'the sealed key is malformed' };
  for (const g of [{ ...FIXTURE, kdf: { ...FIXTURE.kdf, salt: FIXTURE.kdf.salt.slice(2) } }, { ...FIXTURE, kdf: { ...FIXTURE.kdf, salt: 'zz' + FIXTURE.kdf.salt.slice(2) } }, { ...FIXTURE, kdf: { ...FIXTURE.kdf, salt: FIXTURE.kdf.salt.toUpperCase() } },
    { ...FIXTURE, cipher: { ...FIXTURE.cipher, iv: FIXTURE.cipher.iv + '00' } }, { ...FIXTURE, cipher: { ...FIXTURE.cipher, iv: undefined } }, { ...FIXTURE, sealed: FIXTURE.sealed.slice(2) }, { ...FIXTURE, sealed: '' }, { ...FIXTURE, sealed: FIXTURE.sealed + 'a' }])
    assert.deepEqual(await openSeed(g, PASS), bad, JSON.stringify(g).slice(60, 140));
  for (const n of [999, 10000001, '1000', null]) assert.deepEqual(await openSeed({ ...FIXTURE, kdf: { ...FIXTURE.kdf, iterations: n } }, PASS), { ok: false, why: 'the sealed key’s stretch is out of range' }, String(n));
  for (const p of ['', undefined, null, 12345678]) assert.deepEqual(await openSeed(FIXTURE, p), { ok: false, why: 'no passphrase was given' }, String(p));
});

// ── the trust list ───────────────────────────────────────────────────────────────────────────────────────────────
const k = (c) => c.repeat(64);
const [R, J, V, X] = await Promise.all([0x11, 0x22, 0x33, 0x44].map((b) => signerFromSeed(new Uint8Array(32).fill(b))));
const TRUST = { recorders: [R.publicHex], judges: [J.publicHex], reviewers: [V.publicHex] };
const intent = { goal: 'read the file', constraints: [], success_criteria: ['read'], allowed_tools: ['Read'], out_of_scope: [], sealed_at: '2026-10-29T09:00:00.000Z' };
intent.hash = await sha256hex('placeholder');
async function chain(events) { const out = []; let p = GENESIS; for (const e of events) { const l = await link(p, e); out.push(l); p = l.hash; } return out; }
const LOG = await chain([{ kind: 'model_call', at: '2026-10-29T10:00:00.000Z', model: 'm' }, { kind: 'tool_use', at: '2026-10-29T10:00:01.000Z', tool: 'Read' }, { kind: 'question', at: '2026-10-29T10:00:02.000Z', text: 'which' }]);
const RECORD = toRecord({ job_id: 'j1', member_id: 'm', harness: { name: 'claude-code' }, intent, events: eventsOf(LOG) });
const DECIDE = assessStrict(RECORD, await factsOf(RECORD)).review.map((c) => ({ check: c, decision: 'upheld', note: 'seen' }));
const BUNDLE = await makeBundle({ record: RECORD, log: LOG, recorder: R, judge: J, reviewer: V, decisions: DECIDE });
const AT = '2026-11-04T12:00:00.000Z';

test('revokedOf and effective: a revoked key is trusted for nothing, on any list; garbage trusts nothing', () => {
  assert.deepEqual([...ROLES], ['recorders', 'judges', 'reviewers']);
  const t = { recorders: [k('a'), k('b'), 'short', 7], judges: [k('b')], reviewers: k('c'), revoked: [{ key: k('b'), reason: 'lost', at: AT }, { key: k('d') }, { key: 'short' }, null, 'x'] };
  assert.deepEqual([...revokedOf(t)], [[k('b'), { reason: 'lost', at: AT }], [k('d'), { reason: 'no reason given', at: 'no date given' }]]);
  assert.deepEqual(effective(t), { recorders: [k('a')], judges: [], reviewers: [] });
  assert.deepEqual(effective({ recorders: [k('a')], revoked: 'x' }), { recorders: [k('a')], judges: [], reviewers: [] });
  for (const g of [null, 'x', [], 7]) { assert.deepEqual(effective(g), { recorders: [], judges: [], reviewers: [] }); assert.equal(revokedOf(g).size, 0); }
  assert.deepEqual(effective({ get recorders() { throw new Error('toxic'); } }), { recorders: [], judges: [], reviewers: [] });
  assert.equal(revokedOf({ revoked: [{ key: k('e'), reason: 3, at: 4 }] }).get(k('e')).reason, 'no reason given');
});

test('revoke and rotate: a new list each time, the reason and the date kept; bad input refused', () => {
  const t = revoke({ recorders: [k('a'), k('b')], judges: [k('b')], reviewers: [], revoked: [{ key: k('c'), reason: 'old', at: AT }, { key: k('b'), reason: 'first', at: AT }] }, k('b'), '  stolen laptop ', AT);
  assert.deepEqual(t, { recorders: [k('a')], judges: [], reviewers: [], revoked: [{ key: k('c'), reason: 'old', at: AT }, { key: k('b'), reason: 'stolen laptop', at: AT }] });
  assert.deepEqual(revoke(null, k('a'), 'lost', AT), { recorders: [], judges: [], reviewers: [], revoked: [{ key: k('a'), reason: 'lost', at: AT }] });
  assert.deepEqual(revoke({ revoked: 'x' }, k('a'), 'lost', AT).revoked, [{ key: k('a'), reason: 'lost', at: AT }]);
  for (const bad of [[k('A'), 'r', AT], ['ab', 'r', AT], [7, 'r', AT]]) assert.throws(() => revoke({}, ...bad), /a key to revoke is 64 hex characters/);
  for (const bad of [[k('a'), '', AT], [k('a'), '  ', AT], [k('a'), 7, AT], [k('a'), 'r', 'not a date'], [k('a'), 'r', 7]]) assert.throws(() => revoke({}, ...bad), /a revocation needs a reason and a date/);
  const r = rotate({ recorders: [k('a')], judges: [k('8')], reviewers: [] }, 'recorders', k('a'), k('9'), AT);
  assert.deepEqual(r, { recorders: [k('9')], judges: [k('8')], reviewers: [], revoked: [{ key: k('a'), reason: 'rotated', at: AT }] });
  assert.deepEqual(rotate({ judges: [k('9'), k('a')] }, 'judges', k('a'), k('9'), AT).judges, [k('9')], 'the new key once');
  assert.throws(() => rotate({}, 'recorder', k('a'), k('9'), AT), /a role is one of recorders, judges, reviewers/);
  for (const n of [k('a'), 'ab', null]) assert.throws(() => rotate({}, 'judges', k('a'), n, AT), /a new key, 64 hex characters, not the old one/);
});

test('verifyTrusted: nothing revoked verifies; a revoked recorder, judge or reviewer is refused, saying so', async () => {
  assert.deepEqual(await verifyTrusted(BUNDLE, TRUST), { ok: true, problems: [] });
  assert.deepEqual(await verifyTrusted(BUNDLE, { ...TRUST, revoked: [{ key: X.publicHex, reason: 'unused', at: AT }] }), { ok: true, problems: [] }, 'an unrelated revocation changes nothing');
  assert.deepEqual(await verifyTrusted(BUNDLE, revoke(TRUST, R.publicHex, 'lost', AT)), { ok: false, problems: ['recorder: signed by a revoked key (lost, ' + AT + ')'] });
  assert.deepEqual(await verifyTrusted(BUNDLE, { ...TRUST, revoked: [{ key: J.publicHex, reason: 'stolen', at: AT }] }), { ok: false, problems: ['judge: signed by a revoked key (stolen, ' + AT + ')', 'reviewer: a decision is not on a flagged check, or is not upheld or overturned with a note'] });
  assert.deepEqual(await verifyTrusted(BUNDLE, revoke(TRUST, V.publicHex, 'left', AT)), { ok: false, problems: ['reviewer: signed by a revoked key (left, ' + AT + ')'] });
  assert.deepEqual(await verifyTrusted(BUNDLE, { recorders: [], judges: [J.publicHex], reviewers: [V.publicHex] }), { ok: false, problems: ['recorder: signed by a key not on the trust list'] }, 'not trusted is not the same as revoked');
  const moved = { ...BUNDLE, record: { ...RECORD, job_id: 'j2' } };
  assert.ok((await verifyTrusted(moved, revoke(TRUST, X.publicHex, 'x', AT))).problems.includes('recorder: signed a different record'), 'other problems pass through as they are');
  const stray = { ...BUNDLE, reviewed: 'x' };
  assert.deepEqual(await verifyTrusted(stray, revoke(TRUST, V.publicHex, 'left', AT)), { ok: false, problems: ['reviewer: not a reviewed signature'] });
  for (const g of [null, 'x', {}]) assert.deepEqual(await verifyTrusted(g, TRUST), { ok: false, problems: ['not a bundle'] });
  assert.equal((await verifyTrusted(BUNDLE, null)).ok, false);
});
