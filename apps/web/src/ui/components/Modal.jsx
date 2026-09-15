import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Icon } from '../icons.jsx';

/**
 * Animated modal (centered) and drawer (right sheet). Framer Motion entry/exit,
 * scrim, Escape-to-close, focus trap-lite (autofocus close), and a fixed footer
 * for actions. Replaces every alert()/confirm()/prompt() and the old inline
 * dialogs. `variant`: 'modal' | 'drawer'.
 */
export function Modal({ open, onClose, title, description, children, footer, variant = 'modal', size = 'md' }) {
  const reduce = useReducedMotion();
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose?.(); }
    if (open) { document.addEventListener('keydown', onKey); document.body.style.overflow = 'hidden'; }
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [open, onClose]);

  const panelMotion = variant === 'drawer'
    ? { initial: { x: '100%' }, animate: { x: 0 }, exit: { x: '100%' }, transition: { type: 'spring', stiffness: 380, damping: 40 } }
    : { initial: { opacity: 0, y: 16, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: 8, scale: 0.98 }, transition: { duration: 0.18 } };

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className={`rx-modal rx-modal--${variant}`}>
          <motion.div className="rx-modal__scrim" onClick={() => onClose?.()}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
          <motion.div className={`rx-modal__panel rx-modal__panel--${size}`} role="dialog" aria-modal="true" aria-label={title}
            {...(reduce ? { initial: false } : panelMotion)}>
            <header className="rx-modal__head">
              <div>
                <div className="rx-modal__title">{title}</div>
                {description && <div className="rx-modal__desc">{description}</div>}
              </div>
              <button className="rx-iconbtn" onClick={onClose} aria-label="Close" autoFocus><Icon.Plus size={18} style={{ transform: 'rotate(45deg)' }} /></button>
            </header>
            {/* A confirmation with no body (title + description + actions) stays compact. */}
            {children != null && children !== false && <div className="rx-modal__body">{children}</div>}
            {footer && <footer className="rx-modal__foot">{footer}</footer>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export default Modal;
