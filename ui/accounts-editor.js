// accounts-editor.js — enter/edit the accounts of a snapshot (plan.md §3.2/§3.3).
// v1 is single-person, so ownerId is fixed. Cost basis is only meaningful (and shown as
// editable) for taxable accounts; it's ignored/blank for the others.

import { h, clear } from './dom.js';

const TAX_STATUS = [
  ['taxDeferred', 'Tax-deferred (Trad 401k/IRA)'],
  ['roth', 'Roth (401k/IRA)'],
  ['taxable', 'Taxable / brokerage'],
  ['hsa', 'HSA'],
  ['cash', 'Cash / savings'],
];

// Which account plays which role in the contribution waterfall (engine/project.js's
// computeContributionWaterfall) -- independent of taxStatus, so a Roth 401(k) can use the big
// 401(k) elective-deferral limit + match instead of the small Roth IRA limit tier 3 assumes by
// default, and employer match can land in a different account than the employee's own election
// (the common case: Roth 401(k) contribution, Traditional match).
const WATERFALL_ROLE = {
  taxDeferred: [
    ['', 'Auto (default)'],
    ['employerPlan', 'Employer plan (my contributions)'],
    ['employerMatch', 'Employer match lands here'],
  ],
  roth: [
    ['', 'Auto (default)'],
    ['employerPlan', 'Employer plan — Roth 401(k) (my contributions)'],
    ['rothIra', 'Roth IRA (small limit)'],
    ['employerMatch', 'Employer match lands here'],
  ],
};

let idSeq = 1;
const newId = () => `acct-${idSeq++}`;

/**
 * @param {object} opts
 * @param {Array} opts.accounts   the live accounts array (mutated in place)
 * @param {string} [opts.ownerId]
 * @param {(accounts:Array)=>void} [opts.onChange]
 */
export function createAccountsEditor(opts) {
  const accounts = opts.accounts;
  const ownerId = opts.ownerId || 'me';
  const onChange = opts.onChange || (() => {});
  const el = h('div', { class: 'accounts' });

  function emit() { onChange(accounts); render(); }

  function addAccount() {
    accounts.push({ id: newId(), label: '', ownerId, taxStatus: 'taxDeferred', balance: 0 });
    emit();
  }

  function row(acct, i) {
    const isTaxable = acct.taxStatus === 'taxable';
    const isHsa = acct.taxStatus === 'hsa';
    const roleOptions = WATERFALL_ROLE[acct.taxStatus];
    return h('tr', {},
      h('td', {}, h('input', { type: 'text', value: acct.label, placeholder: 'e.g. Fidelity 401(k)', class: 'label', onchange: (e) => { acct.label = e.target.value; onChange(accounts); } })),
      h('td', {}, h('select', { onchange: (e) => { acct.taxStatus = e.target.value; if (acct.taxStatus !== 'taxable') delete acct.costBasis; if (acct.taxStatus !== 'hsa') { delete acct.hsaMaxOut; delete acct.hsaViaPayroll; } if (!WATERFALL_ROLE[acct.taxStatus]) delete acct.waterfallRole; emit(); } },
        ...TAX_STATUS.map(([v, lbl]) => h('option', { value: v, selected: acct.taxStatus === v }, lbl)))),
      h('td', { class: 'r' }, h('span', { class: 'field' }, h('span', { class: 'affix' }, '$'),
        h('input', { type: 'number', step: 'any', value: acct.balance ?? 0, class: 'num', onchange: (e) => { acct.balance = Number(e.target.value); onChange(accounts); } }))),
      h('td', { class: 'r' }, isTaxable
        ? h('span', { class: 'field' }, h('span', { class: 'affix' }, '$'),
            h('input', { type: 'number', step: 'any', value: acct.costBasis ?? '', placeholder: 'basis', class: 'num', onchange: (e) => { const v = e.target.value; if (v === '') delete acct.costBasis; else acct.costBasis = Number(v); onChange(accounts); } }))
        : h('span', { class: 'muted small' }, 'n/a')),
      h('td', { class: 'r' }, isHsa
        ? h('div', { class: 'hsa-opts' },
            h('label', { class: 'checkbox-label small' },
              h('input', { type: 'checkbox', checked: !!acct.hsaMaxOut, onchange: (e) => { acct.hsaMaxOut = e.target.checked; onChange(accounts); } }),
              ' Max out'),
            h('label', { class: 'checkbox-label small' },
              h('input', { type: 'checkbox', checked: acct.hsaViaPayroll !== false, onchange: (e) => { acct.hsaViaPayroll = e.target.checked; onChange(accounts); } }),
              ' Via payroll'))
        : h('span', { class: 'muted small' }, 'n/a')),
      h('td', { class: 'r' }, roleOptions
        ? h('select', { onchange: (e) => { if (e.target.value) acct.waterfallRole = e.target.value; else delete acct.waterfallRole; onChange(accounts); } },
            ...roleOptions.map(([v, lbl]) => h('option', { value: v, selected: (acct.waterfallRole || '') === v }, lbl)))
        : h('span', { class: 'muted small' }, 'n/a')),
      h('td', { class: 'r' }, h('button', { class: 'link', onclick: () => { accounts.splice(i, 1); emit(); } }, '✕')),
    );
  }

  function render() {
    clear(el);
    const table = h('table', { class: 'accounts-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Account'), h('th', {}, 'Tax status'), h('th', { class: 'r' }, 'Balance'),
        h('th', { class: 'r' }, 'Cost basis'), h('th', { class: 'r' }, 'HSA options'),
        h('th', { class: 'r' }, 'Waterfall role'), h('th', {}, ''))),
      h('tbody', {}, ...accounts.map(row)),
    );
    const total = accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);
    el.append(
      table,
      h('div', { class: 'accounts-foot' },
        h('button', { onclick: addAccount }, '+ Add account'),
        h('span', { class: 'total' }, `Total: $${total.toLocaleString()}`),
      ),
    );
  }

  render();
  return { el, addAccount, getAccounts: () => accounts };
}
