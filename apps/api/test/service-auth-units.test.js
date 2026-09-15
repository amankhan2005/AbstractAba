import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientsService } from '../src/modules/clients/clients.service.js';

/**
 * Spec Module 6 Parts 5/9 — the authoritative ABA/FBA ServiceAuthorization:
 *   - hours are DERIVED from units on write, so a client cannot persist a
 *     conflicting units/hours pair;
 *   - one record per (child, serviceType) — a second ABA is rejected, not
 *     silently duplicated.
 * DB-free: the repository is a fake capturing what the service would persist.
 */
const fakePhi = { seal: (v) => v, open: (v) => v };

function makeService({ existing = null, repo = {} } = {}) {
  let created = null; let patched = null;
  const base = {
    findClientById: async () => ({ id: 'c-1', status: 'ACTIVE', version: 1, sensitive: { ssn: null } }),
    listGuardians: async () => [{ id: 'g-1', firstName: 'Jane', lastName: 'Parent', phone: '5551234567', email: 'jane@example.com' }],
    findServiceAuthorization: async () => existing, // legacy lookup (unused by new rule)
    findServiceAuthorizationByNumber: async (_t, _c, num) => ((existing && existing.authorizationNumber === num) ? existing : null),
    findServiceAuthorizationById: async () => existing,
    createServiceAuthorization: async (_t, doc) => { created = doc; return { id: 'sa-1', ...doc }; },
    updateServiceAuthorization: async (_t, _id, patch) => { patched = patch; return { id: 'sa-1', clientId: 'c-1', ...patch }; },
    ...repo,
  };
  const svc = new ClientsService({ repository: base, organizations: { getById: async () => ({ state: 'ACTIVE' }) }, phi: fakePhi });
  return { svc, get created() { return created; }, get patched() { return patched; } };
}

test('create derives hours from units (120 units → 30 hours), ignoring any supplied hours', async () => {
  const h = makeService();
  await h.svc.createServiceAuthorization({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { serviceType: 'ABA', units: 120, hours: 999 } });
  assert.equal(h.created.units, 120);
  assert.equal(h.created.hours, 30, 'hours must be derived, not the supplied 999');
});

test('update derives hours from units too — no conflicting pair can persist', async () => {
  const h = makeService({ existing: { id: 'sa-1', clientId: 'c-1', serviceType: 'ABA', status: 'NOT_SENT' } });
  await h.svc.updateServiceAuthorization({ tenantId: 't', clientId: 'c-1', authorizationId: 'sa-1', actorUserId: 'u', input: { units: 40, hours: 7 } });
  assert.equal(h.patched.units, 40);
  assert.equal(h.patched.hours, 10, 'derived 40*15/60 = 10, not the supplied 7');
});

test('multiple ABA authorizations are allowed for the same child (no single-per-service cap)', async () => {
  // An existing ABA with a different number must NOT block a second ABA.
  const h = makeService({ existing: { id: 'sa-1', serviceType: 'ABA', authorizationNumber: 'AUTH-001' } });
  await h.svc.createServiceAuthorization({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { serviceType: 'ABA', authorizationNumber: 'AUTH-002', units: 40 } });
  assert.equal(h.created.serviceType, 'ABA');
  assert.equal(h.created.authorizationNumber, 'AUTH-002', 'a second ABA persists as its own record');
});

test('a DUPLICATE authorization number for the same child is rejected', async () => {
  const h = makeService({ existing: { id: 'sa-1', serviceType: 'ABA', authorizationNumber: 'AUTH-001' } });
  await assert.rejects(
    () => h.svc.createServiceAuthorization({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { serviceType: 'ABA', authorizationNumber: 'AUTH-001', units: 40 } }),
    (e) => e.code === 'AUTHORIZATION_EXISTS',
  );
});

test('a number-less authorization never collides (multiple drafts allowed)', async () => {
  const h = makeService({ existing: { id: 'sa-1', serviceType: 'ABA', authorizationNumber: 'AUTH-001' } });
  await h.svc.createServiceAuthorization({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { serviceType: 'ABA', units: 20 } });
  assert.equal(h.created.authorizationNumber, null);
});

test('archiving one authorization soft-deletes only that record (child+tenant checked)', async () => {
  let deleted = null;
  const h = makeService({
    existing: { id: 'sa-1', clientId: 'c-1', serviceType: 'ABA' },
    repo: { softDeleteServiceAuthorization: async (_t, id) => { deleted = id; return { id, deleted: true }; } },
  });
  await h.svc.archiveServiceAuthorization({ tenantId: 't', clientId: 'c-1', authorizationId: 'sa-1', actorUserId: 'u' });
  assert.equal(deleted, 'sa-1');
});

test('archiving an authorization that belongs to another child is rejected', async () => {
  const h = makeService({ existing: { id: 'sa-1', clientId: 'c-OTHER', serviceType: 'ABA' } });
  await assert.rejects(
    () => h.svc.archiveServiceAuthorization({ tenantId: 't', clientId: 'c-1', authorizationId: 'sa-1', actorUserId: 'u' }),
    (e) => e.code === 'AUTHORIZATION_NOT_FOUND',
  );
});

test('end-before-start dates are rejected on create', async () => {
  const h = makeService();
  await assert.rejects(
    () => h.svc.createServiceAuthorization({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { serviceType: 'FBA', startDate: '2026-12-31', endDate: '2026-01-01' } }),
    (e) => e.code === 'AUTHORIZATION_DATES_INVALID',
  );
});

test('units omitted → hours left null (no fabricated hours)', async () => {
  const h = makeService();
  await h.svc.createServiceAuthorization({ tenantId: 't', clientId: 'c-1', actorUserId: 'u', input: { serviceType: 'FBA' } });
  assert.equal(h.created.units, null);
  assert.equal(h.created.hours, null);
});
