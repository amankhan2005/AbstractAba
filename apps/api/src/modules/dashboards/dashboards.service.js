import { civilDateString, coversBusinessDay, lastBusinessDateString, parseCivilDate, sessionBusinessDate, startEligibility, zonedMidnightToUtc, zonedParts, zonedWallTimeToUtc } from '../../domain/businessDate.js';
import { AUTH_EXPIRY_WARNING_DAYS, authorizationExpiry, clientCompletionAlerts } from '../clients/clients.alerts.js';
import { deriveSessionStatus } from '../bcba-session/sessionStatus.js';
import { toDateOnly } from '../../utils/format.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Client statuses whose required onboarding can still be open (not discharged). */
const COMPLETION_REVIEW_STATUSES = ['REFERRED', 'INTAKE', 'ACTIVE', 'ON_HOLD'];
const SECTION_LIMIT = 8;
const TODAY_LIMIT = 25;
const LATEST_SESSIONS_LIMIT = 4;
/** A session is completed once it is approved (frozen) or amended — the Sessions pages' rule. */
const COMPLETED_SESSION_STATUSES = new Set(['FROZEN', 'AMENDED']);

/** [start, end) of a business date in the org timezone (DST-correct). */
function businessDayWindow(date, timeZone) {
  const d = parseCivilDate(date);
  const next = new Date(Date.UTC(d.year, d.month - 1, d.day + 1));
  return {
    from: zonedMidnightToUtc(d.year, d.month, d.day, timeZone),
    to: zonedMidnightToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone),
  };
}

/**
 * The time a Today row shows, from the most authoritative source available:
 *   ACTUAL     the persisted SessionTimeRecord, else the live session's start/end
 *   SCHEDULED  this occurrence's scheduled window (timed appointments)
 *   ALL_DAY    a date-only appointment with no recorded work — no invented clock
 * `sortAt` orders the rows and is stripped from the response.
 */
function occurrenceTime(appt, session, record, { businessDate, timeZone, now }) {
  if (record) return { timeKind: 'ACTUAL', startAt: record.startedAt, endAt: record.endedAt, sortAt: record.startedAt };
  if (session?.startedAt && session.status !== 'DRAFT') {
    return { timeKind: 'ACTUAL', startAt: session.startedAt, endAt: session.endedAt ?? null, sortAt: session.startedAt };
  }
  const window = startEligibility(appt, timeZone, now, { businessDate });
  if (appt.timeSet === false) return { timeKind: 'ALL_DAY', startAt: null, endAt: null, sortAt: window.windowStart };
  // A multi-date booking's occurrence ends at the booking's end clock time on
  // THIS business date; a single-date booking keeps its stored end.
  let endAt = appt.endAt ?? null;
  if (endAt && civilDateString(appt.startAt, timeZone) !== lastBusinessDateString(appt.startAt, appt.endAt, timeZone)) {
    const d = parseCivilDate(businessDate);
    const clock = zonedParts(new Date(appt.endAt), timeZone);
    endAt = zonedWallTimeToUtc(d.year, d.month, d.day, clock.hour, clock.minute, 0, timeZone);
  }
  return { timeKind: 'SCHEDULED', startAt: window.windowStart, endAt, sortAt: window.windowStart };
}

/**
 * Role-dashboard composition. Each dashboard is a read-only rollup of existing
 * clinical data, assembled from the injected repository's tenant-scoped counts.
 * The service owns the day-window math (today / next 7 days) and the metric
 * derivations (utilization %, completion %), so those are unit-testable against
 * a fake repository without a database. Nothing here writes; the repository
 * methods are all counts and grouped reads under withTenant().
 *
 * The four dashboards share a set of building-block metrics and each selects the
 * slice relevant to its role:
 *   - Organization : org-wide clinical posture (clients, staff, plans, docs).
 *   - Admin        : operational/compliance queue (approvals, expirations, auth).
 *   - BCBA         : a supervisor's clinical board (their plans, sign-off queue).
 *   - RBT          : a technician's day (their sessions today, upcoming visits).
 *
 * @typedef {{ repository: object, now?: () => Date }} DashboardsDeps
 */
