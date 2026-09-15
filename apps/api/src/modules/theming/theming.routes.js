import { Router } from 'express';
import { asyncHandler } from '../../common/http/asyncHandler.js';
import { validate } from '../../common/validation/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { enterTenantContext } from '../../middleware/tenantContext.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { ThemingController } from './theming.controller.js';
import express from 'express';
import { z } from 'zod';
import { brandTokensPatchSchema, userPreferencesPatchSchema } from './design-tokens.js';

/** A data URL or bare base64 payload. The BYTES are what gets validated. */
export const logoUploadSchema = z.object({
  file: z.string().min(1).max(6_000_000),
}).strict();

/**
 * Theming routes, ported from the original:
 *   /me/preferences        the caller's own preferences (read/patch/reset) —
 *                          authenticated, no permission or tenant context (a
 *                          person's preferences are theirs across every org).
 *   /me/theme              the resolved theme for the caller.
 *   /organization/branding tenant brand tokens; reading needs tenant context,
 *                          writing reuses organization.update.
 */
export function createThemingRouters(service) {
  const controller = new ThemingController(service);

  const me = Router();
  me.use(authenticate);
  me.get('/preferences', asyncHandler(controller.myPreferences));
  me.put('/preferences', validate(userPreferencesPatchSchema, 'body'), asyncHandler(controller.updateMyPreferences));
  me.delete('/preferences', asyncHandler(controller.resetMyPreferences));
  me.get('/theme', asyncHandler(controller.myTheme));

  const branding = Router();
  branding.use(authenticate, enterTenantContext);
  branding.get('/', asyncHandler(controller.getBranding));
  branding.put('/', requirePermission('organization.update'), validate(brandTokensPatchSchema, 'body'), asyncHandler(controller.updateBranding));

  // Logo upload. Base64 in a JSON body rather than multipart, matching the
  // documents module's existing convention so there is one upload shape in the
  // API. The 4 MB body cap leaves headroom over the 2 MB image limit for
  // base64's ~33% expansion; the real size check is on the DECODED bytes.
  branding.post(
    '/logo',
    requirePermission('organization.update'),
    express.json({ limit: '4mb' }),
    validate(logoUploadSchema, 'body'),
    asyncHandler(controller.uploadLogo),
  );

  return { me, branding };
}
