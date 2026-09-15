import { useState, useEffect, useCallback } from 'react';

const KEY = 'aba1on1.sidebar.collapsed';

/**
 * One shared sidebar collapse preference for the whole app (spec §4). Persisted
 * to localStorage so it survives navigation and refresh; it is a non-sensitive
 * UI preference, nothing else is stored. A single source of truth means every
 * page reads/writes the same state rather than each implementing its own.
 * Changes broadcast across mounted components (and tabs) via a storage event.
 */
function read() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(read);

  useEffect(() => {
    const onStorage = (e) => { if (e.key === KEY) setCollapsed(read()); };
    const onLocal = () => setCollapsed(read());
    window.addEventListener('storage', onStorage);
    window.addEventListener('aba1on1:sidebar', onLocal);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('aba1on1:sidebar', onLocal);
    };
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(KEY, next ? '1' : '0'); } catch { /* preference is best-effort */ }
      window.dispatchEvent(new Event('aba1on1:sidebar'));
      return next;
    });
  }, []);

  return { collapsed, toggle };
}
