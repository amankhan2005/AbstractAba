import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';

/**
 * A company's saved parent/guardian email template — reusable across future
 * sends from the existing parent-email composer. Tenant-owned; the subject and
 * body use only the platform's allowlisted variables (validated on save and
 * again when rendered). Recipient and sender are never stored here: they are
 * resolved server-side at send time.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    name: { type: String, required: true, trim: true },
    // Case-insensitive identity for duplicate-name protection within a tenant.
    nameKey: { type: String, required: true },
    subject: { type: String, required: true, trim: true },
    body: { type: String, required: true },
  },
  { timestamps: true, versionKey: false, collection: 'email_template' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, nameKey: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
schema.index({ tenantId: 1, updatedAt: -1 });

export const EmailTemplate = mongoose.model('EmailTemplate', schema);
