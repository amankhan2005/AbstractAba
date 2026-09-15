import { useEffect } from 'react';
import { Button } from './Button';

/**
 * A modal confirmation used for destructive/financial actions. Accessible:
 * focus-scoped overlay, Escape to cancel, labelled dialog. No browser confirm().
 *
 * CONTRACT FIX. This component previously had no `open` prop and rendered
 * whenever it was mounted, while two call sites (RecurringSeriesPage,
 * DataToolsPage) passed `open={...}` and `onCancel={...}`. The result was a
 * permanently-visible dialog whose confirm handler ran against null state —
 * the actual root cause of
 *
 *     RecurringSeriesPage.jsx:209 Cannot read properties of null (reading 'kind')
 *
 * and of an `onClose is not a function` throw on Escape. `open` is now honoured
 * (rendering nothing when false) and `onCancel` is accepted as an alias for
 * `onClose`, so both the existing and the intended call shapes are correct.
 *
 * `open` defaults to true so any call site that mounts conditionally — the
 * original contract — keeps working unchanged.
 */
export function ConfirmDialog({
  open = true,
  title,
  message,
  confirmLabel = 'Confirm',
  tone = 'accent',
  busy = false,
  onConfirm,
  onClose,
  onCancel,
}) {
  const dismiss = onClose ?? onCancel;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !busy) dismiss?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, dismiss]);

  if (!open) return null;

  return (
    <div
      className="ui-modal-overlay"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) dismiss?.(); }}
    >
      <div className="ui-modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="ui-modal__title">{title}</h2>
        <p className="ui-modal__body">{message}</p>
        <div className="ui-modal__footer">
          <Button variant="ghost" onClick={() => dismiss?.()} disabled={busy}>Cancel</Button>
          <Button variant={tone === 'danger' ? 'ghost' : 'accent'} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
