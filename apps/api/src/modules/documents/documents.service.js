import { documentsError } from './documents.errors.js';
import { validateUpload } from './document.validation.js';
import { buildStorageKey, keyBelongsToTenant } from './storage/storageKey.js';
import { recordSafely } from '../audit/audit.service.js';

/**
 * Clinical-documents business rules. The repository holds data access; the
 * organization port answers the ACTIVE gate; the clients port validates that the
 * document is filed against an existing client. Dependencies are injected so the
 * orchestration runs without a database.
 *
 * Invariants enforced here:
 *   - ACTIVE gate on every write (409 otherwise).
 *   - A document is filed against an existing client (any client status — a
 *     discharge summary is filed for a discharged client, so client status is
 *     NOT gated here, only existence).
 *   - FINALIZE is a sign-off: DRAFT → FINALIZED, after which the content is
 *     immutable. Only the archive / supersede status moves are allowed.
 *   - SUPERSEDE files a new DRAFT that replaces a FINALIZED document, archiving
 *     and linking the old one — the versioning chain.
 *
 * @typedef {{
 *   repository: object,
 *   organizations: { getById:(id:string)=>Promise<{state:string}|null> },
 *   clients: { findById:(t:string,id:string)=>Promise<any> },
 * }} DocumentsDeps
 */
export class DocumentsService {
  /** @param {DocumentsDeps} deps */
  constructor(deps) {
    this.deps = deps;
  }

  async _assertActive(tenantId) {
    const org = await this.deps.organizations.getById(tenantId);
    if (!org || org.state !== 'ACTIVE') throw documentsError('ORG_NOT_ACTIVE');
  }

  async _assertClientExists(tenantId, clientId) {
    const client = await this.deps.clients.findById(tenantId, clientId);
    if (!client) throw documentsError('CLIENT_INVALID');
    return client;
  }

  /** Load a document and refuse when it is missing or finalized (the content-immutability guard). */
  async _requireMutableDocument(tenantId, documentId) {
    const doc = await this.deps.repository.findDocumentById(tenantId, documentId);
    if (!doc) throw documentsError('DOCUMENT_NOT_FOUND');
    if (doc.status === 'FINALIZED') throw documentsError('DOCUMENT_FINALIZED');
    if (doc.status === 'ARCHIVED') throw documentsError('INVALID_STATUS_TRANSITION');
    return doc;
  }

  // --- documents -----------------------------------------------------------

  async createDocument({ tenantId, actorUserId, input }) {
    await this._assertActive(tenantId);
    await this._assertClientExists(tenantId, input.clientId);
    return this.deps.repository.createDocument(tenantId, this._buildDoc(input, { clientId: input.clientId, actorUserId }));
  }

  async getDocument({ tenantId, documentId }) {
    const doc = await this.deps.repository.findDocumentById(tenantId, documentId);
    if (!doc) throw documentsError('DOCUMENT_NOT_FOUND');
    return doc;
  }

  async listDocuments({ tenantId, limit, cursor, clientId, documentType, status }) {
    return this.deps.repository.listDocuments(tenantId, {
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
      ...(documentType !== undefined ? { documentType } : {}),
      ...(status !== undefined ? { status } : {}),
    });
  }

  async updateDocument({ tenantId, documentId, actorUserId, expectedVersion, input }) {
    await this._assertActive(tenantId);
    await this._requireMutableDocument(tenantId, documentId);
    const patch = { updatedBy: actorUserId };
    for (const key of ['documentType', 'title', 'description']) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    if (input.documentDate !== undefined) patch.documentDate = new Date(input.documentDate);
    if (input.expiresAt !== undefined) patch.expiresAt = new Date(input.expiresAt);
    return this.deps.repository.updateDocument(tenantId, documentId, patch, expectedVersion);
  }

  // --- binary artifact upload / download (Phase 4.1) -----------------------

