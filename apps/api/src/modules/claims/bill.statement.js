import { formatPersonName } from '../../utils/format.js';

/**
 * THE INSURANCE BILL STATEMENT — the one business-facing summary both the Excel
 * and the PDF download render, taken from the generated bill (ClaimsService
 * getGeneratedBill). It only selects and labels what the bill already holds:
 * per client, each BCBA and RBT with their hourly rate, worked time and charge,
 * the client total and the company total. Nothing is recalculated, so the two
 * files always carry exactly the figures the Insurance Billing page shows.
 *
 * Deliberately excluded (these are bill summaries, not activity reports):
 * individual sessions, times, service dates, authorizations, billing codes,
 * claim numbers, statuses, timezone and generation timestamp.
 */

/** "6h 44m" — worked time the way the page shows it (never raw minutes or decimal hours). */
export const workedTime = (minutes) => {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

/** "$1,234.56" from integer cents. */
export const money = (cents) => {
  const value = Math.round(Number(cents) || 0) / 100;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** "$10.00/hr" from integer cents. */
export const hourlyRate = (cents) => `${money(cents)}/hr`;

/** One clinician line: name, rate(s), worked minutes and charge (cents). */
function clinicianLine(st) {
  const rates = [...new Set((st.hourlyRates?.length ? st.hourlyRates : [st.hourlyRate]).filter((v) => v != null))];
  return {
    name: formatPersonName(st.staffName) || 'Unnamed staff member',
    hourlyRates: rates,
    hourlyRateText: rates.length ? rates.map(hourlyRate).join(' / ') : '—',
    workedMinutes: st.billableMinutes ?? st.workedMinutes ?? 0,
    workedTime: workedTime(st.billableMinutes ?? st.workedMinutes ?? 0),
    charge: st.charge ?? 0,
  };
}

const roleTotals = (lines) => ({
  workedMinutes: lines.reduce((t, l) => t + l.workedMinutes, 0),
  charge: lines.reduce((t, l) => t + l.charge, 0),
});

/**
 * @param {object} bill  the generated bill ({ organization, period, clients, summary })
 * @returns {{ companyName, periodLabel, clients: Array, totals: object }}
 */
export function billStatement(bill) {
  const clients = (bill.clients ?? []).map((c) => {
    const bcba = (c.bcbaStaff ?? []).map(clinicianLine);
    const rbt = (c.rbtStaff ?? []).map(clinicianLine);
    // A clinician whose BCBA/RBT role could not be established is still listed.
    const other = (c.unassignedStaff ?? []).filter((st) => (st.charge ?? 0) > 0 || (st.sessions ?? 0) > 0).map(clinicianLine);
    return {
      clientName: formatPersonName(c.clientName) || 'Unnamed client',
      bcba, rbt, other,
      bcbaTotal: roleTotals(bcba),
      rbtTotal: roleTotals(rbt),
      clientTotal: c.clientTotal ?? 0,
    };
  });
  const sm = bill.summary ?? {};
  return {
    companyName: bill.organization?.name || '',
    periodLabel: bill.period?.label ?? '',
    clients,
    totals: {
      clientCount: clients.length,
      bcbaWorkedMinutes: sm.bcbaWorkedMinutes ?? clients.reduce((t, c) => t + c.bcbaTotal.workedMinutes, 0),
      rbtWorkedMinutes: sm.rbtWorkedMinutes ?? clients.reduce((t, c) => t + c.rbtTotal.workedMinutes, 0),
      bcbaCharge: sm.bcbaCharge ?? clients.reduce((t, c) => t + c.bcbaTotal.charge, 0),
      rbtCharge: sm.rbtCharge ?? clients.reduce((t, c) => t + c.rbtTotal.charge, 0),
      total: sm.totalBillableAmount ?? clients.reduce((t, c) => t + c.clientTotal, 0),
    },
  };
}
