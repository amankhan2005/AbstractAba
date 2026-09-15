import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompanyInsuranceWorkbook } from '../src/modules/claims/claims.xlsx.js';
import { generatedBillDataset } from './_bill-fixture.js';
import { readBillWorkbook, valuesOf } from './_bill-export-read.js';

/**
 * THE INSURANCE BILL EXCEL — verified cell by cell from the generated file.
 * The input is a generated bill built the way generation persists it
 * (_bill-fixture): Raymond K (BCBA + RBT), Bella B (BCBA only), Carl C (RBT
 * only), Dana D (two BCBAs + an RBT). The workbook is a bill SUMMARY: one sheet,
 * one row per client, BCBA and RBT side by side, a company total.
 */
const BILL = generatedBillDataset();
const book = (data = BILL) => readBillWorkbook(buildCompanyInsuranceWorkbook(data));
const row = (wb, name) => wb.table.find((r) => r['Client Name'].value === name);
const BCBA = ['BCBA Name', 'BCBA Hourly Rate', 'BCBA Worked Hours', 'BCBA Charge'];
const RBT = ['RBT Name', 'RBT Hourly Rate', 'RBT Worked Hours', 'RBT Charge'];

test('ONE "Insurance Bill" sheet: company name, Insurance Bill, Billing Period, then the summary columns', () => {
  const wb = book();
  assert.deepEqual(wb.sheetNames, ['Insurance Bill']);
  assert.deepEqual(wb.rows.slice(0, 3).map((r) => r.map((c) => c.value).filter((v) => v !== '')), [['Demo ABA Clinic'], ['Insurance Bill'], ['Billing Period', '09/07/2026 – 09/14/2026']]);
  assert.deepEqual(wb.header, ['Client Name', 'BCBA Name', 'BCBA Hourly Rate', 'BCBA Worked Hours', 'BCBA Charge',
    'RBT Name', 'RBT Hourly Rate', 'RBT Worked Hours', 'RBT Charge', 'Client Total']);
  assert.deepEqual(wb.table.map((r) => r['Client Name'].value), ['Bella B', 'Carl C', 'Dana D', 'Raymond K']);
});

test('a client with BCBA and RBT carries BOTH: names, hourly rates, worked hours "Xh Ym" and charges, then the client total', () => {
  const r = row(book(), 'Raymond K');
  assert.deepEqual(valuesOf(r, BCBA), ['Test1 J', 10, '6h 44m', 67.33]);
  assert.deepEqual(valuesOf(r, RBT), ['Test2 K', 20, '2h 38m', 52.67]);
  assert.equal(r['Client Total'].value, 120);
  // Rates and charges are real numbers formatted as currency; worked hours are text.
  assert.deepEqual([r['BCBA Hourly Rate'].numeric, r['BCBA Charge'].numeric, r['RBT Charge'].numeric, r['Client Total'].numeric, r['BCBA Worked Hours'].numeric], [true, true, true, true, false]);
});

test('BCBA-only and RBT-only clients leave the other role empty — never a made-up $0.00 clinician', () => {
  const wb = book();
  assert.deepEqual(valuesOf(row(wb, 'Bella B'), [...BCBA, ...RBT, 'Client Total']), ['Test1 J', 10, '1h 01m', 10.17, '', '', '', '', 10.17]);
  assert.deepEqual(valuesOf(row(wb, 'Carl C'), [...BCBA, ...RBT, 'Client Total']), ['', '', '', '', 'Test2 K', 20, '0h 45m', 15, 15]);
});

test('two BCBAs for one client are both listed with their own rate and worked hours; the BCBA charge is their sum', () => {
  const r = row(book(), 'Dana D');
  assert.deepEqual(valuesOf(r, BCBA), ['Test1 J\nTest3 L', '$10.00/hr\n$30.00/hr', '1h 00m\n1h 30m', 55]);
  assert.deepEqual(valuesOf(r, [...RBT, 'Client Total']), ['Test2 K', 20, '0h 30m', 10, 65]);
});

test('TOTAL COMPANY INSURANCE BILLING equals the generated bill and the sum of the client totals', () => {
  const wb = book();
  assert.deepEqual(valuesOf(wb.total, ['BCBA Worked Hours', 'BCBA Charge', 'RBT Worked Hours', 'RBT Charge', 'Client Total']), ['10h 15m', 132.5, '3h 53m', 77.67, 210.17]);
  assert.equal(Math.round(wb.total['Client Total'].value * 100), BILL.summary.totalBillableAmount);
  assert.equal(Math.round(wb.table.reduce((t, r) => t + r['Client Total'].value, 0) * 100), BILL.summary.totalBillableAmount);
  for (const r of wb.table) {
    const c = BILL.clients.find((x) => x.clientName === r['Client Name'].value);
    assert.deepEqual([Math.round((Number(r['BCBA Charge'].value) || 0) * 100), Math.round((Number(r['RBT Charge'].value) || 0) * 100), Math.round(r['Client Total'].value * 100)], [c.bcbaCharge, c.rbtCharge, c.clientTotal], c.clientName);
  }
});

