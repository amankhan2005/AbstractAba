import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { AUTHORIZATION_STATUS } from './enums.js';

/**
 * A payer authorization permitting a client to receive a service for a number
 * of units within a date window. Appointments burn down authorizedUnits; a
 * session may only be booked against an ACTIVE authorization with units
 * remaining and a covering date range. Tenant-owned. Versioned for optimistic
 * concurrency (the burn-down is the reconciliation basis Phase 3 relies on).
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    clientId: { type: String, required: true, index: true },
    payerName: { type: String, default: null, trim: true },
    authorizationNumber: { type: String, default: null, trim: true },
    serviceCode: { type: String, default: null, trim: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    authorizedUnits: { type: Number, required: true, min: 0 },
    usedUnits: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: AUTHORIZATION_STATUS, default: 'ACTIVE' },
  },
  { timestamps: true, versionKey: false, collection: 'authorization' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, clientId: 1 });
schema.index({ tenantId: 1, clientId: 1, status: 1 });
schema.index({ tenantId: 1, endDate: 1 });

export const Authorization = mongoose.model('Authorization', schema);
