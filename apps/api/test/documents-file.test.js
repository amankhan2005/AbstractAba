import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentsService } from '../src/modules/documents/documents.service.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// In-memory fakes — the service is DI-based, so this runs without a database.
function makeDeps(overrides = {}) {
  const docs = new Map();
  const storageStore = new Map();
  const repository = {
    async findDocumentById(_t, id) { return docs.get(id) ?? null; },
    async setArtifact(_t, id, patch) {
      const doc = docs.get(id);
      if (!doc) { const e = new Error('not found'); e.status = 404; throw e; }
      if (doc.status !== 'DRAFT') { const e = new Error('finalized'); e.status = 409; throw e; }
      Object.assign(doc, patch); return { ...doc };
    },
  };
  const storage = {
    async put(key, buffer, contentType) { storageStore.set(key, { buffer, contentType }); },
    async get(key) { if (!storageStore.has(key)) { const e = new Error('missing'); e.status = 404; throw e; } return storageStore.get(key); },
    async remove(key) { storageStore.delete(key); },
  };
  return {
    _docs: docs, _storageStore: storageStore,
    repository, storage,
    organizations: { getById: async () => ({ state: 'ACTIVE' }) },
    clients: { findById: async () => ({ id: 'c1' }) },
    limits: { maxBytes: 1000, allowedMimeTypes: ['text/plain', 'application/pdf'] },
    ...overrides,
  };
}

test('attachFile derives trusted descriptor from bytes and stores them', async () => {
  const deps = makeDeps();
  deps._docs.set('d1', { id: 'd1', status: 'DRAFT', clientId: 'c1', title: 'Report' });
  const svc = new DocumentsService(deps);
  const updated = await svc.attachFile({
    tenantId: 't1', documentId: 'd1', actorUserId: 'u1',
    upload: { contentType: 'text/plain', base64: b64('hello world') },
  });
  assert.equal(updated.contentType, 'text/plain');
  assert.equal(updated.sizeBytes, 11);
  assert.match(updated.storageRef, /^docs\/t1\/d1\//);
  assert.equal(updated.checksum.length, 64); // sha256 hex
  // the bytes actually landed in storage under the generated key
  assert.ok(deps._storageStore.has(updated.storageRef));
});

test('attachFile rejects a disallowed content type (server allowlist)', async () => {
  const deps = makeDeps();
  deps._docs.set('d1', { id: 'd1', status: 'DRAFT', clientId: 'c1', title: 'X' });
  const svc = new DocumentsService(deps);
  await assert.rejects(
    () => svc.attachFile({ tenantId: 't1', documentId: 'd1', actorUserId: 'u1', upload: { contentType: 'application/x-msdownload', base64: b64('x') } }),
    /not allowed/,
  );
});

test('attachFile rejects an oversized file (server measures real size)', async () => {
  const deps = makeDeps();
  deps._docs.set('d1', { id: 'd1', status: 'DRAFT', clientId: 'c1', title: 'X' });
  const svc = new DocumentsService(deps);
  await assert.rejects(
    () => svc.attachFile({ tenantId: 't1', documentId: 'd1', actorUserId: 'u1', upload: { contentType: 'text/plain', base64: b64('x'.repeat(2000)) } }),
    /maximum allowed size/,
  );
});

test('attachFile refuses a FINALIZED document (content immutability)', async () => {
  const deps = makeDeps();
  deps._docs.set('d1', { id: 'd1', status: 'FINALIZED', clientId: 'c1', title: 'X' });
  const svc = new DocumentsService(deps);
  await assert.rejects(
    () => svc.attachFile({ tenantId: 't1', documentId: 'd1', actorUserId: 'u1', upload: { contentType: 'text/plain', base64: b64('x') } }),
  );
});

test('downloadFile returns bytes for an owned artifact', async () => {
  const deps = makeDeps();
  deps._docs.set('d1', { id: 'd1', status: 'DRAFT', clientId: 'c1', title: 'Report' });
  const svc = new DocumentsService(deps);
  await svc.attachFile({ tenantId: 't1', documentId: 'd1', actorUserId: 'u1', upload: { contentType: 'text/plain', base64: b64('data here') } });
  const out = await svc.downloadFile({ tenantId: 't1', documentId: 'd1' });
  assert.equal(out.buffer.toString('utf8'), 'data here');
  assert.equal(out.contentType, 'text/plain');
});

test('downloadFile refuses a storageRef belonging to another tenant (IDOR guard)', async () => {
  const deps = makeDeps();
  // Document row carries a ref whose embedded tenant is different from the caller.
  deps._docs.set('d1', { id: 'd1', status: 'DRAFT', clientId: 'c1', title: 'X', storageRef: 'docs/OTHER-TENANT/d1/abc123', contentType: 'text/plain' });
  const svc = new DocumentsService(deps);
  await assert.rejects(() => svc.downloadFile({ tenantId: 't1', documentId: 'd1' }));
});

test('downloadFile 404s when no artifact attached', async () => {
  const deps = makeDeps();
  deps._docs.set('d1', { id: 'd1', status: 'DRAFT', clientId: 'c1', title: 'X' });
  const svc = new DocumentsService(deps);
  await assert.rejects(() => svc.downloadFile({ tenantId: 't1', documentId: 'd1' }));
});
