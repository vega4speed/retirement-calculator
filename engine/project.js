// project.js — the year-by-year projection engine (design doc §4).
//
// Two phases compose into one ledger:
//   - ACCUMULATION (projectAccumulation, Phase 2): growth + contributions, now → retirement.
//   - DECUMULATION (projectDecumulation, Phase 3+4): spending need, tax-status-aware withdrawal
//     sequencing, portfolio-survival tracking, and — when tax inputs are supplied (Phase 4) —
//     real federal tax: RMDs forced by the birth-year SECURE 2.0 rule, capital-gains tax on
//     taxable-account withdrawals, and gross-up (withdraw more than the spending need to net the
//     target amount after tax). Tax is OPT-IN: omit filingStatus/taxTables and the decumulation
//     math is identical to Phase 3 (gross dollar pulls, no tax) — this keeps every Phase 2/3
//     golden-number test valid unchanged.
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
import { resolveYearTable, ordinaryTax, capitalGainsTax, standardDeduction, taxableSocialSecurity, requiredBeginningAge, rmdAmount, cumulativeFactor, bracketTopForRate } from './tax.js';
import { estimatePIA, benefitAtClaimingAge, fullRetirementAge } from './socialsecurity.js';

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
const CONVENTIONAL_ORDER = ['cash', 'taxable', 'taxDeferred', 'hsa', 'roth'];

/**
 * Decide how much to pull from each account to cover `target` (a non-negative nominal $ amount),
 * given each account's current balance. `floors` (optional) are mandatory minimum withdrawals
 * per account — e.g. an RMD — taken first regardless of sequencing order; sequencing then covers
 * whatever's left of `target` beyond the floors' total. If the floors alone exceed `target` (a
 * forced RMD bigger than what's needed), the actual total withdrawn legitimately EXCEEDS target —
 * that's not a bug, it's the caller's cue to reinvest the surplus (see solveTaxYear).
 * @param {number} target
 * @param {{id:string, balance:number, taxStatus:string}[]} accounts
 * @param {'conventional'|'proportional'|'bracketFill'} sequencing
 * @param {Record<string,number>} [floors]
 * @param {{taxDeferredCeiling?:number}} [opts] `bracketFill` only: the dollar ceiling on total
 *   tax-deferred withdrawals (floors included) that keeps ordinary income at or under the chosen
 *   bracket's top (see solveTaxYear, which computes this from the tax tables).
 * @returns {{withdrawals:Record<string,number>, totalWithdrawn:number, shortfall:number}}
 */
