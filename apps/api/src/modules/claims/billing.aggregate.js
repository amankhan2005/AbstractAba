import { computeLineAmount } from '../payroll/payroll.math.js';

/**
 * INSURANCE-BILLING ENGINE — pure, unit-tested. No I/O.
 *
 * A completed session is billing-ready AUTOMATICALLY — there is no manual
 * review or approval step. For every completed session the engine resolves:
 *
 *   worked time    SessionTimeRecord.workedMinutes (actual clock-in → clock-out)
 *   clinician      the session's staff member, as the client's BCBA or RBT
 *   hourly rate    that staff member's HOURLY PayRate (the Staff Profile rate,
 *                  integer cents) in effect on the service date — the same
 *                  effective-dated records payroll reads. When the first rate
 *                  was recorded after the session, that first recorded rate is
 *                  used. Never a default, never an authorization value.
 *   authorization  the session's persisted selection (else its appointment's
 *                  single booked authorization), resolved by INTERNAL id: it
 *                  must exist, not be archived / denied, belong to the client
 *                  and cover the service date. An authorization carries NO rate.
 *   insurance      the client's insurance in force on the service date
 *                  (not failed / needing correction, not private pay)
 *
 * Charges are computed per clinician and role, never across BCBA + RBT:
 *   charge = (Σ workedMinutes / 60) × hourly rate, rounded to the cent ONCE
 *   (payroll.math computeLineAmount), so 404 min at $50/hr is $336.67.
 * Client total = BCBA charge + RBT charge; company total = Σ client totals.
 *
 * A session that cannot be billed is INCOMPLETE — a billing-data gap the admin
 * fixes at its source (e.g. add the clinician's hourly rate); it becomes ready
 * on its own as soon as the data exists. Nothing is ever billed at $0.00 for a
 * missing rate.
 */

/** Session states that are completed for billing. AMENDED rows appear only when already billed. */
export const BILLABLE_SESSION_STATUSES = new Set(['FROZEN', 'SUBMITTED']);

export const BILLING_ISSUES = {
  MISSING_TIME_RECORD: 'Worked time is not available for this session',
  CLINICIAN_ROLE_UNKNOWN: 'Staff member is not assigned to this client as a BCBA or RBT',
  MISSING_HOURLY_RATE: 'Hourly rate is not available for this staff member',
  AUTHORIZATION_NOT_SELECTED: 'No authorization is linked to this session',
  AUTHORIZATION_NOT_FOUND: 'The linked authorization is no longer available',
  AUTHORIZATION_ARCHIVED: 'The linked authorization was archived',
  AUTHORIZATION_DENIED: 'The linked authorization was denied',
  AUTHORIZATION_INACTIVE: 'The linked authorization is not active',
  AUTHORIZATION_CLIENT_MISMATCH: 'The linked authorization belongs to another client',
  AUTHORIZATION_NOT_STARTED: 'The session took place before the authorization start date',
  AUTHORIZATION_EXPIRED: 'The session took place after the authorization end date',
  MISSING_PAYER: 'Insurance is not available for this client',
  INSURANCE_NOT_ACTIVE: 'The client’s insurance needs to be updated',
  COVERAGE_NOT_EFFECTIVE: 'The client’s insurance was not active on the session date',
  PRIVATE_PAY: 'This client is private pay and is not billed to insurance',
};

const issue = (code) => ({ code, label: BILLING_ISSUES[code] ?? code });

const roleFor = (staffProfileId, appt, roleByStaffId = new Map()) => {
  if (appt) {
    if (staffProfileId === appt.bcbaId) return 'BCBA';
    if (staffProfileId === appt.rbtId) return 'RBT';
  }
  return roleByStaffId.get(staffProfileId) ?? null;
};

/** The session's persisted authorization selection, else its appointment's only authorization. */
export function authorizationIdFor(session, appt) {
  if (Array.isArray(session.selectedAuthorizationIds) && session.selectedAuthorizationIds.length) return session.selectedAuthorizationIds[0];
  if (session.selectedAuthorizationId) return session.selectedAuthorizationId;
  const booked = appt ? (appt.authorizationIds?.length ? appt.authorizationIds : (appt.authorizationId ? [appt.authorizationId] : [])) : [];
  return booked.length === 1 ? booked[0] : null;
}

