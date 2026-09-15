import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const GAP = 8;
const EDGE = 12;
const SHEET_QUERY = '(max-width: 560px)';

const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Calendar popover. Portalled to <body> so no ancestor with overflow, transform
 * or a scroll container (modal bodies, animated cards) can clip or misplace it;
 * positioned against the trigger with `position: fixed`, flipping above when
 * there is no room below. On phones it becomes a bottom sheet with a scrim.
 *
 * Keyboard: Escape and Tab are handled in the WINDOW capture phase, before any
 * document-level modal handler sees them — so Escape closes only the calendar
 * (not the dialog it sits in) and Tab cycles inside the calendar rather than
 * being pulled back into the host dialog's focus trap.
 *
 * The portal leaves the role shell's subtree, so the shell accent is read off
 * the anchor once on open and carried in as `--dp-accent`.
 */
export function Popover({ anchorRef, onClose, label, children, wide = false }) {
  const popRef = useRef(null);
  const [sheet] = useState(() => typeof window !== 'undefined' && Boolean(window.matchMedia?.(SHEET_QUERY).matches));
  const [style, setStyle] = useState(() => ({ ...accentVars(anchorRef.current), visibility: 'hidden' }));
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (sheet) { setStyle((s) => ({ ...s, visibility: 'visible' })); return undefined; }
    let frame = 0;
    const place = () => {
      const anchor = anchorRef.current;
      const pop = popRef.current;
      if (!anchor || !pop) return;
      const a = anchor.getBoundingClientRect();
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let top = a.bottom + GAP;
      if (top + h > vh - EDGE && a.top - GAP - h >= EDGE) top = a.top - GAP - h;
      const left = Math.max(EDGE, Math.min(a.left, vw - EDGE - w));
      setStyle((s) => (s.top === top && s.left === left && s.visibility === 'visible' ? s : { ...s, top, left, visibility: 'visible' }));
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    place();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [anchorRef, sheet]);

  useEffect(() => {
    function onPointer(e) {
      if (popRef.current?.contains(e.target) || anchorRef.current?.contains(e.target)) return;
      closeRef.current({ restoreFocus: false });
    }
    function onKey(e) {
      const pop = popRef.current;
      if (!pop) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        closeRef.current({ restoreFocus: true });
        return;
      }
      if (e.key === 'Tab' && pop.contains(document.activeElement)) {
        const nodes = [...pop.querySelectorAll(FOCUSABLE)];
        if (nodes.length === 0) return;
        e.stopPropagation();
        const i = nodes.indexOf(document.activeElement);
        const next = e.shiftKey ? (i <= 0 ? nodes.length - 1 : i - 1) : (i === nodes.length - 1 ? 0 : i + 1);
        e.preventDefault();
        nodes[next].focus();
      }
    }
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchorRef]);

  return createPortal(
    <div className={`dp-layer${sheet ? ' dp-layer--sheet' : ''}`}>
      {sheet && <div className="dp-scrim" aria-hidden="true" />}
      <div
        ref={popRef}
        className={`dp-pop${wide ? ' dp-pop--wide' : ''}${sheet ? ' dp-pop--sheet' : ''}`}
        role="dialog"
        aria-label={label}
        style={style}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Carry the role-shell accent across the portal boundary. */
function accentVars(anchor) {
  if (!anchor || typeof window === 'undefined' || !window.getComputedStyle) return {};
  const cs = window.getComputedStyle(anchor);
  const accent = cs.getPropertyValue('--rx-accent').trim();
  const strong = cs.getPropertyValue('--rx-accent-strong').trim();
  return {
    ...(accent ? { '--dp-accent': accent } : {}),
    ...(strong ? { '--dp-accent-strong': strong } : {}),
  };
}
