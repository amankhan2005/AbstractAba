import { createHmac } from 'node:crypto';

/**
 * RFC 6238 TOTP verification (SHA-1, 6 digits, 30s step) with a ±1 window.
 * Dependency-free so the foundation stays lean. Secret is base32.
 */
function base32Decode(b32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of b32.replace(/=+$/, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 1_000_000).toString().padStart(6, '0');
}

/** Verify a TOTP code; returns the matched counter (to prevent replay) or null. */
export function verifyTotp(base32Secret, code, { window = 1, step = 30 } = {}) {
  const secretBuf = base32Decode(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / step);
  for (let w = -window; w <= window; w += 1) {
    if (hotp(secretBuf, counter + w) === String(code)) return counter + w;
  }
  return null;
}
