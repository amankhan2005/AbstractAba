import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { ProfileMenu } from '@/features/account/ProfileMenu';
import { useHealth } from '@/api/queries';
import { Icon } from './Icon';
import { PLATFORM_BRAND } from '@aba1on1/schemas';
import { BrandLogo } from './BrandLogo';

/**
 * Super Admin shell — dark operator sidebar with grouped, iconised navigation,
 * a slim topbar (section breadcrumb, live platform status, account menu) and a
 * max-width content column. Below 1024px the sidebar becomes an off-canvas
 * drawer opened from the topbar menu button (Escape / backdrop / navigation
 * close it, page scroll is locked while open).
 *
 * The navigation uses only REAL routes the router defines, in plain language.
 */
const NAV = [
  { heading: 'Overview', items: [
    { to: '/', label: 'Dashboard', icon: 'dashboard', match: (p) => p === '/' },
  ] },
  { heading: 'Companies', items: [
    { to: '/companies', label: 'Companies', icon: 'building', match: (p) => p === '/companies' || (p.startsWith('/companies/') && !p.startsWith('/companies/invitations')) },
    { to: '/companies/invitations', label: 'Invitations', icon: 'mail', match: (p) => p.startsWith('/companies/invitations') },
    { to: '/inquiries', label: 'Inquiries', icon: 'inbox', match: (p) => p.startsWith('/inquiries') },
  ] },
  { heading: 'Business', items: [
    { to: '/billing', label: 'Plans & billing', icon: 'card', match: (p) => p.startsWith('/billing') },
    { to: '/insurance', label: 'Insurance', icon: 'shield', match: (p) => p.startsWith('/insurance') },
  ] },
  { heading: 'System', items: [
    { to: '/health', label: 'Status', icon: 'activity', match: (p) => p.startsWith('/health') },
    { to: '/account', label: 'My account', icon: 'user', match: (p) => p.startsWith('/account') },
  ] },
];

/** The current section for the topbar breadcrumb, resolved from the path. */
export function sectionFor(pathname) {
  for (const group of NAV) {
    for (const item of group.items) {
      if (!item.match(pathname)) continue;
      // Company sub-pages get their own final crumb.
      let page = null;
      if (/^\/companies\/[^/]+\/audit$/.test(pathname)) page = 'Audit log';
      else if (/^\/companies\/[^/]+$/.test(pathname) && item.to === '/companies') page = 'Company details';
      const crumbs = [group.heading, item.label, page].filter(Boolean)
        .filter((c, i, arr) => i === 0 || c !== arr[i - 1]);
      return { crumbs, label: page ?? item.label };
    }
  }
  return { crumbs: ['Console'], label: 'Console' };
}

function PlatformStatus() {
  const { data, isError } = useHealth();
  if (!data && !isError) return null;
  const up = data?.status === 'up';
  const label = isError ? 'Status unavailable' : up ? 'All systems operational' : 'Service degraded';
  return (
    <Link to="/health" className={`rxc-status${up ? ' is-up' : ' is-down'}`} title={label}>
      <span className="rxc-status__dot" aria-hidden="true" />
      <span className="rxc-status__label">{label}</span>
    </Link>
  );
}

export function ConsoleShellRx() {
  const { pathname } = useLocation();
  const section = sectionFor(pathname);
  const [navOpen, setNavOpen] = useState(false);
  const menuBtnRef = useRef(null);
  const asideRef = useRef(null);

  // Close the drawer on navigation.
  useEffect(() => { setNavOpen(false); }, [pathname]);

  // Drawer: Escape closes, body scroll locked, focus moves into the drawer and
  // returns to the menu button on close.
  useEffect(() => {
    if (!navOpen) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    asideRef.current?.querySelector('a,button')?.focus();
    const onKey = (e) => { if (e.key === 'Escape') setNavOpen(false); };
    document.addEventListener('keydown', onKey);
    const btn = menuBtnRef.current;
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
      btn?.focus();
    };
  }, [navOpen]);

  // Scroll to top when the route changes (content column is the page scroller).
  useEffect(() => { window.scrollTo?.(0, 0); }, [pathname]);

  return (
    <div className={`rxc${navOpen ? ' is-nav-open' : ''}`}>
      <a href="#rxc-main" className="rxc-skip">Skip to content</a>
      <aside className="rxc__aside" id="rxc-nav" aria-label="Main navigation" ref={asideRef}>
        <div className="rxc__brand">
          <div className="rxc__brandtext">
            <BrandLogo tone="onDark" fallback={<span className="rxc-logo"><><span className="rxc__mark" aria-hidden="true">{PLATFORM_BRAND.productMark}</span><span className="rxc__brandname">{PLATFORM_BRAND.productName}</span></></span>} />
            <div className="rxc__brandrole">Super Admin</div>
          </div>
          <button type="button" className="rxc__navclose" onClick={() => setNavOpen(false)} aria-label="Close navigation">
            <Icon name="x" size={18} />
          </button>
        </div>
        <nav className="rxc__nav">
          {NAV.map((group) => (
            <div className="rxc__navgroup" key={group.heading}>
              <div className="rxc__navhead">{group.heading}</div>
              <ul>
                {group.items.map((item) => {
                  const active = item.match(pathname);
                  return (
                    <li key={item.to}>
                      <Link to={item.to} className={`rxc__link${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined}>
                        <Icon name={item.icon} size={18} />
                        <span>{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <div className="rxc__foot">
          <span className="rxc__footlabel">Platform Console</span>
          <span className="rxc__footlabel rxc__footlabel--provider">Product of {PLATFORM_BRAND.providerName}</span>
        </div>
      </aside>
      <button type="button" className="rxc__scrim" aria-label="Close navigation" tabIndex={-1} onClick={() => setNavOpen(false)} />

      <div className="rxc__main">
        <header className="rxc__top">
          <button
            type="button"
            ref={menuBtnRef}
            className="rxc__menubtn"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            aria-controls="rxc-nav"
            aria-expanded={navOpen}
          >
            <Icon name="menu" size={20} />
          </button>
          <nav className="rxc__crumb" aria-label="Breadcrumb">
            {section.crumbs.map((c, i) => {
              const last = i === section.crumbs.length - 1;
              return (
                <span key={`${c}-${i}`} className="rxc__crumb-item" aria-current={last ? 'page' : undefined}>
                  {i > 0 ? <Icon name="chevronRight" size={14} /> : null}
                  <span className={last ? 'rxc__crumb-page' : 'rxc__crumb-group'}>{c}</span>
                </span>
              );
            })}
          </nav>
          <div className="rxc__topright">
            <PlatformStatus />
            <ProfileMenu />
          </div>
        </header>
        <main className="rxc__container" id="rxc-main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default ConsoleShellRx;
