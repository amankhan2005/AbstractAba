import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';

/** Per-channel delivery record. Tenant-owned. */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    notificationId: { type: String, required: true },
    channel: { type: String, required: true },
    status: { type: String, default: 'pending' },
    failureReason: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'notification_delivery' },
);
schema.plugin(tenantPlugin);
schema.index({ tenantId: 1, notificationId: 1 });

export const NotificationDelivery = mongoose.model('NotificationDelivery', schema);
