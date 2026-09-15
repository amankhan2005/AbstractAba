import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { RbacController } from './rbac.controller.js';
import { authorizationService } from './authorization.service.js';
import { roleKeyParamsSchema } from './rbac.schemas.js';

/**
 * RBAC read routes, ported from the original:
 *   GET /permissions                    the catalogue (any authenticated caller)
 *   GET /me/permissions                 the caller's own effective permissions
 *   GET /roles/:roleKey/permissions     a role's template (guarded by roles.read)
 */
export function createRbacRouters(authorization = authorizationService) {
  const controller = new RbacController(authorization);

  const catalogue = Router();
  catalogue.use(authenticate);
  catalogue.get('/', asyncHandler(controller.catalogue));

  const me = Router();
  me.use(authenticate, enterTenantContext);
  me.get('/permissions', asyncHandler(controller.myPermissions));

  const roles = Router();
  roles.use(authenticate, enterTenantContext);
  roles.get(
    '/:roleKey/permissions',
    validate(roleKeyParamsSchema, 'params'),
    requirePermission('roles.read'),
    asyncHandler(controller.rolePermissions),
  );

  return { catalogue, me, roles };
}

export const rbacRouters = createRbacRouters();
