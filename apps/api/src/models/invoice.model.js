import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { INVOICE_STATUS } from './enums.js';

/**
 * A billing invoice for a company. Platform-scoped, keyed by organizationId.
 * All monetary fields are integer minor units (cents). Authoritative totals are
 * computed server-side; the frontend only displays them.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true, index: true },
    subscriptionId: { type: String, default: null },
    invoiceNumber: { type: String, required: true, unique: true },
    status: { type: String, enum: INVOICE_STATUS, default: 'DRAFT', index: true },
    currency: { type: String, default: 'usd', lowercase: true },
    subtotal: { type: Number, required: true, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    creditsApplied: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    amountPaid: { type: Number, default: 0, min: 0 },
    amountDue: { type: Number, required: true, min: 0 },
    dueDate: { type: Date, default: null },
    issuedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    voidedAt: { type: Date, default: null },
    processorInvoiceId: { type: String, default: null },
    // Idempotency guard for cycle-driven generation. Uniqueness is enforced by
    // a PARTIAL index below (string values only). A `unique + sparse` path index
    // here would be wrong: `default: null` makes generationKey present-but-null
    // on every manually created invoice, and sparse does not skip explicit
    // nulls, so a 2nd null-key invoice would falsely collide (E11000).
    generationKey: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, versionKey: false, collection: 'invoice' },
);
schema.index({ organizationId: 1, status: 1 });
schema.index({ organizationId: 1, createdAt: -1 });
schema.index({ dueDate: 1 });
// Idempotency: a generationKey is unique only when actually set (string).
schema.index(
  { generationKey: 1 },
  { unique: true, partialFilterExpression: { generationKey: { $type: 'string' } } },
);
attributionFields(schema);

export const Invoice = mongoose.models.Invoice || mongoose.model('Invoice', schema);
