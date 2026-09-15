import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DashboardsService } from '../src/modules/dashboards/dashboards.service.js';
import { DashboardsRepository } from '../src/modules/dashboards/dashboards.repository.js';
import { PERMISSION_KEYS } from '../src/modules/rbac/permissionCatalogue.js';
import { SYSTEM_ROLE_TEMPLATES, SYSTEM_ROLE_KEYS } from '../src/modules/rbac/roleTemplates.js';
import { AUDIT_CATALOGUE } from '../src/middleware/auditRecorder.js';
import { TenantContextError } from '../src/tenancy/tenantContext.js';

/**
 * DB-free tests for the role dashboards: the aggregation/derivation logic
 * against a fake repository, the RBAC grant, tenant-isolation fail-closed on the
 * real repository, and the read-only endpoint contract (no audit, GET only).
 */

const FIXED_NOW = new Date('2026-08-07T12:00:00Z');

// A fake repository returning representative grouped counts. Each method records
// nothing but its scope args so scoping can be asserted.
function makeRepo(over = {}) {
  const calls = { sessionsWindow: [], appointmentsWindow: [], activePlansForBcba: [] };
  const repo = {
    countClientsByStatus: async () => ({ ACTIVE: 12, INTAKE: 3, DISCHARGED: 4, ARCHIVED: 2 }),
    countStaffByStatus: async () => ({ ACTIVE: 8, INACTIVE: 1 }),
    countCredentialsExpiringWithin: async () => 2,
    countAppointmentsInWindow: async (_t, args) => { calls.appointmentsWindow.push(args); return 5; },
    countAppointmentsByStatusInWindow: async () => ({ SCHEDULED: 5, COMPLETED: 3 }),
    authorizationUtilization: async () => ({ authorizedUnits: 100, usedUnits: 40, activeAuthorizations: 3 }),
    countPlansByStatus: async () => ({ DRAFT: 2, ACTIVE: 9, ARCHIVED: 5 }),
    countActivePlansForBcba: async (_t, id) => { calls.activePlansForBcba.push(id); return 4; },
    countAssignedClientsForStaff: async (_t, id, role) => (id ? 3 : 0),
    countSessionsByStatus: async (_t, scope) => ({ DRAFT: 6, SUBMITTED: 2, FROZEN: 14 }),
    countSessionsInWindowByStatus: async (_t, args) => { calls.sessionsWindow.push(args); return { DRAFT: 1, SUBMITTED: 1, FROZEN: 3 }; },
    countDocumentsByStatus: async () => ({ DRAFT: 3, FINALIZED: 20, ARCHIVED: 7 }),
    ...over,
  };
  return { repo, calls };
}

function makeService(over) {
  const { repo, calls } = makeRepo(over);
  return { service: new DashboardsService({ repository: repo, now: () => FIXED_NOW }), calls };
}

// --- organization dashboard ------------------------------------------------

test('organization dashboard rolls up clients, staff, plans, documents, sessions, utilization', async () => {
  const { service } = makeService();
  const d = await service.organizationDashboard({ tenantId: 't' });
  assert.equal(d.scope, 'organization');
  assert.equal(d.activeClients, 12);
  assert.equal(d.activeStaff, 8);
  assert.equal(d.activeTreatmentPlans, 9);
  assert.equal(d.archivedPlans, 5);
  assert.equal(d.draftDocuments, 3);
  assert.equal(d.finalizedDocuments, 20);
  assert.equal(d.frozenSessions, 14);
  assert.equal(d.draftSessions, 6);
  assert.equal(d.todaysSessions, 5); // 1 + 1 + 3
  assert.equal(d.upcomingAppointments, 5);
  assert.equal(d.authorizationUtilization.utilizationPercent, 40); // 40/100
  assert.equal(d.generatedAt, FIXED_NOW.toISOString());
});

// --- admin dashboard -------------------------------------------------------

test('admin dashboard derives pending approvals from submitted sessions + draft docs + draft plans', async () => {
  const { service } = makeService();
  const d = await service.adminDashboard({ tenantId: 't' });
  assert.equal(d.scope, 'admin');
  assert.equal(d.pendingApprovals, 2 + 3 + 2); // SUBMITTED sessions + DRAFT docs + DRAFT plans
  assert.deepEqual(d.pendingApprovalsBreakdown, { submittedSessions: 2, draftDocuments: 3, draftPlans: 2 });
  assert.equal(d.credentialExpirations, 2);
  assert.equal(d.activeStaff, 8);
  assert.equal(d.inactiveStaff, 1);
  assert.equal(d.archivedPlans, 5);
  assert.equal(d.authorizationUtilization.utilizationPercent, 40);
});

// --- BCBA dashboard --------------------------------------------------------

