import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Readers for the Insurance Bill downloads, used by the export tests. They open
 * the REAL files — the .xlsx is unzipped and its worksheet cells are read by
 * column reference; the PDF's content streams are read back as text — so every
 * assertion is about what a Company Admin would actually see.
 */

const unescapeXml = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

/**
 * @returns {{
 *   sheetNames: string[], sheetXml: string, stylesXml: string,
 *   rows: Array<Array<{ value: string|number, numeric: boolean, style: number }>>,
 *   header: string[], table: Array<object>, total: object, cells: Array<string|number>
 * }}
 */
export function readBillWorkbook(buffer, { firstHeader = 'Client Name', totalLabel = 'TOTAL COMPANY INSURANCE BILLING' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bill-xlsx-'));
  writeFileSync(join(dir, 'bill.xlsx'), buffer);
  execFileSync('unzip', ['-o', '-q', join(dir, 'bill.xlsx'), '-d', dir]);
  const workbookXml = readFileSync(join(dir, 'xl', 'workbook.xml'), 'utf8');
  const sheetNames = [...workbookXml.matchAll(/<sheet name="([^"]+)"/g)].map((m) => unescapeXml(m[1]));
  const sheetXml = readFileSync(join(dir, 'xl', 'worksheets', 'sheet1.xml'), 'utf8');
  const stylesXml = readFileSync(join(dir, 'xl', 'styles.xml'), 'utf8');

  const rows = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>(.*?)<\/row>/gs)) {
    const cells = [];
    for (const c of rowMatch[1].matchAll(/<c\b([^>/]*)\/>|<c\b([^>]*)>(.*?)<\/c>/gs)) {
      const attrs = c[1] ?? c[2] ?? '';
      const body = c[3] ?? '';
      const idx = colIndex(/\br="([A-Z]+)\d+"/.exec(attrs)[1]);
      const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? 0);
      const inline = [...body.matchAll(/<t\b[^>]*>(.*?)<\/t>/gs)].map((m) => m[1]).join('');
      const v = /<v>(.*?)<\/v>/s.exec(body)?.[1];
      let cell;
      if (/t="inlineStr"/.test(attrs)) cell = { value: unescapeXml(inline), numeric: false, style };
      else if (v != null && v !== '') cell = { value: Number(v), numeric: true, style };
      else cell = { value: '', numeric: false, style };
      while (cells.length < idx) cells.push({ value: '', numeric: false, style: 0 });
      cells[idx] = cell;
    }
    rows.push(cells);
  }
  const headerAt = rows.findIndex((r) => r[0]?.value === firstHeader);
  const header = rows[headerAt]?.map((c) => c.value) ?? [];
  const keyed = (r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? { value: '', numeric: false, style: 0 }]));
  const body = rows.slice(headerAt + 1).map(keyed);
  const total = body.find((r) => r[firstHeader].value === totalLabel);
  const table = body.filter((r) => r !== total && r[firstHeader].value !== '');
  return { sheetNames, sheetXml, stylesXml, rows, header, table, total, cells: rows.flat().map((c) => c.value) };
}

/** Plain values of a keyed workbook row, for compact comparisons. */
export const valuesOf = (row, columns) => columns.map((h) => row[h].value);

const WIN_ANSI_REVERSE = new Map([[0x80, '€'], [0x85, '…'], [0x91, '‘'], [0x92, '’'], [0x93, '“'], [0x94, '”'], [0x95, '•'], [0x96, '–'], [0x97, '—']]);

/** The text items of each PDF page, in drawing order: string[][] (one array per page). */
export function readBillPdf(buffer) {
  const raw = buffer.toString('latin1');
  const streams = [...raw.matchAll(/stream\n(.*?)\nendstream/gs)].map((m) => m[1]);
  const decode = (s) => [...s.replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\')].map((ch) => WIN_ANSI_REVERSE.get(ch.charCodeAt(0)) ?? ch).join('');
  return streams.map((st) => [...st.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)].map((m) => decode(m[1])));
}

/** Every byte inside a PDF text literal (to prove none is a control byte). */
export function pdfLiteralBytes(buffer) {
  const bytes = [];
  for (const m of buffer.toString('latin1').matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) for (const ch of m[1]) bytes.push(ch.charCodeAt(0));
  return bytes;
}

/** The Payroll Summary workbook, read the same way. */
export const readPayrollWorkbook = (buffer) => readBillWorkbook(buffer, { firstHeader: 'Staff Name', totalLabel: 'TOTAL COMPANY PAYROLL' });
