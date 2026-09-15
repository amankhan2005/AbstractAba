import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toSafeCsv, csvCell } from '../src/modules/bulk/csv.js';
import { CLIENT_IMPORT, STAFF_IMPORT, validateImport } from '../src/modules/bulk/import.engine.js';

// ---------------- CSV parser ----------------
test('parseCsv handles headers, quoted fields, embedded commas/quotes/newlines', () => {
  const csv = 'firstName,lastName,note\r\nAda,Lovelace,"Hello, ""world"""\r\nGrace,Hopper,"line1\nline2"';
  const { headers, rows } = parseCsv(csv);
  assert.deepEqual(headers, ['firstName', 'lastName', 'note']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].note, 'Hello, "world"');
  assert.equal(rows[1].note, 'line1\nline2');
  assert.equal(rows[0].__row, 2); // header is line 1
});

test('parseCsv strips BOM and tolerates a trailing newline', () => {
  const { rows } = parseCsv('\uFEFFa,b\r\n1,2\r\n');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].a, rows[0].b], ['1', '2']);
});

test('parseCsv rejects empty content, duplicate headers, and unterminated quotes', () => {
  assert.throws(() => parseCsv('   '), /empty/);
  assert.throws(() => parseCsv('a,a\n1,2'), /duplicate header/);
  assert.throws(() => parseCsv('a,b\n"unterminated,2'), /unterminated/);
});

test('parseCsv enforces the row cap', () => {
  const many = 'a\n' + Array.from({ length: 6000 }, (_, i) => i).join('\n');
  assert.throws(() => parseCsv(many, { maxRows: 5000 }), /maximum of 5000 rows/);
});

// ---------------- formula-injection-safe writer ----------------
test('csvCell neutralizes spreadsheet formula leads', () => {
  assert.equal(csvCell('=SUM(A1:A9)'), "'=SUM(A1:A9)");
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-1+2'), "'-1+2");
  assert.equal(csvCell('@cmd'), "'@cmd");
  // A normal value is untouched.
  assert.equal(csvCell('Ada'), 'Ada');
});

test('toSafeCsv quotes special chars and escapes embedded quotes', () => {
  const out = toSafeCsv(['name', 'note'], [{ name: 'A,B', note: 'say "hi"' }]);
  assert.ok(out.includes('"A,B"'));
  assert.ok(out.includes('"say ""hi"""'));
});

test('toSafeCsv formula-guards a dangerous field even when quoted', () => {
  const out = toSafeCsv(['x'], [{ x: '=1+1,evil' }]);
  // leading quote inserted, then whole field quoted for the comma
  assert.ok(out.includes(`"'=1+1,evil"`));
});

// ---------------- import validation ----------------
test('validateImport: client rows split into valid / invalid with row numbers', () => {
  const rows = [
    { __row: 2, firstName: 'Ada', lastName: 'Lovelace', clientNumber: 'C-1', status: 'active' },
    { __row: 3, firstName: '', lastName: 'NoFirst', clientNumber: 'C-2' },
    { __row: 4, firstName: 'Bad', lastName: 'Status', clientNumber: 'C-3', status: 'WAT' },
    { __row: 5, firstName: 'Bad', lastName: 'Email', clientNumber: 'C-4', email: 'nope' },
  ];
  const res = validateImport(CLIENT_IMPORT, rows);
  assert.equal(res.summary.valid, 1);
  assert.equal(res.summary.invalid, 3);
  assert.equal(res.valid[0].status, 'ACTIVE'); // normalized upper-case
  assert.ok(res.invalid.find((r) => r.__row === 3).errors.some((e) => /firstName/.test(e)));
  assert.ok(res.invalid.find((r) => r.__row === 4).errors.some((e) => /status/.test(e)));
  assert.ok(res.invalid.find((r) => r.__row === 5).errors.some((e) => /email/.test(e)));
});

test('validateImport flags in-file duplicates by dedupe key', () => {
  const rows = [
    { __row: 2, firstName: 'A', lastName: 'B', clientNumber: 'DUP' },
    { __row: 3, firstName: 'C', lastName: 'D', clientNumber: 'dup' }, // case-insensitive dup
  ];
  const res = validateImport(CLIENT_IMPORT, rows);
  assert.equal(res.summary.valid, 1);
  assert.equal(res.summary.duplicates, 1);
  assert.ok(res.invalid.find((r) => r.__row === 3).errors[0].includes('duplicate'));
});

test('validateImport: staff requires userId (existing domain rule)', () => {
  const rows = [
    { __row: 2, firstName: 'S', lastName: 'T' }, // no userId
    { __row: 3, userId: 'u-1', firstName: 'S', lastName: 'T' },
  ];
  const res = validateImport(STAFF_IMPORT, rows);
  assert.equal(res.summary.valid, 1);
  assert.ok(res.invalid.find((r) => r.__row === 2).errors.some((e) => /userId/.test(e)));
});

test('import engine never surfaces tenant/owner/audit fields from CSV', () => {
  const n = CLIENT_IMPORT.normalize({ firstName: 'A', lastName: 'B', clientNumber: 'C', tenantId: 'evil', createdBy: 'evil', status: 'ACTIVE' });
  assert.equal(n.tenantId, undefined);
  assert.equal(n.createdBy, undefined);
});
