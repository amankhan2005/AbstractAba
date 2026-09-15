import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRecordHash, chainNext, GENESIS_HASH, hashableContent } from '../src/modules/audit/audit.hash.js';

const base = {
  tenantId: '018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b',
  actorId: 'actor-1',
  actorRoleIds: ['r2', 'r1'],
  action: 'organization.update',
  entityType: 'organization',
  entityId: 'org-1',
  outcome: 'SUCCESS',
  payload: { b: 2, a: 1 },
  occurredAt: '2026-07-28T00:00:00.000Z',
};

test('genesis chain starts at sequence 1 with the genesis prev-hash', () => {
  const { sequence, prevHash } = chainNext(null, new Date());
  assert.equal(sequence, 1);
  assert.equal(prevHash, GENESIS_HASH);
});

test('hash is deterministic regardless of payload/role key order', () => {
  const a = computeRecordHash({ ...base, sequence: 1, prevHash: GENESIS_HASH });
  const b = computeRecordHash({ ...base, payload: { a: 1, b: 2 }, actorRoleIds: ['r1', 'r2'], sequence: 1, prevHash: GENESIS_HASH });
  assert.equal(a, b);
});

test('changing any field changes the hash (tamper-evident)', () => {
  const a = computeRecordHash({ ...base, sequence: 1, prevHash: GENESIS_HASH });
  const b = computeRecordHash({ ...base, outcome: 'FAILURE', sequence: 1, prevHash: GENESIS_HASH });
  assert.notEqual(a, b);
});

test('chain links: record N prevHash equals record N-1 hash', () => {
  const first = { ...base, sequence: 1, prevHash: GENESIS_HASH };
  first.hash = computeRecordHash(first);
  const { sequence, prevHash } = chainNext({ sequence: first.sequence, hash: first.hash }, new Date());
  assert.equal(sequence, 2);
  assert.equal(prevHash, first.hash);
});

test('hashableContent excludes mutable/derived fields (id, hash)', () => {
  const c = hashableContent({ ...base, sequence: 1, prevHash: GENESIS_HASH });
  assert.ok(!('id' in c) && !('hash' in c));
});
