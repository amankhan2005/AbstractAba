import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authRateLimit } from '../../middleware/security.js';
import { SelfServeController } from './selfServe.controller.js';
import { selfServeSignupSchema } from './selfServe.schemas.js';

/**
 * Public self-serve signup router (BR-3). Mounted UNDER /public, so it inherits
 * the unauthenticated public surface. Abuse is bounded by the stricter
 * authRateLimit (the same limiter guarding login/registration-style endpoints),
 * and duplicate clinics are prevented by the existing slug-uniqueness guarantee
 * in organizations.create(). No authentication is applied — this is the entry
 * point for a clinic that does not yet exist.
 */
export function createSelfServeRouter(service) {
  const controller = new SelfServeController(service);
  const router = Router();

  router.post('/signup', authRateLimit, validate(selfServeSignupSchema, 'body'), asyncHandler(controller.signup));

  return router;
}
