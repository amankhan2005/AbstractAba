import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '@/auth/store';
import { Avatar, Icon } from '@/components';
import { ChangePasswordModal } from '@/features/account/ChangePasswordModal';
import { LogoutConfirm } from '@/features/account/LogoutConfirm';

/**
 * Topbar account menu: the operator's real name and email (from /auth/me), with
 * My account, Change password and Log out. Log out always asks first.
 * Keyboard: Enter/Space/ArrowDown opens, arrows move, Escape closes and returns
 * focus to the trigger.
 */
export function ProfileMenu() {
  const principal = useAuthStore((s) => s.principal);
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const ref = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) {
      if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = Array.from(menuRef.current?.querySelectorAll('[role="menuitem"]') ?? []);
      if (items.length === 0) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next].focus();
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    menuRef.current?.querySelector('[role="menuitem"]')?.focus();
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const user = principal?.user ?? {};
  const name = user.fullName || 'Platform administrator';
  const email = user.email || '';
  const role = principal?.isPlatformOperator ? 'Platform administrator' : 'Operator';

  return (
    <div className="profile" ref={ref}>
      <button
        type="button"
        ref={triggerRef}
        className="profile__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${name}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
      >
        <Avatar name={name} size="sm" />
        <span className="profile__who">
          <span className="profile__name">{name}</span>
          <span className="profile__role">{role}</span>
        </span>
        <Icon name="chevronDown" size={16} className="profile__chev" />
      </button>

      {open ? (
        <div className="profile__menu" role="menu" aria-label="Account" ref={menuRef}>
          <div className="profile__head">
            <Avatar name={name} size="md" />
            <div className="profile__headtext">
              <div className="profile__name">{name}</div>
              {email ? <div className="profile__email">{email}</div> : null}
              <div className="profile__role">{role}</div>
            </div>
          </div>
          <div className="profile__actions">
            <Link to="/account" role="menuitem" className="profile__item" onClick={() => setOpen(false)}>
              <Icon name="user" size={17} /><span>My account</span>
            </Link>
            <button type="button" role="menuitem" className="profile__item" onClick={() => { setOpen(false); setChanging(true); }}>
              <Icon name="key" size={17} /><span>Change password</span>
            </button>
            <div className="profile__sep" role="separator" />
            <button type="button" role="menuitem" className="profile__item profile__item--danger" onClick={() => { setOpen(false); setConfirmLogout(true); }}>
              <Icon name="logout" size={17} /><span>Log out</span>
            </button>
          </div>
        </div>
      ) : null}

      {changing ? <ChangePasswordModal onClose={() => setChanging(false)} /> : null}
      <LogoutConfirm open={confirmLogout} onClose={() => setConfirmLogout(false)} />
    </div>
  );
}
