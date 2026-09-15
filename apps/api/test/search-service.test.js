import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SearchService } from '../src/modules/search/search.service.js';

const ALL_PERMS = ['clients.read', 'staff.read', 'scheduling.read', 'documents.read', 'claims.read'];

// Fake repository records the (tenantId, entityKey) pairs it was asked to query,
// so tests can assert exactly which entities were searched and with which tenant.
function makeService(over = {}) {
  const queried = [];
  const repository = {
    async searchEntity(tenantId, entityKey, opts) {
      queried.push({ tenantId, entityKey, opts, op: 'search' });
      return { type: entityKey, items: [{ id: `${entityKey}-1`, type: entityKey.replace(/s$/, ''), label: 'X' }], nextCursor: null, hasMore: false };
    },
    async countEntity(tenantId, entityKey) {
      queried.push({ tenantId, entityKey, op: 'count' });
      return 1;
    },
    ...over,
  };
  return { service: new SearchService({ repository }), queried };
}

test('global search only queries entities the caller can read', async () => {
  const { service, queried } = makeService();
  const res = await service.search({ tenantId: 't1', permissions: ['clients.read'], term: 'a' });
  const searchedTypes = res.searchedTypes;
  assert.deepEqual(searchedTypes, ['clients']);
  // Repository was never asked to search staff/claims/etc.
  const entities = new Set(queried.map((q) => q.entityKey));
  assert.deepEqual([...entities], ['clients']);
});

test('global search with all perms searches all entities and aggregates counts', async () => {
  const { service } = makeService();
  const res = await service.search({ tenantId: 't1', permissions: ALL_PERMS, term: 'smith' });
  assert.equal(res.searchedTypes.length, 5);
  assert.equal(res.totalCount, 5); // 1 per entity from the fake
  assert.equal(res.groups.length, 5);
});

test('no read permissions → no entities queried, empty result (no leak)', async () => {
  const { service, queried } = makeService();
  const res = await service.search({ tenantId: 't1', permissions: [], term: 'x' });
  assert.deepEqual(res.searchedTypes, []);
  assert.equal(res.totalCount, 0);
  assert.equal(queried.length, 0);
});

test('every repository call receives the server-supplied tenantId (never client)', async () => {
  const { service, queried } = makeService();
  await service.search({ tenantId: 'TENANT-SERVER', permissions: ALL_PERMS, term: 'a' });
  assert.ok(queried.length > 0);
  assert.ok(queried.every((q) => q.tenantId === 'TENANT-SERVER'));
});

test('requesting a specific authorized type limits the search to it', async () => {
  const { service } = makeService();
  const res = await service.search({ tenantId: 't1', permissions: ALL_PERMS, term: 'a', types: ['documents'] });
  assert.deepEqual(res.searchedTypes, ['documents']);
});

test('requesting an unauthorized type omits it silently', async () => {
  const { service } = makeService();
  // Holds documents.read but requests claims → claims omitted, no error.
  const res = await service.search({ tenantId: 't1', permissions: ['documents.read'], term: 'a', types: ['documents', 'claims'] });
  assert.deepEqual(res.searchedTypes, ['documents']);
});

test('searchOne enforces authorization and returns empty for unauthorized entity', async () => {
  const { service, queried } = makeService();
  const res = await service.searchOne({ tenantId: 't1', permissions: ['clients.read'], entityKey: 'claims', term: 'x' });
  assert.deepEqual(res.items, []);
  assert.equal(res.count, 0);
  assert.equal(queried.length, 0); // never queried claims
});

test('searchOne pages an authorized entity with cursor + limit', async () => {
  const { service, queried } = makeService();
  await service.searchOne({ tenantId: 't1', permissions: ['clients.read'], entityKey: 'clients', term: 'a', limit: 50, cursor: 'c123' });
  const call = queried.find((q) => q.op === 'search');
  assert.equal(call.opts.limit, 50);
  assert.equal(call.opts.cursor, 'c123');
});

test('malformed/absent term still works when filters drive the search', async () => {
  const { service } = makeService();
  const res = await service.search({ tenantId: 't1', permissions: ['claims.read'], term: undefined, types: ['claims'], filtersByType: { claims: { status: 'PAID' } } });
  assert.equal(res.searchedTypes[0], 'claims');
  assert.equal(res.term, null);
});
