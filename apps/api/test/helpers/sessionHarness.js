/**
 * ---------------------------------------------------------------------------
 * IN-MEMORY INTEGRATION HARNESS for the session workflow.
 *
 * WHY THIS SHAPE. Onboarding §24 is explicit that a test asserting "the function
 * returned the expected value for hand-built data" does not prove a bug is
 * fixed when the bug lives in the lifecycle. So this harness does NOT stub the
 * service: it constructs the REAL BcbaSessionService and drives it through the
 * real start/stop/complete methods, over ports whose persistence semantics
 * match the real ones. The only thing replaced is the database driver.
 *
 * The two semantics that actually matter here are reproduced faithfully, because
 * the bug being tested lives in exactly this seam:
 *
 *   1. THE PARTIAL UNIQUE INDEX on the Session collection —
 *      (tenantId, appointmentId, staffProfileId) unique WHERE active:true.
 *      `findByAppointment` returns only the ACTIVE session, which is what makes
 *      "complete then start again" produce a SECOND session row. If the harness
 *      ignored `active`, the session-count bug would be invisible to it.
 *
 *   2. THE UNIQUE INDEX on SessionTimeRecord (tenantId, sessionId), which is the
 *      idempotency guarantee behind a repeated Complete.
 *
 * A real MongoDB is not available in this environment, so this is the strongest
 * harness available rather than a substitute for a live integration run. What it
 * proves and what it does not is stated in the test file.
 * ---------------------------------------------------------------------------
 */

import { BcbaSessionService } from '../../src/modules/bcba-session/bcbaSession.service.js';

/** A controllable clock so worked minutes are exact, not wall-clock dependent. */
export function makeClock(startIso) {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advanceMinutes(m) { current += m * 60000; return new Date(current); },
    set(iso) { current = new Date(iso).getTime(); return new Date(current); },
  };
}

