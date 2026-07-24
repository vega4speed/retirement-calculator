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

test('a tax-deferred contribution is TAKE-HOME-COST-anchored: $10,000 out of pocket buys MORE than $10,000 in the account', () => {
  // "contributions" is now the NET (take-home) cost, not the gross deposit -- see
  // projectAccumulation's docs. before = 70000-16100 = 53900 (22% bracket, up to 105700).
  // Walking down: 53900->50400 is 3500 of 22%-bracket room, netAvailable = 3500*0.78 = 2730.
  // Remaining need = 10000-2730 = 7270, in the 12% bracket: netPerGross = 0.88,
  // grossNeeded = 7270/0.88 = 8261.363636... -> gross = 3500 + 8261.363636 = 11761.363636...
  // taxableIncome = 53900 - 11761.363636 = 42138.636364 -> tax = 1240 + (42138.636364-12400)*0.12
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [{ id: 'ira', balance: 100000, taxStatus: 'taxDeferred' }],
    returnRate: { default: 0 }, contributions: { default: 10000 }, wageGrowth: { default: 0 },
    income: { default: 70000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
  });
  const y = row(r, 2027);
  approx(y.accounts.ira.contribution, 11761.363636, 1e-4); // the GROSS amount landing in the account
  approx(y.accounts.ira.netCost, 10000);                   // exactly what was resolved -- the take-home cost
  approx(y.totals.taxableIncome, 42138.636364, 1e-4);
  approx(y.totals.tax, 4808.636364, 1e-4);
  approx(y.totals.marginalRate, 0.12);
  approx(y.accounts.ira.endBalance, 100000 + 11761.363636, 1e-4); // 0% return, contribution lands at year-end
});

test('a Roth contribution of the SAME resolved amount costs the SAME take-home but buys FEWER dollars -- direct comparison', () => {
  const scenario = (taxStatus) => projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [{ id: 'a', balance: 0, taxStatus }],
    returnRate: { default: 0 }, contributions: { default: 10000 }, wageGrowth: { default: 0 },
    income: { default: 70000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
  });
  const traditional = row(scenario('taxDeferred'), 2027);
  const roth = row(scenario('roth'), 2027);
  // Roth: dollar-for-dollar, no gross-up -- $10,000 net cost buys exactly $10,000 in the account.
  approx(roth.accounts.a.contribution, 10000);
  assert.equal(roth.accounts.a.netCost, undefined); // no deduction to gross up, nothing to report
  approx(roth.totals.taxableIncome, 53900); // 70000 - 0 - 16100 (no deduction)
  // Traditional: the SAME $10,000 take-home cost buys MORE ($11,761.36) since it shields itself
  // from tax -- the whole point of this comparison (was previously compared dollar-for-dollar,
  // which understated Traditional's real advantage for the same paycheck hit).
  approx(traditional.accounts.a.contribution, 11761.363636, 1e-4);
  approx(traditional.accounts.a.netCost, 10000);
  approx(traditional.totals.taxableIncome, 42138.636364, 1e-4);
  assert.ok(traditional.totals.tax < roth.totals.tax, 'the traditional contribution must owe strictly less tax THIS year');
  assert.ok(traditional.accounts.a.contribution > roth.accounts.a.contribution, 'the same take-home cost must buy MORE in a traditional account');
});

test('percentOfIncome mode: a Roth % buys exactly that % of income; the SAME % into Traditional buys more', () => {
  // Ramsey's "15% of gross income" heuristic: for Roth this literally deposits 15% of income.
  // For Traditional, the SAME 15%-of-income take-home cost grosses up to more, same mechanism
  // as the dollar-mode test above -- just anchored to a % of income instead of a flat $ figure.
  const scenario = (taxStatus) => projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [{ id: 'a', balance: 0, taxStatus }],
    returnRate: { default: 0 }, contributions: { default: 0.15 }, contributionMode: 'percentOfIncome', wageGrowth: { default: 0 },
    income: { default: 80000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
  });
  const roth = row(scenario('roth'), 2027);
  const traditional = row(scenario('taxDeferred'), 2027);
  approx(roth.accounts.a.contribution, 12000); // 15% of 80000
  approx(traditional.accounts.a.netCost, 12000); // same take-home cost as the Roth case
  assert.ok(traditional.accounts.a.contribution > 12000, 'traditional must buy more than the Roth 15% for the same take-home hit');
});

test('percentOfIncome mode without tax mode resolves to 0 rather than misreading the fraction as dollars', () => {
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [{ id: 'a', balance: 0, taxStatus: 'roth' }],
    returnRate: { default: 0 }, contributions: { default: 0.15 }, contributionMode: 'percentOfIncome', wageGrowth: { default: 0 },
  });
  approx(row(r, 2027).accounts.a.contribution, 0);
});

test('multiple tax-advantaged accounts pool into ONE combined deduction, grossed up sequentially', () => {
  // ira (net $5,000) processed first, hsa maxed out second -- see projectAccumulation's docs for
  // why order matters (each account walks the brackets from where the previous one left off).
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [
      { id: 'ira', balance: 0, taxStatus: 'taxDeferred' },
      { id: 'hsa1', balance: 0, taxStatus: 'hsa', hsaMaxOut: true },
    ],
    returnRate: { default: 0 }, contributions: { byAccount: { ira: 5000 }, default: 0 }, wageGrowth: { default: 0 },
    income: { default: 80000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
    hsaCoverage: 'selfOnly',
  });
  const y = row(r, 2027);
  approx(y.accounts.ira.contribution, 6410.25641, 1e-4);   // 5000 net / (1-0.22), fully within the 22% bracket
  approx(y.accounts.hsa1.contribution, 4400);              // fixed at the 2026 self-only limit
  // taxableIncome after BOTH deductions = 63900 - 6410.25641 - 4400 = 53089.74359
  approx(y.totals.taxableIncome, 53089.74359, 1e-4);
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
