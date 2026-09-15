import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const ToastContext = createContext(null);

/**
 * Tiny toast system: a provider holds a list of transient messages, and
 * useToast() returns push helpers. Auto-dismisses after a few seconds. Used to
 * confirm operator actions (created, invited, transitioned) without blocking.
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  // Track pending auto-dismiss timers so we can clear them on unmount — an
  // uncleared setTimeout firing setToasts after unmount is a real post-unmount
  // state update (the "not wrapped in act(...)" warning seen after a failed
  // booking, where the modal unmounts before the toast's 4s timer elapses).
  const timers = useRef(new Set());

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((message, tone = 'positive') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((list) => [...list, { id, message, tone }]);
    const handle = setTimeout(() => { timers.current.delete(handle); dismiss(id); }, 4000);
    timers.current.add(handle);
  }, [dismiss]);

  useEffect(() => () => { for (const h of timers.current) clearTimeout(h); timers.current.clear(); }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone}`} onClick={() => dismiss(t.id)}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  // A no-op fallback keeps components usable (and unit-testable) without a provider.
  return ctx ?? { push: () => {} };
}
