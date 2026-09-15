import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCompanyBillingPdf } from '../src/modules/claims/claims.pdf.js';
import { buildCompanyInsuranceWorkbook } from '../src/modules/claims/claims.xlsx.js';
import { generatedBillDataset } from './_bill-fixture.js';
import { readBillPdf, readBillWorkbook, pdfLiteralBytes } from './_bill-export-read.js';

/**
 * THE INSURANCE BILL PDF, verified by writing the real file to disk, reading the
 * bytes back and extracting the text a viewer would display. It is a bill
 * SUMMARY: company, Insurance Bill, billing period, each client's BCBA and RBT
 * (hourly rate, worked hours, charge), client totals and the company total.
 */
const BILL = generatedBillDataset();

function generate(data = BILL) {
  const dir = mkdtempSync(join(tmpdir(), 'bill-pdf-'));
  const file = join(dir, 'insurance-bill.pdf');
  writeFileSync(file, buildCompanyBillingPdf(data));
  const bytes = readFileSync(file);
  const pages = readBillPdf(bytes);
  return { bytes, size: statSync(file).size, pages, text: pages.flat() };
}
/** Index of `seq` appearing as consecutive text items. */
const findSequence = (items, seq) => items.findIndex((_, i) => seq.every((s, k) => items[i + k] === s));

test('the generated file is a structurally valid PDF with page numbers', () => {
  const { bytes, size, text } = generate();
  const raw = bytes.toString('latin1');
  assert.ok(raw.startsWith('%PDF-'));
  assert.ok(raw.includes('/Type /Catalog') && raw.includes('/Type /Page') && raw.includes('xref') && raw.includes('trailer'));
  assert.ok(raw.trimEnd().endsWith('%%EOF'));
  assert.ok(size > 2000, `suspiciously small PDF (${size} bytes)`);
  for (const m of raw.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index + m[0].length;
    assert.equal(raw.slice(start, start + Number(m[1]) + '\nendstream'.length).endsWith('\nendstream'), true, 'stream lengths are exact');
  }
  assert.ok(text.includes('Page 1 of 1'));
});

test('header: company name, Insurance Bill and the billing period', () => {
  const { text } = generate();
  assert.deepEqual(text.slice(0, 4), ['Demo ABA Clinic', 'Insurance Bill', 'BILLING PERIOD', '09/07/2026 – 09/14/2026']);
});

test('each client lists its BCBA and RBT with hourly rate, worked hours and charge, then the client total', () => {
  const { text } = generate();
  const at = findSequence(text, ['CLIENT', 'Raymond K']);
  assert.ok(at >= 0, 'Raymond K card');
  const card = text.slice(at, text.indexOf('CLIENT TOTAL', at) + 2);
  assert.ok(findSequence(card, ['BCBA', 'Test1 J', '$10.00/hr', '6h 44m', '$67.33']) >= 0, card.join(' | '));
  assert.ok(findSequence(card, ['RBT', 'Test2 K', '$20.00/hr', '2h 38m', '$52.67']) >= 0, card.join(' | '));
  assert.deepEqual(card.slice(-2), ['CLIENT TOTAL', '$120.00']);
});

test('BCBA-only, RBT-only and two-BCBA clients', () => {
  const { text } = generate();
  const card = (name) => { const at = findSequence(text, ['CLIENT', name]); return text.slice(at, text.indexOf('CLIENT TOTAL', at) + 2); };
  const bella = card('Bella B');
  assert.ok(findSequence(bella, ['BCBA', 'Test1 J', '$10.00/hr', '1h 01m', '$10.17']) >= 0 && !bella.includes('RBT'));
  const carl = card('Carl C');
  assert.ok(findSequence(carl, ['RBT', 'Test2 K', '$20.00/hr', '0h 45m', '$15.00']) >= 0 && !carl.includes('BCBA'));
  const dana = card('Dana D');
  assert.ok(findSequence(dana, ['BCBA', 'Test1 J', '$10.00/hr', '1h 00m', '$10.00', 'BCBA', 'Test3 L', '$30.00/hr', '1h 30m', '$45.00', 'RBT', 'Test2 K', '$20.00/hr', '0h 30m', '$10.00']) >= 0, dana.join(' | '));
  assert.deepEqual(dana.slice(-2), ['CLIENT TOTAL', '$65.00']);
});

test('TOTAL COMPANY INSURANCE BILLING is the generated bill total', () => {
  const { text } = generate();
  const at = text.indexOf('TOTAL COMPANY INSURANCE BILLING');
  assert.deepEqual(text.slice(at, at + 3), ['TOTAL COMPANY INSURANCE BILLING', 'BCBA $132.50   •   RBT $77.67', '$210.17']);
  assert.equal(BILL.summary.totalBillableAmount, 21017);
});

