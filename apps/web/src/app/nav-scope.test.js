import { describe, it, expect } from 'vitest';
import { buildAppNav } from '@/app/nav';

/**
 * NAVIGATION SCOPE FILTERING.
 *
 * Permission alone produced a misleading sidebar: every shipped role holds
 * `staff.read` and `timesheets.read`, so a technician saw "Staff" and
 * "Timesheets". The server answered with their own record and own hours, so
 * nothing leaked — but the sidebar promised the company directory and the
 * company's payroll, which is a bug in what the interface CLAIMS even when the
 * data is correct.
 *
 * These tests are about honesty of the interface, not about security. The
 * server re-checks every permission and narrows every query regardless of what
 * rendered here (blueprint §11.4: the interface "is a convenience, never the
 * boundary"), and `access-boundaries.test.js` on the API side is what proves
 * the actual boundary holds.
 */

// Scope fixtures mirroring the shipped role templates.
const RBT = {
  permissions: ['clients.read', 'sessions.read', 'sessions.write', 'plans.read', 'scheduling.read', 'staff.read', 'timesheets.read', 'dashboards.read', 'documents.read'],
  scopes: {
    'clients.read': 'SELF', 'sessions.read': 'SELF', 'sessions.write': 'SELF',
    'plans.read': 'SELF', 'scheduling.read': 'SELF', 'staff.read': 'SELF',
    'timesheets.read': 'SELF', 'dashboards.read': 'SELF', 'documents.read': 'SELF',
  },
};

const BCBA = {
  permissions: ['clients.read', 'clients.update', 'plans.read', 'plans.create', 'plans.update', 'sessions.read', 'sessions.freeze', 'scheduling.read', 'scheduling.write', 'staff.read', 'supervision.log', 'timesheets.read', 'dashboards.read', 'documents.read'],
  scopes: {
    'clients.read': 'TEAM', 'clients.update': 'TEAM', 'plans.read': 'TEAM',
    'plans.create': 'TEAM', 'plans.update': 'TEAM', 'sessions.read': 'TEAM',
    'sessions.freeze': 'TEAM', 'scheduling.read': 'TEAM', 'scheduling.write': 'TEAM',
    'staff.read': 'TEAM', 'supervision.log': 'TEAM', 'timesheets.read': 'SELF',
    'dashboards.read': 'TEAM', 'documents.read': 'TEAM',
  },
};

const COMPANY = {
  permissions: ['clients.read', 'clients.create', 'staff.read', 'staff.manage', 'scheduling.read', 'scheduling.write', 'plans.read', 'sessions.read', 'billing.read', 'timesheets.read', 'payroll.read', 'claims.read', 'era.read', 'reconciliation.read', 'finance.reports.read', 'dashboards.read', 'documents.read', 'organization.export'],
  scopes: {}, // all ORGANIZATION — the default when a key is unlisted
};

const navFor = (role) => buildAppNav(role.permissions, role.scopes);
const labels = (role) => navFor(role).map((n) => n.label);
const routes = (role) => navFor(role).map((n) => n.to);

describe('RBT navigation', () => {
  it('names own-scope screens honestly', () => {
    expect(labels(RBT)).toContain('My clients');
    expect(labels(RBT)).toContain('My sessions');
    expect(labels(RBT)).toContain('My schedule');
  });

  it('REGRESSION — does not offer the staff directory to a technician', () => {
    // staff.read at SELF resolves to "yourself", so a "Staff" link promises a
    // roster and delivers one row.
    expect(routes(RBT)).not.toContain('/staff');
  });

  it('REGRESSION — does not offer company payroll, billing or finance', () => {
    // §4.5: "No financial visibility beyond their own hours."
    for (const route of ['/payroll', '/billing', '/claims', '/era', '/reconciliation', '/reports']) {
      expect(routes(RBT)).not.toContain(route);
    }
  });

  it('does not offer clinic-wide search or recurring-series building', () => {
    expect(routes(RBT)).not.toContain('/search');
    expect(routes(RBT)).not.toContain('/scheduling/recurring');
  });

  it('does not offer data tools or supervision', () => {
    expect(routes(RBT)).not.toContain('/data-tools');
    expect(routes(RBT)).not.toContain('/supervision');
  });
});

describe('BCBA navigation', () => {
  it('offers the clinical surfaces at caseload breadth', () => {
    expect(routes(BCBA)).toContain('/clients');
    expect(routes(BCBA)).toContain('/plans');
    expect(routes(BCBA)).toContain('/sessions');
    expect(routes(BCBA)).toContain('/supervision');
    expect(routes(BCBA)).toContain('/staff'); // TEAM scope: their supervisees
  });

  it('uses plain names, not "my", because a caseload is more than their own', () => {
    expect(labels(BCBA)).toContain('Clients');
    expect(labels(BCBA)).toContain('Sessions');
    expect(labels(BCBA)).not.toContain('My clients');
  });

  it('REGRESSION — offers no billing, claims or payroll surface', () => {
    // §4.4 "Cannot do": alter billing rates, claim lines, or payroll.
    for (const route of ['/billing', '/claims', '/era', '/reconciliation', '/reports', '/payroll']) {
      expect(routes(BCBA)).not.toContain(route);
    }
  });

  it('has no link to the removed Timesheets / My hours page', () => {
    for (const role of [RBT, BCBA, COMPANY]) {
      expect(routes(role)).not.toContain('/payroll/timesheets');
      expect(labels(role)).not.toContain('My hours');
    }
  });
});

describe('Company navigation', () => {
  it('retains organization-wide management surfaces', () => {
    for (const route of ['/clients', '/staff', '/scheduling', '/billing', '/payroll', '/reports', '/data-tools', '/search']) {
      expect(routes(COMPANY)).toContain(route);
    }
  });

  it('uses company-wide names, never the "my" variants', () => {
    expect(labels(COMPANY)).toContain('Clients');
    expect(labels(COMPANY)).not.toContain('Timesheets'); // page removed
    for (const own of ['My clients', 'My sessions', 'My hours', 'My schedule']) {
      expect(labels(COMPANY)).not.toContain(own);
    }
  });

  it('sees strictly more of the application than a BCBA, who sees more than an RBT', () => {
    expect(routes(COMPANY).length).toBeGreaterThan(routes(BCBA).length);
    expect(routes(BCBA).length).toBeGreaterThan(routes(RBT).length);
  });
});

describe('degradation and safety', () => {
  it('falls back to organization scope when the API sent no scopes', () => {
    // A token issued before permissionScopes shipped must not empty the
    // sidebar; it degrades to the previous permission-only behaviour.
    const nav = buildAppNav(['clients.read', 'staff.read'], undefined);
    expect(nav.map((n) => n.to)).toContain('/clients');
    expect(nav.map((n) => n.to)).toContain('/staff');
    expect(nav.map((n) => n.label)).toContain('Clients');
  });

  it('a principal with no permissions still gets Home and nothing else', () => {
    const nav = buildAppNav([], {});
    expect(nav).toHaveLength(1);
    expect(nav[0].to).toBe('/');
  });

  it('never renders a link for a permission the principal lacks entirely', () => {
    const nav = buildAppNav(['clients.read'], { 'clients.read': 'ORGANIZATION' });
    expect(nav.map((n) => n.to)).toEqual(['/', '/search', '/clients']);
  });
});
