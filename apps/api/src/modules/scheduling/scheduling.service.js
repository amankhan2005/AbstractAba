import { schedulingError } from './scheduling.errors.js';

import {
  validateTimeRange,
  defaultUnits,
  isWithinAvailability,
  validateAuthorization,
  assertClientBookable,
  assertStaffEligible,
  // A booking may only charge against a BOOKABLE authorization — the single
  // source of truth for "selectable", shared with manual session entry.
  BOOKABLE_AUTH_STATUSES,
} from './scheduling.rules.js';
import { expandOccurrences } from './recurrence.js';
import { normalizeBookingInput, assertAssignedRole, assertNewAppointmentDates } from './booking.js';
import { recordSafely } from '../audit/audit.service.js';
import { assertCoverageVerified } from '../clients/insuranceGate.js';

/**
 * The production insurance gate. Runs inside the tenant context so a client in
 * another organization resolves to no coverage rather than to someone else's.
 */
const defaultInsuranceGate = {
  assertVerified: ({ tenantId, clientId, when }) =>
    withTenant(tenantId, () => assertCoverageVerified(clientId, { when })),
};

// Care-team assignment gate. Default is a NO-OP so existing behaviour (and tests
// that don't inject a gate) is unchanged. The composition root injects the real,
// config-driven gate below.
const defaultAssignmentGate = { assertAssigned: async () => {} };

/**
 * Build a real assignment gate. When `enabled` is false it passes; when true it
 * loads the child's assignments through the injected port and throws
 * STAFF_NOT_ASSIGNED unless the staff member has an ACTIVE assignment to the
 * child. Reuses Phase-3 assignment data — no new store.
 */
export function makeAssignmentGate({ assignments, enabled }) {
  return {
    async assertAssigned({ tenantId, clientId, staffProfileId }) {
      if (!enabled) return;
      const list = await assignments.listActiveForClient(tenantId, clientId);
      const ok = (list ?? []).some(
        (a) => a.staffProfileId === staffProfileId && (a.status ?? 'ACTIVE') === 'ACTIVE',
      );
      if (!ok) throw schedulingError('STAFF_NOT_ASSIGNED');
    },
  };
}
import { withTenant } from '../../tenancy/tenantContext.js';
import { businessDayRange, civilDateString, lastBusinessDateString } from '../../domain/businessDate.js';

/**
 * Scheduling business rules. The repository holds data access; the organization
 * port answers the ACTIVE gate; the clients and staff ports answer eligibility.
 * Dependencies are injected so the orchestration is exercised without a
 * database.
 *
 * Booking a session enforces, in order: the ACTIVE gate, a valid time range, a
 * bookable client, an eligible (active, credentialed) staff member, staff
 * availability, a valid authorization with units remaining, and no
 * double-booking. Only then is the appointment created and the authorization
 * burned down atomically.
 *
 * @typedef {{ repository: object, organizations: { getById:(id:string)=>Promise<{state:string}|null> }, clients: { findById:(t:string,id:string)=>Promise<any> }, staff: { findById:(t:string,id:string)=>Promise<any>, listCredentials:(t:string,id:string)=>Promise<any[]> } }} SchedulingDeps
 */
export class SchedulingService {
  /** @param {SchedulingDeps} deps */
  constructor(deps) {
    this.deps = deps;
  }

  /** Server clock (injectable for tests). Business dates are never taken from the client. */
  now() {
    return this.deps.clock?.now ? this.deps.clock.now() : new Date();
  }

  /** Assert the tenant is ACTIVE and return the organization (callers need its timezone). */
  async _assertActive(tenantId) {
    const org = await this.deps.organizations.getById(tenantId);
    if (!org || org.state !== 'ACTIVE') throw schedulingError('ORG_NOT_ACTIVE');
    return org;
  }

