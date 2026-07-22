// tax.test.js — golden-number tests for the tax engine (design doc §8, Phase 4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  bracketTax,
  bracketBreakdown,
  bracketTopForRate,
  resolveYearTable,
  ordinaryTax,
  standardDeduction,
  capitalGainsTax,
  taxableSocialSecurity,
  requiredBeginningAge,
  rmdDivisor,
  rmdAmount,
} from '../engine/tax.js';

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const realTables = JSON.parse(readFileSync(join(root, 'data/tax-tables.json'), 'utf8'));

const BRACKETS = [{ upTo: 10000, rate: 0.10 }, { upTo: 40000, rate: 0.20 }, { upTo: null, rate: 0.30 }];

test('bracketTax: within the first bracket', () => approx(bracketTax(5000, BRACKETS), 500));
test('bracketTax: exactly at a boundary', () => approx(bracketTax(10000, BRACKETS), 1000));
test('bracketTax: spans two brackets', () => approx(bracketTax(25000, BRACKETS), 1000 + 15000 * 0.20));
test('bracketTax: spans into the top (uncapped) bracket', () =>
  approx(bracketTax(50000, BRACKETS), 1000 + 6000 + 10000 * 0.30));
test('bracketTax: zero/negative income is zero tax', () => {
  approx(bracketTax(0, BRACKETS), 0);
  approx(bracketTax(-500, BRACKETS), 0);
});

test('ordinaryTax against the real, verified 2026 MFJ table', () => {
  const t2026 = resolveYearTable({ tables: realTables, year: 2026, anchorYear: 2026 });
  // 10%*24800 + 12%*(100000-24800)
  approx(ordinaryTax(100000, 'mfj', t2026), 24800 * 0.10 + 75200 * 0.12);
});

test('standardDeduction against real 2026 figures, with and without the age-65 addition', () => {
  const t2026 = resolveYearTable({ tables: realTables, year: 2026, anchorYear: 2026 });
  approx(standardDeduction({ filingStatus: 'single', yearTable: t2026 }), 16100);
  approx(standardDeduction({ filingStatus: 'single', age65Count: 1, yearTable: t2026 }), 16100 + 2050);
  approx(standardDeduction({ filingStatus: 'mfj', age65Count: 1, yearTable: t2026 }), 32200 + 1650);
});

test('capitalGainsTax: gain sits entirely in the 0% bracket', () => {
  const t2026 = resolveYearTable({ tables: realTables, year: 2026, anchorYear: 2026 });
  approx(capitalGainsTax(20000, 0, 'mfj', t2026), 0); // 20000 < 98900 (the 0% ceiling)
});

test('capitalGainsTax: gain straddles the 0% -> 15% boundary (stacked on ordinary income)', () => {
  const t2026 = resolveYearTable({ tables: realTables, year: 2026, anchorYear: 2026 });
  // ordinary income 50000 occupies the first 50000 of the 0% band; gain of 100000 pushes
  // past the 98900 ceiling by 51100, which is taxed at 15%.
  approx(capitalGainsTax(100000, 50000, 'mfj', t2026), 51100 * 0.15);
});

test('capitalGainsTax: gain entirely above the 0% ceiling taxes at a flat 15%', () => {
  const t2026 = resolveYearTable({ tables: realTables, year: 2026, anchorYear: 2026 });
  approx(capitalGainsTax(50000, 120000, 'mfj', t2026), 50000 * 0.15);
});

test('taxableSocialSecurity: below tier50 -> nothing taxable', () => {
  approx(taxableSocialSecurity(20000, 10000, 'single', realTables.fixed), 0);
});

test('taxableSocialSecurity: between tier50 and tier85 -> the 50% tier formula', () => {
  // provisional income = 20000 + 10000 = 30000; between 25000 and 34000
  approx(taxableSocialSecurity(20000, 20000, 'single', realTables.fixed), 2500);
});

test('taxableSocialSecurity: above tier85 -> capped at 85% of benefits', () => {
  // provisional income = 40000 + 10000 = 50000, well above tier85 (34000) -> hits the 85% cap
  approx(taxableSocialSecurity(20000, 40000, 'single', realTables.fixed), 17000);
});

test('taxableSocialSecurity: zero benefits is zero taxable', () => {
  approx(taxableSocialSecurity(0, 100000, 'single', realTables.fixed), 0);
});

test('requiredBeginningAge: birth-year-based SECURE 2.0 rule (73 for 1951-1959, 75 for 1960+)', () => {
  assert.equal(requiredBeginningAge(1955, realTables.rmd), 73);
  assert.equal(requiredBeginningAge(1959, realTables.rmd), 73);
  assert.equal(requiredBeginningAge(1960, realTables.rmd), 75);
  assert.equal(requiredBeginningAge(1975, realTables.rmd), 75);
});

