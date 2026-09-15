/**
 * Builds the tenant shell's navigation from the principal's permissions AND the
 * scope each was granted at. Kept as a pure function so the gating is
 * unit-tested without rendering.
 *
 * WHY SCOPE MATTERS HERE. Permission alone produced a misleading sidebar. Every
 * shipped role holds `staff.read` and `timesheets.read`, so a technician saw
 * "Staff" and "Timesheets" — both of which read, to a user, as the company
 * directory and the company's payroll. The server answers those requests with
 * the technician's own record and own hours, so nothing leaked; but a person
 * clicking "Staff" and finding one row reasonably concludes the software is
 * broken. Blueprint §5.5: "If a user lacks every permission in a module, the
 * module does not render" — and §6.14b treats the interface as something that
 * should tell the truth about what it will show you.
 *
 * The label therefore follows the scope: an own-scope sessions screen is
 * "My sessions", not "Sessions". Same route, same server enforcement, honest
 * name.
 *
 * THIS IS UX, NOT SECURITY. The server re-checks every permission and narrows
 * every query by the same scope regardless of what the sidebar rendered.
 * Blueprint §11.4: the interface "is a convenience, never the boundary."
 */

/** Scope ordering, mirroring the API's resolution (widest wins). */
const RANK = { SELF: 1, TEAM: 2, ORGANIZATION: 3, PLATFORM: 4 };

/**
 * @param {string[]} permissions   permission keys the principal holds
 * @param {Record<string,string>} permissionScopes  key → scope, from /auth/me.
 *   Absent for a token issued before scopes shipped; treated as ORGANIZATION so
 *   the navigation degrades to its previous behaviour rather than emptying.
 */
export function buildAppNav(permissions = [], permissionScopes = {}) {
  const has = (key) => permissions.includes(key);
  const scopeOf = (key) => permissionScopes[key] ?? 'ORGANIZATION';
  const atLeast = (key, min) => has(key) && (RANK[scopeOf(key)] ?? 0) >= RANK[min];
  const isOwnScope = (key) => has(key) && scopeOf(key) === 'SELF';

  return [
    { to: '/', label: 'Home', end: true },

    // Global search is a company-wide affordance. §5.5 scopes its results
    // server-side, but offering it to someone whose every read is own-scope
    // promises a search of the clinic and delivers a search of their own three
    // records.
    ...((['clients.read', 'staff.read', 'scheduling.read', 'documents.read', 'claims.read']
      .some((p) => atLeast(p, 'TEAM')))
      ? [{ to: '/search', label: 'Search', end: true }] : []),

    ...((['clients.create', 'staff.manage', 'organization.export'].some((p) => has(p)))
      ? [{ to: '/data-tools', label: 'Data tools', end: true }] : []),

    ...(has('dashboards.read') ? [{ to: '/dashboards', label: 'Dashboards', end: false }] : []),

    // A technician's client list is their assigned children, so name it that.
    ...(has('clients.read')
      ? [{ to: '/clients', label: isOwnScope('clients.read') ? 'My clients' : 'Clients', end: false }] : []),

    // Staff directory: only for someone who can see more than themselves.
    ...(atLeast('staff.read', 'TEAM') ? [{ to: '/staff', label: 'Staff', end: false }] : []),

    ...(has('scheduling.read')
      ? [{ to: '/scheduling', label: isOwnScope('scheduling.read') ? 'My schedule' : 'Scheduling', end: false }] : []),

    // Recurring series is a scheduler/admin construction surface, not a
    // technician one — building a series requires scheduling.write at breadth.
    ...(atLeast('scheduling.write', 'TEAM')
      ? [{ to: '/scheduling/recurring', label: 'Recurring', end: true }] : []),

    ...(has('plans.read')
      ? [{ to: '/plans', label: isOwnScope('plans.read') ? 'My programs' : 'Plans', end: false }] : []),

    ...(has('sessions.read')
      ? [{ to: '/sessions', label: isOwnScope('sessions.read') ? 'My sessions' : 'Sessions', end: false }] : []),

    ...(has('supervision.log') ? [{ to: '/supervision', label: 'Supervision', end: false }] : []),
    ...(has('documents.read') ? [{ to: '/documents', label: 'Documents', end: false }] : []),
    ...(has('billing.read') ? [{ to: '/billing', label: 'Billing', end: false }] : []),

    // The Timesheets page was removed from the app (payroll is computed from
    // SessionTimeRecord worked minutes on /payroll); the timesheet/time-entry
    // backend is untouched, but there is no nav entry for a page that no
    // longer exists.
    ...(has('payroll.read') ? [{ to: '/payroll', label: 'Payroll', end: true }] : []),
    ...(has('era.read') ? [{ to: '/era', label: 'ERA / Remittance', end: false }] : []),
    ...(has('reconciliation.read') ? [{ to: '/reconciliation', label: 'Reconciliation', end: false }] : []),
    ...(has('finance.reports.read') ? [{ to: '/reports', label: 'Financial reports', end: false }] : []),

    // Branding is an organization-administration surface (blueprint 6.14), so
    // it follows organization.update rather than a role name — a clinical
    // manager who holds it sees it, a technician never does.
    ...(has('organization.update') ? [{ to: '/settings/branding', label: 'Branding', end: true }] : []),
  ];
}
