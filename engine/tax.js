// tax.js — federal tax math (design doc §8). Phase 4.
//
// Ordinary-income brackets, standard deduction (incl. age-65+ bump), long-term capital gains
// (stacked on top of ordinary income), Social Security benefit taxation (provisional income —
// up to 85% taxable), and RMDs (Uniform Lifetime Table, birth-year-based required beginning
// age per SECURE 2.0). Pure math over data/tax-tables.json — no DOM, no I/O.
//
// Bracket/standard-deduction indexing: rather than requiring every future year hardcoded in
// tax-tables.json, resolveYearTable() projects an ANCHOR year's real figures forward (or back)
// using an indexing-rate setting (per design doc §8 — the indexing rate is itself adjustable),
// the same cumulative-compounding pattern project.js uses for inflation/wage growth.
//
// State tax is NOT handled here — it's a flat rate applied by the caller (design doc §8: TN=0).

import { resolve } from './resolver.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Marginal tax over a bracket ladder. `brackets` is [{upTo, rate}], upTo:null = no ceiling.
 * @param {number} income
 * @param {{upTo:number|null, rate:number}[]} brackets
 * @returns {number}
 */
export function bracketTax(income, brackets) {
  const taxable = Math.max(0, num(income));
  if (taxable <= 0) return 0;
  let tax = 0;
  let prevUpTo = 0;
  for (const b of brackets) {
    const upTo = b.upTo == null ? Infinity : b.upTo;
    if (taxable <= prevUpTo) break;
    tax += (Math.min(taxable, upTo) - prevUpTo) * b.rate;
    prevUpTo = upTo;
    if (taxable <= upTo) break;
  }
  return tax;
}

/**
 * Per-bracket breakdown of how `amount` gets taxed, for display ("how much falls in each
 * bracket"). Mirrors bracketTax's marginal walk exactly but returns each touched segment
 * instead of only the sum — `rows.reduce((s,r)=>s+r.tax,0)` always equals
 * `bracketTax(base+amount,brackets) - bracketTax(base,brackets)`.
 *
 * `base` offsets where `amount` starts stacking (0 for ordinary income; ordinaryTaxableIncome
 * for a capital-gains breakdown, matching capitalGainsTax's stacking — see resolveYearTable's
 * caller in project.js for how the two compose).
 * @param {number} amount
 * @param {{upTo:number|null, rate:number}[]} brackets
 * @param {number} [base] default 0
 * @returns {{upTo:number|null, rate:number, amount:number, tax:number}[]} only brackets actually touched
 */
export function bracketBreakdown(amount, brackets, base = 0) {
  const amt = Math.max(0, num(amount));
  const rows = [];
  if (amt <= 0) return rows;
  const start = Math.max(0, num(base));
  const end = start + amt;
  let prevUpTo = 0;
  for (const b of brackets) {
    const upTo = b.upTo == null ? Infinity : b.upTo;
    if (end <= prevUpTo) break;
    if (upTo > start) {
      const segStart = Math.max(prevUpTo, start);
      const segEnd = Math.min(upTo, end);
      const segAmount = segEnd - segStart;
      if (segAmount > 0) rows.push({ upTo: b.upTo, rate: b.rate, amount: segAmount, tax: segAmount * b.rate });
    }
    prevUpTo = upTo;
    if (end <= upTo) break;
  }
  return rows;
}

/**
 * The taxable-income ceiling ("top") of the bracket whose marginal rate is `rate` — the anchor
 * for "fill withdrawals up to the top of the 22% bracket" style sequencing (design doc §5). No
 * match (a rate that isn't one of this table's brackets) returns Infinity — an unconstrained fill,
 * which project.js's caller then guards against by requiring the rate come from this same table.
 * @param {number} rate
 * @param {{upTo:number|null, rate:number}[]} brackets
 * @returns {number}
 */
