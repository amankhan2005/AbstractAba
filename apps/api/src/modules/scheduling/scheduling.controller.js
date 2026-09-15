import { AppError } from '../../common/errors/AppError.js';
import { sendCreated, sendNoContent, sendPaginated, sendSuccess } from '../../common/http/responder.js';
import { schedulingError } from './scheduling.errors.js';

/**
 * HTTP boundary for scheduling. Holds no rules — the ACTIVE gate, eligibility,
 * availability, authorization, double-booking, and burn-down all live in the
 * service. Follows the established conventions: {data} envelopes, sendCreated
 * with Location, sendPaginated for lists, mandatory If-Match on the versioned
 * appointment and authorization updates.
 */
export class SchedulingController {
  constructor(service, appointmentNotes = null) {
    this.service = service;
    this.appointmentNotes = appointmentNotes;
  }

  // --- appointment notes ---------------------------------------------------

  /**
   * The caller's clinical role and data scope, both resolved from the TOKEN by
   * requirePermission — never from the request body. The notes service uses
   * these to decide read/write, so a browser cannot claim to be a BCBA.
   */
  static noteActor(req) {
    const roleKeys = req.principal?.roleKeys ?? [];
    // A caller is treated as an RBT only when RBT is their ONLY clinical role.
    // Someone who also holds bcba/org_admin/owner is not locked out by the
    // presence of an rbt grant, and a plain RBT cannot escape the block by any
    // value they control — roleKeys comes from the verified token.
    const isRbtOnly = roleKeys.includes('rbt')
      && !roleKeys.some((k) => ['bcba', 'org_admin', 'owner'].includes(k));
    return {
      actorRole: isRbtOnly ? 'RBT' : 'BCBA',
      actorStaffProfileId: req.dataScope?.staffProfileId ?? null,
      scope: req.dataScope?.scope ?? null,
    };
  }

  listAppointmentNotes = async (req, res) => {
    const result = await this.appointmentNotes.listForAppointment({
      tenantId: SchedulingController.requireTenantId(req),
      appointmentId: req.params.appointmentId,
      ...SchedulingController.noteActor(req),
    });
    sendSuccess(res, result);
  };

  getAppointmentNote = async (req, res) => {
    const result = await this.appointmentNotes.getNote({
      tenantId: SchedulingController.requireTenantId(req),
      appointmentId: req.params.appointmentId,
      ...(req.query.serviceDate !== undefined ? { serviceDate: req.query.serviceDate } : {}),
      ...SchedulingController.noteActor(req),
    });
    sendSuccess(res, result);
  };

  saveAppointmentNote = async (req, res) => {
    const result = await this.appointmentNotes.saveNote({
      tenantId: SchedulingController.requireTenantId(req),
      actorUserId: req.principal?.userId ?? null,
      appointmentId: req.params.appointmentId,
      ...(req.body.serviceDate !== undefined ? { serviceDate: req.body.serviceDate } : {}),
      note: req.body.note,
      ...(req.body.clientId !== undefined ? { clientId: req.body.clientId } : {}),
      ...SchedulingController.noteActor(req),
    });
    sendSuccess(res, result);
  };

  /** DELETE /scheduling/appointments/:appointmentId/note — delete the current-day note. */
  deleteAppointmentNote = async (req, res) => {
    const result = await this.appointmentNotes.deleteNote({
      tenantId: SchedulingController.requireTenantId(req),
      actorUserId: req.principal?.userId ?? null,
      appointmentId: req.params.appointmentId,
      ...(req.query.serviceDate !== undefined ? { serviceDate: req.query.serviceDate } : {}),
      ...SchedulingController.noteActor(req),
    });
    sendSuccess(res, result);
  };

  /** GET /scheduling/appointment-notes — the current business date's notes (admin overview). */
  listAppointmentNotesOverview = async (req, res) => {
    const result = await this.appointmentNotes.listNotesOverview({
      tenantId: SchedulingController.requireTenantId(req),
      ...SchedulingController.noteActor(req),
    });
    sendSuccess(res, result);
  };

  // --- appointments --------------------------------------------------------

