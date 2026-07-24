// contribution-waterfall.test.js — golden-number tests for the "investment order" waterfall
// (Phase 6.7): one overall take-home budget, filled in priority order across Traditional-up-to-
// the-match, HSA-max, Roth-IRA-limit, then back-to-Traditional, each account's own IRS limit
// respected along the way. Opt-in on `contributionWaterfallEnabled`; omit it and accumulation is
// exactly the existing per-account contribution behavior, unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { projectAccumulation } from '../engine/project.js';
import { iraContributionLimit, electiveDeferralLimit, rothIraPhaseOutFactor } from '../engine/tax.js';

const approx = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} (Δ=${Math.abs(a - b)})`);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const taxTables = JSON.parse(readFileSync(join(root, 'data/tax-tables.json'), 'utf8'));
const row = (r, year) => r.years.find((y) => y.year === year);

test('IRS limit helpers: verified 2026 base figures, no catch-up under 50', () => {
  const yearTable = { iraLimit: taxTables.years['2026'].iraLimits, electiveDeferralLimit: taxTables.years['2026'].electiveDeferralLimit };
  assert.equal(iraContributionLimit(40, yearTable), 7500);
  assert.equal(electiveDeferralLimit(40, yearTable), 24500);
});

test('IRS limit helpers: 50+ catch-up, and the 60-63 enhanced catch-up REPLACES (not stacks on) the standard one', () => {
  const yearTable = { iraLimit: taxTables.years['2026'].iraLimits, electiveDeferralLimit: taxTables.years['2026'].electiveDeferralLimit };
  assert.equal(iraContributionLimit(50, yearTable), 7500 + 1100);
  assert.equal(electiveDeferralLimit(55, yearTable), 24500 + 8000);
  assert.equal(electiveDeferralLimit(60, yearTable), 24500 + 11250);
  assert.equal(electiveDeferralLimit(63, yearTable), 24500 + 11250);
  assert.equal(electiveDeferralLimit(64, yearTable), 24500 + 8000); // back to the standard catch-up past 63
});

test('rothIraPhaseOutFactor: full below the range, zero above, linear in between, HOH uses the single range', () => {
  const yearTable = { rothIraPhaseOut: taxTables.years['2026'].rothIraPhaseOut };
  assert.equal(rothIraPhaseOutFactor(100000, 'single', yearTable), 1);
  assert.equal(rothIraPhaseOutFactor(200000, 'single', yearTable), 0);
  approx(rothIraPhaseOutFactor(160000, 'single', yearTable), (168000 - 160000) / (168000 - 153000));
  assert.equal(rothIraPhaseOutFactor(160000, 'hoh', yearTable), rothIraPhaseOutFactor(160000, 'single', yearTable));
});

test('waterfall fills tiers in priority order, each grossed up correctly, matching hand-derived math', () => {
  // income=100000, single, 2026 brackets (12400@10%, 50400@12%, 105700@22%), stdDeduction=16100.
  // before = 83900 (22% bracket). Budget = 15% of income = 15000 net.
  // Tier 1 (match): matchCap=4%*100000=4000, electiveRoom=24500 -> desired=4000.
  //   netCost = 4000 - 4000*0.22 = 3120 <= 15000 -> fund fully. runningBefore=79900, budget=11880.
  //   employerMatch = 4000*1.0 = 4000.
  // Tier 2 (HSA via payroll): cap=4400 (2026 self-only). netCost = 4400*0.9235 - 4400*0.22 = 3095.4
  //   <= 11880 -> fund fully. runningBefore=75500, budget=8784.6.
  // Tier 3 (Roth IRA): cap=7500*1(no phase-out at 100k) -> min(7500, 8784.6)=7500. budget=1284.6.
  // Tier 4 (back to traditional): electiveRoom=24500-4000=20500 desired, but budget only covers
  //   1284.6/0.78=1646.923077 (still fully within the 22% bracket). runningBefore=73853.076923.
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [
      { id: 'trad401k', balance: 0, taxStatus: 'taxDeferred' },
      { id: 'hsa1', balance: 0, taxStatus: 'hsa', hsaViaPayroll: true },
      { id: 'rothira', balance: 0, taxStatus: 'roth' },
    ],
    returnRate: { default: 0 }, wageGrowth: { default: 0 },
    income: { default: 100000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
    contributionWaterfallEnabled: true, contributionMode: 'percentOfIncome', waterfallBudget: { default: 0.15 },
    hsaCoverage: 'selfOnly',
  });
  const y = row(r, 2027);
  approx(y.accounts.trad401k.contribution, 4000 + 1646.923077, 1e-3);
  approx(y.accounts.trad401k.employerMatch, 4000);
  approx(y.accounts.hsa1.contribution, 4400);
  approx(y.accounts.rothira.contribution, 7500);
  approx(y.totals.taxableIncome, 73853.076923, 1e-3);
  approx(y.totals.tax, 10959.676923, 1e-3);
  approx(y.totals.employerMatch, 4000);
  approx(y.totals.contribution, 4000 + 1646.923077 + 4400 + 7500, 1e-3);
});

test('a small budget only partially funds tier 1 and never reaches HSA/Roth', () => {
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [
      { id: 'trad401k', balance: 0, taxStatus: 'taxDeferred' },
      { id: 'hsa1', balance: 0, taxStatus: 'hsa' },
      { id: 'rothira', balance: 0, taxStatus: 'roth' },
    ],
    returnRate: { default: 0 }, wageGrowth: { default: 0 },
    income: { default: 100000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
    contributionWaterfallEnabled: true, waterfallBudget: { default: 2000 },
    hsaCoverage: 'selfOnly',
  });
  const y = row(r, 2027);
  approx(y.accounts.trad401k.contribution, 2000 / 0.78, 1e-3); // fully within the 22% bracket
  approx(y.accounts.trad401k.employerMatch, 2000 / 0.78, 1e-3); // 100% match on whatever was actually funded
  approx(y.accounts.hsa1.contribution, 0);
  approx(y.accounts.rothira.contribution, 0);
});

test('high income phases the Roth IRA tier fully out -- that money falls through to tier 4 instead', () => {
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [
      { id: 'trad401k', balance: 0, taxStatus: 'taxDeferred' },
      { id: 'rothira', balance: 0, taxStatus: 'roth' },
    ],
    returnRate: { default: 0 }, wageGrowth: { default: 0 },
    income: { default: 300000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
    contributionWaterfallEnabled: true, waterfallBudget: { default: 50000 },
  });
  const y = row(r, 2027);
  approx(y.accounts.rothira.contribution, 0);
  // Employee contribution pinned at the elective deferral limit (2026: $24,500, no catch-up --
  // age is unknown here since no birthYear was given); employer match is SEPARATE, on top.
  approx(y.accounts.trad401k.contribution, 24500);
  approx(y.accounts.trad401k.employerMatch, 0.04 * 300000);
});

test('the 401(k) elective deferral limit caps tier 1 + tier 4 COMBINED, catch-up included', () => {
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [{ id: 'trad401k', balance: 0, taxStatus: 'taxDeferred' }],
    returnRate: { default: 0 }, wageGrowth: { default: 0 },
    income: { default: 200000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
    contributionWaterfallEnabled: true, waterfallBudget: { default: 100000 }, // way more than the limit
    birthYear: 1971, // age 55 in 2026 -- the standard (not enhanced) catch-up
  });
  approx(row(r, 2027).accounts.trad401k.contribution, 24500 + 8000);
});

test('no HSA or Roth account: tier 2/3 are silently skipped, budget flows straight to tier 1 + 4', () => {
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [{ id: 'trad401k', balance: 0, taxStatus: 'taxDeferred' }],
    returnRate: { default: 0 }, wageGrowth: { default: 0 },
    income: { default: 100000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
    contributionWaterfallEnabled: true, waterfallBudget: { default: 0.15 }, contributionMode: 'percentOfIncome',
  });
  const y = row(r, 2027);
  // before=83900 (22%); budget=15000. Full tier1 (4000 gross, netCost 3120) leaves 11880, all of
  // which grosses up (still 22% bracket) into tier 4: 11880/0.78 = 15230.769231.
  approx(y.accounts.trad401k.contribution, 4000 + 11880 / 0.78, 1e-3);
});

test('a non-waterfall account keeps using its own independent contributions setting, in the SAME shared deduction pool', () => {
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [
      { id: 'trad401k', balance: 0, taxStatus: 'taxDeferred' }, // claimed by the waterfall
      { id: 'ira2', balance: 0, taxStatus: 'taxDeferred' },      // a SECOND taxDeferred account, not claimed
    ],
    returnRate: { default: 0 }, wageGrowth: { default: 0 },
    contributions: { byAccount: { ira2: 2000 } }, // net cost, independent of the waterfall
    income: { default: 100000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
    contributionWaterfallEnabled: true, waterfallBudget: { default: 2000 },
  });
  const y = row(r, 2027);
  // The waterfall spends its $2,000 budget on trad401k first (grossed up from before=83900, the
  // ORIGINAL position); ira2 then grosses up its OWN $2,000 net cost from whatever's left of
  // runningBefore, continuing the SAME shared pool rather than starting over from 83900.
  const tier1Gross = 2000 / 0.78; // 2564.102564, fully within the 22% bracket
  const runningAfterTier1 = 83900 - tier1Gross;
  approx(y.accounts.trad401k.contribution, tier1Gross, 1e-3);
  assert.ok(y.accounts.ira2.contribution > 2000, 'ira2 must also gross up above its $2,000 net cost');
  approx(y.totals.taxableIncome, runningAfterTier1 - y.accounts.ira2.contribution, 1e-3);
});
