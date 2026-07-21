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
  project.js            accumulation projection — DONE (growth+contributions); decumulation next
  tax.js                brackets / std ded / LTCG / SS tax / RMDs — stub
  socialsecurity.js     earnings → AIME → PIA → claiming   — stub
  strategies.js         withdrawal amount + sequencing     — stub
ui/                   vanilla-JS UI (no framework, no deps)
  app.js                app shell: accounts + assumptions + projection; localStorage persistence
  accounts-editor.js    enter/edit accounts, tax statuses, balances, cost basis
  setting-control.js    the reusable Simple/Expand knob, with a live resolved preview
  projection-view.js    summary tiles + the two-series chart (today's $ vs nominal) + table
  dom.js, formats.js    tiny DOM builder (incl. SVG) + value<->input formatting helpers
data/                 tax-tables.json + EXAMPLE profile/snapshot/scenario templates
schemas/              JSON Schemas for profile / snapshot / scenario
test/                 node:test suites (smoke + resolver)
```

## Running

- **Tests:** `npm test` (runs `node --test` over `test/*.test.js`, no deps to install).
- **App:** serve over http — ES modules don't load from a bare `file://` open. E.g.
  `python3 -m http.server 8000`, then open the printed URL.

## Status

Done & tested: the override resolver, the accounts + Simple/Expand UI, and the accumulation
projection (growth + contributions → retirement, charted in today's dollars, with a hover
crosshair and table view). In progress: decumulation, taxes, Social Security, withdrawal strategies.

> `data/tax-tables.json` figures are UNVERIFIED placeholders — reconcile against current IRS
> tables (and current law) before the tax engine relies on them.

Code comments cite "plan.md §N"; that's the author's private design doc — `README.md` summarizes
the essentials it covers.