export class DashboardsService {
  /** @param {DashboardsDeps} deps */
  constructor(deps) {
    this.deps = deps;
    this._now = deps.now ?? (() => new Date());
  }

  // --- window helpers (pure) ----------------------------------------------

  /** [start, end) of the current UTC day. */
  _todayWindow() {
    const now = this._now();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
    return { from, to };
  }

  /** [now, now + 7 days) for the "upcoming" horizon. */
  _upcomingWindow() {
    const from = this._now();
    const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
    return { from, to };
  }

  // --- organization dashboard ---------------------------------------------

  async organizationDashboard({ tenantId }) {
    const today = this._todayWindow();
    const upcoming = this._upcomingWindow();
    const [clients, staff, plans, documents, sessions, todaySessions, util] = await Promise.all([
      this.deps.repository.countClientsByStatus(tenantId),
      this.deps.repository.countStaffByStatus(tenantId),
      this.deps.repository.countPlansByStatus(tenantId),
      this.deps.repository.countDocumentsByStatus(tenantId),
      this.deps.repository.countSessionsByStatus(tenantId),
      this.deps.repository.countSessionsInWindowByStatus(tenantId, today),
      this.deps.repository.authorizationUtilization(tenantId),
    ]);
    const upcomingAppointments = await this.deps.repository.countAppointmentsInWindow(tenantId, { ...upcoming, status: 'SCHEDULED' });
    return {
      scope: 'organization',
      generatedAt: this._now().toISOString(),
      activeClients: clients.ACTIVE ?? 0,
      clientsByStatus: clients,
      activeStaff: staff.ACTIVE ?? 0,
      staffByStatus: staff,
      activeTreatmentPlans: plans.ACTIVE ?? 0,
      archivedPlans: plans.ARCHIVED ?? 0,
      plansByStatus: plans,
      draftDocuments: documents.DRAFT ?? 0,
      finalizedDocuments: documents.FINALIZED ?? 0,
      documentsByStatus: documents,
      frozenSessions: sessions.FROZEN ?? 0,
      draftSessions: sessions.DRAFT ?? 0,
      todaysSessions: sumCounts(todaySessions),
      todaysSessionsByStatus: todaySessions,
      upcomingAppointments,
      authorizationUtilization: utilizationPercent(util),
    };
  }

