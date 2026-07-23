// scenarios.js — Phase 7: save named scenarios, then compare 2-4 of them side by side (design
// doc §9). A saved scenario is a frozen, self-contained deep copy of the live editor's whole
// state ({snapshot, assumptions, plan, filing, social}) — not a reference to the live snapshot —
// so editing your accounts/assumptions later never retroactively changes a scenario you already
// saved. Persisted separately from the live editor's own localStorage key so "load a scenario
// back into the editor" and "the editor's current state" stay clearly distinct concepts.
//
// Comparison chart follows the dataviz method: change-over-time -> line chart; categorical
// identity -> fixed hue order (validated categorical slots 1-4: blue/orange/aqua/yellow, adjacent-
// pair CVD/normal-vision checks pass — see the dataviz skill's palette.md). Two slots (yellow,
// aqua) sit below 3:1 contrast on the light surface, which the skill's relief rule requires
// covering with visible labels or a table view — this view ships BOTH a legend and a full
// headline-comparison table, so that's covered independent of color. "Color follows the entity,
// never its rank": each scenario's color is assigned once, at save time, and stays fixed across
// whatever subset of scenarios you're comparing in a given session (see resolveComparisonColors).

import { h, s, clear } from './dom.js';
import { COL, usd, usdFull, niceCeil, xTickYears } from './chart-utils.js';
import { projectFor } from './project-adapter.js';

const STORAGE_KEY = 'retirement-calc:scenarios:v1';
const MAX_COMPARE = 4;
// Categorical slots 1-4 from the dataviz skill's validated default palette (adjacent-pair CVD
// ΔE 9.1, normal-vision ΔE 22.9 — both clear the floors; see this file's header comment).
const SERIES_PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'];

const SEQUENCING_LABEL = { conventional: 'Conventional', proportional: 'Proportional', bracketFill: 'Bracket-fill' };
const STRATEGY_LABEL = { fixedReal: "Fixed spending (today's $)", fixedPercent: '% of balance', maxSustainable: 'Maximum sustainable (solved)' };

function loadScenarios() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
function saveScenarios(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* disabled */ }
}

// Each scenario's color is fixed at save time (colorSlot, cycling through the palette). Reuse
// that slot for a comparison whenever possible; only reassign on an actual collision (two
// selected scenarios sharing a slot because more than 4 scenarios have ever been saved) — this
// keeps a survivor's color stable when the selection changes, per the "never repaint survivors"
// rule, while still guaranteeing every scenario ON SCREEN right now is visually distinct.
function resolveComparisonColors(selected) {
  const used = new Set();
  const colorFor = new Map();
  for (const scn of selected) {
    let slot = Number.isInteger(scn.colorSlot) ? scn.colorSlot % SERIES_PALETTE.length : 0;
    if (used.has(slot)) slot = [...Array(SERIES_PALETTE.length).keys()].find((i) => !used.has(i)) ?? slot;
    used.add(slot);
    colorFor.set(scn.id, SERIES_PALETTE[slot]);
  }
  return colorFor;
}

function metaLine(scn) {
  const parts = [
    `retire ${scn.plan?.retirementYear ?? '—'}`,
    `${((scn.assumptions?.returnRate?.default ?? 0) * 100).toFixed(1)}% return`,
    SEQUENCING_LABEL[scn.plan?.sequencing] ?? scn.plan?.sequencing,
  ];
  return parts.join(' · ');
}

