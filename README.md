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
                       Security's income/taxation, plus solveMaxSustainableSpending() — a
                       binary search for the highest constant spend the portfolio survives
                       (done + tested)
  socialsecurity.js   earnings → AIME → PIA → claiming, COLA, solvency haircut (done + tested)
  strategies.js       superseded by project.js's built-in sequencing (bracketFill,
                       Phase 6, plus Roth conversions built on top of it)
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
a withdrawal strategy (fixed target, % of balance, or **maximum sustainable** — see below),
tax-status-aware account sequencing, RMDs
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

**Maximum sustainable spending.** A third withdrawal strategy alongside "fixed target" and "% of
balance": instead of typing an annual spending number, solve for the highest constant real amount
your portfolio actually survives through your full horizon — a binary search over the same
projection engine, shown as a live "Solved: $X/yr" readout that updates as you change any other
assumption.

**Phase 7: scenario comparison.** Save the current accounts + assumptions as a named scenario —
it's a frozen snapshot, so editing your live accounts or assumptions afterward never changes a
scenario you already saved. Select 2–4 scenarios to compare side by side: a combined today's-
dollars balance chart (each scenario keeps the same color for as long as it's part of a
comparison, even as you check/uncheck others) and a headline-readout table — does the money last,
ending balance, lifetime tax, lifetime effective tax rate, the solved maximum sustainable spend
when that strategy was used, and the assumptions that actually differ between them. "Load" puts a
saved scenario back into the live editor to keep tweaking it — and once loaded, an "Update"
button appears so a change you make actually gets saved back to that scenario, instead of only
existing in the (also-persisted, but separate) live editor state.

**Roth conversions.** Built on top of bracket-fill sequencing: in the gap years before you're
forced to take RMDs, whatever room is left in your chosen bracket after covering spending gets
converted from tax-deferred to Roth instead of sitting unused — preserved in full; its own tax
comes from other accounts, not carved out of the converted amount. Raises this year's tax bill
on purpose, to shrink future RMDs and grow tax-free after — a "Converted to Roth" stat tile, table
column, and chart-hover line show what happened, and it's comparable across scenarios too.

**Pre-retirement tax rate.** A snapshot (not a multi-year projection) of today's marginal and
effective tax rate, from the same earnings figure the Social Security estimate uses, compared
against your projected retirement effective rate — with a plain-language verdict on whether
traditional (tax-deferred) or Roth contributions look more tax-efficient for you right now. The
standard financial-planning heuristic for that decision.

