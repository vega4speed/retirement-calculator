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
import { resolve } from '../engine/resolver.js';
import { resolveYearTable, bracketBreakdown, standardDeduction, ordinaryTax, marginalRateForIncome, traditionalVsRothVerdict } from '../engine/tax.js';
import { estimatePIA, benefitAtClaimingAge, fullRetirementAge } from '../engine/socialsecurity.js';
import { projectFor, TAX_ANCHOR_YEAR } from './project-adapter.js';
import { createScenariosView } from './scenarios.js';
import { usd as usdShort } from './chart-utils.js';

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
    strategy: 'fixedReal',       // 'fixedReal' | 'fixedPercent' | 'maxSustainable'
    sequencing: 'conventional',  // 'conventional' | 'proportional' | 'bracketFill'
    bracketFillRate: 0.12,       // 'bracketFill' only: which ordinary bracket to fill up to
    rothConversionsEnabled: false, // 'bracketFill' only: also convert unused room to Roth
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
    const age65Count = row.age != null && row.age >= 65 ? 1 : 0;
    const stdDeduction = standardDeduction({ filingStatus: filing.filingStatus, age65Count, yearTable });
    const ordinary = bracketBreakdown(row.totals.ordinaryTaxableIncome, yearTable.ordinaryBrackets[filing.filingStatus]);
    const ltcg = row.totals.capitalGain > 0
      ? bracketBreakdown(row.totals.capitalGain, yearTable.ltcgBrackets[filing.filingStatus], row.totals.ordinaryTaxableIncome)
      : [];
    return { ordinary, ltcg, stdDeduction, effectiveTaxRate: row.totals.effectiveTaxRate };
  }

  // Live "here's what that produces" readout for the Social Security section — recomputed from
  // the same engine functions the projection itself uses, so it never drifts from the real result.
  // ssEstimateBox (below) is a PERSISTENT element updated from refreshProjection(), same reason
  // and same fix shape as maxSustainableBox: "Career start year"/"Claiming age" were manually
  // routed through a full rebuild() specifically so this readout would refresh ("so the live
  // benefit readout refreshes" — see socialNumberRow's call sites), but "Annual earnings" and
  // "Wage growth" go through the lighter settingRow -> onEdit() path, which never touched it —
  // reported bug: changing earnings 70k -> 150k didn't move the estimated benefit at all, even
  // though the underlying projection (and the max-sustainable solve) DID pick up the change.
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

  // A single point-in-time snapshot of TODAY's tax situation — not a multi-year projection.
  // Reuses the SAME `earnings` setting Social Security draws on (resolved for the current/base
  // year), since asking for the same real-world income twice in two different inputs would be
  // confusing and error-prone. This deliberately does NOT model income growth or a year-by-year
  // pre-retirement tax ledger — the standard financial-planning heuristic for traditional-vs-Roth
  // is "compare your current marginal rate to your expected retirement rate," which only needs
  // one snapshot on each side, not a full trajectory.
  function currentTaxSnapshot() {
    if (!taxTables) return null;
    const year = baseYear();
    const income = Number(resolve(assumptions.earnings, { year })) || 0;
    const yearTable = resolveYearTable({
      tables: taxTables, year, anchorYear: TAX_ANCHOR_YEAR,
      bracketIndexingRate: assumptions.inflation, standardDeductionIndexingRate: assumptions.inflation,
    });
    const age65Count = Number.isFinite(filing.birthYear) && (year - filing.birthYear) >= 65 ? 1 : 0;
    const stdDeductionAmt = standardDeduction({ filingStatus: filing.filingStatus, age65Count, yearTable });
    const taxableIncome = Math.max(0, income - stdDeductionAmt);
    const tax = ordinaryTax(taxableIncome, filing.filingStatus, yearTable);
    const marginalRate = marginalRateForIncome(taxableIncome, yearTable.ordinaryBrackets[filing.filingStatus]);
    const effectiveRate = income > 0 ? tax / income : 0;
    return { year, income, tax, marginalRate, effectiveRate };
  }

  const projectionView = createProjectionView({ bracketBreakdownFor });

  // Loads a saved scenario BACK into the live editor (overwriting it — the scenario itself stays
  // untouched, since it was saved as a deep copy). Mirrors loadPersisted()'s defaults-then-
  // override merge so a scenario saved before a new field existed still loads without crashing.
  function loadScenario(scn) {
    applySnapshot(scn.snapshot);
    assumptions = { ...defaultAssumptions(), ...scn.assumptions };
    Object.assign(plan, scn.plan);
    filing = { ...defaultFiling(), ...scn.filing };
    social = { ...defaultSocial(filing.birthYear), ...scn.social };
    persist();
    rebuild();
  }
  const scenariosView = createScenariosView({
    getCurrentState: () => ({ snapshot, assumptions, plan, filing, social }),
    taxTables,
    onLoad: loadScenario,
  });
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
    plan.bracketFillRate = 0.12;
    plan.rothConversionsEnabled = false;
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
    return projectFor({ snapshot, assumptions, plan, filing, social }, taxTables);
  }
  function refreshProjection() {
    const r = computeProjection();
    if (r) projectionView.render(r); else projectionView.clearView();
    updateMaxSustainableReadout(r);
    updateSocialSecurityReadout();
    updateTaxComparisonReadout(r);
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

  // Rates offered for "fill to the top of a bracket" — the current filing status's own ordinary
  // brackets (anchor year), so the picker always matches what the engine can actually find via
  // tax.bracketTopForRate. Excludes the uncapped top bracket (filling "to the top" of it is the
  // same as no ceiling at all — not a meaningful choice).
  function bracketFillOptions() {
    if (!taxTables) return [];
    const yearTable = resolveYearTable({ tables: taxTables, year: TAX_ANCHOR_YEAR, anchorYear: TAX_ANCHOR_YEAR });
    return yearTable.ordinaryBrackets[filing.filingStatus]
      .filter((b) => b.upTo != null)
      .map((b) => b.rate);
  }

  function bracketFillRateRow() {
    const rates = bracketFillOptions();
    if (!rates.length) return null;
    if (!rates.includes(plan.bracketFillRate)) plan.bracketFillRate = rates[0];
    return selectRow('Fill up to bracket', String(plan.bracketFillRate),
      rates.map((r) => [String(r), `${(r * 100).toFixed(0)}%`]),
      (v) => { plan.bracketFillRate = Number(v); });
  }

  // Live "here's what that produces" readout for the 'maxSustainable' strategy — no input to
  // type, the amount is solved from every other assumption already set (design doc §9: "what's
  // the safe real spending it does support?"). This is a PERSISTENT element (like projectionView
  // and scenariosView above), not markup rebuilt fresh each time: most edits (rate of return,
  // retirement year, ...) go through onEdit() -> refreshProjection() only, not the full-page
  // rebuild() — a plain rebuild()-time render() here would go stale on exactly those edits
  // (reported bug: changing retirement year or rate of return didn't re-solve the readout, even
  // though the chart/table below it — which DOES go through refreshProjection() — was already
  // correct). updateMaxSustainableReadout() is called from refreshProjection() itself so it's
  // kept in sync on every edit path, not just full rebuilds.
  const maxSustainableBox = h('div');
  function updateMaxSustainableReadout(r) {
    clear(maxSustainableBox);
    if (plan.strategy !== 'maxSustainable') return;
    if (!r) { maxSustainableBox.append(h('p', { class: 'muted small' }, 'Add at least one account to solve for a sustainable spending level.')); return; }
    if (r.solvedSpending == null) {
      maxSustainableBox.append(h('p', { class: 'muted small' }, 'Set a "Plan through year" past retirement to solve for a sustainable spending level.'));
      return;
    }
    maxSustainableBox.append(h('div', { class: 'ss-estimate' },
      h('strong', {}, `Solved: $${Math.round(r.solvedSpending).toLocaleString()}/yr`),
      ` — the highest constant spending (today's dollars) that lasts through ${r.horizonYear} under your current assumptions.`,
    ));
  }

  // Same persistent-element fix as maxSustainableBox above, for the Social Security estimate.
  const ssEstimateBox = h('div');
  function updateSocialSecurityReadout() {
    clear(ssEstimateBox);
    const est = socialSecurityEstimate();
    if (!est) return;
    ssEstimateBox.append(h('div', { class: 'ss-estimate' },
      h('strong', {}, `Estimated benefit: $${Math.round(est.annualBenefit).toLocaleString()}/yr`),
      ` starting ${est.claimingYear} (age ${social.claimingAge}) · PIA $${Math.round(est.pia).toLocaleString()}/mo at FRA ${formatYearsMonths(est.fra)}`,
    ));
  }

  // Traditional-vs-Roth guidance: compares TODAY's marginal tax rate (currentTaxSnapshot(), a
  // simplified snapshot — see its docs) against the projected RETIREMENT-ONLY effective rate
  // (r.decumulationEffectiveTaxRate — NOT r.lifetimeEffectiveTaxRate, which now also blends in
  // working-years tax, Phase 6.5, and would badly mismeasure "the retirement side" of this
  // specific comparison). Uses tax.traditionalVsRothVerdict() — the same pure engine helper — so
  // this UI code doesn't carry its own copy of the win/lose/wash logic. Persistent element updated
  // from refreshProjection(), same shape/reason as ssEstimateBox and maxSustainableBox above.
  //
  // The FULL accumulation-phase tax trajectory (marginal rate every working year, not just this
  // one snapshot; tax-deferred-contribution deductions; Roth conversions during accumulation) is
  // now computed by the engine and visible in the projection chart's hover tooltip and table below
  // — this readout stays a fast, prominent "today" verdict alongside that fuller picture, not a
  // replacement for it.
  const taxComparisonBox = h('div');
  function updateTaxComparisonReadout(r) {
    clear(taxComparisonBox);
    const snap = currentTaxSnapshot();
    if (!snap || snap.income <= 0) return;
    if (!r || !(r.decumulationGrossIncome > 0)) {
      taxComparisonBox.append(h('div', { class: 'ss-estimate' },
        h('strong', {}, `Current marginal tax rate: ${(snap.marginalRate * 100).toFixed(0)}%`),
        ` (effective ${(snap.effectiveRate * 100).toFixed(1)}%) on ${usdShort(snap.income)} income in ${snap.year}.`,
        h('div', { class: 'muted small' }, 'Add accounts and a spending plan below to compare this against your projected retirement tax rate.'),
      ));
      return;
    }
    const retirementRate = r.decumulationEffectiveTaxRate;
    const verdict = traditionalVsRothVerdict(snap.marginalRate, retirementRate);
    const verdictText = verdict === 'wash'
      ? "roughly a wash — Traditional and Roth are close to equivalent for you at these rates"
      : verdict === 'traditional'
        ? 'Traditional (tax-deferred) contributions are likely more tax-efficient — you\'d defer tax at a higher rate now and pay it later at a lower one'
        : 'Roth contributions are likely more tax-efficient — you\'d pay tax now at a lower rate than you\'re projected to face in retirement';
    taxComparisonBox.append(h('div', { class: 'ss-estimate' },
      h('strong', {}, `Current marginal tax rate: ${(snap.marginalRate * 100).toFixed(0)}%`),
      ` (effective ${(snap.effectiveRate * 100).toFixed(1)}%) on ${usdShort(snap.income)} income in ${snap.year}, vs. a projected `,
      h('strong', {}, `${(retirementRate * 100).toFixed(1)}% effective rate in retirement`),
      '.',
      h('div', { class: 'muted small' }, `→ ${verdictText}. This compares your current marginal rate to retirement's overall EFFECTIVE rate — the two aren't quite the same kind of number, but it's the standard comparison for this decision; a rough guide, not a precise optimum. See the projection chart's hover and table below for your full tax trajectory year by year, including any working-years Roth conversions.`),
    ));
  }

  function selectRow(label, value, options, onSet) {
    const select = h('select', {
      onchange: (e) => { onSet(e.target.value); onEdit(); rebuild(); },
    }, ...options.map(([v, lbl]) => h('option', { value: v, selected: v === value }, lbl)));
    return h('div', { class: 'setting' }, h('div', { class: 'setting-head' }, h('label', { class: 'setting-label' }, label), select));
  }

  function checkboxRow(label, checked, onSet, hint) {
    const checkbox = h('input', {
      type: 'checkbox', checked,
      onchange: (e) => { onSet(e.target.checked); onEdit(); rebuild(); },
    });
    return h('div', { class: 'setting' }, h('div', { class: 'setting-head' },
      h('label', { class: 'setting-label checkbox-label' }, checkbox, ' ', label),
      hint ? h('span', { class: 'muted small' }, hint) : null,
    ));
  }

  // --- view ----------------------------------------------------------------
  const body = h('div');

  function rebuild() {
    // Most controls that affect other rows' hints/options (sequencing, career start year, birth
    // year, filing status, ...) trigger this full rebuild rather than the lighter onEdit() path.
    // Clearing and re-appending the whole body loses the browser's scroll anchoring the same way
    // the projection view's own re-render did (see projection-view.js) — capture/restore around
    // it so e.g. nudging a number input's spinner doesn't fling the page back to the top.
    const scrollY = window.scrollY;
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
        h('p', { class: 'muted small' }, 'Current tax rate, and whether traditional or Roth contributions make more sense for you — based on the "Annual earnings" figure in the Social Security section below (the same real income, used once).'),
        taxComparisonBox,
      ),
      section('4 · Retirement spending',
        h('p', { class: 'muted' }, 'Withdrawals are drawn from your accounts in the order below, grossed up to net your spending target after tax (Phase 4). RMDs are forced once you reach the required age.'),
        yearRow('Plan through year', () => plan.horizonYear, (v) => { plan.horizonYear = v; }, () => plan.retirementYear),
        selectRow('Withdrawal strategy', plan.strategy, [
          ['fixedReal', "Fixed spending target (today's $)"],
          ['fixedPercent', '% of current balance each year'],
          ['maxSustainable', 'Maximum sustainable (solves for the highest spending that lasts)'],
        ], (v) => { plan.strategy = v; }),
        plan.strategy === 'fixedPercent'
          ? settingRow('withdrawalPercent', 'Withdrawal %', 'percent', false)
          : plan.strategy === 'maxSustainable'
            ? maxSustainableBox
            : settingRow('spending', 'Annual spending (today’s $)', 'money', false),
        settingRow('otherIncome', "Other income — pension/rental (today's $, not yet taxed — a v1 simplification)", 'money', false),
        selectRow('Withdrawal order', plan.sequencing, [
          ['conventional', 'Conventional (cash → taxable → tax-deferred → HSA → Roth)'],
          ['proportional', 'Proportional (spread across all accounts)'],
          ...(taxTables ? [['bracketFill', 'Tax-bracket-aware (fill tax-deferred to the top of a bracket first)']] : []),
        ], (v) => { plan.sequencing = v; }),
        plan.sequencing === 'bracketFill'
          ? h('div', {},
              bracketFillRateRow(),
              h('p', { class: 'muted small' }, 'Each year, withdraws from tax-deferred accounts up to the top of this ordinary-income bracket before touching taxable or Roth — deliberately realizing cheap ordinary income in low-income years instead of saving it all for RMDs. RMDs, when forced, still come first and count against this ceiling.'),
              checkboxRow('Also convert unused bracket room to Roth', plan.rothConversionsEnabled,
                (v) => { plan.rothConversionsEnabled = v; }),
              h('p', { class: 'muted small' }, "Roth conversions (design doc §5): in the gap years before you're forced to take RMDs, whatever room is left in the bracket above after covering your spending gets converted from tax-deferred to Roth instead of sitting unused — paying tax on it now, at today's (possibly lower) rate, so it shrinks future RMDs and grows tax-free forever after. The conversion is preserved in full; its own tax is paid from other accounts (via the withdrawal order above), not carved out of the converted amount. This raises this year's tax bill on purpose — see the Lifetime tax stat and the per-year breakdown below to judge the tradeoff."),
              h('p', { class: 'muted small' }, "This checkbox also applies to your WORKING years, using the same chosen bracket, funded from take-home pay rather than a portfolio withdrawal — see the projection chart's hover and table for whether any room actually shows up there. In practice it's usually $0 while working full-time: ordinary job income alone often already exceeds a modest bracket, leaving nothing to convert — a correct result, not a bug. It's most likely to matter in a lower-income working year (part-time, a gap year, early in a career)."),
            )
          : null,
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
        ssEstimateBox,
      ),
      section("6 · Projection (today's dollars)",
        projectionView.el,
      ),
      section('7 · Scenarios',
        scenariosView.el,
      ),
    );
    refreshProjection();
    window.scrollTo(0, scrollY);
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
