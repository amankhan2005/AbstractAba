import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { attributionFields } from '../tenancy/baseFields.js';

/** A single line on an invoice. Money in integer minor units. */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    invoiceId: { type: String, required: true, index: true },
    organizationId: { type: String, required: true, index: true },
    description: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0 },
    unitAmount: { type: Number, required: true }, // minor units (may be negative for discounts)
    amount: { type: Number, required: true }, // quantity * unitAmount, computed server-side
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, versionKey: false, collection: 'invoice_line_item' },
);
attributionFields(schema);

export const InvoiceLineItem =
  mongoose.models.InvoiceLineItem || mongoose.model('InvoiceLineItem', schema);
