// project.js — the year-by-year projection engine (design doc §4).
//
// Two phases compose into one ledger:
//   - ACCUMULATION (projectAccumulation, Phase 2): growth + contributions, now → retirement.
//   - DECUMULATION (projectDecumulation, Phase 3): spending need, tax-status-aware withdrawal
//     sequencing, and portfolio-survival tracking, retirement → horizon. Deliberately PRE-TAX —
//     withdrawals are gross dollar pulls with no tax computed and no RMDs forced yet. Taxes,
//     RMDs, and tax-bracket-aware sequencing arrive in Phase 4/6 and layer onto this.
// project() composes both, given accumulation-phase and decumulation-phase settings.
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

function rowTotals(accounts, extraKeys) {
  const t = { startBalance: 0, growth: 0, endBalance: 0 };
  for (const k of extraKeys) t[k] = 0;
  for (const id of Object.keys(accounts)) {
    const a = accounts[id];
    for (const k of Object.keys(t)) t[k] += num(a[k]);
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
    const totals = rowTotals(acc, ['contribution']);
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
    const totals = rowTotals(acc, ['contribution']);
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

// Default account draw-down order for 'conventional' sequencing (design doc §5), earliest first:
//   cash      — no growth given up, no tax difference either way: the natural first dollar spent.
//   taxable   — preferential/deferred cap-gains treatment; spend before ordinary-income accounts.
//   taxDeferred — will be ordinary income whenever taxed; spent ahead of the tax-free buckets.
//   hsa       — reserved for medical; drawn after the taxable/deferred buckets, before Roth.
//   roth      — tax-free growth forever: the most valuable dollar to leave compounding, spent last.
// No tax is actually computed in this (pre-tax) phase — this order only decides which account's
// balance is drawn down first. Phase 4/6 add real tax consequences and a bracket-aware order.
const CONVENTIONAL_ORDER = ['cash', 'taxable', 'taxDeferred', 'hsa', 'roth'];

/**
 * Decide how much to pull from each account to cover `gap` (a non-negative nominal $ amount),
 * given each account's current balance. Never overdraws an account; reports any shortfall.
 * @param {number} gap
 * @param {{id:string, balance:number, taxStatus:string}[]} accounts
 * @param {'conventional'|'proportional'} sequencing
 * @returns {{withdrawals:Record<string,number>, shortfall:number}}
 */
function sequenceWithdrawal(gap, accounts, sequencing) {
  const withdrawals = Object.fromEntries(accounts.map((a) => [a.id, 0]));
  if (gap <= 0) return { withdrawals, shortfall: 0 };

  const total = accounts.reduce((s, a) => s + Math.max(0, a.balance), 0);
  if (total <= 0) return { withdrawals, shortfall: gap };

  if (sequencing === 'proportional') {
    // share_i = gap * balance_i/total <= balance_i whenever gap <= total, so a single pass is
    // exact and never overdraws — no capping/redistribution needed except at full depletion.
    if (gap >= total) {
      for (const a of accounts) withdrawals[a.id] = Math.max(0, a.balance);
      return { withdrawals, shortfall: gap - total };
    }
    for (const a of accounts) withdrawals[a.id] = gap * (Math.max(0, a.balance) / total);
    return { withdrawals, shortfall: 0 };
  }

  // conventional: drain accounts in CONVENTIONAL_ORDER, then any taxStatus not in that list.
  const byStatus = new Map();
  for (const a of accounts) {
    if (!byStatus.has(a.taxStatus)) byStatus.set(a.taxStatus, []);
    byStatus.get(a.taxStatus).push(a);
  }
  const order = [...CONVENTIONAL_ORDER, ...[...byStatus.keys()].filter((s) => !CONVENTIONAL_ORDER.includes(s))];
  let remaining = gap;
  for (const status of order) {
    for (const a of byStatus.get(status) || []) {
      if (remaining <= 0) break;
      const take = Math.min(Math.max(0, a.balance), remaining);
      withdrawals[a.id] = take;
      remaining -= take;
    }
    if (remaining <= 0) break;
  }
  return { withdrawals, shortfall: Math.max(0, remaining) };
}

/**
 * Project account balances through the decumulation (retirement) years: spending need, a
 * withdrawal strategy, tax-status-aware sequencing, and portfolio-survival tracking. PRE-TAX —
 * withdrawals are gross dollar pulls; no tax is computed and no RMDs are forced (Phase 4/6).
 *
 * Model (per year):
 *   desired (nominal) = strategy==='fixedPercent' ? startOfYearTotal * withdrawalPercent
 *                                                  : resolve(spending) * cumulativeInflation
 *   otherIncome (nominal) = resolve(otherIncome) * cumulativeInflation   (pension/rental/etc.;
 *                                                  Social Security composes in here, Phase 5)
 *   gap        = max(0, desired - otherIncome)
 *   {withdrawals, shortfall} = sequenceWithdrawal(gap, accounts, sequencing)
 *   remainder  = startBalance - withdrawal   (withdrawal happens at the START of the year)
 *   growth     = remainder * returnRate
 *   endBalance = remainder + growth
 * A shortfall (gap the portfolio couldn't cover) marks that year as depleted; balances never go
 * negative and stay at 0 once exhausted.
 *
 * @param {object} p
 * @param {number} p.startYear   first withdrawal year (typically retirementYear + 1)
 * @param {number} p.endYear     last year of the plan (horizon); inclusive, >= startYear
 * @param {{id:string, balance:number, taxStatus:string}[]} p.accounts
 * @param {object} p.returnRate  setting (per account/year)
 * @param {object} [p.inflation] setting (per year); default 0
 * @param {object} [p.spending]  setting, today's-dollars annual target (per year); default 0
 * @param {object} [p.otherIncome] setting, today's-dollars annual amount (per year); default 0
 * @param {object} [p.withdrawalPercent] setting (per year); default 0.04
 * @param {'fixedReal'|'fixedPercent'} [p.strategy] default 'fixedReal'
 * @param {'conventional'|'proportional'} [p.sequencing] default 'conventional'
 * @param {number} [p.startCumulativeInflation] cumulative inflation already elapsed before
 *   startYear (carried over from accumulation so today's-dollars stays relative to one base
 *   year across the whole plan); default 1
 * @returns {{startYear:number, endYear:number, years:object[], firstDepletionYear:number|null}}
 */
export function projectDecumulation(p) {
  const { startYear, endYear, accounts } = p;
  if (!Number.isInteger(startYear) || !Number.isInteger(endYear)) {
    throw new Error('projectDecumulation: startYear and endYear must be integers');
  }
  if (endYear < startYear) {
    throw new Error('projectDecumulation: endYear must be >= startYear');
  }
  if (!Array.isArray(accounts)) {
    throw new Error('projectDecumulation: accounts must be an array');
  }
  const returnRate = p.returnRate ?? { default: 0 };
  const inflation = p.inflation ?? { default: 0 };
  const spending = p.spending ?? { default: 0 };
  const otherIncome = p.otherIncome ?? { default: 0 };
  const withdrawalPercent = p.withdrawalPercent ?? { default: 0.04 };
  const strategy = p.strategy ?? 'fixedReal';
  const sequencing = p.sequencing ?? 'conventional';

  const bal = {};
  const taxStatus = {};
  for (const a of accounts) { bal[a.id] = num(a.balance); taxStatus[a.id] = a.taxStatus; }

  const years = [];
  let cumInflation = num(p.startCumulativeInflation) || 1;
  let firstDepletionYear = null;

  for (let year = startYear; year <= endYear; year++) {
    cumInflation *= 1 + num(resolve(inflation, { year }));

    const startTotal = Object.values(bal).reduce((s, v) => s + v, 0);
    const desired = strategy === 'fixedPercent'
      ? startTotal * num(resolve(withdrawalPercent, { year }))
      : num(resolve(spending, { year })) * cumInflation;
    const otherIncomeNominal = num(resolve(otherIncome, { year })) * cumInflation;
    const gap = Math.max(0, desired - otherIncomeNominal);

    const seqAccounts = accounts.map((a) => ({ id: a.id, balance: bal[a.id], taxStatus: taxStatus[a.id] }));
    const { withdrawals, shortfall } = sequenceWithdrawal(gap, seqAccounts, sequencing);

    const acc = {};
    for (const a of accounts) {
      const startBalance = bal[a.id];
      const withdrawal = withdrawals[a.id];
      const remainder = startBalance - withdrawal;
      const r = num(resolve(returnRate, { accountId: a.id, year }));
      const growth = remainder * r;
      const endBalance = remainder + growth;
      bal[a.id] = endBalance;
      acc[a.id] = { startBalance, withdrawal, growth, endBalance };
    }
    const totals = rowTotals(acc, ['withdrawal']);
    totals.spendingNeed = desired;
    totals.otherIncome = otherIncomeNominal;
    totals.gap = gap;
    totals.shortfall = shortfall;

    if (shortfall > 1e-9 && firstDepletionYear === null) firstDepletionYear = year;

    years.push({
      year,
      t: year - startYear,
      cumulativeInflation: cumInflation,
      accounts: acc,
      totals,
      real: {
        endBalance: totals.endBalance / cumInflation,
        spendingNeed: totals.spendingNeed / cumInflation,
        otherIncome: totals.otherIncome / cumInflation,
        withdrawal: totals.withdrawal / cumInflation,
        shortfall: totals.shortfall / cumInflation,
      },
    });
  }

  return { startYear, endYear, years, firstDepletionYear };
}

/**
 * Full pipeline: accumulation (now → retirement) composed with decumulation (retirement →
 * horizon). Retirement year is the LAST accumulation year (still contributing); decumulation
 * begins the following year. Balances and cumulative inflation carry over continuously across
 * the boundary — the resulting `years` is one unbroken series, each row tagged with its phase.
 *
 * @param {object} p
 * @param {number} p.baseYear
 * @param {number} p.retirementYear   >= baseYear
 * @param {number} p.horizonYear      >= retirementYear
 * @param {{id:string, balance:number, taxStatus:string}[]} p.accounts
 * @param {object} p.returnRate       setting, used in both phases
 * @param {object} [p.inflation]      setting, used in both phases
 * @param {object} [p.contributions]  accumulation only
 * @param {object} [p.wageGrowth]     accumulation only
 * @param {object} [p.spending]       decumulation only
 * @param {object} [p.otherIncome]    decumulation only
 * @param {object} [p.withdrawalPercent] decumulation only
 * @param {'fixedReal'|'fixedPercent'} [p.strategy] decumulation only
 * @param {'conventional'|'proportional'} [p.sequencing] decumulation only
 * @returns {{baseYear:number, retirementYear:number, horizonYear:number, years:object[], firstDepletionYear:number|null}}
 */
export function project(p) {
  const { baseYear, retirementYear, horizonYear, accounts } = p;
  if (!Number.isInteger(horizonYear) || horizonYear < retirementYear) {
    throw new Error('project: horizonYear must be an integer >= retirementYear');
  }

  const acc = projectAccumulation({
    startYear: baseYear, endYear: retirementYear,
    accounts: accounts.map((a) => ({ id: a.id, balance: a.balance })),
    returnRate: p.returnRate, contributions: p.contributions, wageGrowth: p.wageGrowth, inflation: p.inflation,
  });
  const lastAccRow = acc.years[acc.years.length - 1];

  let decYears = [];
  let firstDepletionYear = null;
  if (horizonYear > retirementYear) {
    const decStartAccounts = accounts.map((a) => ({
      id: a.id, taxStatus: a.taxStatus, balance: lastAccRow.accounts[a.id].endBalance,
    }));
    const dec = projectDecumulation({
      startYear: retirementYear + 1, endYear: horizonYear, accounts: decStartAccounts,
      returnRate: p.returnRate, inflation: p.inflation,
      spending: p.spending, otherIncome: p.otherIncome, withdrawalPercent: p.withdrawalPercent,
      strategy: p.strategy, sequencing: p.sequencing,
      startCumulativeInflation: lastAccRow.cumulativeInflation,
    });
    decYears = dec.years;
    firstDepletionYear = dec.firstDepletionYear;
  }

  const years = [
    ...acc.years.map((y) => ({ ...y, phase: 'accumulation' })),
    ...decYears.map((y) => ({ ...y, phase: 'decumulation' })),
  ];

  return { baseYear, retirementYear, horizonYear, years, firstDepletionYear };
}
