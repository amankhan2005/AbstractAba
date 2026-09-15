import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = { get: [], post: [] };
const instance = {
  get: vi.fn((url, cfg) => { calls.get.push({ url, cfg }); return Promise.resolve({ data: { data: [] } }); }),
  post: vi.fn((url, body) => { calls.post.push({ url, body }); return Promise.resolve({ data: { data: { series: { id: 's1' }, booked: [], skipped: [] } } }); }),
  patch: vi.fn(() => Promise.resolve({ data: { data: {} } })),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};
vi.mock('axios', () => ({ default: { create: () => instance } }));

let api;
beforeEach(async () => { calls.get.length = 0; calls.post.length = 0; vi.clearAllMocks(); api = await import('@/api/client'); });

describe('recurring series client', () => {
  it('createSeries posts only template + rule (no authoritative fields)', async () => {
    await api.createSeries({ clientId: 'c1', staffProfileId: 's1', authorizationId: 'a1', frequency: 'WEEKLY', interval: 1, byWeekday: [1, 3], startDate: '2026-03-02T00:00:00Z', startMinute: 540, endMinute: 600, count: 4 });
    const c = calls.post.find((x) => x.url === '/v1/scheduling/series');
    expect(c).toBeTruthy();
    expect(c.body).toMatchObject({ frequency: 'WEEKLY', interval: 1, count: 4 });
    // Never sends server-owned fields.
    expect(c.body.tenantId).toBeUndefined();
    expect(c.body.status).toBeUndefined();
    expect(c.body.seriesId).toBeUndefined();
  });

  it('lists and gets series', async () => {
    await api.listSeries({ limit: 10 });
    expect(calls.get.find((x) => x.url === '/v1/scheduling/series')).toBeTruthy();
    await api.getSeries('s1');
    expect(calls.get.find((x) => x.url === '/v1/scheduling/series/s1')).toBeTruthy();
  });

  it('cancels a series and a single occurrence via dedicated endpoints', async () => {
    await api.cancelSeries('s1');
    expect(calls.post.find((x) => x.url === '/v1/scheduling/series/s1/cancel')).toBeTruthy();
    await api.cancelSeriesOccurrence('s1', 'ap1');
    expect(calls.post.find((x) => x.url === '/v1/scheduling/series/s1/occurrences/ap1/cancel')).toBeTruthy();
  });
});
