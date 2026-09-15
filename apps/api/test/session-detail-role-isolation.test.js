import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionsService } from '../src/modules/sessions/sessions.service.js';

/**
 * Spec §7–§14 — Session Detail is role-scoped SERVER-SIDE. A clinician viewing
 * their OWN session never receives the other clinician's identity; a tenant-wide
 * admin (oversight) sees both. Enforced in the response, not by hiding in React.
 */
function makeService(ownerStaffProfileId) {
  const session = {
    id: 's-1', appointmentId: 'ap-1', clientId: 'c-1', staffProfileId: ownerStaffProfileId,
    status: 'FROZEN', startedAt: new Date('2026-09-08T10:55:24Z'), endedAt: new Date('2026-09-08T10:56:08Z'),
    clockInAt: new Date('2026-09-08T10:55:24Z'), clockOutAt: new Date('2026-09-08T10:56:08Z'),
    selectedAuthorizationId: 'svc:auth-1', sensitive: { narrative: 'sealed' },
  };
  return new SessionsService({
    repository: { findSessionById: async () => session, listDataPoints: async () => [] },
    appointments: { findById: async () => ({ id: 'ap-1', startAt: new Date('2026-09-08T17:30:00Z'), endAt: new Date('2026-09-08T18:30:00Z'), bcbaId: 'bcba-1', rbtId: 'rbt-1', units: 4, authorizationIds: ['svc:auth-1'] }) },
    clients: { findById: async (_t, id) => (id === 'c-1' ? { id, firstName: 'H', lastName: 'Y' } : null) },
    staff: { findById: async (_t, id) => ({ 'bcba-1': { firstName: 'jackie', lastName: 'more' }, 'rbt-1': { firstName: 'test', lastName: 'k' } }[id] ?? null) },
    authorizations: { resolveMany: async (_t, ids) => ids.map((id) => ({ id, label: 'FBA — 866' })) },
    timeRecords: { findBySession: async () => ({ workedMinutes: 0, amount: 0, currency: 'usd' }) },
    phi: { open: () => 'note' },
  });
}
// A restricted (clinician) scope: not tenant-wide.
const RBT_SCOPE = { scope: 'SELF', staffProfileId: 'rbt-1', clientIds: ['c-1'], staffIds: ['rbt-1'] };
const BCBA_SCOPE = { scope: 'TEAM', staffProfileId: 'bcba-1', clientIds: ['c-1'], staffIds: ['bcba-1'] };
const ADMIN_SCOPE = { scope: 'ORGANIZATION', staffProfileId: null, clientIds: null, staffIds: null };

test('§8/§9 — RBT viewing their own session does NOT receive the BCBA identity', async () => {
  const svc = makeService('rbt-1');
  const res = await svc.getSession({ tenantId: 't', sessionId: 's-1', actorScope: RBT_SCOPE });
  assert.equal(res.display.childName, 'H Y');
  assert.equal(res.display.rbtName, 'test k');   // own role visible
  assert.equal(res.display.bcbaName, null);       // BCBA hidden
  assert.equal(res.appointment.bcbaId, null);     // no BCBA id leaked
  assert.equal(res.appointment.rbtId, 'rbt-1');
  // "jackie more" (the BCBA) must not appear anywhere in the response.
  assert.ok(!JSON.stringify(res).includes('jackie'));
});

test('BCBA (clinical lead) viewing their own session sees the assigned RBT', async () => {
  const svc = makeService('bcba-1');
  const res = await svc.getSession({ tenantId: 't', sessionId: 's-1', actorScope: BCBA_SCOPE });
  assert.equal(res.display.bcbaName, 'jackie more');
  assert.equal(res.display.rbtName, 'test k');
  assert.equal(res.appointment.rbtId, 'rbt-1');
});

test('BCBA: a BCBA-only appointment names the child’s active RBT assignment; none assigned → null', async () => {
  const build = (rbtIds) => {
    const svc = makeService('bcba-1');
    svc.deps.appointments = { findById: async () => ({ id: 'ap-1', startAt: new Date('2026-09-08T17:30:00Z'), endAt: new Date('2026-09-08T18:30:00Z'), bcbaId: 'bcba-1', rbtId: null, units: 4, authorizationIds: [] }) };
    svc.deps.careTeam = { activeRbtIds: async (_t, clientId) => (clientId === 'c-1' ? rbtIds : []) };
    return svc;
  };
  const withRbt = await build(['rbt-1']).getSession({ tenantId: 't', sessionId: 's-1', actorScope: BCBA_SCOPE });
  assert.equal(withRbt.display.rbtName, 'test k');
  const none = await build([]).getSession({ tenantId: 't', sessionId: 's-1', actorScope: BCBA_SCOPE });
  assert.equal(none.display.rbtName, null);
});

test('RBT viewing a session never receives the BCBA identity, even with a care-team lookup available', async () => {
  const svc = makeService('rbt-1');
  svc.deps.careTeam = { activeRbtIds: async () => ['rbt-1'] };
  const res = await svc.getSession({ tenantId: 't', sessionId: 's-1', actorScope: RBT_SCOPE });
  assert.equal(res.display.bcbaName, null);
  assert.ok(!JSON.stringify(res).includes('jackie'));
});

test('§11 — Company Admin (tenant-wide) oversight sees BOTH clinicians', async () => {
  const svc = makeService('rbt-1');
  const res = await svc.getSession({ tenantId: 't', sessionId: 's-1', actorScope: ADMIN_SCOPE });
  assert.equal(res.display.bcbaName, 'jackie more');
  assert.equal(res.display.rbtName, 'test k');
});

test('legacy/internal call with no scope keeps both (back-compat)', async () => {
  const svc = makeService('rbt-1');
  const res = await svc.getSession({ tenantId: 't', sessionId: 's-1' });
  assert.equal(res.display.bcbaName, 'jackie more');
  assert.equal(res.display.rbtName, 'test k');
});
