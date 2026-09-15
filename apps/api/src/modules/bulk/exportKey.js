import crypto from 'node:crypto';
import { AppError } from '../../common/errors/AppError.js';

/**
 * Server-generated storage keys for organization exports. Tenant-partitioned so
 * a stored ref can be re-validated against the caller's tenant on download
 * (defense-in-depth against IDOR). Format: exports/<tenantId>/<exportId>/<rand>
 */
export function buildExportKey({ tenantId, exportId }) {
  if (!tenantId || !exportId) throw AppError.validation('tenantId and exportId are required for an export key.');
  return `exports/${tenantId}/${exportId}/${crypto.randomBytes(12).toString('hex')}`;
}

export function parseExportKey(key) {
  const m = /^exports\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(key ?? '');
  return m ? { tenantId: m[1], exportId: m[2], random: m[3] } : null;
}

export function exportKeyBelongsToTenant(key, tenantId) {
  const parsed = parseExportKey(key);
  return !!parsed && parsed.tenantId === tenantId;
}
