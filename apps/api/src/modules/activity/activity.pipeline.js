import {
  Session, SessionTimeRecord, Appointment, StaffProfile, Client, ClientAssignment, PayRate,
} from '../../models/index.js';
import { PAYROLL_ELIGIBLE_STATES } from '../sessions/sessions.lifecycle.js';
import { projectStaffActivity } from './activity.projection.js';
import { resolveRoleKeys } from '../staff/staff.repository.js';

/**
 * THE authoritative activity pipeline (pipeline re-architecture, spec §3–§7).
 *
 * One batched, tenant-scoped fetch that returns the SINGLE dataset Payroll and
 * Billing both build on: the window's completed sessions, the authoritative
 * worked-minutes (SessionTimeRecord), the id→entity maps, the care-team ROLE
 * map, the effective HOURLY rate map, and the normalized activity rows. Because
 * both surfaces derive from this one function, they can never disagree about who
 * worked, in what role, for how long, or at what rate — which is the recurring
 * bug's real fix (an RBT can no longer be present in one surface and absent from
 * the other).
 *
 * Assumes an ACTIVE tenant context (the caller wraps this in withTenant), so the
 * tenant plugin scopes every query. One query per related collection across the
 * whole window — no per-staff / per-client N+1 (spec §26).
 *
 * `includeAmended`: Billing includes AMENDED sessions (they may already sit on a
 * claim); Payroll must not (an amended session is superseded — paying it would
 * double-pay, BR-PR-1). Default true; Payroll passes false.
 *
 * @param {{start:Date,end:Date}} window
 * @param {{ includeAmended?: boolean }} [opts]
 */
export async function loadStaffActivity(window, { includeAmended = true, statuses: explicitStatuses = null } = {}) {
  // `statuses` lets a caller name its population explicitly (Insurance Billing
  // also consumes clinician-completed SUBMITTED sessions); Payroll keeps its default.
  const statuses = explicitStatuses ?? (includeAmended ? ['FROZEN', 'AMENDED'] : [...PAYROLL_ELIGIBLE_STATES]);
  const sessions = await Session.find({
    status: { $in: statuses },
    deletedAt: null,
    startedAt: { $gte: window.start, $lt: window.end },
  }).sort({ startedAt: 1 }).lean();

  if (sessions.length === 0) {
    return {
      sessions: [],
      activities: [],
      workedById: new Map(),
      apptById: new Map(),
      staffById: new Map(),
      clientById: new Map(),
      roleByStaffId: new Map(),
      rateByStaffId: new Map(),
      payRatesByStaffId: new Map(),
    };
  }

  const sessionIds = sessions.map((s) => s._id);
  const apptIds = [...new Set(sessions.map((s) => s.appointmentId).filter(Boolean))];
  const staffIds = [...new Set(sessions.map((s) => s.staffProfileId).filter(Boolean))];
  const clientIds = [...new Set(sessions.map((s) => s.clientId).filter(Boolean))];

  const [timeRecords, appts, staff, clients, assignments, payRates] = await Promise.all([
    SessionTimeRecord.find({ sessionId: { $in: sessionIds } }).lean(),
    apptIds.length ? Appointment.find({ _id: { $in: apptIds } }).lean() : [],
    staffIds.length ? StaffProfile.find({ _id: { $in: staffIds } }).lean() : [],
    clientIds.length ? Client.find({ _id: { $in: clientIds } }).lean() : [],
    (clientIds.length && staffIds.length)
      ? ClientAssignment.find({ clientId: { $in: clientIds }, staffProfileId: { $in: staffIds }, role: { $in: ['BCBA', 'RBT'] } }).lean()
      : [],
    staffIds.length ? PayRate.find({ staffProfileId: { $in: staffIds }, rateType: 'HOURLY' }).sort({ effectiveFrom: -1 }).lean() : [],
  ]);

  const workedById = new Map(timeRecords.map((t) => [t.sessionId, t.workedMinutes]));
  const apptById = new Map(appts.map((a) => [a._id, a]));
  const staffById = new Map(staff.map((s) => [s._id, s]));
  const clientById = new Map(clients.map((c) => [c._id, c]));

  // Authoritative care-team ROLE per staff — the fallback used when a session's
  // appointment does not itself carry bcbaId/rbtId (e.g. a review-frozen RBT
  // session), so BCBA/RBT never collapses to "unknown".
  const roleByStaffId = new Map();
  for (const a of assignments) {
    if ((a.status ?? 'ACTIVE') !== 'ACTIVE') continue;
    if (!roleByStaffId.has(a.staffProfileId)) roleByStaffId.set(a.staffProfileId, a.role);
  }
  // Last fallback — the clinician's OWN role: their RBAC role key, else their
  // profile discipline, used only when it names exactly one of BCBA / RBT. A
  // clinician invited as an RBT whose session's appointment lacks rbtId and who
  // has no active care-team row is still billed and exported as the RBT.
  const unresolved = staff.filter((s) => !roleByStaffId.has(s._id));
  if (unresolved.length) {
    const keysByUser = await resolveRoleKeys(unresolved);
    for (const s of unresolved) {
      const role = clinicianRoleOf(keysByUser.get(s.userId), s.discipline);
      if (role) roleByStaffId.set(s._id, role);
    }
  }

  // Effective HOURLY compensation rate per staff, resolved as of the period
  // start (latest effectiveFrom ≤ asOf whose effectiveTo is unset or ≥ asOf).
  const rateByStaffId = effectiveRateMap(payRates, window.start);

  const activities = projectStaffActivity({
    sessions, workedById, apptById, staffById, clientById, roleByStaffId, rateByStaffId,
  });

  // Every HOURLY rate per staff member, newest first — Payroll applies the rate in
  // effect on each work date.
  const payRatesByStaffId = new Map(staffIds.map((id) => [id, []]));
  for (const r of payRates) payRatesByStaffId.get(r.staffProfileId)?.push(r);

  return { sessions, activities, workedById, apptById, staffById, clientById, roleByStaffId, rateByStaffId, payRatesByStaffId };
}

/** staffProfileId → { rateCents, rateType, currency } effective on `asOf`. */
export function effectiveRateMap(payRates, asOf) {
  const d = asOf ? new Date(asOf) : new Date();
  const map = new Map();
  for (const r of payRates) {
    if (new Date(r.effectiveFrom) > d) continue;
    if (r.effectiveTo && new Date(r.effectiveTo) < d) continue;
    if (!map.has(r.staffProfileId)) {
      map.set(r.staffProfileId, { rateCents: r.amount ?? null, rateType: r.rateType ?? null, currency: r.currency ?? 'usd' });
    }
  }
  return map;
}

/** 'BCBA' | 'RBT' from a clinician's RBAC role keys, else their discipline; null when absent or ambiguous. */
export function clinicianRoleOf(roleKeys = [], discipline = null) {
  const fromKeys = [...new Set((roleKeys ?? []).map((k) => String(k).toLowerCase()).filter((k) => k === 'bcba' || k === 'rbt'))];
  if (fromKeys.length === 1) return fromKeys[0].toUpperCase();
  if (fromKeys.length > 1) return null;
  const d = String(discipline ?? '').trim().toUpperCase();
  return d === 'BCBA' || d === 'RBT' ? d : null;
}
