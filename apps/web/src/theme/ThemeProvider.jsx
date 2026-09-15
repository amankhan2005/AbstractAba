import { useEffect, useState } from 'react';
import { resolveScheme, toDataAttributes } from './appearance';
import { useAppearanceStore } from './store';

/**
 * Applies the resolved theme to the document. Preferences become data-*
 * attributes on the root; the stylesheet turns those into CSS custom
 * properties, so a change is a variable update, not a re-render (BR-UI-1).
 * `auto` is tracked live through matchMedia. `loadServerTheme` is the
 * reconciliation seam: when provided (after sign-in), the authoritative
 * preferences and tenant brand win over the local cache. Ported verbatim.
 */
function applyPreferenceAttributes(overrides, prefersDark) {
  const attributes = toDataAttributes(overrides, prefersDark);
  // Product decision: the visible UI is always the light (white-panel) scheme.
  // The appearance infrastructure is preserved (accent, density, radius, etc.),
  // but the color scheme is pinned to light so no dark panels are ever rendered.
  attributes.scheme = 'light';
  const root = document.documentElement;
  for (const [name, value] of Object.entries(attributes)) root.dataset[name] = value;
}

function applyBrand(theme, scheme) {
  // Defensive: a malformed/empty theme payload must never blank the whole app.
  // Only set the brand variables when the expected shape is actually present.
  const primary = theme?.brand?.primary?.color?.[scheme];
  const secondary = theme?.brand?.secondary?.color?.[scheme];
  if (!primary && !secondary) return;
  const root = document.documentElement;
  if (primary) root.style.setProperty('--color-brand-primary', primary);
  if (secondary) root.style.setProperty('--color-brand-secondary', secondary);
}

export function ThemeProvider({ children, loadServerTheme }) {
  const overrides = useAppearanceStore((state) => state.overrides);
  const applyServerOverrides = useAppearanceStore((state) => state.applyServerOverrides);
  const [serverTheme, setServerTheme] = useState(null);

  useEffect(() => {
    if (!loadServerTheme) return undefined;
    let cancelled = false;
    void loadServerTheme()
      .then((theme) => {
        if (!cancelled) {
          setServerTheme(theme);
          applyServerOverrides(theme.preferences);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [loadServerTheme, applyServerOverrides]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      applyPreferenceAttributes(overrides, media.matches);
      if (serverTheme) applyBrand(serverTheme, 'light');
    };
    apply();
    media.addEventListener('change', apply);
    return () => { media.removeEventListener('change', apply); };
  }, [overrides, serverTheme]);

  return children;
}
