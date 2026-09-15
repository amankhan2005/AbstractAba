import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission, requireAnyPermission } from '../../middleware/requirePermission.js';
import { SchedulingController } from './scheduling.controller.js';
import {
  createAppointmentSchema,
  updateAppointmentSchema,
  listAppointmentsQuerySchema,
  appointmentIdParamsSchema,
  putAvailabilitySchema,
  staffIdParamsSchema,
  createAuthorizationSchema,
  updateAuthorizationSchema,
  listAuthorizationsQuerySchema,
  authorizationIdParamsSchema,
  createSeriesSchema,
  listSeriesQuerySchema,
  seriesIdParamsSchema,
  seriesOccurrenceParamsSchema,
  appointmentNoteQuerySchema,
  appointmentNotesOverviewQuerySchema,
  saveAppointmentNoteSchema,
} from './scheduling.schemas.js';

/**
 * Scheduling router. Every route is authenticated, bound to the tenant context,
 * and guarded by an explicit permission. Reading requires scheduling.read;
 * booking / rescheduling / cancelling appointments requires scheduling.write;
 * managing availability and authorizations requires scheduling.manage.
 */
export function createSchedulingRouter(service, appointmentNotesService = null) {
  const controller = new SchedulingController(service, appointmentNotesService);
  const router = Router();
  router.use(authenticate, enterTenantContext);

  // appointments
  router.get('/appointments', requirePermission('scheduling.read'), validate(listAppointmentsQuerySchema, 'query'), asyncHandler(controller.listAppointments));
  router.post('/appointments', requirePermission('scheduling.write'), validate(createAppointmentSchema, 'body'), asyncHandler(controller.bookAppointment));
  router.get('/appointments/:appointmentId', requirePermission('scheduling.read'), validate(appointmentIdParamsSchema, 'params'), asyncHandler(controller.getAppointment));
  router.patch('/appointments/:appointmentId', requirePermission('scheduling.write'), validate(appointmentIdParamsSchema, 'params'), validate(updateAppointmentSchema, 'body'), asyncHandler(controller.updateAppointment));
  router.post('/appointments/:appointmentId/cancel', requirePermission('scheduling.write'), validate(appointmentIdParamsSchema, 'params'), asyncHandler(controller.cancelAppointment));

  // APPOINTMENT NOTES — BCBA planning context, per appointment per business
  // date. Guarded by scheduling.read/write like the appointment itself; the
  // per-role rules (RBT denied, Company Admin read-only) are enforced in the
  // service against the resolved data scope, because a permission key alone
  // cannot express "the assigned BCBA may write, an admin may only read".
  // PERMISSION GRADE — why these keys and not scheduling.write.
  //
  // A BCBA deliberately holds NO scheduling.write: they must not book, move or
  // cancel appointments (see roleTemplates). Guarding the note write with it
  // therefore rejected the assigned BCBA in the middleware, before any
  // ownership logic ran — the reported 403 on a clinician's own appointment.
  //
  // An Appointment Note is clinical documentation ABOUT an appointment, not
  // scheduling authority over it, so the correct grade is documents.* — which a
  // BCBA genuinely holds at TEAM scope. scheduling.* is accepted too so a
  // scheduler or admin reaches it by their own route.
  //
  // This is a REGRADE, not a weakening: the permission only decides who may
  // reach the endpoint. WHO MAY READ AND WRITE A GIVEN NOTE is still decided in
  // the service from server-side ownership — assigned BCBA writes, org-wide
  // scope reads, RBT denied outright — so an RBT holding documents.write still
  // gets a 403 from the service.
  // Overview of the CURRENT business date's notes (Company Admin appointment
  // panel). Same permission grade; the service decides which notes each caller
  // may see (org-wide: all; BCBA: own appointments; RBT: forbidden).
  router.get('/appointment-notes', requireAnyPermission('documents.read', 'scheduling.read'), validate(appointmentNotesOverviewQuerySchema, 'query'), asyncHandler(controller.listAppointmentNotesOverview));
  router.get('/appointments/:appointmentId/notes', requireAnyPermission('documents.read', 'scheduling.read'), validate(appointmentIdParamsSchema, 'params'), asyncHandler(controller.listAppointmentNotes));
  router.get('/appointments/:appointmentId/note', requireAnyPermission('documents.read', 'scheduling.read'), validate(appointmentIdParamsSchema, 'params'), validate(appointmentNoteQuerySchema, 'query'), asyncHandler(controller.getAppointmentNote));
  router.put('/appointments/:appointmentId/note', requireAnyPermission('documents.write', 'scheduling.write'), validate(appointmentIdParamsSchema, 'params'), validate(saveAppointmentNoteSchema, 'body'), asyncHandler(controller.saveAppointmentNote));
  router.delete('/appointments/:appointmentId/note', requireAnyPermission('documents.write', 'scheduling.write'), validate(appointmentIdParamsSchema, 'params'), validate(appointmentNoteQuerySchema, 'query'), asyncHandler(controller.deleteAppointmentNote));

  // recurring series (Phase 4.3)
  router.get('/series', requirePermission('scheduling.read'), validate(listSeriesQuerySchema, 'query'), asyncHandler(controller.listSeries));
  router.post('/series', requirePermission('scheduling.write'), validate(createSeriesSchema, 'body'), asyncHandler(controller.createSeries));
  router.get('/series/:seriesId', requirePermission('scheduling.read'), validate(seriesIdParamsSchema, 'params'), asyncHandler(controller.getSeries));
  router.post('/series/:seriesId/cancel', requirePermission('scheduling.manage'), validate(seriesIdParamsSchema, 'params'), asyncHandler(controller.cancelSeries));
  router.post('/series/:seriesId/occurrences/:appointmentId/cancel', requirePermission('scheduling.write'), validate(seriesOccurrenceParamsSchema, 'params'), asyncHandler(controller.cancelOccurrence));

  // availability (per staff member)
  router.get('/staff/:staffId/availability', requirePermission('scheduling.read'), validate(staffIdParamsSchema, 'params'), asyncHandler(controller.getAvailability));
  router.put('/staff/:staffId/availability', requirePermission('scheduling.manage'), validate(staffIdParamsSchema, 'params'), validate(putAvailabilitySchema, 'body'), asyncHandler(controller.putAvailability));

  // authorizations
  router.get('/authorizations', requirePermission('scheduling.read'), validate(listAuthorizationsQuerySchema, 'query'), asyncHandler(controller.listAuthorizations));
  router.post('/authorizations', requirePermission('scheduling.manage'), validate(createAuthorizationSchema, 'body'), asyncHandler(controller.createAuthorization));
  router.get('/authorizations/:authorizationId', requirePermission('scheduling.read'), validate(authorizationIdParamsSchema, 'params'), asyncHandler(controller.getAuthorization));
  router.patch('/authorizations/:authorizationId', requirePermission('scheduling.manage'), validate(authorizationIdParamsSchema, 'params'), validate(updateAuthorizationSchema, 'body'), asyncHandler(controller.updateAuthorization));

  return router;
}
