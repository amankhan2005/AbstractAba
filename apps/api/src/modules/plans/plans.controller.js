import { AppError } from '../../common/errors/AppError.js';
import { sendCreated, sendPaginated, sendSuccess } from '../../common/http/responder.js';
import { plansError } from './plans.errors.js';

/**
 * HTTP boundary for clinical planning. Holds no rules — the ACTIVE gate, the
 * client/BCBA validation, and the archived-plan immutability guard all live in
 * the service. Follows the established conventions: {data} envelope, sendCreated
 * with Location, mandatory If-Match on the versioned plan/goal/program/target
 * updates.
 */
export class PlansController {
  constructor(service) {
    this.service = service;
  }

  // --- treatment plans -----------------------------------------------------

  listPlans = async (req, res) => {
    const tenantId = PlansController.requireTenantId(req);
    const q = req.query;
    // RBT execution view (spec Module 7.3): a caller who cannot AUTHOR plans
    // (no plans.update / plans.create — i.e. an RBT) sees only ACTIVE plans, not
    // DRAFT work-in-progress. Enforced on the server; the browser cannot widen it.
    // `req.principal.permissions` is a Set (built in authenticate.js as
    // `new Set(claims.perms)`); the canonical membership check across the app is
    // `.has(key)` — see requirePermission.js and clients.controller.js. The
    // previous `.includes()` here treated the Set as an Array and threw
    // `perms.includes is not a function` at runtime for every authorised caller.
    const perms = req.principal?.permissions;
    const canAuthor = !!(perms?.has('plans.update') || perms?.has('plans.create'));
    const status = canAuthor ? q.status : 'ACTIVE';
    const page = await this.service.listPlans({
      tenantId,
      dataScope: req.dataScope,
      limit: q.limit,
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.clientId !== undefined ? { clientId: q.clientId } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    sendPaginated(res, page.items, { nextCursor: page.nextCursor, limit: q.limit });
  };

  createPlan = async (req, res) => {
    const principal = PlansController.requirePrincipal(req);
    const plan = await this.service.createPlan({
      tenantId: PlansController.requireTenantId(req),
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, plan, `/api/v1/plans/${plan.id}`);
  };

  getPlan = async (req, res) => {
    const detail = await this.service.getPlan({
      tenantId: PlansController.requireTenantId(req),
      planId: req.params.planId,
    });
    sendSuccess(res, detail);
  };

  updatePlan = async (req, res) => {
    const principal = PlansController.requirePrincipal(req);
    const plan = await this.service.updatePlan({
      tenantId: PlansController.requireTenantId(req),
      planId: req.params.planId,
      actorUserId: principal.userId,
      expectedVersion: PlansController.requireVersion(req),
      input: req.body,
    });
    sendSuccess(res, plan);
  };

  archivePlan = async (req, res) => {
    const principal = PlansController.requirePrincipal(req);
    const result = await this.service.archivePlan({
      tenantId: PlansController.requireTenantId(req),
      planId: req.params.planId,
      actorUserId: principal.userId,
    });
    sendSuccess(res, result);
  };

  deletePlan = async (req, res) => {
    const principal = PlansController.requirePrincipal(req);
    const result = await this.service.deletePlan({
      tenantId: PlansController.requireTenantId(req),
      planId: req.params.planId,
      actorUserId: principal.userId,
    });
    sendSuccess(res, result);
  };

  // --- goals ---------------------------------------------------------------

  addGoal = async (req, res) => {
    const principal = PlansController.requirePrincipal(req);
    const goal = await this.service.addGoal({
      tenantId: PlansController.requireTenantId(req),
      planId: req.params.planId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, goal, `/api/v1/plans/${req.params.planId}/goals/${goal.id}`);
  };

  updateGoal = async (req, res) => {
    const principal = PlansController.requirePrincipal(req);
    const goal = await this.service.updateGoal({
      tenantId: PlansController.requireTenantId(req),
      planId: req.params.planId,
      goalId: req.params.goalId,
      actorUserId: principal.userId,
      expectedVersion: PlansController.requireVersion(req),
      input: req.body,
    });
    sendSuccess(res, goal);
  };

  archiveGoal = async (req, res) => {
    const principal = PlansController.requirePrincipal(req);
    const result = await this.service.archiveGoal({
      tenantId: PlansController.requireTenantId(req),
      planId: req.params.planId,
      goalId: req.params.goalId,
      actorUserId: principal.userId,
    });
    sendSuccess(res, result);
  };

  // --- programs ------------------------------------------------------------

  addProgram = async (req, res) => {
    const principal = PlansController.requirePrincipal(req);
    const program = await this.service.addProgram({
      tenantId: PlansController.requireTenantId(req),
      planId: req.params.planId,
      goalId: req.params.goalId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, program, `/api/v1/plans/${req.params.planId}/programs/${program.id}`);
  };

  updateProgram = async (req, res) => {
    const principal = PlansController.requirePrincipal(req);
    const program = await this.service.updateProgram({
      tenantId: PlansController.requireTenantId(req),
      planId: req.params.planId,
      programId: req.params.programId,
      actorUserId: principal.userId,
      expectedVersion: PlansController.requireVersion(req),
      input: req.body,
    });
    sendSuccess(res, program);
  };

  archiveProgram = async (req, res) => {
    const principal = PlansController.requirePrincipal(req);
    const result = await this.service.archiveProgram({
      tenantId: PlansController.requireTenantId(req),
      planId: req.params.planId,
      programId: req.params.programId,
      actorUserId: principal.userId,
    });
    sendSuccess(res, result);
  };

  // --- targets -------------------------------------------------------------

  addTarget = async (req, res) => {
    const principal = PlansController.requirePrincipal(req);
    const target = await this.service.addTarget({
      tenantId: PlansController.requireTenantId(req),
      planId: req.params.planId,
      programId: req.params.programId,
      actorUserId: principal.userId,
      input: req.body,
    });
    sendCreated(res, target, `/api/v1/plans/${req.params.planId}/programs/${req.params.programId}/targets/${target.id}`);
  };

  updateTarget = async (req, res) => {
    const principal = PlansController.requirePrincipal(req);
    const target = await this.service.updateTarget({
      tenantId: PlansController.requireTenantId(req),
      planId: req.params.planId,
      programId: req.params.programId,
      targetId: req.params.targetId,
      actorUserId: principal.userId,
      expectedVersion: PlansController.requireVersion(req),
      input: req.body,
    });
    sendSuccess(res, target);
  };

  archiveTarget = async (req, res) => {
    const principal = PlansController.requirePrincipal(req);
    const result = await this.service.archiveTarget({
      tenantId: PlansController.requireTenantId(req),
      planId: req.params.planId,
      programId: req.params.programId,
      targetId: req.params.targetId,
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
    if (tenantId === undefined || tenantId === null) throw plansError('TENANT_CONTEXT_MISSING');
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
