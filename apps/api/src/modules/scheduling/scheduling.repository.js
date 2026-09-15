import mongoose from 'mongoose';
import { Appointment, Availability, Authorization, AppointmentSeries, ServiceAuthorization, Client, StaffProfile } from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';
import { supportsTransactions } from '../../config/db.js';
import { schedulingError } from './scheduling.errors.js';
import { scopeToAssignedClinician } from '../rbac/scopeFilters.js';
import { isServiceAuthId, serviceAuthIdOf, serviceAuthToBookable } from './authAdapter.js';

/**
 * Commit-time budget for a scheduling write transaction (ms). A booking must
 * either persist or fail fast — never hold the request open. Bounds both the
 * commit (maxCommitTimeMS) and the majority write concern's wtimeout so a stalled
 * cluster surfaces a retryable error in seconds rather than an endless spinner.
 */
const TX_COMMIT_TIMEOUT_MS = 10_000;

/**
 * Persistence for the scheduling module. Every tenant-owned operation runs under
 * withTenant(); the tenant plugin stamps and scopes it and fails closed without
 * a context. Booking and cancellation adjust the authorization's unit burn-down
 * atomically with the appointment write (a transaction on a replica set, a safe
 * sequence otherwise — the same _maybeTx pattern as the other modules).
 */
export class SchedulingRepository {
  // --- appointments --------------------------------------------------------

  /** Overlapping SCHEDULED appointments for the staff member or client in [startAt,endAt). */
  async findOverlaps(tenantId, { staffProfileId, clientId, startAt, endAt, excludeId }) {
    return withTenant(tenantId, async () => {
      const filter = {
        deletedAt: null,
        status: 'SCHEDULED',
        startAt: { $lt: endAt },
        endAt: { $gt: startAt },
        $or: [{ staffProfileId }, { clientId }],
      };
      if (excludeId) filter._id = { $ne: excludeId };
      const rows = await Appointment.find(filter).limit(1).lean();
      return rows.map(toAppointment);
    });
  }

  /**
   * Create the appointment and burn down the authorization's used units in one
   * unit of work. Sets the authorization to EXHAUSTED when it reaches its cap.
   */
  async createAppointment(tenantId, doc) {
    return withTenant(tenantId, async () => {
      let created;
      await this._maybeTx(async (session) => {
        const opt = session ? { session } : {};
        const [appt] = await Appointment.create([doc], opt);
        created = appt;
        await this._applyUnitDelta(doc.authorizationId, doc.units, opt);
      });
      return toAppointment(created.toObject ? created.toObject() : created);
    });
  }

  /**
   * NEW SIMPLE BOOKING WRITE (rebuild).
   *
   * The core create is one deterministic insert — no multi-document
   * transaction, no session, no lock, no availability/overlap/aggregation query
   * — which is exactly what removes the "endless spinner" failure mode: the
   * request reaches a terminal state (the row exists) in a single bounded round
   * trip. Authorization unit burn-down is applied afterwards as a bounded,
   * best-effort single update against the PRIMARY authorization; the appointment
   * is the source of truth, so a burn-down hiccup can never turn a real,
   * persisted booking into a fake failure or hang the request.
   */
  async createAppointmentSimple(tenantId, doc) {
    return withTenant(tenantId, async () => {
      const created = await Appointment.create(doc);
      if (doc.authorizationId && doc.units) {
        try {
          await this._applyUnitDelta(doc.authorizationId, doc.units, {});
        } catch {
          // Utilization is secondary bookkeeping and reconcilable; never let it
          // fail or delay a booking that already persisted.
        }
      }
      return toAppointment(created.toObject ? created.toObject() : created);
    });
  }

  /** Many appointments by id in ONE query (list views). */
  async findAppointmentsByIds(tenantId, appointmentIds) {
    if (!appointmentIds?.length) return [];
    return withTenant(tenantId, async () => {
      const docs = await Appointment.find({ _id: { $in: appointmentIds }, deletedAt: null }).lean();
      return docs.map(toAppointment);
    });
  }

  async findAppointmentById(tenantId, appointmentId) {
    return withTenant(tenantId, async () => {
      const doc = await Appointment.findOne({ _id: appointmentId, deletedAt: null }).lean();
      return doc ? toAppointment(doc) : null;
    });
  }

  /** Display names (client, BCBA, RBT, legacy staff) for appointments, batched. */
  async withAppointmentNames(tenantId, items) {
    return withTenant(tenantId, async () => await attachAppointmentNames(items));
  }

