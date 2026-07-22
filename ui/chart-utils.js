// chart-utils.js — small formatting/scale helpers shared by every chart in the UI
// (projection-view.js's own chart, and the Phase 7 scenario-comparison chart), plus the fixed
// non-categorical tokens (ink/grid/status colors) that every chart uses regardless of its own
// series palette.

export const COL = {
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  base: '#c3c2b7',
  good: '#0ca30c',      // fixed status palette — never themed
  critical: '#d03b3b',
};

export const usd = (v) => {
  const n = Math.round(v);
  const a = Math.abs(n);
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
  if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
  return '$' + n.toLocaleString();
};
export const usdFull = (v) => '$' + Math.round(v).toLocaleString();

export function niceCeil(v) {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  const f = v / base;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * base;
}

export function xTickYears(baseYear, endYear) {
  const span = endYear - baseYear;
  if (span <= 0) return [baseYear];
  const step = span <= 12 ? 2 : span <= 30 ? 5 : 10;
  const out = [];
  for (let y = baseYear; y <= endYear; y += step) out.push(y);
  if (out[out.length - 1] !== endYear) out.push(endYear);
  return out;
}
