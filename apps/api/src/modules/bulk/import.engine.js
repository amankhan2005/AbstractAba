import { CLIENT_STATUS, STAFF_STATUS } from '../../models/enums.js';

/**
 * Pure per-row validation + normalization for bulk imports. No I/O. Each importer
 * declares its required/optional columns, normalizers, and validators. The result
 * separates valid normalized rows from row-level errors (with the source line
 * number) so the caller can preview (dry-run) or commit.
 *
 * Server-authoritative fields (tenantId, ownership, audit actor, status defaults,
 * permissions) are NEVER taken from the CSV — importers only surface the domain
 * fields below; everything else is applied by the service from the principal.
 */

const trimOrNull = (v) => { const s = (v ?? '').trim(); return s === '' ? null : s; };
const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

export const CLIENT_IMPORT = {
  entity: 'clients',
  required: ['firstName', 'lastName', 'clientNumber'],
  optional: ['status', 'email', 'phone', 'primaryLanguage'],
  dedupeKey: (r) => r.clientNumber.toLowerCase(),
  normalize(raw) {
    return {
      firstName: (raw.firstName ?? '').trim(),
      lastName: (raw.lastName ?? '').trim(),
      clientNumber: (raw.clientNumber ?? '').trim(),
      status: trimOrNull(raw.status)?.toUpperCase() ?? undefined,
      email: trimOrNull(raw.email),
      phone: trimOrNull(raw.phone),
      primaryLanguage: trimOrNull(raw.primaryLanguage),
    };
  },
  validate(n) {
    const errors = [];
    if (!n.firstName) errors.push('firstName is required');
    if (!n.lastName) errors.push('lastName is required');
    if (!n.clientNumber) errors.push('clientNumber is required');
    if (n.firstName && n.firstName.length > 100) errors.push('firstName too long');
    if (n.lastName && n.lastName.length > 100) errors.push('lastName too long');
    if (n.status && !CLIENT_STATUS.includes(n.status)) errors.push(`status must be one of ${CLIENT_STATUS.join('/')}`);
    if (n.email && !isEmail(n.email)) errors.push('email is invalid');
    return errors;
  },
};

export const STAFF_IMPORT = {
  entity: 'staff',
  // Staff profiles link to an already-invited user; userId is required by the
  // existing domain (one profile per user per tenant). We do not provision users.
  required: ['userId', 'firstName', 'lastName'],
  optional: ['title', 'discipline', 'employeeNumber', 'status'],
  dedupeKey: (r) => r.userId.toLowerCase(),
  normalize(raw) {
    return {
      userId: (raw.userId ?? '').trim(),
      firstName: (raw.firstName ?? '').trim(),
      lastName: (raw.lastName ?? '').trim(),
      title: trimOrNull(raw.title),
      discipline: trimOrNull(raw.discipline),
      employeeNumber: trimOrNull(raw.employeeNumber),
      status: trimOrNull(raw.status)?.toUpperCase() ?? undefined,
    };
  },
  validate(n) {
    const errors = [];
    if (!n.userId) errors.push('userId is required');
    if (!n.firstName) errors.push('firstName is required');
    if (!n.lastName) errors.push('lastName is required');
    if (n.status && !STAFF_STATUS.includes(n.status)) errors.push(`status must be one of ${STAFF_STATUS.join('/')}`);
    return errors;
  },
};

export const IMPORTERS = { clients: CLIENT_IMPORT, staff: STAFF_IMPORT };

/**
 * Validate a parsed CSV against an importer. Returns:
 *   { valid: [{ __row, ...normalized }], invalid: [{ __row, errors[] }],
 *     duplicatesInFile: [__row], summary: { total, valid, invalid, duplicates } }
 * In-file duplicates (same dedupe key twice) are flagged; DB duplicate detection
 * happens in the service (tenant-scoped).
 */
export function validateImport(importer, rows) {
  const valid = [];
  const invalid = [];
  const seen = new Map();
  const duplicatesInFile = [];

  for (const raw of rows) {
    const n = importer.normalize(raw);
    const errors = importer.validate(n);
    if (errors.length) { invalid.push({ __row: raw.__row, errors }); continue; }
    const key = importer.dedupeKey(n);
    if (seen.has(key)) { duplicatesInFile.push(raw.__row); invalid.push({ __row: raw.__row, errors: ['duplicate of row ' + seen.get(key) + ' in this file'] }); continue; }
    seen.set(key, raw.__row);
    valid.push({ __row: raw.__row, ...n });
  }

  return {
    valid,
    invalid,
    duplicatesInFile,
    summary: { total: rows.length, valid: valid.length, invalid: invalid.length, duplicates: duplicatesInFile.length },
  };
}
