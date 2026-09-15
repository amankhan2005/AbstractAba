import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';

/**
 * A supervision-hour record: reliable tracking of supervision time between a
 * supervisor and supervisee for a given date. Tenant-owned. May be generated
 * from a SIGNED observation (observationId set) or entered directly. Minutes are
 * a positive integer; the (tenant, observationId) pair is unique when present so
 * a signed observation contributes its hours exactly once (idempotent posting).
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    supervisorStaffId: { type: String, required: true, index: true },
    superviseeStaffId: { type: String, required: true, index: true },
    observationId: { type: String, default: null },
    date: { type: Date, required: true },
    minutes: { type: Number, required: true, min: 1 },
    note: { type: String, default: '' },
  },
  { timestamps: true, versionKey: false, collection: 'supervisionHourLog' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, superviseeStaffId: 1, date: -1 });
schema.index({ tenantId: 1, supervisorStaffId: 1, date: -1 });
// A signed observation posts its hours exactly once (idempotency guard).
schema.index(
  { tenantId: 1, observationId: 1 },
  { unique: true, partialFilterExpression: { observationId: { $type: 'string' } } },
);

export const SupervisionHourLog = mongoose.model('SupervisionHourLog', schema);
