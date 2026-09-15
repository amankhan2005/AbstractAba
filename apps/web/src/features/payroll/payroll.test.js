import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = { get: [], post: [], delete: [] };
const instance = {
  get: vi.fn((url) => { calls.get.push({ url }); return Promise.resolve({ data: { data: [] } }); }),
  post: vi.fn((url, body) => { calls.post.push({ url, body }); return Promise.resolve({ data: { data: {} } }); }),
  delete: vi.fn((url) => { calls.delete.push({ url }); return Promise.resolve({ data: {} }); }),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};
vi.mock('axios', () => ({ default: { create: () => instance } }));

let api;
beforeEach(async () => { calls.get.length = 0; calls.post.length = 0; calls.delete.length = 0; vi.clearAllMocks(); api = await import('@/api/client'); });

describe('payroll client (tenant-scoped /v1/payroll/*)', () => {
  it('reads timesheets, pay periods, runs from tenant paths', async () => {
    await api.fetchTimesheets();
    await api.fetchPayPeriods();
    await api.fetchPayrollRuns();
    const urls = calls.get.map((c) => c.url);
    expect(urls).toContain('/v1/payroll/timesheets');
    expect(urls).toContain('/v1/payroll/pay-periods');
    expect(urls).toContain('/v1/payroll/runs');
  });
  it('generates a run via POST /v1/payroll/runs', async () => {
    await api.generatePayrollRun('pp-1');
    const c = calls.post.find((x) => x.url === '/v1/payroll/runs');
    expect(c.body).toMatchObject({ payPeriodId: 'pp-1' });
  });
  it('finalizes a run via POST /v1/payroll/runs/:id/transitions', async () => {
    await api.transitionPayrollRun('run-1', 'FINALIZED');
    const c = calls.post.find((x) => x.url === '/v1/payroll/runs/run-1/transitions');
    expect(c.body).toMatchObject({ target: 'FINALIZED' });
  });
  it('imports sessions and adds manual entries to a timesheet', async () => {
    await api.importTimesheetSessions('ts-1');
    await api.addTimesheetEntry('ts-1', { workDate: '2026-01-01', minutes: 60 });
    expect(calls.post.some((c) => c.url === '/v1/payroll/timesheets/ts-1/import-sessions')).toBe(true);
    const e = calls.post.find((c) => c.url === '/v1/payroll/timesheets/ts-1/entries');
    expect(e.body).toMatchObject({ minutes: 60 });
  });
});
