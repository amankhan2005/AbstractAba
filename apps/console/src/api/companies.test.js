import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the axios instance's verbs so we can assert exact request paths.
const calls = { get: [], post: [] };
const instance = {
  get: vi.fn((url, config) => { calls.get.push({ url, config }); return Promise.resolve({ data: { data: [] } }); }),
  post: vi.fn((url, body, config) => { calls.post.push({ url, body, config }); return Promise.resolve({ data: { data: { id: 'org-1' } } }); }),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};

vi.mock('axios', () => ({
  default: { create: () => instance },
}));

// Base resolves from env; the important thing is paths are relative to it and
// carry the /platform/organizations contract (no manual /api/v1 in call sites).
let api;
beforeEach(async () => {
  calls.get.length = 0;
  calls.post.length = 0;
  vi.clearAllMocks();
  api = await import('./client');
});

describe('company-management client endpoints', () => {
  it('lists active plans from the billing plans source (Plan dropdown data)', async () => {
    await api.listPlans();
    expect(calls.get[0].url).toBe('/platform/billing/plans');
    expect(calls.get[0].config.params).toMatchObject({ active: 'true' });
  });

  it('lists organizations at the platform path with search/filter params', async () => {
    await api.fetchTenants({ search: 'sun', state: 'ACTIVE' });
    expect(calls.get[0].url).toBe('/platform/organizations');
    expect(calls.get[0].config.params).toMatchObject({ search: 'sun', state: 'ACTIVE' });
  });

  it('creates an organization via POST /platform/organizations', async () => {
    await api.createOrganization({ slug: 'sunrise-aba', tradingName: 'Sunrise' });
    expect(calls.post[0].url).toBe('/platform/organizations');
    expect(calls.post[0].body).toMatchObject({ slug: 'sunrise-aba' });
  });

  it('transitions lifecycle via POST /:id/transitions with { toState, reason } + If-Match version', async () => {
    await api.transitionOrganization('org-1', { toState: 'SUSPENDED', reason: 'Deactivated by operator' }, 5);
    expect(calls.post[0].url).toBe('/platform/organizations/org-1/transitions');
    expect(calls.post[0].body).toMatchObject({ toState: 'SUSPENDED', reason: 'Deactivated by operator' });
    // Optimistic concurrency: the read version travels as If-Match. Omitting it
    // (or sending the old `{ target }` shape) made Deactivate/Activate 422.
    expect(calls.post[0].config?.headers?.['If-Match']).toBe('5');
  });

  it('invites an owner via POST /:id/owner', async () => {
    await api.inviteOwner('org-1', { email: 'a@b.c', fullName: 'A B' });
    expect(calls.post[0].url).toBe('/platform/organizations/org-1/owner-invitations');
    expect(calls.post[0].body).toMatchObject({ email: 'a@b.c', fullName: 'A B' });
  });

  it('resends an invitation via the platform users path', async () => {
    await api.resendInvitation('org-1', 'inv-9');
    expect(calls.post[0].url).toBe('/platform/organizations/org-1/owner-invitations/inv-9/resend');
  });

  it('provisions and activates via the onboarding endpoints', async () => {
    await api.provisionOrganization('org-1');
    await api.activateOrganization('org-1', 7);
    expect(calls.post.map((c) => c.url)).toEqual([
      '/platform/organizations/org-1/onboarding/provision',
      '/platform/organizations/org-1/onboarding/activate',
    ]);
    // activate uses optimistic concurrency: the read version travels as If-Match.
    // Without it the API rejects the call with 422 (the console activate bug).
    expect(calls.post[1].config?.headers?.['If-Match']).toBe('7');
  });

  it('reads members, onboarding, and agreements from platform paths', async () => {
    await api.listMembers('org-1');
    await api.fetchOnboarding('org-1');
    await api.fetchAgreements('org-1');
    expect(calls.get.map((c) => c.url)).toEqual([
      '/platform/organizations/org-1/users',
      '/platform/organizations/org-1/onboarding',
      '/platform/organizations/org-1/agreements',
    ]);
  });

  it('begins offboarding via POST /:id/offboarding', async () => {
    await api.beginOffboarding('org-1', { reason: 'winding down' }, 4);
    expect(calls.post[0].url).toBe('/platform/organizations/org-1/offboarding');
    expect(calls.post[0].body).toMatchObject({ reason: 'winding down' });
    expect(calls.post[0].config?.headers?.['If-Match']).toBe('4');
  });
});

describe('company-invitation client endpoints', () => {
  it('invites a company via POST /platform/company-invitations', async () => {
    await api.inviteCompany({ email: 'owner@co.example' });
    expect(calls.post[0].url).toBe('/platform/company-invitations');
    expect(calls.post[0].body).toMatchObject({ email: 'owner@co.example' });
  });

  it('lists invitations via GET /platform/company-invitations', async () => {
    await api.listCompanyInvitations({ status: 'PENDING' });
    expect(calls.get[0].url).toBe('/platform/company-invitations');
    expect(calls.get[0].config.params).toMatchObject({ status: 'PENDING' });
  });

  it('resends and revokes via the invitation subpaths', async () => {
    await api.resendCompanyInvitation('inv-1');
    await api.revokeCompanyInvitation('inv-1');
    expect(calls.post.map((c) => c.url)).toEqual([
      '/platform/company-invitations/inv-1/resend',
      '/platform/company-invitations/inv-1/revoke',
    ]);
  });
});
