// socialsecurity.js — Social Security estimation (plan.md §6). Phase 5.
//
// Per the §13 decision, benefits are estimated FROM EARNINGS, not a statement PIA:
//   earnings history → AWI-index each year → top-35 → AIME → bend-point PIA formula
//   → claiming-age adjustment → COLA compounding → optional solvency haircut.
// v1 is single-person; spousal/survivor is deferred.

/** Estimate Primary Insurance Amount (monthly, at Full Retirement Age) from an earnings history. */
export function estimatePIA(earningsHistory, birthYear, ssTables) {
  throw new Error('socialsecurity.estimatePIA: not implemented yet (Phase 5)');
}

/** Adjust a PIA for the chosen claiming age (early reduction / delayed credits). */
export function benefitAtClaimingAge(pia, claimingAge, fullRetirementAge, ssTables) {
  throw new Error('socialsecurity.benefitAtClaimingAge: not implemented yet (Phase 5)');
}
