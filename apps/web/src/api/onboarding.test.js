import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the public axios instance's verbs to assert exact request paths.
const calls = { get: [], post: [] };
const instance = {
  get: vi.fn((url) => { calls.get.push({ url }); return Promise.resolve({ data: { data: { email: 'a@b.co' } } }); }),
  post: vi.fn((url, body) => { calls.post.push({ url, body }); return Promise.resolve({ data: { data: { organizationId: 'org-1', state: 'PROVISIONING' } } }); }),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};

vi.mock('axios', () => ({
  default: { create: () => instance },
}));

let api;
beforeEach(async () => {
  calls.get.length = 0;
  calls.post.length = 0;
  vi.clearAllMocks();
  api = await import('./client');
});

describe('public company onboarding client', () => {
  it('previews an invitation at the public token path', async () => {
    await api.previewCompanyInvitation('tok-123');
    expect(calls.get.some((c) => c.url === '/v1/public/company-invitations/tok-123')).toBe(true);
  });

  it('submits onboarding to the public accept path', async () => {
    await api.submitCompanyOnboarding('tok-123', { slug: 'sunrise-aba' });
    expect(calls.post.some((c) => c.url === '/v1/public/company-invitations/tok-123/accept')).toBe(true);
    const call = calls.post.find((c) => c.url.endsWith('/accept'));
    expect(call.body).toMatchObject({ slug: 'sunrise-aba' });
  });
});