function sequenceWithdrawal(target, accounts, sequencing, floors = {}, opts = {}) {
  const withdrawals = Object.fromEntries(accounts.map((a) => [a.id, 0]));
  const remainingBalance = {};
  let floorsTotal = 0;
  for (const a of accounts) {
    const floor = Math.min(Math.max(0, a.balance), Math.max(0, floors[a.id] || 0));
    withdrawals[a.id] = floor;
    remainingBalance[a.id] = Math.max(0, a.balance) - floor;
    floorsTotal += floor;
  }

  const extraTarget = Math.max(0, target - floorsTotal);
  if (extraTarget > 0) {
    const total = accounts.reduce((s, a) => s + remainingBalance[a.id], 0);
    if (total > 0) {
      if (sequencing === 'proportional') {
        // share_i = extra * remaining_i/total <= remaining_i whenever extra <= total.
        if (extraTarget >= total) {
          for (const a of accounts) withdrawals[a.id] += remainingBalance[a.id];
        } else {
          for (const a of accounts) withdrawals[a.id] += extraTarget * (remainingBalance[a.id] / total);
        }
      } else if (sequencing === 'bracketFill') {
        // Design doc §5's "fill to the top of a bracket": draw tax-deferred FIRST (not last, as
        // conventional order does), but only up to a dollar ceiling that keeps that year's
        // ordinary income at or under a chosen bracket's top — deliberately realizing cheap
        // ordinary income in low-income years rather than saving it all for RMDs later. Whatever
        // the ceiling doesn't cover of the target falls back to conventional order over the
        // remaining (non-tax-deferred) buckets; if even that runs out, the last resort is more
        // tax-deferred beyond the ceiling — a real remaining need beats reporting a false shortfall.
        let remaining = extraTarget;
        const tdAccounts = accounts.filter((a) => a.taxStatus === 'taxDeferred');
        const tdFloorTotal = tdAccounts.reduce((s, a) => s + withdrawals[a.id], 0);
        let tdCapacity = Math.max(0, num(opts.taxDeferredCeiling) - tdFloorTotal);
        for (const a of tdAccounts) {
          if (remaining <= 0 || tdCapacity <= 0) break;
          const take = Math.min(remainingBalance[a.id], remaining, tdCapacity);
          withdrawals[a.id] += take;
          remaining -= take;
          tdCapacity -= take;
          remainingBalance[a.id] -= take;
        }
        const byStatus = new Map();
        for (const a of accounts) {
          if (a.taxStatus === 'taxDeferred') continue;
          if (!byStatus.has(a.taxStatus)) byStatus.set(a.taxStatus, []);
          byStatus.get(a.taxStatus).push(a);
        }
        const restOrder = CONVENTIONAL_ORDER.filter((s) => s !== 'taxDeferred');
        const order = [...restOrder, ...[...byStatus.keys()].filter((s) => !restOrder.includes(s))];
        for (const status of order) {
          for (const a of byStatus.get(status) || []) {
            if (remaining <= 0) break;
            const take = Math.min(remainingBalance[a.id], remaining);
            withdrawals[a.id] += take;
            remaining -= take;
          }
          if (remaining <= 0) break;
        }
        if (remaining > 0) {
          for (const a of tdAccounts) {
            if (remaining <= 0) break;
            const take = Math.min(remainingBalance[a.id], remaining);
            withdrawals[a.id] += take;
            remaining -= take;
          }
        }
      } else {
        const byStatus = new Map();
        for (const a of accounts) {
          if (!byStatus.has(a.taxStatus)) byStatus.set(a.taxStatus, []);
          byStatus.get(a.taxStatus).push(a);
        }
        const order = [...CONVENTIONAL_ORDER, ...[...byStatus.keys()].filter((s) => !CONVENTIONAL_ORDER.includes(s))];
        let remaining = extraTarget;
        for (const status of order) {
          for (const a of byStatus.get(status) || []) {
            if (remaining <= 0) break;
            const take = Math.min(remainingBalance[a.id], remaining);
            withdrawals[a.id] += take;
            remaining -= take;
          }
          if (remaining <= 0) break;
        }
      }
    }
  }

  const totalWithdrawn = Object.values(withdrawals).reduce((s, v) => s + v, 0);
  return { withdrawals, totalWithdrawn, shortfall: Math.max(0, target - totalWithdrawn) };
}

// Where surplus net-of-tax proceeds go when a forced RMD exceeds the year's spending need (design
// doc §5/§8): prefer a taxable account (realistic — "just reinvest it"), then cash, then Roth,
// then HSA. If none of those exist (100% tax-deferred portfolio, a real but rare edge case), fall
// back to redepositing in the RMD's own source account — not strictly how RMDs work in reality
// (you can't un-RMD), but conserves the modeled wealth rather than fabricating or destroying it.
const REINVEST_PREFERENCE = ['taxable', 'cash', 'roth', 'hsa'];
function pickReinvestmentTarget(accounts, fallbackId) {
  for (const status of REINVEST_PREFERENCE) {
    const a = accounts.find((x) => x.taxStatus === status);
    if (a) return a.id;
  }
  return fallbackId;
}

/**
 * One year's tax-aware withdrawal solve: forces RMDs, iteratively grosses up the withdrawal so
 * the NET (after federal ordinary + capital-gains + flat state tax) matches `targetNet`, and
 * reinvests any RMD-forced surplus. Pure — no mutation of inputs.
 *
 * Gross-up is a fixed-point iteration (design doc §4.2: "the engine solves for the gross
 * amount"): each round, sequence a candidate gross total, compute the resulting tax from what
 * actually got withdrawn, and adjust the candidate by the shortfall/surplus. Converges in a
 * handful of rounds because tax is monotonic and piecewise-linear with slope < 1 (no marginal
 * rate reaches 100%); it also terminates cleanly, without special-casing, when withdrawals are
 * pinned by either the portfolio's total balance (real shortfall) or by RMD floors alone
 * exceeding the target (surplus) — in both cases totalWithdrawn stops moving between rounds, so
 * further iteration is a harmless no-op, not a bug.
 *
 * @param {object} p
 * @param {number} p.targetNet   desired NET (after-tax) dollars to fund from the portfolio
 * @param {{id:string, balance:number, taxStatus:string, basisFraction?:number}[]} p.accounts
 * @param {'conventional'|'proportional'|'bracketFill'} p.sequencing
 * @param {Record<string,number>} p.rmdFloors
 * @param {'mfj'|'single'|'hoh'} p.filingStatus
 * @param {number} p.age65Count
 * @param {object} p.yearTable   resolved via tax.resolveYearTable
 * @param {number} [p.stateTaxRate] flat rate on (ordinary taxable income + capital gain); default 0
 * @param {number} [p.socialSecurityBenefit] gross SS received this year (design doc §6); its
 *   taxable portion (tax.taxableSocialSecurity) adds to ordinary taxable income. `otherIncome`
 *   is deliberately excluded from the provisional-income test — see project()'s docs.
 * @param {object} [p.fixedTables] tax-tables.json's `fixed` block; required if socialSecurityBenefit > 0
 * @param {number} [p.bracketFillRate] `sequencing==='bracketFill'` only (design doc §5, Phase 6):
 *   the marginal ordinary-income rate to fill up to (must match a rate in yearTable's ordinary
 *   brackets, e.g. 0.12/0.22/0.24 — see tax.bracketTopForRate). Unset/no match ⇒ no ceiling.
 * @returns {{withdrawals:Record<string,number>, reinvestment:Record<string,number>, totalWithdrawn:number, tax:number, ordinaryTaxableIncome:number, capitalGain:number, taxableSocialSecurity:number, netAchieved:number, shortfall:number}}
 */
