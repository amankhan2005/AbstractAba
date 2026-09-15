import { Navigate, useParams } from 'react-router-dom';
import { useAuthStore } from '@/auth/store';
import { shellForRoles } from '@/shells/RoleShell.jsx';
import { ClientFormPage } from '@/features/clients/ClientFormPage';

/**
 * GAP 2 — the Company child editor is Company/Admin-only. A BCBA/RBT typing
 * /clients/:id/edit directly is redirected to their own child view rather than
 * shown the editor. This is defence-in-depth on top of the backend, which
 * independently rejects the underlying PATCH /clients/:id (a BCBA/RBT no longer
 * holds clients.update) — the URL guard just avoids showing a form that would
 * 403 on save.
 */
export function CompanyChildEditGuard() {
  const roles = useAuthStore((s) => s.principal?.roles) ?? [];
  const { clientId } = useParams();
  if (shellForRoles(roles) !== 'company') {
    return <Navigate to={`/clients/${clientId}`} replace />;
  }
  return <ClientFormPage />;
}

export default CompanyChildEditGuard;
