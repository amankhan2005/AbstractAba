import { describe, it, expect } from 'vitest';
import { landingPathFor } from './RoleLanding';

/**
 * ROLE-AWARE LANDING.
 *
 * Every role used to land on the same "you are signed in" card, then hunt for
 * their dashboard through a menu. landingPathFor sends each role to the
 * workspace root matching their job.
 *
 * The security-relevant point these tests fix in place: this is a REDIRECT
 * decision, not an authorization surface. Landing an RBT on the RBT board
 * grants nothing — the board's API calls are scoped server-side, so this only
 * decides which URL opens first (blueprint §11.4).
 */

describe('landingPathFor', () => {
  it('sends owner and org admin to the organization workspace', () => {
    expect(landingPathFor({ roles: ['owner'] })).toBe('/dashboards/organization');
    expect(landingPathFor({ roles: ['org_admin'] })).toBe('/dashboards/organization');
  });

  it('sends a BCBA to the BCBA workspace', () => {
    expect(landingPathFor({ roles: ['bcba'] })).toBe('/dashboards/bcba');
  });

  it('sends an RBT to the RBT workspace', () => {
    expect(landingPathFor({ roles: ['rbt'] })).toBe('/dashboards/rbt');
  });

  it('lands a multi-role user on the WIDEST workspace they hold', () => {
    // Scope ladder: an owner who is also a BCBA sees the org workspace, which
    // contains the caseload view as a subset.
    expect(landingPathFor({ roles: ['bcba', 'owner'] })).toBe('/dashboards/organization');
    expect(landingPathFor({ roles: ['rbt', 'bcba'] })).toBe('/dashboards/bcba');
  });

  it('falls back to the first readable module for a non-primary role', () => {
    expect(landingPathFor({ roles: [], permissions: ['billing.read'] })).toBe('/insurance-billing');
    expect(landingPathFor({ roles: [], permissions: ['clients.read'] })).toBe('/clients');
  });

  it('prefers clients over scheduling when both are readable', () => {
    expect(landingPathFor({ roles: [], permissions: ['scheduling.read', 'clients.read'] })).toBe('/clients');
  });

  it('never dead-ends: an empty session still lands somewhere', () => {
    expect(landingPathFor({ roles: [], permissions: [] })).toBe('/account');
    expect(landingPathFor({})).toBe('/account');
    expect(landingPathFor()).toBe('/account');
  });
});
