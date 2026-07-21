// decumulation-tax.test.js — golden-number tests for Phase 4's tax-aware decumulation
// (gross-up, RMD forcing + surplus reinvestment, capital-gains stacking). Uses the real,
// verified 2026 tax-tables.json figures so these tests double as a data-wiring check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { projectDecumulation, project } from '../engine/project.js';

const approx = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} (Δ=${Math.abs(a - b)})`);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const taxTables = JSON.parse(readFileSync(join(root, 'data/tax-tables.json'), 'utf8'));
const row = (r, year) => r.years.find((y) => y.year === year);

test('REGRESSION: a well-funded portfolio in tax mode is never falsely flagged as depleted', () => {
  // Bug (fixed 2026-07-21): the gross-up loop's $0.01 convergence tolerance leaked through as a
  // fake "shortfall" on essentially every year (since netAchieved can land a few cents under
  // target at convergence), which latched firstDepletionYear onto the very first decumulation
  // year regardless of actual portfolio health. A large, comfortably-funded portfolio here must
  // report NO depletion across a long multi-year run with real growth and inflation in play.
  const r = projectDecumulation({
    startYear: 2026, endYear: 2060,
    accounts: [
      { id: 'ira', balance: 2000000, taxStatus: 'taxDeferred' },
      { id: 'brk', balance: 500000, taxStatus: 'taxable', basisFraction: 0.6 },
    ],
    returnRate: { default: 0.06 }, inflation: { default: 0.03 }, spending: { default: 50000 },
    filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0.03 }, standardDeductionIndexingRate: { default: 0.03 },
  });
  assert.equal(r.firstDepletionYear, null);
  for (const y of r.years) assert.equal(y.totals.shortfall, 0, `year ${y.year} should have zero shortfall`);
});

test('gross-up on a tax-deferred withdrawal converges to the exact algebraic solution (single, 2026)', () => {
  // net(G) = 0.88G + 2180 in the 12% bracket (stdDeduction 16100, 10%-then-12% ladder) ->
  // solving net(G)=50000 gives G = 47820/0.88 = 54340.909090909...
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [{ id: 'ira', balance: 10000000, taxStatus: 'taxDeferred' }],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 50000 },
    filingStatus: 'single', taxTables, anchorYear: 2026,
  });
  const y = row(r, 2026);
  approx(y.totals.withdrawal, 54340.909091);
  approx(y.totals.tax, 4340.909091);
  approx(y.totals.ordinaryTaxableIncome, 38240.909091);
  approx(y.totals.netSpendable, 50000);
});

test('capital gains withdrawal that stays within the 0% LTCG bracket: no tax, net == gross exactly', () => {
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [{ id: 'brk', balance: 1000000, taxStatus: 'taxable', basisFraction: 0.6 }],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 40000 },
    filingStatus: 'single', taxTables, anchorYear: 2026,
  });
  const y = row(r, 2026);
  approx(y.totals.tax, 0, 1e-6);
  approx(y.totals.withdrawal, 40000, 1e-6);
  approx(y.totals.capitalGain, 16000, 1e-6); // 40000 * (1 - 0.6)
  approx(y.totals.netSpendable, 40000, 1e-6);
});

test('capital gains withdrawal that crosses the 0% -> 15% LTCG boundary, grossed up exactly', () => {
  // gain = 0.4G; tax = (0.4G - 49450)*0.15 once gain > 49450 -> net(G) = 0.94G + 7417.5
  // solving net(G)=150000 gives G = 142582.5/0.94 = 151683.510638...
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [{ id: 'brk', balance: 10000000, taxStatus: 'taxable', basisFraction: 0.6 }],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 150000 },
    filingStatus: 'single', taxTables, anchorYear: 2026,
  });
  const y = row(r, 2026);
  approx(y.totals.withdrawal, 151683.510638);
  approx(y.totals.tax, 1683.511064);
  approx(y.totals.capitalGain, 60673.404255);
  approx(y.totals.netSpendable, 150000);
});

test('RMD forces a withdrawal beyond the spending need; the after-tax surplus is reinvested (exact, no iteration slack)', () => {
  // age 76 (born 1950) >= required beginning age 73 -> RMD = 1,000,000 / 23.7 = 42194.092827...
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [
      { id: 'ira', balance: 1000000, taxStatus: 'taxDeferred' },
      { id: 'brk', balance: 5000, taxStatus: 'taxable', basisFraction: 0.5 },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 10000 },
    filingStatus: 'single', taxTables, anchorYear: 2026, birthYear: 1950,
  });
  const y = row(r, 2026);
  const rmd = 1000000 / 23.7;
  approx(y.accounts.ira.withdrawal, rmd, 1e-6);
  // stdDeduction 16100 + 2050 (age 65+) = 18150
  const taxableIncome = rmd - 18150;
  const tax = 12400 * 0.10 + (taxableIncome - 12400) * 0.12;
  approx(y.totals.tax, tax, 1e-6);
  const netFromRmd = rmd - tax;
  const surplus = netFromRmd - 10000;
  approx(y.accounts.brk.reinvestment, surplus, 1e-6);
  approx(y.totals.netSpendable, 10000, 1e-6); // surplus doesn't count as spent
  approx(y.accounts.brk.endBalance, 5000 + surplus, 1e-6); // reinvested, then 0% growth
});

test('below the RMD age, no RMD is forced even with a birthYear supplied', () => {
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [{ id: 'ira', balance: 1000000, taxStatus: 'taxDeferred' }],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 0 },
    filingStatus: 'single', taxTables, anchorYear: 2026, birthYear: 1990, // age 36
  });
  const y = row(r, 2026);
  approx(y.totals.withdrawal, 0, 1e-6);
  approx(y.totals.tax, 0, 1e-6);
});

test('omitting filingStatus/taxTables is IDENTICAL to the pre-tax (Phase 3) path — tax is opt-in', () => {
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [{ id: 'a', balance: 100000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 1000 },
  });
  const y = row(r, 2026);
  approx(y.totals.tax, 0, 1e-9);
  approx(y.totals.netSpendable, y.totals.withdrawal, 1e-9);
});

test('anchorYear is required when taxTables is provided', () => {
  assert.throws(() => projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [{ id: 'a', balance: 1000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, filingStatus: 'single', taxTables,
  }));
});

test('project(): full pipeline with tax enabled — cost basis carries through as a fraction, numbers stay internally consistent', () => {
  const r = project({
    baseYear: 2026, retirementYear: 2026, horizonYear: 2027,
    accounts: [{ id: 'brk', balance: 200000, taxStatus: 'taxable', costBasis: 120000 }],
    returnRate: { default: 0 }, contributions: { default: 0 }, wageGrowth: { default: 0 },
    inflation: { default: 0 }, spending: { default: 20000 }, sequencing: 'conventional',
    filingStatus: 'single', taxTables, anchorYear: 2026,
  });
  const y2027 = row(r, 2027);
  // basisFraction = 120000/200000 = 0.6 -> gain fraction 0.4; well within the 0% LTCG bracket
  approx(y2027.totals.capitalGain, 20000 * 0.4, 1e-6);
  approx(y2027.totals.tax, 0, 1e-6);
  approx(y2027.totals.netSpendable, 20000, 1e-6);
});
