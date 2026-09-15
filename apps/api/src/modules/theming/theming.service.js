import { BRAND_DEFAULTS, PREFERENCE_DEFAULTS, SAFE_ACCENTS, SEMANTIC_PALETTE } from './design-tokens.js';
import { accessibleForeground, deriveDarkVariant } from './color.js';

/**
 * The theming engine (Module 6), ported from the original. Resolves the three
 * token layers into one theme and mediates the only two writable layers: a
 * user's own preferences and a tenant's brand. The locked state.* palette has no
 * write method — it is echoed on resolution (the structural form of BR-UI-2).
 */
export class ThemingService {
  constructor(deps) {
    this.deps = deps;
  }

  getPreferences(userId) {
    return this.deps.preferences.getPreferences(userId);
  }

  async updatePreferences(userId, patch) {
    const current = await this.deps.preferences.getPreferences(userId);
    const merged = { ...current, ...patch };
    await this.deps.preferences.savePreferences(userId, merged);
    return merged;
  }

  async resetPreferences(userId) {
    await this.deps.preferences.savePreferences(userId, {});
  }

  async getBranding(tenantId) {
    // Backend-derived company identity for the caller's OWN tenant: brand tokens
    // (logo, colours) merged with the organization's name (tradingName). tenantId
    // comes from the authenticated tenant context, never the frontend. Name
    // resolution is best-effort — a lookup failure still returns a usable object
    // so the shell falls back to the Abstract ABA product mark rather than crashing.
    const tokens = await this.deps.branding.getBrandTokens(tenantId);
    let name = null;
    if (this.deps.organizations && typeof this.deps.organizations.getName === 'function') {
      try { name = await this.deps.organizations.getName(tenantId); } catch { name = null; }
    }
    return { ...tokens, name: name ?? null };
  }

  async updateBranding(tenantId, patch, actorId) {
    const current = await this.deps.branding.getBrandTokens(tenantId);
    const merged = { ...current, ...patch };
    await this.deps.branding.saveBrandTokens(tenantId, merged, actorId);
    return merged;
  }

  /** Resolves the full theme: preferences platform←user, brand platform←tenant,
   *  semantic palette immutable. An operator has no tenant → brand falls through. */
  async resolveTheme(principal) {
    const overrides = await this.deps.preferences.getPreferences(principal.userId);
    const brandTokens = principal.activeTenantId
      ? await this.deps.branding.getBrandTokens(principal.activeTenantId)
      : {};
    return {
      preferences: { ...PREFERENCE_DEFAULTS, ...overrides },
      brand: this.resolveBrand(brandTokens),
      semantic: SEMANTIC_PALETTE,
      accents: SAFE_ACCENTS,
    };
  }

  resolveBrand(tokens) {
    return {
      primary: this.resolveColor(tokens.primary, BRAND_DEFAULTS.primary.light, BRAND_DEFAULTS.primary.dark),
      secondary: this.resolveColor(tokens.secondary, BRAND_DEFAULTS.secondary.light, BRAND_DEFAULTS.secondary.dark),
      logoUrl: tokens.logoUrl ?? null,
    };
  }

  /** Resolves one brand colour across both schemes; foreground derived, never chosen (BR-UI-4). */
  resolveColor(chosen, defaultLight, defaultDark) {
    const color = chosen ? { light: chosen, dark: deriveDarkVariant(chosen) } : { light: defaultLight, dark: defaultDark };
    return { color, foreground: { light: accessibleForeground(color.light), dark: accessibleForeground(color.dark) } };
  }
}
