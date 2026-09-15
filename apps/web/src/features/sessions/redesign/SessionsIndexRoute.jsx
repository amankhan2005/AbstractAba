import { useAuthStore } from '@/auth/store';
import { shellForRoles } from '@/shells/RoleShell.jsx';
import { CompanySessionsPage } from './CompanySessionsPage.jsx';
import { SessionsListRedesign } from './SessionsListRedesign.jsx';

/**
 * /sessions — the Company experience (Owner / Company Admin) gets the
 * organization-wide Sessions page; BCBA and RBT keep their own Review queue /
 * Sessions page unchanged. Uses the same role → shell rule as RoleShell, so the
 * page always matches the navigation the user is in. Data scope is still decided
 * by the server for every request.
 */
export function SessionsIndexRoute() {
  const roles = useAuthStore((s) => s.principal?.roles) ?? [];
  return shellForRoles(roles) === 'company' ? <CompanySessionsPage /> : <SessionsListRedesign />;
}

export default SessionsIndexRoute;
