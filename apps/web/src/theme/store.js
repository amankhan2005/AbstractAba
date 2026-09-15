import { create } from 'zustand';
import { readStoredOverrides, writeStoredOverrides } from './storage';

/**
 * The client's working copy of the user's preference overrides. Hydrated from
 * the localStorage cache so the store agrees with the pre-paint bootstrap, then
 * reconciled from the server (the authority) by the ThemeProvider. Every
 * mutation writes the cache through so a reload is flash-free. Holds overrides
 * only — resolved values are derived, never stored. Ported verbatim.
 */
export const useAppearanceStore = create((set) => ({
  overrides: readStoredOverrides(),

  setPreference: (key, value) => {
    set((state) => {
      const overrides = { ...state.overrides, [key]: value };
      writeStoredOverrides(overrides);
      return { overrides };
    });
  },

  applyServerOverrides: (overrides) => {
    writeStoredOverrides(overrides);
    set({ overrides });
  },

  reset: () => {
    writeStoredOverrides({});
    set({ overrides: {} });
  },
}));