test('BCBA dashboard scopes today/upcoming to the staff member and counts their active plans', async () => {
  const { service, calls } = makeService();
  const d = await service.bcbaDashboard({ tenantId: 't', staffProfileId: 'st-1' });
  assert.equal(d.scope, 'bcba');
  assert.equal(d.staffProfileId, 'st-1');
  assert.equal(d.activeTreatmentPlans, 4); // from countActivePlansForBcba
  assert.equal(d.caseloadClients, 3); // assigned children (real data, not a session count)
  assert.deepEqual(calls.activePlansForBcba, ['st-1']);
  assert.equal(d.pendingApprovals, 2 + 3); // SUBMITTED sessions + DRAFT docs
  assert.equal(d.todaysSessions, 5);
  assert.equal(d.upcomingAppointments, 5);
  // both the session-window and appointment-window reads carried the staff scope
  assert.ok(calls.sessionsWindow.every((a) => a.staffProfileId === 'st-1'));
  assert.ok(calls.appointmentsWindow.every((a) => a.staffProfileId === 'st-1'));
});

test('BCBA dashboard falls back to org-wide active plans when unscoped', async () => {
  const { service, calls } = makeService();
  const d = await service.bcbaDashboard({ tenantId: 't' });
  assert.equal(d.staffProfileId, null);
  assert.equal(d.activeTreatmentPlans, 9); // org-wide ACTIVE plans
  assert.equal(calls.activePlansForBcba.length, 0);
});

// --- RBT dashboard ---------------------------------------------------------

test('RBT dashboard reports the technician day and session completion statistics', async () => {
  const { service, calls } = makeService();
  const d = await service.rbtDashboard({ tenantId: 't', staffProfileId: 'st-2' });
  assert.equal(d.scope, 'rbt');
  assert.equal(d.staffProfileId, 'st-2');
  assert.equal(d.assignedClients, 3); // assigned children (real assignment data)
  assert.equal(d.todaysSessions, 5);
  assert.equal(d.draftSessions, 6);
  assert.equal(d.submittedSessions, 2);
  assert.equal(d.frozenSessions, 14);
  // completion = FROZEN / total across the scoped session statuses
  assert.equal(d.sessionCompletion.total, 22); // 6 + 2 + 14
  assert.equal(d.sessionCompletion.completed, 14);
  assert.equal(d.sessionCompletion.completionPercent, 64); // round(14/22*100)
  assert.ok(calls.sessionsWindow.every((a) => a.staffProfileId === 'st-2'));
});

// --- derivation edge cases -------------------------------------------------

test('utilization and completion are 0 (not NaN) when there is no data', async () => {
  const { service } = makeService({
    authorizationUtilization: async () => ({ authorizedUnits: 0, usedUnits: 0, activeAuthorizations: 0 }),
    countSessionsByStatus: async () => ({}),
    countSessionsInWindowByStatus: async () => ({}),
  });
  const org = await service.organizationDashboard({ tenantId: 't' });
  assert.equal(org.authorizationUtilization.utilizationPercent, 0);
  assert.equal(org.todaysSessions, 0);
  const rbt = await service.rbtDashboard({ tenantId: 't', staffProfileId: 'st-2' });
  assert.equal(rbt.sessionCompletion.completionPercent, 0);
  assert.equal(rbt.sessionCompletion.total, 0);
});

test('today window is the current UTC day and upcoming is a 7-day horizon', async () => {
  const { service, calls } = makeService();
  await service.organizationDashboard({ tenantId: 't' });
  const win = calls.sessionsWindow[0];
  assert.equal(win.from.toISOString(), '2026-08-07T00:00:00.000Z');
  assert.equal(win.to.toISOString(), '2026-08-08T00:00:00.000Z');
  const appt = calls.appointmentsWindow[0];
  assert.equal(appt.from.toISOString(), FIXED_NOW.toISOString());
  assert.equal(appt.to.toISOString(), '2026-08-14T12:00:00.000Z');
});

// --- RBAC ------------------------------------------------------------------

test('RBAC: dashboards.read is in the catalogue and granted to every system role', () => {
  assert.ok(PERMISSION_KEYS.includes('dashboards.read'), 'dashboards.read is a known permission');
  for (const role of SYSTEM_ROLE_KEYS) {
    assert.ok(
      SYSTEM_ROLE_TEMPLATES[role].some((g) => g.key === 'dashboards.read'),
      `${role} can read dashboards`,
    );
  }
});

// --- tenant isolation ------------------------------------------------------

test('tenant isolation: a dashboard aggregation with no tenant context fails closed', async () => {
  const repo = new DashboardsRepository();
  await assert.rejects(() => repo.countClientsByStatus(undefined), (err) => err instanceof TenantContextError);
  await assert.rejects(() => repo.countSessionsByStatus(undefined, {}), (err) => err instanceof TenantContextError);
  await assert.rejects(() => repo.authorizationUtilization(undefined), (err) => err instanceof TenantContextError);
});