test('a bill summary only: no minutes, decimal hours, sessions, dates, times, claim numbers, authorizations, billing codes, timezone or timestamp', () => {
  const wb = book();
  const text = wb.cells.map(String).join('|');
  for (const bad of ['Minutes', 'Sessions', 'Service Date', 'Session Start', 'Session End', 'Status', 'Claim', 'Authorization', 'Billing Code', 'Payer', 'Timezone', 'Generated',
    'CLM-', 'AUTH-', '97153', 'America/', 'New_York', 'undefined', 'null', 'NaN']) assert.ok(!text.includes(bad), `found "${bad}"`);
  assert.ok(!wb.cells.some((v) => v === 404 || v === 158 || v === 6.73 || v === 2.63), 'no raw minutes or decimal hours');
  assert.ok(!/\d{1,2}:\d{2}\s?(AM|PM)/.test(text), 'no clock times');
  assert.equal((text.match(/\d{2}\/\d{2}\/\d{4}/g) ?? []).length, 2, 'the only dates are the billing period');
});

test('professional workbook: currency and per-hour formats, bordered table, filled header, frozen header, merged title, landscape print', () => {
  const wb = book();
  assert.ok(wb.stylesXml.includes('formatCode="&quot;$&quot;#,##0.00&quot;/hr&quot;"'), 'the $0.00/hr format');
  assert.ok(wb.stylesXml.includes('formatCode="&quot;$&quot;#,##0.00"'), 'the currency format');
  const xf = [...wb.stylesXml.matchAll(/<xf numFmtId="(\d+)"[^>]*?(?:\/>|>.*?<\/xf>)/gs)].slice(1).map((m) => m[1]); // cellXfs (skip the cellStyleXfs entry)
  const r = row(wb, 'Raymond K');
  assert.equal(xf[r['BCBA Hourly Rate'].style], '165', 'rate cell shows $10.00/hr');
  assert.equal(xf[r['BCBA Charge'].style], '164', 'charge cell shows $67.33');
  assert.equal(xf[wb.total['Client Total'].style], '164', 'company total shows currency');
  assert.ok(/<pane ySplit="5" topLeftCell="A6"[^>]*state="frozen"/.test(wb.sheetXml), 'the title and header rows stay visible');
  assert.ok(wb.sheetXml.includes('<dimension ref="A1:J'), 'the used range is declared');
  assert.ok(wb.sheetXml.includes('<mergeCell ref="A1:J1"/>') && wb.sheetXml.includes('<pageSetup orientation="landscape"'));
  assert.ok(wb.stylesXml.includes('<fgColor rgb="FF1F2A44"/>') && wb.stylesXml.includes('style="medium"'), 'filled header and highlighted total');
});

test('names are shown the way the Insurance Billing page shows them', () => {
  // The fixture stores "test1 j"; the page formats it as "Test1 J".
  assert.equal(row(book(), 'Raymond K')['BCBA Name'].value, 'Test1 J');
});

test('a staff member whose BCBA/RBT role is not set is listed in an Other Staff column — never dropped', () => {
  // A line saved before roles were stored, whose role cannot be established.
  const data = generatedBillDataset({ plan: [{ client: 'cR', staff: 'b1', role: 'BCBA', minutes: [60] }, { client: 'cR', staff: 'b2', role: null, minutes: [30] }] });
  const wb = book(data);
  assert.equal(wb.header.at(-1), 'Other Staff');
  assert.equal(row(wb, 'Raymond K')['Other Staff'].value, 'Test3 L · $30.00/hr · 0h 30m · $15.00');
  assert.ok(!book().header.includes('Other Staff'), 'the column only appears when needed');
});

test('an empty bill still produces a valid workbook that says so', () => {
  const wb = book({ organization: { name: 'Demo ABA Clinic' }, period: { label: '09/07/2026 – 09/14/2026' }, clients: [], summary: {} });
  assert.ok(wb.cells.includes('No billed services in this period.'));
  assert.equal(wb.total['Client Total'].value, 0);
});
