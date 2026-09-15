import { billStatement, money } from './bill.statement.js';
import {
  Canvas, assemble, fit, drawDocumentHeader, drawTotalBand, drawFooters,
  M_X, CONTENT_W, MUTED, LINE, PANEL, ACCENT, INK,
} from '../../common/pdf/statementPdf.js';

/**
 * THE INSURANCE BILL PDF — a professional bill summary, drawn with the shared
 * statement PDF writer (common/pdf/statementPdf.js).
 *
 * It renders the same statement as the Excel download (billStatement over the
 * generated bill): company name, "Insurance Bill", the billing period, then for
 * every client each BCBA and RBT with hourly rate, worked hours and charge, the
 * client total, and finally the TOTAL COMPANY INSURANCE BILLING. Page numbers
 * sit in the footer.
 *
 * Deliberately excluded: individual sessions, times, service dates,
 * authorizations, billing codes, claim numbers, statuses, worked minutes,
 * timezone and generation timestamp. No clinical information of any kind.
 */

// Client table columns: Role | Staff Member | Hourly Rate | Worked Hours | Charge.
const COL = {
  role: M_X + 14,
  name: M_X + 70,
  rate: M_X + CONTENT_W - 220, // right edges from here on
  hours: M_X + CONTENT_W - 120,
  charge: M_X + CONTENT_W - 14,
};
const ROW_H = 20;

/** One client card: name bar, a row per BCBA / RBT staff member, the client total. Never split across pages. */
function clientCard(cv, client) {
  const lines = [
    ...client.bcba.map((l) => ({ role: 'BCBA', ...l })),
    ...client.rbt.map((l) => ({ role: 'RBT', ...l })),
    ...client.other.map((l) => ({ role: 'Staff', ...l })),
  ];
  const height = 30 + 18 + Math.max(1, lines.length) * ROW_H + 30 + 14;
  cv.ensure(height);
  const top = cv.y;

  // Name bar.
  cv.rect(M_X, top - 30, CONTENT_W, 30, PANEL);
  cv.rect(M_X, top - 30, 3, 30, ACCENT);
  cv.text(M_X + 14, top - 19, 'CLIENT', { size: 7.5, bold: true, color: MUTED });
  cv.text(M_X + 58, top - 20, fit(client.clientName, 12, true, CONTENT_W - 80), { size: 12, bold: true });

  // Column headings.
  let y = top - 30 - 14;
  cv.text(COL.role, y, 'ROLE', { size: 7.5, bold: true, color: MUTED });
  cv.text(COL.name, y, 'STAFF MEMBER', { size: 7.5, bold: true, color: MUTED });
  cv.text(COL.rate, y, 'HOURLY RATE', { size: 7.5, bold: true, color: MUTED, align: 'right' });
  cv.text(COL.hours, y, 'WORKED HOURS', { size: 7.5, bold: true, color: MUTED, align: 'right' });
  cv.text(COL.charge, y, 'CHARGE', { size: 7.5, bold: true, color: MUTED, align: 'right' });
  y -= 4;
  cv.rule(M_X + 14, y, M_X + CONTENT_W - 14, y);

  for (const l of lines) {
    y -= ROW_H;
    cv.text(COL.role, y + 6, l.role, { size: 8.5, bold: true, color: l.role === 'BCBA' ? ACCENT : INK });
    cv.text(COL.name, y + 6, fit(l.name, 10, false, COL.rate - COL.name - 90), { size: 10 });
    cv.text(COL.rate, y + 6, l.hourlyRateText, { size: 10, align: 'right' });
    cv.text(COL.hours, y + 6, l.workedTime, { size: 10, align: 'right' });
    cv.text(COL.charge, y + 6, money(l.charge), { size: 10, align: 'right' });
    cv.rule(M_X + 14, y, M_X + CONTENT_W - 14, y);
  }
  if (lines.length === 0) {
    y -= ROW_H;
    cv.text(COL.name, y + 6, 'No billed services in this period.', { size: 10, color: MUTED });
  }

  // Client total.
  y -= 22;
  cv.text(COL.hours, y, 'CLIENT TOTAL', { size: 8.5, bold: true, color: MUTED, align: 'right' });
  cv.text(COL.charge, y, money(client.clientTotal), { size: 12, bold: true, align: 'right' });
  cv.rule(M_X, y - 10, M_X + CONTENT_W, y - 10, LINE, 1);
  cv.y = y - 10 - 14;
}

/** Build the Insurance Bill PDF from the generated bill. */
export function buildCompanyBillingPdf(data) {
  const st = billStatement(data);
  const cv = new Canvas();
  drawDocumentHeader(cv, {
    companyName: st.companyName, title: 'Insurance Bill',
    leftLabel: 'BILLING PERIOD', leftValue: st.periodLabel,
    rightLabel: 'CLIENTS', rightValue: String(st.totals.clientCount),
  });

  for (const client of st.clients) clientCard(cv, client);
  if (st.clients.length === 0) {
    cv.text(M_X, cv.y - 10, 'No billed services in this period.', { size: 11, color: MUTED });
    cv.y -= 30;
  }

  drawTotalBand(cv, {
    label: 'TOTAL COMPANY INSURANCE BILLING',
    detail: `BCBA ${money(st.totals.bcbaCharge)}   •   RBT ${money(st.totals.rbtCharge)}`,
    amount: money(st.totals.total),
  });
  drawFooters(cv, st.companyName);
  return assemble(cv.pages);
}
