// bracket-fill.test.js — golden-number tests for Phase 6's tax-bracket-aware ("fill to the top
// of a bracket") withdrawal sequencing (design doc §5). Uses the real, verified 2026 single
// table: 12% bracket tops out at $50,400 taxable income; standard deduction $16,100 -> a gross
// tax-deferred withdrawal ceiling of exactly $66,500 to stay within the 12% bracket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { projectDecumulation } from '../engine/project.js';

// Gross-up converges within a $0.01 NET tolerance (see project.js's solveTaxYear); since gross
// withdrawal moves faster than net (marginal rate < 100%), that residual amplifies slightly on
// gross-dollar assertions — same headroom decumulation-tax.test.js uses for the same reason.
const approx = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} (Δ=${Math.abs(a - b)})`);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const taxTables = JSON.parse(readFileSync(join(root, 'data/tax-tables.json'), 'utf8'));
const row = (r, year) => r.years.find((y) => y.year === year);

test('bracketFill: a need that fits entirely within the ceiling comes ONLY from tax-deferred, taxable untouched', () => {
  // Target gross ordinary withdrawal 46100 -> taxable income 30000 (within the 12% bracket, well
  // under the 50400 ceiling). ordinaryTax(30000) = 1240 + (30000-12400)*0.12 = 3352.
  // net = 46100 - 3352 = 42748 exactly.
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [
      { id: 'ira', balance: 10000000, taxStatus: 'taxDeferred' },
      { id: 'brk', balance: 10000000, taxStatus: 'taxable', basisFraction: 0 },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 42748 },
    filingStatus: 'single', taxTables, anchorYear: 2026,
    sequencing: 'bracketFill', bracketFillRate: 0.12,
  });
  const y = row(r, 2026);
  approx(y.accounts.ira.withdrawal, 46100);
  approx(y.accounts.brk.withdrawal, 0);
  approx(y.totals.capitalGain, 0);
  approx(y.totals.tax, 3352);
  approx(y.totals.netSpendable, 42748);
});

test('bracketFill: a need beyond the ceiling fills tax-deferred to exactly the ceiling, then spills into taxable at LTCG rates', () => {
  // Ceiling = 66500 gross (taxable income exactly 50400, the top of the 12% bracket).
  // ordinaryTax(50400) = 1240 + (50400-12400)*0.12 = 5800 exactly.
  // Excess X beyond the ceiling comes from taxable (basisFraction 0 -> all gain), stacking on
  // ordinaryTaxableIncome=50400 which already clears the 0% LTCG bracket's $49,450 top, so the
  // WHOLE excess is taxed at a flat 15%: tax(G) = 5800 + 0.15*(G-66500) for G > 66500.
  // net(G) = G - tax(G) = 0.85G + 4175. Solving net(G)=100000 -> G = 95825/0.85 = 112735.294118.
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [
      { id: 'ira', balance: 10000000, taxStatus: 'taxDeferred' },
      { id: 'brk', balance: 10000000, taxStatus: 'taxable', basisFraction: 0 },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 100000 },
    filingStatus: 'single', taxTables, anchorYear: 2026,
    sequencing: 'bracketFill', bracketFillRate: 0.12,
  });
  const y = row(r, 2026);
  const G = 95825 / 0.85;
  approx(y.accounts.ira.withdrawal, 66500);
  approx(y.accounts.brk.withdrawal, G - 66500);
  approx(y.totals.ordinaryTaxableIncome, 50400);
  approx(y.totals.capitalGain, G - 66500);
  approx(y.totals.tax, 5800 + 0.15 * (G - 66500));
  approx(y.totals.netSpendable, 100000);
});

test('bracketFill vs conventional: same scenario, opposite account preference', () => {
  // Conventional order draws taxable BEFORE tax-deferred; bracketFill deliberately reverses that
  // preference (up to the ceiling) to realize cheap ordinary income while the bracket is low.
  const scenario = (sequencing) => projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [
      { id: 'ira', balance: 10000000, taxStatus: 'taxDeferred' },
      { id: 'brk', balance: 10000000, taxStatus: 'taxable', basisFraction: 0 },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 20000 },
    filingStatus: 'single', taxTables, anchorYear: 2026,
    sequencing, bracketFillRate: 0.12,
  });
  const conv = row(scenario('conventional'), 2026);
  const fill = row(scenario('bracketFill'), 2026);
  assert.equal(conv.accounts.ira.withdrawal, 0);
  assert.ok(conv.accounts.brk.withdrawal > 0);
  assert.equal(fill.accounts.brk.withdrawal, 0);
  assert.ok(fill.accounts.ira.withdrawal > 0);
});

test('bracketFill: an RMD floor counts against the ceiling, leaving only the remaining room for additional fill', () => {
  // age 76 (birthYear 1950) forces an RMD from the tax-deferred account first (floor), and that
  // floor eats into the bracket-fill ceiling — bracketFill should NOT try to add another 66500 on
  // top of it. RMD = 300000/23.7 = 12658.227848...; ceiling 66500 leaves ~53841.77 of headroom.
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [
      { id: 'ira', balance: 300000, taxStatus: 'taxDeferred' },
      { id: 'brk', balance: 10000000, taxStatus: 'taxable', basisFraction: 0 },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 5000 },
    filingStatus: 'single', taxTables, anchorYear: 2026, birthYear: 1950,
    sequencing: 'bracketFill', bracketFillRate: 0.12,
  });
  const y = row(r, 2026);
  const rmd = 300000 / 23.7;
  // The RMD is forced regardless of the spending target being much smaller (a real surplus case,
  // same as the existing RMD-surplus reinvestment behavior) — the whole IRA balance moves via the
  // floor; bracketFill's ceiling logic only ever ADDS on top of what floors already forced.
  approx(y.accounts.ira.withdrawal, rmd);
  assert.ok(y.accounts.ira.withdrawal <= 66500 + 1e-6, 'RMD alone must not exceed the fill ceiling in this scenario');
});

test('bracketFill without taxTables (no tax mode) does not crash — falls back to drawing tax-deferred last', () => {
  const r = projectDecumulation({
    startYear: 2026, endYear: 2026,
    accounts: [
      { id: 'ira', balance: 100000, taxStatus: 'taxDeferred' },
      { id: 'brk', balance: 100000, taxStatus: 'taxable' },
    ],
    returnRate: { default: 0 }, inflation: { default: 0 }, spending: { default: 1000 },
    sequencing: 'bracketFill', bracketFillRate: 0.12,
  });
  const y = row(r, 2026);
  approx(y.accounts.ira.withdrawal, 0);
  approx(y.accounts.brk.withdrawal, 1000);
});
