import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { sendCreated, sendSuccess } from '../../common/http/responder.js';
import { ClientsController } from './clients.controller.js';
import { createEmailTemplateSchema, updateEmailTemplateSchema, emailTemplateIdParamsSchema } from './clients.schemas.js';

/**
 * /v1/email-templates — the company's saved parent-email templates.
 *
 *   read   clients.update        anyone who can send a parent email may reuse them
 *   write  organization.update   Owner / Company Admin manage the library
 *
 * Tenant comes from the authenticated principal only; the body is strict (no
 * tenant or owner fields accepted). Updates require If-Match (optimistic).
 */
export function createEmailTemplatesRouter(service) {
  const router = Router();
  router.use(authenticate, enterTenantContext);
  const ctx = (req) => ({ tenantId: ClientsController.requireTenantId(req), actorUserId: ClientsController.requirePrincipal(req).userId });

  router.get('/', requirePermission('clients.update'), asyncHandler(async (req, res) => {
    sendSuccess(res, await service.list(ctx(req)));
  }));
  router.get('/:templateId', requirePermission('clients.update'), validate(emailTemplateIdParamsSchema, 'params'), asyncHandler(async (req, res) => {
    sendSuccess(res, await service.get({ ...ctx(req), templateId: req.params.templateId }));
  }));
  router.post('/', requirePermission('organization.update'), validate(createEmailTemplateSchema, 'body'), asyncHandler(async (req, res) => {
    const tpl = await service.create({ ...ctx(req), input: req.body });
    sendCreated(res, tpl, `/api/v1/email-templates/${tpl.id}`);
  }));
  router.patch('/:templateId', requirePermission('organization.update'), validate(emailTemplateIdParamsSchema, 'params'), validate(updateEmailTemplateSchema, 'body'), asyncHandler(async (req, res) => {
    sendSuccess(res, await service.update({ ...ctx(req), templateId: req.params.templateId, expectedVersion: ClientsController.requireVersion(req), input: req.body }));
  }));
  router.delete('/:templateId', requirePermission('organization.update'), validate(emailTemplateIdParamsSchema, 'params'), asyncHandler(async (req, res) => {
    sendSuccess(res, await service.remove({ ...ctx(req), templateId: req.params.templateId }));
  }));
  return router;
}
