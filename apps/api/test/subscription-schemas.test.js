import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignSubscriptionSchema, changePackageSchema, extendSubscriptionSchema, updateValiditySchema,
} from '../src/modules/billing/billing.schemas.js';

/** Spec §7/§8/§22 — request validation for package assignment and validity. */

test('assign: minimal payload is valid (dates optional, computed server-side)', () => {
  assert.equal(assignSubscriptionSchema.safeParse({ organizationId: 'o1', planId: 'p1' }).success, true);
});

test('assign: an inverted explicit date range is rejected at the edge (§8/§22)', () => {
  const r = assignSubscriptionSchema.safeParse({ organizationId: 'o1', planId: 'p1', startDate: '2026-09-04', endDate: '2026-09-01' });
  assert.equal(r.success, false);
});

test('assign: a valid explicit range is accepted and coerced to Dates', () => {
  const r = assignSubscriptionSchema.safeParse({ organizationId: 'o1', planId: 'p1', startDate: '2026-09-04', endDate: '2026-10-04' });
  assert.equal(r.success, true);
  assert.ok(r.data.endDate instanceof Date);
});

test('change: same range rule applies', () => {
  assert.equal(changePackageSchema.safeParse({ organizationId: 'o1', planId: 'p2', startDate: '2026-09-04', endDate: '2026-09-04' }).success, false);
  assert.equal(changePackageSchema.safeParse({ organizationId: 'o1', planId: 'p2' }).success, true);
});

test('extend: requires an endDate', () => {
  assert.equal(extendSubscriptionSchema.safeParse({}).success, false);
  assert.equal(extendSubscriptionSchema.safeParse({ endDate: '2026-11-04' }).success, true);
});

test('validity: needs at least one date and a valid order', () => {
  assert.equal(updateValiditySchema.safeParse({}).success, false);
  assert.equal(updateValiditySchema.safeParse({ startDate: '2026-09-04', endDate: '2026-09-01' }).success, false);
  assert.equal(updateValiditySchema.safeParse({ endDate: '2026-12-01' }).success, true);
});
