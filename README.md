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
  strategies.js       superseded by project.js's built-in sequencing (now incl.
                       bracketFill, Phase 6); Roth conversions remain the natural
                       extension of the same machinery
ui/                 vanilla-JS UI (accounts, Simple/Expand controls, projection chart,
                     scenario comparison — Phase 7)
data/               tax-tables.json + example profile/snapshot/scenario templates
schemas/            JSON Schemas for profile / snapshot / scenario (Phase 0 scaffolding,
                     not wired up — the app's actual state shape evolved differently)
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
gross-up as everything else. There's also a **tax-bracket-aware withdrawal order**: instead of
the conventional cash → taxable → tax-deferred → HSA → Roth sequence, "fill to the top of a
bracket" draws tax-deferred money FIRST, up to the top of whichever ordinary-income bracket you
pick, before touching taxable or Roth — a real retirement tax strategy (realize cheap ordinary
income while you're in a low bracket, instead of letting it compound into bigger RMDs later).
All charted in today's dollars with a retirement marker, a hover tooltip (now including age and
that year's effective tax rate), and a table view — age per year, sticky column headers, and a
clickable Tax cell that expands to show exactly how much fell in each ordinary/capital-gains
bracket that year, including what the standard deduction sheltered, plus a **marginal vs.
effective tax rate** comparison (marginal = the rate on the last dollar; effective = total tax ÷
total gross income — the number that actually shows whether a strategy is tax-efficient, since a
strategy can raise lifetime tax in dollars while keeping the effective rate low by spreading
income across more years). There's a lifetime version of that same rate as a stat tile, for
comparing strategies at a glance. The view preserves your scroll position (both the page's and
the table's own internal scroll) across these interactions instead of jumping to the top.

**Phase 7: scenario comparison.** Save the current accounts + assumptions as a named scenario —
it's a frozen snapshot, so editing your live accounts or assumptions afterward never changes a
scenario you already saved. Select 2–4 scenarios to compare side by side: a combined today's-
dollars balance chart (each scenario keeps the same color for as long as it's part of a
comparison, even as you check/uncheck others) and a headline-readout table — does the money last,
ending balance, lifetime tax, lifetime effective tax rate, and the assumptions that actually
differ between them. "Load" puts a saved scenario back into the live editor to keep tweaking it.

In progress: Roth conversions (the natural extension of the bracket-fill machinery) and
couple/spousal Social Security.

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
