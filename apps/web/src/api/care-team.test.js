import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the axios instance verbs so we can assert exact care-team request paths.
const calls = { get: [], post: [], delete: [] };
const instance = {
  get: vi.fn((url) => { calls.get.push({ url }); return Promise.resolve({ data: { data: [] } }); }),
  post: vi.fn((url, body) => { calls.post.push({ url, body }); return Promise.resolve({ data: { data: { id: 'a-1', role: body?.role } } }); }),
  patch: vi.fn(() => Promise.resolve({ data: { data: {} } })),
  delete: vi.fn((url) => { calls.delete.push({ url }); return Promise.resolve({ data: { data: null } }); }),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};

vi.mock('axios', () => ({ default: { create: () => instance } }));

let api;
beforeEach(async () => {
  calls.get.length = 0;
  calls.post.length = 0;
  calls.delete.length = 0;
  vi.clearAllMocks();
  api = await import('./client');
});

describe('care-team API client', () => {
  it('lists the care team at the client-scoped path', async () => {
    await api.listCareTeam('c-1');
    expect(calls.get.some((c) => c.url === '/v1/clients/c-1/care-team')).toBe(true);
  });

  it('assigns a staff member to a role via POST', async () => {
    await api.assignCareTeam('c-1', { staffProfileId: 'sp-1', role: 'BCBA', isPrimary: true });
    const call = calls.post.find((c) => c.url === '/v1/clients/c-1/care-team');
    expect(call).toBeTruthy();
    expect(call.body).toMatchObject({ staffProfileId: 'sp-1', role: 'BCBA', isPrimary: true });
  });

  it('removes an assignment via DELETE at the assignment path', async () => {
    await api.removeCareTeam('c-1', 'a-9');
    expect(calls.delete.some((c) => c.url === '/v1/clients/c-1/care-team/a-9')).toBe(true);
  });
});
