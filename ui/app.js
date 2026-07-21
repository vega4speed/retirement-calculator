// app.js — app shell. Enter accounts into a snapshot, set filing/tax basics, accumulation
// assumptions (return, contributions, inflation, wage growth), and decumulation assumptions
// (spending or a withdrawal %, other income, sequencing) via the Simple/Expand controls, pick
// retirement/horizon years, and see the full year-by-year projection (chart + table) in today's
// dollars — including real federal tax (RMDs, capital gains, gross-up) and whether it lasts.
//
// Persistence is client-only so this can be HOSTED (e.g. GitHub Pages) with no personal data
// leaving the browser: state auto-saves to localStorage; Export/Import is for backups. Nothing
// is uploaded, and real balances must never be committed to the (public) hosting repo.

import { h, clear, download } from './dom.js';
import { createAccountsEditor } from './accounts-editor.js';
import { createSettingControl } from './setting-control.js';
import { createProjectionView } from './projection-view.js';
import { project } from '../engine/project.js';
import { resolveYearTable, bracketBreakdown } from '../engine/tax.js';
import { estimatePIA, benefitAtClaimingAge, fullRetirementAge } from '../engine/socialsecurity.js';

const todayISO = () => new Date().toISOString().slice(0, 10);
const STORAGE_KEY = 'retirement-calc:v1';
// Latest verified year in data/tax-tables.json (see that file's `_meta.verificationStatus`).
// Brackets/standard-deduction for any other year are projected from this anchor by the
// bracketIndexingRate/standardDeductionIndexingRate settings (engine/tax.js resolveYearTable).
const TAX_ANCHOR_YEAR = 2026;

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
  stateTaxRate: { default: 0 }, // default TN: no state income tax
  earnings: { default: 70000 }, // wage-indexed-equivalent annual $ — see socialsecurity.js
  colaRate: { default: 0.025 }, // historical Social Security COLA average, roughly
});

const defaultFiling = () => ({
  filingStatus: 'single',
  birthYear: new Date().getFullYear() - 45,
});

const defaultSocial = (birthYear) => ({
  careerStartYear: birthYear + 22, // typical career-entry-age guess; override for accuracy
  claimingAge: 67,
  solvencyHaircutStartYear: 2033, // OASI trust fund's projected depletion year (2025 Trustees Report)
  solvencyHaircutFactor: 1,       // 1 = assume Congress fixes it; ~0.77 = the projected payable share if not
});

