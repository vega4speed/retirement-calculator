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

test('waterfallRole: a Roth 401(k) as the employer plan uses the elective-deferral limit (not the Roth IRA limit) and never reduces taxable income', () => {
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [
      { id: 'roth401k', balance: 0, taxStatus: 'roth', waterfallRole: 'employerPlan' },
    ],
    returnRate: { default: 0 }, wageGrowth: { default: 0 },
    income: { default: 100000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
    contributionWaterfallEnabled: true, waterfallBudget: { default: 50000 }, // way more than the limit
  });
  const y = row(r, 2027);
  // Full elective-deferral limit (24500, no age given), funded dollar-for-dollar (Roth = post-tax,
  // no gross-up) -- NOT the small Roth IRA limit (7500) tier 3 would otherwise assume.
  approx(y.accounts.roth401k.contribution, 24500);
  approx(y.accounts.roth401k.employerMatch, 0.04 * 100000);
  // Taxable income is UNCHANGED from before any contribution (100000 - stdDeduction) -- a Roth
  // contribution never reduces it, unlike a Traditional one.
  approx(y.totals.taxableIncome, 100000 - 16100, 1e-3);
});

test('waterfallRole: employer match can land in a SEPARATE Traditional account from a Roth 401(k) employee election', () => {
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [
      { id: 'roth401k', balance: 0, taxStatus: 'roth', waterfallRole: 'employerPlan' },
      { id: 'matchAcct', balance: 0, taxStatus: 'taxDeferred', waterfallRole: 'employerMatch' },
    ],
    returnRate: { default: 0 }, wageGrowth: { default: 0 },
    income: { default: 100000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
    contributionWaterfallEnabled: true, waterfallBudget: { default: 50000 },
  });
  const y = row(r, 2027);
  approx(y.accounts.roth401k.contribution, 24500); // employee's own election, all Roth
  approx(y.accounts.roth401k.employerMatch, 0); // no match landed in the Roth account
  approx(y.accounts.matchAcct.contribution, 0); // match-only account gets no employee contribution
  approx(y.accounts.matchAcct.employerMatch, 0.04 * 100000); // the match landed here instead
  approx(y.totals.taxableIncome, 100000 - 16100, 1e-3); // still untouched -- match is free money, not deductible
});

test('waterfallRole: rothIra explicitly picks which of two Roth accounts gets the IRA-limit tier', () => {
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [
      { id: 'roth401k', balance: 0, taxStatus: 'roth', waterfallRole: 'employerPlan' },
      { id: 'rothIraB', balance: 0, taxStatus: 'roth', waterfallRole: 'rothIra' },
      { id: 'rothIraA', balance: 0, taxStatus: 'roth' }, // earlier in array order, but no explicit role
    ],
    returnRate: { default: 0 }, wageGrowth: { default: 0 },
    income: { default: 100000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
    contributionWaterfallEnabled: true, waterfallBudget: { default: 50000 },
  });
  const y = row(r, 2027);
  approx(y.accounts.rothIraB.contribution, 7500); // explicit role wins over array order
  approx(y.accounts.rothIraA.contribution, 0); // not claimed, defaults to $0 (no override set)
});

test('waterfallRole: "none" keeps an unrelated Roth account OUT of the Roth-IRA fallback tier (regression)', () => {
  // Real bug: a household with one Roth account marked 'employerPlan' and several OTHER,
  // unrelated Roth accounts (each with its OWN $0 contribution override, expecting to be left
  // alone) still had one of those others silently swept into the Roth-IRA fallback tier -- which
  // computes its own contribution and ignores that account's override entirely.
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [
      { id: 'oldRothA', balance: 0, taxStatus: 'roth', waterfallRole: 'none' },
      { id: 'oldRothB', balance: 0, taxStatus: 'roth', waterfallRole: 'none' },
      { id: 'roth401k', balance: 0, taxStatus: 'roth', waterfallRole: 'employerPlan' },
    ],
    returnRate: { default: 0 }, wageGrowth: { default: 0 },
    contributions: { default: 0.15, byAccount: { oldRothA: 0, oldRothB: 0 } },
    income: { default: 100000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
    contributionWaterfallEnabled: true, contributionMode: 'percentOfIncome', waterfallBudget: { default: 0.15 },
  });
  const y = row(r, 2027);
  approx(y.accounts.oldRothA.contribution, 0);
  approx(y.accounts.oldRothB.contribution, 0);
  approx(y.accounts.roth401k.contribution, 15000); // the full waterfall budget, dollar-for-dollar (Roth)
});

