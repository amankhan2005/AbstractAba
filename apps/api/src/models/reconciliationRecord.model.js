import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { RECONCILIATION_STATUS, RECONCILIATION_SOURCE } from './enums.js';

/**
 * A reconciliation record tracks the financial settlement of a claim or invoice.
 * Tenant-owned. Amounts are snapshots (integer minor units) recomputed by the
 * reconciliation service from authoritative source records; the workflow status
 * is managed through a server-side state machine. This does not duplicate the
 * source of truth — claims/invoices remain authoritative — it records the
 * reconciliation posture and review workflow over them.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    source: { type: String, enum: RECONCILIATION_SOURCE, required: true },
    claimId: { type: String, default: null, index: true },
    invoiceId: { type: String, default: null, index: true },
    billedAmount: { type: Number, default: 0, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    adjustmentAmount: { type: Number, default: 0, min: 0 },
    remainingAmount: { type: Number, default: 0 }, // may be negative to flag overpayment
    status: { type: String, enum: RECONCILIATION_STATUS, default: 'UNRECONCILED', index: true },
    discrepancyReason: { type: String, default: null },
    notes: { type: String, default: null },
    lastReconciledAt: { type: Date, default: null },
    reconciledBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'reconciliation_record' },
);
schema.index({ organizationId: 1, status: 1 });
schema.index({ organizationId: 1, source: 1, claimId: 1 }, { unique: true, partialFilterExpression: { claimId: { $type: 'string' } } });
schema.index({ organizationId: 1, source: 1, invoiceId: 1 }, { unique: true, partialFilterExpression: { invoiceId: { $type: 'string' } } });
schema.plugin(tenantPlugin);
attributionFields(schema);

export const ReconciliationRecord = mongoose.models.ReconciliationRecord || mongoose.model('ReconciliationRecord', schema);
