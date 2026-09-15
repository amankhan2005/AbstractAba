import crypto from 'node:crypto';
import { AppError } from '../../../common/errors/AppError.js';

/**
 * Server-generated storage keys. The key embeds the tenant id so an adapter can
 * partition by tenant and so a stored ref can be re-validated against the
 * caller's tenant on download (defense-in-depth against IDOR). Clients never
 * supply or influence this value.
 *
 * Format: docs/<tenantId>/<documentId>/<random>
 */
export function buildStorageKey({ tenantId, documentId }) {
  if (!tenantId || !documentId) throw AppError.validation('tenantId and documentId are required for a storage key.');
  const random = crypto.randomBytes(16).toString('hex');
  return `docs/${tenantId}/${documentId}/${random}`;
}

/** Parse a storage key back to its parts; used to re-assert tenant ownership. */
export function parseStorageKey(key) {
  const m = /^docs\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(key ?? '');
  if (!m) return null;
  return { tenantId: m[1], documentId: m[2], random: m[3] };
}

/** True when a storage key belongs to the given tenant. */
export function keyBelongsToTenant(key, tenantId) {
  const parsed = parseStorageKey(key);
  return !!parsed && parsed.tenantId === tenantId;
}
