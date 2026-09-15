import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { SESSION_STATUS } from './enums.js';

/**
 * A clinical session: the data-capture record for one booked appointment. It
 * binds the appointment, the client, the delivering staff member, and the
 * client's ACTIVE treatment plan, and holds the data points collected against
 * that plan's targets (a separate collection) plus a free-text clinical
 * narrative.
 *
 * The narrative is PHI and is stored sealed in `sensitive.narrative` — opaque
 * ciphertext to every layer except the phi seam, exactly as the client SSN is.
 * Lists project the sealed envelope out; only an authorised detail read opens it.
 *
 * FREEZE is the headline behaviour: a session moves DRAFT → SUBMITTED → FROZEN,
 * and once FROZEN it (and its data points) become immutable — the clinical
 * record of record. Freeze is a status transition (not a soft-delete), so a
 * frozen session stays fully readable; the service enforces the immutability.
 * Tenant-owned, versioned for optimistic concurrency.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    appointmentId: { type: String, required: true },
    clientId: { type: String, required: true },
    staffProfileId: { type: String, required: true },
    // Nullable: a BCBA may start a session before the child has a treatment
    // plan (BCBA panel spec — a plan must NOT be required at session start).
    // The RBT/standard capture path still supplies one via sessions.service,
    // and plan-bound data-point capture rejects cleanly when this is null.
    treatmentPlanId: { type: String, default: null },
    // FIRST start and LAST end of the whole logical session. Kept as-is so every
    // existing reader (indexes, payroll windows, oversight, exports) is
    // unchanged; `intervals` below carries the detail.
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },

    // --- TIMING INTERVALS (onboarding §10 / §30) --------------------------
    // ONE logical session may contain SEVERAL work intervals on the same
    // business day: a clinician can Start, Stop, Start, Stop, Start, Stop and
    // that is still one session. Before this, the only way to record a second
    // interval was to complete the session and start another one, which turned
    // three intervals into THREE sessions — so reporting showed "Sessions: 3"
    // for one visit, and a stopped session could not be resumed at all.
    //
    // Every interval is preserved (never overwritten), which is what lets the
    // session detail show the full timing history while worked time is the SUM.
    // An interval with a null endedAt is the one currently running; there is at
    // most one, enforced by the service.
    //
    // Additive and default-empty, so every historical session stays valid and
    // readable: worked time falls back to startedAt→endedAt when a session
    // predates this field.
    intervals: [{
      _id: false,
      startedAt: { type: Date, required: true },
      endedAt: { type: Date, default: null },
      startedBy: { type: String, default: null }, // staffProfileId
      endedBy: { type: String, default: null },
    }],

    status: { type: String, enum: SESSION_STATUS, default: 'DRAFT' },
    // OPEN-slot flag (Phase 2 §4): true while a session is resumable
    // (DRAFT/IN_PROGRESS/STOPPED); set false when it is completed (FROZEN),
    // amended or cancelled, which frees the appointment+clinician slot so
    // another same-day session can be started. Drives the partial unique index.
    active: { type: Boolean, default: true },
    // Idempotency key for MANUAL session entry (Phase 3) — a deterministic
    // fingerprint of (staff, client, date, start, end). A repeated Save (double
    // click) resolves to the existing session instead of creating a duplicate.
    // Null for timer-created sessions.
    generationKey: { type: String, default: null },
    // How the session was recorded: 'MANUAL' for manual time entry, null for
    // the live Start/Stop workflow (backward compatible — existing rows stay null).
    source: { type: String, enum: ['MANUAL', null], default: null },
    // The ABA/FBA authorization the delivering clinician associated the worked
    // session with at completion (BCBA panel spec §11). Additive + nullable so
    // every existing session stays valid; set only through the BCBA workflow.
    selectedAuthorizationId: { type: String, default: null },
    // MULTI-AUTHORIZATION (spec §22–§25). A session may be finalized against
    // several eligible authorizations; the primary is selectedAuthorizationId
    // (kept for legacy readers) and equals selectedAuthorizationIds[0]. Each
    // selected authorization carries ITS OWN memo, sealed as PHI exactly like
    // the narrative — never collapsed into one generic note (spec §23). Additive
    // and default-empty so every historical session stays valid and readable.
    selectedAuthorizationIds: { type: [String], default: [] },
    authorizationMemos: [{
      _id: false,
      authorizationId: { type: String, required: true },
      memo: { type: String, default: null }, // sealed PHI (opaque ciphertext)
    }],
    sensitive: { narrative: { type: String, default: null } }, // sealed PHI
    // IN-SESSION DOCUMENTATION (spec §1–§8). What the delivering clinician
    // actually did THIS session, captured live while the session runs — kept
    // entirely separate from the treatment plan (what the BCBA prescribed) and
    // from the per-authorization completion memos. Each field is sealed PHI,
    // additive and default-null so every historical session stays valid. Saving
    // these NEVER touches clock-in/out, workedMinutes, or status.
    documentation: {
      what: { type: String, default: null },         // "What did you work on today?"
      how: { type: String, default: null },          // "How did you implement it?"
      childResponse: { type: String, default: null }, // "Child response / observations"
    },
    frozenAt: { type: Date, default: null },
    frozenBy: { type: String, default: null },

    // --- Clock (§6.6 "Clock in / clock out", one action each) --------------
    // Captured AT THE EVENT, never tracked continuously — see the design ruling
    // "Event-based location, never continuous tracking" (§6.6). Two points, at
    // coarse precision, disclosed and consented to; nothing in between.
    clockInAt: { type: Date, default: null },
    clockOutAt: { type: Date, default: null },
    clockInBy: { type: String, default: null },   // staffProfileId
    clockOutBy: { type: String, default: null },

    // --- Verification record (§6.6, the six EVV elements) -----------------
    // "Service type, recipient, provider, date, location and start and end
    // times captured live and immutably — the six elements electronic visit
    // verification requires." Stored as a sub-document so completeness can be
    // evaluated as one unit and held against the claim (BR-BL-5).
    verification: {
      serviceType: { type: String, default: null },   // 1 · service type
      recipientClientId: { type: String, default: null }, // 2 · recipient
      providerStaffProfileId: { type: String, default: null }, // 3 · provider
      serviceDate: { type: Date, default: null },     // 4 · date
      // 5 · location, captured at the two clock events only, coarse precision
      clockInLocation: {
        latitude: { type: Number, default: null },
        longitude: { type: Number, default: null },
        accuracyMetres: { type: Number, default: null },
        capturedAt: { type: Date, default: null },
      },
      clockOutLocation: {
        latitude: { type: Number, default: null },
        longitude: { type: Number, default: null },
        accuracyMetres: { type: Number, default: null },
        capturedAt: { type: Date, default: null },
      },
      // 6 · start and end times mirror the clock events, held here so the
      // verification record is self-contained when handed to an aggregator.
      startTime: { type: Date, default: null },
      endTime: { type: Date, default: null },
      complete: { type: Boolean, default: false },
    },

    // --- Signatures (§6.6, "binding to the session record") ---------------
    // Guardian and technician signatures, plus refusal capture with reason —
    // "Guardian refuses to sign: refusal is recorded with reason; the session
    // proceeds to review flagged" (§9.4 edge cases).
    signatures: [{
      _id: false,
      role: { type: String, enum: ['GUARDIAN', 'TECHNICIAN'], required: true },
      signerName: { type: String, default: null },
      signerUserId: { type: String, default: null },
      signerGuardianId: { type: String, default: null },
      signedAt: { type: Date, default: null },
      // Bound cryptographically to the session record: a hash over the session
      // id, signer, timestamp and captured payload. Rebinding after any change
      // fails, which is what makes "signed sessions cannot be silently
      // modified" enforceable rather than aspirational.
      bindingHash: { type: String, default: null },
      refused: { type: Boolean, default: false },
      refusalReason: { type: String, default: null },
    }],

    // --- Review outcome (§9.4 step 5, "approve, or return with a comment") --
    returnedAt: { type: Date, default: null },
    returnedBy: { type: String, default: null },
    returnComment: { type: String, default: null },

    // --- Cancellation (§6.4 structured reason taxonomy) -------------------
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: null },
    cancellationReason: { type: String, default: null },
    cancellationNote: { type: String, default: null },

    // --- Amendment (§6.6, "the original is never overwritten") ------------
    // An amendment is a NEW session row carrying amendsSessionId; the original
    // moves to AMENDED and keeps every field it had. supersededBySessionId
    // makes the chain navigable in both directions.
    amendsSessionId: { type: String, default: null },
    supersededBySessionId: { type: String, default: null },
    amendmentReason: { type: String, default: null },
    amendedAt: { type: Date, default: null },
    amendedBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'session' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
// At most one OPEN (active) session per appointment+clinician; completed
// sessions are set active:false and no longer occupy the slot, so a clinician
// can record MULTIPLE independent sessions for the same appointment on the same
// day (spec Phase 2 §4). Soft-deleted rows are also excluded. A BCBA and an RBT
// on the same appointment still own separate, independent sessions (§2).
schema.index(
  { tenantId: 1, appointmentId: 1, staffProfileId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null, active: true } },
);
// Manual entry duplicate protection at the DATABASE level: one live session per
// deterministic manual key, so two concurrent identical requests can't both win.
schema.index(
  { tenantId: 1, generationKey: 1 },
  { unique: true, partialFilterExpression: { generationKey: { $type: 'string' }, deletedAt: null } },
);
schema.index({ tenantId: 1, clientId: 1, startedAt: 1 });
schema.index({ tenantId: 1, staffProfileId: 1, startedAt: 1 });
schema.index({ tenantId: 1, status: 1, startedAt: 1 });
// Company dashboard "Latest sessions": the tenant's newest sessions by start.
schema.index({ tenantId: 1, startedAt: -1 });
// Amendment chain lookups, and the review queue's "returned to me" filter.
schema.index({ tenantId: 1, amendsSessionId: 1 });

export const Session = mongoose.model('Session', schema);
