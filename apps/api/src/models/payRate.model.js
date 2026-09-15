import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { PAY_RATE_TYPE } from './enums.js';

/**
 * A staff member's pay rate, effective-dated. Tenant-owned. Money is integer
 * minor units (cents): for HOURLY, amount is per hour; for PER_SESSION, per
 * session; for SALARY, per pay period. The active rate for a date is the most
 * recent one whose effectiveFrom <= date (and effectiveTo null or >= date).
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    staffProfileId: { type: String, required: true, index: true },
    rateType: { type: String, enum: PAY_RATE_TYPE, required: true },
    amount: { type: Number, required: true, min: 0 }, // minor units
    currency: { type: String, default: 'usd', lowercase: true },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'pay_rate' },
);
schema.plugin(tenantPlugin);
attributionFields(schema);

export const PayRate = mongoose.models.PayRate || mongoose.model('PayRate', schema);
