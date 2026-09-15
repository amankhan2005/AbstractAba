import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayrollWorkbook } from '../src/modules/payroll/payroll.xlsx.js';
import { generatedPayroll } from './_payroll-fixture.js';
import { readPayrollWorkbook, valuesOf } from './_bill-export-read.js';

/**
 * THE PAYROLL SUMMARY EXCEL — verified cell by cell from the generated file
 * (unzipped and read by column reference). The input is a generated payroll
 * built by the real payroll aggregation (_payroll-fixture): two BCBAs, three
 * RBTs with their own rates, one of them with a mid-period rate change.
 */
const PAYROLL = generatedPayroll();
const book = (data = PAYROLL) => readPayrollWorkbook(buildPayrollWorkbook(data));
const row = (wb, name) => wb.table.find((r) => r['Staff Name'].value === name);
const COLS = ['Role', 'Hourly Rate', 'Hours Worked', 'Payout'];

test('ONE "Payroll Summary" sheet: company name, Payroll Summary, Payroll Period, then the staff table', () => {
  const wb = book();
  assert.deepEqual(wb.sheetNames, ['Payroll Summary']);
  assert.deepEqual(wb.rows.slice(0, 3).map((r) => r.map((c) => c.value).filter((v) => v !== '')), [['Demo ABA Clinic'], ['Payroll Summary'], ['Payroll Period', '09/07/2026 – 09/13/2026']]);
  assert.deepEqual(wb.header, ['Staff Name', 'Role', 'Hourly Rate', 'Hours Worked', 'Payout']);
  assert.deepEqual(wb.table.map((r) => r['Staff Name'].value), ['Ellen Ng', 'Test1 J', 'Ann Lee', 'Mark Ray', 'Test2 K']);
});

test('each staff member: role, hourly rate, hours worked "Xh Ym" and payout — BCBA and RBT both present', () => {
  const wb = book();
  assert.deepEqual(valuesOf(row(wb, 'Test1 J'), COLS), ['BCBA', 50, '6h 00m', 300]);
  assert.deepEqual(valuesOf(row(wb, 'Ellen Ng'), COLS), ['BCBA', 60, '1h 30m', 90]);
  assert.deepEqual(valuesOf(row(wb, 'Test2 K'), COLS), ['RBT', 25, '2h 30m', 62.5]);
  assert.deepEqual(valuesOf(row(wb, 'Ann Lee'), COLS), ['RBT', 30, '0h 45m', 22.5]);
  assert.deepEqual(valuesOf(row(wb, 'Mark Ray'), COLS), ['RBT', '$30.00/hr / $32.00/hr', '2h 00m', 62]);
  const t = row(wb, 'Test1 J');
  assert.deepEqual([t['Hourly Rate'].numeric, t['Hours Worked'].numeric, t.Payout.numeric], [true, false, true]);
});

test('TOTAL COMPANY PAYROLL equals the generated payroll and the sum of staff payouts', () => {
  const wb = book();
  assert.deepEqual(valuesOf(wb.total, ['Hours Worked', 'Payout']), ['12h 45m', 537]);
  assert.equal(Math.round(wb.total.Payout.value * 100), PAYROLL.summary.totalAmount);
  assert.equal(Math.round(wb.table.reduce((t, r) => t + r.Payout.value, 0) * 100), PAYROLL.summary.totalAmount);
});

test('a payroll summary only: no minutes, decimal hours, sessions, clients, dates, times, identifiers, timezone or timestamp', () => {
  const wb = book();
  const text = wb.cells.map(String).join('|');
  for (const bad of ['Minutes', 'Session', 'Client', 'Service', 'Appointment', 'Authorization', 'Billing', 'Claim', 'run-internal-id', 'Generated', 'Timezone', 'America/', 'undefined', 'null', 'NaN']) {
    assert.ok(!text.includes(bad), `found "${bad}"`);
  }
  assert.ok(!wb.cells.some((v) => v === 360 || v === 765 || v === 6 || v === 2.5), 'no raw minutes or decimal hours');
  assert.ok(!/\d{1,2}:\d{2}\s?(AM|PM)/.test(text));
  assert.equal((text.match(/\d{2}\/\d{2}\/\d{4}/g) ?? []).length, 2, 'the only dates are the payroll period');
});

test('professional workbook: currency and per-hour formats, filled header, highlighted total, frozen header, merged title', () => {
  const wb = book();
  const xf = [...wb.stylesXml.matchAll(/<xf numFmtId="(\d+)"[^>]*?(?:\/>|>.*?<\/xf>)/gs)].slice(1).map((m) => m[1]);
  const t = row(wb, 'Test1 J');
  assert.equal(xf[t['Hourly Rate'].style], '165', '$50.00/hr');
  assert.equal(xf[t.Payout.style], '164', '$300.00');
  assert.equal(xf[wb.total.Payout.style], '164');
  assert.ok(/<pane ySplit="5" topLeftCell="A6"[^>]*state="frozen"/.test(wb.sheetXml));
  assert.ok(wb.sheetXml.includes('<dimension ref="A1:E') && wb.sheetXml.includes('<mergeCell ref="A1:E1"/>'));
});

test('an empty payroll still produces a valid workbook that says so', () => {
  const wb = book({ organization: { name: 'Demo ABA Clinic' }, period: { label: '09/07/2026 – 09/13/2026' }, staff: [], summary: { totalMinutes: 0, totalAmount: 0 } });
  assert.ok(wb.cells.includes('No staff were paid for this period.'));
  assert.equal(wb.total.Payout.value, 0);
});
