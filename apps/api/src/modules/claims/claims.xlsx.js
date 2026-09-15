import {
  buildWorkbook, STYLE_TITLE, STYLE_HEADER, STYLE_LABEL, STYLE_MONEY, STYLE_MONEY_BOLD,
  STYLE_DOC_TITLE, STYLE_DOC_SUBTITLE, STYLE_DOC_LABEL, STYLE_DOC_VALUE, STYLE_TABLE_HEADER, STYLE_TABLE_TEXT,
  STYLE_TABLE_RIGHT, STYLE_TABLE_RATE, STYLE_TABLE_MONEY, STYLE_TABLE_MONEY_BOLD, STYLE_TOTAL_TEXT, STYLE_TOTAL_RIGHT, STYLE_TOTAL_MONEY,
} from '../payroll/payroll.xlsx.js';
import { billStatement, workedTime, money } from './bill.statement.js';

/**
 * INSURANCE BILLING .xlsx workbooks. The company workbook is the Insurance Bill
 * summary (buildCompanyInsuranceWorkbook, below). The child workbook is the
 * separate per-client export built from previewChildBilling. Nothing is
 * recalculated in either.
 */
const dollars = (cents) => (cents == null ? '' : { v: Math.round(cents) / 100, s: STYLE_MONEY });
const dollarsBold = (cents) => ({ v: Math.round(cents ?? 0) / 100, s: STYLE_MONEY_BOLD });
const hoursOf = (min) => Number(((min || 0) / 60).toFixed(2));
const minutesOf = (min) => Math.max(0, Math.round(min || 0));
const zoned = (v, tz, opts) => { if (!v) return ''; try { return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', ...opts }).format(new Date(v)); } catch { return ''; } };
const timeStr = (v, tz) => zoned(v, tz, { hour: 'numeric', minute: '2-digit' });
const serviceDateStr = (key) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || ''); return m ? `${m[2]}/${m[3]}/${m[1]}` : ''; };

export const BILLING_STATUS_LABEL = { READY: 'Ready', BILLED: 'Billed', INCOMPLETE: 'Incomplete billing data' };
const statusOf = (r) => BILLING_STATUS_LABEL[r.billingStatus] ?? r.billingStatus ?? '';
const issuesOf = (r) => (r.issues ?? []).map((x) => x.label).join('; ');
const perHour = (cents) => (cents == null ? '' : { v: Math.round(cents) / 100, s: STYLE_MONEY });

/**
 * THE INSURANCE BILL workbook — ONE professional summary sheet built from the
 * generated bill via billStatement (the same statement the PDF renders):
 *
 *   Company name · Insurance Bill · Billing Period
 *   Client Name | BCBA Name | BCBA Hourly Rate | BCBA Worked Hours | BCBA Charge |
 *   RBT Name | RBT Hourly Rate | RBT Worked Hours | RBT Charge | Client Total
 *   …one row per client…
 *   TOTAL COMPANY INSURANCE BILLING
 *
 * BCBA and RBT each keep their own columns, so a client billed for both always
 * shows both. Worked time reads "6h 44m"; rates and charges are real numbers
 * formatted as currency ("$10.00/hr", "$67.33") so the sheet can still be summed.
 * No session rows, minutes, dates, authorizations, billing codes, claim numbers,
 * timezone or timestamp — this is a bill summary, not an activity report.
 */
