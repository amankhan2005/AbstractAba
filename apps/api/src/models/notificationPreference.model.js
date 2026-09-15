import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';

/** Per-user per-type muted off-platform channels. Tenant-owned. */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    userId: { type: String, required: true },
    type: { type: String, required: true },
    disabledChannels: { type: [String], default: [] },
    updatedBy: { type: String, required: true },
  },
  { timestamps: { createdAt: false, updatedAt: true }, versionKey: false, collection: 'notification_preference' },
);
schema.plugin(tenantPlugin);
schema.index({ tenantId: 1, userId: 1, type: 1 }, { unique: true });
schema.index({ tenantId: 1, userId: 1 });

export const NotificationPreference = mongoose.model('NotificationPreference', schema);
