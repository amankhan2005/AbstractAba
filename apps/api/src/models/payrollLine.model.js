import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { PAY_RATE_TYPE } from './enums.js';

/**
 * One staff member's computed pay within a payroll run. Tenant-owned. All fields
 * are computed server-side and frozen when the run is finalized: minutes and
 * sessionCount come from approved timesheets; rateAmount from the effective pay
 * rate; amount is the server-side product in integer minor units.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    payrollRunId: { type: String, required: true, index: true },
    staffProfileId: { type: String, required: true, index: true },
    rateType: { type: String, enum: PAY_RATE_TYPE, required: true },
    rateAmount: { type: Number, required: true, min: 0 }, // minor units (snapshot)
    minutes: { type: Number, default: 0, min: 0 },
    sessionCount: { type: Number, default: 0, min: 0 },
    amount: { type: Number, required: true, min: 0 }, // minor units, computed
    currency: { type: String, default: 'usd', lowercase: true },
    // Period payroll: the staff member's role(s) for this work ('BCBA', 'RBT',
    // 'BCBA / RBT') and every hourly rate applied, so a generated payroll can be
    // shown and downloaded exactly as it was generated.
    role: { type: String, default: null },
    hourlyRates: { type: [Number], default: undefined },
  },
  { timestamps: true, versionKey: false, collection: 'payroll_line' },
);
schema.plugin(tenantPlugin);
attributionFields(schema);

export const PayrollLine = mongoose.models.PayrollLine || mongoose.model('PayrollLine', schema);
