import { randomUUID } from 'node:crypto';

/**
 * Application-generated identifier. The original platform used UUID v7 so ids
 * are time-ordered yet non-enumerable. We keep string UUIDs as the document
 * `_id` (rather than switching to ObjectId) so tokens, references, and API
 * responses stay byte-for-byte compatible with the existing contract.
 *
 * Node's randomUUID is v4. A small v7 generator is provided for the time-order
 * property where it matters (audit, jobs); both are valid UUIDs the tenant
 * plugin and validators accept.
 */
export function newId() {
  return uuidV7();
}

export { randomUUID };

/** Minimal UUID v7 (unix-ms timestamp prefix + random). */
export function uuidV7() {
  const now = Date.now();
  const timeHex = now.toString(16).padStart(12, '0'); // 48 bits
  const rand = randomUUID().replace(/-/g, ''); // 32 hex chars of randomness
  // time_low/time_mid (48 bits) | version 7 | rand ...
  const hex =
    timeHex.slice(0, 8) +
    timeHex.slice(8, 12) +
    '7' + rand.slice(1, 4) +          // version nibble = 7
    ((parseInt(rand[4], 16) & 0x3 | 0x8).toString(16)) + rand.slice(5, 8) + // variant
    rand.slice(8, 20);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
