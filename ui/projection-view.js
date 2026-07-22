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

const COL = {
  real: '#2a78d6',      // categorical slot 1 — today's dollars (headline)
  nominal: '#eb6834',   // categorical slot 2 — nominal
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  base: '#c3c2b7',
  good: '#0ca30c',      // fixed status palette — never themed
  critical: '#d03b3b',
};

const usd = (v) => {
  const n = Math.round(v);
  const a = Math.abs(n);
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
  if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
  return '$' + n.toLocaleString();
};
const usdFull = (v) => '$' + Math.round(v).toLocaleString();

function niceCeil(v) {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  const f = v / base;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * base;
}

function xTickYears(baseYear, endYear) {
  const span = endYear - baseYear;
  if (span <= 0) return [baseYear];
  const step = span <= 12 ? 2 : span <= 30 ? 5 : 10;
  const out = [];
  for (let y = baseYear; y <= endYear; y += step) out.push(y);
  if (out[out.length - 1] !== endYear) out.push(endYear);
  return out;
}

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
    if (r.phase === 'accumulation' && r.totals.contribution) lines.push(h('div', { class: 'tip-sub' }, `+ ${usdFull(r.totals.contribution)} contributed`));
    if (r.phase === 'decumulation') {
      lines.push(h('div', { class: 'tip-sub' }, `− ${usdFull(r.totals.withdrawal)} withdrawn`));
      if (r.totals.tax) lines.push(h('div', { class: 'tip-sub' }, `− ${usdFull(r.totals.tax)} tax → ${usdFull(r.totals.netSpendable)} net`));
      if (r.totals.reinvestment) lines.push(h('div', { class: 'tip-sub' }, `+ ${usdFull(r.totals.reinvestment)} RMD surplus reinvested`));
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
  const section = (title, rows) => (!rows || !rows.length) ? null : h('div', { class: 'bracket-section' },
    h('h5', {}, title),
    h('table', { class: 'bracket-mini' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Rate'), h('th', { class: 'r' }, 'Amount at this rate'), h('th', { class: 'r' }, 'Tax'))),
      h('tbody', {}, ...rows.map((row) => h('tr', {},
        h('td', {}, `${(row.rate * 100).toFixed(0)}%`),
        h('td', { class: 'r' }, usdFull(row.amount)),
        h('td', { class: 'r' }, usdFull(row.tax)),
      ))),
    ),
  );
  const ordinary = section('Ordinary income brackets', breakdown?.ordinary);
  const ltcg = section('Capital gains brackets', breakdown?.ltcg);
  return h('tr', { class: 'bracket-detail' }, h('td', { colspan },
    (ordinary || ltcg)
      ? h('div', { class: 'bracket-detail-wrap' }, ordinary, ltcg)
      : h('p', { class: 'muted small' }, 'No taxable income this year.'),
  ));
}

function buildTable(result, opts = {}) {
  const rows = result.years;
  const hasTax = rows.some((r) => r.totals.tax);
  const hasAge = rows.some((r) => r.age != null);
  const { expandedYear, onToggleExpand, bracketBreakdownFor } = opts;
  const colCount = 6 + (hasAge ? 1 : 0) + (hasTax ? 2 : 0);

  const bodyRows = [];
  for (const r of rows) {
    const clickableTax = hasTax && bracketBreakdownFor && r.phase === 'decumulation' && r.totals.tax > 0.005;
    const taxCell = !hasTax ? null
      : !r.totals.tax ? h('td', { class: 'r' }, '—')
      : clickableTax
        ? h('td', { class: 'r' }, h('button', { class: 'link tax-link', onclick: () => onToggleExpand(r.year) },
            usdFull(r.totals.tax), ' ', expandedYear === r.year ? '▾' : '▸'))
        : h('td', { class: 'r' }, usdFull(r.totals.tax));

    bodyRows.push(h('tr', {},
      h('td', {}, r.year),
      h('td', { class: 'muted small' }, r.phase === 'decumulation' ? 'retired' : 'working'),
      hasAge ? h('td', { class: 'r' }, r.age ?? '—') : null,
      h('td', { class: 'r' }, r.totals.contribution ? usdFull(r.totals.contribution) : '—'),
      h('td', { class: 'r' }, r.totals.withdrawal ? usdFull(r.totals.withdrawal) : '—'),
      taxCell,
      hasTax ? h('td', { class: 'r' }, r.phase === 'decumulation' ? usdFull(r.totals.netSpendable) : '—') : null,
      h('td', { class: 'r' }, usdFull(r.totals.growth)),
      h('td', { class: 'r' }, usdFull(r.totals.endBalance)),
      h('td', { class: 'r' }, usdFull(r.real.endBalance)),
    ));
    if (clickableTax && expandedYear === r.year) {
      bodyRows.push(bracketDetailRow(colCount, bracketBreakdownFor(r)));
    }
  }

  const table = h('table', { class: 'proj-table' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Year'), h('th', {}, 'Phase'),
      hasAge ? h('th', { class: 'r' }, 'Age') : null,
      h('th', { class: 'r' }, 'Contribution'),
      h('th', { class: 'r' }, 'Withdrawal'),
      hasTax ? h('th', { class: 'r' }, 'Tax') : null,
      hasTax ? h('th', { class: 'r' }, 'Net spendable') : null,
      h('th', { class: 'r' }, 'Growth'),
      h('th', { class: 'r' }, 'Balance (nominal)'), h('th', { class: 'r' }, "Balance (today's)"))),
    h('tbody', {}, ...bodyRows),
  );
  return h('div', { class: 'table-scroll' }, table);
}

