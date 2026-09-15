/**
 * ---------------------------------------------------------------------------
 * WORKSPACE DEFINITIONS — the four distinct experiences.
 *
 * This is the data behind "four workspaces, not one shell with hidden items".
 * Each workspace has its OWN identity, sidebar sections, terminology and
 * primary action — a company admin sees "Clients / Care Team / Payroll" grouped
 * as clinic operations, a technician sees "My day / My clients / My hours" as a
 * personal worklist, and the two never resolve to the same navigation with
 * rows filtered out.
 *
 * Every nav item still carries the permission that governs it, so the sidebar
 * degrades correctly for a user whose grants don't match the archetype exactly
 * (a billing specialist inside the company workspace, say). But the SHAPE —
 * the grouping, the labels, the order, the workspace name — is chosen per role,
 * which is what makes each feel like its own product.
 *
 * Security note: none of this is a boundary. Every route these link to is
 * guarded server-side by permission and data scope; the workspace a user gets
 * changes what they SEE FIRST, never what they may reach (blueprint §11.4).
 * ---------------------------------------------------------------------------
 */

/** Section = a labelled group of items. Items carry the permission that gates them. */

const COMPANY_WORKSPACE = {
  id: 'company',
  name: 'Clinic Operations',
  // The scope word shown in the header — this workspace runs the whole org.
  scopeLabel: 'Organization',
  home: '/dashboards/organization',
  sections: [
    {
      label: 'Overview',
      items: [
        { to: '/dashboards/organization', label: 'Dashboard', perm: 'dashboards.read', end: false },
      ],
    },
    {
      label: 'Care',
      items: [
        { to: '/clients', label: 'Clients', perm: 'clients.read', end: false },
        { to: '/staff', label: 'Staff', perm: 'staff.read', minScope: 'TEAM', end: false },
        { to: '/scheduling', label: 'Scheduling', perm: 'scheduling.read', end: false },
        { to: '/sessions', label: 'Sessions', perm: 'sessions.read', end: false },
      ],
    },
    {
      label: 'Revenue cycle',
      items: [
        { to: '/billing', label: 'Billing', perm: 'billing.read', end: false },
        { to: '/payroll', label: 'Payroll', perm: 'payroll.read', end: true },
        { to: '/reports', label: 'Financial reports', perm: 'finance.reports.read', end: false },
      ],
    },
    {
      label: 'Settings',
      items: [
        { to: '/settings/branding', label: 'Branding', perm: 'organization.update', end: true },
        { to: '/settings/email-templates', label: 'Email Templates', perm: 'clients.update', end: true },
      ],
    },
  ],
};

const BCBA_WORKSPACE = {
  id: 'bcba',
  name: 'Clinical Supervision',
  scopeLabel: 'My caseload',
  home: '/dashboards/bcba',
  sections: [
    {
      label: 'Overview',
      items: [
        { to: '/dashboards/bcba', label: 'Dashboard', perm: 'dashboards.read', end: false },
      ],
    },
    {
      label: 'Caseload',
      items: [
        // A BCBA's clients ARE their caseload — the label says so.
        { to: '/clients', label: 'My caseload', perm: 'clients.read', end: false },
        { to: '/plans', label: 'Plans', perm: 'plans.read', end: false },
        { to: '/sessions', label: 'Sessions', perm: 'sessions.read', end: false },
        { to: '/scheduling', label: 'Schedule', perm: 'scheduling.read', end: false },
      ],
    },
    {
      label: 'Supervision',
      items: [
        { to: '/staff', label: 'Supervisees', perm: 'staff.read', minScope: 'TEAM', end: false },
        { to: '/supervision', label: 'Supervision log', perm: 'supervision.log', end: false },
      ],
    },
  ],
};

const RBT_WORKSPACE = {
  id: 'rbt',
  name: 'My Workspace',
  scopeLabel: 'My work',
  home: '/dashboards/rbt',
  sections: [
    {
      label: 'Today',
      items: [
        { to: '/dashboards/rbt', label: 'My day', perm: 'dashboards.read', end: false },
        { to: '/sessions', label: 'My sessions', perm: 'sessions.read', end: false },
        { to: '/scheduling', label: 'My schedule', perm: 'scheduling.read', end: false },
      ],
    },
    {
      label: 'My work',
      items: [
        { to: '/clients', label: 'My clients', perm: 'clients.read', end: false },
        { to: '/plans', label: 'My programs', perm: 'plans.read', end: false },
      ],
    },
  ],
};

/**
 * The four workspace archetypes, highest scope first. A user's workspace is the
 * widest archetype whose lead role they hold — the same precedence the landing
 * redirect uses, so the sidebar and the landing agree.
 */
export const WORKSPACES = {
  company: COMPANY_WORKSPACE,
  bcba: BCBA_WORKSPACE,
  rbt: RBT_WORKSPACE,
};

const ROLE_TO_WORKSPACE = [
  ['owner', 'company'],
  ['org_admin', 'company'],
  ['bcba', 'bcba'],
  ['rbt', 'rbt'],
];

/** Which workspace a set of roles resolves to. */
export function workspaceForRoles(roles = []) {
  const match = ROLE_TO_WORKSPACE.find(([role]) => roles.includes(role));
  return match ? WORKSPACES[match[1]] : COMPANY_WORKSPACE;
}

const SCOPE_RANK = { SELF: 1, TEAM: 2, ORGANIZATION: 3, PLATFORM: 4 };

/**
 * Resolves a workspace definition against the principal's actual grants: drops
 * items whose permission the user lacks, or whose minimum scope they don't
 * meet, and drops any section left empty. This is what lets the archetype be
 * opinionated about SHAPE while still being correct for a user whose grants
 * differ at the edges.
 */
export function resolveWorkspaceNav(workspace, permissions = [], permissionScopes = {}) {
  const has = (perm) => !perm || permissions.includes(perm);
  const meetsScope = (item) => {
    if (!item.minScope) return true;
    const rank = SCOPE_RANK[permissionScopes[item.perm]] ?? 0;
    return rank >= SCOPE_RANK[item.minScope];
  };

  return workspace.sections
    .map((section) => ({
      label: section.label,
      items: section.items.filter((item) => has(item.perm) && meetsScope(item)),
    }))
    .filter((section) => section.items.length > 0);
}
