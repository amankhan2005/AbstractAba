import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { DOCUMENT_TYPE, DOCUMENT_STATUS } from './enums.js';

/**
 * A clinical document filed against one client — an assessment, consent, report,
 * authorization letter, evaluation, and so on. This record is metadata and
 * lifecycle only: the file bytes themselves live in external object storage and
 * are referenced by the opaque `storageRef` (mirroring organizationExport's
 * artifactRef), never stored in Mongo. `contentType` / `sizeBytes` / `checksum`
 * describe that external artifact. Because the record is searched and listed by
 * title and type, those stay clear (protected by tenant isolation + RBAC +
 * metadata-only audit, exactly as client names are); no field is sealed here.
 *
 * Lifecycle: DRAFT → FINALIZED (the signed, immutable record of record) with
 * ARCHIVED as a supersede/withdraw transition. Once FINALIZED the content is
 * immutable — only the archive / supersede status moves are allowed (enforced in
 * the service). Versioning is a self-referential chain: superseding a finalized
 * document files a new DRAFT linked by supersedesDocumentId, and archives the old
 * one with supersededByDocumentId set. Tenant-owned, versioned for optimistic
 * concurrency.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    clientId: { type: String, required: true },
    documentType: { type: String, enum: DOCUMENT_TYPE, default: 'OTHER' },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: null },
    status: { type: String, enum: DOCUMENT_STATUS, default: 'DRAFT' },
    storageRef: { type: String, default: null }, // opaque external object-storage key; bytes never in Mongo
    contentType: { type: String, default: null },
    sizeBytes: { type: Number, default: null },
    checksum: { type: String, default: null },
    documentDate: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    finalizedAt: { type: Date, default: null },
    finalizedBy: { type: String, default: null },
    supersedesDocumentId: { type: String, default: null },
    supersededByDocumentId: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'clinicalDocument' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, clientId: 1, status: 1 });
schema.index({ tenantId: 1, documentType: 1 });
schema.index({ tenantId: 1, status: 1, expiresAt: 1 });

export const ClinicalDocument = mongoose.model('ClinicalDocument', schema);
