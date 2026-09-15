import {
  Client,
  Guardian,
  StaffProfile,
  Credential,
  Appointment,
  Authorization,
  ServiceAuthorization,
  TreatmentPlan,
  Session,
  SessionTimeRecord,
  ClinicalDocument,
  ClientAssignment,
} from '../../models/index.js';
import { withTenant } from '../../tenancy/tenantContext.js';
import { resolveRoleKeys } from '../staff/staff.repository.js';
import { VALID_PARENT_GUARDIAN_QUERY, deriveAccountStatus } from '../clients/clients.alerts.js';

/**
 * Read-only aggregation for the role dashboards. Every method runs under
 * withTenant() so the tenant plugin scopes the query to the active tenant and
 * fails closed without a context — dashboards never see across tenants and never
 * write. These are counts and small grouped reads over the existing clinical
 * collections; nothing here mutates state, and no method is catalogued for audit
 * (reads are never audited).
 */
export class DashboardsRepository {
  // --- clients -------------------------------------------------------------

  async countClientsByStatus(tenantId) {
    return withTenant(tenantId, async () => {
      const rows = await Client.aggregate([
        { $match: { deletedAt: null } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);
      return countMap(rows);
    });
  }

  /** Client ACCOUNT status counts (Active / Hold / Discharged) — the Clients page's rule. */
  async countClientsByAccountStatus(tenantId) {
    return withTenant(tenantId, async () => {
      const [clients, validIds] = await Promise.all([
        Client.find({ deletedAt: null }).select({ _id: 1, status: 1 }).lean(),
        Guardian.distinct('clientId', VALID_PARENT_GUARDIAN_QUERY),
      ]);
      const valid = new Set(validIds);
      const out = { ACTIVE: 0, HOLD: 0, DISCHARGED: 0 };
      for (const c of clients) out[deriveAccountStatus({ status: c.status, hasValidParent: valid.has(c._id) })] += 1;
      return out;
    });
  }

  // --- staff & credentials -------------------------------------------------

  async countStaffByStatus(tenantId) {
    return withTenant(tenantId, async () => {
      const rows = await StaffProfile.aggregate([
        { $match: { deletedAt: null } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);
      return countMap(rows);
    });
  }

  /** Credentials expiring within `days` and not already lapsed (ACTIVE only). */
  async countCredentialsExpiringWithin(tenantId, days) {
    return withTenant(tenantId, async () => {
      const now = new Date();
      const horizon = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      return Credential.countDocuments({
        deletedAt: null,
        status: 'ACTIVE',
        expiresDate: { $ne: null, $gte: now, $lte: horizon },
      });
    });
  }

  // --- scheduling ----------------------------------------------------------

  /**
   * SCHEDULED appointments whose start falls inside [from, to). Optionally scoped
   * to one staff member. Used for "today's sessions" and "upcoming appointments".
   */
  async countAppointmentsInWindow(tenantId, { from, to, staffProfileId, status = 'SCHEDULED' }) {
    return withTenant(tenantId, async () => {
      const filter = { deletedAt: null, status, startAt: { $gte: from, $lt: to } };
      if (staffProfileId) filter.staffProfileId = staffProfileId;
      return Appointment.countDocuments(filter);
    });
  }

  /**
   * Authorization utilization across ACTIVE authorizations: total authorized and
   * used units, so the service can derive a utilization percentage.
   */
  async authorizationUtilization(tenantId) {
    return withTenant(tenantId, async () => {
      const rows = await Authorization.aggregate([
        { $match: { deletedAt: null, status: 'ACTIVE' } },
        { $group: { _id: null, authorized: { $sum: '$authorizedUnits' }, used: { $sum: '$usedUnits' }, count: { $sum: 1 } } },
      ]);
      const r = rows[0] ?? { authorized: 0, used: 0, count: 0 };
      return { authorizedUnits: r.authorized ?? 0, usedUnits: r.used ?? 0, activeAuthorizations: r.count ?? 0 };
    });
  }

  // --- plans ---------------------------------------------------------------

  async countPlansByStatus(tenantId) {
    return withTenant(tenantId, async () => {
      const rows = await TreatmentPlan.aggregate([
        { $match: { deletedAt: null } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);
      return countMap(rows);
    });
  }

  /** ACTIVE plans whose responsible BCBA is the given staff member. */
  async countActivePlansForBcba(tenantId, staffProfileId) {
    return withTenant(tenantId, async () =>
      TreatmentPlan.countDocuments({ deletedAt: null, status: 'ACTIVE', responsibleBcbaStaffId: staffProfileId }),
    );
  }

  /**
   * Distinct children a staff member is actively assigned to (their caseload).
   * `role` narrows it (BCBA vs RBT); omit to count any active assignment. Counts
   * distinct clientIds so multiple roles on one child don't inflate the number.
   */
  async countAssignedClientsForStaff(tenantId, staffProfileId, role) {
    if (!staffProfileId) return 0;
    return withTenant(tenantId, async () => {
      const filter = { deletedAt: null, status: 'ACTIVE', staffProfileId, ...(role ? { role } : {}) };
      const ids = await ClientAssignment.distinct('clientId', filter);
      return ids.length;
    });
  }

  // --- sessions ------------------------------------------------------------

  async countSessionsByStatus(tenantId, { staffProfileId } = {}) {
    return withTenant(tenantId, async () => {
      const match = { deletedAt: null };
      if (staffProfileId) match.staffProfileId = staffProfileId;
      const rows = await Session.aggregate([
        { $match: match },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);
      return countMap(rows);
    });
  }

  /** Sessions started inside [from, to), grouped by status — "today's sessions". */
  async countSessionsInWindowByStatus(tenantId, { from, to, staffProfileId }) {
    return withTenant(tenantId, async () => {
      const match = { deletedAt: null, startedAt: { $gte: from, $lt: to } };
      if (staffProfileId) match.staffProfileId = staffProfileId;
      const rows = await Session.aggregate([
        { $match: match },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);
      return countMap(rows);
    });
  }

  // --- documents -----------------------------------------------------------

  async countDocumentsByStatus(tenantId) {
    return withTenant(tenantId, async () => {
      const rows = await ClinicalDocument.aggregate([
        { $match: { deletedAt: null } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);
      return countMap(rows);
    });
  }

  // --- Company dashboard reads (GET /dashboards/company) --------------------
  //
  // Data access only: the service applies the business rules (completion,
  // expiry, derived session status, business date). Every read is tenant-scoped
  // under withTenant, projects only what the dashboard shows, and resolves names
  // in one batched lookup per collection (no N+1).

  /** ACTIVE staff profiles per clinical role (RBAC role keys bcba / rbt). */
  async activeClinicianCounts(tenantId) {
    return withTenant(tenantId, async () => {
      const staff = await StaffProfile.find({ deletedAt: null, status: 'ACTIVE' }).select({ _id: 1, userId: 1 }).lean();
      const keys = await resolveRoleKeys(staff);
      let BCBA = 0; let RBT = 0;
      for (const sp of staff) {
        const roles = keys.get(sp.userId) ?? [];
        if (roles.includes('bcba')) BCBA += 1;
        if (roles.includes('rbt')) RBT += 1;
      }
      return { BCBA, RBT, activeStaff: staff.length };
    });
  }

  /**
   * Clients whose required onboarding can still be open (not discharged or
   * archived), with their non-deleted guardians' contact completeness fields.
   * Oldest first, so the longest-waiting client leads.
   */
  async clientsForCompletionReview(tenantId, { statuses }) {
    return withTenant(tenantId, async () => {
      const clients = await Client.find({ deletedAt: null, status: { $in: statuses } })
        .select({ _id: 1, firstName: 1, lastName: 1, preferredName: 1, status: 1, intakeWorkflowStatus: 1, createdAt: 1 })
        .sort({ createdAt: 1, _id: 1 })
        .lean();
      if (!clients.length) return [];
      const guardians = await Guardian.find({ deletedAt: null, clientId: { $in: clients.map((c) => c._id) } })
        .select({ clientId: 1, firstName: 1, lastName: 1, phone: 1, email: 1 })
        .lean();
      const byClient = new Map();
      for (const g of guardians) {
        if (!byClient.has(g.clientId)) byClient.set(g.clientId, []);
        byClient.get(g.clientId).push(g);
      }
      return clients.map((c) => ({
        clientId: c._id,
        clientName: clientName(c),
        status: c.status,
        intakeWorkflowStatus: c.intakeWorkflowStatus ?? 'NOT_SENT',
        guardians: byClient.get(c._id) ?? [],
      }));
    });
  }

  /**
   * Non-deleted ABA/FBA authorizations of non-deleted clients whose end date
   * falls in [from, to] — the candidate set the expiry rule is applied to.
   */
  async authorizationsEndingBetween(tenantId, { from, to }) {
    return withTenant(tenantId, async () => {
      const auths = await ServiceAuthorization.find({ deletedAt: null, endDate: { $ne: null, $gte: from, $lte: to } })
        .select({ _id: 1, clientId: 1, serviceType: 1, status: 1, authorizationNumber: 1, billingCode: 1, endDate: 1 })
        .sort({ endDate: 1, _id: 1 })
        .lean();
      if (!auths.length) return [];
      const clients = await Client.find({ deletedAt: null, _id: { $in: [...new Set(auths.map((a) => a.clientId))] } })
        .select({ _id: 1, firstName: 1, lastName: 1, preferredName: 1 }).lean();
      const byId = new Map(clients.map((c) => [c._id, c]));
      return auths.filter((a) => byId.has(a.clientId)).map((a) => ({
        authorizationId: a._id,
        clientId: a.clientId,
        clientName: clientName(byId.get(a.clientId)),
        serviceType: a.serviceType,
        status: a.status,
        authorizationNumber: a.authorizationNumber ?? null,
        billingCode: a.billingCode ?? null,
        endDate: a.endDate,
      }));
    });
  }

  /**
   * Appointments whose scheduled span overlaps [from, to) — every appointment
   * with an occurrence on the business day (single- and multi-date, timed and
   * date-only, manual-session appointments included) — with their live
   * sessions, those sessions' time records, and client / clinician names.
   */
  async appointmentsForDay(tenantId, { from, to }) {
    return withTenant(tenantId, async () => {
      const appts = await Appointment.find({
        deletedAt: null,
        startAt: { $lt: to },
        $or: [{ endAt: { $gt: from } }, { endAt: null, startAt: { $gte: from } }],
      })
        .select({ _id: 1, clientId: 1, bcbaId: 1, rbtId: 1, staffProfileId: 1, startAt: 1, endAt: 1, timeSet: 1, status: 1 })
        .sort({ startAt: 1, _id: 1 })
        .lean();
      if (!appts.length) return { appointments: [], sessions: [], timeRecords: [], clientNames: new Map(), staffNames: new Map() };
      const sessions = await Session.find({ deletedAt: null, appointmentId: { $in: appts.map((a) => a._id) } })
        .select({ _id: 1, appointmentId: 1, staffProfileId: 1, status: 1, source: 1, startedAt: 1, endedAt: 1, clockInAt: 1, intervals: 1 })
        .lean();
      const [timeRecords, clientNames, staffNames] = await Promise.all([
        sessions.length
          ? SessionTimeRecord.find({ sessionId: { $in: sessions.map((x) => x._id) } }).select({ sessionId: 1, startedAt: 1, endedAt: 1, workedMinutes: 1 }).lean()
          : [],
        this._clientNames(appts.map((a) => a.clientId)),
        this._staffNames(appts.flatMap((a) => [a.bcbaId, a.rbtId, a.staffProfileId])),
      ]);
      return {
        appointments: appts.map(({ _id, ...a }) => ({ id: _id, ...a })),
        sessions: sessions.map(({ _id, ...x }) => ({ id: _id, ...x })),
        timeRecords,
        clientNames,
        staffNames,
      };
    });
  }

  /**
   * The latest `limit` persisted sessions (normal and manual) by when the work
   * started, newest first, with their appointment's clinician assignment, time
   * record and names.
   */
  async latestSessions(tenantId, limit = 4) {
    return withTenant(tenantId, async () => {
      const sessions = await Session.find({ deletedAt: null })
        .select({ _id: 1, appointmentId: 1, clientId: 1, staffProfileId: 1, status: 1, source: 1, startedAt: 1, endedAt: 1 })
        .sort({ startedAt: -1, _id: -1 })
        .limit(limit)
        .lean();
      if (!sessions.length) return { sessions: [], appointments: [], timeRecords: [], clientNames: new Map(), staffNames: new Map() };
      const [appointments, timeRecords, clientNames, staffNames] = await Promise.all([
        Appointment.find({ _id: { $in: sessions.map((x) => x.appointmentId) } }).select({ _id: 1, bcbaId: 1, rbtId: 1 }).lean(),
        SessionTimeRecord.find({ sessionId: { $in: sessions.map((x) => x._id) } }).select({ sessionId: 1, workedMinutes: 1, startedAt: 1, endedAt: 1 }).lean(),
        this._clientNames(sessions.map((x) => x.clientId)),
        this._staffNames(sessions.map((x) => x.staffProfileId)),
      ]);
      return {
        sessions: sessions.map(({ _id, ...x }) => ({ id: _id, ...x })),
        appointments: appointments.map(({ _id, ...a }) => ({ id: _id, ...a })),
        timeRecords,
        clientNames,
        staffNames,
      };
    });
  }

  /**
   * Persisted sessions that started inside [from, to) with what the service
   * needs to split them by clinical role: each session's own appointment
   * assignment (bcbaId / rbtId) and its SessionTimeRecord worked minutes.
   * Batched: one read per collection.
   */
  async sessionsInWindowWithRoles(tenantId, { from, to }) {
    return withTenant(tenantId, async () => {
      const sessions = await Session.find({ deletedAt: null, startedAt: { $gte: from, $lt: to } })
        .select({ _id: 1, appointmentId: 1, staffProfileId: 1, status: 1 })
        .lean();
      if (!sessions.length) return { sessions: [], appointments: [], timeRecords: [] };
      const apptIds = [...new Set(sessions.map((x) => x.appointmentId).filter(Boolean))];
      const [appointments, timeRecords] = await Promise.all([
        apptIds.length ? Appointment.find({ _id: { $in: apptIds } }).select({ _id: 1, bcbaId: 1, rbtId: 1 }).lean() : [],
        SessionTimeRecord.find({ sessionId: { $in: sessions.map((x) => x._id) } }).select({ sessionId: 1, workedMinutes: 1 }).lean(),
      ]);
      return {
        sessions: sessions.map(({ _id, ...x }) => ({ id: _id, ...x })),
        appointments: appointments.map(({ _id, ...a }) => ({ id: _id, ...a })),
        timeRecords,
      };
    });
  }

  /** id → display name, one query (runs inside the caller's tenant context). */
  async _clientNames(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = await Client.find({ _id: { $in: unique } }).select({ _id: 1, firstName: 1, lastName: 1, preferredName: 1 }).lean();
    return new Map(rows.map((c) => [c._id, clientName(c)]));
  }

  async _staffNames(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = await StaffProfile.find({ _id: { $in: unique } }).select({ _id: 1, firstName: 1, lastName: 1 }).lean();
    return new Map(rows.map((sp) => [sp._id, joinName(sp.firstName, sp.lastName)]));
  }
}

/** The same display convention scheduling uses: preferred name, else first + last. */
function clientName(c) {
  if (!c) return null;
  const preferred = c.preferredName && String(c.preferredName).trim();
  return preferred || joinName(c.firstName, c.lastName);
}

function joinName(...parts) {
  const name = parts.filter((x) => x != null && String(x).trim() !== '').map((x) => String(x).trim()).join(' ');
  return name || null;
}

/** Turn [{_id:'ACTIVE',count:3}] into { ACTIVE: 3 }, dropping null keys. */
function countMap(rows) {
  const out = {};
  for (const r of rows) {
    if (r._id === null || r._id === undefined) continue;
    out[r._id] = r.count;
  }
  return out;
}

export const dashboardsRepository = new DashboardsRepository();
