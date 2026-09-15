import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAuthorization } from '../src/modules/scheduling/scheduling.rules.js';

/**
 * P0 — POST /v1/scheduling/appointments returned 422 AUTHORIZATION_INVALID for a
 * VALID appointment booked on the LAST day of the authorization window.
 *
 * ABA/FBA authorizations carry a date-only window (e.g. 09/02/2026–09/10/2026)
 * stored at UTC midnight. validateAuthorization compared the appointment's end
 * against the endDate's 00:00 instant, so any same-day session on 09/10 —
 * whose end is 09/10T…:00Z, after 09/10T00:00Z — was rejected as out-of-window.
 * The authorization is valid THROUGH 09/10, so a 09/10 session must be allowed.
 *
 * These assertions FAIL before the boundary fix and PASS after it, and prove the
 * window is not widened (09/11 is still rejected).
 */

// Mirrors the reported record: "hh · ABA · 09/02/2026–09/10/2026 · 4/4u · ACTIVE".
const auth = {
  clientId: 'child-1', status: 'ACTIVE',
  startDate: '2026-09-02', endDate: '2026-09-10',
  authorizedUnits: 4, usedUnits: 0,
};

test('a session ON the last authorized day is valid (was 422 AUTHORIZATION_INVALID)', () => {
  assert.doesNotThrow(() => validateAuthorization(auth, {
    clientId: 'child-1',
    startAt: new Date('2026-09-10T15:00:00Z'),
    endAt: new Date('2026-09-10T16:00:00Z'),
    units: 4,
  }));
});

test('a session on the FIRST authorized day is valid', () => {
  assert.doesNotThrow(() => validateAuthorization(auth, {
    clientId: 'child-1',
    startAt: new Date('2026-09-02T09:00:00Z'),
    endAt: new Date('2026-09-02T10:00:00Z'),
    units: 4,
  }));
});

test('a session AFTER the window is still rejected (fix does not widen the window)', () => {
  assert.throws(() => validateAuthorization(auth, {
    clientId: 'child-1',
    startAt: new Date('2026-09-11T09:00:00Z'),
    endAt: new Date('2026-09-11T10:00:00Z'),
    units: 4,
  }), (e) => e.code === 'AUTHORIZATION_INVALID');
});

test('a session BEFORE the window is still rejected', () => {
  assert.throws(() => validateAuthorization(auth, {
    clientId: 'child-1',
    startAt: new Date('2026-09-01T09:00:00Z'),
    endAt: new Date('2026-09-01T10:00:00Z'),
    units: 4,
  }), (e) => e.code === 'AUTHORIZATION_INVALID');
});