  /** Runs the full booking validation for a candidate window; returns resolved units. */
  async _validateBooking(tenantId, { clientId, staffProfileId, authorizationId, startAt, endAt, units, excludeId, timeZone, timeSet = true }) {
    const start = new Date(startAt);
    const end = new Date(endAt);
    // The business day is the ORGANIZATION's day (§19); a date-only appointment
    // legitimately spans whole days and is exempt from the same-day rule.
    const zone = timeZone ?? (await this.deps.organizations.getById(tenantId))?.timezone ?? 'UTC';
    const durationMinutes = validateTimeRange(start, end, { timeZone: zone, timeSet });
    const resolvedUnits = units ?? defaultUnits(durationMinutes);

    const client = await this.deps.clients.findById(tenantId, clientId);
    assertClientBookable(client);

    const [staff, credentials] = await Promise.all([
      this.deps.staff.findById(tenantId, staffProfileId),
      this.deps.staff.listCredentials(tenantId, staffProfileId),
    ]);
    assertStaffEligible(staff, credentials);

    // Care-team assignment gate (off by default; see makeAssignmentGate).
    await (this.deps.assignmentGate ?? defaultAssignmentGate).assertAssigned({ tenantId, clientId, staffProfileId });

    const windows = await this.deps.repository.listAvailability(tenantId, staffProfileId);
    if (!isWithinAvailability(start, end, windows)) throw schedulingError('STAFF_NOT_AVAILABLE');

    const auth = await this.deps.repository.findAuthorizationById(tenantId, authorizationId);
    validateAuthorization(auth, { clientId, startAt: start, endAt: end, units: resolvedUnits });

    const overlaps = await this.deps.repository.findOverlaps(tenantId, {
      staffProfileId, clientId, startAt: start, endAt: end, ...(excludeId ? { excludeId } : {}),
    });
    if (overlaps.length > 0) throw schedulingError('DOUBLE_BOOKING');

    return { resolvedUnits, serviceCode: auth.serviceCode ?? null };
  }

  // --- appointments --------------------------------------------------------

  /**
   * ---------------------------------------------------------------------------
   * BOOK APPOINTMENT — rebuilt simple pipeline (spec §9).
   *
   *   validate input  →  validate tenant/client  →  validate BCBA  →
   *   validate RBT    →  validate authorization(s)  →  create  →  return
   *
   * Deterministic by construction. No availability service, no double-booking
   * scan, no insurance-gate block, no multi-document transaction, no external
   * call, no notification/queue — the classes of operation §10 identifies as
   * able to hold the request open. Every branch either returns the created
   * appointment or throws a structured error, so the controller always sends a
   * terminal response and the "Book appointment" spinner always stops.
   *
   * Tenant isolation (§19) is enforced server-side: client, care-team
   * assignments and authorizations are all read through the tenant context, so a
   * cross-tenant id resolves to "not found / not valid", never to another
   * company's record.
   * ---------------------------------------------------------------------------
   */
  async bookAppointment({ tenantId, actorUserId, input }) {
    // 1. Org must be ACTIVE (cheap existing gate). The SAME read also gives us
    //    the organization's timezone — the business authority for every date in
    //    this booking (onboarding §19). It was already being loaded here and
    //    simply not used, which is why booking silently fell back to UTC.
    const org = await this._assertActive(tenantId);
    const timeZone = org?.timezone || 'UTC';

    // 2. Validate + normalize the request shape/dates/units (pure, no I/O).
    //    Dates are interpreted in the org timezone, so the day the admin picked
    //    is the day every later layer sees.
    const b = normalizeBookingInput(input, { timeZone });

    // 2b. NEW-APPOINTMENT DATE WINDOW: every scheduled date must be today or
    //     later AND within the current month (org timezone, server clock).
    //     Refused, never adjusted. Runs before any read or write.
    assertNewAppointmentDates({ startAt: b.startAt, endAt: b.endAt, timeZone, now: this.now() });

    // 3. Client must belong to this tenant and be bookable.
    const client = await this.deps.clients.findById(tenantId, b.clientId);
    if (!client) throw schedulingError('CLIENT_NOT_FOUND');
    assertClientBookable(client);

    // 4 & 5. ONE APPOINTMENT = ONE PRIMARY CLINICIAN (spec §4/§17/§23). A NEW
    // appointment names EITHER a BCBA OR an RBT — never both, and never neither.
    // This is the authoritative, server-side invariant behind session
    // independence: because an appointment carries exactly one clinician, its
    // lifecycle (status, cancel) and its single derived session can never be
    // shared between a BCBA and an RBT. To schedule both for the same child the
    // admin creates two separate appointments (spec §5).
    //
    // Legacy appointments created before this rule may still carry both bcbaId
    // and rbtId; those historical records stay fully readable and each
    // clinician keeps their own independent session — this guard governs the
    // WRITE path only, exactly where the spec places it. Backend validation is
    // mandatory here; the frontend and the request schema also enforce it, but
    // this service check is the one that actually protects the data.
    if (!b.bcbaId && !b.rbtId) throw schedulingError('NO_CLINICIAN');
    if (b.bcbaId && b.rbtId) throw schedulingError('MULTIPLE_CLINICIANS');

    // The single supplied clinician must be an ACTIVE care-team member of this
    // client in the named role (the assignments are tenant-scoped, so this is
    // also the server-side tenant guard for staff).
    const assignments = await this.deps.assignments.listActiveForClient(tenantId, b.clientId);
    if (b.bcbaId) assertAssignedRole(assignments, b.bcbaId, 'BCBA', 'BCBA_NOT_ASSIGNED');
    if (b.rbtId) assertAssignedRole(assignments, b.rbtId, 'RBT', 'RBT_NOT_ASSIGNED');

    // 6. Every selected authorization must exist for THIS client and be
    // BOOKABLE. This is a tenant-scoped read (a cross-tenant or wrong-child id
    // resolves to null / a different client) plus a pure in-memory status check
    // — no extra I/O, always terminal, never able to hang. The status gate is
    // the server-side equivalent of the UI only offering bookable rows: a
    // hand-built request that names a PENDING/ineligible authorization is
    // rejected here, not trusted from the client.
    const auths = [];
    for (const authId of b.authorizationIds) {
      const auth = await this.deps.repository.findAuthorizationById(tenantId, authId);
      if (!auth || auth.clientId !== b.clientId || !BOOKABLE_AUTH_STATUSES.has(auth.status)) {
        throw schedulingError('AUTHORIZATION_INVALID');
      }
      auths.push(auth);
    }
    const primary = auths[0];

    // 7. Create + return. One insert; burn-down is bounded + best-effort inside
    // the repository (never blocks or fails a persisted booking).
    return this.deps.repository.createAppointmentSimple(tenantId, {
      clientId: b.clientId,
      bcbaId: b.bcbaId,
      rbtId: b.rbtId,
      // Legacy consumers (Sessions/Billing/Payroll) read staffProfileId; the RBT
      // is the direct-service provider, so it mirrors rbtId.
      staffProfileId: b.staffProfileId,
      authorizationId: b.authorizationId,
      authorizationIds: b.authorizationIds,
      serviceCode: primary?.serviceCode ?? null,
      startAt: b.startAt,
      endAt: b.endAt,
      timeSet: b.timeSet,
      // The business calendar these instants are anchored to (§19). Recording it
      // makes every later read self-describing and lets the migration tell a
      // corrected appointment from a legacy UTC-composed one.
      businessTimeZone: b.businessTimeZone,
      units: b.units,
      status: 'SCHEDULED',
      ...(b.notes !== undefined ? { notes: b.notes } : {}),
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });
  }

