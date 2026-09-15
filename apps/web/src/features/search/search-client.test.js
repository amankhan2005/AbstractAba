import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAppNav } from '@/app/nav';

const calls = { get: [] };
const instance = {
  get: vi.fn((url, cfg) => { calls.get.push({ url, cfg }); return Promise.resolve({ data: { data: { groups: [], totalCount: 0, searchedTypes: [] } } }); }),
  post: vi.fn(() => Promise.resolve({ data: { data: {} } })),
  patch: vi.fn(() => Promise.resolve({ data: { data: {} } })),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};
vi.mock('axios', () => ({ default: { create: () => instance } }));

let api;
beforeEach(async () => { calls.get.length = 0; vi.clearAllMocks(); api = await import('@/api/client'); });

describe('search client', () => {
  it('globalSearch hits /search with the term (tenant is server-side)', async () => {
    await api.globalSearch({ q: 'smith' });
    const c = calls.get.find((x) => x.url === '/v1/search');
    expect(c).toBeTruthy();
    expect(c.cfg.params).toMatchObject({ q: 'smith' });
    // Client never sends a tenant id.
    expect(c.cfg.params.tenantId).toBeUndefined();
  });

  it('searchEntity pages one entity type', async () => {
    await api.searchEntity('clients', { q: 'a', limit: 25 });
    expect(calls.get.find((x) => x.url === '/v1/search/clients')).toBeTruthy();
  });
});

describe('search nav gating', () => {
  it('shows Search when any searchable read permission is present', () => {
    const nav = buildAppNav(['documents.read']);
    expect(nav.some((n) => n.to === '/search')).toBe(true);
  });

  it('hides Search when no searchable read permission is present', () => {
    const nav = buildAppNav(['payroll.read']);
    expect(nav.some((n) => n.to === '/search')).toBe(false);
  });
});
