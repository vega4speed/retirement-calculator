// project.js — the year-by-year projection engine (design doc §4).
//
// Phase 2 implements the ACCUMULATION phase only: growth + contributions from the snapshot
// year to retirement, with every figure also restated in today's dollars. No taxes and no
// decumulation yet — those arrive in later phases and compose onto this ledger.
//
// Pure and deterministic: no DOM, no I/O, no personal data. Every rate/amount is pulled through
// the override resolver, so a single default or a per-account / per-year override both work.
//
// TODO (future work, noted 2026-07-21): `contributions` currently supports one mode — a flat
// base-year amount escalated by wageGrowth. Planned expansion: selectable per-account modes
// (flat unadjusted / flat adjusted by income growth / flat adjusted by inflation / % of income
// [needs an income figure — not modeled yet] / HSA-specific max with its own escalation table).
// See the design doc §4.1a for the full writeup.

import { resolve } from './resolver.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function rowTotals(accounts) {
  const t = { startBalance: 0, contribution: 0, growth: 0, endBalance: 0 };
  for (const id of Object.keys(accounts)) {
    const a = accounts[id];
    t.startBalance += a.startBalance;
    t.contribution += a.contribution;
    t.growth += a.growth;
    t.endBalance += a.endBalance;
  }
  return t;
}

/**
 * Project account balances forward through the accumulation years.
 *
 * Model (per year, after the baseline year):
 *   growth      = startBalance * returnRate
 *   contribution= base contribution (resolved) escalated by cumulative wage growth
 *   endBalance  = startBalance * (1 + returnRate) + contribution
 * i.e. contributions land at year-end (no growth in the year they are made) — a simple,
 * conservative convention that is easy to verify by hand.
 *
 * Today's-dollars ("real") figures deflate the nominal endBalance by cumulative inflation from
 * the base year. Rates are resolved per {accountId, year}; inflation and wage growth per {year}.
 * Note: a per-year `contributions` override is ALSO escalated by wage growth — to pin exact
 * nominal contributions, set wageGrowth to 0.
 *
 * @param {object} p
 * @param {number} p.startYear       baseline (snapshot) year; row t=0 holds current balances
 * @param {number} p.endYear         last accumulation year (retirement); inclusive, >= startYear
 * @param {{id:string, balance:number}[]} p.accounts
 * @param {object} p.returnRate      setting (per account/year)
 * @param {object} [p.contributions] setting (base-year annual $ per account); default 0
 * @param {object} [p.wageGrowth]    setting (per year); default 0
 * @param {object} [p.inflation]     setting (per year); default 0
 * @returns {{baseYear:number, endYear:number, years:object[]}}
 */
export function projectAccumulation(p) {
  const { startYear, endYear, accounts } = p;
  if (!Number.isInteger(startYear) || !Number.isInteger(endYear)) {
    throw new Error('projectAccumulation: startYear and endYear must be integers');
  }
  if (endYear < startYear) {
    throw new Error('projectAccumulation: endYear must be >= startYear');
  }
  if (!Array.isArray(accounts)) {
    throw new Error('projectAccumulation: accounts must be an array');
  }
  const returnRate = p.returnRate ?? { default: 0 };
  const contributions = p.contributions ?? { default: 0 };
  const wageGrowth = p.wageGrowth ?? { default: 0 };
  const inflation = p.inflation ?? { default: 0 };

  const bal = {};
  for (const a of accounts) bal[a.id] = num(a.balance);

  const years = [];

  // Baseline row (t=0): current balances, no flows.
  {
    const acc = {};
    for (const a of accounts) {
      acc[a.id] = { startBalance: bal[a.id], contribution: 0, growth: 0, endBalance: bal[a.id] };
    }
    const totals = rowTotals(acc);
    years.push({ year: startYear, t: 0, cumulativeInflation: 1, accounts: acc, totals, real: { endBalance: totals.endBalance } });
  }

  let cumInflation = 1; // relative to startYear
  let cumWage = 1;      // wage-growth factor relative to startYear

  for (let year = startYear + 1; year <= endYear; year++) {
    cumInflation *= 1 + num(resolve(inflation, { year }));
    cumWage *= 1 + num(resolve(wageGrowth, { year }));

    const acc = {};
    for (const a of accounts) {
      const startBalance = bal[a.id];
      const r = num(resolve(returnRate, { accountId: a.id, year }));
      const contribution = num(resolve(contributions, { accountId: a.id, year })) * cumWage;
      const growth = startBalance * r;
      const endBalance = startBalance * (1 + r) + contribution;
      bal[a.id] = endBalance;
      acc[a.id] = { startBalance, contribution, growth, endBalance };
    }
    const totals = rowTotals(acc);
    years.push({
      year,
      t: year - startYear,
      cumulativeInflation: cumInflation,
      accounts: acc,
      totals,
      real: { endBalance: totals.endBalance / cumInflation },
    });
  }

  return { baseYear: startYear, endYear, years };
}

/**
 * Full pipeline (accumulation → decumulation → taxes). Not implemented yet — Phase 3+ compose
 * onto projectAccumulation above.
 */
export function project() {
  throw new Error('project: full accumulation+decumulation pipeline not implemented yet (Phase 3+)');
}
