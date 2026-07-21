// app.js — app shell. Enter accounts into a snapshot, set the accumulation assumptions
// (return, contributions, inflation, wage growth) via the Simple/Expand controls, pick a
// retirement year, and see the year-by-year projection (chart + table) in today's dollars.
//
// Persistence is client-only so this can be HOSTED (e.g. GitHub Pages) with no personal data
// leaving the browser: state auto-saves to localStorage; Export/Import is for backups. Nothing
// is uploaded, and real balances must never be committed to the (public) hosting repo.

import { h, clear, download } from './dom.js';
import { createAccountsEditor } from './accounts-editor.js';
import { createSettingControl } from './setting-control.js';
import { createProjectionView } from './projection-view.js';
import { projectAccumulation } from '../engine/project.js';

const todayISO = () => new Date().toISOString().slice(0, 10);
const STORAGE_KEY = 'retirement-calc:v1';

const EXAMPLE_ACCOUNTS = [
  { id: 'ex-401k', label: 'Example 401(k)', ownerId: 'me', taxStatus: 'taxDeferred', balance: 100000 },
  { id: 'ex-roth', label: 'Example Roth IRA', ownerId: 'me', taxStatus: 'roth', balance: 50000 },
  { id: 'ex-brokerage', label: 'Example brokerage', ownerId: 'me', taxStatus: 'taxable', balance: 40000, costBasis: 30000 },
  { id: 'ex-hsa', label: 'Example HSA', ownerId: 'me', taxStatus: 'hsa', balance: 15000 },
  { id: 'ex-cash', label: 'Example cash / savings', ownerId: 'me', taxStatus: 'cash', balance: 20000 },
];

const defaultAssumptions = () => ({
  returnRate: { default: 0.07 },
  contributions: { default: 0 },
  inflation: { default: 0.03 },
  wageGrowth: { default: 0.03 },
});

