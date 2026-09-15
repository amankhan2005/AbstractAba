import { createHash, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/** SHA-256 hex digest. Used for token hashes and the audit chain. */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Deterministic canonical JSON: keys sorted recursively, no incidental
 * whitespace. The audit hash is computed over this so the digest is stable
 * regardless of property insertion order — ported verbatim in intent from the
 * PostgreSQL implementation.
 */
export function canonicalJson(value) {
  return JSON.stringify(sortDeep(value));
}
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortDeep(value[k]);
        return acc;
      }, {});
  }
  return value;
}

/** A cryptographically random opaque token (for refresh/reset/invite tokens). */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time compare of two hex/utf8 strings of equal length. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Application-layer field encryption (AES-256-GCM) for secrets like TOTP seeds.
 * A leaked database must not yield usable MFA secrets — mirrors the original
 * `secretCiphertext` treatment.
 */
function key() {
  const k = Buffer.from(env.fieldEncryptionKey, 'base64');
  if (k.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must decode to 32 bytes');
  return k;
}
export function encryptField(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${ct.toString('base64')}.${tag.toString('base64')}`;
}
export function decryptField(ciphertext) {
  const [ivB64, ctB64, tagB64] = String(ciphertext).split('.');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
