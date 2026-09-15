import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { PAYMENT_STATUS, PAYMENT_METHOD } from './enums.js';

/**
 * A manually recorded payment against an invoice. Abstract ABA uses manual billing —
 * there is no payment processor. An authorized admin/billing user records a
 * payment received out-of-band (bank transfer, check, cash). Platform-scoped,
 * keyed by organizationId. Money in integer minor units. Stores no card data.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true, index: true },
    invoiceId: { type: String, required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'usd', lowercase: true },
    status: { type: String, enum: PAYMENT_STATUS, default: 'SUCCEEDED', index: true },
    paymentMethod: { type: String, enum: PAYMENT_METHOD, default: 'BANK_TRANSFER' },
    referenceNumber: { type: String, default: null, trim: true },
    paymentDate: { type: Date, default: () => new Date() },
    notes: { type: String, default: null },
    recordedBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'payment' },
);
schema.index({ organizationId: 1, status: 1 });
attributionFields(schema);

export const Payment = mongoose.models.Payment || mongoose.model('Payment', schema);