  async getAppointment({ tenantId, appointmentId }) {
    const appt = await this.deps.repository.findAppointmentById(tenantId, appointmentId);
    if (!appt) throw schedulingError('APPOINTMENT_NOT_FOUND');
    if (typeof this.deps.repository.withAppointmentNames !== 'function') return appt;
    const [named] = await this.deps.repository.withAppointmentNames(tenantId, [appt]);
    return named;
  }

  async listAppointments({ tenantId, limit, cursor, from, to, staffProfileId, clientId, status, dataScope }) {
    return this.deps.repository.listAppointments(tenantId, {
      ...(dataScope !== undefined ? { dataScope } : {}),
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(staffProfileId !== undefined ? { staffProfileId } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
      ...(status !== undefined ? { status } : {}),
    });
  }

  async updateAppointment({ tenantId, appointmentId, actorUserId, expectedVersion, input }) {
    await this._assertActive(tenantId);
    const current = await this.deps.repository.findAppointmentById(tenantId, appointmentId);
    if (!current) throw schedulingError('APPOINTMENT_NOT_FOUND');

    const patch = { updatedBy: actorUserId };
    let unitDelta = 0;

    // A time or unit change re-runs the full booking validation and adjusts burn-down.
    const timeChanged = input.startAt !== undefined || input.endAt !== undefined || input.units !== undefined;
    // Appointments created by the rebuilt booking core (they name a BCBA or an
    // RBT) are re-validated with THAT core's rules. The legacy path below checks
    // staff credentials, availability windows and a single-day timed range —
    // rules those appointments were never booked under — so every reschedule of
    // a current appointment was refused (STAFF_NOT_ELIGIBLE / STAFF_NOT_AVAILABLE).
    const rebuilt = Boolean(current.bcbaId || current.rbtId);
    if (timeChanged && rebuilt && (input.status ?? current.status) === 'SCHEDULED') {
      const next = await this._validateReschedule(tenantId, current, input);
      patch.startAt = next.startAt;
      patch.endAt = next.endAt;
      patch.units = next.units;
      unitDelta = next.units - current.units;
    } else if (timeChanged && (input.status ?? current.status) === 'SCHEDULED') {
      const startAt = input.startAt ?? current.startAt;
      const endAt = input.endAt ?? current.endAt;
      const { resolvedUnits } = await this._validateBooking(tenantId, {
        clientId: current.clientId,
        staffProfileId: current.staffProfileId,
        authorizationId: current.authorizationId,
        startAt, endAt,
        units: input.units,
        excludeId: appointmentId,
      });
      patch.startAt = new Date(startAt);
      patch.endAt = new Date(endAt);
      patch.units = resolvedUnits;
      unitDelta = resolvedUnits - current.units;
    }
    if (input.serviceCode !== undefined) patch.serviceCode = input.serviceCode;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.status !== undefined) patch.status = input.status;

    return this.deps.repository.updateAppointment(tenantId, appointmentId, patch, expectedVersion, {
      authorizationId: current.authorizationId,
      unitDelta,
    });
  }