function solveTaxYear(p) {
  const { accounts, sequencing, rmdFloors, filingStatus, yearTable } = p;
  const stateTaxRate = num(p.stateTaxRate);
  const ssBenefit = num(p.socialSecurityBenefit);
  const stdDeduction = standardDeduction({ filingStatus, age65Count: p.age65Count, yearTable });
  const totalAvailable = accounts.reduce((s, a) => s + Math.max(0, a.balance), 0);
  // The bracket-fill ceiling is a taxable-income line; convert to a gross ordinary-withdrawal
  // ceiling by adding back the standard deduction. Taxable SS also counts against the ceiling
  // (it's ordinary income too) but depends circularly on what gets withdrawn — refined each
  // round below from the PRIOR round's taxableSS, converging alongside the gross-up loop itself.
  const bracketFillTop = p.sequencing === 'bracketFill' && p.bracketFillRate != null
    ? bracketTopForRate(p.bracketFillRate, yearTable.ordinaryBrackets[filingStatus])
    : Infinity;

  const taxFor = (withdrawals) => {
    let ordinaryWithdrawn = 0;
    let gain = 0;
    for (const a of accounts) {
      const w = withdrawals[a.id] || 0;
      if (a.taxStatus === 'taxDeferred') ordinaryWithdrawn += w;
      else if (a.taxStatus === 'taxable') gain += w * (1 - (a.basisFraction ?? 0));
    }
    // Provisional-income test uses ordinary withdrawals + capital gain as "other income" — both
    // are real AGI components. otherIncome (pension/rental placeholder) is excluded, matching its
    // exclusion from ordinary tax too (see project()'s docs for that simplification).
    const taxableSS = ssBenefit > 0 ? taxableSocialSecurity(ssBenefit, ordinaryWithdrawn + gain, filingStatus, p.fixedTables) : 0;
    const ordinaryTaxableIncome = Math.max(0, ordinaryWithdrawn + taxableSS - stdDeduction);
    const fedOrdinary = ordinaryTax(ordinaryTaxableIncome, filingStatus, yearTable);
    const fedCapGains = capitalGainsTax(gain, ordinaryTaxableIncome, filingStatus, yearTable);
    const stateTax = stateTaxRate * (ordinaryTaxableIncome + gain);
    return { ordinaryTaxableIncome, gain, taxableSS, tax: fedOrdinary + fedCapGains + stateTax };
  };

  let grossGuess = Math.max(0, p.targetNet);
  let last = null;
  let lastTotalWithdrawn = -1;
  let exhausted = false; // true only when the LAST round hit the portfolio's total balance cap
  let taxableSSEstimate = 0;
  for (let i = 0; i < 8; i++) {
    const taxDeferredCeiling = Math.max(0, bracketFillTop + stdDeduction - taxableSSEstimate);
    const { withdrawals, totalWithdrawn } = sequenceWithdrawal(grossGuess, accounts, sequencing, rmdFloors, { taxDeferredCeiling });
    const { ordinaryTaxableIncome, gain, taxableSS, tax } = taxFor(withdrawals);
    taxableSSEstimate = taxableSS;
    const netAchieved = totalWithdrawn - tax;
    last = { withdrawals, totalWithdrawn, tax, ordinaryTaxableIncome, gain, taxableSS, netAchieved };
    exhausted = totalWithdrawn >= totalAvailable - 1e-6;
    if (exhausted) break;                                          // portfolio exhausted — a real shortfall
    if (totalWithdrawn === lastTotalWithdrawn) break;              // pinned by floors; no further movement possible (surplus, not a shortfall)
    if (Math.abs(netAchieved - p.targetNet) < 0.01) break;         // converged — within tolerance, NOT a shortfall
    lastTotalWithdrawn = totalWithdrawn;
    grossGuess = Math.max(0, grossGuess + (p.targetNet - netAchieved));
  }

  // TODO (future work, noted 2026-07-21): this always reinvests an RMD-forced surplus. That's a
  // reasonable default, not the only sane one — a selectable "forced spending" mode (surplus
  // counts as extra spending that year, called out distinctly rather than silently reinvested)
  // is a real, requested alternative. This is exactly where that mode would branch. See the
  // design doc's §5a for the full writeup.
  const surplus = Math.max(0, last.netAchieved - p.targetNet);
  const reinvestment = Object.fromEntries(accounts.map((a) => [a.id, 0]));
  if (surplus > 1e-9) {
    const rmdSourceId = Object.keys(rmdFloors).find((id) => rmdFloors[id] > 0);
    const targetId = pickReinvestmentTarget(accounts, rmdSourceId ?? accounts[0]?.id);
    if (targetId) reinvestment[targetId] = surplus;
  }

  return {
    withdrawals: last.withdrawals,
    reinvestment,
    totalWithdrawn: last.totalWithdrawn,
    tax: last.tax,
    ordinaryTaxableIncome: last.ordinaryTaxableIncome,
    capitalGain: last.gain,
    taxableSocialSecurity: last.taxableSS,
    netAchieved: last.netAchieved,
    // Only report a shortfall when the portfolio was genuinely exhausted — NOT when the loop
    // simply converged within its $0.01 tolerance (that residual is solver slack, not a real
    // funding gap, and reporting it as one falsely flagged "depleted" on almost every year).
    shortfall: exhausted ? Math.max(0, p.targetNet - last.netAchieved) : 0,
  };
}

