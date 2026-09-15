import mongoose from 'mongoose';
import { Appointment, SessionTimeRecord } from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';

/**
 * Persistence for the BCBA session workflow that is NOT already served by an
 * existing repository:
 *   - the BCBA's own appointments (bcbaId query, tenant-scoped);
 *   - the per-session payroll/time records (SessionTimeRecord), with the
 *     duplicate-key swallow that makes finalization idempotent (spec §16).
 *
 * Session create/find/update/freeze reuse the platform's sessions repository —
 * this module does not re-implement the session lifecycle.
 */
export class BcbaSessionRepository {
  // --- appointments --------------------------------------------------------

  /** Appointments assigned to this BCBA, tenant-scoped, soonest first. */
  async listForBcba(tenantId, bcbaStaffProfileId, { from = null, to = null, limit = 200 } = {}) {
    return withTenant(tenantId, async () => {
      const filter = { bcbaId: bcbaStaffProfileId, deletedAt: null };
      if (from || to) {
        filter.startAt = {};
        if (from) filter.startAt.$gte = new Date(from);
        if (to) filter.startAt.$lte = new Date(to);
      }
      const rows = await Appointment.find(filter).sort({ startAt: 1, _id: -1 }).limit(limit).lean();
      return rows.map(toAppointment);
    });
  }

  /**
   * Appointments assigned to one RBT (the technician panel). Mirrors
   * listForBcba exactly but filters on rbtId — the appointment's assigned
   * technician — so the same panel/start/stop/complete pipeline serves the RBT
   * with the RBT's own assignments. Tenant-scoped via withTenant; the caller's
   * staffProfileId is the token's, never the query's.
   */
  async listForRbt(tenantId, rbtStaffProfileId, { from = null, to = null, limit = 200 } = {}) {
    return withTenant(tenantId, async () => {
      const filter = { rbtId: rbtStaffProfileId, deletedAt: null };
      if (from || to) {
        filter.startAt = {};
        if (from) filter.startAt.$gte = new Date(from);
        if (to) filter.startAt.$lte = new Date(to);
      }
      const rows = await Appointment.find(filter).sort({ startAt: 1, _id: -1 }).limit(limit).lean();
      return rows.map(toAppointment);
    });
  }

  async findAppointmentById(tenantId, appointmentId) {
    return withTenant(tenantId, async () => {
      const doc = await Appointment.findOne({ _id: appointmentId, deletedAt: null }).lean();
      return doc ? toAppointment(doc) : null;
    });
  }

  // --- session time records (payroll receipts) -----------------------------

  /** Time records for many sessions in ONE query (list views), keyed by the caller. */
  async findBySessions(tenantId, sessionIds) {
    if (!sessionIds?.length) return [];
    return withTenant(tenantId, async () => {
      const docs = await SessionTimeRecord.find({ sessionId: { $in: sessionIds }, deletedAt: null }).lean();
      return docs.map((d) => ({ ...toTimeRecord(d), sessionId: d.sessionId }));
    });
  }

  async findBySession(tenantId, sessionId) {
    return withTenant(tenantId, async () => {
      const doc = await SessionTimeRecord.findOne({ sessionId, deletedAt: null }).lean();
      return doc ? toTimeRecord(doc) : null;
    });
  }

  /**
   * Create the record, or return the existing one on a duplicate-key race. The
   * unique index (tenant, sessionId) is the real idempotency guarantee (§16);
   * this swallow turns the race into the same friendly outcome as the
   * check-then-create path in the service.
   */
  async create(tenantId, doc) {
    return withTenant(tenantId, async () => {
      try {
        const created = await SessionTimeRecord.create(doc);
        return toTimeRecord(created.toObject());
      } catch (err) {
        if (err && err.code === 11000) {
          const existing = await SessionTimeRecord.findOne({ sessionId: doc.sessionId, deletedAt: null }).lean();
          if (existing) return toTimeRecord(existing);
        }
        throw err;
      }
    });
  }

