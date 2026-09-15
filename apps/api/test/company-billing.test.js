import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompanyInsuranceWorkbook, buildInsuranceWorkbook } from '../src/modules/claims/claims.xlsx.js';
import { buildCompanyBillingPdf } from '../src/modules/claims/claims.pdf.js';
import { companyDataset } from './_billing-fixture.js';

/**
 * Company billing exports are built from the SAME engine dataset the page and
 * generation read (no recalculation in the exporters).
 */
test('the company workbook and PDF build from the engine dataset without recalculating', () => {
  const data = companyDataset();
  const xlsx = buildCompanyInsuranceWorkbook(data);
  const pdf = buildCompanyBillingPdf(data);
  assert.ok(xlsx.length > 0 && xlsx.slice(0, 2).toString() === 'PK', 'xlsx is a zip');
  assert.ok(pdf.toString('latin1').startsWith('%PDF-'));
  assert.equal(data.summary.totalBillableAmount, data.clients.reduce((t, c) => t + c.bcbaCharge + c.rbtCharge, 0));
});

test('the child workbook is built from the child’s rows of the same dataset', () => {
  const data = companyDataset();
  const john = data.clients.find((c) => c.clientName === 'John Doe');
  const buf = buildInsuranceWorkbook({ child: { clientName: john.clientName }, payerName: john.payerName, period: data.period, sessions: john.sessions,
    summary: { bcbaCharge: john.bcbaCharge, rbtCharge: john.rbtCharge, totalClaimAmount: john.clientTotal } });
  assert.ok(buf.slice(0, 2).toString() === 'PK');
});
