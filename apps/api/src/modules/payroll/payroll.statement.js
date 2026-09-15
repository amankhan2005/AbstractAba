import { formatPersonName } from '../../utils/format.js';

/**
 * THE PAYROLL SUMMARY STATEMENT — the one business-facing summary both the Excel
 * and the PDF download render, taken from the generated payroll
 * (PayrollService.getGeneratedPeriodPayroll). It only selects and labels what the
 * generated payroll already holds: each staff member's name, role, hourly rate,
 * hours worked and payout, and the total company payroll. Nothing is
 * recalculated, so both files carry exactly the figures the Payroll page shows.
 *
 * Deliberately excluded: individual sessions, times, dates of work, clients,
 * appointments, authorizations, billing codes, internal identifiers, raw
 * minutes, timezone and generation timestamp.
 */

/** "36h 30m" — worked time the way the page shows it. */
export const workedTime = (minutes) => {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

/** "$1,825.00" from integer cents. */
export const money = (cents) => {
  const value = Math.round(Number(cents) || 0) / 100;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** "$50.00/hr" from integer cents. */
export const hourlyRate = (cents) => `${money(cents)}/hr`;

/**
 * @param {object} payroll the generated payroll ({ organization, period, staff, summary })
 * @returns {{ companyName, periodLabel, staff: Array, totals: { staffCount, totalMinutes, totalAmount } }}
 */
export function payrollStatement(payroll) {
  const staff = (payroll.staff ?? []).map((s) => {
    const rates = (s.hourlyRates?.length ? s.hourlyRates : [s.hourlyRate]).filter((v) => v != null);
    return {
      name: formatPersonName(s.staffName) || 'Unnamed staff member',
      role: s.role || 'Staff',
      hourlyRates: rates,
      hourlyRateText: rates.length ? rates.map(hourlyRate).join(' / ') : '—',
      workedMinutes: s.workedMinutes ?? 0,
      workedTime: workedTime(s.workedMinutes),
      payout: s.amount ?? 0,
      payoutText: money(s.amount),
    };
  });
  const sm = payroll.summary ?? {};
  return {
    companyName: payroll.organization?.name || '',
    periodLabel: payroll.period?.label ?? '',
    staff,
    totals: {
      staffCount: staff.length,
      totalMinutes: sm.totalMinutes ?? staff.reduce((t, s) => t + s.workedMinutes, 0),
      totalAmount: sm.totalAmount ?? staff.reduce((t, s) => t + s.payout, 0),
    },
  };
}