  async listAppointments(tenantId, query) {
    return withTenant(tenantId, async () => {
      const filter = { deletedAt: null };
      if (query.status) filter.status = query.status;
      if (query.staffProfileId) filter.staffProfileId = query.staffProfileId;
      if (query.clientId) filter.clientId = query.clientId;
      // Calendars/appointment lists are scoped by clinician ASSIGNMENT: a
      // clinician sees only appointments where they are the assigned BCBA or RBT
      // (spec §6/§7) — never another clinician's schedule, never by caseload.
      // Tenant-wide roles (admin/scheduler) are not narrowed.
      if (query.dataScope) scopeToAssignedClinician(filter, query.dataScope);
      if (query.from || query.to) {
        filter.startAt = {};
        if (query.from) filter.startAt.$gte = new Date(query.from);
        if (query.to) filter.startAt.$lte = new Date(query.to);
      }
      // Keyset cursor over the SAME order the page is sorted by (startAt, _id).
      // The previous `_id < cursor` ignored the startAt sort, so page 2 could
      // repeat or skip appointments; a calendar loading a whole date range needs
      // stable pages. An unrecognised (legacy) cursor keeps the old behaviour.
      const keyset = decodeAppointmentCursor(query.cursor);
      if (keyset) {
        filter.$and = [{ $or: [{ startAt: { $gt: keyset.startAt } }, { startAt: keyset.startAt, _id: { $gt: keyset.id } }] }];
      } else if (query.cursor) {
        filter._id = { $lt: query.cursor };
      }
      const limit = query.limit ?? 25;
      const rows = await Appointment.find(filter).sort({ startAt: 1, _id: 1 }).limit(limit + 1).lean();
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const items = await attachAppointmentNames(page.map(toAppointment));
      return { items, nextCursor: hasMore ? encodeAppointmentCursor(page[page.length - 1]) : null };
    });
  }

  /**
   * Update an appointment under an optimistic version guard. When `unitDelta`
   * is non-zero the authorization burn-down is adjusted in the same unit of
   * work (used on reschedule when the unit count changes).
   */
  async updateAppointment(tenantId, appointmentId, patch, expectedVersion, { authorizationId, unitDelta } = {}) {
    return withTenant(tenantId, async () => {
      let updated;
      await this._maybeTx(async (session) => {
        const opt = session ? { session } : {};
        updated = await Appointment.findOneAndUpdate(
          { _id: appointmentId, deletedAt: null, version: expectedVersion },
          { $set: patch, $inc: { version: 1 } },
          { new: true, ...opt },
        ).lean();
        if (!updated) return;
        if (unitDelta && authorizationId) await this._applyUnitDelta(authorizationId, unitDelta, opt);
      });
      if (updated) return toAppointment(updated);
      const exists = await Appointment.exists({ _id: appointmentId, deletedAt: null });
      throw schedulingError(exists ? 'VERSION_CONFLICT' : 'APPOINTMENT_NOT_FOUND');
    });
  }

  /** Cancel an appointment and restore its units to the authorization. */
  async cancelAppointment(tenantId, appointmentId, actorUserId) {
    return withTenant(tenantId, async () => {
      const appt = await Appointment.findOne({ _id: appointmentId, deletedAt: null }).lean();
      if (!appt) throw schedulingError('APPOINTMENT_NOT_FOUND');
      if (appt.status === 'CANCELLED') return toAppointment(appt);
      let result;
      await this._maybeTx(async (session) => {
        const opt = session ? { session } : {};
        result = await Appointment.findOneAndUpdate(
          { _id: appointmentId, deletedAt: null },
          { $set: { status: 'CANCELLED', updatedBy: actorUserId } },
          { new: true, ...opt },
        ).lean();
        // Return units and re-open an EXHAUSTED authorization.
        await this._applyUnitDelta(appt.authorizationId, -appt.units, opt);
      });
      return toAppointment(result);
    });
  }

  async _applyUnitDelta(authorizationId, delta, opt) {
    if (!delta) return;
    if (isServiceAuthId(authorizationId)) {
      // Burn down against the ABA/FBA ServiceAuthorization. Its workflow status
      // (APPROVED) is NOT flipped to EXHAUSTED — remaining is derived from
      // units - usedUnits, and validateAuthorization enforces the ceiling.
      const id = serviceAuthIdOf(authorizationId);
      const svc = await ServiceAuthorization.findOne({ _id: id, deletedAt: null }, null, opt).lean();
      if (!svc) return;
      const used = Math.max(0, (svc.usedUnits ?? 0) + delta);
      await ServiceAuthorization.updateOne({ _id: id }, { $set: { usedUnits: used } }, opt);
      return;
    }
    const auth = await Authorization.findOne({ _id: authorizationId, deletedAt: null }, null, opt).lean();
    if (!auth) return;
    const used = Math.max(0, (auth.usedUnits ?? 0) + delta);
    const status = auth.status === 'REVOKED' || auth.status === 'EXPIRED'
      ? auth.status
      : used >= (auth.authorizedUnits ?? 0) ? 'EXHAUSTED' : 'ACTIVE';
    await Authorization.updateOne({ _id: authorizationId }, { $set: { usedUnits: used, status } }, opt);
  }

