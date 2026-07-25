// projection-view.js — renders a project() result (design doc §4): summary stat tiles
// (including portfolio survival), a two-series line chart spanning accumulation AND
// decumulation with a retirement marker, and a table view.
//
// Chart design follows the dataviz method: change-over-time → line chart; two series → legend
// present + direct end-labels; blue = today's-dollars (the headline), orange = nominal. Palette
// validated (CVD ΔE 24.7 light / 26.8 dark). Status colors (good/critical) are the skill's fixed,
// pre-validated tokens, shown with an icon + label (never color alone). A hover crosshair+tooltip
// and a table view provide the interaction/accessibility layers.

import { h, s, clear } from './dom.js';
import { COL as BASE_COL, usd, usdFull, niceCeil, xTickYears } from './chart-utils.js';

const COL = {
  ...BASE_COL,
  real: '#2a78d6',      // categorical slot 1 — today's dollars (headline)
  nominal: '#eb6834',   // categorical slot 2 — nominal
};

function statTile(label, value, sub, accent) {
  return h('div', { class: 'stat' },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value', style: accent ? { color: accent } : {} }, value),
    sub ? h('div', { class: 'stat-sub' }, sub) : null,
  );
}

function survivalTile(result) {
  const depleted = result.firstDepletionYear != null;
  const label = 'Portfolio';
  if (result.horizonYear <= result.retirementYear) {
    return statTile(label, '— not yet in retirement —', 'Set a horizon year past retirement', COL.muted);
  }
  if (depleted) {
    return h('div', { class: 'stat' },
      h('div', { class: 'stat-label' }, label),
      h('div', { class: 'stat-value', style: { color: COL.critical } }, '⚠ Runs out'),
      h('div', { class: 'stat-sub' }, `in ${result.firstDepletionYear}, before the ${result.horizonYear} horizon`),
    );
  }
  return h('div', { class: 'stat' },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value', style: { color: COL.good } }, '✓ Lasts'),
    h('div', { class: 'stat-sub' }, `through ${result.horizonYear}`),
  );
}

