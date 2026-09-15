import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePlatformOperator } from '../../middleware/requirePlatformOperator.js';
import { OnboardingController } from './onboarding.controller.js';
import {
  agreementIdParamsSchema, approveDestructionSchema, beginOffboardingSchema,
  completeExportSchema, organizationIdParamsSchema, recordAgreementSchema,
} from './onboarding.schemas.js';

/**
 * Onboarding routes, mounted under the platform console. Every route requires a
 * platform operator — none of this is self-service, because the agreement gate
 * exists precisely so a clinic cannot put itself into a state where it may store
 * patient data. Ported from the original (mergeParams for the :id prefix).
 */
export function createOnboardingRouter(service) {
  const router = Router({ mergeParams: true });
  const controller = new OnboardingController(service);
  router.use(authenticate, requirePlatformOperator);

  router.get('/:id/onboarding', validate(organizationIdParamsSchema, 'params'), asyncHandler(controller.checklist));
  router.post('/:id/onboarding/provision', validate(organizationIdParamsSchema, 'params'), asyncHandler(controller.provision));
  router.post('/:id/onboarding/activate', validate(organizationIdParamsSchema, 'params'), asyncHandler(controller.activate));
  router.get('/:id/agreements', validate(organizationIdParamsSchema, 'params'), asyncHandler(controller.listAgreements));
  router.post('/:id/agreements', validate(organizationIdParamsSchema, 'params'), validate(recordAgreementSchema, 'body'), asyncHandler(controller.recordAgreement));
  router.post('/:id/agreements/:agreementId/countersign', validate(agreementIdParamsSchema, 'params'), asyncHandler(controller.countersignAgreement));
  router.post('/:id/offboarding', validate(organizationIdParamsSchema, 'params'), validate(beginOffboardingSchema, 'body'), asyncHandler(controller.beginOffboarding));
  router.get('/:id/offboarding/export', validate(organizationIdParamsSchema, 'params'), asyncHandler(controller.latestExport));
  router.post('/:id/offboarding/export/complete', validate(organizationIdParamsSchema, 'params'), validate(completeExportSchema, 'body'), asyncHandler(controller.completeExport));
  router.post('/:id/destruction/approve', validate(organizationIdParamsSchema, 'params'), validate(approveDestructionSchema, 'body'), asyncHandler(controller.approveDestruction));

  return router;
}
