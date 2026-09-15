import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the anonymous (publicClient) verbs to pin the activation contract.
const calls = { get: [], post: [] };
const instance = {
  get: vi.fn((url) => { calls.get.push({ url }); return Promise.resolve({ data: { data: {} } }); }),
  post: vi.fn((url, body) => { calls.post.push({ url, body }); return Promise.resolve({ data: { data: {} } }); }),
  patch: vi.fn(() => Promise.resolve({ data: { data: {} } })),
  delete: vi.fn(() => Promise.resolve({ data: { data: null } })),
  put: vi.fn(() => Promise.resolve({ data: { data: {} } })),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};
vi.mock('axios', () => ({ default: { create: () => instance } }));

let api;
beforeEach(async () => {
  calls.get.length = 0; calls.post.length = 0;
  vi.clearAllMocks();
  api = await import('./client');
});

describe('staff activation API client', () => {
  it('previews a member invitation at the public token path', async () => {
    await api.previewMemberInvitation('tok-123');
    expect(calls.get.some((c) => c.url === '/v1/invitations/tok-123')).toBe(true);
  });

  it('accepts by setting a password only — never sends a role (backend role is authoritative)', async () => {
    await api.acceptMemberInvitation('tok-123', { password: 'Sup3rSecret!' });
    const call = calls.post.find((c) => c.url === '/v1/invitations/tok-123/accept');
    expect(call).toBeTruthy();
    expect(call.body.password).toBe('Sup3rSecret!');
    for (const forbidden of ['role', 'roleKey', 'roles', 'isPlatformOperator', 'tenantId']) {
      expect(call.body[forbidden]).toBeUndefined();
    }
  });
});