test('totals.netContributionCost adds back up to exactly the waterfall budget, even though gross contributions exceed it', () => {
  // Real user report: a 15%-of-income budget produced a table showing "16.7%" next to Total
  // contribution, because the HSA tier's GROSS deposit ($9,013) exceeds its NET take-home cost
  // (tax deduction + FICA exemption via payroll) -- the 15% budget is a NET figure, but the
  // dollars landing in accounts are gross. netContributionCost is the net-cost total that should
  // reconcile back to exactly the budget, and each account's own `netCost` should reconcile too.
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [
      { id: 'roth401k', balance: 0, taxStatus: 'roth', waterfallRole: 'employerPlan' },
      { id: 'hsa1', balance: 0, taxStatus: 'hsa', hsaViaPayroll: true },
    ],
    returnRate: { default: 0 }, wageGrowth: { default: 0 },
    income: { default: 156000 }, filingStatus: 'mfj', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0.03 }, standardDeductionIndexingRate: { default: 0.03 },
    contributionWaterfallEnabled: true, contributionMode: 'percentOfIncome', waterfallBudget: { default: 0.15 },
    hsaCoverage: 'family',
  });
  const y = row(r, 2027);
  approx(y.totals.netContributionCost, 0.15 * 156000, 1e-6); // reconciles EXACTLY to the net budget
  assert.ok(y.totals.contribution > y.totals.netContributionCost, 'gross contribution exceeds net cost when a tax-advantaged tier is involved');
  approx(y.accounts.roth401k.netCost, y.accounts.roth401k.contribution); // Roth: no gross-up, net === gross
  assert.ok(y.accounts.hsa1.netCost < y.accounts.hsa1.contribution, 'HSA net cost is less than its gross deposit');
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

// --- 'bracketAware' order (2026-07-27) --------------------------------------
// match -> HSA max -> Traditional only down to the top of a chosen bracket -> Roth for the rest.
// Same 2026 single figures throughout: stdDeduction 16100, brackets 12400@10% / 50400@12% /
// 105700@22%, so a 0.12 rothBracketRate means "deduct until taxable income hits 50400".

