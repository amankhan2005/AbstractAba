import { encryptField, decryptField } from './crypto.js';

/**
 * PHI-at-rest seam (Phase 2 · Step 1).
 *
 * The clinical modules that begin with Clients must encrypt their most sensitive
 * identifiers at rest. Rather than call the low-level field cipher directly,
 * every clinical module seals and opens PHI through this one seam, so the key
 * strategy is decided in exactly one place.
 *
 * Today this delegates to the AES-256-GCM field cipher keyed by the single
 * global FIELD_ENCRYPTION_KEY (crypto.js). A later phase can derive a per-tenant
 * key here — the ambient tenant context (AsyncLocalStorage) is already available
 * to this layer — WITHOUT changing this signature or any caller, which is why
 * callers must never reach past it to crypto.js. See the Phase 2 plan,
 * decision "PHI encryption behind a clean seam".
 *
 * The sealed form is an opaque string; callers store it verbatim and never index
 * or search it. `null`/`undefined` pass through unchanged so an absent optional
 * PHI field stays absent rather than becoming ciphertext over an empty string.
 */

/** Seal a PHI value for storage. Returns the opaque sealed string, or the input unchanged when it is null/undefined. */
export function sealPhi(plaintext) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  return encryptField(String(plaintext));
}

/** Open a sealed PHI value for authorised use. Returns the plaintext, or the input unchanged when it is null/undefined. */
export function openPhi(sealed) {
  if (sealed === null || sealed === undefined) return sealed;
  return decryptField(sealed);
}
