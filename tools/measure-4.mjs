#!/usr/bin/env node
// tools/measure-4.mjs — organ 4 measured against its seal (claims/organ-4.json). K1-K2 on 50 keys from fresh random
// seeds (5 of them re-sealed at 1,000 iterations for the tamper part, as the seal says); K3-K4 on organ 3's 1,000
// bundles and its demonstration keys; K5 on the command line, end to end in temporary folders. The salts, nonces and
// seeds are random, so the receipt holds counts, which do not depend on them: CI re-derives every one.
//   node tools/measure-4.mjs          → receipts/organ-4.json
//   node tools/measure-4.mjs --check  → re-derive; refuse unless the facts and verdicts are the receipt's
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealSeed, openSeed, ITERATIONS } from '../src/keystore.mjs';
import { revoke, rotate, verifyTrusted } from '../src/trust.mjs';
import { signerFromSeed } from '../src/sign.mjs';
import { makeBundle } from '../src/bundle.mjs';
import { link, GENESIS, eventsOf } from '../src/log.mjs';
import { toRecord } from '../src/normalise.mjs';
import { assessStrict } from '../src/judge.mjs';
import { factsOf, sha256hex } from '../src/record.mjs';
import { cleanJob, plantedJob, KINDS } from './suite.mjs';

const ROOT = new URL('../', import.meta.url);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const path = 'claims/organ-4.json', text = readFileSync(new URL(path, ROOT), 'utf8');
const commit = git('log', '-1', '--format=%H', '--', path).trim();
if (!commit || git('show', commit + ':' + path) !== text) { console.log(path + ' differs from the commit that sealed it — refusing to measure'); process.exit(1); }
const claims = JSON.parse(text), CHECK = process.argv.includes('--check');
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const hexOf = (u8) => Buffer.from(u8).toString('hex');
const PKCS8 = '302e020100300506032b657004220420';
const formsOf = (seed) => [Buffer.from(seed).toString('latin1'), hexOf(seed), Buffer.from(seed).toString('base64'), Buffer.from(seed).toString('base64url'), PKCS8 + hexOf(seed), Buffer.from(PKCS8 + hexOf(seed), 'hex').toString('base64')];
const refused = async (s, pass) => { try { return !(await openSeed(s, pass)).ok; } catch { throws++; return false; } };
let throws = 0;

// ── K1, K2: sealed keys ─────────────────────────────────────────────────────────────────────────────────────────────
const k1 = { keys: 50, iterations: ITERATIONS, formsChecked: 0, hits: 0, atDefault: 0 }, k2 = { opened: 0, wrongTried: 0, wrongRefused: 0, resealedOpened: 0, tamperTried: 0, tamperRefused: 0, threw: 0 };
const keys = [];
for (let i = 0; i < k1.keys; i++) {
  const seed = rand(32), pass = hexOf(rand(12)), s = await sealSeed(seed, pass, { role: 'key-' + i }), file = JSON.stringify(s);
  for (const f of formsOf(seed)) { k1.formsChecked++; if (file.includes(f)) k1.hits++; }
  if (s.kdf.iterations >= 600000 && ITERATIONS === 600000) k1.atDefault++;
  keys.push({ seed, pass, s });
}
for (const { seed, pass, s } of keys) {
  const o = await openSeed(s, pass);
  if (o.ok && (await signerFromSeed(o.seed)).publicHex === (await signerFromSeed(seed)).publicHex) k2.opened++;
  for (let w = 0; w < 3; w++) { k2.wrongTried++; if (await refused(s, pass + ' ' + w)) k2.wrongRefused++; }
}
const flipByte = (h, i) => h.slice(0, 2 * i) + (parseInt(h.slice(2 * i, 2 * i + 2), 16) ^ 1).toString(16).padStart(2, '0') + h.slice(2 * i + 2);
for (const { seed, pass } of keys.slice(0, 5)) {
  const s = await sealSeed(seed, pass, { role: 'tamper', iterations: 1000 });
  const o = await openSeed(s, pass);
  if (o.ok && hexOf(o.seed) === hexOf(seed)) k2.resealedOpened++;
  const tampered = [];
  for (let i = 0; i < 16; i++) tampered.push({ ...s, kdf: { ...s.kdf, salt: flipByte(s.kdf.salt, i) } });
  for (let i = 0; i < 12; i++) tampered.push({ ...s, cipher: { ...s.cipher, iv: flipByte(s.cipher.iv, i) } });
  for (let i = 0; i < 48; i++) tampered.push({ ...s, sealed: flipByte(s.sealed, i) });
  tampered.push({ ...s, kdf: { ...s.kdf, iterations: s.kdf.iterations + 1 } }, { ...s, kdf: { ...s.kdf, iterations: s.kdf.iterations - 1 } }, { ...s, kind: s.kind + 'x' });
  for (const t of tampered) { k2.tamperTried++; if (await refused(t, pass)) k2.tamperRefused++; }
}
k2.threw = throws;

