import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture axios verbs to assert exact request paths/params for the two new flows.
const calls = { get: [], post: [], delete: [] };
const instance = {
  get: vi.fn((url, config) => { calls.get.push({ url, params: config?.params }); return Promise.resolve({ data: { data: { groups: [] } } }); }),
  post: vi.fn((url, body) => { calls.post.push({ url, body }); return Promise.resolve({ data: { data: {} } }); }),
  patch: vi.fn(() => Promise.resolve({ data: { data: {} } })),
  delete: vi.fn((url) => { calls.delete.push({ url }); return Promise.resolve({ data: { data: null } }); }),
  put: vi.fn(() => Promise.resolve({ data: { data: {} } })),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};
vi.mock('axios', () => ({ default: { create: () => instance } }));

let api;
beforeEach(async () => {
  calls.get.length = 0; calls.post.length = 0; calls.delete.length = 0;
  vi.clearAllMocks();
  api = await import('./client');
});

describe('guardian unlink API client', () => {
  it('removeGuardian deletes the relationship at the child-scoped path', async () => {
    await api.removeGuardian('c-1', 'g-9');
    expect(calls.delete.some((c) => c.url === '/v1/clients/c-1/guardians/g-9')).toBe(true);
  });
});

describe('global search API client', () => {
  it('sends only the query params — never tenant/role/ownership', async () => {
    await api.globalSearch({ q: 'mia', limit: 5 });
    const call = calls.get.find((c) => c.url === '/v1/search');
    expect(call).toBeTruthy();
    expect(call.params).toEqual({ q: 'mia', limit: 5 });
    // the frontend must not smuggle authority fields
    for (const forbidden of ['tenantId', 'organizationId', 'role', 'userId']) {
      expect(call.params[forbidden]).toBeUndefined();
    }
  });
});