  /**
   * Reschedule validation for a rebuilt appointment — the SAME rules as booking:
   *   • dates in the organization's timezone; a DATE-ONLY appointment (timeSet
   *     false) stays date-only and is re-anchored to whole business days (no
   *     clock time is invented); a timed one must stay within one business day;
   *   • the client must still be bookable and the appointment's clinician still
   *     an ACTIVE care-team member in that role;
   *   • every authorization must still exist for the client and be bookable.
   * Refused, never adjusted.
   */
  async _validateReschedule(tenantId, current, input) {
    const org = await this._assertActive(tenantId);
    const zone = org?.timezone || current.businessTimeZone || 'UTC';
    let startAt = new Date(input.startAt ?? current.startAt);
    let endAt = new Date(input.endAt ?? current.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) {
      throw schedulingError('INVALID_TIME_RANGE');
    }
    if (current.timeSet === false) {
      const range = businessDayRange(civilDateString(startAt, zone), lastBusinessDateString(startAt, endAt, zone), zone);
      if (!range) throw schedulingError('END_BEFORE_START');
      ({ startAt, endAt } = range);
    } else {
      validateTimeRange(startAt, endAt, { timeZone: zone, timeSet: true });
    }
    // The today → end-of-month window guards CREATION only (appointment-date-window
    // tests); a reschedule does not invent a new date rule.

    const client = await this.deps.clients.findById(tenantId, current.clientId);
    if (!client) throw schedulingError('CLIENT_NOT_FOUND');
    assertClientBookable(client);
    const assignments = await this.deps.assignments.listActiveForClient(tenantId, current.clientId);
    if (current.bcbaId) assertAssignedRole(assignments, current.bcbaId, 'BCBA', 'BCBA_NOT_ASSIGNED');
    else if (current.rbtId) assertAssignedRole(assignments, current.rbtId, 'RBT', 'RBT_NOT_ASSIGNED');

    const ids = current.authorizationIds?.length ? current.authorizationIds : [current.authorizationId].filter(Boolean);
    for (const authId of ids) {
      const auth = await this.deps.repository.findAuthorizationById(tenantId, authId);
      if (!auth || auth.clientId !== current.clientId || !BOOKABLE_AUTH_STATUSES.has(auth.status)) {
        throw schedulingError('AUTHORIZATION_INVALID');
      }
    }
    return { startAt, endAt, units: input.units ?? current.units };
  }

  async cancelAppointment({ tenantId, appointmentId, actorUserId }) {
    await this._assertActive(tenantId);
    return this.deps.repository.cancelAppointment(tenantId, appointmentId, actorUserId);
  }

  // --- recurring series (Phase 4.3) ----------------------------------------

