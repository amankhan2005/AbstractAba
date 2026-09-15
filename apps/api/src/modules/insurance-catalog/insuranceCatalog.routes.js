import { Router } from 'express';
import express from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePlatformOperator } from '../../middleware/requirePlatformOperator.js';
import { InsuranceCatalogController } from './insuranceCatalog.controller.js';
import {
  createCatalogSchema,
  updateCatalogSchema,
  catalogIdParamsSchema,
  catalogLogoUploadSchema,
  listCatalogQuerySchema,
} from './insuranceCatalog.schemas.js';

/**
 * Two routers over one catalog (spec Module 5):
 *   - platform: Super Admin CRUD, guarded by requirePlatformOperator.
 *   - tenant: a company reads ONLY the active entries for its own service
 *     states; company identity is taken from the authenticated tenant context,
 *     never the request body. Companies cannot write the catalog.
 */
export function createInsuranceCatalogRouters(service) {
  const controller = new InsuranceCatalogController(service);

  const platform = Router();
  platform.use(authenticate, requirePlatformOperator);
  platform.get('/', validate(listCatalogQuerySchema, 'query'), asyncHandler(controller.list));
  platform.post('/', validate(createCatalogSchema, 'body'), asyncHandler(controller.create));
  platform.get('/:id', validate(catalogIdParamsSchema, 'params'), asyncHandler(controller.get));
  platform.patch('/:id', validate(catalogIdParamsSchema, 'params'), validate(updateCatalogSchema, 'body'), asyncHandler(controller.update));
  platform.post(
    '/:id/logo',
    validate(catalogIdParamsSchema, 'params'),
    express.json({ limit: '8mb' }),
    validate(catalogLogoUploadSchema, 'body'),
    asyncHandler(controller.uploadLogo),
  );
  platform.delete('/:id', validate(catalogIdParamsSchema, 'params'), asyncHandler(controller.remove));

  const tenant = Router();
  tenant.use(authenticate, enterTenantContext);
  tenant.get('/', asyncHandler(controller.listForCompany));

  return { platform, tenant };
}
