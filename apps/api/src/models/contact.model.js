import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { CONTACT_TYPE } from './enums.js';

/**
 * A non-guardian contact associated with a client (emergency contact,
 * physician, case manager). A separate tenant-owned collection referenced by
 * clientId. Contacts carry no legal responsibility — that is the guardian's
 * role — so they are simpler records.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    clientId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    contactType: { type: String, enum: CONTACT_TYPE, default: 'OTHER' },
    phone: { type: String, default: null, trim: true },
    email: { type: String, default: null, trim: true, lowercase: true },
    organizationName: { type: String, default: null, trim: true },
    notes: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'contact' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, clientId: 1 });

export const Contact = mongoose.model('Contact', schema);
