import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { toXlsx, XLSX_CONTENT_TYPE } from '../src/modules/reports/reports.xlsx.js';

/**
 * Parse a STORE-method ZIP (no compression) into { name -> Buffer } by walking
 * local file headers. Proves the output is a real ZIP container, not HTML with
 * an .xlsx name.
 */
function readStoreZip(buf) {
  const files = {};
  let i = 0;
  while (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const dataStart = i + 30 + nameLen + extraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    files[name] = method === 0 ? raw : inflateRawSync(raw);
    i = dataStart + compSize;
  }
  return files;
}

const HEADERS = ['claimNumber', 'payerName', 'totalCharge'];
const ROWS = [
  ['CLM-1001', 'Blue Shield', 480],
  ['CLM-1002', 'Aetna & Co <East>', 1200.5],
];

test('toXlsx starts with the ZIP signature (real container, not HTML)', () => {
  const buf = toXlsx(HEADERS, ROWS, 'Claims');
  assert.equal(buf[0], 0x50); // 'P'
  assert.equal(buf[1], 0x4b); // 'K'
  assert.doesNotMatch(buf.slice(0, 64).toString('utf8'), /<html|<!DOCTYPE/i);
});

test('workbook contains the required OOXML parts', () => {
  const files = readStoreZip(toXlsx(HEADERS, ROWS, 'Claims'));
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']) {
    assert.ok(files[part], `missing part: ${part}`);
  }
  assert.match(files['[Content_Types].xml'].toString('utf8'), /spreadsheetml\.sheet\.main\+xml/);
});

test('worksheet carries the real header + data, numbers as numbers, text escaped', () => {
  const files = readStoreZip(toXlsx(HEADERS, ROWS, 'Claims'));
  const sheet = files['xl/worksheets/sheet1.xml'].toString('utf8');
  assert.match(sheet, /claimNumber/);
  assert.match(sheet, /CLM-1002/);
  assert.match(sheet, /<v>1200.5<\/v>/);       // numeric cell
  assert.match(sheet, /Aetna &amp; Co &lt;East&gt;/); // XML-escaped text
  assert.doesNotMatch(sheet, /undefined|NaN|\[object Object\]/);
});

test('sheet name is applied and the MIME type is the Excel type', () => {
  const files = readStoreZip(toXlsx(HEADERS, ROWS, 'Claims'));
  assert.match(files['xl/workbook.xml'].toString('utf8'), /name="Claims"/);
  assert.equal(XLSX_CONTENT_TYPE, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});