  // --- availability --------------------------------------------------------

  async listAvailability(tenantId, staffProfileId) {
    return withTenant(tenantId, async () => {
      const rows = await Availability.find({ staffProfileId, deletedAt: null }).sort({ dayOfWeek: 1, startMinute: 1 }).lean();
      return rows.map(toAvailability);
    });
  }

  /** Replace a staff member's availability set (hard-replace within the tenant). */
  async replaceAvailability(tenantId, staffProfileId, windows, actorUserId) {
    return withTenant(tenantId, async () => {
      await this._maybeTx(async (session) => {
        const opt = session ? { session } : {};
        await Availability.deleteMany({ staffProfileId }, opt);
        if (windows.length > 0) {
          await Availability.create(
            windows.map((w) => ({ ...w, staffProfileId, createdBy: actorUserId, updatedBy: actorUserId })),
            opt,
          );
        }
      });
      const rows = await Availability.find({ staffProfileId, deletedAt: null }).sort({ dayOfWeek: 1, startMinute: 1 }).lean();
      return rows.map(toAvailability);
    });
  }

  // --- authorizations ------------------------------------------------------

  async createAuthorization(tenantId, doc) {
    return withTenant(tenantId, async () => {
      const created = await Authorization.create(doc);
      return toAuthorization(created.toObject());
    });
  }

  async findAuthorizationById(tenantId, authorizationId) {
    return withTenant(tenantId, async () => {
      if (isServiceAuthId(authorizationId)) {
        const svc = await ServiceAuthorization.findOne({ _id: serviceAuthIdOf(authorizationId), deletedAt: null }).lean();
        return svc ? serviceAuthToBookable(svc) : null;
      }
      const doc = await Authorization.findOne({ _id: authorizationId, deletedAt: null }).lean();
      return doc ? toAuthorization(doc) : null;
    });
  }

  async listAuthorizations(tenantId, query) {
    return withTenant(tenantId, async () => {
      const filter = { deletedAt: null };
      if (query.status) filter.status = query.status;
      if (query.clientId) filter.clientId = query.clientId;
      if (query.cursor) filter._id = { $lt: query.cursor };
      const limit = query.limit ?? 25;
      const rows = await Authorization.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const items = page.map(toAuthorization);
      // When scoped to a child, also surface the Company's ABA/FBA
      // ServiceAuthorizations — the SAME records the Company created — from the
      // authoritative source, in EVERY workflow state (BUG #1 fix). Previously
      // this listed only APPROVED rows, so a just-created NOT_SENT/SENT
      // authorization was invisible to Scheduling and the UI reported
      // "No Authorization" even though the record existed on the child. We now
      // surface all non-archived rows and let serviceAuthToBookable carry the
      // state: a saved authorization maps to status 'ACTIVE' (usable) as soon as
      // it is added; only a DENIED one maps to 'DENIED'. validateAuthorization()
      // still enforces the status, the date window and the remaining units.
      // A caller that explicitly filters by status still receives only matching
      // rows (e.g. status=ACTIVE returns just the bookable ones).
      if (query.clientId) {
        const svcFilter = { clientId: query.clientId, deletedAt: null };
        const svcRows = await ServiceAuthorization.find(svcFilter)
          .sort({ serviceType: 1, createdAt: 1 })
          .lean();
        for (const s of svcRows) {
          const mapped = serviceAuthToBookable(s);
          if (!query.status || mapped.status === query.status) items.push(mapped);
        }
      }
      return { items, nextCursor: hasMore ? page[page.length - 1]._id : null };
    });
  }

  async updateAuthorization(tenantId, authorizationId, patch, expectedVersion) {
    return withTenant(tenantId, async () => {
      const updated = await Authorization.findOneAndUpdate(
        { _id: authorizationId, deletedAt: null, version: expectedVersion },
        { $set: patch, $inc: { version: 1 } },
        { new: true },
      ).lean();
      if (updated) return toAuthorization(updated);
      const exists = await Authorization.exists({ _id: authorizationId, deletedAt: null });
      throw schedulingError(exists ? 'VERSION_CONFLICT' : 'AUTHORIZATION_NOT_FOUND');
    });
  }

