import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientsService } from '../src/modules/clients/clients.service.js';
import { validateAuthorization } from '../src/modules/scheduling/scheduling.rules.js';
import {
  serviceAuthToBookable, serviceAuthIdOf, isServiceAuthId, bookableIdForServiceAuth,
} from '../src/modules/scheduling/authAdapter.js';

/**
 * REGRESSION — ONE authoritative bookable authorization.
 *
 * The child-authorization path (ClientsService.createServiceAuthorization +
 * approve) and the scheduling inline-create path both write the SAME model
 * (ServiceAuthorization). This test shares ONE in-memory ServiceAuthorization
 * collection between the two sides and proves the identity is real, not a
 * prefixed copy:
 *   - the id scheduling books (svc:<_id>) strips to the exact row _id the child
 *     path created;
 *   - resolving + burning down through the scheduling side mutates THAT SAME
 *     row (usedUnits changes on the record the child created).
 */

const DAY = 24 * 60 * 60 * 1000;

// One shared collection, keyed by _id — the single source of truth.
function sharedServiceAuthStore() {
  const rows = new Map();
  let seq = 0;
  return {
    rows,
    // Mirrors clients.repository ServiceAuthorization methods the service uses.
    findServiceAuthorization: async (_t, clientId, serviceType) =>
      [...rows.values()].find((r) => r.clientId === clientId && r.serviceType === serviceType && !r.deletedAt) ?? null,
    findServiceAuthorizationByNumber: async (_t, clientId, num) =>
      [...rows.values()].find((r) => r.clientId === clientId && r.authorizationNumber === num && !r.deletedAt) ?? null,
    createServiceAuthorization: async (_t, doc) => { const _id = `sa-${(seq += 1)}`; const row = { _id, ...doc, usedUnits: 0, version: 0 }; rows.set(_id, row); return { id: _id, ...row }; },
    findServiceAuthorizationById: async (_t, id) => rows.get(id) ?? null,
    updateServiceAuthorization: async (_t, id, patch) => { Object.assign(rows.get(id), patch); return { id, ...rows.get(id) }; },
    // Mirrors scheduling.repository resolution + burn-down against the SAME map.
    schedFindAuthorizationById: async (id) => { if (!isServiceAuthId(id)) return null; const row = rows.get(serviceAuthIdOf(id)); return row ? serviceAuthToBookable(row) : null; },
    schedApplyUnitDelta: async (id, delta) => { const row = rows.get(serviceAuthIdOf(id)); if (row) row.usedUnits = Math.max(0, (row.usedUnits ?? 0) + delta); },
  };
}

function makeClientsService(store) {
  const repo = {
    findClientById: async () => ({ id: 'child-A', status: 'ACTIVE' }),
    listGuardians: async () => [{ id: 'g-1', firstName: 'Jane', lastName: 'Parent', phone: '5551234567', email: 'jane@example.com' }],
    findServiceAuthorization: store.findServiceAuthorization,
    findServiceAuthorizationByNumber: store.findServiceAuthorizationByNumber,
    createServiceAuthorization: store.createServiceAuthorization,
    findServiceAuthorizationById: store.findServiceAuthorizationById,
    updateServiceAuthorization: store.updateServiceAuthorization,
  };
  return new ClientsService({ repository: repo, organizations: { getById: async () => ({ state: 'ACTIVE' }) }, phi: { seal: (v) => v, open: (v) => v } });
}

test('child-created ABA authorization is the SAME record scheduling books (DB identity, not a copy)', async () => {
  const store = sharedServiceAuthStore();
  const svc = makeClientsService(store);

  // 1) Child path: create ABA authorization, then approve it via the workflow.
  const created = await svc.createServiceAuthorization({
    tenantId: 't', clientId: 'child-A', actorUserId: 'admin',
    input: { serviceType: 'ABA', authorizationNumber: 'AUTH-1', startDate: new Date(Date.now() - DAY).toISOString(), endDate: new Date(Date.now() + 30 * DAY).toISOString(), units: 160 },
  });
  await svc.transitionServiceAuthorization({ tenantId: 't', clientId: 'child-A', authorizationId: created.id, actorUserId: 'admin', target: 'SENT' });
  await svc.transitionServiceAuthorization({ tenantId: 't', clientId: 'child-A', authorizationId: created.id, actorUserId: 'admin', target: 'APPROVED' });

  const childRowId = created.id; // the ServiceAuthorization._id
  assert.equal(store.rows.get(childRowId).status, 'APPROVED');

  // 2) Scheduling side: the bookable id it offers strips to the SAME _id.
  const bookable = await store.schedFindAuthorizationById(bookableIdForServiceAuth(childRowId));
  assert.ok(bookable, 'scheduling resolves the child-created authorization');
  assert.equal(serviceAuthIdOf(bookable.id), childRowId, 'scheduling id carries the real ServiceAuthorization._id');
  assert.equal(bookable.serviceType, 'ABA');
  assert.equal(bookable.status, 'ACTIVE'); // APPROVED → bookable

  // 3) Booking validates + burns down THAT SAME row.
  assert.doesNotThrow(() => validateAuthorization(bookable, { clientId: 'child-A', startAt: new Date(), endAt: new Date(Date.now() + 3600e3), units: 4 }));
  await store.schedApplyUnitDelta(bookable.id, 4);
  assert.equal(store.rows.get(childRowId).usedUnits, 4, 'burn-down mutated the child-created record itself');

  // 4) There is exactly ONE record — no duplicate authorization was created.
  assert.equal(store.rows.size, 1);
});

test('scheduling never invents a second record: only the child-created ABA/FBA rows are surfaced', async () => {
  const store = sharedServiceAuthStore();
  const svc = makeClientsService(store);
  const mk = async (serviceType) => {
    const c = await svc.createServiceAuthorization({ tenantId: 't', clientId: 'child-A', actorUserId: 'a', input: { serviceType, startDate: new Date(Date.now() - DAY).toISOString(), endDate: new Date(Date.now() + DAY).toISOString(), units: 100 } });
    await svc.transitionServiceAuthorization({ tenantId: 't', clientId: 'child-A', authorizationId: c.id, actorUserId: 'a', target: 'SENT' });
    await svc.transitionServiceAuthorization({ tenantId: 't', clientId: 'child-A', authorizationId: c.id, actorUserId: 'a', target: 'APPROVED' });
    return c.id;
  };
  const abaId = await mk('ABA');
  const fbaId = await mk('FBA');
  // Both ABA and FBA present as bookable, each carrying its own real _id.
  const aba = await store.schedFindAuthorizationById(bookableIdForServiceAuth(abaId));
  const fba = await store.schedFindAuthorizationById(bookableIdForServiceAuth(fbaId));
  assert.equal(serviceAuthIdOf(aba.id), abaId);
  assert.equal(serviceAuthIdOf(fba.id), fbaId);
  assert.equal(store.rows.size, 2); // exactly the two the child path created
});
