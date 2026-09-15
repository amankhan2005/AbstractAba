import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizationService } from '../src/modules/rbac/authorization.service.js';

/**
 * Phase 1 — child access control (RBAC matrix).
 *
 * The child-CREATE gate is `clients.create`. Company roles (owner, org_admin)
 * hold it; clinicians (bcba, rbt) MUST NOT — a BCBA/RBT cannot create or add a
 * child. `POST /v1/clients` is guarded by requirePermission('clients.create'),
 * so removing the grant from these roles is the authoritative server-side block.
 */

const perms = (roleKeys) => authorizationService.resolvePermissions({ roleKeys, isPlatformOperator: false });

test('Company owner and org_admin CAN create a child', () => {
  assert.equal(perms(['owner']).has('clients.create'), true);
  assert.equal(perms(['org_admin']).has('clients.create'), true);
});

test('a BCBA CANNOT create a child (no clients.create grant)', () => {
  const p = perms(['bcba']);
  assert.equal(p.has('clients.create'), false);
  // a BCBA still reads their caseload, at TEAM scope
  assert.equal(p.get('clients.read'), 'TEAM');
});

test('an RBT CANNOT create a child (no clients.create grant)', () => {
  const p = perms(['rbt']);
  assert.equal(p.has('clients.create'), false);
  // an RBT still reads their own assigned children, at SELF scope
  assert.equal(p.get('clients.read'), 'SELF');
});

test('a BCBA/RBT read scope is narrower than organization (caseload only)', () => {
  assert.notEqual(perms(['bcba']).get('clients.read'), 'ORGANIZATION');
  assert.notEqual(perms(['rbt']).get('clients.read'), 'ORGANIZATION');
  assert.equal(perms(['owner']).get('clients.read'), 'ORGANIZATION');
});
