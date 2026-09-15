import { useEffect, useRef, useState } from 'react';
import { NavLink, matchPath, useLocation, useOutlet } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useAuthStore } from '@/auth/store';
import { signOut } from '@/api/client';
import { Icon } from '@/ui/icons.jsx';
import { BrandLogo } from '@/ui/BrandLogo.jsx';
import { PLATFORM_BRAND } from '@aba1on1/schemas';
import { Confirm } from '@/ui/components/Confirm.jsx';
import { useToast } from '@/components';
import { GlobalSearch } from './GlobalSearch.jsx';
import { useSidebarCollapsed } from './useSidebarCollapsed.js';
import { formatPersonName } from '@/lib/format';
import { pageVariants, drawerVariants, scrimVariants } from '@/ui/motion.js';

/**
 * The shared skeleton the three role shells compose. It owns ONLY the mechanics
 * every app needs — the responsive two-column grid, the off-canvas mobile
 * drawer, the sticky glass topbar, and the animated page transition. Everything
 * that gives an app its identity (brand, nav model, terminology, header copy,
 * accent) is passed IN by each role shell, so Company / BCBA / RBT read as three
 * distinct products rather than one layout with rows filtered by role.
 */

function initials(name = '') {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || 'U';
}

/**
 * Is a nav item the CURRENT route? Exact route matching, never substring
 * matching: an item is active on its own path (or its subtree unless `end`),
 * plus any extra route PATTERNS it declares in `activeFor` (for example
 * '/sessions/:sessionId'). A pathname that belongs to ANOTHER item in the same
 * nav (e.g. /sessions/oversight → "Session insights") never activates this one,
 * so two items can't be highlighted at once.
 */
export function isNavItemActive(item, pathname, allTargets = []) {
  const own = matchPath({ path: item.to, end: Boolean(item.end) }, pathname);
  const siblingOwns = allTargets.some((to) => to !== item.to && to.length > item.to.length && matchPath({ path: to, end: false }, pathname));
  if (own && !siblingOwns) return true;
  if (siblingOwns) return false;
  return (item.activeFor ?? []).some((pattern) => matchPath({ path: pattern, end: true }, pathname));
}

function NavGroup({ group, onNavigate, collapsed, pathname, allTargets }) {
  return (
    <div className="rx-nav__group">
      {group.label && !collapsed && <div className="rx-nav__label">{group.label}</div>}
      {group.items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          title={collapsed ? item.label : undefined}
          aria-label={item.label}
          aria-current={isNavItemActive(item, pathname, allTargets) ? 'page' : undefined}
          className={() => `rx-nav__link${isNavItemActive(item, pathname, allTargets) ? ' is-active' : ''}`}
        >
          <item.icon className="rx-nav__icon" />
          <span>{item.label}</span>
        </NavLink>
      ))}
    </div>
  );
}

/**
 * `confirmSignOut` (the Company, BCBA and RBT shells all pass it) asks
 * "Log out?" before running the existing sign-out.
 */
