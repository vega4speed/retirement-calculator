// projection-view.js — renders a projectAccumulation() result (design doc §4.1/§7):
// summary stat tiles, a two-series line chart (today's-dollars vs nominal), and a table view.
//
// Chart design follows the dataviz method: change-over-time → line chart; two series → legend
// present + direct end-labels; blue = today's-dollars (the headline), orange = nominal. Palette
// validated (CVD ΔE 24.7 light / 26.8 dark). Light-mode tokens to match the app; a hover
// crosshair+tooltip and a table view provide the interaction/accessibility layers.

import { h, s, clear } from './dom.js';

const COL = {
  real: '#2a78d6',     // categorical slot 1 — today's dollars (headline)
  nominal: '#eb6834',  // categorical slot 2 — nominal
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  base: '#c3c2b7',
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

function buildChart(result) {
  const rows = result.years;
  const baseYear = result.baseYear;
  const endYear = result.endYear;
  const W = 760, H = 360, m = { t: 20, r: 132, b: 40, l: 66 };
  const plotW = W - m.l - m.r, plotH = H - m.t - m.b;

  const ymax = niceCeil(Math.max(1, ...rows.map((r) => r.totals.endBalance)));
  const xspan = Math.max(1, endYear - baseYear);
  const xScale = (yr) => m.l + ((yr - baseYear) / xspan) * plotW;
  const yScale = (v) => m.t + plotH - (v / ymax) * plotH;

  const pts = (sel) => rows.map((r) => `${xScale(r.year).toFixed(2)},${yScale(sel(r)).toFixed(2)}`).join(' ');
  const nominalPts = pts((r) => r.totals.endBalance);
  const realPts = pts((r) => r.real.endBalance);

  // y gridlines + labels (5 ticks: 0..ymax)
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * ymax);
  const grid = yTicks.map((v) =>
    s('line', { x1: m.l, y1: yScale(v), x2: m.l + plotW, y2: yScale(v), stroke: v === 0 ? COL.base : COL.grid, 'stroke-width': 1 }));
  const yLabels = yTicks.map((v) =>
    s('text', { x: m.l - 8, y: yScale(v) + 4, 'text-anchor': 'end', fill: COL.muted, 'font-size': 11, 'font-variant-numeric': 'tabular-nums' }, usd(v)));
  const xLabels = xTickYears(baseYear, endYear).map((yr) =>
    s('text', { x: xScale(yr), y: m.t + plotH + 20, 'text-anchor': 'middle', fill: COL.muted, 'font-size': 11, 'font-variant-numeric': 'tabular-nums' }, yr));

  // direct end-labels, nudged apart if they collide
  const endRow = rows[rows.length - 1];
  let yNom = yScale(endRow.totals.endBalance);
  let yReal = yScale(endRow.real.endBalance);
  if (yReal - yNom < 14) yReal = yNom + 14;
  const endLabel = (yy, color, tag, val) =>
    s('g', {},
      s('circle', { cx: xScale(endYear), cy: yScale(val), r: 3.5, fill: color }),
      s('text', { x: xScale(endYear) + 10, y: yy + 4, fill: COL.ink2, 'font-size': 12 },
        s('tspan', { fill: color, 'font-weight': 700 }, '● '), `${tag} ${usd(val)}`));

  // hover layer
  const cross = s('line', { x1: 0, y1: m.t, x2: 0, y2: m.t + plotH, stroke: COL.base, 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden' });
  const dotN = s('circle', { r: 4, fill: COL.nominal, stroke: '#fff', 'stroke-width': 1.5, visibility: 'hidden' });
  const dotR = s('circle', { r: 4, fill: COL.real, stroke: '#fff', 'stroke-width': 1.5, visibility: 'hidden' });

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': `Projected balance from ${baseYear} to ${endYear}` },
    s('title', {}, `Projected balance ${baseYear}–${endYear}: today's dollars and nominal`),
    ...grid, ...yLabels, ...xLabels,
    s('polyline', { points: nominalPts, fill: 'none', stroke: COL.nominal, 'stroke-width': 2, 'stroke-linejoin': 'round' }),
    s('polyline', { points: realPts, fill: 'none', stroke: COL.real, 'stroke-width': 2, 'stroke-linejoin': 'round' }),
    endLabel(yNom, COL.nominal, 'Nominal', endRow.totals.endBalance),
    endLabel(yReal, COL.real, "Today's", endRow.real.endBalance),
    cross, dotN, dotR);

  // tooltip + mouse handling
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
    for (const el of [cross]) { el.setAttribute('x1', x); el.setAttribute('x2', x); el.setAttribute('visibility', 'visible'); }
    dotN.setAttribute('cx', x); dotN.setAttribute('cy', yScale(r.totals.endBalance)); dotN.setAttribute('visibility', 'visible');
    dotR.setAttribute('cx', x); dotR.setAttribute('cy', yScale(r.real.endBalance)); dotR.setAttribute('visibility', 'visible');
    clear(tip);
    tip.append(
      h('div', { class: 'tip-year' }, `${r.year}${r.t ? ` · +${r.t} yr` : ''}`),
      h('div', {}, h('span', { class: 'sw', style: { background: COL.real } }), `Today's: ${usdFull(r.real.endBalance)}`),
      h('div', {}, h('span', { class: 'sw', style: { background: COL.nominal } }), `Nominal: ${usdFull(r.totals.endBalance)}`),
    );
    const rect = wrap.getBoundingClientRect();
    const relX = ((x) / W) * rect.width;
    tip.style.left = `${Math.min(relX + 14, rect.width - 150)}px`;
    tip.style.top = `12px`;
    tip.style.visibility = 'visible';
  });
  overlay.addEventListener('mouseleave', () => {
    tip.style.visibility = 'hidden';
    for (const el of [cross, dotN, dotR]) el.setAttribute('visibility', 'hidden');
  });

  // legend (identity not carried by color alone)
  const legend = h('div', { class: 'legend' },
    h('span', { class: 'leg' }, h('span', { class: 'sw', style: { background: COL.real } }), "Today's dollars"),
    h('span', { class: 'leg' }, h('span', { class: 'sw', style: { background: COL.nominal } }), 'Nominal'),
  );
  return h('div', {}, legend, wrap);
}

