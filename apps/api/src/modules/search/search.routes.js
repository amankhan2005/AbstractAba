import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { SearchController } from './search.controller.js';
import { globalSearchQuerySchema, entitySearchQuerySchema, entityTypeParamsSchema } from './search.schemas.js';

/**
 * Search router. Every route is authenticated and bound to the tenant context.
 * There is no single route-level permission: search is authorized PER ENTITY by
 * the caller's own read permissions (an entity the caller cannot read is never
 * queried), so a user with no read permissions gets empty results, never data
 * they shouldn't see. The tenant is taken from the principal, never the client.
 */
export function createSearchRouter(service) {
  const controller = new SearchController(service);
  const router = Router();
  router.use(authenticate, enterTenantContext);

  router.get('/', validate(globalSearchQuerySchema, 'query'), asyncHandler(controller.globalSearch));
  router.get('/:entityType', validate(entityTypeParamsSchema, 'params'), validate(entitySearchQuerySchema, 'query'), asyncHandler(controller.entitySearch));

  return router;
}
