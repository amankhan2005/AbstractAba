import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';

/** A payroll date window. Tenant-owned. */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    label: { type: String, required: true, trim: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    // Set once a payroll run for this period is finalized (immutability marker).
    finalizedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'pay_period' },
);
schema.index({ organizationId: 1, startDate: 1 });
schema.plugin(tenantPlugin);
attributionFields(schema);

export const PayPeriod = mongoose.models.PayPeriod || mongoose.model('PayPeriod', schema);