export function bracketTopForRate(rate, brackets) {
  const b = brackets.find((x) => Math.abs(x.rate - rate) < 1e-9);
  if (!b) return Infinity;
  return b.upTo == null ? Infinity : b.upTo;
}

/**
 * The MARGINAL rate on the next dollar at a given taxable-income level — the inverse of
 * bracketTopForRate (rate -> threshold instead of threshold -> rate). Used for "what's my
 * current tax bracket" readouts, distinct from the EFFECTIVE rate (total tax / total income;
 * see project.js's totals.effectiveTaxRate) which is what you're actually paying on average.
 * @param {number} taxableIncome
 * @param {{upTo:number|null, rate:number}[]} brackets
 * @returns {number}
 */
export function marginalRateForIncome(taxableIncome, brackets) {
  const income = Math.max(0, num(taxableIncome));
  for (const b of brackets) {
    if (b.upTo == null || income <= b.upTo) return b.rate;
  }
  return brackets[brackets.length - 1]?.rate ?? 0;
}

/**
 * The standard traditional-vs-Roth heuristic: compare the rate paid NOW (a working year's
 * marginal rate, since a traditional contribution's tax savings land at that margin) against the
 * rate paid LATER (retirement's overall effective rate, since a traditional withdrawal stacks
 * across the whole bracket ladder, not just the top). If they're within `tolerance`, the two are
 * close to mathematically equivalent (the classic result: if your rate now equals your rate
 * later, pre-tax and post-tax contributions are worth the same). Otherwise, traditional wins when
 * the CURRENT rate is higher (defer tax now, pay it later at a lower rate) and Roth wins when the
 * current rate is lower (pay tax now at a bargain, avoid it later at a higher rate).
 * @param {number} currentRate    this working year's marginal rate
 * @param {number} laterRate      retirement's overall effective rate (or another year's marginal
 *   rate, for a year-over-year comparison)
 * @param {number} [tolerance] default 0.02 (2 percentage points)
 * @returns {'traditional'|'roth'|'wash'}
 */
export function traditionalVsRothVerdict(currentRate, laterRate, tolerance = 0.02) {
  const diff = num(currentRate) - num(laterRate);
  if (Math.abs(diff) < tolerance) return 'wash';
  return diff > 0 ? 'traditional' : 'roth';
}

/**
 * The inverse of a marginal-bracket walk: given a target NET cost (take-home pay you're willing
 * to give up) and your taxable income position BEFORE this deduction, find the exact GROSS
 * pre-tax contribution that costs exactly that much take-home pay. Walks the ordinary brackets
 * DOWNWARD from `before` (a dollar sheltered from a higher bracket costs less take-home than one
 * sheltered from a lower bracket) — the same bracket-arithmetic idea as bracketTax's own walk,
 * just inverted: bracketTax measures tax owed on income already earned, this measures how much
 * MORE gross income a fixed net cost can shelter.
 *
 * netCost(gross) = gross*(1 - ficaSavingsRate) - [tax(before) - tax(before - gross)]. Both the
 * bracket-walk term and the FICA term are monotonic in gross (tax rates and ficaSavingsRate are
 * always < 100%), so netCost is strictly increasing in gross — a unique solution always exists.
 * Once `before - gross` would go below $0 there's no more INCOME tax to shelter (the bracket-walk
 * term caps out), but ficaSavingsRate keeps applying beyond that point since FICA is a flat rate
 * on wages, not bracket-structured — the remainder costs `netCost / (1 - ficaSavingsRate)` gross
 * per net dollar, same shape as a Roth contribution once ficaSavingsRate is 0.
 *
 * ficaSavingsRate: an OPTIONAL flat rate (e.g. 0.0765 for combined Social Security + Medicare
 * employee-side) for contributions that ALSO skip payroll tax when made via payroll (HSA through
 * a Section 125 cafeteria plan) — see project.js's docs for why traditional 401(k)/IRA never get
 * this. Deliberately a flat rate, not a real FICA calculation (no wage-base cap, no Additional
 * Medicare Tax threshold) — same simplification already noted for FICA elsewhere in this app.
 *
 * @param {number} netCost
 * @param {number} before   taxable income BEFORE this deduction (clamped to >= 0)
 * @param {{upTo:number|null, rate:number}[]} brackets
 * @param {number} [ficaSavingsRate] default 0
 * @returns {number} the gross (pre-tax) contribution amount
 */
