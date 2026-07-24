// project.test.js — golden-number tests for the accumulation engine (design doc §4.1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectAccumulation } from '../engine/project.js';

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const last = (r) => r.years[r.years.length - 1];
const total = (r, year) => r.years.find((y) => y.year === year).totals.endBalance;

test('baseline row holds current balances with no flows', () => {
  const r = projectAccumulation({
    startYear: 2026, endYear: 2026,
    accounts: [{ id: 'a', balance: 100000 }],
    returnRate: { default: 0.1 },
  });
  assert.equal(r.years.length, 1);
  assert.deepEqual(r.years[0].totals, { startBalance: 100000, contribution: 0, growth: 0, endBalance: 100000, conversion: 0 });
  assert.equal(r.years[0].real.endBalance, 100000);
});

test('flat 10% growth, no contributions, compounds correctly', () => {
  const r = projectAccumulation({
    startYear: 2000, endYear: 2003,
    accounts: [{ id: 'a', balance: 100000 }],
    returnRate: { default: 0.1 },
  });
  approx(total(r, 2000), 100000);
  approx(total(r, 2001), 110000);
  approx(total(r, 2002), 121000);
  approx(total(r, 2003), 133100);
  // no inflation -> real equals nominal
  approx(last(r).real.endBalance, 133100);
});

test('contributions land at year-end (no growth the year contributed)', () => {
  const r = projectAccumulation({
    startYear: 2000, endYear: 2002,
    accounts: [{ id: 'a', balance: 0 }],
    returnRate: { default: 0.1 },
    contributions: { default: 1000 },
  });
  approx(total(r, 2000), 0);
  approx(total(r, 2001), 1000);        // 0*1.1 + 1000
  approx(total(r, 2002), 2100);        // 1000*1.1 + 1000
});

test('wage growth escalates contributions', () => {
  const r = projectAccumulation({
    startYear: 2000, endYear: 2002,
    accounts: [{ id: 'a', balance: 0 }],
    returnRate: { default: 0 },
    contributions: { default: 1000 },
    wageGrowth: { default: 0.1 },
  });
  approx(total(r, 2001), 1100);        // contribution 1000*1.1
  approx(total(r, 2002), 2310);        // 1100 + 1000*1.21
});

test("inflation deflates nominal to today's dollars", () => {
  const r = projectAccumulation({
    startYear: 2000, endYear: 2002,
    accounts: [{ id: 'a', balance: 100000 }],
    returnRate: { default: 0 },
    inflation: { default: 0.05 },
  });
  approx(total(r, 2002), 100000);                       // nominal unchanged (0% return)
  approx(r.years.find((y) => y.year === 2001).real.endBalance, 100000 / 1.05);
  approx(last(r).real.endBalance, 100000 / (1.05 * 1.05));
});

test('per-account return override via the resolver', () => {
  const r = projectAccumulation({
    startYear: 2000, endYear: 2001,
    accounts: [{ id: 'stocks', balance: 1000 }, { id: 'cash', balance: 1000 }],
    returnRate: { default: 0.1, byAccount: { cash: 0 } },
  });
  const y = r.years.find((x) => x.year === 2001);
  approx(y.accounts.stocks.endBalance, 1100);
  approx(y.accounts.cash.endBalance, 1000);
  approx(y.totals.endBalance, 2100);
});

test('per-year return override via the resolver', () => {
  const r = projectAccumulation({
    startYear: 2000, endYear: 2002,
    accounts: [{ id: 'a', balance: 1000 }],
    returnRate: { default: 0.1, byYear: { 2002: -0.5 } },
  });
  approx(total(r, 2001), 1100);        // +10%
  approx(total(r, 2002), 550);         // 1100 * (1 - 0.5)
});

test('growth field equals startBalance * rate', () => {
  const r = projectAccumulation({
    startYear: 2000, endYear: 2001,
    accounts: [{ id: 'a', balance: 2000 }],
    returnRate: { default: 0.08 },
    contributions: { default: 500 },
  });
  const y = r.years.find((x) => x.year === 2001);
  approx(y.accounts.a.growth, 160);            // 2000 * 0.08
  approx(y.accounts.a.contribution, 500);
  approx(y.accounts.a.endBalance, 2660);       // 2000*1.08 + 500
});

test('invalid inputs throw', () => {
  assert.throws(() => projectAccumulation({ startYear: 2005, endYear: 2000, accounts: [] }));
  assert.throws(() => projectAccumulation({ startYear: 2000.5, endYear: 2001, accounts: [] }));
  assert.throws(() => projectAccumulation({ startYear: 2000, endYear: 2001, accounts: 'nope' }));
});

test('missing settings default to zero (no growth, no contributions)', () => {
  const r = projectAccumulation({
    startYear: 2000, endYear: 2003,
    accounts: [{ id: 'a', balance: 5000 }],
  });
  approx(last(r).totals.endBalance, 5000);
  approx(last(r).real.endBalance, 5000);
});