function buildTable(result) {
  const rows = result.years;
  const table = h('table', { class: 'proj-table' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Year'), h('th', { class: 'r' }, '+Yr'), h('th', { class: 'r' }, 'Contribution'),
      h('th', { class: 'r' }, 'Growth'), h('th', { class: 'r' }, 'Balance (nominal)'), h('th', { class: 'r' }, "Balance (today's)"))),
    h('tbody', {}, ...rows.map((r) => h('tr', {},
      h('td', {}, r.year), h('td', { class: 'r' }, r.t),
      h('td', { class: 'r' }, usdFull(r.totals.contribution)),
      h('td', { class: 'r' }, usdFull(r.totals.growth)),
      h('td', { class: 'r' }, usdFull(r.totals.endBalance)),
      h('td', { class: 'r' }, usdFull(r.real.endBalance)),
    ))),
  );
  return h('div', { class: 'table-scroll' }, table);
}

export function createProjectionView() {
  const el = h('div');
  let showTable = false;
  let current = null;

  function render() {
    clear(el);
    if (!current) { el.append(h('p', { class: 'muted' }, 'Add at least one account to see a projection.')); return; }
    const r = current;
    const startTotal = r.years[0].totals.endBalance;
    const endRow = r.years[r.years.length - 1];
    const contributed = r.years.reduce((sn, y) => sn + y.totals.contribution, 0);
    const growth = endRow.totals.endBalance - startTotal - contributed;
    const yrs = r.endYear - r.baseYear;

    const parts = [
      h('div', { class: 'stats' },
        statTile("At retirement · today's dollars", usd(endRow.real.endBalance), `${r.endYear} · in ${yrs} yr${yrs === 1 ? '' : 's'}`, COL.real),
        statTile('At retirement · nominal', usd(endRow.totals.endBalance), `${r.endYear}`, COL.nominal),
        statTile('Total contributed', usd(contributed), 'over the period'),
        statTile('Investment growth', usd(growth), 'nominal, cumulative'),
      ),
      buildChart(r),
      h('div', { class: 'table-toggle' },
        h('button', { class: 'ghost', onclick: () => { showTable = !showTable; render(); } }, showTable ? 'Hide table' : 'Show table'),
      ),
    ];
    if (showTable) parts.push(buildTable(r));
    el.append(...parts);
  }

  return {
    el,
    render(result) { current = result; render(); },
    clearView() { current = null; render(); },
  };
}
