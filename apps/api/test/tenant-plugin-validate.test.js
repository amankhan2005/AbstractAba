import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Membership, UserInvitation } from '../src/models/index.js';
import { withTenant, withPlatform } from '../src/tenancy/tenantContext.js';

/**
 * Regression guard for the "Membership validation failed: tenantId is required"
 * 422. The tenant plugin must stamp tenantId at pre('validate') — Mongoose runs
 * validation before pre('save'), so stamping only at save time is too late and
 * a required tenantId fails validation first. These run without a database:
 * doc.validate() executes pre('validate') + validation, which is exactly the
 * lifecycle point that was broken.
 */
const TENANT = '11111111-1111-4111-8111-111111111111';

test('Membership: tenantId is stamped from context before validation (new doc)', async () => {
  await withTenant(TENANT, async () => {
    const doc = new Membership({ userId: 'user-1', status: 'INVITED', isOwner: true });
    await doc.validate(); // would throw "tenantId is required" before the fix
    assert.equal(doc.tenantId, TENANT);
  });
});

test('UserInvitation: tenantId is stamped from context before validation', async () => {
  await withTenant(TENANT, async () => {
    const doc = new UserInvitation({
      membershipId: 'm-1',
      email: 'owner@example.com',
      tokenHash: 'x'.repeat(64),
      expiresAt: new Date(Date.now() + 3600_000),
      invitedByUserId: 'op-1',
    });
    await doc.validate();
    assert.equal(doc.tenantId, TENANT);
  });
});

test('fail closed: validating a tenant-owned doc with no context throws', async () => {
  const doc = new Membership({ userId: 'user-2' });
  await assert.rejects(() => doc.validate(), /no tenant context is active/);
});

test('platform scope: an explicit tenantId is required and preserved', async () => {
  await withPlatform(async () => {
    const bad = new Membership({ userId: 'user-3' });
    await assert.rejects(() => bad.validate(), /must set tenantId explicitly/);

    const ok = new Membership({ userId: 'user-4', tenantId: TENANT });
    await ok.validate();
    assert.equal(ok.tenantId, TENANT);
  });
});
