import { Navigate } from 'react-router-dom';
import { useAuthStore } from '@/auth/store';
import { LoadingState } from '@/components';

/**
 * Gates every console route on an authenticated platform operator. While the
 * session restores it shows a loading state; once resolved it renders the
 * protected content or redirects to sign-in. Ported verbatim.
 */
export function RequireOperator({ children }) {
  const status = useAuthStore((state) => state.status);
  if (status === 'unknown' || status === 'authenticating') {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><LoadingState label="Restoring your session…" /></div>;
  }
  if (status !== 'authenticated') return <Navigate to="/login" replace />;
  return children;
}
