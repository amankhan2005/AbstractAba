import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAppNav } from '@/app/nav';

const calls = { get: [], post: [] };
const instance = {
  get: vi.fn((url, cfg) => { calls.get.push({ url, cfg }); return Promise.resolve({ data: new Blob(['x']) }); }),
  post: vi.fn((url, body) => { calls.post.push({ url, body }); return Promise.resolve({ data: { data: { summary: { valid: 1 }, created: 1, failed: 0 } } }); }),
  patch: vi.fn(() => Promise.resolve({ data: { data: {} } })),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};
vi.mock('axios', () => ({ default: { create: () => instance } }));

class FR { readAsDataURL() { this.result = 'data:text/csv;base64,Zmlyc3ROYW1l'; this.onload?.(); } }
globalThis.FileReader = FR;

let api;
beforeEach(async () => { calls.get.length = 0; calls.post.length = 0; vi.clearAllMocks(); api = await import('@/api/client'); });

describe('bulk import/export client', () => {
  it('previewImport posts base64 CSV to the preview endpoint (no tenant/owner fields)', async () => {
    await api.previewImport('clients', { name: 'c.csv', type: 'text/csv' });
    const c = calls.post.find((x) => x.url === '/v1/bulk/imports/clients/preview');
    expect(c).toBeTruthy();
    expect(c.body.base64).toBeTruthy();
    expect(c.body.tenantId).toBeUndefined();
    expect(c.body.createdBy).toBeUndefined();
  });

  it('commitImport posts to the commit endpoint', async () => {
    await api.commitImport('staff', { name: 's.csv', type: 'text/csv' });
    expect(calls.post.find((x) => x.url === '/v1/bulk/imports/staff/commit')).toBeTruthy();
  });

  it('generateExport and download use the export endpoints', async () => {
    await api.generateExport();
    expect(calls.post.find((x) => x.url === '/v1/bulk/exports')).toBeTruthy();
    await api.downloadExport('e1');
    const d = calls.get.find((x) => x.url === '/v1/bulk/exports/e1/download');
    expect(d.cfg.responseType).toBe('blob');
  });
});

describe('data-tools nav gating', () => {
  it('shows Data tools with any import/export permission', () => {
    expect(buildAppNav(['clients.create']).some((n) => n.to === '/data-tools')).toBe(true);
    expect(buildAppNav(['organization.export']).some((n) => n.to === '/data-tools')).toBe(true);
  });
  it('hides Data tools without any import/export permission', () => {
    expect(buildAppNav(['sessions.read']).some((n) => n.to === '/data-tools')).toBe(false);
  });
});
