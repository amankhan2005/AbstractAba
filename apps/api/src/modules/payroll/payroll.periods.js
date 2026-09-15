import { companyWeekWindow, zonedMidnightToUtc } from '../bcba-session/weeklyHours.js';
import { applicableHourlyRate, allocateCents, computeLineAmount } from './payroll.math.js';
import { zonedParts } from '../../domain/businessDate.js';
import { AppError } from '../../common/errors/AppError.js';

/**
 * PAYROLL PERIOD RESOLUTION — pure, server-side, timezone-correct (spec §1/§15).
 *
 * The Company Admin picks a MODE (weekly / bi-weekly / custom); the server —
 * never the browser — resolves it to a half-open UTC interval [start, end) in
 * the COMPANY's timezone and week-start day, so week/fortnight boundaries honour
 * weekStartsOn and every boundary is DST-safe (it goes through the same
 * zonedMidnightToUtc the "My Hours" windows use — no parallel date logic).
 *
 *   weekly     → the LATEST COMPLETED Monday–Sunday week (or the week containing `anchor`)
 *   biweekly   → the LATEST COMPLETED fixed 14-day pay period (or the one containing `anchor`)
 *   custom     → [from 00:00, (to+1) 00:00) — inclusive of the whole `to` day
 *
 * Custom validates From Date <= To Date and never silently uses today.
 */

/**
 * BI-WEEKLY PAY CYCLE. Pay periods are consecutive, NON-OVERLAPPING 14-day
 * windows on a fixed cycle: every period starts on the payroll week-start day,
 * an even number of weeks after the cycle reference below. So when one period
 * ends at 00:00 org time the next one begins at that same instant — the
 * previous period is closed (historical) and new work lands only in the new
 * one. (The earlier "this week + the week before" window slid every week, so
 * consecutive "periods" overlapped by seven days and the same week could be
 * generated into two runs.)
 *
 * The reference is the civil date 2024-01-01 (a Monday), aligned back to the
 * payroll week-start day. It is a calendar constant, not a timestamp, so it has
 * no timezone and never drifts.
 */
export const BIWEEKLY_CYCLE_REFERENCE = { y: 2024, m: 1, d: 1 };
const DAY_MS = 86400000;

export function biweeklyPayPeriodWindow(at, timeZone, weekStartsOn = 1) {
  const zone = timeZone || 'UTC';
  const wsd = ((Number(weekStartsOn) % 7) + 7) % 7;
  const week = companyWeekWindow(at, zone, wsd);
  const ws = zonedParts(week.start, zone);
  const weekStartDay = Date.UTC(ws.year, ws.month - 1, ws.day) / DAY_MS;
  const ref = Date.UTC(BIWEEKLY_CYCLE_REFERENCE.y, BIWEEKLY_CYCLE_REFERENCE.m - 1, BIWEEKLY_CYCLE_REFERENCE.d);
  const refDow = new Date(ref).getUTCDay();
  const refStartDay = ref / DAY_MS - (((refDow - wsd) + 7) % 7);
  const weeks = Math.round((weekStartDay - refStartDay) / 7);
  const offset = ((weeks % 2) + 2) % 2; // 0 = first week of a period, 1 = second
  const startCivil = new Date((weekStartDay - offset * 7) * DAY_MS);
  const endCivil = new Date((weekStartDay - offset * 7 + 14) * DAY_MS);
  const start = zonedMidnightToUtc(startCivil.getUTCFullYear(), startCivil.getUTCMonth() + 1, startCivil.getUTCDate(), zone);
  const end = zonedMidnightToUtc(endCivil.getUTCFullYear(), endCivil.getUTCMonth() + 1, endCivil.getUTCDate(), zone);
  return { start, end, weekStartsOn: wsd, timeZone: zone };
}

/** Civil Y/M/D from a 'YYYY-MM-DD' string or a Date (UTC parts — date-only
 *  inputs are coerced to UTC midnight upstream, so UTC parts are the civil date). */
