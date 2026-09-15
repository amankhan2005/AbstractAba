import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_ENTITIES, SEARCHABLE_TYPES, resolveSearchableEntities, buildEntityFilter,
} from '../src/modules/search/search.engine.js';

const ALL_PERMS = ['clients.read', 'staff.read', 'scheduling.read', 'documents.read', 'claims.read'];

test('every searchable entity declares a permission, text fields, and a mapper', () => {
  for (const key of SEARCHABLE_TYPES) {
    const s = SEARCH_ENTITIES[key];
    assert.ok(s.permission, `${key} needs a permission`);
    assert.ok(Array.isArray(s.textFields) && s.textFields.length, `${key} needs text fields`);
    assert.equal(typeof s.map, 'function', `${key} needs a mapper`);
  }
});

test('resolveSearchableEntities returns only authorized entities', () => {
  // Only clients.read → only clients searchable.
  assert.deepEqual(resolveSearchableEntities({ requestedTypes: null, permissions: ['clients.read'] }), ['clients']);
  // All perms → all entities.
  assert.deepEqual(resolveSearchableEntities({ requestedTypes: null, permissions: ALL_PERMS }), SEARCHABLE_TYPES);
  // No perms → nothing (no leak).
  assert.deepEqual(resolveSearchableEntities({ requestedTypes: null, permissions: [] }), []);
});

test('resolveSearchableEntities omits an unauthorized requested type (no error, no leak)', () => {
  // Requesting claims but only holding clients.read → claims silently dropped.
  const out = resolveSearchableEntities({ requestedTypes: ['clients', 'claims'], permissions: ['clients.read'] });
  assert.deepEqual(out, ['clients']);
});

test('resolveSearchableEntities rejects an unknown requested type', () => {
  assert.throws(() => resolveSearchableEntities({ requestedTypes: ['clients', 'wombats'], permissions: ALL_PERMS }), /Unknown search type/);
});

test('buildEntityFilter escapes regex metacharacters (no injection / ReDoS)', () => {
  const f = buildEntityFilter('clients', { term: 'a.*(b|c)+' });
  const rx = f.$or[0].firstName;
  assert.ok(rx instanceof RegExp);
  // The dangerous metachars must be escaped to literals.
  assert.ok(rx.source.includes('\\.'));
  assert.ok(rx.source.includes('\\*'));
  assert.ok(rx.source.includes('\\('));
  // A literal-looking string should NOT match a regex-interpreted target.
  assert.equal(rx.test('axxxbc'), false);
  assert.equal(rx.test('a.*(b|c)+'), true);
});

test('buildEntityFilter always scopes to non-deleted and builds $or across text fields', () => {
  const f = buildEntityFilter('staff', { term: 'smith' });
  assert.equal(f.deletedAt, null);
  assert.equal(f.$or.length, SEARCH_ENTITIES.staff.textFields.length);
});

test('buildEntityFilter applies allowed structured filters and rejects unknown ones', () => {
  const f = buildEntityFilter('documents', { term: 'plan', filters: { status: 'DRAFT', documentType: 'ASSESSMENT' } });
  assert.equal(f.status, 'DRAFT');
  assert.equal(f.documentType, 'ASSESSMENT');
  assert.throws(() => buildEntityFilter('documents', { term: 'x', filters: { secretField: 'y' } }), /Unsupported filter/);
});

test('buildEntityFilter with no term omits $or (filter-only search)', () => {
  const f = buildEntityFilter('claims', { filters: { status: 'PAID' } });
  assert.equal(f.$or, undefined);
  assert.equal(f.status, 'PAID');
  assert.equal(f.deletedAt, null);
});

test('buildEntityFilter never accepts a tenantId filter from the client', () => {
  // tenantId is not a declared filter on any entity → must be rejected.
  for (const key of SEARCHABLE_TYPES) {
    assert.throws(() => buildEntityFilter(key, { term: 'x', filters: { tenantId: 'evil-tenant' } }), /Unsupported filter/);
  }
});

test('document/client mappers never expose PHI-envelope or storage internals', () => {
  const doc = SEARCH_ENTITIES.documents.map({ _id: 'd1', title: 'T', documentType: 'NOTE', status: 'DRAFT', storageRef: 'secret', checksum: 'abc' });
  assert.equal(doc.storageRef, undefined);
  assert.equal(doc.checksum, undefined);
  const client = SEARCH_ENTITIES.clients.map({ _id: 'c1', firstName: 'A', lastName: 'B', clientNumber: 'CN', status: 'ACTIVE', sensitive: { ssn: 'x' } });
  assert.equal(client.sensitive, undefined);
});
