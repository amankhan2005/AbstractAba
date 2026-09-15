import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { sendSuccess, sendCreated } from '../../common/http/responder.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { AppError } from '../../common/errors/AppError.js';
import * as S from './reconciliation.schemas.js';

export function createReconciliationRouter(service) {
  const r = Router();

  // Every route below is tenant-scoped. `enterTenantContext` was missing here:
  // authorization needed nothing from the database, so the omission was
  // invisible. requirePermission now resolves the caller's data scope by
  // reading tenant-owned models, which requires an active context. Mounting it
  // once on the router also stops the next route being added without it.
  r.use(authenticate, enterTenantContext);

  const orgId = (req) => { const id = req.principal?.activeTenantId; if (!id) throw AppError.forbidden('AUTH-403', 'No active tenant'); return id; };
  const actor = (req) => req.principal.userId;

  r.get('/', requirePermission('reconciliation.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.list(orgId(req), req.query))));
  r.get('/queue', requirePermission('reconciliation.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.queue(orgId(req)))));
  r.get('/:id', requirePermission('reconciliation.read'),
    asyncHandler(async (req, res) => sendSuccess(res, await service.get(orgId(req), req.params.id))));
  r.post('/refresh', requirePermission('reconciliation.manage'), validate(S.refreshSchema),
    asyncHandler(async (req, res) => {
      const { claimId, invoiceId } = req.body;
      const out = claimId ? await service.refreshClaim(orgId(req), claimId, actor(req)) : await service.refreshInvoice(orgId(req), invoiceId, actor(req));
      sendCreated(res, out);
    }));
  r.post('/:id/transitions', requirePermission('reconciliation.manage'), validate(S.reconTransitionSchema),
    asyncHandler(async (req, res) => sendSuccess(res, await service.transition(orgId(req), req.params.id, req.body.target, actor(req), req.body))));

  return r;
}
