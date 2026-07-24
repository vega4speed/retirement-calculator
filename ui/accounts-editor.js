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
    return h('tr', {},
      h('td', {}, h('input', { type: 'text', value: acct.label, placeholder: 'e.g. Fidelity 401(k)', class: 'label', onchange: (e) => { acct.label = e.target.value; onChange(accounts); } })),
      h('td', {}, h('select', { onchange: (e) => { acct.taxStatus = e.target.value; if (acct.taxStatus !== 'taxable') delete acct.costBasis; if (acct.taxStatus !== 'hsa') { delete acct.hsaMaxOut; delete acct.hsaViaPayroll; } emit(); } },
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
      h('td', { class: 'r' }, h('button', { class: 'link', onclick: () => { accounts.splice(i, 1); emit(); } }, '✕')),
    );
  }

  function render() {
    clear(el);
    const table = h('table', { class: 'accounts-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Account'), h('th', {}, 'Tax status'), h('th', { class: 'r' }, 'Balance'),
        h('th', { class: 'r' }, 'Cost basis'), h('th', { class: 'r' }, 'HSA options'), h('th', {}, ''))),
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
