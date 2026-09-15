import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { sendSuccess, sendCreated, sendNoContent } from '../../common/http/responder.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePlatformOperator } from '../../middleware/requirePlatformOperator.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { AppError } from '../../common/errors/AppError.js';
import * as S from './billing.schemas.js';

/**
 * Two route groups over one service:
 *  - platform (operator): full billing administration across all companies.
 *  - tenant (company): read-only access to *its own* billing, scoped by the
 *    caller's activeTenantId so one company can never read another's.
 */
export function createBillingRouters(service) {
  const platform = Router();
  platform.use(authenticate, requirePlatformOperator);

  // plans
  platform.post('/plans', validate(S.createPlanSchema), asyncHandler(async (req, res) => {
    sendCreated(res, await service.createPlan(req.body, req.principal.userId));
  }));
  platform.get('/plans', asyncHandler(async (req, res) => {
    sendSuccess(res, await service.listPlans({ activeOnly: req.query.active === 'true' }));
  }));
  platform.patch('/plans/:id', validate(S.updatePlanSchema), asyncHandler(async (req, res) => {
    sendSuccess(res, await service.updatePlan(req.params.id, req.body, req.principal.userId));
  }));

  // subscriptions
  platform.post('/subscriptions', validate(S.assignSubscriptionSchema), asyncHandler(async (req, res) => {
    sendCreated(res, await service.assignSubscription(req.body, req.principal.userId));
  }));
  // Change the assigned package (spec §13): supersedes the current one, keeps history.
  platform.post('/subscriptions/change', validate(S.changePackageSchema), asyncHandler(async (req, res) => {
    sendCreated(res, await service.changeSubscriptionPackage(req.body, req.principal.userId));
  }));
  platform.get('/subscriptions/:organizationId', asyncHandler(async (req, res) => {
    sendSuccess(res, await service.getCurrentSubscription(req.params.organizationId));
  }));
  // Extend / update validity (spec §12/§14).
  platform.post('/subscriptions/:id/extend', validate(S.extendSubscriptionSchema), asyncHandler(async (req, res) => {
    sendSuccess(res, await service.extendSubscription(req.params.id, req.body, req.principal.userId));
  }));
  platform.patch('/subscriptions/:id/validity', validate(S.updateValiditySchema), asyncHandler(async (req, res) => {
    sendSuccess(res, await service.updateSubscriptionValidity(req.params.id, req.body, req.principal.userId));
  }));
  platform.post('/subscriptions/:id/transitions', validate(S.transitionSubscriptionSchema), asyncHandler(async (req, res) => {
    sendSuccess(res, await service.transitionSubscription(req.params.id, req.body.target, req.principal.userId, req.body));
  }));

  // invoices
  platform.post('/invoices', validate(S.generateInvoiceSchema), asyncHandler(async (req, res) => {
    sendCreated(res, await service.generateInvoice(req.body, req.principal.userId));
  }));
  platform.get('/invoices', asyncHandler(async (req, res) => {
    sendSuccess(res, await service.listInvoices({ organizationId: req.query.organizationId, status: req.query.status }));
  }));
  platform.get('/invoices/:id', asyncHandler(async (req, res) => {
    sendSuccess(res, await service.getInvoice(req.params.id));
  }));
  platform.post('/invoices/:id/void', asyncHandler(async (req, res) => {
    sendSuccess(res, await service.voidInvoice(req.params.id, req.principal.userId));
  }));

  // payments
  platform.post('/payments', validate(S.recordPaymentSchema), asyncHandler(async (req, res) => {
    sendCreated(res, await service.recordPayment(req.body, req.principal.userId));
  }));
  platform.get('/payments', asyncHandler(async (req, res) => {
    sendSuccess(res, await service.listPayments({ organizationId: req.query.organizationId, status: req.query.status }));
  }));
  platform.post('/payments/:id/refund', asyncHandler(async (req, res) => {
    sendSuccess(res, await service.refundPayment(req.params.id, req.principal.userId));
  }));

  // credits
  platform.post('/credits', validate(S.issueCreditSchema), asyncHandler(async (req, res) => {
    sendCreated(res, await service.issueCredit(req.body, req.principal.userId));
  }));
  platform.get('/credits', asyncHandler(async (req, res) => {
    sendSuccess(res, await service.listCredits({ organizationId: req.query.organizationId }));
  }));

  // overview
  platform.get('/overview', asyncHandler(async (_req, res) => {
    sendSuccess(res, await service.overview());
  }));

  // ---- tenant (company self-service, read-only), scoped to caller's org ----
  const tenant = Router();
  // The tenant sub-router carries a data scope; the platform sub-router above
  // deliberately does not (it runs under withPlatform for cross-tenant billing
  // operations and is guarded by requirePlatformOperator instead).
  tenant.use(authenticate, enterTenantContext);
  const orgId = (req) => {
    const id = req.principal?.activeTenantId;
    if (!id) throw AppError.forbidden('AUTH-403', 'No active tenant');
    return id;
  };
  tenant.get('/subscription', requirePermission('billing.read'), asyncHandler(async (req, res) => {
    sendSuccess(res, await service.getCurrentSubscription(orgId(req)));
  }));
  tenant.get('/invoices', requirePermission('billing.read'), asyncHandler(async (req, res) => {
    sendSuccess(res, await service.listInvoices({ organizationId: orgId(req) }));
  }));
  tenant.get('/invoices/:id', requirePermission('billing.read'), asyncHandler(async (req, res) => {
    sendSuccess(res, await service.getInvoice(req.params.id, { organizationId: orgId(req) }));
  }));
  tenant.get('/payments', requirePermission('billing.read'), asyncHandler(async (req, res) => {
    sendSuccess(res, await service.listPayments({ organizationId: orgId(req) }));
  }));
  tenant.get('/balance', requirePermission('billing.read'), asyncHandler(async (req, res) => {
    sendSuccess(res, await service.getBalance(orgId(req)));
  }));

  return { platform, tenant };
}