/** 'YYYY-MM-DD' for an instant on the organization's calendar. */
export function civilKey(instant, timeZone = 'UTC') {
  if (!instant) return null;
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** 'YYYY-MM-DD' of a date-only field stored at UTC midnight (authorization / coverage / rate dates). */
export function dateOnlyKey(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// The staff hourly rate for a work date and the exact cent split are shared
// with Payroll (one Staff Profile rate rule, one rounding rule).
export { applicableHourlyRate as hourlyRateFor, allocateCents } from '../payroll/payroll.math.js';
import { applicableHourlyRate as hourlyRateFor, allocateCents } from '../payroll/payroll.math.js';

/** The client's usable insurance on a service date, or the reason there is none. */
export function resolvePayer(coverages, serviceDateKey) {
  const live = (coverages ?? []).filter((c) => !c.deletedAt);
  if (live.length === 0) return { reason: 'MISSING_PAYER' };
  const insured = live.filter((c) => c.fundingSource !== 'PRIVATE_PAY');
  if (insured.length === 0) return { reason: 'PRIVATE_PAY' };
  const usable = insured.filter((c) => !['FAILED', 'NEEDS_CORRECTION'].includes(c.verificationStatus));
  if (usable.length === 0) return { reason: 'INSURANCE_NOT_ACTIVE' };
  const inForce = (c) => {
    const from = dateOnlyKey(c.effectiveFrom);
    const to = dateOnlyKey(c.effectiveTo);
    return (!from || !serviceDateKey || serviceDateKey >= from) && (!to || !serviceDateKey || serviceDateKey <= to);
  };
  const order = { PRIMARY: 0, SECONDARY: 1, TERTIARY: 2 };
  const match = usable.filter(inForce).sort((a, b) => (order[a.benefitOrder] ?? 9) - (order[b.benefitOrder] ?? 9))[0];
  return match ? { payerName: match.payerName ?? null, coverageId: match._id ?? match.id ?? null } : { reason: 'COVERAGE_NOT_EFFECTIVE' };
}

/**
 * One client's billing (sessions in any order).
 *
 * @param {object} p
 * @param {Array}  p.sessions               completed sessions for the client (FROZEN / SUBMITTED / AMENDED)
 * @param {Map}    p.workedById             sessionId → SessionTimeRecord.workedMinutes
 * @param {Map}    p.apptById               appointmentId → appointment
 * @param {Map}    p.staffById              staffProfileId → staff profile
 * @param {Map}    p.authById               authorizationId → normalized authorization (no rate)
 * @param {Map}    p.payRatesByStaffId      staffProfileId → PayRate[] (HOURLY, cents)
 * @param {Map}    [p.claimedLineBySession] sessionId → { charge, claimId, claimNumber }
 * @param {Map}    [p.coveragesByClient]    clientId → InsuranceCoverage[] (omit to skip the insurance rule)
 * @param {Map}    [p.roleByStaffId]        staffProfileId → care-team role
 * @param {string} [p.timeZone]
 */
export function aggregateChildBilling({
  sessions = [], workedById = new Map(), apptById = new Map(), staffById = new Map(), authById = new Map(),
  payRatesByStaffId = new Map(), claimedLineBySession = new Map(), coveragesByClient = null,
  roleByStaffId = new Map(), timeZone = 'UTC', window = {},
}) {
  const nameOf = (id) => { const s = staffById.get(id); return s ? ([s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ').trim() || null) : null; };

  const rows = [];
  const ordered = [...sessions].sort((a, b) => new Date(a.startedAt ?? 0) - new Date(b.startedAt ?? 0));
  for (const s of ordered) {
    const sid = s._id ?? s.id;
    const claimed = claimedLineBySession.get(sid) ?? null;
    // A superseded (AMENDED) session is only shown when it was already billed.
    if (!claimed && !BILLABLE_SESSION_STATUSES.has(s.status)) continue;

    const appt = apptById.get(s.appointmentId) || null;
    const role = roleFor(s.staffProfileId, appt, roleByStaffId);
    const hasRecord = workedById.has(sid) && Number.isFinite(Number(workedById.get(sid)));
    const workedMinutes = hasRecord ? Math.max(0, Math.round(Number(workedById.get(sid)))) : 0;
    const serviceDate = civilKey(s.startedAt, timeZone);
    const authId = authorizationIdFor(s, appt);
    const auth = authId ? (authById.get(authId) || null) : null;
    const hourlyRate = hourlyRateFor(payRatesByStaffId.get(s.staffProfileId), s.startedAt);
    const payer = coveragesByClient ? resolvePayer(coveragesByClient.get(s.clientId), serviceDate) : {};

    const issues = [];
    if (!claimed) {
      if (!hasRecord) issues.push(issue('MISSING_TIME_RECORD'));
      if (!role) issues.push(issue('CLINICIAN_ROLE_UNKNOWN'));
      if (hourlyRate == null) issues.push(issue('MISSING_HOURLY_RATE'));
      if (!authId) issues.push(issue('AUTHORIZATION_NOT_SELECTED'));
      else if (!auth) issues.push(issue('AUTHORIZATION_NOT_FOUND'));
      else {
        if (auth.deletedAt) issues.push(issue('AUTHORIZATION_ARCHIVED'));
        else if (auth.status === 'DENIED') issues.push(issue('AUTHORIZATION_DENIED'));
        else if (['REVOKED', 'EXPIRED', 'PENDING'].includes(auth.status)) issues.push(issue('AUTHORIZATION_INACTIVE'));
        if (auth.clientId && s.clientId && auth.clientId !== s.clientId) issues.push(issue('AUTHORIZATION_CLIENT_MISMATCH'));
        const startKey = dateOnlyKey(auth.startDate);
        const endKey = dateOnlyKey(auth.endDate);
        if (serviceDate && startKey && serviceDate < startKey) issues.push(issue('AUTHORIZATION_NOT_STARTED'));
        if (serviceDate && endKey && serviceDate > endKey) issues.push(issue('AUTHORIZATION_EXPIRED'));
      }
      if (payer.reason) issues.push(issue(payer.reason));
    }

    rows.push({
      sessionId: sid,
      appointmentId: s.appointmentId ?? null,
      clientId: s.clientId ?? null,
      staffProfileId: s.staffProfileId,
      staffName: nameOf(s.staffProfileId),
      role,
      status: s.status ?? null,
      source: s.source ?? null,
      serviceDate,
      workDate: s.startedAt ?? null,
      clockInAt: s.clockInAt ?? s.startedAt ?? null,
      clockOutAt: s.clockOutAt ?? s.endedAt ?? null,
      workedMinutes,
      workedHours: workedMinutes / 60,
      intervals: (s.intervals ?? []).filter((iv) => iv?.startedAt && iv?.endedAt),
      authorizationId: authId,
      authorizationNumber: auth?.authorizationNumber ?? null,
      billingCode: auth?.billingCode ?? null,
      payerName: payer.payerName ?? null,
      coverageId: payer.coverageId ?? null,
      hourlyRate: claimed?.hourlyRate ?? hourlyRate,
      amount: claimed ? (claimed.charge ?? null) : null, // ready amounts are allocated below
      claimId: claimed?.claimId ?? null,
      claimNumber: claimed?.claimNumber ?? null,
      billingStatus: claimed ? 'BILLED' : (issues.length ? 'INCOMPLETE' : 'READY'),
      issues,
      issue: issues[0]?.label ?? null,
    });
  }

  // Charges per clinician + role + rate: (Σ minutes / 60) × rate, rounded once,
  // then allocated back to that group's sessions so every figure reconciles.
  const readyGroups = new Map();
  for (const r of rows) {
    if (r.billingStatus !== 'READY') continue;
    const key = `${r.staffProfileId}|${r.role}|${r.hourlyRate}`;
    if (!readyGroups.has(key)) readyGroups.set(key, []);
    readyGroups.get(key).push(r);
  }
  for (const list of readyGroups.values()) {
    const minutes = list.map((r) => r.workedMinutes);
    const charge = computeLineAmount({ rateType: 'HOURLY', rateAmount: list[0].hourlyRate, minutes: minutes.reduce((t, m) => t + m, 0) });
    allocateCents(charge, minutes).forEach((cents, i) => { list[i].amount = cents; });
  }

  return summarizeRows(rows, { authById, window });
}

/** Clinicians, authorizations and totals for one client's rows (preview or generated). */
function summarizeRows(rows, { authById = new Map(), window = {} } = {}) {
  const counted = (r) => r.billingStatus !== 'INCOMPLETE';
  const sumCharge = (list) => list.reduce((t, r) => t + (counted(r) ? r.amount ?? 0 : 0), 0);

  // Clinicians — one entry per staff member and role, never merged.
  const staffAgg = new Map();
  for (const r of rows) {
    const key = `${r.staffProfileId}:${r.role ?? ''}`;
    if (!staffAgg.has(key)) staffAgg.set(key, { staffProfileId: r.staffProfileId, staffName: r.staffName, role: r.role, rows: [] });
    staffAgg.get(key).rows.push(r);
  }
  const staff = [...staffAgg.values()].map(({ rows: list, ...st }) => {
    const rates = [...new Set(list.map((r) => r.hourlyRate).filter((v) => v != null))];
    const billable = list.filter(counted);
    return {
      ...st,
      sessions: list.length,
      workedMinutes: list.reduce((t, r) => t + r.workedMinutes, 0),
      billableMinutes: billable.reduce((t, r) => t + r.workedMinutes, 0),
      hourlyRate: rates.length === 1 ? rates[0] : null,
      hourlyRates: rates,
      charge: sumCharge(list),
      readyCount: list.filter((r) => r.billingStatus === 'READY').length,
      billedCount: list.filter((r) => r.billingStatus === 'BILLED').length,
      incompleteCount: list.filter((r) => r.billingStatus === 'INCOMPLETE').length,
    };
  }).sort((a, b) => (a.staffName || '').localeCompare(b.staffName || ''));

  const authAgg = new Map();
  for (const r of rows) {
    if (!r.authorizationId) continue;
    if (!authAgg.has(r.authorizationId)) authAgg.set(r.authorizationId, []);
    authAgg.get(r.authorizationId).push(r);
  }
  const authorizations = [...authAgg.entries()].map(([authorizationId, list]) => {
    const a = authById.get(authorizationId) || {};
    return {
      authorizationId,
      authorizationNumber: a.authorizationNumber ?? null,
      billingCode: a.billingCode ?? null,
      serviceType: a.serviceType ?? null,
      startDate: dateOnlyKey(a.startDate),
      endDate: dateOnlyKey(a.endDate),
      sessions: list.length,
      workedMinutes: list.reduce((t, r) => t + r.workedMinutes, 0),
      charge: sumCharge(list),
    };
  }).sort((x, y) => (x.authorizationNumber || '').localeCompare(y.authorizationNumber || ''));

  const byRole = (role) => rows.filter((r) => r.role === role);
  const readyRows = rows.filter((r) => r.billingStatus === 'READY');
  const billedRows = rows.filter((r) => r.billingStatus === 'BILLED');
  const summary = {
    periodStart: window.start ?? null,
    periodEnd: window.end ?? null,
    totalSessions: rows.length,
    totalWorkedMinutes: rows.reduce((t, r) => t + r.workedMinutes, 0),
    bcbaSessions: byRole('BCBA').length,
    rbtSessions: byRole('RBT').length,
    bcbaWorkedMinutes: byRole('BCBA').reduce((t, r) => t + r.workedMinutes, 0),
    rbtWorkedMinutes: byRole('RBT').reduce((t, r) => t + r.workedMinutes, 0),
    bcbaCharge: sumCharge(byRole('BCBA')),
    rbtCharge: sumCharge(byRole('RBT')),
    readyCount: readyRows.length,
    billedCount: billedRows.length,
    incompleteCount: rows.length - readyRows.length - billedRows.length,
    readyAmount: sumCharge(readyRows),
    billedAmount: sumCharge(billedRows),
    totalCharge: sumCharge(rows),
    currency: 'usd',
  };

  return { authorizations, staff, sessions: rows, summary };
}

/** Billing-data issues across rows: [{ code, label, count, staff:[names] }], most frequent first. */
function issueCounts(rows) {
  const counts = new Map();
  for (const r of rows) {
    if (r.billingStatus !== 'INCOMPLETE') continue;
    for (const x of r.issues) {
      if (!counts.has(x.code)) counts.set(x.code, { code: x.code, label: x.label, count: 0, staff: new Set(), clients: new Set() });
      const c = counts.get(x.code);
      c.count += 1;
      if (r.staffName) c.staff.add(r.staffName);
      if (r.clientName) c.clients.add(r.clientName);
    }
  }
  return [...counts.values()].map((c) => ({ ...c, staff: [...c.staff].sort(), clients: [...c.clients].sort() })).sort((a, b) => b.count - a.count);
}

/**
 * COMPANY-WIDE billing: the period's completed sessions grouped by client, each
 * client resolved by aggregateChildBilling. Client total = BCBA + RBT charge;
 * company total = Σ client totals.
 */
export function aggregateCompanyBilling({ sessions = [], clientById = new Map(), ...rest }) {
  const byClient = new Map();
  for (const s of sessions) {
    if (s.clientId == null) continue;
    if (!byClient.has(s.clientId)) byClient.set(s.clientId, []);
    byClient.get(s.clientId).push(s);
  }
  const clients = [];
  for (const [clientId, clientSessions] of byClient) {
    const agg = aggregateChildBilling({ ...rest, sessions: clientSessions });
    if (agg.sessions.length === 0) continue;
    clients.push(clientEntry(clientId, clientById.get(clientId), agg));
  }
  return companyResult(clients, rest.window);
}

/** A client's billing entry: BCBA and RBT separately, client total = BCBA + RBT. */
function clientEntry(clientId, c, agg) {
  const clientName = c ? ([c.firstName, c.middleName, c.lastName].filter(Boolean).join(' ').trim() || c.clientNumber || null) : null;
  for (const r of agg.sessions) r.clientName = clientName;
  const sm = agg.summary;
  return {
    clientId,
    clientName,
    clientNumber: c?.clientNumber ?? null,
    payerName: [...new Set(agg.sessions.map((r) => r.payerName).filter(Boolean))].join(', ') || null,
    bcbaStaff: agg.staff.filter((s) => s.role === 'BCBA'),
    rbtStaff: agg.staff.filter((s) => s.role === 'RBT'),
    unassignedStaff: agg.staff.filter((s) => !s.role),
    authorizations: agg.authorizations,
    sessions: agg.sessions,
    totalSessions: sm.totalSessions,
    totalWorkedMinutes: sm.totalWorkedMinutes,
    bcbaSessions: sm.bcbaSessions,
    rbtSessions: sm.rbtSessions,
    bcbaWorkedMinutes: sm.bcbaWorkedMinutes,
    rbtWorkedMinutes: sm.rbtWorkedMinutes,
    bcbaCharge: sm.bcbaCharge,
    rbtCharge: sm.rbtCharge,
    // Sessions without a BCBA/RBT role are never billable, so this is exact.
    clientTotal: sm.bcbaCharge + sm.rbtCharge,
    readyAmount: sm.readyAmount,
    billedAmount: sm.billedAmount,
    readyCount: sm.readyCount,
    billedCount: sm.billedCount,
    incompleteCount: sm.incompleteCount,
    issues: issueCounts(agg.sessions),
    status: sm.incompleteCount > 0 ? 'INCOMPLETE' : (sm.readyCount > 0 ? 'READY' : 'BILLED'),
  };
}

/** Clients sorted by name plus the company summary (total = Σ client totals). */
function companyResult(clients, window = {}) {
  clients.sort((a, b) => (a.clientName || '').localeCompare(b.clientName || ''));
  const allRows = clients.flatMap((c) => c.sessions);
  const sum = (k) => clients.reduce((t, c) => t + c[k], 0);
  const summary = {
    periodStart: window?.start ?? null,
    periodEnd: window?.end ?? null,
    totalClients: clients.length,
    totalSessions: allRows.length,
    bcbaSessions: sum('bcbaSessions'),
    rbtSessions: sum('rbtSessions'),
    bcbaWorkedMinutes: sum('bcbaWorkedMinutes'),
    rbtWorkedMinutes: sum('rbtWorkedMinutes'),
    totalWorkedMinutes: sum('totalWorkedMinutes'),
    bcbaCharge: sum('bcbaCharge'),
    rbtCharge: sum('rbtCharge'),
    readyToBill: sum('readyCount'),
    alreadyBilled: sum('billedCount'),
    incomplete: sum('incompleteCount'),
    readyAmount: sum('readyAmount'),
    billedAmount: sum('billedAmount'),
    // TOTAL COMPANY INSURANCE BILLING for the period (ready + already billed).
    totalBillableAmount: sum('clientTotal'),
    issues: issueCounts(allRows),
    currency: 'usd',
  };
  return { clients, summary };
}

/**
 * THE GENERATED BILL — read back from what generation PERSISTED: each claim
 * line's session, role, worked minutes, hourly rate and charge. Nothing is
 * recalculated, so the bill (and its Excel / PDF) always equals what was
 * generated, even if a rate or a session changes afterwards. A line generated
 * before its role was stored resolves the role the same way billing does
 * (appointment → care team → staff role), never by guessing.
 */
export function aggregateGeneratedBill({ claims = [], lines = [], sessionsById = new Map(), apptById = new Map(), staffById = new Map(), clientById = new Map(), authById = new Map(), roleByStaffId = new Map(), timeZone = 'UTC', window = {} }) {
  const claimById = new Map(claims.map((c) => [c._id ?? c.id, c]));
  const nameOf = (id) => { const s = staffById.get(id); return s ? ([s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ').trim() || null) : null; };
  const rowsByClient = new Map();
  const ordered = [...lines].sort((a, b) => new Date(a.serviceDate) - new Date(b.serviceDate));
  for (const l of ordered) {
    const claim = claimById.get(l.claimId);
    if (!claim) continue;
    const session = sessionsById.get(l.sessionId) || {};
    const role = l.role ?? roleFor(l.staffProfileId, apptById.get(session.appointmentId) || null, roleByStaffId);
    const auth = l.authorizationId ? authById.get(l.authorizationId) : null;
    const workedMinutes = Number.isFinite(l.workedMinutes) ? l.workedMinutes : 0;
    const row = {
      sessionId: l.sessionId,
      appointmentId: session.appointmentId ?? null,
      clientId: claim.clientId,
      staffProfileId: l.staffProfileId,
      staffName: nameOf(l.staffProfileId),
      role,
      status: session.status ?? null,
      source: session.source ?? null,
      serviceDate: civilKey(l.serviceDate, timeZone),
      workDate: l.serviceDate,
      clockInAt: session.clockInAt ?? session.startedAt ?? null,
      clockOutAt: session.clockOutAt ?? session.endedAt ?? null,
      workedMinutes,
      workedHours: workedMinutes / 60,
      intervals: (session.intervals ?? []).filter((iv) => iv?.startedAt && iv?.endedAt),
      authorizationId: l.authorizationId ?? null,
      authorizationNumber: auth?.authorizationNumber ?? null,
      billingCode: l.serviceCode ?? auth?.billingCode ?? null,
      payerName: claim.payerName ?? null,
      coverageId: null,
      hourlyRate: l.hourlyRate ?? null,
      amount: l.charge,
      claimId: claim._id ?? claim.id,
      claimNumber: claim.claimNumber ?? null,
      billingStatus: 'BILLED',
      issues: [],
      issue: null,
    };
    if (!rowsByClient.has(claim.clientId)) rowsByClient.set(claim.clientId, []);
    rowsByClient.get(claim.clientId).push(row);
  }
  const clients = [...rowsByClient.entries()].map(([clientId, rows]) => clientEntry(clientId, clientById.get(clientId), summarizeRows(rows, { authById, window })));
  return companyResult(clients, window);
}
