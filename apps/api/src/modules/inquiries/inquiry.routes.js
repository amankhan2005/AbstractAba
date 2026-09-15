import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { sendSuccess } from '../../common/http/responder.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePlatformOperator } from '../../middleware/requirePlatformOperator.js';
import {
  submitInquirySchema,
  inquiryIdParamsSchema,
  listInquiriesQuerySchema,
  updateInquirySchema,
} from './inquiry.schemas.js';

/** Per-client limit for anonymous submissions, on top of the global limit. */
export function createInquirySubmitRateLimit({ max = 5, windowMs = 15 * 60 * 1000 } = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: { code: 'INQUIRY-429', message: 'Too many messages were sent from this connection. Please try again later.' },
    },
  });
}

/**
 * Public: POST / (anonymous, validated, rate limited).
 * Platform: GET /, GET /:id, PATCH /:id behind authentication and the
 * platform-operator gate — company admins, BCBAs and RBTs are refused.
 */
export function createInquiryRouters(service, { submitLimiter = createInquirySubmitRateLimit() } = {}) {
  const publicRouter = Router();
  publicRouter.post(
    '/',
    submitLimiter,
    validate(submitInquirySchema, 'body'),
    asyncHandler(async (req, res) => {
      sendSuccess(res, await service.submit(req.body), 201);
    }),
  );

  const platform = Router();
  platform.use(authenticate, requirePlatformOperator);
  platform.get(
    '/',
    validate(listInquiriesQuerySchema, 'query'),
    asyncHandler(async (req, res) => {
      sendSuccess(res, await service.list({ status: req.query.status }));
    }),
  );
  platform.get(
    '/:id',
    validate(inquiryIdParamsSchema, 'params'),
    asyncHandler(async (req, res) => {
      sendSuccess(res, await service.get(req.params.id));
    }),
  );
  platform.patch(
    '/:id',
    validate(inquiryIdParamsSchema, 'params'),
    validate(updateInquirySchema, 'body'),
    asyncHandler(async (req, res) => {
      sendSuccess(res, await service.update({ id: req.params.id, actorUserId: req.principal.userId, input: req.body }));
    }),
  );

  return { public: publicRouter, platform };
}
