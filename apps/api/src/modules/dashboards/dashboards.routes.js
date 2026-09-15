import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { DashboardsController } from './dashboards.controller.js';
import { dashboardQuerySchema } from './dashboards.schemas.js';

/**
 * Role-dashboard router. Every route is authenticated, bound to the tenant
 * context, guarded by dashboards.read, and is a read-only GET. Because these are
 * reads, none of them is entered in the audit catalogue — dashboard reads create
 * no audit records (Level A records writes only).
 */
export function createDashboardsRouter(service) {
  const controller = new DashboardsController(service);
  const router = Router();
  router.use(authenticate, enterTenantContext);

  router.get('/company', requirePermission('dashboards.read'), asyncHandler(controller.company));
  router.get('/organization', requirePermission('dashboards.read'), asyncHandler(controller.organization));
  router.get('/admin', requirePermission('dashboards.read'), asyncHandler(controller.admin));
  router.get('/bcba', requirePermission('dashboards.read'), validate(dashboardQuerySchema, 'query'), asyncHandler(controller.bcba));
  router.get('/rbt', requirePermission('dashboards.read'), validate(dashboardQuerySchema, 'query'), asyncHandler(controller.rbt));

  return router;
}
