import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizationService, toResolvedList } from '../src/modules/rbac/authorization.service.js';

test('catalogue: reference metadata for every known permission', () => {
  const cat = authorizationService.catalogue();
  assert.ok(cat.length >= 20);
  const org = cat.find((c) => c.key === 'organization.read');
  assert.equal(org.module, 'organization');
  assert.equal(org.platformOnly, false);
  const plat = cat.find((c) => c.key === 'platform.tenant.read');
  assert.equal(plat.platformOnly, true);
});

test('effective permissions: union of role templates, widest scope wins', () => {
  const owner = authorizationService.resolvePermissions({ roleKeys: ['owner'], isPlatformOperator: false });
  assert.ok(owner.size > 0);
  // an unknown role contributes nothing
  const unknown = authorizationService.resolvePermissions({ roleKeys: ['not_a_role'], isPlatformOperator: false });
  assert.equal(unknown.size, 0);
});

test('platform operator holds platform grants, not tenant roles', () => {
  const op = authorizationService.resolvePermissions({ isPlatformOperator: true });
  assert.equal(op.has('platform.tenant.read'), true);
  assert.equal(op.has('platform.tenant.create'), true);
});

test('can(): only known permissions the principal holds', () => {
  assert.equal(authorizationService.can({ isPlatformOperator: true }, 'platform.tenant.read'), true);
  assert.equal(authorizationService.can({ roleKeys: [] }, 'organization.read'), false);
  assert.equal(authorizationService.can({ isPlatformOperator: true }, 'not.a.real.permission'), false);
});

test('rolePermissions(): known role returns list, unknown returns null', () => {
  assert.notEqual(authorizationService.rolePermissions('owner'), null);
  assert.equal(authorizationService.rolePermissions('nope'), null);
});

test('toResolvedList: sorted key/scope pairs', () => {
  const list = toResolvedList(new Map([['b.x', 'SELF'], ['a.y', 'ORGANIZATION']]));
  assert.deepEqual(list.map((p) => p.key), ['a.y', 'b.x']);
});

// --- Phase 3 financial permissions: positive AND negative role coverage -----
test('Phase 3 RBAC: billing_staff holds claims/ERA/finance/reconciliation, clinical does not', () => {
  const can = (roleKeys, perm) => authorizationService.can({ roleKeys, isPlatformOperator: false }, perm);
  // positive
  for (const p of ['claims.manage', 'era.process', 'era.resolve', 'finance.reports.read', 'finance.export', 'reconciliation.manage', 'billing.manage']) {
    assert.equal(can(['billing_staff'], p), true, `billing_staff should hold ${p}`);
  }
  // negative — clinical staff must never hold financial permissions
  for (const role of ['rbt', 'bcba', 'scheduler', 'receptionist']) {
    for (const p of ['claims.read', 'era.read', 'finance.reports.read', 'reconciliation.read', 'billing.read', 'payroll.read']) {
      assert.equal(can([role], p), false, `${role} must NOT hold ${p}`);
    }
  }
});

test('Phase 3 RBAC: payroll_staff holds payroll/timesheets but no claims/ERA/finance', () => {
  const can = (roleKeys, perm) => authorizationService.can({ roleKeys, isPlatformOperator: false }, perm);
  for (const p of ['payroll.manage', 'timesheets.approve']) {
    assert.equal(can(['payroll_staff'], p), true, `payroll_staff should hold ${p}`);
  }
  for (const p of ['claims.read', 'era.read', 'finance.reports.read', 'reconciliation.manage', 'billing.manage']) {
    assert.equal(can(['payroll_staff'], p), false, `payroll_staff must NOT hold ${p}`);
  }
});

test('Phase 3 RBAC: owner and org_admin hold reconciliation.manage + finance.export', () => {
  const can = (roleKeys, perm) => authorizationService.can({ roleKeys, isPlatformOperator: false }, perm);
  for (const role of ['owner', 'org_admin']) {
    assert.equal(can([role], 'reconciliation.manage'), true);
    assert.equal(can([role], 'finance.export'), true);
    assert.equal(can([role], 'claims.manage'), true);
  }
});

// --- Phase 4.2 supervision workflow permissions ----------------------------
test('Phase 4.2 RBAC: bcba/owner/org_admin hold supervision.log + supervision.signoff', () => {
  const can = (roleKeys, perm) => authorizationService.can({ roleKeys, isPlatformOperator: false }, perm);
  for (const role of ['owner', 'org_admin', 'bcba']) {
    assert.equal(can([role], 'supervision.log'), true, `${role} should hold supervision.log`);
    assert.equal(can([role], 'supervision.signoff'), true, `${role} should hold supervision.signoff`);
  }
});