  // --- Company dashboard (GET /dashboards/company) -------------------------
  //
  // The Company Admin's operational dashboard. Every figure is read from
  // persisted, tenant-scoped records and every rule is the application's
  // canonical one:
  //   clients        Client.status (the Clients page's own filter): active =
  //                  ACTIVE, inactive = every other non-archived status
  //   staff          ACTIVE StaffProfiles by RBAC role key (bcba / rbt)
  //   attention      clientCompletionAlerts — intake pipeline + valid parent
  //   authorizations authorizationExpiry — AUTH_EXPIRY_WARNING_DAYS, never DENIED
  //   today          appointments with an occurrence on the ORG business date,
  //                  status from deriveSessionStatus, times from the persisted
  //                  SessionTimeRecord / session, else the schedule
  //   notes          AppointmentNotesService.listNotesOverview (current business
  //                  date, BCBA-authored, the note's own selected client only)
  //   latest         the 4 most recent sessions by start, clock-in/out and
  //                  worked minutes from SessionTimeRecord
  //   sessionsByRole month-to-date (org business calendar) sessions per clinical
  //                  role from each session's own appointment assignment, worked
  //                  minutes from SessionTimeRecord — BCBA and RBT never merged
  async companyDashboard({ tenantId, includeNotes = false }) {
    const now = this._now();
    const org = await this.deps.organizations.getById(tenantId);
    const timeZone = org?.timezone || 'UTC';
    const businessDate = civilDateString(now, timeZone);
    const day = businessDayWindow(businessDate, timeZone);

    const monthStartDate = `${businessDate.slice(0, 7)}-01`;
    const month = { from: businessDayWindow(monthStartDate, timeZone).from, to: day.to };

    const [clientCounts, accountCounts, clinicians, staffCounts, monthSessions, completionRows, authCandidates, dayData, latest, notes] = await Promise.all([
      this.deps.repository.countClientsByStatus(tenantId),
      this.deps.repository.countClientsByAccountStatus(tenantId),
      this.deps.repository.activeClinicianCounts(tenantId),
      this.deps.repository.countStaffByStatus(tenantId),
      this.deps.repository.sessionsInWindowWithRoles
        ? this.deps.repository.sessionsInWindowWithRoles(tenantId, month)
        : Promise.resolve({ sessions: [], appointments: [], timeRecords: [] }),
      this.deps.repository.clientsForCompletionReview(tenantId, { statuses: COMPLETION_REVIEW_STATUSES }),
      this.deps.repository.authorizationsEndingBetween(tenantId, {
        from: new Date(now.getTime() - DAY_MS),
        to: new Date(now.getTime() + (AUTH_EXPIRY_WARNING_DAYS + 1) * DAY_MS),
      }),
      this.deps.repository.appointmentsForDay(tenantId, day),
      this.deps.repository.latestSessions(tenantId, LATEST_SESSIONS_LIMIT),
      includeNotes && this.deps.appointmentNotes
        ? this.deps.appointmentNotes.listNotesOverview({ tenantId, actorRole: 'ADMIN', scope: 'ORGANIZATION' })
        : Promise.resolve(null),
    ]);

    // Active = ACCOUNT status Active (valid parent, not on hold or discharged) —
    // the same rule and numbers as the Clients page.
    const total = sumCounts(clientCounts);
    const active = accountCounts.ACTIVE ?? 0;
    const staffTotal = sumCounts(staffCounts);
    const staffActive = staffCounts.ACTIVE ?? 0;

    return {
      scope: 'company',
      generatedAt: now.toISOString(),
      timeZone,
      businessDate,
      clients: { total, active, inactive: total - active, byStatus: clientCounts, byAccount: accountCounts },
      staff: {
        bcba: clinicians.BCBA,
        rbt: clinicians.RBT,
        activeStaff: clinicians.activeStaff,
        total: staffTotal,
        active: staffActive,
        inactive: staffTotal - staffActive,
        byStatus: staffCounts,
      },
      sessionsByRole: this._sessionsByRole(monthSessions, { from: monthStartDate, to: businessDate }),
      attention: this._attention(completionRows),
      expiringAuthorizations: this._expiringAuthorizations(authCandidates, now),
      today: this._todaySessions(dayData, { businessDate, timeZone, now }),
      appointmentNotes: notes ? this._bcbaNotes(notes) : null,
      latestSessions: this._latestSessions(latest),
    };
  }

  _attention(rows) {
    const order = { CRITICAL: 0, WARNING: 1, INFO: 2 };
    const items = [];
    for (const row of rows) {
      const alerts = clientCompletionAlerts({ intakeWorkflowStatus: row.intakeWorkflowStatus, guardians: row.guardians });
      if (!alerts.length) continue;
      items.push({
        clientId: row.clientId,
        clientName: row.clientName,
        status: row.status,
        severity: alerts.some((a) => a.severity === 'CRITICAL') ? 'CRITICAL' : 'WARNING',
        missing: alerts.map((a) => ({ code: a.code, label: a.message })),
      });
    }
    items.sort((a, b) => order[a.severity] - order[b.severity]);
    return { total: items.length, items: items.slice(0, SECTION_LIMIT) };
  }

  _expiringAuthorizations(rows, now) {
    const items = [];
    for (const a of rows) {
      const { state, daysLeft } = authorizationExpiry(a, now);
      if (state !== 'EXPIRING') continue;
      items.push({
        authorizationId: a.authorizationId,
        clientId: a.clientId,
        clientName: a.clientName,
        serviceType: a.serviceType,
        authorizationNumber: a.authorizationNumber,
        billingCode: a.billingCode,
        endDate: toDateOnly(a.endDate),
        daysLeft,
        status: a.status,
      });
    }
    return { total: items.length, items: items.slice(0, SECTION_LIMIT) };
  }

