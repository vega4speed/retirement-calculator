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
  project.js            accumulation + decumulation — DONE, pre-tax (spending, withdrawal
                         strategy, tax-status sequencing, portfolio survival); taxes/RMDs next
  tax.js                brackets / std ded / LTCG / SS tax / RMDs — stub
  socialsecurity.js     earnings → AIME → PIA → claiming   — stub
  strategies.js         withdrawal amount + sequencing     — superseded by project.js's
                         built-in sequencing for Phase 3; revisit for Phase 6 (bracket-fill,
                         Roth conversions) which need the tax engine
ui/                   vanilla-JS UI (no framework, no deps)
  app.js                app shell: accounts + working-years + retirement-spending assumptions
                         + full-lifecycle projection; localStorage persistence
  accounts-editor.js    enter/edit accounts, tax statuses, balances, cost basis
  setting-control.js    the reusable Simple/Expand knob (supports `perAccount:false` for
                         household-level settings like spending), with a live resolved preview
  projection-view.js    stat tiles (incl. portfolio survival) + the two-series chart (today's $
                         vs nominal, with a retirement marker) + table, spanning both phases
  dom.js, formats.js    tiny DOM builder (incl. SVG) + value<->input formatting helpers
data/                 tax-tables.json + EXAMPLE profile/snapshot/scenario templates
schemas/              JSON Schemas for profile / snapshot / scenario
test/                 node:test suites (smoke, resolver, accumulation, decumulation)
```

## Running

- **Tests:** `npm test` (runs `node --test` over `test/*.test.js`, no deps to install).
- **App:** serve over http — ES modules don't load from a bare `file://` open. E.g.
  `python3 -m http.server 8000`, then open the printed URL.

## Status

Done & tested: the override resolver, the accounts + Simple/Expand UI, and the full
accumulation→decumulation projection (growth + contributions to retirement; then spending, a
withdrawal strategy, tax-status-aware sequencing, and portfolio survival to a horizon year) —
charted in today's dollars with a retirement marker, hover crosshair, and table view. Pre-tax:
no tax is computed and no RMDs are forced yet. In progress: taxes, RMDs, Social Security, and
tax-bracket-aware withdrawal sequencing.

Known gaps: light theme only (no dark mode); no income modeling yet.

> `data/tax-tables.json` figures are UNVERIFIED placeholders — reconcile against current IRS
> tables (and current law) before the tax engine relies on them.

Code comments cite "plan.md §N"; that's the author's private design doc — `README.md` summarizes
the essentials it covers.