test('rmdDivisor / rmdAmount against the real Uniform Lifetime Table', () => {
  approx(rmdDivisor(75, realTables.rmd.uniformLifetime), 24.6);
  approx(rmdAmount(75, 246000, realTables.rmd), 10000);
  approx(rmdAmount(75, 0, realTables.rmd), 0);
});

test('rmdDivisor clamps outside the table range instead of failing', () => {
  approx(rmdDivisor(50, realTables.rmd.uniformLifetime), 27.4);   // clamps down to age 72's divisor
  approx(rmdDivisor(200, realTables.rmd.uniformLifetime), 2.0);   // clamps up to age 120's divisor
});

test('resolveYearTable at the anchor year returns the raw anchor figures unscaled', () => {
  const t = resolveYearTable({ tables: realTables, year: 2026, anchorYear: 2026 });
  approx(t.standardDeduction.mfj, 32200);
  approx(t.ordinaryBrackets.mfj[0].upTo, 24800);
  approx(t.ltcgBrackets.mfj[0].upTo, 98900);
});

test('resolveYearTable indexes forward by the compounded indexing-rate setting', () => {
  const t = resolveYearTable({
    tables: realTables, year: 2028, anchorYear: 2026,
    bracketIndexingRate: { default: 0.03 }, standardDeductionIndexingRate: { default: 0.03 },
  });
  approx(t.standardDeduction.mfj, 32200 * 1.03 * 1.03);
  approx(t.ordinaryBrackets.mfj[0].upTo, 24800 * 1.03 * 1.03);
});

test('resolveYearTable indexes backward symmetrically', () => {
  const t = resolveYearTable({
    tables: realTables, year: 2024, anchorYear: 2026,
    standardDeductionIndexingRate: { default: 0.03 },
  });
  approx(t.standardDeduction.mfj, 32200 / 1.03 / 1.03);
});

test('resolveYearTable with no indexing-rate settings passed defaults to no indexing', () => {
  const t = resolveYearTable({ tables: realTables, year: 2040, anchorYear: 2026 });
  approx(t.standardDeduction.mfj, 32200);
});

test('resolveYearTable throws for an anchor year not present in the tables', () => {
  assert.throws(() => resolveYearTable({ tables: realTables, year: 2026, anchorYear: 1999 }));
});

test('bracketBreakdown: rows sum to exactly bracketTax(income, brackets)', () => {
  const rows = bracketBreakdown(25000, BRACKETS);
  assert.deepEqual(rows, [
    { upTo: 10000, rate: 0.10, amount: 10000, tax: 1000 },
    { upTo: 40000, rate: 0.20, amount: 15000, tax: 3000 },
  ]);
  const sum = rows.reduce((s, r) => s + r.tax, 0);
  approx(sum, bracketTax(25000, BRACKETS));
});

test('bracketBreakdown: amount of 0 or less returns no rows', () => {
  assert.deepEqual(bracketBreakdown(0, BRACKETS), []);
  assert.deepEqual(bracketBreakdown(-500, BRACKETS), []);
});

test('bracketBreakdown with a base offset matches the capital-gains stacking test exactly', () => {
  // Same scenario as the capitalGainsTax stacking test: ordinary income 50000, gain 100000,
  // 2026 MFJ LTCG brackets (0% to 98900, 15% to 613700, 20% above).
  const t2026 = resolveYearTable({ tables: realTables, year: 2026, anchorYear: 2026 });
  const rows = bracketBreakdown(100000, t2026.ltcgBrackets.mfj, 50000);
  assert.deepEqual(rows, [
    { upTo: 98900, rate: 0.00, amount: 48900, tax: 0 },
    { upTo: 613700, rate: 0.15, amount: 51100, tax: 7665 },
  ]);
  const sum = rows.reduce((s, r) => s + r.tax, 0);
  approx(sum, capitalGainsTax(100000, 50000, 'mfj', t2026));
});

test('bracketTopForRate: finds the ceiling of a matching bracket (real 2026 single table)', () => {
  const t2026 = resolveYearTable({ tables: realTables, year: 2026, anchorYear: 2026 });
  approx(bracketTopForRate(0.12, t2026.ordinaryBrackets.single), 50400);
  approx(bracketTopForRate(0.22, t2026.ordinaryBrackets.single), 105700);
});

test('bracketTopForRate: the top (uncapped) bracket has no ceiling', () => {
  const t2026 = resolveYearTable({ tables: realTables, year: 2026, anchorYear: 2026 });
  assert.equal(bracketTopForRate(0.37, t2026.ordinaryBrackets.single), Infinity);
});

test('bracketTopForRate: a rate that matches no bracket is unconstrained', () => {
  assert.equal(bracketTopForRate(0.99, BRACKETS), Infinity);
});