  _todaySessions({ appointments, sessions, timeRecords, clientNames, staffNames }, { businessDate, timeZone, now }) {
    const recordBySession = new Map(timeRecords.map((r) => [r.sessionId, r]));
    const rows = [];
    for (const appt of appointments) {
      if (!coversBusinessDay(appt.startAt, appt.endAt, timeZone, now)) continue;
      const clinicians = [];
      if (appt.bcbaId) clinicians.push({ id: appt.bcbaId, role: 'BCBA' });
      if (appt.rbtId) clinicians.push({ id: appt.rbtId, role: 'RBT' });
      if (!clinicians.length && appt.staffProfileId) clinicians.push({ id: appt.staffProfileId, role: null });

      for (const clinician of clinicians) {
        // The session for THIS clinician and THIS business date's occurrence.
        const session = sessions
          .filter((x) => x.appointmentId === appt.id && x.staffProfileId === clinician.id)
          .filter((x) => { const bound = sessionBusinessDate(appt, x, timeZone); return bound === null || bound === businessDate; })
          .sort((x, y) => new Date(y.startedAt ?? 0) - new Date(x.startedAt ?? 0))[0] ?? null;
        const record = session ? recordBySession.get(session.id) : null;
        const status = !session && appt.status === 'NO_SHOW' ? 'NO_SHOW' : deriveSessionStatus(appt, session);
        const time = occurrenceTime(appt, session, record, { businessDate, timeZone, now });
        rows.push({
          key: `${appt.id}:${clinician.role ?? clinician.id}`,
          appointmentId: appt.id,
          sessionId: session?.id ?? null,
          clientName: clientNames.get(appt.clientId) ?? null,
          clinicianName: staffNames.get(clinician.id) ?? null,
          role: clinician.role,
          status,
          source: session?.source ?? null,
          ...time,
          workedMinutes: record?.workedMinutes ?? null,
        });
      }
    }
    rows.sort((a, b) => new Date(a.sortAt) - new Date(b.sortAt) || String(a.clientName).localeCompare(String(b.clientName)));
    const byRole = { BCBA: 0, RBT: 0 };
    for (const r of rows) if (r.role === 'BCBA' || r.role === 'RBT') byRole[r.role] += 1;
    return { total: rows.length, byRole, items: rows.slice(0, TODAY_LIMIT).map(({ sortAt, ...r }) => r) };
  }

  /** Sessions per clinical role for a period, attributed by each session's own appointment. */
  _sessionsByRole({ sessions = [], appointments = [], timeRecords = [] }, period) {
    const apptById = new Map(appointments.map((a) => [a.id, a]));
    const minutes = new Map(timeRecords.map((r) => [r.sessionId, r.workedMinutes]));
    const out = { period, BCBA: { sessions: 0, completed: 0, workedMinutes: 0 }, RBT: { sessions: 0, completed: 0, workedMinutes: 0 } };
    for (const x of sessions) {
      const appt = apptById.get(x.appointmentId);
      const role = appt?.bcbaId === x.staffProfileId ? 'BCBA' : appt?.rbtId === x.staffProfileId ? 'RBT' : null;
      if (!role) continue;
      const bucket = out[role];
      bucket.sessions += 1;
      if (COMPLETED_SESSION_STATUSES.has(x.status)) bucket.completed += 1;
      const m = minutes.get(x.id);
      if (Number.isFinite(m)) bucket.workedMinutes += Math.max(0, Math.round(m));
    }
    return out;
  }

  _bcbaNotes({ items = [] }) {
    const notes = items
      .filter((n) => n.authorRole === 'BCBA')
      .map((n) => ({
        noteId: n.id,
        appointmentId: n.appointmentId,
        authorFirstName: n.authorFirstName ?? null,
        noteClientName: n.noteClientName ?? null,
        updatedAt: n.updatedAt ?? null,
      }))
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    return { total: notes.length, items: notes };
  }

  _latestSessions({ sessions, appointments, timeRecords, clientNames, staffNames }) {
    const apptById = new Map(appointments.map((a) => [a.id, a]));
    const recordBySession = new Map(timeRecords.map((r) => [r.sessionId, r]));
    return sessions.map((x) => {
      const record = recordBySession.get(x.id);
      const appt = apptById.get(x.appointmentId);
      const role = appt?.bcbaId === x.staffProfileId ? 'BCBA' : appt?.rbtId === x.staffProfileId ? 'RBT' : null;
      return {
        sessionId: x.id,
        clientName: clientNames.get(x.clientId) ?? null,
        clinicianName: staffNames.get(x.staffProfileId) ?? null,
        role,
        startedAt: x.startedAt,
        endedAt: x.endedAt ?? null,
        // Clock-in / clock-out: the persisted SessionTimeRecord, else the session's own start/end.
        clockIn: record?.startedAt ?? x.startedAt ?? null,
        clockOut: record?.endedAt ?? x.endedAt ?? null,
        workedMinutes: record?.workedMinutes ?? null,
        status: x.status,
        source: x.source ?? null,
      };
    });
  }

