/**
 * STATEMENT PDF WRITER — a small, dependency-free PDF engine for the business
 * documents the product downloads (Insurance Bill, Payroll Summary). Numbered
 * objects with an xref table, the two standard Helvetica faces with WinAnsi
 * encoding (no embedded font files), and a page canvas that draws text, filled
 * rectangles and rules and paginates on demand. Shared so every document has the
 * same typography, palette, header and footer.
 */

export const PAGE_W = 612; export const PAGE_H = 792; // US Letter, portrait
export const M_X = 48; export const TOP = PAGE_H - 48; export const BOTTOM = 60;
export const CONTENT_W = PAGE_W - M_X * 2;

// Palette (RGB 0..1): deep navy ink, muted grey, soft panel, accent violet.
export const INK = [0.122, 0.165, 0.267];
export const MUTED = [0.4, 0.44, 0.52];
export const LINE = [0.84, 0.86, 0.9];
export const PANEL = [0.957, 0.961, 0.976];
export const ACCENT = [0.357, 0.247, 0.659];
export const WHITE = [1, 1, 1];

/**
 * WinAnsi byte for a typographic character with no Latin-1 code point. The
 * fonts declare /WinAnsiEncoding, so an en dash (U+2013) must be written as
 * 0x96, never truncated to a control byte.
 */
const WIN_ANSI = new Map(Object.entries({
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85,
  '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8A,
  '‹': 0x8B, 'Œ': 0x8C, 'Ž': 0x8E, '‘': 0x91, '’': 0x92,
  '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9A, '›': 0x9B, 'œ': 0x9C,
  'ž': 0x9E, 'Ÿ': 0x9F,
}));

/** A PDF literal string in WinAnsi: structural characters escaped, never a control byte. */
export const esc = (s) => {
  let out = '';
  for (const ch of String(s == null ? '' : s)) {
    if (ch === '\\') { out += '\\\\'; continue; }
    if (ch === '(') { out += '\\('; continue; }
    if (ch === ')') { out += '\\)'; continue; }
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code <= 0x7E) { out += ch; continue; }
    const win = WIN_ANSI.get(ch);
    if (win !== undefined) { out += String.fromCharCode(win); continue; }
    if (code >= 0xA0 && code <= 0xFF) { out += ch; continue; }
    if (code === 0x09) { out += ' '; continue; }
    if (code < 0x20) continue;
    out += '?';
  }
  return out;
};

// Helvetica / Helvetica-Bold advance widths (1/1000 em) for ASCII 32..126, from
// the standard font metrics — used to right-align amounts precisely.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELV_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
export function textWidth(text, size, bold = false) {
  const table = bold ? HELV_BOLD : HELV;
  let units = 0;
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code <= 126) units += table[code - 32];
    else if (ch === '—') units += 1000;
    else units += 556;
  }
  return (units * size) / 1000;
}

/** Truncate text with an ellipsis so it fits a column. */
export function fit(text, size, bold, maxWidth) {
  let t = String(text ?? '');
  if (textWidth(t, size, bold) <= maxWidth) return t;
  while (t.length > 1 && textWidth(`${t}…`, size, bold) > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

export const rgb = ([r, g, b]) => `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`;

/** Page-based drawing surface: text, filled rectangles and rules; paginates on demand. */
export class Canvas {
  constructor() { this.pages = [[]]; this.y = TOP; }
  get ops() { return this.pages[this.pages.length - 1]; }
  newPage() { this.pages.push([]); this.y = TOP; }
  /** Ensure `h` points remain above the footer; start a new page otherwise. */
  ensure(h) { if (this.y - h < BOTTOM) this.newPage(); }
  text(x, y, str, { size = 10, bold = false, color = INK, align = 'left' } = {}) {
    const w = textWidth(str, size, bold);
    const tx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(color)} rg 1 0 0 1 ${tx.toFixed(2)} ${y.toFixed(2)} Tm (${esc(str)}) Tj ET`);
  }
  rect(x, y, w, h, color) { this.ops.push(`${rgb(color)} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); }
  rule(x1, y1, x2, y2, color = LINE, width = 0.75) { this.ops.push(`${rgb(color)} RG ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`); }
}

export function assemble(pages) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalogNo = add('<< /Type /Catalog /Pages 2 0 R >>');
  const pagesNo = add('');
  const f1No = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2No = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const ops of pages) {
    const stream = ops.join('\n');
    const contentNo = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    const pageNo = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1No} 0 R /F2 ${f2No} 0 R >> >> /Contents ${contentNo} 0 R >>`);
    kids.push(`${pageNo} 0 R`);
  }
  objects[pagesNo - 1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}] >>`;
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  for (let i = 0; i < objects.length; i += 1) {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 0; i < objects.length; i += 1) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNo} 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

/**
 * The document header every statement shares: an accent bar, the company name,
 * the document title on the right, then a label/value pair on each side
 * (e.g. BILLING PERIOD … CLIENTS). Leaves the canvas cursor below it.
 */
export function drawDocumentHeader(cv, { companyName, title, leftLabel, leftValue, rightLabel, rightValue }) {
  cv.rect(0, PAGE_H - 8, PAGE_W, 8, ACCENT);
  cv.text(M_X, TOP - 14, fit(companyName, 22, true, CONTENT_W - 190), { size: 22, bold: true });
  cv.text(M_X + CONTENT_W, TOP - 12, title, { size: 16, bold: true, color: ACCENT, align: 'right' });
  cv.rule(M_X, TOP - 30, M_X + CONTENT_W, TOP - 30, LINE, 1);
  cv.text(M_X, TOP - 50, leftLabel, { size: 8, bold: true, color: MUTED });
  cv.text(M_X, TOP - 66, leftValue, { size: 12, bold: true });
  if (rightLabel) {
    cv.text(M_X + CONTENT_W, TOP - 50, rightLabel, { size: 8, bold: true, color: MUTED, align: 'right' });
    cv.text(M_X + CONTENT_W, TOP - 66, rightValue, { size: 12, bold: true, align: 'right' });
  }
  cv.y = TOP - 92;
}

/** A dark total band: label, a secondary line, and the amount on the right. */
export function drawTotalBand(cv, { label, detail, amount }) {
  cv.ensure(64);
  const y = cv.y - 6;
  cv.rect(M_X, y - 46, CONTENT_W, 46, INK);
  cv.text(M_X + 16, y - 20, label, { size: 10, bold: true, color: WHITE });
  if (detail) cv.text(M_X + 16, y - 35, detail, { size: 8.5, color: [0.8, 0.83, 0.9] });
  cv.text(M_X + CONTENT_W - 16, y - 30, amount, { size: 18, bold: true, color: WHITE, align: 'right' });
  cv.y = y - 46 - 10;
}

/** Footer on every page: the company name and "Page X of Y". */
export function drawFooters(cv, companyName) {
  const count = cv.pages.length;
  cv.pages.forEach((ops, i) => {
    ops.push(`${rgb(LINE)} RG 0.75 w ${M_X} 42 m ${M_X + CONTENT_W} 42 l S`);
    ops.push(`BT /F1 8 Tf ${rgb(MUTED)} rg 1 0 0 1 ${M_X} 30 Tm (${esc(fit(companyName, 8, false, 300))}) Tj ET`);
    const label = `Page ${i + 1} of ${count}`;
    ops.push(`BT /F1 8 Tf ${rgb(MUTED)} rg 1 0 0 1 ${(M_X + CONTENT_W - textWidth(label, 8)).toFixed(2)} 30 Tm (${esc(label)}) Tj ET`);
  });
}
