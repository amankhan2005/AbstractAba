import { Router } from 'express';
import { authRouter } from '../modules/auth/auth.routes.js';
import { healthRouter } from '../modules/health/health.routes.js';
import { consoleRouter } from '../modules/platform-console/console.routes.js';
import { organizationRouters } from '../modules/organization/index.js';
import { rbacRouters } from '../modules/rbac/rbac.routes.js';
import { usersRouters } from '../modules/users/index.js';
import { onboardingRouter } from '../modules/onboarding/index.js';
import { settingsRouter } from '../modules/settings/index.js';
import { themingRouters } from '../modules/theming/index.js';
import { notificationRouter } from '../modules/notifications/index.js';
import { clientsRouter, emailTemplatesRouter } from '../modules/clients/index.js';
import { insuranceCatalogRouters } from '../modules/insurance-catalog/index.js';
import { staffRouter } from '../modules/staff/index.js';
import { schedulingRouter } from '../modules/scheduling/index.js';
import { searchRouter } from '../modules/search/index.js';
import { bulkRouter } from '../modules/bulk/index.js';
import { plansRouter } from '../modules/plans/index.js';
import { sessionsRouter } from '../modules/sessions/index.js';
import { bcbaSessionRouter, rbtSessionRouter } from '../modules/bcba-session/index.js';
import { documentsRouter } from '../modules/documents/index.js';
import { supervisionRouter } from '../modules/supervision/index.js';
import { dashboardsRouter } from '../modules/dashboards/index.js';
import { companyInvitationRouters } from '../modules/company-invitations/index.js';
import { billingRouters } from '../modules/billing/index.js';
import { payrollRouter } from '../modules/payroll/index.js';
import { claimsRouter } from '../modules/claims/index.js';
import { eraRouter } from '../modules/era/index.js';
import { reconciliationRouter } from '../modules/reconciliation/index.js';
import { reportsRouter } from '../modules/reports/index.js';
import { createGuardianPublicRouter } from '../modules/clients/guardian-public.routes.js';
import { inquiryRouters } from '../modules/inquiries/index.js';

/**
 * API v1 route tree. Foundation modules plus the organization module.
 * Remaining business-module routers (users, onboarding, theming, settings,
 * notifications) mount here as they are ported — see PORTING_STATUS.md.
 */
export const apiRouter = Router();

apiRouter.use('/', healthRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/public', organizationRouters.public);
// Public self-serve signup (/public/signup) is DEACTIVATED: company creation is
// invitation-only (Super Admin → Add Company → invitation → onboarding). The
// self-serve module itself (modules/self-serve/*) is left in place — it is a
// real future milestone per the blueprint (self-serve onboarding with an
// agreement gate) — but it is no longer mounted, so no request can reach it.
// Rather than a bare 404 (which looks like a missing route), /signup replies
// with a clear, intentional message so a legacy or curious client understands
// why. It can never create an organization.
apiRouter.post('/public/signup', (req, res) => {
  res.status(410).json({
    error: {
      code: 'SIGNUP-410',
      message: 'Company registration is invitation-only. Ask your platform administrator to send you an invitation.',
    },
  });
});
apiRouter.use('/public/company-invitations', companyInvitationRouters.public);
// Anonymous guardian surface: a family opens a one-time link to supply their
// own contact details. No account, no portal (blueprint 2.6 excludes a family
// portal); the token names the tenant and the service enters that context.
apiRouter.use('/public/guardian', createGuardianPublicRouter());
// Public website "Contact Us" inquiries: anonymous submit; platform operators review them.
apiRouter.use('/public/inquiries', inquiryRouters.public);

// Organization module. The platform router is mounted before the console router
// so /platform/organizations resolves to it; the console keeps /platform/health
// and /platform/tenants/:id/audit and reuses these org endpoints (as the original did).
apiRouter.use('/platform/organizations', organizationRouters.platform);
apiRouter.use('/platform/organizations', usersRouters.platform);
apiRouter.use('/platform/organizations', onboardingRouter);
apiRouter.use('/platform/company-invitations', companyInvitationRouters.platform);
apiRouter.use('/platform/inquiries', inquiryRouters.platform);
// Platform Console financial surface is strictly Revenue & Subscriptions
// (Blueprint §5.3 "Metering & revenue", §6.15). Tenant Payroll, Claims/ERA,
// Reconciliation and Financial Reports live ONLY in the Company Panel — their
// out-of-panel /platform/*/overview aggregates were removed to hold the boundary
// the spec draws (§5.4: the Console never reaches tenant financial rows).
apiRouter.use('/platform/billing', billingRouters.platform);
apiRouter.use('/billing', billingRouters.tenant);
apiRouter.use('/payroll', payrollRouter);
apiRouter.use('/claims', claimsRouter);
apiRouter.use('/era', eraRouter);
apiRouter.use('/reconciliation', reconciliationRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/platform', consoleRouter);
apiRouter.use('/organization/settings', settingsRouter);
apiRouter.use('/organization/branding', themingRouters.branding);
apiRouter.use('/organization', organizationRouters.tenant);
apiRouter.use('/me', organizationRouters.me);

// RBAC read surface. /me and /roles chain after the organization routers on the
// same mount paths (Express composes multiple routers per mount).
apiRouter.use('/permissions', rbacRouters.catalogue);
apiRouter.use('/me', rbacRouters.me);
apiRouter.use('/roles', rbacRouters.roles);

// Clinical spine · Clients (Phase 2).
apiRouter.use('/clients', clientsRouter);
apiRouter.use('/email-templates', emailTemplatesRouter);
// Insurance master catalog (spec Module 5): Super Admin CRUD on the platform
// side; company reads its state-filtered slice on the tenant side.
apiRouter.use('/platform/insurance-catalog', insuranceCatalogRouters.platform);
apiRouter.use('/insurance-catalog', insuranceCatalogRouters.tenant);

// Clinical spine · Staff & credentials (Phase 2).
apiRouter.use('/staff', staffRouter);

// Clinical spine · Scheduling & calendar (Phase 2).
apiRouter.use('/scheduling', schedulingRouter);
apiRouter.use('/search', searchRouter);
apiRouter.use('/bulk', bulkRouter);

// Clinical spine · Plans, goals, programs & targets (Phase 2).
apiRouter.use('/plans', plansRouter);

// Clinical spine · Session capture & freeze (Phase 2).
apiRouter.use('/sessions', sessionsRouter);

// BCBA session workflow — the connected appointment → start → timer → child
// plan → stop → ABA/FBA selection → memo → payroll pipeline (BCBA panel spec).
// Distinct mount from /sessions: it orchestrates existing modules rather than
// replacing the session-capture surface.
apiRouter.use('/bcba', bcbaSessionRouter);
// RBT technician panel — same session pipeline, RBT assignment axis (rbtId).
apiRouter.use('/rbt', rbtSessionRouter);

// Clinical spine · Clinical documents (Phase 2).
apiRouter.use('/documents', documentsRouter);
apiRouter.use('/supervision', supervisionRouter);

// Clinical spine · Role dashboards (Phase 2) — read-only aggregation.
apiRouter.use('/dashboards', dashboardsRouter);

// Users & role management.
apiRouter.use('/users', usersRouters.users);
apiRouter.use('/roles', usersRouters.roles);
apiRouter.use('/invitations', usersRouters.public);

// Theming: per-user preferences + resolved theme.
apiRouter.use('/me', themingRouters.me);
apiRouter.use('/me', notificationRouter);