  // --- admin dashboard -----------------------------------------------------

  async adminDashboard({ tenantId }) {
    const today = this._todayWindow();
    const [staff, sessions, documents, plans, credentialExpirations, util] = await Promise.all([
      this.deps.repository.countStaffByStatus(tenantId),
      this.deps.repository.countSessionsByStatus(tenantId),
      this.deps.repository.countDocumentsByStatus(tenantId),
      this.deps.repository.countPlansByStatus(tenantId),
      this.deps.repository.countCredentialsExpiringWithin(tenantId, 30),
      this.deps.repository.authorizationUtilization(tenantId),
    ]);
    const todaySessions = await this.deps.repository.countSessionsInWindowByStatus(tenantId, today);
    // "Pending approvals" = clinical work awaiting sign-off: submitted sessions
    // plus draft documents plus draft plans.
    const pendingApprovals = (sessions.SUBMITTED ?? 0) + (documents.DRAFT ?? 0) + (plans.DRAFT ?? 0);
    return {
      scope: 'admin',
      generatedAt: this._now().toISOString(),
      pendingApprovals,
      pendingApprovalsBreakdown: {
        submittedSessions: sessions.SUBMITTED ?? 0,
        draftDocuments: documents.DRAFT ?? 0,
        draftPlans: plans.DRAFT ?? 0,
      },
      credentialExpirations,
      activeStaff: staff.ACTIVE ?? 0,
      inactiveStaff: staff.INACTIVE ?? 0,
      authorizationUtilization: utilizationPercent(util),
      draftDocuments: documents.DRAFT ?? 0,
      finalizedDocuments: documents.FINALIZED ?? 0,
      archivedPlans: plans.ARCHIVED ?? 0,
      todaysSessions: sumCounts(todaySessions),
      frozenSessions: sessions.FROZEN ?? 0,
    };
  }

  // --- BCBA dashboard ------------------------------------------------------

  async bcbaDashboard({ tenantId, staffProfileId, subjectMissing = false }) {
    // Narrowing-scope caller with no resolvable clinician profile: return an
    // empty board WITHOUT querying, so a missing user↔StaffProfile link can
    // never widen into an unscoped, tenant-wide aggregation.
    if (subjectMissing) return this._emptyBcbaBoard();
    const today = this._todayWindow();
    const upcoming = this._upcomingWindow();
    const scoped = staffProfileId ? { staffProfileId } : {};
    const [todaySessions, sessions, documents, credentialExpirations] = await Promise.all([
      this.deps.repository.countSessionsInWindowByStatus(tenantId, { ...today, ...scoped }),
      this.deps.repository.countSessionsByStatus(tenantId, scoped),
      this.deps.repository.countDocumentsByStatus(tenantId),
      this.deps.repository.countCredentialsExpiringWithin(tenantId, 30),
    ]);
    const upcomingAppointments = await this.deps.repository.countAppointmentsInWindow(tenantId, { ...upcoming, ...scoped, status: 'SCHEDULED' });
    // Active plans this BCBA is responsible for when scoped; org-wide otherwise.
    const activeTreatmentPlans = staffProfileId
      ? await this.deps.repository.countActivePlansForBcba(tenantId, staffProfileId)
      : (await this.deps.repository.countPlansByStatus(tenantId)).ACTIVE ?? 0;
    const caseloadClients = await this.deps.repository.countAssignedClientsForStaff(tenantId, staffProfileId, 'BCBA');
    return {
      scope: 'bcba',
      staffProfileId: staffProfileId ?? null,
      generatedAt: this._now().toISOString(),
      caseloadClients,
      todaysSessions: sumCounts(todaySessions),
      todaysSessionsByStatus: todaySessions,
      upcomingAppointments,
      activeTreatmentPlans,
      // A BCBA's sign-off queue: sessions submitted for review + draft documents.
      pendingApprovals: (sessions.SUBMITTED ?? 0) + (documents.DRAFT ?? 0),
      draftSessions: sessions.DRAFT ?? 0,
      frozenSessions: sessions.FROZEN ?? 0,
      credentialExpirations,
    };
  }

