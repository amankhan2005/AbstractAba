import { Navigate } from 'react-router-dom';
import { useAuthStore } from '@/auth/store';

/**
 * Role-aware landing.
 *
 * Every role previously landed on the same "you are signed in" card and then
 * had to find their own dashboard through a menu — the "one workspace, hidden
 * items" shape the product is meant to move away from. This sends each role
 * straight to the workspace root that matches their job, so the first screen
 * after login answers "what do I need to do?" rather than "you are signed in".
 *
 * This is a REDIRECT, not a new authorization surface. Every destination route
 * is still guarded server-side by its own permission and data scope; landing an
 * RBT on the RBT board grants nothing — the board's API calls resolve to the
 * RBT's own sessions because the backend scopes them, exactly as they would if
 * the RBT navigated there by hand. Frontend routing is convenience; the
 * boundary is the API (blueprint §11.4).
 *
 * Precedence follows the blueprint's scope ladder: platform > organization >
 * team > self. A user who holds several roles lands on the widest workspace
 * they own, because that is the one that contains the others' work as a subset.
 */

// Highest-precedence role first. The first match wins.
const LANDING_BY_ROLE = [
  ['owner', '/dashboards/organization'],
  ['org_admin', '/dashboards/organization'],
  ['bcba', '/dashboards/bcba'],
  ['rbt', '/dashboards/rbt'],
];

/**
 * Pure landing decision, extracted so it is unit-tested without rendering.
 * Given a principal's roles and permissions, returns the path their session
 * should open on. Never returns null — a signed-in user always has a home.
 */
export function landingPathFor({ roles = [], permissions = [] } = {}) {
  const byRole = LANDING_BY_ROLE.find(([role]) => roles.includes(role))?.[1];
  if (byRole) return byRole;

  // A user with none of the four primary roles (a billing or scheduling
  // specialist) still gets a coherent home: the first section their
  // permissions actually open, never a wall.
  if (permissions.includes('clients.read')) return '/clients';
  if (permissions.includes('scheduling.read')) return '/scheduling';
  if (permissions.includes('billing.read')) return '/insurance-billing';

  // Reached only by a session with no readable module — rare, and better than
  // a redirect loop.
  return '/account';
}

export function RoleLanding() {
  const principal = useAuthStore((state) => state.principal);
  return <Navigate to={landingPathFor(principal ?? {})} replace />;
}