  /**
   * Create a recurring-appointment series and materialize its occurrences. Each
   * occurrence is booked through the SAME validation path as a single
   * appointment (eligibility, availability, authorization burn-down,
   * double-booking) — reused, not duplicated. Occurrences that fail validation
   * do NOT abort the series: they are returned as skipped exceptions so the
   * caller sees exactly what was booked and what was not.
   */
  async createSeries({ tenantId, actorUserId, input }) {
    await this._assertActive(tenantId);

    const rule = {
      frequency: input.frequency,
      interval: input.interval ?? 1,
      byWeekday: input.byWeekday ?? [],
      startDate: new Date(input.startDate),
      untilDate: input.untilDate ? new Date(input.untilDate) : null,
      count: input.count ?? null,
      startMinute: input.startMinute,
      endMinute: input.endMinute,
    };
    // Expand first so an invalid rule fails before any persistence.
    const occurrences = expandOccurrences(rule);
    if (occurrences.length === 0) throw schedulingError('NO_OCCURRENCES');

    const series = await this.deps.repository.createSeries(tenantId, {
      clientId: input.clientId,
      staffProfileId: input.staffProfileId,
      authorizationId: input.authorizationId,
      units: input.units ?? null,
      startMinute: input.startMinute,
      endMinute: input.endMinute,
      frequency: rule.frequency,
      interval: rule.interval,
      byWeekday: rule.byWeekday,
      startDate: rule.startDate,
      untilDate: rule.untilDate,
      count: rule.count,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      status: 'ACTIVE',
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });

    const { booked, skipped } = await this._materialize({ tenantId, actorUserId, series, occurrences });

    recordSafely({
      tenantId, actorId: actorUserId, action: 'scheduling.series_created',
      entityType: 'appointment_series', entityId: series.id, outcome: 'success',
      payload: { requested: occurrences.length, booked: booked.length, skipped: skipped.length },
    });

    return { series, booked, skipped };
  }

  /** Book each occurrence through the shared validation path; collect exceptions. */
  async _materialize({ tenantId, actorUserId, series, occurrences }) {
    const booked = [];
    const skipped = [];
    let lastDate = series.lastMaterializedDate ? new Date(series.lastMaterializedDate) : null;

    for (const occ of occurrences) {
      try {
        const { resolvedUnits, serviceCode } = await this._validateBooking(tenantId, {
          clientId: series.clientId,
          staffProfileId: series.staffProfileId,
          authorizationId: series.authorizationId,
          startAt: occ.startAt,
          endAt: occ.endAt,
          units: series.units ?? undefined,
        });
        const appt = await this.deps.repository.createAppointment(tenantId, {
          clientId: series.clientId,
          staffProfileId: series.staffProfileId,
          authorizationId: series.authorizationId,
          seriesId: series.id,
          startAt: occ.startAt,
          endAt: occ.endAt,
          units: resolvedUnits,
          serviceCode,
          status: 'SCHEDULED',
          createdBy: actorUserId,
          updatedBy: actorUserId,
        });
        booked.push(appt);
        if (!lastDate || occ.startAt > lastDate) lastDate = occ.startAt;
      } catch (err) {
        // Validation failures (double-booking, unavailable, auth exhausted, …)
        // become recorded exceptions rather than aborting the whole series.
        const reason = err?.code || err?.expose ? (err.message || 'SKIPPED') : 'SKIPPED';
        skipped.push({ startAt: occ.startAt, endAt: occ.endAt, reason });
      }
    }

    if (lastDate) await this.deps.repository.setSeriesLastMaterialized(tenantId, series.id, lastDate);
    return { booked, skipped };
  }

  async getSeries({ tenantId, seriesId }) {
    const series = await this.deps.repository.findSeriesById(tenantId, seriesId);
    if (!series) throw schedulingError('SERIES_NOT_FOUND');
    const appointments = await this.deps.repository.listAppointmentsBySeries(tenantId, seriesId);
    return { series, appointments };
  }

  async listSeries({ tenantId, filters }) {
    return this.deps.repository.listSeries(tenantId, filters);
  }

  /**
   * Cancel a whole series: mark it CANCELLED and cancel every FUTURE scheduled
   * occurrence (restoring authorization units through the same cancel path).
   * Past/held appointments are left as historical record.
   */
  async cancelSeries({ tenantId, seriesId, actorUserId }) {
    await this._assertActive(tenantId);
    const series = await this.deps.repository.findSeriesById(tenantId, seriesId);
    if (!series) throw schedulingError('SERIES_NOT_FOUND');
    if (series.status === 'CANCELLED') throw schedulingError('SERIES_ALREADY_CANCELLED');

    const now = new Date();
    const future = await this.deps.repository.listFutureScheduledBySeries(tenantId, seriesId, now);
    let cancelled = 0;
    for (const appt of future) {
      await this.deps.repository.cancelAppointment(tenantId, appt.id, actorUserId);
      cancelled += 1;
    }
    const updated = await this.deps.repository.cancelSeries(tenantId, seriesId, actorUserId);

    recordSafely({
      tenantId, actorId: actorUserId, action: 'scheduling.series_cancelled',
      entityType: 'appointment_series', entityId: seriesId, outcome: 'success',
      payload: { cancelledOccurrences: cancelled },
    });
    return { series: updated, cancelledOccurrences: cancelled };
  }