export function createProjectionView(opts = {}) {
  const el = h('div');
  const bracketBreakdownFor = opts.bracketBreakdownFor;
  let showTable = false;
  let expandedYear = null;
  let current = null;

  function render() {
    // A toggle (Show table / expand a Tax cell) fully rebuilds this view's DOM. Clearing and
    // re-appending a large subtree loses the browser's scroll anchoring, so it silently snaps
    // the page to the top — jarring when you're clicking a link deep in a long table. Capture
    // and restore the scroll position around the rebuild so it's a no-op to the user.
    const scrollY = window.scrollY;
    clear(el);
    if (!current) { el.append(h('p', { class: 'muted' }, 'Add at least one account to see a projection.')); window.scrollTo(0, scrollY); return; }
    const r = current;
    const startTotal = r.years[0].totals.endBalance;
    const retRow = r.years.find((y) => y.year === r.retirementYear) || r.years[0];
    const endRow = r.years[r.years.length - 1];
    const contributed = r.years.reduce((sn, y) => sn + (y.totals.contribution || 0), 0);
    const lifetimeTax = r.years.reduce((sn, y) => sn + (y.totals.tax || 0), 0);
    const growth = retRow.totals.endBalance - startTotal - contributed;
    const yrs = r.retirementYear - r.baseYear;

    const parts = [
      h('div', { class: 'stats' },
        survivalTile(r),
        statTile("At retirement · today's dollars", usd(retRow.real.endBalance), `${r.retirementYear} · in ${yrs} yr${yrs === 1 ? '' : 's'}`, COL.real),
        statTile('Total contributed', usd(contributed), 'over the accumulation years'),
        statTile("End of plan · today's dollars", usd(endRow.real.endBalance), `${r.horizonYear}`, endRow.real.endBalance > 0 ? COL.real : COL.critical),
        lifetimeTax > 0 ? statTile('Lifetime tax in retirement', usd(lifetimeTax), 'nominal, federal + state') : null,
      ),
      buildChart(r),
      h('div', { class: 'table-toggle' },
        h('button', { class: 'ghost', onclick: () => { showTable = !showTable; render(); } }, showTable ? 'Hide table' : 'Show table'),
      ),
    ];
    if (showTable) {
      parts.push(buildTable(r, {
        expandedYear,
        bracketBreakdownFor,
        onToggleExpand: (year) => { expandedYear = expandedYear === year ? null : year; render(); },
      }));
    }
    el.append(...parts);
    window.scrollTo(0, scrollY);
  }

  return {
    el,
    render(result) { current = result; render(); },
    clearView() { current = null; render(); },
  };
}