// ── K3, K4: revocation and rotation over organ 3's 1,000 bundles ──────────────────────────────────────────────────
const AT = '2026-11-04T12:00:00.000Z';
const [R, J, V, X, N] = await Promise.all([0x11, 0x22, 0x33, 0x44, 0x55].map((b) => signerFromSeed(new Uint8Array(32).fill(b))));   // public demonstration seeds
const TRUST = { recorders: [R.publicHex], judges: [J.publicHex], reviewers: [V.publicHex] };
async function chain(events) { const out = []; let p = GENESIS; for (const e of events) { const l = await link(p, e); out.push(l); p = l.hash; } return out; }
const eventsOfJob = (job) => [...job.timeline.map(({ seq, ...e }) => e), ...job.artifacts.map((a) => ({ kind: 'artifact', ...a })), ...job.claims.map((c) => ({ kind: 'claim', ...c }))];
async function bundleOf(job, recorder) {
  const log = await chain(eventsOfJob(job)), record = toRecord({ job_id: job.job_id, member_id: job.member_id, harness: job.harness, intent: job.intent, events: eventsOf(log) });
  const decisions = assessStrict(record, await factsOf(record)).review.map((c) => ({ check: c, decision: 'upheld', note: 'seen by the reviewer' }));
  return makeBundle({ record, log, recorder, judge: J, reviewer: V, decisions });
}
const jobs = [];
for (let i = 1; i <= 500; i++) jobs.push(await cleanJob(i));
for (const [k, kind] of KINDS.entries()) for (let i = 0; i < 50; i++) jobs.push((await plantedJob(10000 + k * 1000 + i, kind)).job);
const says = (v, role) => !v.ok && v.problems.some((p) => p.startsWith(role + ': signed by a revoked key ('));
const k3 = { bundles: 0, verified: 0, recorderRevokedRefused: 0, judgeRevokedRefused: 0, withReview: 0, reviewerRevokedRefused: 0, unrelatedVerified: 0 };
const T = { recorder: revoke(TRUST, R.publicHex, 'lost', AT), judge: revoke(TRUST, J.publicHex, 'stolen', AT), reviewer: revoke(TRUST, V.publicHex, 'left', AT), unrelated: revoke(TRUST, X.publicHex, 'unused', AT) };
const k4 = { jobs: 0, newVerified: 0, oldRefused: 0 }, ROTATED = rotate(TRUST, 'recorders', R.publicHex, N.publicHex, AT);
for (const [i, job] of jobs.entries()) {
  const b = await bundleOf(job, R);
  k3.bundles++;
  if ((await verifyTrusted(b, TRUST)).ok) k3.verified++;
  if (says(await verifyTrusted(b, T.recorder), 'recorder')) k3.recorderRevokedRefused++;
  if (says(await verifyTrusted(b, T.judge), 'judge')) k3.judgeRevokedRefused++;
  if (b.reviewed !== undefined) { k3.withReview++; if (says(await verifyTrusted(b, T.reviewer), 'reviewer')) k3.reviewerRevokedRefused++; }
  if ((await verifyTrusted(b, T.unrelated)).ok) k3.unrelatedVerified++;
  if (i < 100) {
    k4.jobs++;
    if ((await verifyTrusted(await bundleOf(job, N), ROTATED)).ok) k4.newVerified++;
    if (says(await verifyTrusted(await bundleOf(job, R), ROTATED), 'recorder')) k4.oldRefused++;
  }
}