/**
 * Project account balances through the decumulation (retirement) years: spending need, a
 * withdrawal strategy, tax-status-aware sequencing, and portfolio-survival tracking.
 *
 * PRE-TAX by default (Phase 3 behavior, unchanged): omit `filingStatus`/`taxTables` and
 * withdrawals are gross dollar pulls with no tax and no RMDs.
 *
 * TAX-AWARE (Phase 4) when `filingStatus` + `taxTables` + `anchorYear` are supplied: RMDs are
 * forced once age >= the SECURE 2.0 birth-year threshold (needs `birthYear`); withdrawals from
 * tax-deferred accounts are ordinary income and from taxable accounts trigger capital-gains tax
 * on the gain portion (`account.basisFraction`, 0-1 — the fraction of a withdrawal that is
 * already-taxed basis, not gain; missing/undefined ⇒ 0, i.e. the whole withdrawal is treated as
 * gain — the conservative default when basis isn't known); Roth/HSA/cash stay
 * tax-free (v1 simplification: HSA's non-medical penalty and Roth's early-withdrawal rules are
 * not modeled — see the design doc for the full list of Phase-4 simplifications). Withdrawals
 * gross-up so the NET matches the spending need; an RMD-forced surplus is reinvested rather than
 * lost. `otherIncome` (pension/rental placeholder) is still NOT taxed (a deliberate, documented
 * v1 boundary) — but SOCIAL SECURITY (Phase 5) IS: when `socialSecurityStartingBenefit` +
 * `socialSecurityClaimingYear` are given, the benefit (COLA-compounded from the year after
 * claiming, optionally haircut from a solvency-lever start year) offsets the spending gap like
 * `otherIncome` does, AND its taxable portion (tax.taxableSocialSecurity's provisional-income
 * formula) adds to ordinary taxable income — the first real guaranteed-income source properly
 * taxed. See project()'s docs for how the starting benefit gets computed from earnings.
 *
 * Model (per year, pre-tax path):
 *   desired (nominal) = strategy==='fixedPercent' ? startOfYearTotal * withdrawalPercent
 *                                                  : resolve(spending) * cumulativeInflation
 *   otherIncome (nominal) = resolve(otherIncome) * cumulativeInflation
 *   gap        = max(0, desired - otherIncome)
 *   {withdrawals, shortfall} = sequenceWithdrawal(gap, accounts, sequencing)
 *   remainder  = startBalance - withdrawal + reinvestment   (withdrawal at the START of the year)
 *   growth     = remainder * returnRate
 *   endBalance = remainder + growth
 * A shortfall (gap the portfolio couldn't cover) marks that year as depleted; balances never go
 * negative and stay at 0 once exhausted.
 *
 * @param {object} p
 * @param {number} p.startYear   first withdrawal year (typically retirementYear + 1)
 * @param {number} p.endYear     last year of the plan (horizon); inclusive, >= startYear
 * @param {{id:string, balance:number, taxStatus:string, basisFraction?:number}[]} p.accounts
 * @param {object} p.returnRate  setting (per account/year)
 * @param {object} [p.inflation] setting (per year); default 0
 * @param {object} [p.spending]  setting, today's-dollars annual target (per year); default 0
 * @param {object} [p.otherIncome] setting, today's-dollars annual amount (per year); default 0
 * @param {object} [p.withdrawalPercent] setting (per year); default 0.04
 * @param {'fixedReal'|'fixedPercent'} [p.strategy] default 'fixedReal'
 * @param {'conventional'|'proportional'|'bracketFill'} [p.sequencing] default 'conventional'.
 *   `bracketFill` requires tax mode (below) — it needs real brackets to fill.
 * @param {number} [p.bracketFillRate] `sequencing==='bracketFill'` only: the marginal ordinary
 *   rate to fill tax-deferred withdrawals up to each year (design doc §5, Phase 6) — e.g. 0.12
 *   fills the 12% bracket before touching taxable/Roth. Must match a rate in the resolved year's
 *   ordinary brackets; see tax.bracketTopForRate.
 * @param {number} [p.startCumulativeInflation] cumulative inflation already elapsed before
 *   startYear (carried over from accumulation so today's-dollars stays relative to one base
 *   year across the whole plan); default 1
 * @param {'mfj'|'single'|'hoh'} [p.filingStatus] presence (with taxTables) enables tax-aware mode
 * @param {object} [p.taxTables]  parsed tax-tables.json
 * @param {number} [p.anchorYear] required if taxTables given — see tax.resolveYearTable
 * @param {object} [p.bracketIndexingRate] setting (per year); default 0
 * @param {object} [p.standardDeductionIndexingRate] setting (per year); default 0
 * @param {number} [p.stateTaxRate] flat rate; default 0 (e.g. TN)
 * @param {number} [p.birthYear] enables RMD forcing + the standard deduction's age-65 addition
 * @param {number} [p.socialSecurityStartingBenefit] annual $ benefit as of the claiming year
 *   (design doc §6) — see project()'s docs for how this gets computed from earnings
 * @param {number} [p.socialSecurityClaimingYear] first year the benefit is received; before it,
 *   the benefit is 0
 * @param {object} [p.colaRate] setting (per year); annual COLA applied from the year AFTER
 *   claiming onward; default 0
 * @param {number} [p.solvencyHaircutStartYear] if set, the benefit is multiplied by
 *   solvencyHaircutFactor from this year on (design doc §6's trust-fund-depletion lever)
 * @param {number} [p.solvencyHaircutFactor] default 1 (no haircut)
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
  const taxMode = !!(p.filingStatus && p.taxTables);
  if (taxMode && !Number.isInteger(p.anchorYear)) {
    throw new Error('projectDecumulation: anchorYear is required when taxTables is provided');
  }
  const ssStartingBenefit = num(p.socialSecurityStartingBenefit);
  const ssClaimingYear = Number.isInteger(p.socialSecurityClaimingYear) ? p.socialSecurityClaimingYear : null;
  const colaRate = p.colaRate ?? { default: 0 };
  const haircutStartYear = Number.isInteger(p.solvencyHaircutStartYear) ? p.solvencyHaircutStartYear : null;
  const haircutFactor = p.solvencyHaircutFactor != null ? num(p.solvencyHaircutFactor) : 1;

  const bal = {};
  const taxStatus = {};
  const basisFraction = {};
  for (const a of accounts) { bal[a.id] = num(a.balance); taxStatus[a.id] = a.taxStatus; basisFraction[a.id] = a.basisFraction; }

  const years = [];
  let cumInflation = num(p.startCumulativeInflation) || 1;
  // Relative to the claiming year; starts compounding the year AFTER claiming. If claiming
  // happened BEFORE this function's startYear (e.g. claimed while still in the accumulation
  // phase, which projectDecumulation never iterates), seed cumCOLA for the skipped years so the
  // benefit is correctly grown once payments start here — otherwise those years' COLA would
  // silently vanish and understate every subsequent payment.
  let cumCOLA = (ssClaimingYear != null && startYear > ssClaimingYear)
    ? cumulativeFactor(colaRate, ssClaimingYear, startYear - 1)
    : 1;
  let firstDepletionYear = null;

  for (let year = startYear; year <= endYear; year++) {
    cumInflation *= 1 + num(resolve(inflation, { year }));

    let ssBenefitNominal = 0;
    if (ssClaimingYear != null && year >= ssClaimingYear) {
      if (year > ssClaimingYear) cumCOLA *= 1 + num(resolve(colaRate, { year }));
      const haircut = haircutStartYear != null && year >= haircutStartYear ? haircutFactor : 1;
      ssBenefitNominal = ssStartingBenefit * cumCOLA * haircut;
    }

    const startTotal = Object.values(bal).reduce((s, v) => s + v, 0);
    const desired = strategy === 'fixedPercent'
      ? startTotal * num(resolve(withdrawalPercent, { year }))
      : num(resolve(spending, { year })) * cumInflation;
    const otherIncomeNominal = num(resolve(otherIncome, { year })) * cumInflation;
    const gap = Math.max(0, desired - otherIncomeNominal - ssBenefitNominal);

    const seqAccounts = accounts.map((a) => ({ id: a.id, balance: bal[a.id], taxStatus: taxStatus[a.id], basisFraction: basisFraction[a.id] }));

    let withdrawals, reinvestment, shortfall, tax = 0, ordinaryTaxableIncome = 0, capitalGain = 0, taxableSS = 0;
    if (taxMode) {
      const age = Number.isInteger(p.birthYear) ? year - p.birthYear : null;
      const rmdFloors = {};
      if (age != null) {
        const rbAge = requiredBeginningAge(p.birthYear, p.taxTables.rmd);
        if (age >= rbAge) {
          for (const a of seqAccounts) {
            if (a.taxStatus === 'taxDeferred') rmdFloors[a.id] = rmdAmount(age, a.balance, p.taxTables.rmd);
          }
        }
      }
      const yearTable = resolveYearTable({
        tables: p.taxTables, year, anchorYear: p.anchorYear,
        bracketIndexingRate: p.bracketIndexingRate, standardDeductionIndexingRate: p.standardDeductionIndexingRate,
      });
      const solved = solveTaxYear({
        targetNet: gap, accounts: seqAccounts, sequencing, rmdFloors,
        filingStatus: p.filingStatus, age65Count: age != null && age >= 65 ? 1 : 0,
        yearTable, stateTaxRate: p.stateTaxRate,
        socialSecurityBenefit: ssBenefitNominal, fixedTables: p.taxTables.fixed,
        bracketFillRate: p.bracketFillRate,
      });
      withdrawals = solved.withdrawals; reinvestment = solved.reinvestment; shortfall = solved.shortfall;
      tax = solved.tax; ordinaryTaxableIncome = solved.ordinaryTaxableIncome; capitalGain = solved.capitalGain;
      taxableSS = solved.taxableSocialSecurity;
    } else {
      const seq = sequenceWithdrawal(gap, seqAccounts, sequencing);
      withdrawals = seq.withdrawals; shortfall = seq.shortfall;
      reinvestment = Object.fromEntries(accounts.map((a) => [a.id, 0]));
    }

    const acc = {};
    for (const a of accounts) {
      const startBalance = bal[a.id];
      const withdrawal = withdrawals[a.id];
      const reinvest = reinvestment[a.id] || 0;
      const remainder = startBalance - withdrawal + reinvest;
      const r = num(resolve(returnRate, { accountId: a.id, year }));
      const growth = remainder * r;
      const endBalance = remainder + growth;
      bal[a.id] = endBalance;
      acc[a.id] = { startBalance, withdrawal, reinvestment: reinvest, growth, endBalance };
    }
    const totals = rowTotals(acc, ['withdrawal', 'reinvestment']);
    totals.spendingNeed = desired;
    totals.otherIncome = otherIncomeNominal;
    totals.socialSecurity = ssBenefitNominal;
    totals.taxableSocialSecurity = taxableSS;
    totals.gap = gap;
    totals.shortfall = shortfall;
    totals.tax = tax;
    totals.ordinaryTaxableIncome = ordinaryTaxableIncome;
    totals.capitalGain = capitalGain;
    totals.netSpendable = otherIncomeNominal + ssBenefitNominal + (totals.withdrawal - tax - totals.reinvestment);
    // Gross income realized this year (before tax, including tax-free withdrawals like Roth) and
    // the EFFECTIVE rate that funds — as opposed to the MARGINAL rate the bracket breakdown shows
    // (the rate on the next/last dollar). Effective rate is what a bracket-fill-vs-conventional
    // comparison actually needs: bracket-fill can raise lifetime tax in dollars while keeping the
    // effective rate low each year (spreading ordinary income across many low-bracket years)
    // rather than compressing it into a smaller, more-heavily-taxed window once RMDs force it.
    totals.grossIncome = otherIncomeNominal + ssBenefitNominal + totals.withdrawal;
    totals.effectiveTaxRate = totals.grossIncome > 1e-9 ? tax / totals.grossIncome : 0;

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
        socialSecurity: totals.socialSecurity / cumInflation,
        withdrawal: totals.withdrawal / cumInflation,
        shortfall: totals.shortfall / cumInflation,
        tax: totals.tax / cumInflation,
        netSpendable: totals.netSpendable / cumInflation,
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
 * Cost basis (`accounts[].costBasis`, taxable accounts only) is captured as a FRACTION of the
 * account's starting balance and held constant through growth (design doc §4/§8's v1
 * simplification — contributions during accumulation aren't tracked as additional basis).
 *
 * @param {object} p
 * @param {number} p.baseYear
 * @param {number} p.retirementYear   >= baseYear
 * @param {number} p.horizonYear      >= retirementYear
 * @param {{id:string, balance:number, taxStatus:string, costBasis?:number}[]} p.accounts
 * @param {object} p.returnRate       setting, used in both phases
 * @param {object} [p.inflation]      setting, used in both phases
 * @param {object} [p.contributions]  accumulation only
 * @param {object} [p.wageGrowth]     accumulation only
 * @param {object} [p.spending]       decumulation only
 * @param {object} [p.otherIncome]    decumulation only
 * @param {object} [p.withdrawalPercent] decumulation only
 * @param {'fixedReal'|'fixedPercent'} [p.strategy] decumulation only
 * @param {'conventional'|'proportional'|'bracketFill'} [p.sequencing] decumulation only
 * @param {number} [p.bracketFillRate] `sequencing==='bracketFill'` only (Phase 6, design doc §5)
 * @param {'mfj'|'single'|'hoh'} [p.filingStatus] enables Phase 4 tax-aware decumulation
 * @param {object} [p.taxTables] parsed tax-tables.json
 * @param {number} [p.anchorYear] required if taxTables given
 * @param {object} [p.bracketIndexingRate] setting; default 0
 * @param {object} [p.standardDeductionIndexingRate] setting; default 0
 * @param {number} [p.stateTaxRate] default 0
 * @param {number} [p.birthYear] enables RMDs + age-65 standard deduction; also, when given,
 *   every row in the returned `years` gets an `age` field (year - birthYear)
 * @param {object} [p.earnings] setting (per year), wage-indexed-equivalent annual $ — Social
 *   Security (Phase 5), requires claimingAge/careerStartYear/birthYear/taxTables too. See
 *   socialsecurity.js's docs for what "wage-indexed-equivalent" means (a v1 simplification).
 * @param {number} [p.careerStartYear] first year of SS-covered earnings
 * @param {number} [p.claimingAge] age Social Security is claimed (62-70, whole years)
 * @param {object} [p.colaRate] setting (per year); default 0
 * @param {number} [p.solvencyHaircutStartYear] trust-fund-depletion lever; unset = no haircut
 * @param {number} [p.solvencyHaircutFactor] default 1 (no haircut) — e.g. 0.77 for the OASI
 *   trust fund's projected ~77%-payable scenario starting 2033
 * @returns {{baseYear:number, retirementYear:number, horizonYear:number, years:object[], firstDepletionYear:number|null}}
 */
