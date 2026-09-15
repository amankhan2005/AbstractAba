import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizationService } from '../src/modules/rbac/authorization.service.js';
import { isKnownPermission } from '../src/modules/rbac/permissionCatalogue.js';
import { requirePermission } from '../src/middleware/requirePermission.js';

/**
 * REGRESSION — care-team mutation must be Company/Admin-only at the BACKEND.
 *
 * Blueprint (non-negotiable): "Company controls WHO works with the child."
 * Parts 7 & 12: a BCBA must NOT assign/replace/remove the care team, and a
 * direct API call from a BCBA "must be rejected" — not merely hidden in the UI
 * (Part 29 forbids frontend-only security). RBT is likewise blocked.
 *
 * ROOT CAUSE (found & fixed): the four care-team mutation routes were gated by
 * `clients.update`, which the BCBA role template grants (TEAM scope, so a BCBA
 * can edit clinical fields on their caseload). That same grant let a BCBA POST
 * /clients/:id/care-team and reassign the BCBA/RBT. Care-team management is now
 * a DISTINCT capability — `clients.care_team.manage` — held only by owner /
 * org_admin (Company/Admin), so a BCBA keeps clients.update but can no longer
 * mutate the care team.
 *
 * These assertions are offline: capability resolution is pure (role templates
 * are code), and the middleware's permission gate rejects a principal lacking
 * the key BEFORE any data-scope/DB work runs.
 */

const CARE_TEAM_MANAGE = 'clients.care_team.manage';
const can = (roleKeys, perm) =>
  authorizationService.can({ roleKeys, isPlatformOperator: false }, perm);

// Build a request principal exactly as authenticate.js does from a token:
// permissions is a Set, permissionScopes a Map — both sourced from the role
// templates, so this is faithful to what a real BCBA/owner token carries.
function principalFor(roleKeys) {
  const resolved = authorizationService.resolvePermissions({ roleKeys, isPlatformOperator: false });
  return {
    userId: `user-${roleKeys.join('-')}`,
    roleKeys,
    permissions: new Set(resolved.keys()),
    permissionScopes: new Map(resolved.entries()),
  };
}

const runGuard = (mw, req) =>
  new Promise((resolve) => mw(req, {}, (err) => resolve(err ?? null)));

test('clients.care_team.manage is a known, catalogued permission', () => {
  assert.equal(isKnownPermission(CARE_TEAM_MANAGE), true);
  const entry = authorizationService.catalogue().find((c) => c.key === CARE_TEAM_MANAGE);
  assert.ok(entry, 'care_team.manage must appear in the catalogue');
  assert.equal(entry.platformOnly, false);
  assert.equal(entry.module, 'clients');
});

test('only Company/Admin (owner, org_admin) hold care-team management', () => {
  // positive — the operational authority that owns "who works with the child"
  for (const role of ['owner', 'org_admin']) {
    assert.equal(can([role], CARE_TEAM_MANAGE), true, `${role} should manage the care team`);
  }
  // negative — clinicians and every other role must NOT
  for (const role of ['bcba', 'rbt', 'scheduler', 'receptionist', 'billing_staff', 'payroll_staff']) {
    assert.equal(can([role], CARE_TEAM_MANAGE), false, `${role} must NOT manage the care team`);
  }
});

test('the split is real: a BCBA has neither care-team mutation nor child administration', () => {
  // Child administration (incl. the child editor / clients.update) is now
  // Company/Admin-only; a BCBA holds neither it nor care-team mutation…
  assert.equal(can(['bcba'], 'clients.update'), false);
  assert.equal(can(['bcba'], CARE_TEAM_MANAGE), false);
  // …while its clinical planning permissions are untouched.
  assert.equal(can(['bcba'], 'plans.create'), true);
  assert.equal(can(['bcba'], 'plans.update'), true);
  // RBT never had clients.update and never had care-team mutation.
  assert.equal(can(['rbt'], 'clients.update'), false);
  assert.equal(can(['rbt'], CARE_TEAM_MANAGE), false);
});

test('route guard rejects a BCBA principal on a care-team mutation route (403, before any DB work)', async () => {
  const guard = requirePermission(CARE_TEAM_MANAGE);
  const err = await runGuard(guard, { principal: principalFor(['bcba']) });
  assert.ok(err, 'a BCBA must be rejected');
  assert.equal(err.status, 403);
});

test('route guard rejects an RBT principal on a care-team mutation route (403)', async () => {
  const guard = requirePermission(CARE_TEAM_MANAGE);
  const err = await runGuard(guard, { principal: principalFor(['rbt']) });
  assert.ok(err, 'an RBT must be rejected');
  assert.equal(err.status, 403);
});

test('care-team READ stays open to clinicians (BCBA/RBT can still view their team)', () => {
  // The GET /care-team route is guarded by clients.read, which both hold.
  assert.equal(can(['bcba'], 'clients.read'), true);
  assert.equal(can(['rbt'], 'clients.read'), true);
});
