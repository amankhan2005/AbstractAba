import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { TIME_ENTRY_SOURCE } from './enums.js';

/**
 * A single block of worked time on a timesheet. Tenant-owned. Entries derived
 * from a FROZEN session carry source SESSION + sessionId (deduped); manual
 * entries carry source MANUAL. minutes is authoritative and validated
 * server-side (> 0). Corrections are edits that keep an audit trail; entries on
 * an APPROVED timesheet are immutable.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    timesheetId: { type: String, required: true, index: true },
    staffProfileId: { type: String, required: true, index: true },
    source: { type: String, enum: TIME_ENTRY_SOURCE, required: true },
    sessionId: { type: String, default: null }, // set when source = SESSION
    workDate: { type: Date, required: true },
    minutes: { type: Number, required: true, min: 1 },
    note: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'time_entry' },
);
// Prevent the same session being imported twice into a timesheet.
schema.index({ organizationId: 1, timesheetId: 1, sessionId: 1 }, { unique: true, partialFilterExpression: { sessionId: { $type: 'string' } } });
schema.plugin(tenantPlugin);
attributionFields(schema);

export const TimeEntry = mongoose.models.TimeEntry || mongoose.model('TimeEntry', schema);
