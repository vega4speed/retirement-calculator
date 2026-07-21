// tax.js — federal (and optional state) tax math (plan.md §8). Phase 4.
//
// Ordinary-income brackets (inflation-indexed breakpoints), standard deduction
// (incl. age-65+ bump), long-term capital gains brackets, Social Security benefit
// taxation (provisional income → up to 85%), and RMDs (Uniform Lifetime Table).
// All tables come from data/tax-tables.json — this module is math over that data.

/** Ordinary income tax for a filing status in a given (indexed) year. */
export function ordinaryTax(taxableIncome, filingStatus, yearTable) {
  throw new Error('tax.ordinaryTax: not implemented yet (Phase 4)');
}

/** Portion of Social Security benefits that is federally taxable (up to 85%). */
export function taxableSocialSecurity(benefits, otherIncome, filingStatus, fixedTables) {
  throw new Error('tax.taxableSocialSecurity: not implemented yet (Phase 4)');
}

/** Required Minimum Distribution for an age given a prior-year-end balance. */
export function rmd(age, priorYearEndBalance, rmdTable) {
  throw new Error('tax.rmd: not implemented yet (Phase 4)');
}
