import { Navigate, createBrowserRouter } from 'react-router-dom';
import { RoleShell } from '@/shells/RoleShell.jsx';
import { LoginPageNew } from '@/features/auth/redesign/LoginPageNew.jsx';
import { StaffActivationPage } from '@/features/auth/StaffActivationPage.jsx';
import { ForgotPasswordPage, ResetPasswordPage } from '@/features/auth/PasswordResetPages.jsx';
import { CompanyDashboardPage } from '@/features/dashboards/redesign/CompanyDashboardPage.jsx';
import { BcbaDashboardPage } from '@/features/dashboards/redesign/BcbaDashboardPage.jsx';
import { RbtDashboardPage } from '@/features/dashboards/redesign/RbtDashboardPage.jsx';
import { EmailTemplatesPage } from '@/features/email-templates/EmailTemplatesPage.jsx';
import { ClientsIndexRoute } from '@/features/clients/redesign/ClinicianCaseloadPage.jsx';
import { ClientDetailRedesign } from '@/features/clients/redesign/ClientDetailRedesign.jsx';
import { RoleAwareChildDetail } from '@/features/clients/redesign/RoleAwareChildDetail.jsx';
import { CompanyChildEditGuard } from '@/features/clients/redesign/CompanyChildEditGuard.jsx';
import { StaffListRedesign } from '@/features/staff/redesign/StaffListRedesign.jsx';
import { AddStaffForm } from '@/features/staff/redesign/AddStaffForm.jsx';
import { SchedulingRedesign } from '@/features/scheduling/redesign/SchedulingRedesign.jsx';
import { PayrollRedesign } from '@/features/payroll/redesign/PayrollRedesign.jsx';
import { SessionsIndexRoute } from '@/features/sessions/redesign/SessionsIndexRoute.jsx';
import { AdminSessionOversightPage } from '@/features/sessions/AdminSessionOversightPage.jsx';
import { BcbaSessionPanelPage } from '@/features/sessions/BcbaSessionPanelPage.jsx';
import { SessionDetailRedesign } from '@/features/sessions/redesign/SessionDetailRedesign.jsx';
import { SettingsRedesign } from '@/features/settings/redesign/SettingsRedesign.jsx';
import { CompanyProfileRedesign } from '@/features/settings/redesign/CompanyProfileRedesign.jsx';
import { AccountSecurityPage } from '@/features/settings/AccountSecurityPage.jsx';
import { ProfilePage } from '@/features/settings/ProfilePage.jsx';
import { GuardianPublicRedesign } from '@/features/guardian/redesign/GuardianPublicRedesign.jsx';
import { SearchRedesign } from '@/features/search/redesign/SearchRedesign.jsx';
import { DocumentsRedesign } from '@/features/documents/redesign/DocumentsRedesign.jsx';
import { SessionCreateRedesign } from '@/features/sessions/redesign/SessionCreateRedesign.jsx';
import { ManualSessionPage } from '@/features/sessions/ManualSessionPage.jsx';
import { PlanEditorRedesign } from '@/features/plans/redesign/PlanEditorRedesign.jsx';
import { DocumentEditorRedesign } from '@/features/documents/redesign/DocumentEditorRedesign.jsx';
import { EraRedesign } from '@/features/claims/redesign/EraRedesign.jsx';
import { ClaimsRedesign } from '@/features/claims/redesign/ClaimsRedesign.jsx';
import { ReconciliationRedesign } from '@/features/reports/redesign/ReconciliationRedesign.jsx';
import { HomePage } from '@/features/home/HomePage';
import { RoleLanding } from '@/features/home/RoleLanding';
import { DesignSystemPage } from '@/features/design/DesignSystemPage';
import { ClientsListPage } from '@/features/clients/ClientsListPage';
import { ClientFormPage } from '@/features/clients/ClientFormPage';
import { ClientDetailPage } from '@/features/clients/ClientDetailPage';
import { StaffProfileRedesign, StaffEditRedirect } from '@/features/staff/redesign/StaffProfileRedesign.jsx';
import { SchedulingCalendarPage } from '@/features/scheduling/SchedulingCalendarPage';
import { SearchPage } from '@/features/search/SearchPage';
import { DataToolsPage } from '@/features/data/DataToolsPage';
import { AppointmentsListPage } from '@/features/scheduling/AppointmentsListPage';
import { AppointmentFormPage } from '@/features/scheduling/AppointmentFormPage';
import { AppointmentDetailPage } from '@/features/scheduling/AppointmentDetailPage';
import { AvailabilityPage } from '@/features/scheduling/AvailabilityPage';
import { RecurringSeriesPage } from '@/features/scheduling/RecurringSeriesPage';
import { PlansListPage } from '@/features/plans/PlansListPage';
import { PlanFormPage } from '@/features/plans/PlanFormPage';
import { PlanDetailPage } from '@/features/plans/PlanDetailPage';
import { SessionsListPage } from '@/features/sessions/SessionsListPage';
import { SessionFormPage } from '@/features/sessions/SessionFormPage';
import { SessionDetailPage } from '@/features/sessions/SessionDetailPage';
import { DocumentsListPage } from '@/features/documents/DocumentsListPage';
import { DocumentFormPage } from '@/features/documents/DocumentFormPage';
import { DocumentDetailPage } from '@/features/documents/DocumentDetailPage';
import { SupervisionPage } from '@/features/supervision/SupervisionPage';
import { DashboardHomePage } from '@/features/dashboards/DashboardHomePage';
import { RequireAuth } from './RequireAuth';
import { CompanyOnboardingPage } from '@/features/onboarding/CompanyOnboardingPage';
import { SubscriptionPage } from '@/features/billing/SubscriptionPage';
import { EraPage } from '@/features/claims/EraPage';
import { ReportsPage } from '@/features/reports/ReportsPage';
import { ReconciliationPage } from '@/features/reports/ReconciliationPage';
import { GuardianInvitationPage } from '@/features/guardian/GuardianInvitationPage';
import { BrandingPage } from '@/features/settings/BrandingPage';