function clone(v) {
  return v === null || v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/**
 * In-memory stores with the real collections' identity semantics.
 * Everything is tenant-keyed so a cross-tenant read genuinely returns nothing.
 */
export function createHarness({
  timeZone = 'America/New_York',
  now = '2026-09-12T14:00:00.000Z',
  hourlyRateDollars = 50,
  /** Optional { [staffProfileId]: dollarsPerHour } overriding the flat rate. */
  hourlyRatesByStaff = null,
  appointment,
  orgState = 'ACTIVE',
} = {}) {
  const clock = makeClock(now);
  const sessions = new Map();     // id -> session doc
  const timeRecords = new Map();  // id -> record doc
  const appointments = new Map();
  let seq = 0;
  const nextId = (p) => `${p}_${++seq}`;

  if (appointment) appointments.set(appointment.id, { ...appointment });

  const scoped = (doc, tenantId) => (doc && doc.tenantId === tenantId ? doc : null);

  const sessionsPort = {
    /**
     * Mirrors sessionsRepository.findSessionByAppointmentAndStaff: returns the
     * OPEN (active) session only. A completed session sets active:false and
     * therefore stops occupying the slot — which is precisely how repeated
     * Start/Stop used to spawn extra session rows.
     */
    async findByAppointment(tenantId, appointmentId, staffProfileId) {
      for (const s of sessions.values()) {
        if (s.tenantId !== tenantId) continue;
        if (s.appointmentId !== appointmentId) continue;
        if (s.staffProfileId !== staffProfileId) continue;
        if (s.active === false) continue;
        return clone(s);
      }
      return null;
    },
    /** Mirrors findLatestFinalizedByAppointmentAndStaff: inactive rows only. */
    async findLatestFinalized(tenantId, appointmentId, staffProfileId) {
      const rows = [...sessions.values()].filter((s) => s.tenantId === tenantId
        && s.appointmentId === appointmentId && s.staffProfileId === staffProfileId && s.active === false);
      rows.sort((a, b) => new Date(b.frozenAt ?? b.startedAt) - new Date(a.frozenAt ?? a.startedAt));
      return rows.length ? clone(rows[0]) : null;
    },
    async findById(tenantId, id) { return clone(scoped(sessions.get(id), tenantId)); },
    async findByGenerationKey(tenantId, key) {
      for (const s of sessions.values()) {
        if (s.tenantId === tenantId && s.generationKey === key) return clone(s);
      }
      return null;
    },
    async create(tenantId, doc) {
      // Enforce the partial unique index rather than trusting the caller.
      for (const s of sessions.values()) {
        if (s.tenantId === tenantId && s.appointmentId === doc.appointmentId
          && s.staffProfileId === doc.staffProfileId && s.active !== false && doc.active !== false) {
          const err = new Error('duplicate active session'); err.code = 11000; throw err;
        }
      }
      const id = nextId('ses');
      const row = {
        id, tenantId, active: true, intervals: [], status: 'DRAFT',
        selectedAuthorizationIds: [], authorizationMemos: [],
        documentation: {}, sensitive: { narrative: null }, ...clone(doc),
      };
      sessions.set(id, row);
      return clone(row);
    },
    async update(tenantId, id, patch) {
      const row = scoped(sessions.get(id), tenantId);
      if (!row) return null;
      // Mirror Mongo's `$set` semantics: a DOTTED key writes into the nested
      // object rather than creating a literal key called "documentation.what".
      // The service builds sparse patches with dotted paths (documentation.*,
      // sensitive.narrative), so a harness that stored them flat would silently
      // diverge from production and hide real bugs.
      for (const [key, value] of Object.entries(patch)) {
        if (!key.includes('.')) { row[key] = clone(value); continue; }
        const segments = key.split('.');
        let cursor = row;
        for (let i = 0; i < segments.length - 1; i += 1) {
          const seg = segments[i];
          if (cursor[seg] == null || typeof cursor[seg] !== 'object') cursor[seg] = {};
          cursor = cursor[seg];
        }
        cursor[segments[segments.length - 1]] = clone(value);
      }
      return clone(row);
    },
    async freeze(tenantId, id, actorUserId) {
      const row = scoped(sessions.get(id), tenantId);
      if (!row) return null;
      // Mirrors freezeSession: FROZEN + active:false (frees the slot).
      row.status = 'FROZEN';
      row.active = false;
      row.frozenAt = clock.now();
      row.frozenBy = actorUserId;
      return clone(row);
    },
  };

  const timeRecordsPort = {
    async findBySession(tenantId, sessionId) {
      for (const r of timeRecords.values()) {
        if (r.tenantId === tenantId && r.sessionId === sessionId) return clone(r);
      }
      return null;
    },
    async create(tenantId, doc) {
      // Unique (tenantId, sessionId) — a repeated finalize resolves, never duplicates.
      for (const r of timeRecords.values()) {
        if (r.tenantId === tenantId && r.sessionId === doc.sessionId) return clone(r);
      }
      const id = nextId('str');
      const row = { id, tenantId, ...clone(doc) };
      timeRecords.set(id, row);
      return clone(row);
    },
    async list() { return []; },
    async sumWorkedMinutes() { return 0; },
    async sumWorkedSeconds() { return 0; },
  };

  const service = new BcbaSessionService({
    clock: { now: () => clock.now() },
    organizations: { getById: async () => ({ id: 'org1', state: orgState, timezone: timeZone }) },
    appointments: {
      findById: async (tenantId, id) => clone(scoped(appointments.get(id), tenantId) ?? (appointments.get(id)?.tenantId === undefined ? appointments.get(id) : null)),
      listForBcba: async () => [...appointments.values()].map(clone),
      listForRbt: async () => [...appointments.values()].map(clone),
      createManual: async (tenantId, doc) => { const id = nextId('appt'); const row = { id, tenantId, ...clone(doc) }; appointments.set(id, row); return clone(row); },
    },
    assignments: { listActiveForClient: async () => [] },
    sessions: sessionsPort,
    plans: { findActivePlanForClient: async () => null, summarize: async () => ({ goalCount: 0, programCount: 0 }) },
    clients: { findById: async () => ({ id: 'child1', firstName: 'John', lastName: 'Doe' }) },
    authorizations: { resolveMany: async (_t, ids) => ids.map((id) => ({ id, label: `Auth ${id}` })) },
    payRates: {
      // Per-staff rates when a map is supplied, so a single store can hold two
      // clinicians on genuinely different rates (a shared flat rate would make
      // "each clinician is paid their own rate" untestable).
      getCurrentHourlyRate: async ({ staffProfileId }) => (
        hourlyRatesByStaff && Object.prototype.hasOwnProperty.call(hourlyRatesByStaff, staffProfileId)
          ? hourlyRatesByStaff[staffProfileId]
          : hourlyRateDollars
      ),
    },
    settings: { getStaffing: async () => ({}) },
    timeRecords: timeRecordsPort,
    // Identity seal so assertions can read what was stored without a key.
    phi: { seal: (v) => (v == null ? null : `sealed:${v}`), open: (v) => (typeof v === 'string' && v.startsWith('sealed:') ? v.slice(7) : v) },
  });

  return {
    service,
    clock,
    stores: { sessions, timeRecords, appointments },
    /** Every session row for a tenant, including completed ones. */
    allSessions: (tenantId) => [...sessions.values()].filter((s) => s.tenantId === tenantId).map(clone),
    allTimeRecords: (tenantId) => [...timeRecords.values()].filter((r) => r.tenantId === tenantId).map(clone),
    addAppointment(doc) { appointments.set(doc.id, { ...doc }); return doc; },
  };
}
