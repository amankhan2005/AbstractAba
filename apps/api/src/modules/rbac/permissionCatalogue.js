/**
 * Code-declared permission catalogue — the closed set of permission keys the
 * platform recognises. Code, not data: the foundation permissions are identical
 * across every tenant and not tenant-editable. Ported from the original RBAC
 * engine (Module 5). Scopes: PLATFORM, ORGANIZATION, TEAM, SELF.
 */
export const SCOPES = ['PLATFORM', 'ORGANIZATION', 'TEAM', 'SELF'];

export const PERMISSION_CATALOGUE = Object.freeze([
  // organization
  { key: 'organization.read', scope: 'ORGANIZATION' },
  { key: 'organization.update', scope: 'ORGANIZATION' },
  { key: 'organization.offboard_request', scope: 'ORGANIZATION' },
  { key: 'organization.export', scope: 'ORGANIZATION' },
  { key: 'organization.usage.read', scope: 'ORGANIZATION' },
  // audit
  { key: 'audit.read', scope: 'ORGANIZATION' },
  // clients (Phase 2 · clinical spine)
  { key: 'clients.read', scope: 'ORGANIZATION' },
  { key: 'clients.create', scope: 'ORGANIZATION' },
  { key: 'clients.update', scope: 'ORGANIZATION' },
  // Care-team assignment is a distinct capability from editing a child's
  // clinical record. Assigning/replacing/removing the BCBA or RBT decides WHO
  // works with a child — an operational (Company/Admin) authority, never a
  // clinician one. Splitting it out of clients.update is what stops a BCBA (who
  // holds clients.update at TEAM scope to edit clinical fields on their
  // caseload) from also mutating the care team via a direct API call. Blueprint:
  // "Company controls WHO works with the child."
  { key: 'clients.care_team.manage', scope: 'ORGANIZATION' },
  // Medical conditions/history are Company/Admin-owned child administration,
  // distinct from a clinician reading them. A BCBA/RBT reads medical data
  // (scoped + field-filtered) but cannot create/edit/delete it.
  { key: 'clients.medical.manage', scope: 'ORGANIZATION' },
  // Recording a verification is the fact the scheduling gate trusts, so it is
  // a distinct permission from editing the coverage details (blueprint 6.9).
  { key: 'clients.verify_insurance', scope: 'ORGANIZATION' },
  { key: 'clients.archive', scope: 'ORGANIZATION' },
  // staff & credentials (Phase 2 · clinical spine)
  { key: 'staff.read', scope: 'ORGANIZATION' },
  { key: 'staff.manage', scope: 'ORGANIZATION' },
  { key: 'credentials.read', scope: 'ORGANIZATION' },
  { key: 'credentials.manage', scope: 'ORGANIZATION' },
  // scheduling & calendar (Phase 2 · clinical spine)
  { key: 'scheduling.read', scope: 'ORGANIZATION' },
  { key: 'scheduling.write', scope: 'ORGANIZATION' },
  { key: 'scheduling.manage', scope: 'ORGANIZATION' },
  // clinical plans, goals, programs & targets (Phase 2 · clinical spine)
  { key: 'plans.read', scope: 'ORGANIZATION' },
  { key: 'plans.create', scope: 'ORGANIZATION' },
  { key: 'plans.update', scope: 'ORGANIZATION' },
  { key: 'plans.archive', scope: 'ORGANIZATION' },
  // session capture & freeze (Phase 2 · clinical spine)
  { key: 'sessions.read', scope: 'ORGANIZATION' },
  { key: 'sessions.write', scope: 'ORGANIZATION' },
  { key: 'sessions.freeze', scope: 'ORGANIZATION' },
  // clinical documents (Phase 2 · clinical spine)
  { key: 'documents.read', scope: 'ORGANIZATION' },
  { key: 'documents.write', scope: 'ORGANIZATION' },
  { key: 'documents.finalize', scope: 'ORGANIZATION' },
  // role dashboards (Phase 2 · clinical spine) — read-only aggregation
  { key: 'dashboards.read', scope: 'ORGANIZATION' },
  // users / roles / permissions
  { key: 'users.read', scope: 'ORGANIZATION' },
  { key: 'users.invite', scope: 'ORGANIZATION' },
  { key: 'users.manage', scope: 'ORGANIZATION' },
  { key: 'users.role.assign', scope: 'ORGANIZATION' },
  { key: 'roles.read', scope: 'ORGANIZATION' },
  { key: 'permissions.read', scope: 'ORGANIZATION' },
  // platform (held via isPlatformOperator, never a tenant role)
  { key: 'platform.tenant.create', scope: 'PLATFORM' },
  { key: 'platform.tenant.read', scope: 'PLATFORM' },
  { key: 'platform.tenant.transition', scope: 'PLATFORM' },
  { key: 'platform.tenant.provision', scope: 'PLATFORM' },
  { key: 'platform.tenant.agreement', scope: 'PLATFORM' },
  { key: 'platform.tenant.offboard', scope: 'PLATFORM' },
  { key: 'platform.tenant.destroy_approve', scope: 'PLATFORM' },
  { key: 'platform.tenant.invite_owner', scope: 'PLATFORM' },
  // billing & payments (Phase 3.1) — company-scoped read/manage for tenant users
  { key: 'billing.read', scope: 'ORGANIZATION' },
  { key: 'billing.manage', scope: 'ORGANIZATION' },
  // timesheets & payroll (Phase 3.2)
  { key: 'timesheets.read', scope: 'ORGANIZATION' },
  { key: 'timesheets.write', scope: 'ORGANIZATION' },
  { key: 'timesheets.approve', scope: 'ORGANIZATION' },
  { key: 'payroll.read', scope: 'ORGANIZATION' },
  { key: 'payroll.manage', scope: 'ORGANIZATION' },
  // claims & ERA / remittance (Phase 3.3)
  { key: 'claims.read', scope: 'ORGANIZATION' },
  { key: 'claims.write', scope: 'ORGANIZATION' },
  { key: 'claims.submit', scope: 'ORGANIZATION' },
  { key: 'claims.manage', scope: 'ORGANIZATION' },
  { key: 'era.read', scope: 'ORGANIZATION' },
  { key: 'era.process', scope: 'ORGANIZATION' },
  { key: 'era.resolve', scope: 'ORGANIZATION' },
  // reconciliation & financial reporting (Phase 3.4)
  { key: 'reconciliation.read', scope: 'ORGANIZATION' },
  { key: 'reconciliation.manage', scope: 'ORGANIZATION' },
  { key: 'finance.reports.read', scope: 'ORGANIZATION' },
  { key: 'finance.export', scope: 'ORGANIZATION' },
  // supervision workflow (Phase 4.2) — clinical supervisors log & sign off
  // observations and record supervision hours. Viewing reuses staff.read.
  { key: 'supervision.log', scope: 'ORGANIZATION' },
  { key: 'supervision.signoff', scope: 'ORGANIZATION' },
]);

export const PERMISSION_KEYS = Object.freeze(PERMISSION_CATALOGUE.map((p) => p.key));

const byKey = new Map(PERMISSION_CATALOGUE.map((p) => [p.key, p]));
export function isKnownPermission(key) {
  return byKey.has(key);
}