function buildComparisonChart(entries) {
  const allRows = entries.flatMap((e) => e.result.years);
  if (!allRows.length) return null;
  const baseYear = Math.min(...entries.map((e) => e.result.years[0].year));
  const endYear = Math.max(...entries.map((e) => e.result.years[e.result.years.length - 1].year));
  const ymax = niceCeil(Math.max(1, ...allRows.map((r) => r.real.endBalance)));
  const W = 760, H = 340, m = { t: 20, r: 24, b: 40, l: 66 };
  const plotW = W - m.l - m.r, plotH = H - m.t - m.b;
  const xspan = Math.max(1, endYear - baseYear);
  const xScale = (yr) => m.l + ((yr - baseYear) / xspan) * plotW;
  const yScale = (v) => m.t + plotH - (v / ymax) * plotH;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * ymax);
  const grid = yTicks.map((v) =>
    s('line', { x1: m.l, y1: yScale(v), x2: m.l + plotW, y2: yScale(v), stroke: v === 0 ? COL.base : COL.grid, 'stroke-width': 1 }));
  const yLabels = yTicks.map((v) =>
    s('text', { x: m.l - 8, y: yScale(v) + 4, 'text-anchor': 'end', fill: COL.muted, 'font-size': 11, 'font-variant-numeric': 'tabular-nums' }, usd(v)));
  const xLabels = xTickYears(baseYear, endYear).map((yr) =>
    s('text', { x: xScale(yr), y: m.t + plotH + 20, 'text-anchor': 'middle', fill: COL.muted, 'font-size': 11, 'font-variant-numeric': 'tabular-nums' }, yr));

  const lines = entries.map((e) => {
    const pts = e.result.years.map((r) => `${xScale(r.year).toFixed(2)},${yScale(r.real.endBalance).toFixed(2)}`).join(' ');
    return s('polyline', { points: pts, fill: 'none', stroke: e.color, 'stroke-width': 2, 'stroke-linejoin': 'round' });
  });

  const cross = s('line', { x1: 0, y1: m.t, x2: 0, y2: m.t + plotH, stroke: COL.base, 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden' });
  const dots = entries.map((e) => s('circle', { r: 4, fill: e.color, stroke: '#fff', 'stroke-width': 1.5, visibility: 'hidden' }));

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': `Comparing ${entries.length} scenarios, ${baseYear} to ${endYear}, today's dollars` },
    s('title', {}, `Scenario comparison ${baseYear}–${endYear}: today's dollars`),
    ...grid, ...yLabels, ...xLabels, ...lines, cross, ...dots);

  const tip = h('div', { class: 'chart-tip', style: { visibility: 'hidden' } });
  const wrap = h('div', { class: 'chart-wrap' }, svg, tip);
  const overlay = s('rect', { x: m.l, y: m.t, width: plotW, height: plotH, fill: 'transparent', style: 'cursor:crosshair' });
  svg.append(overlay);

  const nearestForEntry = (e, clampedYear) => {
    const rows = e.result.years;
    let best = rows[0];
    for (const r of rows) if (Math.abs(r.year - clampedYear) < Math.abs(best.year - clampedYear)) best = r;
    return best;
  };
  overlay.addEventListener('mousemove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const yr = Math.round(baseYear + ((px - m.l) / plotW) * xspan);
    const clamped = Math.min(endYear, Math.max(baseYear, yr));
    const x = xScale(clamped);
    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
    clear(tip);
    const lines2 = [h('div', { class: 'tip-year' }, `${clamped}`)];
    entries.forEach((e, i) => {
      const row = nearestForEntry(e, clamped);
      const inRange = row.year === clamped;
      dots[i].setAttribute('cx', x);
      dots[i].setAttribute('cy', yScale(row.real.endBalance));
      dots[i].setAttribute('visibility', inRange ? 'visible' : 'hidden');
      lines2.push(h('div', {},
        h('span', { class: 'sw', style: { background: e.color } }),
        `${e.label}: ${inRange ? usdFull(row.real.endBalance) : 'ended'}`));
    });
    tip.append(...lines2);
    const wrapRect = wrap.getBoundingClientRect();
    const relX = (x / W) * wrapRect.width;
    tip.style.left = `${Math.min(relX + 14, wrapRect.width - 170)}px`;
    tip.style.top = '12px';
    tip.style.visibility = 'visible';
  });
  overlay.addEventListener('mouseleave', () => {
    tip.style.visibility = 'hidden';
    cross.setAttribute('visibility', 'hidden');
    for (const d of dots) d.setAttribute('visibility', 'hidden');
  });

  const legend = h('div', { class: 'legend' },
    ...entries.map((e) => h('span', { class: 'leg' }, h('span', { class: 'sw', style: { background: e.color } }), e.label)));
  return h('div', {}, legend, wrap);
}

