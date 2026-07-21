// social-security-decumulation.test.js — Phase 5 integration: wiring a benefit stream (claiming
// year, COLA, solvency haircut, taxation) into projectDecumulation()/project().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { projectDecumulation, project } from '../engine/project.js';
import { taxableSocialSecurity, ordinaryTax, standardDeduction, resolveYearTable } from '../engine/tax.js';
import { estimatePIA, benefitAtClaimingAge, fullRetirementAge } from '../engine/socialsecurity.js';

const approx = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} (Δ=${Math.abs(a - b)})`);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const taxTables = JSON.parse(readFileSync(join(root, 'data/tax-tables.json'), 'utf8'));
const row = (r, year) => r.years.find((y) => y.year === year);

test('Social Security offsets the spending gap dollar-for-dollar, even pre-tax (no filingStatus/taxTables)', () => {
  const r = projectDecumulation({
    startYear: 2028, endYear: 2032,
    accounts: [{ id: 'a', balance: 10000000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 30000 },
    socialSecurityStartingBenefit: 20000, socialSecurityClaimingYear: 2030,
  });
  approx(row(r, 2028).totals.socialSecurity, 0);
  approx(row(r, 2029).totals.socialSecurity, 0);
  approx(row(r, 2030).totals.socialSecurity, 20000);
  approx(row(r, 2028).totals.withdrawal, 30000);
  approx(row(r, 2030).totals.withdrawal, 10000); // 30000 - 20000
  approx(row(r, 2032).totals.withdrawal, 10000);
});

test('COLA compounds from the year AFTER claiming, not the claiming year itself', () => {
  const r = projectDecumulation({
    startYear: 2030, endYear: 2032,
    accounts: [{ id: 'a', balance: 10000000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 0 },
    socialSecurityStartingBenefit: 20000, socialSecurityClaimingYear: 2030,
    colaRate: { default: 0.02 },
  });
  approx(row(r, 2030).totals.socialSecurity, 20000);        // claiming year: no COLA yet
  approx(row(r, 2031).totals.socialSecurity, 20000 * 1.02);
  approx(row(r, 2032).totals.socialSecurity, 20000 * 1.02 * 1.02);
});

test('REGRESSION: COLA still compounds correctly when claiming happened before this run starts', () => {
  // Bug (fixed 2026-07-21): if Social Security is claimed before projectDecumulation's startYear
  // (e.g. claimed while still in the accumulation phase, which this function never iterates),
  // cumCOLA started at 1 unconditionally -- silently skipping every year of COLA that should
  // have accrued between the claiming year and startYear, understating every subsequent payment.
  // Claimed in 2020; this run only starts in 2030 (10 skipped years must still count).
  const r = projectDecumulation({
    startYear: 2030, endYear: 2030,
    accounts: [{ id: 'a', balance: 10000000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 0 },
    socialSecurityStartingBenefit: 20000, socialSecurityClaimingYear: 2020,
    colaRate: { default: 0.02 },
  });
  approx(row(r, 2030).totals.socialSecurity, 20000 * Math.pow(1.02, 10));
});

test('solvency haircut multiplies the benefit from its start year onward', () => {
  const r = projectDecumulation({
    startYear: 2030, endYear: 2034,
    accounts: [{ id: 'a', balance: 10000000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 0 },
    socialSecurityStartingBenefit: 20000, socialSecurityClaimingYear: 2030,
    solvencyHaircutStartYear: 2033, solvencyHaircutFactor: 0.77,
  });
  approx(row(r, 2032).totals.socialSecurity, 20000);
  approx(row(r, 2033).totals.socialSecurity, 20000 * 0.77);
  approx(row(r, 2034).totals.socialSecurity, 20000 * 0.77);
});

test('taxableSocialSecurity wires correctly into the gross-up tax calc (self-consistency check)', () => {
  // A real withdrawal is needed alongside SS (spending exceeds SS alone), so the provisional-
  // income test and the ordinary-income tax genuinely interact. Rather than hand-deriving the
  // fixed point (SS taxability is itself piecewise-tiered on the withdrawal amount), verify
  // internal consistency: recompute tax from the engine's OWN reported withdrawal/taxableSS
  // using the same tax.js primitives and confirm an exact match.
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [{ id: 'ira', balance: 2000000, taxStatus: 'taxDeferred' }],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 40000 },
    filingStatus: 'single', taxTables, anchorYear: 2026,
    socialSecurityStartingBenefit: 20000, socialSecurityClaimingYear: 2026,
  });
  const y = row(r, 2026);
  assert.ok(y.totals.socialSecurity > 0);
  assert.ok(y.totals.taxableSocialSecurity > 0, 'SS should be partially taxable given the withdrawal alongside it');

  const yearTable = resolveYearTable({ tables: taxTables, year: 2026, anchorYear: 2026 });
  const expectedTaxableSS = taxableSocialSecurity(y.totals.socialSecurity, y.accounts.ira.withdrawal, 'single', taxTables.fixed);
  approx(y.totals.taxableSocialSecurity, expectedTaxableSS, 0.01);

  const stdDed = standardDeduction({ filingStatus: 'single', age65Count: 0, yearTable });
  const expectedOrdinaryTaxableIncome = Math.max(0, y.accounts.ira.withdrawal + expectedTaxableSS - stdDed);
  approx(y.totals.ordinaryTaxableIncome, expectedOrdinaryTaxableIncome, 0.01);
  approx(y.totals.tax, ordinaryTax(expectedOrdinaryTaxableIncome, 'single', yearTable), 0.01);
});

test('low-income scenario: Social Security stays entirely untaxed (below the provisional-income tier)', () => {
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [{ id: 'ira', balance: 2000000, taxStatus: 'taxDeferred' }],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 20000 },
    filingStatus: 'single', taxTables, anchorYear: 2026,
    socialSecurityStartingBenefit: 20000, socialSecurityClaimingYear: 2026,
  });
  const y = row(r, 2026);
  // spending 20000 fully covered by SS (20000) -> gap 0 -> no withdrawal -> provisional income
  // is just half of SS -> well under tier50 (25000 single) -> nothing taxable.
  approx(y.accounts.ira.withdrawal, 0);
  approx(y.totals.taxableSocialSecurity, 0);
  approx(y.totals.tax, 0);
});

test('project(): the starting benefit matches a direct estimatePIA + benefitAtClaimingAge call', () => {
  const earnings = { default: 60000 };
  const careerStartYear = 2000;
  const birthYear = 1964; // turns 62 in 2026 (matches the anchor year, no bend-point indexing needed)
  const claimingAge = 67;

  const result = project({
    baseYear: 2026, retirementYear: 2030, horizonYear: 2032,
    accounts: [{ id: 'a', balance: 500000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, contributions: { default: 0 }, wageGrowth: { default: 0 },
    inflation: { default: 0 }, spending: { default: 0 },
    filingStatus: 'single', taxTables, anchorYear: 2026, birthYear,
    earnings, careerStartYear, claimingAge,
  });

  const pia = estimatePIA({ earnings, careerStartYear, retirementYear: 2030, birthYear, tables: taxTables, anchorYear: 2026 });
  const fra = fullRetirementAge(birthYear);
  const expectedBenefit = benefitAtClaimingAge(pia, claimingAge, fra, taxTables.socialSecurity);
  const claimingYear = birthYear + claimingAge; // 2031

  approx(row(result, claimingYear).totals.socialSecurity, expectedBenefit);
});

test('project(): Social Security requires anchorYear even without full tax mode active for it', () => {
  assert.throws(() => project({
    baseYear: 2026, retirementYear: 2026, horizonYear: 2027,
    accounts: [{ id: 'a', balance: 100000, taxStatus: 'taxable' }],
    returnRate: { default: 0 }, taxTables, birthYear: 1964,
    earnings: { default: 60000 }, careerStartYear: 2000, claimingAge: 67,
    // anchorYear deliberately omitted
  }));
});