  /**
   * Attach (or replace) the binary artifact for a DRAFT document. The server is
   * authoritative: it validates the content type against the allowlist, measures
   * the real byte length, computes the checksum, generates the storageRef, and
   * writes the bytes through the storage adapter. The client's claimed size/ref/
   * checksum are never trusted. A FINALIZED document is immutable (rejected).
   */
  async attachFile({ tenantId, documentId, actorUserId, upload }) {
    await this._assertActive(tenantId);
    const doc = await this._requireMutableDocument(tenantId, documentId);
    const { storage, limits } = this.deps;
    const { buffer, descriptor } = validateUpload(upload, limits);
    const storageRef = buildStorageKey({ tenantId, documentId });
    await storage.put(storageRef, buffer, descriptor.contentType);
    // If a prior artifact existed, remove it after the new one is safely written.
    if (doc.storageRef && doc.storageRef !== storageRef && keyBelongsToTenant(doc.storageRef, tenantId)) {
      await storage.remove(doc.storageRef).catch(() => {});
    }
    const updated = await this.deps.repository.setArtifact(
      tenantId, documentId,
      { updatedBy: actorUserId, storageRef, contentType: descriptor.contentType, sizeBytes: descriptor.sizeBytes, checksum: descriptor.checksum },
    );
    recordSafely({
      tenantId, actorId: actorUserId, action: 'document.file_attached', entityType: 'clinical_document', entityId: documentId,
      outcome: 'success', payload: { contentType: descriptor.contentType, sizeBytes: descriptor.sizeBytes, checksum: descriptor.checksum },
    });
    return updated;
  }

  /**
   * Stream-read a document's stored artifact. Re-asserts tenant ownership of the
   * storageRef (defense-in-depth against a mismatched ref) before returning
   * bytes. Returns { buffer, contentType, fileName }.
   */
  async downloadFile({ tenantId, documentId }) {
    const doc = await this.deps.repository.findDocumentById(tenantId, documentId);
    if (!doc) throw documentsError('DOCUMENT_NOT_FOUND');
    if (!doc.storageRef) throw documentsError('DOCUMENT_NOT_FOUND');
    if (!keyBelongsToTenant(doc.storageRef, tenantId)) {
      // A stored ref that doesn't belong to the caller's tenant must never be served.
      throw documentsError('DOCUMENT_NOT_FOUND');
    }
    const { buffer, contentType } = await this.deps.storage.get(doc.storageRef);
    return { buffer, contentType: doc.contentType ?? contentType, fileName: doc.title };
  }

  async finalizeDocument({ tenantId, documentId, actorUserId }) {
    await this._assertActive(tenantId);
    const doc = await this.deps.repository.findDocumentById(tenantId, documentId);
    if (!doc) throw documentsError('DOCUMENT_NOT_FOUND');
    if (doc.status !== 'DRAFT') throw documentsError('INVALID_STATUS_TRANSITION');
    return this.deps.repository.finalizeDocument(tenantId, documentId, actorUserId);
  }

  async archiveDocument({ tenantId, documentId, actorUserId }) {
    await this._assertActive(tenantId);
    const doc = await this.deps.repository.findDocumentById(tenantId, documentId);
    if (!doc) throw documentsError('DOCUMENT_NOT_FOUND');
    if (doc.status === 'ARCHIVED') throw documentsError('INVALID_STATUS_TRANSITION');
    return this.deps.repository.archiveDocument(tenantId, documentId, actorUserId);
  }

  async supersedeDocument({ tenantId, documentId, actorUserId, input }) {
    await this._assertActive(tenantId);
    const source = await this.deps.repository.findDocumentById(tenantId, documentId);
    if (!source) throw documentsError('DOCUMENT_NOT_FOUND');
    if (source.status !== 'FINALIZED') throw documentsError('INVALID_STATUS_TRANSITION');
    if (source.supersededByDocumentId) throw documentsError('ALREADY_SUPERSEDED');
    const newDoc = this._buildDoc(input, { clientId: source.clientId, actorUserId });
    return this.deps.repository.supersedeDocument(tenantId, documentId, newDoc);
  }

  // --- internals -----------------------------------------------------------

  /** Assemble a DRAFT document from validated input, sharing the create/supersede path. */
  _buildDoc(input, { clientId, actorUserId }) {
    return {
      clientId,
      title: input.title,
      status: 'DRAFT',
      ...(input.documentType !== undefined ? { documentType: input.documentType } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.documentDate !== undefined ? { documentDate: new Date(input.documentDate) } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: new Date(input.expiresAt) } : {}),
      createdBy: actorUserId,
      updatedBy: actorUserId,
    };
  }
}
