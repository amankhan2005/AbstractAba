import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { SessionsController } from './sessions.controller.js';
import { requireRecordInScope } from '../../middleware/scopeGuard.js';
import { sessionVisibleToScope, withSessionReviewScope } from '../rbac/dataScope.js';
import {
  clockInSchema,
  clockOutSchema,
  captureSignatureSchema,
  returnSessionSchema,
  cancelSessionSchema,
  amendSessionSchema,
  createSessionSchema,
  updateSessionSchema,
  listSessionsQuerySchema,
  sessionInsightsQuerySchema,
  sessionIdParamsSchema,
  createDataPointSchema,
  updateDataPointSchema,
  dataPointParamsSchema,
} from './sessions.schemas.js';

/**
 * Session-capture router. Every route is authenticated, bound to the tenant
 * context, and guarded by an explicit permission. Reading requires
 * sessions.read; capturing (create/update session, add/update/remove data
 * points) requires sessions.write; freezing — the clinical sign-off that makes
 * the record immutable — requires the distinct sessions.freeze.
 */
export function createSessionsRouter(service) {
  const controller = new SessionsController(service);
  const router = Router();
  router.use(authenticate, enterTenantContext);

  // Every by-id session route re-checks the caseload boundary. A correct list
  // filter does not protect GET /sessions/:id — the record is still reachable
  // by identifier, which is precisely the probe the isolation contract models.
  // Session access by clinician relationship, from persisted records only:
  //   RBT (SELF)  → only a session they delivered;
  //   BCBA (TEAM) → their own session, or an RBT session on a child they lead.
  // Anything else resolves to "not found" (no existence leak). Wider scopes keep
  // the standard client-or-staff guard.
  const sessionInScope = requireRecordInScope(
    async (req) => {
      const record = await service.findSessionForScope({
        tenantId: req.principal.activeTenantId,
        sessionId: req.params.sessionId,
      });
      if (!record) return null;
      if (req.dataScope?.scope === 'SELF' || req.dataScope?.scope === 'TEAM') {
        req.dataScope = await withSessionReviewScope(req.dataScope);
        return sessionVisibleToScope(req.dataScope, record) ? record : null;
      }
      return record;
    },
    { code: 'SESSION-404', message: 'We couldn\u2019t find that session.' },
  );

  // BCBA (TEAM) session lists and insights: resolve which RBT sessions they may
  // review (children they lead) before the query runs.
  const sessionReviewScope = asyncHandler(async (req, _res, next) => { req.dataScope = await withSessionReviewScope(req.dataScope); next(); });

  // sessions
  router.get('/', requirePermission('sessions.read'), sessionReviewScope, validate(listSessionsQuerySchema, 'query'), asyncHandler(controller.listSessions));
  // Session-oversight child summaries (spec §4). Read-only, tenant + scope
  // enforced. Declared before '/:sessionId' so it isn't captured as an id.
  router.get('/oversight/children', requirePermission('sessions.read'), sessionReviewScope, asyncHandler(controller.oversightChildren));
  // Session Insights (organization-level summary for the caller's scope). Declared before '/:sessionId'.
  router.get('/oversight/insights', requirePermission('sessions.read'), sessionReviewScope, validate(sessionInsightsQuerySchema, 'query'), asyncHandler(controller.sessionInsights));
  router.post('/', requirePermission('sessions.write'), validate(createSessionSchema, 'body'), asyncHandler(controller.createSession));
  router.get('/:sessionId', requirePermission('sessions.read'), sessionInScope, validate(sessionIdParamsSchema, 'params'), asyncHandler(controller.getSession));
  router.patch('/:sessionId', requirePermission('sessions.write'), sessionInScope, validate(sessionIdParamsSchema, 'params'), validate(updateSessionSchema, 'body'), asyncHandler(controller.updateSession));
  router.post('/:sessionId/freeze', requirePermission('sessions.freeze'), sessionInScope, validate(sessionIdParamsSchema, 'params'), asyncHandler(controller.freezeSession));

  // --- lifecycle transitions (blueprint Figure 6.2) ------------------------
  //
  // Each transition is its own endpoint rather than a PATCH on `status`,
  // because every one of them carries obligations the state field alone cannot
  // express: clock events capture time and location AT the event, a return
  // carries a comment, a cancellation carries a taxonomy code, an amendment
  // creates a new record. A generic status PATCH would let a client move a
  // session to APPROVED without any of them.
  //
  // Permissions follow the blueprint's role boundaries, not job titles:
  //   clock in/out, signatures  → sessions.write  (the delivering technician)
  //   return                    → sessions.freeze (the reviewing analyst; §9.4
  //                               step 5 pairs approve and return as the two
  //                               outcomes of the SAME review authority)
  //   cancel                    → sessions.write
  //   amend                     → sessions.freeze (post-approval correction is
  //                               a privileged act; BR-CN-3)
  router.post('/:sessionId/clock-in', requirePermission('sessions.write'), sessionInScope, validate(sessionIdParamsSchema, 'params'), validate(clockInSchema, 'body'), asyncHandler(controller.clockIn));
  router.post('/:sessionId/clock-out', requirePermission('sessions.write'), sessionInScope, validate(sessionIdParamsSchema, 'params'), validate(clockOutSchema, 'body'), asyncHandler(controller.clockOut));
  router.get('/:sessionId/verification', requirePermission('sessions.read'), sessionInScope, validate(sessionIdParamsSchema, 'params'), asyncHandler(controller.verification));
  router.post('/:sessionId/signatures', requirePermission('sessions.write'), sessionInScope, validate(sessionIdParamsSchema, 'params'), validate(captureSignatureSchema, 'body'), asyncHandler(controller.captureSignature));
  router.post('/:sessionId/submit', requirePermission('sessions.write'), sessionInScope, validate(sessionIdParamsSchema, 'params'), asyncHandler(controller.submitSession));
  router.post('/:sessionId/return', requirePermission('sessions.freeze'), sessionInScope, validate(sessionIdParamsSchema, 'params'), validate(returnSessionSchema, 'body'), asyncHandler(controller.returnSession));
  router.post('/:sessionId/cancel', requirePermission('sessions.write'), sessionInScope, validate(sessionIdParamsSchema, 'params'), validate(cancelSessionSchema, 'body'), asyncHandler(controller.cancelSession));
  router.post('/:sessionId/amend', requirePermission('sessions.freeze'), sessionInScope, validate(sessionIdParamsSchema, 'params'), validate(amendSessionSchema, 'body'), asyncHandler(controller.amendSession));

  // data points
  router.post('/:sessionId/data-points', requirePermission('sessions.write'), sessionInScope, validate(sessionIdParamsSchema, 'params'), validate(createDataPointSchema, 'body'), asyncHandler(controller.addDataPoint));
  router.patch('/:sessionId/data-points/:dataPointId', requirePermission('sessions.write'), sessionInScope, validate(dataPointParamsSchema, 'params'), validate(updateDataPointSchema, 'body'), asyncHandler(controller.updateDataPoint));
  router.delete('/:sessionId/data-points/:dataPointId', requirePermission('sessions.write'), sessionInScope, validate(dataPointParamsSchema, 'params'), asyncHandler(controller.removeDataPoint));

  return router;
}
