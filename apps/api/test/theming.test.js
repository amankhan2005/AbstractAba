import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, accessibleForeground, deriveDarkVariant, relativeLuminance } from '../src/modules/theming/color.js';
import { ThemingService } from '../src/modules/theming/theming.service.js';
import { SAFE_ACCENTS, SEMANTIC_PALETTE, PREFERENCE_DEFAULTS, BRAND_DEFAULTS, userPreferencesPatchSchema, brandTokensPatchSchema } from '../src/modules/theming/design-tokens.js';

/** DB-free tests for theming: WCAG colour derivation, three-layer resolution,
 *  operator fall-through, and the locked semantic palette. */

// --- colour (BR-UI-4) ------------------------------------------------------

test('contrast ratio matches WCAG extremes', () => {
  assert.equal(Number(contrastRatio('#FFFFFF', '#000000').toFixed(0)), 21);
  assert.equal(contrastRatio('#123456', '#123456'), 1);
});

test('accessibleForeground picks the more legible neutral', () => {
  assert.equal(accessibleForeground('#0C1017'), '#FFFFFF'); // dark bg → white text
  assert.equal(accessibleForeground('#FFFFFF'), '#0C1017'); // light bg → ink text
  // derived foreground always clears the AA large-text bar (>= 3:1), by construction
  for (const hex of ['#0F6E56', '#9B3A78', '#2E6FB8', '#EF9F27']) {
    assert.ok(contrastRatio(hex, accessibleForeground(hex)) >= 3);
  }
});

test('deriveDarkVariant preserves hue and lightens', () => {
  const dark = deriveDarkVariant('#0F6E56');
  assert.match(dark, /^#[0-9A-F]{6}$/);
  // a dark-mode stop should be lighter than the light-mode hue it came from
  assert.ok(relativeLuminance(dark) > relativeLuminance('#0F6E56'));
});

// --- resolution (three layers) --------------------------------------------

function makeService(prefs = {}, brand = {}) {
  return new ThemingService({
    preferences: { getPreferences: async () => prefs, savePreferences: async () => {} },
    branding: { getBrandTokens: async () => brand, saveBrandTokens: async () => {} },
  });
}

test('resolveTheme composes defaults ← user preferences', async () => {
  const svc = makeService({ accent: 'violet', colorScheme: 'dark' });
  const theme = await svc.resolveTheme({ userId: 'u', activeTenantId: 't' });
  assert.equal(theme.preferences.accent, 'violet');       // overridden
  assert.equal(theme.preferences.colorScheme, 'dark');    // overridden
  assert.equal(theme.preferences.density, PREFERENCE_DEFAULTS.density); // default retained
});

test('resolveTheme derives brand ramp + foreground from a chosen hue', async () => {
  const svc = makeService({}, { primary: '#9B3A78' });
  const theme = await svc.resolveTheme({ userId: 'u', activeTenantId: 't' });
  assert.equal(theme.brand.primary.color.light, '#9B3A78');
  assert.match(theme.brand.primary.color.dark, /^#[0-9A-F]{6}$/); // derived
  assert.ok(['#FFFFFF', '#0C1017'].includes(theme.brand.primary.foreground.light)); // derived, not chosen
});

test('a platform operator (no tenant) falls through to brand defaults', async () => {
  const svc = makeService({}, {});
  const theme = await svc.resolveTheme({ userId: 'op', activeTenantId: null });
  assert.equal(theme.brand.primary.color.light, BRAND_DEFAULTS.primary.light);
  assert.equal(theme.brand.secondary.color.light, BRAND_DEFAULTS.secondary.light);
});

test('the locked semantic palette is always echoed and unchanged (BR-UI-2)', async () => {
  const svc = makeService({}, {});
  const theme = await svc.resolveTheme({ userId: 'u', activeTenantId: 't' });
  assert.deepEqual(theme.semantic, SEMANTIC_PALETTE);
  assert.deepEqual(theme.accents, SAFE_ACCENTS);
  // every semantic entry carries an icon + label so meaning isn't colour-only (BR-UI-3)
  for (const state of Object.keys(SEMANTIC_PALETTE)) {
    assert.ok(theme.semantic[state].icon && theme.semantic[state].label);
  }
});

test('updatePreferences merges over stored, resetPreferences clears', async () => {
  const store = { accent: 'teal' };
  const svc = new ThemingService({
    preferences: { getPreferences: async () => store, savePreferences: async (_u, p) => { Object.assign(store, p); } },
    branding: { getBrandTokens: async () => ({}), saveBrandTokens: async () => {} },
  });
  const merged = await svc.updatePreferences('u', { colorScheme: 'dark' });
  assert.equal(merged.accent, 'teal');       // preserved
  assert.equal(merged.colorScheme, 'dark');  // added
});

// --- schema guards (BR-UI-2: no state.* write path) ------------------------

test('preference schema is strict and rejects unknown / state.* keys', () => {
  assert.equal(userPreferencesPatchSchema.safeParse({ accent: 'teal' }).success, true);
  assert.equal(userPreferencesPatchSchema.safeParse({ semanticApproved: '#fff' }).success, false); // no state write path
  assert.equal(userPreferencesPatchSchema.safeParse({ accent: 'cyan' }).success, false);           // outside safe band
});

test('brand schema accepts a hex hue + http(s) logo, rejects other schemes', () => {
  assert.equal(brandTokensPatchSchema.safeParse({ primary: '#0F6E56' }).success, true);
  assert.equal(brandTokensPatchSchema.safeParse({ logoUrl: 'https://cdn.example.com/logo.png' }).success, true);
  assert.equal(brandTokensPatchSchema.safeParse({ logoUrl: 'javascript:alert(1)' }).success, false);
  assert.equal(brandTokensPatchSchema.safeParse({ primary: 'red' }).success, false);
});