export function grossUpDeduction(netCost, before, brackets, ficaSavingsRate = 0) {
  const target = Math.max(0, num(netCost));
  if (target <= 1e-9) return 0;
  const startingBefore = Math.max(0, num(before));

  // Build the bracket segments actually touched by [0, startingBefore], ascending.
  const segments = [];
  let prevUpTo = 0;
  for (const b of brackets) {
    const upTo = b.upTo == null ? Infinity : b.upTo;
    const segEnd = Math.min(upTo, startingBefore);
    if (segEnd > prevUpTo) segments.push({ start: prevUpTo, end: segEnd, rate: b.rate });
    prevUpTo = upTo;
    if (startingBefore <= upTo) break;
  }

  let gross = 0;
  let netCovered = 0;
  // Walk from the TOP touched segment down -- the segment `before` currently sits in (the most
  // expensive bracket to be in, so the cheapest room to shelter FROM) is consumed first.
  for (let i = segments.length - 1; i >= 0 && netCovered < target - 1e-9; i--) {
    const seg = segments[i];
    const room = seg.end - seg.start;
    const netPerGross = Math.max(0, 1 - seg.rate - ficaSavingsRate);
    const netAvailable = room * netPerGross;
    const netNeeded = target - netCovered;
    if (netAvailable <= netNeeded + 1e-9) {
      gross += room;
      netCovered += netAvailable;
    } else {
      gross += netPerGross > 1e-9 ? netNeeded / netPerGross : room;
      netCovered = target;
    }
  }
  // Below $0 taxable income there's no more INCOME tax to shelter, but FICA savings (if any)
  // still apply -- flat on wages, not tied to brackets/taxable income at all.
  if (netCovered < target - 1e-9) {
    const netPerGrossTail = Math.max(1e-9, 1 - ficaSavingsRate);
    gross += (target - netCovered) / netPerGrossTail;
  }
  return gross;
}

/**
 * This year's HSA contribution limit for a coverage tier, including the age-55+ catch-up.
 * `yearTable.hsaLimit` (self-only/family) is indexed the SAME way as the standard deduction (see
 * resolveYearTable) -- HSA limits have historically tracked close to general inflation (2025->2026
 * was +2.3% on both tiers), and the real IRS formula's own lumpier $50-rounded chained-CPI
 * calculation isn't worth replicating for a multi-decade estimate; the catch-up amount is fixed by
 * statute (never inflation-indexed, unlike the base limits), so it comes from `fixedTables`
 * un-scaled, same pattern as the Social Security provisional-income thresholds.
 * @param {'selfOnly'|'family'} coverage
 * @param {number|null} age
 * @param {{hsaLimit?: {selfOnly:number, family:number}}} yearTable  from resolveYearTable
 * @param {{hsaCatchUp?: {amount:number, age:number}}} fixedTables   tax-tables.json's `fixed` block
 * @returns {number}
 */
export function hsaContributionLimit(coverage, age, yearTable, fixedTables) {
  const base = num(yearTable.hsaLimit?.[coverage]);
  const catchUp = fixedTables?.hsaCatchUp;
  const catchUpAmt = catchUp && Number.isFinite(age) && age >= catchUp.age ? num(catchUp.amount) : 0;
  return base + catchUpAmt;
}

function scaleBrackets(brackets, factor) {
  return brackets.map((b) => ({ upTo: b.upTo == null ? null : b.upTo * factor, rate: b.rate }));
}

