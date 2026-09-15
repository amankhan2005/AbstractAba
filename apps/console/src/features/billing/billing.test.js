import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = { get: [], post: [], patch: [] };
const instance = {
  get: vi.fn((url, config) => { calls.get.push({ url, config }); return Promise.resolve({ data: { data: {} } }); }),
  post: vi.fn((url, body) => { calls.post.push({ url, body }); return Promise.resolve({ data: { data: {} } }); }),
  patch: vi.fn((url, body) => { calls.patch.push({ url, body }); return Promise.resolve({ data: { data: {} } }); }),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};
vi.mock('axios', () => ({ default: { create: () => instance } }));

let api;
beforeEach(async () => { calls.get.length = 0; calls.post.length = 0; calls.patch.length = 0; vi.clearAllMocks(); api = await import('@/api/client'); });

describe('billing operator client endpoints', () => {
  it('fetches overview at the platform billing path', async () => {
    await api.fetchBillingOverview();
    expect(calls.get.some((c) => c.url === '/platform/billing/overview')).toBe(true);
  });
  it('creates a plan via POST /platform/billing/plans', async () => {
    await api.createPlan({ code: 'pro', name: 'Pro', monthlyPrice: 9900, yearlyPrice: 99000 });
    const c = calls.post.find((x) => x.url === '/platform/billing/plans');
    expect(c).toBeTruthy();
    expect(c.body).toMatchObject({ code: 'pro', monthlyPrice: 9900 });
  });
  it('voids an invoice via POST /platform/billing/invoices/:id/void', async () => {
    await api.voidInvoice('inv-1');
    expect(calls.post.some((c) => c.url === '/platform/billing/invoices/inv-1/void')).toBe(true);
  });
  it('records a manual payment via POST /platform/billing/payments', async () => {
    await api.recordPayment({ invoiceId: 'inv-1', amount: 5000, paymentMethod: 'CHECK', referenceNumber: 'chk-9' });
    const c = calls.post.find((x) => x.url === '/platform/billing/payments');
    expect(c.body).toMatchObject({ invoiceId: 'inv-1', amount: 5000, paymentMethod: 'CHECK', referenceNumber: 'chk-9' });
  });
  it('issues a manual credit via POST /platform/billing/credits', async () => {
    await api.issueCredit({ organizationId: 'org-1', amount: 2000, reason: 'service credit' });
    const c = calls.post.find((x) => x.url === '/platform/billing/credits');
    expect(c.body).toMatchObject({ organizationId: 'org-1', amount: 2000, reason: 'service credit' });
  });
});
