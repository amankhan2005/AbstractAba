import mongoose from 'mongoose';
import {
  Session, SessionDataPoint, SessionTimeRecord, Appointment, StaffProfile, Client,
} from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';
import { supportsTransactions } from '../../config/db.js';
import { sessionsError } from './sessions.errors.js';
import { scopeSessionsFilter } from '../rbac/scopeFilters.js';

/**
 * Persistence for the session-capture module (session + its data points). Every
 * tenant-owned operation runs under withTenant(); the tenant plugin stamps and
 * scopes it and fails closed without a context.
 *
 * The stored narrative (session.sensitive.narrative) is opaque ciphertext to
 * this layer: the service seals before writing and opens after reading. The
 * repository never seals, opens, projects (into lists), or logs it.
 *
 * Freeze is a status transition, not a delete: a frozen session and its data
 * points stay readable; immutability is enforced by the service. The one-live-
 * session-per-appointment rule is backed by a partial-unique index; a concurrent
 * create surfaces as SESSION_EXISTS (409).
 */
export class SessionsRepository {
  // --- sessions ------------------------------------------------------------

  async createSession(tenantId, doc) {
    return withTenant(tenantId, async () => {
      try {
        const created = await Session.create(doc);
        return toSession(created.toObject());
      } catch (err) {
        if (isDuplicateKey(err)) throw sessionsError('SESSION_EXISTS');
        throw err;
      }
    });
  }

  async findSessionById(tenantId, sessionId) {
    return withTenant(tenantId, async () => {
      const doc = await Session.findOne({ _id: sessionId, deletedAt: null }).lean();
      return doc ? toSession(doc) : null;
    });
  }

  async findSessionByAppointment(tenantId, appointmentId) {
    return withTenant(tenantId, async () => {
      const doc = await Session.findOne({ appointmentId, deletedAt: null }).lean();
      return doc ? toSession(doc) : null;
    });
  }

  /**
   * The session OWNED BY A SPECIFIC CLINICIAN for an appointment. A BCBA+RBT
   * appointment has two sessions (one per clinician); resolving by appointment
   * alone would collide them, so clinician-scoped lookups MUST use this (spec
   * §2/§8/§9A). Returns null when this clinician has no session yet.
   */
  async findSessionByGenerationKey(tenantId, generationKey) {
    return withTenant(tenantId, async () => {
      if (!generationKey) return null;
      const doc = await Session.findOne({ generationKey, deletedAt: null }).lean();
      return doc ? toSession(doc) : null;
    });
  }
  /**
   * The most recently FINALIZED session for this appointment+clinician (any
   * inactive state: FROZEN, AMENDED or CANCELLED).
   *
   * This exists because findSessionByAppointmentAndStaff below deliberately
   * returns only the OPEN session, which made the completion flow's idempotency
   * guard unreachable: once a session was completed it became active:false, so
   * a repeated Complete (a double-click, a retried request) could not find it
   * and returned "We couldn't find that session" (404) instead of resolving to
   * the work already recorded. Callers use this ONLY as an idempotency
   * fallback — starting a new session still ignores finalized ones, so a
   * genuinely separate later visit is still its own session.
   */
  async findLatestFinalizedByAppointmentAndStaff(tenantId, appointmentId, staffProfileId) {
    return withTenant(tenantId, async () => {
      const doc = await Session.findOne({ appointmentId, staffProfileId, deletedAt: null, active: false })
        .sort({ frozenAt: -1, updatedAt: -1, startedAt: -1 })
        .lean();
      return doc ? toSession(doc) : null;
    });
  }

  async findSessionByAppointmentAndStaff(tenantId, appointmentId, staffProfileId) {
    return withTenant(tenantId, async () => {
      // The OPEN (resumable) session for this appointment+clinician, if any.
      // Completed/amended/cancelled sessions are active:false, so a new Start
      // does not resolve to them — it creates a fresh same-day session (§4/§5).
      const doc = await Session.findOne({ appointmentId, staffProfileId, deletedAt: null, active: true }).lean();
      return doc ? toSession(doc) : null;
    });
  }

  /**
   * Session-oversight child summaries (spec §4). Batched, tenant-scoped, no
   * N+1: one Session scan (scoped), one SessionTimeRecord fetch for worked
   * minutes, and batched Appointment/StaffProfile/Client lookups. Returns raw
   * docs for the pure aggregator to shape.
   */
  async oversightChildren(tenantId, dataScope) {
    // Same scoped, batched load as Session Insights, without filters.
    return this.oversightInsights(tenantId, dataScope);
  }

