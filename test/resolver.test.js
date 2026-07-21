// resolver.test.js — unit tests for the general→granular override resolver (plan.md §2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolve,
  explainResolve,
  isSetting,
  makeSetting,
  overrideKeyLevel,
  setOverride,
  clearOverride,
  listOverrides,
} from '../engine/resolver.js';

test('default only — resolves to default in any context', () => {
  const s = { default: 0.1 };
  assert.equal(resolve(s), 0.1);
  assert.equal(resolve(s, { accountId: 'a', year: 2040 }), 0.1);
});

test('byAccount override applies only to that account', () => {
  const s = { default: 0.1, byAccount: { cash: 0.03 } };
  assert.equal(resolve(s, { accountId: 'cash', year: 2040 }), 0.03);
  assert.equal(resolve(s, { accountId: 'roth', year: 2040 }), 0.1);
  assert.equal(resolve(s, { year: 2040 }), 0.1); // no account in context
});

test('byYear override applies to every account that year', () => {
  const s = { default: 0.1, byYear: { 2040: 0.05 } };
  assert.equal(resolve(s, { accountId: 'roth', year: 2040 }), 0.05);
  assert.equal(resolve(s, { accountId: 'roth', year: 2041 }), 0.1);
});

test('precedence: byAccountYear beats byYear beats byAccount beats default', () => {
  const s = {
    default: 0.1,
    byAccount: { roth: 0.09 },
    byYear: { 2040: 0.05 },
    byAccountYear: { 'roth|2040': 0.03 },
  };
  assert.equal(resolve(s, { accountId: 'roth', year: 2040 }), 0.03); // most specific
  assert.equal(resolve(s, { accountId: 'roth', year: 2041 }), 0.09); // byAccount (no year match)
  assert.equal(resolve(s, { accountId: 'cash', year: 2040 }), 0.05); // byYear (no account match)
  assert.equal(resolve(s, { accountId: 'cash', year: 2041 }), 0.1); // default
});

test('year is normalized — number and string keys are equivalent', () => {
  assert.equal(resolve({ default: 0, byYear: { 2033: 0.01 } }, { year: 2033 }), 0.01);
  assert.equal(resolve({ default: 0, byYear: { 2033: 0.01 } }, { year: '2033' }), 0.01);
});

test('falsy values are real results, not treated as missing', () => {
  assert.equal(resolve({ default: 0 }), 0);
  assert.equal(resolve({ default: false }), false);
  assert.equal(resolve({ default: 0.1, byAccount: { cash: 0 } }, { accountId: 'cash' }), 0);
});

test('literal (non-setting) values pass through unchanged', () => {
  assert.equal(resolve(0.1), 0.1);
  assert.equal(resolve('x'), 'x');
  assert.equal(resolve(null), null);
});

test('a setting with no default resolves to undefined (level: unset)', () => {
  const r = explainResolve({ byAccount: { a: 1 } }, { accountId: 'b' });
  assert.equal(r.value, undefined);
  assert.equal(r.level, 'unset');
});

test('explainResolve reports the matching level and key', () => {
  const s = { default: 0.1, byAccount: { roth: 0.09 }, byAccountYear: { 'roth|2040': 0.03 } };
  assert.deepEqual(explainResolve(s, { accountId: 'roth', year: 2040 }), {
    value: 0.03,
    level: 'byAccountYear',
    key: 'roth|2040',
  });
  assert.deepEqual(explainResolve(s, { accountId: 'roth', year: 2041 }), {
    value: 0.09,
    level: 'byAccount',
    key: 'roth',
  });
  assert.equal(explainResolve(s, {}).level, 'default');
  assert.equal(explainResolve(5).level, 'literal');
});

test('isSetting / makeSetting', () => {
  assert.equal(isSetting({ default: 1 }), true);
  assert.equal(isSetting({ byYear: {} }), false);
  assert.equal(isSetting(5), false);
  assert.deepEqual(makeSetting(0.1), { default: 0.1 });
});

test('overrideKeyLevel classifies targets correctly', () => {
  assert.deepEqual(overrideKeyLevel({ accountId: 'a', year: 2040 }), { level: 'byAccountYear', key: 'a|2040' });
  assert.deepEqual(overrideKeyLevel({ year: 2040 }), { level: 'byYear', key: '2040' });
  assert.deepEqual(overrideKeyLevel({ accountId: 'a' }), { level: 'byAccount', key: 'a' });
  assert.deepEqual(overrideKeyLevel({}), { level: 'default', key: null });
});

test('setOverride writes to the right level and resolve reflects it', () => {
  const s = makeSetting(0.1);
  setOverride(s, { accountId: 'roth', year: 2040 }, 0.03);
  setOverride(s, { year: 2050 }, 0.04);
  setOverride(s, { accountId: 'cash' }, 0.02);
  assert.equal(resolve(s, { accountId: 'roth', year: 2040 }), 0.03);
  assert.equal(resolve(s, { year: 2050 }), 0.04);
  assert.equal(resolve(s, { accountId: 'cash' }), 0.02);
  setOverride(s, {}, 0.11); // empty target updates default
  assert.equal(resolve(s, { accountId: 'other', year: 1999 }), 0.11);
});

test('clearOverride removes an override and prunes empty maps', () => {
  const s = { default: 0.1, byAccount: { cash: 0.02 } };
  clearOverride(s, { accountId: 'cash' });
  assert.equal(resolve(s, { accountId: 'cash' }), 0.1);
  assert.equal('byAccount' in s, false, 'empty byAccount map is pruned');
  clearOverride(s, {}); // clearing default is a no-op
  assert.equal(s.default, 0.1);
});

test('listOverrides flattens all levels for display', () => {
  const s = {
    default: 0.1,
    byAccount: { cash: 0.02 },
    byYear: { 2050: 0.04 },
    byAccountYear: { 'roth|2040': 0.03 },
  };
  const rows = listOverrides(s);
  assert.equal(rows.length, 3);
  const byLevel = Object.fromEntries(rows.map((r) => [r.level, r]));
  assert.deepEqual(byLevel.byAccount, { level: 'byAccount', key: 'cash', accountId: 'cash', year: null, value: 0.02 });
  assert.deepEqual(byLevel.byYear, { level: 'byYear', key: '2050', accountId: null, year: '2050', value: 0.04 });
  assert.deepEqual(byLevel.byAccountYear, {
    level: 'byAccountYear',
    key: 'roth|2040',
    accountId: 'roth',
    year: '2040',
    value: 0.03,
  });
});
