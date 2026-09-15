import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeAllowsClient, scopeAllowsStaff } from '../src/modules/rbac/dataScope.js';
import { authorizationService } from '../src/modules/rbac/authorization.service.js';
import { SYSTEM_ROLE_TEMPLATES } from '../src/modules/rbac/roleTemplates.js';
import { DashboardsController } from '../src/modules/dashboards/dashboards.controller.js';

/**
 * ---------------------------------------------------------------------------
 * INTRA-TENANT DATA SCOPE — regression suite.
 *
 * The existing isolation suite proves Company A cannot read Company B. It says
 * nothing about what one company's own staff can read about each other, and
 * that is where the platform was open: every role held every permission at
 * ORGANIZATION scope, so an RBT calling GET /v1/clients received the entire
 * roster of the clinic.
 *
 * Blueprint 4.5 — RBT: "own scope throughout: their schedule, their assigned
 * clients, their sessions, their timesheet."
 * Blueprint 4.4 — BCBA cannot "see clients outside their caseload".
 *
 * These tests are DB-free: they assert the scope DECLARATIONS in the role
 * templates and the PURE guards that consume them. The database-backed
 * resolution (resolveDataScope) is exercised by the module suites.
 * ---------------------------------------------------------------------------
 */

const scopeOf = (roleKey, permKey) =>
  authorizationService.resolvePermissions({ roleKeys: [roleKey] }).get(permKey);

// --- role template scope declarations (blueprint 4.11 permission matrix) ----

test('RBT holds every data-bearing permission at SELF scope, never organization-wide', () => {
  for (const key of ['clients.read', 'sessions.read', 'sessions.write', 'plans.read',
    'documents.read', 'scheduling.read', 'timesheets.read', 'dashboards.read']) {
    assert.equal(scopeOf('rbt', key), 'SELF', `rbt.${key} must be SELF, not ${scopeOf('rbt', key)}`);
  }
});

test('RBT cannot approve a session, touch billing, or read company payroll', () => {
  const rbt = authorizationService.resolvePermissions({ roleKeys: ['rbt'] });
  // "Cannot do: ... Approve their own sessions." (4.5)
  assert.equal(rbt.has('sessions.freeze'), false);
  // "No financial visibility beyond their own hours." (4.5)
  assert.equal(rbt.has('billing.read'), false);
  assert.equal(rbt.has('billing.manage'), false);
  assert.equal(rbt.has('claims.read'), false);
  assert.equal(rbt.has('payroll.read'), false);
  assert.equal(rbt.has('payroll.manage'), false);
  // "Cannot do: Author or alter treatment plans, programs or goals." (4.5)
  assert.equal(rbt.has('plans.create'), false);
  assert.equal(rbt.has('plans.update'), false);
  // Own timesheet only — never the team's.
  assert.equal(rbt.get('timesheets.read'), 'SELF');
  assert.equal(rbt.has('timesheets.approve'), false);
  // No staff management, no settings, no audit log.
  assert.equal(rbt.has('staff.manage'), false);
  assert.equal(rbt.has('users.manage'), false);
  assert.equal(rbt.has('audit.read'), false);
});

test('BCBA holds clinical authorship at TEAM (caseload) scope, not organization-wide', () => {
  // clients.update is deliberately NOT here: child administration is Company-only
  // now. The BCBA's clinical authorship is plans.*/sessions.* at TEAM scope.
  for (const key of ['clients.read', 'plans.create', 'plans.update',
    'sessions.read', 'sessions.freeze', 'dashboards.read', 'staff.read']) {
    assert.equal(scopeOf('bcba', key), 'TEAM', `bcba.${key} must be TEAM, not ${scopeOf('bcba', key)}`);
  }
  // And the child editor is out of reach entirely.
  assert.equal(scopeOf('bcba', 'clients.update'), undefined);
});

test('BCBA holds no billing, claims or payroll capability at any scope', () => {
  const bcba = authorizationService.resolvePermissions({ roleKeys: ['bcba'] });
  // "Cannot do: Alter billing rates, claim lines, or payroll." (4.4)
  for (const key of ['billing.read', 'billing.manage', 'claims.read', 'claims.write',
    'payroll.read', 'payroll.manage', 'timesheets.approve', 'finance.reports.read']) {
    assert.equal(bcba.has(key), false, `bcba must not hold ${key}`);
  }
  // Their own timesheet, though — they are staff too.
  assert.equal(bcba.get('timesheets.read'), 'SELF');
});

test('Owner and Organization Admin retain tenant scope on operational reads', () => {
  for (const role of ['owner', 'org_admin']) {
    assert.equal(scopeOf(role, 'clients.read'), 'ORGANIZATION');
    assert.equal(scopeOf(role, 'dashboards.read'), 'ORGANIZATION');
    assert.equal(scopeOf(role, 'staff.read'), 'ORGANIZATION');
  }
});

test('every scope declared by every system role is a known scope name', () => {
  const VALID = new Set(['SELF', 'TEAM', 'ORGANIZATION', 'PLATFORM']);
  for (const [roleKey, grants] of Object.entries(SYSTEM_ROLE_TEMPLATES)) {
    for (const g of grants) {
      assert.ok(VALID.has(g.scope), `${roleKey}.${g.key} has unknown scope ${g.scope}`);
    }
  }
});

