import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = { get: [], post: [], patch: [] };
const instance = {
  get: vi.fn((url, cfg) => { calls.get.push({ url, cfg }); return Promise.resolve({ data: { data: {} } }); }),
  post: vi.fn((url, body) => { calls.post.push({ url, body }); return Promise.resolve({ data: { data: {} } }); }),
  patch: vi.fn((url, body) => { calls.patch.push({ url, body }); return Promise.resolve({ data: { data: {} } }); }),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};
vi.mock('axios', () => ({ default: { create: () => instance } }));

let api;
beforeEach(async () => { calls.get.length = 0; calls.post.length = 0; calls.patch.length = 0; vi.clearAllMocks(); api = await import('@/api/client'); });

describe('supervision client', () => {
  it('creates an observation without sending server-authoritative fields', async () => {
    await api.createSupervisionObservation({ supervisorStaffId: 'a', superviseeStaffId: 'b', observedAt: '2026-02-01T10:00:00Z', durationMinutes: 60 });
    const c = calls.post.find((x) => x.url === '/v1/supervision/observations');
    expect(c).toBeTruthy();
    // client must not attempt to set tenant/status/signer
    expect(c.body.tenantId).toBeUndefined();
    expect(c.body.status).toBeUndefined();
    expect(c.body.signedBy).toBeUndefined();
  });

  it('sign posts to the sign endpoint with no body payload', async () => {
    await api.signSupervisionObservation('obs-1');
    const c = calls.post.find((x) => x.url === '/v1/supervision/observations/obs-1/sign');
    expect(c).toBeTruthy();
    expect(c.body).toEqual({});
  });

  it('hours summary is a GET with query params', async () => {
    await api.getSupervisionHoursSummary({ superviseeStaffId: 'b' });
    const c = calls.get.find((x) => x.url === '/v1/supervision/hours');
    expect(c).toBeTruthy();
    expect(c.cfg.params).toMatchObject({ superviseeStaffId: 'b' });
  });
});
