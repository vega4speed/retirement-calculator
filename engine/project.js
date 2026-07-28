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

import { resolve, explainResolve } from './resolver.js';
import {
  resolveYearTable, ordinaryTax, capitalGainsTax, standardDeduction, taxableSocialSecurity,
  requiredBeginningAge, rmdAmount, cumulativeFactor, bracketTopForRate, marginalRateForIncome,
  grossUpDeduction, hsaContributionLimit, iraContributionLimit, electiveDeferralLimit, rothIraPhaseOutFactor,
} from './tax.js';
import { estimatePIA, benefitAtClaimingAge, fullRetirementAge } from './socialsecurity.js';

// Combined employee-side Social Security (6.2%) + Medicare (1.45%) payroll tax rate. A flat
// approximation (no wage-base cap, no Additional Medicare Tax threshold) -- see project.js's
// contribution docs for why this only matters for HSA-via-payroll, never for 401(k)/IRA.
const DEFAULT_FICA_RATE = 0.0765;
// Standard employer-match assumption for the contribution waterfall below: 100% match up to 4%
// of pay. Plain constants, not resolver settings (a scope simplification -- a per-year-varying
// match formula is a real but unlikely need; see the contribution-waterfall docs).
const DEFAULT_MATCH_RATE = 1.0;
const DEFAULT_MATCH_CAP_PERCENT = 0.04;

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
 * The standard "investment order" waterfall (design doc, Phase 6.7): given ONE overall take-home
 * budget for the year, fill four tiers in priority order -- the employer plan up to the match,
 * HSA to its max, Roth IRA to its (phase-out-adjusted) limit, then back to the employer plan for
 * whatever's left of the budget -- rather than the caller typing a separate number into each
 * account's own `contributions` setting.
 *
 * Which account plays which role is normally "the first account of a given taxStatus" (a
 * v1/single-person scope simplification -- others of the same status keep using their own
 * independent `contributions` setting instead), but can be overridden per-account via
 * `account.waterfallRole` ('employerPlan' | 'employerMatch' | 'rothIra' | 'none') -- see below.
 *
 * `waterfallRole: 'employerPlan'` decouples "which IRS limit + match rules apply" from
 * `taxStatus`: a Roth 401(k) needs `taxStatus: 'roth'` for tax treatment (post-tax contributions,
 * tax-free growth) but the BIG 401(k) elective-deferral limit (electiveDeferralLimit(), shared
 * with a Traditional 401(k) under real IRS rules) rather than the small Roth IRA limit tier 3
 * assumes. Its contribution is funded pre-tax (reduces `runningBefore`) when the account's
 * `taxStatus` is 'taxDeferred', or dollar-for-dollar post-tax (no `runningBefore` change) when
 * it's 'roth' -- same branching `fundEmployerPlan` below applies at both the match-cap tier and
 * the tier-4 spillover. (A plan offering BOTH elections, sharing one real combined limit, IS
 * modeled now -- mark the Traditional side 'employerPlan' and the Roth side 'employerPlanRoth',
 * described below. Only one account can hold each role.)
 *
 * `waterfallRole: 'employerMatch'` is a SEPARATE, independently-assignable role: real 401(k)
 * plans near-universally deposit the employer match into a separate Traditional sub-account even
 * when the employee's own election is Roth. Defaults to the same account as 'employerPlan' when
 * not set (today's exact behavior, since historically there was only ever one tier-1 account).
 *
 * Tier 3 ('rothIra', or the first 'roth' account not already claimed as 'employerPlan' or marked
 * 'none') assumes a ROTH IRA (the smaller, separate IRS limit) -- a real, documented assumption,
 * not a general Roth-account cap.
 *
 * `waterfallRole: 'employerPlanRoth'` (2026-07-28) is the ROTH SIDE of a plan that offers both --
 * a real 401(k)/403(b) where you can split one elective deferral between a Traditional and a Roth
 * election. It shares `electiveRoom` with the 'employerPlan' account (real IRS rule: ONE combined
 * employee limit across both elections, not one each), is funded dollar-for-dollar post-tax like
 * any other Roth, and runs as its own tier AFTER the Roth IRA tier and BEFORE the Traditional
 * spillover -- so under 'bracketAware' the budget left over once income has been deducted down to
 * the bracket ceiling lands in the Roth side of the plan rather than going back to Traditional.
 * It's excluded from tier 3's Roth-IRA fallback search (being claimed there instead would cap it
 * at the much smaller IRA limit -- exactly the bug this role exists to avoid). Use it for the
 * SECOND side of a plan whose Traditional side is marked 'employerPlan'; a Roth-ONLY plan should
 * still use 'employerPlan' itself (that path already funds post-tax at the elective limit, and is
 * what drives the tier-1 match).
 *
 * `waterfallRole: 'none'` opts an account OUT of every fallback search above -- without it, a
 * household with SEVERAL Roth (or Traditional) accounts and only one explicitly given a role
 * would still have its OTHER, otherwise-unrelated accounts silently swept into a fallback tier
 * (which then computes its own contribution and ignores that account's independent
 * `contributions` setting/override entirely) -- a real bug found when a user marked one Roth
 * account 'employerPlan' and expected their other Roth accounts to stay untouched.
 *
 * Employer match is NOT part of your own budget -- it's free money added on top, tracked
 * separately (`employerMatchByAccount`), and never touches `runningBefore`: it was never your
 * wages to begin with, so it never touched your taxable income (unlike your own elective
 * deferral, which reduces Box 1 wages).
 *
 * ORDER 'bracketAware' (2026-07-27), an alternative to the 'standard' order above: match, HSA max,
 * then TRADITIONAL only as far as it takes to pull taxable income down to the top of a chosen
 * ordinary bracket, then Roth for the rest. It's the accumulation-side mirror of decumulation's
 * `bracketFill` sequencing, and it exists because the standard order routes tier-3 dollars to Roth
 * regardless of what rate they'd otherwise be taxed at: deducting a dollar that would be taxed at
 * 22% is worth more than deducting one taxed at 12%, so the deduction goes to the expensive
 * dollars first and the cheap ones (at/below the ceiling) go to Roth instead. Tiers:
 *   1. employer plan up to the match cap        (unchanged)
 *   2. HSA to its max                           (unchanged)
 *   3. Traditional, sized as `runningBefore - bracketTopForRate(p.rothBracketRate)` -- i.e. only
 *      the income ABOVE the ceiling gets deducted; if income already sits at/below the ceiling
 *      this tier funds $0 and everything falls through to Roth. Capped by the elective-deferral
 *      limit when the pre-tax account IS the employer plan, else by the IRA limit (a taxDeferred
 *      account that isn't the employer plan is assumed to be a Traditional IRA -- the same
 *      flavor of assumption tier 4 already makes about "the first roth account is a Roth IRA").
 *   4. Roth IRA to its (phase-out-adjusted) limit
 *   5. back to the employer plan for anything left, as in the standard order
 * Note tiers 1-2 shrink `runningBefore` before tier 3 measures it, so the match and HSA deductions
 * legitimately count toward reaching the ceiling -- tier 3 only funds what's still needed.
 *
 * @param {object} p
 * @param {{id:string, taxStatus:string, hsaViaPayroll?:boolean, waterfallRole?:('employerPlan'|'employerPlanRoth'|'employerMatch'|'rothIra'|'none')}[]} p.accounts
 * @param {number} p.income        this year's nominal income
 * @param {number|null} p.age
 * @param {number} p.runningBefore taxable income position BEFORE the waterfall's own deductions
 *   (income - standard deduction, net of anything already deducted ahead of it)
 * @param {object} p.yearTable     resolved via tax.resolveYearTable
 * @param {'mfj'|'single'|'hoh'} p.filingStatus
 * @param {number} p.ficaRate
 * @param {'selfOnly'|'family'} p.hsaCoverage
 * @param {number} [p.matchRate]        fraction of the employee's tier-1 contribution matched; default DEFAULT_MATCH_RATE
 * @param {number} [p.matchCapPercent]  fraction of income eligible for match; default DEFAULT_MATCH_CAP_PERCENT
 * @param {number} p.budget             this year's overall NET take-home budget
 * @param {object} p.fixedTables        tax-tables.json's `fixed` block (for hsaContributionLimit)
 * @param {'standard'|'bracketAware'} [p.order] default 'standard'
 * @param {number} [p.rothBracketRate]  'bracketAware' only: the ordinary bracket whose TOP is the
 *   floor Traditional deducts down to (e.g. 0.12 ⇒ deduct until taxable income reaches the top of
 *   the 12% bracket, then switch to Roth). Must match a rate in the year's ordinary brackets; no
 *   match ⇒ no ceiling, i.e. Traditional absorbs the whole budget (bracketTopForRate's own
 *   convention, same as decumulation's bracketFill).
 * @returns {{contributionByAccount:Record<string,number>, employerMatchByAccount:Record<string,number>, netContributionCostByAccount:Record<string,number>, claimedAccountIds:Set<string>, runningBefore:number}}
 */
function computeContributionWaterfall(p) {
  const { accounts, income, age, filingStatus, ficaRate, hsaCoverage, yearTable, fixedTables } = p;
  const matchRate = p.matchRate ?? DEFAULT_MATCH_RATE;
  const matchCapPercent = p.matchCapPercent ?? DEFAULT_MATCH_CAP_PERCENT;
  const brackets = yearTable.ordinaryBrackets[filingStatus];

  const contributionByAccount = {};
  const employerMatchByAccount = {};
  const netContributionCostByAccount = {};
  const claimedAccountIds = new Set();
  let runningBefore = p.runningBefore;
  let remainingBudget = Math.max(0, num(p.budget));

  // Every tier spends `remainingBudget` (a NET take-home figure) by exactly its net cost,
  // regardless of tier -- so the budget delta around a funding call IS that account's net cost,
  // with no need to duplicate each tier's own gross-up math. Accumulates (not overwrites) since
  // the employer-plan account can be funded twice (the match-cap tier, then the tier-4 spillover).
  const trackNetCost = (accountId, fn) => {
    const before = remainingBudget;
    const result = fn();
    netContributionCostByAccount[accountId] = (netContributionCostByAccount[accountId] || 0) + (before - remainingBudget);
    return result;
  };

  const taxSavedFor = (gross) =>
    ordinaryTax(runningBefore, filingStatus, yearTable) - ordinaryTax(Math.max(0, runningBefore - gross), filingStatus, yearTable);

  // Fund up to `desiredGross` from the current tier -- fully, if the remaining budget covers its
  // full net cost, or partially (whatever the remaining budget grosses up to) otherwise. Returns
  // the ACTUAL gross amount funded; mutates runningBefore/remainingBudget as a side effect.
  const fundTier = (desiredGross, tierFicaRate) => {
    if (desiredGross <= 1e-9 || remainingBudget <= 1e-9) return 0;
    const netCostFull = desiredGross * (1 - tierFicaRate) - taxSavedFor(desiredGross);
    if (netCostFull <= remainingBudget + 1e-9) {
      runningBefore = Math.max(0, runningBefore - desiredGross);
      remainingBudget -= netCostFull;
      return desiredGross;
    }
    const actual = grossUpDeduction(remainingBudget, runningBefore, brackets, tierFicaRate);
    runningBefore = Math.max(0, runningBefore - actual);
    remainingBudget = 0;
    return actual;
  };

  // The employer-plan tier's OWN contribution: pre-tax (reduces runningBefore, via fundTier) when
  // the account is Traditional, post-tax dollar-for-dollar (no runningBefore change) when it's a
  // Roth 401(k) -- same "no deduction, no gross-up" treatment as the Roth IRA tier below.
  const fundEmployerPlan = (account, desiredGross) => {
    if (account.taxStatus === 'roth') {
      const actual = Math.min(Math.max(0, desiredGross), remainingBudget);
      remainingBudget -= actual;
      return actual;
    }
    return fundTier(desiredGross, 0);
  };

  // 'none' opts an account OUT of every fallback search below -- without it, a household with
  // several Roth accounts and only ONE explicitly assigned a role would still have its OTHER,
  // unrelated Roth accounts silently swept into the Roth-IRA fallback tier (which then computes
  // its own contribution and stops reading that account's independent `contributions` setting).
  const fallbackEligible = (a) => a.waterfallRole !== 'none';

  const employerPlanAccount = accounts.find((a) => a.waterfallRole === 'employerPlan')
    ?? accounts.find((a) => a.taxStatus === 'taxDeferred' && fallbackEligible(a)); // legacy fallback, unchanged behavior
  const employerMatchAccount = accounts.find((a) => a.waterfallRole === 'employerMatch')
    ?? employerPlanAccount; // legacy fallback: match lands wherever the contribution does, as today
  const hsaAccount = accounts.find((a) => a.taxStatus === 'hsa');
  // The Roth side of an employer plan that offers both -- never swept into the Roth IRA tier below
  // (that would cap it at the IRA limit instead of the shared elective-deferral limit).
  const rothPlanAccount = accounts.find((a) => a.waterfallRole === 'employerPlanRoth'
    && a.taxStatus === 'roth' && a.id !== employerPlanAccount?.id);
  const notRothPlan = (a) => a.id !== rothPlanAccount?.id;
  const rothIraAccount = accounts.find((a) => a.waterfallRole === 'rothIra' && a.id !== employerPlanAccount?.id && notRothPlan(a))
    ?? accounts.find((a) => a.taxStatus === 'roth' && a.id !== employerPlanAccount?.id && notRothPlan(a) && fallbackEligible(a)); // legacy fallback

  // ONE elective-deferral limit covers the Traditional and Roth sides together (real IRS rule).
  let electiveRoom = (employerPlanAccount || rothPlanAccount) ? electiveDeferralLimit(age, yearTable) : 0;
  if (employerPlanAccount) {
    claimedAccountIds.add(employerPlanAccount.id);
    if (employerMatchAccount) {
      claimedAccountIds.add(employerMatchAccount.id);
      // A distinct match-only account (e.g. Traditional match alongside a Roth 401(k) employee
      // election) is claimed here but never separately "funded" -- it receives ONLY the employer
      // match below, no employee contribution of its own. Without this, its contributionByAccount
      // entry would stay unset (undefined), and the caller adds it directly into endBalance math.
      if (employerMatchAccount.id !== employerPlanAccount.id) contributionByAccount[employerMatchAccount.id] = 0;
    }
    const matchCap = matchCapPercent * income;
    const tier1Desired = Math.min(matchCap, electiveRoom);
    const tier1Actual = trackNetCost(employerPlanAccount.id, () => fundEmployerPlan(employerPlanAccount, tier1Desired));
    contributionByAccount[employerPlanAccount.id] = tier1Actual;
    if (employerMatchAccount) {
      employerMatchByAccount[employerMatchAccount.id] = tier1Actual * matchRate;
    }
    electiveRoom -= tier1Actual;
  }

  if (hsaAccount) {
    claimedAccountIds.add(hsaAccount.id);
    const hsaViaPayroll = hsaAccount.hsaViaPayroll !== false;
    const hsaCap = hsaContributionLimit(hsaCoverage, age, yearTable, fixedTables);
    contributionByAccount[hsaAccount.id] = trackNetCost(hsaAccount.id, () => fundTier(hsaCap, hsaViaPayroll ? ficaRate : 0));
  }

  // Tier 3, 'bracketAware' only: Traditional, but ONLY down to the chosen bracket's top -- the
  // dollars above the ceiling are the expensive ones worth deducting; the rest go to Roth below.
  // The pre-tax target is the employer plan when that account is itself Traditional (capped by
  // what's left of the elective-deferral limit), else the first other taxDeferred account, assumed
  // to be a Traditional IRA and capped accordingly.
  if (p.order === 'bracketAware') {
    const viaEmployerPlan = employerPlanAccount?.taxStatus === 'taxDeferred';
    const preTaxAccount = viaEmployerPlan
      ? employerPlanAccount
      : accounts.find((a) => a.taxStatus === 'taxDeferred' && fallbackEligible(a));
    if (preTaxAccount) {
      const ceiling = p.rothBracketRate != null ? bracketTopForRate(p.rothBracketRate, brackets) : Infinity;
      // Infinity ceiling (no bracket picked, or a rate matching no bracket) ⇒ nothing is "cheap",
      // so Traditional takes whatever the budget allows -- the room cap below is what bounds it.
      const aboveCeiling = ceiling === Infinity ? Infinity : Math.max(0, runningBefore - ceiling);
      const room = viaEmployerPlan ? electiveRoom : iraContributionLimit(age, yearTable);
      const desired = Math.min(aboveCeiling, room);
      if (desired > 1e-9) {
        claimedAccountIds.add(preTaxAccount.id);
        const actual = trackNetCost(preTaxAccount.id, () => fundTier(desired, 0));
        contributionByAccount[preTaxAccount.id] = (contributionByAccount[preTaxAccount.id] || 0) + actual;
        if (viaEmployerPlan) electiveRoom -= actual;
      }
    }
  }

  if (rothIraAccount) {
    claimedAccountIds.add(rothIraAccount.id);
    const rothCap = iraContributionLimit(age, yearTable) * rothIraPhaseOutFactor(income, filingStatus, yearTable);
    // Roth IRA: no deduction, no gross-up -- straight dollar-for-dollar against the remaining budget.
    const rothActual = Math.min(Math.max(0, rothCap), remainingBudget);
    contributionByAccount[rothIraAccount.id] = rothActual;
    netContributionCostByAccount[rothIraAccount.id] = (netContributionCostByAccount[rothIraAccount.id] || 0) + rothActual;
    remainingBudget -= rothActual;
  }

  // The Roth side of the employer plan: post-tax dollar-for-dollar (no deduction, no gross-up),
  // drawing on the SAME electiveRoom the Traditional side has already spent from. Sits ahead of
  // the Traditional spillover below so that 'bracketAware' does what it says -- once income has
  // been deducted to the bracket ceiling, the rest of the budget goes Roth rather than deducting
  // dollars that were never worth deducting.
  if (rothPlanAccount) {
    claimedAccountIds.add(rothPlanAccount.id);
    const actual = Math.min(Math.max(0, electiveRoom), remainingBudget);
    contributionByAccount[rothPlanAccount.id] = (contributionByAccount[rothPlanAccount.id] || 0) + actual;
    netContributionCostByAccount[rothPlanAccount.id] = (netContributionCostByAccount[rothPlanAccount.id] || 0) + actual;
    remainingBudget -= actual;
    electiveRoom -= actual;
  }

  if (employerPlanAccount && electiveRoom > 1e-9) {
    contributionByAccount[employerPlanAccount.id] += trackNetCost(employerPlanAccount.id, () => fundEmployerPlan(employerPlanAccount, electiveRoom));
  }

  return { contributionByAccount, employerMatchByAccount, netContributionCostByAccount, claimedAccountIds, runningBefore };
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
 * PRE-TAX by default (unchanged since Phase 2): omit `income`/`filingStatus`/`taxTables` and
 * nothing below applies — every existing Phase 2/3 golden-number test stays valid unchanged.
 *
 * TAX-AWARE, opt-in (Phase 6.5): with `filingStatus` + `taxTables` + `anchorYear` supplied, each
 * working year also computes a real federal tax bill on `income` (the SAME wage-indexed-
 * equivalent `earnings` setting Social Security draws on — one input, escalated to NOMINAL
 * dollars for the year by cumulative wage growth, same convention `contributions` already uses).
 *
 * Contribution semantics (Phase 6.6 — take-home-pay-anchored, not gross-$-anchored): comparing a
 * $1,000 Roth contribution to a $1,000 Traditional contribution dollar-for-dollar isn't a fair
 * "which costs my lifestyle more" comparison — Roth is post-tax (costs $1,000 of take-home pay,
 * full stop) while Traditional is pre-tax (that same $1,000 gross only costs take-home pay of
 * $1,000*(1-yourMarginalRate), since it shields itself from tax). So for accounts with
 * `taxStatus` in {'taxDeferred', 'hsa'} (both get a real deduction here — see below), the
 * resolved `contributions` value is interpreted as the NET take-home cost you're willing to give
 * up, and the engine solves BACKWARD for the larger GROSS amount that actually lands in the
 * account, via tax.grossUpDeduction's exact bracket walk (not a flat 1/(1-marginalRate)
 * approximation, which would overstate the gross amount whenever the deduction spans more than
 * one bracket). For every other tax status (roth/taxable/cash) the resolved value is still the
 * literal gross $ that lands in the account — there's no deduction to gross up.
 *
 * `contributionMode` picks how the resolved contribution number itself is read: 'dollar' (default)
 * is a base-year $ amount escalated by cumulative wage growth, same as before; 'percentOfIncome'
 * reads it as a fraction of THIS year's `income` directly (already wage-growth-escalated via
 * `income` itself, so no separate cumWage multiply) — e.g. Dave Ramsey's "15% of gross income"
 * heuristic, applied as 15% of take-home cost for a Roth and grossed up further for Traditional.
 * `percentOfIncome` requires tax mode (there's no income figure without it); contributions
 * resolve to 0 if selected without tax mode rather than crashing.
 *
 * Multiple accounts with taxStatus in {'taxDeferred','hsa'} pool into ONE combined deduction
 * against taxable income (real tax law: the deduction is against your total taxable income, not
 * per-account) — so they're grossed up SEQUENTIALLY in `accounts` array order, each one walking
 * the brackets from wherever the previous one left off, rather than independently (which would
 * double-count the same cheap bracket room across accounts). This makes the split between
 * multiple such accounts's OWN gross amounts order-dependent (whichever is processed first "gets"
 * the cheaper bracket room) — a real but minor wrinkle, same flavor as sequencing order mattering
 * elsewhere in this engine (e.g. RMD floors going first in withdrawal sequencing).
 *
 * HSA contributions (`taxStatus:'hsa'`) join the SAME deduction pool as Traditional 401(k)/IRA —
 * real tax law: HSA contributions reduce federal taxable income just like a 401(k)'s, whether
 * made via payroll or claimed as an above-the-line deduction. Two HSA-specific per-account flags
 * (on the `accounts` array entries) layer on top:
 *   - `hsaMaxOut` (boolean): bypasses net-cost-anchoring entirely for that account — the GROSS
 *     contribution is fixed at that year's indexed HSA limit (tax.hsaContributionLimit, using
 *     `p.hsaCoverage` and age for the 55+ catch-up) rather than solved from a net-cost target.
 *     The take-home cost is then derived (informational) rather than being the input.
 *   - `hsaViaPayroll` (boolean, default true when omitted): whether the contribution passes
 *     through a Section 125 cafeteria plan. When true, it ALSO skips FICA (Social Security +
 *     Medicare payroll tax, `p.ficaRate`, default 7.65%) — one of HSA's real tax advantages over
 *     a Traditional 401(k), which reduces income-tax wages (W-2 Box 1) but NEVER payroll-tax
 *     wages (Box 3/5), regardless of contribution method. Set false if the HSA is instead funded
 *     after-tax and deducted on the return, which gets the income-tax benefit but not the FICA one.
 *
 * Roth conversions during accumulation (opt-in `rothConversionsEnabled` + `bracketFillRate`,
 * same knobs as decumulation's — design doc §5, extended to the working years by request):
 * whatever room is left in the chosen bracket after job income (net of tax-deferred
 * contributions) gets converted from tax-deferred to Roth, using the ACCOUNT'S balance as of the
 * START of the year (not this year's own contribution/growth). Unlike decumulation's version,
 * there's no portfolio withdrawal to gross up — the conversion's tax is assumed paid from take-
 * home pay / other savings (you have a job; that's the whole point of "accumulation"), so it's
 * purely informational here, not funded from any modeled account. In practice this will often be
 * $0 for someone working full-time: ordinary job income alone frequently already exceeds a
 * modest bracket ceiling, leaving no room — that's a correct result, not a bug.
 *
 * @param {object} p
 * @param {number} p.startYear       baseline (snapshot) year; row t=0 holds current balances
 * @param {number} p.endYear         last accumulation year (retirement); inclusive, >= startYear
 * @param {{id:string, balance:number, taxStatus?:string, hsaMaxOut?:boolean, hsaViaPayroll?:boolean}[]} p.accounts
 *   taxStatus/hsaMaxOut/hsaViaPayroll are only used by tax-aware mode (the deduction + conversion
 *   mechanics above); harmless to omit otherwise
 * @param {object} p.returnRate      setting (per account/year)
 * @param {object} [p.contributions] setting; meaning depends on p.contributionMode. default 0
 * @param {'dollar'|'percentOfIncome'} [p.contributionMode] default 'dollar'
 * @param {object} [p.wageGrowth]    setting (per year); default 0
 * @param {object} [p.inflation]     setting (per year); default 0
 * @param {object} [p.income] setting (per year), wage-indexed-equivalent annual $ — enables
 *   tax-aware mode together with filingStatus/taxTables/anchorYear
 * @param {'mfj'|'single'|'hoh'} [p.filingStatus]
 * @param {object} [p.taxTables] parsed tax-tables.json
 * @param {number} [p.anchorYear] required if taxTables given — see tax.resolveYearTable
 * @param {object} [p.bracketIndexingRate] setting; default 0
 * @param {object} [p.standardDeductionIndexingRate] setting; default 0
 * @param {number} [p.stateTaxRate] flat rate; default 0
 * @param {number} [p.birthYear] enables the standard deduction's age-65 addition (rare during
 *   working years, but kept consistent with decumulation's handling) and the HSA 55+ catch-up
 * @param {'selfOnly'|'family'} [p.hsaCoverage] default 'selfOnly'; drives hsaMaxOut's limit
 * @param {number} [p.ficaRate] default 0.0765; see hsaViaPayroll above
 * @param {boolean} [p.rothConversionsEnabled] see the conversions section above
 * @param {number} [p.bracketFillRate] the ordinary rate to fill up to; required with
 *   rothConversionsEnabled (see tax.bracketTopForRate)
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
  const contributionMode = p.contributionMode ?? 'dollar';
  const wageGrowth = p.wageGrowth ?? { default: 0 };
  const inflation = p.inflation ?? { default: 0 };
  const taxMode = !!(p.income && p.filingStatus && p.taxTables);
  if (taxMode && !Number.isInteger(p.anchorYear)) {
    throw new Error('projectAccumulation: anchorYear is required when taxTables is provided');
  }
  const stateTaxRate = num(p.stateTaxRate);
  const ficaRate = p.ficaRate ?? DEFAULT_FICA_RATE;
  const hsaCoverage = p.hsaCoverage === 'family' ? 'family' : 'selfOnly';

  const bal = {};
  for (const a of accounts) bal[a.id] = num(a.balance);

  const years = [];

  // Baseline row (t=0): current balances, no flows.
  {
    const acc = {};
    for (const a of accounts) {
      acc[a.id] = { startBalance: bal[a.id], contribution: 0, conversion: 0, growth: 0, endBalance: bal[a.id] };
    }
    const totals = rowTotals(acc, ['contribution']);
    totals.conversion = 0;
    years.push({ year: startYear, t: 0, cumulativeInflation: 1, accounts: acc, totals, real: { endBalance: totals.endBalance } });
  }

  let cumInflation = 1; // relative to startYear
  let cumWage = 1;      // wage-growth factor relative to startYear

  for (let year = startYear + 1; year <= endYear; year++) {
    cumInflation *= 1 + num(resolve(inflation, { year }));
    cumWage *= 1 + num(resolve(wageGrowth, { year }));

    // Income & the year's resolved tax table are needed BEFORE contributions now (net-cost
    // gross-up needs a taxable-income position to walk down from; percentOfIncome mode needs
    // `income` directly) — computed once here, reused by both the contribution pass and the tax
    // pass below.
    let income = 0, taxableIncome = 0, tax = 0, marginalRate = 0, effectiveTaxRate = 0, conversionAmount = 0, grossIncome = 0;
    const conversionFlow = Object.fromEntries(accounts.map((a) => [a.id, 0]));
    const netContributionCost = {}; // informational per-account take-home cost (UI display only)
    let yearTable = null, stdDeduction = 0, age = null;
    if (taxMode) {
      income = num(resolve(p.income, { year })) * cumWage;
      age = Number.isInteger(p.birthYear) ? year - p.birthYear : null;
      yearTable = resolveYearTable({
        tables: p.taxTables, year, anchorYear: p.anchorYear,
        bracketIndexingRate: p.bracketIndexingRate, standardDeductionIndexingRate: p.standardDeductionIndexingRate,
      });
      stdDeduction = standardDeduction({ filingStatus: p.filingStatus, age65Count: age != null && age >= 65 ? 1 : 0, yearTable });
    }

    // Pass 1: this year's contribution per account (doesn't touch balances yet). Accounts with
    // taxStatus 'taxDeferred' or 'hsa' pool into ONE combined deduction, grossed up SEQUENTIALLY
    // in accounts-array order (see the contribution-semantics docs above) rather than
    // independently. Everything else (roth/taxable/cash) is dollar-for-dollar, no gross-up.
    const contributionByAccount = {};
    const employerMatchByAccount = {};
    if (taxMode) {
      const brackets = yearTable.ordinaryBrackets[p.filingStatus];
      let runningBefore = Math.max(0, income - stdDeduction);
      // The contribution waterfall (Phase 6.7, opt-in) claims up to 3 accounts (first taxDeferred,
      // first hsa, first roth) and computes their contributions FIRST, from one shared take-home
      // budget -- see computeContributionWaterfall's docs. Claimed accounts are then SKIPPED by
      // the normal per-account loop below, which continues from wherever the waterfall left
      // `runningBefore` for any remaining tax-advantaged accounts (still one shared deduction pool).
      const claimedByWaterfall = new Set();
      if (p.contributionWaterfallEnabled) {
        const rawBudget = num(resolve(p.waterfallBudget ?? { default: 0 }, { year }));
        const budget = contributionMode === 'percentOfIncome' ? rawBudget * income : rawBudget * cumWage;
        const wf = computeContributionWaterfall({
          accounts, income, age, runningBefore, yearTable, fixedTables: p.taxTables.fixed,
          filingStatus: p.filingStatus, ficaRate, hsaCoverage,
          matchRate: p.matchRate, matchCapPercent: p.matchCapPercent, budget,
          order: p.waterfallOrder, rothBracketRate: p.waterfallRothBracketRate,
        });
        Object.assign(contributionByAccount, wf.contributionByAccount);
        Object.assign(employerMatchByAccount, wf.employerMatchByAccount);
        Object.assign(netContributionCost, wf.netContributionCostByAccount);
        for (const id of wf.claimedAccountIds) claimedByWaterfall.add(id);
        runningBefore = wf.runningBefore;
      }
      // An account the waterfall did NOT claim (a second account of a role it already filled)
      // used to silently fall back to the global `contributions` default, stacking that same
      // percentage/dollar figure on top of the waterfall's shared budget once per extra account --
      // multiplying the intended contribution by however many similar accounts exist. Now it
      // defaults to $0 instead, UNLESS the user set an override specifically for THIS account
      // (byAccount/byAccountYear) -- that's a deliberate opt-back-in, still honored.
      const resolveUnclaimedContribution = (accountId) => {
        if (p.contributionWaterfallEnabled && !claimedByWaterfall.has(accountId)) {
          const { level } = explainResolve(contributions, { accountId, year });
          if (level !== 'byAccount' && level !== 'byAccountYear') return 0;
        }
        return num(resolve(contributions, { accountId, year }));
      };
      for (const a of accounts) {
        if (a.taxStatus !== 'taxDeferred' && a.taxStatus !== 'hsa') continue;
        if (claimedByWaterfall.has(a.id)) continue;
        const viaPayroll = a.taxStatus === 'hsa' && a.hsaViaPayroll !== false;
        const accountFicaRate = viaPayroll ? ficaRate : 0;
        if (a.taxStatus === 'hsa' && a.hsaMaxOut) {
          const gross = hsaContributionLimit(hsaCoverage, age, yearTable, p.taxTables.fixed);
          const taxSaved = ordinaryTax(runningBefore, p.filingStatus, yearTable)
            - ordinaryTax(Math.max(0, runningBefore - gross), p.filingStatus, yearTable);
          contributionByAccount[a.id] = gross;
          netContributionCost[a.id] = gross * (1 - accountFicaRate) - taxSaved;
          runningBefore = Math.max(0, runningBefore - gross);
        } else {
          const raw = resolveUnclaimedContribution(a.id);
          const netCost = contributionMode === 'percentOfIncome' ? raw * income : raw * cumWage;
          const gross = grossUpDeduction(netCost, runningBefore, brackets, accountFicaRate);
          contributionByAccount[a.id] = gross;
          netContributionCost[a.id] = netCost;
          runningBefore = Math.max(0, runningBefore - gross);
        }
      }
      taxableIncome = runningBefore;
      for (const a of accounts) {
        if (a.taxStatus === 'taxDeferred' || a.taxStatus === 'hsa') continue;
        if (claimedByWaterfall.has(a.id)) continue;
        const raw = resolveUnclaimedContribution(a.id);
        contributionByAccount[a.id] = contributionMode === 'percentOfIncome' ? raw * income : raw * cumWage;
      }
    } else {
      for (const a of accounts) {
        if (contributionMode === 'percentOfIncome') { contributionByAccount[a.id] = 0; continue; } // no income figure without tax mode
        const raw = num(resolve(contributions, { accountId: a.id, year }));
        contributionByAccount[a.id] = raw * cumWage;
      }
    }

    if (taxMode) {
      if (p.rothConversionsEnabled && p.bracketFillRate != null) {
        const ceiling = bracketTopForRate(p.bracketFillRate, yearTable.ordinaryBrackets[p.filingStatus]);
        const roomLeft = Math.max(0, ceiling - taxableIncome);
        const tdAccounts = accounts.filter((a) => a.taxStatus === 'taxDeferred');
        const tdStartBalance = tdAccounts.reduce((s, a) => s + Math.max(0, bal[a.id]), 0);
        const targetId = accounts.find((a) => a.taxStatus === 'roth')?.id;
        const desired = Math.min(roomLeft, tdStartBalance);
        if (desired > 1e-9 && targetId) {
          let remaining = desired;
          for (const a of tdAccounts) {
            if (remaining <= 0) break;
            const avail = Math.max(0, bal[a.id]);
            const take = Math.min(avail, remaining);
            conversionFlow[a.id] -= take;
            remaining -= take;
          }
          conversionAmount = desired - remaining;
          conversionFlow[targetId] += conversionAmount;
          taxableIncome += conversionAmount;
        }
      }

      const fedTax = ordinaryTax(taxableIncome, p.filingStatus, yearTable);
      tax = fedTax + stateTaxRate * taxableIncome;
      marginalRate = marginalRateForIncome(taxableIncome, yearTable.ordinaryBrackets[p.filingStatus]);
      // Denominator includes the conversion (money that moved and got taxed, even though it's a
      // transfer between your own accounts rather than new income) — same convention
      // decumulation's totals.grossIncome/effectiveTaxRate already use for ITS conversions
      // (folded into totals.withdrawal there). Without this, a year with a big conversion but
      // modest job income would show a misleadingly huge effective rate: e.g. $5,800 tax on
      // $20,000 job income alone reads as 29%, but the $5,800 is really taxing $66,500 of total
      // ordinary income (job + conversion) — 8.7%, the number that actually reflects what happened.
      grossIncome = income + conversionAmount;
      effectiveTaxRate = grossIncome > 1e-9 ? tax / grossIncome : 0;
    }

    // Pass 2: apply the conversion flow (if any), then growth, then this year's contribution —
    // same "contributions land at year-end, no growth in the year they're made" convention as
    // before; the conversion (a balance transfer, not new money) DOES grow this year, since it's
    // effectively money that was already there, just relocated.
    const acc = {};
    let netContributionCostTotal = 0;
    for (const a of accounts) {
      const startBalance = bal[a.id];
      const contribution = contributionByAccount[a.id];
      const employerMatch = employerMatchByAccount[a.id] || 0;
      const remainder = startBalance + conversionFlow[a.id];
      const r = num(resolve(returnRate, { accountId: a.id, year }));
      const growth = remainder * r;
      // Employer match is free money on top of your own contribution -- lands in the account the
      // same as a contribution, but isn't yours (see computeContributionWaterfall's docs).
      const endBalance = remainder + growth + contribution + employerMatch;
      bal[a.id] = endBalance;
      // netCost: informational take-home-pay cost for tax-advantaged accounts (see the
      // contribution-semantics docs above) -- undefined for roth/taxable/cash, where the
      // contribution figure already IS the take-home cost (no gross-up to report).
      const netCost = netContributionCost[a.id];
      // taxSaved/ficaSaved: splits the (contribution - netCost) gap EXACTLY, not by estimating a
      // rate -- ficaRate only ever applies to an HSA-via-payroll account (Traditional 401(k)/IRA
      // NEVER get a FICA exemption, regardless of contribution method, a real tax-law fact this
      // app already models elsewhere), so ficaSaved is a fixed, known-correct amount and taxSaved
      // is simply whatever's left of the gap -- correct regardless of which code path (the
      // waterfall's tiers or the independent per-account gross-up) produced the contribution.
      const accountFicaRate = a.taxStatus === 'hsa' && a.hsaViaPayroll !== false ? ficaRate : 0;
      const ficaSaved = netCost != null ? contribution * accountFicaRate : undefined;
      const taxSaved = netCost != null ? contribution - netCost - ficaSaved : undefined;
      acc[a.id] = { startBalance, contribution, employerMatch, netCost, taxSaved, ficaSaved, conversion: conversionFlow[a.id], growth, endBalance };
      if (netCost != null) netContributionCostTotal += netCost;
    }
    // NOT auto-summed via rowTotals: acc[id].conversion is SIGNED (negative on the source
    // account, positive on the target), so a plain sum across accounts always nets to exactly
    // zero (it's a transfer between two of the same household's accounts, not new money). What
    // "how much was converted this year" actually means is the magnitude, tracked separately.
    // acc[id].netCost is untouched by rowTotals too (only listed keys get summed) -- it's
    // `undefined` for non-tax-advantaged accounts, and naively coercing that to 0 would blur "no
    // gross-up to report" with "a real $0 take-home cost"; summed explicitly below instead.
    const totals = rowTotals(acc, ['contribution', 'employerMatch']);
    totals.conversion = conversionAmount;
    totals.netContributionCost = netContributionCostTotal;
    totals.income = income;
    totals.taxableIncome = taxableIncome;
    totals.tax = tax;
    totals.marginalRate = marginalRate;
    totals.effectiveTaxRate = effectiveTaxRate;
    // Mirrors decumulation's totals.grossIncome/effectiveTaxRate naming (and, like there,
    // includes any conversion) so UI code and the lifetime aggregates in project() (below) can
    // treat both phases' rows uniformly.
    totals.grossIncome = grossIncome;
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
 * @param {{taxDeferredCeiling?:number, reserveStatuses?:string[]}} [opts] `taxDeferredCeiling` is
 *   `bracketFill` only: the dollar ceiling on total tax-deferred withdrawals (floors included)
 *   that keeps ordinary income at or under the chosen bracket's top (see solveTaxYear, which
 *   computes this from the tax tables). `reserveStatuses` holds those tax statuses out of the
 *   general draw entirely (floors and a last-resort sweep excepted) — see the body.
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

  // Accounts whose taxStatus is RESERVED (opts.reserveStatuses — e.g. an HSA held back for
  // medical costs, see projectDecumulation's `hsaMedicalOnly`) are skipped by the general pass
  // below. Their floors still apply (that's how the medical draw itself gets made), and they stay
  // available as a LAST RESORT once every other bucket is exhausted — same philosophy as
  // bracketFill's own beyond-the-ceiling fallback: a real remaining need beats a false shortfall.
  const reserved = new Set(opts.reserveStatuses || []);
  const pool = accounts.filter((a) => !reserved.has(a.taxStatus));

  let remaining = Math.max(0, target - floorsTotal);
  // Draw from `list` in conventional tax-status order, skipping any status in `skip`, until
  // `remaining` is covered. Mutates withdrawals/remainingBalance/remaining.
  const drawInOrder = (list, skip) => {
    const byStatus = new Map();
    for (const a of list) {
      if (skip && skip.has(a.taxStatus)) continue;
      if (!byStatus.has(a.taxStatus)) byStatus.set(a.taxStatus, []);
      byStatus.get(a.taxStatus).push(a);
    }
    const order = [...CONVENTIONAL_ORDER, ...[...byStatus.keys()].filter((s) => !CONVENTIONAL_ORDER.includes(s))];
    for (const status of order) {
      for (const a of byStatus.get(status) || []) {
        if (remaining <= 0) break;
        const take = Math.min(remainingBalance[a.id], remaining);
        withdrawals[a.id] += take;
        remaining -= take;
        remainingBalance[a.id] -= take;
      }
      if (remaining <= 0) break;
    }
  };

  if (remaining > 0) {
    const total = pool.reduce((s, a) => s + remainingBalance[a.id], 0);
    if (total > 0) {
      if (sequencing === 'proportional') {
        // share_i = extra * remaining_i/total <= remaining_i whenever extra <= total.
        if (remaining >= total) {
          for (const a of pool) {
            withdrawals[a.id] += remainingBalance[a.id];
            remaining -= remainingBalance[a.id];
            remainingBalance[a.id] = 0;
          }
        } else {
          const extraTarget = remaining;
          for (const a of pool) {
            const take = extraTarget * (remainingBalance[a.id] / total);
            withdrawals[a.id] += take;
            remaining -= take;
            remainingBalance[a.id] -= take;
          }
        }
      } else if (sequencing === 'bracketFill') {
        // Design doc §5's "fill to the top of a bracket": draw tax-deferred FIRST (not last, as
        // conventional order does), but only up to a dollar ceiling that keeps that year's
        // ordinary income at or under a chosen bracket's top — deliberately realizing cheap
        // ordinary income in low-income years rather than saving it all for RMDs later. Whatever
        // the ceiling doesn't cover of the target falls back to conventional order over the
        // remaining (non-tax-deferred) buckets; if even that runs out, the last resort is more
        // tax-deferred beyond the ceiling — a real remaining need beats reporting a false shortfall.
        const tdAccounts = pool.filter((a) => a.taxStatus === 'taxDeferred');
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
        drawInOrder(pool, new Set(['taxDeferred']));
        if (remaining > 0) {
          for (const a of tdAccounts) {
            if (remaining <= 0) break;
            const take = Math.min(remainingBalance[a.id], remaining);
            withdrawals[a.id] += take;
            remaining -= take;
            remainingBalance[a.id] -= take;
          }
        }
      } else {
        drawInOrder(pool);
      }
    }
    // Last resort: the reserved buckets (see `reserved` above).
    if (remaining > 1e-9 && reserved.size > 0) {
      drawInOrder(accounts.filter((a) => reserved.has(a.taxStatus)));
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
 * @param {Record<string,number>} [p.medicalFloors] forced HSA withdrawals covering this year's
 *   medical costs (design doc §8 / medical expenses): mechanically identical to an RMD floor —
 *   taken first, ahead of sequencing — but tax-free, so the gross-up loop naturally ends up
 *   grossing up only the SPILLOVER portion funded from other accounts. Kept separate from
 *   `rmdFloors` because only an RMD's surplus is reinvestment-eligible (a medical floor is spent).
 * @param {string[]} [p.reserveStatuses] tax statuses held out of the general draw (see
 *   sequenceWithdrawal) — used to reserve HSA balances for medical costs only.
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
 * @param {boolean} [p.rothConversionsEnabled] Phase 6 stretch / Roth conversions: only takes
 *   effect with `sequencing==='bracketFill'`. After funding the spending target, if there's
 *   ceiling room left over (spending alone didn't use the whole bracket), convert that much MORE
 *   from tax-deferred to Roth — preserved in full; the conversion's own tax is covered by
 *   additional withdrawal via the normal sequencing, not by shrinking the converted amount or the
 *   spending target. The CALLER is responsible for age-gating this to before the RMD-forcing age
 *   (design doc §5: "the gap years between retirement and RMD age") — this function just does
 *   what it's told.
 * @returns {{withdrawals:Record<string,number>, reinvestment:Record<string,number>, conversions:Record<string,number>, conversionAmount:number, totalWithdrawn:number, tax:number, ordinaryTaxableIncome:number, capitalGain:number, taxableSocialSecurity:number, netAchieved:number, shortfall:number}}
 */
function solveTaxYear(p) {
  const { accounts, sequencing, rmdFloors, filingStatus, yearTable } = p;
  // Both kinds of forced withdrawal (RMD, medical-from-HSA) land on different accounts by
  // construction (taxDeferred vs hsa), so a shallow merge can't collide; summing anyway keeps
  // that from becoming a silent truncation if that ever stops holding.
  const baseFloors = { ...rmdFloors };
  for (const [id, amt] of Object.entries(p.medicalFloors || {})) {
    baseFloors[id] = (baseFloors[id] || 0) + num(amt);
  }
  const reserveStatuses = p.reserveStatuses;
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

  // The core gross-up fixed-point loop, extracted so a Roth conversion (below) can run it a
  // SECOND time with an extra forced tax-deferred floor and `divertedAmount` (the conversion,
  // which isn't spendable) subtracted from netAchieved — same convergence logic, just reused.
  function grossUp(floors, divertedAmount) {
    let grossGuess = Math.max(0, p.targetNet + divertedAmount);
    let last = null;
    let lastTotalWithdrawn = -1;
    let exhausted = false; // true only when the LAST round hit the portfolio's total balance cap
    let taxableSSEstimate = 0;
    let taxDeferredCeiling = 0;
    for (let i = 0; i < 8; i++) {
      taxDeferredCeiling = Math.max(0, bracketFillTop + stdDeduction - taxableSSEstimate);
      const { withdrawals, totalWithdrawn } = sequenceWithdrawal(grossGuess, accounts, sequencing, floors, { taxDeferredCeiling, reserveStatuses });
      const { ordinaryTaxableIncome, gain, taxableSS, tax } = taxFor(withdrawals);
      taxableSSEstimate = taxableSS;
      const netAchieved = totalWithdrawn - tax - divertedAmount;
      last = { withdrawals, totalWithdrawn, tax, ordinaryTaxableIncome, gain, taxableSS, netAchieved };
      exhausted = totalWithdrawn >= totalAvailable - 1e-6;
      if (exhausted) break;                                          // portfolio exhausted — a real shortfall
      if (totalWithdrawn === lastTotalWithdrawn) break;              // pinned by floors; no further movement possible (surplus, not a shortfall)
      if (Math.abs(netAchieved - p.targetNet) < 0.01) break;         // converged — within tolerance, NOT a shortfall
      lastTotalWithdrawn = totalWithdrawn;
      grossGuess = Math.max(0, grossGuess + (p.targetNet - netAchieved));
    }
    return { last, exhausted, taxDeferredCeiling };
  }

  let { last, exhausted, taxDeferredCeiling } = grossUp(baseFloors, 0);

  // Roth conversions (opt-in, bracketFill only): whatever bracket room the spending withdrawal
  // above DIDN'T use, convert that much more tax-deferred -> Roth, then re-solve so the
  // conversion's own tax is covered by additional withdrawal (normal sequencing), not by
  // shrinking the conversion or the spending target.
  let conversionAmount = 0;
  const conversions = Object.fromEntries(accounts.map((a) => [a.id, 0]));
  if (p.rothConversionsEnabled && sequencing === 'bracketFill' && !exhausted) {
    const tdAccounts = accounts.filter((a) => a.taxStatus === 'taxDeferred');
    const tdWithdrawnForSpending = tdAccounts.reduce((s, a) => s + (last.withdrawals[a.id] || 0), 0);
    const roomLeft = Math.max(0, taxDeferredCeiling - tdWithdrawnForSpending);
    const tdRemainingBalance = tdAccounts.reduce((s, a) => s + Math.max(0, a.balance - (last.withdrawals[a.id] || 0)), 0);
    const desired = Math.min(roomLeft, tdRemainingBalance);
    const targetId = accounts.find((a) => a.taxStatus === 'roth')?.id;
    if (desired > 1e-9 && targetId) {
      // Force the desired amount out of tax-deferred, on top of whatever spending already forced
      // (RMD floors + the spending withdrawal itself), across accounts in balance order.
      const conversionFloors = { ...baseFloors };
      let remaining = desired;
      for (const a of tdAccounts) {
        if (remaining <= 0) break;
        const alreadyFloored = baseFloors[a.id] || 0;
        const alreadyWithdrawn = Math.max(alreadyFloored, last.withdrawals[a.id] || 0);
        const avail = Math.max(0, a.balance - alreadyWithdrawn);
        const take = Math.min(avail, remaining);
        conversionFloors[a.id] = alreadyWithdrawn + take;
        remaining -= take;
      }
      const actual = desired - remaining; // balances may cap it further than roomLeft alone did
      if (actual > 1e-9) {
        const resolved = grossUp(conversionFloors, actual);
        last = resolved.last;
        exhausted = resolved.exhausted;
        conversions[targetId] = actual;
        conversionAmount = actual;
      }
    }
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
    conversions,
    conversionAmount,
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
 * @param {object} [p.medicalExpenses] setting, today's-dollars annual out-of-pocket medical cost
 *   (per year); default 0 ⇒ the whole medical feature is inert. Full resolver support, so a
 *   `byYear` override covers "Medicare starts at 65", a late-life long-term-care bump, etc.
 * @param {object} [p.medicalInflation] setting (per year); medical costs get their OWN cumulative
 *   escalator (healthcare historically outpaces CPI); omit to reuse `inflation`
 * @param {boolean} [p.medicalIncludedInSpending] true ⇒ the medical figure is assumed to already
 *   sit inside `spending`, so it changes only the FUNDING SOURCE (HSA first), not the year's total
 *   need. false (default) ⇒ medical is an ADDITIONAL need on top of the spending target.
 * @param {boolean} [p.hsaMedicalOnly] true ⇒ HSA balances are reserved for medical costs and are
 *   skipped by ordinary spending sequencing (still a last resort once all else is exhausted).
 *   Default false — HSA keeps its conventional-order slot, i.e. existing plans are unchanged.
 * @param {'fixedReal'|'fixedPercent'} [p.strategy] default 'fixedReal'
 * @param {'conventional'|'proportional'|'bracketFill'} [p.sequencing] default 'conventional'.
 *   `bracketFill` requires tax mode (below) — it needs real brackets to fill.
 * @param {number} [p.bracketFillRate] `sequencing==='bracketFill'` only: the marginal ordinary
 *   rate to fill tax-deferred withdrawals up to each year (design doc §5, Phase 6) — e.g. 0.12
 *   fills the 12% bracket before touching taxable/Roth. Must match a rate in the resolved year's
 *   ordinary brackets; see tax.bracketTopForRate.
 * @param {boolean} [p.rothConversionsEnabled] `sequencing==='bracketFill'` only: convert
 *   tax-deferred -> Roth to fill whatever bracket room the spending withdrawal didn't use, every
 *   year before the SECURE-2.0 RMD-forcing age (needs `birthYear`; without one, there's no RMD
 *   concept to gate on, so conversions run every year). See solveTaxYear's docs for the mechanics.
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
  const medicalExpenses = p.medicalExpenses ?? { default: 0 };
  const medicalInflation = p.medicalInflation ?? inflation;
  const reserveStatuses = p.hsaMedicalOnly ? ['hsa'] : undefined;
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
  // Medical costs compound on their own escalator (see p.medicalInflation), seeded from the same
  // starting point as general inflation so both stay relative to the plan's one base year.
  let cumMedicalInflation = num(p.startCumulativeInflation) || 1;
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
    cumMedicalInflation *= 1 + num(resolve(medicalInflation, { year }));

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
    // Medical costs: an additional need on top of the spending target by default, or (when
    // medicalIncludedInSpending) already inside it — in which case only the funding source below
    // changes, never the year's total need.
    const medicalNominal = Math.max(0, num(resolve(medicalExpenses, { year })) * cumMedicalInflation);
    const totalNeed = desired + (p.medicalIncludedInSpending ? 0 : medicalNominal);
    const gap = Math.max(0, totalNeed - otherIncomeNominal - ssBenefitNominal);

    const seqAccounts = accounts.map((a) => ({ id: a.id, balance: bal[a.id], taxStatus: taxStatus[a.id], basisFraction: basisFraction[a.id] }));

    // Fund medical from the HSA FIRST (tax-free), then let the ordinary sequencing cover whatever
    // spilled over. Netting against income BEFORE sizing the HSA draw matters: if Social Security
    // and other income already cover the year outright there's nothing to withdraw at all, and an
    // HSA floor bigger than the year's target would otherwise trip solveTaxYear's surplus path
    // (which exists for RMDs) and "reinvest" money that was actually spent on care.
    const medicalFromPortfolio = Math.min(medicalNominal, gap);
    const medicalFloors = {};
    let medicalFromHsa = 0;
    let medicalRemaining = medicalFromPortfolio;
    for (const a of seqAccounts) {
      if (medicalRemaining <= 1e-9) break;
      if (a.taxStatus !== 'hsa') continue;
      const take = Math.min(Math.max(0, a.balance), medicalRemaining);
      if (take <= 0) continue;
      medicalFloors[a.id] = take;
      medicalFromHsa += take;
      medicalRemaining -= take;
    }
    // What the HSA couldn't cover is funded like any other spending: normal sequencing, and (in
    // tax mode) grossed up so the NET covers the bill.
    const medicalFromOther = Math.max(0, medicalFromPortfolio - medicalFromHsa);

    let withdrawals, reinvestment, conversions, shortfall, tax = 0, ordinaryTaxableIncome = 0, capitalGain = 0, taxableSS = 0;
    if (taxMode) {
      const age = Number.isInteger(p.birthYear) ? year - p.birthYear : null;
      const rmdFloors = {};
      let beforeRmdAge = age == null; // no birthYear -> no RMD concept, so no age gate either
      if (age != null) {
        const rbAge = requiredBeginningAge(p.birthYear, p.taxTables.rmd);
        beforeRmdAge = age < rbAge;
        if (!beforeRmdAge) {
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
        medicalFloors, reserveStatuses,
        filingStatus: p.filingStatus, age65Count: age != null && age >= 65 ? 1 : 0,
        yearTable, stateTaxRate: p.stateTaxRate,
        socialSecurityBenefit: ssBenefitNominal, fixedTables: p.taxTables.fixed,
        bracketFillRate: p.bracketFillRate,
        // Roth conversions (design doc §5): only in the gap years before RMDs are forced.
        rothConversionsEnabled: !!p.rothConversionsEnabled && beforeRmdAge,
      });
      withdrawals = solved.withdrawals; reinvestment = solved.reinvestment; conversions = solved.conversions; shortfall = solved.shortfall;
      tax = solved.tax; ordinaryTaxableIncome = solved.ordinaryTaxableIncome; capitalGain = solved.capitalGain;
      taxableSS = solved.taxableSocialSecurity;
    } else {
      const seq = sequenceWithdrawal(gap, seqAccounts, sequencing, medicalFloors, { reserveStatuses });
      withdrawals = seq.withdrawals; shortfall = seq.shortfall;
      reinvestment = Object.fromEntries(accounts.map((a) => [a.id, 0]));
      conversions = Object.fromEntries(accounts.map((a) => [a.id, 0]));
    }

    const acc = {};
    for (const a of accounts) {
      const startBalance = bal[a.id];
      const withdrawal = withdrawals[a.id];
      const reinvest = reinvestment[a.id] || 0;
      const conversionIn = conversions[a.id] || 0;
      const remainder = startBalance - withdrawal + reinvest + conversionIn;
      const r = num(resolve(returnRate, { accountId: a.id, year }));
      const growth = remainder * r;
      const endBalance = remainder + growth;
      bal[a.id] = endBalance;
      acc[a.id] = { startBalance, withdrawal, reinvestment: reinvest, conversion: conversionIn, growth, endBalance };
    }
    const totals = rowTotals(acc, ['withdrawal', 'reinvestment', 'conversion']);
    totals.spendingNeed = desired;
    // Medical: the full cost, and how it got funded. `medicalExpense - medicalFromHsa -
    // medicalFromOther` is the part income (SS/otherIncome) covered outright — no withdrawal at all.
    totals.medicalExpense = medicalNominal;
    totals.medicalFromHsa = medicalFromHsa;
    totals.medicalFromOther = medicalFromOther;
    totals.otherIncome = otherIncomeNominal;
    totals.socialSecurity = ssBenefitNominal;
    totals.taxableSocialSecurity = taxableSS;
    totals.gap = gap;
    totals.shortfall = shortfall;
    totals.tax = tax;
    totals.ordinaryTaxableIncome = ordinaryTaxableIncome;
    totals.capitalGain = capitalGain;
    // A Roth conversion is diverted into another owned account, not spent — excluded from
    // netSpendable exactly like reinvestment already is (see rothConversionsEnabled's docs above).
    totals.netSpendable = otherIncomeNominal + ssBenefitNominal + (totals.withdrawal - tax - totals.reinvestment - totals.conversion);
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
        medicalExpense: totals.medicalExpense / cumInflation,
        medicalFromHsa: totals.medicalFromHsa / cumInflation,
        medicalFromOther: totals.medicalFromOther / cumInflation,
        otherIncome: totals.otherIncome / cumInflation,
        socialSecurity: totals.socialSecurity / cumInflation,
        withdrawal: totals.withdrawal / cumInflation,
        shortfall: totals.shortfall / cumInflation,
        tax: totals.tax / cumInflation,
        netSpendable: totals.netSpendable / cumInflation,
        conversion: totals.conversion / cumInflation,
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
 * @param {{id:string, balance:number, taxStatus:string, costBasis?:number, hsaMaxOut?:boolean, hsaViaPayroll?:boolean}[]} p.accounts
 * @param {object} p.returnRate       setting, used in both phases
 * @param {object} [p.inflation]      setting, used in both phases
 * @param {object} [p.contributions]  accumulation only — see projectAccumulation's docs for the
 *   take-home-pay-anchored semantics
 * @param {'dollar'|'percentOfIncome'} [p.contributionMode] accumulation only; default 'dollar'
 * @param {'selfOnly'|'family'} [p.hsaCoverage] accumulation only; default 'selfOnly'
 * @param {number} [p.ficaRate] accumulation only; default 0.0765
 * @param {boolean} [p.contributionWaterfallEnabled] accumulation only (Phase 6.7) — see
 *   computeContributionWaterfall's docs
 * @param {'standard'|'bracketAware'} [p.waterfallOrder] accumulation only; default 'standard' —
 *   see computeContributionWaterfall's docs for the tier order each one runs
 * @param {number} [p.waterfallRothBracketRate] accumulation only, 'bracketAware' order only: the
 *   ordinary bracket whose top Traditional contributions deduct down to before Roth takes over
 * @param {object} [p.waterfallBudget] accumulation only, household-level setting (not per-account)
 *   read the same way as p.contributions per p.contributionMode; the waterfall's overall take-home
 *   budget for the year
 * @param {number} [p.matchRate] accumulation only; default 1.0 (100% match)
 * @param {number} [p.matchCapPercent] accumulation only; default 0.04 (4% of pay)
 * @param {object} [p.wageGrowth]     accumulation only
 * @param {object} [p.spending]       decumulation only
 * @param {object} [p.otherIncome]    decumulation only
 * @param {object} [p.withdrawalPercent] decumulation only
 * @param {object} [p.medicalExpenses] decumulation only — see projectDecumulation's docs
 * @param {object} [p.medicalInflation] decumulation only; defaults to `inflation`
 * @param {boolean} [p.medicalIncludedInSpending] decumulation only; default false
 * @param {boolean} [p.hsaMedicalOnly] decumulation only; default false
 * @param {'fixedReal'|'fixedPercent'} [p.strategy] decumulation only
 * @param {'conventional'|'proportional'|'bracketFill'} [p.sequencing] decumulation only
 * @param {number} [p.bracketFillRate] `sequencing==='bracketFill'` only (Phase 6, design doc §5)
 * @param {boolean} [p.rothConversionsEnabled] `sequencing==='bracketFill'` only (Phase 6 stretch,
 *   design doc §5) — see projectDecumulation's docs
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
    accounts: accounts.map((a) => ({
      id: a.id, balance: a.balance, taxStatus: a.taxStatus,
      hsaMaxOut: a.hsaMaxOut, hsaViaPayroll: a.hsaViaPayroll, waterfallRole: a.waterfallRole,
    })),
    returnRate: p.returnRate, contributions: p.contributions, contributionMode: p.contributionMode,
    wageGrowth: p.wageGrowth, inflation: p.inflation,
    // Pre-retirement tax mode (Phase 6.5): opt-in on the SAME inputs decumulation tax and Social
    // Security already need — no separate toggle, consistent with how tax mode auto-activates
    // below. Reuses `earnings` (the SS wage-indexed-equivalent figure) as the income driving
    // this year's tax bill; see projectAccumulation's docs for the escalation convention and the
    // taxDeferred/HSA-contribution-deduction, take-home-cost gross-up, and Roth-conversion mechanics.
    income: p.earnings, filingStatus: p.filingStatus, taxTables: p.taxTables, anchorYear: p.anchorYear,
    bracketIndexingRate: p.bracketIndexingRate, standardDeductionIndexingRate: p.standardDeductionIndexingRate,
    stateTaxRate: p.stateTaxRate, birthYear: p.birthYear, hsaCoverage: p.hsaCoverage, ficaRate: p.ficaRate,
    contributionWaterfallEnabled: p.contributionWaterfallEnabled, waterfallBudget: p.waterfallBudget,
    waterfallOrder: p.waterfallOrder, waterfallRothBracketRate: p.waterfallRothBracketRate,
    matchRate: p.matchRate, matchCapPercent: p.matchCapPercent,
    rothConversionsEnabled: p.rothConversionsEnabled, bracketFillRate: p.bracketFillRate,
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
      medicalExpenses: p.medicalExpenses, medicalInflation: p.medicalInflation,
      medicalIncludedInSpending: p.medicalIncludedInSpending, hsaMedicalOnly: p.hsaMedicalOnly,
      strategy: p.strategy, sequencing: p.sequencing, bracketFillRate: p.bracketFillRate,
      rothConversionsEnabled: p.rothConversionsEnabled,
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

  // Lifetime aggregates, computed once here rather than re-derived by every UI consumer (the
  // projection view's stat tiles, the scenario-comparison table, and — Phase 6.5 — the
  // traditional-vs-Roth readout all need the same "total tax paid" / "total gross income" sums).
  // WHOLE-PLAN (accumulation + decumulation) — now that accumulation years can carry real tax
  // too (Phase 6.5), this genuinely spans your entire working + retired life, not just retirement.
  const lifetimeTax = years.reduce((s, y) => s + (y.totals.tax || 0), 0);
  const lifetimeGrossIncome = years.reduce((s, y) => s + (y.totals.grossIncome || 0), 0);
  const lifetimeEffectiveTaxRate = lifetimeGrossIncome > 0 ? lifetimeTax / lifetimeGrossIncome : 0;
  const lifetimeRothConversions = years.reduce((s, y) => s + (y.totals.conversion || 0), 0);
  // DECUMULATION-ONLY — kept separate because the traditional-vs-Roth comparison specifically
  // needs "what rate will this money face WHEN WITHDRAWN IN RETIREMENT," not a figure diluted by
  // already-realized working-years tax (a different, already-sunk cost, not the retirement side
  // of the trade-off).
  const decYearsOnly = years.filter((y) => y.phase === 'decumulation');
  const decumulationTax = decYearsOnly.reduce((s, y) => s + (y.totals.tax || 0), 0);
  const decumulationGrossIncome = decYearsOnly.reduce((s, y) => s + (y.totals.grossIncome || 0), 0);
  const decumulationEffectiveTaxRate = decumulationGrossIncome > 0 ? decumulationTax / decumulationGrossIncome : 0;
  // Medical costs are decumulation-only today (working-years medical isn't modeled), so these
  // sums are over the same rows either way.
  const lifetimeMedical = years.reduce((s, y) => s + (y.totals.medicalExpense || 0), 0);
  const lifetimeMedicalFromHsa = years.reduce((s, y) => s + (y.totals.medicalFromHsa || 0), 0);

  return {
    baseYear, retirementYear, horizonYear, years, firstDepletionYear,
    lifetimeTax, lifetimeGrossIncome, lifetimeEffectiveTaxRate, lifetimeRothConversions,
    decumulationTax, decumulationGrossIncome, decumulationEffectiveTaxRate,
    lifetimeMedical, lifetimeMedicalFromHsa,
  };
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