test('Phase 4.2 RBAC: rbt and non-supervisors cannot log or sign off supervision', () => {
  const can = (roleKeys, perm) => authorizationService.can({ roleKeys, isPlatformOperator: false }, perm);
  for (const role of ['rbt', 'scheduler', 'receptionist', 'billing_staff', 'payroll_staff']) {
    assert.equal(can([role], 'supervision.log'), false, `${role} must NOT hold supervision.log`);
    assert.equal(can([role], 'supervision.signoff'), false, `${role} must NOT hold supervision.signoff`);
  }
});

test('Phase 4.2 RBAC: supervision.signoff is distinct from supervision.log (RBT cannot sign even if granted log)', () => {
  const can = (roleKeys, perm) => authorizationService.can({ roleKeys, isPlatformOperator: false }, perm);
  // A hypothetical principal with only supervision.log must not gain signoff.
  assert.equal(can(['rbt'], 'supervision.signoff'), false);
});

// --- Phase 4.3 recurring appointments: reuse scheduling permissions --------
test('Phase 4.3 RBAC: scheduling roles gate recurring series (reused perms)', () => {
  const can = (roleKeys, perm) => authorizationService.can({ roleKeys, isPlatformOperator: false }, perm);
  // Roles that can schedule can also create/cancel series occurrences.
  for (const role of ['owner', 'org_admin', 'scheduler']) {
    assert.equal(can([role], 'scheduling.write'), true, `${role} should hold scheduling.write`);
    assert.equal(can([role], 'scheduling.read'), true, `${role} should hold scheduling.read`);
  }
  // Cancelling a whole series requires scheduling.manage.
  assert.equal(can(['owner'], 'scheduling.manage'), true);
  assert.equal(can(['org_admin'], 'scheduling.manage'), true);
  // A clinician without scheduling perms cannot touch series.
  assert.equal(can(['rbt'], 'scheduling.write'), false);
  assert.equal(can(['rbt'], 'scheduling.manage'), false);
});

// --- Phase 4.5 bulk import / org export: reuse existing permissions ---------
test('Phase 4.5 RBAC: import reuses clients.create / staff.manage; export uses organization.export', () => {
  const can = (roleKeys, perm) => authorizationService.can({ roleKeys, isPlatformOperator: false }, perm);
  // Client import → clients.create (owner/org_admin/receptionist hold it).
  // Phase 1 (child access control): BCBA/RBT do NOT hold clients.create, so a
  // BCBA can no longer create a child by ANY path — direct or bulk import.
  assert.equal(can(['receptionist'], 'clients.create'), true);
  assert.equal(can(['bcba'], 'clients.create'), false);
  assert.equal(can(['rbt'], 'clients.create'), false);
  // Staff import → staff.manage (owner/org_admin only).
  assert.equal(can(['owner'], 'staff.manage'), true);
  assert.equal(can(['org_admin'], 'staff.manage'), true);
  assert.equal(can(['receptionist'], 'staff.manage'), false); // can import clients but NOT staff
  assert.equal(can(['bcba'], 'staff.manage'), false);
  // Org export → organization.export (owner only).
  assert.equal(can(['owner'], 'organization.export'), true);
  assert.equal(can(['org_admin'], 'organization.export'), false);
  assert.equal(can(['bcba'], 'organization.export'), false);
});

// --- Part 6: BCBA/RBT are VIEW-ONLY for scheduling (Company/Admin authority) --
// Clinicians may see their caseload calendar but must not create appointments.
// A direct POST /scheduling/appointments is gated by scheduling.write, so the
// absence of that grant is what makes the API reject the call server-side.
test('Part 6 RBAC: BCBA and RBT hold scheduling.read but NOT write/manage', () => {
  const can = (roleKeys, perm) => authorizationService.can({ roleKeys, isPlatformOperator: false }, perm);
  for (const role of ['bcba', 'rbt']) {
    assert.equal(can([role], 'scheduling.read'), true, `${role} keeps scheduling.read (view-only)`);
    assert.equal(can([role], 'scheduling.write'), false, `${role} MUST NOT hold scheduling.write`);
    assert.equal(can([role], 'scheduling.manage'), false, `${role} MUST NOT hold scheduling.manage`);
  }
  // The scheduling authority — Company/Admin plus scheduler/receptionist — keeps write.
  for (const role of ['owner', 'org_admin', 'scheduler', 'receptionist']) {
    assert.equal(can([role], 'scheduling.write'), true, `${role} is a scheduling authority`);
  }
});
