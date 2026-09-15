import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceAuthorization } from '../src/models/serviceAuthorization.model.js';
import { authorizationDuplicateError } from '../src/modules/clients/clients.repository.js';

/**
 * Fix 1 — MULTIPLE ABA/FBA AUTHORIZATIONS · index-level regression guard.
 *
 * The production bug was a UNIQUE index on { tenantId, clientId, serviceType },
 * which caps a child at one ABA + one FBA and rejects the second with a
 * duplicate-key error. These assertions read the COMPILED schema (no database
 * needed — the fake-repo suite never touches a live index), so the footgun
 * cannot silently return.
 *
 * Correct shape after the fix:
 *   - (tenantId, clientId, serviceType) exists but is NOT unique — multiple
 *     ABA/FBA per child are allowed.
 *   - (tenantId, clientId, authorizationNumber) is UNIQUE but PARTIAL, scoped to
 *     string values only — duplicate protection is by the REAL identity (the
 *     authorization number), and number-less drafts never collide.
 */

function indexesFor(Model, keyShape) {
  const wantKeys = Object.keys(keyShape);
  return Model.schema.indexes().filter(([keys]) => {
    const k = Object.keys(keys);
    return k.length === wantKeys.length && k.every((key, i) => key === wantKeys[i] && keys[key] === keyShape[key]);
  });
}

test('there is NO unique index on (tenantId, clientId, serviceType) — multiple ABA/FBA are allowed', () => {
  const matches = indexesFor(ServiceAuthorization, { tenantId: 1, clientId: 1, serviceType: 1 });
  assert.ok(matches.length > 0, 'the (tenant, client, serviceType) index should still exist for query performance');
  const anyUnique = matches.some(([, opts]) => opts && opts.unique);
  assert.equal(anyUnique, false, 'a UNIQUE (tenant, client, serviceType) index caps a child at one ABA + one FBA — it must not be unique');
});

test('duplicate protection is a PARTIAL unique index on (tenantId, clientId, authorizationNumber), string-only', () => {
  const matches = indexesFor(ServiceAuthorization, { tenantId: 1, clientId: 1, authorizationNumber: 1 });
  const good = matches.find(([, opts]) =>
    opts && opts.unique && opts.partialFilterExpression
    && opts.partialFilterExpression.authorizationNumber
    && opts.partialFilterExpression.authorizationNumber.$type === 'string',
  );
  assert.ok(good, 'must have { unique:true, partialFilterExpression:{ authorizationNumber: { $type: "string" } } } so a repeated NUMBER is rejected but number-less drafts never collide');
});

// --- E11000 translation (defense-in-depth for a race past the service check) --

test('authorizationDuplicateError maps a Mongo duplicate key to the AUTHORIZATION_EXISTS business error', () => {
  const mapped = authorizationDuplicateError({ code: 11000, keyPattern: { authorizationNumber: 1 } }, 'ABA-001');
  assert.ok(mapped, 'a duplicate-key error must be translated');
  assert.equal(mapped.code, 'AUTHORIZATION_EXISTS');
  assert.equal(mapped.status, 409);
  // The raw Mongo message/E11000 is never surfaced — a clean business message is.
  assert.doesNotMatch(mapped.message, /E11000|duplicate key/i);
  assert.equal(mapped.context?.authorizationNumber, 'ABA-001');
});

test('authorizationDuplicateError returns null for a non-duplicate error (so the caller rethrows)', () => {
  assert.equal(authorizationDuplicateError(new Error('network blip')), null);
  assert.equal(authorizationDuplicateError({ name: 'ValidationError' }), null);
  assert.equal(authorizationDuplicateError(null), null);
});
