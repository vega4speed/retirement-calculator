// strategies.js — withdrawal amount + tax-efficient sequencing (plan.md §5). Phase 5/6.
//
// Two independent choices:
//   • withdrawal strategy: how much to pull (fixedReal | fixedPercent | guardrails)
//   • sequencing: which tax bucket funds the gap (conventional | proportional | bracketFill)
// bracketFill is where the real optimization lives (fill to the top of a chosen bracket;
// same machinery extends to Roth conversions). The engine gross-ups tax-deferred pulls.

/** Decide the year's total withdrawal need (nominal) before sourcing. */
export function withdrawalAmount(strategy, context) {
  throw new Error('strategies.withdrawalAmount: not implemented yet (Phase 5/6)');
}

/** Source a gap from accounts per the sequencing rule, returning pulls-by-account + tax. */
export function sequenceWithdrawals(sequencing, gap, accounts, taxContext) {
  throw new Error('strategies.sequenceWithdrawals: not implemented yet (Phase 6)');
}