// --- endpoint contract -----------------------------------------------------

test('endpoint contract: dashboard reads are never audited (no catalogue entries, GET only)', () => {
  const dash = AUDIT_CATALOGUE.filter((e) => e.pattern.includes('/dashboards'));
  assert.equal(dash.length, 0, 'no dashboard route is catalogued for audit');
  assert.equal(AUDIT_CATALOGUE.some((e) => e.method === 'GET'), false, 'the catalogue records writes only');
});

test('endpoint contract: the router mounts guarded GET dashboards (incl. company)', async () => {
  const { createDashboardsRouter } = await import('../src/modules/dashboards/dashboards.routes.js');
  const router = createDashboardsRouter({});
  const paths = router.stack
    .filter((l) => l.route)
    .map((l) => ({ path: l.route.path, methods: Object.keys(l.route.methods) }));
  const byPath = Object.fromEntries(paths.map((p) => [p.path, p.methods]));
  assert.deepEqual(Object.keys(byPath).sort(), ['/admin', '/bcba', '/company', '/organization', '/rbt']);
  for (const methods of Object.values(byPath)) {
    assert.deepEqual(methods, ['get'], 'dashboards are read-only GET routes');
  }
});

// --- BCBA-403 regression: narrowing scope with no clinician profile --------
// Reproduces the reported `GET /api/v1/dashboards/bcba → 403` for a valid BCBA
// whose user↔StaffProfile link is unresolved. The controller guard must yield
// an EMPTY personal board, never a 403 (blocks a valid BCBA) and never the
// tenant-wide branch (discloses whole-clinic figures).

import { DashboardsController } from '../src/modules/dashboards/dashboards.controller.js';

test('subjectStaff: resolved profile → own board', () => {
  const req = { query: {}, dataScope: { staffProfileId: 'st-9', clientIds: ['c1'], staffIds: ['st-9'] } };
  assert.deepEqual(DashboardsController.subjectStaff(req), { staffProfileId: 'st-9' });
});

test('subjectStaff: tenant-wide admin (clientIds null) → unscoped board', () => {
  const req = { query: {}, dataScope: { staffProfileId: null, clientIds: null, staffIds: null } };
  assert.deepEqual(DashboardsController.subjectStaff(req), {});
});

test('subjectStaff: narrowing scope, no profile → empty board signal, NOT 403', () => {
  // TEAM scope resolved to no StaffProfile: clientIds is [] (not null), staffProfileId null.
  const req = { query: {}, dataScope: { scope: 'TEAM', staffProfileId: null, clientIds: [], staffIds: [] } };
  assert.deepEqual(DashboardsController.subjectStaff(req), { subjectMissing: true });
});

test('subjectStaff: requesting an out-of-scope subject still 403s', () => {
  const req = { query: { staffProfileId: 'someone-else' }, dataScope: { staffProfileId: 'st-1', clientIds: ['c1'], staffIds: ['st-1'] } };
  assert.throws(() => DashboardsController.subjectStaff(req), /access to this dashboard/);
});

test('subjectStaff: a supervisor may request a supervisee in scope', () => {
  const req = { query: { staffProfileId: 'sup-2' }, dataScope: { staffProfileId: 'st-1', clientIds: ['c1'], staffIds: ['st-1', 'sup-2'] } };
  assert.deepEqual(DashboardsController.subjectStaff(req), { staffProfileId: 'sup-2' });
});

test('bcbaDashboard(subjectMissing) returns a zeroed board and never touches the repository', async () => {
  const { service, calls } = makeService();
  const d = await service.bcbaDashboard({ tenantId: 't', subjectMissing: true });
  assert.equal(d.scope, 'bcba');
  assert.equal(d.staffProfileId, null);
  assert.equal(d.todaysSessions, 0);
  assert.equal(d.upcomingAppointments, 0);
  assert.equal(d.activeTreatmentPlans, 0);
  assert.equal(d.pendingApprovals, 0);
  // The smoking gun: no scoped OR unscoped repo query ran, so no tenant-wide leak.
  assert.equal(calls.sessionsWindow.length, 0);
  assert.equal(calls.appointmentsWindow.length, 0);
  assert.equal(calls.activePlansForBcba.length, 0);
});

test('rbtDashboard(subjectMissing) returns a zeroed board and never touches the repository', async () => {
  const { service, calls } = makeService();
  const d = await service.rbtDashboard({ tenantId: 't', subjectMissing: true });
  assert.equal(d.scope, 'rbt');
  assert.equal(d.staffProfileId, null);
  assert.equal(d.todaysSessions, 0);
  assert.equal(d.upcomingAppointments, 0);
  assert.equal(d.sessionCompletion.total, 0);
  assert.equal(d.sessionCompletion.completionPercent, 0);
  assert.equal(calls.sessionsWindow.length, 0);
  assert.equal(calls.appointmentsWindow.length, 0);
});