function buildChart(result) {
  const rows = result.years;
  const baseYear = rows[0].year;
  const endYear = rows[rows.length - 1].year;
  const retYear = result.retirementYear;
  const W = 760, H = 360, m = { t: 20, r: 132, b: 40, l: 66 };
  const plotW = W - m.l - m.r, plotH = H - m.t - m.b;

  const ymax = niceCeil(Math.max(1, ...rows.map((r) => r.totals.endBalance)));
  const xspan = Math.max(1, endYear - baseYear);
  const xScale = (yr) => m.l + ((yr - baseYear) / xspan) * plotW;
  const yScale = (v) => m.t + plotH - (v / ymax) * plotH;

  const pts = (sel) => rows.map((r) => `${xScale(r.year).toFixed(2)},${yScale(sel(r)).toFixed(2)}`).join(' ');
  const nominalPts = pts((r) => r.totals.endBalance);
  const realPts = pts((r) => r.real.endBalance);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * ymax);
  const grid = yTicks.map((v) =>
    s('line', { x1: m.l, y1: yScale(v), x2: m.l + plotW, y2: yScale(v), stroke: v === 0 ? COL.base : COL.grid, 'stroke-width': 1 }));
  const yLabels = yTicks.map((v) =>
    s('text', { x: m.l - 8, y: yScale(v) + 4, 'text-anchor': 'end', fill: COL.muted, 'font-size': 11, 'font-variant-numeric': 'tabular-nums' }, usd(v)));
  const xLabels = xTickYears(baseYear, endYear).map((yr) =>
    s('text', { x: xScale(yr), y: m.t + plotH + 20, 'text-anchor': 'middle', fill: COL.muted, 'font-size': 11, 'font-variant-numeric': 'tabular-nums' }, yr));

  // retirement marker: a neutral (non-data-color) annotation, not a third series
  const retMarker = (retYear > baseYear && retYear < endYear)
    ? s('g', {},
        s('line', { x1: xScale(retYear), y1: m.t, x2: xScale(retYear), y2: m.t + plotH, stroke: COL.base, 'stroke-width': 1, 'stroke-dasharray': '2 3' }),
        s('text', { x: xScale(retYear), y: m.t - 6, 'text-anchor': 'middle', fill: COL.muted, 'font-size': 10 }, 'Retirement'))
    : null;

  const endRow = rows[rows.length - 1];
  let yNom = yScale(endRow.totals.endBalance);
  let yReal = yScale(endRow.real.endBalance);
  if (Math.abs(yReal - yNom) < 14) yReal = yNom + (yReal >= yNom ? 14 : -14);
  const endLabel = (yy, color, tag, val) =>
    s('g', {},
      s('circle', { cx: xScale(endYear), cy: yScale(val), r: 3.5, fill: color }),
      s('text', { x: xScale(endYear) + 10, y: yy + 4, fill: COL.ink2, 'font-size': 12 },
        s('tspan', { fill: color, 'font-weight': 700 }, '● '), `${tag} ${usd(val)}`));

  const cross = s('line', { x1: 0, y1: m.t, x2: 0, y2: m.t + plotH, stroke: COL.base, 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden' });
  const dotN = s('circle', { r: 4, fill: COL.nominal, stroke: '#fff', 'stroke-width': 1.5, visibility: 'hidden' });
  const dotR = s('circle', { r: 4, fill: COL.real, stroke: '#fff', 'stroke-width': 1.5, visibility: 'hidden' });

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': `Projected balance from ${baseYear} to ${endYear}` },
    s('title', {}, `Projected balance ${baseYear}–${endYear}: today's dollars and nominal`),
    ...grid, ...yLabels, ...xLabels, retMarker,
    s('polyline', { points: nominalPts, fill: 'none', stroke: COL.nominal, 'stroke-width': 2, 'stroke-linejoin': 'round' }),
    s('polyline', { points: realPts, fill: 'none', stroke: COL.real, 'stroke-width': 2, 'stroke-linejoin': 'round' }),
    endLabel(yNom, COL.nominal, 'Nominal', endRow.totals.endBalance),
    endLabel(yReal, COL.real, "Today's", endRow.real.endBalance),
    cross, dotN, dotR);

  const tip = h('div', { class: 'chart-tip', style: { visibility: 'hidden' } });
  const wrap = h('div', { class: 'chart-wrap' }, svg, tip);
  const overlay = s('rect', { x: m.l, y: m.t, width: plotW, height: plotH, fill: 'transparent', style: 'cursor:crosshair' });
  svg.append(overlay);

  const nearestRow = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    const yr = Math.round(baseYear + ((px - m.l) / plotW) * xspan);
    const clamped = Math.min(endYear, Math.max(baseYear, yr));
    return rows.find((r) => r.year === clamped) || rows[rows.length - 1];
  };
  overlay.addEventListener('mousemove', (e) => {
    const r = nearestRow(e.clientX);
    const x = xScale(r.year);
    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
    dotN.setAttribute('cx', x); dotN.setAttribute('cy', yScale(r.totals.endBalance)); dotN.setAttribute('visibility', 'visible');
    dotR.setAttribute('cx', x); dotR.setAttribute('cy', yScale(r.real.endBalance)); dotR.setAttribute('visibility', 'visible');
    clear(tip);
    const ageText = r.age != null ? ` · age ${r.age}` : '';
    const lines = [
      h('div', { class: 'tip-year' }, `${r.year}${ageText} · ${r.phase === 'decumulation' ? 'retired' : 'working'}`),
      h('div', {}, h('span', { class: 'sw', style: { background: COL.real } }), `Today's: ${usdFull(r.real.endBalance)}`),
      h('div', {}, h('span', { class: 'sw', style: { background: COL.nominal } }), `Nominal: ${usdFull(r.totals.endBalance)}`),
    ];
    if (r.phase === 'accumulation') {
      if (r.totals.contribution) lines.push(h('div', { class: 'tip-sub' }, `+ ${usdFull(r.totals.contribution)} contributed`));
      if (r.totals.employerMatch) lines.push(h('div', { class: 'tip-sub' }, `+ ${usdFull(r.totals.employerMatch)} employer match`));
      if (r.totals.tax) {
        const marginal = r.totals.marginalRate != null ? `${(r.totals.marginalRate * 100).toFixed(0)}% marginal` : '';
        const effective = r.totals.effectiveTaxRate != null ? `${(r.totals.effectiveTaxRate * 100).toFixed(1)}% effective` : '';
        lines.push(h('div', { class: 'tip-sub' }, `Income ${usdFull(r.totals.income)} · tax ${usdFull(r.totals.tax)} (${marginal}, ${effective})`));
      }
      if (r.totals.conversion) lines.push(h('div', { class: 'tip-sub' }, `↷ ${usdFull(r.totals.conversion)} converted to Roth`));
    }
    if (r.phase === 'decumulation') {
      lines.push(h('div', { class: 'tip-sub' }, `− ${usdFull(r.totals.withdrawal)} withdrawn`));
      if (r.totals.tax) {
        const effRate = r.totals.effectiveTaxRate != null ? ` (${(r.totals.effectiveTaxRate * 100).toFixed(1)}% effective)` : '';
        lines.push(h('div', { class: 'tip-sub' }, `− ${usdFull(r.totals.tax)} tax${effRate} → ${usdFull(r.totals.netSpendable)} net`));
      }
      if (r.totals.reinvestment) lines.push(h('div', { class: 'tip-sub' }, `+ ${usdFull(r.totals.reinvestment)} RMD surplus reinvested`));
      if (r.totals.conversion) lines.push(h('div', { class: 'tip-sub' }, `↷ ${usdFull(r.totals.conversion)} converted to Roth`));
      if (r.totals.shortfall > 1e-6) lines.push(h('div', { class: 'tip-sub', style: { color: COL.critical } }, `Shortfall: ${usdFull(r.totals.shortfall)}`));
    }
    tip.append(...lines);
    const rect = wrap.getBoundingClientRect();
    const relX = (x / W) * rect.width;
    tip.style.left = `${Math.min(relX + 14, rect.width - 150)}px`;
    tip.style.top = '12px';
    tip.style.visibility = 'visible';
  });
  overlay.addEventListener('mouseleave', () => {
    tip.style.visibility = 'hidden';
    for (const el of [cross, dotN, dotR]) el.setAttribute('visibility', 'hidden');
  });

  const legend = h('div', { class: 'legend' },
    h('span', { class: 'leg' }, h('span', { class: 'sw', style: { background: COL.real } }), "Today's dollars"),
    h('span', { class: 'leg' }, h('span', { class: 'sw', style: { background: COL.nominal } }), 'Nominal'),
  );
  return h('div', {}, legend, wrap);
}

