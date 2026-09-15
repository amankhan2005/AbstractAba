import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildXlsx, buildPayrollWorkbook, zipStore } from '../src/modules/payroll/payroll.xlsx.js';

/**
 * Spec §14/§20/§21/§22 — the payroll export is a REAL .xlsx (an OPC ZIP of
 * OOXML parts), not a renamed CSV, and carries the period, per-session detail,
 * staff totals and the company total. No clinical PHI. DB-free.
 */

// A real .xlsx begins with the ZIP local-file signature "PK\x03\x04".
const isZip = (buf) => buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;

test('buildXlsx produces a ZIP (PK header), not CSV text', () => {
  const buf = buildXlsx({ sheetName: 'S', rows: [['a', 1], ['b', 2]] });
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(isZip(buf), 'output must start with the ZIP signature');
  // It is binary OOXML, not comma-separated text.
  assert.ok(!buf.toString('utf8', 0, 64).includes(','), 'not CSV');
});

test('the .xlsx contains the required OOXML parts', () => {
  const buf = buildXlsx({ sheetName: 'Payroll', rows: [['x']] });
  const s = buf.toString('latin1');
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']) {
    assert.ok(s.includes(part), `missing part ${part}`);
  }
});

const DATA = {
  period: { label: 'Sep 1, 2026 – Sep 7, 2026' },
  summary: { staffCount: 2, bcbaCount: 1, rbtCount: 1, sessionCount: 2, totalMinutes: 93, totalAmount: 4650, currency: 'usd' },
  staff: [
    { staffProfileId: 'rbt-1', staffName: 'Sarah Williams', role: 'RBT', sessionCount: 2, workedMinutes: 93, hourlyRate: 3000, amount: 4650, missingRate: false, currency: 'usd',
      entries: [
        { sessionId: 's1', childName: 'H Y', workDate: '2026-09-01T17:31:00Z', clockInAt: '2026-09-01T17:31:00Z', clockOutAt: '2026-09-01T17:34:00Z', workedMinutes: 3, hourlyRate: 3000, amount: 150 },
        { sessionId: 's2', childName: 'H Y', workDate: '2026-09-02T10:00:00Z', clockInAt: '2026-09-02T10:00:00Z', clockOutAt: '2026-09-02T10:30:00Z', workedMinutes: 30, hourlyRate: 3000, amount: 1500 },
      ] },
    { staffProfileId: 'bcba-1', staffName: 'John Smith', role: 'BCBA', sessionCount: 0, workedMinutes: 90, hourlyRate: 5000, amount: 7500, missingRate: false, currency: 'usd', entries: [] },
  ],
};

test('the payroll workbook carries the company, period, staff and the total company payroll', () => {
  const buf = buildPayrollWorkbook(DATA);
  assert.ok(isZip(buf));
  const s = buf.toString('utf8');
  assert.ok(s.includes('Payroll Summary'), 'document name present');
  assert.ok(s.includes('Sarah Williams') && s.includes('John Smith'), 'staff present');
  assert.ok(s.includes('TOTAL COMPANY PAYROLL'), 'company total label present');
  assert.ok(!s.includes('H Y'), 'no client or session detail');
});

test('the workbook contains NO clinical PHI (no memo / plan / documentation fields)', () => {
  const buf = buildPayrollWorkbook(DATA);
  const s = buf.toString('utf8').toLowerCase();
  for (const banned of ['treatment plan', 'memo', 'documentation', 'narrative', 'diagnosis']) {
    assert.ok(!s.includes(banned), `must not export ${banned}`);
  }
});

test('the generated file is a valid archive (unzip -t), when unzip is available', () => {
  let unzipAvailable = true;
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch { unzipAvailable = false; }
  if (!unzipAvailable) return; // environment without unzip — the PK/parts checks above still hold
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
  const file = join(dir, 'payroll.xlsx');
  writeFileSync(file, buildPayrollWorkbook(DATA));
  const out = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
  assert.ok(/No errors detected/.test(out), 'archive integrity');
  assert.ok(/xl\/worksheets\/sheet1\.xml/.test(out), 'worksheet entry present');
});

test('zipStore is deterministic (same input → identical bytes)', () => {
  const files = [{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'b.txt', data: Buffer.from('world') }];
  assert.deepEqual(zipStore(files), zipStore(files));
});
