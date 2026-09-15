import { payrollStatement, workedTime } from './payroll.statement.js';

/**
 * MINIMAL, DEPENDENCY-FREE .xlsx WRITER (spec §14 — a real XLSX, never a CSV
 * renamed .xlsx). An .xlsx file is an OPC ZIP of OOXML parts; this module builds
 * exactly the parts Excel needs for a single worksheet and packages them with a
 * tiny store-mode (no-compression) ZIP writer. Values are written inline
 * (t="inlineStr" for text, <v> for numbers) so no shared-strings table is
 * required. The output opens in Excel, Numbers and LibreOffice.
 *
 * It is intentionally small and pure so it is unit-testable and adds no runtime
 * dependency to the API. Only payroll/administrative values are ever written by
 * the caller — this module has no knowledge of PHI.
 */

// ---- CRC32 (for ZIP entries) ---------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---- store-mode ZIP -------------------------------------------------------
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

/** Package [{name, data:Buffer}] into a ZIP Buffer using store (method 0). */
export function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0; const DOS_DATE = 0x21; // 1980-01-01, fixed for determinism

  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0),
      name, data,
    ]);
    chunks.push(local);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(data.length), u32(data.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      name,
    ]));
    offset += local.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralBuf.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ---- OOXML ----------------------------------------------------------------
const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const colName = (i) => { // 0 -> A, 26 -> AA
  let n = i; let s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
};

/**
 * One cell. A value may be a primitive (number → numeric, string → inline text)
 * or `{ v, s }` where `s` is a style index (see STYLE_* below). `null`/`''` →
 * an empty (optionally styled) cell.
 */
function cellXml(ref, value) {
  const v = (value && typeof value === 'object' && 'v' in value) ? value.v : value;
  const s = (value && typeof value === 'object' && 's' in value) ? value.s : 0;
  const sa = s ? ` s="${s}"` : '';
  if (v == null || v === '') return `<c r="${ref}"${sa}/>`;
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${sa}><v>${v}</v></c>`;
  return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
}

/** Build a worksheet part from an array of rows (each an array of cell values). */
function sheetXml(rows) {
  const body = rows.map((row, r) => {
    const cells = row.map((v, c) => cellXml(`${colName(c)}${r + 1}`, v)).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<sheetData>${body}</sheetData></worksheet>`;
}

// Style indexes written into xl/styles.xml by buildWorkbook.
export const STYLE_DEFAULT = 0;
export const STYLE_TITLE = 1;   // bold, larger — report title
export const STYLE_HEADER = 2;  // bold — table header / KPI label
export const STYLE_LABEL = 3;   // bold — summary key
export const STYLE_MONEY = 4;   // numeric dollars shown as $#,##0.00 (still a real number cell)
export const STYLE_MONEY_BOLD = 5; // bold $#,##0.00 — totals
// Statement styles (bill-summary workbooks): bordered table cells, a filled
// header, currency / per-hour formats and a highlighted total row.
export const STYLE_DOC_TITLE = 6;      // company name — bold 18
export const STYLE_DOC_SUBTITLE = 7;   // document name — bold 14, accent colour
export const STYLE_DOC_LABEL = 8;      // small grey label ("Billing Period")
export const STYLE_DOC_VALUE = 9;      // bold value next to a label
export const STYLE_TABLE_HEADER = 10;  // white bold on dark fill, bordered, wrapped
export const STYLE_TABLE_TEXT = 11;    // bordered text, wrapped, top-aligned
export const STYLE_TABLE_RIGHT = 12;   // bordered text, right-aligned, wrapped
export const STYLE_TABLE_RATE = 13;    // bordered number shown as $#,##0.00/hr
export const STYLE_TABLE_MONEY = 14;   // bordered number shown as $#,##0.00
export const STYLE_TABLE_MONEY_BOLD = 15; // bordered bold $ — a client total
export const STYLE_TOTAL_TEXT = 16;    // total row: bold on light fill, bordered
export const STYLE_TOTAL_RIGHT = 17;   // total row: right-aligned text
export const STYLE_TOTAL_MONEY = 18;   // total row: bold $ on light fill