  /**
   * Total worked minutes for a staff member whose sessions STARTED within a
   * half-open [from, to) window, tenant-scoped. Sums the authoritative
   * SessionTimeRecord.workedMinutes (§L) with a Mongo aggregate so it is not
   * capped by a page size — a full week of sessions always totals correctly.
   */
  async sumWorkedMinutes(tenantId, { staffProfileId, from, to }) {
    return withTenant(tenantId, async () => {
      const match = { deletedAt: null };
      if (staffProfileId) match.staffProfileId = staffProfileId;
      match.startedAt = {};
      if (from) match.startedAt.$gte = new Date(from);
      if (to) match.startedAt.$lt = new Date(to);
      const rows = await SessionTimeRecord.aggregate([
        { $match: match },
        { $group: { _id: null, minutes: { $sum: '$workedMinutes' }, sessions: { $sum: 1 } } },
      ]);
      return { minutes: rows[0]?.minutes ?? 0, sessions: rows[0]?.sessions ?? 0 };
    });
  }

  /**
   * EXACT worked seconds for a staff member whose sessions STARTED within a
   * half-open [from, to) window, tenant-scoped. Unlike sumWorkedMinutes (which
   * sums the rounded workedMinutes), this computes elapsed time straight from
   * the authoritative second-level timestamps (endedAt - startedAt), so the
   * "My Hours" card can show accurate seconds (spec Change 4). $subtract on two
   * BSON dates yields the difference in milliseconds; we sum ms and round to
   * whole seconds once, at the end.
   */
  async sumWorkedSeconds(tenantId, { staffProfileId, from, to }) {
    return withTenant(tenantId, async () => {
      const match = { deletedAt: null, startedAt: {}, endedAt: { $ne: null } };
      if (staffProfileId) match.staffProfileId = staffProfileId;
      if (from) match.startedAt.$gte = new Date(from);
      if (to) match.startedAt.$lt = new Date(to);
      const rows = await SessionTimeRecord.aggregate([
        { $match: match },
        { $group: {
          _id: null,
          ms: { $sum: { $subtract: ['$endedAt', '$startedAt'] } },
          minutes: { $sum: '$workedMinutes' },
          sessions: { $sum: 1 },
        } },
      ]);
      const ms = rows[0]?.ms ?? 0;
      return {
        seconds: Math.max(0, Math.round(ms / 1000)),
        minutes: rows[0]?.minutes ?? 0,
        sessions: rows[0]?.sessions ?? 0,
      };
    });
  }

  async list(tenantId, { staffProfileId = null, from = null, to = null, limit = 100 } = {}) {
    return withTenant(tenantId, async () => {
      const filter = { deletedAt: null };
      if (staffProfileId) filter.staffProfileId = staffProfileId;
      if (from || to) {
        filter.startedAt = {};
        if (from) filter.startedAt.$gte = new Date(from);
        if (to) filter.startedAt.$lte = new Date(to);
      }
      const rows = await SessionTimeRecord.find(filter).sort({ startedAt: -1, _id: -1 }).limit(limit).lean();
      return rows.map(toTimeRecord);
    });
  }
}

function toAppointment(doc) {
  return {
    id: doc._id,
    clientId: doc.clientId,
    staffProfileId: doc.staffProfileId,
    bcbaId: doc.bcbaId ?? null,
    rbtId: doc.rbtId ?? null,
    authorizationId: doc.authorizationId,
    authorizationIds: doc.authorizationIds?.length ? doc.authorizationIds : [],
    startAt: doc.startAt,
    endAt: doc.endAt,
    timeSet: doc.timeSet ?? true,
    units: doc.units,
    status: doc.status,
  };
}

function toTimeRecord(doc) {
  return {
    id: doc._id,
    staffProfileId: doc.staffProfileId,
    clientId: doc.clientId,
    sessionId: doc.sessionId,
    appointmentId: doc.appointmentId,
    authorizationId: doc.authorizationId ?? null,
    authorizationIds: doc.authorizationIds ?? [],
    startedAt: doc.startedAt,
    endedAt: doc.endedAt,
    workedMinutes: doc.workedMinutes,
    hourlyRateSnapshot: doc.hourlyRateSnapshot ?? null,
    currency: doc.currency ?? 'usd',
    amount: doc.amount ?? null,
    memoCaptured: !!doc.memoCaptured,
    createdAt: doc.createdAt,
  };
}

export const bcbaSessionRepository = new BcbaSessionRepository();
export { mongoose };
