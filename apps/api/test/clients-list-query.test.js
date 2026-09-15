import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listClientsQuerySchema } from '../src/modules/clients/clients.schemas.js';

/**
 * Insurance Billing child-discovery bug — root cause. The child selector reuses
 * the existing tenant-scoped Client directory (GET /v1/clients), whose query
 * schema caps `limit` at 100 and is `.strict()`. The selector was requesting
 * limit=200, which fails validation (422) so no children came back. These tests
 * pin the contract the client must respect and confirm search/name discovery is
 * supported by the existing endpoint (no new child source needed).
 */

test('limit above 100 is rejected (this was the 422 that emptied the selector)', () => {
  const r = listClientsQuerySchema.safeParse({ limit: 200 });
  assert.equal(r.success, false);
});

test('limit of 100 (the selector now uses) is accepted', () => {
  const r = listClientsQuerySchema.safeParse({ limit: 100 });
  assert.equal(r.success, true);
  assert.equal(r.data.limit, 100);
});

test('a bare query is valid and defaults limit (child discovery needs no date range)', () => {
  const r = listClientsQuerySchema.safeParse({});
  assert.equal(r.success, true);
  assert.equal(r.data.limit, 25);
  assert.equal(r.data.search, undefined);
  assert.equal(r.data.cursor, undefined);
});

test('the existing endpoint supports name search — no separate billing child list needed', () => {
  const r = listClientsQuerySchema.safeParse({ search: 'John', limit: 100 });
  assert.equal(r.success, true);
  assert.equal(r.data.search, 'John');
});

test('the sole cause was the limit bound — an out-of-range limit fails even alone', () => {
  assert.equal(listClientsQuerySchema.safeParse({ limit: 101 }).success, false);
  assert.equal(listClientsQuerySchema.safeParse({ limit: 100 }).success, true);
});
