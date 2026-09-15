import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { SupervisionController } from './supervision.controller.js';
import {
  createObservationSchema,
  updateObservationSchema,
  supersedeObservationSchema,
  observationIdParamsSchema,
  listObservationsQuerySchema,
  recordHoursSchema,
  hoursSummaryQuerySchema,
} from './supervision.schemas.js';

/**
 * Supervision workflow router. Every route is authenticated and tenant-bound.
 * Viewing reuses staff.read; creating/editing/submitting observations and
 * recording hours require supervision.log; signing off and superseding require
 * the distinct supervision.signoff (the clinical sign-off authority).
 */
export function createSupervisionRouter(service) {
  const controller = new SupervisionController(service);
  const router = Router();
  router.use(authenticate, enterTenantContext);

  // observations
  router.get('/observations', requirePermission('staff.read'), validate(listObservationsQuerySchema, 'query'), asyncHandler(controller.listObservations));
  router.post('/observations', requirePermission('supervision.log'), validate(createObservationSchema, 'body'), asyncHandler(controller.createObservation));
  router.get('/observations/:observationId', requirePermission('staff.read'), validate(observationIdParamsSchema, 'params'), asyncHandler(controller.getObservation));
  router.patch('/observations/:observationId', requirePermission('supervision.log'), validate(observationIdParamsSchema, 'params'), validate(updateObservationSchema, 'body'), asyncHandler(controller.updateObservation));
  router.post('/observations/:observationId/submit', requirePermission('supervision.log'), validate(observationIdParamsSchema, 'params'), asyncHandler(controller.submitObservation));
  router.post('/observations/:observationId/reopen', requirePermission('supervision.signoff'), validate(observationIdParamsSchema, 'params'), asyncHandler(controller.reopenObservation));
  router.post('/observations/:observationId/sign', requirePermission('supervision.signoff'), validate(observationIdParamsSchema, 'params'), asyncHandler(controller.signObservation));
  router.post('/observations/:observationId/supersede', requirePermission('supervision.signoff'), validate(observationIdParamsSchema, 'params'), validate(supersedeObservationSchema, 'body'), asyncHandler(controller.supersedeObservation));

  // hours
  router.get('/hours', requirePermission('staff.read'), validate(hoursSummaryQuerySchema, 'query'), asyncHandler(controller.hoursSummary));
  router.post('/hours', requirePermission('supervision.log'), validate(recordHoursSchema, 'body'), asyncHandler(controller.recordHours));

  return router;
}
