import { payrollStatement, workedTime, money } from './payroll.statement.js';
import {
  Canvas, assemble, fit, drawDocumentHeader, drawTotalBand, drawFooters,
  M_X, CONTENT_W, MUTED, LINE, PANEL, ACCENT, INK,
} from '../../common/pdf/statementPdf.js';

/**
 * THE PAYROLL SUMMARY PDF — a professional payroll statement drawn with the
 * shared statement PDF writer. It renders the same statement as the Excel
 * download (payrollStatement over the generated payroll): company name,
 * "Payroll Summary", the payroll period and staff paid, a staff table (Staff
 * Name, Role, Hourly Rate, Hours Worked, Payout) whose header repeats on every
 * page, and the TOTAL COMPANY PAYROLL. Page numbers sit in the footer.
 *
 * Deliberately excluded: individual sessions, times, dates of work, clients,
 * internal identifiers, raw minutes, timezone and generation timestamp.
 */

const COL = {
  name: M_X + 12,
  role: M_X + 186,
  rate: M_X + 350, // right edges from here on
  hours: M_X + 440,
  payout: M_X + CONTENT_W - 12,
};
const HEAD_H = 24;
const ROW_H = 24;

function tableHeader(cv) {
  const top = cv.y;
  cv.rect(M_X, top - HEAD_H, CONTENT_W, HEAD_H, PANEL);
  cv.rect(M_X, top - HEAD_H, 3, HEAD_H, ACCENT);
  const y = top - HEAD_H + 9;
  const opts = { size: 7.5, bold: true, color: MUTED };
  cv.text(COL.name, y, 'STAFF NAME', opts);
  cv.text(COL.role, y, 'ROLE', opts);
  cv.text(COL.rate, y, 'HOURLY RATE', { ...opts, align: 'right' });
  cv.text(COL.hours, y, 'HOURS WORKED', { ...opts, align: 'right' });
  cv.text(COL.payout, y, 'PAYOUT', { ...opts, align: 'right' });
  cv.y = top - HEAD_H;
}

/** Build the Payroll Summary PDF from the generated payroll. */
export function buildPayrollPdf(data) {
  const st = payrollStatement(data);
  const cv = new Canvas();
  drawDocumentHeader(cv, {
    companyName: st.companyName, title: 'Payroll Summary',
    leftLabel: 'PAYROLL PERIOD', leftValue: st.periodLabel,
    rightLabel: 'STAFF PAID', rightValue: String(st.totals.staffCount),
  });

  tableHeader(cv);
  for (const s of st.staff) {
    if (cv.y - ROW_H < 60 + 8) { cv.newPage(); tableHeader(cv); }
    const y = cv.y - ROW_H;
    cv.text(COL.name, y + 8, fit(s.name, 10, true, COL.role - COL.name - 14), { size: 10, bold: true });
    cv.text(COL.role, y + 8, fit(s.role.replace(' / ', '/'), 9, true, 52), { size: 9, bold: true, color: s.role === 'BCBA' ? ACCENT : INK });
    cv.text(COL.rate, y + 8, fit(s.hourlyRateText, 10, false, 108), { size: 10, align: 'right' });
    cv.text(COL.hours, y + 8, s.workedTime, { size: 10, align: 'right' });
    cv.text(COL.payout, y + 8, s.payoutText, { size: 10, bold: true, align: 'right' });
    cv.rule(M_X, y, M_X + CONTENT_W, y, LINE);
    cv.y = y;
  }
  if (st.staff.length === 0) {
    cv.text(COL.name, cv.y - 16, 'No staff were paid for this period.', { size: 10, color: MUTED });
    cv.y -= ROW_H;
  }
  cv.y -= 12;

  drawTotalBand(cv, {
    label: 'TOTAL COMPANY PAYROLL',
    detail: `${st.totals.staffCount} staff member${st.totals.staffCount === 1 ? '' : 's'}   •   ${workedTime(st.totals.totalMinutes)} worked`,
    amount: money(st.totals.totalAmount),
  });
  drawFooters(cv, st.companyName);
  return assemble(cv.pages);
}
