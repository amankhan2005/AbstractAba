import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';

/**
 * A recurring weekly availability window for a staff member: a day of week and
 * a minute-of-day range, optionally bounded by an effective date range. An
 * appointment may only be booked when it falls entirely within one of the
 * staff member's availability windows. Tenant-owned.
 *
 * dayOfWeek: 0 = Sunday … 6 = Saturday (UTC).
 * startMinute/endMinute: minutes from midnight, 0..1440, startMinute < endMinute.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    staffProfileId: { type: String, required: true, index: true },
    dayOfWeek: { type: Number, required: true, min: 0, max: 6 },
    startMinute: { type: Number, required: true, min: 0, max: 1440 },
    endMinute: { type: Number, required: true, min: 0, max: 1440 },
    effectiveFrom: { type: Date, default: null },
    effectiveTo: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'availability' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, staffProfileId: 1 });
schema.index({ tenantId: 1, staffProfileId: 1, dayOfWeek: 1 });

export const Availability = mongoose.model('Availability', schema);
