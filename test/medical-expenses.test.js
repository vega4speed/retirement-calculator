// medical-expenses.test.js — golden-number tests for decumulation-phase medical costs: an
// HSA-first funding order, spillover to ordinary sequencing (grossed up in tax mode), medical's
// own inflation escalator, the included-in-spending vs on-top modes, and the hsaMedicalOnly
// reserve. Uses the real, verified tax-tables.json figures for the tax-mode cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { projectDecumulation } from '../engine/project.js';

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} (Δ=${Math.abs(a - b)})`);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const taxTables = JSON.parse(readFileSync(join(root, 'data/tax-tables.json'), 'utf8'));
const row = (r, year) => r.years.find((y) => y.year === year);

test('medical costs are funded from the HSA first, tax-free, and are additional to spending', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2001,
    accounts: [
      { id: 'hsa', balance: 50000, taxStatus: 'hsa' },
      { id: 'brk', balance: 100000, taxStatus: 'taxable' },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 },
    spending: { default: 20000 }, medicalExpenses: { default: 10000 },
  });
  const y = row(r, 2000);
  approx(y.totals.spendingNeed, 20000);
  approx(y.totals.medicalExpense, 10000);
  approx(y.totals.gap, 30000);                 // medical is ON TOP of spending by default
  approx(y.accounts.hsa.withdrawal, 10000);    // the whole medical bill came from the HSA
  approx(y.accounts.brk.withdrawal, 20000);    // ordinary spending came from elsewhere
  approx(y.totals.medicalFromHsa, 10000);
  approx(y.totals.medicalFromOther, 0);
  approx(y.accounts.hsa.endBalance, 40000);
  approx(row(r, 2001).accounts.hsa.endBalance, 30000);
});

test('medicalIncludedInSpending changes only the funding source, not the total need', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2000,
    accounts: [
      { id: 'hsa', balance: 50000, taxStatus: 'hsa' },
      { id: 'brk', balance: 100000, taxStatus: 'taxable' },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 },
    spending: { default: 30000 }, medicalExpenses: { default: 10000 },
    medicalIncludedInSpending: true,
  });
  const y = row(r, 2000);
  approx(y.totals.gap, 30000);                 // NOT 40000 — medical already sits inside spending
  approx(y.totals.withdrawal, 30000);
  approx(y.accounts.hsa.withdrawal, 10000);    // ...but the HSA still pays the medical share
  approx(y.accounts.brk.withdrawal, 20000);
});

test('an HSA too small for the bill spills the remainder over to ordinary sequencing', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2000,
    accounts: [
      { id: 'hsa', balance: 4000, taxStatus: 'hsa' },
      { id: 'brk', balance: 100000, taxStatus: 'taxable' },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 },
    spending: { default: 0 }, medicalExpenses: { default: 10000 },
  });
  const y = row(r, 2000);
  approx(y.accounts.hsa.withdrawal, 4000);
  approx(y.accounts.brk.withdrawal, 6000);
  approx(y.totals.medicalFromHsa, 4000);
  approx(y.totals.medicalFromOther, 6000);
});

test('medical costs escalate on their own inflation rate, independent of general inflation', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2002,
    accounts: [{ id: 'brk', balance: 1000000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0.02 },
    spending: { default: 1000 }, medicalExpenses: { default: 1000 }, medicalInflation: { default: 0.06 },
  });
  approx(row(r, 2000).totals.medicalExpense, 1060);
  approx(row(r, 2001).totals.medicalExpense, 1123.6);
  approx(row(r, 2002).totals.medicalExpense, 1191.016, 1e-9);
  approx(row(r, 2002).totals.spendingNeed, 1000 * 1.02 ** 3, 1e-9); // general inflation, unchanged
  // `real` deflates by GENERAL inflation, so real medical cost climbs — the whole point of the
  // separate escalator.
  approx(row(r, 2002).real.medicalExpense, 1191.016 / 1.02 ** 3, 1e-9);
});

test('medicalInflation defaults to the general inflation assumption when omitted', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2001,
    accounts: [{ id: 'brk', balance: 1000000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0.05 },
    spending: { default: 0 }, medicalExpenses: { default: 1000 },
  });
  approx(row(r, 2000).totals.medicalExpense, 1050);
  approx(row(r, 2001).totals.medicalExpense, 1102.5);
  approx(row(r, 2001).real.medicalExpense, 1000, 1e-9);
});

test('income covering the year outright means no withdrawal at all — and no phantom reinvestment', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2000,
    accounts: [
      { id: 'hsa', balance: 50000, taxStatus: 'hsa' },
      { id: 'brk', balance: 100000, taxStatus: 'taxable' },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 },
    spending: { default: 20000 }, otherIncome: { default: 40000 },
    medicalExpenses: { default: 10000 },
  });
  const y = row(r, 2000);
  approx(y.totals.gap, 0);                  // 20k spending + 10k medical < 40k income
  approx(y.totals.withdrawal, 0);
  approx(y.totals.medicalFromHsa, 0);       // the HSA is not raided to cover an already-paid bill
  approx(y.totals.medicalFromOther, 0);
  approx(y.totals.reinvestment, 0);
  approx(y.accounts.hsa.endBalance, 50000);
});

test('hsaMedicalOnly reserves the HSA from ordinary spending sequencing', () => {
  const params = {
    startYear: 2000, endYear: 2000,
    accounts: [
      { id: 'brk', balance: 5000, taxStatus: 'taxable' },
      { id: 'hsa', balance: 50000, taxStatus: 'hsa' },
      { id: 'roth', balance: 50000, taxStatus: 'roth' },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 },
    spending: { default: 25000 }, medicalExpenses: { default: 10000 },
  };
  // Default: HSA keeps its conventional-order slot (ahead of Roth), so ordinary spending taps it.
  const off = row(projectDecumulation(params), 2000);
  approx(off.accounts.brk.withdrawal, 5000);
  approx(off.accounts.hsa.withdrawal, 30000);  // 10k medical + 20k of ordinary spending
  approx(off.accounts.roth.withdrawal, 0);

  const on = row(projectDecumulation({ ...params, hsaMedicalOnly: true }), 2000);
  approx(on.accounts.brk.withdrawal, 5000);
  approx(on.accounts.hsa.withdrawal, 10000);   // medical only
  approx(on.accounts.roth.withdrawal, 20000);  // ordinary spending skips the HSA entirely
});

test('a reserved HSA is still a last resort once every other account is exhausted', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2000,
    accounts: [
      { id: 'brk', balance: 5000, taxStatus: 'taxable' },
      { id: 'hsa', balance: 50000, taxStatus: 'hsa' },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 },
    spending: { default: 25000 }, medicalExpenses: { default: 10000 }, hsaMedicalOnly: true,
  });
  const y = row(r, 2000);
  approx(y.totals.withdrawal, 35000);   // fully funded: a real need beats a false shortfall
  approx(y.accounts.hsa.withdrawal, 30000);
  approx(y.totals.shortfall, 0);
});

test('tax mode: the HSA share is tax-free and only the spillover gets grossed up', () => {
  const base = {
    startYear: 2030, endYear: 2030,
    accounts: [
      { id: 'hsa', balance: 200000, taxStatus: 'hsa' },
      { id: 'ira', balance: 1000000, taxStatus: 'taxDeferred' },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 },
    spending: { default: 40000 },
    filingStatus: 'single', taxTables, anchorYear: 2026, birthYear: 1990,
  };
  const covered = row(projectDecumulation({ ...base, medicalExpenses: { default: 15000 } }), 2030);
  approx(covered.accounts.hsa.withdrawal, 15000);
  // Net of tax, the portfolio delivered exactly the year's total need (spending + medical).
  approx(covered.totals.withdrawal - covered.totals.tax, 55000, 0.05);

  // With no HSA at all, the SAME $55k need must come entirely from the IRA — so the tax bill is
  // strictly larger: every medical dollar is now ordinary income that has to be grossed up.
  const noHsa = row(projectDecumulation({
    ...base,
    accounts: [{ id: 'ira', balance: 1000000, taxStatus: 'taxDeferred' }],
    medicalExpenses: { default: 15000 },
  }), 2030);
  approx(noHsa.totals.withdrawal - noHsa.totals.tax, 55000, 0.05);
  assert.ok(noHsa.totals.tax > covered.totals.tax + 1000, `${noHsa.totals.tax} > ${covered.totals.tax}`);
});

test('tax mode: a forced RMD and an HSA medical floor coexist without double-counting', () => {
  const r = projectDecumulation({
    startYear: 2030, endYear: 2030,
    accounts: [
      { id: 'hsa', balance: 200000, taxStatus: 'hsa' },
      { id: 'ira', balance: 1000000, taxStatus: 'taxDeferred' },
      { id: 'brk', balance: 200000, taxStatus: 'taxable', basisFraction: 1 },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 },
    spending: { default: 10000 }, medicalExpenses: { default: 15000 },
    filingStatus: 'single', taxTables, anchorYear: 2026, birthYear: 1955, // age 75 -> RMDs forced
  });
  const y = row(r, 2030);
  assert.ok(y.accounts.ira.withdrawal > 0, 'RMD forced from the IRA');
  approx(y.accounts.hsa.withdrawal, 15000);   // the medical floor, unaffected by the RMD
  // RMD-forced surplus beyond the year's need is reinvested, not lost.
  approx(
    y.totals.withdrawal - y.totals.tax - y.totals.reinvestment,
    25000,
    0.05,
  );
});

test('REGRESSION: omitting the medical settings reproduces the pre-feature projection exactly', () => {
  const base = {
    startYear: 2030, endYear: 2045,
    accounts: [
      { id: 'hsa', balance: 100000, taxStatus: 'hsa' },
      { id: 'ira', balance: 900000, taxStatus: 'taxDeferred' },
      { id: 'brk', balance: 400000, taxStatus: 'taxable', basisFraction: 0.5 },
    ],
    returnRate: { default: 0.05 }, inflation: { default: 0.025 }, spending: { default: 60000 },
    filingStatus: 'single', taxTables, anchorYear: 2026, birthYear: 1965,
  };
  const without = projectDecumulation(base);
  const zeroed = projectDecumulation({ ...base, medicalExpenses: { default: 0 }, medicalInflation: { default: 0.06 } });
  for (let i = 0; i < without.years.length; i++) {
    approx(zeroed.years[i].totals.endBalance, without.years[i].totals.endBalance, 1e-6);
    approx(zeroed.years[i].totals.tax, without.years[i].totals.tax, 1e-6);
    approx(zeroed.years[i].totals.medicalExpense, 0);
  }
});