export function ShellFrame({ shellClass, brand, roleLabel, nav, topbar, showAccountLink = true, confirmSignOut = false, showProductSignature = true }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const outlet = useOutlet();
  const reduce = useReducedMotion();
  const principal = useAuthStore((s) => s.principal);
  const setStatus = useAuthStore.setState;
  const { collapsed, toggle } = useSidebarCollapsed();
  const toast = useToast();
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const signOutInFlight = useRef(false);

  // Modals, drawers, dropdown menus and toasts render in <body>, outside the
  // shell. Tagging <body> with the portal lets them use the same portal styling
  // (accent, surfaces) as the page that opened them.
  const portal = shellClass.replace(/^rx-shell--/, '');
  useEffect(() => {
    document.body.dataset.portal = portal;
    return () => { if (document.body.dataset.portal === portal) delete document.body.dataset.portal; };
  }, [portal]);

  // Presentation-only: the sidebar/header user name is shown with each name
  // component capitalized (john smith → John Smith), so the authenticated user's
  // first name always begins with a capital in the panel chrome. Only the stored
  // fullName is formatted — the email fallback is shown verbatim (never
  // title-cased). The persisted value is never changed. `formatPersonName`
  // safely returns '' for empty/nullish input, so the fallback chain still works.
  const name = formatPersonName(principal?.user?.fullName) || principal?.user?.email || 'You';
  const allTargets = nav.flatMap((g) => g.items.map((it) => it.to));
  // A shell can ask for a page-aware top bar: the current nav item's name, with
  // its section as context (e.g. "Clients" · "Care"), instead of one fixed title.
  const current = topbar.fromNav
    ? nav.flatMap((g) => g.items.map((it) => ({ ...it, group: g.label }))).find((it) => isNavItemActive(it, location.pathname, allTargets))
    : null;
  const barTitle = current?.label ?? topbar.title;
  const barSub = current ? [roleLabel, current.group].filter(Boolean).join(' · ') : topbar.subtitle;

  async function handleSignOut() {
    // One request per sign-out, however many clicks.
    if (signOutInFlight.current) return;
    signOutInFlight.current = true;
    setSigningOut(true);
    try {
      await signOut();
    } catch {
      // Existing contract: the API client always clears the local session (its
      // access token and session hint) even when the request fails, so the user
      // is signed out on this device either way — tell them rather than fail
      // silently.
      toast.push('You have been logged out on this device. The server could not be reached to end the session.', 'negative');
    }
    setStatus({ status: 'unauthenticated', principal: null });
  }

  const requestSignOut = () => {
    setOpen(false);
    if (confirmSignOut) setConfirmingSignOut(true);
    else void handleSignOut();
  };

  const aside = (
    <>
      <div className="rx-brand">
        <div className="rx-brand__mark">
          {brand.logoUrl
            ? <img src={brand.logoUrl} alt={`${brand.name || 'Company'} logo`} className="rx-brand__logo"
                onError={(e) => { e.currentTarget.style.display = 'none'; if (e.currentTarget.nextSibling) e.currentTarget.nextSibling.style.display = 'flex'; }} />
            : null}
          <span className="rx-brand__markfallback" style={{ display: brand.logoUrl ? 'none' : 'flex' }}>
            {brand.mark ?? initials(brand.name)}
          </span>
        </div>
        <div>
          <div className="rx-brand__name">{brand.name}</div>
          <div className="rx-brand__role">{roleLabel}</div>
        </div>
      </div>
      <nav className="rx-nav" aria-label="Primary">
        {nav.map((group, i) => <NavGroup key={group.label || i} group={group} collapsed={collapsed} onNavigate={() => setOpen(false)}
          pathname={location.pathname} allTargets={allTargets} />)}
      </nav>
      <div className="rx-aside__foot">
        {/* Product signature — the software brand, separate from the customer
            organization shown at the top of the rail. */}
        {showProductSignature ? (
          <div className="rx-productsig">
            <BrandLogo size="sm" tone="onLight" />
            <span className="rx-productsig__by">Product of {PLATFORM_BRAND.providerName}</span>
          </div>
        ) : null}
        {showAccountLink && (
          <NavLink to="/account" onClick={() => setOpen(false)} className="rx-navlink" style={{ marginBottom: 8 }}>
            <Icon.Shield size={16} /><span>Account &amp; security</span>
          </NavLink>
        )}
        <div className="rx-userchip" style={{ cursor: 'default' }}>
          <div className="rx-avatar">{initials(name)}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="rx-userchip__name" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
            <div className="rx-userchip__meta">{principal?.user?.email}</div>
          </div>
          <button className="rx-iconbtn" style={{ width: 34, height: 34 }} onClick={requestSignOut}
            aria-label={confirmSignOut ? 'Log out' : 'Sign out'} title={confirmSignOut ? 'Log out' : 'Sign out'} aria-haspopup={confirmSignOut ? 'dialog' : undefined}>
            <Icon.Logout size={16} />
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className={`rx-shell ${shellClass}${collapsed ? ' is-collapsed' : ''}`}>
      {/* Desktop rail */}
      <aside className="rx-shell__aside" aria-hidden={false}>
        <button
          type="button"
          className="rx-collapse-btn"
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-pressed={collapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <Icon.Arrow size={16} style={{ transform: collapsed ? 'rotate(180deg)' : 'none', transition: 'transform .18s' }} />
        </button>
        {aside}
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {open && (
          <>
            <motion.div className="rx-scrim" variants={scrimVariants} initial="initial" animate="animate" exit="exit"
              onClick={() => setOpen(false)} />
            <motion.aside className="rx-shell__aside is-open" variants={drawerVariants} initial="initial" animate="animate" exit="exit">
              {aside}
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="rx-shell__main">
        <header className="rx-topbar">
          <button className="rx-iconbtn rx-burger" onClick={() => setOpen(true)} aria-label="Open menu"><Icon.Menu /></button>
          <div className="rx-topbar__heading">
            <div className="rx-topbar__title">{barTitle}</div>
            {barSub && <div className="rx-topbar__sub">{barSub}</div>}
          </div>
          <div className="rx-topbar__spacer" />
          <GlobalSearch />
          <button className="rx-iconbtn" aria-label="Notifications"><Icon.Bell size={18} /><span className="rx-iconbtn__dot" /></button>
        </header>

        <div className="rx-shell__scroll">
          <AnimatePresence mode="wait">
            <motion.main
              key={location.pathname}
              className="rx-container"
              variants={reduce ? undefined : pageVariants}
              initial="initial" animate="animate" exit="exit"
            >
              {outlet}
            </motion.main>
          </AnimatePresence>
        </div>
      </div>

      {confirmSignOut && (
        <Confirm
          open={confirmingSignOut}
          title="Log out?"
          message="Are you sure you want to log out?"
          confirmLabel="Log out"
          busy={signingOut}
          onConfirm={() => { void handleSignOut(); }}
          onCancel={() => { if (!signingOut) setConfirmingSignOut(false); }}
        />
      )}
    </div>
  );
}

export default ShellFrame;
