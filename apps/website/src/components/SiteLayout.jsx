import { useEffect, useId, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { PLATFORM_BRAND } from '@aba1on1/schemas';
import { siteEnv } from '@/config/env';
import { BrandLogo } from './BrandLogo.jsx';
import { EASE } from './motion.jsx';

/**
 * Shared frame for every public page: a sticky navbar with a mobile menu, the
 * page content, and the footer. "Sign In" is a plain link to the existing web
 * panel login — this application has no authentication of its own.
 */
export const NAV_LINKS = [
  { label: 'Home', to: '/' },
  { label: 'Features', to: '/#features' },
  { label: 'How It Works', to: '/#how-it-works' },
  { label: 'Privacy', to: '/privacy-policy' },
  { label: 'Terms', to: '/terms-and-conditions' },
];

const DEFAULT_DESCRIPTION = `${PLATFORM_BRAND.productName} is practice management software for ABA organizations — clients, staff, scheduling, sessions, treatment plans, insurance billing and payroll in one role-based workspace.`;

function setMeta(selector, attr, value) {
  const el = document.head.querySelector(selector);
  if (el) el.setAttribute(attr, value);
}

function usePageMeta(title, description) {
  useEffect(() => {
    const fullTitle = title ? `${title} | ${PLATFORM_BRAND.productName}` : PLATFORM_BRAND.productName;
    const desc = description || DEFAULT_DESCRIPTION;
    document.title = fullTitle;
    setMeta('meta[name="description"]', 'content', desc);
    setMeta('meta[property="og:title"]', 'content', fullTitle);
    setMeta('meta[property="og:description"]', 'content', desc);
  }, [title, description]);
}

/** Scroll to the top on page change, or to the #section named in the URL. */
function useScrollManagement() {
  const { pathname, hash } = useLocation();
  const reduce = useReducedMotion();
  useEffect(() => {
    if (hash) {
      const target = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (target) {
        target.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        return;
      }
    }
    window.scrollTo?.(0, 0);
  }, [pathname, hash, reduce]);
}

function isActive(link, location) {
  const [path, fragment] = link.to.split('#');
  if (fragment) return location.pathname === path && location.hash === `#${fragment}`;
  if (path === '/') return location.pathname === '/' && !location.hash;
  return location.pathname === path;
}

function Navbar() {
  const location = useLocation();
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const menuId = useId();
  const toggleRef = useRef(null);

  useEffect(() => { setOpen(false); }, [location.pathname, location.hash]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { setOpen(false); toggleRef.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header className={`ps-nav${scrolled ? ' is-scrolled' : ''}${open ? ' is-open' : ''}`}>
      <div className="ps-container ps-nav__bar">
        <Link to="/" className="ps-nav__brand" aria-label={`${PLATFORM_BRAND.productName} home`}>
          <BrandLogo />
        </Link>

        <nav className="ps-nav__links" aria-label="Primary">
          {NAV_LINKS.map((link) => (
            <Link key={link.to} to={link.to} className={`ps-nav__link${isActive(link, location) ? ' is-active' : ''}`}
              aria-current={isActive(link, location) ? 'page' : undefined}>
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="ps-nav__actions">
          <a href={siteEnv.signInUrl} className="ps-btn ps-btn--ghost">Sign In</a>
          <Link to="/contact" className="ps-btn ps-btn--primary">Contact Us</Link>
        </div>

        <button
          ref={toggleRef}
          type="button"
          className="ps-nav__toggle"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="ps-nav__toggle-bars" aria-hidden="true"><span /><span /><span /></span>
        </button>
      </div>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.nav
            id={menuId}
            className="ps-nav__menu"
            aria-label="Mobile"
            initial={reduce ? false : { opacity: 0, height: 0 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: reduce ? 0 : 0.28, ease: EASE }}
          >
            <div className="ps-container ps-nav__menu-inner">
              {NAV_LINKS.map((link) => (
                <Link key={link.to} to={link.to} className={`ps-nav__menu-link${isActive(link, location) ? ' is-active' : ''}`}
                  aria-current={isActive(link, location) ? 'page' : undefined}>
                  {link.label}
                </Link>
              ))}
              <div className="ps-nav__menu-actions">
                <Link to="/contact" className="ps-btn ps-btn--primary ps-btn--block">Contact Us</Link>
                <a href={siteEnv.signInUrl} className="ps-btn ps-btn--outline ps-btn--block">Sign In</a>
              </div>
            </div>
          </motion.nav>
        ) : null}
      </AnimatePresence>
    </header>
  );
}

function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="ps-footer">
      <div className="ps-container ps-footer__grid">
        <div className="ps-footer__brand">
          <BrandLogo />
          <p>
            Practice management software for ABA organizations — clients, staff, scheduling, sessions,
            treatment plans, insurance billing and payroll in one role-based workspace.
          </p>
        </div>
        <nav className="ps-footer__nav" aria-label="Footer">
          <h2 className="ps-footer__heading">Explore</h2>
          <ul>
            <li><NavLink to="/" end>Home</NavLink></li>
            <li><NavLink to="/contact">Contact Us</NavLink></li>
            <li><a href={siteEnv.signInUrl}>Sign In</a></li>
          </ul>
        </nav>
        <nav className="ps-footer__nav" aria-label="Legal">
          <h2 className="ps-footer__heading">Legal</h2>
          <ul>
            <li><NavLink to="/privacy-policy">Privacy Policy</NavLink></li>
            <li><NavLink to="/terms-and-conditions">Terms &amp; Conditions</NavLink></li>
          </ul>
        </nav>
        <div className="ps-footer__nav">
          <h2 className="ps-footer__heading">Contact</h2>
          <ul>
            <li><a href={`mailto:${PLATFORM_BRAND.supportEmail}`}>{PLATFORM_BRAND.supportEmail}</a></li>
          </ul>
        </div>
      </div>
      <div className="ps-container ps-footer__base">
        <span>© {year} {PLATFORM_BRAND.productName}. All rights reserved.</span>
        <span>Product of {PLATFORM_BRAND.providerName}</span>
      </div>
    </footer>
  );
}

export function SiteLayout({ title, description, children }) {
  usePageMeta(title, description);
  useScrollManagement();
  return (
    <div className="ps">
      <a className="ps-skip" href="#main-content">Skip to main content</a>
      <Navbar />
      <main id="main-content" className="ps-main" tabIndex={-1}>
        {children}
      </main>
      <Footer />
    </div>
  );
}
