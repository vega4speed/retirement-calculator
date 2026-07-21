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
  project.js          accumulation + decumulation projection, tax-aware, incl. Social
                       Security's income/taxation (done + tested)
  socialsecurity.js   earnings → AIME → PIA → claiming, COLA, solvency haircut (done + tested)
  strategies.js       superseded by project.js's built-in sequencing; revisit for
                       Phase 6 (bracket-fill withdrawals, Roth conversions)
ui/                 vanilla-JS UI (accounts, Simple/Expand controls, projection chart)
data/               tax-tables.json + example profile/snapshot/scenario templates
schemas/            JSON Schemas for profile / snapshot / scenario
test/               node:test suites
```

## Status

Done & tested: the override resolver, the accounts + Simple/Expand UI, the full **tax-aware
accumulation + decumulation projection** — growth and contributions to retirement, then spending,
a withdrawal strategy (fixed target or % of balance), tax-status-aware account sequencing, RMDs
(forced by the SECURE 2.0 birth-year rule), federal ordinary-income and capital-gains tax with
gross-up (withdrawals are increased so the *net* after tax hits your spending target) — and now
**Social Security**: the benefit is *estimated from your earnings*, not typed in as a fixed
number, via the real bend-point PIA formula, so "work N more years" or "claim earlier" changes
the estimate. Includes claiming-age adjustment (early reduction / delayed credits, capped at 70),
COLA, a solvency-haircut lever (the OASI trust fund's own ~77%-payable-if-depleted projection),
and real taxation of the benefit (the provisional-income formula) that composes into the same
gross-up as everything else. All charted in today's dollars with a retirement marker, hover
crosshair, and a table view — age per year, sticky column headers, and a clickable Tax cell that
expands to show exactly how much fell in each ordinary/capital-gains bracket that year. In
progress: tax-bracket-aware withdrawal sequencing (Roth conversions, "fill to the top of a
bracket") and couple/spousal Social Security.

Known simplifications, documented in the code: state tax is a flat rate (no state brackets);
`otherIncome` (pension/rental placeholder) still isn't taxed — a deliberate v1 boundary, unlike
Social Security which now is; "earnings" for the SS estimate is wage-indexed-equivalent rather
than real historical dollars run through the actual SSA wage index (skips a multi-decade table
the tool doesn't have verified data for — see `engine/socialsecurity.js`'s header for the full
reasoning); the FICA wage-base cap isn't modeled (high earners' PIA is modestly overstated);
Social Security only starts once decumulation begins, even if your claiming age is earlier;
taxable-account cost basis is a constant fraction from your snapshot, not grown through
contributions; HSA non-medical penalties and Roth early-withdrawal rules aren't modeled; light
theme only (no dark mode); no income modeling yet (blocks a %-of-income contribution mode).

> **Note:** `data/tax-tables.json` 2025/2026 figures are verified against IRS Rev. Proc. 2025-32
> and cross-checked secondary sources (see the file's `_meta`). RMD divisors past age 100 are
> unverified approximations — re-check before relying on projections that far out.
