import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { CREDIT_NOTE_STATUS } from './enums.js';

/** A credit issued to a company, optionally applied to an invoice. Minor units. */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true, index: true },
    invoiceId: { type: String, default: null, index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'usd', lowercase: true },
    reason: { type: String, required: true },
    status: { type: String, enum: CREDIT_NOTE_STATUS, default: 'ISSUED', index: true },
    processorReference: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'credit_note' },
);
attributionFields(schema);

export const CreditNote = mongoose.models.CreditNote || mongoose.model('CreditNote', schema);