  /**
   * Records for Session Insights: the same scoped, batched load as
   * oversightChildren, with optional filters (org-timezone date window as
   * instants, client, clinician, status) and the time-record clock fields.
   */
  async oversightInsights(tenantId, dataScope, { from = null, to = null, clientId, staffProfileId, status } = {}) {
    return withTenant(tenantId, async () => {
      const filter = { deletedAt: null };
      if (dataScope) scopeSessionsFilter(filter, dataScope);
      if (clientId) filter.clientId = clientId;
      if (staffProfileId) filter.staffProfileId = staffProfileId;
      if (status) filter.status = status;
      if (from || to) {
        filter.startedAt = {};
        if (from) filter.startedAt.$gte = from;
        if (to) filter.startedAt.$lt = to;
      }
      const sessions = await Session.find(filter)
        .select({ _id: 1, clientId: 1, staffProfileId: 1, appointmentId: 1, startedAt: 1, endedAt: 1, status: 1, source: 1 })
        .lean();
      const sessionIds = sessions.map((s) => s._id);
      const apptIds = [...new Set(sessions.map((s) => s.appointmentId).filter(Boolean))];
      const staffIds = [...new Set(sessions.map((s) => s.staffProfileId).filter(Boolean))];
      const clientIds = [...new Set(sessions.map((s) => s.clientId).filter(Boolean))];
      const [timeRecs, appts, staff, clients] = await Promise.all([
        sessionIds.length ? SessionTimeRecord.find({ sessionId: { $in: sessionIds } }).select({ sessionId: 1, workedMinutes: 1, startedAt: 1, endedAt: 1 }).lean() : [],
        apptIds.length ? Appointment.find({ _id: { $in: apptIds } }).select({ bcbaId: 1, rbtId: 1 }).lean() : [],
        staffIds.length ? StaffProfile.find({ _id: { $in: staffIds } }).select({ firstName: 1, lastName: 1 }).lean() : [],
        clientIds.length ? Client.find({ _id: { $in: clientIds } }).select({ firstName: 1, lastName: 1, preferredName: 1, clientNumber: 1 }).lean() : [],
      ]);
      return { sessions, timeRecs, appts, staff, clients };
    });
  }

  async listSessions(tenantId, query) {
    return withTenant(tenantId, async () => {
      const filter = { deletedAt: null };
      if (query.clientId) filter.clientId = query.clientId;
      if (query.staffProfileId) filter.staffProfileId = query.staffProfileId;
      // Data scope, applied at the QUERY, not in the response mapper. A
      // technician sees sessions they delivered; a BCBA additionally sees
      // sessions for clients on their caseload.
      if (query.dataScope) scopeSessionsFilter(filter, query.dataScope);
      if (query.appointmentId) filter.appointmentId = query.appointmentId;
      if (query.status) filter.status = query.status;
      if (query.cursor) filter._id = { $lt: query.cursor };
      const limit = query.limit ?? 25;
      const rows = await Session.find(filter)
        .select({ sensitive: 0 }) // never project the sealed narrative into a list
        .sort({ _id: -1 })
        .limit(limit + 1)
        .lean();
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return { items: page.map(toSessionSummary), nextCursor: hasMore ? page[page.length - 1]._id : null };
    });
  }

  /**
   * Optimistic-concurrency update. `expectedVersion` is optional: the
   * lifecycle transitions (clock in/out, return, cancel) are guarded by their
   * own state preconditions in the service and are not user-authored edits, so
   * they carry no If-Match. A caller that DOES supply a version still gets the
   * conflict check — omitting it must not silently weaken it for edits.
   */
  async updateSession(tenantId, sessionId, patch, expectedVersion) {
    return withTenant(tenantId, async () => {
      const guard = { _id: sessionId, deletedAt: null };
      if (expectedVersion !== undefined && expectedVersion !== null) guard.version = expectedVersion;
      const updated = await Session.findOneAndUpdate(
        guard,
        { $set: patch, $inc: { version: 1 } },
        { new: true },
      ).lean();
      if (updated) return toSession(updated);
      const exists = await Session.exists({ _id: sessionId, deletedAt: null });
      throw sessionsError(exists ? 'VERSION_CONFLICT' : 'SESSION_NOT_FOUND');
    });
  }

  async freezeSession(tenantId, sessionId, actorUserId) {
    return withTenant(tenantId, async () => {
      const now = new Date();
      const updated = await Session.findOneAndUpdate(
        { _id: sessionId, deletedAt: null, status: { $ne: 'FROZEN' } },
        // Freeze = COMPLETED. Clear the open-slot flag so the clinician can start
        // another independent session for the same appointment/day (§4/§5).
        { $set: { status: 'FROZEN', active: false, frozenAt: now, frozenBy: actorUserId, updatedBy: actorUserId }, $inc: { version: 1 } },
        { new: true },
      ).lean();
      if (updated) return toSession(updated);
      const exists = await Session.exists({ _id: sessionId, deletedAt: null });
      // Already frozen (or gone): the service re-reads and raises the precise error.
      throw sessionsError(exists ? 'INVALID_STATUS_TRANSITION' : 'SESSION_NOT_FOUND');
    });
  }

