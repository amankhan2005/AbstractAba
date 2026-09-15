import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { APPOINTMENT_STATUS } from './enums.js';

/**
 * A scheduled appointment (session) binding a client, a staff member, and an
 * authorization within a concrete time window. Booking is guarded by eligibility
 * (bookable client, active credentialed staff), availability, authorization
 * validity, and double-booking prevention — all enforced in the service.
 * Tenant-owned. Versioned for optimistic concurrency on reschedule.
 *
 * `units` is the number of authorization units the appointment consumes; the
 * service burns them down on the authorization when the appointment is booked
 * and restores them on cancellation.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    clientId: { type: String, required: true },
    // Delivering clinician. Kept required and populated for backward
    // compatibility: Sessions/Billing/Payroll read appointment.staffProfileId,
    // so the new pipeline sets it to the RBT (the direct-service provider).
    staffProfileId: { type: String, required: true },
    // NEW pipeline (separate care-team roles). Additive fields — historical
    // appointments created before the rebuild simply have these null and stay
    // fully readable. bcbaId/rbtId are the two care-team members chosen at
    // booking; staffProfileId mirrors rbtId for legacy consumers.
    bcbaId: { type: String, default: null },
    rbtId: { type: String, default: null },
    // Primary authorization (legacy single-field readers, e.g. unit burn-down).
    authorizationId: { type: String, required: true },
    // NEW pipeline: all authorizations selected for this appointment (ABA/FBA).
    // authorizationId above is authorizationIds[0]. Multiple selections are
    // stored here as the full relationship set.
    authorizationIds: { type: [String], default: [] },
    // Set when this appointment was materialized from a recurring series (Phase 4.3).
    seriesId: { type: String, default: null, index: true },
    serviceCode: { type: String, default: null, trim: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    // Whether a clock time was actually entered at booking. Appointments created
    // without a Start/End time are DATE-ONLY: startAt/endAt are anchored to the
    // scheduled day only so date-range queries, indexes and the calendar keep
    // working, but `timeSet: false` tells every display NOT to show a clock time
    // (no fabricated time). Legacy/timed appointments default to true. Actual
    // worked time never comes from these fields — only from the clinician session.
    timeSet: { type: Boolean, default: true },
    // The IANA business timezone startAt/endAt are anchored to (onboarding §19).
    // Set by booking from organization.timezone. NULL means a legacy row whose
    // instants were composed as UTC wall-clock before the business-date fix —
    // the migration script stamps this field as it corrects each row, which is
    // what makes that migration repeatable and safe to re-run.
    businessTimeZone: { type: String, default: null },
    // Set ONLY by the business-date migration: the instants this row held before
    // it was re-anchored to the organization timezone. Kept so the correction is
    // auditable and reversible, and so historical meaning is never lost
    // (onboarding §23). Null on every appointment created after the fix.
    legacyStartAt: { type: Date, default: null },
    legacyEndAt: { type: Date, default: null },
    units: { type: Number, required: true, min: 1 },
    status: { type: String, enum: APPOINTMENT_STATUS, default: 'SCHEDULED' },
    notes: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'appointment' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, staffProfileId: 1, startAt: 1 });
schema.index({ tenantId: 1, clientId: 1, startAt: 1 });
schema.index({ tenantId: 1, status: 1, startAt: 1 });
// Company dashboard "Today's sessions": appointments overlapping a business day.
schema.index({ tenantId: 1, startAt: 1 });
// Dashboard visibility for the assigned BCBA/RBT (spec §16).
schema.index({ tenantId: 1, bcbaId: 1, startAt: 1 });
schema.index({ tenantId: 1, rbtId: 1, startAt: 1 });

export const Appointment = mongoose.model('Appointment', schema);
