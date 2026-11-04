// test/reviewcase.test.mjs — the brochure's cost case: every external figure from the vendored, sourced basis (byte for
// byte the estate's), floors not top ends, the cloud judge like for like, inputs the reader's own, never a throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import cases, { DEFAULTS, BASIS_KEYS, sourcesOf, over, reviewCase } from '../src/reviewcase.mjs';

const RAW = readFileSync(new URL('../data/basis.json', import.meta.url));
const BASIS = JSON.parse(RAW.toString('utf8'));
const base = (patch) => ({ ...BASIS, ...patch });

test('the basis is the estate’s, byte for byte, and every figure the case reads is in it with its source', () => {
  assert.equal(createHash('sha256').update(RAW).digest('hex'), '83e9c2effa2f81596dcfa7110f030940032c1910cdf928d27d628ae59d73bb42');
  assert.deepEqual([...BASIS_KEYS], ['wageMedianHourly', 'cpi', 'frontier', 'fxGbpPerUsd', 'electricityPencePerKwh', 'laptopExtraWatts', 'hoursPerYear']);
  const s = sourcesOf(BASIS);
  assert.deepEqual(s.map((x) => x.key), [...BASIS_KEYS]);
  for (const x of s.filter((x) => x.key !== 'hoursPerYear')) assert.match(x.source, /^https:\/\//, x.key);
  assert.equal(s.find((x) => x.key === 'hoursPerYear').source, null, 'a definition, not a sourced price');
  assert.equal(s.find((x) => x.key === 'frontier').what, 'Claude Sonnet 5 (API)', 'a product named where there is no "what"');
  assert.match(s.find((x) => x.key === 'wageMedianHourly').what, /^ONS ASHE 2025/);
  assert.deepEqual(sourcesOf(null), []); assert.deepEqual(sourcesOf({}), []);
  assert.equal(cases.reviewCase, reviewCase); assert.equal(cases.over, over); assert.equal(cases.sourcesOf, sourcesOf);
  assert.equal(cases.DEFAULTS, DEFAULTS); assert.equal(cases.BASIS_KEYS, BASIS_KEYS);
});

test('the default case, every line from the basis', () => {
  const r = reviewCase(BASIS, {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.inputs, DEFAULTS);
  assert.deepEqual({ ...DEFAULTS }, { jobsPerWeek: 25, minutesPerJob: 30, share: 0.5, tokensIn: 50000, tokensOut: 2000, years: 3 });
  assert.deepEqual(r.lines, { jobs: 1300, perJob: 9.84, staff: 12785.5, takenOff: 6392.75, cloud: 117.62, power: 32.21 });
  assert.deepEqual(r.perYear, { today: 12785.5, cloudJudge: 6510.37, own: 6424.96 });
  assert.deepEqual(r.over, { today: 39557.84, cloudJudge: 20142.83, own: 19878.58 });
  assert.deepEqual([r.savingPerYear, r.savingOver, r.versusCloudOver], [6360.54, 19679.26, 264.25]);
  assert.deepEqual(reviewCase(BASIS, null), r); assert.deepEqual(reviewCase(BASIS), r);
});

test('the reader’s own inputs, and like for like: the cloud judge and this take the same share off', () => {
  const r = reviewCase(BASIS, { jobsPerWeek: 10, minutesPerJob: 45, share: 0.25, tokensIn: 80000, tokensOut: 4000, years: 5 });
  assert.deepEqual(r.lines, { jobs: 520, perJob: 14.75, staff: 7671.3, takenOff: 1917.83, cloud: 78.41, power: 32.21 });
  assert.deepEqual(r.perYear, { today: 7671.3, cloudJudge: 5831.88, own: 5785.68 });
  assert.deepEqual(r.over, { today: 40809.47, cloudJudge: 31024.2, own: 30778.43 });
  assert.deepEqual([r.savingPerYear, r.savingOver, r.versusCloudOver], [1885.62, 10031.04, 245.77]);
  assert.equal(r.perYear.cloudJudge, Math.round((r.lines.staff - r.lines.takenOff + r.lines.cloud) * 100) / 100);
  assert.equal(r.perYear.own, Math.round((r.lines.staff - r.lines.takenOff + r.lines.power) * 100) / 100);
  const none = reviewCase(BASIS, { share: 0 });
  assert.equal(none.perYear.own, Math.round((none.lines.staff + none.lines.power) * 100) / 100, 'nothing taken off: the run cost is added, never hidden');
  assert.equal(reviewCase(BASIS, { share: 1 }).perYear.own, reviewCase(BASIS, { share: 1 }).lines.power);
});

test('the figures move with the basis, not with anything typed', () => {
  assert.equal(reviewCase(base({ wageMedianHourly: { ...BASIS.wageMedianHourly, value: 30 } }), {}).lines.staff, 1300 * 30 / 60 * 30);
  assert.equal(reviewCase(base({ electricityPencePerKwh: { ...BASIS.electricityPencePerKwh, value: 10 } }), {}).lines.power, Math.round(15 * 8760 / 1000 * 10 / 100 * 100) / 100);
  assert.equal(reviewCase(base({ laptopExtraWatts: { ...BASIS.laptopExtraWatts, value: 30 } }), {}).lines.power, Math.round(30 * 8760 / 1000 * 24.51 / 100 * 100) / 100);
  assert.equal(reviewCase(base({ hoursPerYear: { value: 1000 } }), {}).lines.power, Math.round(15 * 1000 / 1000 * 24.51 / 100 * 100) / 100);
  assert.equal(reviewCase(base({ fxGbpPerUsd: { ...BASIS.fxGbpPerUsd, value: 1 } }), {}).lines.cloud, 1300 * (50000 * 2 + 2000 * 10) / 1e6);
  assert.equal(reviewCase(base({ frontier: { ...BASIS.frontier, inPerM: 0 } }), {}).lines.cloud, Math.round(1300 * (2000 * 10) / 1e6 * 0.75396 * 100) / 100);
  assert.equal(reviewCase(base({ frontier: { ...BASIS.frontier, outPerM: 0 } }), {}).lines.cloud, Math.round(1300 * (50000 * 2) / 1e6 * 0.75396 * 100) / 100);
  assert.equal(reviewCase(base({ cpi: { ...BASIS.cpi, value: 0 } }), {}).over.today, 12785.5 * 3);
});

test('over(): the first year as it is, each later year up by CPI', () => {
  assert.equal(over(100, 0.1, 3), 331);
  assert.equal(over(100, 0.1, 1), 100);
  assert.equal(over(100, 0, 4), 400);
  assert.equal(over(0, 0.5, 5), 0);
  assert.equal(over(100, 0.1, 0), 0);
  assert.equal(over(1, 0.001, 2), 2);
});

test('boundaries hold at both ends of every input, and the reason is given', () => {
  for (const ok of [{ jobsPerWeek: 0 }, { jobsPerWeek: 100000 }, { minutesPerJob: 0 }, { minutesPerJob: 600 }, { share: 0 }, { share: 1 }, { years: 1 }, { years: 10 }, { tokensIn: 0, tokensOut: 0 }])
    assert.equal(reviewCase(BASIS, ok).ok, true, JSON.stringify(ok));
  const why = (i) => reviewCase(BASIS, i).why;
  for (const v of [-1, 100000.5, NaN, Infinity, '5', null]) assert.equal(why({ jobsPerWeek: v }), 'jobs a week: 0 to 100,000', String(v));
  for (const v of [-1, 600.5, NaN, '30']) assert.equal(why({ minutesPerJob: v }), 'minutes a job: 0 to 600', String(v));
  for (const v of [-0.1, 1.01, NaN, '0.5']) assert.equal(why({ share: v }), 'the share of the reviewer’s time taken off: 0 to 1', String(v));
  for (const t of [{ tokensIn: -1 }, { tokensOut: -1 }, { tokensIn: 'x' }, { tokensOut: Infinity }]) assert.equal(why(t), 'tokens: numbers', JSON.stringify(t));
  for (const v of [0, 11, 1.5, '3', -2]) assert.equal(why({ years: v }), 'years: 1 to 10', String(v));
});

test('a basis missing a figure, or garbage anywhere, is answered, never thrown', () => {
  const no = 'a sourced basis with every figure the case reads';
  for (const b of [null, undefined, {}, 'x', 7, []]) assert.deepEqual(reviewCase(b, {}), { ok: false, why: no }, String(b));
  for (const k of BASIS_KEYS) { const b = { ...BASIS }; delete b[k]; assert.deepEqual(reviewCase(b, {}), { ok: false, why: no }, k); }
  assert.deepEqual(reviewCase(base({ wageMedianHourly: { value: '19.67' } }), {}), { ok: false, why: no });
  assert.deepEqual(reviewCase(base({ cpi: { value: -0.01 } }), {}), { ok: false, why: no });
  assert.deepEqual(reviewCase(base({ frontier: { inPerM: 2 } }), {}), { ok: false, why: no });
  const toxic = { get jobsPerWeek() { throw new Error('toxic'); } };
  assert.deepEqual(reviewCase(BASIS, toxic), { ok: false, why: 'the inputs could not be read' });
  const toxicBasis = { ...BASIS, get cpi() { throw new Error('toxic'); } };
  assert.deepEqual(reviewCase(toxicBasis, {}), { ok: false, why: 'the inputs could not be read' });
  assert.deepEqual(sourcesOf(toxicBasis), []);
  for (const g of [() => {}, 10n, Symbol('s'), [1, 2]]) assert.equal(typeof reviewCase(BASIS, g).ok, 'boolean');
});
