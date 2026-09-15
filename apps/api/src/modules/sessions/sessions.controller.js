import { AppError } from '../../common/errors/AppError.js';
import { sendCreated, sendPaginated, sendSuccess } from '../../common/http/responder.js';
import { sessionsError } from './sessions.errors.js';

/**
 * HTTP boundary for session capture. Holds no rules — the ACTIVE gate, the
 * appointment/plan/target validation, the measurement checks, and the frozen-
 * immutability guard all live in the service. Follows the established
 * conventions: {data} envelope, sendCreated with Location, mandatory If-Match on
 * the versioned session update and optional If-Match on the data-point update.
 */
export class SessionsController {
  constructor(service) {
    this.service = service;
  }

  // --- sessions ------------------------------------------------------------

  sessionInsights = async (req, res) => {
    const tenantId = SessionsController.requireTenantId(req);
    const q = req.query;
    const insights = await this.service.oversightInsights({
      tenantId,
      dataScope: req.dataScope,
      ...(q.from ? { from: q.from } : {}),
      ...(q.to ? { to: q.to } : {}),
      ...(q.clientId ? { clientId: q.clientId } : {}),
      ...(q.staffProfileId ? { staffProfileId: q.staffProfileId } : {}),
      ...(q.status ? { status: q.status } : {}),
    });
    sendSuccess(res, insights);
  };

  oversightChildren = async (req, res) => {
    const tenantId = SessionsController.requireTenantId(req);
    const rows = await this.service.oversightChildren({ tenantId, dataScope: req.dataScope });
    sendSuccess(res, rows);
  };

  listSessions = async (req, res) => {
    const tenantId = SessionsController.requireTenantId(req);
    const q = req.query;
    const page = await this.service.listSessions({
      tenantId,
      dataScope: req.dataScope,
      limit: q.limit,
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.clientId !== undefined ? { clientId: q.clientId } : {}),
      ...(q.staffProfileId !== undefined ? { staffProfileId: q.staffProfileId } : {}),
      ...(q.appointmentId !== undefined ? { appointmentId: q.appointmentId } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
    });
    sendPaginated(res, page.items, { nextCursor: page.nextCursor, limit: q.limit });
  };

