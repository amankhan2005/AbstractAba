import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { sendSuccess, sendCreated } from '../../common/http/responder.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { AppError } from '../../common/errors/AppError.js';
import * as S from './era.schemas.js';

/** Tenant-scoped ERA routes. */
export function createEraRouter(service) {
  const r = Router();

  // Every route below is tenant-scoped. `enterTenantContext` was missing here:
  // authorization needed nothing from the database, so the omission was
  // invisible. requirePermission now resolves the caller's data scope by
  // reading tenant-owned models, which requires an active context. Mounting it
  // once on the router also stops the next route being added without it.
  r.use(authenticate, enterTenantContext);

  const orgId = (req) => {
    const id = req.principal?.activeTenantId;
    if (!id) throw AppError.forbidden('AUTH-403', 'No active tenant');
    return id;
  };
  const actor = (req) => req.principal.userId;

  r.post('/files', requirePermission('era.process'), validate(S.uploadEraSchema),
    asyncHandler(async (req, res) => sendCreated(res, await service.uploadFile(orgId(req), req.body, actor(req)))));
  r.get('/files', requirePermission('era.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.listFiles(orgId(req), req.query))));
  r.get('/files/:id', requirePermission('era.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.getFile(orgId(req), req.params.id))));
  r.get('/records', requirePermission('era.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.listRecords(orgId(req), req.query))));
  r.post('/records/:id/resolve', requirePermission('era.resolve'), validate(S.resolveRecordSchema),
    asyncHandler(async (req, res) => sendSuccess(res, await service.resolveRecord(orgId(req), req.params.id, req.body, actor(req)))));

  return r;
}
