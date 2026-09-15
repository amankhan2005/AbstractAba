import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';

/**
 * A supervision relationship between two staff profiles — which supervisor
 * (typically a BCBA) oversees which supervisee (typically an RBT). Feeds
 * clinical sign-off authority in later phases. Tenant-owned. An active link is
 * unique per (supervisor, supervisee) pair within the tenant.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    supervisorStaffId: { type: String, required: true, index: true },
    superviseeStaffId: { type: String, required: true, index: true },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false, collection: 'supervisionLink' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, supervisorStaffId: 1 });
schema.index({ tenantId: 1, superviseeStaffId: 1 });
schema.index(
  { tenantId: 1, supervisorStaffId: 1, superviseeStaffId: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);

export const SupervisionLink = mongoose.model('SupervisionLink', schema);
