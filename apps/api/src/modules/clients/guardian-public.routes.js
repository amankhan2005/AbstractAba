import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { sendSuccess } from '../../common/http/responder.js';
import { authRateLimit } from '../../middleware/security.js';
import { guardianInvitationService } from './guardian-invitation.js';
import { guardianSubmissionSchema, guardianTokenParamsSchema } from './clients.schemas.js';

/**
 * ---------------------------------------------------------------------------
 * THE ANONYMOUS GUARDIAN SURFACE.
 *
 * This is the only unauthenticated, tenant-owned surface in the application,
 * so it is built to be the narrowest thing that works.
 *
 *   NO authenticate. NO enterTenantContext. The caller is a family member with
 *   a link, not a user; the TOKEN names the tenant, and the service re-enters
 *   that tenant's context after resolving it. The router-wiring test exempts
 *   this router because it holds no `requirePermission` — there is no
 *   permission to hold.
 *
 *   RATE LIMITED with the auth limiter. A token is a bearer credential, and an
 *   unthrottled endpoint that says whether a token is valid is a guessing
 *   oracle. The same limiter that protects sign-in protects this.
 *
 *   The token is a PATH parameter, not a query parameter: query strings reach
 *   referrer headers, proxy logs and analytics far more readily.
 *
 *   Every failure mode — unknown, expired, revoked, already used — returns an
 *   identical 404 and an identical message. Distinguishing them would let
 *   someone with a list of guesses learn which tokens exist.
 * ---------------------------------------------------------------------------
 */
export function createGuardianPublicRouter(service = guardianInvitationService) {
  const router = Router();

  // What is being asked, and by whom. Returns a child's FIRST NAME and the
  // clinic's name — never an identifier, never clinical content.
  router.get(
    '/:token',
    authRateLimit,
    validate(guardianTokenParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      sendSuccess(res, await service.resolve(req.params.token));
    }),
  );

  // Accept the submission and close the link permanently.
  router.post(
    '/:token',
    authRateLimit,
    validate(guardianTokenParamsSchema, 'params'),
    validate(guardianSubmissionSchema, 'body'),
    asyncHandler(async (req, res) => {
      sendSuccess(res, await service.submit(req.params.token, req.body));
    }),
  );

  return router;
}
