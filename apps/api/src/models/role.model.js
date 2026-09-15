import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';

/** A role within one organization. Tenant-owned. Eight system roles seeded per tenant. */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    key: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    system: { type: Boolean, default: true },
    assignable: { type: Boolean, default: true },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'role' },
);
schema.plugin(tenantPlugin);
attributionFields(schema);
schema.index({ tenantId: 1, key: 1 }, { unique: true });

export const Role = mongoose.model('Role', schema);
