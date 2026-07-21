// resolver.js — the general→granular override resolver (plan.md §2).
//
// Every adjustable knob is stored as a `setting`:
//   { default, byAccount?, byYear?, byAccountYear? }
// and resolved most-specific-first:
//   byAccountYear["<acct>|<year>"] → byYear["<year>"] → byAccount["<acct>"] → default
//
// This is the single most-reused primitive in the engine. Pure, no I/O, no DOM.

const has = (obj, key) =>
  obj != null && Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Resolve a setting AND report which override level supplied the value — useful for
 * the UI (showing whether a cell is inherited or overridden) and for tests.
 * @param {*} setting a setting object, or any literal value (returned as-is).
 * @param {{year?:number|string, accountId?:string}} [context]
 * @returns {{value:*, level:'byAccountYear'|'byYear'|'byAccount'|'default'|'literal'|'unset', key:(string|null)}}
 */
export function explainResolve(setting, context = {}) {
  // A bare value (not a setting object) is treated as a literal.
  if (setting === null || typeof setting !== 'object' || Array.isArray(setting)) {
    return { value: setting, level: 'literal', key: null };
  }

  const accountId =
    context.accountId != null && context.accountId !== '' ? String(context.accountId) : undefined;
  const year = context.year != null && context.year !== '' ? String(context.year) : undefined;

  if (accountId !== undefined && year !== undefined) {
    const k = `${accountId}|${year}`;
    if (has(setting.byAccountYear, k)) {
      return { value: setting.byAccountYear[k], level: 'byAccountYear', key: k };
    }
  }
  if (year !== undefined && has(setting.byYear, year)) {
    return { value: setting.byYear[year], level: 'byYear', key: year };
  }
  if (accountId !== undefined && has(setting.byAccount, accountId)) {
    return { value: setting.byAccount[accountId], level: 'byAccount', key: accountId };
  }
  if (has(setting, 'default')) {
    return { value: setting.default, level: 'default', key: null };
  }
  return { value: undefined, level: 'unset', key: null };
}

/**
 * Resolve a setting's effective value for a given context.
 * Note: falsy values (0, false, "") are valid results and are returned, not skipped —
 * presence is checked with hasOwnProperty, never truthiness.
 * @param {*} setting
 * @param {{year?:number|string, accountId?:string}} [context]
 * @returns {*}
 */
export function resolve(setting, context = {}) {
  return explainResolve(setting, context).value;
}

/** True if `v` looks like a setting object (has an own `default`). */
export function isSetting(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v) && has(v, 'default');
}

/** Build a fresh setting from a simple-mode value. */
export function makeSetting(defaultValue) {
  return { default: defaultValue };
}

/**
 * Classify an override target into its level + storage key.
 * Both account and year → byAccountYear; year only → byYear; account only → byAccount;
 * neither → default.
 */
export function overrideKeyLevel({ accountId, year } = {}) {
  const a = accountId != null && accountId !== '';
  const y = year != null && year !== '';
  if (a && y) return { level: 'byAccountYear', key: `${accountId}|${year}` };
  if (y) return { level: 'byYear', key: String(year) };
  if (a) return { level: 'byAccount', key: String(accountId) };
  return { level: 'default', key: null };
}

/**
 * Set an override on a setting (mutates and returns it). Target {accountId?, year?}
 * selects the level; empty target sets the default.
 */
export function setOverride(setting, target, value) {
  const { level, key } = overrideKeyLevel(target);
  if (level === 'default') {
    setting.default = value;
    return setting;
  }
  if (!setting[level]) setting[level] = {};
  setting[level][key] = value;
  return setting;
}

/**
 * Remove an override (mutates and returns it). Pruning empty override maps keeps saved
 * JSON clean. Clearing the "default" target is a no-op (a setting must keep its default).
 */
export function clearOverride(setting, target) {
  const { level, key } = overrideKeyLevel(target);
  if (level === 'default') return setting;
  if (setting[level]) {
    delete setting[level][key];
    if (Object.keys(setting[level]).length === 0) delete setting[level];
  }
  return setting;
}

/** List every override on a setting as flat rows — for rendering an overrides table. */
export function listOverrides(setting) {
  const rows = [];
  if (!isSetting(setting)) return rows;
  for (const [level, prop] of [
    ['byAccount', 'byAccount'],
    ['byYear', 'byYear'],
    ['byAccountYear', 'byAccountYear'],
  ]) {
    const map = setting[prop];
    if (!map) continue;
    for (const key of Object.keys(map)) {
      let accountId = null;
      let year = null;
      if (level === 'byAccount') accountId = key;
      else if (level === 'byYear') year = key;
      else {
        const [a, y] = key.split('|');
        accountId = a;
        year = y;
      }
      rows.push({ level, key, accountId, year, value: map[key] });
    }
  }
  return rows;
}
