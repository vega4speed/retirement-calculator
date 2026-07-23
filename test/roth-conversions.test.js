// roth-conversions.test.js — golden-number tests for Roth conversions (design doc §5, the
// deferred stretch half of Phase 6): in the gap years before RMDs are forced, convert whatever
// bracket-fill ceiling room the spending withdrawal didn't use from tax-deferred into Roth,
// funding the conversion's own tax from other accounts so the FULL converted amount lands intact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { projectDecumulation } from '../engine/project.js';

const approx = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} (Δ=${Math.abs(a - b)})`);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const taxTables = JSON.parse(readFileSync(join(root, 'data/tax-tables.json'), 'utf8'));
const row = (r, year) => r.years.find((y) => y.year === year);

test('converts the unused 12%-bracket room to Roth, fully preserved, tax funded from taxable (exact algebra)', () => {
  // Ceiling (12% bracket top 50400 + stdDeduction 16100) = 66500 gross ordinary.
  // Spending target 10000 << ceiling -> IRA withdrawal for spending = 10000 (all under the std
  // deduction, $0 tax on its own). Room left = 66500 - 10000 = 56500 -> convert 56500 more from
  // IRA to Roth. That pins ordinary withdrawal at exactly 66500 (taxable income exactly 50400,
  // the bracket's top) regardless of how much MORE gets drawn from taxable to cover tax -- so
  // ordinary tax is fixed at 12400*0.10 + 38000*0.12 = 5800, and every extra dollar drawn from
  // taxable (brk, basisFraction 0) is taxed at a flat 15% LTCG rate (base 50400 already clears
  // the 0% LTCG threshold of 49450, and stays far below the next LTCG boundary at 545500).
  // netAchieved(extra) = (66500+extra) - (5800 + 0.15*extra) - 56500(diverted) = 4200 + 0.85*extra.
  // Solve netAchieved = 10000 -> extra = 5800/0.85 = 6823.529411764706.
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [
      { id: 'ira', balance: 10000000, taxStatus: 'taxDeferred' },
      { id: 'brk', balance: 10000000, taxStatus: 'taxable', basisFraction: 0 },
      { id: 'roth', balance: 0, taxStatus: 'roth' },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 10000 },
    filingStatus: 'single', taxTables, anchorYear: 2026, birthYear: 1990,
    sequencing: 'bracketFill', bracketFillRate: 0.12, rothConversionsEnabled: true,
  });
  const y = row(r, 2026);
  const extra = 5800 / 0.85;
  approx(y.accounts.ira.withdrawal, 66500);
  approx(y.accounts.brk.withdrawal, extra);
  approx(y.accounts.roth.conversion, 56500);
  approx(y.accounts.roth.endBalance, 56500);
  approx(y.totals.conversion, 56500);
  approx(y.totals.tax, 5800 + 0.15 * extra);
  approx(y.totals.netSpendable, 10000); // the conversion never touches what you actually spend
});

test('disabled by default: bracketFill alone does not convert anything', () => {
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [
      { id: 'ira', balance: 10000000, taxStatus: 'taxDeferred' },
      { id: 'roth', balance: 0, taxStatus: 'roth' },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 10000 },
    filingStatus: 'single', taxTables, anchorYear: 2026, birthYear: 1990,
    sequencing: 'bracketFill', bracketFillRate: 0.12,
  });
  const y = row(r, 2026);
  approx(y.accounts.roth.conversion, 0, 1e-6);
  approx(y.accounts.roth.endBalance, 0, 1e-6);
  approx(y.totals.conversion, 0, 1e-6);
});

test('stops once RMDs are being forced -- no conversions past the SECURE 2.0 required-beginning age', () => {
  // birthYear 1950 -> age 76 in 2026, well past the required beginning age (73).
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [
      { id: 'ira', balance: 1000000, taxStatus: 'taxDeferred' },
      { id: 'roth', balance: 0, taxStatus: 'roth' },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 10000 },
    filingStatus: 'single', taxTables, anchorYear: 2026, birthYear: 1950,
    sequencing: 'bracketFill', bracketFillRate: 0.12, rothConversionsEnabled: true,
  });
  const y = row(r, 2026);
  approx(y.totals.conversion, 0, 1e-6);
  // The RMD still gets forced as normal, unaffected by rothConversionsEnabled being set.
  const rmd = 1000000 / 23.7;
  approx(y.accounts.ira.withdrawal, rmd, 1e-6);
});

test('conversion is capped by the remaining tax-deferred balance, not just the bracket ceiling', () => {
  // A small IRA: spending draws some of it, and what's left is far less than the 56500 of
  // ceiling room that would otherwise be available -- the conversion should exactly drain it.
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [
      { id: 'ira', balance: 15000, taxStatus: 'taxDeferred' },
      { id: 'brk', balance: 10000000, taxStatus: 'taxable', basisFraction: 0 },
      { id: 'roth', balance: 0, taxStatus: 'roth' },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 5000 },
    filingStatus: 'single', taxTables, anchorYear: 2026, birthYear: 1990,
    sequencing: 'bracketFill', bracketFillRate: 0.12, rothConversionsEnabled: true,
  });
  const y = row(r, 2026);
  approx(y.accounts.ira.withdrawal, 15000, 1e-6); // fully drained: 5000 for spending + 10000 converted
  approx(y.accounts.roth.conversion, 10000, 1e-6);
  approx(y.accounts.ira.endBalance, 0, 1e-6);
});

test('no Roth account to convert into -> no crash, conversionAmount stays 0', () => {
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [{ id: 'ira', balance: 1000000, taxStatus: 'taxDeferred' }],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 10000 },
    filingStatus: 'single', taxTables, anchorYear: 2026, birthYear: 1990,
    sequencing: 'bracketFill', bracketFillRate: 0.12, rothConversionsEnabled: true,
  });
  const y = row(r, 2026);
  approx(y.totals.conversion, 0, 1e-6);
});

test('rothConversionsEnabled has no effect outside bracketFill sequencing', () => {
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [
      { id: 'ira', balance: 10000000, taxStatus: 'taxDeferred' },
      { id: 'roth', balance: 0, taxStatus: 'roth' },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 10000 },
    filingStatus: 'single', taxTables, anchorYear: 2026, birthYear: 1990,
    sequencing: 'conventional', rothConversionsEnabled: true,
  });
  const y = row(r, 2026);
  approx(y.totals.conversion, 0, 1e-6);
});

test('no birthYear (no RMD concept) still allows conversions -- no age gate to apply', () => {
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [
      { id: 'ira', balance: 10000000, taxStatus: 'taxDeferred' },
      { id: 'brk', balance: 10000000, taxStatus: 'taxable', basisFraction: 0 },
      { id: 'roth', balance: 0, taxStatus: 'roth' },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 10000 },
    filingStatus: 'single', taxTables, anchorYear: 2026,
    sequencing: 'bracketFill', bracketFillRate: 0.12, rothConversionsEnabled: true,
  });
  const y = row(r, 2026);
  approx(y.totals.conversion, 56500);
});
