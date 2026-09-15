import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { ADJUSTMENT_GROUP } from './enums.js';

/**
 * A CAS adjustment line from an 835, linked to a claim. Tenant-owned. Uses the
 * payer-supplied CARC group + reason codes verbatim — no invented codes. Money
 * in integer minor units.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    claimId: { type: String, default: null, index: true },
    eraClaimPaymentId: { type: String, required: true, index: true },
    groupCode: { type: String, enum: ADJUSTMENT_GROUP, required: true }, // CAS01 (CO/PR/OA/PI/CR)
    reasonCode: { type: String, required: true }, // CARC (CAS02)
    amount: { type: Number, required: true }, // minor units (CAS03), may be negative
  },
  { timestamps: true, versionKey: false, collection: 'payment_adjustment' },
);
schema.plugin(tenantPlugin);
attributionFields(schema);

export const PaymentAdjustment = mongoose.models.PaymentAdjustment || mongoose.model('PaymentAdjustment', schema);
