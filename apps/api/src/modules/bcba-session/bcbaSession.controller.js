import { AppError } from '../../common/errors/AppError.js';
import { sendSuccess, sendCreated } from '../../common/http/responder.js';

/**
 * HTTP boundary for the BCBA session workflow. Holds no business rules — the
 * ACTIVE gate, appointment ownership, authorization validation, timing and
 * idempotent finalization all live in the service.
 *
 * The acting BCBA's staffProfileId is taken from req.dataScope (resolved
 * server-side from the token subject by requirePermission), NEVER from the
 * request body or query — the security invariant §19/§20 rest on.
 */
export class BcbaSessionController {
  constructor(service, role = 'BCBA') {
    this.service = service;
    this.role = role;
  }

  // GET /bcba/panel — appointments assigned to me, each with session status.
  panel = async (req, res) => {
    const tenantId = BcbaSessionController.tenantId(req);
    const cards = await this.service.listPanel({
      tenantId,
      bcbaStaffProfileId: BcbaSessionController.staffProfileId(req),
      role: this.role,
      ...(req.query.from !== undefined ? { from: req.query.from } : {}),
      ...(req.query.to !== undefined ? { to: req.query.to } : {}),
    });
    sendSuccess(res, cards);
  };

  // POST /bcba/appointments/:appointmentId/start
  start = async (req, res) => {
    const principal = BcbaSessionController.principal(req);
    const session = await this.service.startSession({
      tenantId: BcbaSessionController.tenantId(req),
      actorUserId: principal.userId,
      bcbaStaffProfileId: BcbaSessionController.staffProfileId(req),
      appointmentId: req.params.appointmentId,
      role: this.role,
    });
    sendCreated(res, session, `/api/v1/bcba/appointments/${req.params.appointmentId}/session`);
  };

  // GET /bcba/appointments/:appointmentId/session — active session (timer reconstruction).
  active = async (req, res) => {
    const session = await this.service.getActiveByAppointment({
      tenantId: BcbaSessionController.tenantId(req),
      bcbaStaffProfileId: BcbaSessionController.staffProfileId(req),
      appointmentId: req.params.appointmentId,
      role: this.role,
    });
    sendSuccess(res, session);
  };

  // POST /bcba/appointments/:appointmentId/stop — fix endedAt, return completion payload.
  stop = async (req, res) => {
    const principal = BcbaSessionController.principal(req);
    const payload = await this.service.stopSession({
      tenantId: BcbaSessionController.tenantId(req),
      actorUserId: principal.userId,
      bcbaStaffProfileId: BcbaSessionController.staffProfileId(req),
      appointmentId: req.params.appointmentId,
      role: this.role,
    });
    sendSuccess(res, payload);
  };

  // POST /bcba/appointments/:appointmentId/complete — finalize + payroll time record.
  complete = async (req, res) => {
    const principal = BcbaSessionController.principal(req);
    const result = await this.service.completeSession({
      tenantId: BcbaSessionController.tenantId(req),
      actorUserId: principal.userId,
      bcbaStaffProfileId: BcbaSessionController.staffProfileId(req),
      appointmentId: req.params.appointmentId,
      ...(req.body.authorizationId !== undefined ? { authorizationId: req.body.authorizationId } : {}),
      ...(req.body.memo !== undefined ? { memo: req.body.memo } : {}),
      ...(req.body.authorizations !== undefined ? { authorizations: req.body.authorizations } : {}),
      role: this.role,
    });
    sendSuccess(res, result);
  };

  // GET /bcba/appointments/:appointmentId/child — permission-scoped child overview.
  childDetail = async (req, res) => {
    const detail = await this.service.getChildDetail({
      tenantId: BcbaSessionController.tenantId(req),
      bcbaStaffProfileId: BcbaSessionController.staffProfileId(req),
      appointmentId: req.params.appointmentId,
      role: this.role,
    });
    sendSuccess(res, detail);
  };

  manualSession = async (req, res) => {
    const principal = BcbaSessionController.principal(req);
    const result = await this.service.createManualSession({
      tenantId: BcbaSessionController.tenantId(req),
      actorUserId: principal.userId,
      bcbaStaffProfileId: BcbaSessionController.staffProfileId(req),
      role: this.role,
      input: req.body,
    });
    sendSuccess(res, result);
  };

  saveDocumentation = async (req, res) => {
    const principal = BcbaSessionController.principal(req);
    const session = await this.service.saveDocumentation({
      tenantId: BcbaSessionController.tenantId(req),
      actorUserId: principal.userId,
      bcbaStaffProfileId: BcbaSessionController.staffProfileId(req),
      appointmentId: req.params.appointmentId,
      documentation: {
        ...(req.body.what !== undefined ? { what: req.body.what } : {}),
        ...(req.body.how !== undefined ? { how: req.body.how } : {}),
        ...(req.body.childResponse !== undefined ? { childResponse: req.body.childResponse } : {}),
        ...(req.body.memo !== undefined ? { memo: req.body.memo } : {}),
      },
      role: this.role,
    });
    sendSuccess(res, session);
  };

  // GET /bcba/weekly-hours — this BCBA's progress toward the company weekly target (§K–§N).
  weeklyHours = async (req, res) => {
    const summary = await this.service.getWeeklyHours({
      tenantId: BcbaSessionController.tenantId(req),
      bcbaStaffProfileId: BcbaSessionController.staffProfileId(req),
    });
    sendSuccess(res, summary);
  };

  // GET /bcba/my-hours — this BCBA's OWN exact worked time (h/m/s) for a
  // selected period (spec Change 4). Worked-time only; no pay. The acting
  // clinician is the token's staffProfileId (never the query), and the service
  // sums only that id's tenant-scoped records.
  myHours = async (req, res) => {
    const summary = await this.service.getMyHours({
      tenantId: BcbaSessionController.tenantId(req),
      bcbaStaffProfileId: BcbaSessionController.staffProfileId(req),
      period: req.query.period,
    });
    sendSuccess(res, summary);
  };
  timeRecords = async (req, res) => {
    const q = req.query;
    const records = await this.service.listTimeRecords({
      tenantId: BcbaSessionController.tenantId(req),
      ...(q.staffProfileId !== undefined ? { staffProfileId: q.staffProfileId } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    });
    sendSuccess(res, records);
  };

  // --- helpers -------------------------------------------------------------

  static principal(req) {
    if (!req.principal) throw AppError.unauthorized('AUTH-401', 'Authentication required');
    return req.principal;
  }

  static tenantId(req) {
    const tenantId = req.principal?.activeTenantId;
    if (tenantId === undefined || tenantId === null) {
      throw new AppError('TENANT_CONTEXT_MISSING', { status: 500, message: 'No tenant context on request.' });
    }
    return tenantId;
  }

  /** The acting clinician, resolved from the token by requirePermission — never the body. */
  static staffProfileId(req) {
    return req.dataScope?.staffProfileId ?? null;
  }
}
