import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statesIntersect, assertCatalogEligible } from '../src/modules/clients/insuranceEligibility.js';

/**
 * Spec Module 5.4 / §14 — the backend eligibility rule for referencing a global
 * insurance company from a client-insurance record. The picker filters in the
 * browser, but this is the rule the SERVER enforces before the write, so a
 * hand-crafted request can't reference an insurer a company isn't entitled to.
 */

test('statesIntersect — any single shared state is enough (case-insensitive)', () => {
  assert.equal(statesIntersect(['CA'], ['CA', 'FL']), true);
  assert.equal(statesIntersect(['ca'], ['CA']), true);
  assert.equal(statesIntersect(['TX', 'CA'], ['FL', 'CA']), true, 'A ∩ where CA matches');
});

test('statesIntersect — no overlap is not eligible', () => {
  assert.equal(statesIntersect(['TX'], ['CA', 'FL']), false);
});

test('statesIntersect — a company with NO operating states matches nothing', () => {
  // With no states the intersection is empty by definition; the catalog service
  // decides separately whether to fall back to the full active list.
  assert.equal(statesIntersect([], ['CA']), false);
  assert.equal(statesIntersect(null, ['CA']), false);
});

test('assertCatalogEligible — a missing insurer is refused as not-found', () => {
  assert.throws(() => assertCatalogEligible(null, ['CA']), (e) => e.code === 'INSURANCE_CATALOG_NOT_FOUND');
});

test('assertCatalogEligible — an inactive insurer is refused (validation)', () => {
  assert.throws(
    () => assertCatalogEligible({ id: 'ic1', name: 'A', states: ['CA'], active: false }, ['CA']),
    (e) => e.status === 422,
  );
});

test('assertCatalogEligible — a soft-deleted insurer is refused', () => {
  assert.throws(
    () => assertCatalogEligible({ id: 'ic1', name: 'A', states: ['CA'], active: true, deletedAt: new Date() }, ['CA']),
    (e) => e.status === 422,
  );
});

test('assertCatalogEligible — an out-of-state insurer is refused as forbidden (§14)', () => {
  assert.throws(
    () => assertCatalogEligible({ id: 'ic1', name: 'A', states: ['NY'], active: true }, ['CA', 'TX']),
    (e) => e.code === 'INSURANCE_NOT_ELIGIBLE' && e.status === 403,
  );
});

test('assertCatalogEligible — an eligible insurer returns the AUTHORITATIVE payer name', () => {
  // The stored payerName comes from the catalog, never the request body, so a
  // caller can't relabel a global insurer it is otherwise entitled to.
  const out = assertCatalogEligible({ id: 'ic1', name: 'ABC Health Plan', states: ['CA'], active: true }, ['ca']);
  assert.deepEqual(out, { payerName: 'ABC Health Plan', catalogInsuranceId: 'ic1' });
});