**Working-years income & tax, and Roth conversions while you work.** Beyond that snapshot, the
projection now models your actual working years year by year: income (your earnings setting
growing with wages), the real tax deduction your 401(k)/IRA contributions earn you, tax,
marginal rate, and effective rate — so you can see whether paying more tax now to defer it (or
vice versa) is a genuine trade-off for your numbers, or just adds to your lifetime tax bill. The
same Roth-conversion feature above now also runs during your working years (opt in by picking
"fill to the top of a bracket" as your withdrawal order) — converting unused bracket room from
tax-deferred to Roth, paid for out of take-home pay instead of a portfolio withdrawal. In
practice this is usually $0 while working full-time (a full salary already fills a modest
bracket on its own) and shows up mainly in a lower-income working year — a part-time stretch, a
gap year, or early in a career. Because working years can carry their own tax now, the "lifetime"
tax figures are joined by retirement-only ones (used for the trad-vs-Roth verdict above, so it
isn't diluted by pre-retirement tax) and a combined "working + retired" total is shown whenever
it actually differs from the retirement-only figure.

**Fair Traditional-vs-Roth comparisons, and HSA.** A $1,000 Roth contribution and a $1,000
Traditional contribution aren't an apples-to-apples comparison — Roth is post-tax, so it costs
$1,000 out of your paycheck, full stop; Traditional shields itself from tax, so that same $1,000
gross costs you LESS take-home pay. So contributions to Traditional and HSA accounts are now
anchored to the take-home cost you're willing to give up, not the raw dollar amount — type in
what you're willing to give up from your paycheck, and the calculator solves for the larger
amount that actually lands in a Traditional or HSA account (an exact tax-bracket calculation, not
a rough estimate). You can set that figure as a flat dollar amount or as a % of income (Dave
Ramsey's "give 15%" heuristic, for instance) — a one-line note under the setting shows what
today's figure actually buys in each account type. HSA accounts now also get their own real tax
treatment: a "max out" option fills the account to that year's actual IRS limit (including the
55+ catch-up), and a "via payroll" option reflects that payroll HSA contributions skip Social
Security/Medicare tax too — a real advantage a Traditional 401(k)/IRA never gets, regardless of
how you contribute.

**The standard investment order.** A common savings strategy: contribute to your 401(k) up to the
employer match (free money), then max your HSA, then contribute to a Roth IRA up to its limit,
then go back to your 401(k) for anything left of what you'd planned to save. Rather than
computing each of those numbers by hand, turn on "the standard investment order" and set one
overall budget (a flat $ or a % of income) — the calculator fills each step in order, respecting
that step's real IRS limit, before moving to the next: 401(k) up to your match, HSA to its real
max, Roth IRA up to its limit (reduced or eliminated at higher incomes, per the real IRS
phase-out), then back to the 401(k) for whatever's left, capped by its own real annual limit.
Employer match is modeled separately as free money on top of your own contribution, shown as its
own stat tile and table column. The projection table also shows a column per account during your
working years (contribution + any match), an Income column, and %-of-income next to your
Total-contribution and Tax figures — so you can see exactly where each year's money went without
doing the math by hand. A toggle switches the whole table between nominal dollars and today's
dollars.

In progress: couple/spousal Social Security (the remaining v1-boundary item).

Known simplifications, documented in the code: state tax is a flat rate (no state brackets);
`otherIncome` (pension/rental placeholder) still isn't taxed — a deliberate v1 boundary, unlike
Social Security which now is; "earnings" for the SS estimate is wage-indexed-equivalent rather
than real historical dollars run through the actual SSA wage index (skips a multi-decade table
the tool doesn't have verified data for — see `engine/socialsecurity.js`'s header for the full
reasoning); the FICA wage-base cap and Additional Medicare Tax threshold aren't modeled (a flat
7.65% rate is used only for the HSA take-home-cost calculation, not as a real payroll-tax
liability computed anywhere); Social Security only starts once decumulation begins, even if your
claiming age is earlier; taxable-account cost basis is a constant fraction from your snapshot,
not grown through contributions; HSA non-medical penalties and Roth early-withdrawal rules aren't
modeled; light theme only (no dark mode); working-years Roth conversions are gated behind picking
"fill to the top of a bracket" as your withdrawal order rather than having their own independent
toggle, a scope-control simplification rather than a hard requirement; HSA contribution limits
are indexed by the same rate as the standard deduction (a reasonable proxy, tracking close to
recent real growth) rather than the IRS's own lumpier formula; self-employed HSA/payroll-tax
differences aren't modeled — a known gap for later, since self-employment tax works entirely
differently from W-2 payroll withholding; the investment-order waterfall assumes a single-tier
employer match ("100% up to 4% of pay") rather than a real multi-tier formula, and fills accounts
by type (your first 401(k)/HSA/Roth account) rather than letting you assign specific accounts to
specific steps; the Roth IRA income phase-out uses your gross income as a stand-in for the real
MAGI calculation, and the combined employer + employee 401(k) contribution limit (around $70k)
isn't modeled — only your own employee contribution limit is.

> **Note:** `data/tax-tables.json` 2025/2026 figures are verified against IRS Rev. Proc. 2025-32
> and cross-checked secondary sources (see the file's `_meta`). RMD divisors past age 100 are
> unverified approximations — re-check before relying on projections that far out.
