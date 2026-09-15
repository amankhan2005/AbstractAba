import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { PAYROLL_RUN_STATUS } from './enums.js';

/**
 * A payroll run for a pay period. Tenant-owned. Lifecycle
 * DRAFT -> APPROVED -> FINALIZED is enforced server-side; a FINALIZED run is
 * immutable (no further edits, recompute, or line changes). totalAmount is the
 * sum of its lines, computed server-side in integer minor units.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    payPeriodId: { type: String, required: true, index: true },
    status: { type: String, enum: PAYROLL_RUN_STATUS, default: 'DRAFT', index: true },
    currency: { type: String, default: 'usd', lowercase: true },
    totalAmount: { type: Number, default: 0, min: 0 },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: String, default: null },
    finalizedAt: { type: Date, default: null },
    finalizedBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'payroll_run' },
);
schema.index({ organizationId: 1, payPeriodId: 1 }, { unique: true });
schema.plugin(tenantPlugin);
attributionFields(schema);

export const PayrollRun = mongoose.models.PayrollRun || mongoose.model('PayrollRun', schema);
