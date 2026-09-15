import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPayrollPdf } from '../src/modules/payroll/payroll.pdf.js';
import { buildPayrollWorkbook } from '../src/modules/payroll/payroll.xlsx.js';
import { generatedPayroll } from './_payroll-fixture.js';
import { readBillPdf, readPayrollWorkbook, pdfLiteralBytes } from './_bill-export-read.js';

/**
 * THE PAYROLL SUMMARY PDF — the real file is written, read back and its visible
 * text asserted: company, Payroll Summary, payroll period, one row per staff
 * member (name, role, hourly rate, hours worked, payout) and the total company
 * payroll — and nothing session-level.
 */
const PAYROLL = generatedPayroll();
function generate(data = PAYROLL) {
  const dir = mkdtempSync(join(tmpdir(), 'payroll-pdf-'));
  writeFileSync(join(dir, 'payroll.pdf'), buildPayrollPdf(data));
  const bytes = readFileSync(join(dir, 'payroll.pdf'));
  const pages = readBillPdf(bytes);
  return { bytes, pages, text: pages.flat() };
}
const findSequence = (items, seq) => items.findIndex((_, i) => seq.every((v, k) => items[i + k] === v));

test('a structurally valid PDF with exact stream lengths and page numbers', () => {
  const { bytes, text } = generate();
  const raw = bytes.toString('latin1');
  assert.ok(raw.startsWith('%PDF-') && raw.includes('/Type /Catalog') && raw.includes('xref') && raw.trimEnd().endsWith('%%EOF'));
  for (const m of raw.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index + m[0].length;
    assert.ok(raw.slice(start, start + Number(m[1]) + 10).endsWith('\nendstream'));
  }
  assert.ok(text.includes('Page 1 of 1'));
});

test('header: company name, Payroll Summary, payroll period and staff paid', () => {
  const { text } = generate();
  assert.deepEqual(text.slice(0, 6), ['Demo ABA Clinic', 'Payroll Summary', 'PAYROLL PERIOD', '09/07/2026 – 09/13/2026', 'STAFF PAID', '5']);
  assert.deepEqual(text.slice(6, 11), ['STAFF NAME', 'ROLE', 'HOURLY RATE', 'HOURS WORKED', 'PAYOUT']);
});

test('one row per staff member with role, hourly rate, hours worked and payout', () => {
  const { text } = generate();
  for (const seq of [
    ['Ellen Ng', 'BCBA', '$60.00/hr', '1h 30m', '$90.00'],
    ['Test1 J', 'BCBA', '$50.00/hr', '6h 00m', '$300.00'],
    ['Ann Lee', 'RBT', '$30.00/hr', '0h 45m', '$22.50'],
    ['Mark Ray', 'RBT', '$30.00/hr / $32.00/hr', '2h 00m', '$62.00'],
    ['Test2 K', 'RBT', '$25.00/hr', '2h 30m', '$62.50'],
  ]) assert.ok(findSequence(text, seq) >= 0, seq.join(' | '));
});

test('TOTAL COMPANY PAYROLL equals the generated payroll', () => {
  const { text } = generate();
  const at = text.indexOf('TOTAL COMPANY PAYROLL');
  assert.deepEqual(text.slice(at, at + 3), ['TOTAL COMPANY PAYROLL', '5 staff members   •   12h 45m worked', '$537.00']);
});

test('the PDF and the Excel carry the same staff, roles, rates, hours, payouts and total', () => {
  const { text } = generate();
  const wb = readPayrollWorkbook(buildPayrollWorkbook(PAYROLL));
  const usd = (v) => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  for (const r of wb.table) {
    const rate = r['Hourly Rate'].numeric ? `${usd(r['Hourly Rate'].value)}/hr` : r['Hourly Rate'].value;
    assert.ok(findSequence(text, [r['Staff Name'].value, r.Role.value, rate, r['Hours Worked'].value, usd(r.Payout.value)]) >= 0, r['Staff Name'].value);
  }
  assert.ok(text.includes(usd(wb.total.Payout.value)));
});

test('a payroll summary only: no sessions, clients, dates of work, times, minutes, identifiers, timezone or timestamp', () => {
  const joined = generate().text.join('\n');
  for (const bad of ['Session', 'session', 'Client', 'Appointment', 'Authorization', 'Claim', 'run-internal-id', 'Generated', 'America/', 'minutes', 'Timezone']) assert.ok(!joined.includes(bad), `found "${bad}"`);
  assert.ok(!/\d{1,2}:\d{2}\s?(AM|PM)/.test(joined));
  assert.equal((joined.match(/\d{2}\/\d{2}\/\d{4}/g) ?? []).length, 2, 'the only dates are the payroll period');
});

test('many staff paginate cleanly: the table header repeats and every page is numbered', () => {
  const staff = Array.from({ length: 60 }, (_, i) => ({ staffProfileId: `s${i}`, staffName: `Staff ${String(i + 1).padStart(2, '0')}`, role: i % 2 ? 'RBT' : 'BCBA', hourlyRates: [2500], workedMinutes: 60, amount: 2500 }));
  const { pages } = generate({ ...PAYROLL, staff, summary: { totalMinutes: 3600, totalAmount: 150000 } });
  assert.ok(pages.length > 1);
  pages.forEach((p, i) => {
    assert.ok(p.includes(`Page ${i + 1} of ${pages.length}`));
    assert.ok(p.includes('STAFF NAME') && p.includes('PAYOUT'), `table header on page ${i + 1}`);
  });
  assert.equal(pages.flat().filter((t) => /^Staff \d\d$/.test(t)).length, 60);
  assert.ok(pages.at(-1).includes('$1,500.00'));
});

test('an empty payroll still produces a valid PDF that says so; no control bytes', () => {
  const { text } = generate({ organization: { name: 'Demo ABA Clinic' }, period: { label: '09/07/2026 – 09/13/2026' }, staff: [], summary: { totalMinutes: 0, totalAmount: 0 } });
  assert.ok(text.includes('No staff were paid for this period.') && text.includes('$0.00'));
  assert.equal(pdfLiteralBytes(buildPayrollPdf(PAYROLL)).filter((b) => b < 0x20).length, 0);
});