/** Compounds `setting` (resolved per {year}) from fromYear to toYear — the shared indexing
 * primitive: resolveYearTable uses it for brackets/standard deduction, socialsecurity.js reuses
 * it for the PIA bend points. Symmetric: toYear before fromYear divides instead of multiplies. */
export function cumulativeFactor(setting, fromYear, toYear) {
  if (toYear === fromYear) return 1;
  let factor = 1;
  if (toYear > fromYear) {
    for (let y = fromYear + 1; y <= toYear; y++) factor *= 1 + num(resolve(setting, { year: y }));
  } else {
    for (let y = fromYear; y > toYear; y--) factor /= 1 + num(resolve(setting, { year: y }));
  }
  return factor;
}

/**
 * Project an anchor year's brackets/standard-deduction to any target year by compounding an
 * indexing-rate setting (design doc §8: bracket creep / TCJA-sunset scenarios are just different
 * indexingRate settings). Both directions work; projections only ever need forward.
 * @param {object} p
 * @param {object} p.tables         parsed tax-tables.json
 * @param {number} p.year           target year
 * @param {number} p.anchorYear     a year present in tables.years (e.g. the latest verified one)
 * @param {object} [p.bracketIndexingRate] setting (per year); default = anchor's own inflation-like drift is NOT assumed — default 0 (no indexing) if omitted
 * @param {object} [p.standardDeductionIndexingRate] setting (per year); default 0
 * @returns {{ordinaryBrackets:object, ltcgBrackets:object, standardDeduction:object}}
 */
export function resolveYearTable(p) {
  const { tables, year, anchorYear } = p;
  const anchor = tables.years[String(anchorYear)];
  if (!anchor) throw new Error(`tax.resolveYearTable: no tax table for anchor year ${anchorYear}`);
  const bracketIndexingRate = p.bracketIndexingRate ?? { default: 0 };
  const standardDeductionIndexingRate = p.standardDeductionIndexingRate ?? { default: 0 };

  const bf = cumulativeFactor(bracketIndexingRate, anchorYear, year);
  const sf = cumulativeFactor(standardDeductionIndexingRate, anchorYear, year);

  return {
    ordinaryBrackets: {
      mfj: scaleBrackets(anchor.ordinaryBrackets.mfj, bf),
      single: scaleBrackets(anchor.ordinaryBrackets.single, bf),
    },
    ltcgBrackets: {
      mfj: scaleBrackets(anchor.ltcgBrackets.mfj, bf),
      single: scaleBrackets(anchor.ltcgBrackets.single, bf),
    },
    standardDeduction: {
      mfj: anchor.standardDeduction.mfj * sf,
      single: anchor.standardDeduction.single * sf,
      hoh: anchor.standardDeduction.hoh * sf,
      additional65: {
        married: anchor.standardDeduction.additional65.married * sf,
        unmarried: anchor.standardDeduction.additional65.unmarried * sf,
      },
    },
    // Reuses the SAME standardDeductionIndexingRate as the standard deduction above -- see
    // hsaContributionLimit's docs for why this is a reasonable stand-in for the real (lumpier)
    // IRS HSA indexing formula rather than a dedicated one.
    hsaLimit: anchor.hsaLimits ? {
      selfOnly: anchor.hsaLimits.selfOnly * sf,
      family: anchor.hsaLimits.family * sf,
    } : undefined,
  };
}

/** Federal ordinary-income tax for a filing status, given a resolved yearTable (see resolveYearTable). */
export function ordinaryTax(taxableIncome, filingStatus, yearTable) {
  return bracketTax(taxableIncome, yearTable.ordinaryBrackets[filingStatus]);
}

/**
 * Standard deduction, including the age-65+ addition. `age65Count` is how many filers on the
 * return are 65+ (0, 1, or — for a future MFJ-with-both-spouses-65+ case — 2); v1 is
 * single-person so this is always 0 or 1 today.
 */