function buildComparisonTable(entries) {
  const survivalCell = (e) => {
    const depleted = e.result.firstDepletionYear != null;
    return depleted
      ? h('td', {}, h('span', { style: { color: COL.critical } }, `⚠ Runs out ${e.result.firstDepletionYear}`))
      : h('td', {}, h('span', { style: { color: COL.good } }, '✓ Lasts'));
  };
  const anySolved = entries.some((e) => e.result.solvedSpending != null);
  const rowsSpec = [
    ['Portfolio', (e) => survivalCell(e)],
    ...(anySolved ? [['Max sustainable spend · today\'s $', (e) =>
      h('td', { class: 'r' }, e.result.solvedSpending != null ? usdFull(e.result.solvedSpending) : '—')]] : []),
    ["Ending balance · today's $", (e) => h('td', { class: 'r' }, usdFull(e.result.years[e.result.years.length - 1].real.endBalance))],
    ['Lifetime tax (nominal)', (e) => {
      const t = e.result.years.reduce((sn, y) => sn + (y.totals.tax || 0), 0);
      return h('td', { class: 'r' }, t > 0 ? usdFull(t) : '—');
    }],
    ['Lifetime effective tax rate', (e) => {
      const t = e.result.years.reduce((sn, y) => sn + (y.totals.tax || 0), 0);
      const g = e.result.years.reduce((sn, y) => sn + (y.totals.grossIncome || 0), 0);
      return h('td', { class: 'r' }, g > 0 ? `${((t / g) * 100).toFixed(1)}%` : '—');
    }],
    ...(entries.some((e) => e.scn.plan?.rothConversionsEnabled)
      ? [['Converted to Roth (lifetime)', (e) => {
          const c = e.result.years.reduce((sn, y) => sn + (y.totals.conversion || 0), 0);
          return h('td', { class: 'r' }, c > 0 ? usdFull(c) : '—');
        }]]
      : []),
    ['Retirement year', (e) => h('td', { class: 'r' }, e.result.retirementYear)],
    ['Withdrawal strategy', (e) => h('td', {}, STRATEGY_LABEL[e.scn.plan?.strategy] ?? e.scn.plan?.strategy ?? '—')],
    ['Withdrawal order', (e) => h('td', {}, SEQUENCING_LABEL[e.scn.plan?.sequencing] ?? e.scn.plan?.sequencing ?? '—')],
    ['Rate of return', (e) => h('td', { class: 'r' }, `${((e.scn.assumptions?.returnRate?.default ?? 0) * 100).toFixed(1)}%`)],
  ];
  return h('table', { class: 'proj-table compare-table' },
    h('thead', {}, h('tr', {},
      h('th', {}, ''),
      ...entries.map((e) => h('th', {}, h('span', { class: 'sw', style: { background: e.color } }), e.label)))),
    h('tbody', {}, ...rowsSpec.map(([label, cell]) => h('tr', {}, h('td', { class: 'muted' }, label), ...entries.map(cell)))),
  );
}

