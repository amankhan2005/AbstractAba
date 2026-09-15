import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveEffectiveStatus, msRemaining, remainingBreakdown, presentSubscription, EXPIRING_SOON_DAYS,
} from '../src/modules/billing/subscription.lifecycle.js';
import { BillingService } from '../src/modules/billing/billing.service.js';

/**
 * Spec §8/§10/§11/§25/§28 — the acceptance-critical calculation logic, pure and
 * time-injected so every boundary is tested without the clock.
 */
const NOW = new Date('2026-09-04T12:00:00Z');

test('status: ACTIVE well before renewal', () => {
  assert.equal(deriveEffectiveStatus({ status: 'ACTIVE', currentPeriodEnd: new Date('2026-10-04T12:00:00Z') }, NOW), 'ACTIVE');
});

test('status: EXPIRING_SOON inside the threshold window (§11)', () => {
  const end = new Date(NOW.getTime() + (EXPIRING_SOON_DAYS - 2) * 86400000);
  assert.equal(deriveEffectiveStatus({ status: 'ACTIVE', currentPeriodEnd: end }, NOW), 'EXPIRING_SOON');
});

test('status: EXPIRED once the renewal date has passed (§25)', () => {
  assert.equal(deriveEffectiveStatus({ status: 'ACTIVE', currentPeriodEnd: new Date('2026-09-01T12:00:00Z') }, NOW), 'EXPIRED');
});

test('status: expires exactly now → EXPIRED, not a zero-countdown ACTIVE (§10/§25)', () => {
  assert.equal(deriveEffectiveStatus({ status: 'ACTIVE', currentPeriodEnd: NOW }, NOW), 'EXPIRED');
});

test('status: CANCELED/SUSPENDED/PAST_DUE are authoritative over the clock', () => {
  const end = new Date('2026-10-04T12:00:00Z');
  assert.equal(deriveEffectiveStatus({ status: 'CANCELED', currentPeriodEnd: end }, NOW), 'CANCELED');
  assert.equal(deriveEffectiveStatus({ status: 'SUSPENDED', currentPeriodEnd: end }, NOW), 'SUSPENDED');
  assert.equal(deriveEffectiveStatus({ status: 'PAST_DUE', currentPeriodEnd: end }, NOW), 'PAST_DUE');
});

test('countdown: never negative; floored at zero when expired (§10)', () => {
  assert.equal(msRemaining(new Date('2026-09-01T12:00:00Z'), NOW), 0);
  const b = remainingBreakdown(new Date('2026-08-01T00:00:00Z'), NOW);
  assert.deepEqual([b.days, b.hours, b.minutes, b.seconds], [0, 0, 0, 0]);
});

test('countdown: breakdown reflects the real remaining time', () => {
  const end = new Date(NOW.getTime() + (2 * 86400000) + (3 * 3600000) + (4 * 60000) + 5000);
  const b = remainingBreakdown(end, NOW);
  assert.deepEqual([b.days, b.hours, b.minutes, b.seconds], [2, 3, 4, 5]);
});

test('countdown: annual subscription crosses a year boundary (§29.20)', () => {
  const start = new Date('2026-09-04T00:00:00Z');
  const end = new Date('2027-09-04T00:00:00Z');
  const b = remainingBreakdown(end, start);
  assert.equal(b.days, 365);
});

test('present: null subscription → null (empty state, §24)', () => {
  assert.equal(presentSubscription(null), null);
});

test('present: uses the stored SNAPSHOT amount, not the live plan (§28)', () => {
  const sub = {
    _id: 's1', organizationId: 'o1', planId: 'p1', planName: 'Professional', unitAmount: 49900,
    currency: 'usd', billingInterval: 'MONTHLY', status: 'ACTIVE',
    currentPeriodStart: new Date('2026-09-04T00:00:00Z'), currentPeriodEnd: new Date('2026-10-04T00:00:00Z'),
  };
  const livePlanNowPricier = { name: 'Professional', monthlyPrice: 59900, yearlyPrice: 599000, currency: 'usd' };
  const out = presentSubscription(sub, livePlanNowPricier, NOW);
  assert.equal(out.amount, 49900, 'historical amount preserved despite the plan price rising');
  assert.equal(out.planName, 'Professional');
  assert.equal(out.billingInterval, 'MONTHLY');
  assert.equal(out.effectiveStatus, 'ACTIVE');
  assert.equal(out.expired, false);
});

test('present: falls back to the live plan only when a snapshot is missing', () => {
  const preSnapshotRow = { _id: 's2', organizationId: 'o1', planId: 'p1', billingInterval: 'YEARLY', status: 'ACTIVE', currentPeriodEnd: new Date('2027-09-04T00:00:00Z') };
  const plan = { name: 'Enterprise', monthlyPrice: 80000, yearlyPrice: 800000, currency: 'usd' };
  const out = presentSubscription(preSnapshotRow, plan, NOW);
  assert.equal(out.amount, 800000, 'yearly price used for a YEARLY interval');
  assert.equal(out.planName, 'Enterprise');
});

test('validity: explicit end must be after start (§8/§22)', () => {
  assert.throws(
    () => BillingService.resolveValidity({ startDate: '2026-09-04', endDate: '2026-09-01' }),
    (e) => e.status === 422,
  );
});

test('validity: monthly interval computes a one-month window when no end given (§8)', () => {
  const { start, end } = BillingService.resolveValidity({ startDate: '2026-09-04T00:00:00Z', billingInterval: 'MONTHLY' });
  assert.equal(start.toISOString().slice(0, 10), '2026-09-04');
  assert.equal(end.toISOString().slice(0, 10), '2026-10-04');
});

test('validity: annual interval computes a one-year window (§8)', () => {
  const { end } = BillingService.resolveValidity({ startDate: '2026-09-04T00:00:00Z', billingInterval: 'YEARLY' });
  assert.equal(end.toISOString().slice(0, 10), '2027-09-04');
});

test('snapshotOf picks the interval-correct price (§16/§28)', () => {
  const plan = { name: 'Pro', monthlyPrice: 49900, yearlyPrice: 499000, currency: 'usd' };
  assert.deepEqual(BillingService.snapshotOf(plan, 'MONTHLY'), { planName: 'Pro', unitAmount: 49900, currency: 'usd' });
  assert.deepEqual(BillingService.snapshotOf(plan, 'YEARLY'), { planName: 'Pro', unitAmount: 499000, currency: 'usd' });
});
