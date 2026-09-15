/**
 * The notification matrix (§6.10) — every notification defined once. Empty at
 * Phase 1, exactly as the original: the types are raised by clinical, billing
 * and console modules that don't exist yet, each registering its own as it's
 * built. The framework is complete and exercised in tests with representative
 * descriptors; production simply has nothing to raise until a producer arrives.
 * @type {readonly object[]}
 */
export const NOTIFICATION_MATRIX = [
  // Staff & credentials (Phase 2 · Module 2): the first real producer. Raised by
  // the credential-expiry scan to admins and supervisors. Not mandatory (may be
  // muted off-platform); in-app can never be opted out. Carries no PHI.
  {
    type: 'staff.credential_expiring',
    channels: ['in_app', 'email'],
    priority: 'normal',
    mandatory: false,
    audience: { roles: ['org_admin', 'bcba'] },
  },
  // Admin-initiated ad-hoc message to a child's care team (Phase 7). Recipients
  // are supplied explicitly (context.recipientUserIds) after the server re-checks
  // the current assignment, so there is no audience block. Carries no PHI: the
  // body is an admin-authored message, not clinical data.
  {
    type: 'care_team.message',
    channels: ['in_app', 'email'],
    priority: 'normal',
    mandatory: false,
    audience: { roles: [] },
  },
];