function bracketDetailRow(colspan, breakdown) {
  const stdDeductionRow = breakdown?.stdDeduction > 0
    ? h('tr', { class: 'muted' },
        h('td', {}, 'std. deduction'),
        h('td', { class: 'r' }, `up to ${usdFull(breakdown.stdDeduction)}`),
        h('td', { class: 'r' }, usdFull(0)),
      )
    : null;
  const section = (title, rows, leadingRow) => {
    if (!leadingRow && (!rows || !rows.length)) return null;
    return h('div', { class: 'bracket-section' },
      h('h5', {}, title),
      h('table', { class: 'bracket-mini' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Rate'), h('th', { class: 'r' }, 'Amount at this rate'), h('th', { class: 'r' }, 'Tax'))),
        h('tbody', {}, leadingRow, ...(rows || []).map((row) => h('tr', {},
          h('td', {}, `${(row.rate * 100).toFixed(0)}%`),
          h('td', { class: 'r' }, usdFull(row.amount)),
          h('td', { class: 'r' }, usdFull(row.tax)),
        ))),
      ),
    );
  };
  const ordinary = section('Ordinary income brackets', breakdown?.ordinary, stdDeductionRow);
  const ltcg = section('Capital gains brackets', breakdown?.ltcg);
  const topMarginalRate = breakdown?.ordinary?.length ? breakdown.ordinary[breakdown.ordinary.length - 1].rate : 0;
  // The MARGINAL rate (top bracket touched, shown above) is the rate on the next dollar. The
  // EFFECTIVE rate — tax actually paid divided by total gross income received — is usually much
  // lower, since the standard deduction and every lower bracket are taxed at less than that top
  // rate. This is the number that shows whether a strategy is genuinely tax-efficient: bracket-
  // fill sequencing can raise LIFETIME tax in dollars while keeping the effective rate low each
  // year, by spreading ordinary income across many low-bracket years instead of compressing it.
  const rateCompare = breakdown?.effectiveTaxRate != null && (ordinary || ltcg)
    ? h('p', { class: 'muted small' },
        `Marginal (top bracket touched): ${(topMarginalRate * 100).toFixed(0)}% · Effective (total tax ÷ total gross income): ${(breakdown.effectiveTaxRate * 100).toFixed(1)}%`)
    : null;
  // Splits the tax bill into "tax on regular income" vs "tax on the Roth conversion" — the
  // conversion sits as the TOP slice of ordinary taxable income (bracket-fill fills up to a
  // ceiling, never past it), so this is an exact bracket-walk difference, not an estimate.
  const conversionSplit = breakdown?.conversionAmount > 1e-9
    ? h('p', { class: 'muted small' },
        `Of this, ${usdFull(breakdown.taxOnConversion)} is tax on the ${usdFull(breakdown.conversionAmount)} Roth conversion; the remaining ${usdFull((breakdown.ordinary?.reduce((s, row) => s + row.tax, 0) || 0) - breakdown.taxOnConversion)} is tax on regular income.`)
    : null;
  return h('tr', { class: 'bracket-detail' }, h('td', { colspan },
    (ordinary || ltcg)
      ? h('div', {}, h('div', { class: 'bracket-detail-wrap' }, ordinary, ltcg), rateCompare, conversionSplit)
      : h('p', { class: 'muted small' }, 'No taxable income this year.'),
  ));
}

// Per-account gross/tax-saved/FICA-saved/net-cost table for a clicked "Total contribution" cell
// (accumulation years). `toDisplay` applies the table's own nominal/today's-$ mode toggle.
function contributionDetailRow(colspan, breakdown, toDisplay) {
  if (!breakdown?.accounts?.length) {
    return h('tr', { class: 'bracket-detail' }, h('td', { colspan }, h('p', { class: 'muted small' }, 'No contributions this year.')));
  }
  const totalTaxSaved = breakdown.accounts.reduce((s, a) => s + a.taxSaved, 0);
  const totalFicaSaved = breakdown.accounts.reduce((s, a) => s + a.ficaSaved, 0);
  const table = h('table', { class: 'bracket-mini' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Account'), h('th', { class: 'r' }, 'Gross'), h('th', { class: 'r' }, 'Tax saved'),
      h('th', { class: 'r' }, 'FICA saved'), h('th', { class: 'r' }, 'Net cost'))),
    h('tbody', {}, ...breakdown.accounts.map((a) => h('tr', {},
      h('td', {}, a.label),
      h('td', { class: 'r' }, usdFull(toDisplay(a.gross))),
      h('td', { class: 'r' }, a.taxSaved > 0.5 ? usdFull(toDisplay(a.taxSaved)) : '—'),
      h('td', { class: 'r' }, a.ficaSaved > 0.5 ? usdFull(toDisplay(a.ficaSaved)) : '—'),
      h('td', { class: 'r' }, usdFull(toDisplay(a.netCost))),
    ))),
  );
  const savedNote = (totalTaxSaved > 0.5 || totalFicaSaved > 0.5)
    ? ` — ${usdFull(toDisplay(totalTaxSaved))} in tax and ${usdFull(toDisplay(totalFicaSaved))} in FICA avoided`
    : '';
  const summary = h('p', { class: 'muted small' },
    `${usdFull(toDisplay(breakdown.totalGross))} gross across these accounts cost ${usdFull(toDisplay(breakdown.totalNetCost))} out of your paycheck${savedNote}.`);
  return h('tr', { class: 'bracket-detail' }, h('td', { colspan }, h('div', {}, h('div', { class: 'bracket-detail-wrap' }, table), summary)));
}