  // --- recurring series (Phase 4.3) ----------------------------------------

  async createSeries(tenantId, doc) {
    return withTenant(tenantId, async () => {
      const created = await AppointmentSeries.create(doc);
      return toSeries(created.toObject ? created.toObject() : created);
    });
  }

  async findSeriesById(tenantId, seriesId) {
    return withTenant(tenantId, async () => {
      const doc = await AppointmentSeries.findOne({ _id: seriesId, deletedAt: null }).lean();
      return doc ? toSeries(doc) : null;
    });
  }

  async listSeries(tenantId, query = {}) {
    return withTenant(tenantId, async () => {
      const filter = { deletedAt: null };
      if (query.status) filter.status = query.status;
      if (query.clientId) filter.clientId = query.clientId;
      if (query.staffProfileId) filter.staffProfileId = query.staffProfileId;
      const rows = await AppointmentSeries.find(filter).sort({ startDate: -1 }).limit(query.limit ?? 100).lean();
      return rows.map(toSeries);
    });
  }

  async setSeriesLastMaterialized(tenantId, seriesId, date) {
    return withTenant(tenantId, async () => {
      await AppointmentSeries.updateOne({ _id: seriesId, deletedAt: null }, { $set: { lastMaterializedDate: date } });
    });
  }

  async cancelSeries(tenantId, seriesId, actorUserId) {
    return withTenant(tenantId, async () => {
      const updated = await AppointmentSeries.findOneAndUpdate(
        { _id: seriesId, deletedAt: null },
        { $set: { status: 'CANCELLED', updatedBy: actorUserId } },
        { new: true },
      ).lean();
      if (!updated) throw schedulingError('SERIES_NOT_FOUND');
      return toSeries(updated);
    });
  }

  async listAppointmentsBySeries(tenantId, seriesId) {
    return withTenant(tenantId, async () => {
      const rows = await Appointment.find({ seriesId, deletedAt: null }).sort({ startAt: 1 }).lean();
      return rows.map(toAppointment);
    });
  }

  async listFutureScheduledBySeries(tenantId, seriesId, from) {
    return withTenant(tenantId, async () => {
      const rows = await Appointment.find({
        seriesId, deletedAt: null, status: 'SCHEDULED', startAt: { $gt: from },
      }).sort({ startAt: 1 }).lean();
      return rows.map(toAppointment);
    });
  }

  async _maybeTx(fn) {
    if (!supportsTransactions()) return fn(null);
    const session = await mongoose.startSession();
    try {
      // BUG #2 root cause — the booking write is the one server-side operation
      // with no time budget. session.withTransaction() commits with majority
      // write concern; on a real cluster a transient majority-unavailability (or
      // a shared-tier stall) makes an un-bounded commit block indefinitely, which
      // holds the POST /appointments request open with NO response — and because
      // the web client has no request timeout, the "Book appointment" spinner
      // spins forever and the appointment is never created (the reported bug).
      //
      // Bounding the commit (and the write concern's own wtimeout) turns a
      // pathological stall into a fast, real error the caller can retry, instead
      // of an open socket. This does NOT weaken any validation or hide the
      // spinner: the mutation still reaches a terminal state (success OR error),
      // which is exactly the guarantee scheduling needs. Transactional atomicity
      // is unchanged — a bounded commit that fails rolls the whole unit back, so
      // units are never half-consumed.
      await session.withTransaction(async () => { await fn(session); }, {
        readConcern: { level: 'local' },
        writeConcern: { w: 'majority', wtimeout: TX_COMMIT_TIMEOUT_MS },
        maxCommitTimeMS: TX_COMMIT_TIMEOUT_MS,
      });
    } finally {
      await session.endSession();
    }
  }
}

function toSeries(doc) {
  return {
    id: doc._id,
    clientId: doc.clientId,
    staffProfileId: doc.staffProfileId,
    authorizationId: doc.authorizationId,
    serviceCode: doc.serviceCode ?? null,
    units: doc.units ?? null,
    startMinute: doc.startMinute,
    endMinute: doc.endMinute,
    frequency: doc.frequency,
    interval: doc.interval,
    byWeekday: doc.byWeekday ?? [],
    startDate: doc.startDate,
    untilDate: doc.untilDate ?? null,
    count: doc.count ?? null,
    notes: doc.notes ?? null,
    status: doc.status,
    lastMaterializedDate: doc.lastMaterializedDate ?? null,
    createdAt: doc.createdAt,
    version: doc.version,
  };
}

