import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authRateLimit } from '../../middleware/security.js';
import * as ctrl from './auth.controller.js';

export const authRouter = Router();

authRouter.post('/sign-in', authRateLimit, validate(ctrl.signInSchema), asyncHandler(ctrl.signIn));
authRouter.post('/mfa/verify', authRateLimit, validate(ctrl.mfaSchema), asyncHandler(ctrl.verifyMfa));
authRouter.post('/refresh', validate(ctrl.refreshSchema), asyncHandler(ctrl.refresh));
authRouter.post('/sign-out', validate(ctrl.refreshSchema), asyncHandler(ctrl.signOut));
authRouter.get('/me', authenticate, asyncHandler(ctrl.me));
authRouter.patch('/me', authenticate, validate(ctrl.updateMeSchema), asyncHandler(ctrl.updateMe));
authRouter.post('/change-password', authenticate, authRateLimit, validate(ctrl.changePasswordSchema), asyncHandler(ctrl.changePassword));
// Public, rate-limited, no-enumeration password reset.
authRouter.post('/forgot-password', authRateLimit, validate(ctrl.forgotPasswordSchema), asyncHandler(ctrl.requestPasswordReset));
authRouter.post('/reset-password', authRateLimit, validate(ctrl.resetPasswordSchema), asyncHandler(ctrl.resetPassword));
