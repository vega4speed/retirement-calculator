// hsa-contributions.test.js — golden-number tests for HSA contributions joining the tax-deferred
// deduction pool, the "max out" checkbox (indexed IRS limit + 55+ catch-up), and the
// via-payroll FICA savings that HSA gets but traditional 401(k)/IRA never do (Phase 6.6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { projectAccumulation } from '../engine/project.js';
import { hsaContributionLimit, grossUpDeduction } from '../engine/tax.js';

const approx = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} (Δ=${Math.abs(a - b)})`);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const taxTables = JSON.parse(readFileSync(join(root, 'data/tax-tables.json'), 'utf8'));
const row = (r, year) => r.years.find((y) => y.year === year);

test('hsaContributionLimit: verified 2026 limits, no catch-up under 55', () => {
  const yearTable = { hsaLimit: taxTables.years['2026'].hsaLimits };
  assert.equal(hsaContributionLimit('selfOnly', 40, yearTable, taxTables.fixed), 4400);
  assert.equal(hsaContributionLimit('family', 40, yearTable, taxTables.fixed), 8750);
});

test('hsaContributionLimit: the $1,000 catch-up applies starting the year you turn 55', () => {
  const yearTable = { hsaLimit: taxTables.years['2026'].hsaLimits };
  assert.equal(hsaContributionLimit('selfOnly', 54, yearTable, taxTables.fixed), 4400);
  assert.equal(hsaContributionLimit('selfOnly', 55, yearTable, taxTables.fixed), 5400);
  assert.equal(hsaContributionLimit('selfOnly', 60, yearTable, taxTables.fixed), 5400);
});

test('HSA max-out: gross is fixed at the indexed limit regardless of the "contributions" setting', () => {
  const r = projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [{ id: 'hsa1', balance: 0, taxStatus: 'hsa', hsaMaxOut: true }],
    // A contributions setting is present but irrelevant to a maxed-out account.
    returnRate: { default: 0 }, contributions: { default: 999999 }, wageGrowth: { default: 0 },
    income: { default: 80000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
    hsaCoverage: 'selfOnly',
  });
  approx(row(r, 2027).accounts.hsa1.contribution, 4400);
});

test('HSA via payroll (default) also saves FICA on top of income tax -- lower take-home cost than a 401(k) for the same gross', () => {
  // Same $80,000 income, same 22%-bracket position (before=63900), same $4,400 gross deduction.
  // Traditional 401(k): netCost = 4400 - 4400*0.22 = 3432.
  // HSA via payroll: netCost = 4400*(1-0.0765) - 4400*0.22 = 4400*0.7035 = 3095.4 -- STRICTLY less.
  const params = (taxStatus, extra = {}) => ({
    startYear: 2026, endYear: 2027,
    accounts: [{ id: 'a', balance: 0, taxStatus, ...extra }],
    returnRate: { default: 0 }, wageGrowth: { default: 0 },
    income: { default: 80000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
    hsaCoverage: 'selfOnly',
  });
  const hsaPayroll = row(projectAccumulation({ ...params('hsa', { hsaMaxOut: true, hsaViaPayroll: true }) }), 2027);
  const hsaNoPayroll = row(projectAccumulation({ ...params('hsa', { hsaMaxOut: true, hsaViaPayroll: false }) }), 2027);
  approx(hsaPayroll.accounts.a.contribution, 4400);
  approx(hsaNoPayroll.accounts.a.contribution, 4400);
  approx(hsaNoPayroll.accounts.a.netCost, 3432);   // income-tax savings only, same as a 401(k) would get
  approx(hsaPayroll.accounts.a.netCost, 3095.4);   // ALSO saves FICA -- strictly cheaper take-home cost
  assert.ok(hsaPayroll.accounts.a.netCost < hsaNoPayroll.accounts.a.netCost, 'paying via payroll must cost less take-home for the identical gross deposit');
});

test('HSA joins the SAME deduction pool as a taxDeferred account (reduces taxable income like a 401(k))', () => {
  const withHsa = row(projectAccumulation({
    startYear: 2026, endYear: 2027,
    accounts: [{ id: 'hsa1', balance: 0, taxStatus: 'hsa', hsaMaxOut: true, hsaViaPayroll: false }],
    returnRate: { default: 0 }, contributions: { default: 0 }, wageGrowth: { default: 0 },
    income: { default: 80000 }, filingStatus: 'single', taxTables, anchorYear: 2026,
    bracketIndexingRate: { default: 0 }, standardDeductionIndexingRate: { default: 0 },
    hsaCoverage: 'selfOnly',
  }), 2027);
  // before = 80000-16100 = 63900; -4400 deduction -> taxableIncome = 59500, fully in the 22% bracket.
  approx(withHsa.totals.taxableIncome, 59500);
});

test('grossUpDeduction: exact single-bracket case matches hand math', () => {
  const brackets = taxTables.years['2026'].ordinaryBrackets.single;
  // before=63900 (22% bracket), net target 3000, well inside the 22% bracket's room down to 50400.
  const gross = grossUpDeduction(3000, 63900, brackets);
  approx(gross, 3000 / 0.78, 1e-6);
});

test('grossUpDeduction: past $0 taxable income, further gross costs $1-for-$1 net (no FICA)', () => {
  const brackets = taxTables.years['2026'].ordinaryBrackets.single;
  // before=2000 (all in the 10% bracket): the whole $2,000 income shelters $2000*0.9=1800 net.
  // A $3,000 net target needs 1800 from that + the remaining 1200 at $1-for-$1 beyond $0.
  const gross = grossUpDeduction(3000, 2000, brackets);
  approx(gross, 2000 + 1200, 1e-6); // 2000 shelters $1800 net; the other $1200 net costs $1200 gross
});

test('grossUpDeduction: past $0 taxable income, FICA savings still apply on the remainder', () => {
  const brackets = taxTables.years['2026'].ordinaryBrackets.single;
  const gross = grossUpDeduction(3000, 2000, brackets, 0.0765);
  // First 2000 gross (all 10% bracket): net = 2000*(1-0.10-0.0765) = 2000*0.8235 = 1647.
  // Remaining net needed = 1353, past $0 taxable income costs 1/(1-0.0765) gross per net dollar.
  const expected = 2000 + 1353 / (1 - 0.0765);
  approx(gross, expected, 1e-6);
});

test('grossUpDeduction: zero net target is zero gross', () => {
  const brackets = taxTables.years['2026'].ordinaryBrackets.single;
  assert.equal(grossUpDeduction(0, 63900, brackets), 0);
});