const WITHDRAWAL_TAX_STATUS_LABEL = {
  taxDeferred: 'Tax-deferred', roth: 'Roth', taxable: 'Taxable / brokerage', hsa: 'HSA', cash: 'Cash / savings',
};

// Per-account withdrawal breakdown for a clicked "Withdrawal" cell (decumulation years), with the
// RMD floor (and the math behind it) for any tax-deferred account past the required-beginning age.
function withdrawalDetailRow(colspan, breakdown, toDisplay) {
  if (!breakdown?.accounts?.length) {
    return h('tr', { class: 'bracket-detail' }, h('td', { colspan }, h('p', { class: 'muted small' }, 'No withdrawal this year.')));
  }
  const table = h('table', { class: 'bracket-mini' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Account'), h('th', {}, 'Type'), h('th', { class: 'r' }, 'Withdrawn'), h('th', { class: 'r' }, 'RMD required'))),
    h('tbody', {}, ...breakdown.accounts.map((a) => h('tr', {},
      h('td', {}, a.label),
      h('td', { class: 'muted small' }, WITHDRAWAL_TAX_STATUS_LABEL[a.taxStatus] || a.taxStatus),
      h('td', { class: 'r' }, usdFull(toDisplay(a.withdrawal))),
      h('td', { class: 'r' }, a.rmdFloor != null ? usdFull(toDisplay(a.rmdFloor)) : '—'),
    ))),
  );
  const rmdNote = breakdown.accounts.some((a) => a.rmdFloor != null)
    ? h('p', { class: 'muted small' },
        `RMD required = prior year-end balance ÷ the IRS uniform-lifetime divisor for age ${breakdown.age} (SECURE 2.0's required-beginning-age rule).`)
    : null;
  return h('tr', { class: 'bracket-detail' }, h('td', { colspan }, h('div', {}, h('div', { class: 'bracket-detail-wrap' }, table), rmdNote)));
}

// The whole-portfolio equation behind this row's Balance column -- pure arithmetic already on
// `r.totals` (matches rowTotals()'s own identity in engine/project.js exactly), no extra data.
function balanceDetailRow(colspan, r, toDisplay) {
  const t = r.totals;
  const parts = [`Start ${usdFull(toDisplay(t.startBalance))}`];
  if (r.phase === 'decumulation') {
    if (t.withdrawal) parts.push(`− Withdrawals ${usdFull(toDisplay(t.withdrawal))}`);
    if (t.reinvestment) parts.push(`+ RMD surplus reinvested ${usdFull(toDisplay(t.reinvestment))}`);
    parts.push(`+ Growth ${usdFull(toDisplay(t.growth))}`);
    if (t.conversion) parts.push(`(+ ${usdFull(toDisplay(t.conversion))} converted to Roth this year, moved within your own accounts)`);
  } else {
    parts.push(`+ Growth ${usdFull(toDisplay(t.growth))}`);
    if (t.contribution) parts.push(`+ Your contributions ${usdFull(toDisplay(t.contribution))}`);
    if (t.employerMatch) parts.push(`+ Employer match ${usdFull(toDisplay(t.employerMatch))}`);
    if (t.conversion) parts.push(`(${usdFull(toDisplay(t.conversion))} converted to Roth this year, moved within your own accounts -- nets to $0 across all accounts)`);
  }
  parts.push(`= End ${usdFull(toDisplay(t.endBalance))}`);
  return h('tr', { class: 'bracket-detail' }, h('td', { colspan }, h('p', { class: 'muted small' }, parts.join('  '))));
}

function buildTable(result, opts = {}) {
  const rows = result.years;
  const hasTax = rows.some((r) => r.totals.tax);
  const hasAge = rows.some((r) => r.age != null);
  const hasConversion = rows.some((r) => r.totals.conversion);
  const hasMatch = rows.some((r) => r.totals.employerMatch);
  const { expandedCells, onToggleExpand, bracketBreakdownFor, contributionBreakdownFor, withdrawalBreakdownFor } = opts;
  const isExpanded = (year, col) => expandedCells.has(`${year}:${col}`);
  const getAccountLabel = opts.getAccountLabel || ((id) => id);
  const mode = opts.mode === 'real' ? 'real' : 'nominal'; // 'nominal' | 'real' (today's $)

  // Every dollar figure here is nominal-by-construction in the engine; "today's $" is always
  // exactly nominal ÷ that row's cumulativeInflation (the SAME transform project.js uses for
  // real.endBalance) -- recomputing it at display time, uniformly for every column, is simpler
  // and provably consistent than threading a second "real" field through the engine for every
  // total. A ratio (the %-of-income annotations below) is invariant either way, so those are
  // always computed from the raw nominal figures regardless of `mode`.
  const val = (v, r) => (mode === 'real' ? (v || 0) / (r.cumulativeInflation || 1) : (v || 0));
  const pct = (v, income) => (income > 1e-9 ? ` (${((v / income) * 100).toFixed(1)}%)` : '');

  // One column per account that exists during accumulation -- NOT filtered to "ever funded" (a
  // filtered-out account silently vanishing from the table, rather than showing a column full of
  // "—", was confusing: you can't tell "this account type isn't supported here" apart from "this
  // account genuinely got $0" without the column existing to look at).
  const accumRows = rows.filter((r) => r.phase !== 'decumulation');
  const perAccountIds = accumRows.length ? Object.keys(accumRows[0].accounts) : [];

  const colCount = 7 + (hasAge ? 1 : 0) + (hasTax ? 2 : 0) + (hasConversion ? 1 : 0) + (hasMatch ? 1 : 0) + perAccountIds.length;

  const bodyRows = [];
  for (const r of rows) {
    // The Income column and %-of-income annotations on contribution/match/conversion figures
    // all mean "share of what you actually earned" — during accumulation that's wages alone
    // (`totals.income`), NOT wages + any Roth conversion (`totals.grossIncome`): a conversion is
    // money moving between your own accounts, not new income, and it already has its own column.
    // Decumulation has no separate wage figure, so grossIncome (which there already folds the
    // conversion into the withdrawal, not additively) is the only "income" concept available.
    const displayIncome = r.phase === 'decumulation' ? (r.totals.grossIncome || 0) : (r.totals.income || 0);
    const taxIncome = r.totals.grossIncome || 0; // effectiveTaxRate's own denominator — tax legitimately falls on the conversion too
    const toDisplay = (v) => val(v, r);
    const clickableTax = hasTax && bracketBreakdownFor && r.totals.tax > 0.005;
    const taxCell = !hasTax ? null
      : !r.totals.tax ? h('td', { class: 'r' }, '—')
      : clickableTax
        ? h('td', { class: 'r' }, h('button', { class: 'link tax-link', onclick: () => onToggleExpand(r.year, 'tax') },
            usdFull(val(r.totals.tax, r)), pct(r.totals.tax, taxIncome), ' ', isExpanded(r.year, 'tax') ? '▾' : '▸'))
        : h('td', { class: 'r' }, usdFull(val(r.totals.tax, r)), pct(r.totals.tax, taxIncome));

    const clickableContribution = contributionBreakdownFor && r.totals.contribution > 0.5;
    const contributionCell = !r.totals.contribution ? h('td', { class: 'r' }, '—')
      : clickableContribution
        ? h('td', { class: 'r' }, h('button', { class: 'link tax-link', onclick: () => onToggleExpand(r.year, 'contribution') },
            usdFull(val(r.totals.contribution, r)), pct(r.totals.netContributionCost ?? r.totals.contribution, displayIncome), ' ', isExpanded(r.year, 'contribution') ? '▾' : '▸'))
        : h('td', { class: 'r' }, usdFull(val(r.totals.contribution, r)), pct(r.totals.netContributionCost ?? r.totals.contribution, displayIncome));

    const clickableWithdrawal = withdrawalBreakdownFor && r.totals.withdrawal > 0.5;
    const withdrawalCell = !r.totals.withdrawal ? h('td', { class: 'r' }, '—')
      : clickableWithdrawal
        ? h('td', { class: 'r' }, h('button', { class: 'link tax-link', onclick: () => onToggleExpand(r.year, 'withdrawal') },
            usdFull(val(r.totals.withdrawal, r)), ' ', isExpanded(r.year, 'withdrawal') ? '▾' : '▸'))
        : h('td', { class: 'r' }, usdFull(val(r.totals.withdrawal, r)));

    // The Balance equation is pure arithmetic already on the row -- no external data needed, so
    // it's clickable whenever there's actually something to explain (skips the inert baseline row).
    const hasBalanceDetail = !!(r.totals.growth || r.totals.contribution || r.totals.employerMatch
      || r.totals.withdrawal || r.totals.conversion || r.totals.reinvestment);
    const balanceCell = hasBalanceDetail
      ? h('td', { class: 'r' }, h('button', { class: 'link tax-link', onclick: () => onToggleExpand(r.year, 'balance') },
          usdFull(val(r.totals.endBalance, r)), ' ', isExpanded(r.year, 'balance') ? '▾' : '▸'))
      : h('td', { class: 'r' }, usdFull(val(r.totals.endBalance, r)));

    // %-of-income annotations reflect NET take-home cost, not the gross dollars landing in the
    // account, whenever the two differ (a Traditional/HSA account's tax deduction + any FICA
    // exemption means less actually left your paycheck than what shows up in the account) —
    // otherwise a 15%-of-income waterfall budget visibly reads as "16.7%" once an HSA's tax/FICA
    // savings are counted as if they'd cost you take-home pay, which they didn't. `netCost` is
    // `undefined` for Roth/taxable/cash (no gross-up there -- contribution already IS the net
    // cost), so those fall back to the raw contribution figure, identical either way.
    const netBasis = (account, fallback) => (account?.netCost != null ? account.netCost : fallback);

    const perAccountCells = perAccountIds.map((id) => {
      const a = r.accounts[id];
      const contribution = a?.contribution || 0;
      const match = a?.employerMatch || 0;
      if (contribution <= 1e-9 && match <= 1e-9) return h('td', { class: 'r' }, '—');
      return h('td', { class: 'r' },
        h('div', {}, usdFull(val(contribution, r)), pct(netBasis(a, contribution), displayIncome)),
        match > 1e-9 ? h('div', { class: 'muted small' }, `+${usdFull(val(match, r))} match${pct(match, displayIncome)}`) : null,
      );
    });

    bodyRows.push(h('tr', {},
      h('td', {}, r.year),
      h('td', { class: 'muted small' }, r.phase === 'decumulation' ? 'retired' : 'working'),
      hasAge ? h('td', { class: 'r' }, r.age ?? '—') : null,
      hasTax ? h('td', { class: 'r' }, displayIncome ? usdFull(val(displayIncome, r)) : '—') : null,
      contributionCell,
      hasMatch ? h('td', { class: 'r' }, r.totals.employerMatch ? [usdFull(val(r.totals.employerMatch, r)), pct(r.totals.employerMatch, displayIncome)] : '—') : null,
      ...perAccountCells,
      withdrawalCell,
      taxCell,
      hasTax ? h('td', { class: 'r' }, r.phase === 'decumulation' ? usdFull(val(r.totals.netSpendable, r)) : '—') : null,
      hasConversion ? h('td', { class: 'r' }, r.totals.conversion ? [usdFull(val(r.totals.conversion, r)), pct(r.totals.conversion, displayIncome)] : '—') : null,
      h('td', { class: 'r' }, usdFull(val(r.totals.growth, r))),
      balanceCell,
    ));
    if (clickableContribution && isExpanded(r.year, 'contribution')) {
      bodyRows.push(contributionDetailRow(colCount, contributionBreakdownFor(r), toDisplay));
    }
    if (clickableTax && isExpanded(r.year, 'tax')) {
      bodyRows.push(bracketDetailRow(colCount, bracketBreakdownFor(r)));
    }
    if (clickableWithdrawal && isExpanded(r.year, 'withdrawal')) {
      bodyRows.push(withdrawalDetailRow(colCount, withdrawalBreakdownFor(r), toDisplay));
    }
    if (hasBalanceDetail && isExpanded(r.year, 'balance')) {
      bodyRows.push(balanceDetailRow(colCount, r, toDisplay));
    }
  }

  const table = h('table', { class: 'proj-table' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Year'), h('th', {}, 'Phase'),
      hasAge ? h('th', { class: 'r' }, 'Age') : null,
      hasTax ? h('th', { class: 'r' }, 'Income') : null,
      h('th', { class: 'r' }, 'Total contribution'),
      hasMatch ? h('th', { class: 'r' }, 'Employer match') : null,
      ...perAccountIds.map((id) => h('th', { class: 'r' }, getAccountLabel(id))),
      h('th', { class: 'r' }, 'Withdrawal'),
      hasTax ? h('th', { class: 'r' }, 'Tax') : null,
      hasTax ? h('th', { class: 'r' }, 'Net spendable') : null,
      hasConversion ? h('th', { class: 'r' }, 'Roth conversion') : null,
      h('th', { class: 'r' }, 'Growth'),
      h('th', { class: 'r' }, mode === 'real' ? "Balance (today's $)" : 'Balance (nominal)'))),
    h('tbody', {}, ...bodyRows),
  );
  return h('div', { class: 'table-scroll' }, table);
}

