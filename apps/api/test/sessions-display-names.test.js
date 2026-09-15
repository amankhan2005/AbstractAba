import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionsService } from '../src/modules/sessions/sessions.service.js';

/**
 * Session-detail display enrichment (spec §3–§5, §19): GET /v1/sessions/:id must
 * resolve the real child, BCBA and RBT NAMES (never ids) from the existing
 * client/staff repositories, tenant-scoped, and must degrade to nulls — never
 * throw — when a lookup is missing. The session list gets the same additive
 * childName/clinicianName so the review queue shows real people.
 */

function makeService(over = {}) {
  const session = {
    id: 's-1', appointmentId: 'ap-1', clientId: 'c-1', staffProfileId: 'bcba-1',
    status: 'FROZEN', startedAt: new Date('2026-09-04T21:51:12Z'), endedAt: new Date('2026-09-04T22:48:31Z'),
    clockInAt: new Date('2026-09-04T21:51:12Z'), clockOutAt: new Date('2026-09-04T22:48:31Z'),
    selectedAuthorizationId: 'svc:auth-1', sensitive: { narrative: 'sealed' },
  };
  const deps = {
    repository: {
      findSessionById: async () => session,
      listDataPoints: async () => [],
      listSessions: async () => ({ items: [{ id: 's-1', clientId: 'c-1', staffProfileId: 'rbt-1', status: 'FROZEN' }], nextCursor: null }),
    },
    appointments: { findById: async () => ({ id: 'ap-1', startAt: new Date('2026-09-04T21:50:00Z'), endAt: new Date('2026-09-04T22:50:00Z'), bcbaId: 'bcba-1', rbtId: 'rbt-1', units: 4, authorizationIds: ['svc:auth-1'] }) },
    clients: { findById: async (_t, id) => (id === 'c-1' ? { id, firstName: 'Raymond', lastName: 'More', dateOfBirth: '2017-05-01' } : null) },
    staff: { findById: async (_t, id) => ({ 'bcba-1': { firstName: 'Aman', lastName: 'Khan' }, 'rbt-1': { firstName: 'Nia', lastName: 'Patel' } }[id] ?? null) },
    authorizations: { resolveMany: async (_t, ids) => ids.map((id) => ({ id, label: 'ABA Therapy — ABC Insurance' })) },
    timeRecords: { findBySession: async () => ({ workedMinutes: 57, hourlyRateSnapshot: 3000, amount: 2850, currency: 'usd' }) },
    phi: { open: () => 'note' },
    ...over,
  };
  return new SessionsService(deps);
}

test('getSession resolves real child, BCBA and RBT display names (never ids)', async () => {
  const svc = makeService();
  const res = await svc.getSession({ tenantId: 't', sessionId: 's-1' });
  assert.equal(res.display.childName, 'Raymond More');
  assert.equal(res.display.bcbaName, 'Aman Khan');
  assert.equal(res.display.rbtName, 'Nia Patel');
  // the resolved names must not be ids
  for (const v of Object.values(res.display)) assert.ok(!/^(c-1|bcba-1|rbt-1|svc:)/.test(String(v)));
  // authorization resolves to a human label, not a svc: id
  assert.equal(res.appointment.selectedAuthorization.label, 'ABA Therapy — ABC Insurance');
  assert.equal(res.payroll.workedMinutes, 57);
});

test('getSession degrades to null names when lookups are missing — never throws', async () => {
  const svc = makeService({
    clients: { findById: async () => null },
    staff: { findById: async () => null },
  });
  const res = await svc.getSession({ tenantId: 't', sessionId: 's-1' });
  assert.equal(res.display.childName, null);
  assert.equal(res.display.bcbaName, null);
  assert.equal(res.display.rbtName, null);
});

test('getSession still works with NO name ports wired (narrow harness)', async () => {
  const svc = makeService({ clients: undefined, staff: undefined, appointments: undefined, authorizations: undefined, timeRecords: undefined });
  const res = await svc.getSession({ tenantId: 't', sessionId: 's-1' });
  assert.equal(res.session.status, 'FROZEN');
  assert.equal(res.display.childName, null);
});

test('listSessions decorates rows with childName and clinicianName', async () => {
  const svc = makeService();
  const page = await svc.listSessions({ tenantId: 't', limit: 25 });
  assert.equal(page.items[0].childName, 'Raymond More');
  assert.equal(page.items[0].clinicianName, 'Nia Patel');
});
