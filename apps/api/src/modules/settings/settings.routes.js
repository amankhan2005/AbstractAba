import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { SettingsController } from './settings.controller.js';

/** Path-shape guard; per-key value validation is registry-driven in the service. */
const namespaceParams = z.object({ namespace: z.string().min(1).max(64) });
const settingsPatchBody = z.record(z.unknown());

/**
 * Organization settings routes, ported from the original:
 *   GET  /            all effective settings for the active tenant
 *   GET  /:namespace  effective settings for one namespace
 *   PUT  /:namespace  apply a validated patch (reuses organization.update)
 *
 * Reading requires only tenant membership; writing reuses the existing
 * organization.update permission, exactly as the original did.
 */
export function createSettingsRouter(service) {
  const controller = new SettingsController(service);
  const router = Router();
  router.use(authenticate, enterTenantContext);

  router.get('/', asyncHandler(controller.getSettings));
  router.get('/:namespace', validate(namespaceParams, 'params'), asyncHandler(controller.getNamespace));
  router.put(
    '/:namespace',
    requirePermission('organization.update'),
    validate(namespaceParams, 'params'),
    validate(settingsPatchBody, 'body'),
    asyncHandler(controller.updateNamespace),
  );

  return router;
}
