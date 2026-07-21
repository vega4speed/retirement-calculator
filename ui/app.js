// app.js — app shell. Enter accounts into a snapshot, set accumulation assumptions (return,
// contributions, inflation, wage growth) and decumulation assumptions (spending or a withdrawal
// %, other income, sequencing) via the Simple/Expand controls, pick retirement/horizon years,
// and see the full year-by-year projection (chart + table) in today's dollars, including
// whether the portfolio lasts.
//
// Persistence is client-only so this can be HOSTED (e.g. GitHub Pages) with no personal data
// leaving the browser: state auto-saves to localStorage; Export/Import is for backups. Nothing
// is uploaded, and real balances must never be committed to the (public) hosting repo.

import { h, clear, download } from './dom.js';
import { createAccountsEditor } from './accounts-editor.js';
import { createSettingControl } from './setting-control.js';
import { createProjectionView } from './projection-view.js';
import { project } from '../engine/project.js';

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
  spending: { default: 40000 },
  otherIncome: { default: 0 },
  withdrawalPercent: { default: 0.04 },
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
  const plan = {
    retirementYear: baseYear() + 25,
    horizonYear: baseYear() + 55,
    strategy: 'fixedReal',       // 'fixedReal' | 'fixedPercent'
    sequencing: 'conventional',  // 'conventional' | 'proportional'
  };

  const acctSummary = () => snapshot.accounts.map((a) => ({ id: a.id, label: a.label || a.id }));
  const projectionView = createProjectionView();
  let acctAwareControls = [];

  // --- persistence (localStorage only) -------------------------------------
  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ snapshot, assumptions, plan })); } catch { /* disabled */ }
  }
  function loadPersisted() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.snapshot) applySnapshot(data.snapshot);
      if (data.assumptions && typeof data.assumptions === 'object') assumptions = { ...defaultAssumptions(), ...data.assumptions };
      if (data.plan && typeof data.plan === 'object') Object.assign(plan, data.plan);
      else if (data.retirement && Number.isFinite(data.retirement.year)) plan.retirementYear = data.retirement.year; // migrate v1 shape
    } catch { /* ignore corrupt state */ }
  }
  function clearSaved() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    snapshot.accounts.length = 0;
    assumptions = defaultAssumptions();
    plan.retirementYear = baseYear() + 25;
    plan.horizonYear = baseYear() + 55;
    plan.strategy = 'fixedReal';
    plan.sequencing = 'conventional';
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
    const accounts = snapshot.accounts.map((a) => ({ id: a.id, balance: Number(a.balance) || 0, taxStatus: a.taxStatus }));
    if (!accounts.length) return null;
    const startYear = baseYear();
    const retirementYear = Math.max(startYear, Math.round(plan.retirementYear) || startYear);
    const horizonYear = Math.max(retirementYear, Math.round(plan.horizonYear) || retirementYear);
    return project({
      baseYear: startYear, retirementYear, horizonYear, accounts,
      returnRate: assumptions.returnRate,
      contributions: assumptions.contributions,
      wageGrowth: assumptions.wageGrowth,
      inflation: assumptions.inflation,
      spending: assumptions.spending,
      otherIncome: assumptions.otherIncome,
      withdrawalPercent: assumptions.withdrawalPercent,
      strategy: plan.strategy,
      sequencing: plan.sequencing,
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
      perAccount,
      accounts: perAccount ? acctSummary() : [],
      baseYear: baseYear() + 1,
      onChange: onEdit,
    });
    if (perAccount) acctAwareControls.push(control);
    return control.el;
  }

  function yearRow(label, get, set, min) {
    const hint = h('span', { class: 'muted small' });
    const setHint = () => { hint.textContent = `in ${Math.max(0, get() - baseYear())} yr(s)`; };
    setHint();
    const input = h('input', {
      type: 'number', step: '1', value: get(), class: 'num yr',
      onchange: (e) => {
        const v = parseInt(e.target.value, 10);
        set(Number.isFinite(v) ? Math.max(min(), v) : min());
        e.target.value = get();
        setHint(); onEdit();
      },
    });
    return h('div', { class: 'setting' }, h('div', { class: 'setting-head' }, h('label', { class: 'setting-label' }, label), h('span', { class: 'field' }, input), hint));
  }

  function selectRow(label, value, options, onSet) {
    const select = h('select', {
      onchange: (e) => { onSet(e.target.value); onEdit(); rebuild(); },
    }, ...options.map(([v, lbl]) => h('option', { value: v, selected: v === value }, lbl)));
    return h('div', { class: 'setting' }, h('div', { class: 'setting-head' }, h('label', { class: 'setting-label' }, label), select));
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
      section('2 · Working years',
        h('p', { class: 'muted' }, 'Set one value, or Expand any knob to override it per account and/or per year. Contributions are the base-year annual amount, escalated by wage growth.'),
        yearRow('Retirement year', () => plan.retirementYear, (v) => { plan.retirementYear = v; if (plan.horizonYear < v) plan.horizonYear = v; }, baseYear),
        settingRow('returnRate', 'Rate of return', 'percent', true),
        settingRow('contributions', 'Annual contribution', 'money', true),
        settingRow('inflation', 'Inflation', 'percent', false),
        settingRow('wageGrowth', 'Wage growth', 'percent', false),
      ),
      section('3 · Retirement spending',
        h('p', { class: 'muted' }, "Pre-tax for now (Phase 4 adds real tax math): withdrawals are gross dollar pulls, drawn from your accounts in the order below. \"Does it last\" reflects spending vs. growth only."),
        yearRow('Plan through year', () => plan.horizonYear, (v) => { plan.horizonYear = v; }, () => plan.retirementYear),
        selectRow('Withdrawal strategy', plan.strategy, [
          ['fixedReal', "Fixed spending target (today's $)"],
          ['fixedPercent', '% of current balance each year'],
        ], (v) => { plan.strategy = v; }),
        plan.strategy === 'fixedPercent'
          ? settingRow('withdrawalPercent', 'Withdrawal %', 'percent', false)
          : settingRow('spending', 'Annual spending (today’s $)', 'money', false),
        settingRow('otherIncome', "Other income — pension/rental (today's $)", 'money', false),
        selectRow('Withdrawal order', plan.sequencing, [
          ['conventional', 'Conventional (cash → taxable → tax-deferred → HSA → Roth)'],
          ['proportional', 'Proportional (spread across all accounts)'],
        ], (v) => { plan.sequencing = v; }),
      ),
      section("4 · Projection (today's dollars)",
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
      h('p', { class: 'muted' }, 'Project your accounts through retirement, in today’s dollars. Saved only in this browser.')),
    body,
  );
  rebuild();
}
