import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { TIMESHEET_STATUS } from './enums.js';

/**
 * A staff member's timesheet for a pay period. Tenant-owned. The approval
 * workflow (DRAFT -> SUBMITTED -> APPROVED/REJECTED) is enforced server-side.
 * totalMinutes is derived from its time entries by the service, never trusted
 * from the client.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    staffProfileId: { type: String, required: true, index: true },
    payPeriodId: { type: String, required: true, index: true },
    status: { type: String, enum: TIMESHEET_STATUS, default: 'DRAFT', index: true },
    totalMinutes: { type: Number, default: 0, min: 0 },
    submittedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: String, default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'timesheet' },
);
schema.index({ organizationId: 1, staffProfileId: 1, payPeriodId: 1 }, { unique: true });
schema.plugin(tenantPlugin);
attributionFields(schema);

export const Timesheet = mongoose.models.Timesheet || mongoose.model('Timesheet', schema);
