import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentsService } from '../src/modules/documents/documents.service.js';

/**
 * DB-free tests for the clinical-documents service against a fake repository and
 * fake ports. They lock in the ACTIVE gate, client-existence validation, the
 * DRAFT → FINALIZED sign-off, the finalized-content immutability guard, the
 * archive transition, the supersede versioning chain, and version forwarding.
 */

function makeService({ state = 'ACTIVE', docStatus = 'DRAFT', supersededBy = null, over = {} } = {}) {
  const calls = { createDocument: [], updateDocument: [], finalizeDocument: [], archiveDocument: [], supersedeDocument: [] };
  const repo = {
    createDocument: async (_t, doc) => { calls.createDocument.push(doc); return { id: 'd-1', ...doc, version: 1 }; },
    findDocumentById: async () => ({ id: 'd-1', clientId: 'c-1', documentType: 'ASSESSMENT', title: 'Intake', status: docStatus, supersededByDocumentId: supersededBy, version: 4 }),
    listDocuments: async () => ({ items: [{ id: 'd-1', status: docStatus }], nextCursor: null }),
    updateDocument: async (_t, id, patch, v) => { calls.updateDocument.push({ patch, v }); return { id, ...patch, version: (v ?? 1) + 1 }; },
    finalizeDocument: async (_t, id, actor) => { calls.finalizeDocument.push({ id, actor }); return { id, status: 'FINALIZED', finalizedBy: actor, version: 5 }; },
    archiveDocument: async (_t, id, actor) => { calls.archiveDocument.push({ id, actor }); return { id, status: 'ARCHIVED', version: 5 }; },
    supersedeDocument: async (_t, sourceId, newDoc) => { calls.supersedeDocument.push({ sourceId, newDoc }); return { id: 'd-2', ...newDoc, supersedesDocumentId: sourceId, version: 1 }; },
    ...over.repo,
  };
  const service = new DocumentsService({
    repository: repo,
    organizations: { getById: async () => ({ state }) },
    clients: { findById: async () => ({ id: 'c-1', status: 'ACTIVE' }), ...over.clients },
  });
  return { service, calls };
}

const createInput = { clientId: 'c-1', documentType: 'ASSESSMENT', title: 'Intake assessment' };

// --- ACTIVE gate + creation validation -------------------------------------

test('create refused (409) when org not ACTIVE', async () => {
  const { service } = makeService({ state: 'SUSPENDED' });
  await assert.rejects(() => service.createDocument({ tenantId: 't', actorUserId: 'u', input: createInput }), (e) => e.code === 'ORG_NOT_ACTIVE' && e.status === 409);
});

test('create refused (422) when the client does not exist', async () => {
  const { service } = makeService({ over: { clients: { findById: async () => null } } });
  await assert.rejects(() => service.createDocument({ tenantId: 't', actorUserId: 'u', input: createInput }), (e) => e.code === 'CLIENT_INVALID' && e.status === 422);
});

test('create files a DRAFT without any client-supplied artifact descriptors', async () => {
  const { service, calls } = makeService();
  const doc = await service.createDocument({ tenantId: 't', actorUserId: 'u', input: createInput });
  const filed = calls.createDocument[0];
  assert.equal(filed.status, 'DRAFT');
  assert.equal(filed.clientId, 'c-1');
  // Artifact descriptors are server-derived only via attachFile — never at create.
  assert.equal(filed.storageRef, undefined);
  assert.equal(filed.sizeBytes, undefined);
  assert.equal(filed.checksum, undefined);
  assert.equal(doc.id, 'd-1');
});

test('create allows a client of any status (documents may be filed for discharged clients)', async () => {
  const { service } = makeService({ over: { clients: { findById: async () => ({ id: 'c-1', status: 'DISCHARGED' }) } } });
  await assert.doesNotReject(() => service.createDocument({ tenantId: 't', actorUserId: 'u', input: createInput }));
});

// --- update + finalize immutability ----------------------------------------

