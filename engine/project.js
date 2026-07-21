// project.js — the year-by-year projection engine (plan.md §4).
//
// Pure and deterministic: given (snapshot, assumptionSet) produce a per-year ledger.
// No DOM, no I/O, no personal data baked in — so it can be unit-tested hard (plan.md §12).
// Accumulation phase (now→retirement) in Phase 2; decumulation (retirement→horizon) in Phase 3.

/**
 * Run the full projection.
 * @param {object} snapshot   parsed snapshot (see schemas/snapshot.schema.json)
 * @param {object} scenario   parsed scenario (see schemas/scenario.schema.json)
 * @param {object} taxTables  parsed tax-tables.json (used once the tax engine lands, Phase 4)
 * @returns {{years: object[]}}  per-year ledger (balances, flows, taxes, nominal + today's-dollars)
 */
export function project(snapshot, scenario, taxTables) {
  throw new Error('project.project: not implemented yet (Phase 2/3)');
}