  /**
   * Appends a signature. $push rather than a read-modify-write, so two devices
   * capturing guardian and technician signatures concurrently cannot lose one.
   */
  async appendSignature(tenantId, sessionId, signature, actorUserId) {
    return withTenant(tenantId, async () => {
      const updated = await Session.findOneAndUpdate(
        { _id: sessionId, deletedAt: null, status: { $in: ['DRAFT', 'IN_PROGRESS', 'RETURNED'] } },
        { $push: { signatures: signature }, $set: { updatedBy: actorUserId }, $inc: { version: 1 } },
        { new: true },
      ).lean();
      if (updated) return toSession(updated);
      const exists = await Session.exists({ _id: sessionId, deletedAt: null });
      throw sessionsError(exists ? 'SESSION_FROZEN' : 'SESSION_NOT_FOUND');
    });
  }

  /**
   * Creates an amendment: a NEW session row carrying the corrected values and
   * pointing back at the original, while the original moves to AMENDED and
   * keeps every field it had.
   *
   * The original is updated FIRST and guarded on `status: 'FROZEN'`, so two
   * concurrent amendment requests cannot both succeed and leave two rows
   * claiming to supersede one record.
   */
  async createAmendment(tenantId, { original, changes, reason, actorUserId }) {
    return withTenant(tenantId, async () => {
      const now = new Date();
      const claimed = await Session.findOneAndUpdate(
        { _id: original._id ?? original.id, deletedAt: null, status: 'FROZEN' },
        { $set: { status: 'AMENDED', amendedAt: now, amendedBy: actorUserId, updatedBy: actorUserId }, $inc: { version: 1 } },
        { new: true },
      ).lean();
      if (!claimed) throw sessionsError('AMENDMENT_INVALID');

      const [amendment] = await Session.create([{
        appointmentId: original.appointmentId,
        clientId: original.clientId,
        staffProfileId: original.staffProfileId,
        treatmentPlanId: original.treatmentPlanId,
        startedAt: changes.startedAt ? new Date(changes.startedAt) : original.startedAt,
        endedAt: changes.endedAt ? new Date(changes.endedAt) : original.endedAt,
        // An amendment lands already approved: it is a correction to a fact that
        // has been reviewed, authored by someone who held approval authority.
        status: 'FROZEN',
        frozenAt: now,
        frozenBy: actorUserId,
        clockInAt: original.clockInAt,
        clockOutAt: original.clockOutAt,
        verification: original.verification,
        signatures: original.signatures,
        amendsSessionId: claimed._id,
        amendmentReason: reason,
        amendedAt: now,
        amendedBy: actorUserId,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      }]);

      // Make the chain navigable forwards as well as backwards.
      await Session.updateOne({ _id: claimed._id }, { $set: { supersededBySessionId: amendment._id } });
      return toSession(amendment.toObject ? amendment.toObject() : amendment);
    });
  }

  // --- data points ---------------------------------------------------------

  async listDataPoints(tenantId, sessionId) {
    return withTenant(tenantId, async () => {
      const rows = await SessionDataPoint.find({ sessionId, deletedAt: null }).sort({ _id: 1 }).lean();
      return rows.map(toDataPoint);
    });
  }

  async findDataPoint(tenantId, sessionId, dataPointId) {
    return withTenant(tenantId, async () => {
      const doc = await SessionDataPoint.findOne({ _id: dataPointId, sessionId, deletedAt: null }).lean();
      return doc ? toDataPoint(doc) : null;
    });
  }

  async addDataPoint(tenantId, sessionId, input) {
    return withTenant(tenantId, async () => {
      const doc = await SessionDataPoint.create({ ...input, sessionId });
      return toDataPoint(doc.toObject());
    });
  }

  async updateDataPoint(tenantId, sessionId, dataPointId, patch, expectedVersion) {
    return withTenant(tenantId, async () => {
      const query = { _id: dataPointId, sessionId, deletedAt: null };
      if (expectedVersion !== undefined) query.version = expectedVersion;
      const updated = await SessionDataPoint.findOneAndUpdate(query, { $set: patch, $inc: { version: 1 } }, { new: true }).lean();
      if (updated) return toDataPoint(updated);
      const exists = await SessionDataPoint.exists({ _id: dataPointId, sessionId, deletedAt: null });
      throw sessionsError(exists ? 'VERSION_CONFLICT' : 'DATA_POINT_NOT_FOUND');
    });
  }