function civilParts(value) {
  if (value == null) return null;
  if (value instanceof Date || typeof value === 'number') {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }
  const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

const cmpCivil = (a, b) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
const validCivil = ({ y, m, d }) => { const x = new Date(Date.UTC(y, m - 1, d)); return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d; };

/** 'YYYY-MM-DD' of an instant on the organization's calendar. */
function dateKey(instant, zone) {
  const p = zonedParts(instant, zone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
const usDate = (key) => `${key.slice(5, 7)}/${key.slice(8, 10)}/${key.slice(0, 4)}`;

/** The window's inclusive civil dates, its "MM/DD/YYYY – MM/DD/YYYY" label and the period-navigation anchors. */
function describe(start, end, zone) {
  const from = dateKey(start, zone);
  const to = dateKey(new Date(end.getTime() - 1), zone);
  return { from, to, label: `${usDate(from)} – ${usDate(to)}` };
}

/**
 * @param {object} p
 * @param {'weekly'|'biweekly'|'custom'} p.mode
 * @param {string|Date} [p.from]  required for custom
 * @param {string|Date} [p.to]    required for custom
 * @param {string|Date} [p.anchor] a date inside the desired week / fortnight;
 *        omitted → the LATEST COMPLETED week / fortnight
 * @param {Date} [p.now]
 * @param {string} [p.timeZone]   IANA zone (org.timezone)
 * @param {number} [p.weekStartsOn] 0=Sun … 6=Sat (payroll standard: 1 = Monday)
 * @param {boolean} [p.requireCompleted] refuse a weekly / bi-weekly period that has not ended yet
 * @returns {{ start:Date, end:Date, mode:string, from:string, to:string, label:string,
 *   timeZone:string, weekStartsOn:number, previousAnchor:string|null, nextAnchor:string|null, completed:boolean }}
 *
 * WEEKLY and BI-WEEKLY pay only COMPLETED work: with no anchor, the period is the
 * most recent one that has fully ended in the organization's timezone — on
 * Tuesday 09/15 the weekly period is Monday 09/07 → Sunday 09/13, and the week
 * that started on Monday 09/14 waits until its Sunday has ended. Bi-weekly
 * periods are the fixed, non-overlapping 14-day cycle; the latest completed one
 * is the cycle period before the one in progress.
 */
export function resolvePayrollWindow({ mode = 'weekly', from = null, to = null, anchor = null, now = new Date(), timeZone = 'UTC', weekStartsOn = 1, requireCompleted = false } = {}) {
  const zone = timeZone || 'UTC';
  const wsd = ((Number(weekStartsOn) % 7) + 7) % 7;
  const nowAt = new Date(now);

  if (mode === 'custom') {
    const f = civilParts(from);
    const t = civilParts(to);
    if (!f || !t) throw AppError.validation('Select a From Date and a To Date.');
    if (!validCivil(f) || !validCivil(t)) throw AppError.validation('Enter a valid date.');
    if (cmpCivil(f, t) > 0) throw AppError.validation('From Date must be on or before To Date.');
    const start = zonedMidnightToUtc(f.y, f.m, f.d, zone);
    const endCivil = new Date(Date.UTC(t.y, t.m - 1, t.d + 1)); // inclusive of the whole `to` day
    const end = zonedMidnightToUtc(endCivil.getUTCFullYear(), endCivil.getUTCMonth() + 1, endCivil.getUTCDate(), zone);
    return { start, end, mode: 'custom', timeZone: zone, weekStartsOn: wsd, ...describe(start, end, zone), previousAnchor: null, nextAnchor: null, completed: end <= nowAt };
  }
  if (mode !== 'weekly' && mode !== 'biweekly') throw AppError.validation('Select Weekly, Bi-weekly or Custom.');

  const windowAt = (at) => (mode === 'weekly' ? companyWeekWindow(at, zone, wsd) : biweeklyPayPeriodWindow(at, zone, wsd));
  let w;
  if (anchor) {
    const at = civilParts(anchor) && /^\d{4}-\d{2}-\d{2}$/.test(String(anchor))
      ? (() => { const c = civilParts(anchor); return zonedMidnightToUtc(c.y, c.m, c.d, zone); })()
      : new Date(anchor);
    if (Number.isNaN(at.getTime())) throw AppError.validation('Enter a valid date.');
    w = windowAt(at);
  } else {
    // The period in progress, then the one immediately before it (1 ms before its start).
    const current = windowAt(nowAt);
    w = current.start <= nowAt && nowAt < current.end ? windowAt(new Date(current.start.getTime() - 1)) : current;
  }
  const completed = w.end <= nowAt;
  if (requireCompleted && !completed) {
    throw AppError.validation(mode === 'weekly'
      ? 'This week has not finished yet. Weekly payroll includes completed Monday to Sunday weeks only.'
      : 'This pay period has not finished yet. Bi-weekly payroll includes completed two-week periods only.');
  }
  const previous = windowAt(new Date(w.start.getTime() - 1));
  const next = windowAt(w.end);
  return {
    start: w.start, end: w.end, mode, timeZone: zone, weekStartsOn: wsd, ...describe(w.start, w.end, zone), completed,
    previousAnchor: dateKey(previous.start, zone),
    nextAnchor: next.end <= nowAt ? dateKey(next.start, zone) : null,
  };
}

const ROLE_ORDER = { BCBA: 0, RBT: 1 };
/** BCBA first, then RBT, then anyone else; by name within a role. */
export function byRoleThenName(a, b) {
  const rank = (s) => ROLE_ORDER[String(s.role ?? '').split(' / ')[0]] ?? 2;
  return rank(a) - rank(b) || (a.staffName || '').localeCompare(b.staffName || '') || String(a.staffProfileId).localeCompare(String(b.staffProfileId));
}

/**
 * PURE payroll aggregation from the authoritative completed-session worked time.
 * No I/O: the service supplies one record per completed session and the
 * id→entity maps; this is the single place payroll figures are shaped.
 *
 *  - Worked time is the session's actual worked minutes (never a schedule).
 *  - Hourly rate is the staff member's Staff Profile rate applicable on each
 *    work date (`payRatesByStaffId`, effective-dated); `rateByStaff` (a single
 *    rate per staff member) is honoured when no rate history is supplied.
 *  - Payout per staff member = for each applicable rate, (Σ worked minutes ÷ 60)
 *    × rate, rounded to the cent ONCE — worked time is never rounded first. The
 *    per-session amounts are that payout split exactly by worked minutes.
 *  - Work with no rate at all is flagged missingRate and contributes NO amount —
 *    it is never silently paid $0.
 *  - Each staff member is their own row; BCBA and RBT never merge.
 *
 * @param {object} p
 * @param {Array} p.records            one row per completed session
 * @param {Map}   p.apptById           appointmentId → appointment (role)
 * @param {Map}   p.staffById          staffProfileId → staff profile (name)
 * @param {Map}   p.clientNameById     clientId → display name
 * @param {Map}   [p.payRatesByStaffId] staffProfileId → PayRate[] (HOURLY, cents)
 * @param {Map}   [p.rateByStaff]      staffProfileId → rate cents (fallback)
 * @param {Map}   [p.roleByStaffId]    staffProfileId → care-team role (fallback)
 * @param {{start:Date,end:Date}} p.window
 */
export function aggregatePeriodPayroll({ records = [], apptById = new Map(), staffById = new Map(), clientNameById = new Map(), payRatesByStaffId = null, rateByStaff = new Map(), roleByStaffId = new Map(), window = {} }) {
  // Role comes from THIS session's appointment first (bcbaId/rbtId), then the
  // staff member's own care-team / clinician role.
  const roleFor = (staffProfileId, appt) => {
    if (appt) {
      if (staffProfileId === appt.bcbaId) return 'BCBA';
      if (staffProfileId === appt.rbtId) return 'RBT';
    }
    return roleByStaffId.get(staffProfileId) ?? null;
  };
  const rateFor = (staffProfileId, record) => {
    const history = payRatesByStaffId?.get(staffProfileId);
    if (history && history.length) return applicableHourlyRate(history, record.startedAt);
    if (rateByStaff.has(staffProfileId) && rateByStaff.get(staffProfileId) != null) return rateByStaff.get(staffProfileId);
    return record.hourlyRateSnapshot ?? null;
  };

  const groups = new Map();
  for (const r of records) {
    if (!groups.has(r.staffProfileId)) groups.set(r.staffProfileId, []);
    groups.get(r.staffProfileId).push(r);
  }

  const staff = [];
  for (const [staffProfileId, rows] of groups) {
    const sp = staffById.get(staffProfileId) || null;
    const staffName = sp ? ([sp.firstName, sp.middleName, sp.lastName].filter(Boolean).join(' ').trim() || null) : null;
    const roles = [];
    const entries = rows.map((r) => {
      const appt = apptById.get(r.appointmentId) || null;
      const role = roleFor(staffProfileId, appt);
      if (role && !roles.includes(role)) roles.push(role);
      return {
        sessionId: r.sessionId,
        appointmentId: r.appointmentId ?? null,
        clientId: r.clientId ?? null,
        childName: clientNameById.get(r.clientId) ?? null,
        role,
        workDate: r.startedAt ?? null,
        scheduledStart: appt?.startAt ?? null,
        scheduledEnd: appt?.endAt ?? null,
        scheduledTimeSet: appt ? (appt.timeSet ?? true) : true,
        clockInAt: r.startedAt ?? null,
        clockOutAt: r.endedAt ?? null,
        intervals: Array.isArray(r.intervals) ? r.intervals : [],
        workedMinutes: Number.isFinite(r.workedMinutes) ? Math.max(0, Math.round(r.workedMinutes)) : 0,
        hourlyRate: rateFor(staffProfileId, r),
        currency: 'usd',
        amount: null,
        status: 'FROZEN',
      };
    });

    // One rounded payout per applicable rate, split back to its sessions.
    const byRate = new Map();
    let missingRate = false;
    for (const e of entries) {
      if (e.hourlyRate == null) { missingRate = true; continue; }
      if (!byRate.has(e.hourlyRate)) byRate.set(e.hourlyRate, []);
      byRate.get(e.hourlyRate).push(e);
    }
    let amount = 0;
    const rateLines = [];
    for (const [rate, list] of [...byRate.entries()].sort((a, b) => a[0] - b[0])) {
      const minutes = list.reduce((t, e) => t + e.workedMinutes, 0);
      const payout = computeLineAmount({ rateType: 'HOURLY', rateAmount: rate, minutes });
      allocateCents(payout, list.map((e) => e.workedMinutes)).forEach((cents, i) => { list[i].amount = cents; });
      rateLines.push({ hourlyRate: rate, workedMinutes: minutes, amount: payout });
      amount += payout;
    }
    const hourlyRates = rateLines.map((l) => l.hourlyRate);
    const workedMinutes = entries.reduce((t, e) => t + e.workedMinutes, 0);
    staff.push({
      staffProfileId, staffName,
      role: roles.length ? roles.join(' / ') : null,
      roles,
      sessionCount: rows.length,
      workedMinutes,
      payableMinutes: rateLines.reduce((t, l) => t + l.workedMinutes, 0),
      hourlyRate: hourlyRates.length === 1 ? hourlyRates[0] : null,
      hourlyRates,
      rateLines,
      amount,
      currency: 'usd',
      missingRate,
      entries,
    });
  }
  staff.sort(byRoleThenName);

  const summary = {
    periodStart: window.start ?? null,
    periodEnd: window.end ?? null,
    staffCount: staff.length,
    paidStaffCount: staff.filter((s) => s.amount > 0 || s.rateLines.length > 0).length,
    bcbaCount: staff.filter((s) => s.roles.includes('BCBA')).length,
    rbtCount: staff.filter((s) => s.roles.includes('RBT')).length,
    sessionCount: records.length,
    totalMinutes: staff.reduce((t, s) => t + s.workedMinutes, 0),
    paidMinutes: staff.reduce((t, s) => t + s.payableMinutes, 0),
    totalAmount: staff.reduce((t, s) => t + s.amount, 0),
    missingRateCount: staff.filter((s) => s.missingRate).length,
    currency: 'usd',
  };
  return { staff, summary };
}
