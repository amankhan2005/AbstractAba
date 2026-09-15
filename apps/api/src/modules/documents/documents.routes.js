import { Router } from 'express';
import express from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { DocumentsController } from './documents.controller.js';
import {
  createDocumentSchema,
  updateDocumentSchema,
  listDocumentsQuerySchema,
  documentIdParamsSchema,
  supersedeDocumentSchema,
  attachFileSchema,
} from './documents.schemas.js';

/**
 * Clinical-documents router. Every route is authenticated, bound to the tenant
 * context, and guarded by an explicit permission. Reading requires
 * documents.read; drafting (create / update draft) requires documents.write; the
 * record-lifecycle sign-off actions — finalize, archive, supersede — require the
 * distinct documents.finalize.
 */
export function createDocumentsRouter(service) {
  const controller = new DocumentsController(service);
  const router = Router();
  router.use(authenticate, enterTenantContext);

  router.get('/', requirePermission('documents.read'), validate(listDocumentsQuerySchema, 'query'), asyncHandler(controller.listDocuments));
  router.post('/', requirePermission('documents.write'), validate(createDocumentSchema, 'body'), asyncHandler(controller.createDocument));
  router.get('/:documentId', requirePermission('documents.read'), validate(documentIdParamsSchema, 'params'), asyncHandler(controller.getDocument));
  router.patch('/:documentId', requirePermission('documents.write'), validate(documentIdParamsSchema, 'params'), validate(updateDocumentSchema, 'body'), asyncHandler(controller.updateDocument));
  router.post('/:documentId/finalize', requirePermission('documents.finalize'), validate(documentIdParamsSchema, 'params'), asyncHandler(controller.finalizeDocument));
  router.post('/:documentId/archive', requirePermission('documents.finalize'), validate(documentIdParamsSchema, 'params'), asyncHandler(controller.archiveDocument));
  router.post('/:documentId/supersede', requirePermission('documents.finalize'), validate(documentIdParamsSchema, 'params'), validate(supersedeDocumentSchema, 'body'), asyncHandler(controller.supersedeDocument));

  // Binary artifact upload/download (Phase 4.1). The upload route uses a scoped
  // larger JSON body limit for the base64 payload (the global limit stays 1mb);
  // the server enforces the real byte cap after decoding. Download requires read.
  const uploadBody = express.json({ limit: '40mb' });
  router.post('/:documentId/file', requirePermission('documents.write'), uploadBody, validate(documentIdParamsSchema, 'params'), validate(attachFileSchema, 'body'), asyncHandler(controller.attachFile));
  router.get('/:documentId/file', requirePermission('documents.read'), validate(documentIdParamsSchema, 'params'), asyncHandler(controller.downloadFile));

  return router;
}
