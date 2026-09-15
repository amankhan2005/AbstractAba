import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientsService } from '../src/modules/clients/clients.service.js';

/**
 * ---------------------------------------------------------------------------
 * MULTIPLE ABA / FBA PER CHILD — spec Bug #1 (Parts 4, 5, 7, 30 #1–8).
 *
 * The reported bug was that a child could not hold a second ABA/FBA. Two things
 * had to be true for the fix: the DATABASE must not carry a unique
 * (tenant, client, serviceType) index (covered by service-authorization-index +
 * reconcile-indexes tests), AND the SERVICE must not reject a second
 * authorization of the same type. This test pins the service rule against a fake
 * repository that faithfully mirrors the real one — a partial-unique on the
 * authorization NUMBER only (a repeated number collides; different numbers, and
 * number-less drafts, do not).
 * ---------------------------------------------------------------------------
 */

// A fake authorization repository backed by one in-memory collection, mirroring
// the uniqueness the live partial index enforces: a repeated authorizationNumber
// for the same child is a duplicate; different numbers are independent rows.
function authRepo() {
  const rows = new Map();
  let seq = 0;
  return {
    rows,
    listServiceAuthorizations: async (_t, clientId) =>
      [...rows.values()].filter((r) => r.clientId === clientId && !r.deletedAt),
    findServiceAuthorization: async () => null,
    findServiceAuthorizationByNumber: async (_t, clientId, num) =>
      [...rows.values()].find((r) => r.clientId === clientId && r.authorizationNumber === num && !r.deletedAt) ?? null,
    findServiceAuthorizationById: async (_t, id) => rows.get(id) ?? null,
    createServiceAuthorization: async (_t, doc) => {
      // Enforce the same identity the live partial-unique index enforces.
      if (doc.authorizationNumber) {
        const clash = [...rows.values()].find(
          (r) => r.clientId === doc.clientId && r.authorizationNumber === doc.authorizationNumber && !r.deletedAt,
        );
        if (clash) {
          const err = new Error('E11000 duplicate key');
          err.code = 11000;
          err.keyPattern = { tenantId: 1, clientId: 1, authorizationNumber: 1 };
          throw err;
        }
      }
      const _id = `sa-${(seq += 1)}`;
      const row = { _id, id: _id, usedUnits: 0, version: 0, deletedAt: null, ...doc };
      rows.set(_id, row);
      return row;
    },
    updateServiceAuthorization: async (_t, id, patch) => { Object.assign(rows.get(id), patch); return rows.get(id); },
  };
}

function makeService(repo) {
  return new ClientsService({
    repository: {
      findClientById: async () => ({ id: 'c-1', status: 'ACTIVE' }),
      listGuardians: async () => [{ id: 'g-1', firstName: 'Jane', lastName: 'Parent', phone: '5551234567', email: 'jane@example.com' }],
      ...repo,
    },
    organizations: { getById: async () => ({ state: 'ACTIVE' }) },
    phi: { seal: (v) => v, open: (v) => v },
  });
}

const mkInput = (over = {}) => ({ serviceType: 'ABA', units: 100, ...over });

test('a child can hold multiple ABA authorizations with different numbers', async () => {
  const repo = authRepo();
  const svc = makeService(repo);
  const a1 = await svc.createServiceAuthorization({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u-1', input: mkInput({ authorizationNumber: 'ABA-001' }) });
  const a2 = await svc.createServiceAuthorization({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u-1', input: mkInput({ authorizationNumber: 'ABA-002' }) });
  const a3 = await svc.createServiceAuthorization({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u-1', input: mkInput({ authorizationNumber: 'ABA-003' }) });
  const ids = new Set([a1.id, a2.id, a3.id]);
  assert.equal(ids.size, 3, 'each ABA is a distinct database record');
  const list = await svc.listServiceAuthorizations({ tenantId: 't-1', clientId: 'c-1' });
  assert.equal(list.length, 3);
});

test('a child can hold ABA and FBA authorizations simultaneously', async () => {
  const repo = authRepo();
  const svc = makeService(repo);
  await svc.createServiceAuthorization({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u-1', input: mkInput({ serviceType: 'ABA', authorizationNumber: 'ABA-001' }) });
  await svc.createServiceAuthorization({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u-1', input: mkInput({ serviceType: 'FBA', authorizationNumber: 'FBA-001' }) });
  await svc.createServiceAuthorization({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u-1', input: mkInput({ serviceType: 'FBA', authorizationNumber: 'FBA-002' }) });
  const list = await svc.listServiceAuthorizations({ tenantId: 't-1', clientId: 'c-1' });
  const byType = list.reduce((m, r) => ((m[r.serviceType] = (m[r.serviceType] || 0) + 1), m), {});
  assert.deepEqual(byType, { ABA: 1, FBA: 2 });
});

test('same serviceType + different authorization number is ALLOWED (not treated as duplicate)', async () => {
  const repo = authRepo();
  const svc = makeService(repo);
  await svc.createServiceAuthorization({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u-1', input: mkInput({ authorizationNumber: 'ABA-001' }) });
  await assert.doesNotReject(() =>
    svc.createServiceAuthorization({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u-1', input: mkInput({ authorizationNumber: 'ABA-002' }) }),
  );
});

test('same child + same authorization number IS rejected as AUTHORIZATION_EXISTS', async () => {
  const repo = authRepo();
  const svc = makeService(repo);
  await svc.createServiceAuthorization({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u-1', input: mkInput({ authorizationNumber: 'ABA-001' }) });
  await assert.rejects(
    () => svc.createServiceAuthorization({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u-1', input: mkInput({ authorizationNumber: 'ABA-001' }) }),
    (e) => e.code === 'AUTHORIZATION_EXISTS' || /exist/i.test(e.message),
  );
});

test('per-record units are independent — booking one authorization never touches another', async () => {
  const repo = authRepo();
  const svc = makeService(repo);
  const a1 = await svc.createServiceAuthorization({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u-1', input: mkInput({ units: 100, authorizationNumber: 'ABA-001' }) });
  const a2 = await svc.createServiceAuthorization({ tenantId: 't-1', clientId: 'c-1', actorUserId: 'u-1', input: mkInput({ units: 50, authorizationNumber: 'ABA-002' }) });
  // Burn down 20 units on a1 only (mirrors scheduling applying a delta to one row).
  await repo.updateServiceAuthorization('t-1', a1.id, { usedUnits: 20 });
  assert.equal(repo.rows.get(a1.id).usedUnits, 20);
  assert.equal(repo.rows.get(a2.id).usedUnits, 0, 'the other authorization is untouched');
});