test('the PDF and the Excel carry the same clients, staff, rates, worked hours, charges and totals', () => {
  const { text } = generate();
  const wb = readBillWorkbook(buildCompanyInsuranceWorkbook(BILL));
  const usd = (v) => `$${Number(v).toFixed(2)}`;
  for (const r of wb.table) {
    const at = findSequence(text, ['CLIENT', r['Client Name'].value]);
    const card = text.slice(at, text.indexOf('CLIENT TOTAL', at) + 2);
    for (const role of ['BCBA', 'RBT']) {
      if (r[`${role} Name`].value === '') { assert.ok(!card.includes(role)); continue; }
      const names = String(r[`${role} Name`].value).split('\n');
      const hours = String(r[`${role} Worked Hours`].value).split('\n');
      const rates = r[`${role} Hourly Rate`].numeric ? [`${usd(r[`${role} Hourly Rate`].value)}/hr`] : String(r[`${role} Hourly Rate`].value).split('\n');
      names.forEach((n, i) => assert.ok(findSequence(card, [role, n, rates[i], hours[i]]) >= 0, `${r['Client Name'].value} ${role} ${n}`));
      if (names.length === 1) assert.ok(card.includes(usd(r[`${role} Charge`].value)));
    }
    assert.equal(card.at(-1), usd(r['Client Total'].value));
  }
  assert.ok(text.includes(usd(wb.total['Client Total'].value)));
});

test('a bill summary only: no sessions, times, dates, minutes, claim numbers, authorizations, billing codes, statuses, timezone or timestamp', () => {
  const joined = generate().text.join('\n');
  for (const bad of ['Session', 'session', 'Service date', 'Claim', 'CLM-', 'AUTH-', 'Authorization', '97153', 'Billing code', 'Billed', 'Ready', 'Incomplete',
    'America/', 'New_York', 'Timezone', 'Generated', 'minutes', 'Payer', 'Acme Health']) assert.ok(!joined.includes(bad), `found "${bad}"`);
  assert.ok(!/\d{1,2}:\d{2}\s?(AM|PM)/.test(joined), 'no clock times');
  assert.equal((joined.match(/\d{2}\/\d{2}\/\d{4}/g) ?? []).length, 2, 'the only dates are the billing period');
  assert.ok(!/\b404\b|\b158\b|6\.73|2\.63/.test(joined), 'no raw minutes or decimal hours');
});

test('many clients paginate cleanly: page numbers on every page, and a client card is never split across pages', () => {
  const plan = Array.from({ length: 30 }, (_, i) => [
    { client: `c${i}`, staff: 'b1', role: 'BCBA', minutes: [60 + i] },
    { client: `c${i}`, staff: 'r1', role: 'RBT', minutes: [30 + i] },
  ]).flat();
  const clients = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`c${i}`, { _id: `c${i}`, firstName: 'Client', lastName: String(i + 1).padStart(2, '0') }]));
  const data = generatedBillDataset({ plan, clients });
  const { pages } = generate(data);
  assert.ok(pages.length > 1);
  pages.forEach((p, i) => assert.ok(p.includes(`Page ${i + 1} of ${pages.length}`)));
  for (const p of pages) {
    const starts = p.filter((t) => t === 'CLIENT').length;
    const ends = p.filter((t) => t === 'CLIENT TOTAL').length;
    assert.equal(starts, ends, 'every card on a page ends on that page');
  }
  assert.equal(pages.flat().filter((t) => /^Client \d\d$/.test(t)).length, 30);
  assert.ok(pages.at(-1).includes('TOTAL COMPANY INSURANCE BILLING'));
});

test('an empty bill still produces a valid PDF that says so', () => {
  const { bytes, text } = generate({ organization: { name: 'Demo ABA Clinic' }, period: { label: '09/07/2026 – 09/14/2026' }, clients: [], summary: {} });
  assert.ok(bytes.toString('latin1').startsWith('%PDF-'));
  assert.ok(text.includes('No billed services in this period.') && text.includes('$0.00'));
});

test('no character is emitted as a control byte; en dash and accented names survive', () => {
  const data = generatedBillDataset({ clients: { cR: { _id: 'cR', firstName: 'José', lastName: 'Núñez' }, cB: { _id: 'cB', firstName: 'Bella', lastName: 'B' }, cC: { _id: 'cC', firstName: 'Carl', lastName: 'C' }, cD: { _id: 'cD', firstName: 'Dana', lastName: 'D' } } });
  const buf = buildCompanyBillingPdf(data);
  assert.equal(pdfLiteralBytes(buf).filter((b) => b < 0x20).length, 0);
  const text = readBillPdf(buf).flat();
  assert.ok(text.includes('José Núñez'));
  assert.ok(text.includes('09/07/2026 – 09/14/2026'));
});

test('no clinical or review wording is written into the bill', () => {
  const joined = generate().text.join('\n').toLowerCase();
  for (const f of ['narrative', 'note', 'diagnosis', 'observation', 'unit price', 'review', 'approve']) assert.ok(!joined.includes(f), f);
});
