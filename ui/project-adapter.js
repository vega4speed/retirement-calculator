// project-adapter.js — bridges the app's persisted state shape ({snapshot, assumptions, plan,
// filing, social}) to a project() call. Shared by the live editor (app.js) and the scenario
// comparison view (scenarios.js, Phase 7) so a saved scenario and the live plan are ALWAYS
// projected identically — no separate/divergent copy of this parameter-mapping logic.

import { project, solveMaxSustainableSpending } from '../engine/project.js';

// Latest verified year in data/tax-tables.json (see that file's `_meta.verificationStatus`).
// Brackets/standard-deduction for any other year are projected from this anchor by the
// bracketIndexingRate/standardDeductionIndexingRate settings (engine/tax.js resolveYearTable).
export const TAX_ANCHOR_YEAR = 2026;

/** Builds the project()-shaped params object from the app's state shape, or null if there are
 * no accounts to project. Shared by projectFor() and solveMaxSustainableSpendingFor() below so
 * both stay in sync — one is a straight project() call, the other feeds the same params into the
 * solver (which internally overrides strategy/spending; see engine/project.js's docs). */
function paramsFor(state, taxTables) {
  const { snapshot, assumptions, plan, filing, social } = state;
  const accounts = snapshot.accounts.map((a) => ({
    id: a.id, balance: Number(a.balance) || 0, taxStatus: a.taxStatus,
    costBasis: a.costBasis != null ? Number(a.costBasis) : undefined,
    hsaMaxOut: a.taxStatus === 'hsa' ? !!a.hsaMaxOut : undefined,
    hsaViaPayroll: a.taxStatus === 'hsa' ? a.hsaViaPayroll !== false : undefined,
  }));
  if (!accounts.length) return null;
  const startYear = parseInt(String(snapshot.asOf).slice(0, 4), 10) || new Date().getFullYear();
  const retirementYear = Math.max(startYear, Math.round(plan.retirementYear) || startYear);
  const horizonYear = Math.max(retirementYear, Math.round(plan.horizonYear) || retirementYear);
  return {
    baseYear: startYear, retirementYear, horizonYear, accounts,
    returnRate: assumptions.returnRate,
    contributions: assumptions.contributions,
    contributionMode: plan.contributionMode,
    wageGrowth: assumptions.wageGrowth,
    inflation: assumptions.inflation,
    spending: assumptions.spending,
    otherIncome: assumptions.otherIncome,
    withdrawalPercent: assumptions.withdrawalPercent,
    strategy: plan.strategy,
    sequencing: plan.sequencing,
    bracketFillRate: plan.sequencing === 'bracketFill' ? plan.bracketFillRate : undefined,
    rothConversionsEnabled: plan.sequencing === 'bracketFill' ? !!plan.rothConversionsEnabled : undefined,
    // birthYear is passed unconditionally — it drives the table's age column even when tax
    // tables didn't load (age display doesn't depend on tax being computed).
    birthYear: Number.isFinite(filing.birthYear) ? filing.birthYear : undefined,
    // The rest of tax is opt-in (engine/project.js): only passed through when tables loaded.
    // Bracket/standard-deduction indexing reuses the `inflation` assumption — a defensible
    // default ("brackets roughly keep pace with prices"); a dedicated knob is a later refinement.
    ...(taxTables ? {
      filingStatus: filing.filingStatus,
      taxTables, anchorYear: TAX_ANCHOR_YEAR,
      bracketIndexingRate: assumptions.inflation, standardDeductionIndexingRate: assumptions.inflation,
      stateTaxRate: assumptions.stateTaxRate,
      // HSA contribution limit (Phase 6.6): coverage tier only matters once there's a real
      // bracket table to index the limit against, hence gated the same as the rest of tax mode.
      hsaCoverage: filing.hsaCoverage,
      // Contribution waterfall (Phase 6.7): needs real IRS limits + brackets, so it's gated the
      // same way as the rest of tax mode too.
      contributionWaterfallEnabled: !!plan.contributionWaterfallEnabled,
      waterfallBudget: assumptions.waterfallBudget,
      matchRate: plan.matchRate,
      matchCapPercent: plan.matchCapPercent,
      // Social Security (Phase 5) is opt-in within tax mode: needs earnings + claiming age.
      earnings: assumptions.earnings, careerStartYear: social.careerStartYear, claimingAge: social.claimingAge,
      colaRate: assumptions.colaRate,
      solvencyHaircutStartYear: social.solvencyHaircutStartYear, solvencyHaircutFactor: social.solvencyHaircutFactor,
    } : {}),
  };
}

/**
 * @param {{snapshot:object, assumptions:object, plan:object, filing:object, social:object}} state
 * @param {object|null} taxTables parsed tax-tables.json, or null if it failed to load
 * @returns {object|null} a project() result, or null if there are no accounts to project. When
 *   `plan.strategy === 'maxSustainable'` this transparently runs solveMaxSustainableSpending()
 *   instead of a plain project() call and stashes the solved amount as `result.solvedSpending`
 *   (today's dollars) — every other consumer of this result (charts, tables, scenario
 *   comparison) needs no special-casing, since the shape is otherwise identical to project()'s.
 */
export function projectFor(state, taxTables) {
  const params = paramsFor(state, taxTables);
  if (!params) return null;
  if (state.plan.strategy === 'maxSustainable') {
    const { spending, result } = solveMaxSustainableSpending(params);
    return { ...result, solvedSpending: spending };
  }
  return project(params);
}
