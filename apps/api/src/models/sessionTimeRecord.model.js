import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';

/**
 * A per-session payroll/time record — the receipt produced the moment a BCBA
 * finalizes a session they delivered (BCBA panel spec §13–§16).
 *
 * WHY THIS EXISTS ALONGSIDE THE EXISTING PAYROLL PIPELINE. The platform's
 * timesheet/pay-period/payroll-run flow (modules/payroll) computes pay LAZILY:
 * it imports FROZEN sessions into a timesheet and a payroll run recomputes the
 * amount from the effective PayRate at run time. That is the aggregate the
 * finance team approves. It is NOT a snapshot, and it does not exist until a
 * pay period is opened. The spec asks for something the lazy pipeline cannot
 * give: an immediate, admin-visible time record for THIS session that carries
 * the exact worked duration, the hourly rate that applied AT completion, the
 * computed amount, the selected ABA/FBA authorization and the session memo, and
 * that never changes when the staff member's rate later changes (§14 rate
 * snapshot; §16 idempotency).
 *
 * This model is that snapshot. It is NOT a second payroll calculation engine —
 * the arithmetic reuses payroll.math (minutesBetween + computeLineAmount), the
 * one source of pay math. The session is also FROZEN at completion, so the
 * existing timesheet import still sees it in its pay period exactly as before;
 * this record and that pipeline derive from the SAME worked minutes and never
 * double-pay (nothing sums SessionTimeRecord into a PayrollRun).
 *
 * IDEMPOTENCY (§16, critical). One record per session, full stop: the unique
 * index on (tenantId, sessionId) makes a double-click / refresh / retry a
 * no-op — the duplicate insert is rejected and the finalizer returns the
 * existing record instead of creating a second one.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },

    // --- Who + what the worked time belongs to ---------------------------
    staffProfileId: { type: String, required: true, index: true }, // the BCBA
    clientId: { type: String, required: true },
    sessionId: { type: String, required: true }, // one record per session
    appointmentId: { type: String, required: true },

    // The ABA/FBA authorization the BCBA associated the work with (§11). The
    // full eligible set is kept for traceability; `authorizationId` is the one
    // selected to receive the work.
    authorizationId: { type: String, default: null },
    authorizationIds: { type: [String], default: [] },

    // --- Server-authoritative timing (§9, §10) ---------------------------
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, required: true },
    workedMinutes: { type: Number, required: true, min: 0 },

    // --- Pay snapshot (§13, §14) -----------------------------------------
    // hourlyRateSnapshot is integer MINOR units (cents), matching PayRate and
    // the rest of payroll. Frozen at completion; a later rate change never
    // rewrites this row.
    hourlyRateSnapshot: { type: Number, default: null },
    currency: { type: String, default: 'usd', lowercase: true },
    amount: { type: Number, default: null }, // minor units; null when no rate configured

    // --- Documentation (§12) ---------------------------------------------
    // The session memo is also the session's clinical narrative (sealed PHI on
    // the Session row). A short, non-PHI copy is NOT stored here; the memo lives
    // with the session and is read through the PHI seam. This field records only
    // whether a memo was captured, so admin payroll can flag missing notes
    // without opening PHI.
    memoCaptured: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false, collection: 'session_time_record' },
);

schema.plugin(tenantPlugin);
attributionFields(schema);

// One payroll/time record per session, per tenant. This is the idempotency
// guarantee behind §16: a repeated finalize cannot create a second record.
schema.index({ tenantId: 1, sessionId: 1 }, { unique: true });
schema.index({ tenantId: 1, staffProfileId: 1, startedAt: -1 });
schema.index({ tenantId: 1, startedAt: -1 });

export const SessionTimeRecord =
  mongoose.models.SessionTimeRecord || mongoose.model('SessionTimeRecord', schema);