  createSession = async (req, res) => {
    const principal = SessionsController.requirePrincipal(req);
    const session = await this.service.createSession({
      tenantId: SessionsController.requireTenantId(req),
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, session, `/api/v1/sessions/${session.id}`);
  };

  getSession = async (req, res) => {
    const detail = await this.service.getSession({
      tenantId: SessionsController.requireTenantId(req),
      sessionId: req.params.sessionId,
      // Role-scope the detail: derived server-side from the caller's resolved
      // data scope, never from the request body (spec §12).
      actorScope: req.dataScope ?? null,
    });
    sendSuccess(res, detail);
  };

  updateSession = async (req, res) => {
    const principal = SessionsController.requirePrincipal(req);
    const session = await this.service.updateSession({
      tenantId: SessionsController.requireTenantId(req),
      sessionId: req.params.sessionId,
      actorUserId: principal.userId,
      expectedVersion: SessionsController.requireVersion(req),
      input: req.body,
    });
    sendSuccess(res, session);
  };

  freezeSession = async (req, res) => {
    const principal = SessionsController.requirePrincipal(req);
    const result = await this.service.freezeSession({
      tenantId: SessionsController.requireTenantId(req),
      sessionId: req.params.sessionId,
      actorUserId: principal.userId,
      // BR-CN-2 / §4.5: a session may never be approved by the person who
      // delivered it. The acting clinician is DERIVED from the resolved data
      // scope, never accepted from the request — otherwise the separation of
      // duties could be defeated by sending someone else's staff id.
      actorStaffProfileId: req.dataScope?.staffProfileId ?? null,
    });
    sendSuccess(res, result);
  };

  // --- lifecycle transitions ----------------------------------------------

  /**
   * Clock in (§6.6 "one action each"). Time and coarse location are captured at
   * the event; the acting technician comes from the resolved scope so nobody
   * can clock in on a colleague's behalf.
   */
  clockIn = async (req, res) => {
    const principal = SessionsController.requirePrincipal(req);
    const result = await this.service.clockIn({
      tenantId: SessionsController.requireTenantId(req),
      sessionId: req.params.sessionId,
      actorUserId: principal.userId,
      actorStaffProfileId: req.dataScope?.staffProfileId ?? null,
      ...(req.body.location !== undefined ? { location: req.body.location } : {}),
      ...(req.body.serviceType !== undefined ? { serviceType: req.body.serviceType } : {}),
      ...(req.body.at !== undefined ? { at: req.body.at } : {}),
    });
    sendSuccess(res, result);
  };

  clockOut = async (req, res) => {
    const principal = SessionsController.requirePrincipal(req);
    const result = await this.service.clockOut({
      tenantId: SessionsController.requireTenantId(req),
      sessionId: req.params.sessionId,
      actorUserId: principal.userId,
      actorStaffProfileId: req.dataScope?.staffProfileId ?? null,
      ...(req.body.location !== undefined ? { location: req.body.location } : {}),
      ...(req.body.at !== undefined ? { at: req.body.at } : {}),
    });
    sendSuccess(res, result);
  };

  /** The six EVV elements and whether the record is complete (BR-BL-5). */
  verification = async (req, res) => {
    const result = await this.service.verificationStatus({
      tenantId: SessionsController.requireTenantId(req),
      sessionId: req.params.sessionId,
    });
    sendSuccess(res, result);
  };

  captureSignature = async (req, res) => {
    const principal = SessionsController.requirePrincipal(req);
    const result = await this.service.captureSignature({
      tenantId: SessionsController.requireTenantId(req),
      sessionId: req.params.sessionId,
      actorUserId: principal.userId,
      actorStaffProfileId: req.dataScope?.staffProfileId ?? null,
      role: req.body.role,
      ...(req.body.signerName !== undefined ? { signerName: req.body.signerName } : {}),
      ...(req.body.signerGuardianId !== undefined ? { signerGuardianId: req.body.signerGuardianId } : {}),
      ...(req.body.refused !== undefined ? { refused: req.body.refused } : {}),
      ...(req.body.refusalReason !== undefined ? { refusalReason: req.body.refusalReason } : {}),
    });
    sendSuccess(res, result);
  };

  /** Submit for review, gated by the server-side completeness check (§6.6). */
  submitSession = async (req, res) => {
    const principal = SessionsController.requirePrincipal(req);
    const result = await this.service.submitSession({
      tenantId: SessionsController.requireTenantId(req),
      sessionId: req.params.sessionId,
      actorUserId: principal.userId,
      actorStaffProfileId: req.dataScope?.staffProfileId ?? null,
    });
    sendSuccess(res, result);
  };

  /** Return with a comment — the BCBA's second documented review action. */
  returnSession = async (req, res) => {
    const principal = SessionsController.requirePrincipal(req);
    const result = await this.service.returnSession({
      tenantId: SessionsController.requireTenantId(req),
      sessionId: req.params.sessionId,
      actorUserId: principal.userId,
      comment: req.body.comment,
    });
    sendSuccess(res, result);
  };

  cancelSession = async (req, res) => {
    const principal = SessionsController.requirePrincipal(req);
    const result = await this.service.cancelSession({
      tenantId: SessionsController.requireTenantId(req),
      sessionId: req.params.sessionId,
      actorUserId: principal.userId,
      reasonCode: req.body.reasonCode,
      ...(req.body.note !== undefined ? { note: req.body.note } : {}),
    });
    sendSuccess(res, result);
  };

  /**
   * Amend an approved session. Creates a NEW attributed record; the original
   * moves to AMENDED and is never overwritten (§6.6, BR-CN-3).
   */
  amendSession = async (req, res) => {
    const principal = SessionsController.requirePrincipal(req);
    const result = await this.service.amendSession({
      tenantId: SessionsController.requireTenantId(req),
      sessionId: req.params.sessionId,
      actorUserId: principal.userId,
      reason: req.body.reason,
      ...(req.body.changes !== undefined ? { changes: req.body.changes } : {}),
    });
    sendCreated(res, result);
  };

  // --- data points ---------------------------------------------------------

  addDataPoint = async (req, res) => {
    const principal = SessionsController.requirePrincipal(req);
    const dp = await this.service.addDataPoint({
      tenantId: SessionsController.requireTenantId(req),
      sessionId: req.params.sessionId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, dp, `/api/v1/sessions/${req.params.sessionId}/data-points/${dp.id}`);
  };

  updateDataPoint = async (req, res) => {
    const principal = SessionsController.requirePrincipal(req);
    const dp = await this.service.updateDataPoint({
      tenantId: SessionsController.requireTenantId(req),
      sessionId: req.params.sessionId,
      dataPointId: req.params.dataPointId,
      actorUserId: principal.userId,
      ...(SessionsController.optionalVersion(req) !== undefined ? { expectedVersion: SessionsController.optionalVersion(req) } : {}),
      input: req.body,
    });
    sendSuccess(res, dp);
  };

  removeDataPoint = async (req, res) => {
    const principal = SessionsController.requirePrincipal(req);
    const result = await this.service.removeDataPoint({
      tenantId: SessionsController.requireTenantId(req),
      sessionId: req.params.sessionId,
      dataPointId: req.params.dataPointId,
      actorUserId: principal.userId,
    });
    sendSuccess(res, result);
  };

  // --- guards --------------------------------------------------------------

  static requirePrincipal(req) {
    if (!req.principal) throw AppError.unauthorized('AUTH-401', 'Authentication required');
    return req.principal;
  }

  static requireTenantId(req) {
    const tenantId = req.principal?.activeTenantId;
    if (tenantId === undefined || tenantId === null) throw sessionsError('TENANT_CONTEXT_MISSING');
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

  static optionalVersion(req) {
    const header = req.get('if-match');
    if (header === undefined) return undefined;
    if (!/^\d+$/.test(header)) {
      throw AppError.validation('If-Match must be the numeric version you read.', [
        { path: 'headers.if-match', message: 'Invalid' },
      ]);
    }
    return Number.parseInt(header, 10);
  }
}
