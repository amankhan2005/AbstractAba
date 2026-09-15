import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';

/** In-app notification centre + record. Tenant-owned. `body` never leaves the platform. */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    recipientUserId: { type: String, required: true },
    type: { type: String, required: true },
    priority: { type: String, required: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    link: { type: String, required: true },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, collection: 'notification' },
);
schema.plugin(tenantPlugin);
schema.index({ tenantId: 1, recipientUserId: 1, readAt: 1 });
schema.index({ tenantId: 1, recipientUserId: 1, createdAt: -1 });

export const Notification = mongoose.model('Notification', schema);
