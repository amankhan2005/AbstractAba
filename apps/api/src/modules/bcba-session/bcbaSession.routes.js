import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { BcbaSessionController } from './bcbaSession.controller.js';
import {
  panelQuerySchema,
  appointmentParamsSchema,
  completeSessionSchema,
  saveDocumentationSchema,
  manualSessionSchema,
  timeRecordsQuerySchema,
  myHoursQuerySchema,
} from './bcbaSession.schemas.js';

/**
 * BCBA session workflow router. Every route is authenticated and bound to the
 * tenant context. Permission guards follow the platform's existing keys:
 *
 *   panel / start / stop / complete → sessions.write
 *       The BCBA is running and finalizing their OWN direct-service session.
 *       requirePermission resolves req.dataScope.staffProfileId from the token,
 *       which the controller passes to the service as the acting clinician —
 *       the body can never name a different BCBA.
 *
 *   time-records (admin payroll visibility) → payroll.read
 *       Admin/Payroll Staff hold this; a BCBA does NOT, so starting a session
 *       never grants payroll-management sight (§15, §20).
 */
export function createBcbaSessionRouter(service, role = 'BCBA') {
  const controller = new BcbaSessionController(service, role);
  const router = Router();
  router.use(authenticate, enterTenantContext);

  router.get(
    '/panel',
    requirePermission('sessions.write'),
    validate(panelQuerySchema, 'query'),
    asyncHandler(controller.panel),
  );

  router.post(
    '/appointments/:appointmentId/start',
    requirePermission('sessions.write'),
    validate(appointmentParamsSchema, 'params'),
    asyncHandler(controller.start),
  );

  router.get(
    '/appointments/:appointmentId/session',
    requirePermission('sessions.write'),
    validate(appointmentParamsSchema, 'params'),
    asyncHandler(controller.active),
  );

  router.get(
    '/appointments/:appointmentId/child',
    requirePermission('sessions.write'),
    validate(appointmentParamsSchema, 'params'),
    asyncHandler(controller.childDetail),
  );

  // MANUAL SESSION ENTRY (Phase 3) — record a completed session (no live timer).
  // Same sessions.write guard; clinician identity + role come from the token.
  router.post(
    '/manual-session',
    requirePermission('sessions.write'),
    validate(manualSessionSchema, 'body'),
    asyncHandler(controller.manualSession),
  );
  // session runs (spec §1/§6). Same sessions.write guard as start/stop/complete:
  // the acting clinician is resolved from the token, and the service asserts
  // ownership of THIS appointment's own session before writing. It touches only
  // the documentation fields — never clock, status or workedMinutes.
  router.patch(
    '/appointments/:appointmentId/documentation',
    requirePermission('sessions.write'),
    validate(appointmentParamsSchema, 'params'),
    validate(saveDocumentationSchema, 'body'),
    asyncHandler(controller.saveDocumentation),
  );

  router.post(
    '/appointments/:appointmentId/stop',
    requirePermission('sessions.write'),
    validate(appointmentParamsSchema, 'params'),
    asyncHandler(controller.stop),
  );

  router.post(
    '/appointments/:appointmentId/complete',
    requirePermission('sessions.write'),
    validate(appointmentParamsSchema, 'params'),
    validate(completeSessionSchema, 'body'),
    asyncHandler(controller.complete),
  );

  // The BCBA's OWN weekly progress. Guarded by sessions.write (the BCBA holds
  // it; the acting clinician is resolved from the token by requirePermission),
  // and the service only ever sums this staffProfileId's records (§R).
  router.get(
    '/weekly-hours',
    requirePermission('sessions.write'),
    asyncHandler(controller.weeklyHours),
  );

  // GET /bcba/my-hours — exact own worked time (h/m/s) by period (Change 4).
  // Same guard as weekly-hours: requirePermission resolves the caller's own
  // staffProfileId onto req.dataScope; the query carries only the period.
  router.get(
    '/my-hours',
    requirePermission('sessions.write'),
    validate(myHoursQuerySchema, 'query'),
    asyncHandler(controller.myHours),
  );

  router.get(
    '/time-records',
    requirePermission('payroll.read'),
    validate(timeRecordsQuerySchema, 'query'),
    asyncHandler(controller.timeRecords),
  );

  return router;
}
