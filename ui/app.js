// app.js — Phase 1 app shell: enter accounts into a snapshot, and drive one setting
// (return rate) through the Simple/Expand control so the resolver is visibly working
// end-to-end. Static page, no backend.
//
// Persistence is deliberately client-only so this can be HOSTED (e.g. GitHub Pages) without
// any personal data leaving the browser: state auto-saves to localStorage, and the same data
// can be exported/imported as a JSON file for backup or moving between browsers. Nothing is
// ever uploaded, and real balances must never be committed to the (public) hosting repo.

import { h, clear, download } from './dom.js';
import { createAccountsEditor } from './accounts-editor.js';
import { createSettingControl } from './setting-control.js';

const todayISO = () => new Date().toISOString().slice(0, 10);
const STORAGE_KEY = 'retirement-calc:v1';

const EXAMPLE_ACCOUNTS = [
  { id: 'ex-401k', label: 'Example 401(k)', ownerId: 'me', taxStatus: 'taxDeferred', balance: 100000 },
  { id: 'ex-roth', label: 'Example Roth IRA', ownerId: 'me', taxStatus: 'roth', balance: 50000 },
  { id: 'ex-brokerage', label: 'Example brokerage', ownerId: 'me', taxStatus: 'taxable', balance: 40000, costBasis: 30000 },
  { id: 'ex-hsa', label: 'Example HSA', ownerId: 'me', taxStatus: 'hsa', balance: 15000 },
  { id: 'ex-cash', label: 'Example cash / savings', ownerId: 'me', taxStatus: 'cash', balance: 20000 },
];

export function mount(root) {
  // --- state ---------------------------------------------------------------
  const snapshot = {
    id: `snapshot-${todayISO()}`,
    label: 'My accounts',
    profileId: 'me',
    asOf: todayISO(),
    accounts: [],
  };
  // one demo setting so the resolver is exercised live; more knobs arrive in later phases.
  let returnRate = { default: 0.1 };

  const acctSummary = () => snapshot.accounts.map((a) => ({ id: a.id, label: a.label || a.id }));

  // --- persistence (localStorage only) -------------------------------------
  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ snapshot, returnRate })); } catch { /* private mode / disabled */ }
  }
  function loadPersisted() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.snapshot) applySnapshot(data.snapshot);
      if (data.returnRate && typeof data.returnRate === 'object') returnRate = data.returnRate;
    } catch { /* ignore corrupt state */ }
  }
  function clearSaved() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    snapshot.accounts.length = 0;
    returnRate = { default: 0.1 };
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

  // --- helpers -------------------------------------------------------------
  const section = (title, ...children) => h('section', { class: 'card' }, h('h2', {}, title), ...children);

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

  // --- view ----------------------------------------------------------------
  const body = h('div');

  function rebuild() {
    // Build the control first so the editor's onChange can push account changes into it.
    const control = createSettingControl({
      setting: returnRate,
      label: 'Assumed rate of return',
      kind: 'percent',
      accounts: acctSummary(),
      onChange: () => persist(),
    });
    const editor = createAccountsEditor({
      accounts: snapshot.accounts,
      ownerId: snapshot.profileId,
      onChange: () => { control.setAccounts(acctSummary()); persist(); },
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
      section('2 · Settings preview (Simple / Expand)',
        h('p', { class: 'muted' }, 'One knob shown for now. Set a single value, or Expand to override it per account, per year, or per account-per-year — the preview shows exactly which override level wins for each cell.'),
        control.el,
      ),
    );
  }

  // --- init ----------------------------------------------------------------
  loadPersisted();

  clear(root);
  root.append(
    h('header', { class: 'app-header' },
      h('h1', {}, 'Retirement Calculator'),
      h('p', { class: 'muted' }, 'Accounts input + the general→granular setting control. Saved only in this browser.')),
    body,
  );
  rebuild();
}