/** The shared styles part: fonts, fills, borders and the cell formats indexed by STYLE_*. */
function stylesXml() {
  const border = '<border><left style="thin"><color rgb="FFD0D5DD"/></left><right style="thin"><color rgb="FFD0D5DD"/></right><top style="thin"><color rgb="FFD0D5DD"/></top><bottom style="thin"><color rgb="FFD0D5DD"/></bottom><diagonal/></border>';
  const totalBorder = '<border><left style="thin"><color rgb="FFD0D5DD"/></left><right style="thin"><color rgb="FFD0D5DD"/></right><top style="medium"><color rgb="FF1F2A44"/></top><bottom style="medium"><color rgb="FF1F2A44"/></bottom><diagonal/></border>';
  const wrapTop = '<alignment vertical="top" wrapText="1"/>';
  const wrapTopRight = '<alignment horizontal="right" vertical="top" wrapText="1"/>';
  const center = '<alignment vertical="center" wrapText="1"/>';
  const centerRight = '<alignment horizontal="right" vertical="center"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0.00&quot;/hr&quot;"/></numFmts>`
    + `<fonts count="8">`
    + `<font><sz val="11"/><name val="Calibri"/></font>`
    + `<font><b/><sz val="11"/><name val="Calibri"/></font>`
    + `<font><b/><sz val="14"/><name val="Calibri"/></font>`
    + `<font><b/><sz val="18"/><color rgb="FF1F2A44"/><name val="Calibri"/></font>`
    + `<font><b/><sz val="14"/><color rgb="FF5B3FA8"/><name val="Calibri"/></font>`
    + `<font><sz val="10"/><color rgb="FF667085"/><name val="Calibri"/></font>`
    + `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>`
    + `<font><b/><sz val="12"/><color rgb="FF1F2A44"/><name val="Calibri"/></font>`
    + `</fonts>`
    + `<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`
    + `<fill><patternFill patternType="solid"><fgColor rgb="FF1F2A44"/><bgColor indexed="64"/></patternFill></fill>`
    + `<fill><patternFill patternType="solid"><fgColor rgb="FFEEF0F6"/><bgColor indexed="64"/></patternFill></fill></fills>`
    + `<borders count="3"><border/>${border}${totalBorder}</borders>`
    + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
    + `<cellXfs count="19">`
    + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
    + `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>`
    + `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>`
    + `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>`
    + `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`
    + `<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>`
    // 6..9 document header
    + `<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>`
    + `<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>`
    + `<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1"/>`
    + `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>`
    // 10..15 table
    + `<xf numFmtId="0" fontId="6" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${center}</xf>`
    + `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">${wrapTop}</xf>`
    + `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">${wrapTopRight}</xf>`
    + `<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">${wrapTopRight}</xf>`
    + `<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1">${wrapTopRight}</xf>`
    + `<xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1">${wrapTopRight}</xf>`
    // 16..18 total row
    + `<xf numFmtId="0" fontId="7" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${center}</xf>`
    + `<xf numFmtId="0" fontId="7" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${centerRight}</xf>`
    + `<xf numFmtId="164" fontId="7" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${centerRight}</xf>`
    + `</cellXfs>`
    + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>`
    + `</styleSheet>`;
}

/**
 * A worksheet part with optional column widths, a frozen header, row heights,
 * merged ranges and landscape fit-to-width printing. A <dimension> is always
 * written so every spreadsheet app knows the full used range up front.
 */
function sheetXmlStyled({ rows, cols = [], freezeHeaderRows = 0, rowHeights = {}, merges = [], landscape = false }) {
  const colsXml = cols.length
    ? `<cols>${cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const view = freezeHeaderRows > 0
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${freezeHeaderRows}" topLeftCell="A${freezeHeaderRows + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : '';
  const width = Math.max(1, cols.length, ...rows.map((r) => r.length));
  const dimension = `<dimension ref="A1:${colName(width - 1)}${Math.max(1, rows.length)}"/>`;
  const body = rows.map((row, r) => {
    const cells = row.map((v, c) => cellXml(`${colName(c)}${r + 1}`, v)).join('');
    const ht = rowHeights[r + 1] ? ` ht="${rowHeights[r + 1]}" customHeight="1"` : '';
    return `<row r="${r + 1}"${ht}>${cells}</row>`;
  }).join('');
  const mergeXml = merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  const sheetPr = landscape ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : '';
  const print = landscape
    ? '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>'
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `${sheetPr}${dimension}${view}${colsXml}<sheetData>${body}</sheetData>${mergeXml}${print}</worksheet>`;
}

/**
 * Build a professional, MULTI-SHEET .xlsx (spec §11–§13). Each sheet is
 * { name, rows, cols?, freezeHeaderRows? }; rows carry plain values or styled
 * `{ v, s }` cells. Adds a shared styles part (bold headers/titles), per-column
 * widths and a frozen header row. Still dependency-free and store-mode zipped.
 */
export function buildWorkbook({ sheets = [] }) {
  const list = sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }];
  const seen = new Set();
  const safe = (name, i) => {
    let n = String(name || `Sheet${i + 1}`).slice(0, 31).replace(/[\\/*?:[\]]/g, ' ').trim() || `Sheet${i + 1}`;
    let k = n; let d = 2;
    while (seen.has(k.toLowerCase())) { k = `${n.slice(0, 28)} ${d}`; d += 1; }
    seen.add(k.toLowerCase());
    return k;
  };
  const names = list.map((s, i) => safe(s.name, i));

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
    + list.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + `</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
    + `</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>${names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + list.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + `</Relationships>`;

  const files = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: stylesXml() },
    ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXmlStyled({ rows: s.rows ?? [], cols: s.cols ?? [], freezeHeaderRows: s.freezeHeaderRows ?? 0, rowHeights: s.rowHeights ?? {}, merges: s.merges ?? [], landscape: Boolean(s.landscape) }) })),
  ];
  return zipStore(files);
}

/**
 * Build a single-sheet .xlsx from a title and rows. Returns a Buffer.
 * @param {{ sheetName?:string, rows: Array<Array<string|number|null>> }} p
 */
export function buildXlsx({ sheetName = 'Payroll', rows = [] }) {
  const safeName = String(sheetName).slice(0, 31).replace(/[\\/*?:[\]]/g, ' ');
  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
        + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
        + `<Default Extension="xml" ContentType="application/xml"/>`
        + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
        + `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        + `</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
        + `</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
        + `<sheets><sheet name="${xmlEscape(safeName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
        + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>`
        + `</Relationships>`,
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(rows) },
  ];
  return zipStore(files);
}

// ---- payroll summary workbook ------------------------------------------------
/**
 * THE PAYROLL SUMMARY workbook — ONE professional sheet built from the generated
 * payroll via payrollStatement (the same statement the PDF renders):
 *
 *   Company name · Payroll Summary · Payroll Period
 *   Staff Name | Role | Hourly Rate | Hours Worked | Payout
 *   …one row per staff member…
 *   TOTAL COMPANY PAYROLL
 *
 * Hours worked read "36h 30m"; rates and payouts are real numbers formatted as
 * currency ("$50.00/hr", "$1,825.00") so the sheet can still be summed. No
 * session rows, minutes, dates, clients, identifiers, timezone or timestamp.
 */
export function buildPayrollWorkbook(data) {
  const st = payrollStatement(data);
  const cell = (v, s) => ({ v, s });
  const rows = [
    [cell(st.companyName, STYLE_DOC_TITLE)],
    [cell('Payroll Summary', STYLE_DOC_SUBTITLE)],
    [cell('Payroll Period', STYLE_DOC_LABEL), cell(st.periodLabel, STYLE_DOC_VALUE)],
    [],
    ['Staff Name', 'Role', 'Hourly Rate', 'Hours Worked', 'Payout'].map((h) => cell(h, STYLE_TABLE_HEADER)),
  ];
  for (const s of st.staff) {
    rows.push([
      cell(s.name, STYLE_TABLE_TEXT),
      cell(s.role, STYLE_TABLE_TEXT),
      s.hourlyRates.length === 1 ? cell(s.hourlyRates[0] / 100, STYLE_TABLE_RATE) : cell(s.hourlyRateText, STYLE_TABLE_RIGHT),
      cell(s.workedTime, STYLE_TABLE_RIGHT),
      cell(s.payout / 100, STYLE_TABLE_MONEY_BOLD),
    ]);
  }
  if (st.staff.length === 0) rows.push([cell('No staff were paid for this period.', STYLE_TABLE_TEXT)]);
  rows.push([
    cell('TOTAL COMPANY PAYROLL', STYLE_TOTAL_TEXT), cell('', STYLE_TOTAL_TEXT), cell('', STYLE_TOTAL_RIGHT),
    cell(workedTime(st.totals.totalMinutes), STYLE_TOTAL_RIGHT), cell(st.totals.totalAmount / 100, STYLE_TOTAL_MONEY),
  ]);
  return buildWorkbook({
    sheets: [{
      name: 'Payroll Summary',
      rows,
      cols: [32, 14, 20, 16, 18],
      freezeHeaderRows: 5,
      rowHeights: { 1: 28, 2: 22, 5: 26, [rows.length]: 24 },
      merges: ['A1:E1', 'A2:E2', 'B3:E3'],
    }],
  });
}
