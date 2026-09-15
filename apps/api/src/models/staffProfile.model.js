import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { STAFF_STATUS } from './enums.js';

/**
 * A clinical staff member's profile within a tenant, linked to the platform
 * user behind their membership. Drives scheduling eligibility (an appointment
 * may only be booked against an active, credentialed staff member) and clinical
 * sign-off authority (via supervision links). Staff data is PII, not PHI: it is
 * stored in the clear under tenant isolation + RBAC, with no PHI seam.
 *
 * One profile per user per tenant (unique on userId).
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    userId: { type: String, required: true },
    firstName: { type: String, required: true, trim: true },
    middleName: { type: String, default: null, trim: true },
    lastName: { type: String, required: true, trim: true },
    title: { type: String, default: null, trim: true },
    discipline: { type: String, default: null, trim: true },
    employeeNumber: { type: String, default: null, trim: true },
    status: { type: String, enum: STAFF_STATUS, default: 'ACTIVE', index: true },
    startDate: { type: Date, default: null },
    notes: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'staffProfile' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, userId: 1 }, { unique: true });
schema.index({ tenantId: 1, lastName: 1, firstName: 1 });

export const StaffProfile = mongoose.model('StaffProfile', schema);
