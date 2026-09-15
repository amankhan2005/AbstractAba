import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = { get: [], post: [] };
const instance = {
  get: vi.fn((url) => { calls.get.push({ url }); return Promise.resolve({ data: { data: [] } }); }),
  post: vi.fn((url, body) => { calls.post.push({ url, body }); return Promise.resolve({ data: { data: {} } }); }),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};
vi.mock('axios', () => ({ default: { create: () => instance } }));

let api;
beforeEach(async () => { calls.get.length = 0; calls.post.length = 0; vi.clearAllMocks(); api = await import('@/api/client'); });

describe('claims client (tenant-scoped /v1/claims/*)', () => {
  it('lists and reads claims', async () => {
    await api.fetchClaims({ status: 'SUBMITTED' });
    await api.fetchClaim('cl-1');
    expect(calls.get.some((c) => c.url === '/v1/claims')).toBe(true);
    expect(calls.get.some((c) => c.url === '/v1/claims/cl-1')).toBe(true);
  });
  it('generates a claim from sessions', async () => {
    await api.generateClaim({ clientId: 'c1', sessionIds: ['s1'] });
    const c = calls.post.find((x) => x.url === '/v1/claims/generate');
    expect(c.body).toMatchObject({ clientId: 'c1' });
  });
  it('submits and resubmits claims', async () => {
    await api.submitClaim('cl-1');
    await api.resubmitClaim('cl-1');
    expect(calls.post.some((c) => c.url === '/v1/claims/cl-1/submit')).toBe(true);
    expect(calls.post.some((c) => c.url === '/v1/claims/cl-1/resubmit')).toBe(true);
  });
});

describe('ERA client (tenant-scoped /v1/era/*)', () => {
  it('uploads a file, lists files/records, resolves a record', async () => {
    await api.uploadEraFile({ fileName: 'r.835', content: 'ISA...' });
    await api.fetchEraFiles();
    await api.fetchEraRecords();
    await api.resolveEraRecord('rec-1', 'cl-1');
    expect(calls.post.some((c) => c.url === '/v1/era/files')).toBe(true);
    expect(calls.get.some((c) => c.url === '/v1/era/files')).toBe(true);
    expect(calls.get.some((c) => c.url === '/v1/era/records')).toBe(true);
    const res = calls.post.find((c) => c.url === '/v1/era/records/rec-1/resolve');
    expect(res.body).toMatchObject({ claimId: 'cl-1' });
  });
});