export function createScenariosView(opts) {
  const el = h('div');
  let scenarios = loadScenarios();
  let selectedIds = []; // ordered by selection
  // Which scenario the live editor was last loaded from (or saved as) — lets "Update" overwrite
  // that SAME scenario in place instead of "Save current as scenario" always minting a new one,
  // which was the only way to persist a change before and left no way to actually update one.
  let loadedScenarioId = null;

  function persist() { saveScenarios(scenarios); }

  function render() {
    clear(el);
    const loadedScenario = loadedScenarioId ? scenarios.find((s2) => s2.id === loadedScenarioId) : null;
    if (!loadedScenario) loadedScenarioId = null;

    const nameInput = h('input', { type: 'text', placeholder: 'Scenario name (e.g. "Retire at 62")', class: 'scenario-name' });
    const saveAsNew = () => {
      const label = nameInput.value.trim();
      if (!label) { nameInput.focus(); return; }
      const state = opts.getCurrentState();
      const cloned = JSON.parse(JSON.stringify(state));
      const scn = {
        id: `scn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        label,
        createdAt: new Date().toISOString(),
        colorSlot: scenarios.length % SERIES_PALETTE.length,
        ...cloned,
      };
      scenarios.push(scn);
      loadedScenarioId = scn.id; // further edits can now "Update" this new scenario in place
      persist();
      render();
    };
    const saveBtn = h('button', { onclick: saveAsNew }, 'Save current as scenario');

    const updateBox = loadedScenario
      ? h('div', { class: 'scenario-update' },
          h('span', { class: 'muted small' }, `Currently editing based on "${loadedScenario.label}".`),
          h('button', { class: 'ghost', onclick: () => {
            const state = opts.getCurrentState();
            const cloned = JSON.parse(JSON.stringify(state));
            Object.assign(loadedScenario, cloned);
            persist();
            render();
          } }, `Update "${loadedScenario.label}" with current changes`),
        )
      : null;

    const rows = scenarios.map((scn) => {
      const checked = selectedIds.includes(scn.id);
      const atCap = selectedIds.length >= MAX_COMPARE && !checked;
      const checkbox = h('input', {
        type: 'checkbox', checked, disabled: atCap,
        onchange: (e) => {
          if (e.target.checked) selectedIds.push(scn.id);
          else selectedIds = selectedIds.filter((id) => id !== scn.id);
          render();
        },
      });
      return h('div', { class: 'scenario-row' },
        checkbox,
        h('div', { class: 'scenario-row-main' },
          h('div', {}, h('strong', {}, scn.label)),
          h('div', { class: 'muted small' }, metaLine(scn)),
        ),
        h('button', { class: 'ghost', onclick: () => { loadedScenarioId = scn.id; opts.onLoad(scn); render(); } }, 'Load'),
        h('button', { class: 'ghost', onclick: () => {
          if (!confirm(`Delete scenario "${scn.label}"?`)) return;
          scenarios = scenarios.filter((s2) => s2.id !== scn.id);
          selectedIds = selectedIds.filter((id) => id !== scn.id);
          if (loadedScenarioId === scn.id) loadedScenarioId = null;
          persist();
          render();
        } }, 'Delete'),
      );
    });

    const parts = [
      h('p', { class: 'muted' }, 'Save the current accounts + assumptions as a named scenario, then select 2–4 to compare side by side. A saved scenario is frozen — editing your live accounts or assumptions afterward never changes it, unless you Load it back and Update it.'),
      h('div', { class: 'toolbar' }, nameInput, saveBtn),
      updateBox,
      scenarios.length
        ? h('div', { class: 'scenario-list' }, ...rows)
        : h('p', { class: 'muted small' }, 'No scenarios saved yet.'),
    ];

    const selected = selectedIds.map((id) => scenarios.find((s2) => s2.id === id)).filter(Boolean);
    if (selected.length >= 2) {
      const colorFor = resolveComparisonColors(selected);
      const entries = selected
        .map((scn) => ({ scn, id: scn.id, label: scn.label, color: colorFor.get(scn.id), result: projectFor(scn, opts.taxTables) }))
        .filter((e) => e.result);
      if (entries.length >= 2) {
        parts.push(
          h('div', { class: 'scenario-compare' },
            h('h3', {}, 'Comparison'),
            buildComparisonChart(entries),
            h('div', { class: 'table-scroll' }, buildComparisonTable(entries)),
          ),
        );
      }
    } else if (selected.length === 1) {
      parts.push(h('p', { class: 'muted small' }, 'Select at least one more scenario to compare.'));
    }

    el.append(...parts);
  }

  render();
  return { el };
}
