import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';

/** Per-organization namespaced configuration. Tenant-owned. */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    namespace: { type: String, required: true },
    key: { type: String, required: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'organization_setting' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, namespace: 1, key: 1 }, { unique: true });
schema.index({ tenantId: 1, namespace: 1 });

export const OrganizationSetting = mongoose.model('OrganizationSetting', schema);