test('multi-role users receive the union with the broader scope winning (4.12)', () => {
  // A small-clinic owner who also carries a caseload: owner's ORGANIZATION
  // scope must beat bcba's TEAM scope, not the other way round.
  const both = authorizationService.resolvePermissions({ roleKeys: ['bcba', 'owner'] });
  assert.equal(both.get('clients.read'), 'ORGANIZATION');
  const reversed = authorizationService.resolvePermissions({ roleKeys: ['owner', 'bcba'] });
  assert.equal(reversed.get('clients.read'), 'ORGANIZATION', 'scope must not depend on role order');
});

// --- the pure scope guards -------------------------------------------------

test('scopeAllowsClient: null clientIds is tenant-wide, an array narrows', () => {
  assert.equal(scopeAllowsClient({ clientIds: null }, 'anything'), true);
  assert.equal(scopeAllowsClient({ clientIds: ['c1', 'c2'] }, 'c1'), true);
  assert.equal(scopeAllowsClient({ clientIds: ['c1', 'c2'] }, 'c9'), false);
});

test('scopeAllowsClient FAILS CLOSED on an empty set and on a missing scope', () => {
  // A technician with no assignments sees nothing — never everything.
  assert.equal(scopeAllowsClient({ clientIds: [] }, 'c1'), false);
  assert.equal(scopeAllowsClient(undefined, 'c1'), false);
  assert.equal(scopeAllowsClient(null, 'c1'), false);
});

test('scopeAllowsStaff: self and supervisees only, unless tenant-wide', () => {
  assert.equal(scopeAllowsStaff({ staffIds: null }, 's9'), true);
  assert.equal(scopeAllowsStaff({ staffIds: ['s1', 's2'] }, 's2'), true);
  assert.equal(scopeAllowsStaff({ staffIds: ['s1', 's2'] }, 's3'), false);
  assert.equal(scopeAllowsStaff({ staffIds: [] }, 's1'), false);
  assert.equal(scopeAllowsStaff(undefined, 's1'), false);
});

// --- dashboard identity cannot be supplied by the caller -------------------

const reqFor = (dataScope, query = {}) => ({
  principal: { userId: 'u1', activeTenantId: 't1' },
  dataScope,
  query,
});

test('dashboard subject defaults to the caller, ignoring who they say they are', () => {
  const own = DashboardsController.subjectStaff(
    reqFor({ staffProfileId: 'me', clientIds: ['c1'], staffIds: ['me'] }),
  );
  assert.deepEqual(own, { staffProfileId: 'me' });
});

test('RBT cannot request another technician\u2019s dashboard by query parameter', () => {
  const req = reqFor(
    { staffProfileId: 'me', clientIds: ['c1'], staffIds: ['me'] },
    { staffProfileId: 'someone-else' },
  );
  assert.throws(() => DashboardsController.subjectStaff(req), (err) => {
    assert.equal(err.status ?? err.statusCode, 403);
    // Plain language, no codes leaked to the user (blueprint 26 / house rule).
    assert.doesNotMatch(err.message, /AUTH-403|tenantId|Mongo/);
    return true;
  });
});

test('a supervising BCBA may open a supervisee\u2019s dashboard, but not a stranger\u2019s', () => {
  const scope = { staffProfileId: 'bcba1', clientIds: ['c1'], staffIds: ['bcba1', 'rbt1'] };
  assert.deepEqual(
    DashboardsController.subjectStaff(reqFor(scope, { staffProfileId: 'rbt1' })),
    { staffProfileId: 'rbt1' },
  );
  assert.throws(() => DashboardsController.subjectStaff(reqFor(scope, { staffProfileId: 'rbt-other' })));
});

test('an administrator with tenant scope may open any clinician\u2019s dashboard', () => {
  const scope = { staffProfileId: null, clientIds: null, staffIds: null };
  assert.deepEqual(
    DashboardsController.subjectStaff(reqFor(scope, { staffProfileId: 'anyone' })),
    { staffProfileId: 'anyone' },
  );
  // …and with no parameter gets the unscoped board.
  assert.deepEqual(DashboardsController.subjectStaff(reqFor(scope)), {});
});

test('company-wide dashboards are refused to anyone without tenant scope', () => {
  assert.throws(() => DashboardsController.requireOrganizationScope(
    reqFor({ staffProfileId: 'me', clientIds: ['c1'], staffIds: ['me'] }),
  ));
  assert.throws(() => DashboardsController.requireOrganizationScope(
    reqFor({ staffProfileId: 'bcba1', clientIds: [], staffIds: ['bcba1'] }),
  ));
  // An owner/admin passes.
  assert.doesNotThrow(() => DashboardsController.requireOrganizationScope(
    reqFor({ staffProfileId: null, clientIds: null, staffIds: null }),
  ));
});

test('a refusal is written in plain language, never as a code or a field name', () => {
  // Blueprint requirement: the user never sees tenantId, AUTH-401, 422 or a
  // Mongo error. A permission refusal is one of the most likely places for an
  // internal identifier to leak into the interface.
  const req = {
    principal: { userId: 'u-1', activeTenantId: 't-1' },
    dataScope: { staffProfileId: 'rbt-1', staffIds: ['rbt-1'], clientIds: [] },
    query: { staffProfileId: 'rbt-2' },
  };
  try {
    DashboardsController.subjectStaff(req);
    assert.fail('expected a refusal');
  } catch (err) {
    assert.match(err.message, /^You don\u2019t have access to this dashboard\.$/);
    assert.doesNotMatch(err.message, /tenantId|staffProfileId|AUTH-|\b403\b|Mongo/);
  }
});
