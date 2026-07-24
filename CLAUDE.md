# Retirement Calculator — repo guide

Static, zero-dependency retirement-readiness calculator (vanilla JS, no build step). See
`README.md` for what it does and how to run/host it. This file is the map for working in the code.

## Principles

- **The override resolver (`engine/resolver.js`) is the core primitive.** Every adjustable setting
  is `{ default, byAccount?, byYear?, byAccountYear? }`, resolved most-specific-first
  (byAccountYear → byYear → byAccount → default). The whole UI and engine build on it. Lookups use
  presence checks, not truthiness, so a real `0` / `false` override resolves correctly.
- **`engine/` is pure** — no DOM, no I/O, no personal data — so it can be unit-tested hard.
  Financial math fails silently; add golden-number tests with every engine change.
- **No personal data in this repo.** Real balances live in the browser (localStorage) plus
  Export/Import files the user keeps privately. The `data/*/EXAMPLE.*` files are templates only.

## Layout

```
index.html            app entry point
engine/               pure calculation modules (unit-tested)
  resolver.js           the override resolver — DONE (implemented + tested)
  tax.js                brackets / std ded / LTCG / SS tax / RMDs — DONE (implemented + tested;
                         resolveYearTable() projects an anchor year's real figures forward via
                         an indexing-rate setting, same pattern as inflation in project.js;
                         bracketBreakdown() powers the table's clickable-Tax-cell detail view;
                         marginalRateForIncome() — inverse of bracketTopForRate, taxable income
                         -> marginal rate — powers the pre-retirement tax-rate readout and
                         projectAccumulation()'s per-year marginalRate; traditionalVsRothVerdict()
                         — pure current-rate-vs-later-rate -> 'traditional'|'roth'|'wash', with a
                         configurable tolerance for "close enough to call it a wash" — extracted
                         from app.js's inline verdict logic; grossUpDeduction() — the reverse of a
                         marginal-bracket walk: net take-home cost -> gross pre-tax amount, walking
                         brackets DOWNWARD from a taxable-income position (see project.js's
                         contribution docs); hsaContributionLimit() — this year's indexed HSA limit
                         + 55+ catch-up, resolveYearTable()'s output now also carries `hsaLimit`
                         {selfOnly,family}, indexed the same way as the standard deduction)
  project.js            accumulation + decumulation, tax-aware — DONE (spending, withdrawal
                         strategy, tax-status sequencing, RMD forcing, capital-gains stacking,
                         gross-up, portfolio survival, Social Security income + taxation, and
                         (Phase 6) a 'bracketFill' sequencing mode that draws tax-deferred FIRST
                         up to a chosen ordinary-bracket ceiling, then falls back to conventional
                         order). Tax is opt-in: omit filingStatus/taxTables and it's the pure
                         pre-tax Phase 3 behavior, unchanged. SS is opt-in within tax mode: omit
                         claimingAge/earnings/careerStartYear and there's no benefit stream.
                         bracketFill is opt-in too: omit bracketFillRate (or select another
                         sequencing) and it behaves exactly like 'conventional'/'proportional'.
                         Each decumulation year's totals now also carry grossIncome and
                         effectiveTaxRate (tax ÷ gross income) — the number that actually shows
                         whether a strategy is tax-efficient, distinct from the marginal rate.
                         solveMaxSustainableSpending(p) — binary-searches the maximum constant
                         real annual spend ('fixedReal') the portfolio survives through the full
                         horizon (design doc §9's "what's the safe spending it supports"); every
                         other input held fixed, ~30-90 project() calls per solve, feasibility is
                         monotonic in spend so the search is valid. Wired into project() indirectly
                         via ui/project-adapter.js, not project() itself — kept as a separate
                         exported function since it's a search OVER project(), not a mode of it.
                         Roth conversions (design doc §5, the Phase 6 stretch piece — DONE): an
                         opt-in `rothConversionsEnabled` flag, bracketFill-only. solveTaxYear's
                         gross-up loop is extracted into a reusable grossUp(floors, divertedAmount)
                         closure, run once to fund spending (discovering how much bracket-ceiling
                         room is left over), then run AGAIN with that leftover room folded in as
                         an extra tax-deferred floor (same mechanism as RMD floors) — the
                         conversion lands in Roth intact; its own tax is covered by additional
                         withdrawal via the normal sequencing, not by shrinking the conversion or
                         the spending target. Gated to the gap years before the SECURE 2.0
                         RMD-forcing age; without a birthYear there's no RMD concept to gate on,
                         so conversions run every eligible year. project()'s return now also
                         carries lifetimeTax / lifetimeGrossIncome / lifetimeEffectiveTaxRate /
                         lifetimeRothConversions — computed ONCE here rather than re-derived by
                         every UI consumer (projection-view.js's stat tiles and scenarios.js's
                         comparison table both use these directly now). Also carries
                         decumulationTax / decumulationGrossIncome / decumulationEffectiveTaxRate
                         — the SAME aggregates filtered to decumulation-only years, added once
                         accumulation could carry its own tax (below) so "lifetime" would
                         otherwise dilute the "what rate will this money face in retirement"
                         comparison the trad-vs-Roth verdict needs.
                         projectAccumulation() (DONE): year-by-year working-years income + tax,
                         opt-in on income/filingStatus/taxTables (omit any and it's exactly
                         Phase 2's pre-tax accumulation, unchanged). Per year: income (the
                         `earnings` setting escalated by cumulative wage growth — note this is a
                         DIFFERENT interpretation of the same raw setting than estimatePIA's,
                         which applies no escalation; an intentional, documented divergence since
                         the two consumers transform the input differently for different
                         purposes), taxableIncome (income minus tax-deferred contributions —
                         the real 401k/IRA pre-tax deduction — minus the standard deduction),
                         tax, marginalRate (via new marginalRateForIncome), effectiveTaxRate
                         (tax ÷ gross income, gross including any conversion). Accumulation-phase
                         Roth conversions reuse the SAME rothConversionsEnabled/bracketFillRate
                         knobs as decumulation, deliberately coupled to plan.sequencing ===
                         'bracketFill' for scope control even though accumulation has no real
                         "sequencing" concept (documented simplification). Mechanically simpler
                         than decumulation's version — no gross-up needed, since a working person
                         pays the conversion's tax out of take-home pay, not a portfolio
                         withdrawal — just a signed conversionFlow map (negative on the
                         tax-deferred source, positive on the Roth target) applied before growth.
                         In practice usually $0 for a full-time salary (job income alone already
                         exceeds a modest bracket) — most likely to show up in a lower-income
                         working year (part-time, a gap year, early career).
                         Phase 6.6, take-home-pay-anchored contributions (DONE): comparing a $1,000
                         Roth contribution to a $1,000 Traditional one dollar-for-dollar isn't fair
                         — Roth is post-tax (costs $1,000 take-home, full stop) while Traditional
                         shields itself from tax (costs LESS take-home for the same gross $). So
                         for taxDeferred/hsa accounts, the resolved `contributions` value is now
                         the NET take-home cost, and tax.grossUpDeduction() solves BACKWARD for the
                         larger gross amount that lands in the account — an EXACT bracket walk
                         (not a flat 1/(1-marginalRate) approximation, which overstates the gross
                         amount once a deduction spans more than one bracket). `contributionMode`
                         ('dollar' default, or 'percentOfIncome' — reads the resolved value as a
                         fraction of that year's income directly, e.g. Dave Ramsey's "15% of gross
                         income" heuristic). Multiple taxDeferred/hsa accounts pool into ONE
                         combined deduction (real tax law), grossed up SEQUENTIALLY in accounts-
                         array order — order-dependent (whichever's processed first "gets" the
                         cheaper bracket room), a documented, minor wrinkle, same flavor as
                         sequencing order mattering elsewhere in this engine. HSA now joins the
                         SAME deduction pool as taxDeferred (real tax law: HSA contributions reduce
                         federal taxable income too). Two HSA-only per-account flags: `hsaMaxOut`
                         (bypasses net-cost-anchoring — gross is fixed at that year's indexed limit
                         via tax.hsaContributionLimit, using `hsaCoverage` + the 55+ catch-up) and
                         `hsaViaPayroll` (default true — whether it also skips FICA, `ficaRate`
                         default 7.65%, a flat approximation matching the existing "FICA wage-base
                         cap isn't modeled" simplification; false if funded after-tax and deducted
                         on the return, which gets the income-tax benefit but not the FICA one —
                         traditional 401(k)/IRA NEVER get this regardless of method, a real,
                         unconditional tax-law fact, not a toggle). Each account row also carries
                         `netCost` (the take-home figure, informational — undefined for roth/
                         taxable/cash, which have no gross-up to report).
                         Phase 6.7, the contribution waterfall (DONE): the standard "investment
                         order" — Traditional up to the employer match, then HSA to its max, then
                         Roth IRA to its (income-phased-out) limit, then back to Traditional for
                         whatever's left of ONE overall take-home budget — as a single opt-in
                         (`contributionWaterfallEnabled` + `waterfallBudget`) rather than typing
                         four separate numbers. `computeContributionWaterfall()`: claims up to 3
                         accounts by role (first taxDeferred/hsa/roth, same convention Roth
                         conversions already use — v1/single-person scope; a second account of the
                         same status keeps using its own independent `contributions` setting,
                         composed into the SAME shared deduction pool afterward). Tier 3 assumes
                         "roth" means a Roth IRA (the smaller, separate IRS limit), not a Roth
                         401(k) (documented assumption, not a general Roth-account cap). Employer
                         match (`matchRate`/`matchCapPercent`, plain constants not resolver
                         settings — a scope simplification) is FREE money tracked separately
                         (`employerMatch`, both per-account and in totals) — it's not your wages to
                         begin with, so it never touches `runningBefore`/the take-home budget.
                         New tax.js exports back this: `iraContributionLimit()`,
                         `electiveDeferralLimit()` (401(k)/403(b), incl. SECURE 2.0's age-60-63
                         enhanced catch-up, which REPLACES rather than stacks on the standard
                         50+ catch-up), `rothIraPhaseOutFactor()` (linear 1→0 across the MAGI
                         range, MAGI approximated as gross `income` — same precision level as the
                         rest of this app's income modeling; HOH uses the single range, matching
                         the real IRS convention). All three limits verified + indexed the SAME
                         way as the standard deduction (see tax-tables.json's `_meta`).
  socialsecurity.js     earnings → AIME → PIA → claiming → COLA/haircut — DONE (implemented +
                         tested). fullRetirementAge() (1983-Amendments table), estimatePIA()
                         (bend-point formula on a "wage-indexed-equivalent" earnings setting —
                         a documented v1 simplification, see the file's header), 
                         benefitAtClaimingAge() (early reduction / delayed credits, capped at 70).
  strategies.js         withdrawal amount + sequencing — superseded by project.js's built-in
                         sequencing (bracketFill, Phase 6, plus Roth conversions on top of it).
ui/                   vanilla-JS UI (no framework, no deps)
  app.js                app shell: accounts + filing/tax + working-years + retirement-spending
                         + Social Security assumptions + full-lifecycle projection + scenarios
                         (Phase 7); localStorage persistence. Live readouts (SS benefit estimate,
                         max-sustainable solve, pre-retirement tax snapshot) are all PERSISTENT
                         elements updated from refreshProjection() — not markup rebuilt fresh
                         each render — after two real staleness bugs found the hard way (a readout
                         baked into rebuild()-only markup goes stale on any edit that takes the
                         lighter onEdit() path instead). currentTaxSnapshot(): a single point-in-
                         time (not multi-year) estimate of TODAY's marginal/effective tax rate
                         from the same `earnings` setting Social Security already uses, compared
                         against the projected retirement DECUMULATION-ONLY effective rate (not the
                         whole-plan lifetime one, which would now be diluted by accumulation's
                         own tax) via the new traditionalVsRothVerdict() helper in tax.js — kept
                         even after project.js grew a real year-by-year accumulation tax ledger,
                         since this snapshot is self-contained and works without a
                         retirementYear > baseYear (see the Status section for how the two
                         relate). Now also returns `taxableIncome` (was computed internally but
                         silently dropped from the return value — a real latent bug, only surfaced
                         once contributionCostBox became the first consumer to need it; fixed).
                         contributionCostBox: a one-line "what does that actually buy" readout for
                         the Annual contribution row — reuses currentTaxSnapshot()'s real (not
                         approximated) taxableIncome position with tax.grossUpDeduction() to show
                         today's exact Traditional/HSA-via-payroll gross equivalent for the DEFAULT
                         contribution value (doesn't reflect per-account overrides, multiple pooled
                         accounts, or an HSA max-out limit — the projection table below computes
                         the exact, complete version of this per year). `plan.contributionMode`
                         ('dollar'|'percentOfIncome') and `filing.hsaCoverage` ('selfOnly'|'family',
                         shown only when an HSA account exists) are new state fields, both reset on
                         Clear. Switching contributionMode resets `assumptions.contributions` to a
                         fresh default rather than reinterpreting the same stored number under the
                         other mode's totally different meaning (a $10,000 dollar-mode value would
                         otherwise read as 1,000,000% if left in place).
                         Contribution waterfall (Phase 6.7) controls: `plan.contributionWaterfallEnabled`
                         + a new household-level `assumptions.waterfallBudget` setting (read the
                         SAME dollar/percent way as `contributions`, via the same contributionMode
                         toggle) + `plan.matchRate`/`plan.matchCapPercent` (plain percentFieldRow
                         numeric inputs, not resolver settings). Shown only when tax tables loaded
                         (needs real IRS limits + brackets). Doesn't hide the existing "Annual
                         contribution" row — accounts NOT claimed by the waterfall (a second
                         taxDeferred account, taxable, cash) still use it independently.
  project-adapter.js    projectFor(state, taxTables) — the ONE place that maps the app's
                         {snapshot, assumptions, plan, filing, social} state shape to a
                         project() call. Shared by app.js (the live editor) and scenarios.js
                         (comparing saved scenarios) so both are always projected identically —
                         added in Phase 7 by extracting what used to be app.js's own
                         computeProjection() body. When plan.strategy === 'maxSustainable',
                         transparently runs engine/project.js's solveMaxSustainableSpending()
                         instead of project() and stashes the solved amount on the result as
                         `solvedSpending` — every other consumer (chart, table, scenario
                         comparison) needs no special-casing, since the shape is otherwise
                         identical to a normal project() result.
  scenarios.js           Phase 7: save the current state as a named, FROZEN scenario
                         (deep-copied, not a live reference — editing your accounts/assumptions
                         afterward never changes a saved scenario); select 2-4 to compare
                         side by side — a combined today's-$ balance chart (up to 4 lines,
                         validated categorical palette, color assigned once per scenario at
                         save time so it never changes as the comparison selection changes) +
                         a headline-readout table (lasts/runs-out, ending balance, lifetime tax,
                         lifetime effective tax rate, "Max sustainable spend" when either scenario
                         used that strategy, "Converted to Roth (lifetime)" when either used
                         conversions, and the assumptions that differ). "Load"
                         puts a saved scenario back into the live editor; once loaded (or just
                         saved), an "Update" affordance appears to overwrite that SAME scenario
                         in place with further changes — tracks `loadedScenarioId` internally so
                         "Save current as scenario" (always new) and "Update" (overwrite) are
                         two distinct, clearly-labeled actions, not one button doing both. Own
                         localStorage key (`retirement-calc:scenarios:v1`), separate from the
                         live editor's.
                         NOTE: `schemas/scenario.schema.json` (Phase 0) is unused — its nested
                         shape predates how the live app's state actually evolved through
                         Phases 2-6; scenarios.js persists the app's real (flatter) state shape
                         directly instead of forcing a fit to that schema.
  accounts-editor.js    enter/edit accounts, tax statuses, balances, cost basis, and (HSA accounts
                         only, "n/a" otherwise, same pattern as the cost-basis column) two
                         checkboxes: max out (Phase 6.6) and via payroll (FICA savings)
  setting-control.js    the reusable Simple/Expand knob (supports `perAccount:false` for
                         household-level settings like spending), with a live resolved preview
  projection-view.js    stat tiles (portfolio survival; "Lifetime tax in retirement" +
                         "Lifetime effective tax rate" now use project()'s decumulation-only
                         aggregates, not the whole-plan ones, since accumulation can carry tax
                         too now; a "Total tax, working + retired" tile appears only when that
                         whole-plan figure actually differs from the decumulation-only one;
                         "Converted to Roth" sums both phases; a new "Employer match" tile
                         appears only when the waterfall produced one) + the two-series chart
                         (today's $ vs nominal, retirement marker, hover tooltip shows age + that
                         year's effective tax rate + any Roth conversion + any employer match —
                         accumulation-phase rows now show income/tax/marginal/effective + any
                         conversion too, not just the contribution) + a table (both phases, sticky
                         headers, an age column when birthYear is known, a Roth-conversion column
                         and an Employer-match column when relevant, and a clickable Tax cell that
                         expands a per-bracket breakdown row — including what the standard
                         deduction sheltered, plus a marginal-vs-effective-rate line — the whole
                         view preserves scroll position, both the page's own AND the table's own
                         internal scroll container, across re-renders)
  chart-utils.js         shared chart primitives (usd/usdFull formatters, niceCeil axis rounding,
                         xTickYears, the fixed non-categorical COL tokens) — factored out in
                         Phase 7 so projection-view.js's chart and scenarios.js's comparison
                         chart don't each keep their own copy.
  dom.js, formats.js    tiny DOM builder (incl. SVG) + value<->input formatting helpers
data/                 tax-tables.json (verified 2025/2026 figures, now incl. HSA self-only/family
                       limits, IRA/Roth-IRA limits + catch-up, the 401(k) elective deferral limit
                       + SECURE 2.0 catch-ups, and the Roth IRA MAGI phase-out ranges, all per
                       year; the fixed $1,000/age-55 HSA catch-up lives in `fixed`) + EXAMPLE
                       templates
schemas/              JSON Schemas for profile / snapshot / scenario — scaffolding from Phase 0,
                       predates the app's actual (simpler) state shape; not wired up (see
                       scenarios.js above)
test/                 node:test suites (smoke, resolver, accumulation, accumulation-tax,
                       hsa-contributions, contribution-waterfall, decumulation, tax,
                       decumulation-tax, socialsecurity, social-security-decumulation,
                       bracket-fill, max-sustainable, roth-conversions) — 155 passing.
```

