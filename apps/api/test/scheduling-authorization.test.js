import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAuthorization } from '../src/modules/scheduling/scheduling.rules.js';

/**
 * Backend authorization gates for booking (independent of the frontend).
 * These pin the reject/accept behavior the UI relies on but must never trust.
 */

const DAY = 24 * 60 * 60 * 1000;
const base = () => ({
  clientId: 'child-A',
  status: 'ACTIVE',
  startDate: new Date(Date.now() - 30 * DAY),
  endDate: new Date(Date.now() + 30 * DAY),
  authorizedUnits: 100,
  usedUnits: 10,
});
const window = () => ({ clientId: 'child-A', startAt: new Date(), endAt: new Date(Date.now() + 60 * 60 * 1000), units: 4 });

test('5 — a valid authorization is accepted', () => {
  assert.doesNotThrow(() => validateAuthorization(base(), window()));
});

test('8 — wrong-child authorization is rejected', () => {
  assert.throws(() => validateAuthorization(base(), { ...window(), clientId: 'child-B' }), (e) => e.code === 'AUTHORIZATION_INVALID');
});

test('9 — a missing authorization (e.g. cross-tenant lookup miss) is rejected', () => {
  // findAuthorizationById is tenant-scoped, so a cross-tenant id resolves to
  // null here — which must reject, never fall through.
  assert.throws(() => validateAuthorization(null, window()), (e) => e.code === 'AUTHORIZATION_INVALID');
});

test('6 — an expired / non-active authorization is rejected', () => {
  assert.throws(() => validateAuthorization({ ...base(), status: 'EXPIRED' }, window()), (e) => e.code === 'AUTHORIZATION_INVALID');
});

test('6b — a booking outside the authorization date window is rejected', () => {
  const auth = { ...base(), endDate: new Date(Date.now() - DAY) }; // ended yesterday
  assert.throws(() => validateAuthorization(auth, window()), (e) => e.code === 'AUTHORIZATION_INVALID');
});

test('7 — an exhausted authorization (insufficient remaining units) is rejected', () => {
  const auth = { ...base(), authorizedUnits: 12, usedUnits: 10 }; // 2 remaining
  assert.throws(() => validateAuthorization(auth, { ...window(), units: 4 }), (e) => e.code === 'AUTHORIZATION_EXHAUSTED');
});

test('7b — remaining exactly equal to requested units is allowed', () => {
  const auth = { ...base(), authorizedUnits: 14, usedUnits: 10 }; // 4 remaining
  assert.doesNotThrow(() => validateAuthorization(auth, { ...window(), units: 4 }));
});
