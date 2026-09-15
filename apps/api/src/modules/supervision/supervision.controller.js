import { AppError } from '../../common/errors/AppError.js';
import { sendCreated, sendSuccess } from '../../common/http/responder.js';

/**
 * HTTP boundary for the supervision workflow. Holds no business rules — the
 * ACTIVE gate, state machine, sign-off authority, hour posting, and audit all
 * live in the service. tenantId and actor identity are taken from the
 * authenticated principal, never from the request body.
 */
export class SupervisionController {
  constructor(service) {
    this.service = service;
  }

  createObservation = async (req, res) => {
    const p = SupervisionController.principal(req);
    const obs = await this.service.createObservation({
      tenantId: SupervisionController.tenantId(req), actorUserId: p.userId, input: req.body,
    });
    sendCreated(res, obs, `/api/v1/supervision/observations/${obs.id}`);
  };

  listObservations = async (req, res) => {
    SupervisionController.principal(req);
    const rows = await this.service.listObservations({
      tenantId: SupervisionController.tenantId(req), filters: req.query,
    });
    sendSuccess(res, rows);
  };

  getObservation = async (req, res) => {
    SupervisionController.principal(req);
    const obs = await this.service.getObservation({
      tenantId: SupervisionController.tenantId(req), observationId: req.params.observationId,
    });
    sendSuccess(res, obs);
  };

  updateObservation = async (req, res) => {
    const p = SupervisionController.principal(req);
    const obs = await this.service.updateObservation({
      tenantId: SupervisionController.tenantId(req), observationId: req.params.observationId,
      actorUserId: p.userId, input: req.body,
    });
    sendSuccess(res, obs);
  };

  submitObservation = async (req, res) => {
    const p = SupervisionController.principal(req);
    const obs = await this.service.submitObservation({
      tenantId: SupervisionController.tenantId(req), observationId: req.params.observationId, actorUserId: p.userId,
    });
    sendSuccess(res, obs);
  };

  reopenObservation = async (req, res) => {
    const p = SupervisionController.principal(req);
    const obs = await this.service.reopenObservation({
      tenantId: SupervisionController.tenantId(req), observationId: req.params.observationId, actorUserId: p.userId,
    });
    sendSuccess(res, obs);
  };

  signObservation = async (req, res) => {
    const p = SupervisionController.principal(req);
    const obs = await this.service.signObservation({
      tenantId: SupervisionController.tenantId(req), observationId: req.params.observationId, actorUserId: p.userId,
    });
    sendSuccess(res, obs);
  };

  supersedeObservation = async (req, res) => {
    const p = SupervisionController.principal(req);
    const obs = await this.service.supersedeObservation({
      tenantId: SupervisionController.tenantId(req), observationId: req.params.observationId,
      actorUserId: p.userId, input: req.body,
    });
    sendCreated(res, obs, `/api/v1/supervision/observations/${obs.id}`);
  };

  recordHours = async (req, res) => {
    const p = SupervisionController.principal(req);
    const log = await this.service.recordHours({
      tenantId: SupervisionController.tenantId(req), actorUserId: p.userId, input: req.body,
    });
    sendCreated(res, log, `/api/v1/supervision/hours/${log.id}`);
  };

  hoursSummary = async (req, res) => {
    SupervisionController.principal(req);
    const summary = await this.service.hoursSummary({
      tenantId: SupervisionController.tenantId(req), filters: req.query,
    });
    sendSuccess(res, summary);
  };

  static principal(req) {
    if (!req.principal) throw AppError.unauthorized('AUTH-401', 'Authentication required');
    return req.principal;
  }

  static tenantId(req) {
    const tenantId = req.principal?.activeTenantId;
    if (tenantId === undefined || tenantId === null) throw AppError.forbidden('SUPERVISION-403', 'No active tenant context');
    return tenantId;
  }
}
