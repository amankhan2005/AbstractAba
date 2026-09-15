import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { MEMBERSHIP_STATUS } from './enums.js';

/** Joins a global user to one organization. Tenant-owned (RLS → tenant plugin). */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    userId: { type: String, required: true, index: true },
    status: { type: String, enum: MEMBERSHIP_STATUS, default: 'INVITED' },
    isOwner: { type: Boolean, default: false },
    joinedAt: { type: Date, default: null },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'membership' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, userId: 1 }, { unique: true });
schema.index({ tenantId: 1, status: 1 });

export const Membership = mongoose.model('Membership', schema);
