// smoke.test.js — Phase 0 toolchain + data-shape smoke test (zero dependencies).
//
// Proves `npm test` (node --test) runs, that every JSON data/schema file is well-formed,
// and that the example scenario actually uses the {default,...} setting shape the whole
// design rests on. Real engine golden-number tests arrive with the math (Phase 1+).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

test('tax-tables.json parses and has the expected top-level shape', () => {
  const t = readJson('data/tax-tables.json');
  assert.ok(t.years?.['2025'], 'has a 2025 year');
  assert.ok(Array.isArray(t.years['2025'].ordinaryBrackets.mfj), '2025 MFJ brackets is an array');
  assert.ok(t.fixed?.socialSecurityBenefitTaxation, 'has fixed SS benefit-taxation thresholds');
  assert.ok(t.rmd?.uniformLifetime?.['73'], 'has an RMD divisor for age 73');
});

test('all schema files parse as JSON', () => {
  for (const f of ['schemas/profile.schema.json', 'schemas/snapshot.schema.json', 'schemas/scenario.schema.json']) {
    assert.equal(typeof readJson(f), 'object', `${f} parses to an object`);
  }
});

test('example data files parse', () => {
  for (const f of [
    'data/profiles/EXAMPLE.profile.json',
    'data/snapshots/EXAMPLE.snapshot.json',
    'data/scenarios/EXAMPLE.scenario.json',
  ]) {
    assert.doesNotThrow(() => readJson(f), `${f} parses`);
  }
});

test('example scenario assumptions use the general→granular setting shape (§2)', () => {
  const s = readJson('data/scenarios/EXAMPLE.scenario.json');
  for (const knob of ['returnRate', 'inflation', 'spending']) {
    assert.ok(s.assumptions[knob] && 'default' in s.assumptions[knob], `${knob} has a default`);
  }
  assert.ok(s.assumptions.returnRate.byAccount, 'returnRate demonstrates a byAccount override');
});

test('example snapshot exercises every account tax status', () => {
  const snap = readJson('data/snapshots/EXAMPLE.snapshot.json');
  const statuses = new Set(snap.accounts.map((a) => a.taxStatus));
  for (const s of ['taxDeferred', 'roth', 'taxable', 'hsa', 'cash']) {
    assert.ok(statuses.has(s), `snapshot includes a ${s} account`);
  }
});
