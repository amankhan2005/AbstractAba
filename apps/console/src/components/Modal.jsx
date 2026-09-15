import { useCallback, useEffect, useId, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

/**
 * Ref-counted body scroll lock. Nested modals (e.g. a ConfirmDialog opened on
 * top of an editor Modal) each acquire the lock; the page only regains scroll
 * once the last one releases it. The original overflow is captured once, on the
 * first acquire, and restored on the final release.
 */
let lockCount = 0;
let restoreOverflow = '';
function acquireScrollLock() {
  if (lockCount === 0) {
    restoreOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;
}
function releaseScrollLock() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) document.body.style.overflow = restoreOverflow;
}

/**
 * Open-modal stack. Only the top-most dialog reacts to Escape and traps Tab, so
 * pressing Escape in a confirmation opened over an editor closes just the
 * confirmation — not both.
 */
const modalStack = [];
const isTop = (token) => modalStack[modalStack.length - 1] === token;

const FOCUSABLE =
  'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const SIZE_CLASS = { sm: ' modal--sm', lg: ' modal--lg', xl: ' modal--xl' };

/**
 * Accessible modal — the ONE dialog system for the console, rendered through a
 * portal attached to <body> so no transformed/overflow ancestor can clip it.
 *
 *  - Layer: `.modal-overlay` carries `z-index: var(--z-modal)` (above sidebar,
 *    header, dropdowns and toasts); the date-picker popover layer sits above it.
 *  - Sizes: sm (confirmations) · md default (forms) · lg (wide forms) · xl.
 *  - Header: title + optional description + close button. Footer: actions.
 *  - Body scrolls internally; on phones the dialog becomes a full-width sheet.
 *  - Focus moves to the first field in the body (never the close button when a
 *    field exists), is trapped while open, and returns to the trigger on close.
 *  - Escape / overlay click / close button call `onClose`, unless
 *    `closeDisabled` is set (e.g. while a destructive request is in flight).
 */
export function Modal({ title, description, onClose, children, footer, size, closeDisabled = false }) {
  const closeRef = useRef(onClose);
  closeRef.current = typeof onClose === 'function' ? onClose : () => {};
  const disabledRef = useRef(closeDisabled);
  disabledRef.current = closeDisabled;
  const close = useCallback(() => { if (!disabledRef.current) closeRef.current(); }, []);

  const panelRef = useRef(null);
  const returnFocusRef = useRef(null);
  const tokenRef = useRef(null);
  if (tokenRef.current === null) tokenRef.current = {};
  const titleId = useId();
  const descId = useId();

  // Lock page scroll and register in the modal stack for the modal's lifetime.
  useLayoutEffect(() => {
    const token = tokenRef.current;
    acquireScrollLock();
    modalStack.push(token);
    return () => {
      releaseScrollLock();
      const i = modalStack.lastIndexOf(token);
      if (i !== -1) modalStack.splice(i, 1);
    };
  }, []);

  // Remember the element that had focus, move focus into the dialog (without
  // stealing an autoFocus'd field), and restore focus on unmount.
  useEffect(() => {
    returnFocusRef.current = document.activeElement;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const body = panel.querySelector('.modal-body');
      const field = body?.querySelector('input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),select:not([disabled]),textarea:not([disabled])');
      const first = field || body?.querySelector(FOCUSABLE) || panel.querySelector('.modal-foot ' + 'button:not([disabled])') || panel.querySelector(FOCUSABLE);
      (first || panel).focus?.();
    }
    return () => {
      const prev = returnFocusRef.current;
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus();
    };
  }, []);

  // Escape closes; Tab is trapped inside the panel. Top-most modal only.
  useEffect(() => {
    function onKey(e) {
      if (!isTop(tokenRef.current)) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (nodes.length === 0) {
        e.preventDefault();
        panel.focus?.();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [close]);

  const overlay = (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        className={`modal${SIZE_CLASS[size] ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
      >
        <div className="modal-head">
          <div className="modal-head__text">
            <h2 id={titleId}>{title}</h2>
            {description ? <p className="modal-desc" id={descId}>{description}</p> : null}
          </div>
          <button type="button" className="modal-x" onClick={close} aria-label="Close" disabled={closeDisabled}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );

  // Guard against SSR / missing body; render nothing rather than throwing.
  if (typeof document === 'undefined' || !document.body) return null;
  return createPortal(overlay, document.body);
}

/**
 * A confirmation dialog for destructive or state-changing actions.
 *
 * Contract (backward-compatible with every existing caller):
 *   - `open` gates rendering. Defaults to `true` so callers that gate
 *     themselves ({cond ? <ConfirmDialog/> : null}) keep working, while callers
 *     that pass `open={cond}` hide correctly.
 *   - close is taken from `onClose` OR `onCancel` (alias), then a no-op guard.
 *   - While `busy`, both buttons disable and Escape / overlay / X are ignored,
 *     so a request in flight can't be abandoned half-way or double-submitted.
 */
export function ConfirmDialog({
  open = true,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  busyLabel = 'Working…',
  tone = 'primary',
  busy,
  onConfirm,
  onClose,
  onCancel,
}) {
  const close = onClose || onCancel || (() => {});
  if (!open) return null;
  const danger = tone === 'danger';

  return (
    <Modal
      title={title}
      onClose={close}
      size="sm"
      closeDisabled={!!busy}
      footer={
        <>
          <button type="button" className="rxc-btn rxc-btn--secondary" onClick={close} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`rxc-btn ${danger ? 'rxc-btn--danger' : 'rxc-btn--primary'}`}
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy ? 'true' : undefined}
          >
            {busy ? <span className="rxc-spinner rxc-spinner--inline" aria-hidden="true" /> : null}
            <span>{busy ? busyLabel : confirmLabel}</span>
          </button>
        </>
      }
    >
      <div className={`confirm${danger ? ' confirm--danger' : ''}`}>
        <span className="confirm__icon" aria-hidden="true"><Icon name={danger ? 'alert' : 'info'} size={20} /></span>
        <p className="confirm__msg">{message}</p>
      </div>
    </Modal>
  );
}
