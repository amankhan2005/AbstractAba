import { Router } from 'express';
import express from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { AppError } from '../../common/errors/AppError.js';
import { BulkController } from './bulk.controller.js';
import { importUploadSchema, importEntityParamsSchema, exportIdParamsSchema } from './bulk.schemas.js';

/**
 * Bulk import/export router. Authenticated + tenant-bound. Import is authorized
 * per entity with the SAME permission the entity's create route uses (clients →
 * clients.create, staff → staff.manage); export uses organization.export. The
 * CSV upload route raises the JSON body limit locally (base64 of a 5 MiB file);
 * the global 1 MB limit is unchanged everywhere else.
 */
function requireImportPermission(req, res, next) {
  const perm = req.params.entity === 'staff' ? 'staff.manage' : 'clients.create';
  return requirePermission(perm)(req, res, next);
}

export function createBulkRouter(service) {
  const controller = new BulkController(service);
  const router = Router();
  router.use(authenticate, enterTenantContext);

  const uploadBody = express.json({ limit: '8mb' });

  router.post('/imports/:entity/preview', uploadBody, validate(importEntityParamsSchema, 'params'), requireImportPermission, validate(importUploadSchema, 'body'), asyncHandler(controller.previewImport));
  router.post('/imports/:entity/commit', uploadBody, validate(importEntityParamsSchema, 'params'), requireImportPermission, validate(importUploadSchema, 'body'), asyncHandler(controller.commitImport));

  router.get('/exports', requirePermission('organization.export'), asyncHandler(controller.listExports));
  router.post('/exports', requirePermission('organization.export'), asyncHandler(controller.generateExport));
  router.get('/exports/:exportId/download', requirePermission('organization.export'), validate(exportIdParamsSchema, 'params'), asyncHandler(controller.downloadExport));

  return router;
}
