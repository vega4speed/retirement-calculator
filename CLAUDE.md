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
                         bracketBreakdown() powers the table's clickable-Tax-cell detail view)
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
  socialsecurity.js     earnings → AIME → PIA → claiming → COLA/haircut — DONE (implemented +
                         tested). fullRetirementAge() (1983-Amendments table), estimatePIA()
                         (bend-point formula on a "wage-indexed-equivalent" earnings setting —
                         a documented v1 simplification, see the file's header), 
                         benefitAtClaimingAge() (early reduction / delayed credits, capped at 70).
  strategies.js         withdrawal amount + sequencing     — superseded by project.js's
                         built-in sequencing (now including bracketFill, Phase 6). Roth
                         conversions (Phase 6 stretch) are the remaining natural extension of
                         the same bracket-fill machinery.
ui/                   vanilla-JS UI (no framework, no deps)
  app.js                app shell: accounts + filing/tax + working-years + retirement-spending
                         + Social Security assumptions + full-lifecycle projection; localStorage
                         persistence. Live benefit-estimate readout in the SS section, recomputed
                         from the same engine functions the projection uses (never drifts).
  accounts-editor.js    enter/edit accounts, tax statuses, balances, cost basis
  setting-control.js    the reusable Simple/Expand knob (supports `perAccount:false` for
                         household-level settings like spending), with a live resolved preview
  projection-view.js    stat tiles (incl. portfolio survival, lifetime tax, lifetime effective
                         tax rate) + the two-series chart (today's $ vs nominal, retirement
                         marker, hover tooltip shows age + that year's effective tax rate) + a
                         table (both phases, sticky headers, an age column when birthYear is
                         known, and a clickable Tax cell that expands a per-bracket breakdown row
                         — now including what the standard deduction sheltered, plus a marginal-
                         vs-effective-rate line — the whole view preserves scroll position, both
                         the page's own AND the table's own internal scroll container, across
                         re-renders)
  dom.js, formats.js    tiny DOM builder (incl. SVG) + value<->input formatting helpers
data/                 tax-tables.json (verified 2025/2026 figures) + EXAMPLE templates
schemas/              JSON Schemas for profile / snapshot / scenario
test/                 node:test suites (smoke, resolver, accumulation, decumulation, tax,
                       decumulation-tax, socialsecurity, social-security-decumulation,
                       bracket-fill) — 107 passing
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
into the same gross-up — and (Phase 6) **tax-bracket-aware withdrawal sequencing**: a `bracketFill`
mode that draws tax-deferred accounts FIRST each year, up to the top of a chosen ordinary-income
bracket, before touching taxable/Roth — the opposite preference from conventional order, meant to
deliberately realize cheap ordinary income in low-income retirement years instead of letting it
all pile up as RMDs later. The UI's bracket picker lists the current filing status's own bracket
rates, so it always matches what the engine can resolve. Charted in today's dollars with a
retirement marker, a hover tooltip that now includes age, and table view (tax/net-spendable/age
columns, sticky headers, clickable per-bracket Tax detail) — the whole view preserves scroll
position across re-renders now, so expanding a table row no longer jumps you back to the top. In
progress: Roth conversions (the natural extension of the same bracket-fill machinery — convert
tax-deferred → Roth up to a bracket ceiling in the gap years before RMDs start) and couple/spousal
Social Security.

**Fixed 2026-07-22 (two small UI bugs):**
1. Clicking a Tax cell to expand its per-bracket breakdown — or toggling "Show table" — fully
   rebuilds the projection view's DOM, which silently reset the page's scroll position to the
   top (lost scroll anchoring on a full subtree replace). `createProjectionView`'s `render()` now
   captures `window.scrollY` before clearing and restores it after re-appending.
2. The chart's hover tooltip showed year and phase but not age, even though the table already had
   an age column. Added `· age N` to the tooltip's first line when `birthYear` is known.

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
FICA wage-base cap isn't modeled; SS only starts once decumulation begins even if claimed
earlier; taxable-account cost basis is a constant fraction from the snapshot, not grown through
contributions; HSA/Roth early-withdrawal penalties not modeled; light theme only; no income
modeling yet.

> `data/tax-tables.json` 2025/2026 figures are VERIFIED (IRS Rev. Proc. 2025-32 + cross-checked
> secondary sources, see `_meta`). RMD divisors past age 100 are unverified approximations.

Code comments cite "plan.md §N"; that's the author's private design doc — `README.md` summarizes
the essentials it covers.