// ── K5: the command line, end to end ──────────────────────────────────────────────────────────────────────────────
const BIN = new URL('../bin/acg.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), PASS = 'the measurement passphrase';
const run = (home, argv, env = {}, input = '') => spawnSync(process.execPath, [BIN, ...argv], { env: { ...process.env, ACG_HOME: home, ACG_PASSPHRASE: '', ...env }, input, encoding: 'utf8' });
const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const ROLES = ['recorder', 'judge', 'reviewer'];
const k5 = { plainSeedFiles: 0, seedFormHits: 0, rightBundleVerified: false, wrongRefusedNoBundle: false, missingRefusedNoBundle: false, sealedSamePublic: false, plainLeftAfterSeal: 0 };
{
  const home = mkdtempSync(join(tmpdir(), 'acg-m4-'));
  try {
    run(home, ['keys'], { ACG_PASSPHRASE: PASS });
    const seeds = [];
    for (const r of ROLES) { if (existsSync(join(home, 'keys', r + '.seed'))) k5.plainSeedFiles++; const o = await openSeed(JSON.parse(readFileSync(join(home, 'keys', r + '.key.json'), 'utf8')), PASS); if (o.ok) seeds.push(o.seed); }
    run(home, ['seal', '--goal', 'read a note', '--allowed', 'Read'], { ACG_PASSPHRASE: PASS });
    run(home, ['hook'], {}, JSON.stringify({ session_id: 'm4', hook_event_name: 'UserPromptSubmit' }));
    run(home, ['hook'], {}, JSON.stringify({ session_id: 'm4', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }));
    const p = join(home, 'jobs', 'm4', 'bundle.json');
    const wrong = run(home, ['bundle'], { ACG_PASSPHRASE: 'not the passphrase' });
    k5.wrongRefusedNoBundle = wrong.status === 1 && /does not open this key/.test(wrong.stderr) && !existsSync(p);
    const missing = run(home, ['bundle']);
    k5.missingRefusedNoBundle = missing.status === 1 && /is sealed: give its passphrase/.test(missing.stderr) && !existsSync(p);
    const right = run(home, ['bundle'], { ACG_PASSPHRASE: PASS });
    k5.rightBundleVerified = right.status === 0 && run(home, ['verify-bundle', p]).stdout.trim() === 'the bundle verifies';
    for (const f of files(home)) { const t = readFileSync(f, 'latin1'); for (const s of seeds) for (const form of formsOf(s)) if (t.includes(form)) k5.seedFormHits++; }
    if (seeds.length !== 3) k5.seedFormHits = -1;   // a key that did not open cannot be looked for: that is not a pass
  } finally { rmSync(home, { recursive: true, force: true }); }
  const old = mkdtempSync(join(tmpdir(), 'acg-m4-'));
  try {
    run(old, ['keys']);
    const before = JSON.parse(readFileSync(join(old, 'keys', 'trust.json'), 'utf8'));
    const sealed = run(old, ['keys', '--seal'], { ACG_PASSPHRASE: PASS }), after = JSON.parse(readFileSync(join(old, 'keys', 'trust.json'), 'utf8'));
    k5.sealedSamePublic = sealed.status === 0 && ROLES.every((r) => before[r + 's'][0] === after[r + 's'][0] && after[r + 's'].length === 1 && existsSync(join(old, 'keys', r + '.key.json')));
    k5.plainLeftAfterSeal = ROLES.filter((r) => existsSync(join(old, 'keys', r + '.seed'))).length;
  } finally { rmSync(old, { recursive: true, force: true }); }
}

// ── verdicts ──────────────────────────────────────────────────────────────────────────────────────────────────────
const RULES = {
  K1: () => [k1.hits === 0 && k1.formsChecked === k1.keys * 6 && k1.atDefault === k1.keys, k1.keys + ' keys sealed at the default strength (' + k1.atDefault + ' record 600,000 or more iterations); seed forms looked for: ' + k1.formsChecked + ', found: ' + k1.hits],
  K2: () => [k2.opened === k1.keys && k2.wrongRefused === k2.wrongTried && k2.wrongTried === 150 && k2.resealedOpened === 5 && k2.tamperRefused === k2.tamperTried && k2.tamperTried > 0 && k2.threw === 0,
    k2.opened + ' of ' + k1.keys + ' opened with their passphrase to the same public key; ' + k2.wrongRefused + ' of ' + k2.wrongTried + ' wrong passphrases refused; ' + k2.resealedOpened + ' of 5 re-sealed keys opened, then ' + k2.tamperRefused + ' of ' + k2.tamperTried + ' one-byte, stretch and kind changes refused; threw: ' + k2.threw],
  K3: () => [k3.verified === k3.bundles && k3.recorderRevokedRefused === k3.bundles && k3.judgeRevokedRefused === k3.bundles && k3.reviewerRevokedRefused === k3.withReview && k3.withReview > 0 && k3.unrelatedVerified === k3.bundles,
    'of ' + k3.bundles + ' bundles: ' + k3.verified + ' verified with nothing revoked; refused as revoked: ' + k3.recorderRevokedRefused + ' with the recorder’s key revoked, ' + k3.judgeRevokedRefused + ' with the judge’s, ' + k3.reviewerRevokedRefused + ' of the ' + k3.withReview + ' carrying a review with the reviewer’s; ' + k3.unrelatedVerified + ' verified with an unrelated key revoked'],
  K4: () => [k4.jobs === 100 && k4.newVerified === k4.jobs && k4.oldRefused === k4.jobs, 'after rotating the recorder’s key, of ' + k4.jobs + ' jobs: ' + k4.newVerified + ' signed with the new key verified; ' + k4.oldRefused + ' signed afresh with the old key refused as revoked'],
  K5: () => [k5.plainSeedFiles === 0 && k5.seedFormHits === 0 && k5.rightBundleVerified && k5.wrongRefusedNoBundle && k5.missingRefusedNoBundle && k5.sealedSamePublic && k5.plainLeftAfterSeal === 0,
    'with a passphrase: plain seed files ' + k5.plainSeedFiles + ', seed forms anywhere under the folder ' + k5.seedFormHits + '; the right passphrase signed a bundle that verifies: ' + (k5.rightBundleVerified ? 'yes' : 'no') + '; a wrong one refused with no bundle: ' + (k5.wrongRefusedNoBundle ? 'yes' : 'no') + '; none refused with no bundle: ' + (k5.missingRefusedNoBundle ? 'yes' : 'no') + '; --seal kept the public keys: ' + (k5.sealedSamePublic ? 'yes' : 'no') + ', plain seeds left: ' + k5.plainLeftAfterSeal],
};
const verdicts = claims.claims.map((c) => { const [held, measured] = RULES[c.id](); return { id: c.id, kind: c.kind, claim: c.claim, held, measured }; });
const facts = { K1: k1, K2: k2, K3: k3, K4: k4, K5: k5 };
const receipt = { kind: 'acg-autopilot.receipt', organ: 4, v: 1, sealed: { path, commit, claimsSha256: await sha256hex(text) }, demoSeeds: 'K3 and K4 use public demonstration keys, never real ones; K1 and K2 use fresh random seeds, never written down', facts, verdicts, held: verdicts.filter((v) => v.held).length, failed: verdicts.filter((v) => !v.held).length };
if (CHECK) {
  const was = JSON.parse(readFileSync(new URL('receipts/organ-4.json', ROOT), 'utf8'));
  const pick = (r) => JSON.stringify({ sealed: r.sealed, facts: r.facts, verdicts: r.verdicts.map((v) => [v.id, v.held, v.measured]) });
  const same = pick(was) === pick(receipt);
  console.log(same ? 'ORGAN 4 REPRODUCED · ' + receipt.held + ' held, ' + receipt.failed + ' failed, as the receipt says' : 'ORGAN 4 DRIFT · the facts or verdicts differ from the receipt');
  if (!same) console.log(JSON.stringify({ facts, verdicts: verdicts.map((v) => [v.id, v.held]) }));
  process.exit(same ? 0 : 1);
}
writeFileSync(new URL('receipts/organ-4.json', ROOT), JSON.stringify(receipt, null, 1) + '\n');
for (const v of verdicts) console.log((v.held ? 'HELD   ' : 'FAILED ') + v.id + ' · ' + v.measured);
console.log('wrote receipts/organ-4.json · ' + receipt.held + ' held, ' + receipt.failed + ' failed');
