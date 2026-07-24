// accumulation-tax.test.js — golden-number tests for pre-retirement (accumulation-phase) income
// & tax modeling (Phase 6.5): real federal tax on working-years income, tax-deferred
// contributions reducing taxable income, and Roth conversions during accumulation. Opt-in on
// `income`/`filingStatus`/`taxTables` — omit them and projectAccumulation is unchanged (Phase 2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { projectAccumulation } from '../engine/project.js';

const approx = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} (Δ=${Math.abs(a - b)})`);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const taxTables = JSON.parse(readFileSync(join(root, 'data/tax-tables.json'), 'utf8'));
const row = (r, year) => r.years.find((y) => y.year === year);

// Real 2026 single figures used throughout: 10% to 12400, 12% to 50400, 22% to 105700;
// standard deduction 16100.

test('omitting income/filingStatus/taxTables leaves accumulation exactly as pre-tax (Phase 2 unchanged)', () => {
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [{ id: 'a', balance: 100000, taxStatus: 'taxDeferred' }],
    returnRate: { default: 0.05 }, contributions: { default: 10000 },
  });
  const y = row(r, 2027);
  assert.equal(y.totals.tax, 0);
  assert.equal(y.totals.income, 0);
  approx(y.totals.endBalance, 100000 * 1.05 + 10000);
});

test('basic tax on job income alone, no contributions: exact bracket math', () => {
  // taxableIncome = 70000 - 0 - 16100 = 53900 -> tax = 1240 + 4560 + (53900-50400)*0.22 = 6570
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [{ id: 'ira', balance: 100000, taxStatus: 'taxDeferred' }],
    returnRate: { default: 0.05 }, contributions: { default: 0 }, wageGrowth: { default: 0 },
    income: { default: 70000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
  });
  const y = row(r, 2027);
  approx(y.totals.income, 70000);
  approx(y.totals.taxableIncome, 53900);
  approx(y.totals.tax, 6570);
  approx(y.totals.marginalRate, 0.22);
  approx(y.totals.effectiveTaxRate, 6570 / 70000);
});

test('a tax-deferred contribution reduces taxable income (the real 401k/IRA deduction)', () => {
  // taxableIncome = 70000 - 10000(contribution) - 16100 = 43900 -> entirely in the 12% bracket
  // tax = 1240 + (43900-12400)*0.12 = 1240 + 3780 = 5020
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [{ id: 'ira', balance: 100000, taxStatus: 'taxDeferred' }],
    returnRate: { default: 0 }, contributions: { default: 10000 }, wageGrowth: { default: 0 },
    income: { default: 70000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
  });
  const y = row(r, 2027);
  approx(y.totals.taxableIncome, 43900);
  approx(y.totals.tax, 5020);
  approx(y.totals.marginalRate, 0.12);
  approx(y.accounts.ira.endBalance, 100000 + 10000); // 0% return, contribution lands at year-end
});

test('a Roth contribution of the SAME amount does NOT reduce taxable income -- direct comparison', () => {
  const scenario = (taxStatus) => projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [{ id: 'a', balance: 0, taxStatus }],
    returnRate: { default: 0 }, contributions: { default: 10000 }, wageGrowth: { default: 0 },
    income: { default: 70000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
  });
  const traditional = row(scenario('taxDeferred'), 2027);
  const roth = row(scenario('roth'), 2027);
  approx(traditional.totals.taxableIncome, 43900); // 70000 - 10000 - 16100
  approx(roth.totals.taxableIncome, 53900);          // 70000 - 0 - 16100 (no deduction)
  approx(traditional.totals.tax, 5020);
  approx(roth.totals.tax, 6570);
  assert.ok(traditional.totals.tax < roth.totals.tax, 'the traditional contribution must owe strictly less tax THIS year');
});

test('Roth conversion during accumulation: fills remaining bracket room, capped by the account balance', () => {
  // Low job income (a part-time/gap year) leaves lots of 12%-bracket room after the standard
  // deduction: taxableIncome before conversion = 20000-16100 = 3900; ceiling (12% bracket top) =
  // 50400 -> room = 46500, well under the $500,000 IRA balance, so the full 46500 converts.
  // taxableIncome after = 3900+46500 = 50400 exactly -> tax = 1240+4560 = 5800.
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [
      { id: 'ira', balance: 500000, taxStatus: 'taxDeferred' },
      { id: 'roth', balance: 0, taxStatus: 'roth' },
    ],
    returnRate: { default: 0 }, contributions: { default: 0 }, wageGrowth: { default: 0 },
    income: { default: 20000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
    rothConversionsEnabled: true, bracketFillRate: 0.12,
  });
  const y = row(r, 2027);
  approx(y.totals.conversion, 46500);
  approx(y.totals.taxableIncome, 50400);
  approx(y.totals.tax, 5800);
  approx(y.accounts.ira.endBalance, 500000 - 46500);
  approx(y.accounts.roth.endBalance, 46500);
  // Effective rate divides by job income + conversion (both are real ordinary income realized
  // this year), not job income alone -- otherwise a small-income/big-conversion year would look
  // like an absurd ~29% effective rate instead of the true ~8.7%.
  approx(y.totals.grossIncome, 20000 + 46500);
  approx(y.totals.effectiveTaxRate, 5800 / 66500, 1e-6);
});

test('Roth conversion during accumulation: usually zero for a normal full-time salary (no room left)', () => {
  // 70000 income alone -> taxableIncome 53900, already past the 12% ceiling (50400) -> no room.
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [
      { id: 'ira', balance: 500000, taxStatus: 'taxDeferred' },
      { id: 'roth', balance: 0, taxStatus: 'roth' },
    ],
    returnRate: { default: 0 }, contributions: { default: 0 }, wageGrowth: { default: 0 },
    income: { default: 70000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
    rothConversionsEnabled: true, bracketFillRate: 0.12,
  });
  const y = row(r, 2027);
  approx(y.totals.conversion, 0, 1e-6);
  approx(y.accounts.roth.endBalance, 0, 1e-6);
});

test('Roth conversion during accumulation: capped by the tax-deferred balance, not just bracket room', () => {
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [
      { id: 'ira', balance: 5000, taxStatus: 'taxDeferred' }, // far less than the ~46500 room
      { id: 'roth', balance: 0, taxStatus: 'roth' },
    ],
    returnRate: { default: 0 }, contributions: { default: 0 }, wageGrowth: { default: 0 },
    income: { default: 20000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
    rothConversionsEnabled: true, bracketFillRate: 0.12,
  });
  const y = row(r, 2027);
  approx(y.totals.conversion, 5000, 1e-6);
  approx(y.accounts.ira.endBalance, 0, 1e-6);
  approx(y.accounts.roth.endBalance, 5000, 1e-6);
});

test('income escalates with wage growth, same convention as contributions', () => {
  // wageGrowth 10%/yr: year 2027 income = 50000*1.1 = 55000; year 2028 = 50000*1.1^2 = 60500.
  const r = projectAccumulation({
    startYear: 2026, endYear: 2028,
    accounts: [{ id: 'a', balance: 0, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, contributions: { default: 0 }, wageGrowth: { default: 0.10 },
    income: { default: 50000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
  });
  approx(row(r, 2027).totals.income, 55000);
  approx(row(r, 2028).totals.income, 60500);
});
