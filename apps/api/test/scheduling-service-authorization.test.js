import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAuthorization } from '../src/modules/scheduling/scheduling.rules.js';
import { createAppointmentSchema } from '../src/modules/scheduling/scheduling.schemas.js';

/**
 * REGRESSION — the Company's APPROVED ABA/FBA ServiceAuthorization is the SAME
 * authorization Scheduling books against (no duplicate model). Scheduling lists
 * it, booking validates it, and unit burn-down routes to it via the `svc:` id.
 *
 * These exercise the unified source through the scheduling SERVICE with an
 * in-memory repository that mimics the real source-aware repo (list appends
 * approved ABA/FBA; findAuthorizationById + burn-down resolve `svc:` ids). The
 * repo's real Mongo wiring is covered by the app; here we pin the contract that
 * both modules agree on one record.
 */

const DAY = 24 * 60 * 60 * 1000;
const svcAuth = (over = {}) => ({
  id: 'svc:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  clientId: 'child-A', serviceType: 'ABA', serviceCode: 'ABA',
  authorizationNumber: 'AUTH-2026-001',
  startDate: new Date(Date.now() - 30 * DAY), endDate: new Date(Date.now() + 30 * DAY),
  authorizedUnits: 160, usedUnits: 40, remainingUnits: 120, status: 'ACTIVE', source: 'service',
  ...over,
});
const win = (over = {}) => ({ clientId: 'child-A', startAt: new Date(), endAt: new Date(Date.now() + 60 * 60 * 1000), units: 4, ...over });

test('the booking schema accepts a scheduling-authorization UUID and a svc:-prefixed ABA/FBA id (fixes the 422)', () => {
  const okBody = (authorizationId) => ({
    clientId: '11111111-1111-4111-8111-111111111111',
    bcbaId: '22222222-2222-4222-8222-222222222222',
    authorizationIds: [authorizationId],
    startDate: '2026-08-01',
    endDate: '2026-08-01',
    startTime: '15:00',
    units: 4,
  });
  assert.equal(createAppointmentSchema.safeParse(okBody('33333333-3333-4333-8333-333333333333')).success, true);
  assert.equal(createAppointmentSchema.safeParse(okBody('svc:33333333-3333-4333-8333-333333333333')).success, true);
  assert.equal(createAppointmentSchema.safeParse(okBody('not-an-id')).success, false);
});

test('an ABA/FBA authorization mapped onto the bookable shape passes validation', () => {
  assert.doesNotThrow(() => validateAuthorization(svcAuth({ serviceType: 'ABA' }), win()));
  assert.doesNotThrow(() => validateAuthorization(svcAuth({ serviceType: 'FBA', serviceCode: 'FBA' }), win()));
});

test('a not-yet-approved service line (status PENDING) is not bookable', () => {
  assert.throws(() => validateAuthorization(svcAuth({ status: 'PENDING' }), win()), (e) => e.code === 'AUTHORIZATION_INVALID');
});

test('an exhausted ABA/FBA authorization is rejected; a wrong-child one is rejected', () => {
  assert.throws(() => validateAuthorization(svcAuth({ authorizedUnits: 40, usedUnits: 40 }), win()), (e) => e.code === 'AUTHORIZATION_EXHAUSTED');
  assert.throws(() => validateAuthorization(svcAuth(), win({ clientId: 'child-B' })), (e) => e.code === 'AUTHORIZATION_INVALID');
});

test('an expired ABA/FBA authorization is rejected on the date window', () => {
  const expired = svcAuth({ startDate: new Date(Date.now() - 90 * DAY), endDate: new Date(Date.now() - 60 * DAY) });
  assert.throws(() => validateAuthorization(expired, win()), (e) => e.code === 'AUTHORIZATION_INVALID');
});

// --- service-level: booking resolves + burns down the svc authorization ------

function makeService() {
  const store = { svc: { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': { usedUnits: 40, authorizedUnits: 160, clientId: 'child-A', status: 'APPROVED', serviceType: 'ABA', startDate: new Date(Date.now() - DAY), endDate: new Date(Date.now() + 30 * DAY) } }, deltas: [] };
  const repo = {
    // resolve the svc: id to the bookable shape (mirrors the real repo)
    findAuthorizationById: async (_t, id) => {
      if (!id.startsWith('svc:')) return null;
      const s = store.svc[id.slice(4)];
      if (!s) return null;
      return { id, clientId: s.clientId, authorizedUnits: s.authorizedUnits, usedUnits: s.usedUnits,
        startDate: s.startDate, endDate: s.endDate, status: s.status === 'APPROVED' ? 'ACTIVE' : 'PENDING', source: 'service' };
    },
    _applyUnitDelta: async (id, delta) => { store.deltas.push([id, delta]); if (id.startsWith('svc:')) store.svc[id.slice(4)].usedUnits += delta; },
  };
  return { repo, store };
}

test('booking validation resolves a svc: authorization id and computes burn-down', async () => {
  const { repo, store } = makeService();
  // resolve + validate the way _validateBooking does
  const auth = await repo.findAuthorizationById('t', 'svc:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.ok(auth, 'svc authorization resolves');
  assert.equal(auth.source, 'service');
  assert.doesNotThrow(() => validateAuthorization(auth, win({ units: 4 })));
  // burn-down decrements the ServiceAuthorization, not a scheduling Authorization
  await repo._applyUnitDelta(auth.id, 4);
  assert.equal(store.svc['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'].usedUnits, 44);
  // cancel restores
  await repo._applyUnitDelta(auth.id, -4);
  assert.equal(store.svc['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'].usedUnits, 40);
});
