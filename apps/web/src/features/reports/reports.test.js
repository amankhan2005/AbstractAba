import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = { get: [], post: [] };
const instance = {
  get: vi.fn((url, cfg) => { calls.get.push({ url, cfg }); return Promise.resolve({ data: { data: {} } }); }),
  post: vi.fn((url, body) => { calls.post.push({ url, body }); return Promise.resolve({ data: { data: {} } }); }),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};
vi.mock('axios', () => ({ default: { create: () => instance } }));

let api;
beforeEach(async () => { calls.get.length = 0; calls.post.length = 0; vi.clearAllMocks(); api = await import('@/api/client'); });

describe('reports client (tenant-scoped /v1/reports/*)', () => {
  it('reads overview/revenue/collections with a preset', async () => {
    await api.fetchReportsOverview({ preset: 'this_month' });
    await api.fetchRevenueReport({ preset: 'last_month' });
    await api.fetchCollectionsReport({ preset: 'today' });
    expect(calls.get.some((c) => c.url === '/v1/reports/overview')).toBe(true);
    expect(calls.get.some((c) => c.url === '/v1/reports/revenue')).toBe(true);
    expect(calls.get.some((c) => c.url === '/v1/reports/collections')).toBe(true);
  });
  it('downloads a CSV export as a blob', async () => {
    await api.downloadReportCsv('claims', { preset: 'this_month' });
    const c = calls.get.find((x) => x.url === '/v1/reports/export/claims');
    expect(c.cfg.responseType).toBe('blob');
  });
});

describe('reconciliation client (tenant-scoped /v1/reconciliation/*)', () => {
  it('reads records/queue and transitions', async () => {
    await api.fetchReconciliationRecords();
    await api.fetchReconciliationQueue();
    await api.transitionReconciliation('r-1', 'RECONCILED');
    expect(calls.get.some((c) => c.url === '/v1/reconciliation')).toBe(true);
    expect(calls.get.some((c) => c.url === '/v1/reconciliation/queue')).toBe(true);
    const t = calls.post.find((c) => c.url === '/v1/reconciliation/r-1/transitions');
    expect(t.body).toMatchObject({ target: 'RECONCILED' });
  });
});
