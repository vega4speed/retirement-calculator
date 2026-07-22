// max-sustainable.test.js — golden-number tests for solveMaxSustainableSpending() (design doc
// §9: "what's the safe real spending it does support?"). Uses a 0%-return, 0%-inflation, no-tax
// scenario so the answer is exactly balance / (number of decumulation years) — hand-solvable,
// not just plausible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { solveMaxSustainableSpending, project } from '../engine/project.js';

const approx = (a, b, eps = 1) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} (Δ=${Math.abs(a - b)})`);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const taxTables = JSON.parse(readFileSync(join(root, 'data/tax-tables.json'), 'utf8'));

test('solves exactly balance / decumulation-years with 0% return, 0% inflation, no tax', () => {
  // baseYear 2026, retirementYear 2026 (no accumulation years), horizonYear 2036 ->
  // decumulation years 2027..2036 = 10 years. Balance 1,000,000 / 10 = 100,000/yr exactly.
  const { spending, result } = solveMaxSustainableSpending({
    baseYear: 2026, retirementYear: 2026, horizonYear: 2036,
    accounts: [{ id: 'a', balance: 1000000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0 },
  });
  approx(spending, 100000);
  assert.equal(result.firstDepletionYear, null);
  const lastYear = result.years[result.years.length - 1];
  approx(lastYear.totals.endBalance, 0, 5);
});

test('a slightly higher spend than the solved max genuinely fails to last', () => {
  const { spending } = solveMaxSustainableSpending({
    baseYear: 2026, retirementYear: 2026, horizonYear: 2036,
    accounts: [{ id: 'a', balance: 1000000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0 },
  });
  const tooMuch = project({
    baseYear: 2026, retirementYear: 2026, horizonYear: 2036,
    accounts: [{ id: 'a', balance: 1000000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0 },
    strategy: 'fixedReal', spending: { default: spending + 5000 },
  });
  assert.notEqual(tooMuch.firstDepletionYear, null);
});

test('a comfortably lower spend than the solved max lasts with balance to spare', () => {
  const { spending } = solveMaxSustainableSpending({
    baseYear: 2026, retirementYear: 2026, horizonYear: 2036,
    accounts: [{ id: 'a', balance: 1000000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0 },
  });
  const comfortable = project({
    baseYear: 2026, retirementYear: 2026, horizonYear: 2036,
    accounts: [{ id: 'a', balance: 1000000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0 },
    strategy: 'fixedReal', spending: { default: spending - 5000 },
  });
  assert.equal(comfortable.firstDepletionYear, null);
  const lastYear = comfortable.years[comfortable.years.length - 1];
  assert.ok(lastYear.totals.endBalance > 40000, 'should end with meaningfully more than $0 left over');
});

test('more starting balance solves to a higher sustainable spend (monotonic sanity check)', () => {
  const solveWithBalance = (balance) => solveMaxSustainableSpending({
    baseYear: 2026, retirementYear: 2026, horizonYear: 2036,
    accounts: [{ id: 'a', balance, taxStatus: 'taxable' }],
    returnRate: { default: 0.05 }, inflation: { default: 0.02 },
  }).spending;
  assert.ok(solveWithBalance(2000000) > solveWithBalance(1000000));
});

test('no decumulation phase (horizonYear === retirementYear) -> spending is null, no crash', () => {
  const { spending, result } = solveMaxSustainableSpending({
    baseYear: 2026, retirementYear: 2026, horizonYear: 2026,
    accounts: [{ id: 'a', balance: 1000000, taxStatus: 'taxable' }],
    returnRate: { default: 0.05 },
  });
  assert.equal(spending, null);
  assert.equal(result.retirementYear, result.horizonYear);
});

test('with real federal tax enabled, the solve still converges to a genuinely-lasting result', () => {
  const { spending, result } = solveMaxSustainableSpending({
    baseYear: 2026, retirementYear: 2026, horizonYear: 2046,
    accounts: [{ id: 'ira', balance: 800000, taxStatus: 'taxDeferred' }],
    returnRate: { default: 0.05 }, inflation: { default: 0.025 },
    filingStatus: 'single', taxTables, anchorYear: 2026, birthYear: 1960,
  });
  assert.ok(spending > 0);
  assert.equal(result.firstDepletionYear, null);
});
