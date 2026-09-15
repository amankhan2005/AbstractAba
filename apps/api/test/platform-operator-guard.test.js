import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requirePlatformOperator } from '../src/middleware/requirePlatformOperator.js';
import { createOrganizationRouters } from '../src/modules/organization/organization.routes.js';
import { createOnboardingRouter } from '../src/modules/onboarding/onboarding.routes.js';

// ============================================================================
// Backend enforcement of the platform boundary. Activate (onboarding/activate)
// and Deactivate/Activate (organization transitions) are Super-Admin-only. A
// Company Admin / BCBA / RBT — any tenant principal with isPlatformOperator
// false — must be refused by the middleware, not just hidden in the UI.
// ============================================================================

function runGuard(principal) {
  const req = { principal };
  let nextArg = 'UNSET';
  requirePlatformOperator(req, {}, (arg) => { nextArg = arg; });
  return nextArg; // undefined = allowed; an AppError = refused
}

test('requirePlatformOperator ALLOWS a platform operator', () => {
  assert.equal(runGuard({ userId: 'u1', isPlatformOperator: true }), undefined);
});

for (const role of ['owner', 'organization_admin', 'bcba', 'rbt', 'billing_staff']) {
  test(`requirePlatformOperator REFUSES a tenant ${role} (403)`, () => {
    const err = runGuard({ userId: 'u1', isPlatformOperator: false, roleKeys: [role] });
    assert.ok(err, 'a tenant role must be refused');
    assert.equal(err.status, 403);
  });
}

test('requirePlatformOperator REFUSES an unauthenticated request (no principal)', () => {
  const err = runGuard(undefined);
  assert.ok(err);
  assert.equal(err.status, 403);
});

// The lifecycle endpoints must actually MOUNT the guard — a route that forgot it
// would pass the unit test above while still being reachable by tenant users.
function platformStackNames(router) {
  // The platform sub-router's middleware stack, by function name.
  return router.stack.map((l) => l.handle?.name).filter(Boolean);
}

test('the organization platform router mounts authenticate + requirePlatformOperator (guards transitions)', () => {
  const { platform } = createOrganizationRouters({});
  const names = platformStackNames(platform);
  assert.ok(names.includes('requirePlatformOperator'), 'transitions endpoint must be behind the platform guard');
  assert.ok(names.includes('authenticate'), 'transitions endpoint must require authentication');
});

test('the onboarding router mounts authenticate + requirePlatformOperator (guards activate)', () => {
  const router = createOnboardingRouter({});
  const names = platformStackNames(router);
  assert.ok(names.includes('requirePlatformOperator'), 'onboarding/activate must be behind the platform guard');
  assert.ok(names.includes('authenticate'), 'onboarding/activate must require authentication');
});
