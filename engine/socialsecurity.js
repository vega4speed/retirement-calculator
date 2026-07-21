// socialsecurity.js — Social Security estimation (design doc §6). Phase 5.
//
// Per the design doc's §13 decision, benefits are estimated FROM EARNINGS, not typed in as a
// statement PIA — so "work N more years" or "retire early" naturally changes the estimate.
//
// v1 simplification (documented, not an oversight): real AIME uses the SSA's National Average
// Wage Index to convert each year's actual nominal earnings into "today's-wage-equivalent"
// dollars (indexing freezes at age 60). Reproducing that needs a verified multi-decade AWI table
// AND the user's exact historical nominal earnings for every year — a lot of research and data
// entry for modest precision gain. Instead, the `earnings` setting IS a wage-indexed-equivalent
// figure from the start (conceptually the same trick as "today's dollars" elsewhere in this app,
// but pegged to WAGE growth rather than CPI inflation — which is actually more methodologically
// faithful to how AIME really works than a CPI-based figure would be). Top-35 years are taken
// directly from `earnings`; years beyond a real 35-year career correctly count as $0 by simply
// not existing in the range. Also not modeled: the annual FICA wage base cap (very high earners'
// PIA will be modestly overstated), and spousal/survivor benefits (single-person v1).
//
// v1 also only models Social Security income starting in the DECUMULATION phase (project.js) —
// if a chosen claiming age would fall before retirementYear, the benefit isn't paid until
// decumulation begins. Real early-claim-while-still-working scenarios aren't modeled.

import { resolve } from './resolver.js';
import { cumulativeFactor } from './tax.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Full Retirement Age by birth year (stable since the 1983 Social Security Amendments),
 * returned in fractional years (e.g. 66 + 2/12 for someone born in 1955).
 * @param {number} birthYear
 * @returns {number}
 */
export function fullRetirementAge(birthYear) {
  if (birthYear <= 1937) return 65;
  if (birthYear <= 1942) return 65 + (birthYear - 1937) * 2 / 12; // 65+2mo .. 65+10mo, 1938-1942
  if (birthYear <= 1954) return 66;
  if (birthYear <= 1959) return 66 + (birthYear - 1954) * 2 / 12; // 66+2mo .. 66+10mo, 1955-1959
  return 67;
}

/** Scales an anchor year's PIA bend points forward/back via a wage-indexing-rate setting —
 * the same cumulativeFactor pattern tax.js's resolveYearTable uses for brackets. */
function resolvePIABendPoints({ tables, year, anchorYear, wageIndexingRate }) {
  const anchor = tables.years[String(anchorYear)];
  if (!anchor?.socialSecurityPIA) throw new Error(`socialsecurity: no socialSecurityPIA table for anchor year ${anchorYear}`);
  const factor = cumulativeFactor(wageIndexingRate ?? { default: 0 }, anchorYear, year);
  return {
    factors: anchor.socialSecurityPIA.factors,
    bendPointsMonthly: {
      first: anchor.socialSecurityPIA.bendPointsMonthly.first * factor,
      second: anchor.socialSecurityPIA.bendPointsMonthly.second * factor,
    },
  };
}

/**
 * Estimate the monthly Primary Insurance Amount (the benefit AT full retirement age, before any
 * claiming-age adjustment) from an earnings history, via the real bend-point formula.
 *
 * AIME = (sum of the top 35 years of `earnings`, careerStartYear..retirementYear inclusive) / 420.
 * Fewer than 35 working years correctly lowers AIME (missing years count as $0 — dividing by 420
 * regardless of how many real years exist is the actual SSA rule, not a bug). The bend points
 * used are those in effect for the year the person turns 62 (the real rule — not the claiming
 * year), scaled from `anchorYear` by `wageIndexingRate`.
 *
 * @param {object} p
 * @param {object} p.earnings         setting (per year), wage-indexed-equivalent annual $
 * @param {number} p.careerStartYear  first year of SS-covered earnings
 * @param {number} p.retirementYear   last year of earnings (inclusive)
 * @param {number} p.birthYear
 * @param {object} p.tables           parsed tax-tables.json
 * @param {number} p.anchorYear
 * @param {object} [p.wageIndexingRate] setting (per year); default 0
 * @returns {number} monthly PIA
 */
export function estimatePIA(p) {
  const { earnings, careerStartYear, retirementYear, birthYear, tables, anchorYear } = p;
  if (!Number.isInteger(careerStartYear) || !Number.isInteger(retirementYear)) {
    throw new Error('estimatePIA: careerStartYear and retirementYear must be integers');
  }
  const years = [];
  for (let y = careerStartYear; y <= retirementYear; y++) years.push(num(resolve(earnings, { year: y })));
  years.sort((a, b) => b - a);
  const top35 = years.slice(0, 35);
  const aime = top35.reduce((s, v) => s + v, 0) / (35 * 12);

  const turn62Year = birthYear + 62;
  const { factors, bendPointsMonthly: b } = resolvePIABendPoints({
    tables, year: turn62Year, anchorYear, wageIndexingRate: p.wageIndexingRate,
  });
  return factors[0] * Math.min(aime, b.first)
    + factors[1] * Math.max(0, Math.min(aime, b.second) - b.first)
    + factors[2] * Math.max(0, aime - b.second);
}

/**
 * Adjust a monthly PIA for the chosen claiming age: the actuarial reduction for claiming before
 * Full Retirement Age, or delayed retirement credits for claiming after (credits stop accruing
 * at 70 — claiming later than that gains nothing further).
 * @param {number} pia               monthly, at FRA
 * @param {number} claimingAge       years (whole-year precision — v1 doesn't model month-level claiming)
 * @param {number} fullRetirementAge years (fractional, from fullRetirementAge())
 * @param {object} ssTables          tax-tables.json's `socialSecurity` block
 * @returns {number} ANNUAL benefit at the chosen claiming age
 */
export function benefitAtClaimingAge(pia, claimingAge, fullRetirementAge, ssTables) {
  const monthsDiff = (claimingAge - fullRetirementAge) * 12;
  let monthly;
  if (monthsDiff < 0) {
    const monthsEarly = -monthsDiff;
    const { perMonthFirst36, perMonthBeyond36 } = ssTables.earlyClaimingReduction;
    const reduction = Math.min(monthsEarly, 36) * perMonthFirst36 + Math.max(0, monthsEarly - 36) * perMonthBeyond36;
    monthly = pia * (1 - reduction);
  } else if (monthsDiff > 0) {
    const yearsLate = Math.min(monthsDiff / 12, 70 - fullRetirementAge);
    monthly = pia * (1 + yearsLate * ssTables.delayedRetirementCreditPerYear);
  } else {
    monthly = pia;
  }
  return monthly * 12;
}
