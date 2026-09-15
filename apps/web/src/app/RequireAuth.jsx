import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/auth/store';
import { LoadingState } from '@/components';
import { CompanyUnavailablePage } from '@/features/company/CompanyUnavailablePage';

/**
 * Gates every tenant route on an authenticated organization member. While the
 * session restores it shows a loading state; once resolved it renders the
 * protected content, the friendly "company unavailable" screen when the user's
 * company has been deactivated, or redirects to sign-in. Mirror of the console's
 * RequireOperator, adapted to the tenant access rule.
 *
 * First-login gate: a staff member provisioned with a temporary password carries
 * mustChangePassword until they change it. Until then they are redirected to the
 * account security (change-password) page — they cannot reach the rest of the
 * panel with a temporary credential.
 */
export function RequireAuth({ children }) {
  const status = useAuthStore((state) => state.status);
  const principal = useAuthStore((state) => state.principal);
  const location = useLocation();
  if (status === 'unknown' || status === 'authenticating') return <LoadingState label="Restoring session…" />;
  if (status === 'company-unavailable') return <CompanyUnavailablePage />;
  if (status !== 'authenticated') return <Navigate to="/login" replace />;
  const mustChange = principal?.mustChangePassword === true || principal?.user?.mustChangePassword === true;
  if (mustChange && location.pathname !== '/account') {
    return <Navigate to="/account" replace state={{ forcedPasswordChange: true }} />;
  }
  return children;
}
