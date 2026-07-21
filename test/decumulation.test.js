// decumulation.test.js — golden-number tests for projectDecumulation() and project()
// (design doc §4.2/§5, Phase 3: spending, withdrawal sequencing, portfolio survival, pre-tax).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectDecumulation, project } from '../engine/project.js';

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const row = (r, year) => r.years.find((y) => y.year === year);

test('flat spending, no growth, no inflation: balance drains by the spending amount each year', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2003,
    accounts: [{ id: 'a', balance: 10000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 1000 },
  });
  approx(row(r, 2000).totals.endBalance, 9000);
  approx(row(r, 2001).totals.endBalance, 8000);
  approx(row(r, 2002).totals.endBalance, 7000);
  approx(row(r, 2003).totals.endBalance, 6000);
  approx(row(r, 2000).totals.withdrawal, 1000);
  approx(row(r, 2000).real.endBalance, 9000); // no inflation -> real == nominal
  assert.equal(r.firstDepletionYear, null);
});

test('withdrawal happens at start of year; growth applies only to the remainder', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2000,
    accounts: [{ id: 'a', balance: 10000, taxStatus: 'taxable' }],
    returnRate: { default: 0.1 }, inflation: { default: 0 }, spending: { default: 1000 },
  });
  const y = row(r, 2000);
  approx(y.accounts.a.withdrawal, 1000);
  approx(y.accounts.a.growth, 900);       // (10000-1000)*0.1
  approx(y.accounts.a.endBalance, 9900);  // 9000*1.1
});

test('inflation grows nominal spending while real spending stays flat', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2002,
    accounts: [{ id: 'a', balance: 1000000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0.05 }, spending: { default: 1000 },
  });
  approx(row(r, 2000).totals.spendingNeed, 1050);
  approx(row(r, 2001).totals.spendingNeed, 1102.5);
  approx(row(r, 2002).totals.spendingNeed, 1157.625);
  for (const y of [2000, 2001, 2002]) approx(row(r, y).real.spendingNeed, 1000);
});

test('otherIncome (pension/rental placeholder) offsets the gap funded from accounts', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2000,
    accounts: [{ id: 'a', balance: 1000000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0 },
    spending: { default: 1000 }, otherIncome: { default: 400 },
  });
  const y = row(r, 2000);
  approx(y.totals.spendingNeed, 1000);
  approx(y.totals.otherIncome, 400);
  approx(y.totals.gap, 600);
  approx(y.totals.withdrawal, 600);
});

test('conventional sequencing drains cash before taxable when both present', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2000,
    accounts: [
      { id: 'cash', balance: 500, taxStatus: 'cash' },
      { id: 'brk', balance: 10000, taxStatus: 'taxable' },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 800 },
    sequencing: 'conventional',
  });
  const y = row(r, 2000);
  approx(y.accounts.cash.withdrawal, 500);   // exhausted first
  approx(y.accounts.brk.withdrawal, 300);    // remainder from taxable
});

test('conventional order across all five tax statuses: cash, taxable, taxDeferred, hsa, roth', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2000,
    accounts: [
      { id: 'roth', balance: 1000, taxStatus: 'roth' },
      { id: 'hsa', balance: 1000, taxStatus: 'hsa' },
      { id: 'deferred', balance: 1000, taxStatus: 'taxDeferred' },
      { id: 'taxable', balance: 1000, taxStatus: 'taxable' },
      { id: 'cash', balance: 1000, taxStatus: 'cash' },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 2500 },
    sequencing: 'conventional',
  });
  const y = row(r, 2000);
  approx(y.accounts.cash.withdrawal, 1000);
  approx(y.accounts.taxable.withdrawal, 1000);
  approx(y.accounts.deferred.withdrawal, 500); // gap exhausted partway through the 3rd bucket
  approx(y.accounts.hsa.withdrawal, 0);
  approx(y.accounts.roth.withdrawal, 0);
});

test('proportional sequencing splits the gap by balance share', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2000,
    accounts: [{ id: 'a', balance: 1000, taxStatus: 'taxable' }, { id: 'b', balance: 3000, taxStatus: 'roth' }],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 400 },
    sequencing: 'proportional',
  });
  const y = row(r, 2000);
  approx(y.accounts.a.withdrawal, 100);  // 400 * 1000/4000
  approx(y.accounts.b.withdrawal, 300);  // 400 * 3000/4000
});

test('proportional withdrawal never overdraws a single account (share <= balance whenever gap <= total)', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2000,
    accounts: [{ id: 'small', balance: 10, taxStatus: 'taxable' }, { id: 'big', balance: 1000, taxStatus: 'roth' }],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 500 },
    sequencing: 'proportional',
  });
  const y = row(r, 2000);
  assert.ok(y.accounts.small.withdrawal <= 10 + 1e-9);
  approx(y.accounts.small.withdrawal, 500 * (10 / 1010));
  approx(y.totals.shortfall, 0);
});

