import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { requireRecordInScope } from '../../middleware/scopeGuard.js';
import { PlansController } from './plans.controller.js';
import {
  createPlanSchema,
  updatePlanSchema,
  listPlansQuerySchema,
  planIdParamsSchema,
  createGoalSchema,
  updateGoalSchema,
  goalParamsSchema,
  createProgramSchema,
  updateProgramSchema,
  programParamsSchema,
  createTargetSchema,
  updateTargetSchema,
  targetParamsSchema,
  programTargetParamsSchema,
} from './plans.schemas.js';

/**
 * Clinical planning router. Every route is authenticated, bound to the tenant
 * context, and guarded by an explicit permission. Reading requires plans.read;
 * creating requires plans.create; updating requires plans.update; archiving
 * (plan / goal / program / target) requires plans.archive.
 */
export function createPlansRouter(service) {
  const controller = new PlansController(service);
  const router = Router();

  // Every by-id plan route re-checks the caseload boundary. A correct list
  // filter does not protect GET /plans/:planId, nor any of the nested goal,
  // program and target paths beneath it — all of which reach clinical content
  // for a specific child.
  const planInScope = requireRecordInScope(
    (req) => service.findPlanForScope({
      tenantId: req.principal.activeTenantId,
      planId: req.params.planId,
    }),
    { code: 'PLAN-404', message: 'We couldn\u2019t find that treatment plan.' },
  );
  router.use(authenticate, enterTenantContext);

  // treatment plans
  router.get('/', requirePermission('plans.read'), validate(listPlansQuerySchema, 'query'), asyncHandler(controller.listPlans));
  router.post('/', requirePermission('plans.create'), validate(createPlanSchema, 'body'), asyncHandler(controller.createPlan));
  router.get('/:planId', requirePermission('plans.read'), planInScope, validate(planIdParamsSchema, 'params'), asyncHandler(controller.getPlan));
  router.patch('/:planId', requirePermission('plans.update'), planInScope, validate(planIdParamsSchema, 'params'), validate(updatePlanSchema, 'body'), asyncHandler(controller.updatePlan));
  router.post('/:planId/archive', requirePermission('plans.archive'), planInScope, validate(planIdParamsSchema, 'params'), asyncHandler(controller.archivePlan));
  // DELETE reuses the destructive-lifecycle permission (plans.archive — held by
  // Owner/Org-Admin/BCBA, never RBT) rather than introducing a new permission
  // and re-seeding roles. Every guard the by-id routes use applies: authenticate
  // + enterTenantContext (above), requirePermission, and planInScope (re-checks
  // the caseload boundary from the plan's own clientId), so a caller cannot
  // delete a plan outside their tenant or caseload by supplying its id.
  router.delete('/:planId', requirePermission('plans.archive'), planInScope, validate(planIdParamsSchema, 'params'), asyncHandler(controller.deletePlan));

  // goals
  router.post('/:planId/goals', requirePermission('plans.update'), planInScope, validate(planIdParamsSchema, 'params'), validate(createGoalSchema, 'body'), asyncHandler(controller.addGoal));
  router.patch('/:planId/goals/:goalId', requirePermission('plans.update'), planInScope, validate(goalParamsSchema, 'params'), validate(updateGoalSchema, 'body'), asyncHandler(controller.updateGoal));
  router.post('/:planId/goals/:goalId/archive', requirePermission('plans.archive'), planInScope, validate(goalParamsSchema, 'params'), asyncHandler(controller.archiveGoal));

  // programs
  router.post('/:planId/goals/:goalId/programs', requirePermission('plans.update'), planInScope, validate(goalParamsSchema, 'params'), validate(createProgramSchema, 'body'), asyncHandler(controller.addProgram));
  router.patch('/:planId/programs/:programId', requirePermission('plans.update'), planInScope, validate(programTargetParamsSchema, 'params'), validate(updateProgramSchema, 'body'), asyncHandler(controller.updateProgram));
  router.post('/:planId/programs/:programId/archive', requirePermission('plans.archive'), planInScope, validate(programTargetParamsSchema, 'params'), asyncHandler(controller.archiveProgram));

  // targets
  router.post('/:planId/programs/:programId/targets', requirePermission('plans.update'), planInScope, validate(programTargetParamsSchema, 'params'), validate(createTargetSchema, 'body'), asyncHandler(controller.addTarget));
  router.patch('/:planId/programs/:programId/targets/:targetId', requirePermission('plans.update'), planInScope, validate(targetParamsSchema, 'params'), validate(updateTargetSchema, 'body'), asyncHandler(controller.updateTarget));
  router.post('/:planId/programs/:programId/targets/:targetId/archive', requirePermission('plans.archive'), planInScope, validate(targetParamsSchema, 'params'), asyncHandler(controller.archiveTarget));

  return router;
}
