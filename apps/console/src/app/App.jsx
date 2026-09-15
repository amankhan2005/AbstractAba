import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Navigate,
  RouterProvider,
  createBrowserRouter,
  isRouteErrorResponse,
  useNavigate,
  useParams,
  useRouteError,
} from 'react-router-dom';
import { useAuthStore } from '@/auth/store';
import { ConsoleShellRx, ToastProvider, Icon } from '@/components';
import { LoginPage } from '@/features/auth/LoginPage';
import { ForgotPasswordPage, ResetPasswordPage } from '@/features/auth/PasswordResetPages';
import { DashboardRx } from '@/features/dashboard/DashboardRx';
import { CompaniesRx } from '@/features/companies/CompaniesRx';
import { InvitationsRx } from '@/features/companies/InvitationsRx';
import { HealthRx } from '@/features/health/HealthRx';
import { CompanyDetailRx } from '@/features/companies/CompanyDetailRx';
import { BillingRx } from '@/features/billing/BillingRx';
import { InsuranceCatalogRx } from '@/features/insurance/InsuranceCatalogRx';
import { InquiriesRx } from '@/features/inquiries/InquiriesRx';
import { AuditRx } from '@/features/tenants/AuditRx';
import { AccountRx } from '@/features/account/AccountRx';
import { RequireOperator } from './RequireOperator';

/** Redirect legacy /tenants/:id → /companies/:id, preserving the id. */
function TenantRedirect() {
  const { id } = useParams();
  return <Navigate to={`/companies/${id}`} replace />;
}
/** Redirect legacy /tenants/:id/audit → /companies/:id/audit. */
function TenantAuditRedirect() {
  const { id } = useParams();
  return <Navigate to={`/companies/${id}/audit`} replace />;
}

/**
 * Graceful fallback for any error thrown while rendering a route — a render
 * crash, a loader/action rejection, or a 404. Without this, React Router shows
 * its raw developer error screen (a blank page with a stack trace) in
 * production. This keeps the operator in a recoverable state.
 */
function RouteError() {
  const error = useRouteError();
  const navigate = useNavigate();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const title = notFound ? 'Page not found' : 'Something went wrong';
  const detail = notFound
    ? 'The page you were looking for doesn’t exist or has moved.'
    : 'This page couldn’t be displayed. Go back and try again, or return to the dashboard.';
  return (
    <div className="rxc-auth__main" style={{ minHeight: '100vh' }}>
      <div className="rxc-card" role="alert" style={{ maxWidth: 480, width: '100%', textAlign: 'center', padding: 32 }}>
        <span className="rxc-state__icon rxc-tone--red" style={{ margin: '0 auto 14px' }}><Icon name="alertCircle" size={22} /></span>
        <h1 className="rxc-page-title" style={{ fontSize: '1.25rem' }}>{title}</h1>
        <p className="rxc-page-desc" style={{ margin: '8px auto 20px' }}>{detail}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="rxc-btn rxc-btn--secondary" onClick={() => navigate(-1)}>
            <Icon name="arrowLeft" size={16} /><span>Go back</span>
          </button>
          <a className="rxc-btn rxc-btn--primary" href="/">Back to dashboard</a>
        </div>
      </div>
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Client errors (401/403/404/409/422) will not succeed on retry, so retrying
      // them only produces duplicate requests. Retry once for network/5xx only.
      retry: (failureCount, error) => {
        const status = error?.response?.status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
    mutations: { retry: false },
  },
});

// The Console surfaces exactly the Platform Console modules the Blueprint defines
// (§5.3, §6.15): platform health, tenant lifecycle & onboarding, agreements, and
// the platform Revenue & Subscriptions view. Tenant Payroll / Claims / ERA /
// Reconciliation / Financial Reports are Company-Panel modules and are NOT routed
// here. "Companies" is the single tenant-directory surface; the legacy /tenants
// paths redirect to it so existing links keep working.
const router = createBrowserRouter([
  { path: '/login', element: <LoginPage />, errorElement: <RouteError /> },
  { path: '/forgot-password', element: <ForgotPasswordPage />, errorElement: <RouteError /> },
  { path: '/reset-password/:token', element: <ResetPasswordPage />, errorElement: <RouteError /> },
  {
    path: '/',
    element: (
      <RequireOperator>
        <ConsoleShellRx />
      </RequireOperator>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, element: <DashboardRx /> },
      { path: 'health', element: <HealthRx /> },
      { path: 'companies', element: <CompaniesRx /> },
      { path: 'companies/invitations', element: <InvitationsRx /> },
      { path: 'companies/:id', element: <CompanyDetailRx /> },
      { path: 'companies/:id/audit', element: <AuditRx /> },
      { path: 'billing', element: <BillingRx /> },
      { path: 'insurance', element: <InsuranceCatalogRx /> },
      { path: 'inquiries', element: <InquiriesRx /> },
      { path: 'account', element: <AccountRx /> },
      // Legacy tenant routes → the unified Companies surface.
      { path: 'tenants', element: <Navigate to="/companies" replace /> },
      { path: 'tenants/:id', element: <TenantRedirect /> },
      { path: 'tenants/:id/audit', element: <TenantAuditRedirect /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

/**
 * Application root. Attempts a silent session restore once on mount, then serves
 * the router.
 */
export function App() {
  const bootstrap = useAuthStore((state) => state.bootstrap);
  useEffect(() => { void bootstrap(); }, [bootstrap]);
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  );
}