export function buildCompanyInsuranceWorkbook(data) {
  const st = billStatement(data);
  const hasOther = st.clients.some((c) => c.other.length > 0);
  const header = ['Client Name', 'BCBA Name', 'BCBA Hourly Rate', 'BCBA Worked Hours', 'BCBA Charge',
    'RBT Name', 'RBT Hourly Rate', 'RBT Worked Hours', 'RBT Charge', 'Client Total', ...(hasOther ? ['Other Staff'] : [])];
  const width = header.length;
  const last = String.fromCharCode(64 + width);
  const cell = (v, s) => ({ v, s });

  /** A role's four cells: name(s), hourly rate, worked hours, charge. */
  const roleCells = (lines, totals) => {
    if (lines.length === 0) return [cell('', STYLE_TABLE_TEXT), cell('', STYLE_TABLE_RIGHT), cell('', STYLE_TABLE_RIGHT), cell('', STYLE_TABLE_RIGHT)];
    const singleRate = lines.length === 1 && lines[0].hourlyRates.length === 1;
    return [
      cell(lines.map((l) => l.name).join('\n'), STYLE_TABLE_TEXT),
      singleRate ? cell(lines[0].hourlyRates[0] / 100, STYLE_TABLE_RATE) : cell(lines.map((l) => l.hourlyRateText).join('\n'), STYLE_TABLE_RIGHT),
      cell(lines.map((l) => l.workedTime).join('\n'), STYLE_TABLE_RIGHT),
      cell(totals.charge / 100, STYLE_TABLE_MONEY),
    ];
  };

  const rows = [
    [cell(st.companyName, STYLE_DOC_TITLE)],
    [cell('Insurance Bill', STYLE_DOC_SUBTITLE)],
    [cell('Billing Period', STYLE_DOC_LABEL), cell(st.periodLabel, STYLE_DOC_VALUE)],
    [],
    header.map((h) => cell(h, STYLE_TABLE_HEADER)),
  ];
  const rowHeights = { 1: 28, 2: 22, 5: 32 };
  for (const c of st.clients) {
    const lineCount = Math.max(1, c.bcba.length, c.rbt.length);
    rows.push([
      cell(c.clientName, STYLE_TABLE_TEXT),
      ...roleCells(c.bcba, c.bcbaTotal),
      ...roleCells(c.rbt, c.rbtTotal),
      cell(c.clientTotal / 100, STYLE_TABLE_MONEY_BOLD),
      ...(hasOther ? [cell(c.other.map((l) => `${l.name} · ${l.hourlyRateText} · ${l.workedTime} · ${money(l.charge)}`).join('\n'), STYLE_TABLE_TEXT)] : []),
    ]);
    if (lineCount > 1) rowHeights[rows.length] = 16 * lineCount;
  }
  if (st.clients.length === 0) rows.push([cell('No billed services in this period.', STYLE_TABLE_TEXT)]);
  const t = st.totals;
  rows.push([
    cell('TOTAL COMPANY INSURANCE BILLING', STYLE_TOTAL_TEXT),
    cell('', STYLE_TOTAL_TEXT), cell('', STYLE_TOTAL_RIGHT),
    cell(workedTime(t.bcbaWorkedMinutes), STYLE_TOTAL_RIGHT), cell(t.bcbaCharge / 100, STYLE_TOTAL_MONEY),
    cell('', STYLE_TOTAL_TEXT), cell('', STYLE_TOTAL_RIGHT),
    cell(workedTime(t.rbtWorkedMinutes), STYLE_TOTAL_RIGHT), cell(t.rbtCharge / 100, STYLE_TOTAL_MONEY),
    cell(t.total / 100, STYLE_TOTAL_MONEY),
    ...(hasOther ? [cell('', STYLE_TOTAL_TEXT)] : []),
  ]);
  rowHeights[rows.length] = 24;

  return buildWorkbook({
    sheets: [{
      name: 'Insurance Bill',
      rows,
      cols: [26, 22, 16, 17, 14, 22, 16, 17, 14, 16, ...(hasOther ? [40] : [])],
      freezeHeaderRows: 5,
      rowHeights,
      merges: [`A1:${last}1`, `A2:${last}2`, 'B3:E3'],
      landscape: true,
    }],
  });
}

/** Child + period workbook — the child's rows from the same dataset. */
export function buildInsuranceWorkbook(data) {
  const tz = data.period?.timeZone || 'UTC';
  const H = (v) => ({ v, s: STYLE_HEADER });
  const K = (v) => ({ v, s: STYLE_LABEL });
  const sm = data.summary ?? {};
  const rows = [
    [{ v: 'Insurance Billing', s: STYLE_TITLE }],
    [K('Client'), data.child?.clientName ?? ''],
    [K('Payer'), data.payerName ?? ''],
    [K('Billing Period'), data.period?.label ?? ''],
    [K('Timezone'), tz],
    [],
    ['Clinician', 'Role', 'Service Date', 'Session Start', 'Session End', 'Worked Hours', 'Worked Minutes', 'Authorization', 'Billing Code', 'Hourly Rate', 'Billable Amount', 'Status', 'Billing Data Issue'].map(H),
  ];
  for (const r of data.sessions ?? []) {
    rows.push([
      r.staffName ?? '', r.role ?? '', serviceDateStr(r.serviceDate), timeStr(r.clockInAt, tz), timeStr(r.clockOutAt, tz),
      hoursOf(r.workedMinutes), minutesOf(r.workedMinutes), r.authorizationNumber ?? '', r.billingCode ?? '',
      perHour(r.hourlyRate), dollars(r.billingStatus === 'INCOMPLETE' ? null : r.amount),
      statusOf(r), issuesOf(r),
    ]);
  }
  rows.push([]);
  rows.push([K('BCBA Charge'), dollars(sm.bcbaCharge ?? 0)]);
  rows.push([K('RBT Charge'), dollars(sm.rbtCharge ?? 0)]);
  rows.push([K('CLIENT TOTAL'), dollarsBold(sm.totalClaimAmount ?? 0)]);
  return buildWorkbook({ sheets: [{ name: 'Insurance Billing', rows, cols: [22, 7, 13, 13, 13, 13, 15, 16, 13, 13, 16, 22, 44] }] });
}