export function createProjectionView(opts = {}) {
  const el = h('div');
  const bracketBreakdownFor = opts.bracketBreakdownFor;
  const contributionBreakdownFor = opts.contributionBreakdownFor;
  const withdrawalBreakdownFor = opts.withdrawalBreakdownFor;
  const getAccountLabel = opts.getAccountLabel || ((id) => id);
  let showTable = false;
  // Keys are `${year}:${column}` (column: 'tax'|'contribution'|'withdrawal'|'balance') -- a Set
  // rather than a single scalar so multiple expansions (even in the same row) can be open at once,
  // unlike the single-Tax-cell `expandedYear` this replaced.
  let expandedCells = new Set();
  let current = null;
  let tableMode = 'nominal'; // 'nominal' | 'real' -- see buildTable's docs

  function render() {
    // A toggle (Show table / expand a Tax cell) fully rebuilds this view's DOM. Clearing and
    // re-appending a large subtree loses the browser's scroll anchoring, so it silently snaps
    // the page to the top — jarring when you're clicking a link deep in a long table. Capture
    // and restore the scroll position around the rebuild so it's a no-op to the user. Two
    // separate scroll positions matter here: the page's own scroll, AND the table's internal
    // scroll (.table-scroll has its own max-height + overflow so long tables don't blow out the
    // page) — the table gets torn down and rebuilt as a brand-new element, so its scrollTop
    // resets to 0 unless captured from the OLD element and reapplied to the NEW one.
    const scrollY = window.scrollY;
    const prevTableScroll = el.querySelector('.table-scroll');
    const tableScrollTop = prevTableScroll ? prevTableScroll.scrollTop : 0;
    clear(el);
    if (!current) { el.append(h('p', { class: 'muted' }, 'Add at least one account to see a projection.')); window.scrollTo(0, scrollY); return; }
    const r = current;
    const startTotal = r.years[0].totals.endBalance;
    const retRow = r.years.find((y) => y.year === r.retirementYear) || r.years[0];
    const endRow = r.years[r.years.length - 1];
    const contributed = r.years.reduce((sn, y) => sn + (y.totals.contribution || 0), 0);
    const employerMatchTotal = r.years.reduce((sn, y) => sn + (y.totals.employerMatch || 0), 0);
    // Tax/effective-rate/conversion aggregates are computed ONCE in project() (see its docs) and
    // reused here rather than re-derived — the scenario-comparison table (scenarios.js) uses the
    // exact same fields, so both are guaranteed consistent by construction, not by convention.
    // decumulationTax/-EffectiveTaxRate stay scoped to "in retirement" (this tile's label); the
    // WHOLE-PLAN lifetime figures (which now also include working-years tax, Phase 6.5) get their
    // own tile below so neither number silently absorbs the other.
    const { decumulationTax, decumulationEffectiveTaxRate, lifetimeTax, lifetimeEffectiveTaxRate, lifetimeRothConversions: lifetimeConversions } = r;
    const growth = retRow.totals.endBalance - startTotal - contributed;
    const yrs = r.retirementYear - r.baseYear;

    const parts = [
      h('div', { class: 'stats' },
        survivalTile(r),
        statTile("At retirement · today's dollars", usd(retRow.real.endBalance), `${r.retirementYear} · in ${yrs} yr${yrs === 1 ? '' : 's'}`, COL.real),
        statTile('Total contributed', usd(contributed), 'over the accumulation years'),
        employerMatchTotal > 0 ? statTile('Employer match', usd(employerMatchTotal), 'free money, on top of what you contributed') : null,
        // Under 'maxSustainable', ending balance is always ~$0 by construction (that's what the
        // solver targets) — showing it as a headline number is misleading, not just uninteresting.
        // The actually meaningful number for this strategy is the spend it solved for.
        r.solvedSpending != null
          ? statTile("Annual spend · today's $", usd(r.solvedSpending), 'maximum sustainable through ' + r.horizonYear, COL.real)
          : statTile("End of plan · today's dollars", usd(endRow.real.endBalance), `${r.horizonYear}`, endRow.real.endBalance > 0 ? COL.real : COL.critical),
        decumulationTax > 0 ? statTile('Lifetime tax in retirement', usd(decumulationTax), 'nominal, federal + state') : null,
        decumulationTax > 0 ? statTile('Lifetime effective tax rate', `${(decumulationEffectiveTaxRate * 100).toFixed(1)}%`, 'total tax ÷ total gross income, in retirement') : null,
        lifetimeTax > decumulationTax ? statTile('Total tax, working + retired', usd(lifetimeTax), `${(lifetimeEffectiveTaxRate * 100).toFixed(1)}% effective, your whole plan`) : null,
        lifetimeConversions > 0 ? statTile('Converted to Roth', usd(lifetimeConversions), 'nominal, working + retired years') : null,
      ),
      buildChart(r),
      h('div', { class: 'table-toggle' },
        h('button', { class: 'ghost', onclick: () => { showTable = !showTable; render(); } }, showTable ? 'Hide table' : 'Show table'),
        showTable
          ? h('button', { class: 'ghost', onclick: () => { tableMode = tableMode === 'nominal' ? 'real' : 'nominal'; render(); } },
              `Table: ${tableMode === 'real' ? "today's $" : 'nominal'} (switch)`)
          : null,
      ),
    ];
    if (showTable) {
      parts.push(buildTable(r, {
        expandedCells,
        bracketBreakdownFor,
        contributionBreakdownFor,
        withdrawalBreakdownFor,
        getAccountLabel,
        mode: tableMode,
        onToggleExpand: (year, column) => {
          const key = `${year}:${column}`;
          if (expandedCells.has(key)) expandedCells.delete(key); else expandedCells.add(key);
          render();
        },
      }));
    }
    el.append(...parts);
    const newTableScroll = el.querySelector('.table-scroll');
    if (newTableScroll) newTableScroll.scrollTop = tableScrollTop;
    window.scrollTo(0, scrollY);
  }

  return {
    el,
    render(result) { current = result; render(); },
    clearView() { current = null; render(); },
  };
}