export async function mount(root) {
  // Tax tables are fetched at runtime (not bundled) so the plain JSON file stays the single
  // source of truth; if it can't be loaded (e.g. opened via file:// instead of a server), tax
  // computation degrades gracefully to Phase 3's pre-tax mode rather than breaking the app.
  const taxTables = await fetch('./data/tax-tables.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);

  // --- state ---------------------------------------------------------------
  const snapshot = {
    id: `snapshot-${todayISO()}`,
    label: 'My accounts',
    profileId: 'me',
    asOf: todayISO(),
    accounts: [],
  };
  let assumptions = defaultAssumptions();
  let filing = defaultFiling();
  let social = defaultSocial(filing.birthYear);
  const baseYear = () => parseInt(String(snapshot.asOf).slice(0, 4), 10) || new Date().getFullYear();
  const plan = {
    retirementYear: baseYear() + 25,
    horizonYear: baseYear() + 55,
    strategy: 'fixedReal',       // 'fixedReal' | 'fixedPercent'
    sequencing: 'conventional',  // 'conventional' | 'proportional'
  };

  const acctSummary = () => snapshot.accounts.map((a) => ({ id: a.id, label: a.label || a.id }));

  // Recomputes a year's ordinary + capital-gains bracket breakdown on demand (clicking a Tax
  // cell), rather than storing it on every ledger row — cheap to redo, keeps the ledger lean.
  function bracketBreakdownFor(row) {
    if (!taxTables) return null;
    const yearTable = resolveYearTable({
      tables: taxTables, year: row.year, anchorYear: TAX_ANCHOR_YEAR,
      bracketIndexingRate: assumptions.inflation, standardDeductionIndexingRate: assumptions.inflation,
    });
    const ordinary = bracketBreakdown(row.totals.ordinaryTaxableIncome, yearTable.ordinaryBrackets[filing.filingStatus]);
    const ltcg = row.totals.capitalGain > 0
      ? bracketBreakdown(row.totals.capitalGain, yearTable.ltcgBrackets[filing.filingStatus], row.totals.ordinaryTaxableIncome)
      : [];
    return { ordinary, ltcg };
  }

  // Live "here's what that produces" readout for the Social Security section — recomputed from
  // the same engine functions the projection itself uses, so it never drifts from the real result.
  function socialSecurityEstimate() {
    if (!taxTables || !Number.isFinite(filing.birthYear) || !Number.isInteger(social.careerStartYear)) return null;
    const retirementYear = Math.max(baseYear(), Math.round(plan.retirementYear) || baseYear());
    try {
      const pia = estimatePIA({
        earnings: assumptions.earnings, careerStartYear: social.careerStartYear, retirementYear,
        birthYear: filing.birthYear, tables: taxTables, anchorYear: TAX_ANCHOR_YEAR, wageIndexingRate: assumptions.wageGrowth,
      });
      const fra = fullRetirementAge(filing.birthYear);
      const annualBenefit = benefitAtClaimingAge(pia, social.claimingAge, fra, taxTables.socialSecurity);
      const claimingYear = Math.round(filing.birthYear + social.claimingAge);
      return { pia, fra, annualBenefit, claimingYear };
    } catch { return null; }
  }

  const projectionView = createProjectionView({ bracketBreakdownFor });
  let acctAwareControls = [];

  // --- persistence (localStorage only) -------------------------------------
  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ snapshot, assumptions, plan, filing, social })); } catch { /* disabled */ }
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
      if (data.filing && typeof data.filing === 'object') filing = { ...defaultFiling(), ...data.filing };
      if (data.social && typeof data.social === 'object') social = { ...defaultSocial(filing.birthYear), ...data.social };
    } catch { /* ignore corrupt state */ }
  }
  function clearSaved() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    snapshot.accounts.length = 0;
    assumptions = defaultAssumptions();
    filing = defaultFiling();
    social = defaultSocial(filing.birthYear);
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
    const accounts = snapshot.accounts.map((a) => ({
      id: a.id, balance: Number(a.balance) || 0, taxStatus: a.taxStatus,
      costBasis: a.costBasis != null ? Number(a.costBasis) : undefined,
    }));
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
      // birthYear is passed unconditionally — it drives the table's age column even when tax
      // tables didn't load (age display doesn't depend on tax being computed).
      birthYear: Number.isFinite(filing.birthYear) ? filing.birthYear : undefined,
      // The rest of tax is opt-in (engine/project.js): only passed through when tables loaded.
      // Bracket/standard-deduction indexing reuses the `inflation` assumption — a defensible
      // default ("brackets roughly keep pace with prices"); a dedicated knob is a later refinement.
      ...(taxTables ? {
        filingStatus: filing.filingStatus,
        taxTables, anchorYear: TAX_ANCHOR_YEAR,
        bracketIndexingRate: assumptions.inflation, standardDeductionIndexingRate: assumptions.inflation,
        stateTaxRate: assumptions.stateTaxRate,
        // Social Security (Phase 5) is opt-in within tax mode: needs earnings + claiming age.
        earnings: assumptions.earnings, careerStartYear: social.careerStartYear, claimingAge: social.claimingAge,
        colaRate: assumptions.colaRate,
        solvencyHaircutStartYear: social.solvencyHaircutStartYear, solvencyHaircutFactor: social.solvencyHaircutFactor,
      } : {}),
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
    const setHint = () => {
      const inYrs = Math.max(0, get() - baseYear());
      const ageText = Number.isFinite(filing.birthYear) ? ` · age ${get() - filing.birthYear}` : '';
      hint.textContent = `in ${inYrs} yr(s)${ageText}`;
    };
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

  function birthYearRow() {
    const hint = h('span', { class: 'muted small' });
    const setHint = () => { hint.textContent = `age ${baseYear() - filing.birthYear} in ${baseYear()}`; };
    setHint();
    const input = h('input', {
      type: 'number', step: '1', value: filing.birthYear, class: 'num yr',
      onchange: (e) => {
        const v = parseInt(e.target.value, 10);
        filing.birthYear = Number.isFinite(v) ? v : filing.birthYear;
        e.target.value = filing.birthYear;
        persist(); rebuild(); // rebuild so the retirement/horizon-year age hints refresh too
      },
    });
    return h('div', { class: 'setting' }, h('div', { class: 'setting-head' },
      h('label', { class: 'setting-label' }, 'Birth year'), h('span', { class: 'field' }, input), hint));
  }

  function formatYearsMonths(years) {
    const wholeYears = Math.floor(years);
    const months = Math.round((years - wholeYears) * 12);
    return months === 0 ? `${wholeYears}` : `${wholeYears}y ${months}mo`;
  }

  function socialNumberRow(label, get, set, hintFn) {
    const hint = h('span', { class: 'muted small' });
    const setHint = () => { hint.textContent = hintFn ? hintFn() : ''; };
    setHint();
    const input = h('input', {
      type: 'number', step: '1', value: get(), class: 'num yr',
      onchange: (e) => {
        const v = parseInt(e.target.value, 10);
        set(Number.isFinite(v) ? v : get());
        e.target.value = get();
        persist(); rebuild(); // rebuild so the live benefit readout refreshes
      },
    });
    return h('div', { class: 'setting' }, h('div', { class: 'setting-head' }, h('label', { class: 'setting-label' }, label), h('span', { class: 'field' }, input), hint));
  }

  function haircutFactorRow() {
    const input = h('input', {
      type: 'number', step: 'any', value: +(social.solvencyHaircutFactor * 100).toFixed(4), class: 'num',
      onchange: (e) => {
        const v = Number(e.target.value);
        social.solvencyHaircutFactor = Number.isFinite(v) ? Math.max(0, v) / 100 : social.solvencyHaircutFactor;
        persist(); rebuild();
      },
    });
    return h('div', { class: 'setting' }, h('div', { class: 'setting-head' },
      h('label', { class: 'setting-label' }, 'Benefits payable (if depleted)'),
      h('span', { class: 'field' }, input, h('span', { class: 'affix' }, '%')),
      h('span', { class: 'muted small' }, '100% = assume Congress fixes it; ~77% = the OASI trust fund\'s own projection'),
    ));
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
      section('2 · Filing & taxes',
        taxTables
          ? h('p', { class: 'muted' }, `Federal tax is computed for real (brackets/standard deduction anchored to ${TAX_ANCHOR_YEAR}, indexed by the inflation assumption). Birth year drives RMDs and the age-65 standard-deduction bump.`)
          : h('p', { class: 'muted', style: { color: '#b45309' } }, "Tax tables didn't load — projections are running pre-tax (gross withdrawals only). Serve this app over http(s), not a bare file:// open."),
        selectRow('Filing status', filing.filingStatus, [
          ['single', 'Single'], ['mfj', 'Married filing jointly'], ['hoh', 'Head of household'],
        ], (v) => { filing.filingStatus = v; }),
        birthYearRow(),
        settingRow('stateTaxRate', 'State income tax rate (flat)', 'percent', false),
      ),
      section('3 · Working years',
        h('p', { class: 'muted' }, 'Set one value, or Expand any knob to override it per account and/or per year. Contributions are the base-year annual amount, escalated by wage growth.'),
        yearRow('Retirement year', () => plan.retirementYear, (v) => { plan.retirementYear = v; if (plan.horizonYear < v) plan.horizonYear = v; }, baseYear),
        settingRow('returnRate', 'Rate of return', 'percent', true),
        settingRow('contributions', 'Annual contribution', 'money', true),
        settingRow('inflation', 'Inflation', 'percent', false),
        settingRow('wageGrowth', 'Wage growth', 'percent', false),
      ),
      section('4 · Retirement spending',
        h('p', { class: 'muted' }, 'Withdrawals are drawn from your accounts in the order below, grossed up to net your spending target after tax (Phase 4). RMDs are forced once you reach the required age.'),
        yearRow('Plan through year', () => plan.horizonYear, (v) => { plan.horizonYear = v; }, () => plan.retirementYear),
        selectRow('Withdrawal strategy', plan.strategy, [
          ['fixedReal', "Fixed spending target (today's $)"],
          ['fixedPercent', '% of current balance each year'],
        ], (v) => { plan.strategy = v; }),
        plan.strategy === 'fixedPercent'
          ? settingRow('withdrawalPercent', 'Withdrawal %', 'percent', false)
          : settingRow('spending', 'Annual spending (today’s $)', 'money', false),
        settingRow('otherIncome', "Other income — pension/rental (today's $, not yet taxed — a v1 simplification)", 'money', false),
        selectRow('Withdrawal order', plan.sequencing, [
          ['conventional', 'Conventional (cash → taxable → tax-deferred → HSA → Roth)'],
          ['proportional', 'Proportional (spread across all accounts)'],
        ], (v) => { plan.sequencing = v; }),
      ),
      section('5 · Social Security',
        taxTables
          ? h('p', { class: 'muted' }, "Estimated from your earnings history, not typed in as a fixed number — so \"work N more years\" or \"claim earlier\" changes the estimate. \"Earnings\" is wage-indexed-equivalent (a simplification — see the repo's README); override specific years for accuracy.")
          : h('p', { class: 'muted', style: { color: '#b45309' } }, "Tax tables didn't load, so Social Security isn't estimated (it needs the benefit formula's bend points)."),
        settingRow('earnings', 'Annual earnings (wage-indexed $)', 'money', false),
        socialNumberRow('Career start year', () => social.careerStartYear, (v) => { social.careerStartYear = v; },
          () => `${Math.max(0, plan.retirementYear - social.careerStartYear + 1)} working years counted`),
        socialNumberRow('Claiming age', () => social.claimingAge, (v) => { social.claimingAge = Math.min(70, Math.max(62, v)); },
          () => Number.isFinite(filing.birthYear) ? `FRA: ${formatYearsMonths(fullRetirementAge(filing.birthYear))}` : ''),
        settingRow('colaRate', 'Cost-of-living adjustment (COLA)', 'percent', false),
        socialNumberRow('Solvency haircut starts', () => social.solvencyHaircutStartYear, (v) => { social.solvencyHaircutStartYear = v; },
          () => 'OASI trust fund\'s projected depletion year'),
        haircutFactorRow(),
        (() => {
          const est = socialSecurityEstimate();
          if (!est) return null;
          return h('div', { class: 'ss-estimate' },
            h('strong', {}, `Estimated benefit: $${Math.round(est.annualBenefit).toLocaleString()}/yr`),
            ` starting ${est.claimingYear} (age ${social.claimingAge}) · PIA $${Math.round(est.pia).toLocaleString()}/mo at FRA ${formatYearsMonths(est.fra)}`,
          );
        })(),
      ),
      section("6 · Projection (today's dollars)",
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