test('update forwards the If-Match version and maps the patch (no artifact fields)', async () => {
  const { service, calls } = makeService();
  await service.updateDocument({ tenantId: 't', documentId: 'd-1', actorUserId: 'u', expectedVersion: 4, input: { title: 'Revised' } });
  assert.equal(calls.updateDocument[0].v, 4);
  assert.equal(calls.updateDocument[0].patch.title, 'Revised');
  // sizeBytes / storageRef / checksum are not client-mappable via update anymore.
  assert.equal(calls.updateDocument[0].patch.sizeBytes, undefined);
});

test('a FINALIZED document is immutable to update', async () => {
  const { service } = makeService({ docStatus: 'FINALIZED' });
  await assert.rejects(() => service.updateDocument({ tenantId: 't', documentId: 'd-1', actorUserId: 'u', expectedVersion: 4, input: { title: 'x' } }), (e) => e.code === 'DOCUMENT_FINALIZED' && e.status === 409);
});

test('an ARCHIVED document cannot be updated', async () => {
  const { service } = makeService({ docStatus: 'ARCHIVED' });
  await assert.rejects(() => service.updateDocument({ tenantId: 't', documentId: 'd-1', actorUserId: 'u', expectedVersion: 4, input: { title: 'x' } }), (e) => e.code === 'INVALID_STATUS_TRANSITION');
});

test('finalize moves DRAFT → FINALIZED with a signer', async () => {
  const { service, calls } = makeService({ docStatus: 'DRAFT' });
  const res = await service.finalizeDocument({ tenantId: 't', documentId: 'd-1', actorUserId: 'bcba-9' });
  assert.equal(res.status, 'FINALIZED');
  assert.equal(calls.finalizeDocument[0].actor, 'bcba-9');
});

test('finalize refused when the document is not a DRAFT', async () => {
  const { service } = makeService({ docStatus: 'FINALIZED' });
  await assert.rejects(() => service.finalizeDocument({ tenantId: 't', documentId: 'd-1', actorUserId: 'u' }), (e) => e.code === 'INVALID_STATUS_TRANSITION' && e.status === 409);
});

// --- archive ---------------------------------------------------------------

test('archive moves a document to ARCHIVED; refused when already archived', async () => {
  const ok = makeService({ docStatus: 'FINALIZED' });
  const res = await ok.service.archiveDocument({ tenantId: 't', documentId: 'd-1', actorUserId: 'u' });
  assert.equal(res.status, 'ARCHIVED');
  const already = makeService({ docStatus: 'ARCHIVED' });
  await assert.rejects(() => already.service.archiveDocument({ tenantId: 't', documentId: 'd-1', actorUserId: 'u' }), (e) => e.code === 'INVALID_STATUS_TRANSITION');
});

// --- supersede versioning chain --------------------------------------------

test('supersede files a new DRAFT linked to the finalized source, inheriting its client', async () => {
  const { service, calls } = makeService({ docStatus: 'FINALIZED' });
  const next = await service.supersedeDocument({ tenantId: 't', documentId: 'd-1', actorUserId: 'u', input: { title: 'Re-assessment 2026', documentType: 'ASSESSMENT' } });
  assert.equal(next.supersedesDocumentId, 'd-1');
  assert.equal(calls.supersedeDocument[0].sourceId, 'd-1');
  assert.equal(calls.supersedeDocument[0].newDoc.clientId, 'c-1', 'client inherited from the superseded document');
  assert.equal(calls.supersedeDocument[0].newDoc.status, 'DRAFT');
});

test('supersede refused when the source is not FINALIZED, or already superseded', async () => {
  const draft = makeService({ docStatus: 'DRAFT' });
  await assert.rejects(() => draft.service.supersedeDocument({ tenantId: 't', documentId: 'd-1', actorUserId: 'u', input: { title: 'x' } }), (e) => e.code === 'INVALID_STATUS_TRANSITION');
  const already = makeService({ docStatus: 'FINALIZED', supersededBy: 'd-9' });
  await assert.rejects(() => already.service.supersedeDocument({ tenantId: 't', documentId: 'd-1', actorUserId: 'u', input: { title: 'x' } }), (e) => e.code === 'ALREADY_SUPERSEDED' && e.status === 409);
});