test('portfolio depletion: shortfall tracked, balance floors at 0, firstDepletionYear set', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2002,
    accounts: [{ id: 'a', balance: 100, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 1000 },
  });
  approx(row(r, 2000).totals.withdrawal, 100);
  approx(row(r, 2000).totals.shortfall, 900);
  approx(row(r, 2000).totals.endBalance, 0);
  approx(row(r, 2001).totals.withdrawal, 0);
  approx(row(r, 2001).totals.shortfall, 1000);
  approx(row(r, 2001).totals.endBalance, 0);
  assert.equal(r.firstDepletionYear, 2000);
});

test('fixedPercent strategy withdraws a percentage of the CURRENT start-of-year balance each year', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2001,
    accounts: [{ id: 'a', balance: 10000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0 },
    strategy: 'fixedPercent', withdrawalPercent: { default: 0.04 },
  });
  approx(row(r, 2000).totals.withdrawal, 400);   // 10000 * 4%
  approx(row(r, 2000).totals.endBalance, 9600);
  approx(row(r, 2001).totals.withdrawal, 384);   // 9600 * 4% -- self-correcting
});

test('startCumulativeInflation carries forward correctly (continuity from accumulation)', () => {
  const r = projectDecumulation({
    startYear: 2010, endYear: 2010,
    accounts: [{ id: 'a', balance: 1000000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0.1 }, spending: { default: 100 },
    startCumulativeInflation: 2,
  });
  // cumInflation should become 2 * 1.1 = 2.2, so nominal spending = 100 * 2.2 = 220
  approx(row(r, 2010).cumulativeInflation, 2.2);
  approx(row(r, 2010).totals.spendingNeed, 220);
});

test('missing settings default sensibly (no spending -> no withdrawal, balance just grows)', () => {
  const r = projectDecumulation({
    startYear: 2000, endYear: 2001,
    accounts: [{ id: 'a', balance: 1000, taxStatus: 'taxable' }],
    returnRate: { default: 0.1 },
  });
  approx(row(r, 2000).totals.withdrawal, 0);
  approx(row(r, 2000).totals.endBalance, 1100);
});

test('invalid inputs throw', () => {
  assert.throws(() => projectDecumulation({ startYear: 2005, endYear: 2000, accounts: [] }));
  assert.throws(() => projectDecumulation({ startYear: 2000, endYear: 2001, accounts: 'nope' }));
});

test('project(): full accumulation->decumulation pipeline is one continuous, correctly tagged series', () => {
  const r = project({
    baseYear: 2000, retirementYear: 2002, horizonYear: 2004,
    accounts: [{ id: 'a', balance: 0, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, contributions: { default: 1000 }, wageGrowth: { default: 0 },
    inflation: { default: 0 }, spending: { default: 700 }, sequencing: 'conventional',
  });
  assert.equal(r.years.length, 5); // 2000,2001,2002 (accumulation) + 2003,2004 (decumulation)
  assert.deepEqual(r.years.map((y) => y.year), [2000, 2001, 2002, 2003, 2004]);
  assert.deepEqual(r.years.map((y) => y.phase), ['accumulation', 'accumulation', 'accumulation', 'decumulation', 'decumulation']);
  // accumulation: 0 -> 1000 -> 2000 (matches project.test.js's contribution-timing case)
  approx(row(r, 2002).totals.endBalance, 2000);
  // decumulation continuity: 2003's start balance equals 2002's ending balance
  approx(row(r, 2003).totals.startBalance, 2000);
  approx(row(r, 2003).totals.endBalance, 1300);  // 2000 - 700
  approx(row(r, 2004).totals.endBalance, 600);   // 1300 - 700
  assert.equal(r.firstDepletionYear, null);
});

test('project(): horizonYear === retirementYear yields accumulation only, no decumulation rows', () => {
  const r = project({
    baseYear: 2000, retirementYear: 2002, horizonYear: 2002,
    accounts: [{ id: 'a', balance: 1000, taxStatus: 'taxable' }],
    returnRate: { default: 0 },
  });
  assert.equal(r.years.length, 3);
  assert.ok(r.years.every((y) => y.phase === 'accumulation'));
  assert.equal(r.firstDepletionYear, null);
});

test('project(): horizonYear < retirementYear throws', () => {
  assert.throws(() => project({
    baseYear: 2000, retirementYear: 2010, horizonYear: 2005,
    accounts: [{ id: 'a', balance: 1000, taxStatus: 'taxable' }],
    returnRate: { default: 0 },
  }));
});