/**
 * The tenant application route tree. /login is public; everything under the
 * shell is gated by RequireAuth. Business routes (clients, scheduling, …) are
 * added as children here as their modules land.
 */
// Company creation is invitation-only: there is deliberately no public
// self-signup route. /onboarding/:token (invitation-gated) is the only way
// a new company gets created from the web app.
export const router = createBrowserRouter([
  { path: '/login', element: <LoginPageNew /> },
  { path: '/onboarding/:token', element: <CompanyOnboardingPage /> },
  { path: '/invitations/:token', element: <StaffActivationPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password/:token', element: <ResetPasswordPage /> },
  // The anonymous guardian surface. Deliberately OUTSIDE RequireAuth and
  // outside the workspace shell: a family arriving here has no account (blueprint 2.6
  // excludes a family portal) and must never be shown navigation into one.
  { path: '/guardian/:token', element: <GuardianPublicRedesign /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <RoleShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <RoleLanding /> },
      { path: 'account', element: <AccountSecurityPage /> },
      { path: 'profile', element: <ProfilePage /> },
      { path: 'search', element: <SearchRedesign /> },
      { path: 'data-tools', element: <DataToolsPage /> },
      { path: 'settings/company', element: <CompanyProfileRedesign /> },
      { path: 'settings/email-templates', element: <EmailTemplatesPage /> },
      { path: 'settings/branding', element: <SettingsRedesign /> },
      // Company Admin → organization Clients page; BCBA / RBT → their caseload.
      { path: 'clients', element: <ClientsIndexRoute /> },
      { path: 'clients/new', element: <ClientFormPage /> },
      { path: 'clients/:clientId', element: <RoleAwareChildDetail /> },
      { path: 'clients/:clientId/edit', element: <CompanyChildEditGuard /> },
      { path: 'staff', element: <StaffListRedesign /> },
      { path: 'staff/new', element: <AddStaffForm /> },
      { path: 'staff/:staffId', element: <StaffProfileRedesign /> },
      // Legacy edit URL: opens the editor on the profile (no second edit form).
      { path: 'staff/:staffId/edit', element: <StaffEditRedirect /> },
      { path: 'scheduling', element: <SchedulingRedesign /> },
      { path: 'scheduling/appointments', element: <AppointmentsListPage /> },
      // Legacy standalone create form retired: booking now happens through the
      // canonical "New appointment" modal on /scheduling (separate optional
      // BCBA/RBT, multi-authorization, no forced session timing). The old form
      // posted a single-staffProfileId shape the strict booking schema rejects,
      // so /new redirects to the one canonical creation surface. Reschedule
      // (/edit) still uses AppointmentFormPage.
      { path: 'scheduling/appointments/new', element: <Navigate to="/scheduling" replace /> },
      { path: 'scheduling/appointments/:appointmentId', element: <AppointmentDetailPage /> },
      { path: 'scheduling/appointments/:appointmentId/edit', element: <AppointmentFormPage /> },
      { path: 'scheduling/availability', element: <AvailabilityPage /> },
      { path: 'scheduling/recurring', element: <RecurringSeriesPage /> },
      { path: 'plans', element: <PlansListPage /> },
      { path: 'plans/new', element: <PlanEditorRedesign /> },
      { path: 'plans/:planId', element: <PlanDetailPage /> },
      { path: 'plans/:planId/edit', element: <PlanEditorRedesign /> },
      { path: 'sessions', element: <SessionsIndexRoute /> },
      { path: 'sessions/oversight', element: <AdminSessionOversightPage /> },
      { path: 'sessions/panel', element: <BcbaSessionPanelPage /> },
      { path: 'sessions/new', element: <SessionCreateRedesign /> },
      // Manual Session — BCBA and RBT (sidebar "Manual Session" in both
      // clinician rails). The page redirects anyone without a BCBA/RBT role;
      // the server independently derives the clinician from the token.
      { path: 'sessions/manual', element: <ManualSessionPage /> },
      { path: 'sessions/:sessionId', element: <SessionDetailRedesign /> },
      { path: 'documents', element: <DocumentsRedesign /> },
      { path: 'documents/new', element: <DocumentEditorRedesign /> },
      { path: 'documents/:documentId', element: <DocumentDetailPage /> },
      { path: 'documents/:documentId/edit', element: <DocumentEditorRedesign /> },
      { path: 'supervision', element: <SupervisionPage /> },
      { path: 'dashboards', element: <DashboardHomePage /> },
      { path: 'dashboards/organization', element: <CompanyDashboardPage /> },
      { path: 'dashboards/admin', element: <CompanyDashboardPage /> },
      { path: 'dashboards/bcba', element: <BcbaDashboardPage /> },
      { path: 'dashboards/rbt', element: <RbtDashboardPage /> },
      { path: 'billing', element: <Navigate to="/insurance-billing" replace /> },
      { path: 'subscription', element: <SubscriptionPage /> },
      // The Timesheets page was removed. Old links and bookmarks land on Payroll,
      // which is computed from SessionTimeRecord worked minutes; the timesheet
      // and time-entry backend stays intact.
      { path: 'payroll/timesheets', element: <Navigate to="/payroll" replace /> },
      { path: 'payroll/timesheets/*', element: <Navigate to="/payroll" replace /> },
      { path: 'payroll', element: <PayrollRedesign /> },
      // Claim page removed from the user-facing app. Old links redirect to the
      // existing Billing page rather than 404/blank; the claims backend/API is
      // intact for other revenue-cycle workflows.
      // Insurance / payer billing (claims) is its OWN Company-Admin route,
      // distinct from /billing which stays the company's SaaS invoices/balance.
      // Reuses the existing ClaimsRedesign workflow (preview/generate) — no
      // duplicate billing/claims system. /claims is kept as a back-compat
      // redirect to the canonical insurance-billing route.
      { path: 'insurance-billing', element: <ClaimsRedesign /> },
      { path: 'claims', element: <Navigate to="/insurance-billing" replace /> },
      { path: 'claims/:claimId', element: <Navigate to="/insurance-billing" replace /> },
      { path: 'era', element: <EraRedesign /> },
      { path: 'reports', element: <Navigate to="/" replace /> },
      { path: 'reconciliation', element: <ReconciliationRedesign /> },
      { path: 'design', element: <DesignSystemPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