export function mount(root) {
  // --- state ---------------------------------------------------------------
  const snapshot = {
    id: `snapshot-${todayISO()}`,
    label: 'My accounts',
    profileId: 'me',
    asOf: todayISO(),
    accounts: [],
  };
  let assumptions = defaultAssumptions();
  const baseYear = () => parseInt(String(snapshot.asOf).slice(0, 4), 10) || new Date().getFullYear();
  const retirement = { year: baseYear() + 25 };

  const acctSummary = () => snapshot.accounts.map((a) => ({ id: a.id, label: a.label || a.id }));
  const projectionView = createProjectionView();
  let acctAwareControls = [];

  // --- persistence (localStorage only) -------------------------------------
  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ snapshot, assumptions, retirement })); } catch { /* disabled */ }
  }
  function loadPersisted() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.snapshot) applySnapshot(data.snapshot);
      if (data.assumptions && typeof data.assumptions === 'object') assumptions = { ...defaultAssumptions(), ...data.assumptions };
      if (data.retirement && Number.isFinite(data.retirement.year)) retirement.year = data.retirement.year;
    } catch { /* ignore corrupt state */ }
  }
  function clearSaved() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    snapshot.accounts.length = 0;
    assumptions = defaultAssumptions();
    retirement.year = baseYear() + 25;
    rebuild();
  }

  function applySnapshot(src) {
    Object.assign(snapshot, {
      id: src.id ?? snapshot.id,
      label: src.label ?? snapshot.label,
      profileId: src.profileId ?? snapshot.profileId,
      asOf: src.asOf ?? snapshot.asOf,
    });
    if (Array.isArray(src.accounts)) {
      snapshot.accounts.length = 0;
      snapshot.accounts.push(...src.accounts.map((a) => ({ ...a })));
    }
  }

  // --- projection ----------------------------------------------------------
  function computeProjection() {
    const accounts = snapshot.accounts.map((a) => ({ id: a.id, balance: Number(a.balance) || 0 }));
    if (!accounts.length) return null;
    const startYear = baseYear();
    const endYear = Math.max(startYear, Math.round(retirement.year) || startYear);
    return projectAccumulation({
      startYear, endYear, accounts,
      returnRate: assumptions.returnRate,
      contributions: assumptions.contributions,
      wageGrowth: assumptions.wageGrowth,
      inflation: assumptions.inflation,
    });
  }
  function refreshProjection() {
    const r = computeProjection();
    if (r) projectionView.render(r); else projectionView.clearView();
  }

  // --- helpers -------------------------------------------------------------
  const section = (title, ...children) => h('section', { class: 'card' }, h('h2', {}, title), ...children);
  const onEdit = () => { persist(); refreshProjection(); };

  function replaceAccounts(list) {
    snapshot.accounts.length = 0;
    snapshot.accounts.push(...list.map((a) => ({ ...a })));
    persist();
    rebuild();
  }

  function onLoadFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.accounts)) throw new Error('not a snapshot (no accounts array)');
        applySnapshot(data);
        persist();
        rebuild();
      } catch (err) {
        alert(`Could not load snapshot: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }

  function fileButton() {
    const input = h('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' }, onchange: onLoadFile });
    return h('span', {}, h('button', { class: 'ghost', onclick: () => input.click() }, 'Import JSON'), input);
  }

  function settingRow(key, label, kind, perAccount) {
    const control = createSettingControl({
      setting: assumptions[key],
      label,
      kind,
      accounts: perAccount ? acctSummary() : [],
      baseYear: baseYear() + 1,
      onChange: onEdit,
    });
    if (perAccount) acctAwareControls.push(control);
    return control.el;
  }

  function retirementRow() {
    const hint = h('span', { class: 'muted small' });
    const setHint = () => { hint.textContent = `in ${Math.max(0, Math.round(retirement.year) - baseYear())} yr(s)`; };
    setHint();
    const input = h('input', {
      type: 'number', step: '1', value: retirement.year, class: 'num yr',
      onchange: (e) => {
        const v = parseInt(e.target.value, 10);
        retirement.year = Number.isFinite(v) ? Math.max(baseYear(), v) : baseYear();
        e.target.value = retirement.year;
        setHint(); onEdit();
      },
    });
    return h('div', { class: 'setting' },
      h('div', { class: 'setting-head' },
        h('label', { class: 'setting-label' }, 'Retirement year'),
        h('span', { class: 'field' }, input),
        hint,
      ));
  }

  // --- view ----------------------------------------------------------------
  const body = h('div');

  function rebuild() {
    acctAwareControls = [];
    const editor = createAccountsEditor({
      accounts: snapshot.accounts,
      ownerId: snapshot.profileId,
      onChange: () => { acctAwareControls.forEach((c) => c.setAccounts(acctSummary())); persist(); refreshProjection(); },
    });

    clear(body);
    body.append(
      section('1 · Your accounts',
        h('p', { class: 'muted' }, 'Enter each account and its tax status. This stays in your browser — nothing is uploaded. Use Export to keep a backup file.'),
        editor.el,
        h('div', { class: 'toolbar' },
          h('button', { onclick: () => download(`${snapshot.id}.snapshot.json`, JSON.stringify(snapshot, null, 2)) }, 'Export JSON'),
          fileButton(),
          h('button', { class: 'ghost', onclick: () => replaceAccounts(EXAMPLE_ACCOUNTS) }, 'Load example accounts'),
          h('button', { class: 'ghost', onclick: () => { if (confirm('Clear all saved data in this browser?')) clearSaved(); } }, 'Clear'),
        ),
      ),
      section('2 · Assumptions',
        h('p', { class: 'muted' }, 'Set one value, or Expand any knob to override it per account and/or per year. Contributions are the base-year annual amount, escalated by wage growth.'),
        retirementRow(),
        settingRow('returnRate', 'Rate of return', 'percent', true),
        settingRow('contributions', 'Annual contribution', 'money', true),
        settingRow('inflation', 'Inflation', 'percent', false),
        settingRow('wageGrowth', 'Wage growth', 'percent', false),
      ),
      section("3 · Projection to retirement (today's dollars)",
        projectionView.el,
      ),
    );
    refreshProjection();
  }

  // --- init ----------------------------------------------------------------
  loadPersisted();

  clear(root);
  root.append(
    h('header', { class: 'app-header' },
      h('h1', {}, 'Retirement Calculator'),
      h('p', { class: 'muted' }, 'Project your accounts forward to retirement, in today’s dollars. Saved only in this browser.')),
    body,
  );
  rebuild();
}