  /**
   * Cancel a single occurrence within a series (an exception). Reuses the
   * standard appointment cancel (unit restoration) and emits an audit event.
   */
  async cancelOccurrence({ tenantId, seriesId, appointmentId, actorUserId }) {
    await this._assertActive(tenantId);
    const appt = await this.deps.repository.findAppointmentById(tenantId, appointmentId);
    if (!appt || appt.seriesId !== seriesId) throw schedulingError('APPOINTMENT_NOT_FOUND');
    const cancelled = await this.deps.repository.cancelAppointment(tenantId, appointmentId, actorUserId);
    recordSafely({
      tenantId, actorId: actorUserId, action: 'scheduling.occurrence_cancelled',
      entityType: 'appointment', entityId: appointmentId, outcome: 'success',
      payload: { seriesId },
    });
    return cancelled;
  }

  // --- availability --------------------------------------------------------

  async getAvailability({ tenantId, staffId }) {
    await this._requireStaff(tenantId, staffId);
    return this.deps.repository.listAvailability(tenantId, staffId);
  }

  async replaceAvailability({ tenantId, staffId, actorUserId, windows }) {
    await this._assertActive(tenantId);
    await this._requireStaff(tenantId, staffId);
    const normalized = windows.map((w) => ({
      dayOfWeek: w.dayOfWeek,
      startMinute: w.startMinute,
      endMinute: w.endMinute,
      ...(w.effectiveFrom !== undefined ? { effectiveFrom: new Date(w.effectiveFrom) } : {}),
      ...(w.effectiveTo !== undefined ? { effectiveTo: new Date(w.effectiveTo) } : {}),
    }));
    return this.deps.repository.replaceAvailability(tenantId, staffId, normalized, actorUserId);
  }

  // --- authorizations ------------------------------------------------------

  async createAuthorization({ tenantId, actorUserId, input }) {
    await this._assertActive(tenantId);
    const client = await this.deps.clients.findById(tenantId, input.clientId);
    if (!client) throw schedulingError('CLIENT_NOT_BOOKABLE');
    return this.deps.repository.createAuthorization(tenantId, {
      clientId: input.clientId,
      ...(input.payerName !== undefined ? { payerName: input.payerName } : {}),
      ...(input.authorizationNumber !== undefined ? { authorizationNumber: input.authorizationNumber } : {}),
      ...(input.serviceCode !== undefined ? { serviceCode: input.serviceCode } : {}),
      startDate: new Date(input.startDate),
      endDate: new Date(input.endDate),
      authorizedUnits: input.authorizedUnits,
      usedUnits: 0,
      status: 'ACTIVE',
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });
  }

  async getAuthorization({ tenantId, authorizationId }) {
    const auth = await this.deps.repository.findAuthorizationById(tenantId, authorizationId);
    if (!auth) throw schedulingError('AUTHORIZATION_NOT_FOUND');
    return auth;
  }

  async listAuthorizations({ tenantId, limit, cursor, clientId, status }) {
    return this.deps.repository.listAuthorizations(tenantId, {
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
      ...(status !== undefined ? { status } : {}),
    });
  }

  async updateAuthorization({ tenantId, authorizationId, actorUserId, expectedVersion, input }) {
    await this._assertActive(tenantId);
    const patch = { updatedBy: actorUserId };
    for (const key of ['payerName', 'authorizationNumber', 'serviceCode', 'authorizedUnits', 'status']) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    if (input.startDate !== undefined) patch.startDate = new Date(input.startDate);
    if (input.endDate !== undefined) patch.endDate = new Date(input.endDate);
    return this.deps.repository.updateAuthorization(tenantId, authorizationId, patch, expectedVersion);
  }

  // --- internals -----------------------------------------------------------

  async _requireStaff(tenantId, staffId) {
    const staff = await this.deps.staff.findById(tenantId, staffId);
    if (!staff) throw schedulingError('STAFF_NOT_ELIGIBLE');
    return staff;
  }
}