const bracketAwareBase = (overrides = {}) => ({
  startYear: 2026, endYear: 2027,
  accounts: [
    { id: 'trad401k', balance: 0, taxStatus: 'taxDeferred' },
    { id: 'hsa1', balance: 0, taxStatus: 'hsa', hsaViaPayroll: true },
    { id: 'rothira', balance: 0, taxStatus: 'roth' },
  ],
  returnRate: { default: 0 }, wageGrowth: { default: 0 },
  income: { default: 100000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
  bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
  contributionWaterfallEnabled: true, contributionMode: 'percentOfIncome',
  waterfallBudget: { default: 0.15 }, hsaCoverage: 'selfOnly',
  waterfallOrder: 'bracketAware', waterfallRothBracketRate: 0.12,
  ...overrides,
});

test('bracketAware: a 22%-bracket income sends the whole post-HSA budget to Traditional, not Roth', () => {
  // before=83900. Tier 1 match: 4000 gross, netCost 4000*0.78=3120 -> budget 11880, before 79900.
  // Tier 2 HSA: 4400 gross, netCost 4400*0.9235 - 4400*0.22 = 3095.4 -> budget 8784.6, before 75500.
  // Tier 3 Traditional-to-ceiling: aboveCeiling = 75500-50400 = 25100, electiveRoom = 24500-4000 =
  //   20500 -> desired 20500, but its full net cost (20500*0.78=15990) exceeds the 8784.6 budget,
  //   so it funds what the budget grosses up to: 8784.6/0.78 = 11262.307692 (all within the 22%
  //   band, which runs from 50400 up to 105700). Budget exhausted -> Roth gets nothing.
  const y = row(projectAccumulation(bracketAwareBase()), 2027);
  approx(y.accounts.trad401k.contribution, 4000 + 11262.307692, 1e-3);
  approx(y.accounts.rothira.contribution, 0);
  approx(y.accounts.hsa1.contribution, 4400);
  approx(y.totals.taxableIncome, 75500 - 11262.307692, 1e-3);
});

test('bracketAware: once income is deducted to the ceiling, the rest of the budget goes to Roth', () => {
  // Same as above with a 30%-of-income budget. Tier 3's full 20500 (elective room) now fits:
  // netCost 15990 <= 23784.6 -> before 55000, budget 7794.6. Tier 4 Roth IRA takes its 7500 limit.
  // Note before (55000) stops ABOVE the 50400 ceiling here: the elective-deferral limit ran out
  // first, which is the cap binding, not the bracket.
  const y = row(projectAccumulation(bracketAwareBase({ waterfallBudget: { default: 0.30 } })), 2027);
  approx(y.accounts.trad401k.contribution, 24500, 1e-3); // = the full 2026 elective deferral limit
  approx(y.accounts.hsa1.contribution, 4400);
  approx(y.accounts.rothira.contribution, 7500);
  approx(y.totals.taxableIncome, 55000, 1e-3);
});

test('bracketAware: income already at/below the ceiling funds NO extra Traditional — it all goes Roth', () => {
  // income=60000 -> before=43900, under the 50400 ceiling from the start.
  // Tier 1 match: 2400 gross (4% of pay), netCost 2400*0.88 = 2112 -> budget 6888, before 41500.
  // Tier 2 HSA: netCost 4400*0.9235 - 4400*0.12 = 3535.4 -> budget 3352.6, before 37100.
  // Tier 3: aboveCeiling = max(0, 37100 - 50400) = 0 -> skipped entirely. Tier 4 Roth: 3352.6.
  const y = row(projectAccumulation(bracketAwareBase({ income: { default: 60000 } })), 2027);
  approx(y.accounts.trad401k.contribution, 2400, 1e-3); // the match tier only
  approx(y.accounts.rothira.contribution, 3352.6, 1e-3);
  approx(y.totals.taxableIncome, 37100, 1e-3);
});

test('bracketAware vs standard: same budget, same accounts, more of it lands pre-tax at 22%', () => {
  const standard = row(projectAccumulation(bracketAwareBase({ waterfallOrder: 'standard' })), 2027);
  const aware = row(projectAccumulation(bracketAwareBase()), 2027);
  approx(standard.totals.contribution + standard.totals.tax, aware.totals.contribution + aware.totals.tax, 5000);
  assert.ok(aware.accounts.trad401k.contribution > standard.accounts.trad401k.contribution,
    `pre-tax should be larger under bracketAware (${aware.accounts.trad401k.contribution} vs ${standard.accounts.trad401k.contribution})`);
  assert.ok(aware.totals.taxableIncome < standard.totals.taxableIncome, 'and taxable income lower');
  assert.ok(aware.totals.tax < standard.totals.tax, 'so this year\'s tax bill is lower');
});

test('REGRESSION: omitting waterfallOrder is exactly the standard order', () => {
  const omitted = projectAccumulation(bracketAwareBase({ waterfallOrder: undefined, waterfallRothBracketRate: undefined }));
  const explicit = projectAccumulation(bracketAwareBase({ waterfallOrder: 'standard' }));
  // years[0] is the inert baseline row (no contributions computed at all), hence the || 0.
  for (let i = 0; i < omitted.years.length; i++) {
    approx(omitted.years[i].totals.contribution || 0, explicit.years[i].totals.contribution || 0, 1e-9);
    approx(omitted.years[i].totals.taxableIncome || 0, explicit.years[i].totals.taxableIncome || 0, 1e-9);
  }
});

// --- 'employerPlanRoth': both sides of one plan, sharing one limit (2026-07-28) --------------
// A real 401(k)/403(b) lets you split ONE elective deferral between a Traditional and a Roth
// election. Base case below: income 80000 single, stdDeduction 16100 -> before = 63900 (in the
// 22% band, 50400..105700). Budget 30000 flat. Ceiling = top of the 12% bracket = 50400.

const bothSidesBase = (overrides = {}) => ({
  startYear: 2026, endYear: 2027,
  accounts: [
    { id: 'trad401k', balance: 0, taxStatus: 'taxDeferred', waterfallRole: 'employerPlan' },
    { id: 'roth401k', balance: 0, taxStatus: 'roth', waterfallRole: 'employerPlanRoth' },
    { id: 'hsa1', balance: 0, taxStatus: 'hsa', hsaViaPayroll: true },
    { id: 'rothira', balance: 0, taxStatus: 'roth', waterfallRole: 'rothIra' },
  ],
  returnRate: { default: 0 }, wageGrowth: { default: 0 },
  income: { default: 80000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
  bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
  contributionWaterfallEnabled: true, waterfallBudget: { default: 30000 }, hsaCoverage: 'selfOnly',
  waterfallOrder: 'bracketAware', waterfallRothBracketRate: 0.12,
  ...overrides,
});

test('employerPlanRoth: bracketAware deducts to the ceiling, then the REST goes to the Roth side of the plan', () => {
  // Tier 1 match: 4% * 80000 = 3200 gross, netCost 3200*0.78 = 2496 -> budget 27504, before 60700.
  //   electiveRoom = 24500 - 3200 = 21300.
  // Tier 2 HSA: 4400 gross, netCost 4400*0.9235 - 968 = 3095.4 -> budget 24408.6, before 56300.
  // Tier 3 Traditional-to-ceiling: aboveCeiling = 56300 - 50400 = 5900 (well under electiveRoom),
  //   netCost 5900*0.78 = 4602 -> budget 19806.6, before EXACTLY 50400. electiveRoom = 15400.
  // Tier 4 Roth IRA: 7500 limit, no phase-out at 80k -> budget 12306.6.
  // Tier 5 Roth side of the plan: min(electiveRoom 15400, budget 12306.6) = 12306.6 -> budget 0.
  // Tier 6 Traditional spillover: nothing left to spend.
  const y = row(projectAccumulation(bothSidesBase()), 2027);
  approx(y.accounts.trad401k.contribution, 3200 + 5900, 1e-3);
  approx(y.accounts.hsa1.contribution, 4400);
  approx(y.accounts.rothira.contribution, 7500);
  approx(y.accounts.roth401k.contribution, 12306.6, 1e-3);
  approx(y.totals.taxableIncome, 50400, 1e-3); // deducted to the ceiling, not past it
  // The Roth side is NOT capped at the Roth IRA limit -- that's the whole point of the role.
  assert.ok(y.accounts.roth401k.contribution > iraContributionLimit(43, { iraLimit: taxTables.years['2026'].iraLimits }),
    'the Roth side of the plan must use the elective-deferral limit, not the IRA limit');
});

test('employerPlanRoth: both sides share ONE elective-deferral limit, never one each', () => {
  // Budget 60000: enough that tier 5 is capped by what's LEFT of the shared limit, not by budget.
  const y = row(projectAccumulation(bothSidesBase({ waterfallBudget: { default: 60000 } })), 2027);
  const employeeTotal = y.accounts.trad401k.contribution + y.accounts.roth401k.contribution;
  approx(employeeTotal, 24500, 1e-3); // exactly the 2026 elective deferral limit, across both sides
  approx(y.accounts.trad401k.contribution, 3200 + 5900, 1e-3);
  approx(y.accounts.roth401k.contribution, 24500 - 3200 - 5900, 1e-3);
  approx(y.accounts.rothira.contribution, 7500); // its own separate limit, unaffected
});

test('employerPlanRoth is never swept into the Roth IRA tier (which would cap it at the IRA limit)', () => {
  // Same setup with NO separate Roth IRA account: the plan's Roth side must still be funded from
  // the elective limit rather than being picked up as "the first roth account" at the IRA limit.
  const params = bothSidesBase({ waterfallBudget: { default: 60000 } });
  params.accounts = params.accounts.filter((a) => a.id !== 'rothira');
  const y = row(projectAccumulation(params), 2027);
  approx(y.accounts.trad401k.contribution + y.accounts.roth401k.contribution, 24500, 1e-3);
  approx(y.accounts.roth401k.contribution, 24500 - 3200 - 5900, 1e-3);
});

test('employerPlanRoth under the STANDARD order: funded after the Roth IRA, before extra Traditional', () => {
  const y = row(projectAccumulation(bothSidesBase({ waterfallOrder: 'standard', waterfallBudget: { default: 60000 } })), 2027);
  // No bracket tier here, so after match + HSA + Roth IRA the Roth side takes the rest of the
  // shared limit, and only then would the Traditional spillover get anything.
  approx(y.accounts.rothira.contribution, 7500);
  approx(y.accounts.trad401k.contribution + y.accounts.roth401k.contribution, 24500, 1e-3);
  approx(y.accounts.trad401k.contribution, 3200, 1e-3); // the match tier only
});
