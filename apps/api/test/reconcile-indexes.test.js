import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __testables } from '../src/config/reconcileIndexes.js';

/**
 * ---------------------------------------------------------------------------
 * INDEX RECONCILIATION LOGIC — spec Fix 1, Parts 9 & 30 (#15, #16).
 *
 * A corrected schema does not repair a running database: Mongoose autoIndex
 * never drops an obsolete index. reconcileIndexes() is what actually removes the
 * stale unique { tenantId, clientId, serviceType } index (which capped a child
 * at one ABA + one FBA) and the broken single-field unique indexes.
 *
 * There is no live MongoDB in this environment, so these tests drive the drop
 * helpers against a FAKE collection that records dropIndex calls. That proves
 * the logic that decides WHAT to drop:
 *   - the obsolete compound unique index IS dropped (by exact key shape);
 *   - it is dropped only when unique — a non-unique index of the same shape is
 *     kept (the corrected index);
 *   - a partial-unique single-field index is kept; only the broken non-partial
 *     unique one is dropped;
 *   - running again after the drop is a no-op (idempotent).
 * The behaviour against a real cluster additionally needs a live DB — see the
 * final report's "Remaining limitations".
 * ---------------------------------------------------------------------------
 */

const { dropBrokenUnique, dropCompoundUnique, dropCappingServiceTypeUnique } = __testables;

/** A fake mongo collection over a mutable index list, recording drops. */
function fakeCollection(indexes) {
  const dropped = [];
  return {
    dropped,
    // The real driver returns a CURSOR synchronously; .toArray() is the async part.
    listIndexes() {
      return { toArray: async () => indexes };
    },
    async dropIndex(name) {
      dropped.push(name);
      const i = indexes.findIndex((ix) => ix.name === name);
      if (i >= 0) indexes.splice(i, 1);
    },
  };
}

/** Temporarily point the shared mongoose singleton's db at a fake. */
async function withFakeDb(collectionsByName, fn) {
  const { mongoose } = await import('../src/config/db.js');
  const original = mongoose.connection.db;
  mongoose.connection.db = { collection: (name) => collectionsByName[name] };
  try {
    return await fn();
  } finally {
    mongoose.connection.db = original;
  }
}

test('drops the obsolete compound UNIQUE (tenantId, clientId, serviceType) index', async () => {
  const coll = fakeCollection([
    { name: '_id_', key: { _id: 1 } },
    { name: 'tenantId_1_clientId_1_serviceType_1', key: { tenantId: 1, clientId: 1, serviceType: 1 }, unique: true },
    { name: 'tenantId_1_clientId_1_authorizationNumber_1', key: { tenantId: 1, clientId: 1, authorizationNumber: 1 }, unique: true, partialFilterExpression: { authorizationNumber: { $type: 'string' } } },
  ]);
  await withFakeDb({ serviceauthorizations: coll }, () =>
    dropCompoundUnique('serviceauthorizations', { tenantId: 1, clientId: 1, serviceType: 1 }),
  );
  assert.deepEqual(coll.dropped, ['tenantId_1_clientId_1_serviceType_1']);
  // The partial-unique authorizationNumber index (the real duplicate guard) is untouched.
  assert.ok(coll.dropped.every((n) => !n.includes('authorizationNumber')));
});

test('keeps a NON-unique (tenantId, clientId, serviceType) index — the corrected shape', async () => {
  const coll = fakeCollection([
    { name: '_id_', key: { _id: 1 } },
    { name: 'tenantId_1_clientId_1_serviceType_1', key: { tenantId: 1, clientId: 1, serviceType: 1 } }, // not unique
  ]);
  await withFakeDb({ serviceauthorizations: coll }, () =>
    dropCompoundUnique('serviceauthorizations', { tenantId: 1, clientId: 1, serviceType: 1 }),
  );
  assert.deepEqual(coll.dropped, [], 'the non-unique corrected index must be preserved');
});

test('is idempotent: a second run after the drop changes nothing', async () => {
  const coll = fakeCollection([
    { name: '_id_', key: { _id: 1 } },
    { name: 'tenantId_1_clientId_1_serviceType_1', key: { tenantId: 1, clientId: 1, serviceType: 1 }, unique: true },
  ]);
  await withFakeDb({ serviceauthorizations: coll }, async () => {
    await dropCompoundUnique('serviceauthorizations', { tenantId: 1, clientId: 1, serviceType: 1 });
    await dropCompoundUnique('serviceauthorizations', { tenantId: 1, clientId: 1, serviceType: 1 });
  });
  assert.deepEqual(coll.dropped, ['tenantId_1_clientId_1_serviceType_1'], 'exactly one drop across two runs');
});

