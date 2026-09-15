import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useAuthStore } from '@/auth/store';
import { workspaceForRoles, resolveWorkspaceNav } from '@/app/workspaces';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

/**
 * ---------------------------------------------------------------------------
 * WORKSPACE LAYOUT — the shell for all four experiences.
 *
 * One component, parameterised by the workspace the signed-in role resolves to.
 * That is deliberate: the four experiences differ in their DATA (sidebar
 * sections, labels, workspace name, scope word), not in their mechanics
 * (collapsible sidebar, mobile drawer, header, sign-out). Sharing the mechanics
 * keeps them consistent; the per-workspace data is what makes a technician's
 * "My day / My hours" feel like a different product from a company admin's
 * "Clients / Payroll".
 *
 * Motion is subtle and reduced-motion-aware: a short content fade on route
 * change, a drawer slide on mobile. Nothing animates that would slow the work.
 * ---------------------------------------------------------------------------
 */
export function WorkspaceLayout() {
  const principal = useAuthStore((state) => state.principal);
  const signOut = useAuthStore((state) => state.signOut);
  const location = useLocation();
  const reduce = useReducedMotion();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // INTENTIONALLY NOT usePermissions(). This is the navigation rail, and it is
  // only ever mounted inside an authenticated route — by the time it renders,
  // the principal is already resolved, so there is no bootstrap window in which
  // an empty permission list could be mistaken for denial. Gating the whole
  // shell on readiness here would blank the entire chrome rather than a single
  // action, which is worse. Screens that draw ACTIONS use usePermissions();
  // navigation derives from the principal it was handed.
  const roles = principal?.roles ?? [];
  const workspace = workspaceForRoles(roles);
  const sections = resolveWorkspaceNav(
    workspace,
    principal?.permissions ?? [],
    principal?.permissionScopes ?? {},
  );

  const initials = (principal?.fullName ?? principal?.email ?? '?')
    .split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('');

  const nav = (
    <nav className="ws-nav" aria-label={`${workspace.name} sections`}>
      {sections.map((section) => (
        <div key={section.label} className="ws-nav__section">
          <p className="ws-nav__heading">{section.label}</p>
          {section.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={() => setDrawerOpen(false)}
              className={({ isActive }) => (isActive ? 'ws-navlink ws-navlink--active' : 'ws-navlink')}
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="ws" data-workspace={workspace.id}>
      {/* Desktop sidebar */}
      <aside className="ws__sidebar" aria-label="Primary">
        <div className="ws__brand">
          <span className="ws__brand-mark">{PLATFORM_BRAND.productName}</span>
          <span className="ws__brand-workspace">{workspace.name}</span>
        </div>
        {nav}
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {drawerOpen ? (
          <>
            <motion.div
              className="ws__scrim"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.15 }}
              onClick={() => setDrawerOpen(false)}
            />
            <motion.aside
              className="ws__drawer"
              aria-label="Primary"
              initial={{ x: reduce ? 0 : '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: reduce ? 0 : '-100%' }}
              transition={{ type: 'tween', duration: reduce ? 0 : 0.2 }}
            >
              <div className="ws__brand">
                <span className="ws__brand-mark">{PLATFORM_BRAND.productName}</span>
                <span className="ws__brand-workspace">{workspace.name}</span>
              </div>
              {nav}
            </motion.aside>
          </>
        ) : null}
      </AnimatePresence>

      <div className="ws__main">
        <header className="ws__header">
          <button
            type="button"
            className="ws__menu-btn"
            aria-label="Open menu"
            onClick={() => setDrawerOpen(true)}
          >
            <span aria-hidden>☰</span>
          </button>
          <span className="ws__scope">{workspace.scopeLabel}</span>
          <div className="ws__identity">
            <span className="ws__avatar" aria-hidden>{initials || '?'}</span>
            <span className="muted ws__whoami">{principal?.fullName ?? principal?.email ?? ''}</span>
            <button type="button" className="ui-button ui-button--ghost" onClick={() => { void signOut(); }}>
              Sign out
            </button>
          </div>
        </header>

        <main className="ws__content">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: reduce ? 0 : 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.18, ease: 'easeOut' }}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
