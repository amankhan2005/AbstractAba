import { describe, it, expect } from 'vitest';
import { workspaceForRoles, resolveWorkspaceNav, WORKSPACES } from './workspaces';

/**
 * ---------------------------------------------------------------------------
 * FOUR WORKSPACES.
 *
 * These pin the behaviour that makes the four experiences genuinely distinct
 * rather than one sidebar with rows hidden:
 *
 *   - each role resolves to its OWN workspace archetype (own name, own
 *     sections, own terminology);
 *   - a multi-role user gets the WIDEST workspace they hold;
 *   - the archetype's shape is preserved, but items the user's grants don't
 *     cover are dropped, so the opinionated layout stays correct at the edges.
 *
 * The security boundary is not tested here because it does not live here: every
 * route is guarded server-side, so which workspace renders only changes what a
 * user sees first, never what they may reach (blueprint §11.4).
 * ---------------------------------------------------------------------------
 */

describe('workspaceForRoles', () => {
  it('gives each primary role its own workspace', () => {
    expect(workspaceForRoles(['owner']).id).toBe('company');
    expect(workspaceForRoles(['org_admin']).id).toBe('company');
    expect(workspaceForRoles(['bcba']).id).toBe('bcba');
    expect(workspaceForRoles(['rbt']).id).toBe('rbt');
  });

  it('gives a multi-role user the WIDEST workspace they hold', () => {
    // Scope ladder: company > bcba > rbt. The widest contains the others' work.
    expect(workspaceForRoles(['rbt', 'bcba']).id).toBe('bcba');
    expect(workspaceForRoles(['bcba', 'owner']).id).toBe('company');
    expect(workspaceForRoles(['rbt', 'org_admin', 'bcba']).id).toBe('company');
  });

  it('defaults to the company workspace for an unrecognised role set', () => {
    expect(workspaceForRoles([]).id).toBe('company');
    expect(workspaceForRoles(['billing_staff']).id).toBe('company');
  });

  it('each workspace has a distinct name and scope label', () => {
    const names = Object.values(WORKSPACES).map((w) => w.name);
    expect(new Set(names).size).toBe(names.length);
    for (const w of Object.values(WORKSPACES)) {
      expect(w.name).toBeTruthy();
      expect(w.scopeLabel).toBeTruthy();
      expect(w.home).toMatch(/^\//);
    }
  });

  it('uses role-appropriate terminology, not one generic label set', () => {
    // The technician calls it "My day"; the company calls the same area a
    // dashboard. That divergence is the point.
    const rbtLabels = WORKSPACES.rbt.sections.flatMap((s) => s.items.map((i) => i.label));
    expect(rbtLabels).toContain('My day');
    expect(rbtLabels).not.toContain('My hours'); // Timesheets page removed
    expect(rbtLabels).toContain('My clients');

    const companyLabels = WORKSPACES.company.sections.flatMap((s) => s.items.map((i) => i.label));
    expect(companyLabels).toContain('Clients');
    expect(companyLabels).not.toContain('My clients');

    const bcbaLabels = WORKSPACES.bcba.sections.flatMap((s) => s.items.map((i) => i.label));
    expect(bcbaLabels).toContain('My caseload');
    expect(bcbaLabels).toContain('Supervisees');
  });
});

describe('resolveWorkspaceNav', () => {
  const allCompanyPerms = [
    'dashboards.read', 'clients.read', 'staff.read', 'scheduling.read', 'sessions.read',
    'billing.read', 'claims.read', 'timesheets.read', 'payroll.read', 'finance.reports.read',
    'organization.update',
  ];
  const allScopesOrg = Object.fromEntries(allCompanyPerms.map((p) => [p, 'ORGANIZATION']));

  it('keeps a section only when the user holds at least one of its items', () => {
    const nav = resolveWorkspaceNav(WORKSPACES.company, allCompanyPerms, allScopesOrg);
    const labels = nav.map((s) => s.label);
    expect(labels).toContain('Overview');
    expect(labels).toContain('Care');
    expect(labels).toContain('Revenue cycle');
    expect(labels).toContain('Settings');
  });

  it('drops items the user lacks the permission for', () => {
    // A user with only clients.read in the company workspace keeps Clients and
    // loses billing, payroll, branding — the shape stays, the gaps close.
    const nav = resolveWorkspaceNav(WORKSPACES.company, ['clients.read'], { 'clients.read': 'ORGANIZATION' });
    const items = nav.flatMap((s) => s.items.map((i) => i.to));
    expect(items).toContain('/clients');
    expect(items).not.toContain('/billing');
    expect(items).not.toContain('/payroll');
    expect(items).not.toContain('/settings/branding');
  });

  it('drops an item whose minimum scope the user does not meet', () => {
    // The company workspace shows Staff only at TEAM+; a self-scoped staff.read
    // (a technician's own record) does not qualify.
    const nav = resolveWorkspaceNav(
      WORKSPACES.company,
      ['clients.read', 'staff.read'],
      { 'clients.read': 'ORGANIZATION', 'staff.read': 'SELF' },
    );
    const items = nav.flatMap((s) => s.items.map((i) => i.to));
    expect(items).toContain('/clients');
    expect(items).not.toContain('/staff');
  });

  it('keeps a min-scope item when the scope is met', () => {
    const nav = resolveWorkspaceNav(
      WORKSPACES.bcba,
      ['staff.read', 'supervision.log'],
      { 'staff.read': 'TEAM' },
    );
    const items = nav.flatMap((s) => s.items.map((i) => i.to));
    expect(items).toContain('/staff');
  });

  it('returns no empty sections', () => {
    const nav = resolveWorkspaceNav(WORKSPACES.rbt, ['sessions.read'], { 'sessions.read': 'SELF' });
    for (const section of nav) {
      expect(section.items.length).toBeGreaterThan(0);
    }
  });

  it('an RBT with the standard grants sees a personal, self-scoped workspace', () => {
    const perms = ['dashboards.read', 'sessions.read', 'scheduling.read', 'clients.read', 'plans.read', 'timesheets.read'];
    const scopes = Object.fromEntries(perms.map((p) => [p, 'SELF']));
    const nav = resolveWorkspaceNav(WORKSPACES.rbt, perms, scopes);
    const labels = nav.flatMap((s) => s.items.map((i) => i.label));
    expect(labels).toContain('My day');
    expect(labels).toContain('My sessions');
    expect(nav.flatMap((s) => s.items.map((i) => i.to))).not.toContain('/payroll/timesheets');
    // No company revenue surfaces exist in this archetype at all.
    const routes = nav.flatMap((s) => s.items.map((i) => i.to));
    expect(routes).not.toContain('/billing');
    expect(routes).not.toContain('/payroll');
  });
});
