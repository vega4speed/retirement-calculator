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
                         gross-up, portfolio survival). Tax is opt-in: omit filingStatus/
                         taxTables and it's the pure pre-tax Phase 3 behavior, unchanged.
  socialsecurity.js     earnings → AIME → PIA → claiming   — stub
  strategies.js         withdrawal amount + sequencing     — superseded by project.js's
                         built-in sequencing; revisit for Phase 6 (bracket-fill withdrawals,
                         Roth conversions, which need tax.js's ordinaryTax/resolveYearTable)
ui/                   vanilla-JS UI (no framework, no deps)
  app.js                app shell: accounts + working-years + retirement-spending assumptions
                         + full-lifecycle projection; localStorage persistence
  accounts-editor.js    enter/edit accounts, tax statuses, balances, cost basis
  setting-control.js    the reusable Simple/Expand knob (supports `perAccount:false` for
                         household-level settings like spending), with a live resolved preview
  projection-view.js    stat tiles (incl. portfolio survival, lifetime tax) + the two-series
                         chart (today's $ vs nominal, retirement marker) + a table (both phases,
                         sticky headers, an age column when birthYear is known, and a clickable
                         Tax cell that expands a per-bracket breakdown row)
  dom.js, formats.js    tiny DOM builder (incl. SVG) + value<->input formatting helpers
data/                 tax-tables.json (verified 2025/2026 figures) + EXAMPLE templates
schemas/              JSON Schemas for profile / snapshot / scenario
test/                 node:test suites (smoke, resolver, accumulation, decumulation, tax,
                       decumulation-tax) — 79 passing
```

## Running

- **Tests:** `npm test` (runs `node --test` over `test/*.test.js`, no deps to install).
- **App:** serve over http — ES modules don't load from a bare `file://` open. E.g.
  `python3 -m http.server 8000`, then open the printed URL. `mount()` in `ui/app.js` is async —
  it `fetch()`s `data/tax-tables.json` at startup; if that fetch fails (e.g. opened via bare
  `file://`), the app degrades gracefully to pre-tax mode rather than breaking.

## Status

Done & tested: the override resolver, the accounts + Simple/Expand UI, and the full **tax-aware**
accumulation→decumulation projection — growth + contributions to retirement; then spending, a
withdrawal strategy, tax-status-aware sequencing, RMDs (SECURE 2.0 birth-year rule), federal
ordinary + capital-gains tax with gross-up, and portfolio survival to a horizon year — charted in
today's dollars with a retirement marker, hover crosshair, and table view (tax/net-spendable/age
columns, sticky headers, and a clickable Tax cell showing the per-bracket breakdown). In
progress: Social Security, tax-bracket-aware ("fill to the top of a bracket") withdrawal
sequencing and Roth conversions.

**Fixed 2026-07-21:** the portfolio-survival badge could falsely claim depletion on the very
first decumulation year — `solveTaxYear`'s $0.01 gross-up convergence tolerance was leaking
through as a fake `shortfall`. Only a genuinely exhausted portfolio (hit its total balance cap)
reports a shortfall now; see the regression test in `test/decumulation-tax.test.js`.

Known simplifications (see README's Status section for the full list): flat state tax rate (no
state brackets); `otherIncome` isn't taxed yet (Phase 5's Social Security will be); taxable-
account cost basis is a constant fraction from the snapshot, not grown through contributions;
HSA/Roth early-withdrawal penalties not modeled; light theme only; no income modeling yet.

> `data/tax-tables.json` 2025/2026 figures are VERIFIED (IRS Rev. Proc. 2025-32 + cross-checked
> secondary sources, see `_meta`). RMD divisors past age 100 are unverified approximations.

Code comments cite "plan.md §N"; that's the author's private design doc — `README.md` summarizes
the essentials it covers.
