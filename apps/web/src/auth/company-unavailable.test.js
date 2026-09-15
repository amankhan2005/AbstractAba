import { describe, it, expect } from 'vitest';
import { resolveAuthState } from './store';

// A principal that can access the app (member of an organization). canAccessApp
// keys on roles/permissions; a role is enough here.
const member = (over = {}) => ({
  userId: 'u1', isPlatformOperator: false, activeTenantId: 'org-1',
  roles: ['bcba'], permissions: ['clients.read'], permissionScopes: { 'clients.read': 'tenant' },
  organizationActive: true, ...over,
});

describe('resolveAuthState — deactivated company handling', () => {
  it('an active company member is authenticated', () => {
    expect(resolveAuthState(member()).status).toBe('authenticated');
  });

  it('a member whose company is deactivated goes to the friendly unavailable state (not an error)', () => {
    const s = resolveAuthState(member({ organizationActive: false }));
    expect(s.status).toBe('company-unavailable');
    expect(s.principal).not.toBeNull(); // still a real session; the screen is UX, not the boundary
    expect(s.error).toBeNull(); // never surfaced as a raw error
  });

  it('reactivation (organizationActive true again) restores normal access', () => {
    expect(resolveAuthState(member({ organizationActive: true })).status).toBe('authenticated');
  });

  it('a non-member is unauthenticated regardless of company state', () => {
    const s = resolveAuthState({ isPlatformOperator: false, roles: [], permissions: [] });
    expect(s.status).toBe('unauthenticated');
    expect(s.principal).toBeNull();
  });

  it('a null organizationActive (e.g. operator / no active tenant) does NOT trigger the unavailable screen', () => {
    expect(resolveAuthState(member({ organizationActive: null })).status).toBe('authenticated');
  });
});
