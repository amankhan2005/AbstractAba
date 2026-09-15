import { withTenant, withPlatform } from '../tenancy/tenantContext.js';
import { AppError } from '../common/errors/AppError.js';

/**
 * Enters the correct isolation scope for the remainder of the request.
 *
 * This is the bridge between the HTTP layer and the AsyncLocalStorage-based
 * tenant context: a tenant principal runs the rest of the pipeline inside
 * withTenant(activeTenantId); a platform operator runs inside withPlatform().
 * Because Express middleware is a callback chain, wrapping `next` inside the
 * context keeps every downstream handler, model call, and awaited continuation
 * bound to the same scope — the request-lifetime analogue of SET LOCAL.
 */
export function enterTenantContext(req, res, next) {
  const p = req.principal;
  if (!p) return next(AppError.unauthorized());
  if (p.isPlatformOperator) return withPlatform(() => Promise.resolve(next())).catch(next);
  if (!p.activeTenantId) return next(AppError.forbidden('AUTH-403', 'No active tenant'));
  return withTenant(p.activeTenantId, () => Promise.resolve(next())).catch(next);
}

/** For platform-only routes: enter platform scope regardless of principal type. */
export function enterPlatformContext(_req, _res, next) {
  return withPlatform(() => Promise.resolve(next())).catch(next);
}
