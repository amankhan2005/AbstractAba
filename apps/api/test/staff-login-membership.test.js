import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Membership } from '../src/models/index.js';
import { withTenant, TenantContextError } from '../src/tenancy/tenantContext.js';

/**
 * REGRESSION — staff login "This account is not a member of an organization."
 *
 * That message is produced ONLY when a signed-in tenant user has no ACTIVE
 * membership: sign-in's `_defaultTenantFor(userId)` queries
 * `Membership.findOne({ userId, status: 'ACTIVE' })`; when it finds nothing it
 * returns null, the session carries no activeTenantId, and the web
 * `canAccessApp` rule rejects the principal.
 *
 * ROOT CAUSE (historical): staff used to be provisioned via the invitation-link
 * flow, which created an **INVITED** membership and no password — so a staff
 * member never had an ACTIVE membership and always hit this error. The current
 * temporary-password flow (`usersRepository.provisionStaffAccount`) creates an
 * **ACTIVE** membership, tenant-stamped to the creating organization, so
 * `_defaultTenantFor` resolves it.
 *
 * These tests use the REAL tenant plugin against a disconnected Mongoose:
 * validate() runs the plugin's pre-validate stamping with no DB, which is
 * exactly where tenantId is applied. They pin the two facts that decide member
 * vs non-member: the provisioned membership is ACTIVE, and it is stamped to the
 * creating tenant (and only that tenant).
 */

const ORG_A = '11111111-1111-7111-8111-111111111111';
const ORG_B = '22222222-2222-7222-8222-222222222222';

// The exact filter sign-in's _defaultTenantFor uses to decide "is a member".
const isMemberResolvable = (m) => m.status === 'ACTIVE' && !!m.tenantId;

async function stampMembership(scopeOrg, status) {
  const doc = new Membership({ _id: 'm-1', userId: 'u-1', status, isOwner: false, joinedAt: new Date(), createdBy: 'admin' });
  await withTenant(scopeOrg, async () => doc.validate());
  return doc;
}

test('a staff membership created in the org context is ACTIVE and tenant-stamped → resolvable as a member', async () => {
  const m = await stampMembership(ORG_A, 'ACTIVE');
  assert.equal(m.status, 'ACTIVE');
  assert.equal(m.tenantId, ORG_A, 'membership is stamped to the creating organization');
  assert.ok(isMemberResolvable(m), '_defaultTenantFor({status:ACTIVE}) would resolve this membership → activeTenantId set');
});

test('the historical INVITED membership (pre-fix) is NOT resolvable → reproduces "not a member"', async () => {
  const m = await stampMembership(ORG_A, 'INVITED');
  assert.equal(m.status, 'INVITED');
  assert.equal(isMemberResolvable(m), false, 'an INVITED membership is skipped by the ACTIVE filter → no activeTenantId → "not a member"');
});

test('membership is stamped to the creating tenant ONLY (cross-tenant isolation)', async () => {
  const a = await stampMembership(ORG_A, 'ACTIVE');
  const b = await stampMembership(ORG_B, 'ACTIVE');
  assert.equal(a.tenantId, ORG_A);
  assert.equal(b.tenantId, ORG_B);
  assert.notEqual(a.tenantId, b.tenantId, 'BCBA A resolves only to org A, BCBA B only to org B');
});

test('the tenant plugin fails closed: a membership write with no org context throws (never a null-tenant member)', async () => {
  const doc = new Membership({ _id: 'm-1', userId: 'u-1', status: 'ACTIVE', isOwner: false, joinedAt: new Date(), createdBy: 'admin' });
  await assert.rejects(() => doc.validate(), (e) => e instanceof TenantContextError);
});
