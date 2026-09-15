/**
 * ONE AUTHORITATIVE STAFF-ACTIVITY PROJECTION (pipeline re-architecture).
 *
 * This is the single, pure place that normalizes a completed session into the
 * canonical activity row Payroll and Billing BOTH derive from. Before this,
 * Payroll and Billing each independently re-derived "who worked, in what role,
 * for how long, at what rate" — and RBT was repeatedly lost when one of those
 * independent derivations disagreed (most acutely: Payroll read only
 * SessionTimeRecord, which review-approved RBT sessions never produce). With a
 * single projection there is exactly ONE answer to each of those questions, so
 * the two surfaces can never disagree again.
 *
 * No I/O: the caller (activity.pipeline.loadStaffActivity) supplies the frozen
 * session set and the id→entity maps; this function attributes each session to
 * its staff member, resolves the authoritative ROLE, WORKED MINUTES and staff
 * RATE, and emits a flat, normalized row. Domain-specific rollups (payroll
 * amounts, insurance claim math + authorizations) are layered on top by each
 * projection — they are NOT computed here.
 *
 *   - ROLE: the session's own appointment first (single-clinician bcbaId XOR
 *     rbtId); when the appointment does not carry it (e.g. a session frozen
 *     through the standard review flow), the staff member's ACTIVE care-team
 *     role. Never a frontend value.
 *   - WORKED MINUTES: the authoritative SessionTimeRecord.workedMinutes when a
 *     record exists; otherwise the session's OWN verified clock
 *     (clockIn/clockOut, else started/ended). Never a scheduled duration.
 *   - RATE: the staff member's effective HOURLY compensation rate (integer
 *     cents) supplied by the caller — never hardcoded, never the insurance rate.
 */

/** Full name as First Middle Last (spec §33) — never "Last, First". */
export function fullName(entity) {
  if (!entity) return null;
  return [entity.firstName, entity.middleName, entity.lastName].filter(Boolean).join(' ').trim() || null;
}

/** Client display name, preferring an explicit preferredName. */
export function clientName(client) {
  if (!client) return null;
  return client.preferredName?.trim()
    || [client.firstName, client.middleName, client.lastName].filter(Boolean).join(' ').trim()
    || client.clientNumber
    || null;
}

/** Whole minutes between two instants, or 0 for an incoherent/missing pair. */
export function minutesBetween(start, end) {
  if (!start || !end) return 0;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const m = Math.round(ms / 60000);
  return Number.isFinite(m) && m > 0 ? m : 0;
}

/**
 * Worked minutes from a session's own record, used when no SessionTimeRecord
 * exists (a session frozen through the review flow). Sums the session's TIMING
 * INTERVALS when it has them, so a Start/Stop/Start/Stop day is credited its
 * real total rather than only its first stretch or its wall-to-wall span.
 * Exact durations are summed and rounded ONCE, so three 9m40s intervals are 29
 * minutes rather than 27 or 30.
 *
 * Falls back to the verified clock for sessions recorded before intervals
 * existed, so historical payroll and billing are unchanged.
 */
export function sessionMinutes(session) {
  const closed = (session?.intervals ?? []).filter((iv) => iv?.startedAt && iv?.endedAt);
  if (closed.length > 0) {
    let seconds = 0;
    for (const iv of closed) {
      const ms = new Date(iv.endedAt).getTime() - new Date(iv.startedAt).getTime();
      if (Number.isFinite(ms) && ms > 0) seconds += ms / 1000;
    }
    return Math.round(seconds / 60);
  }
  return minutesBetween(session?.clockInAt ?? session?.startedAt, session?.clockOutAt ?? session?.endedAt);
}

/** Authoritative role for a session: appointment assignment first, then the
 *  staff member's active care-team role. Never trusts a frontend value. */