export function project(p) {
  const { baseYear, retirementYear, horizonYear, accounts } = p;
  if (!Number.isInteger(horizonYear) || horizonYear < retirementYear) {
    throw new Error('project: horizonYear must be an integer >= retirementYear');
  }

  // Social Security (Phase 5): opt-in, requires an earnings history + claiming age + birth year
  // + tax tables (the PIA bend points live there). Computed ONCE here (not per decumulation
  // year — it doesn't depend on withdrawals) using earnings from careerStartYear..retirementYear.
  let socialSecurityStartingBenefit = 0;
  let socialSecurityClaimingYear = null;
  const ssMode = p.claimingAge != null && p.taxTables && Number.isInteger(p.birthYear) && p.earnings && Number.isInteger(p.careerStartYear);
  if (ssMode) {
    if (!Number.isInteger(p.anchorYear)) throw new Error('project: anchorYear is required for Social Security estimation');
    const pia = estimatePIA({
      earnings: p.earnings, careerStartYear: p.careerStartYear, retirementYear,
      birthYear: p.birthYear, tables: p.taxTables, anchorYear: p.anchorYear,
      wageIndexingRate: p.wageGrowth, // bend points scale with wages (AWI), not prices — reuses the accumulation-phase wage-growth assumption rather than adding a dedicated knob
    });
    const fra = fullRetirementAge(p.birthYear);
    socialSecurityStartingBenefit = benefitAtClaimingAge(pia, p.claimingAge, fra, p.taxTables.socialSecurity);
    socialSecurityClaimingYear = Math.round(p.birthYear + p.claimingAge);
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
      // Conservative default (0 = treat as entirely gain) whenever basis can't be determined —
      // matches solveTaxYear's `basisFraction ?? 0` fallback for a missing costBasis, and also
      // covers a taxable account with $0 starting balance (any value it has by decumulation came
      // entirely from untracked growth/contributions, not known original basis).
      basisFraction: a.taxStatus === 'taxable'
        ? (a.balance > 0 ? Math.min(1, Math.max(0, num(a.costBasis) / a.balance)) : 0)
        : undefined,
    }));
    const dec = projectDecumulation({
      startYear: retirementYear + 1, endYear: horizonYear, accounts: decStartAccounts,
      returnRate: p.returnRate, inflation: p.inflation,
      spending: p.spending, otherIncome: p.otherIncome, withdrawalPercent: p.withdrawalPercent,
      strategy: p.strategy, sequencing: p.sequencing, bracketFillRate: p.bracketFillRate,
      startCumulativeInflation: lastAccRow.cumulativeInflation,
      filingStatus: p.filingStatus, taxTables: p.taxTables, anchorYear: p.anchorYear,
      bracketIndexingRate: p.bracketIndexingRate, standardDeductionIndexingRate: p.standardDeductionIndexingRate,
      stateTaxRate: p.stateTaxRate, birthYear: p.birthYear,
      socialSecurityStartingBenefit, socialSecurityClaimingYear,
      colaRate: p.colaRate, solvencyHaircutStartYear: p.solvencyHaircutStartYear, solvencyHaircutFactor: p.solvencyHaircutFactor,
    });
    decYears = dec.years;
    firstDepletionYear = dec.firstDepletionYear;
  }

  const withAge = Number.isInteger(p.birthYear)
    ? (y) => ({ ...y, age: y.year - p.birthYear })
    : (y) => y;

  const years = [
    ...acc.years.map((y) => withAge({ ...y, phase: 'accumulation' })),
    ...decYears.map((y) => withAge({ ...y, phase: 'decumulation' })),
  ];

  return { baseYear, retirementYear, horizonYear, years, firstDepletionYear };
}

