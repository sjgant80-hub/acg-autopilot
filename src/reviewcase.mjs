// src/reviewcase.mjs — the cost case for a team that reviews its agents' work, for the "For a business" brochure on the
// page. What reviewing how each agent job was done costs today in a reviewer's time; what a cloud model reading every
// job's transcript (an LLM judge) would add; and what this costs to run on a machine the team already has. Every
// external figure is read from the vendored, sourced basis (data/basis.json, byte for byte the estate's basis); the jobs,
// the minutes, the share and the transcript sizes are the reader's own. Floors, never top ends: a reviewer's time at the
// UK median wage with on-costs left out; CPI applied to every later year. Like for like: the cloud judge takes the SAME
// share of the reviewer's time off as this does, so the two differ only in the per-token bill (and in where the
// transcripts go). The share is not measured yet (the pilot on real jobs measures it), so it is the reader's input.
// No price of ours appears here: these are the buyer's own costs. Pure, total, deterministic: garbage in gives
// { ok: false, why }, never a throw.

export const DEFAULTS = Object.freeze({ jobsPerWeek: 25, minutesPerJob: 30, share: 0.5, tokensIn: 50000, tokensOut: 2000, years: 3 });
export const BASIS_KEYS = Object.freeze(['wageMedianHourly', 'cpi', 'frontier', 'fxGbpPerUsd', 'electricityPencePerKwh', 'laptopExtraWatts', 'hoursPerYear']);

const isNum = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const r2 = (x) => Math.round(x * 100) / 100;

/** the basis entries the case reads, each a sourced number; null when one is missing or unreadable */
function figures(basis) {
  const b = basis || {}, f = (k) => b[k] || {};
  const out = {
    wage: f('wageMedianHourly').value, cpi: f('cpi').value, apiIn: f('frontier').inPerM, apiOut: f('frontier').outPerM, fx: f('fxGbpPerUsd').value,
    pence: f('electricityPencePerKwh').value, watts: f('laptopExtraWatts').value, hours: f('hoursPerYear').value,
  };
  return Object.values(out).every(isNum) ? out : null;
}

/** where each figure came from, for the page to list beside the numbers */
export function sourcesOf(basis) {
  try { return BASIS_KEYS.map((k) => ({ key: k, what: basis[k].what || basis[k].product, source: basis[k].source || null })); } catch { return []; }
}

/** a yearly cost carried over `years`, rising by CPI each year after the first */
export function over(perYear, cpi, years) {
  let total = 0, factor = 1;
  for (let y = 0; y < years; y++) { total += perYear * factor; factor *= 1 + cpi; }
  return r2(total);
}

/** the case. input (all optional, defaults above): jobsPerWeek, minutesPerJob, share (0 to 1), tokensIn, tokensOut, years */
export function reviewCase(basis, input) {
  try {
    const f = figures(basis);
    if (!f) return { ok: false, why: 'a sourced basis with every figure the case reads' };
    const i = { ...DEFAULTS, ...(input || {}) };
    if (!isNum(i.jobsPerWeek) || i.jobsPerWeek > 100000) return { ok: false, why: 'jobs a week: 0 to 100,000' };
    if (!isNum(i.minutesPerJob) || i.minutesPerJob > 600) return { ok: false, why: 'minutes a job: 0 to 600' };
    if (!isNum(i.share) || i.share > 1) return { ok: false, why: 'the share of the reviewer’s time taken off: 0 to 1' };
    if (!isNum(i.tokensIn) || !isNum(i.tokensOut)) return { ok: false, why: 'tokens: numbers' };
    if (!Number.isInteger(i.years) || i.years < 1 || i.years > 10) return { ok: false, why: 'years: 1 to 10' };
    const jobs = i.jobsPerWeek * 52;
    const staff = r2(jobs * i.minutesPerJob / 60 * f.wage);                                       // reviewing how each job was done, a year
    const takenOff = r2(staff * i.share);                                                         // the share the record and the judge take off
    const cloud = r2(jobs * (i.tokensIn * f.apiIn + i.tokensOut * f.apiOut) / 1e6 * f.fx);        // a cloud model reading every transcript
    const power = r2(f.watts * f.hours / 1000 * f.pence / 100);                                   // an upper bound: as if it drew power all year
    const perYear = { today: staff, cloudJudge: r2(staff - takenOff + cloud), own: r2(staff - takenOff + power) };
    const total = Object.fromEntries(Object.entries(perYear).map(([k, v]) => [k, over(v, f.cpi, i.years)]));
    return {
      ok: true, inputs: i, lines: { jobs, perJob: r2(i.minutesPerJob / 60 * f.wage), staff, takenOff, cloud, power }, perYear, over: total,
      savingPerYear: r2(perYear.today - perYear.own), savingOver: r2(total.today - total.own), versusCloudOver: r2(total.cloudJudge - total.own),
    };
  } catch { return { ok: false, why: 'the inputs could not be read' }; }
}

export default { DEFAULTS, BASIS_KEYS, sourcesOf, over, reviewCase };
