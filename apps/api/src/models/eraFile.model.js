import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { ERA_FILE_STATUS } from './enums.js';

/**
 * An uploaded 835 remittance file. Tenant-owned. The raw EDI content is stored
 * on the record for asynchronous parsing (835 files are small text payloads, not
 * PHI documents); parsed results are written to EraClaimPayment. Processing runs
 * on the shared job worker and is idempotent.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    fileName: { type: String, required: true },
    sizeBytes: { type: Number, default: 0 },
    checksum: { type: String, default: null }, // sha256 of content, for dedupe/integrity
    rawContent: { type: String, default: null }, // 835 text; consumed by the parse job
    status: { type: String, enum: ERA_FILE_STATUS, default: 'RECEIVED', index: true },
    processedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    claimsParsed: { type: Number, default: 0 },
    matched: { type: Number, default: 0 },
    unmatched: { type: Number, default: 0 },
    ambiguous: { type: Number, default: 0 },
    totalPaidAmount: { type: Number, default: 0 }, // minor units, from BPR
  },
  { timestamps: true, versionKey: false, collection: 'era_file' },
);
schema.index({ organizationId: 1, status: 1 });
schema.index({ organizationId: 1, checksum: 1 }, { partialFilterExpression: { checksum: { $type: 'string' } } });
schema.plugin(tenantPlugin);
attributionFields(schema);

export const EraFile = mongoose.models.EraFile || mongoose.model('EraFile', schema);
