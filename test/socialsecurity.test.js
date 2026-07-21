// socialsecurity.test.js — golden-number tests for Phase 5 (design doc §6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fullRetirementAge, estimatePIA, benefitAtClaimingAge } from '../engine/socialsecurity.js';

const approx = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} (Δ=${Math.abs(a - b)})`);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const taxTables = JSON.parse(readFileSync(join(root, 'data/tax-tables.json'), 'utf8'));

test('fullRetirementAge: the stable 1983-Amendments table', () => {
  assert.equal(fullRetirementAge(1937), 65);
  approx(fullRetirementAge(1938), 65 + 2 / 12);
  approx(fullRetirementAge(1942), 65 + 10 / 12);
  assert.equal(fullRetirementAge(1943), 66);
  assert.equal(fullRetirementAge(1954), 66);
  approx(fullRetirementAge(1955), 66 + 2 / 12);
  approx(fullRetirementAge(1959), 66 + 10 / 12);
  assert.equal(fullRetirementAge(1960), 67);
  assert.equal(fullRetirementAge(1990), 67);
});

test('estimatePIA: a flat 35-year career against the real, verified 2026 bend points', () => {
  // birthYear 1964 -> turns 62 in 2026, so this uses the unscaled anchor-year bend points
  // directly (1286/7749). 35 years * $60,000 / 420 = AIME 5000, which lands in the 32% band.
  // PIA = 0.9*1286 + 0.32*(5000-1286) = 1157.4 + 1188.48 = 2345.88
  const pia = estimatePIA({
    earnings: { default: 60000 }, careerStartYear: 2000, retirementYear: 2034,
    birthYear: 1964, tables: taxTables, anchorYear: 2026,
  });
  approx(pia, 2345.88);
});

test('estimatePIA: fewer than 35 working years correctly lowers AIME (missing years count as $0)', () => {
  // 10 years at $60,000 / 420 (still divided by 35*12, not 10*12) = AIME 1428.5714286
  const pia = estimatePIA({
    earnings: { default: 60000 }, careerStartYear: 2010, retirementYear: 2019,
    birthYear: 1964, tables: taxTables, anchorYear: 2026,
  });
  const aime = (10 * 60000) / 420;
  const expected = 0.9 * 1286 + 0.32 * (aime - 1286);
  approx(pia, expected);
});

test('estimatePIA: only the top 35 years count — low years beyond a real 35-year career are dropped', () => {
  // 40 years, the 5 lowest zeroed via override -> top-35 are the 35 real $60,000 years, so this
  // must produce EXACTLY the same PIA as the flat-35-year test above, unaffected by the zeros.
  const pia = estimatePIA({
    earnings: { default: 60000, byYear: { 2000: 0, 2001: 0, 2002: 0, 2003: 0, 2004: 0 } },
    careerStartYear: 2000, retirementYear: 2039, birthYear: 1964, tables: taxTables, anchorYear: 2026,
  });
  approx(pia, 2345.88);
});

test('estimatePIA: bend points scale by wageIndexingRate for a turn-62 year off the anchor', () => {
  // birthYear 1966 -> turns 62 in 2028; anchor is 2026, so bend points compound by 1.03 twice.
  const pia = estimatePIA({
    earnings: { default: 60000 }, careerStartYear: 2000, retirementYear: 2034,
    birthYear: 1966, tables: taxTables, anchorYear: 2026, wageIndexingRate: { default: 0.03 },
  });
  const bend1 = 1286 * 1.03 * 1.03;
  const bend2 = 7749 * 1.03 * 1.03;
  const aime = 5000;
  const expected = 0.9 * bend1 + 0.32 * (aime - bend1);
  assert.ok(aime < bend2); // sanity: still in the 32% band
  approx(pia, expected);
});

test('estimatePIA: invalid inputs throw', () => {
  assert.throws(() => estimatePIA({
    earnings: { default: 1 }, careerStartYear: 2000.5, retirementYear: 2020,
    birthYear: 1964, tables: taxTables, anchorYear: 2026,
  }));
});

test('benefitAtClaimingAge: claiming exactly at FRA leaves the PIA unchanged', () => {
  approx(benefitAtClaimingAge(1000, 67, 67, taxTables.socialSecurity), 12000);
});

test('benefitAtClaimingAge: early claim applies the two-tier actuarial reduction', () => {
  // FRA 67, claim at 62 -> 60 months early: 36 @ 5/9%/mo + 24 @ 5/12%/mo
  const reduction = 36 * 0.005556 + 24 * 0.004167;
  approx(benefitAtClaimingAge(1000, 62, 67, taxTables.socialSecurity), 1000 * (1 - reduction) * 12);
});

test('benefitAtClaimingAge: delayed claim applies 8%/year credits', () => {
  // FRA 67, claim at 70 -> 3 years late * 8%/year
  approx(benefitAtClaimingAge(1000, 70, 67, taxTables.socialSecurity), 1000 * 1.24 * 12);
});

test('benefitAtClaimingAge: delayed credits stop accruing at age 70', () => {
  // FRA 66, claim at 72 -> credits cap at 70 (4 years late, not 6)
  approx(benefitAtClaimingAge(1000, 72, 66, taxTables.socialSecurity), 1000 * 1.32 * 12);
});
