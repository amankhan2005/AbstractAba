import mongoose from 'mongoose';
import { ClinicalDocument } from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';
import { supportsTransactions } from '../../config/db.js';
import { documentsError } from './documents.errors.js';

/**
 * Persistence for the clinical-documents module. Every tenant-owned operation
 * runs under withTenant(); the tenant plugin stamps and scopes it and fails
 * closed without a context. Finalize is a status transition (not a delete), so a
 * finalized document stays fully readable; immutability is enforced by the
 * service. The supersede chain is written in a transaction where the deployment
 * supports it (the old document is archived and linked, the new draft filed).
 */
export class DocumentsRepository {
  async createDocument(tenantId, doc) {
    return withTenant(tenantId, async () => {
      const created = await ClinicalDocument.create(doc);
      return toDocument(created.toObject());
    });
  }

  async findDocumentById(tenantId, documentId) {
    return withTenant(tenantId, async () => {
      const doc = await ClinicalDocument.findOne({ _id: documentId, deletedAt: null }).lean();
      return doc ? toDocument(doc) : null;
    });
  }

  async listDocuments(tenantId, query) {
    return withTenant(tenantId, async () => {
      const filter = { deletedAt: null };
      if (query.clientId) filter.clientId = query.clientId;
      if (query.documentType) filter.documentType = query.documentType;
      if (query.status) filter.status = query.status;
      if (query.cursor) filter._id = { $lt: query.cursor };
      const limit = query.limit ?? 25;
      const rows = await ClinicalDocument.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return { items: page.map(toDocument), nextCursor: hasMore ? page[page.length - 1]._id : null };
    });
  }

  async updateDocument(tenantId, documentId, patch, expectedVersion) {
    return withTenant(tenantId, async () => {
      const updated = await ClinicalDocument.findOneAndUpdate(
        { _id: documentId, deletedAt: null, version: expectedVersion },
        { $set: patch, $inc: { version: 1 } },
        { new: true },
      ).lean();
      if (updated) return toDocument(updated);
      const exists = await ClinicalDocument.exists({ _id: documentId, deletedAt: null });
      throw documentsError(exists ? 'VERSION_CONFLICT' : 'DOCUMENT_NOT_FOUND');
    });
  }

  /**
   * Set the stored-artifact descriptor fields (storageRef/contentType/sizeBytes/
   * checksum). This is a server-authoritative write from attachFile that is NOT
   * gated on the client's optimistic version — the bytes are already safely
   * stored; it still refuses a non-DRAFT document (content immutability).
   */
  async setArtifact(tenantId, documentId, patch) {
    return withTenant(tenantId, async () => {
      const updated = await ClinicalDocument.findOneAndUpdate(
        { _id: documentId, deletedAt: null, status: 'DRAFT' },
        { $set: patch, $inc: { version: 1 } },
        { new: true },
      ).lean();
      if (updated) return toDocument(updated);
      const exists = await ClinicalDocument.exists({ _id: documentId, deletedAt: null });
      throw documentsError(exists ? 'DOCUMENT_FINALIZED' : 'DOCUMENT_NOT_FOUND');
    });
  }

  async finalizeDocument(tenantId, documentId, actorUserId) {
    return withTenant(tenantId, async () => {
      const now = new Date();
      const updated = await ClinicalDocument.findOneAndUpdate(
        { _id: documentId, deletedAt: null, status: 'DRAFT' },
        { $set: { status: 'FINALIZED', finalizedAt: now, finalizedBy: actorUserId, updatedBy: actorUserId }, $inc: { version: 1 } },
        { new: true },
      ).lean();
      if (updated) return toDocument(updated);
      const exists = await ClinicalDocument.exists({ _id: documentId, deletedAt: null });
      throw documentsError(exists ? 'INVALID_STATUS_TRANSITION' : 'DOCUMENT_NOT_FOUND');
    });
  }

  async archiveDocument(tenantId, documentId, actorUserId) {
    return withTenant(tenantId, async () => {
      const updated = await ClinicalDocument.findOneAndUpdate(
        { _id: documentId, deletedAt: null, status: { $ne: 'ARCHIVED' } },
        { $set: { status: 'ARCHIVED', updatedBy: actorUserId } },
        { new: true },
      ).lean();
      if (updated) return toDocument(updated);
      const exists = await ClinicalDocument.exists({ _id: documentId, deletedAt: null });
      throw documentsError(exists ? 'INVALID_STATUS_TRANSITION' : 'DOCUMENT_NOT_FOUND');
    });
  }

  /**
   * File a new DRAFT that supersedes an existing FINALIZED document, archiving
   * the old one and linking both, atomically where transactions are available.
   */
  async supersedeDocument(tenantId, sourceId, newDoc) {
    return withTenant(tenantId, async () => {
      let created;
      await this._maybeTx(async (session) => {
        const opt = session ? { session } : {};
        const [doc] = await ClinicalDocument.create([{ ...newDoc, supersedesDocumentId: sourceId }], opt);
        created = doc;
        await ClinicalDocument.updateOne(
          { _id: sourceId, deletedAt: null },
          { $set: { status: 'ARCHIVED', supersededByDocumentId: doc._id, updatedBy: newDoc.updatedBy } },
          opt,
        );
      });
      return toDocument(created.toObject());
    });
  }

  async _maybeTx(fn) {
    if (!supportsTransactions()) return fn(null);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => { await fn(session); });
    } finally {
      await session.endSession();
    }
  }
}

// --- mapper ----------------------------------------------------------------

function toDocument(doc) {
  return {
    id: doc._id,
    clientId: doc.clientId,
    documentType: doc.documentType,
    title: doc.title,
    description: doc.description ?? null,
    status: doc.status,
    storageRef: doc.storageRef ?? null,
    contentType: doc.contentType ?? null,
    sizeBytes: doc.sizeBytes ?? null,
    checksum: doc.checksum ?? null,
    documentDate: doc.documentDate ?? null,
    expiresAt: doc.expiresAt ?? null,
    finalizedAt: doc.finalizedAt ?? null,
    finalizedBy: doc.finalizedBy ?? null,
    supersedesDocumentId: doc.supersedesDocumentId ?? null,
    supersededByDocumentId: doc.supersededByDocumentId ?? null,
    createdAt: doc.createdAt,
    version: doc.version,
  };
}

export const documentsRepository = new DocumentsRepository();
