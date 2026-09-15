import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { RECURRENCE_FREQUENCY, APPOINTMENT_SERIES_STATUS } from './enums.js';

/**
 * A recurring-appointment series. It holds the recurrence rule and the booking
 * template (client, staff, authorization, time-of-day window, duration, units);
 * materialization expands the rule into concrete Appointment rows, each linked
 * back via seriesId. Tenant-owned.
 *
 * The rule is deliberately small (DAILY/WEEKLY + interval + optional weekdays,
 * bounded by untilDate or count) — enough for real ABA scheduling without
 * pulling in a full RRULE dependency. Times of day are stored as minute-of-day
 * (UTC) so an occurrence date + startMinute/endMinute yields the concrete window.
 *
 * Cancelling a series is server-authoritative and only affects FUTURE occurrences;
 * already-materialized past/held appointments are left as historical record.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    // Booking template
    clientId: { type: String, required: true },
    staffProfileId: { type: String, required: true },
    authorizationId: { type: String, required: true },
    serviceCode: { type: String, default: null, trim: true },
    units: { type: Number, default: null, min: 1 },
    startMinute: { type: Number, required: true, min: 0, max: 1439 },
    endMinute: { type: Number, required: true, min: 1, max: 1440 },
    // Recurrence rule
    frequency: { type: String, enum: RECURRENCE_FREQUENCY, required: true },
    interval: { type: Number, required: true, min: 1, max: 52, default: 1 },
    byWeekday: { type: [Number], default: [] }, // 0=Sun..6=Sat (WEEKLY only)
    startDate: { type: Date, required: true },
    untilDate: { type: Date, default: null },
    count: { type: Number, default: null, min: 1, max: 366 },
    notes: { type: String, default: null },
    status: { type: String, enum: APPOINTMENT_SERIES_STATUS, default: 'ACTIVE', index: true },
    lastMaterializedDate: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'appointmentSeries' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, staffProfileId: 1, startDate: 1 });
schema.index({ tenantId: 1, clientId: 1, startDate: 1 });
schema.index({ tenantId: 1, status: 1 });

export const AppointmentSeries = mongoose.model('AppointmentSeries', schema);
