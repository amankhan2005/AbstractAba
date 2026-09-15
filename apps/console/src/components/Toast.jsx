import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';

const ToastContext = createContext(null);

const TONE_ICON = { positive: 'checkCircle', negative: 'alertCircle', info: 'info', warning: 'alert' };
const DURATION = { positive: 4000, info: 5000, warning: 6000, negative: 7000 };

/**
 * Toast system: a provider holds transient messages and useToast() returns
 * `push(message, tone)` (tone: positive | negative | info | warning). Toasts
 * stack bottom-right (bottom-centre on phones), sit below the modal layer,
 * announce politely (errors assertively), pause on hover, and can be dismissed.
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);

  const schedule = useCallback((id, tone) => {
    const t = setTimeout(() => dismiss(id), DURATION[tone] ?? 4000);
    timers.current.set(id, t);
  }, [dismiss]);

  const push = useCallback((message, tone = 'positive') => {
    const id = Math.random().toString(36).slice(2);
    // Collapse an identical message already on screen instead of stacking duplicates.
    setToasts((list) => [...list.filter((x) => x.message !== message), { id, message, tone }].slice(-4));
    schedule(id, tone);
  }, [schedule]);

  useEffect(() => () => { timers.current.forEach((t) => clearTimeout(t)); timers.current.clear(); }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite" aria-relevant="additions">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast--${t.tone}`}
            role={t.tone === 'negative' ? 'alert' : 'status'}
            onMouseEnter={() => { const x = timers.current.get(t.id); if (x) { clearTimeout(x); timers.current.delete(t.id); } }}
            onMouseLeave={() => schedule(t.id, t.tone)}
          >
            <span className="toast__icon" aria-hidden="true"><Icon name={TONE_ICON[t.tone] ?? 'info'} size={18} /></span>
            <span className="toast__msg">{t.message}</span>
            <button type="button" className="toast__x" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
              <Icon name="x" size={14} />
            </button>
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
