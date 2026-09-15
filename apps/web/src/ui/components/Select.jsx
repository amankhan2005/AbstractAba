import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Icon } from '../icons.jsx';

/**
 * Premium custom select — searchable, keyboard-accessible, animated, and fed by
 * real API data (options are passed in by the caller, which fetches them). It
 * replaces the browser-default control everywhere a richer picker is warranted:
 * loading/empty/disabled/selected states, optional per-option badge, and a
 * clearable value. Positioned under the trigger; closes on outside click / Esc.
 *
 * options: [{ value, label, hint?, badge?: {tone,text}, image?: url }]
 *
 * `image` (optional) renders a small logo before the label — used by the
 * insurance picker to show the Super-Admin-provided catalog logo where one
 * exists. Options without an image are unchanged (no placeholder is invented).
 *
 * `portal` (optional) renders the menu in <body> with `position: fixed`, using
 * the same approach as the shared date-picker Popover. Use it where the field
 * sits inside a container that clips its children (overflow hidden/auto, an
 * animated panel) or near the bottom of the viewport: the menu opens below the
 * field when there is room, otherwise above it, is height-limited to the space
 * available so every option stays reachable, and follows the field on scroll
 * and resize. Without `portal` the menu stays inline, exactly as before.
 */
const MENU_GAP = 6;
// Floating list height cap. Taller than the inline 240px (.rx-select__list) so a
// short list (e.g. the seven US timezones) is shown in full without scrolling.
const FLOATING_LIST_MAX = 320;
const VIEWPORT_EDGE = 12;
/** Tokens the menu reads; copied from the field so the portal keeps the shell theme. */
const THEME_VARS = ['--rx-accent', '--rx-accent-strong', '--rx-accent-tint', '--rx-accent-tint-2', '--rx-surface', '--rx-ink', '--rx-ink-soft', '--rx-ink-faint', '--rx-line', '--rx-line-soft'];
export function Select({
  value, onChange, options = [], placeholder = 'Select…', label, searchable = true,
  loading = false, disabled = false, clearable = false, emptyText = 'No matches', id, portal = false,
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const searchRef = useRef(null);
  const [floating, setFloating] = useState(null); // { style, above } when portalled
  const reduce = useReducedMotion();

  const selected = options.find((o) => o.value === value) || null;
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : options;

  // A portalled menu is hidden for its first frame while it is measured, and a
  // hidden input cannot take focus — so focus the search box once it is placed.
  const placed = Boolean(floating);
  useEffect(() => {
    if (portal && open && placed && searchable) searchRef.current?.focus({ preventScroll: true });
  }, [portal, open, placed, searchable]);

  // A portalled menu can hold focus outside the field (or none at all), so
  // Escape is handled at the window while it is open — in the capture phase,
  // like the date-picker Popover, so it closes only the menu and not a dialog
  // the field sits in.
  useEffect(() => {
    if (!portal || !open) return undefined;
    function onEscape(e) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
    }
    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, [portal, open]);

  useEffect(() => {
    function onDoc(e) {
      if (rootRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => { if (!open) { setQ(''); setActive(0); } }, [open]);

  // Floating placement: below when the menu fits (or there is more room below),
  // otherwise above; capped to the available height; re-measured on scroll
  // (capture phase, so scrolling any ancestor counts) and on resize.
  useLayoutEffect(() => {
    if (!portal || !open) { setFloating(null); return undefined; }
    let frame = 0;
    const place = () => {
      // Measure the button, not the wrapper: a grid row can stretch the wrapper taller.
      const trigger = rootRef.current?.querySelector('.rx-select__trigger');
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const r = trigger.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const list = menu.querySelector('.rx-select__list');
      const chrome = list ? menu.offsetHeight - list.offsetHeight : 0; // search bar + borders
      const natural = chrome + (list ? Math.min(list.scrollHeight, FLOATING_LIST_MAX) : menu.offsetHeight);
      const below = vh - r.bottom - MENU_GAP - VIEWPORT_EDGE;
      const above = r.top - MENU_GAP - VIEWPORT_EDGE;
      const openAbove = natural > below && above > below;
      const maxHeight = Math.max(0, Math.floor(Math.min(natural, openAbove ? above : below)));
      const width = Math.min(r.width, vw - VIEWPORT_EDGE * 2);
      const left = Math.max(VIEWPORT_EDGE, Math.min(r.left, vw - VIEWPORT_EDGE - width));
      const top = openAbove ? r.top - MENU_GAP - maxHeight : r.bottom + MENU_GAP;
      setFloating((prev) => {
        const next = { top: Math.round(top), left: Math.round(left), width: Math.round(width), maxHeight, listMax: Math.max(0, maxHeight - chrome), above: openAbove };
        return prev && Object.keys(next).every((k) => prev[k] === next[k]) ? prev : next;
      });
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
  }, [portal, open, filtered.length, loading]);

  function themeVars() {
    const el = rootRef.current;
    if (!el || !window.getComputedStyle) return {};
    const cs = window.getComputedStyle(el);
    return Object.fromEntries(THEME_VARS.map((v) => [v, cs.getPropertyValue(v).trim()]).filter(([, val]) => val));
  }

  function choose(opt) { onChange?.(opt.value); setOpen(false); }

  function onKey(e) {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, filtered.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    if (e.key === 'Enter' && open && filtered[active]) { e.preventDefault(); choose(filtered[active]); }
  }

  const floatStyle = portal
    ? { ...themeVars(), ...(floating ? { top: floating.top, left: floating.left, width: floating.width } : { visibility: 'hidden' }) }
    : undefined;
  const offsetY = floating?.above ? 6 : -6;
  const menu = open ? (
    <motion.div
      ref={menuRef}
      className={`rx-select__menu${portal ? ' rx-select__menu--floating' : ''}`} role="listbox"
      style={floatStyle}
      initial={reduce ? false : { opacity: 0, y: offsetY, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: offsetY, scale: 0.98 }}
      transition={{ duration: 0.14 }}
    >
      {searchable && (
        <div className="rx-select__search">
          <Icon.Search size={15} />
          <input ref={searchRef} autoFocus value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} placeholder="Search…" />
        </div>
      )}
      <div className="rx-select__list" style={portal && floating ? { maxHeight: floating.listMax } : undefined}>
        {loading ? (
          <div className="rx-select__note"><span className="rx-spinner" style={{ width: 16, height: 16 }} /> Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="rx-select__note">{emptyText}</div>
        ) : filtered.map((o, i) => (
          <button
            type="button" key={o.value} role="option" aria-selected={o.value === value}
            className={`rx-select__opt${o.value === value ? ' is-selected' : ''}${i === active ? ' is-active' : ''}`}
            onMouseEnter={() => setActive(i)} onClick={() => choose(o)}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              {o.image && <img src={o.image} alt="" width={18} height={18} style={{ borderRadius: 4, objectFit: 'contain', flex: '0 0 auto' }} />}
              {o.badge && <span className={`rx-badge rx-badge--${o.badge.tone}`}><span className="rx-badge__dot" />{o.badge.text}</span>}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}{o.hint ? <span style={{ color: 'var(--rx-ink-faint)', marginLeft: 6, fontSize: '.82em' }}>{o.hint}</span> : null}</span>
            </span>
            {o.value === value && <Icon.Check size={16} />}
          </button>
        ))}
      </div>
    </motion.div>
  ) : null;

  return (
    <div className="rx-select" ref={rootRef} onKeyDown={onKey}>
      <button
        type="button" id={id} className={`rx-select__trigger${disabled ? ' is-disabled' : ''}`}
        aria-haspopup="listbox" aria-expanded={open} disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
      >
        <span className={`rx-select__value${selected ? '' : ' is-placeholder'}`}>
          {selected ? (
            <>
              {selected.image && <img src={selected.image} alt="" width={18} height={18} style={{ borderRadius: 4, objectFit: 'contain', marginRight: 6, verticalAlign: 'middle' }} />}
              {selected.badge && <span className={`rx-badge rx-badge--${selected.badge.tone}`} style={{ marginRight: 6 }}><span className="rx-badge__dot" />{selected.badge.text}</span>}
              {selected.label}
            </>
          ) : placeholder}
        </span>
        {clearable && selected && !disabled && (
          <span className="rx-select__clear" role="button" aria-label="Clear"
            onClick={(e) => { e.stopPropagation(); onChange?.(''); }}>×</span>
        )}
        <Icon.Grid size={0} />
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: .5, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}><path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>

      {portal ? createPortal(<AnimatePresence>{menu}</AnimatePresence>, document.body) : <AnimatePresence>{menu}</AnimatePresence>}
    </div>
  );
}

export default Select;