export function standardDeduction({ filingStatus, age65Count = 0, yearTable }) {
  const base = num(yearTable.standardDeduction[filingStatus]);
  const addlKey = filingStatus === 'mfj' ? 'married' : 'unmarried';
  return base + Math.max(0, age65Count) * num(yearTable.standardDeduction.additional65[addlKey]);
}

/**
 * Long-term capital gains tax. Gains "stack on top" of ordinary taxable income for bracket
 * purposes: computed as the marginal LTCG tax on (ordinaryTaxableIncome + gain) minus the tax
 * on ordinaryTaxableIncome alone — the standard stacking method.
 */
export function capitalGainsTax(gain, ordinaryTaxableIncome, filingStatus, yearTable) {
  const g = Math.max(0, num(gain));
  if (g <= 0) return 0;
  const base = Math.max(0, num(ordinaryTaxableIncome));
  const brackets = yearTable.ltcgBrackets[filingStatus];
  return bracketTax(base + g, brackets) - bracketTax(base, brackets);
}

/**
 * Portion of Social Security benefits that is federally taxable, via the standard simplified
 * two-tier "provisional income" formula (IRS Pub. 915's quick-calculation method — very close
 * to, but not a substitute for, the full worksheet's line-by-line edge cases).
 * @param {number} benefits     annual SS benefits received
 * @param {number} otherIncome  AGI excluding SS + tax-exempt interest
 * @param {'mfj'|'single'} filingStatus
 * @param {object} fixedTables  tax-tables.json's `fixed` block
 */
export function taxableSocialSecurity(benefits, otherIncome, filingStatus, fixedTables) {
  const b = Math.max(0, num(benefits));
  if (b <= 0) return 0;
  const { tier50, tier85 } = fixedTables.socialSecurityBenefitTaxation[filingStatus];
  const provisionalIncome = Math.max(0, num(otherIncome)) + 0.5 * b;

  let taxable;
  if (provisionalIncome <= tier50) {
    taxable = 0;
  } else if (provisionalIncome <= tier85) {
    taxable = Math.min(0.5 * b, 0.5 * (provisionalIncome - tier50));
  } else {
    taxable = Math.min(0.85 * b, 0.85 * (provisionalIncome - tier85) + Math.min(0.5 * b, 0.5 * (tier85 - tier50)));
  }
  return Math.min(taxable, fixedTables.socialSecurityBenefitTaxation.maxTaxablePortion * b);
}

/** The SECURE 2.0 required-beginning-age for RMDs, by birth year (73 for 1951-1959, 75 for 1960+). */
export function requiredBeginningAge(birthYear, rmdTable) {
  for (const rule of rmdTable.requiredBeginningAgeByBirthYear) {
    if (rule.bornThrough != null && birthYear <= rule.bornThrough) return rule.age;
    if (rule.bornFrom != null && birthYear >= rule.bornFrom) return rule.age;
  }
  return 75; // shouldn't be reached — the two rules above are exhaustive
}

/** Uniform Lifetime Table divisor for `age`, clamped to the table's covered range. */
export function rmdDivisor(age, uniformLifetime) {
  // Filter to numeric keys only — a stray non-numeric key (e.g. a "_note" comment sharing this
  // object) would otherwise poison the numeric sort with NaN and silently break the clamp.
  const ages = Object.keys(uniformLifetime).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const clamped = Math.max(ages[0], Math.min(ages[ages.length - 1], Math.round(age)));
  return uniformLifetime[String(clamped)];
}

/** Required Minimum Distribution for `age` given the prior-year-end balance. 0 if balance <= 0. */
export function rmdAmount(age, priorYearEndBalance, rmdTable) {
  const bal = Math.max(0, num(priorYearEndBalance));
  if (bal <= 0) return 0;
  return bal / rmdDivisor(age, rmdTable.uniformLifetime);
}
