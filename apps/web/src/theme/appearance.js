import { PREFERENCE_DEFAULTS } from '@aba1on1/schemas';

/**
 * Pure appearance logic — Blueprint §6.14b. Turns preferences into the data-*
 * attributes the stylesheet keys on. Touches no DOM and no storage, so the
 * resolution rules (auto scheme, high-contrast precedence) are unit-tested
 * directly. The ThemeProvider is the only place that writes the result.
 */
export const APPEARANCE_STORAGE_KEY = 'aba1on1.appearance';

/** Resolves `auto` against the device, or returns the explicit choice. */
export function resolveScheme(scheme, prefersDark) {
  if (scheme === 'auto') return prefersDark ? 'dark' : 'light';
  return scheme;
}

/** Merges stored overrides onto the platform defaults. */
export function resolvePreferences(overrides) {
  return { ...PREFERENCE_DEFAULTS, ...overrides };
}

/**
 * The data-* attributes (camel-cased for dataset) expressing a resolved
 * preference set. High contrast is its own attribute so the stylesheet can let
 * it win over accent and brand (BR-UI-7); the semantic palette is never
 * expressed here because no preference may touch it (BR-UI-2).
 */
export function toDataAttributes(overrides, prefersDark) {
  const prefs = resolvePreferences(overrides);
  return {
    scheme: resolveScheme(prefs.colorScheme, prefersDark),
    accent: prefs.accent,
    density: prefs.density,
    radius: prefs.radius,
    fontSize: prefs.fontSize,
    sidebar: prefs.sidebarStyle,
    nav: prefs.navStyle,
    contrast: prefs.highContrast ? 'high' : 'normal',
    motion: prefs.reducedMotion ? 'reduced' : 'full',
  };
}
