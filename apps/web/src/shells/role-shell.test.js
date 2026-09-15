import { describe, it, expect } from 'vitest';
import { shellForRoles } from './RoleShell.jsx';

/**
 * The four-experience dispatch. Proves RoleShell resolves each role to its OWN
 * shell (not one configured layout) and honours scope precedence when a user
 * holds several roles.
 */
describe('shellForRoles', () => {
  it('owner and org_admin get the company (clinic operations) shell', () => {
    expect(shellForRoles(['owner'])).toBe('company');
    expect(shellForRoles(['org_admin'])).toBe('company');
  });
  it('a BCBA gets the clinical supervision shell', () => {
    expect(shellForRoles(['bcba'])).toBe('bcba');
  });
  it('an RBT gets the technician shell', () => {
    expect(shellForRoles(['rbt'])).toBe('rbt');
  });
  it('precedence: the widest experience wins when several roles are held', () => {
    expect(shellForRoles(['rbt', 'bcba', 'org_admin'])).toBe('company');
    expect(shellForRoles(['rbt', 'bcba'])).toBe('bcba');
  });
  it('a specialist with none of the primary roles still gets a coherent shell', () => {
    expect(shellForRoles(['billing_staff'])).toBe('company');
    expect(shellForRoles([])).toBe('company');
  });
});
