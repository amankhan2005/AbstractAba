import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';

/** Assignment of a role to a membership. Tenant-owned join. */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    membershipId: { type: String, required: true, index: true },
    roleId: { type: String, required: true, index: true },
    assignedAt: { type: Date, default: Date.now },
    assignedBy: { type: String, default: null },
  },
  { versionKey: false, collection: 'membership_role' },
);
schema.plugin(tenantPlugin);
schema.index({ membershipId: 1, roleId: 1 }, { unique: true });

export const MembershipRole = mongoose.model('MembershipRole', schema);