  async removeDataPoint(tenantId, sessionId, dataPointId, actorUserId) {
    return withTenant(tenantId, async () => {
      const res = await SessionDataPoint.findOneAndUpdate(
        { _id: dataPointId, sessionId, deletedAt: null },
        { $set: { deletedAt: new Date(), deletedBy: actorUserId } },
        { new: true },
      ).lean();
      if (!res) throw sessionsError('DATA_POINT_NOT_FOUND');
      return { dataPointId, removed: true };
    });
  }

  async _maybeTx(fn) {
    if (!supportsTransactions()) return fn(null);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => { await fn(session); });
    } finally {
      await session.endSession();
    }
  }
}

// --- mappers ---------------------------------------------------------------

/** Full session including the still-sealed narrative envelope (the service opens it). */
function toSession(doc) {
  return {
    id: doc._id,
    appointmentId: doc.appointmentId,
    clientId: doc.clientId,
    staffProfileId: doc.staffProfileId,
    treatmentPlanId: doc.treatmentPlanId,
    startedAt: doc.startedAt,
    endedAt: doc.endedAt ?? null,
    // TIMING INTERVALS (onboarding §10/§30). The individual Start/Stop periods
    // of this ONE logical session. Projected through because worked time is
    // their SUM and the session detail shows the full history. Empty for
    // sessions recorded before intervals existed — those fall back to
    // startedAt→endedAt, so historical data stays readable and unchanged.
    intervals: Array.isArray(doc.intervals)
      ? doc.intervals.map((iv) => ({
        startedAt: iv.startedAt ?? null,
        endedAt: iv.endedAt ?? null,
        startedBy: iv.startedBy ?? null,
        endedBy: iv.endedBy ?? null,
      }))
      : [],
    status: doc.status,
    active: doc.active !== false,
    // 'MANUAL' for manual time entry, null for the live Start/Stop workflow.
    source: doc.source ?? null,
    selectedAuthorizationId: doc.selectedAuthorizationId ?? null,
    // Multi-authorization completion (spec §22/§23): the selected set + each
    // authorization's own sealed memo. Additive and default-empty for legacy rows.
    selectedAuthorizationIds: Array.isArray(doc.selectedAuthorizationIds) ? doc.selectedAuthorizationIds : [],
    authorizationMemos: Array.isArray(doc.authorizationMemos)
      ? doc.authorizationMemos.map((m) => ({ authorizationId: m.authorizationId, memo: m.memo ?? null }))
      : [],
    // Clock events are persisted on the session (the delivering staff's
    // clock-in/out). They were previously dropped from the projection, which is
    // why the Session Detail showed "Clocked in / — / Clocked out / —" even
    // when the values existed. Map them through so the detail can render them.
    clockInAt: doc.clockInAt ?? null,
    clockOutAt: doc.clockOutAt ?? null,
    sensitive: { narrative: doc.sensitive ? (doc.sensitive.narrative ?? null) : null },
    // In-session documentation envelope — still sealed here; the service opens
    // it (spec §1/§8/§11). Additive/default-null for legacy rows.
    documentation: {
      what: doc.documentation?.what ?? null,
      how: doc.documentation?.how ?? null,
      childResponse: doc.documentation?.childResponse ?? null,
    },
    frozenAt: doc.frozenAt ?? null,
    frozenBy: doc.frozenBy ?? null,
    returnComment: doc.returnComment ?? null,
    createdAt: doc.createdAt,
    version: doc.version,
  };
}

/** List row: no sealed envelope ever leaves the repository in a list. */
function toSessionSummary(doc) {
  return {
    id: doc._id,
    appointmentId: doc.appointmentId,
    clientId: doc.clientId,
    staffProfileId: doc.staffProfileId,
    treatmentPlanId: doc.treatmentPlanId,
    startedAt: doc.startedAt,
    endedAt: doc.endedAt ?? null,
    status: doc.status,
    active: doc.active !== false,
    source: doc.source ?? null,
    selectedAuthorizationId: doc.selectedAuthorizationId ?? null,
    // Sealed in-session documentation — the service opens it for the oversight
    // read (spec §8). Additive/default-null for legacy rows.
    documentation: {
      what: doc.documentation?.what ?? null,
      how: doc.documentation?.how ?? null,
      childResponse: doc.documentation?.childResponse ?? null,
    },
    frozenAt: doc.frozenAt ?? null,
    version: doc.version,
  };
}

function toDataPoint(doc) {
  return {
    id: doc._id,
    sessionId: doc.sessionId,
    targetId: doc.targetId,
    programId: doc.programId ?? null,
    treatmentPlanId: doc.treatmentPlanId,
    measurementType: doc.measurementType,
    value: doc.value ?? null,
    numerator: doc.numerator ?? null,
    denominator: doc.denominator ?? null,
    version: doc.version,
  };
}

function isDuplicateKey(err) {
  return err && (err.code === 11000 || err.code === 11001);
}

export const sessionsRepository = new SessionsRepository();