  listAppointments = async (req, res) => {
    const tenantId = SchedulingController.requireTenantId(req);
    const q = req.query;
    const page = await this.service.listAppointments({
      tenantId,
      dataScope: req.dataScope,
      limit: q.limit,
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
      ...(q.staffProfileId !== undefined ? { staffProfileId: q.staffProfileId } : {}),
      ...(q.clientId !== undefined ? { clientId: q.clientId } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
    });
    sendPaginated(res, page.items, { nextCursor: page.nextCursor, limit: q.limit });
  };

  bookAppointment = async (req, res) => {
    const principal = SchedulingController.requirePrincipal(req);
    const appt = await this.service.bookAppointment({
      tenantId: SchedulingController.requireTenantId(req),
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, appt, `/api/v1/scheduling/appointments/${appt.id}`);
  };

  getAppointment = async (req, res) => {
    const appt = await this.service.getAppointment({
      tenantId: SchedulingController.requireTenantId(req),
      appointmentId: req.params.appointmentId,
    });
    sendSuccess(res, appt);
  };

  updateAppointment = async (req, res) => {
    const principal = SchedulingController.requirePrincipal(req);
    const appt = await this.service.updateAppointment({
      tenantId: SchedulingController.requireTenantId(req),
      appointmentId: req.params.appointmentId,
      actorUserId: principal.userId,
      expectedVersion: SchedulingController.requireVersion(req),
      input: req.body,
    });
    sendSuccess(res, appt);
  };

  cancelAppointment = async (req, res) => {
    const principal = SchedulingController.requirePrincipal(req);
    const appt = await this.service.cancelAppointment({
      tenantId: SchedulingController.requireTenantId(req),
      appointmentId: req.params.appointmentId,
      actorUserId: principal.userId,
    });
    sendSuccess(res, appt);
  };

  // --- recurring series (Phase 4.3) ----------------------------------------

  createSeries = async (req, res) => {
    const principal = SchedulingController.requirePrincipal(req);
    const result = await this.service.createSeries({
      tenantId: SchedulingController.requireTenantId(req),
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, result, `/api/v1/scheduling/series/${result.series.id}`);
  };

  listSeries = async (req, res) => {
    const rows = await this.service.listSeries({
      tenantId: SchedulingController.requireTenantId(req),
      filters: req.query,
    });
    sendSuccess(res, rows);
  };

  getSeries = async (req, res) => {
    const result = await this.service.getSeries({
      tenantId: SchedulingController.requireTenantId(req),
      seriesId: req.params.seriesId,
    });
    sendSuccess(res, result);
  };

  cancelSeries = async (req, res) => {
    const principal = SchedulingController.requirePrincipal(req);
    const result = await this.service.cancelSeries({
      tenantId: SchedulingController.requireTenantId(req),
      seriesId: req.params.seriesId,
      actorUserId: principal.userId,
    });
    sendSuccess(res, result);
  };

  cancelOccurrence = async (req, res) => {
    const principal = SchedulingController.requirePrincipal(req);
    const appt = await this.service.cancelOccurrence({
      tenantId: SchedulingController.requireTenantId(req),
      seriesId: req.params.seriesId,
      appointmentId: req.params.appointmentId,
      actorUserId: principal.userId,
    });
    sendSuccess(res, appt);
  };

  // --- availability --------------------------------------------------------

  getAvailability = async (req, res) => {
    const windows = await this.service.getAvailability({
      tenantId: SchedulingController.requireTenantId(req),
      staffId: req.params.staffId,
    });
    sendSuccess(res, windows);
  };

  putAvailability = async (req, res) => {
    const principal = SchedulingController.requirePrincipal(req);
    const windows = await this.service.replaceAvailability({
      tenantId: SchedulingController.requireTenantId(req),
      staffId: req.params.staffId,
      actorUserId: principal.userId,
      windows: req.body.windows,
    });
    sendSuccess(res, windows);
  };

  // --- authorizations ------------------------------------------------------

  listAuthorizations = async (req, res) => {
    const tenantId = SchedulingController.requireTenantId(req);
    const q = req.query;
    const page = await this.service.listAuthorizations({
      tenantId,
      limit: q.limit,
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.clientId !== undefined ? { clientId: q.clientId } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
    });
    sendPaginated(res, page.items, { nextCursor: page.nextCursor, limit: q.limit });
  };

  createAuthorization = async (req, res) => {
    const principal = SchedulingController.requirePrincipal(req);
    const auth = await this.service.createAuthorization({
      tenantId: SchedulingController.requireTenantId(req),
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, auth, `/api/v1/scheduling/authorizations/${auth.id}`);
  };

  getAuthorization = async (req, res) => {
    const auth = await this.service.getAuthorization({
      tenantId: SchedulingController.requireTenantId(req),
      authorizationId: req.params.authorizationId,
    });
    sendSuccess(res, auth);
  };

  updateAuthorization = async (req, res) => {
    const principal = SchedulingController.requirePrincipal(req);
    const auth = await this.service.updateAuthorization({
      tenantId: SchedulingController.requireTenantId(req),
      authorizationId: req.params.authorizationId,
      actorUserId: principal.userId,
      expectedVersion: SchedulingController.requireVersion(req),
      input: req.body,
    });
    sendSuccess(res, auth);
  };

  // --- guards --------------------------------------------------------------

  static requirePrincipal(req) {
    if (!req.principal) throw AppError.unauthorized('AUTH-401', 'Authentication required');
    return req.principal;
  }

  static requireTenantId(req) {
    const tenantId = req.principal?.activeTenantId;
    if (tenantId === undefined || tenantId === null) throw schedulingError('TENANT_CONTEXT_MISSING');
    return tenantId;
  }

  static requireVersion(req) {
    const header = req.get('if-match');
    if (header === undefined || !/^\d+$/.test(header)) {
      throw AppError.validation('Supply the version you read in an If-Match header.', [
        { path: 'headers.if-match', message: 'Required' },
      ]);
    }
    return Number.parseInt(header, 10);
  }
}