test('dropBrokenUnique removes a non-partial single-field unique index but keeps the partial one', async () => {
  const coll = fakeCollection([
    { name: '_id_', key: { _id: 1 } },
    { name: 'customDomain_1_broken', key: { customDomain: 1 }, unique: true }, // broken: unique, not partial
  ]);
  await withFakeDb({ organization: coll }, () => dropBrokenUnique('organization', 'customDomain'));
  assert.deepEqual(coll.dropped, ['customDomain_1_broken']);

  const coll2 = fakeCollection([
    { name: '_id_', key: { _id: 1 } },
    { name: 'customDomain_1_partial', key: { customDomain: 1 }, unique: true, partialFilterExpression: { customDomain: { $type: 'string' } } },
  ]);
  await withFakeDb({ organization: coll2 }, () => dropBrokenUnique('organization', 'customDomain'));
  assert.deepEqual(coll2.dropped, [], 'the corrected partial-unique index must be preserved');
});

test('a missing collection is skipped without throwing', async () => {
  const throwingColl = {
    listIndexes() { return { toArray: async () => { throw new Error('ns not found'); } }; },
    async dropIndex() { throw new Error('should not be called'); },
  };
  await withFakeDb({ serviceauthorizations: throwingColl }, async () => {
    await assert.doesNotReject(() =>
      dropCompoundUnique('serviceauthorizations', { tenantId: 1, clientId: 1, serviceType: 1 }),
    );
  });
});

/**
 * ---------------------------------------------------------------------------
 * SHAPE-INDEPENDENT CAPPING-INDEX DROP — spec Parts 6, 7, 8.
 *
 * dropCompoundUnique matches ONE exact key ordering. A live cluster migrated
 * across older builds can carry the capping unique constraint in a different
 * order, without the tenant prefix, or with an extra field — every one of those
 * still limits a child to one ABA + one FBA. dropCappingServiceTypeUnique drops
 * ANY unique index whose key contains `serviceType` but not `authorizationNumber`
 * (the shape-independent definition of "caps the service line"), and preserves
 * the legitimate partial-unique authorizationNumber index, every non-unique
 * index, and _id_.
 * ---------------------------------------------------------------------------
 */
test('drops a differently-ORDERED capping unique index (serviceType first)', async () => {
  const coll = fakeCollection([
    { name: '_id_', key: { _id: 1 } },
    { name: 'serviceType_1_clientId_1_tenantId_1', key: { serviceType: 1, clientId: 1, tenantId: 1 }, unique: true },
    { name: 'tenantId_1_clientId_1_authorizationNumber_1', key: { tenantId: 1, clientId: 1, authorizationNumber: 1 }, unique: true, partialFilterExpression: { authorizationNumber: { $type: 'string' } } },
  ]);
  await withFakeDb({ serviceauthorizations: coll }, () => dropCappingServiceTypeUnique('serviceauthorizations'));
  assert.deepEqual(coll.dropped, ['serviceType_1_clientId_1_tenantId_1']);
});

test('drops a tenant-less {clientId, serviceType} capping unique index', async () => {
  const coll = fakeCollection([
    { name: '_id_', key: { _id: 1 } },
    { name: 'clientId_1_serviceType_1', key: { clientId: 1, serviceType: 1 }, unique: true },
  ]);
  await withFakeDb({ serviceauthorizations: coll }, () => dropCappingServiceTypeUnique('serviceauthorizations'));
  assert.deepEqual(coll.dropped, ['clientId_1_serviceType_1']);
});

test('preserves the partial-unique authorizationNumber index and every non-unique index', async () => {
  const coll = fakeCollection([
    { name: '_id_', key: { _id: 1 } },
    // legitimate duplicate guard — includes authorizationNumber → kept
    { name: 'tenantId_1_clientId_1_authorizationNumber_1', key: { tenantId: 1, clientId: 1, authorizationNumber: 1 }, unique: true, partialFilterExpression: { authorizationNumber: { $type: 'string' } } },
    // corrected non-unique lookup index — not unique → kept
    { name: 'tenantId_1_clientId_1_serviceType_1', key: { tenantId: 1, clientId: 1, serviceType: 1 } },
    { name: 'tenantId_1_clientId_1_status_1', key: { tenantId: 1, clientId: 1, status: 1 } },
  ]);
  await withFakeDb({ serviceauthorizations: coll }, () => dropCappingServiceTypeUnique('serviceauthorizations'));
  assert.deepEqual(coll.dropped, [], 'nothing legitimate may be dropped');
});

test('capping-index drop is idempotent and never touches _id_', async () => {
  const coll = fakeCollection([
    { name: '_id_', key: { _id: 1 } },
    { name: 'tenantId_1_clientId_1_serviceType_1', key: { tenantId: 1, clientId: 1, serviceType: 1 }, unique: true },
  ]);
  await withFakeDb({ serviceauthorizations: coll }, async () => {
    await dropCappingServiceTypeUnique('serviceauthorizations');
    await dropCappingServiceTypeUnique('serviceauthorizations');
  });
  assert.deepEqual(coll.dropped, ['tenantId_1_clientId_1_serviceType_1'], 'exactly one drop across two runs; _id_ untouched');
});
