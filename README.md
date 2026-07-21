# Retirement Calculator

Project your current investment accounts forward under adjustable assumptions — rates of
return, retirement timing, withdrawal rate and tax-aware account sequencing, Social Security,
inflation, and tax-policy drift — and measure the result in **today's dollars**.

Static, zero-dependency web app (vanilla JS, no build step). **Your data never leaves your
browser** — everything is saved locally (localStorage) with Export/Import for backups. Nothing
is uploaded, and no personal financial data lives in this repository.

## Use it

Hosted (GitHub Pages): open the published URL, enter your accounts, and go — state persists in
your browser.

Run it locally: this app uses ES modules, which don't load from a bare `file://` open, so serve
the folder over http —

```bash
python3 -m http.server 8000    # or: npx serve -l 8000
# then open http://localhost:8000
```

## Develop

```bash
npm test        # node --test over test/*.test.js — zero dependencies to install
```

The design centers on a **general → granular override resolver**: every adjustable setting is a
`{ default, byAccount?, byYear?, byAccountYear? }` value resolved most-specific-first. Set one
value in Simple mode, or Expand to override it per account, per year, or per account-per-year.

```
index.html          the app entry point
engine/             pure calculation modules (no DOM, no I/O) — unit-tested
  resolver.js         the override resolver (done + tested)
  tax.js               brackets / std ded / LTCG / SS taxation / RMDs (done + tested)
  project.js          accumulation + decumulation projection, tax-aware (done + tested)
  socialsecurity.js   earnings → AIME → PIA → claiming            (in progress)
  strategies.js       superseded by project.js's built-in sequencing; revisit for
                       Phase 6 (bracket-fill withdrawals, Roth conversions)
ui/                 vanilla-JS UI (accounts, Simple/Expand controls, projection chart)
data/               tax-tables.json + example profile/snapshot/scenario templates
schemas/            JSON Schemas for profile / snapshot / scenario
test/               node:test suites
```

## Status

Done & tested: the override resolver, the accounts + Simple/Expand UI, and the full **tax-aware
accumulation + decumulation projection** — growth and contributions to retirement, then spending,
a withdrawal strategy (fixed target or % of balance), tax-status-aware account sequencing, RMDs
(forced by the SECURE 2.0 birth-year rule), federal ordinary-income and capital-gains tax with
gross-up (withdrawals are increased so the *net* after tax hits your spending target), and
portfolio-survival tracking through a horizon year — all charted in today's dollars with a
retirement marker, hover crosshair, and a table view. In progress: Social Security and
tax-bracket-aware withdrawal sequencing (Roth conversions, "fill to the top of a bracket").

Known simplifications, documented in the code: state tax is a flat rate (no state brackets);
`otherIncome` (pension/rental placeholder) isn't taxed yet — Social Security's own taxation
(Phase 5) will be the first real guaranteed-income source properly modeled; taxable-account cost
basis is tracked as a constant fraction from your snapshot, not grown through accumulation
contributions; HSA non-medical penalties and Roth early-withdrawal rules aren't modeled; light
theme only (no dark mode); no income modeling yet (blocks a %-of-income contribution mode).

> **Note:** `data/tax-tables.json` 2025/2026 figures are verified against IRS Rev. Proc. 2025-32
> and cross-checked secondary sources (see the file's `_meta`). RMD divisors past age 100 are
> unverified approximations — re-check before relying on projections that far out.