// --- mappers ---------------------------------------------------------------

/** Opaque keyset cursor: `<startAt ms>.<id>`. */
function encodeAppointmentCursor(doc) {
  return `${new Date(doc.startAt).getTime()}.${doc._id}`;
}
function decodeAppointmentCursor(cursor) {
  if (typeof cursor !== 'string') return null;
  const m = /^(\d{1,15})\.(.+)$/.exec(cursor);
  if (!m) return null;
  return { startAt: new Date(Number(m[1])), id: m[2] };
}

const displayName = (p) => (p ? [p.firstName, p.lastName].filter((x) => x != null && String(x).trim() !== '').join(' ').trim() || null : null);

/**
 * Display names for a page of appointments — ONE batched read per collection
 * (never one per appointment), run inside the caller's tenant context so only
 * this tenant's records resolve. The calendar used to derive names from separate
 * client/staff list calls capped at 25 rows, so larger companies saw blank names.
 * Adds clientName, bcbaName, rbtName and staffName (the legacy clinician).
 */
async function attachAppointmentNames(items) {
  if (items.length === 0) return items;
  const clientIds = [...new Set(items.map((a) => a.clientId).filter(Boolean))];
  const staffIds = [...new Set(items.flatMap((a) => [a.bcbaId, a.rbtId, a.staffProfileId]).filter(Boolean))];
  const [clients, staff] = await Promise.all([
    clientIds.length ? Client.find({ _id: { $in: clientIds } }).select({ firstName: 1, lastName: 1 }).lean() : [],
    staffIds.length ? StaffProfile.find({ _id: { $in: staffIds } }).select({ firstName: 1, lastName: 1 }).lean() : [],
  ]);
  const clientName = new Map(clients.map((c) => [c._id, displayName(c)]));
  const staffName = new Map(staff.map((p) => [p._id, displayName(p)]));
  return items.map((a) => ({
    ...a,
    clientName: clientName.get(a.clientId) ?? null,
    bcbaName: a.bcbaId ? staffName.get(a.bcbaId) ?? null : null,
    rbtName: a.rbtId ? staffName.get(a.rbtId) ?? null : null,
    staffName: a.staffProfileId ? staffName.get(a.staffProfileId) ?? null : null,
  }));
}

function toAppointment(doc) {
  return {
    id: doc._id,
    clientId: doc.clientId,
    staffProfileId: doc.staffProfileId,
    // New care-team fields; null on historical appointments (backward compatible).
    bcbaId: doc.bcbaId ?? null,
    rbtId: doc.rbtId ?? null,
    authorizationId: doc.authorizationId,
    authorizationIds: Array.isArray(doc.authorizationIds) && doc.authorizationIds.length
      ? doc.authorizationIds
      : (doc.authorizationId ? [doc.authorizationId] : []),
    seriesId: doc.seriesId ?? null,
    serviceCode: doc.serviceCode ?? null,
    startAt: doc.startAt,
    endAt: doc.endAt,
    timeSet: doc.timeSet ?? true,
    businessTimeZone: doc.businessTimeZone ?? null,
    units: doc.units,
    status: doc.status,
    notes: doc.notes ?? null,
    createdAt: doc.createdAt,
    version: doc.version,
  };
}

function toAvailability(doc) {
  return {
    id: doc._id,
    staffProfileId: doc.staffProfileId,
    dayOfWeek: doc.dayOfWeek,
    startMinute: doc.startMinute,
    endMinute: doc.endMinute,
    effectiveFrom: doc.effectiveFrom ?? null,
    effectiveTo: doc.effectiveTo ?? null,
  };
}

function toAuthorization(doc) {
  return {
    id: doc._id,
    clientId: doc.clientId,
    payerName: doc.payerName ?? null,
    authorizationNumber: doc.authorizationNumber ?? null,
    serviceCode: doc.serviceCode ?? null,
    startDate: doc.startDate,
    endDate: doc.endDate,
    authorizedUnits: doc.authorizedUnits,
    usedUnits: doc.usedUnits ?? 0,
    remainingUnits: (doc.authorizedUnits ?? 0) - (doc.usedUnits ?? 0),
    status: doc.status,
    createdAt: doc.createdAt,
    version: doc.version,
  };
}

// --- unified authorization source -----------------------------------------
// Adapter/id helpers live in ./authAdapter.js (pure + unit-tested for DB
// identity). The Company's APPROVED ABA/FBA ServiceAuthorization is the SAME
// record Scheduling books against — surfaced with a `svc:` marker carrying its
// real _id. No third model, no duplication.

export const schedulingRepository = new SchedulingRepository();
