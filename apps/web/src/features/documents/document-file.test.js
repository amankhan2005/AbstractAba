import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = { get: [], post: [] };
const instance = {
  get: vi.fn((url, cfg) => { calls.get.push({ url, cfg }); return Promise.resolve({ data: new Blob(['x']) }); }),
  post: vi.fn((url, body) => { calls.post.push({ url, body }); return Promise.resolve({ data: { data: {} } }); }),
  patch: vi.fn(() => Promise.resolve({ data: { data: {} } })),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
};
vi.mock('axios', () => ({ default: { create: () => instance } }));

// Minimal FileReader stub for jsdom base64 conversion.
class FR {
  readAsDataURL() { this.result = 'data:text/plain;base64,aGVsbG8='; this.onload?.(); }
}
globalThis.FileReader = FR;

let api;
beforeEach(async () => { calls.get.length = 0; calls.post.length = 0; vi.clearAllMocks(); api = await import('@/api/client'); });

describe('document file client', () => {
  it('uploads a file as base64 with server-authoritative contract (no storageRef/checksum sent)', async () => {
    const file = { name: 'note.txt', type: 'text/plain' };
    await api.uploadDocumentFile('d1', file);
    const c = calls.post.find((x) => x.url === '/v1/documents/d1/file');
    expect(c).toBeTruthy();
    expect(c.body).toMatchObject({ fileName: 'note.txt', contentType: 'text/plain', base64: 'aGVsbG8=' });
    // The client must NOT attempt to send server-owned descriptors.
    expect(c.body.storageRef).toBeUndefined();
    expect(c.body.checksum).toBeUndefined();
    expect(c.body.sizeBytes).toBeUndefined();
  });

  it('downloads a file as a blob via the authenticated client', async () => {
    await api.downloadDocumentFile('d1');
    const c = calls.get.find((x) => x.url === '/v1/documents/d1/file');
    expect(c).toBeTruthy();
    expect(c.cfg.responseType).toBe('blob');
  });
});
