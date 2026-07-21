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
  project.js          accumulation + decumulation projection (done + tested); pre-tax
  tax.js              brackets / std ded / LTCG / SS taxation / RMDs (in progress)
  socialsecurity.js   earnings → AIME → PIA → claiming            (in progress)
  strategies.js       withdrawal amount + tax-aware sequencing    (in progress)
ui/                 vanilla-JS UI (accounts, Simple/Expand controls, projection chart)
data/               tax-tables.json + example profile/snapshot/scenario templates
schemas/            JSON Schemas for profile / snapshot / scenario
test/               node:test suites
```

## Status

Early build. Done & tested: the override resolver, the accounts + Simple/Expand UI, and the
full **accumulation + decumulation projection** — growth and contributions to retirement, then
spending, a withdrawal strategy (fixed target or % of balance), tax-status-aware account
sequencing, and portfolio-survival tracking through a horizon year — all charted in today's
dollars with a retirement marker, hover crosshair, and a table view. This is **pre-tax**:
withdrawals are gross dollar pulls, no tax is computed, and RMDs aren't forced yet. In progress:
taxes, Social Security, and tax-aware withdrawal sequencing.

Known gaps: light theme only (no dark mode yet); no income modeling yet (blocks a %-of-income
contribution mode and feeds into the tax/SS engines later).

> **Note:** `data/tax-tables.json` figures are unverified placeholders and must be reconciled
> against current IRS tables before the tax engine relies on them.
