import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizationService } from '../src/modules/rbac/authorization.service.js';
import { PERMISSION_CATALOGUE } from '../src/modules/rbac/permissionCatalogue.js';

/**
 * Phase 5 — RBT progress → BCBA + Company, over ONE authoritative source.
 *
 * "Progress" is not a separate model or permission: it is the existing session
 * data (Session + SessionDataPoint), captured with sessions.write and read with
 * sessions.read. The RBT records for assigned children (SELF); the BCBA (TEAM)
 * and Company (ORGANIZATION) read the SAME records. No duplicate progress copy.
 */
const perms = (r) => authorizationService.resolvePermissions({ roleKeys: [r], isPlatformOperator: false });

test('progress is one source: there is no separate progress permission — it is session data', () => {
  const keys = PERMISSION_CATALOGUE.map((p) => p.key ?? p);
  assert.equal(keys.some((k) => /progress/i.test(k)), false);
  assert.ok(keys.includes('sessions.read') && keys.includes('sessions.write'));
});

test('RBT records progress for ASSIGNED children only (write + read at SELF), and cannot sign off', () => {
  const p = perms('rbt');
  assert.equal(p.get('sessions.write'), 'SELF');
  assert.equal(p.get('sessions.read'), 'SELF');
  assert.equal(p.has('sessions.freeze'), false); // clinical sign-off is the BCBA's, not the RBT's
});

test('BCBA sees progress for their caseload (read at TEAM) and can sign off', () => {
  const p = perms('bcba');
  assert.equal(p.get('sessions.read'), 'TEAM');
  assert.equal(p.get('sessions.freeze'), 'TEAM');
});

test('Company/Admin sees organization progress (read at ORGANIZATION)', () => {
  assert.equal(perms('owner').get('sessions.read'), 'ORGANIZATION');
  assert.equal(perms('org_admin').get('sessions.read'), 'ORGANIZATION');
});

test('scopes are strictly ordered SELF < TEAM < ORGANIZATION — RBT never reads wider than assigned', () => {
  // an RBT's read must be the narrowest; it can never equal the org-wide read.
  assert.notEqual(perms('rbt').get('sessions.read'), 'ORGANIZATION');
  assert.notEqual(perms('rbt').get('sessions.read'), 'TEAM');
});