/**
 * Binary-search the maximum constant real annual spending (today's dollars, 'fixedReal'
 * strategy) the portfolio sustains through the full horizon — design doc §9's "what's the safe
 * real spending it does support?" Holds every other input fixed and only varies `spending`;
 * `p.strategy` and `p.spending` are both ignored/overridden (the solve wouldn't mean anything
 * against a moving target). Feasibility is monotonic in spending — more nominal $ withdrawn per
 * year can only hasten or cause depletion, never help it — so a binary search is valid: each
 * round tests one candidate spend via a full project() call and narrows toward the boundary
 * where the portfolio JUST lasts (ends at/near $0 by horizonYear rather than running dry early
 * or leaving money unspent).
 *
 * @param {object} p same shape as project() (see its docs); `spending`/`strategy` ignored
 * @param {object} [opts]
 * @param {number} [opts.tolerance] dollars precision to stop narrowing at; default 1
 * @param {number} [opts.maxIterations] binary-search round cap; default 60
 * @returns {{spending: number|null, result: object}} `spending` is the solved today's-dollars
 *   annual amount; null when there's no decumulation phase to solve for (horizonYear <=
 *   retirementYear), in which case `result` is just project()'s own no-op-decumulation output.
 */
export function solveMaxSustainableSpending(p, opts = {}) {
  const tolerance = opts.tolerance ?? 1;
  const maxIterations = opts.maxIterations ?? 60;
  const runAt = (spend) => project({ ...p, strategy: 'fixedReal', spending: { default: spend } });

  const zeroResult = runAt(0);
  if (zeroResult.horizonYear <= zeroResult.retirementYear) {
    return { spending: null, result: zeroResult };
  }

  let lo = 0, loResult = zeroResult;
  let hi = 1000;
  let hiResult = runAt(hi);
  let doublings = 0;
  // Grow hi until it's genuinely infeasible (or we hit a sane cap) — starting hi=1000 could
  // already be sustainable for a small portfolio, in which case doubling finds the real ceiling.
  while (hiResult.firstDepletionYear == null && hi < 1e9 && doublings < 40) {
    hi *= 2;
    hiResult = runAt(hi);
    doublings++;
  }

  for (let i = 0; i < maxIterations && hi - lo > tolerance; i++) {
    const mid = (lo + hi) / 2;
    const midResult = runAt(mid);
    if (midResult.firstDepletionYear == null) { lo = mid; loResult = midResult; }
    else hi = mid;
  }
  return { spending: lo, result: loResult };
}
