import { userPreferencesPatchSchema } from '@aba1on1/schemas';
import { APPEARANCE_STORAGE_KEY } from './appearance';

/**
 * The appearance cache in localStorage — a cache for first paint, never a source
 * of truth: the authoritative preferences live on the user record and reconcile
 * after sign-in. The stored shape is exactly the override patch the API accepts,
 * so the pre-paint bootstrap and the running app agree without translation.
 * Reads are validated, so a tampered or stale entry degrades to defaults.
 */
export function readStoredOverrides() {
  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = userPreferencesPatchSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writeStoredOverrides(overrides) {
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // A private-mode or quota failure must never break the app; preferences
    // still live on the server and apply on the next load.
  }
}
