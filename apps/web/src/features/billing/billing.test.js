import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = { get: [] };
const instance = {
  get: vi.fn((url) => { calls.get.push({ url }); return Promise.resolve({ data: { data: {} } }); }),
  post: vi.fn(() => Promise.resolve({ data: { data: {} } })),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};
vi.mock('axios', () => ({ default: { create: () => instance } }));

let api;
beforeEach(async () => { calls.get.length = 0; vi.clearAllMocks(); api = await import('@/api/client'); });

describe('company billing client (tenant-scoped)', () => {
  it('reads subscription/invoices/payments/balance from /v1/billing/*', async () => {
    await api.fetchMySubscription();
    await api.fetchMyInvoices();
    await api.fetchMyPayments();
    await api.fetchMyBalance();
    const urls = calls.get.map((c) => c.url);
    expect(urls).toContain('/v1/billing/subscription');
    expect(urls).toContain('/v1/billing/invoices');
    expect(urls).toContain('/v1/billing/payments');
    expect(urls).toContain('/v1/billing/balance');
  });
});