## Running

- **Tests:** `npm test` (runs `node --test` over `test/*.test.js`, no deps to install).
- **App:** serve over http — ES modules don't load from a bare `file://` open. E.g.
  `python3 -m http.server 8000`, then open the printed URL. `mount()` in `ui/app.js` is async —
  it `fetch()`s `data/tax-tables.json` at startup; if that fetch fails (e.g. opened via bare
  `file://`), the app degrades gracefully to pre-tax mode rather than breaking.

## Status

Done & tested: the override resolver, the accounts + Simple/Expand UI, the full **tax-aware**
accumulation→decumulation projection — growth + contributions to retirement; then spending, a
withdrawal strategy, tax-status-aware sequencing, RMDs (SECURE 2.0 birth-year rule), federal
ordinary + capital-gains tax with gross-up — **Social Security**: estimated from earnings via
the real bend-point PIA formula (not typed in as a fixed number), claiming-age adjustment, COLA,
a solvency-haircut lever, and real taxation of the benefit (provisional-income formula) composed
into the same gross-up — (Phase 6) **tax-bracket-aware withdrawal sequencing**: a `bracketFill`
mode that draws tax-deferred accounts FIRST each year, up to the top of a chosen ordinary-income
bracket, before touching taxable/Roth — the opposite preference from conventional order, meant to
deliberately realize cheap ordinary income in low-income retirement years instead of letting it
all pile up as RMDs later. The UI's bracket picker lists the current filing status's own bracket
rates, so it always matches what the engine can resolve. Every decumulation year also reports an
**effective tax rate** (total tax ÷ total gross income) alongside the marginal rate the bracket
breakdown shows — the number that actually answers "is this strategy tax-efficient," since
bracket-fill can raise lifetime tax in dollars while keeping the effective rate low by spreading
ordinary income across more years. **Roth conversions** (the Phase 6 stretch piece, now done):
opt-in on top of bracket-fill sequencing — in the gap years before RMDs, whatever bracket-ceiling
room the spending withdrawal didn't use gets converted from tax-deferred to Roth instead of
sitting unused, preserved in full, with the conversion's own tax funded by additional withdrawal
rather than shrinking the converted amount. (Phase 7) **scenario comparison**: save the current
accounts + assumptions as a named, frozen scenario, then pick 2-4 to compare side by side — a
combined balance chart plus a headline-readout table (lasts/runs-out, ending balance, lifetime
tax, lifetime effective tax rate, max sustainable spend, lifetime Roth conversions). A third
withdrawal strategy, **maximum sustainable spending**: instead of typing a spending target, solve
for the highest constant real annual spend the portfolio survives through the full horizon — a
binary search (`solveMaxSustainableSpending`) over the same engine, exposed as a live "Solved:
$X/yr" readout, and directly comparable across scenarios in the same comparison table. And a
**pre-retirement tax snapshot**: today's marginal + effective tax rate (from the same earnings
figure Social Security uses) compared against the projected retirement lifetime effective rate,
with a plain-language traditional-vs-Roth verdict — a single point-in-time comparison, not a
year-by-year working-years tax projection (see Known simplifications). Charted in today's
dollars with a retirement marker, a hover tooltip that now includes age, and table view
(tax/net-spendable/age/Roth-conversion columns, sticky headers, clickable per-bracket Tax detail
showing the standard deduction + marginal-vs-effective rate) — the whole view preserves scroll
position across re-renders now, so expanding a table row no longer jumps you back to the top.
**Pre-retirement accumulation-phase tax modeling** (2026-07-24): the working years now carry a
real year-by-year income/tax ledger, not just the point-in-time snapshot above — each year's
income (earnings escalated by wage growth), taxable income (net of the real 401k/IRA pre-tax
contribution deduction and the standard deduction), tax, marginal rate, and effective rate. This
is what actually answers the original question ("is paying higher tax now to defer worth it, or
does it just add to lifetime tax burden") with real numbers instead of a single snapshot.
**Roth conversions during accumulation**: the same opt-in bracket-fill conversion mechanism from
decumulation now also runs during working years (gated behind the same `bracketFill` sequencing
selection) — funded from take-home pay instead of a portfolio withdrawal, so no gross-up is
needed; usually $0 for a full salary (job income alone typically exceeds a modest bracket) and
most likely to show up in a lower-income working year. Because accumulation can now carry its own
tax, `project()`'s lifetime tax aggregates would dilute the "what rate will this money face in
retirement" comparison the trad-vs-Roth verdict needs — so it now also returns
decumulation-only aggregates, and both the verdict readout and the "Lifetime tax in retirement"
stat tile were repointed to those; a new "Total tax, working + retired" tile shows the whole-plan
figure only when it actually differs.
**Phase 6.6, take-home-pay-anchored contributions + HSA (2026-07-24):** comparing a $1,000 Roth
contribution to a $1,000 Traditional one dollar-for-dollar isn't a fair "which costs my lifestyle
more" comparison, since Roth is post-tax and Traditional shields itself from tax. Contributions to
tax-deferred/HSA accounts are now interpreted as the NET take-home cost, grossed up to the larger
actual account deposit via an exact bracket walk (`tax.grossUpDeduction`, not a flat-rate
approximation). A new `contributionMode` ('dollar' or 'percentOfIncome', e.g. "15% of gross
income") picks how the resolved number itself reads. HSA now joins the SAME deduction pool as
Traditional 401(k)/IRA (real tax law), plus two HSA-only per-account options: max out (fixed at
that year's indexed IRS limit + 55+ catch-up, verified/sourced in `tax-tables.json`) and via
payroll (also skips FICA — a real tax advantage 401(k)/IRA never get, regardless of contribution
method). A one-line readout under the contribution setting shows today's real gross-equivalent for
whatever the default value resolves to.
**Phase 6.7, the contribution waterfall (2026-07-24):** the standard "investment order" — match,
then HSA, then Roth IRA, then back to Traditional — as one opt-in toggle instead of four separate
numbers you'd have to compute by hand. One overall take-home budget (dollar or % of income, same
convention as everything else) fills each tier in priority order, respecting that tier's real IRS
limit (all now sourced + verified: IRA/Roth IRA, the 401(k) elective deferral limit including
SECURE 2.0's age-60-63 enhanced catch-up, and the Roth IRA income phase-out) before spilling over
to the next. Employer match is modeled as a simple single-tier formula (rate + cap % of pay) and
tracked as free money, separate from your own contribution. In progress: couple/spousal Social
Security (the remaining v1-boundary item from §13).

**Fixed 2026-07-22 (two small UI bugs):**
1. Clicking a Tax cell to expand its per-bracket breakdown — or toggling "Show table" — fully
   rebuilds the projection view's DOM, which silently reset the page's scroll position to the
   top (lost scroll anchoring on a full subtree replace). `createProjectionView`'s `render()` now
   captures `window.scrollY` before clearing and restores it after re-appending.
2. The chart's hover tooltip showed year and phase but not age, even though the table already had
   an age column. Added `· age N` to the tooltip's first line when `birthYear` is known.

**Fixed 2026-07-24 (currentTaxSnapshot() silently dropped taxableIncome):** found while building
Phase 6.6's contribution-cost readout — the function computed `taxableIncome` internally but never
included it in its return object, so `snap.taxableIncome` was `undefined` everywhere; the ONLY
place that broke visibly was the new readout (num()'s `undefined -> 0` fallback made every
Traditional/HSA gross-equivalent read as identical to the net cost, since grossUpDeduction treated
"before" as $0 taxable income). No prior consumer had needed the field, so this was a real,
pre-existing latent gap, not a regression. Fixed by adding `taxableIncome` to the return value.

**Fixed 2026-07-21 (two bugs, both with regression tests):**
1. The portfolio-survival badge could falsely claim depletion on the very first decumulation
   year — `solveTaxYear`'s $0.01 gross-up convergence tolerance was leaking through as a fake
   `shortfall`. Only a genuinely exhausted portfolio (hit its total balance cap) reports a
   shortfall now (`test/decumulation-tax.test.js`).
2. If Social Security was claimed before `projectDecumulation`'s `startYear` (claimed while
   still in the accumulation phase, which that function never iterates), COLA compounding for
   the skipped years was silently dropped, understating every subsequent payment. `cumCOLA` is
   now seeded via `tax.cumulativeFactor` for the gap (`test/social-security-decumulation.test.js`).

Known simplifications (see README's Status section for the full list): flat state tax rate (no
state brackets); `otherIncome` still isn't taxed (Social Security now is); SS "earnings" is
wage-indexed-equivalent, not real historical dollars run through the actual SSA wage index; the
FICA wage-base cap and Additional Medicare Tax threshold aren't modeled (`ficaRate` is a flat
7.65% used only inside the take-home-cost gross-up, not a real FICA liability computed anywhere);
SS only starts once decumulation begins even if claimed earlier; taxable-account cost basis is a
constant fraction from the snapshot, not grown through contributions; HSA/Roth early-withdrawal
penalties not modeled; light theme only; the pre-retirement snapshot readout (today's
marginal/effective rate) is still a single point in time, kept alongside the newer year-by-year
accumulation ledger rather than replaced by it (self-contained, doesn't need retirementYear >
baseYear); accumulation-phase Roth conversions are gated behind selecting `bracketFill`
decumulation sequencing rather than having their own independent toggle — a scope-control
simplification, not a hard requirement; HSA contribution limits are indexed by the SAME rate as
the standard deduction (a reasonable proxy — 2025→2026 growth was +2.3% on both tiers, tracking
close to inflation) rather than the real IRS formula's own lumpier $50-rounded chained-CPI
calculation; self-employed HSA/FICA/SE-tax differences aren't modeled — a known gap, logged for
later, not blocking (self-employment tax works entirely differently from W-2 payroll FICA); the
contribution waterfall assumes a SINGLE-tier employer match (rate + cap % of pay) rather than a
real multi-tier formula ("100% on the first 3%, 50% on the next 2%"), and claims accounts by
role/taxStatus (first taxDeferred/hsa/roth) rather than letting you assign specific accounts to
specific tiers — both real, documented scope simplifications, not oversights; Roth IRA MAGI is
approximated as gross `income` (not a real AGI/MAGI calculation), and the phase-out is linear
rather than the IRS's own $10-rounded/$200-floor version; the combined employer+employee 401(k)
contribution limit (~$70k) isn't modeled, only the employee's own elective deferral limit.

> `data/tax-tables.json` 2025/2026 figures are VERIFIED (IRS Rev. Proc. 2025-32 + cross-checked
> secondary sources, see `_meta`). RMD divisors past age 100 are unverified approximations.

Code comments cite "plan.md §N"; that's the author's private design doc — `README.md` summarizes
the essentials it covers.
