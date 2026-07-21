// setting-control.js — the reusable "Simple / Expand" control (plan.md §2).
//
// One knob. Simple mode shows a single default input. "Expand ▸" reveals the override
// editor (per-account, per-year, or per-account-per-year) plus a live resolved-value
// preview that colours each cell by which override level supplied it. Every edit mutates
// the same `setting` object and fires onChange, so the whole thing round-trips to JSON.

import { h, clear } from './dom.js';
import { getFormat } from './formats.js';
import {
  isSetting,
  makeSetting,
  explainResolve,
  listOverrides,
  setOverride,
  clearOverride,
} from '../engine/resolver.js';

const LEVEL_LABEL = {
  byAccountYear: 'account + year',
  byYear: 'year',
  byAccount: 'account',
  default: 'default',
  unset: 'unset',
  literal: 'literal',
};

/**
 * @param {object} opts
 * @param {object} opts.setting   a setting object (or a bare value — wrapped automatically)
 * @param {string} opts.label
 * @param {'percent'|'money'|'number'} [opts.kind]
 * @param {{id:string,label:string}[]} [opts.accounts]
 * @param {boolean} [opts.perAccount] false for a household-level setting with no by-account
 *   dimension (e.g. retirement spending) — hides the account picker/column entirely. Default true.
 * @param {number} [opts.baseYear]  first column of the preview table
 * @param {(setting:object)=>void} [opts.onChange]
 * @returns {{el:HTMLElement, setAccounts:(a:any[])=>void, getSetting:()=>object}}
 */
export function createSettingControl(opts) {
  const fmt = getFormat(opts.kind);
  const perAccount = opts.perAccount !== false;
  let accounts = perAccount && opts.accounts ? [...opts.accounts] : [];
  const baseYear = opts.baseYear ?? new Date().getFullYear();
  const onChange = opts.onChange || (() => {});
  let setting = isSetting(opts.setting) ? opts.setting : makeSetting(opts.setting ?? 0);
  let expanded = false;

  const el = h('div', { class: 'setting' });

  function emit() {
    onChange(setting);
    render();
  }

  function inputWrap(value, onCommit, placeholder) {
    const input = h('input', {
      type: 'number',
      step: 'any',
      value: value ?? '',
      placeholder: placeholder ?? '',
      class: 'num',
      onchange: (e) => onCommit(fmt.parse(e.target.value)),
    });
    return h('span', { class: 'field' }, fmt.prefix ? h('span', { class: 'affix' }, fmt.prefix) : null, input, fmt.suffix ? h('span', { class: 'affix' }, fmt.suffix) : null);
  }

  function renderOverridesEditor() {
    const rows = listOverrides(setting);
    const acctLabel = (id) => accounts.find((a) => a.id === id)?.label ?? id;
    const describe = (r) =>
      r.level === 'byAccountYear'
        ? `${acctLabel(r.accountId)}, ${r.year}`
        : r.level === 'byYear'
          ? (perAccount ? `all accounts, ${r.year}` : `${r.year}`)
          : `${acctLabel(r.accountId)}, all years`;

    const list = rows.length
      ? h('table', { class: 'ovr' },
          h('tbody', {},
            ...rows.map((r) =>
              h('tr', {},
                h('td', {}, describe(r)),
                h('td', { class: 'r' }, fmt.display(r.value)),
                h('td', { class: 'r' }, h('button', { class: 'link', onclick: () => { clearOverride(setting, { accountId: r.accountId ?? undefined, year: r.year ?? undefined }); emit(); } }, '✕')),
              ),
            ),
          ),
        )
      : h('p', { class: 'muted small' }, 'No overrides yet — everything inherits the default above.');

    // add-override row
    const acctSel = perAccount
      ? h('select', {}, h('option', { value: '' }, 'All accounts'), ...accounts.map((a) => h('option', { value: a.id }, a.label)))
      : null;
    const yearInp = h('input', { type: 'number', step: '1', placeholder: 'Year', class: 'num yr' });
    const valInp = h('input', { type: 'number', step: 'any', placeholder: 'value', class: 'num' });
    const add = h('button', { onclick: () => {
      const value = fmt.parse(valInp.value);
      if (value === undefined || Number.isNaN(value)) return;
      const target = { accountId: acctSel ? (acctSel.value || undefined) : undefined, year: yearInp.value || undefined };
      if (!perAccount && !target.year) return; // household-level: a year is required (no by-account fallback)
      setOverride(setting, target, value);
      yearInp.value = ''; valInp.value = '';
      emit();
    } }, 'Add override');

    return h('div', { class: 'ovr-editor' },
      list,
      h('div', { class: 'add-row' },
        acctSel,
        yearInp,
        h('span', { class: 'field' }, fmt.prefix ? h('span', { class: 'affix' }, fmt.prefix) : null, valInp, fmt.suffix ? h('span', { class: 'affix' }, fmt.suffix) : null),
        add,
      ),
    );
  }

  function renderPreview() {
    if (perAccount && !accounts.length) return h('p', { class: 'muted small' }, 'Add accounts to preview per-account resolution.');
    const years = [...new Set([baseYear, ...listOverrides(setting).map((r) => r.year).filter(Boolean).map(Number)])].sort((a, b) => a - b);
    if (!perAccount) {
      return h('table', { class: 'preview' },
        h('thead', {}, h('tr', {}, h('th', {}, 'year'), h('th', { class: 'r' }, 'value'))),
        h('tbody', {},
          ...years.map((y) => {
            const { value, level } = explainResolve(setting, { year: y });
            return h('tr', {}, h('td', {}, y), h('td', { class: `r lvl-${level}`, title: LEVEL_LABEL[level] }, fmt.display(value)));
          }),
        ),
      );
    }
    return h('table', { class: 'preview' },
      h('thead', {}, h('tr', {}, h('th', {}, 'account'), ...years.map((y) => h('th', { class: 'r' }, y)))),
      h('tbody', {},
        ...accounts.map((a) =>
          h('tr', {},
            h('td', {}, a.label),
            ...years.map((y) => {
              const { value, level } = explainResolve(setting, { accountId: a.id, year: y });
              return h('td', { class: `r lvl-${level}`, title: LEVEL_LABEL[level] }, fmt.display(value));
            }),
          ),
        ),
      ),
    );
  }

  function render() {
    clear(el);
    const header = h('div', { class: 'setting-head' },
      h('label', { class: 'setting-label' }, opts.label),
      inputWrap(fmt.toStr(setting.default), (v) => { setting.default = v; emit(); }),
      h('button', { class: 'link expand', onclick: () => { expanded = !expanded; render(); } }, expanded ? 'Collapse ▾' : 'Expand ▸'),
    );
    el.append(header);
    if (expanded) {
      el.append(
        h('div', { class: 'setting-body' },
          h('div', { class: 'col' }, h('h4', {}, 'Overrides'), renderOverridesEditor()),
          h('div', { class: 'col' }, h('h4', {}, 'Resolved preview'), renderPreview()),
        ),
      );
    }
  }

  render();

  return {
    el,
    setAccounts(next) { if (perAccount) { accounts = next ? [...next] : []; render(); } },
    getSetting() { return setting; },
  };
}
