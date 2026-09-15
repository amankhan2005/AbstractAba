import { aggregatePeriodPayroll } from '../src/modules/payroll/payroll.periods.js';

/**
 * A payroll period computed by the real payroll aggregation, and the GENERATED
 * payroll exactly as PayrollService.getGeneratedPeriodPayroll returns it (one
 * saved line per paid staff member). DB-free. Period 09/07/2026 – 09/13/2026.
 *
 *   Test1 J   BCBA $50/hr  240 + 120 = 6h 00m → $300.00
 *   Ellen Ng  BCBA $60/hr  90         = 1h 30m → $90.00
 *   Test2 K   RBT  $25/hr  90 + 60    = 2h 30m → $62.50
 *   Ann Lee   RBT  $30/hr  45         = 0h 45m → $22.50
 *   Mark Ray  RBT  $30/hr until 09/10, $32/hr from 09/10:
 *                  60 on 09/08 ($30.00) + 60 on 09/11 ($32.00) = 2h 00m → $62.00
 *   Total company payroll $537.00
 */
const at = (iso) => new Date(iso);
export const RATES = new Map([
  ['b1', [{ staffProfileId: 'b1', rateType: 'HOURLY', amount: 5000, effectiveFrom: at('2026-01-01T00:00:00Z') }]],
  ['b2', [{ staffProfileId: 'b2', rateType: 'HOURLY', amount: 6000, effectiveFrom: at('2026-01-01T00:00:00Z') }]],
  ['r1', [{ staffProfileId: 'r1', rateType: 'HOURLY', amount: 2500, effectiveFrom: at('2026-01-01T00:00:00Z') }]],
  ['r2', [{ staffProfileId: 'r2', rateType: 'HOURLY', amount: 3000, effectiveFrom: at('2026-01-01T00:00:00Z') }]],
  ['r3', [
    { staffProfileId: 'r3', rateType: 'HOURLY', amount: 3200, effectiveFrom: at('2026-09-10T04:00:00Z') },
    { staffProfileId: 'r3', rateType: 'HOURLY', amount: 3000, effectiveFrom: at('2026-01-01T00:00:00Z'), effectiveTo: at('2026-09-10T03:59:59Z') },
  ]],
]);
export const STAFF = new Map([
  ['b1', { _id: 'b1', firstName: 'test1', lastName: 'j' }],
  ['b2', { _id: 'b2', firstName: 'Ellen', lastName: 'Ng' }],
  ['r1', { _id: 'r1', firstName: 'Test2', lastName: 'K' }],
  ['r2', { _id: 'r2', firstName: 'Ann', lastName: 'Lee' }],
  ['r3', { _id: 'r3', firstName: 'Mark', lastName: 'Ray' }],
]);
const appt = (id, role, staff) => [id, { _id: id, ...(role === 'BCBA' ? { bcbaId: staff } : { rbtId: staff }) }];
export const APPTS = new Map([
  appt('a1', 'BCBA', 'b1'), appt('a2', 'BCBA', 'b2'), appt('a3', 'RBT', 'r1'), appt('a4', 'RBT', 'r2'), appt('a5', 'RBT', 'r3'),
]);
const rec = (sessionId, staffProfileId, appointmentId, startedAt, workedMinutes) => ({ sessionId, staffProfileId, appointmentId, clientId: 'c1', startedAt: at(startedAt), endedAt: new Date(at(startedAt).getTime() + workedMinutes * 60000), workedMinutes });
export const RECORDS = [
  rec('s1', 'b1', 'a1', '2026-09-08T13:00:00Z', 240),
  rec('s2', 'b1', 'a1', '2026-09-09T13:00:00Z', 120),
  rec('s3', 'b2', 'a2', '2026-09-09T15:00:00Z', 90),
  rec('s4', 'r1', 'a3', '2026-09-08T14:00:00Z', 90),
  rec('s5', 'r1', 'a3', '2026-09-11T14:00:00Z', 60),
  rec('s6', 'r2', 'a4', '2026-09-12T14:00:00Z', 45),
  rec('s7', 'r3', 'a5', '2026-09-08T16:00:00Z', 60),
  rec('s8', 'r3', 'a5', '2026-09-11T16:00:00Z', 60),
];
export const WINDOW = { start: at('2026-09-07T04:00:00Z'), end: at('2026-09-14T04:00:00Z') };

export function periodPayroll(records = RECORDS) {
  return aggregatePeriodPayroll({ records, apptById: APPTS, staffById: STAFF, payRatesByStaffId: RATES, window: WINDOW });
}

/** The generated payroll (saved lines → page / Excel / PDF data). */
export function generatedPayroll(records = RECORDS) {
  const { staff } = periodPayroll(records);
  const paid = staff.filter((s) => s.rateLines.length > 0).map((s) => ({
    staffProfileId: s.staffProfileId, staffName: s.staffName, role: s.role, hourlyRates: s.hourlyRates,
    hourlyRate: s.hourlyRates.length === 1 ? s.hourlyRates[0] : null, workedMinutes: s.payableMinutes, sessionCount: s.sessionCount, amount: s.amount, currency: 'usd',
  }));
  return {
    organization: { name: 'Demo ABA Clinic' },
    period: { mode: 'weekly', label: '09/07/2026 – 09/13/2026', from: '2026-09-07', to: '2026-09-13' },
    generated: true, status: 'DRAFT', payrollRunId: 'run-internal-id', generatedAt: at('2026-09-15T16:00:00Z'),
    staff: paid,
    summary: { staffCount: paid.length, totalMinutes: paid.reduce((t, s) => t + s.workedMinutes, 0), totalAmount: paid.reduce((t, s) => t + s.amount, 0), currency: 'usd' },
  };
}
