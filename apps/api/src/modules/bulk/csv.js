import { AppError } from '../../common/errors/AppError.js';

/**
 * Dependency-free CSV utilities for bulk import/export.
 *
 * parseCsv: a strict RFC-4180 parser (quoted fields, embedded quotes/commas/
 * newlines, CRLF or LF). Bounded by a max row count. Returns { headers, rows }
 * where each row is an object keyed by header. No eval, no regex catastrophe.
 *
 * toSafeCsv: RFC-4180 serialization PLUS spreadsheet formula-injection defense —
 * any field beginning with = + - @ (or tab/CR that some apps treat as leads) is
 * prefixed with a single quote so Excel/Sheets/LibreOffice cannot execute it.
 */

const MAX_ROWS = 5000;
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function parseCsv(text, { maxRows = MAX_ROWS } = {}) {
  if (typeof text !== 'string') throw AppError.validation('CSV content must be text.');
  const src = text.replace(/^\uFEFF/, ''); // strip BOM
  if (src.trim() === '') throw AppError.validation('The CSV file is empty.');

  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => { record.push(field); field = ''; };
  const pushRecord = () => { pushField(); records.push(record); record = []; };

  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ',') { pushField(); i += 1; continue; }
    if (c === '\r') { if (src[i + 1] === '\n') i += 1; pushRecord(); i += 1; continue; }
    if (c === '\n') { pushRecord(); i += 1; continue; }
    field += c; i += 1;
  }
  // trailing field/record (no final newline)
  if (field !== '' || record.length > 0) pushRecord();
  if (inQuotes) throw AppError.validation('Malformed CSV: unterminated quoted field.');

  // Drop a trailing empty record (file ended with newline).
  while (records.length && records[records.length - 1].length === 1 && records[records.length - 1][0] === '') records.pop();
  if (records.length === 0) throw AppError.validation('The CSV file has no rows.');

  const headers = records[0].map((h) => h.trim());
  if (new Set(headers).size !== headers.length) throw AppError.validation('CSV has duplicate header columns.');
  const dataRows = records.slice(1);
  if (dataRows.length > maxRows) throw AppError.validation(`CSV exceeds the maximum of ${maxRows} rows.`);

  const rows = dataRows.map((cols, idx) => {
    const obj = { __row: idx + 2 }; // 1-based, +1 for the header line
    headers.forEach((h, ci) => { obj[h] = (cols[ci] ?? '').trim(); });
    return obj;
  });
  return { headers, rows };
}

/** Escape a single field for CSV output with formula-injection defense. */
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (FORMULA_LEAD.test(s)) s = `'${s}`; // neutralize spreadsheet formula execution
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize headers + array-of-objects to injection-safe RFC-4180 CSV. */
export function toSafeCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(','));
  return lines.join('\r\n');
}
