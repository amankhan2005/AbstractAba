import crypto from 'node:crypto';
import { AppError } from '../../common/errors/AppError.js';

/**
 * Pure, server-authoritative validation for document uploads. The client never
 * supplies storageRef, checksum, or sizeBytes — the server derives them from the
 * actual bytes here. This closes the IDOR/forgery gap where a client could point
 * a document at an arbitrary artifact or lie about its size/type.
 */

/** Decode a base64 payload to a Buffer, rejecting malformed input. */
export function decodeBase64Payload(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) {
    throw AppError.validation('File content is required.');
  }
  // Strip an optional data-URL prefix (data:<mime>;base64,)
  const comma = base64.indexOf(',');
  const raw = base64.startsWith('data:') && comma !== -1 ? base64.slice(comma + 1) : base64;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw.replace(/\s/g, ''))) {
    throw AppError.validation('File content is not valid base64.');
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length === 0) throw AppError.validation('Decoded file is empty.');
  return buf;
}

/** Enforce the server-side size cap. */
export function assertWithinSizeLimit(sizeBytes, maxBytes) {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw AppError.validation('Invalid file size.');
  if (sizeBytes > maxBytes) {
    throw AppError.validation(`File exceeds the maximum allowed size of ${maxBytes} bytes.`);
  }
}

/** Enforce the server-side MIME allowlist (exact match, case-insensitive). */
export function assertAllowedMimeType(contentType, allowedMimeTypes) {
  const ct = (contentType ?? '').toLowerCase().split(';')[0].trim();
  if (!ct) throw AppError.validation('A content type is required.');
  const ok = allowedMimeTypes.some((a) => a.toLowerCase() === ct);
  if (!ok) throw AppError.validation(`Content type ${ct} is not allowed.`);
  return ct;
}

/** SHA-256 of the bytes, hex — the integrity checksum stored on the document. */
export function computeChecksum(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Full server-side validation of an upload. Returns the derived, trusted
 * artifact descriptor (never the client's claimed values).
 */
export function validateUpload({ base64, contentType }, { maxBytes, allowedMimeTypes }) {
  const mime = assertAllowedMimeType(contentType, allowedMimeTypes);
  const buffer = decodeBase64Payload(base64);
  assertWithinSizeLimit(buffer.length, maxBytes);
  return {
    buffer,
    descriptor: {
      contentType: mime,
      sizeBytes: buffer.length,
      checksum: computeChecksum(buffer),
    },
  };
}