export function roleForSession(staffProfileId, appt, roleByStaffId = new Map()) {
  if (appt) {
    if (staffProfileId === appt.bcbaId) return 'BCBA';
    if (staffProfileId === appt.rbtId) return 'RBT';
  }
  return roleByStaffId.get(staffProfileId) ?? null;
}

/** The selected authorization ids for a session (primary first), or []. */
export function selectedAuthIdsOf(session) {
  if (Array.isArray(session.selectedAuthorizationIds) && session.selectedAuthorizationIds.length) {
    return session.selectedAuthorizationIds;
  }
  return session.selectedAuthorizationId ? [session.selectedAuthorizationId] : [];
}

/**
 * Project frozen sessions into normalized, authoritative activity rows.
 *
 * @param {object} p
 * @param {Array}  p.sessions        FROZEN/AMENDED sessions in the window
 * @param {Map}    p.workedById      sessionId → SessionTimeRecord.workedMinutes
 * @param {Map}    p.apptById        appointmentId → appointment
 * @param {Map}    p.staffById       staffProfileId → staff profile
 * @param {Map}    p.clientById      clientId → client
 * @param {Map}    p.roleByStaffId   staffProfileId → 'BCBA'|'RBT' (care-team)
 * @param {Map}    p.rateByStaffId   staffProfileId → { rateCents, rateType, currency }
 * @returns {Array<object>} one normalized row per session
 */
export function projectStaffActivity({
  sessions = [], workedById = new Map(), apptById = new Map(), staffById = new Map(),
  clientById = new Map(), roleByStaffId = new Map(), rateByStaffId = new Map(),
} = {}) {
  const rows = [];
  for (const s of sessions) {
    const sid = s._id ?? s.id;
    const appt = apptById.get(s.appointmentId) || null;
    const role = roleForSession(s.staffProfileId, appt, roleByStaffId);
    const recorded = workedById.get(sid);
    const workedMinutes = Number.isFinite(recorded)
      ? Math.max(0, Math.round(recorded))
      : sessionMinutes(s);
    const rate = rateByStaffId.get(s.staffProfileId) || { rateCents: null, rateType: null, currency: 'usd' };
    rows.push({
      sessionId: sid,
      appointmentId: s.appointmentId ?? null,
      staffProfileId: s.staffProfileId,
      staffName: fullName(staffById.get(s.staffProfileId)),
      role, // 'BCBA' | 'RBT' | null (authoritative; never a frontend value)
      clientId: s.clientId ?? null,
      clientName: clientName(clientById.get(s.clientId)),
      status: s.status ?? 'FROZEN',
      serviceDate: s.startedAt ?? null,
      // Actual verified session timing (never the scheduled appointment window).
      // For a multi-interval session these are the FIRST start and LAST end; the
      // worked total below is the sum of the intervals, not the span between
      // them, so a two-hour break in the middle is never paid or billed.
      sessionStart: s.clockInAt ?? s.startedAt ?? null,
      sessionEnd: s.clockOutAt ?? s.endedAt ?? null,
      workedMinutes,
      // The Start/Stop periods behind the total, so Session Detail, reports and
      // exports can show the history without re-deriving it (§10/§30).
      intervals: (s.intervals ?? [])
        .filter((iv) => iv?.startedAt)
        .map((iv) => ({
          startedAt: iv.startedAt,
          endedAt: iv.endedAt ?? null,
          workedMinutes: iv.endedAt ? minutesBetween(iv.startedAt, iv.endedAt) : null,
        })),
      selectedAuthorizationIds: selectedAuthIdsOf(s),
      staffRateCents: rate.rateCents ?? null,
      staffRateType: rate.rateType ?? null,
      currency: rate.currency ?? 'usd',
      // Scheduled context for detail views (date-only appts carry timeSet:false).
      scheduledStart: appt?.startAt ?? null,
      scheduledEnd: appt?.endAt ?? null,
      scheduledTimeSet: appt ? (appt.timeSet ?? true) : true,
    });
  }
  return rows;
}
