import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePlatformOperator } from '../../middleware/requirePlatformOperator.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { enterTenantContext, enterPlatformContext } from '../../middleware/tenantContext.js';
import { OrganizationController } from './organization.controller.js';
import {
  brandingQuerySchema,
  createOrganizationSchema,
  listOrganizationsQuerySchema,
  organizationIdParamsSchema,
  switchOrganizationSchema,
  transitionSchema,
  updateProfileSchema,
} from './organization.schemas.js';

/**
 * Organization routers, ported from the original. Three trust levels kept
 * visibly separate so a route cannot be added to the wrong one by accident:
 *
 *   /platform/organizations  platform operators only, no tenant context
 *   /organization            the caller's own clinic, tenant context required
 *   /me                      the caller's memberships (spans organizations)
 *   /public                  unauthenticated, branding only
 */
export function createOrganizationRouters(service) {
  const controller = new OrganizationController(service);

  // --- platform console -----------------------------------------------------
  const platform = Router();
  platform.use(authenticate, requirePlatformOperator, enterPlatformContext);
  platform.post('/', validate(createOrganizationSchema, 'body'), asyncHandler(controller.create));
  platform.get('/', validate(listOrganizationsQuerySchema, 'query'), asyncHandler(controller.list));
  platform.get('/:id', validate(organizationIdParamsSchema, 'params'), asyncHandler(controller.getById));
  platform.post(
    '/:id/transitions',
    validate(organizationIdParamsSchema, 'params'),
    validate(transitionSchema, 'body'),
    asyncHandler(controller.transition),
  );

  // --- tenant application ---------------------------------------------------
  const tenant = Router();
  tenant.use(authenticate, enterTenantContext);
  tenant.get('/', asyncHandler(controller.getProfile));
  // Company Profile writes (including the organization timezone, the business
  // timezone every module reads) are limited to organization.update — Owner and
  // Company Admin. Reading the profile stays open to any tenant member.
  tenant.patch('/', requirePermission('organization.update'), validate(updateProfileSchema, 'body'), asyncHandler(controller.updateProfile));
  tenant.get('/usage', asyncHandler(controller.usage));

  // --- the caller's own memberships ----------------------------------------
  const me = Router();
  me.use(authenticate);
  me.get('/memberships', asyncHandler(controller.listMemberships));
  me.post(
    '/active-organization',
    validate(switchOrganizationSchema, 'body'),
    asyncHandler(controller.switchOrganization),
  );

  // --- public ---------------------------------------------------------------
  const publicRouter = Router();
  publicRouter.get('/branding', validate(brandingQuerySchema, 'query'), asyncHandler(controller.branding));

  return { platform, tenant, me, public: publicRouter };
}
