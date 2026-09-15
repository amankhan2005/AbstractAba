import { useCallback } from 'react';
import { resetPreferences, savePreferences } from '@/api/client';
import { resolvePreferences } from './appearance';
import { useAppearanceStore } from './store';

/**
 * Read and change the current user's appearance. Updates are optimistic — the
 * store changes and the document re-themes immediately — then persisted. A
 * failed write leaves the change applied locally and cached; it reconciles on
 * the next authenticated load. Ported verbatim.
 */
export function useAppearance() {
  const overrides = useAppearanceStore((state) => state.overrides);
  const setStorePreference = useAppearanceStore((state) => state.setPreference);
  const resetStore = useAppearanceStore((state) => state.reset);

  const setPreference = useCallback(
    (key, value) => {
      setStorePreference(key, value);
      void savePreferences({ [key]: value }).catch(() => {});
    },
    [setStorePreference],
  );

  const reset = useCallback(() => {
    resetStore();
    void resetPreferences().catch(() => {});
  }, [resetStore]);

  return { preferences: resolvePreferences(overrides), overrides, setPreference, reset };
}
