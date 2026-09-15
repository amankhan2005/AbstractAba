import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = { post: [] };
const publicInstance = {
  get: vi.fn(() => Promise.resolve({ data: { data: {} } })),
  post: vi.fn((url, body) => { calls.post.push({ url, body, client: 'public' }); return Promise.resolve({ data: { data: { organizationId: 'org-1', slug: body.slug, state: 'PENDING_AGREEMENT', ownerEmail: body.ownerEmail, nextStep: 'Check your email.' } } }); }),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};
const authInstance = {
  get: vi.fn(() => Promise.resolve({ data: { data: {} } })),
  post: vi.fn((url, body) => { calls.post.push({ url, body, client: 'auth' }); return Promise.resolve({ data: { data: {} } }); }),
  patch: vi.fn(() => Promise.resolve({ data: { data: {} } })),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};
let created = 0;
vi.mock('axios', () => ({ default: { create: () => (created++ === 0 ? authInstance : publicInstance) } }));

let api;
beforeEach(async () => { calls.post.length = 0; created = 0; vi.clearAllMocks(); api = await import('@/api/client'); });

describe('self-serve signup client', () => {
  it('posts to the PUBLIC /signup endpoint (unauthenticated client)', async () => {
    await api.selfServeSignup({
      slug: 'bright-aba', legalName: 'Bright ABA LLC', tradingName: 'Bright ABA', countryCode: 'US',
      timezone: 'America/New_York', ownerFullName: 'Jane Doe', ownerEmail: 'jane@bright.com',
      agreement: { version: 'v1', acceptedByName: 'Jane Doe', acceptedByTitle: 'CEO', accepted: true },
    });
    const c = calls.post.find((x) => x.url === '/v1/public/signup');
    expect(c).toBeTruthy();
    expect(c.client).toBe('public');
  });

  it('never sends tenant/state/role/authoritative fields', async () => {
    await api.selfServeSignup({
      slug: 'bright-aba', legalName: 'Bright ABA LLC', tradingName: 'Bright ABA', countryCode: 'US',
      timezone: 'America/New_York', ownerFullName: 'Jane Doe', ownerEmail: 'jane@bright.com',
      agreement: { version: 'v1', acceptedByName: 'Jane Doe', acceptedByTitle: 'CEO', accepted: true },
    });
    const body = calls.post.find((x) => x.url === '/v1/public/signup').body;
    expect(body.tenantId).toBeUndefined();
    expect(body.state).toBeUndefined();
    expect(body.roleKeys).toBeUndefined();
    expect(body.agreement.accepted).toBe(true);
  });
});