  // --- RBT dashboard -------------------------------------------------------

  async rbtDashboard({ tenantId, staffProfileId, subjectMissing = false }) {
    if (subjectMissing) return this._emptyRbtBoard();
    const today = this._todayWindow();
    const upcoming = this._upcomingWindow();
    const scoped = staffProfileId ? { staffProfileId } : {};
    const [todaySessions, sessions] = await Promise.all([
      this.deps.repository.countSessionsInWindowByStatus(tenantId, { ...today, ...scoped }),
      this.deps.repository.countSessionsByStatus(tenantId, scoped),
    ]);
    const upcomingAppointments = await this.deps.repository.countAppointmentsInWindow(tenantId, { ...upcoming, ...scoped, status: 'SCHEDULED' });
    const assignedClients = await this.deps.repository.countAssignedClientsForStaff(tenantId, staffProfileId, 'RBT');
    return {
      scope: 'rbt',
      staffProfileId: staffProfileId ?? null,
      generatedAt: this._now().toISOString(),
      assignedClients,
      todaysSessions: sumCounts(todaySessions),
      todaysSessionsByStatus: todaySessions,
      upcomingAppointments,
      // The technician's own follow-through: sessions still in draft to complete.
      draftSessions: sessions.DRAFT ?? 0,
      submittedSessions: sessions.SUBMITTED ?? 0,
      frozenSessions: sessions.FROZEN ?? 0,
      sessionCompletion: sessionCompletion(sessions),
    };
  }

  // --- empty personal boards (subject profile unresolved) ------------------

  /** A BCBA board with everything zeroed — no repository access, no disclosure. */
  _emptyBcbaBoard() {
    const zeroByStatus = { DRAFT: 0, SUBMITTED: 0, FROZEN: 0 };
    return {
      scope: 'bcba',
      staffProfileId: null,
      generatedAt: this._now().toISOString(),
      caseloadClients: 0,
      todaysSessions: 0,
      todaysSessionsByStatus: zeroByStatus,
      upcomingAppointments: 0,
      activeTreatmentPlans: 0,
      pendingApprovals: 0,
      draftSessions: 0,
      frozenSessions: 0,
      credentialExpirations: 0,
    };
  }

  /** An RBT board with everything zeroed — no repository access, no disclosure. */
  _emptyRbtBoard() {
    const zeroByStatus = { DRAFT: 0, SUBMITTED: 0, FROZEN: 0 };
    return {
      scope: 'rbt',
      staffProfileId: null,
      generatedAt: this._now().toISOString(),
      assignedClients: 0,
      todaysSessions: 0,
      todaysSessionsByStatus: zeroByStatus,
      upcomingAppointments: 0,
      draftSessions: 0,
      submittedSessions: 0,
      frozenSessions: 0,
      sessionCompletion: sessionCompletion(zeroByStatus),
    };
  }
}

// --- pure metric derivations -----------------------------------------------

function sumCounts(map) {
  return Object.values(map).reduce((a, b) => a + b, 0);
}

/** Utilization as a rounded percentage of used vs authorized units (0 when none). */
function utilizationPercent({ authorizedUnits, usedUnits, activeAuthorizations }) {
  const pct = authorizedUnits > 0 ? Math.round((usedUnits / authorizedUnits) * 100) : 0;
  return { authorizedUnits, usedUnits, activeAuthorizations, utilizationPercent: pct };
}

/**
 * Session completion statistics: a frozen session is a completed clinical record;
 * total is all non-deleted sessions in scope. Percentage is rounded (0 when none).
 */
function sessionCompletion(byStatus) {
  const total = sumCounts(byStatus);
  const completed = byStatus.FROZEN ?? 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return { total, completed, draft: byStatus.DRAFT ?? 0, submitted: byStatus.SUBMITTED ?? 0, completionPercent: pct };
}
